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
  if (areaSqMi < 1.5) return { key: 'urban', ...DENSITY_TIERS.urban };
  if (areaSqMi <= 60) return { key: 'suburban', ...DENSITY_TIERS.suburban };
  return { key: 'rural', ...DENSITY_TIERS.rural };
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

function normalizePolygon(points = []) {
  const deduped = points.filter((point, index, arr) => !samePoint(point, arr[index - 1]));
  if (deduped.length > 2 && samePoint(deduped[0], deduped[deduped.length - 1])) deduped.pop();
  return signedArea(deduped) < 0 ? deduped.reverse() : deduped;
}

function clipPolygon(subjectPolygon, clipPolygonPoints) {
  let output = normalizePolygon(subjectPolygon);
  const clipPoints = normalizePolygon(clipPolygonPoints);
  for (let index = 0; index < clipPoints.length; index += 1) {
    const edgeStart = clipPoints[index];
    const edgeEnd = clipPoints[(index + 1) % clipPoints.length];
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
  return normalizePolygon(output);
}

function isValidPolygon(points) {
  if (!points || points.length < 3) return false;
  if (calculatePolygonAreaSqMi(points) <= 0.000001) return false;
  const first = points[0];
  return points.some((point, index) => {
    const next = points[(index + 1) % points.length];
    return Math.abs((point.lng - first.lng) * (next.lat - first.lat) - (point.lat - first.lat) * (next.lng - first.lng)) > 0.0000000001;
  });
}

function polygonCentroid(points) {
  const clean = normalizePolygon(points);
  if (!isValidPolygon(clean)) return null;
  let areaTerm = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const current = clean[index];
    const next = clean[(index + 1) % clean.length];
    const cross = current.lng * next.lat - next.lng * current.lat;
    areaTerm += cross;
    cx += (current.lng + next.lng) * cross;
    cy += (current.lat + next.lat) * cross;
  }
  const area = areaTerm / 2;
  if (Math.abs(area) < 0.0000000001) return null;
  return { lat: cy / (6 * area), lng: cx / (6 * area) };
}

function centroidOfParts(parts) {
  let totalArea = 0;
  let lat = 0;
  let lng = 0;
  parts.forEach((part) => {
    const area = calculatePolygonAreaSqMi(part);
    const centroid = polygonCentroid(part);
    if (!centroid || area <= 0) return;
    totalArea += area;
    lat += centroid.lat * area;
    lng += centroid.lng * area;
  });
  return totalArea > 0 ? { lat: lat / totalArea, lng: lng / totalArea } : null;
}

function getDropPoint(points) {
  return points.reduce((best, point) => {
    if (!best) return point;
    if (point.lat > best.lat) return point;
    if (Math.abs(point.lat - best.lat) < 0.000001 && point.lng < best.lng) return point;
    return best;
  }, null);
}

function splitCell(cell) {
  const bounds = getBounds(cell.geometry);
  const splitLat = (bounds.minLat + bounds.maxLat) / 2;
  const splitLng = (bounds.minLng + bounds.maxLng) / 2;
  const splitAlongLng = (bounds.maxLng - bounds.minLng) >= (bounds.maxLat - bounds.minLat);
  const rectangles = splitAlongLng ? [
    [{ lat: bounds.maxLat, lng: bounds.minLng }, { lat: bounds.maxLat, lng: splitLng }, { lat: bounds.minLat, lng: splitLng }, { lat: bounds.minLat, lng: bounds.minLng }],
    [{ lat: bounds.maxLat, lng: splitLng }, { lat: bounds.maxLat, lng: bounds.maxLng }, { lat: bounds.minLat, lng: bounds.maxLng }, { lat: bounds.minLat, lng: splitLng }],
  ] : [
    [{ lat: bounds.maxLat, lng: bounds.minLng }, { lat: bounds.maxLat, lng: bounds.maxLng }, { lat: splitLat, lng: bounds.maxLng }, { lat: splitLat, lng: bounds.minLng }],
    [{ lat: splitLat, lng: bounds.minLng }, { lat: splitLat, lng: bounds.maxLng }, { lat: bounds.minLat, lng: bounds.maxLng }, { lat: bounds.minLat, lng: bounds.minLng }],
  ];
  const pieces = rectangles
    .map((rectangle) => clipPolygon(cell.geometry, rectangle))
    .filter(isValidPolygon)
    .map((geometry) => ({ geometry, area: calculatePolygonAreaSqMi(geometry) }));
  return pieces.length === 2 ? pieces : [cell];
}

