import { buildCanvasStreetWorkUnits } from './canvasStreetTopology.js';
import { polygon as geoJsonPolygon } from 'turf-helpers';
import intersectPolygons from 'turf-intersect';

const ALGORITHM_VERSION = 'canvas_street_workload_v3';
const MAX_CANVAS_ZONE_COUNT = 250;
const MAX_CANVAS_INTERACTIVE_WORK_UNITS = 20_000;
const MAX_CANVAS_INTERACTIVE_COMPLEXITY = 5_000_000;
const MAX_CANVAS_INTERACTIVE_SEGMENTS = 50_000;
const MAX_DISPLAY_CORRIDOR_WORK_UNITS = 2_000;
const ZONE_COLORS = ['#A855F7', '#2563EB', '#059669', '#D97706', '#DC2626', '#0891B2', '#7C3AED', '#DB2777'];
const OPTIONAL_CANDIDATE_FAILURES = new Set([
  'INVALID_CANDIDATE_INPUT',
  'INVALID_CANDIDATE_IDENTITIES',
  'CANDIDATES_OUTSIDE_POLYGON',
  'UNSNAPPED_CANDIDATES',
  'AMBIGUOUS_CANDIDATE_SNAPS',
]);

function compareIds(left, right) {
  return String(left).localeCompare(String(right), 'en', { numeric: true });
}

function stableHash(value) {
  let first = 2166136261;
  let second = 2246822507;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489909);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function failure(status, code, message, details = {}) {
  return {
    ok: false,
    status,
    deployable: false,
    code,
    message,
    details,
    planning_method: 'street_workload',
    assignment_basis: 'street_work_unit_ids',
    ownership_geometry: 'clipped_street_segments',
    method: 'street_workload',
    algorithm_version: ALGORITHM_VERSION,
    zones: [],
    work_units: [],
    door_candidates: [],
    doors: [],
    qa: {
      deployable: false,
      street_coverage_complete: false,
      exclusive_work_unit_coverage: false,
      coverage_complete: false,
      no_duplicate_work_units: false,
      connected_zones: false,
      atomic_work_units: false,
      cul_de_sac_splits: 0,
      protected_units_intact: false,
      display_geometry_complete: false,
      data_quality_status: 'unverified',
      warnings: [message],
    },
  };
}

function normalizeBoundary(input = []) {
  if (!Array.isArray(input)) return [];
  const points = input.map((point) => {
    const lat = Number(point?.lat ?? point?.latitude ?? point?.[0]);
    const lng = Number(point?.lng ?? point?.lon ?? point?.longitude ?? point?.[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }).filter(Boolean);
  if (points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first.lat === last.lat && first.lng === last.lng) points.pop();
  }
  return points;
}

function normalizeCandidates(input = {}) {
  const raw = input.door_candidates
    ?? input.estimated_door_candidates
    ?? input.opportunities
    ?? input.doors
    ?? [];
  if (!Array.isArray(raw)) {
    return {
      candidates: [],
      warnings: ['Optional door estimates were ignored because they were not supplied as an array.'],
    };
  }
  const warnings = [];
  const normalized = [];
  let invalidCount = 0;
  raw.forEach((candidate) => {
    const lat = Number(candidate?.lat ?? candidate?.latitude);
    const lng = Number(candidate?.lng ?? candidate?.lon ?? candidate?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      invalidCount += 1;
      return;
    }
    const explicitId = String(candidate?.candidate_id
      ?? candidate?.id
      ?? candidate?.stable_door_id
      ?? candidate?.stable_id
      ?? candidate?.address_hash
      ?? candidate?.property_id
      ?? '').trim();
    const id = explicitId || `estimate:${stableHash(`${lat.toFixed(7)}:${lng.toFixed(7)}`)}`;
    const rawWeight = Number(candidate?.weight ?? candidate?.estimated_doors ?? 1);
    normalized.push({
      ...candidate,
      id,
      candidate_id: id,
      lat,
      lng,
      weight: Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 1,
    });
  });
  if (invalidCount) warnings.push(`${invalidCount} invalid optional door estimate${invalidCount === 1 ? ' was' : 's were'} ignored.`);
  normalized.sort((left, right) => compareIds(left.id, right.id)
    || left.lat - right.lat
    || left.lng - right.lng);
  const deduplicated = [];
  const seen = new Set();
  let duplicateCount = 0;
  normalized.forEach((candidate) => {
    if (seen.has(candidate.id)) {
      duplicateCount += 1;
      return;
    }
    seen.add(candidate.id);
    deduplicated.push(candidate);
  });
  if (duplicateCount) warnings.push(`${duplicateCount} duplicate optional door estimate${duplicateCount === 1 ? ' was' : 's were'} ignored.`);
  return { candidates: deduplicated, warnings };
}

function closedCoordinateRing(points = []) {
  const coordinates = points.map((point) => [Number(point.lng), Number(point.lat)]);
  if (!coordinates.length) return coordinates;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first]);
  return coordinates;
}

