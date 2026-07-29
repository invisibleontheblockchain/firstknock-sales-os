export const ACQUISITION_STORAGE_KEY = 'fk_acquisition_touch_v1';
export const ACQUISITION_TOUCH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
];

function cleanToken(value, maxLength = 120) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._~-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength);
}

function cleanPath(value) {
  const path = String(value || '/').trim().slice(0, 300);
  return path.startsWith('/') ? path : '/';
}

function referrerHost(referrer) {
  try {
    return new URL(referrer).hostname.toLowerCase().slice(0, 160);
  } catch {
    return '';
  }
}

function inferSourceFromReferrer(host) {
  if (!host) return null;
  if (
    host === 'instagram.com'
    || host.endsWith('.instagram.com')
  ) {
    return { source: 'instagram', medium: 'organic_social' };
  }
  if (
    host === 'tiktok.com'
    || host.endsWith('.tiktok.com')
  ) {
    return { source: 'tiktok', medium: 'organic_social' };
  }
  return null;
}

export function parseAcquisitionTouch({
  href,
  referrer = '',
  now = new Date(),
} = {}) {
  let url;
  try {
    url = new URL(href || window.location.href);
  } catch {
    return null;
  }

  const params = url.searchParams;
  const host = referrerHost(referrer);
  const inferred = inferSourceFromReferrer(host);
  const hasTrackingParam = TRACKING_PARAMS.some((key) => params.has(key));
  const source = cleanToken(params.get('utm_source') || inferred?.source);
  const medium = cleanToken(params.get('utm_medium') || inferred?.medium);
  const campaign = cleanToken(params.get('utm_campaign'));
  const content = cleanToken(params.get('utm_content') || params.get('fk_content'));
  const term = cleanToken(params.get('utm_term'));

  if (!hasTrackingParam && !content && !inferred) return null;
  if (!source && !campaign && !content) return null;

  const capturedAt = now instanceof Date ? now : new Date(now);
  return {
    source: source || 'unknown',
    medium: medium || 'unknown',
    campaign: campaign || 'unassigned',
    content: content || 'unassigned',
    term,
    landing_path: cleanPath(url.pathname),
    referrer_host: host,
    captured_at: Number.isFinite(capturedAt.getTime())
      ? capturedAt.toISOString()
      : new Date().toISOString(),
  };
}

export function readStoredAcquisition(
  storage = globalThis.localStorage,
  now = new Date(),
) {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(ACQUISITION_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const nowValue = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const explicitExpiry = new Date(parsed.expires_at || '').getTime();
    const firstCapture = new Date(parsed.first_touch?.captured_at || '').getTime();
    const expiry = Number.isFinite(explicitExpiry)
      ? explicitExpiry
      : Number.isFinite(firstCapture)
        ? firstCapture + ACQUISITION_TOUCH_TTL_MS
        : 0;
    if (expiry && Number.isFinite(nowValue) && expiry <= nowValue) {
      storage.removeItem?.(ACQUISITION_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function captureAcquisitionTouch({
  href = globalThis.location?.href,
  referrer = globalThis.document?.referrer || '',
  now = new Date(),
  storage = globalThis.localStorage,
} = {}) {
  const touch = parseAcquisitionTouch({ href, referrer, now });
  if (!touch || !storage) return touch;

  try {
    const existing = readStoredAcquisition(storage, now) || {};
    // A previously bound browser journey must not become another account's
    // first touch on a shared device. A fresh tracked visit starts a new local
    // journey; the backend still preserves an existing user's immutable touch.
    const startsNewJourney = Boolean(existing.synced_user_id);
    const base = startsNewJourney ? {} : existing;
    const capturedAt = new Date(touch.captured_at).getTime();
    const next = {
      first_touch: base.first_touch || touch,
      last_touch: touch,
      synced_user_id: '',
      synced_last_touch_at: '',
      expires_at: new Date(
        (Number.isFinite(capturedAt) ? capturedAt : Date.now())
        + ACQUISITION_TOUCH_TTL_MS,
      ).toISOString(),
    };
    storage.setItem(ACQUISITION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Attribution must never prevent the app from loading.
  }

  return touch;
}

export function shouldSyncStoredAcquisition(stored, userId) {
  if (!stored?.first_touch || !userId) return false;
  if (
    stored.synced_user_id
    && stored.synced_user_id !== String(userId)
  ) {
    return false;
  }
  return !(
    stored.synced_user_id === String(userId)
    && stored.synced_last_touch_at === stored.last_touch?.captured_at
  );
}

export function markStoredAcquisitionSynced(
  userId,
  storage = globalThis.localStorage,
) {
  if (!storage || !userId) return;
  try {
    const existing = readStoredAcquisition(storage);
    if (!existing?.first_touch) return;
    storage.setItem(ACQUISITION_STORAGE_KEY, JSON.stringify({
      ...existing,
      synced_user_id: String(userId),
      synced_last_touch_at: existing.last_touch?.captured_at || '',
    }));
  } catch {
    // A failed sync marker only causes a harmless retry next session.
  }
}

export function buildInstagramTrackedLink({
  origin = 'https://firstknock.online',
  destination = '/instagram',
  campaign = '1000-users',
  contentId,
} = {}) {
  const base = new URL(cleanPath(destination), origin);
  base.searchParams.set('utm_source', 'instagram');
  base.searchParams.set('utm_medium', 'organic_social');
  base.searchParams.set('utm_campaign', cleanToken(campaign) || '1000-users');
  base.searchParams.set('utm_content', cleanToken(contentId) || 'ig-bio');
  return base.toString();
}

export function buildPlatformTrackedLink({
  origin = 'https://firstknock.online',
  destination = '/start',
  platform,
  campaign = '1000-users',
  contentId,
} = {}) {
  const source = cleanToken(platform);
  if (!['instagram', 'tiktok'].includes(source)) {
    throw new TypeError('A supported acquisition platform is required.');
  }

  const base = new URL(cleanPath(destination), origin);
  base.searchParams.set('utm_source', source);
  base.searchParams.set('utm_medium', 'organic_social');
  base.searchParams.set('utm_campaign', cleanToken(campaign) || '1000-users');
  base.searchParams.set(
    'utm_content',
    cleanToken(contentId) || (source === 'tiktok' ? 'tt-bio' : 'ig-bio'),
  );
  return base.toString();
}