function serpentineSort(cells) {
  const rows = new Map();
  cells.forEach((cell) => {
    const key = Math.round(cell.center.lat * 1000);
    rows.set(key, [...(rows.get(key) || []), cell]);
  });
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .flatMap(([, row], rowIndex) => row.sort((a, b) => rowIndex % 2 === 0 ? a.center.lng - b.center.lng : b.center.lng - a.center.lng));
}

function groupCells(cells, zoneCount, targetZoneAreaSqMi) {
  const ordered = serpentineSort(cells);
  const targetArea = Math.max(0.0001, targetZoneAreaSqMi || (ordered.reduce((sum, cell) => sum + cell.area, 0) / zoneCount));
  const groups = [];
  let current = [];
  let currentArea = 0;
  ordered.forEach((cell, index) => {
    const remainingCells = ordered.length - index;
    const remainingGroups = zoneCount - groups.length;
    const wouldExceed = current.length > 0 && currentArea + cell.area > targetArea * 1.12;
    const currentIsUseful = currentArea >= targetArea * 0.65;
    const shouldClose = wouldExceed && currentIsUseful && remainingCells >= remainingGroups;
    if (shouldClose) {
      groups.push(current);
      current = [];
      currentArea = 0;
    }
    current.push(cell);
    currentArea += cell.area;
  });
  if (current.length) groups.push(current);
  while (groups.length > zoneCount) groups[groups.length - 2].push(...groups.pop());
  while (groups.length < zoneCount && groups.some((group) => group.length > 1)) {
    const largestIndex = groups.reduce((best, group, index) => {
      const area = group.reduce((sum, cell) => sum + cell.area, 0);
      const bestArea = groups[best].reduce((sum, cell) => sum + cell.area, 0);
      return area > bestArea && group.length > 1 ? index : best;
    }, 0);
    groups.splice(largestIndex + 1, 0, groups[largestIndex].splice(Math.ceil(groups[largestIndex].length / 2)));
  }
  return groups.slice(0, zoneCount);
}

export function getCanvasCampaignSummary({ polygon, repCount = 8, shiftHours = 5, doorsPerHour = 20, repsPerZone = 1, densityMode = 'auto', customDoorsPerSqMi = 150 }) {
  const areaSqMi = calculatePolygonAreaSqMi(polygon);
  const density = detectCanvasDensity(areaSqMi, densityMode, customDoorsPerSqMi);
  const doorsPerRep = Math.max(1, Math.round((Number(shiftHours) || 5) * (Number(doorsPerHour) || 20)));
  const safeRepsPerZone = Math.max(1, Math.min(2, Number(repsPerZone) || 1));
  const targetDoorsPerZone = doorsPerRep * safeRepsPerZone;
  const minimumRepZones = Math.max(1, Math.ceil((Number(repCount) || 1) / safeRepsPerZone));
  const estimatedTotalDoors = Math.round(areaSqMi * density.doorsPerSqMi);
  const capacityZones = Math.max(1, Math.ceil(estimatedTotalDoors / targetDoorsPerZone));
  const zoneCount = Math.max(minimumRepZones, capacityZones);
  const targetZoneAreaSqMi = targetDoorsPerZone / density.doorsPerSqMi;
  return { areaSqMi, density, doorsPerRep, targetDoorsPerZone, zoneCount, targetZoneAreaSqMi, estimatedTotalDoors, minimumRepZones, capacityZones };
}

