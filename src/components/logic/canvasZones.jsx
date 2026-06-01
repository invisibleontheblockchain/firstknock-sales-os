import { polygonToCells, cellToBoundary, gridDisk } from 'h3-js';

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

function pointInPolygon(point, polygon = []) {
  if (!point || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const current = polygon[i];
    const previous = polygon[j];
    const intersects = ((current.lat > point.lat) !== (previous.lat > point.lat))
      && (point.lng < ((previous.lng - current.lng) * (point.lat - current.lat)) / ((previous.lat - current.lat) || 0.0000000001) + current.lng);
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonIntersectsPolygon(a = [], b = []) {
  if (!isValidPolygon(a) || !isValidPolygon(b)) return false;
  return a.some((point) => pointInPolygon(point, b))
    || b.some((point) => pointInPolygon(point, a))
    || pointInPolygon(polygonCentroid(a), b)
    || pointInPolygon(polygonCentroid(b), a);
}

function edgeKey(a, b) {
  return String(a) < String(b) ? `${a}:${b}` : `${b}:${a}`;
}

function directedEdgeKey(a, b) {
  return `${a}->${b}`;
}

function graphAngle(fromId, toId, nodes) {
  const from = nodes.get(fromId);
  const to = nodes.get(toId);
  if (!from || !to) return 0;
  const scale = Math.cos(((from.lat + to.lat) / 2) * Math.PI / 180) || 1;
  return Math.atan2(to.lat - from.lat, (to.lng - from.lng) * scale);
}

function clockwiseTurn(fromId, throughId, toId, nodes) {
  const incoming = graphAngle(throughId, fromId, nodes);
  const outgoing = graphAngle(throughId, toId, nodes);
  return (incoming - outgoing + Math.PI * 2) % (Math.PI * 2);
}

function canonicalFaceKey(faceIds = []) {
  if (!faceIds.length) return '';
  const rotations = [];
  const forward = faceIds.slice();
  const backward = faceIds.slice().reverse();
  [forward, backward].forEach((ids) => {
    for (let index = 0; index < ids.length; index += 1) {
      rotations.push([...ids.slice(index), ...ids.slice(0, index)].join(':'));
    }
  });
  return rotations.sort()[0];
}

function buildRoadGraph(roadNetwork) {
  const allowed = new Set(['primary', 'secondary', 'tertiary', 'residential']);
  const rawNodes = new Map();
  const ways = [];
  (roadNetwork?.elements || []).forEach((element) => {
    if (element.type === 'node' && Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
      rawNodes.set(element.id, { lat: Number(element.lat), lng: Number(element.lon) });
    }
  });
  (roadNetwork?.elements || []).forEach((element) => {
    if (element.type !== 'way' || !allowed.has(element.tags?.highway) || !Array.isArray(element.nodes) || element.nodes.length < 2) return;
    const nodes = element.nodes.filter((id) => rawNodes.has(id));
    if (nodes.length > 1) ways.push(nodes);
  });

  const adjacency = new Map();
  const nodes = new Map();
  ways.forEach((way) => {
    way.forEach((id) => nodes.set(id, rawNodes.get(id)));
    for (let index = 0; index < way.length - 1; index += 1) {
      const a = way[index];
      const b = way[index + 1];
      if (a === b) continue;
      adjacency.set(a, new Set([...(adjacency.get(a) || []), b]));
      adjacency.set(b, new Set([...(adjacency.get(b) || []), a]));
    }
  });

  return {
    nodes,
    adjacency: new Map([...adjacency.entries()].map(([id, neighbors]) => [id, [...neighbors]])),
  };
}

function findRoadFaces(nodes, adjacency, managerPolygon, targetZoneAreaSqMi) {
  const visited = new Set();
  const facesByKey = new Map();
  const maxFaceArea = Math.max(0.0001, targetZoneAreaSqMi * 3);
  const maxSteps = Math.max(50, adjacency.size * 4);

  adjacency.forEach((neighbors, startA) => {
    neighbors.forEach((startB) => {
      const startKey = directedEdgeKey(startA, startB);
      if (visited.has(startKey)) return;
      const faceIds = [];
      let previous = startA;
      let current = startB;

      for (let step = 0; step < maxSteps; step += 1) {
        visited.add(directedEdgeKey(previous, current));
        faceIds.push(previous);
        const candidates = (adjacency.get(current) || []).filter((id) => id !== previous);
        const next = candidates.length
          ? candidates.reduce((best, candidate) => clockwiseTurn(previous, current, candidate, nodes) < clockwiseTurn(previous, current, best, nodes) ? candidate : best, candidates[0])
          : previous;
        previous = current;
        current = next;
        if (previous === startA && current === startB) break;
      }

      if (previous !== startA || current !== startB || faceIds.length < 3) return;
      const key = canonicalFaceKey(faceIds);
      if (facesByKey.has(key)) return;
      const geometry = normalizePolygon(faceIds.map((id) => nodes.get(id)).filter(Boolean));
      if (!isValidPolygon(geometry)) return;
      const area = calculatePolygonAreaSqMi(geometry);
      if (area <= 0.000001 || area > maxFaceArea) return;
      const clipped = clipPolygon(geometry, managerPolygon);
      if (!isValidPolygon(clipped) || !polygonIntersectsPolygon(clipped, managerPolygon)) return;
      facesByKey.set(key, {
        ids: faceIds,
        geometry: clipped,
        area: calculatePolygonAreaSqMi(clipped),
        edgeKeys: faceIds.map((id, index) => edgeKey(id, faceIds[(index + 1) % faceIds.length])),
      });
    });
  });

  const faces = [...facesByKey.values()].filter((face) => face.area > 0.000001);
  const faceUsage = new Map();
  faces.forEach((face) => face.edgeKeys.forEach((key) => faceUsage.set(key, (faceUsage.get(key) || 0) + 1)));
  const missedInterior = [];
  adjacency.forEach((neighbors, a) => {
    neighbors.forEach((b) => {
      if (String(a) > String(b)) return;
      const first = nodes.get(a);
      const second = nodes.get(b);
      const midpoint = first && second ? { lat: (first.lat + second.lat) / 2, lng: (first.lng + second.lng) / 2 } : null;
      if (midpoint && pointInPolygon(midpoint, managerPolygon) && (faceUsage.get(edgeKey(a, b)) || 0) === 1) missedInterior.push(edgeKey(a, b));
    });
  });
  if (missedInterior.length) {
    console.warn('Road-aligned Canvas fallback: planar traversal missed an interior face.', missedInterior.slice(0, 5));
    return [];
  }
  return faces;
}

function subdivideOversizedFace(face, targetDoors, density) {
  if (face.estimatedDoors <= targetDoors * 2) return [face];
  let cells = [{ geometry: face.geometry, area: face.area, center: polygonCentroid(face.geometry) }];
  let guard = 0;
  while (cells.some((cell) => Math.round(cell.area * density.doorsPerSqMi) > targetDoors) && guard < 20) {
    const largestIndex = cells.reduce((best, cell, index) => cell.area > cells[best].area ? index : best, 0);
    const pieces = splitCell(cells[largestIndex]);
    if (pieces.length < 2) break;
    cells.splice(largestIndex, 1, ...pieces.map((piece) => ({ ...piece, center: polygonCentroid(piece.geometry) })));
    guard += 1;
  }
  return cells.map((cell, index) => ({
    ...cell,
    estimatedDoors: Math.max(1, Math.round(cell.area * density.doorsPerSqMi)),
    edgeKeys: [`${face.edgeKeys.join('|')}:split:${index}`],
  }));
}

function groupRoadFaces(faces, targetDoors) {
  const remaining = new Set(faces.map((_, index) => index));
  const edgeOwners = new Map();
  faces.forEach((face, index) => face.edgeKeys.forEach((key) => edgeOwners.set(key, [...(edgeOwners.get(key) || []), index])));
  const groups = [];

  const faceNeighbors = (index) => [...new Set(faces[index].edgeKeys.flatMap((key) => edgeOwners.get(key) || []).filter((neighbor) => neighbor !== index && remaining.has(neighbor)))]
    .sort((a, b) => faces[b].estimatedDoors - faces[a].estimatedDoors);

  while (remaining.size) {
    const seed = [...remaining].sort((a, b) => faces[b].estimatedDoors - faces[a].estimatedDoors)[0];
    const group = [seed];
    remaining.delete(seed);
    let doors = faces[seed].estimatedDoors;
    let expanded = true;

    while (doors < targetDoors && expanded) {
      expanded = false;
      const candidates = [...new Set(group.flatMap(faceNeighbors))]
        .sort((a, b) => faces[b].estimatedDoors - faces[a].estimatedDoors);
      const next = candidates.find((index) => doors + faces[index].estimatedDoors <= targetDoors * 1.25) || candidates[0];
      if (next !== undefined) {
        group.push(next);
        remaining.delete(next);
        doors += faces[next].estimatedDoors;
        expanded = true;
      }
    }
    groups.push(group.map((index) => faces[index]));
  }
  return groups;
}

function getConfigDoorPoints(config = {}) {
  const raw = config.doorPoints || config.propertyPoints || config.properties || config.addressPoints || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((point) => ({
      lat: Number(point?.lat ?? point?.latitude),
      lng: Number(point?.lng ?? point?.lon ?? point?.longitude),
    }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function getDynamicH3Resolution(summary) {
  if (summary.targetZoneAreaSqMi <= 0.25) return 9;
  if (summary.targetZoneAreaSqMi <= 1.5) return 8;
  return 7;
}

function h3CellPolygon(cellId) {
  return normalizePolygon(cellToBoundary(cellId, true).map(([lng, lat]) => ({ lat, lng })));
}

function coordinateKey(point) {
  return `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`;
}

function edgeSignature(a, b) {
  const first = coordinateKey(a);
  const second = coordinateKey(b);
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function mergePartsToOuterParts(parts = []) {
  const edges = new Map();
  parts.filter(isValidPolygon).forEach((part) => {
    const normalized = normalizePolygon(part);
    for (let index = 0; index < normalized.length; index += 1) {
      const start = normalized[index];
      const end = normalized[(index + 1) % normalized.length];
      const signature = edgeSignature(start, end);
      if (edges.has(signature)) edges.delete(signature);
      else edges.set(signature, { start, end, startKey: coordinateKey(start), endKey: coordinateKey(end) });
    }
  });

  const unused = new Map(edges);
  const loops = [];
  while (unused.size) {
    const [firstSignature, firstEdge] = unused.entries().next().value;
    unused.delete(firstSignature);
    const loop = [firstEdge.start, firstEdge.end];
    let currentKey = firstEdge.endKey;
    let guard = 0;

    while (currentKey !== coordinateKey(loop[0]) && guard < edges.size + 5) {
      const nextEntry = [...unused.entries()].find(([, edge]) => edge.startKey === currentKey || edge.endKey === currentKey);
      if (!nextEntry) break;
      const [signature, edge] = nextEntry;
      unused.delete(signature);
      const nextPoint = edge.startKey === currentKey ? edge.end : edge.start;
      loop.push(nextPoint);
      currentKey = coordinateKey(nextPoint);
      guard += 1;
    }

    if (loop.length > 2 && coordinateKey(loop[0]) === coordinateKey(loop[loop.length - 1])) loop.pop();
    const normalized = normalizePolygon(loop);
    if (isValidPolygon(normalized)) loops.push(normalized);
  }

  return loops.length ? loops.sort((a, b) => calculatePolygonAreaSqMi(b) - calculatePolygonAreaSqMi(a)) : parts;
}

function buildDynamicH3Cells(points, config, summary) {
  try {
    const doorPoints = getConfigDoorPoints(config).filter((point) => pointInPolygon(point, points));
    const hasDoorPoints = doorPoints.length > 0;
    const baseResolution = getDynamicH3Resolution(summary);
    const ring = points.map((point) => [point.lng, point.lat]);
    if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);

    let cellIds = [];
    for (let resolution = baseResolution; resolution <= Math.min(10, baseResolution + 1); resolution += 1) {
      cellIds = polygonToCells([ring], resolution, true);
      if (cellIds.length >= Math.min(summary.zoneCount * 2, 24)) break;
    }

    return cellIds.map((cellId) => {
      const hex = h3CellPolygon(cellId);
      const clipped = clipPolygon(points, hex);
      if (!isValidPolygon(clipped)) return null;
      const area = calculatePolygonAreaSqMi(clipped);
      const containedDoors = hasDoorPoints ? doorPoints.filter((point) => pointInPolygon(point, clipped)).length : null;
      const estimatedDoors = hasDoorPoints ? containedDoors : Math.max(1, Math.round(area * summary.density.doorsPerSqMi));
      if (estimatedDoors <= 0) return null;
      return {
        h3Id: cellId,
        geometry: clipped,
        area,
        center: polygonCentroid(clipped),
        estimatedDoors,
      };
    }).filter((cell) => cell?.center);
  } catch (error) {
    console.warn('Dynamic Canvas H3 fallback unavailable:', error);
    return [];
  }
}

function groupDynamicCells(cells, targetDoors) {
  const byId = new Map(cells.map((cell, index) => [cell.h3Id, index]));
  const remaining = new Set(cells.map((_, index) => index));
  const groups = [];

  const distanceToGroup = (candidateIndex, group) => {
    const candidate = cells[candidateIndex].center;
    return Math.min(...group.map((index) => {
      const center = cells[index].center;
      return Math.hypot(candidate.lat - center.lat, candidate.lng - center.lng);
    }));
  };

  const getCandidates = (group) => {
    const neighborIndexes = [...new Set(group.flatMap((index) => {
      try { return gridDisk(cells[index].h3Id, 1).map((id) => byId.get(id)).filter((value) => value !== undefined && remaining.has(value)); }
      catch { return []; }
    }))];
    const candidates = neighborIndexes.length ? neighborIndexes : [...remaining];
    return candidates.sort((a, b) => distanceToGroup(a, group) - distanceToGroup(b, group));
  };

  while (remaining.size) {
    const seed = [...remaining].sort((a, b) => cells[b].estimatedDoors - cells[a].estimatedDoors)[0];
    const group = [seed];
    remaining.delete(seed);
    let doors = cells[seed].estimatedDoors;

    while (remaining.size && doors < targetDoors) {
      const candidates = getCandidates(group);
      const next = candidates.find((index) => doors + cells[index].estimatedDoors <= targetDoors * 1.25) || candidates[0];
      if (next === undefined) break;
      group.push(next);
      remaining.delete(next);
      doors += cells[next].estimatedDoors;
    }
    groups.push(group.map((index) => cells[index]));
  }

  return groups;
}

function zonesFromCellGroups(groups, summary, targetDoors, existingZones = []) {
  return groups.map((group, index) => {
    const existing = existingZones[index] || {};
    const rawParts = group.map((cell) => cell.geometry);
    const parts = mergePartsToOuterParts(rawParts);
    const area = group.reduce((sum, cell) => sum + cell.area, 0);
    const estimatedDoors = group.reduce((sum, cell) => sum + cell.estimatedDoors, 0);
    const center = centroidOfParts(parts) || group[0]?.center || null;
    return {
      ...existing,
      zone_number: index + 1,
      name: existing.name || `Zone ${index + 1}`,
      color: existing.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      geometry: parts[0] || [],
      parts,
      area_sq_mi: Number(area.toFixed(2)),
      estimated_doors: Math.max(1, Math.round(estimatedDoors)),
      target_doors: targetDoors,
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

function generateDynamicCanvasZones(polygon, configOrCount, existingZones = []) {
  const points = normalizePolygon(cleanPolygon(polygon));
  if (points.length < 3) return [];
  const config = typeof configOrCount === 'object' ? configOrCount : { repCount: configOrCount };
  const summary = getCanvasCampaignSummary({ polygon: points, ...config });
  const targetDoors = Math.max(1, Number(config.doorsPerZone || config.targetDoorsPerZone || summary.targetDoorsPerZone));
  const cells = buildDynamicH3Cells(points, config, summary);
  if (cells.length < 2) return [];
  const groups = groupDynamicCells(cells, targetDoors).filter((group) => group.length);
  if (!groups.length) return [];
  return zonesFromCellGroups(groups, summary, targetDoors, existingZones);
}

function generateRoadAlignedZones(polygon, options, roadNetwork) {
  try {
    const points = normalizePolygon(cleanPolygon(polygon));
    if (points.length < 3) return [];
    const config = typeof options === 'object' ? options : { repCount: options };
    const summary = getCanvasCampaignSummary({ polygon: points, ...config });
    const targetDoors = Math.max(1, Number(config.doorsPerZone || config.targetDoorsPerZone || summary.targetDoorsPerZone));
    const { nodes, adjacency } = buildRoadGraph(roadNetwork);
    if (nodes.size < 3 || adjacency.size < 3) return [];

    let faces = findRoadFaces(nodes, adjacency, points, summary.targetZoneAreaSqMi)
      .map((face) => ({
        ...face,
        center: polygonCentroid(face.geometry),
        estimatedDoors: Math.max(1, Math.round(face.area * summary.density.doorsPerSqMi)),
      }))
      .filter((face) => face.center && pointInPolygon(face.center, points));

    if (faces.length < 2) return [];
    if (faces.some((face) => face.estimatedDoors > targetDoors * 3)) return [];
    faces = faces.flatMap((face) => subdivideOversizedFace(face, targetDoors, summary.density));
    if (faces.length < 2) return [];

    const groups = groupRoadFaces(faces, targetDoors).filter((group) => group.length);
    if (!groups.length) return [];

    return groups.map((group, index) => {
      const parts = group.map((cell) => cell.geometry);
      const area = group.reduce((sum, cell) => sum + cell.area, 0);
      const center = centroidOfParts(parts) || group[0]?.center || null;
      return {
        zone_number: index + 1,
        name: `Zone ${index + 1}`,
        color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
        geometry: parts[0] || [],
        parts,
        area_sq_mi: Number(area.toFixed(2)),
        estimated_doors: Math.max(1, Math.round(area * summary.density.doorsPerSqMi)),
        target_doors: targetDoors,
        density_key: summary.density.key,
        density_doors_per_sq_mi: summary.density.doorsPerSqMi,
        drop_point: getDropPoint(parts.flat()),
        center,
        status: 'unworked',
        notes: '',
        assignments: [],
      };
    });
  } catch (error) {
    console.warn('Road-aligned Canvas fallback:', error);
    return [];
  }
}

export function generateCanvasZones(polygon, configOrCount, roadNetwork = null) {
  let points = cleanPolygon(polygon);
  if (points.length > 2 && samePoint(points[0], points[points.length - 1])) points = points.slice(0, -1);
  if (points.length < 3) return [];
  points = normalizePolygon(points);

  const existingZones = Array.isArray(roadNetwork) ? roadNetwork : [];
  const activeRoadNetwork = Array.isArray(roadNetwork) ? null : roadNetwork;
  if (activeRoadNetwork?.elements?.length > 0) {
    const roadZones = generateRoadAlignedZones(points, configOrCount, activeRoadNetwork);
    if (roadZones && roadZones.length > 0) return roadZones;
  }

  const dynamicZones = generateDynamicCanvasZones(points, configOrCount, existingZones);
  if (dynamicZones && dynamicZones.length > 0) return dynamicZones;

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