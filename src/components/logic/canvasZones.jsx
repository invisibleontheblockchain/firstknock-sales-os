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

function haversineMiles(a, b) {
  if (!a || !b) return Infinity;
  const radius = 3958.8;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function distancePointToSegment(point, a, b) {
  const avgLat = (point.lat + a.lat + b.lat) / 3;
  const { latScale, lngScale } = getScales(avgLat);
  const px = point.lng * lngScale;
  const py = point.lat * latScale;
  const ax = a.lng * lngScale;
  const ay = a.lat * latScale;
  const bx = b.lng * lngScale;
  const by = b.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointOnPolygonBoundary(point, polygon = []) {
  if (!point || polygon.length < 3) return false;
  return polygon.some((current, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return distancePointToSegment(point, current, next) < 0.00003;
  });
}

function bearingDegrees(from, to) {
  const scale = Math.cos(((from.lat + to.lat) / 2) * Math.PI / 180) || 1;
  return (Math.atan2((to.lng - from.lng) * scale, to.lat - from.lat) * 180 / Math.PI + 360) % 360;
}

function clockwiseRelativeAngle(departureBearing, reverseArrivalBearing) {
  return (departureBearing - reverseArrivalBearing + 360) % 360;
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
      rawNodes.set(element.id, { lat: Number(element.lat), lng: Number(element.lon), id: element.id });
    }
  });

  (roadNetwork?.elements || []).forEach((element) => {
    if (element.type !== 'way' || !allowed.has(element.tags?.highway) || !Array.isArray(element.nodes) || element.nodes.length < 2) return;
    if (element.nodes.some((id) => !rawNodes.has(id))) {
      console.warn('[FK] Skipping malformed OSM way with missing node refs:', element.id);
      return;
    }
    ways.push(element.nodes);
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
    ways,
    adjacency: new Map([...adjacency.entries()].map(([id, neighbors]) => [id, [...neighbors]])),
  };
}