function clippedPolygonParts(points, boundary) {
  if (!Array.isArray(points) || points.length < 3) return [];
  if (!Array.isArray(boundary) || boundary.length < 3) return [points];
  try {
    const intersection = intersectPolygons(
      geoJsonPolygon([closedCoordinateRing(points)]),
      geoJsonPolygon([closedCoordinateRing(boundary)]),
    );
    if (!intersection?.geometry) return [];
    const polygons = intersection.geometry.type === 'Polygon'
      ? [intersection.geometry.coordinates]
      : intersection.geometry.type === 'MultiPolygon'
        ? intersection.geometry.coordinates
        : [];
    return polygons.map((polygon) => (polygon?.[0] || []).slice(0, -1).map(([lng, lat]) => ({ lat, lng })))
      .filter((part) => part.length >= 3);
  } catch {
    return [];
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function selectedRepIds(input = {}) {
  const raw = input.selected_team_member_ids ?? input.selectedRepIds ?? [];
  return [...new Set((Array.isArray(raw) ? raw : []).map(String).filter(Boolean))].sort(compareIds);
}

function resolveZoneRequest(input, totalStreetWorkloadMeters, reps) {
  const explicitRaw = input.area_count
    ?? input.requested_zone_count
    ?? input.zone_count
    ?? input.zoneCount;
  if (explicitRaw !== undefined && explicitRaw !== null && explicitRaw !== '') {
    const explicit = Number(explicitRaw);
    if (!Number.isInteger(explicit) || explicit <= 0) {
      return { error: failure('blocked', 'INVALID_AREA_COUNT', 'Area count must be a positive whole number.') };
    }
    if (reps.length && explicit !== reps.length) {
      return {
        error: failure(
          'blocked',
          'AREA_COUNT_REP_MISMATCH',
          `Selected-rep plans require exactly ${reps.length} areas, one for each selected rep.`,
          { selected_rep_count: reps.length, requested_area_count: explicit },
        ),
      };
    }
    return { zoneCount: explicit, divisionMode: reps.length ? 'selected_reps' : 'area_count' };
  }
  if (reps.length) return { zoneCount: reps.length, divisionMode: 'selected_reps' };

  const targetRaw = input.target_street_workload_meters_per_area
    ?? input.target_workload_meters_per_area
    ?? input.target_workload
    ?? input.target_street_length_meters_per_area;
  if (targetRaw !== undefined && targetRaw !== null && targetRaw !== '') {
    const target = Number(targetRaw);
    if (!Number.isFinite(target) || target <= 0) {
      return { error: failure('blocked', 'INVALID_STREET_WORKLOAD_TARGET', 'Street workload target must be a positive number of meters.') };
    }
    return {
      zoneCount: Math.max(1, Math.ceil(totalStreetWorkloadMeters / target)),
      divisionMode: 'street_workload_target',
      targetStreetWorkloadMeters: target,
    };
  }
  return { zoneCount: 1, divisionMode: 'area_count' };
}

function decorateWorkUnits(workUnits, candidateById, candidateEquivalentMeters) {
  return workUnits.map((unit) => {
    const estimatedDoorWeight = (unit.candidateIds || [])
      .reduce((sum, candidateId) => sum + Number(candidateById.get(candidateId)?.weight || 0), 0);
    const classWeightedLengthMeters = Number(unit.classWeightedLengthMeters ?? unit.streetLengthMeters ?? 0);
    return {
      ...unit,
      estimatedDoorWeight: Number(estimatedDoorWeight.toFixed(2)),
      workloadScore: Number((classWeightedLengthMeters + estimatedDoorWeight * candidateEquivalentMeters).toFixed(2)),
    };
  });
}

function unitComponents(units) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const unseen = new Set(byId.keys());
  const orderedIds = [...byId.keys()].sort(compareIds);
  let seedIndex = 0;
  const components = [];
  while (unseen.size) {
    while (seedIndex < orderedIds.length && !unseen.has(orderedIds[seedIndex])) seedIndex += 1;
    const seed = orderedIds[seedIndex];
    seedIndex += 1;
    const queue = [seed];
    const ids = [];
    unseen.delete(seed);
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const unitId = queue[queueIndex];
      ids.push(unitId);
      (byId.get(unitId)?.neighborIds || []).forEach((neighborId) => {
        if (!unseen.has(neighborId)) return;
        unseen.delete(neighborId);
        queue.push(neighborId);
      });
    }
    const sortedIds = ids.sort(compareIds);
    components.push({
      ids: sortedIds,
      unitCount: sortedIds.length,
      workloadScore: sortedIds.reduce((sum, id) => sum + Number(byId.get(id)?.workloadScore || 0), 0),
      streetLengthMeters: sortedIds.reduce((sum, id) => sum + Number(byId.get(id)?.streetLengthMeters || 0), 0),
      classWeightedLengthMeters: sortedIds.reduce((sum, id) => sum + Number(byId.get(id)?.classWeightedLengthMeters || 0), 0),
      estimatedDoorWeight: sortedIds.reduce((sum, id) => sum + Number(byId.get(id)?.estimatedDoorWeight || 0), 0),
    });
  }
  return components.sort((left, right) => compareIds(left.ids[0], right.ids[0]));
}

function allocateComponentZoneCounts(components, totalZoneCount) {
  const allocation = components.map(() => 1);
  let remaining = totalZoneCount - allocation.length;
  while (remaining > 0) {
    const candidates = components.map((component, index) => ({
      index,
      capacity: component.unitCount - allocation[index],
      pressure: component.workloadScore / allocation[index],
      firstId: component.ids[0],
    })).filter((candidate) => candidate.capacity > 0)
      .sort((left, right) => right.pressure - left.pressure || compareIds(left.firstId, right.firstId));
    if (!candidates.length) return null;
    allocation[candidates[0].index] += 1;
    remaining -= 1;
  }
  return allocation;
}

function shortestDistances(seedId, allowedIds, byId) {
  const allowed = new Set(allowedIds);
  const distances = new Map([[seedId, 0]]);
  const queue = [seedId];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const unitId = queue[queueIndex];
    const distance = distances.get(unitId);
    (byId.get(unitId)?.neighborIds || []).filter((id) => allowed.has(id)).sort(compareIds).forEach((neighborId) => {
      if (distances.has(neighborId)) return;
      distances.set(neighborId, distance + 1);
      queue.push(neighborId);
    });
  }
  return distances;
}

