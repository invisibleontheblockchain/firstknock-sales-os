const DEFAULT_COLORS = [
  '#FFD166', '#EF476F', '#06D6A0', '#118AB2', '#A78BFA', '#F97316',
  '#22C55E', '#38BDF8', '#FACC15', '#FB7185', '#34D399', '#C084FC'
];

export const DENSITY_TIERS = {
  urban: { label: 'Urban', doorsPerSqMi: 500 },
  suburban: { label: 'Suburban', doorsPerSqMi: 150 },
  rural: { label: 'Rural', doorsPerSqMi: 40 },
};

const cleanPolygon = (polygon = []) => polygon
  .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
  .map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));

const samePoint = (a, b) => a && b && Math.abs(a.lat - b.lat) < 0.0000001 && Math.abs(a.lng - b.lng) < 0.0000001;

const getScales = (lat) => ({ latScale: 69, lngScale: 69 * Math.cos(lat * Math.PI / 180) });

const getBounds = (points) => points.reduce((bounds, point) => ({
  minLat: Math.min(bounds.minLat, point.lat),
  maxLat: Math.max(bounds.maxLat, point.lat),
  minLng: Math.min(bounds.minLng, point.lng),
  maxLng: Math.max(bounds.maxLng, point.lng),
}), { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity });

export function calculatePolygonAreaSqMi(polygon = []) {
  const points = cleanPolygon(polygon);
  if (points.length < 3) return 0;
  const avgLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const { latScale, lngScale } = getScales(avgLat);
  const origin = points[0];
  const projected = points.map((point) => ({
    x: (point.lng - origin.lng) * lngScale,
    y: (point.lat - origin.lat) * latScale,
  }));
  let sum = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

export function detectCanvasDensity(areaSqMi, override = 'auto', customDoorsPerSqMi = 150) {
  if (override === 'custom') return { key: 'custom', label: 'Custom', doorsPerSqMi: Math.max(1, Number(customDoorsPerSqMi) || 150) };
  if (DENSITY_TIERS[override]) return { key: override, ...DENSITY_TIERS[override] };
  if (areaSqMi < 2) return { key: 'urban', ...DENSITY_TIERS.urban };
  if (areaSqMi <= 10) return { key: 'suburban', ...DENSITY_TIERS.suburban };
  return { key: 'rural', ...DENSITY_TIERS.rural };
}

function isInside(point, edgeStart, edgeEnd) {
  return (edgeEnd.lng - edgeStart.lng) * (point.lat - edgeStart.lat) - (edgeEnd.lat - edgeStart.lat) * (point.lng - edgeStart.lng) >= -0.000000001;
}

function intersection(lineStart, lineEnd, edgeStart, edgeEnd) {
  const x1 = lineStart.lng; const y1 = lineStart.lat;
  const x2 = lineEnd.lng; const y2 = lineEnd.lat;
  const x3 = edgeStart.lng; const y3 = edgeStart.lat;
  const x4 = edgeEnd.lng; const y4 = edgeEnd.lat;
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denominator) < 0.0000000001) return lineEnd;
  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denominator;
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denominator;
  return { lat: py, lng: px };
}

function signedArea(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current.lng * next.lat - next.lng * current.lat;
  }
  return sum / 2;
}

function clipPolygon(subjectPolygon, clipPolygonPoints) {
  let output = subjectPolygon;
  for (let index = 0; index < clipPolygonPoints.length; index += 1) {
    const edgeStart = clipPolygonPoints[index];
    const edgeEnd = clipPolygonPoints[(index + 1) % clipPolygonPoints.length];
    const input = output;
    output = [];
    if (!input.length) break;
    let previous = input[input.length - 1];
    input.forEach((current) => {
      const currentInside = isInside(current, edgeStart, edgeEnd);
      const previousInside = isInside(previous, edgeStart, edgeEnd);
      if (currentInside) {
        if (!previousInside) output.push(intersection(previous, current, edgeStart, edgeEnd));
        output.push(current);
      } else if (previousInside) {
        output.push(intersection(previous, current, edgeStart, edgeEnd));
      }
      previous = current;
    });
  }
  return output.filter((point, index, arr) => !samePoint(point, arr[index - 1]));
}

