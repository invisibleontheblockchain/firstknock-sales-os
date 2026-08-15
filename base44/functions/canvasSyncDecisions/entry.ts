import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { Client } from "npm:@neondatabase/serverless@0.9.0";

const OUTCOMES = new Set(["no_answer", "not_interested", "callback", "appointment", "sale", "do_not_knock"]);
const MAX_DECISIONS = 100;
const MAX_BODY_BYTES = 256_000;
const MAX_ROAD_SNAP_METERS = 150;
const ROAD_AMBIGUITY_METERS = 12;
const ROAD_AMBIGUITY_RATIO = 1.5;
const PIN_MATCH_METERS = 25;
const DNC_HOUSE_MATCH_METERS = 12;
const MAX_CLOCK_AGE_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_LEAD_MS = 5 * 60 * 1000;

const json = (body: unknown, status = 200) => Response.json(body, { status });

class HttpError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  details?: unknown;

  constructor(status: number, code: string, message: string, retryable = false, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : Array.isArray((value as any)?.items) ? (value as any).items : [];
}

function normalized(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ["manager", "admin"].includes(appRole) || ["manager", "admin"].includes(accountRole);
}

function requiredString(value: unknown, field: string, maxLength = 256) {
  const result = String(value || "").trim();
  if (!result || result.length > maxLength) {
    throw new HttpError(400, "invalid_decision", `${field} is required or invalid.`);
  }
  return result;
}

function optionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  const result = String(value).trim();
  if (result.length > maxLength) throw new HttpError(400, "invalid_decision", `${field} is too long.`);
  return result || null;
}

function normalizePoint(value: any) {
  const lat = Number(value?.lat ?? value?.latitude ?? value?.[0]);
  const lng = Number(value?.lng ?? value?.lon ?? value?.longitude ?? value?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new HttpError(400, "invalid_decision_location", "point must contain a valid latitude and longitude.");
  }
  return { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) };
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cleanIdentityPart(value: unknown, maxLength = 180) {
  return normalized(value).replace(/\s+/g, " ").slice(0, maxLength);
}

function deriveHouseKey(decision: any) {
  const unit = cleanIdentityPart(decision.unit_label, 80) || "_";
  if (decision.opportunity_id) return `opportunity:${cleanIdentityPart(decision.opportunity_id)}:unit:${unit}`;
  if (decision.building_feature_id) return `building:${cleanIdentityPart(decision.building_feature_id)}:unit:${unit}`;
  if (decision.normalized_address) return `address:${cleanIdentityPart(decision.normalized_address)}:unit:${unit}`;
  return `coordinate:${decision.point.lat.toFixed(6)},${decision.point.lng.toFixed(6)}:unit:${unit}`;
}

function parseClientTime(value: unknown) {
  const raw = requiredString(value, "client_recorded_at", 64);
  const timestamp = Date.parse(raw);
  const now = Date.now();
  if (!Number.isFinite(timestamp) || timestamp < now - MAX_CLOCK_AGE_MS || timestamp > now + MAX_CLOCK_LEAD_MS) {
    throw new HttpError(400, "invalid_client_time", "client_recorded_at is outside the accepted offline window.");
  }
  return new Date(timestamp).toISOString();
}

function validateDecision(value: any, index: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_decision", `decisions[${index}] must be an object.`);
  }
  const outcome = normalized(value.outcome);
  if (!OUTCOMES.has(outcome)) throw new HttpError(400, "invalid_outcome", `decisions[${index}].outcome is invalid.`);
  const decision = {
    idempotency_key: requiredString(value.idempotency_key, `decisions[${index}].idempotency_key`, 128),
    client_recorded_at: parseClientTime(value.client_recorded_at),
    point: normalizePoint(value.point),
    outcome,
    note: optionalString(value.note, `decisions[${index}].note`, 2_000),
    address: optionalString(value.address, `decisions[${index}].address`, 500),
    normalized_address: optionalString(value.normalized_address || value.address, `decisions[${index}].normalized_address`, 500),
    unit_label: optionalString(value.unit_label, `decisions[${index}].unit_label`, 120),
    building_feature_id: optionalString(value.building_feature_id, `decisions[${index}].building_feature_id`, 256),
    opportunity_id: optionalString(value.opportunity_id, `decisions[${index}].opportunity_id`, 256),
    pin_id: optionalString(value.pin_id, `decisions[${index}].pin_id`, 256),
    house_key: optionalString(value.house_key, `decisions[${index}].house_key`, 512)
  } as any;
  decision.normalized_address = cleanIdentityPart(decision.normalized_address, 500) || null;
  decision.normalized_unit_label = cleanIdentityPart(decision.unit_label, 120) || null;
  decision.house_key = decision.house_key ? cleanIdentityPart(decision.house_key, 512) : deriveHouseKey(decision);
  if (!decision.house_key) throw new HttpError(400, "invalid_house_identity", "A stable house identity could not be produced.");
  return decision;
}

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

