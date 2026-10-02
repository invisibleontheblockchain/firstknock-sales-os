export const LOCATION_LIVE_MS = 60_000;
export const LOCATION_MAX_AGE_MS = 5 * 60_000;
export const LOCATION_PUBLISH_MS = 15_000;
export const LOCATION_FIX_MAX_AGE_MS = 30_000;

export function validLocation(point) {
  return typeof point?.lat === 'number' && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && typeof point?.lng === 'number' && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

export function locationStatus(location, now = Date.now()) {
  if (!location?.sharing || !validLocation(location)) return 'offline';
  const age = now - Date.parse(location.observed_at);
  if (!Number.isFinite(age) || age < -10_000 || age > LOCATION_MAX_AGE_MS) return 'offline';
  return age <= LOCATION_LIVE_MS ? 'live' : 'stale';
}

export function locationAgeLabel(location, now = Date.now()) {
  const age = now - Date.parse(location?.observed_at);
  if (!Number.isFinite(age)) return 'No location yet';
  const seconds = Math.max(0, Math.floor(age / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}
