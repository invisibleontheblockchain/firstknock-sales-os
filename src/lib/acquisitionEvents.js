import { readStoredAcquisition } from './acquisitionTracking.js';

export const ACQUISITION_ANONYMOUS_ID_KEY = 'fk_acquisition_anonymous_id_v1';
export const ACQUISITION_SESSION_ID_KEY = 'fk_acquisition_session_id_v1';
export const ACQUISITION_VISITOR_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const ACQUISITION_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

const EVENT_NAMES = new Set([
  'landing_viewed',
  'signup_cta_clicked',
]);

function createId(prefix, cryptoApi = globalThis.crypto) {
  const uuid = cryptoApi?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${uuid}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 80);
}

function storedId(storage, key, prefix, cryptoApi, {
  nowMs,
  expiresAfterMs,
  inactivityTimeoutMs,
} = {}) {
  if (!storage) return createId(prefix, cryptoApi);
  try {
    const raw = String(storage.getItem(key) || '');
    let record = null;
    try {
      record = JSON.parse(raw);
    } catch {
      record = /^[a-z0-9_-]{8,80}$/.test(raw) ? { id: raw } : null;
    }
    const existing = String(record?.id || '');
    const expiresAt = Number(record?.expires_at || 0);
    const lastSeenAt = Number(record?.last_seen_at || 0);
    const expired = expiresAt > 0 && expiresAt <= nowMs;
    const inactive = inactivityTimeoutMs
      && lastSeenAt > 0
      && lastSeenAt + inactivityTimeoutMs <= nowMs;
    if (/^[a-z0-9_-]{8,80}$/.test(existing) && !expired && !inactive) {
      storage.setItem(key, JSON.stringify({
        id: existing,
        ...(expiresAfterMs ? { expires_at: nowMs + expiresAfterMs } : {}),
        ...(inactivityTimeoutMs ? { last_seen_at: nowMs } : {}),
      }));
      return existing;
    }
    const next = createId(prefix, cryptoApi);
    storage.setItem(key, JSON.stringify({
      id: next,
      ...(expiresAfterMs ? { expires_at: nowMs + expiresAfterMs } : {}),
      ...(inactivityTimeoutMs ? { last_seen_at: nowMs } : {}),
    }));
    return next;
  } catch {
    return createId(prefix, cryptoApi);
  }
}

export function getAcquisitionIdentity({
  persistentStorage = globalThis.localStorage,
  sessionStorage = globalThis.sessionStorage,
  cryptoApi = globalThis.crypto,
  now = new Date(),
} = {}) {
  const parsedNow = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(parsedNow.getTime()) ? parsedNow.getTime() : Date.now();
  return {
    anonymous_id: storedId(
      persistentStorage,
      ACQUISITION_ANONYMOUS_ID_KEY,
      'anon',
      cryptoApi,
      {
        nowMs,
        expiresAfterMs: ACQUISITION_VISITOR_TTL_MS,
      },
    ),
    session_id: storedId(
      sessionStorage,
      ACQUISITION_SESSION_ID_KEY,
      'session',
      cryptoApi,
      {
        nowMs,
        inactivityTimeoutMs: ACQUISITION_SESSION_TIMEOUT_MS,
      },
    ),
  };
}

export function buildAcquisitionEvent(eventName, {
  ctaVariant = '',
  landingPath = globalThis.location?.pathname || '/instagram',
  identity = getAcquisitionIdentity(),
  storage = globalThis.localStorage,
  now = new Date(),
  cryptoApi = globalThis.crypto,
} = {}) {
  if (!EVENT_NAMES.has(eventName)) {
    throw new Error(`Unsupported acquisition event: ${eventName}`);
  }

  const stored = readStoredAcquisition(storage);
  const touch = stored?.last_touch || stored?.first_touch || null;
  const occurredAt = now instanceof Date ? now : new Date(now);

  return {
    event_id: createId('event', cryptoApi),
    event_name: eventName,
    anonymous_id: identity.anonymous_id,
    session_id: identity.session_id,
    occurred_at: Number.isFinite(occurredAt.getTime())
      ? occurredAt.toISOString()
      : new Date().toISOString(),
    landing_path: String(landingPath || '/instagram').slice(0, 300),
    cta_variant: String(ctaVariant || '').slice(0, 80),
    touch,
  };
}

export async function sendAcquisitionEvent(invoke, eventName, options = {}) {
  if (typeof invoke !== 'function') {
    throw new TypeError('An acquisition event invoker is required.');
  }
  const payload = buildAcquisitionEvent(eventName, options);
  return invoke('trackAcquisitionEvent', payload);
}
