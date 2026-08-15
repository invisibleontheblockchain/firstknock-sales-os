export const CANVAS_DNC_HOUSE_MATCH_METERS = 12;

function normalizedHouseKey(value) {
  return String(value || '').trim().toLowerCase();
}

function pointOf(value) {
  const point = value?.point || value || {};
  const lat = Number(value?.lat ?? point.lat ?? point.latitude);
  const lng = Number(value?.lng ?? point.lng ?? point.lon ?? point.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function distanceMeters(left, right) {
  const radians = Math.PI / 180;
  const lat1 = left.lat * radians;
  const lat2 = right.lat * radians;
  const deltaLat = (right.lat - left.lat) * radians;
  const deltaLng = (right.lng - left.lng) * radians;
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function isCanvasDncProtected(target, entries = [], maxDistanceMeters = CANVAS_DNC_HOUSE_MATCH_METERS) {
  if (target?.read_only_dnc || target?.dnc_active || target?.latest_outcome === 'do_not_knock') return true;
  const targetHouseKey = normalizedHouseKey(target?.house_key ?? target?.houseKey);
  const targetPoint = pointOf(target);
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    if (entry?.active === false) return false;
    const entryHouseKey = normalizedHouseKey(entry?.house_key ?? entry?.houseKey);
    if (targetHouseKey && entryHouseKey && targetHouseKey === entryHouseKey) return true;
    const entryPoint = pointOf(entry);
    return Boolean(targetPoint && entryPoint && distanceMeters(targetPoint, entryPoint) <= maxDistanceMeters);
  });
}
