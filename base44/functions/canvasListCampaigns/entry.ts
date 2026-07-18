// base44/functions/canvasListCampaigns/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// base44/functions/canvasListCampaigns/canvasLifecycleSignature.js
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

// base44/functions/canvasListCampaigns/entry.ts
var CAMPAIGN_PAGE_SIZE = 100;
var MAX_CAMPAIGNS = 500;
function normalized(value) {
  return String(value || "").trim().toLowerCase();
}
function canManageCanvas(user) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return ["manager", "admin"].includes(appRole) || ["manager", "admin"].includes(accountRole);
}
function asArray2(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}
function deploymentSigningSecret() {
  const secret = Deno.env.get("CANVAS_DEPLOYMENT_SIGNING_SECRET") || "";
  return secret.length >= 32 ? secret : null;
}
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: "Manager access required" }, { status: 403 });
    const sessions = [];
    for (let offset = 0; offset < MAX_CAMPAIGNS; offset += CAMPAIGN_PAGE_SIZE) {
      const page = asArray2(await base44.entities.CanvasSession.filter(
        { manager_id: user.id },
        "-updated_date",
        CAMPAIGN_PAGE_SIZE,
        offset
      ));
      sessions.push(...page);
      if (page.length < CAMPAIGN_PAGE_SIZE) break;
    }
    const signingSecret = deploymentSigningSecret();
    const trustedSessions = [];
    let rejectedCampaigns = 0;
    for (const session of sessions) {
      if (String(session?.manager_id || "") !== String(user.id || "")) continue;
      if (session.status !== "draft") {
        if (!signingSecret) {
          return Response.json({
            error: "canvas_signing_unavailable",
            message: "Canvas lifecycle signing is not configured. Active campaign records cannot be trusted."
          }, { status: 503 });
        }
        const requiredState = session.status === "deployed" ? "active" : session.status;
        if (!await verifyCanvasLifecycleSession(signingSecret, session, requiredState)) {
          rejectedCampaigns += 1;
          continue;
        }
      }
      trustedSessions.push(session);
    }
    const trustedById = new Map(trustedSessions.map((session) => [session.id, session]));
    const supersededBy = /* @__PURE__ */ new Map();
    for (const newer of trustedSessions) {
      const newerTimestamp = Date.parse(newer.deployed_at || "");
      for (const olderId of asArray2(newer.deployment_qa?.superseded_session_ids)) {
        const older = trustedById.get(olderId);
        if (!older || older.id === newer.id || older.manager_id !== newer.manager_id) continue;
        const olderTimestamp = Date.parse(older.deployed_at || "");
        if (Number.isFinite(newerTimestamp) && Number.isFinite(olderTimestamp) && newerTimestamp >= olderTimestamp) {
          supersededBy.set(older.id, newer.id);
        }
      }
    }
    const campaigns = trustedSessions.map((session) => {
      const supersededBySessionId = supersededBy.get(session.id) || null;
      const effectiveStatus = supersededBySessionId ? "superseded" : session.status || "draft";
      return {
        session_id: session.id,
        session_name: session.session_name || "Canvas Campaign",
        status: effectiveStatus,
        stored_status: session.status || "draft",
        lifecycle_state: supersededBySessionId ? "superseded" : session.lifecycle_state || (session.status === "deployed" ? "active" : null),
        superseded_by_session_id: supersededBySessionId,
        version: Number(session.version || 0),
        zone_count: asArray2(session.zones).length,
        work_unit_count: asArray2(session.work_units).length,
        division_mode: session.division_mode || null,
        workload_basis: session.workload_basis || null,
        target_workload: session.target_workload ?? null,
        total_street_length_meters: Number(session.qa?.total_street_length_meters || 0),
        rep_count: Math.max(0, Number(session.rep_count) || 0),
        draft_saved_at: session.draft_saved_at || null,
        deployed_at: session.deployed_at || null,
        closed_at: session.closed_at || null,
        close_action: session.close_action || null,
        integrity_status: session.status === "draft" ? "draft" : "verified"
      };
    });
    return Response.json({
      success: true,
      campaigns,
      rejected_campaigns: rejectedCampaigns,
      truncated: sessions.length >= MAX_CAMPAIGNS
    });
  } catch (error) {
    console.error("[canvasListCampaigns]", error?.message || error);
    return Response.json({
      error: "canvas_campaign_list_failed",
      message: "Canvas campaigns could not be loaded."
    }, { status: 503 });
  }
});
