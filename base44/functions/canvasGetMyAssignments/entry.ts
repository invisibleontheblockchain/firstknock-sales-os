// base44/functions/canvasGetMyAssignments/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// base44/functions/canvasGetMyAssignments/canvasLifecycleSignature.js
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

// base44/functions/canvasGetMyAssignments/entry.ts
var MAX_ACTIVE_SESSIONS = 1e3;
var MAX_LIFECYCLE_SESSIONS = 1e4;
var LIFECYCLE_PAGE_SIZE = 500;
function asArray2(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
function normalized(value) {
  return String(value || "").trim().toLowerCase();
}
function deploymentSigningSecret() {
  const secret = Deno.env.get("CANVAS_DEPLOYMENT_SIGNING_SECRET") || "";
  if (secret.length < 32) {
    const error = new Error("Canvas assignment verification is not configured.");
    error.status = 503;
    error.code = "canvas_signing_unavailable";
    throw error;
  }
  return secret;
}
function repSafeDeploymentQa(qa) {
  return {
    lifecycle_state: qa?.lifecycle_state || null,
    validator_version: qa?.validator_version ?? null,
    topology_validator: qa?.topology_validator || null,
    server_algorithm_version: qa?.server_algorithm_version || null,
    server_data_version: qa?.server_data_version || null,
    street_coverage_complete: qa?.street_coverage_complete === true,
    connected_zones: qa?.connected_zones === true,
    atomic_work_units: qa?.atomic_work_units === true,
    protected_units_intact: qa?.protected_units_intact === true,
    cul_de_sac_splits: Number(qa?.cul_de_sac_splits) || 0,
    zone_count: Number(qa?.zone_count) || 0,
    work_unit_count: Number(qa?.work_unit_count) || 0,
    total_street_length_meters: Number(qa?.total_street_length_meters) || 0,
    verified_at: qa?.verified_at || null
  };
}
async function resolveAuthenticatedTeamMember(base44, user) {
  const expectedManagerId = String(user?.team_manager_id || user?.data?.team_manager_id || "").trim();
  if (!expectedManagerId) return null;
  const primary = asArray2(await base44.entities.TeamMember.filter({ user_id: user.id, status: "active" }, "-updated_date", 20).catch(() => []));
  const candidates = primary.filter((member) => member.user_id === user.id && member.status === "active" && normalized(member.role) === "rep" && member.manager_id === expectedManagerId);
  const unique = new Map(candidates.map((member) => [member.id, member]));
  if (!unique.size) return null;
  if (unique.size > 1) {
    const error = new Error("More than one active TeamMember record matches this account.");
    error.status = 409;
    error.code = "ambiguous_team_membership";
    throw error;
  }
  return { member: [...unique.values()][0], resolution: "user_id" };
}
function activeValidDeployments(validSessions) {
  const byId = new Map(validSessions.map((session) => [session.id, session]));
  const supersededIds = /* @__PURE__ */ new Set();
  for (const newer of validSessions) {
    const newerAt = Date.parse(newer.deployed_at || "");
    for (const supersededId of asArray2(newer.deployment_qa?.superseded_session_ids)) {
      const older = byId.get(supersededId);
      if (!older || older.manager_id !== newer.manager_id || older.id === newer.id) continue;
      const olderAt = Date.parse(older.deployed_at || "");
      if (Number.isFinite(newerAt) && Number.isFinite(olderAt) && newerAt >= olderAt) supersededIds.add(older.id);
    }
  }
  return {
    active: validSessions.filter((session) => session.status === "deployed" && session.lifecycle_state === "active" && !supersededIds.has(session.id)),
    supersededIds
  };
}
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const membership = await resolveAuthenticatedTeamMember(base44, user);
    if (!membership) return Response.json({ error: "team_membership_required", message: "No active linked rep record was found for this account." }, { status: 403 });
    const { member, resolution } = membership;
    const signingSecret = deploymentSigningSecret();
    const body = await req.json().catch(() => ({}));
    const requestedSessionId = body?.session_id ? String(body.session_id).trim() : null;
    if (requestedSessionId && requestedSessionId.length > 256) return Response.json({ error: "invalid_session_id" }, { status: 400 });
    const lifecycleRows = [];
    for (const status of ["deployed", "completed", "recalled"]) {
      let skip = 0;
      while (true) {
        const page = asArray2(await base44.asServiceRole.entities.CanvasSession.filter({ manager_id: member.manager_id, status }, "-deployed_at", LIFECYCLE_PAGE_SIZE, skip));
        lifecycleRows.push(...page);
        if (lifecycleRows.length > MAX_LIFECYCLE_SESSIONS) {
          const error = new Error("Canvas lifecycle history exceeds the safe assignment verification limit.");
          error.status = 503;
          error.code = "canvas_lifecycle_scan_limit";
          throw error;
        }
        if (page.length < LIFECYCLE_PAGE_SIZE) break;
        skip += page.length;
      }
    }
    const candidates = [...new Map(lifecycleRows.filter((session) => session.manager_id === member.manager_id).map((session) => [session.id, session])).values()];
    const valid = [];
    for (const session of candidates) {
      if (!await verifyCanvasLifecycleSession(signingSecret, session)) {
        const error = new Error("A Canvas deployment failed server integrity verification.");
        error.status = 409;
        error.code = "deployment_signature_invalid";
        throw error;
      }
      valid.push(session);
    }
    const { active, supersededIds } = activeValidDeployments(valid);
    if (active.length > MAX_ACTIVE_SESSIONS) {
      const error = new Error("Too many active Canvas sessions exist to verify assignments safely.");
      error.status = 503;
      error.code = "canvas_assignment_scan_limit";
      throw error;
    }
    const sessions = requestedSessionId ? active.filter((session) => session.id === requestedSessionId) : active;
    const assignments = [];
    for (const session of sessions) {
      const bindings = asArray2(session.deployment_qa?.verified_team_member_bindings);
      const binding = bindings.find((candidate) => String(candidate?.team_member_id || "") === String(member.id));
      const hasAssignedZone = asArray2(session.zones).some((zone) => String(zone?.assigned_team_member_id || "") === String(member.id));
      if (hasAssignedZone && (!binding || String(binding.user_id || "") !== String(user.id || "") || normalized(binding.email) !== normalized(user.email) || String(member.user_id || "") !== String(user.id || ""))) {
        const error = new Error("The signed Canvas assignment no longer matches this TeamMember authentication link.");
        error.status = 409;
        error.code = "deployment_rep_binding_invalid";
        throw error;
      }
      const workUnitById = new Map(asArray2(session.work_units).map((unit) => [String(unit?.id || ""), unit]));
      for (const zone of asArray2(session.zones)) {
        if (String(zone?.assigned_team_member_id || "") !== String(member.id)) continue;
        const workUnitIds = asArray2(zone.work_unit_ids).map(String);
        assignments.push({
          session_id: session.id,
          campaign_id: session.id,
          session_name: session.session_name || "Canvas Campaign",
          territory_model: session.territory_model,
          version: Number(session.version || 0),
          plan_hash: session.plan_hash || null,
          evidence_id: session.evidence_id || null,
          revision_id: session.revision_id || null,
          snapshot_hash: session.snapshot_hash || null,
          planning_method: session.planning_method,
          assignment_basis: session.assignment_basis,
          workload_basis: session.workload_basis,
          division_mode: session.division_mode,
          target_workload: session.target_workload ?? null,
          deployed_at: session.deployed_at,
          campaign_boundary: session.polygon,
          deployment_qa: repSafeDeploymentQa(session.deployment_qa),
          zone: {
            zone_id: zone.zone_id,
            zone_number: zone.zone_number,
            name: zone.name || `Area ${zone.zone_number}`,
            color: zone.color || null,
            geometry: zone.geometry || null,
            parts: zone.parts || null,
            center: zone.center || null,
            drop_point: zone.drop_point || null,
            work_unit_ids: workUnitIds,
            street_work_unit_ids: workUnitIds,
            street_length_meters: Number(zone.street_length_meters || 0),
            estimated_doors: zone.estimated_doors ?? null,
            estimated_minutes: zone.estimated_minutes ?? null,
            workload_score: Number(zone.workload_score || 0),
            workload_share: zone.workload_share ?? null,
            assigned_team_member_id: member.id
          },
          work_units: workUnitIds.map((id) => workUnitById.get(id)).filter(Boolean)
        });
      }
    }
    return Response.json({
      success: true,
      team_member_id: member.id,
      manager_id: member.manager_id,
      membership_resolution: resolution,
      assignments,
      superseded_deployments: supersededIds.size,
      server_time: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (error) {
    if (error?.status && error?.code) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error("[canvasGetMyAssignments]", error?.message || error);
    return Response.json({ error: "canvas_assignments_unavailable", message: "Canvas assignments could not be loaded." }, { status: 500 });
  }
});