function chooseSeeds(componentIds, count, byId) {
  const candidates = [...componentIds].sort(compareIds);
  const first = [...candidates].sort((left, right) =>
    Number(byId.get(right)?.workloadScore || 0) - Number(byId.get(left)?.workloadScore || 0)
      || compareIds(left, right))[0];
  const seeds = [first];
  const firstDistances = shortestDistances(first, componentIds, byId);
  const nearestSeedDistance = new Map(candidates.map((id) => [id, firstDistances.get(id) ?? Number.MAX_SAFE_INTEGER]));
  const seedSet = new Set(seeds);
  while (seeds.length < count) {
    const ranked = candidates.filter((id) => !seedSet.has(id)).map((id) => ({
      id,
      distance: nearestSeedDistance.get(id) ?? Number.MAX_SAFE_INTEGER,
      workload: Number(byId.get(id)?.workloadScore || 0),
    })).sort((left, right) => right.distance - left.distance
      || right.workload - left.workload
      || compareIds(left.id, right.id));
    if (!ranked.length) break;
    const nextSeed = ranked[0].id;
    seeds.push(nextSeed);
    seedSet.add(nextSeed);
    const distances = shortestDistances(nextSeed, componentIds, byId);
    candidates.forEach((id) => {
      nearestSeedDistance.set(id, Math.min(
        nearestSeedDistance.get(id) ?? Number.MAX_SAFE_INTEGER,
        distances.get(id) ?? Number.MAX_SAFE_INTEGER,
      ));
    });
  }
  return seeds;
}

function compareFrontierEntry(left, right) {
  return left.distance - right.distance || compareIds(left.unitId, right.unitId);
}

function heapPush(heap, value) {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareFrontierEntry(heap[parent], value) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
}

function heapPop(heap) {
  if (!heap.length) return null;
  const first = heap[0];
  const last = heap.pop();
  if (heap.length && last) {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= heap.length) break;
      const child = right < heap.length && compareFrontierEntry(heap[right], heap[left]) < 0 ? right : left;
      if (compareFrontierEntry(last, heap[child]) <= 0) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  }
  return first;
}

function discardAssignedFrontierEntries(zone, unassigned) {
  while (zone.frontier.length && !unassigned.has(zone.frontier[0].unitId)) heapPop(zone.frontier);
  return zone.frontier[0] || null;
}

function enqueueZoneFrontier(zone, unitId, unassigned, byId, seedDistances) {
  (byId.get(unitId)?.neighborIds || []).forEach((neighborId) => {
    if (!unassigned.has(neighborId) || zone.frontierQueued.has(neighborId)) return;
    zone.frontierQueued.add(neighborId);
    heapPush(zone.frontier, {
      unitId: neighborId,
      distance: seedDistances.get(neighborId) ?? Number.MAX_SAFE_INTEGER,
    });
  });
}

function takeBestFrontierEntry(zone, unassigned, byId, target) {
  discardAssignedFrontierEntries(zone, unassigned);
  const nearestDistance = zone.frontier[0]?.distance;
  if (!Number.isFinite(nearestDistance)) return null;
  const candidates = [];
  while (zone.frontier.length && candidates.length < 24) {
    const next = zone.frontier[0];
    if (next.distance !== nearestDistance) break;
    const candidate = heapPop(zone.frontier);
    if (candidate && unassigned.has(candidate.unitId)) candidates.push(candidate);
  }
  if (!candidates.length) return takeBestFrontierEntry(zone, unassigned, byId, target);
  candidates.sort((left, right) => {
    const leftUnit = byId.get(left.unitId);
    const rightUnit = byId.get(right.unitId);
    const leftWorkload = Number(leftUnit?.workloadScore || 0);
    const rightWorkload = Number(rightUnit?.workloadScore || 0);
    const leftError = Math.abs(zone.workloadScore + leftWorkload - target);
    const rightError = Math.abs(zone.workloadScore + rightWorkload - target);
    const leftNeighbors = (leftUnit?.neighborIds || []).filter((id) => zone.unitIds.has(id)).length;
    const rightNeighbors = (rightUnit?.neighborIds || []).filter((id) => zone.unitIds.has(id)).length;
    return leftError - rightError
      || rightNeighbors - leftNeighbors
      || rightWorkload - leftWorkload
      || compareIds(left.unitId, right.unitId);
  });
  const selected = candidates.shift();
  candidates.forEach((candidate) => heapPush(zone.frontier, candidate));
  return selected;
}

function partitionComponent(component, zoneCount, byId) {
  const seeds = chooseSeeds(component.ids, zoneCount, byId);
  const seedSet = new Set(seeds);
  const unassigned = new Set(component.ids.filter((id) => !seedSet.has(id)));
  const target = component.workloadScore / zoneCount;
  const zones = seeds.map((seedId, index) => ({
    localIndex: index,
    seedId,
    unitIds: new Set([seedId]),
    workloadScore: Number(byId.get(seedId)?.workloadScore || 0),
    frontier: [],
    frontierQueued: new Set(),
    seedDistances: shortestDistances(seedId, component.ids, byId),
  }));
  zones.forEach((zone) => enqueueZoneFrontier(zone, zone.seedId, unassigned, byId, zone.seedDistances));

  while (unassigned.size) {
    const availableZones = zones.filter((zone) => discardAssignedFrontierEntries(zone, unassigned))
      .sort((left, right) => left.workloadScore / Math.max(1, target) - right.workloadScore / Math.max(1, target)
        || left.workloadScore - right.workloadScore
        || left.localIndex - right.localIndex);
    if (!availableZones.length) return null;
    const zone = availableZones[0];
    const selected = takeBestFrontierEntry(zone, unassigned, byId, target);
    if (!selected) return null;
    const unitWorkload = Number(byId.get(selected.unitId)?.workloadScore || 0);
    zone.unitIds.add(selected.unitId);
    zone.workloadScore += unitWorkload;
    unassigned.delete(selected.unitId);
    enqueueZoneFrontier(zone, selected.unitId, unassigned, byId, zone.seedDistances);
  }
  return zones.map(({ frontier, frontierQueued, seedDistances, ...zone }) => zone);
}

