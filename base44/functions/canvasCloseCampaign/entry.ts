// base44/functions/canvasCloseCampaign/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// base44/functions/canvasCloseCampaign/canvasLifecycleSignature.js
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

// base44/functions/canvasCloseCampaign/entry.ts
var CLOSE_ACTIONS = /* @__PURE__ */ new Set(["complete", "recall"]);
var CAMPAIGN_TRANSITION_LOCK_MS = 3e4;
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
  if (!result || result.length > maxLength) {
    throw new HttpError(400, "invalid_close_request", `${field} is required or invalid.`);
  }
  return result;
}
function deploymentSigningSecret() {
  const secret = Deno.env.get("CANVAS_DEPLOYMENT_SIGNING_SECRET") || "";
  if (secret.length < 32) {
    throw new HttpError(503, "canvas_signing_unavailable", "Canvas lifecycle signing is not configured. The campaign was not changed.");
  }
  return secret;
}
function validateIdempotencyKey(value) {
  const key = requiredString(value, "idempotency_key", 128);
  if (key.length < 8 || !/^[A-Za-z0-9:_-]+$/.test(key)) {
    throw new HttpError(400, "invalid_close_request", "idempotency_key must be 8-128 letters, numbers, colons, underscores, or hyphens.");
  }
  return key;
}
function targetStateFor(action) {
  return action === "complete" ? "completed" : "recalled";
}
function closeResponse(session, idempotent) {
  return {
    success: true,
    idempotent,
    session_id: session.id,
    version: Number(session.version),
    status: session.status,
    lifecycle_state: session.lifecycle_state,
    close_action: session.close_action,
    closed_at: session.closed_at,
    closed_by_user_id: session.closed_by_user_id
  };
}
function lockToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function acquireCampaignTransitionLock(base44, session) {
  const now = /* @__PURE__ */ new Date();
  const token = lockToken();
  const mutation = await base44.asServiceRole.entities.CanvasSession.updateMany({
    id: session.id,
    manager_id: session.manager_id,
    status: "deployed",
    $or: [
      { canvas_field_write_lock_token: null },
      { canvas_field_write_lock_token: { $exists: false } },
      { canvas_field_write_lock_expires_at: { $lte: now.toISOString() } }
    ]
  }, { $set: {
    canvas_field_write_lock_token: token,
    canvas_field_write_lock_acquired_at: now.toISOString(),
    canvas_field_write_lock_expires_at: new Date(now.getTime() + CAMPAIGN_TRANSITION_LOCK_MS).toISOString()
  } });
  if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
    throw new HttpError(409, "campaign_field_write_in_progress", "A house decision or another campaign transition is finishing. Retry close in a moment.");
  }
  const locked = await base44.asServiceRole.entities.CanvasSession.get(session.id).catch(() => null);
  if (!locked || locked.canvas_field_write_lock_token !== token) {
    throw new HttpError(503, "campaign_transition_lock_unverified", "Canvas could not verify the campaign close lock. Nothing was changed.");
  }
  return token;
}
async function releaseCampaignTransitionLock(base44, session, token) {
  if (!token) return;
  await base44.asServiceRole.entities.CanvasSession.updateMany({
    id: session.id,
    manager_id: session.manager_id,
    canvas_field_write_lock_token: token
  }, { $unset: {
    canvas_field_write_lock_token: "",
    canvas_field_write_lock_acquired_at: "",
    canvas_field_write_lock_expires_at: ""
  } }).catch(() => null);
}
Deno.serve(async (req) => {
  let base44 = null;
  let session = null;
  let transitionLock = null;
  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: "Only managers can close Canvas campaigns." }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const sessionId = requiredString(body?.session_id, "session_id");
    const action = normalized(body?.action);
    if (!CLOSE_ACTIONS.has(action)) {
      throw new HttpError(400, "invalid_close_request", "action must be complete or recall.");
    }
    const idempotencyKey = validateIdempotencyKey(body?.idempotency_key);
    const expectedVersion = Number(body?.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new HttpError(400, "invalid_close_request", "expected_version must be a positive integer.");
    }
    session = await base44.entities.CanvasSession.get(sessionId).catch(() => null);
    if (!session) throw new HttpError(404, "session_not_found", "Canvas session not found.");
    if (String(session.manager_id || "") !== String(user.id || "")) {
      throw new HttpError(403, "forbidden", "This Canvas campaign belongs to another manager.");
    }
    const signingSecret = deploymentSigningSecret();
    const targetState = targetStateFor(action);
    if (session.status === "completed" || session.status === "recalled") {
      const validClosedSignature = await verifyCanvasLifecycleSession(signingSecret, session, session.status);
      if (!validClosedSignature) {
        throw new HttpError(409, "lifecycle_signature_invalid", "The closed Canvas campaign failed lifecycle signature verification.");
      }
      if (session.status !== targetState || session.close_action !== action || session.close_idempotency_key !== idempotencyKey) {
        throw new HttpError(409, "campaign_already_closed", `This Canvas campaign is already ${session.status}.`);
      }
      const originalVersion = Number(session.lifecycle_evidence?.from_version);
      if (expectedVersion !== originalVersion && expectedVersion !== Number(session.version)) {
        throw new HttpError(409, "version_conflict", "The Canvas campaign changed before this close retry.");
      }
      return Response.json(closeResponse(session, true));
    }
    if (session.status !== "deployed") {
      throw new HttpError(409, "campaign_not_active", "Only an active deployed Canvas campaign can be completed or recalled.");
    }
    if (expectedVersion !== Number(session.version)) {
      throw new HttpError(409, "version_conflict", "The Canvas campaign changed. Reload it before closing.");
    }
    if (!await verifyCanvasLifecycleSession(signingSecret, session, "active")) {
      throw new HttpError(409, "lifecycle_signature_invalid", "The active Canvas campaign failed lifecycle signature verification.");
    }
    transitionLock = await acquireCampaignTransitionLock(base44, session);
    session = await base44.entities.CanvasSession.get(sessionId).catch(() => null);
    if (!session || session.manager_id !== user.id || session.status !== "deployed" || session.lifecycle_state !== "active" || Number(session.version) !== expectedVersion || !await verifyCanvasLifecycleSession(signingSecret, session, "active")) {
      throw new HttpError(409, "version_conflict", "The Canvas campaign changed before the close lock was acquired. Reload before retrying.");
    }
    const closedAt = (/* @__PURE__ */ new Date()).toISOString();
    const nextVersion = Number(session.version) + 1;
    const lifecycleEvidence = {
      schema_version: 1,
      state: targetState,
      transition: action,
      transitioned_at: closedAt,
      transitioned_by_user_id: user.id,
      idempotency_key: idempotencyKey,
      from_version: Number(session.version),
      to_version: nextVersion,
      previous_signature: session.deployment_signature
    };
    const deploymentQa = {
      ...session.deployment_qa || {},
      lifecycle_state: targetState,
      lifecycle_transition: action,
      lifecycle_transitioned_at: closedAt,
      lifecycle_transitioned_by_user_id: user.id,
      lifecycle_closed_at: closedAt,
      lifecycle_closed_by_user_id: user.id,
      lifecycle_close_action: action
    };
    const lifecycleUpdate = {
      status: targetState,
      version: nextVersion,
      lifecycle_state: targetState,
      lifecycle_evidence: lifecycleEvidence,
      deployment_qa: deploymentQa,
      closed_at: closedAt,
      closed_by_user_id: user.id,
      close_action: action,
      close_idempotency_key: idempotencyKey
    };
    const signedSession = { ...session, ...lifecycleUpdate };
    const lifecycleSignature = await signCanvasLifecycle(
      signingSecret,
      signedSession,
      canvasRepTeamMemberIds(signedSession)
    );
    const mutation = await base44.asServiceRole.entities.CanvasSession.updateMany({
      id: session.id,
      manager_id: user.id,
      status: "deployed",
      lifecycle_state: "active",
      version: Number(session.version),
      plan_hash: session.plan_hash,
      deployment_signature: session.deployment_signature
    }, { $set: {
      ...lifecycleUpdate,
      deployment_signature: lifecycleSignature
    } });
    if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
      const latest = await base44.entities.CanvasSession.get(session.id).catch(() => null);
      if (latest?.manager_id === user.id && latest?.status === targetState && latest?.close_action === action && latest?.close_idempotency_key === idempotencyKey && await verifyCanvasLifecycleSession(signingSecret, latest, targetState)) {
        return Response.json(closeResponse(latest, true));
      }
      throw new HttpError(409, "version_conflict", "The Canvas campaign changed before the close committed. Reload before retrying.");
    }
    const updated = await base44.entities.CanvasSession.get(session.id).catch(() => null);
    if (!updated || !await verifyCanvasLifecycleSession(signingSecret, updated, targetState)) {
      throw new HttpError(503, "canvas_close_commit_unverified", "The Canvas lifecycle commit could not be verified. Reload before retrying.");
    }
    return Response.json(closeResponse(updated, false));
  } catch (error) {
    if (error instanceof HttpError) {
      return Response.json({
        error: error.code,
        message: error.message,
        ...error.details ? { details: error.details } : {}
      }, { status: error.status });
    }
    console.error("[canvasCloseCampaign]", error?.message || error);
    return Response.json({
      error: "canvas_close_failed",
      message: "Canvas campaign could not be closed. No trusted lifecycle transition was confirmed."
    }, { status: 503 });
  } finally {
    if (base44 && session && transitionLock) await releaseCampaignTransitionLock(base44, session, transitionLock);
  }
});