function buildClockwiseNextMap(nodes, adjacency) {
  const halfEdges = [];
  adjacency.forEach((neighbors, fromId) => {
    neighbors.forEach((toId) => {
      const from = nodes.get(fromId);
      const to = nodes.get(toId);
      if (!from || !to) return;
      halfEdges.push({ fromId, toId, key: directedEdgeKey(fromId, toId), bearing: bearingDegrees(from, to) });
    });
  });

  const nextMap = new Map();
  halfEdges.forEach((edge) => {
    const incomingBearing = edge.bearing;
    const reverseArrivalBearing = (incomingBearing + 180) % 360;
    const outgoing = (adjacency.get(edge.toId) || [])
      .map((targetId) => {
        const from = nodes.get(edge.toId);
        const to = nodes.get(targetId);
        return from && to ? {
          fromId: edge.toId,
          toId: targetId,
          key: directedEdgeKey(edge.toId, targetId),
          delta: clockwiseRelativeAngle(bearingDegrees(from, to), reverseArrivalBearing),
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.delta - b.delta);
    if (outgoing.length) nextMap.set(edge.key, outgoing[0]);
  });

  return { halfEdges, nextMap };
}

function findRoadFaces(nodes, adjacency, managerPolygon, targetZoneAreaSqMi) {
  const { halfEdges, nextMap } = buildClockwiseNextMap(nodes, adjacency);
  const visited = new Set();
  const facesByKey = new Map();
  const maxSteps = Math.max(50, halfEdges.length + 5);

  halfEdges.forEach((startEdge) => {
    if (visited.has(startEdge.key)) return;
    const traversed = [];
    const faceIds = [];
    let current = startEdge;

    for (let step = 0; step < maxSteps; step += 1) {
      if (!current || traversed.includes(current.key)) break;
      traversed.push(current.key);
      faceIds.push(current.fromId);
      current = nextMap.get(current.key);
      if (current?.key === startEdge.key) break;
    }

    if (current?.key !== startEdge.key || faceIds.length < 3) return;
    traversed.forEach((key) => visited.add(key));

    const key = canonicalFaceKey(faceIds);
    if (facesByKey.has(key)) return;

    const fullGeometry = normalizePolygon(faceIds.map((id) => nodes.get(id)).filter(Boolean));
    if (!isValidPolygon(fullGeometry)) return;
    const fullArea = calculatePolygonAreaSqMi(fullGeometry);
    if (fullArea <= 0.000001) return;

    facesByKey.set(key, {
      ids: faceIds,
      fullGeometry,
      fullArea,
      edgeKeys: faceIds.map((id, index) => edgeKey(id, faceIds[(index + 1) % faceIds.length])),
    });
  });

  let faces = [...facesByKey.values()].sort((a, b) => b.fullArea - a.fullArea);
  if (faces.length > 1) faces = faces.slice(1);

  const maxFaceArea = Math.max(0.0001, targetZoneAreaSqMi * 3);
  faces = faces
    .filter((face) => face.fullArea <= maxFaceArea && polygonIntersectsPolygon(face.fullGeometry, managerPolygon))
    .map((face) => {
      const clipped = clipPolygon(face.fullGeometry, managerPolygon);
      if (!isValidPolygon(clipped)) return null;
      return {
        ...face,
        geometry: clipped,
        area: calculatePolygonAreaSqMi(clipped),
      };
    })
    .filter((face) => face?.area > 0.000001);

  const usage = new Map();
  faces.forEach((face) => face.edgeKeys.forEach((key) => usage.set(key, (usage.get(key) || 0) + 1)));
  let incompleteSegment = null;
  adjacency.forEach((neighbors, a) => {
    if (incompleteSegment) return;
    neighbors.forEach((b) => {
      if (incompleteSegment || String(a) > String(b)) return;
      const first = nodes.get(a);
      const second = nodes.get(b);
      if (!first || !second) return;
      const midpoint = { lat: (first.lat + second.lat) / 2, lng: (first.lng + second.lng) / 2 };
      if (!pointInPolygon(midpoint, managerPolygon)) return;
      if ((usage.get(edgeKey(a, b)) || 0) === 1) incompleteSegment = [a, b];
    });
  });

  if (incompleteSegment) {
    console.warn(`[FK] Face traversal incomplete — segment [${incompleteSegment[0]},${incompleteSegment[1]}] in only one face`);
    return [];
  }

  return faces.length >= 2 ? faces : [];
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

function densityKeyForFace(face, doors) {
  const km2 = Math.max(0.000001, (face.area || face.fullArea || 0) * 2.58999);
  const doorsPerKm2 = doors / km2;
  if (doorsPerKm2 > 200) return 'urban';
  if (doorsPerKm2 >= 80) return 'suburban';
  return 'rural';
}

function assignDoorsToFaces(faces, doorPoints, fallbackDensity) {
  if (!doorPoints.length) {
    return faces.map((face) => {
      const estimatedDoors = Math.max(1, Math.round(face.area * fallbackDensity.doorsPerSqMi));
      return { ...face, estimatedDoors, densityKey: densityKeyForFace(face, estimatedDoors) };
    });
  }

  const counts = new Array(faces.length).fill(0);
  doorPoints.forEach((door) => {
    const matches = faces
      .map((face, index) => ({ face, index }))
      .filter(({ face }) => pointInPolygon(door, face.geometry) || pointOnPolygonBoundary(door, face.geometry));
    if (!matches.length) return;
    const selected = matches.length === 1 ? matches[0] : matches.reduce((best, candidate) => {
      const bestDistance = haversineMiles(door, best.face.center);
      const candidateDistance = haversineMiles(door, candidate.face.center);
      return candidateDistance < bestDistance ? candidate : best;
    }, matches[0]);
    counts[selected.index] += 1;
  });

  return faces.map((face, index) => {
    const estimatedDoors = counts[index] || Math.max(1, Math.round(face.area * fallbackDensity.doorsPerSqMi));
    return { ...face, estimatedDoors, densityKey: densityKeyForFace(face, estimatedDoors) };
  });
}

function subdivideOversizedFace(face, targetDoors, density, doorPoints = []) {
  if (face.estimatedDoors <= targetDoors * 2) return [face];
  let cells = [{ geometry: face.geometry, area: face.area, fullArea: face.fullArea || face.area, center: polygonCentroid(face.geometry) }];
  let guard = 0;

  while (cells.some((cell) => Math.round(cell.area * density.doorsPerSqMi) > targetDoors) && guard < 20) {
    const largestIndex = cells.reduce((best, cell, index) => cell.area > cells[best].area ? index : best, 0);
    const pieces = splitCell(cells[largestIndex]);
    if (pieces.length < 2) break;
    cells.splice(largestIndex, 1, ...pieces.map((piece) => ({ ...piece, fullArea: piece.area, center: polygonCentroid(piece.geometry) })));
    guard += 1;
  }

  return cells.map((cell, index) => {
    const actualDoors = doorPoints.length ? doorPoints.filter((point) => pointInPolygon(point, cell.geometry) || pointOnPolygonBoundary(point, cell.geometry)).length : null;
    const estimatedDoors = actualDoors ?? Math.max(1, Math.round(cell.area * density.doorsPerSqMi));
    return {
      ...cell,
      estimatedDoors,
      densityKey: densityKeyForFace(cell, estimatedDoors),
      edgeKeys: [`${face.edgeKeys.join('|')}:split:${index}`],
    };
  });
}

function groupRoadFaces(faces, targetDoors) {
  const remaining = new Set(faces.map((_, index) => index));
  const edgeOwners = new Map();
  faces.forEach((face, index) => face.edgeKeys.forEach((key) => edgeOwners.set(key, [...(edgeOwners.get(key) || []), index])));
  const groups = [];

  const faceNeighbors = (group) => [...new Set(group.flatMap((index) => faces[index].edgeKeys.flatMap((key) => edgeOwners.get(key) || [])))]
    .filter((neighbor) => !group.includes(neighbor) && remaining.has(neighbor))
    .sort((a, b) => faces[b].estimatedDoors - faces[a].estimatedDoors);

  while (remaining.size) {
    const seed = [...remaining].sort((a, b) => faces[b].estimatedDoors - faces[a].estimatedDoors)[0];
    const group = [seed];
    remaining.delete(seed);
    let doors = faces[seed].estimatedDoors;
    const zoneTargetDoors = faces[seed].densityKey === 'rural' ? targetDoors * 1.5 : targetDoors;

    while (doors < zoneTargetDoors) {
      const candidates = faceNeighbors(group);
      if (!candidates.length) break;
      const next = candidates.find((index) => doors + faces[index].estimatedDoors <= zoneTargetDoors * 1.25) || candidates[0];
      if (next === undefined) break;
      group.push(next);
      remaining.delete(next);
      doors += faces[next].estimatedDoors;
    }

    groups.push(group.map((index) => faces[index]));
  }

  return groups;
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

function buildDensityGrid(points, doorPoints, summary) {
  const bounds = getBounds(points);
  const latStep = (bounds.maxLat - bounds.minLat) / 8 || 0.001;
  const lngStep = (bounds.maxLng - bounds.minLng) / 8 || 0.001;
  const grid = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const cell = normalizePolygon([
        { lat: bounds.maxLat - row * latStep, lng: bounds.minLng + col * lngStep },
        { lat: bounds.maxLat - row * latStep, lng: bounds.minLng + (col + 1) * lngStep },
        { lat: bounds.maxLat - (row + 1) * latStep, lng: bounds.minLng + (col + 1) * lngStep },
        { lat: bounds.maxLat - (row + 1) * latStep, lng: bounds.minLng + col * lngStep },
      ]);
      const clipped = clipPolygon(points, cell);
      if (!isValidPolygon(clipped)) continue;
      const areaSqMi = calculatePolygonAreaSqMi(clipped);
      const doors = doorPoints.length ? doorPoints.filter((point) => pointInPolygon(point, clipped)).length : Math.round(areaSqMi * summary.density.doorsPerSqMi);
      const km2 = areaSqMi * 2.58999;
      const doorsPerKm2 = km2 > 0 ? doors / km2 : summary.density.doorsPerSqMi / 2.58999;
      const densityKey = doorsPerKm2 > 200 ? 'urban' : doorsPerKm2 >= 80 ? 'suburban' : 'rural';
      grid.push({ geometry: clipped, center: polygonCentroid(clipped), densityKey });
    }
  }
  return grid;
}

function getLocalDensityKey(point, grid, fallbackKey) {
  return grid.find((cell) => pointInPolygon(point, cell.geometry))?.densityKey || fallbackKey;
}

function doorsPerSqMiForDensity(key, fallback) {
  if (key === 'urban') return DENSITY_TIERS.urban.doorsPerSqMi;
  if (key === 'suburban') return DENSITY_TIERS.suburban.doorsPerSqMi;
  if (key === 'rural') return DENSITY_TIERS.rural.doorsPerSqMi;
  return fallback;
}

function buildDynamicH3Cells(points, config, summary) {
  try {
    const doorPoints = getConfigDoorPoints(config).filter((point) => pointInPolygon(point, points));
    const hasDoorPoints = doorPoints.length > 0;
    const densityGrid = buildDensityGrid(points, doorPoints, summary);
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
      const center = polygonCentroid(clipped);
      if (!center) return null;
      const densityKey = getLocalDensityKey(center, densityGrid, summary.density.key);
      const localDoorsPerSqMi = doorsPerSqMiForDensity(densityKey, summary.density.doorsPerSqMi);
      const containedDoors = hasDoorPoints ? doorPoints.filter((point) => pointInPolygon(point, clipped) || pointOnPolygonBoundary(point, clipped)).length : null;
      const estimatedDoors = hasDoorPoints ? containedDoors : Math.max(1, Math.round(area * localDoorsPerSqMi));
      if (estimatedDoors <= 0) return null;
      return {
        h3Id: cellId,
        geometry: clipped,
        fullArea: calculatePolygonAreaSqMi(hex),
        area,
        center,
        estimatedDoors,
        densityKey,
      };
    }).filter(Boolean);
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
    return Math.min(...group.map((index) => haversineMiles(candidate, cells[index].center)));
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

function buildZoneFromGroup(group, summary, targetDoors, index, existing = {}) {
  const rawParts = group.map((cell) => cell.geometry);
  const parts = mergePartsToOuterParts(rawParts);
  const area = group.reduce((sum, cell) => sum + cell.area, 0);
  const fullArea = group.reduce((sum, cell) => sum + (cell.fullArea || cell.area), 0);
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
    drop_point: center || getDropPoint(parts.flat()),
    center,
    status: existing.status || 'unworked',
    notes: existing.notes || '',
    assignments: existing.assignments || [],
    __clipRatio: fullArea > 0 ? area / fullArea : 1,
  };
}

function zonesFromCellGroups(groups, summary, targetDoors, existingZones = []) {
  return groups.map((group, index) => buildZoneFromGroup(group, summary, targetDoors, index, existingZones[index] || {}));
}

function stripPrivateZoneFields(zone) {
  const { __clipRatio, ...clean } = zone;
  return clean;
}

function zonesShareBoundary(a, b) {
  const aEdges = new Set((a.parts || [a.geometry]).flatMap((part) => normalizePolygon(part).map((point, index, arr) => edgeSignature(point, arr[(index + 1) % arr.length]))));
  return (b.parts || [b.geometry]).some((part) => normalizePolygon(part).some((point, index, arr) => aEdges.has(edgeSignature(point, arr[(index + 1) % arr.length]))));
}

function mergeClippedBoundaryZones(zones = []) {
  const working = zones.map((zone) => ({ ...zone, parts: zone.parts || [zone.geometry].filter(Boolean) }));
  for (let index = working.length - 1; index >= 0; index -= 1) {
    const zone = working[index];
    if ((zone.__clipRatio ?? 1) >= 0.6 || working.length < 2) continue;
    const candidates = working
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidateIndex }) => candidateIndex !== index);
    const adjacent = candidates.filter(({ candidate }) => zonesShareBoundary(zone, candidate));
    const pool = adjacent.length ? adjacent : candidates;
    const target = pool.sort((a, b) => {
      const doorDiff = (a.candidate.estimated_doors || 0) - (b.candidate.estimated_doors || 0);
      if (doorDiff !== 0) return doorDiff;
      return haversineMiles(zone.center, a.candidate.center) - haversineMiles(zone.center, b.candidate.center);
    })[0];
    if (!target) continue;
    const mergedParts = mergePartsToOuterParts([...(target.candidate.parts || []), ...(zone.parts || [])]);
    const mergedArea = (target.candidate.area_sq_mi || 0) + (zone.area_sq_mi || 0);
    const mergedCenter = centroidOfParts(mergedParts) || target.candidate.center;
    working[target.candidateIndex] = {
      ...target.candidate,
      geometry: mergedParts[0] || target.candidate.geometry,
      parts: mergedParts,
      area_sq_mi: Number(mergedArea.toFixed(2)),
      estimated_doors: Math.max(1, Math.round((target.candidate.estimated_doors || 0) + (zone.estimated_doors || 0))),
      center: mergedCenter,
      drop_point: mergedCenter || target.candidate.drop_point,
      __clipRatio: Math.max(target.candidate.__clipRatio ?? 1, zone.__clipRatio ?? 1),
    };
    working.splice(index, 1);
  }
  return working.map((zone, index) => ({
    ...zone,
    zone_number: index + 1,
    name: `Zone ${index + 1}`,
    color: zone.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
  }));
}