function convexHull(points = []) {
  const unique = [...new Map(points.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
    .map((point) => [`${Number(point.lat).toFixed(8)}:${Number(point.lng).toFixed(8)}`, { lat: Number(point.lat), lng: Number(point.lng) }])).values()]
    .sort((left, right) => left.lng - right.lng || left.lat - right.lat);
  if (unique.length <= 2) return unique;
  const cross = (origin, first, second) => (first.lng - origin.lng) * (second.lat - origin.lat) - (first.lat - origin.lat) * (second.lng - origin.lng);
  const lower = [];
  unique.forEach((point) => {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  });
  const upper = [];
  [...unique].reverse().forEach((point) => {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  });
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function offsetPoint(point, eastMeters, northMeters) {
  const latitudeScale = 110540;
  const longitudeScale = Math.max(1000, 111320 * Math.cos(Number(point.lat) * Math.PI / 180));
  return { lat: Number(point.lat) + northMeters / latitudeScale, lng: Number(point.lng) + eastMeters / longitudeScale };
}

function unitDisplayCorridor(unit, corridorMeters = 16) {
  const buffered = [];
  (unit.segments || []).forEach((segment) => {
    const start = segment.start;
    const end = segment.end;
    const averageLat = (Number(start.lat) + Number(end.lat)) / 2;
    const dx = (Number(end.lng) - Number(start.lng)) * 111320 * Math.cos(averageLat * Math.PI / 180);
    const dy = (Number(end.lat) - Number(start.lat)) * 110540;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    const east = (-dy / length) * corridorMeters;
    const north = (dx / length) * corridorMeters;
    buffered.push(offsetPoint(start, east, north), offsetPoint(start, -east, -north));
    buffered.push(offsetPoint(end, east, north), offsetPoint(end, -east, -north));
  });
  const hull = convexHull(buffered);
  if (hull.length >= 3) return hull;
  const point = (unit.segments || [])[0]?.start;
  return point ? [
    offsetPoint(point, -corridorMeters, -corridorMeters),
    offsetPoint(point, corridorMeters, -corridorMeters),
    offsetPoint(point, corridorMeters, corridorMeters),
    offsetPoint(point, -corridorMeters, corridorMeters),
  ] : [];
}

function centerOfUnits(units, fallbackPoints = []) {
  let latitudeTotal = 0;
  let longitudeTotal = 0;
  let pointCount = 0;
  units.forEach((unit) => (unit.segments || []).forEach((segment) => {
    [segment.start, segment.end].forEach((point) => {
      latitudeTotal += Number(point.lat);
      longitudeTotal += Number(point.lng);
      pointCount += 1;
    });
  }));
  if (!pointCount) {
    fallbackPoints.forEach((point) => {
      latitudeTotal += Number(point.lat);
      longitudeTotal += Number(point.lng);
      pointCount += 1;
    });
  }
  if (!pointCount) return null;
  return {
    lat: latitudeTotal / pointCount,
    lng: longitudeTotal / pointCount,
  };
}

function ownedStreetPointNearest(units, target) {
  if (!target) return null;
  let best = null;
  units.forEach((unit) => (unit.segments || []).forEach((segment) => {
    const referenceLatitude = (Number(target.lat) + Number(segment.start.lat) + Number(segment.end.lat)) / 3;
    const longitudeScale = Math.max(1000, 111320 * Math.cos(referenceLatitude * Math.PI / 180));
    const latitudeScale = 110540;
    const startX = (Number(segment.start.lng) - Number(target.lng)) * longitudeScale;
    const startY = (Number(segment.start.lat) - Number(target.lat)) * latitudeScale;
    const endX = (Number(segment.end.lng) - Number(target.lng)) * longitudeScale;
    const endY = (Number(segment.end.lat) - Number(target.lat)) * latitudeScale;
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const position = lengthSquared <= 0
      ? 0
      : Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / lengthSquared));
    const point = {
      lat: Number(segment.start.lat) + (Number(segment.end.lat) - Number(segment.start.lat)) * position,
      lng: Number(segment.start.lng) + (Number(segment.end.lng) - Number(segment.start.lng)) * position,
    };
    const candidate = {
      point,
      distanceSquared: (startX + position * deltaX) ** 2 + (startY + position * deltaY) ** 2,
      edgeId: segment.edgeId,
      unitId: unit.id,
    };
    if (!best || candidate.distanceSquared < best.distanceSquared
      || (candidate.distanceSquared === best.distanceSquared && compareIds(candidate.edgeId, best.edgeId) < 0)
      || (candidate.distanceSquared === best.distanceSquared && compareIds(candidate.edgeId, best.edgeId) === 0 && compareIds(candidate.unitId, best.unitId) < 0)) {
      best = candidate;
    }
  }));
  return best?.point || null;
}

function polygonArea(points = []) {
  if (points.length < 3) return 0;
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.lng * next.lat - next.lng * point.lat;
  }, 0) / 2);
}