function getDropPoint(points) {
  return points.reduce((best, point) => {
    if (!best) return point;
    if (point.lat > best.lat) return point;
    if (Math.abs(point.lat - best.lat) < 0.000001 && point.lng < best.lng) return point;
    return best;
  }, null);
}

function centerOf(points) {
  if (!points.length) return null;
  return points.reduce((sum, point) => ({ lat: sum.lat + point.lat / points.length, lng: sum.lng + point.lng / points.length }), { lat: 0, lng: 0 });
}

export function getCanvasCampaignSummary({ polygon, repCount = 8, shiftHours = 5, doorsPerHour = 20, repsPerZone = 1, densityMode = 'auto', customDoorsPerSqMi = 150 }) {
  const areaSqMi = calculatePolygonAreaSqMi(polygon);
  const density = detectCanvasDensity(areaSqMi, densityMode, customDoorsPerSqMi);
  const doorsPerRep = Math.max(1, Math.round((Number(shiftHours) || 5) * (Number(doorsPerHour) || 20)));
  const safeRepsPerZone = Math.max(1, Math.min(2, Number(repsPerZone) || 1));
  const targetDoorsPerZone = doorsPerRep * safeRepsPerZone;
  const zoneCount = Math.max(1, Math.ceil((Number(repCount) || 1) / safeRepsPerZone));
  const targetZoneAreaSqMi = targetDoorsPerZone / density.doorsPerSqMi;
  const estimatedTotalDoors = Math.round(areaSqMi * density.doorsPerSqMi);
  return { areaSqMi, density, doorsPerRep, targetDoorsPerZone, zoneCount, targetZoneAreaSqMi, estimatedTotalDoors };
}

export function generateCanvasZones(polygon, configOrCount, existingZones = []) {
  let points = cleanPolygon(polygon);
  if (points.length > 2 && samePoint(points[0], points[points.length - 1])) points = points.slice(0, -1);
  if (points.length < 3) return [];
  if (signedArea(points) < 0) points = [...points].reverse();

  const config = typeof configOrCount === 'object' ? configOrCount : { repCount: configOrCount };
  const summary = getCanvasCampaignSummary({ polygon: points, ...config });
  const bounds = getBounds(points);
  const avgLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const { latScale, lngScale } = getScales(avgLat);
  const targetArea = Math.max(0.02, summary.targetZoneAreaSqMi);
  const aspectRatio = 1.25;
  const cellHeightMiles = Math.sqrt(targetArea / aspectRatio);
  const cellWidthMiles = cellHeightMiles * aspectRatio;
  const latStep = Math.max(0.001, cellHeightMiles / latScale);
  const lngStep = Math.max(0.001, cellWidthMiles / lngScale);
  const fullCellArea = cellHeightMiles * cellWidthMiles;
  const zones = [];

  for (let lat = bounds.maxLat; lat > bounds.minLat && zones.length < summary.zoneCount; lat -= latStep) {
    for (let lng = bounds.minLng; lng < bounds.maxLng && zones.length < summary.zoneCount; lng += lngStep) {
      const rectangle = [
        { lat, lng },
        { lat, lng: Math.min(lng + lngStep, bounds.maxLng) },
        { lat: Math.max(lat - latStep, bounds.minLat), lng: Math.min(lng + lngStep, bounds.maxLng) },
        { lat: Math.max(lat - latStep, bounds.minLat), lng },
      ];
      const clipped = clipPolygon(rectangle, points);
      const clippedArea = calculatePolygonAreaSqMi(clipped);
      if (clipped.length < 3 || clippedArea < fullCellArea * 0.2) continue;
      const index = zones.length;
      const existing = existingZones[index] || {};
      zones.push({
        ...existing,
        zone_number: index + 1,
        name: existing.name || `Zone ${index + 1}`,
        color: existing.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
        geometry: clipped,
        area_sq_mi: Number(clippedArea.toFixed(2)),
        estimated_doors: Math.max(1, Math.round(clippedArea * summary.density.doorsPerSqMi)),
        drop_point: getDropPoint(clipped),
        center: centerOf(clipped),
        status: existing.status || 'unworked',
        notes: existing.notes || '',
        assignments: existing.assignments || [],
      });
    }
  }

  return zones;
}