function getRoadNodes(roadNetwork) {
  const allowed = new Set(['primary', 'secondary', 'tertiary', 'residential']);
  const nodeMap = new Map();
  (roadNetwork?.elements || []).forEach((element) => {
    if (element.type === 'node' && Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
      nodeMap.set(element.id, { lat: Number(element.lat), lng: Number(element.lon) });
    }
  });
  const allowedIds = new Set();
  (roadNetwork?.elements || []).forEach((element) => {
    if (element.type === 'way' && allowed.has(element.tags?.highway) && Array.isArray(element.nodes) && element.nodes.every((id) => nodeMap.has(id))) {
      element.nodes.forEach((id) => allowedIds.add(id));
    }
  });
  return [...allowedIds].map((id) => nodeMap.get(id)).filter(Boolean);
}

function snapDropPointsToRoad(zones, roadNetwork) {
  const roadNodes = getRoadNodes(roadNetwork);
  if (!roadNodes.length) return zones.map(stripPrivateZoneFields);
  return zones.map((zone) => {
    const origin = centroidOfParts(zone.parts || [zone.geometry]) || zone.center || zone.drop_point;
    const nearest = roadNodes.reduce((best, node) => haversineMiles(origin, node) < haversineMiles(origin, best) ? node : best, roadNodes[0]);
    return stripPrivateZoneFields({ ...zone, center: origin || zone.center, drop_point: nearest || zone.drop_point });
  });
}

