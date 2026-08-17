const EARTH_METERS_PER_DEGREE = 111_320;

export function pointOf(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null;
  const [lng, lat] = geometry.coordinates.map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export function ringsOf(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type === 'Polygon') return [geometry.coordinates?.[0] || []];
  if (geometry?.type === 'MultiPolygon') return (geometry.coordinates || []).map((polygon) => polygon?.[0] || []);
  return [];
}

export function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[previous];
    const [x2, y2] = ring[index];
    if ((y2 > point.lat) !== (y1 > point.lat) && point.lng < ((x1 - x2) * (point.lat - y2)) / (y1 - y2) + x2) inside = !inside;
  }
  return inside;
}

export function featureContainsPoint(feature, point) {
  return ringsOf(feature).some((ring) => pointInRing(point, ring));
}

function orientation(first, second, third) {
  const value = (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
  if (Math.abs(value) <= 1e-12) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(point, start, end) {
  return orientation(start, end, point) === 0
    && point[0] >= Math.min(start[0], end[0]) - 1e-12 && point[0] <= Math.max(start[0], end[0]) + 1e-12
    && point[1] >= Math.min(start[1], end[1]) - 1e-12 && point[1] <= Math.max(start[1], end[1]) + 1e-12;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const one = orientation(firstStart, firstEnd, secondStart);
  const two = orientation(firstStart, firstEnd, secondEnd);
  const three = orientation(secondStart, secondEnd, firstStart);
  const four = orientation(secondStart, secondEnd, firstEnd);
  return (one !== two && three !== four) || onSegment(secondStart, firstStart, firstEnd)
    || onSegment(secondEnd, firstStart, firstEnd) || onSegment(firstStart, secondStart, secondEnd)
    || onSegment(firstEnd, secondStart, secondEnd);
}

export function lineIntersectsRing(coordinates, ring) {
  if (coordinates.some(([lng, lat]) => pointInRing({ lng, lat }, ring))) return true;
  for (let lineIndex = 1; lineIndex < coordinates.length; lineIndex += 1) {
    for (let ringIndex = 0; ringIndex < ring.length; ringIndex += 1) {
      if (segmentsIntersect(coordinates[lineIndex - 1], coordinates[lineIndex], ring[ringIndex], ring[(ringIndex + 1) % ring.length])) return true;
    }
  }
  return false;
}

function projected(point, originLat) {
  return { x: point.lng * EARTH_METERS_PER_DEGREE * Math.cos(originLat * Math.PI / 180), y: point.lat * EARTH_METERS_PER_DEGREE };
}

export function distanceToLineMeters(point, coordinates = []) {
  const originLat = point.lat;
  const target = projected(point, originLat);
  let best = Infinity;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = projected({ lng: Number(coordinates[index - 1][0]), lat: Number(coordinates[index - 1][1]) }, originLat);
    const end = projected({ lng: Number(coordinates[index][0]), lat: Number(coordinates[index][1]) }, originLat);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const ratio = dx || dy ? Math.max(0, Math.min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(target.x - (start.x + ratio * dx), target.y - (start.y + ratio * dy)));
  }
  return best;
}

export function boundsForFeatures(features = []) {
  const positions = [];
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) positions.push([Number(value[0]), Number(value[1])]);
    else value.forEach(visit);
  };
  features.forEach((feature) => visit(feature?.geometry?.coordinates));
  if (!positions.length) throw new TypeError('Regional Overture inputs contain no geometry.');
  const lng = positions.map(([value]) => value);
  const lat = positions.map(([, value]) => value);
  return { min_lng: Math.min(...lng), min_lat: Math.min(...lat), max_lng: Math.max(...lng), max_lat: Math.max(...lat) };
}

export function bboxAreaSqMi(bounds) {
  const latitude = (bounds.min_lat + bounds.max_lat) / 2;
  return Math.max(0.000001, (bounds.max_lat - bounds.min_lat) * 69 * (bounds.max_lng - bounds.min_lng) * 69 * Math.cos(latitude * Math.PI / 180));
}