export const LOCATION_LIVE_MS = 60_000;
export const LOCATION_MAX_AGE_MS = 5 * 60_000;
// Two fresh heartbeats fit inside the unchanged one-minute live window.
export const LOCATION_PUBLISH_MS = 30_000;
export const LOCATION_REPORT_MS = 30_000;
export const LOCATION_RETRY_MAX_MS = 2 * 60_000;
export const LOCATION_FIX_MAX_AGE_MS = 30_000;

export function validLocation(point) {
  return typeof point?.lat === 'number' && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && typeof point?.lng === 'number' && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

// Reps share only while clocked in. Past the delayed window a rep who is still on
// the clock keeps their last position from this shift, marked paused: a browser
// cannot send GPS while the phone is locked or the app is closed.
export function locationStatus(location, now = Date.now(), onShift = false) {
  if (!location?.sharing || !validLocation(location)) return 'offline';
  const age = now - Date.parse(location.observed_at);
  if (!Number.isFinite(age) || age < -10_000) return 'offline';
  if (age > LOCATION_MAX_AGE_MS) return onShift ? 'paused' : 'offline';
  return age <= LOCATION_LIVE_MS ? 'live' : 'stale';
}

export function locationAgeLabel(location, now = Date.now()) {
  const age = now - Date.parse(location?.observed_at);
  if (!Number.isFinite(age)) return 'No location yet';
  const seconds = Math.max(0, Math.floor(age / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}