function warnDuplicateRepAssignments(zones = [], options = {}) {
  const repCount = Math.max(1, Number(options.repCount) || 1);
  const maxZonesPerRep = Math.ceil((zones.length || 1) / repCount);
  const counts = new Map();
  zones.forEach((zone) => (zone.assignments || []).filter(Boolean).forEach((name) => counts.set(name, (counts.get(name) || 0) + 1)));
  counts.forEach((count, name) => {
    if (count > maxZonesPerRep) console.warn(`[FK] ${name} assigned to ${count} zones — check workload`);
  });
}

function runPostProcessing(zones, roadNetwork, options = {}) {
  const cleaned = mergeClippedBoundaryZones(zones);
  warnDuplicateRepAssignments(cleaned, options);
  return snapDropPointsToRoad(cleaned, roadNetwork);
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

function generateHexZones(polygon, configOrCount, existingZones = []) {
  const points = normalizePolygon(cleanPolygon(polygon));
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
      cells.push({ geometry: clipped, fullArea: calculatePolygonAreaSqMi(rectangle), area, center: polygonCentroid(clipped), estimatedDoors: Math.max(1, Math.round(area * summary.density.doorsPerSqMi)) });
    }
  }

  while (cells.some((cell) => cell.area > summary.targetZoneAreaSqMi * 0.75) || cells.length < summary.zoneCount) {
    const largestIndex = cells.reduce((bestIndex, cell, index) => cell.area > cells[bestIndex].area ? index : bestIndex, 0);
    const pieces = splitCell(cells[largestIndex]);
    if (pieces.length < 2) break;
    cells.splice(largestIndex, 1, ...pieces.map((piece) => ({ ...piece, fullArea: piece.area, center: polygonCentroid(piece.geometry), estimatedDoors: Math.max(1, Math.round(piece.area * summary.density.doorsPerSqMi)) })));
  }

  const groupedCells = groupCells(cells, summary.zoneCount, summary.targetZoneAreaSqMi);
  return groupedCells.map((group, index) => buildZoneFromGroup(group, summary, summary.targetDoorsPerZone, index, existingZones[index] || {}));
}