async function resolveActor(base44: any, user: any) {
  if (canManageCanvas(user)) {
    return { managerId: String(user.id || "").trim(), teamMemberId: null, isManager: true };
  }
  const managerId = String(user?.team_manager_id || user?.data?.team_manager_id || "").trim();
  if (!managerId) throw new HttpError(403, "canvas_assignment_forbidden", "No active Canvas team membership is linked to this account.");
  const candidates = asArray(await base44.entities.TeamMember.filter(
    { user_id: user.id, status: "active" },
    "-updated_date",
    20
  ).catch(() => [])).filter((member: any) =>
    String(member?.user_id || "") === String(user.id || "") &&
    String(member?.manager_id || "") === managerId &&
    normalized(member?.status) === "active" &&
    normalized(member?.role) === "rep"
  );
  const unique = new Map(candidates.map((member: any) => [String(member.id), member]));
  if (unique.size !== 1) {
    throw new HttpError(unique.size > 1 ? 409 : 403, unique.size > 1 ? "ambiguous_team_membership" : "canvas_assignment_forbidden", "An exact active rep membership is required.");
  }
  return { managerId, teamMemberId: String([...unique.values()][0].id), isManager: false };
}

function validateAssignmentRow(row: any, actor: any, user: any, packageVersion: number) {
  if (!row || String(row.manager_id) !== actor.managerId) {
    throw new HttpError(403, "canvas_assignment_forbidden", "This assignment is not available to this account.");
  }
  if (!actor.isManager && (
    String(row.assignee_user_id) !== String(user.id) ||
    String(row.team_member_id) !== actor.teamMemberId
  )) {
    throw new HttpError(403, "canvas_assignment_forbidden", "This assignment belongs to another rep.");
  }
  if (String(row.deployment_status) === "recalled") {
    throw new HttpError(409, "campaign_recalled", "This Canvas campaign was recalled. Refresh assignments before logging.");
  }
  if (String(row.deployment_status) !== "active") {
    throw new HttpError(409, "campaign_not_active", "This Canvas campaign is not active.");
  }
  if (["revoked", "superseded"].includes(String(row.assignment_status)) || row.revoked_at) {
    throw new HttpError(409, "assignment_revoked", "This Canvas assignment was revoked or replaced. Refresh assignments before logging.");
  }
  if (String(row.assignment_status) !== "active" || String(row.package_status) !== "ready") {
    throw new HttpError(409, "assignment_not_ready", "This Canvas assignment package is not ready for field decisions.");
  }
  if (Number(row.package_version) !== packageVersion) {
    throw new HttpError(409, "package_version_mismatch", "The offline package is stale. Download the current assignment package.");
  }
  if (!row.package_id || String(row.package_record_status) !== "ready") {
    throw new HttpError(409, "package_not_ready", "The signed offline assignment package is not ready.");
  }
  const now = Date.now();
  if ((row.valid_from && Date.parse(row.valid_from) > now) || (row.package_issued_at && Date.parse(row.package_issued_at) > now)) {
    throw new HttpError(409, "assignment_not_yet_valid", "This Canvas assignment is not active yet.");
  }
  if ((row.valid_until && Date.parse(row.valid_until) <= now) || (row.package_valid_until && Date.parse(row.package_valid_until) <= now)) {
    throw new HttpError(409, "assignment_expired", "This Canvas assignment package has expired.");
  }
  return row;
}

