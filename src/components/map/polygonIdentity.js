const COORDINATE_PRECISION = 7;

function normalizedCoordinate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // Avoid two identities for the same coordinate because one value is -0.
  return Object.is(number, -0) ? 0 : number;
}

function normalizePoint(point) {
  if (Array.isArray(point)) {
    const lng = normalizedCoordinate(point[0]);
    const lat = normalizedCoordinate(point[1]);
    return lat === null || lng === null ? null : { lat, lng };
  }

  const lat = normalizedCoordinate(point?.lat ?? point?.latitude);
  const lng = normalizedCoordinate(point?.lng ?? point?.lon ?? point?.longitude);
  return lat === null || lng === null ? null : { lat, lng };
}

function pointToken(point) {
  return `${point.lat.toFixed(COORDINATE_PRECISION)},${point.lng.toFixed(COORDINATE_PRECISION)}`;
}

function minimalRotation(tokens) {
  const length = tokens.length;
  if (length < 2) return tokens.slice();

  // Booth's algorithm finds the lexicographically smallest cyclic rotation in O(n).
  let left = 0;
  let right = 1;
  let offset = 0;

  while (left < length && right < length && offset < length) {
    const leftValue = tokens[(left + offset) % length];
    const rightValue = tokens[(right + offset) % length];

    if (leftValue === rightValue) {
      offset += 1;
      continue;
    }

    if (leftValue > rightValue) {
      left += offset + 1;
      if (left === right) left += 1;
    } else {
      right += offset + 1;
      if (left === right) right += 1;
    }
    offset = 0;
  }

  const start = Math.min(left, right);
  return Array.from({ length }, (_, index) => tokens[(start + index) % length]);
}

export function canonicalPolygonVertices(polygon = []) {
  if (!Array.isArray(polygon)) return [];

  let points = polygon;
  if (Array.isArray(points[0]) && Array.isArray(points[0][0])) points = points[0];

  const tokens = points.map(normalizePoint).filter(Boolean).map(pointToken);
  if (tokens.length === 0) return [];

  // Provider payloads may explicitly repeat the first point to close the ring.
  while (tokens.length > 1 && tokens[tokens.length - 1] === tokens[0]) tokens.pop();

  const withoutConsecutiveDuplicates = tokens.filter((token, index) => index === 0 || token !== tokens[index - 1]);
  if (withoutConsecutiveDuplicates.length < 3) return [];

  const forward = minimalRotation(withoutConsecutiveDuplicates);
  const reverse = minimalRotation(withoutConsecutiveDuplicates.slice().reverse());
  return forward.join(';') <= reverse.join(';') ? forward : reverse;
}

export function polygonIdentity(polygon = []) {
  const canonical = canonicalPolygonVertices(polygon);
  return canonical.length >= 3 ? `polygon:${canonical.length}:${canonical.join(';')}` : '';
}
