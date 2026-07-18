const LIFECYCLE_STATES = new Set(['active', 'completed', 'recalled']);

function asArray(value) {
  return Array.isArray(value) ? value : (Array.isArray(value?.items) ? value.items : []);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canvasRepTeamMemberIds(session) {
  return [...new Set(asArray(session?.zones)
    .map((zone) => String(zone?.assigned_team_member_id || '').trim())
    .filter(Boolean))].sort();
}

export function canvasStoredPlanForHash(session) {
  const deploymentPlanVersion = Number(session?.deployment_plan_version);
  const planVersion = Number.isInteger(deploymentPlanVersion) && deploymentPlanVersion > 0
    ? deploymentPlanVersion
    : Number(session?.version);
  return {
    session_name: session?.session_name || 'Canvas Campaign',
    territory_model: session?.territory_model || 'street_territory_v1',
    polygon: asArray(session?.polygon),
    rep_count: Number(session?.rep_count || 0),
    planning_method: session?.planning_method,
    assignment_basis: session?.assignment_basis,
    workload_basis: session?.workload_basis,
    division_mode: session?.division_mode,
    target_workload: session?.target_workload === null || session?.target_workload === undefined
      ? null
      : Number(session.target_workload),
    ...(Array.isArray(session?.selected_team_member_ids)
      ? { selected_team_member_ids: session.selected_team_member_ids }
      : {}),
    zones: asArray(session?.zones),
    work_units: asArray(session?.work_units),
    qa: session?.qa || {},
    algorithm_version: session?.algorithm_version || null,
    data_version: session?.data_version || null,
    manager_id: session?.manager_id,
    version: planVersion
  };
}

export function canvasLifecycleSignaturePayload(session, repIds = canvasRepTeamMemberIds(session)) {
  return {
    purpose: 'firstknock-canvas-lifecycle-v2',
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

export async function signCanvasLifecycle(secret, session, repIds = canvasRepTeamMemberIds(session)) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const payload = canvasLifecycleSignaturePayload(session, repIds);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(JSON.stringify(canonicalize(payload)))
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hasExactLifecycleShape(session, requiredState) {
  const state = String(session?.lifecycle_state || '');
  const qa = session?.deployment_qa || {};
  const evidence = session?.lifecycle_evidence || {};
  if (!LIFECYCLE_STATES.has(state)
    || (requiredState && state !== requiredState)
    || String(qa.lifecycle_state || '') !== state
    || String(evidence.state || '') !== state
    || Number(evidence.schema_version) !== 1
    || String(evidence.transitioned_at || '') !== String(qa.lifecycle_transitioned_at || '')
    || String(evidence.transitioned_by_user_id || '') !== String(qa.lifecycle_transitioned_by_user_id || '')
    || Number(evidence.to_version) !== Number(session?.version)) return false;

  const deploymentPlanVersion = Number(session?.deployment_plan_version);
  if (!Number.isInteger(deploymentPlanVersion) || deploymentPlanVersion < 1) return false;

  if (state === 'active') {
    return session?.status === 'deployed'
      && evidence.transition === 'deploy'
      && qa.lifecycle_transition === 'deploy'
      && String(evidence.transitioned_at || '') === String(session?.deployed_at || '')
      && String(evidence.transitioned_by_user_id || '') === String(session?.deployed_by_user_id || '')
      && String(evidence.idempotency_key || '') === String(session?.deployment_idempotency_key || '')
      && Number(evidence.from_version) === Number(session?.version)
      && evidence.previous_signature === null
      && !session?.closed_at
      && !session?.closed_by_user_id
      && !session?.close_action
      && !session?.close_idempotency_key;
  }

  const action = state === 'completed' ? 'complete' : 'recall';
  return session?.status === state
    && String(session?.close_action || '') === action
    && String(session?.close_idempotency_key || '') !== ''
    && String(session?.closed_at || '') !== ''
    && String(session?.closed_by_user_id || '') !== ''
    && evidence.transition === action
    && qa.lifecycle_transition === action
    && String(evidence.transitioned_at || '') === String(session.closed_at)
    && String(evidence.transitioned_by_user_id || '') === String(session.closed_by_user_id)
    && String(evidence.idempotency_key || '') === String(session.close_idempotency_key)
    && Number(evidence.from_version) === Number(session.version) - 1
    && deploymentPlanVersion <= Number(evidence.from_version)
    && /^[a-f0-9]{64}$/.test(String(evidence.previous_signature || ''));
}

export async function verifyCanvasLifecycleSession(secret, session, requiredState = null) {
  if (!session?.plan_hash || !session?.deployment_signature || !hasExactLifecycleShape(session, requiredState)) return false;
  const calculatedPlanHash = await sha256(canvasStoredPlanForHash(session));
  if (calculatedPlanHash !== session.plan_hash) return false;
  const calculatedSignature = await signCanvasLifecycle(secret, session, canvasRepTeamMemberIds(session));
  return calculatedSignature === session.deployment_signature;
}