async function loadAssignment(client: any, assignmentId: string, actor: any, user: any, packageVersion: number, lock = false) {
  const result = await client.query(`
    SELECT
      a.assignment_id, a.manager_id, a.campaign_id, a.zone_id,
      a.assignee_user_id, a.team_member_id, a.package_version,
      a.package_status, a.status AS assignment_status, a.valid_from,
      a.valid_until, a.revoked_at, d.status AS deployment_status,
      p.package_id, p.status AS package_record_status,
      p.issued_at AS package_issued_at, p.valid_until AS package_valid_until
    FROM canvas_assignments a
    JOIN canvas_deployments d
      ON d.campaign_id = a.campaign_id AND d.manager_id = a.manager_id
    LEFT JOIN canvas_assignment_packages p
      ON p.manager_id = a.manager_id AND p.assignment_id = a.assignment_id
     AND p.package_version = a.package_version
    WHERE a.assignment_id = $1 AND a.manager_id = $2
    ${lock ? "FOR SHARE OF a, d" : ""}
  `, [assignmentId, actor.managerId]);
  const row = rows(result)[0];
  if (lock && row?.package_id) {
    const packageResult = await client.query(`
      SELECT package_id, status AS package_record_status,
        issued_at AS package_issued_at, valid_until AS package_valid_until
      FROM canvas_assignment_packages
      WHERE package_id = $1 AND manager_id = $2
        AND assignment_id = $3 AND package_version = $4
      FOR SHARE
    `, [row.package_id, row.manager_id, row.assignment_id, row.package_version]);
    const lockedPackage = rows(packageResult)[0];
    row.package_id = lockedPackage?.package_id || null;
    row.package_record_status = lockedPackage?.package_record_status || null;
    row.package_issued_at = lockedPackage?.package_issued_at || null;
    row.package_valid_until = lockedPackage?.package_valid_until || null;
  }
  return validateAssignmentRow(row, actor, user, packageVersion);
}

function mapPin(row: any, dncActive: boolean) {
  if (!row) return null;
  return {
    pin_id: row.pin_id,
    house_key: row.house_key,
    opportunity_id: row.opportunity_id,
    street_unit_id: row.street_unit_id,
    point: { lat: Number(row.lat), lng: Number(row.lng) },
    address: row.address,
    unit_label: row.unit_label,
    latest_outcome: row.latest_outcome,
    latest_note: row.latest_note,
    latest_event_id: row.latest_event_id,
    latest_change_cursor: Number(row.latest_change_cursor),
    latest_client_recorded_at: row.latest_client_recorded_at,
    version: Number(row.version),
    dnc_active: dncActive
  };
}

function publicEvent(row: any) {
  return {
    event_id: row.event_id,
    idempotency_key: row.idempotency_key,
    pin_id: row.pin_id,
    street_unit_id: row.street_unit_id,
    outcome: row.outcome,
    note: row.note,
    client_recorded_at: row.client_recorded_at,
    server_recorded_at: row.server_recorded_at,
    applied_to_latest: Boolean(row.applied_to_latest),
    pin_version: Number(row.pin_version),
    change_cursor: Number(row.change_cursor)
  };
}

async function lockKey(client: any, value: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [value]);
}

function parseOutcomeCounts(value: any) {
  const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value || {};
  const result: Record<string, number> = {};
  for (const outcome of OUTCOMES) result[outcome] = Math.max(0, Number(parsed[outcome] || 0));
  return result;
}

function updateOutcomeCounts(counts: Record<string, number>, previous: string | null, next: string) {
  if (previous && OUTCOMES.has(previous)) counts[previous] = Math.max(0, Number(counts[previous] || 0) - 1);
  counts[next] = Number(counts[next] || 0) + 1;
  return counts;
}

async function insertChange(client: any, values: {
  managerId: string;
  campaignId: string;
  zoneId: string;
  assignmentId: string;
  type: string;
  entityId: string;
  version: number;
  payload: unknown;
}) {
  const result = await client.query(`
    INSERT INTO canvas_changes (
      manager_id, campaign_id, zone_id, assignment_id,
      change_type, entity_id, entity_version, payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    RETURNING cursor, occurred_at
  `, [
    values.managerId,
    values.campaignId,
    values.zoneId,
    values.assignmentId,
    values.type,
    values.entityId,
    values.version,
    JSON.stringify(values.payload)
  ]);
  return rows(result)[0];
}