function generateRoadAlignedZones(polygon, options, roadNetwork, existingZones = []) {
  const points = normalizePolygon(cleanPolygon(polygon));
  if (points.length < 3) return [];
  const config = typeof options === 'object' ? options : { repCount: options };
  const summary = getCanvasCampaignSummary({ polygon: points, ...config });
  const targetDoors = Math.max(1, Number(config.doorsPerZone || config.targetDoorsPerZone || summary.targetDoorsPerZone));
  const { nodes, adjacency } = buildRoadGraph(roadNetwork);
  if (nodes.size < 3 || adjacency.size < 3) return [];

  const doorPoints = getConfigDoorPoints(config).filter((point) => pointInPolygon(point, points));
  let faces = findRoadFaces(nodes, adjacency, points, summary.targetZoneAreaSqMi)
    .map((face) => ({ ...face, center: polygonCentroid(face.geometry) }))
    .filter((face) => face.center && pointInPolygon(face.center, points));

  if (faces.length < 2) return [];
  faces = assignDoorsToFaces(faces, doorPoints, summary.density);
  faces = faces.flatMap((face) => subdivideOversizedFace(face, targetDoors, summary.density, doorPoints));
  if (faces.length < 2) return [];

  const groups = groupRoadFaces(faces, targetDoors).filter((group) => group.length);
  if (!groups.length) return [];

  return groups.map((group, index) => buildZoneFromGroup(group, summary, targetDoors, index, existingZones[index] || {}));
}