export function generateCanvasZones(polygon, configOrCount, existingZones = []) {
  let points = cleanPolygon(polygon);
  if (points.length > 2 && samePoint(points[0], points[points.length - 1])) points = points.slice(0, -1);
  if (points.length < 3) return [];
  points = normalizePolygon(points);

  const config = typeof configOrCount === 'object' ? configOrCount : { repCount: configOrCount };
  const summary = getCanvasCampaignSummary({ polygon: points, ...config });
  const bounds = getBounds(points);
  const avgLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const { latScale, lngScale } = getScales(avgLat);
  const areaPerSeedCell = Math.max(0.0008, Math.min(summary.targetZoneAreaSqMi / 8, summary.areaSqMi / Math.max(summary.zoneCount * 8, summary.zoneCount)));
  const aspectRatio = 1.25;
  const cellHeightMiles = Math.sqrt(areaPerSeedCell / aspectRatio);
  const cellWidthMiles = cellHeightMiles * aspectRatio;
  const latStep = Math.max(0.0005, cellHeightMiles / latScale);
  const lngStep = Math.max(0.0005, cellWidthMiles / lngScale);
  const paddedBounds = {
    minLat: bounds.minLat - latStep,
    maxLat: bounds.maxLat + latStep,
    minLng: bounds.minLng - lngStep,
    maxLng: bounds.maxLng + lngStep,
  };
  let cells = [];

  for (let lat = paddedBounds.maxLat; lat > paddedBounds.minLat; lat -= latStep) {
    for (let lng = paddedBounds.minLng; lng < paddedBounds.maxLng; lng += lngStep) {
      const rectangle = normalizePolygon([
        { lat, lng },
        { lat, lng: lng + lngStep },
        { lat: lat - latStep, lng: lng + lngStep },
        { lat: lat - latStep, lng },
      ]);
      const clipped = clipPolygon(points, rectangle);
      if (!isValidPolygon(clipped)) continue;
      const area = calculatePolygonAreaSqMi(clipped);
      cells.push({ geometry: clipped, area, center: polygonCentroid(clipped) });
    }
  }

  while (cells.some((cell) => cell.area > summary.targetZoneAreaSqMi * 0.75) || cells.length < summary.zoneCount) {
    const largestIndex = cells.reduce((bestIndex, cell, index) => cell.area > cells[bestIndex].area ? index : bestIndex, 0);
    const pieces = splitCell(cells[largestIndex]);
    if (pieces.length < 2) break;
    cells.splice(largestIndex, 1, ...pieces.map((piece) => ({ ...piece, center: polygonCentroid(piece.geometry) })));
  }

  const groupedCells = groupCells(cells, summary.zoneCount, summary.targetZoneAreaSqMi);
  return groupedCells.map((group, index) => {
    const existing = existingZones[index] || {};
    const parts = group.map((cell) => cell.geometry);
    const area = group.reduce((sum, cell) => sum + cell.area, 0);
    const center = centroidOfParts(parts) || group[0]?.center || null;
    return {
      ...existing,
      zone_number: index + 1,
      name: existing.name || `Zone ${index + 1}`,
      color: existing.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      geometry: parts[0] || [],
      parts,
      area_sq_mi: Number(area.toFixed(2)),
      estimated_doors: Math.max(1, Math.round(area * summary.density.doorsPerSqMi)),
      target_doors: summary.targetDoorsPerZone,
      density_key: summary.density.key,
      density_doors_per_sq_mi: summary.density.doorsPerSqMi,
      drop_point: getDropPoint(parts.flat()),
      center,
      status: existing.status || 'unworked',
      notes: existing.notes || '',
      assignments: existing.assignments || [],
    };
  });
}