function isConnected(unitIds, byId) {
  if (!unitIds.length) return false;
  const allowed = new Set(unitIds);
  const seen = new Set([unitIds[0]]);
  const queue = [unitIds[0]];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const unitId = queue[queueIndex];
    (byId.get(unitId)?.neighborIds || []).forEach((neighborId) => {
      if (!allowed.has(neighborId) || seen.has(neighborId)) return;
      seen.add(neighborId);
      queue.push(neighborId);
    });
  }
  return seen.size === allowed.size;
}

function colorAdjacentZones(zones, workUnits, zoneByUnitId) {
  const adjacency = new Map(zones.map((zone) => [zone.zone_id, new Set()]));
  workUnits.forEach((unit) => (unit.neighborIds || []).forEach((neighborId) => {
    const zoneId = zoneByUnitId.get(unit.id);
    const neighborZoneId = zoneByUnitId.get(neighborId);
    if (!zoneId || !neighborZoneId || zoneId === neighborZoneId) return;
    adjacency.get(zoneId)?.add(neighborZoneId);
    adjacency.get(neighborZoneId)?.add(zoneId);
  }));
  const colors = new Map();
  [...zones].sort((left, right) =>
    (adjacency.get(right.zone_id)?.size || 0) - (adjacency.get(left.zone_id)?.size || 0)
      || left.zone_number - right.zone_number
      || compareIds(left.zone_id, right.zone_id)).forEach((zone) => {
    const neighborColors = [...(adjacency.get(zone.zone_id) || [])]
      .map((neighborZoneId) => colors.get(neighborZoneId))
      .filter(Boolean);
    const available = ZONE_COLORS.find((color) => !neighborColors.includes(color));
    if (available) {
      colors.set(zone.zone_id, available);
      return;
    }
    const usage = new Map(ZONE_COLORS.map((color) => [color, neighborColors.filter((value) => value === color).length]));
    colors.set(zone.zone_id, [...ZONE_COLORS].sort((left, right) => usage.get(left) - usage.get(right)
      || ZONE_COLORS.indexOf(left) - ZONE_COLORS.indexOf(right))[0]);
  });
  return zones.map((zone) => ({ ...zone, color: colors.get(zone.zone_id) || ZONE_COLORS[0] }));
}

