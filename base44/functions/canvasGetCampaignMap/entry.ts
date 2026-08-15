// base44/functions/canvasGetCampaignMap/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// base44/functions/canvasGetCampaignMap/canvasLifecycleSignature.js
var LIFECYCLE_STATES = /* @__PURE__ */ new Set(["active", "completed", "recalled"]);
function asArray(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}
async function sha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function canvasRepTeamMemberIds(session) {
  return [...new Set(asArray(session?.zones).map((zone) => String(zone?.assigned_team_member_id || "").trim()).filter(Boolean))].sort();
}
function canvasStoredPlanForHash(session) {
  const deploymentPlanVersion = Number(session?.deployment_plan_version);
  const planVersion = Number.isInteger(deploymentPlanVersion) && deploymentPlanVersion > 0 ? deploymentPlanVersion : Number(session?.version);
  return {
    session_name: session?.session_name || "Canvas Campaign",
    territory_model: session?.territory_model || "street_territory_v1",
    polygon: asArray(session?.polygon),
    rep_count: Number(session?.rep_count || 0),
    planning_method: session?.planning_method,
    assignment_basis: session?.assignment_basis,
    workload_basis: session?.workload_basis,
    division_mode: session?.division_mode,
    target_workload: session?.target_workload === null || session?.target_workload === void 0 ? null : Number(session.target_workload),
    ...Array.isArray(session?.selected_team_member_ids) ? { selected_team_member_ids: session.selected_team_member_ids } : {},
    zones: asArray(session?.zones),
    work_units: asArray(session?.work_units),
    qa: session?.qa || {},
    algorithm_version: session?.algorithm_version || null,
    data_version: session?.data_version || null,
    ...session?.territory_model === "residential_street_territory_v2" ? { evidence_id: session?.evidence_id, evidence_release_id: session?.evidence_release_id || null, revision_id: session?.revision_id || null, snapshot_hash: session?.snapshot_hash, evidence_schema_version: Number(session?.evidence_schema_version), unresolved_unit_count: Number(session?.unresolved_unit_count || 0), assignment_version: Number(session?.assignment_version || 0) } : {},
    manager_id: session?.manager_id,
    version: planVersion
  };
}
function canvasLifecycleSignaturePayload(session, repIds = canvasRepTeamMemberIds(session)) {
  return {
    purpose: "firstknock-canvas-lifecycle-v2",
    session_id: session?.id,
    manager_id: session?.manager_id,
    status: session?.status,
    version: Number(session?.version),
    deployment_plan_version: Number(session?.deployment_plan_version),
    plan_hash: session?.plan_hash,
    deployed_at: session?.deployed_at,
    deployed_by_user_id: session?.deployed_by_user_id,
    deployment_idempotency_key: session?.deployment_idempotency_key,
    rep_team_member_ids: [...new Set(asArray(repIds).map(String).filter(Boolean))].sort(),
    lifecycle_state: session?.lifecycle_state || null,
    lifecycle_evidence: session?.lifecycle_evidence || null,
    closed_at: session?.closed_at || null,
    closed_by_user_id: session?.closed_by_user_id || null,
    close_action: session?.close_action || null,
    close_idempotency_key: session?.close_idempotency_key || null,
    deployment_qa: session?.deployment_qa || null
  };
}
async function signCanvasLifecycle(secret, session, repIds = canvasRepTeamMemberIds(session)) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const payload = canvasLifecycleSignaturePayload(session, repIds);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(JSON.stringify(canonicalize(payload)))
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function hasExactLifecycleShape(session, requiredState) {
  const state = String(session?.lifecycle_state || "");
  const qa = session?.deployment_qa || {};
  const evidence = session?.lifecycle_evidence || {};
  if (!LIFECYCLE_STATES.has(state) || requiredState && state !== requiredState || String(qa.lifecycle_state || "") !== state || String(evidence.state || "") !== state || Number(evidence.schema_version) !== 1 || String(evidence.transitioned_at || "") !== String(qa.lifecycle_transitioned_at || "") || String(evidence.transitioned_by_user_id || "") !== String(qa.lifecycle_transitioned_by_user_id || "") || Number(evidence.to_version) !== Number(session?.version)) return false;
  const deploymentPlanVersion = Number(session?.deployment_plan_version);
  if (!Number.isInteger(deploymentPlanVersion) || deploymentPlanVersion < 1) return false;
  if (state === "active") {
    return session?.status === "deployed" && evidence.transition === "deploy" && qa.lifecycle_transition === "deploy" && String(evidence.transitioned_at || "") === String(session?.deployed_at || "") && String(evidence.transitioned_by_user_id || "") === String(session?.deployed_by_user_id || "") && String(evidence.idempotency_key || "") === String(session?.deployment_idempotency_key || "") && Number(evidence.from_version) === Number(session?.version) && evidence.previous_signature === null && !session?.closed_at && !session?.closed_by_user_id && !session?.close_action && !session?.close_idempotency_key;
  }
  const action = state === "completed" ? "complete" : "recall";
  return session?.status === state && String(session?.close_action || "") === action && String(session?.close_idempotency_key || "") !== "" && String(session?.closed_at || "") !== "" && String(session?.closed_by_user_id || "") !== "" && evidence.transition === action && qa.lifecycle_transition === action && String(evidence.transitioned_at || "") === String(session.closed_at) && String(evidence.transitioned_by_user_id || "") === String(session.closed_by_user_id) && String(evidence.idempotency_key || "") === String(session.close_idempotency_key) && Number(evidence.from_version) === Number(session.version) - 1 && deploymentPlanVersion <= Number(evidence.from_version) && /^[a-f0-9]{64}$/.test(String(evidence.previous_signature || ""));
}
async function verifyCanvasLifecycleSession(secret, session, requiredState = null) {
  if (!session?.plan_hash || !session?.deployment_signature || !hasExactLifecycleShape(session, requiredState)) return false;
  const calculatedPlanHash = await sha256(canvasStoredPlanForHash(session));
  if (calculatedPlanHash !== session.plan_hash) return false;
  const calculatedSignature = await signCanvasLifecycle(secret, session, canvasRepTeamMemberIds(session));
  return calculatedSignature === session.deployment_signature;
}

