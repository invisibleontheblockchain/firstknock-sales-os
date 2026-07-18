import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { canvasRepTeamMemberIds, signCanvasLifecycle, verifyCanvasLifecycleSession } from './canvasLifecycleSignature.js';

const CLOSE_ACTIONS = new Set(['complete', 'recall']);

class HttpError extends Error {
  status: number;
  code: string;
  details: any;

  constructor(status: number, code: string, message: string, details: any = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ['manager', 'admin'].includes(appRole) || ['manager', 'admin'].includes(accountRole);
}

function requiredString(value: unknown, field: string, maxLength = 256) {
  const result = String(value || '').trim();
  if (!result || result.length > maxLength) {
    throw new HttpError(400, 'invalid_close_request', `${field} is required or invalid.`);
  }
  return result;
}

function deploymentSigningSecret() {
  const secret = Deno.env.get('CANVAS_DEPLOYMENT_SIGNING_SECRET') || '';
  if (secret.length < 32) {
    throw new HttpError(503, 'canvas_signing_unavailable', 'Canvas lifecycle signing is not configured. The campaign was not changed.');
  }
  return secret;
}

function validateIdempotencyKey(value: unknown) {
  const key = requiredString(value, 'idempotency_key', 128);
  if (key.length < 8 || !/^[A-Za-z0-9:_-]+$/.test(key)) {
    throw new HttpError(400, 'invalid_close_request', 'idempotency_key must be 8-128 letters, numbers, colons, underscores, or hyphens.');
  }
  return key;
}

function targetStateFor(action: string) {
  return action === 'complete' ? 'completed' : 'recalled';
}

function closeResponse(session: any, idempotent: boolean) {
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

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'Only managers can close Canvas campaigns.' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const sessionId = requiredString(body?.session_id, 'session_id');
    const action = normalized(body?.action);
    if (!CLOSE_ACTIONS.has(action)) {
      throw new HttpError(400, 'invalid_close_request', 'action must be complete or recall.');
    }
    const idempotencyKey = validateIdempotencyKey(body?.idempotency_key);
    const expectedVersion = Number(body?.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new HttpError(400, 'invalid_close_request', 'expected_version must be a positive integer.');
    }

    // Caller-scoped reads retain CanvasSession ownership RLS. Closing never
    // requires a paid entitlement because managers must always be able to stop work.
    const session = await base44.entities.CanvasSession.get(sessionId).catch(() => null);
    if (!session) throw new HttpError(404, 'session_not_found', 'Canvas session not found.');
    if (String(session.manager_id || '') !== String(user.id || '')) {
      throw new HttpError(403, 'forbidden', 'This Canvas campaign belongs to another manager.');
    }

    const signingSecret = deploymentSigningSecret();
    const targetState = targetStateFor(action);
    if (session.status === 'completed' || session.status === 'recalled') {
      const validClosedSignature = await verifyCanvasLifecycleSession(signingSecret, session, session.status);
      if (!validClosedSignature) {
        throw new HttpError(409, 'lifecycle_signature_invalid', 'The closed Canvas campaign failed lifecycle signature verification.');
      }
      if (session.status !== targetState
        || session.close_action !== action
        || session.close_idempotency_key !== idempotencyKey) {
        throw new HttpError(409, 'campaign_already_closed', `This Canvas campaign is already ${session.status}.`);
      }
      const originalVersion = Number(session.lifecycle_evidence?.from_version);
      if (expectedVersion !== originalVersion && expectedVersion !== Number(session.version)) {
        throw new HttpError(409, 'version_conflict', 'The Canvas campaign changed before this close retry.');
      }
      return Response.json(closeResponse(session, true));
    }
    if (session.status !== 'deployed') {
      throw new HttpError(409, 'campaign_not_active', 'Only an active deployed Canvas campaign can be completed or recalled.');
    }
    if (expectedVersion !== Number(session.version)) {
      throw new HttpError(409, 'version_conflict', 'The Canvas campaign changed. Reload it before closing.');
    }
    if (!await verifyCanvasLifecycleSession(signingSecret, session, 'active')) {
      throw new HttpError(409, 'lifecycle_signature_invalid', 'The active Canvas campaign failed lifecycle signature verification.');
    }

    const closedAt = new Date().toISOString();
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
      ...(session.deployment_qa || {}),
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
      status: 'deployed',
      lifecycle_state: 'active',
      version: Number(session.version),
      plan_hash: session.plan_hash,
      deployment_signature: session.deployment_signature
    }, { $set: {
      ...lifecycleUpdate,
      deployment_signature: lifecycleSignature
    } });
    if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
      const latest = await base44.entities.CanvasSession.get(session.id).catch(() => null);
      if (latest?.manager_id === user.id
        && latest?.status === targetState
        && latest?.close_action === action
        && latest?.close_idempotency_key === idempotencyKey
        && await verifyCanvasLifecycleSession(signingSecret, latest, targetState)) {
        return Response.json(closeResponse(latest, true));
      }
      throw new HttpError(409, 'version_conflict', 'The Canvas campaign changed before the close committed. Reload before retrying.');
    }
    const updated = await base44.entities.CanvasSession.get(session.id).catch(() => null);
    if (!updated || !await verifyCanvasLifecycleSession(signingSecret, updated, targetState)) {
      throw new HttpError(503, 'canvas_close_commit_unverified', 'The Canvas lifecycle commit could not be verified. Reload before retrying.');
    }
    return Response.json(closeResponse(updated, false));
  } catch (error: any) {
    if (error instanceof HttpError) {
      return Response.json({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {})
      }, { status: error.status });
    }
    console.error('[canvasCloseCampaign]', error?.message || error);
    return Response.json({
      error: 'canvas_close_failed',
      message: 'Canvas campaign could not be closed. No trusted lifecycle transition was confirmed.'
    }, { status: 503 });
  }
});
