// Lets a rep close the location and mileage notices at the top of the app.
//
// A closed notice stays closed for the rest of that shift (or, off the clock,
// until the next clock-in), and never longer than a working day, so a rep who
// hides it is not nagged but still sees it again on the next shift. The memory
// is per device and per account, and survives the reloads phones do when the
// rep switches apps.
//
// Kept free of React and DOM imports so it runs under node:test.

export const FIELD_BANNER_DISMISS_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const text = value => (value === undefined || value === null ? '' : String(value).trim());

export function fieldBannerKey(bannerId, userId) {
  return `fk_dismissedBanner_${text(bannerId)}_${text(userId)}`;
}

/** True when this banner was closed for this exact scope within the time limit. */
export function isFieldBannerDismissed(storage, { bannerId, userId, scope }, { now = Date.now(), maxAgeMs = FIELD_BANNER_DISMISS_MAX_AGE_MS } = {}) {
  if (!text(bannerId) || !text(userId)) return false;
  try {
    const record = JSON.parse(storage?.getItem?.(fieldBannerKey(bannerId, userId)) || 'null');
    const at = Number(record?.at);
    return record?.scope === text(scope) && Number.isFinite(at) && at <= now + 60_000 && now - at <= maxAgeMs;
  } catch {
    return false;
  }
}

export function dismissFieldBanner(storage, { bannerId, userId, scope }, { now = Date.now() } = {}) {
  if (!text(bannerId) || !text(userId)) return false;
  try {
    storage?.setItem?.(fieldBannerKey(bannerId, userId), JSON.stringify({ scope: text(scope), at: now }));
    return true;
  } catch {
    // Private mode or a full device: the notice still closes for this visit.
    return false;
  }
}

/** The location notice's scope: one shift, or the off-the-clock period. */
export function locationBannerScope({ sharing, shiftId, verificationError }) {
  if (verificationError) return 'verification';
  return sharing && text(shiftId) ? `shift:${text(shiftId)}` : 'off-shift';
}

/** The mileage notice's scope: the consent prompt, or one shift with mileage on. */
export function mileageBannerScope({ consent, shiftId }) {
  return `${consent ? 'on' : 'prompt'}:${text(shiftId) || 'no-shift'}`;
}

/**
 * The location notice's headline. A blocked or silent GPS is said plainly, not
 * as "connecting" forever, so the rep knows it needs them.
 */
export function locationBannerTitle({ sharing, live, error, verificationError }) {
  if (verificationError) return 'Location sharing paused: your shift could not be verified';
  if (!sharing) return 'Location sharing starts when you clock in';
  if (live) return 'On the clock · location live with your manager';
  const problem = text(error);
  if (/permission is blocked/i.test(problem)) return 'On the clock · location access is blocked';
  if (/unavailable on this device/i.test(problem)) return 'On the clock · location sharing unavailable';
  if (/waiting for/i.test(problem)) return 'On the clock · waiting for GPS…';
  if (problem) return 'On the clock · location not updating';
  return 'On the clock · connecting your location…';
}
