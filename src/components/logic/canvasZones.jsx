const DEFAULT_COLORS = ['#FFD700', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#f97316', '#8b5cf6', '#06b6d4', '#eab308', '#14b8a6'];

const cleanPolygon = (polygon = []) => polygon
  .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
  .map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));

const samePoint = (a, b) => a && b && Math.abs(a.lat - b.lat) < 0.0000001 && Math.abs(a.lng - b.lng) < 0.0000001;

const distance = (a, b) => {
  const latScale = 69;
  const lngScale = 69 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const dLat = (b.lat - a.lat) * latScale;
  const dLng = (b.lng - a.lng) * lngScale;
  return Math.sqrt(dLat * dLat + dLng * dLng);
};

const interpolate = (a, b, ratio) => ({
  lat: a.lat + (b.lat - a.lat) * ratio,
  lng: a.lng + (b.lng - a.lng) * ratio,
});

const centroidOf = (points) => {
  const total = points.reduce((sum, point) => ({ lat: sum.lat + point.lat, lng: sum.lng + point.lng }), { lat: 0, lng: 0 });
  return { lat: total.lat / points.length, lng: total.lng / points.length };
};

const buildEdges = (points) => {
  const edges = [];
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const length = distance(start, end);
    if (length <= 0) continue;
    edges.push({ start, end, startDistance: total, endDistance: total + length, length });
    total += length;
  }
  return { edges, total };
};

const pointAtDistance = (edges, targetDistance, totalDistance) => {
  const wrappedDistance = ((targetDistance % totalDistance) + totalDistance) % totalDistance;
  const edge = edges.find((item) => wrappedDistance >= item.startDistance && wrappedDistance <= item.endDistance) || edges[edges.length - 1];
  const ratio = edge.length ? (wrappedDistance - edge.startDistance) / edge.length : 0;
  return interpolate(edge.start, edge.end, Math.max(0, Math.min(1, ratio)));
};

const perimeterSlice = (edges, startDistance, endDistance, totalDistance) => {
  const startPoint = pointAtDistance(edges, startDistance, totalDistance);
  const endPoint = pointAtDistance(edges, endDistance, totalDistance);
  const points = [startPoint];

  edges.forEach((edge) => {
    if (edge.endDistance > startDistance && edge.endDistance < endDistance && !samePoint(points[points.length - 1], edge.end)) {
      points.push(edge.end);
    }
  });

  if (!samePoint(points[points.length - 1], endPoint)) points.push(endPoint);
  return points;
};

export function generateCanvasZones(polygon, count, existingZones = []) {
  let points = cleanPolygon(polygon);
  if (points.length > 2 && samePoint(points[0], points[points.length - 1])) points = points.slice(0, -1);

  const zoneCount = Math.max(1, Math.min(500, Number(count) || 1));
  if (points.length < 3) return [];

  const center = centroidOf(points);
  const { edges, total } = buildEdges(points);
  if (!edges.length || total <= 0) return [];

  return Array.from({ length: zoneCount }, (_, index) => {
    const existing = existingZones[index] || {};
    const startDistance = (total / zoneCount) * index;
    const endDistance = (total / zoneCount) * (index + 1);
    const boundary = perimeterSlice(edges, startDistance, endDistance, total);

    return {
      ...existing,
      zone_number: index + 1,
      name: existing.name || `Zone ${index + 1}`,
      color: existing.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      geometry: [center, ...boundary],
    };
  });
}