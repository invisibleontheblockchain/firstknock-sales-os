import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ACTIVE_LIFECYCLE_STATUSES = new Set(['deployed', 'completed', 'recalled']);
const LIFECYCLE_STATES = new Set(['active', 'completed', 'recalled']);
const PAGE_SIZE = 100;
const MAX_RECORDS = 500;
const CONFIRMATION = 'QUARANTINE_INVALID_CANVAS_RECORDS';

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ['manager', 'admin'].includes(appRole) || ['manager', 'admin'].includes(accountRole);
}

function asArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: any) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canvasRepTeamMemberIds(session: any) {
  return [...new Set(asArray(session?.zones).map((zone) => String(zone?.assigned_team_member_id || '').trim()).filter(Boolean))].sort();
}

function canvasStoredPlanForHash(session: any) {
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
    target_workload: session?.target_workload === null || session?.target_workload === undefined ? null : Number(session.target_workload),
    ...(Array.isArray(session?.selected_team_member_ids) ? { selected_team_member_ids: session.selected_team_member_ids } : {}),
    zones: asArray(session?.zones),
    work_units: asArray(session?.work_units),
    qa: session?.qa || {},
    algorithm_version: session?.algorithm_version || null,
    data_version: session?.data_version || null,
    manager_id: session?.manager_id,
    version: planVersion,
  };
}

function lifecycleSignaturePayload(session: any, repIds = canvasRepTeamMemberIds(session)) {
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
    deployment_qa: session?.deployment_qa || null,
  };
}

async function signLifecycle(secret: string, session: any) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(JSON.stringify(canonicalize(lifecycleSignaturePayload(session)))),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hasExactLifecycleShape(session: any, requiredState: string) {
  const state = String(session?.lifecycle_state || '');
  const qa = session?.deployment_qa || {};
  const evidence = session?.lifecycle_evidence || {};
  if (!LIFECYCLE_STATES.has(state)
    || state !== requiredState
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

async function verifyLifecycle(secret: string, session: any) {
  const requiredState = session?.status === 'deployed' ? 'active' : String(session?.status || '');
  if (!session?.plan_hash || !session?.deployment_signature || !hasExactLifecycleShape(session, requiredState)) return false;
  if (await sha256(canvasStoredPlanForHash(session)) !== session.plan_hash) return false;
  return await signLifecycle(secret, session) === session.deployment_signature;
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'Manager access required' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    if (body?.confirmation !== CONFIRMATION) {
      return Response.json({
        error: 'explicit_confirmation_required',
        message: 'Explicit quarantine confirmation is required. No records were changed.',
      }, { status: 400 });
    }
    const secret = Deno.env.get('CANVAS_DEPLOYMENT_SIGNING_SECRET') || '';
    if (secret.length < 32) {
      return Response.json({
        error: 'canvas_signing_unavailable',
        message: 'Canvas lifecycle signing must be configured before invalid records can be identified safely.',
      }, { status: 503 });
    }

    const sessions = [];
    for (let offset = 0; offset < MAX_RECORDS; offset += PAGE_SIZE) {
      const page = asArray(await base44.asServiceRole.entities.CanvasSession.filter(
        { manager_id: user.id, status: { $in: [...ACTIVE_LIFECYCLE_STATUSES] } },
        '-updated_date',
        PAGE_SIZE,
        offset,
      ));
      sessions.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const quarantinedIds = [];
    const skippedValidIds = [];
    const unresolvedSignedIds = [];
    const conflicts = [];
    const now = new Date().toISOString();
    for (const candidate of sessions) {
      if (String(candidate?.manager_id || '') !== String(user.id) || !ACTIVE_LIFECYCLE_STATUSES.has(candidate?.status)) continue;
      if (await verifyLifecycle(secret, candidate)) {
        skippedValidIds.push(candidate.id);
        continue;
      }
      if (String(candidate?.deployment_signature || '').trim()) {
        unresolvedSignedIds.push(candidate.id);
        continue;
      }
      const expectedVersion = Number(candidate.version || 0);
      const mutation = await base44.asServiceRole.entities.CanvasSession.updateMany({
        id: candidate.id,
        manager_id: user.id,
        status: candidate.status,
        version: expectedVersion,
      }, { $set: {
        status: 'quarantined',
        version: expectedVersion + 1,
        quarantined_at: now,
        quarantined_by_user_id: user.id,
        quarantine_reason: 'legacy_lifecycle_verification_failed',
      } });
      if (mutation?.success === true && Number(mutation?.updated) === 1 && mutation?.has_more !== true) quarantinedIds.push(candidate.id);
      else conflicts.push(candidate.id);
    }

    return Response.json({
      success: true,
      quarantined_count: quarantinedIds.length,
      quarantined_campaign_ids: quarantinedIds,
      verified_campaigns_unchanged: skippedValidIds.length,
      unresolved_signed_campaign_count: unresolvedSignedIds.length,
      unresolved_signed_campaign_ids: unresolvedSignedIds,
      conflict_campaign_ids: conflicts,
      truncated: sessions.length >= MAX_RECORDS,
    });
  } catch (error) {
    console.error('[canvasQuarantineInvalidCampaigns]', error?.message || error);
    return Response.json({
      error: 'canvas_quarantine_failed',
      message: 'Invalid Canvas records could not be quarantined. No valid campaigns were changed.',
    }, { status: 503 });
  }
});
