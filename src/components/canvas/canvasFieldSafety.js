export const CANVAS_FIELD_TAP_MAX_STREET_METERS = 120;

function point(value) {
  const lat = Number(value?.lat ?? value?.latitude);
  const lng = Number(value?.lng ?? value?.lon ?? value?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function pointToSegmentMeters(target, start, end) {
  const meanLatRadians = ((target.lat + start.lat + end.lat) / 3) * Math.PI / 180;
  const metersPerLng = Math.max(1, 111_320 * Math.cos(meanLatRadians));
  const origin = { x: target.lng * metersPerLng, y: target.lat * 110_574 };
  const left = { x: start.lng * metersPerLng, y: start.lat * 110_574 };
  const right = { x: end.lng * metersPerLng, y: end.lat * 110_574 };
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator > 0
    ? Math.max(0, Math.min(1, ((origin.x - left.x) * dx + (origin.y - left.y) * dy) / denominator))
    : 0;
  return Math.hypot(origin.x - (left.x + ratio * dx), origin.y - (left.y + ratio * dy));
}

export function nearestCanvasStreetDistanceMeters(targetValue, segments = []) {
  const target = point(targetValue);
  if (!target) return Infinity;
  let nearest = Infinity;
  for (const segment of Array.isArray(segments) ? segments : []) {
    const start = point(segment?.start);
    const end = point(segment?.end);
    if (!start || !end) continue;
    nearest = Math.min(nearest, pointToSegmentMeters(target, start, end));
  }
  return nearest;
}

export function isCanvasFieldTapSafe(target, segments, maximumMeters = CANVAS_FIELD_TAP_MAX_STREET_METERS) {
  return nearestCanvasStreetDistanceMeters(target, segments) <= maximumMeters;
}