function finitePositive(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/**
 * Divides a freehand Canvas polygon into deterministic, connected territories.
 * Street work units are the assignment source of truth. Optional door candidates
 * tune workload estimates only; they are never required or used as deployment IDs.
 */
export function planCanvasTerritories(input = {}) {
  const candidateInput = normalizeCandidates(input);
  let candidates = candidateInput.candidates;
  const warnings = [...candidateInput.warnings];
  const topologyInput = {
    polygon: input.polygon,
    roadNetwork: input.roadNetwork,
    candidates,
    maxSnapDistanceMeters: input.max_snap_distance_meters ?? input.maxSnapDistanceMeters,
    roadSnapAmbiguityMeters: input.road_snap_ambiguity_meters ?? input.roadSnapAmbiguityMeters,
    roadSnapAmbiguityRatio: input.road_snap_ambiguity_ratio ?? input.roadSnapAmbiguityRatio,
  };
  let topology = buildCanvasStreetWorkUnits(topologyInput);
  if (!topology.ok && candidates.length && OPTIONAL_CANDIDATE_FAILURES.has(topology.code)) {
    warnings.push(`Optional door estimates were ignored: ${topology.message}`);
    candidates = [];
    topology = buildCanvasStreetWorkUnits({ ...topologyInput, candidates: [] });
  }
  if (!topology.ok) {
    return failure(
      topology.status || 'blocked',
      topology.code || 'TOPOLOGY_BLOCKED',
      topology.message || 'Street topology could not be verified.',
      topology.details,
    );
  }
  warnings.push(...(topology.warnings || []).map((warning) => warning.message || String(warning)));

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const candidateEquivalentMeters = finitePositive(input.candidate_equivalent_meters, 35);
  const workUnits = decorateWorkUnits(topology.workUnits, candidateById, candidateEquivalentMeters);
  const segmentCount = workUnits.reduce((sum, unit) => sum + (unit.segments?.length || 0), 0);
  const reps = selectedRepIds(input);
  const totalStreetWorkloadMeters = workUnits.reduce((sum, unit) => sum + unit.workloadScore, 0);
  const totalClassWeightedLengthMeters = workUnits
    .reduce((sum, unit) => sum + Number(unit.classWeightedLengthMeters || 0), 0);
  const request = resolveZoneRequest(input, totalClassWeightedLengthMeters, reps);
  if (request.error) return request.error;
  const zoneCount = request.zoneCount;
  if (zoneCount > MAX_CANVAS_ZONE_COUNT) {
    return failure(
      'infeasible',
      'CANVAS_ZONE_LIMIT_EXCEEDED',
      `Canvas supports at most ${MAX_CANVAS_ZONE_COUNT} areas in one campaign.`,
      { requested_zone_count: zoneCount, maximum_zone_count: MAX_CANVAS_ZONE_COUNT, production_zone_limit: MAX_CANVAS_ZONE_COUNT },
    );
  }
  if (workUnits.length > MAX_CANVAS_INTERACTIVE_WORK_UNITS || segmentCount > MAX_CANVAS_INTERACTIVE_SEGMENTS || zoneCount * workUnits.length > MAX_CANVAS_INTERACTIVE_COMPLEXITY) {
    return failure(
      'blocked',
      'CANVAS_PLAN_TOO_COMPLEX',
      'This street network is too complex to verify safely as one campaign. Review the limits below, then reduce the boundary or area count that exceeded them.',
      {
        zone_count: zoneCount,
        work_unit_count: workUnits.length,
        segment_count: segmentCount,
        interactive_complexity: zoneCount * workUnits.length,
        maximum_work_unit_count: MAX_CANVAS_INTERACTIVE_WORK_UNITS,
        maximum_segment_count: MAX_CANVAS_INTERACTIVE_SEGMENTS,
        maximum_interactive_complexity: MAX_CANVAS_INTERACTIVE_COMPLEXITY,
      },
    );
  }
  const byId = new Map(workUnits.map((unit) => [unit.id, unit]));
  const components = unitComponents(workUnits);
  const minimumZoneCount = components.length;
  const maximumZoneCount = Math.min(workUnits.length, MAX_CANVAS_ZONE_COUNT);
  if (minimumZoneCount > MAX_CANVAS_ZONE_COUNT) {
    return failure(
      'infeasible',
      'TOO_MANY_DISCONNECTED_COMPONENTS',
      `The selected streets contain ${minimumZoneCount} disconnected groups, exceeding the ${MAX_CANVAS_ZONE_COUNT}-area Canvas limit.`,
      {
        minimum_zone_count: minimumZoneCount,
        maximum_zone_count: MAX_CANVAS_ZONE_COUNT,
        production_zone_limit: MAX_CANVAS_ZONE_COUNT,
      },
    );
  }
  if (zoneCount < minimumZoneCount) {
    return failure(
      'infeasible',
      'TOO_FEW_ZONES_FOR_COMPONENTS',
      `At least ${minimumZoneCount} areas are required because the selected streets have ${minimumZoneCount} disconnected road groups.`,
      { minimum_zone_count: minimumZoneCount, maximum_zone_count: maximumZoneCount },
    );
  }
  if (zoneCount > maximumZoneCount) {
    const exceedsProductionLimit = zoneCount > MAX_CANVAS_ZONE_COUNT;
    return failure(
      'infeasible',
      exceedsProductionLimit ? 'CANVAS_ZONE_LIMIT_EXCEEDED' : 'TOO_MANY_ZONES_FOR_WORK_UNITS',
      exceedsProductionLimit
        ? `Canvas supports at most ${MAX_CANVAS_ZONE_COUNT} areas in one campaign.`
        : `At most ${maximumZoneCount} connected areas can be created without splitting an atomic street unit.`,
      {
        requested_zone_count: zoneCount,
        minimum_zone_count: minimumZoneCount,
        maximum_zone_count: maximumZoneCount,
        production_zone_limit: MAX_CANVAS_ZONE_COUNT,
      },
    );
  }
  const allocation = allocateComponentZoneCounts(components, zoneCount);
  if (!allocation) {
    return failure(
      'infeasible',
      'ZONE_ALLOCATION_INFEASIBLE',
      'The requested area count cannot be allocated without splitting an atomic street unit.',
      { minimum_zone_count: minimumZoneCount, maximum_zone_count: maximumZoneCount },
    );
  }

  const partitioned = [];
  components.forEach((component, componentIndex) => {
    const groups = partitionComponent(component, allocation[componentIndex], byId);
    if (groups) partitioned.push(...groups);
  });
  if (partitioned.length !== zoneCount) {
    return failure('infeasible', 'CONNECTED_PARTITION_FAILED', 'Canvas could not form the requested number of connected street areas.');
  }

  const boundary = normalizeBoundary(input.polygon);
  const workUnitZoneId = new Map();
  const averageWorkload = totalStreetWorkloadMeters / zoneCount;
  const walkingMetersPerMinute = finitePositive(input.walking_meters_per_minute, 75);
  const streetPassMultiplier = finitePositive(input.street_pass_multiplier, 2);
  const doorsPerHour = finitePositive(input.doors_per_hour, 20);
  const includeDisplayCorridors = workUnits.length <= MAX_DISPLAY_CORRIDOR_WORK_UNITS;
  let zones = partitioned.map((group, index) => {
    const workUnitIds = [...group.unitIds].sort(compareIds);
    const units = workUnitIds.map((unitId) => byId.get(unitId));
    const zoneId = `canvas-zone:${stableHash(workUnitIds.join('|'))}`;
    workUnitIds.forEach((unitId) => workUnitZoneId.set(unitId, zoneId));
    const parts = includeDisplayCorridors
      ? units.flatMap((unit) => clippedPolygonParts(unitDisplayCorridor(unit), boundary))
      : [];
    const geometry = [...parts].sort((left, right) => polygonArea(right) - polygonArea(left))[0] || [];
    const center = centerOfUnits(units, geometry);
    const dropPoint = ownedStreetPointNearest(units, center);
    const streetLengthMeters = units.reduce((sum, unit) => sum + Number(unit.streetLengthMeters || 0), 0);
    const classWeightedLengthMeters = units.reduce((sum, unit) => sum + Number(unit.classWeightedLengthMeters || 0), 0);
    const estimatedDoorWeight = units.reduce((sum, unit) => sum + Number(unit.estimatedDoorWeight || 0), 0);
    const workloadScore = units.reduce((sum, unit) => sum + Number(unit.workloadScore || 0), 0);
    const protectedOversize = units.some((unit) => unit.protected && unit.workloadScore > averageWorkload);
    const streetSegments = units.flatMap((unit) => (unit.segments || []).map((segment) => ({
      edge_id: segment.edgeId,
      work_unit_id: unit.id,
      start: segment.start,
      end: segment.end,
      street_names: segment.streetNames,
      highway_types: segment.highwayTypes,
      length_meters: segment.lengthMeters,
      workload_weight: segment.workloadWeight,
      class_weighted_length_meters: segment.classWeightedLengthMeters,
    })));
    const estimatedMinutes = streetLengthMeters * streetPassMultiplier / walkingMetersPerMinute
      + (candidates.length ? estimatedDoorWeight / doorsPerHour * 60 : 0);
    return {
      zone_id: zoneId,
      zone_number: index + 1,
      name: `Area ${index + 1}`,
      color: null,
      geometry,
      parts,
      geometry_role: 'display_only',
      center,
      drop_point: dropPoint,
      work_unit_ids: workUnitIds,
      street_work_unit_ids: workUnitIds,
      display_work_unit_ids: workUnitIds,
      street_segments: streetSegments,
      street_length_meters: Number(streetLengthMeters.toFixed(2)),
      street_length_m: Number(streetLengthMeters.toFixed(2)),
      class_weighted_street_length_meters: Number(classWeightedLengthMeters.toFixed(2)),
      estimated_doors: candidates.length ? Number(estimatedDoorWeight.toFixed(1)) : null,
      estimated_minutes: Number(estimatedMinutes.toFixed(1)),
      workload_score: Number(workloadScore.toFixed(2)),
      workload_share: Number((workloadScore / Math.max(1, totalStreetWorkloadMeters)).toFixed(4)),
      protected_unit_over_target: protectedOversize,
    };
  });
  zones = colorAdjacentZones(zones, workUnits, workUnitZoneId);
  const displayGeometryComplete = zones.every((zone) => (
    Array.isArray(zone.geometry) && zone.geometry.length >= 3 && zone.parts.length > 0
  ));
  if (!displayGeometryComplete) warnings.push(includeDisplayCorridors
    ? 'Some legacy display corridors could not be rendered; clipped street segments remain the authoritative territory view.'
    : 'Legacy display corridors were skipped for this large plan; colored street segments remain the authoritative territory view.');

  const workUnitZoneCounts = new Map();
  zones.forEach((zone) => zone.work_unit_ids.forEach((unitId) => {
    workUnitZoneCounts.set(unitId, (workUnitZoneCounts.get(unitId) || 0) + 1);
  }));
  const expectedWorkUnitIds = workUnits.map((unit) => unit.id).sort(compareIds);
  const missingWorkUnitIds = expectedWorkUnitIds.filter((unitId) => !workUnitZoneCounts.has(unitId));
  const duplicateWorkUnitIds = [...workUnitZoneCounts]
    .filter(([, count]) => count !== 1)
    .map(([unitId]) => unitId)
    .sort(compareIds);
  const connectedZones = zones.every((zone) => isConnected(zone.work_unit_ids, byId));
  const atomicWorkUnits = missingWorkUnitIds.length === 0
    && duplicateWorkUnitIds.length === 0
    && workUnitZoneCounts.size === expectedWorkUnitIds.length;
  const protectedUnitsIntact = workUnits.filter((unit) => unit.protected)
    .every((unit) => workUnitZoneCounts.get(unit.id) === 1);
  const streetCoverageComplete = atomicWorkUnits;
  const maxWorkloadDeviationPercent = Math.round(Math.max(...zones.map((zone) =>
    Math.abs(zone.workload_score - averageWorkload) / Math.max(1, averageWorkload))) * 100);
  const zoneByUnitId = new Map(zones.flatMap((zone) => zone.work_unit_ids.map((unitId) => [unitId, zone.zone_id])));
  const adjacencyPairs = new Set();
  const crossZonePairs = new Set();
  const adjacentZonePairs = new Set();
  workUnits.forEach((unit) => (unit.neighborIds || []).forEach((neighborId) => {
    const pair = [unit.id, neighborId].sort(compareIds).join('|');
    adjacencyPairs.add(pair);
    const zoneId = zoneByUnitId.get(unit.id);
    const neighborZoneId = zoneByUnitId.get(neighborId);
    if (zoneId !== neighborZoneId) {
      crossZonePairs.add(pair);
      adjacentZonePairs.add([zoneId, neighborZoneId].sort(compareIds).join('|'));
    }
  }));
  const colorByZoneId = new Map(zones.map((zone) => [zone.zone_id, zone.color]));
  const adjacentZoneColorConflicts = [...adjacentZonePairs].filter((pair) => {
    const [firstZoneId, secondZoneId] = pair.split('|');
    return colorByZoneId.get(firstZoneId) === colorByZoneId.get(secondZoneId);
  }).length;
  const compactnessScore = adjacencyPairs.size
    ? Number((1 - crossZonePairs.size / adjacencyPairs.size).toFixed(3))
    : 1;
  zones.filter((zone) => zone.protected_unit_over_target).forEach((zone) => {
    warnings.push(`Area ${zone.zone_number} exceeds the average workload because a protected terminal branch cannot be split.`);
  });
  if (maxWorkloadDeviationPercent > 25) {
    warnings.push(`Street-workload imbalance reaches ${maxWorkloadDeviationPercent}% because only whole connected street units can move between areas.`);
  }
  if (adjacentZoneColorConflicts) warnings.push(`${adjacentZoneColorConflicts} adjacent area color conflict${adjacentZoneColorConflicts === 1 ? '' : 's'} could not be avoided with the available palette.`);
  const hardGatesPass = streetCoverageComplete && connectedZones && atomicWorkUnits && protectedUnitsIntact;
  const status = topology.status === 'degraded' || warnings.length ? 'degraded' : 'ready';

  const candidateSnapsById = new Map((topology.candidateSnaps || []).map((snap) => [snap.candidateId, snap]));
  const doorCandidates = candidates.map((candidate) => {
    const snap = candidateSnapsById.get(candidate.id);
    return {
      candidate_id: candidate.id,
      lat: candidate.lat,
      lng: candidate.lng,
      weight: candidate.weight,
      work_unit_id: snap?.workUnitId || null,
      zone_id: snap ? workUnitZoneId.get(snap.workUnitId) || null : null,
    };
  });
  const versionSnapshot = canonicalize({
    polygon: boundary.map((point) => [Number(point.lat.toFixed(8)), Number(point.lng.toFixed(8))]),
    road_work_units: workUnits.map((unit) => ({
      id: unit.id,
      protected: unit.protected,
      neighbor_ids: [...(unit.neighborIds || [])].sort(compareIds),
      segments: (unit.segments || []).map((segment) => ({
        edge_id: segment.edgeId,
        start: [Number(segment.start.lat.toFixed(10)), Number(segment.start.lng.toFixed(10))],
        end: [Number(segment.end.lat.toFixed(10)), Number(segment.end.lng.toFixed(10))],
        street_names: segment.streetNames,
        highway_types: segment.highwayTypes,
        class_weighted_length_meters: segment.classWeightedLengthMeters,
      })),
    })).sort((left, right) => compareIds(left.id, right.id)),
    candidates: doorCandidates.map((candidate) => [
      candidate.candidate_id,
      Number(candidate.lat.toFixed(8)),
      Number(candidate.lng.toFixed(8)),
      candidate.weight,
      candidate.work_unit_id,
    ]),
    area_count: zoneCount,
    division_mode: request.divisionMode,
    target_street_workload_meters_per_area: request.targetStreetWorkloadMeters ?? null,
    target_street_workload_meters: request.targetStreetWorkloadMeters ?? null,
    candidate_equivalent_meters: candidateEquivalentMeters,
  });
  const dataVersion = `canvas-territory:${stableHash(JSON.stringify(versionSnapshot))}`;
  const totalStreetLengthMeters = workUnits.reduce((sum, unit) => sum + Number(unit.streetLengthMeters || 0), 0);
  const totalEstimatedDoors = candidates.length
    ? candidates.reduce((sum, candidate) => sum + candidate.weight, 0)
    : null;

  return {
    ok: hardGatesPass,
    status: hardGatesPass ? status : 'blocked',
    deployable: hardGatesPass,
    planning_method: 'street_workload',
    assignment_basis: 'street_work_unit_ids',
    ownership_geometry: 'clipped_street_segments',
    division_mode: request.divisionMode,
    workload_basis: candidates.length ? 'street_length_plus_estimated_doors' : 'street_length',
    selected_team_member_ids: reps,
    area_count: zoneCount,
    target_street_workload_meters_per_area: request.targetStreetWorkloadMeters ?? null,
    target_street_workload_meters: request.targetStreetWorkloadMeters ?? null,
    method: 'street_workload',
    algorithm_version: ALGORITHM_VERSION,
    data_version: dataVersion,
    road_aligned: true,
    street_aligned: true,
    culdesac_integrity: protectedUnitsIntact,
    zones,
    work_units: workUnits,
    door_candidates: doorCandidates,
    doors: [],
    qa: {
      deployable: hardGatesPass,
      street_coverage_complete: streetCoverageComplete,
      exclusive_work_unit_coverage: atomicWorkUnits,
      coverage_complete: streetCoverageComplete,
      no_duplicate_work_units: duplicateWorkUnitIds.length === 0,
      no_missing_work_units: missingWorkUnitIds.length === 0,
      connected_zones: connectedZones,
      atomic_work_units: atomicWorkUnits,
      cul_de_sac_splits: protectedUnitsIntact ? 0 : 1,
      protected_units_intact: protectedUnitsIntact,
      display_geometry_complete: displayGeometryComplete,
      data_quality_status: hardGatesPass ? 'verified' : 'unverified',
      total_street_length_meters: Number(totalStreetLengthMeters.toFixed(2)),
      assigned_street_length_meters: Number(zones.reduce((sum, zone) => sum + zone.street_length_meters, 0).toFixed(2)),
      class_weighted_street_workload_meters: Number(totalClassWeightedLengthMeters.toFixed(2)),
      total_workload_score: Number(totalStreetWorkloadMeters.toFixed(2)),
      estimated_doors: totalEstimatedDoors === null ? null : Number(totalEstimatedDoors.toFixed(1)),
      zone_count: zones.length,
      work_unit_count: expectedWorkUnitIds.length,
      protected_terminal_branch_count: topology.diagnostics?.protectedTerminalBranchCount || 0,
      disconnected_component_count: components.length,
      minimum_zone_count: minimumZoneCount,
      maximum_zone_count: maximumZoneCount,
      target_street_workload_meters_per_area: request.targetStreetWorkloadMeters ?? null,
      target_street_workload_meters: request.targetStreetWorkloadMeters ?? null,
      max_workload_deviation_percent: maxWorkloadDeviationPercent,
      cross_zone_adjacency_count: crossZonePairs.size,
      adjacent_zone_color_conflicts: adjacentZoneColorConflicts,
      compactness_score: compactnessScore,
      missing_work_unit_ids: missingWorkUnitIds,
      duplicate_work_unit_ids: duplicateWorkUnitIds,
      warnings,
    },
    diagnostics: {
      ...topology.diagnostics,
      method: 'street_workload',
      generation_method: ALGORITHM_VERSION,
      street_aligned: true,
      road_aligned: true,
      class_weighted_street_workload_meters: Number(totalClassWeightedLengthMeters.toFixed(2)),
      optional_door_estimates_used: candidates.length > 0,
      warnings,
    },
    warnings,
  };
}
