import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizeEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 320 || /\s/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    throw new HttpError(400, 'invalid_target_email', 'target_email is required and must be a valid email address.');
  }
  return email;
}

function isoInstant(value: unknown) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function parseGrantDocument() {
  const encoded = Deno.env.get('BETA_ACCESS_GRANTS');
  if (!encoded) throw new HttpError(503, 'beta_grants_unavailable', 'Beta access grants are unavailable.');
  let document: any;
  try {
    document = JSON.parse(encoded);
  } catch {
    throw new HttpError(503, 'beta_grants_invalid', 'Beta access grants are invalid.');
  }
  if (!document || Array.isArray(document) || document.version !== 1
    || !document.grants || Array.isArray(document.grants) || typeof document.grants !== 'object') {
    throw new HttpError(503, 'beta_grants_invalid', 'Beta access grants are invalid.');
  }
  return document.grants;
}

function activeGrantForUser(grants: any, userId: string) {
  if (!Object.prototype.hasOwnProperty.call(grants, userId)) {
    throw new HttpError(403, 'beta_grant_required', 'The target user does not have an active beta grant.');
  }
  const candidate = grants[userId];
  const startsAt = isoInstant(candidate?.starts_at);
  const endsAt = isoInstant(candidate?.ends_at);
  const precisionLimit = Number(candidate?.precision_limit);
  const canvasSeats = Number(candidate?.canvas_seats);
  if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object'
    || typeof candidate.grant_id !== 'string' || !candidate.grant_id.trim() || candidate.grant_id !== candidate.grant_id.trim() || candidate.grant_id.length > 256
    || candidate.status !== 'active'
    || typeof candidate.precision_limit !== 'number' || typeof candidate.canvas_seats !== 'number'
    || !Number.isSafeInteger(precisionLimit) || precisionLimit < 1 || precisionLimit > 1_000
    || !Number.isSafeInteger(canvasSeats) || canvasSeats < 1 || canvasSeats > 100
    || startsAt === null || endsAt === null || startsAt >= endsAt
    || Date.now() < startsAt || Date.now() >= endsAt) {
    throw new HttpError(403, 'beta_grant_required', 'The target user does not have an active beta grant.');
  }
  return {
    grant_id: candidate.grant_id,
    precision_limit: precisionLimit,
    canvas_seats: canvasSeats,
    starts_at: candidate.starts_at,
    ends_at: candidate.ends_at
  };
}

function toArray(value: any) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const actor = await base44.auth.me();
    if (!actor) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (String(actor.role || '').trim().toLowerCase() !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const targetEmail = normalizeEmail(body?.target_email);
    const service = base44.asServiceRole;
    const matches = toArray(await service.entities.User.filter({ email: targetEmail }, 'created_date', 2))
      .filter((candidate: any) => String(candidate?.email || '').trim().toLowerCase() === targetEmail);
    if (matches.length === 0) throw new HttpError(404, 'target_user_not_found', 'The target user was not found.');
    if (matches.length !== 1) throw new HttpError(409, 'target_user_ambiguous', 'target_email must identify exactly one user.');

    const target = matches[0];
    const targetUserId = String(target?.id || '');
    if (!targetUserId) throw new HttpError(409, 'target_user_invalid', 'The target user does not have an immutable user ID.');
    const grant = activeGrantForUser(parseGrantDocument(), targetUserId);

    await service.entities.User.update(targetUserId, {
      role: 'user',
      app_role: 'manager',
      is_owner: true,
      subscription_status: 'active',
      subscription_tier: 'canvas',
      subscription_paid_confirmed: true,
      stripe_card_on_file_confirmed: false,
      total_seats: grant.canvas_seats
    });

    const audit = {
      grant_id: grant.grant_id,
      target_user_id: targetUserId,
      granted_by_user_id: String(actor.id || ''),
      precision_limit: grant.precision_limit,
      canvas_seats: grant.canvas_seats,
      starts_at: grant.starts_at,
      ends_at: grant.ends_at
    };
    console.info('[adminSetOwner]', JSON.stringify({ event: 'beta_access_granted', ...audit }));
    return Response.json({ success: true, ...audit });
  } catch (error: any) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    console.error('[adminSetOwner]', error?.message || error);
    return Response.json({ error: 'beta_access_grant_failed', message: 'Beta access could not be granted.' }, { status: 500 });
  }
});
