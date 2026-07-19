// base44/functions/canvasLogHouseDecision/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// base44/functions/canvasLogHouseDecision/canvasLifecycleSignature.js
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
    ...session?.territory_model === "residential_street_territory_v2" ? { evidence_id: session?.evidence_id, revision_id: session?.revision_id || null, snapshot_hash: session?.snapshot_hash, evidence_schema_version: Number(session?.evidence_schema_version), unresolved_unit_count: Number(session?.unresolved_unit_count || 0), assignment_version: Number(session?.assignment_version || 0) } : {},
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

// base44/functions/canvasLogHouseDecision/entry.ts
var OUTCOMES = /* @__PURE__ */ new Set(["no_answer", "not_interested", "callback", "appointment", "sale", "do_not_knock"]);
var MAX_TARGETED_PIN_MATCHES = 50;
var MAX_ROAD_SNAP_METERS = 150;
var ROAD_AMBIGUITY_METERS = 12;
var ROAD_AMBIGUITY_RATIO = 1.5;
var PIN_MATCH_METERS = 12;
var ZONE_DECISION_LEASE_MS = 3e4;
var HttpError = class extends Error {
  status;
  code;
  details;
  constructor(status, code, message, details = void 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
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
function requiredString(value, field, maxLength = 256) {
  const result = String(value || "").trim();
  if (!result || result.length > maxLength) throw new HttpError(400, "invalid_decision", `${field} is required or invalid.`);
  return result;
}
function optionalString(value, field, maxLength) {
  if (value === void 0 || value === null || value === "") return null;
  const result = String(value).trim();
  if (result.length > maxLength) throw new HttpError(400, "invalid_decision", `${field} is too long.`);
  return result || null;
}
function normalizePoint(value) {
  const lat = Number(value?.lat ?? value?.[0]);
  const lng = Number(value?.lng ?? value?.lon ?? value?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new HttpError(400, "invalid_decision_location", "point must contain a valid latitude and longitude.");
  }
  return { lat, lng };
}
function deploymentSigningSecret() {
  const secret = Deno.env.get("CANVAS_DEPLOYMENT_SIGNING_SECRET") || "";
  if (secret.length < 32) throw new HttpError(503, "canvas_signing_unavailable", "Canvas assignment verification is not configured.");
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
async function signDecisionPayload(secret, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(canonicalize(payload))));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function campaignDecisionAnchorPayload(session) {
  return {
    purpose: "firstknock-canvas-decision-campaign-anchor-v1",
    manager_id: String(session?.manager_id || ""),
    campaign_id: String(session?.id || session?.campaign_id || ""),
    deployment_plan_version: Number(session?.deployment_plan_version),
    plan_hash: String(session?.plan_hash || "")
  };
}
function campaignDecisionStatePayload(state) {
  return {
    purpose: "firstknock-canvas-decision-campaign-state-v1",
    anchor_signature: String(state?.anchor_signature || ""),
    manager_id: String(state?.manager_id || ""),
    campaign_id: String(state?.campaign_id || ""),
    deployment_plan_version: Number(state?.deployment_plan_version),
    plan_hash: String(state?.plan_hash || ""),
    state: String(state?.state || ""),
    state_version: Number(state?.state_version),
    transition_action: String(state?.transition_action || ""),
    transition_idempotency_key: String(state?.transition_idempotency_key || ""),
    transition_started_at: String(state?.transition_started_at || ""),
    transition_completed_at: state?.transition_completed_at || null,
    superseded_by_campaign_id: state?.superseded_by_campaign_id || null
  };
}
function zoneDecisionAnchorPayload(session, zoneId) {
  return {
    purpose: "firstknock-canvas-decision-zone-anchor-v1",
    manager_id: String(session?.manager_id || ""),
    campaign_id: String(session?.id || session?.campaign_id || ""),
    zone_id: String(zoneId || ""),
    deployment_plan_version: Number(session?.deployment_plan_version),
    plan_hash: String(session?.plan_hash || "")
  };
}
async function verifyDecisionCampaignState(secret, session, state) {
  if (!state || String(state.manager_id || "") !== String(session.manager_id || "") || String(state.campaign_id || "") !== String(session.id || "") || Number(state.deployment_plan_version) !== Number(session.deployment_plan_version) || String(state.plan_hash || "") !== String(session.plan_hash || "")) return false;
  const expectedAnchor = await signDecisionPayload(secret, campaignDecisionAnchorPayload(session));
  if (String(state.anchor_signature || "") !== expectedAnchor) return false;
  return String(state.state_signature || "") === await signDecisionPayload(secret, campaignDecisionStatePayload(state));
}
async function loadDecisionCampaignState(base44, session, secret) {
  const rows = asArray2(await base44.asServiceRole.entities.CanvasDecisionCampaignState.filter({
    manager_id: session.manager_id,
    campaign_id: session.id
  }, "-updated_date", 2)).filter((row) => String(row.manager_id || "") === String(session.manager_id || "") && String(row.campaign_id || "") === String(session.id || ""));
  if (rows.length !== 1 || !await verifyDecisionCampaignState(secret, session, rows[0])) {
    throw new HttpError(409, "canvas_decision_state_integrity_failed", "The campaign decision gate failed tenant-scoped integrity verification.");
  }
  if (rows[0].state === "superseded") {
    throw new HttpError(409, "campaign_superseded", "This area was replaced by a newer Canvas campaign. Refresh assignments before logging.", { superseded_by_campaign_id: rows[0].superseded_by_campaign_id || null });
  }
  if (rows[0].state !== "active") throw new HttpError(409, "campaign_not_active", "This Canvas campaign is closing or closed. Refresh assignments.");
  return rows[0];
}
async function loadDecisionZoneState(base44, session, zoneId, secret) {
  const rows = asArray2(await base44.asServiceRole.entities.CanvasDecisionZoneState.filter({
    manager_id: session.manager_id,
    campaign_id: session.id,
    zone_id: zoneId
  }, "-updated_date", 2)).filter((row) => String(row.manager_id || "") === String(session.manager_id || "") && String(row.campaign_id || "") === String(session.id || "") && String(row.zone_id || "") === String(zoneId));
  if (rows.length !== 1) throw new HttpError(409, "canvas_zone_state_integrity_failed", "The assigned area decision state is missing or duplicated.");
  const expectedAnchor = await signDecisionPayload(secret, zoneDecisionAnchorPayload(session, zoneId));
  const state = rows[0];
  if (String(state.anchor_signature || "") !== expectedAnchor || Number(state.deployment_plan_version) !== Number(session.deployment_plan_version) || String(state.plan_hash || "") !== String(session.plan_hash || "")) {
    throw new HttpError(409, "canvas_zone_state_integrity_failed", "The assigned area decision state failed integrity verification.");
  }
  return state;
}
function distanceMeters(left, right) {
  const latRadians = (Number(left.lat) + Number(right.lat)) / 2 * Math.PI / 180;
  const x = (Number(right.lng) - Number(left.lng)) * Math.cos(latRadians) * 111320;
  const y = (Number(right.lat) - Number(left.lat)) * 110540;
  return Math.sqrt(x * x + y * y);
}
function distanceToSegmentMeters(point, start, end) {
  const latRadians = point.lat * Math.PI / 180;
  const toXY = (value) => ({
    x: (Number(value.lng) - point.lng) * Math.cos(latRadians) * 111320,
    y: (Number(value.lat) - point.lat) * 110540
  });
  const a = toXY(start);
  const b = toXY(end);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared)) : 0;
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  return Math.sqrt(x * x + y * y);
}
function pointOnBoundary(point, polygon) {
  for (let index = 0; index < polygon.length; index += 1) {
    if (distanceToSegmentMeters(point, polygon[index], polygon[(index + 1) % polygon.length]) <= 1) return true;
  }
  return false;
}
function pointInPolygon(point, polygon) {
  if (pointOnBoundary(point, polygon)) return true;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = a.lat > point.lat !== b.lat > point.lat && point.lng < (b.lng - a.lng) * (point.lat - a.lat) / (b.lat - a.lat || Number.EPSILON) + a.lng;
    if (intersects) inside = !inside;
  }
  return inside;
}
function resolveRoadOwnership(session, point, requestedZoneId) {
  if (!pointInPolygon(point, asArray2(session.polygon))) {
    throw new HttpError(422, "pin_outside_campaign", "Tap a house inside the campaign boundary.");
  }
  const unitToZone = /* @__PURE__ */ new Map();
  for (const zone of asArray2(session.zones)) {
    for (const unitId of asArray2(zone.work_unit_ids)) unitToZone.set(String(unitId), String(zone.zone_id));
  }
  const candidates = asArray2(session.work_units).map((unit) => ({
    work_unit_id: String(unit?.id || ""),
    canvas_role: unit?.canvas_role || null,
    zone_id: unitToZone.get(String(unit?.id || "")) || null,
    distance_meters: Math.min(...asArray2(unit?.segments).map((segment) => distanceToSegmentMeters(point, segment.start, segment.end)))
  })).filter((candidate) => candidate.work_unit_id && candidate.zone_id
    && (session.territory_model !== "residential_street_territory_v2" || candidate.canvas_role === "knock")
    && Number.isFinite(candidate.distance_meters)).sort((left, right) => left.distance_meters - right.distance_meters || left.work_unit_id.localeCompare(right.work_unit_id));
  const nearest = candidates[0];
  if (!nearest || nearest.distance_meters > MAX_ROAD_SNAP_METERS) {
    throw new HttpError(422, "pin_too_far_from_street", `Tap a house within ${MAX_ROAD_SNAP_METERS} meters of a campaign street.`, {
      nearest_distance_meters: nearest ? Number(nearest.distance_meters.toFixed(1)) : null
    });
  }
  const competing = candidates.find((candidate) => candidate.work_unit_id !== nearest.work_unit_id && candidate.zone_id !== nearest.zone_id);
  if (competing && competing.distance_meters <= MAX_ROAD_SNAP_METERS) {
    const gap = competing.distance_meters - nearest.distance_meters;
    const ratio = nearest.distance_meters <= 0.01 ? competing.distance_meters <= 0.01 ? 1 : Number.POSITIVE_INFINITY : competing.distance_meters / nearest.distance_meters;
    if (gap <= ROAD_AMBIGUITY_METERS && ratio <= ROAD_AMBIGUITY_RATIO) {
      throw new HttpError(409, "ambiguous_pin_territory", "This house is equally close to streets owned by different reps. Move the pin closer to the correct street.", {
        nearest: { work_unit_id: nearest.work_unit_id, zone_id: nearest.zone_id, distance_meters: Number(nearest.distance_meters.toFixed(1)) },
        competing: { work_unit_id: competing.work_unit_id, zone_id: competing.zone_id, distance_meters: Number(competing.distance_meters.toFixed(1)) }
      });
    }
  }
  if (nearest.zone_id !== requestedZoneId) {
    throw new HttpError(403, "pin_outside_assigned_zone", "This house belongs to a different rep area.", {
      requested_zone_id: requestedZoneId,
      resolved_zone_id: nearest.zone_id,
      work_unit_id: nearest.work_unit_id
    });
  }
  return { work_unit_id: nearest.work_unit_id, street_unit_id: nearest.work_unit_id, distance_meters: Number(nearest.distance_meters.toFixed(1)) };
}
function normalizeAddress(value) {
  return normalized(value).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeUnitLabel(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
function canonicalize2(value) {
  if (Array.isArray(value)) return value.map(canonicalize2);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize2(value[key])]));
}
async function sha2562(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize2(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function token() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function acquireZoneDecisionLease(base44, session, zoneId, actorUserId, secret) {
  const state = await loadDecisionZoneState(base44, session, zoneId, secret);
  const now = /* @__PURE__ */ new Date();
  const lockToken = token();
  const expiresAt = new Date(now.getTime() + ZONE_DECISION_LEASE_MS).toISOString();
  const generation = Math.max(0, Number(state.lease_generation || 0)) + 1;
  const mutation = await base44.asServiceRole.entities.CanvasDecisionZoneState.updateMany({
    id: state.id,
    manager_id: session.manager_id,
    campaign_id: session.id,
    zone_id: zoneId,
    anchor_signature: state.anchor_signature,
    lease_generation: Math.max(0, Number(state.lease_generation || 0)),
    $or: [
      { lease_token: null },
      { lease_token: { $exists: false } },
      { lease_expires_at: { $lte: now.toISOString() } }
    ]
  }, { $set: {
    lease_token: lockToken,
    lease_actor_user_id: actorUserId,
    lease_acquired_at: now.toISOString(),
    lease_expires_at: expiresAt,
    lease_generation: generation
  } });
  if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
    throw new HttpError(409, "zone_decision_write_in_progress", "Another house update is finishing in this area. Retry this saved decision with the same idempotency key.");
  }
  const locked = await base44.asServiceRole.entities.CanvasDecisionZoneState.get(state.id).catch(() => null);
  if (!locked || locked.lease_token !== lockToken || Number(locked.lease_generation) !== generation || locked.lease_expires_at !== expiresAt) {
    throw new HttpError(503, "decision_lock_unverified", "Canvas could not verify the decision write lock. Retry safely with the same idempotency key.");
  }
  return { state_id: state.id, token: lockToken, generation, expires_at: expiresAt };
}
async function renewZoneDecisionLease(base44, session, zoneId, lease) {
  const expiresAt = new Date(Date.now() + ZONE_DECISION_LEASE_MS).toISOString();
  const mutation = await base44.asServiceRole.entities.CanvasDecisionZoneState.updateMany({
    id: lease.state_id,
    manager_id: session.manager_id,
    campaign_id: session.id,
    zone_id: zoneId,
    lease_token: lease.token,
    lease_generation: lease.generation,
    lease_expires_at: { $gte: new Date().toISOString() }
  }, { $set: { lease_expires_at: expiresAt } });
  if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
    throw new HttpError(409, "decision_lease_lost", "The area write lease expired before the house decision committed. Retry with the same idempotency key.");
  }
  lease.expires_at = expiresAt;
}
async function releaseZoneDecisionLease(base44, session, zoneId, lease) {
  if (!lease) return;
  await base44.asServiceRole.entities.CanvasDecisionZoneState.updateMany({
    id: lease.state_id,
    manager_id: session.manager_id,
    campaign_id: session.id,
    zone_id: zoneId,
    lease_token: lease.token,
    lease_generation: lease.generation
  }, { $unset: {
    lease_token: "",
    lease_actor_user_id: "",
    lease_acquired_at: "",
    lease_expires_at: ""
  } }).catch(() => null);
}
function ownedPins(value, managerId, campaignId) {
  return asArray2(value).filter((pin) => pin.manager_id === managerId && pin.campaign_id === campaignId);
}
function nearestPin(pins, point) {
  return pins.map((pin) => ({ pin, distance: distanceMeters(pin, point) })).sort((left, right) => left.distance - right.distance || String(left.pin.id).localeCompare(String(right.pin.id)))[0] || null;
}
function pinsWithUnitIdentity(pins, normalizedUnitLabel) {
  return pins.filter((pin) => normalizeUnitLabel(pin.normalized_unit_label || pin.unit_label) === normalizedUnitLabel);
}
async function findExistingPin(base44, { managerId, campaignId, suppliedPinId, buildingFeatureId, normalizedAddress, normalizedUnitLabel, point }) {
  if (suppliedPinId) {
    const direct = await base44.asServiceRole.entities.CanvasHousePin.get(suppliedPinId).catch(() => null);
    if (!direct || direct.manager_id !== managerId || direct.campaign_id !== campaignId) {
      throw new HttpError(404, "pin_not_found", "The selected Canvas house pin was not found.");
    }
    return direct;
  }
  if (buildingFeatureId) {
    const matches = pinsWithUnitIdentity(ownedPins(await base44.asServiceRole.entities.CanvasHousePin.filter({
      manager_id: managerId,
      campaign_id: campaignId,
      building_feature_id: buildingFeatureId,
      ...(normalizedUnitLabel ? { normalized_unit_label: normalizedUnitLabel } : {})
    }, "-last_event_at", MAX_TARGETED_PIN_MATCHES), managerId, campaignId), normalizedUnitLabel);
    if (matches.length) return nearestPin(matches, point).pin;
  }
  if (normalizedAddress) {
    const matches = pinsWithUnitIdentity(ownedPins(await base44.asServiceRole.entities.CanvasHousePin.filter({
      manager_id: managerId,
      campaign_id: campaignId,
      normalized_address: normalizedAddress,
      ...(normalizedUnitLabel ? { normalized_unit_label: normalizedUnitLabel } : {})
    }, "-last_event_at", MAX_TARGETED_PIN_MATCHES), managerId, campaignId), normalizedUnitLabel);
    if (matches.length) return nearestPin(matches, point).pin;
  }
  const latDelta = PIN_MATCH_METERS / 110540;
  const lngDelta = PIN_MATCH_METERS / Math.max(1, 111320 * Math.cos(point.lat * Math.PI / 180));
  const candidates = pinsWithUnitIdentity(ownedPins(await base44.asServiceRole.entities.CanvasHousePin.filter({
    manager_id: managerId,
    campaign_id: campaignId,
    lat: { $gte: point.lat - latDelta, $lte: point.lat + latDelta },
    lng: { $gte: point.lng - lngDelta, $lte: point.lng + lngDelta },
    ...(normalizedUnitLabel ? { normalized_unit_label: normalizedUnitLabel } : {})
  }, "-last_event_at", MAX_TARGETED_PIN_MATCHES), managerId, campaignId), normalizedUnitLabel);
  const nearest = nearestPin(candidates, point);
  return nearest && nearest.distance <= PIN_MATCH_METERS ? nearest.pin : null;
}
function publicPin(pin) {
  return {
    pin_id: pin.id,
    campaign_id: pin.campaign_id,
    zone_id: pin.zone_id,
    street_unit_id: pin.street_unit_id || null,
    evidence_id: pin.evidence_id || null,
    revision_id: pin.revision_id || null,
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
Deno.serve(async (req) => {
  let base44 = null;
  let session = null;
  let zoneId = null;
  let zoneLease = null;
  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const campaignId = requiredString(body?.campaign_id ?? body?.session_id, "campaign_id");
    zoneId = requiredString(body?.zone_id, "zone_id", 512);
    const idempotencyKey = requiredString(body?.idempotency_key, "idempotency_key", 128);
    if (idempotencyKey.length < 8 || !/^[A-Za-z0-9:_-]+$/.test(idempotencyKey)) {
      throw new HttpError(400, "invalid_decision", "idempotency_key must be 8-128 letters, numbers, colons, underscores, or hyphens.");
    }
    const outcome = normalized(body?.outcome);
    if (!OUTCOMES.has(outcome)) throw new HttpError(400, "invalid_outcome", "Choose a supported Canvas house outcome.");
    const point = normalizePoint(body?.point ?? body);
    const note = optionalString(body?.note, "note", 1e3);
    const address = optionalString(body?.address, "address", 500);
    const buildingFeatureId = optionalString(body?.building_feature_id, "building_feature_id", 256);
    const unitLabelInput = optionalString(body?.unit_label, "unit_label", 100);
    const unitLabel = optionalString(unitLabelInput ? unitLabelInput.normalize("NFKC").replace(/\s+/g, " ").trim() : null, "unit_label", 100);
    const normalizedUnitLabel = normalizeUnitLabel(unitLabel);
    const suppliedPinId = optionalString(body?.pin_id, "pin_id", 256);
    const suppliedStreetUnitId = optionalString(body?.street_unit_id ?? body?.work_unit_id, "street_unit_id", 512);
    const clientRecordedAt = body?.client_recorded_at ? new Date(body.client_recorded_at) : /* @__PURE__ */ new Date();
    if (!Number.isFinite(clientRecordedAt.getTime()) || clientRecordedAt.getTime() > Date.now() + 5 * 6e4 || clientRecordedAt.getTime() < Date.now() - 366 * 24 * 60 * 6e4) {
      throw new HttpError(400, "invalid_decision_time", "client_recorded_at is outside the supported offline window.");
    }
    const manager = canManageCanvas(user);
    const member = manager ? null : await resolveAuthenticatedTeamMember(base44, user);
    if (!manager && !member) throw new HttpError(403, "team_membership_required", "No active linked rep record was found for this account.");
    session = manager ? await base44.entities.CanvasSession.get(campaignId).catch(() => null) : await base44.asServiceRole.entities.CanvasSession.get(campaignId).catch(() => null);
    if (!session) throw new HttpError(404, "campaign_not_found", "Canvas campaign not found.");
    const expectedManagerId = manager ? user.id : member.manager_id;
    if (String(session.manager_id || "") !== String(expectedManagerId || "")) throw new HttpError(403, "forbidden", "This Canvas campaign belongs to another team.");
    const secret = deploymentSigningSecret();
    if (!await verifyCanvasLifecycleSession(secret, session, "active")) throw new HttpError(409, "campaign_not_active", "This Canvas campaign is not an active signed deployment.");
    await loadDecisionCampaignState(base44, session, secret);
    const zone = asArray2(session.zones).find((candidate) => String(candidate?.zone_id || "") === zoneId);
    if (!zone) throw new HttpError(404, "zone_not_found", "Canvas area not found in this campaign.");
    if (!manager && (String(zone.assigned_team_member_id || "") !== String(member.id) || !bindingMatches(session, member, user))) {
      throw new HttpError(403, "zone_not_assigned", "This area is not assigned to the authenticated rep.");
    }
    const roadOwnership = resolveRoadOwnership(session, point, zoneId);
    if (suppliedStreetUnitId && suppliedStreetUnitId !== roadOwnership.street_unit_id) throw new HttpError(409, "street_unit_mismatch", "The selected street unit does not own this pin location.");
    const normalizedAddress = normalizeAddress(address);
    const requestHash = await sha2562({
      campaign_id: campaignId,
      zone_id: zoneId,
      street_unit_id: roadOwnership.street_unit_id,
      evidence_id: session.evidence_id || null,
      revision_id: session.revision_id || null,
      actor_user_id: user.id,
      point: { lat: Number(point.lat.toFixed(7)), lng: Number(point.lng.toFixed(7)) },
      outcome,
      note,
      address,
      building_feature_id: buildingFeatureId,
      unit_label: normalizedUnitLabel || null,
      pin_id: suppliedPinId,
      client_recorded_at: clientRecordedAt.toISOString()
    });
    zoneLease = await acquireZoneDecisionLease(base44, session, zoneId, user.id, secret);
    session = await base44.asServiceRole.entities.CanvasSession.get(session.id).catch(() => null);
    if (!session || !await verifyCanvasLifecycleSession(secret, session, "active")) {
      throw new HttpError(409, "campaign_not_active", "This Canvas campaign closed while the decision was queued. Refresh assignments.");
    }
    await loadDecisionCampaignState(base44, session, secret);
    const existingEvents = asArray2(await base44.asServiceRole.entities.CanvasHouseEvent.filter({
      manager_id: session.manager_id,
      actor_user_id: user.id,
      idempotency_key: idempotencyKey
    }, "created_date", 10)).filter((event2) => event2.manager_id === session.manager_id && event2.actor_user_id === user.id && event2.idempotency_key === idempotencyKey);
    if (existingEvents.length > 1) throw new HttpError(409, "duplicate_idempotency_record", "Duplicate idempotency records require support review.");
    const existingEvent = existingEvents[0] || null;
    if (existingEvent && existingEvent.request_hash !== requestHash) {
      throw new HttpError(409, "idempotency_key_reused", "This idempotency key was already used for a different house decision.");
    }
    if (existingEvent?.write_status === "committed") {
      const pin2 = await base44.asServiceRole.entities.CanvasHousePin.get(existingEvent.pin_id).catch(() => null);
      if (!pin2 || pin2.manager_id !== session.manager_id || pin2.campaign_id !== campaignId) throw new HttpError(409, "idempotent_pin_missing", "The committed decision pin could not be verified.");
      return Response.json({ success: true, idempotent: true, pin: publicPin(pin2), event: { event_id: existingEvent.id, outcome: existingEvent.outcome, unit_label: existingEvent.unit_label || null, client_recorded_at: existingEvent.client_recorded_at, server_recorded_at: existingEvent.server_recorded_at, applied_to_latest: existingEvent.applied_to_latest === true } });
    }
    let pin = await findExistingPin(base44, {
      managerId: session.manager_id,
      campaignId,
      suppliedPinId,
      buildingFeatureId,
      normalizedAddress,
      normalizedUnitLabel,
      point
    });
    if (suppliedPinId && pin) {
      if (pin.zone_id !== zoneId || distanceMeters(pin, point) > 25 || session.territory_model === "residential_street_territory_v2" && pin.street_unit_id !== roadOwnership.street_unit_id) throw new HttpError(409, "pin_zone_mismatch", "The selected pin does not match this house location, street unit, and area.");
      const existingUnitLabel = normalizeUnitLabel(pin.normalized_unit_label || pin.unit_label);
      if (existingUnitLabel && normalizedUnitLabel && existingUnitLabel !== normalizedUnitLabel) {
        throw new HttpError(409, "pin_unit_mismatch", "The selected pin belongs to a different unit at this building.");
      }
    }
    if (pin && (pin.zone_id !== zoneId || session.territory_model === "residential_street_territory_v2" && pin.street_unit_id !== roadOwnership.street_unit_id)) throw new HttpError(409, "pin_zone_mismatch", "An existing house pin at this location belongs to another street unit or area.");
    const serverRecordedAt = (/* @__PURE__ */ new Date()).toISOString();
    let event = existingEvent;
    if (!event) {
      event = await base44.asServiceRole.entities.CanvasHouseEvent.create({
        campaign_id: campaignId,
        pin_id: pin?.id || null,
        zone_id: zoneId,
        manager_id: session.manager_id,
        street_unit_id: roadOwnership.street_unit_id,
        evidence_id: session.evidence_id || null,
        revision_id: session.revision_id || null,
        actor_user_id: user.id,
        actor_team_member_id: member?.id || null,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        write_status: "pending",
        applied_to_latest: false,
        outcome,
        note,
        lat: point.lat,
        lng: point.lng,
        address,
        building_feature_id: buildingFeatureId,
        unit_label: unitLabel,
        normalized_unit_label: normalizedUnitLabel || null,
        client_recorded_at: clientRecordedAt.toISOString(),
        server_recorded_at: serverRecordedAt,
        pin_version: null
      });
    }
    const eventAlreadyApplied = Boolean(existingEvent && pin && String(pin.latest_event_id || "") === String(event.id || ""));
    const latestAt = pin?.latest_client_recorded_at ? Date.parse(pin.latest_client_recorded_at) : Number.NEGATIVE_INFINITY;
    const appliesToLatest = eventAlreadyApplied || !pin || clientRecordedAt.getTime() >= latestAt;
    await renewZoneDecisionLease(base44, session, zoneId, zoneLease);
    if (!pin) {
      pin = await base44.asServiceRole.entities.CanvasHousePin.create({
        campaign_id: campaignId,
        zone_id: zoneId,
        manager_id: session.manager_id,
        street_unit_id: roadOwnership.street_unit_id,
        evidence_id: session.evidence_id || null,
        revision_id: session.revision_id || null,
        lat: point.lat,
        lng: point.lng,
        address,
        normalized_address: normalizedAddress || null,
        building_feature_id: buildingFeatureId,
        unit_label: unitLabel,
        normalized_unit_label: normalizedUnitLabel || null,
        latest_outcome: outcome,
        latest_note: note,
        latest_event_id: event.id,
        latest_client_recorded_at: clientRecordedAt.toISOString(),
        last_event_at: serverRecordedAt,
        last_actor_user_id: user.id,
        last_actor_team_member_id: member?.id || null,
        version: 1
      });
    } else if (appliesToLatest && !eventAlreadyApplied) {
      const currentVersion = Math.max(1, Number(pin.version || 1));
      const mutation = await base44.asServiceRole.entities.CanvasHousePin.updateMany({
        id: pin.id,
        manager_id: session.manager_id,
        campaign_id: campaignId,
        zone_id: zoneId,
        version: currentVersion
      }, { $set: {
        address: address || pin.address || null,
        normalized_address: normalizedAddress || pin.normalized_address || null,
        building_feature_id: buildingFeatureId || pin.building_feature_id || null,
        unit_label: unitLabel || pin.unit_label || null,
        normalized_unit_label: normalizedUnitLabel || pin.normalized_unit_label || null,
        latest_outcome: outcome,
        latest_note: note,
        latest_event_id: event.id,
        latest_client_recorded_at: clientRecordedAt.toISOString(),
        last_event_at: serverRecordedAt,
        last_actor_user_id: user.id,
        last_actor_team_member_id: member?.id || null,
        version: currentVersion + 1
      } });
      if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
        throw new HttpError(409, "pin_version_conflict", "This house changed while saving. Retry with the same idempotency key.");
      }
      pin = await base44.asServiceRole.entities.CanvasHousePin.get(pin.id);
    }
    await renewZoneDecisionLease(base44, session, zoneId, zoneLease);
    const eventMutation = await base44.asServiceRole.entities.CanvasHouseEvent.updateMany({
      id: event.id,
      manager_id: session.manager_id,
      actor_user_id: user.id,
      idempotency_key: idempotencyKey,
      write_status: "pending"
    }, { $set: {
      pin_id: pin.id,
      write_status: "committed",
      applied_to_latest: appliesToLatest,
      pin_version: Number(pin.version || 1)
    } });
    if (eventMutation?.success !== true || Number(eventMutation?.updated) !== 1 || eventMutation?.has_more === true) {
      throw new HttpError(503, "decision_commit_unverified", "The house pin saved but its event receipt could not be verified. Retry with the same idempotency key.");
    }
    const committedEvent = await base44.asServiceRole.entities.CanvasHouseEvent.get(event.id).catch(() => null);
    if (!committedEvent || committedEvent.write_status !== "committed" || committedEvent.pin_id !== pin.id) {
      throw new HttpError(503, "decision_commit_unverified", "The house decision receipt could not be verified. Retry safely with the same idempotency key.");
    }
    return Response.json({
      success: true,
      idempotent: false,
      pin: publicPin(pin),
      event: {
        event_id: committedEvent.id,
        outcome,
        unit_label: unitLabel,
        client_recorded_at: clientRecordedAt.toISOString(),
        server_recorded_at: serverRecordedAt,
        applied_to_latest: appliesToLatest,
        road_snap: roadOwnership
      }
    });
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message, ...error.details ? { details: error.details } : {} }, { status: error.status });
    console.error("[canvasLogHouseDecision]", error?.message || error);
    return Response.json({ error: "canvas_decision_failed", message: "The house decision could not be saved. Retry safely with the same idempotency key." }, { status: 503 });
  } finally {
    if (base44 && session && zoneId && zoneLease) await releaseZoneDecisionLease(base44, session, zoneId, zoneLease);
  }
});