// base44/functions/canvasGetCampaignMap/entry.ts
var PAGE_SIZE = 500;
var MAX_PINS = 1e4;
var MAX_EVENTS = 2e4;
var MAX_DNC_PINS = 2e4;
var MAX_LIFECYCLE_ROWS = 1e4;
var HttpError = class extends Error {
  status;
  code;
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
};
function asArray2(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
function normalized(value) {
  return String(value || "").trim().toLowerCase();
}
function canManageCanvas(user) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ["manager", "admin"].includes(appRole) || ["manager", "admin"].includes(accountRole);
}
function deploymentSigningSecret() {
  const secret = Deno.env.get("CANVAS_DEPLOYMENT_SIGNING_SECRET") || "";
  if (secret.length < 32) throw new HttpError(503, "canvas_signing_unavailable", "Canvas lifecycle verification is not configured.");
  return secret;
}
async function resolveAuthenticatedTeamMember(base44, user) {
  const managerId = String(user?.team_manager_id || user?.data?.team_manager_id || "").trim();
  if (!managerId) return null;
  const candidates = asArray2(await base44.entities.TeamMember.filter({ user_id: user.id, status: "active" }, "-updated_date", 20).catch(() => [])).filter((member) => member.user_id === user.id && member.manager_id === managerId && member.status === "active" && normalized(member.role) === "rep");
  const unique = new Map(candidates.map((member) => [member.id, member]));
  if (unique.size > 1) throw new HttpError(409, "ambiguous_team_membership", "More than one active rep record matches this account.");
  return unique.size ? [...unique.values()][0] : null;
}
function bindingMatches(session, member, user) {
  const binding = asArray2(session?.deployment_qa?.verified_team_member_bindings).find((candidate) => String(candidate?.team_member_id || "") === String(member?.id || ""));
  return binding && String(binding.user_id || "") === String(user.id || "") && normalized(binding.email) === normalized(user.email) && String(member.user_id || "") === String(user.id || "");
}
async function loadLifecycle(base44, managerId, secret) {
  const rows = [];
  for (const status of ["deployed", "completed", "recalled"]) {
    let offset = 0;
    while (true) {
      const page = asArray2(await base44.asServiceRole.entities.CanvasSession.filter({ manager_id: managerId, status }, "-deployed_at", PAGE_SIZE, offset));
      rows.push(...page);
      if (rows.length > MAX_LIFECYCLE_ROWS) throw new HttpError(503, "canvas_lifecycle_scan_limit", "Canvas lifecycle history exceeds the safe map verification limit.");
      if (page.length < PAGE_SIZE) break;
      offset += page.length;
    }
  }
  const valid = [];
  for (const row of [...new Map(rows.map((item) => [item.id, item])).values()]) {
    if (!await verifyCanvasLifecycleSession(secret, row)) throw new HttpError(409, "canvas_lifecycle_integrity_failed", "Canvas lifecycle history failed integrity verification.");
    valid.push(row);
  }
  return valid;
}
function supersededByMap(sessions) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const result = /* @__PURE__ */ new Map();
  for (const newer of sessions) {
    const newerAt = Date.parse(newer.deployed_at || "");
    for (const olderId of asArray2(newer.deployment_qa?.superseded_session_ids)) {
      const older = byId.get(olderId);
      if (!older || older.manager_id !== newer.manager_id || newer.id === older.id) continue;
      if (newerAt >= Date.parse(older.deployed_at || "")) result.set(older.id, newer.id);
    }
  }
  return result;
}
async function pagedFilter(entity, filter, sort, maximum) {
  const rows = [];
  for (let offset = 0; offset < maximum; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, maximum - rows.length);
    const page = asArray2(await entity.filter(filter, sort, limit, offset));
    rows.push(...page);
    if (page.length < limit) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
async function pagedFilterByVisibleZones(entity, filter, zoneIds, sort, maximum) {
  const uniqueZoneIds = [...new Set(asArray2(zoneIds).map(String).filter(Boolean))].sort();
  if (!uniqueZoneIds.length) return { rows: [], truncated: false };
  const baseQuota = Math.floor(maximum / uniqueZoneIds.length);
  const quotaRemainder = maximum % uniqueZoneIds.length;
  const byId = /* @__PURE__ */ new Map();
  let truncated = false;
  for (let index = 0; index < uniqueZoneIds.length; index += 1) {
    const zoneId = uniqueZoneIds[index];
    const zoneMaximum = baseQuota + (index < quotaRemainder ? 1 : 0);
    const result = await pagedFilter(entity, { ...filter, zone_id: zoneId }, sort, zoneMaximum);
    truncated ||= result.truncated;
    for (const row of result.rows) {
      if (String(row?.zone_id || "") !== zoneId) continue;
      const identity = String(row?.id || `${zoneId}:${byId.size}`);
      if (!byId.has(identity)) byId.set(identity, row);
    }
  }
  return { rows: [...byId.values()], truncated };
}
async function loadCompleteDncPins(entity, filter, zoneIds, manager) {
  const visibleZoneIds = [...new Set(asArray2(zoneIds).map(String).filter(Boolean))].sort();
  const byId = /* @__PURE__ */ new Map();
  const addRows = (rows, expectedZoneId = null) => {
    for (const row of rows) {
      if (String(row?.manager_id || "") !== String(filter.manager_id || "") || String(row?.campaign_id || "") !== String(filter.campaign_id || "")) {
        throw new HttpError(503, "dnc_safety_integrity_failed", "A do-not-knock pin failed campaign ownership verification. The map was withheld for safety.");
      }
      if (String(row?.latest_outcome || "") !== "do_not_knock") continue;
      if (expectedZoneId && String(row?.zone_id || "") !== expectedZoneId) continue;
      const id = String(row?.id || "");
      if (!id) throw new HttpError(503, "dnc_safety_integrity_failed", "A do-not-knock pin is missing its durable identity. The map was withheld for safety.");
      byId.set(id, row);
    }
  };
  if (manager) {
    const result = await pagedFilter(entity, { ...filter, latest_outcome: "do_not_knock" }, "-last_event_at", MAX_DNC_PINS + 1);
    addRows(result.rows);
    if (result.truncated || byId.size > MAX_DNC_PINS) {
      throw new HttpError(503, "dnc_safety_limit_exceeded", `This campaign exceeds the ${MAX_DNC_PINS} do-not-knock safety-pin limit. The map was withheld rather than returning an incomplete suppression list.`);
    }
    return [...byId.values()];
  }
  for (const zoneId of visibleZoneIds) {
    const remainingWithSentinel = MAX_DNC_PINS + 1 - byId.size;
    if (remainingWithSentinel <= 0) {
      throw new HttpError(503, "dnc_safety_limit_exceeded", `This assignment exceeds the ${MAX_DNC_PINS} do-not-knock safety-pin limit. The map was withheld rather than returning an incomplete suppression list.`);
    }
    const result = await pagedFilter(entity, { ...filter, zone_id: zoneId, latest_outcome: "do_not_knock" }, "-last_event_at", remainingWithSentinel);
    addRows(result.rows, zoneId);
    if (result.truncated || byId.size > MAX_DNC_PINS) {
      throw new HttpError(503, "dnc_safety_limit_exceeded", `This assignment exceeds the ${MAX_DNC_PINS} do-not-knock safety-pin limit. The map was withheld rather than returning an incomplete suppression list.`);
    }
  }
  return [...byId.values()];
}
function publicPin(pin) {
  return {
    pin_id: pin.id,
    campaign_id: pin.campaign_id,
    zone_id: pin.zone_id,
    lat: pin.lat,
    lng: pin.lng,
    address: pin.address || null,
    building_feature_id: pin.building_feature_id || null,
    unit_label: pin.unit_label || null,
    latest_outcome: pin.latest_outcome,
    latest_note: pin.latest_note || null,
    latest_client_recorded_at: pin.latest_client_recorded_at || null,
    last_event_at: pin.last_event_at || null,
    last_actor_team_member_id: pin.last_actor_team_member_id || null,
    version: Number(pin.version || 1)
  };
}
function publicEvent(event) {
  return {
    event_id: event.id,
    pin_id: event.pin_id,
    campaign_id: event.campaign_id,
    zone_id: event.zone_id,
    actor_team_member_id: event.actor_team_member_id || null,
    outcome: event.outcome,
    note: event.note || null,
    lat: event.lat,
    lng: event.lng,
    address: event.address || null,
    building_feature_id: event.building_feature_id || null,
    unit_label: event.unit_label || null,
    client_recorded_at: event.client_recorded_at,
    server_recorded_at: event.server_recorded_at,
    applied_to_latest: event.applied_to_latest === true
  };
}
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const campaignId = String(body?.campaign_id ?? body?.session_id ?? "").trim();
    if (!campaignId || campaignId.length > 256) throw new HttpError(400, "invalid_campaign_id", "campaign_id is required or invalid.");
    const includeEvents = body?.include_events === true;
    const manager = canManageCanvas(user);
    const member = manager ? null : await resolveAuthenticatedTeamMember(base44, user);
    if (!manager && !member) throw new HttpError(403, "team_membership_required", "No active linked rep record was found for this account.");
    const session = manager ? await base44.entities.CanvasSession.get(campaignId).catch(() => null) : await base44.asServiceRole.entities.CanvasSession.get(campaignId).catch(() => null);
    if (!session) throw new HttpError(404, "campaign_not_found", "Canvas campaign not found.");
    const managerId = manager ? user.id : member.manager_id;
    if (String(session.manager_id || "") !== String(managerId || "")) throw new HttpError(403, "forbidden", "This Canvas campaign belongs to another team.");
    let effectiveStatus = session.status || "draft";
    let supersededBySessionId = null;
    if (session.status !== "draft") {
      const secret = deploymentSigningSecret();
      const lifecycle = await loadLifecycle(base44, managerId, secret);
      const superseded = supersededByMap(lifecycle);
      supersededBySessionId = superseded.get(session.id) || null;
      if (supersededBySessionId) effectiveStatus = "superseded";
      if (!manager && (session.status !== "deployed" || session.lifecycle_state !== "active" || supersededBySessionId)) {
        throw new HttpError(409, "campaign_not_active", "This Canvas assignment is no longer active. Refresh assignments.");
      }
    } else if (!manager) {
      throw new HttpError(403, "draft_not_visible", "Canvas drafts are manager-only.");
    }
    const allZones = asArray2(session.zones);
    const visibleZones = manager ? allZones : allZones.filter((zone) => String(zone.assigned_team_member_id || "") === String(member.id));
    if (!manager && (!visibleZones.length || !bindingMatches(session, member, user))) {
      throw new HttpError(403, "zone_not_assigned", "This campaign has no area assigned to the authenticated rep.");
    }
    const visibleZoneIds = new Set(visibleZones.map((zone) => String(zone.zone_id)));
    // Residential Canvas v2 stores field decisions in the transactional
    // operational ledger. Managers load those decisions by viewport and read
    // totals from canvasGetCampaignSummary; resending every pin with the static
    // campaign geometry would recreate the national-scale polling bottleneck.
    // Legacy campaigns and rep callers always retain the complete Base44 path.
    const operationalViewport = manager
      && session.territory_model === "residential_street_territory_v2"
      && body?.include_pins === false;
    const pinFilter = { manager_id: managerId, campaign_id: campaignId };
    const pinResult = operationalViewport
      ? { rows: [], truncated: false }
      : manager
        ? await pagedFilter(base44.asServiceRole.entities.CanvasHousePin, pinFilter, "-last_event_at", MAX_PINS)
        : await pagedFilterByVisibleZones(base44.asServiceRole.entities.CanvasHousePin, pinFilter, [...visibleZoneIds], "-last_event_at", MAX_PINS);
    const dncPins = operationalViewport
      ? []
      : await loadCompleteDncPins(base44.asServiceRole.entities.CanvasHousePin, pinFilter, [...visibleZoneIds], manager);
    if (dncPins.some((pin) => !visibleZoneIds.has(String(pin.zone_id)))) {
      throw new HttpError(503, "dnc_safety_integrity_failed", "A do-not-knock pin no longer belongs to a campaign territory. The map was withheld for safety.");
    }
    const pinById = new Map(pinResult.rows.map((pin) => [String(pin?.id || ""), pin]));
    for (const pin of dncPins) pinById.set(String(pin.id), pin);
    const pins = [...pinById.values()].filter((pin) => pin.manager_id === managerId && pin.campaign_id === campaignId && visibleZoneIds.has(String(pin.zone_id)));
    let events = [];
    let eventsTruncated = false;
    if (includeEvents && !operationalViewport) {
      const eventFilter = {
        manager_id: managerId,
        campaign_id: campaignId,
        write_status: "committed"
      };
      const eventResult = manager ? await pagedFilter(base44.asServiceRole.entities.CanvasHouseEvent, eventFilter, "-server_recorded_at", MAX_EVENTS) : await pagedFilterByVisibleZones(base44.asServiceRole.entities.CanvasHouseEvent, eventFilter, [...visibleZoneIds], "-server_recorded_at", MAX_EVENTS);
      events = eventResult.rows.filter((event) => event.manager_id === managerId && event.campaign_id === campaignId && event.write_status === "committed" && visibleZoneIds.has(String(event.zone_id)));
      eventsTruncated = eventResult.truncated;
    }
    const outcomeCounts = {};
    const zoneCounts = Object.fromEntries(visibleZones.map((zone) => [zone.zone_id, { total_pins: 0, outcomes: {} }]));
    for (const pin of pins) {
      const outcome = String(pin.latest_outcome || "unknown");
      outcomeCounts[outcome] = (outcomeCounts[outcome] || 0) + 1;
      const summary = zoneCounts[pin.zone_id];
      if (summary) {
        summary.total_pins += 1;
        summary.outcomes[outcome] = (summary.outcomes[outcome] || 0) + 1;
      }
    }
    const visibleWorkUnitIds = new Set(visibleZones.flatMap((zone) => asArray2(zone.work_unit_ids).map(String)));
    const workUnits = asArray2(session.work_units).filter((unit) => visibleWorkUnitIds.has(String(unit.id)));
    return Response.json({
      success: true,
      access_scope: manager ? "manager_global" : "rep_assigned_zones",
      decision_delivery: operationalViewport ? "operational_viewport" : "embedded",
      campaign: {
        campaign_id: session.id,
        session_name: session.session_name || "Canvas Campaign",
        territory_model: session.territory_model,
        planning_method: session.planning_method,
        assignment_basis: session.assignment_basis,
        workload_basis: session.workload_basis,
        division_mode: session.division_mode,
        target_workload: session.target_workload ?? null,
        plan_hash: manager ? session.plan_hash || null : void 0,
        algorithm_version: manager ? session.algorithm_version || null : void 0,
        data_version: manager ? session.data_version || null : void 0,
        area_count: manager ? allZones.length : void 0,
        rep_count: manager ? Number(session.rep_count || 0) : void 0,
        selected_team_member_ids: manager ? asArray2(session.selected_team_member_ids).map(String) : void 0,
        qa: manager ? session.qa || {} : void 0,
        status: effectiveStatus,
        stored_status: session.status,
        lifecycle_state: session.lifecycle_state || null,
        superseded_by_session_id: supersededBySessionId,
        version: Number(session.version || 0),
        deployed_at: session.deployed_at || null,
        draft_saved_at: manager ? session.draft_saved_at || null : void 0,
        closed_at: session.closed_at || null,
        polygon: session.polygon,
        zones: visibleZones,
        work_units: workUnits
      },
      pins: pins.map(publicPin),
      events: includeEvents && !operationalViewport ? events.map(publicEvent) : void 0,
      outcome_counts: outcomeCounts,
      zone_counts: zoneCounts,
      total_pins: pins.length,
      total_events: includeEvents && !operationalViewport ? events.length : null,
      dnc_safety: operationalViewport
        ? { complete: true, delivery: "operational_viewport", pin_count: null }
        : { complete: true, delivery: "embedded", pin_count: dncPins.length, hard_limit: MAX_DNC_PINS },
      truncated: { pins: pinResult.truncated, events: eventsTruncated },
      server_time: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error("[canvasGetCampaignMap]", error?.message || error);
    return Response.json({ error: "canvas_campaign_map_unavailable", message: "Canvas campaign map data could not be loaded." }, { status: 503 });
  }
});