async function findOwnedWorkUnit(client: any, assignment: any, point: any) {
  const result = await client.query(`
    WITH target AS (
      SELECT ST_SetSRID(ST_MakePoint($3, $4), 4326) AS geom
    )
    SELECT
      w.assignment_id, w.zone_id, w.work_unit_id,
      ST_Distance(w.geometry::geography, target.geom::geography) AS distance_meters
    FROM canvas_work_unit_ownership w
    CROSS JOIN target
    WHERE w.manager_id = $1
      AND w.campaign_id = $2
      AND ST_DWithin(w.geometry::geography, target.geom::geography, $5)
    ORDER BY distance_meters, w.work_unit_id
    LIMIT 8
  `, [assignment.manager_id, assignment.campaign_id, point.lng, point.lat, MAX_ROAD_SNAP_METERS]);
  const candidates = rows(result);
  if (!candidates.length) {
    throw new HttpError(422, "decision_outside_street_work", "This location is not close enough to an owned residential street unit.");
  }
  const nearest = candidates[0];
  if (String(nearest.assignment_id) !== String(assignment.assignment_id) || String(nearest.zone_id) !== String(assignment.zone_id)) {
    throw new HttpError(409, "decision_owned_by_another_assignment", "This location belongs to another Canvas assignment.");
  }
  const competing = candidates.find((candidate: any) =>
    String(candidate.assignment_id) !== String(nearest.assignment_id) || String(candidate.zone_id) !== String(nearest.zone_id)
  );
  if (competing) {
    const nearestDistance = Number(nearest.distance_meters);
    const competingDistance = Number(competing.distance_meters);
    if (competingDistance - nearestDistance <= ROAD_AMBIGUITY_METERS || competingDistance <= Math.max(1, nearestDistance) * ROAD_AMBIGUITY_RATIO) {
      throw new HttpError(409, "ambiguous_street_ownership", "This location is too close to another rep's street ownership boundary.");
    }
  }
  return nearest;
}

async function findPinForUpdate(client: any, assignment: any, decision: any) {
  if (decision.pin_id) {
    const result = await client.query(`
      SELECT p.*, ST_Y(p.point) AS lat, ST_X(p.point) AS lng,
        ST_Distance(
          p.point::geography,
          ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography
        ) AS submitted_distance_meters
      FROM canvas_house_pins p
      WHERE p.pin_id = $1 AND p.manager_id = $2 AND p.campaign_id = $3
        AND p.zone_id = $4 AND p.assignment_id = $5
      FOR UPDATE
    `, [decision.pin_id, assignment.manager_id, assignment.campaign_id, assignment.zone_id, assignment.assignment_id, decision.point.lng, decision.point.lat]);
    const pin = rows(result)[0];
    if (!pin) throw new HttpError(404, "pin_not_found", "The selected Canvas pin is not part of this assignment.");
    if (Number(pin.submitted_distance_meters) > PIN_MATCH_METERS) {
      throw new HttpError(409, "pin_location_mismatch", "The submitted point does not match the selected house pin.");
    }
    return pin;
  }
  const result = await client.query(`
    SELECT p.*, ST_Y(p.point) AS lat, ST_X(p.point) AS lng
    FROM canvas_house_pins p
    WHERE p.manager_id = $1 AND p.campaign_id = $2 AND p.house_key = $3
    FOR UPDATE
  `, [assignment.manager_id, assignment.campaign_id, decision.house_key]);
  const pin = rows(result)[0] || null;
  if (pin && (String(pin.assignment_id) !== String(assignment.assignment_id) || String(pin.zone_id) !== String(assignment.zone_id))) {
    throw new HttpError(409, "house_owned_by_another_assignment", "This house already belongs to another Canvas assignment.");
  }
  return pin;
}