function parseGenerationArgs(thirdArg, fourthArg, configOrCount) {
  const config = typeof configOrCount === 'object' && configOrCount ? configOrCount : {};
  const values = [thirdArg, fourthArg, config.roadNetwork, config.road_network];
  const roadNetwork = values.find((value) => value?.elements?.length > 0) || null;
  const existingZones = values.find((value) => Array.isArray(value)) || [];
  return { roadNetwork, existingZones };
}

export function generateCanvasZones(polygon, options, roadNetwork = null, existingZonesArg = null) {
  let points = cleanPolygon(polygon);
  if (points.length > 2 && samePoint(points[0], points[points.length - 1])) points = points.slice(0, -1);
  if (points.length < 3) return [];
  points = normalizePolygon(points);

  const { roadNetwork: activeRoadNetwork, existingZones } = parseGenerationArgs(roadNetwork, existingZonesArg, options);
  if (activeRoadNetwork?.elements?.length > 0) {
    try {
      const zones = generateRoadAlignedZones(points, options, activeRoadNetwork, existingZones);
      if (zones && zones.length >= 2) return runPostProcessing(zones, activeRoadNetwork, options);
    } catch (error) {
      console.warn('[FK] Road-aligned generation failed, falling back to hex:', error);
    }
  } else {
    console.warn('[FK] No road data — falling back to hex generation');
  }

  try {
    return runPostProcessing(generateHexZones(points, options, existingZones), null, options);
  } catch (error) {
    console.warn('[FK] Hex generation failed:', error);
    return [];
  }
}