async function syncOneDecision(client: any, context: any, decision: any) {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const assignment = await loadAssignment(client, context.assignmentId, context.actor, context.user, context.packageVersion, true);
    await lockKey(client, `canvas:idempotency:${assignment.manager_id}:${context.user.id}:${decision.idempotency_key}`);

    const requestHash = await sha256({
      assignment_id: assignment.assignment_id,
      package_version: context.packageVersion,
      actor_user_id: context.user.id,
      decision
    });
    const existingResult = await client.query(`
      SELECT e.*
      FROM canvas_house_events e
      WHERE e.manager_id = $1 AND e.actor_user_id = $2 AND e.idempotency_key = $3
    `, [assignment.manager_id, context.user.id, decision.idempotency_key]);
    const existing = rows(existingResult)[0];
    if (existing) {
      if (String(existing.request_hash) !== requestHash) {
        throw new HttpError(409, "idempotency_key_reused", "This idempotency key was already used for a different decision.");
      }
      const pinResult = await client.query(`
        SELECT p.*, ST_Y(p.point) AS lat, ST_X(p.point) AS lng
        FROM canvas_house_pins p
        WHERE p.pin_id = $1 AND p.manager_id = $2
      `, [existing.pin_id, assignment.manager_id]);
      const dncResult = await client.query(`
        SELECT 1 FROM canvas_dnc_suppressions
        WHERE manager_id = $1 AND house_key = $2 AND active
        LIMIT 1
      `, [assignment.manager_id, rows(pinResult)[0]?.house_key || decision.house_key]);
      await client.query("COMMIT");
      return {
        status: "already_applied",
        event: publicEvent(existing),
        pin: mapPin(rows(pinResult)[0], rows(dncResult).length > 0)
      };
    }

    if (decision.outcome === "do_not_knock") {
      await lockKey(client, `canvas:dnc:${assignment.manager_id}`);
    }
    const workUnit = await findOwnedWorkUnit(client, assignment, decision.point);
    await lockKey(client, `canvas:house:${assignment.manager_id}:${decision.house_key}`);
    const pin = await findPinForUpdate(client, assignment, decision);
    if (pin?.house_key && String(pin.house_key) !== String(decision.house_key)) {
      throw new HttpError(409, "pin_identity_mismatch", "The submitted house identity does not match the selected Canvas pin.");
    }
    const existingDnc = rows(await client.query(`
      SELECT *
      FROM canvas_dnc_suppressions
      WHERE manager_id = $1 AND active
        AND (
          house_key = $2
          OR ST_DWithin(
            point::geography,
            ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
            $5
          )
        )
      ORDER BY CASE WHEN house_key = $2 THEN 0 ELSE 1 END
      LIMIT 1
      FOR UPDATE
    `, [
      assignment.manager_id,
      decision.house_key,
      decision.point.lng,
      decision.point.lat,
      DNC_HOUSE_MATCH_METERS
    ]))[0];
    if (existingDnc && decision.outcome !== "do_not_knock") {
      throw new HttpError(
        409,
        "dnc_house_protected",
        "This house is on the tenant do-not-knock list. Ordinary outcomes cannot replace or obscure that protection."
      );
    }
    const pinId = pin?.pin_id || crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const clientTime = Date.parse(decision.client_recorded_at);
    const latestClientTime = pin ? Date.parse(pin.latest_client_recorded_at) : -Infinity;
    const appliesToLatest = !pin || clientTime >= latestClientTime;
    const pinVersion = pin ? Number(pin.version) + (appliesToLatest ? 1 : 0) : 1;

    const eventChange = await insertChange(client, {
      managerId: assignment.manager_id,
      campaignId: assignment.campaign_id,
      zoneId: assignment.zone_id,
      assignmentId: assignment.assignment_id,
      type: "decision_event",
      entityId: eventId,
      version: 1,
      payload: {
        event_id: eventId,
        pin_id: pinId,
        house_key: decision.house_key,
        street_unit_id: workUnit.work_unit_id,
        outcome: decision.outcome,
        note: decision.note,
        point: decision.point,
        client_recorded_at: decision.client_recorded_at,
        applied_to_latest: appliesToLatest,
        pin_version: pinVersion
      }
    });

    const insertedEvent = rows(await client.query(`
      INSERT INTO canvas_house_events (
        event_id, manager_id, campaign_id, zone_id, assignment_id,
        actor_user_id, actor_team_member_id, idempotency_key, request_hash,
        change_cursor, pin_id, opportunity_id, street_unit_id, outcome,
        note, address, building_feature_id, unit_label, point,
        client_recorded_at, applied_to_latest, pin_version
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18,
        ST_SetSRID(ST_MakePoint($19, $20), 4326), $21, $22, $23
      )
      RETURNING *
    `, [
      eventId, assignment.manager_id, assignment.campaign_id, assignment.zone_id, assignment.assignment_id,
      context.user.id, context.actor.teamMemberId, decision.idempotency_key, requestHash,
      eventChange.cursor, pinId, decision.opportunity_id, workUnit.work_unit_id, decision.outcome,
      decision.note, decision.address, decision.building_feature_id, decision.unit_label,
      decision.point.lng, decision.point.lat, decision.client_recorded_at, appliesToLatest, pinVersion
    ]))[0];

    let currentPin = pin;
    let pinChange: any = null;
    if (appliesToLatest) {
      pinChange = await insertChange(client, {
        managerId: assignment.manager_id,
        campaignId: assignment.campaign_id,
        zoneId: assignment.zone_id,
        assignmentId: assignment.assignment_id,
        type: "pin_upsert",
        entityId: pinId,
        version: pinVersion,
        payload: {
          pin_id: pinId,
          house_key: decision.house_key,
          opportunity_id: decision.opportunity_id,
          street_unit_id: workUnit.work_unit_id,
          point: decision.point,
          address: decision.address,
          unit_label: decision.unit_label,
          latest_outcome: decision.outcome,
          latest_note: decision.note,
          latest_event_id: eventId,
          latest_client_recorded_at: decision.client_recorded_at,
          version: pinVersion
        }
      });
      if (pin) {
        currentPin = rows(await client.query(`
          UPDATE canvas_house_pins SET
            opportunity_id = COALESCE($6, opportunity_id),
            street_unit_id = $7,
            point = ST_SetSRID(ST_MakePoint($8, $9), 4326),
            address = COALESCE($10, address),
            normalized_address = COALESCE($11, normalized_address),
            building_feature_id = COALESCE($12, building_feature_id),
            unit_label = COALESCE($13, unit_label),
            normalized_unit_label = COALESCE($14, normalized_unit_label),
            latest_outcome = $15, latest_note = $16, latest_event_id = $17,
            latest_change_cursor = $18, latest_client_recorded_at = $19,
            last_event_at = NOW(), last_actor_user_id = $20,
            last_actor_team_member_id = $21, version = $22, updated_at = NOW()
          WHERE pin_id = $1 AND manager_id = $2 AND campaign_id = $3
            AND zone_id = $4 AND assignment_id = $5
          RETURNING *, ST_Y(point) AS lat, ST_X(point) AS lng
        `, [
          pinId, assignment.manager_id, assignment.campaign_id, assignment.zone_id, assignment.assignment_id,
          decision.opportunity_id, workUnit.work_unit_id, decision.point.lng, decision.point.lat,
          decision.address, decision.normalized_address, decision.building_feature_id,
          decision.unit_label, decision.normalized_unit_label, decision.outcome, decision.note,
          eventId, pinChange.cursor, decision.client_recorded_at, context.user.id,
          context.actor.teamMemberId, pinVersion
        ]))[0];
      } else {
        currentPin = rows(await client.query(`
          INSERT INTO canvas_house_pins (
            pin_id, manager_id, campaign_id, zone_id, assignment_id, house_key,
            opportunity_id, street_unit_id, point, address, normalized_address,
            building_feature_id, unit_label, normalized_unit_label, latest_outcome,
            latest_note, latest_event_id, latest_change_cursor,
            latest_client_recorded_at, last_event_at, last_actor_user_id,
            last_actor_team_member_id, version
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            ST_SetSRID(ST_MakePoint($9, $10), 4326), $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20, NOW(), $21, $22, $23
          )
          RETURNING *, ST_Y(point) AS lat, ST_X(point) AS lng
        `, [
          pinId, assignment.manager_id, assignment.campaign_id, assignment.zone_id, assignment.assignment_id,
          decision.house_key, decision.opportunity_id, workUnit.work_unit_id,
          decision.point.lng, decision.point.lat, decision.address, decision.normalized_address,
          decision.building_feature_id, decision.unit_label, decision.normalized_unit_label,
          decision.outcome, decision.note, eventId, pinChange.cursor, decision.client_recorded_at,
          context.user.id, context.actor.teamMemberId, pinVersion
        ]))[0];
      }
    } else {
      currentPin = { ...pin, lat: Number(pin.lat), lng: Number(pin.lng) };
    }

    let dnc = existingDnc || null;
    let dncCreated = false;
    if (decision.outcome === "do_not_knock" && !existingDnc) {
      const suppressionId = crypto.randomUUID();
      const dncChange = await insertChange(client, {
        managerId: assignment.manager_id,
        campaignId: assignment.campaign_id,
        zoneId: assignment.zone_id,
        assignmentId: assignment.assignment_id,
        type: "dnc_upsert",
        entityId: suppressionId,
        version: 1,
        payload: {
          suppression_id: suppressionId,
          house_key: decision.house_key,
          point: decision.point,
          source_event_id: eventId,
          active: true,
          version: 1
        }
      });
      dnc = rows(await client.query(`
        INSERT INTO canvas_dnc_suppressions (
          suppression_id, manager_id, house_key, point, source_event_id,
          source_campaign_id, source_zone_id, set_by_user_id, active,
          version, change_cursor
        ) VALUES (
          $1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326),
          $6, $7, $8, $9, TRUE, 1, $10
        )
        RETURNING *
      `, [
        suppressionId, assignment.manager_id, decision.house_key,
        decision.point.lng, decision.point.lat, eventId, assignment.campaign_id,
        assignment.zone_id, context.user.id, dncChange.cursor
      ]))[0];
      dncCreated = true;
    }
    // Deliberately no inverse branch: ordinary outcomes never clear a DNC.

    await lockKey(client, `canvas:progress:${assignment.manager_id}:${assignment.campaign_id}:${assignment.zone_id}`);
    const progressRow = rows(await client.query(`
      SELECT * FROM canvas_zone_progress
      WHERE manager_id = $1 AND campaign_id = $2 AND zone_id = $3
      FOR UPDATE
    `, [assignment.manager_id, assignment.campaign_id, assignment.zone_id]))[0];
    const outcomeCounts = parseOutcomeCounts(progressRow?.outcome_counts);
    if (appliesToLatest) updateOutcomeCounts(outcomeCounts, pin?.latest_outcome || null, decision.outcome);
    const progress = {
      distinct_pin_count: Number(progressRow?.distinct_pin_count || 0) + (pin ? 0 : 1),
      event_count: Number(progressRow?.event_count || 0) + 1,
      active_dnc_count: Number(progressRow?.active_dnc_count || 0) + (dncCreated ? 1 : 0),
      outcome_counts: outcomeCounts,
      version: Number(progressRow?.version || 0) + 1
    };
    const progressChange = await insertChange(client, {
      managerId: assignment.manager_id,
      campaignId: assignment.campaign_id,
      zoneId: assignment.zone_id,
      assignmentId: assignment.assignment_id,
      type: "progress_changed",
      entityId: `${assignment.campaign_id}:${assignment.zone_id}`,
      version: progress.version,
      payload: progress
    });
    await client.query(`
      INSERT INTO canvas_zone_progress (
        manager_id, campaign_id, zone_id, distinct_pin_count, event_count,
        active_dnc_count, outcome_counts, last_change_cursor, version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
      ON CONFLICT (manager_id, campaign_id, zone_id) DO UPDATE SET
        distinct_pin_count = EXCLUDED.distinct_pin_count,
        event_count = EXCLUDED.event_count,
        active_dnc_count = EXCLUDED.active_dnc_count,
        outcome_counts = EXCLUDED.outcome_counts,
        last_change_cursor = EXCLUDED.last_change_cursor,
        version = EXCLUDED.version,
        updated_at = NOW()
    `, [
      assignment.manager_id, assignment.campaign_id, assignment.zone_id,
      progress.distinct_pin_count, progress.event_count, progress.active_dnc_count,
      JSON.stringify(progress.outcome_counts), progressChange.cursor, progress.version
    ]);

    await client.query("COMMIT");
    return {
      status: "applied",
      event: publicEvent(insertedEvent),
      pin: mapPin(currentPin, Boolean(dnc?.active)),
      dnc_active: Boolean(dnc?.active),
      progress: { ...progress, last_change_cursor: Number(progressChange.cursor) }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function postgresErrorCode(error: any) {
  return String(error?.code || error?.cause?.code || "");
}

Deno.serve(async (req) => {
  let client: any = null;
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) return json({ error: "unauthorized", message: "Sign in to sync Canvas decisions." }, 401);
    const actor = await resolveActor(base44, user);

    const declaredLength = Number(req.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ error: "decision_batch_too_large", message: "Canvas decision batches may not exceed 256 KB." }, 413);
    }
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ error: "decision_batch_too_large", message: "Canvas decision batches may not exceed 256 KB." }, 413);
    }
    let body: any;
    try {
      body = JSON.parse(rawBody || "{}");
    } catch {
      throw new HttpError(400, "invalid_json", "The Canvas decision batch is not valid JSON.");
    }
    const assignmentId = requiredString(body.assignment_id, "assignment_id", 256);
    const packageVersion = Number(body.package_version);
    if (!Number.isInteger(packageVersion) || packageVersion < 1) {
      throw new HttpError(400, "invalid_package_version", "package_version must be a positive integer.");
    }
    if (!Array.isArray(body.decisions) || body.decisions.length < 1 || body.decisions.length > MAX_DECISIONS) {
      throw new HttpError(400, "invalid_decision_batch", `decisions must contain between 1 and ${MAX_DECISIONS} items.`);
    }
    const decisions = body.decisions.map(validateDecision);

    const databaseUrl = Deno.env.get("CANVAS_DATABASE_URL") || "";
    if (!databaseUrl) throw new HttpError(503, "canvas_database_unavailable", "Canvas decision sync is not configured.", true);
    client = new Client(databaseUrl);
    await client.connect();
    await loadAssignment(client, assignmentId, actor, user, packageVersion, false);

    const results = [];
    for (const decision of decisions) {
      try {
        const result = await syncOneDecision(client, { assignmentId, packageVersion, actor, user }, decision);
        results.push({ idempotency_key: decision.idempotency_key, ok: true, ...result });
      } catch (error) {
        const dbCode = postgresErrorCode(error);
        if (error instanceof HttpError) {
          results.push({
            idempotency_key: decision.idempotency_key,
            ok: false,
            error: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.details ? { details: error.details } : {})
          });
        } else if (["40001", "40P01"].includes(dbCode)) {
          results.push({
            idempotency_key: decision.idempotency_key,
            ok: false,
            error: "canvas_sync_conflict",
            message: "The decision conflicted with another update and should be retried.",
            retryable: true
          });
        } else {
          console.error("[canvasSyncDecisions] decision transaction failed", { code: dbCode || "unknown" });
          results.push({
            idempotency_key: decision.idempotency_key,
            ok: false,
            error: "canvas_sync_failed",
            message: "The decision could not be committed and should be retried.",
            retryable: true
          });
        }
      }
    }
    const applied = results.filter((result: any) => result.ok && result.status === "applied").length;
    const alreadyApplied = results.filter((result: any) => result.ok && result.status === "already_applied").length;
    const rejected = results.length - applied - alreadyApplied;
    return json({
      success: rejected === 0,
      assignment_id: assignmentId,
      package_version: packageVersion,
      accepted: applied + alreadyApplied,
      applied,
      already_applied: alreadyApplied,
      rejected,
      results
    }, rejected ? 207 : 200);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.code, message: error.message, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) }, error.status);
    }
    console.error("[canvasSyncDecisions] request failed");
    return json({ error: "canvas_sync_unavailable", message: "Canvas decision sync is temporarily unavailable.", retryable: true }, 503);
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
});
