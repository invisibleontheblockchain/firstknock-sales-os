import { buildCanvasStreetWorkUnits } from './canvasStreetTopology.js';
import { polygon as geoJsonPolygon } from 'npm:turf-helpers@3.0.12';
import intersectPolygons from 'npm:turf-intersect@3.0.12';

const ALGORITHM_VERSION = 'canvas_street_work_units_v1';
const ZONE_COLORS = ['#A855F7', '#2563EB', '#059669', '#D97706', '#DC2626', '#0891B2', '#7C3AED', '#DB2777'];

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
    planning_method: 'street_work_units',
    assignment_basis: 'stable_door_ids',
    method: 'street_work_units',
    algorithm_version: ALGORITHM_VERSION,
    zones: [],
    doors: [],
    qa: {
      deployable: false,
      coverage_complete: false,
      no_duplicate_doors: false,
      no_missing_doors: false,
      connected_zones: false,
      atomic_work_units: false,
      cul_de_sac_splits: 0,
      protected_units_intact: false,
      data_quality_status: 'unverified',
      warnings: [message],
    },
  };
}

function canonicalDoorId(door) {
  return String(door?.stable_door_id ?? door?.id ?? door?.stable_id ?? door?.address_hash ?? door?.property_id ?? '').trim();
}

function normalizeDoors(input = []) {
  return input.map((door) => {
    const stableDoorId = canonicalDoorId(door);
    const lat = Number(door?.lat ?? door?.latitude);
    const lng = Number(door?.lng ?? door?.lon ?? door?.longitude);
    if (!stableDoorId || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { ...door, id: stableDoorId, stable_door_id: stableDoorId, lat, lng };
  }).filter(Boolean).sort((left, right) => compareIds(left.stable_door_id, right.stable_door_id));
}

function normalizeBoundary(input = []) {
  if (!Array.isArray(input)) return [];
  return input.map((point) => {
    const lat = Number(point?.lat ?? point?.latitude ?? point?.[0]);
    const lng = Number(point?.lng ?? point?.lon ?? point?.longitude ?? point?.[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }).filter(Boolean);
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

function canonicalWayNodes(nodes) {
  if (!Array.isArray(nodes)) return null;
  const forward = nodes.map(String);
  const reverse = [...forward].reverse();
  return forward.join('|').localeCompare(reverse.join('|')) <= 0 ? forward : reverse;
}

function requestedZoneCount(input, doorCount) {
  const explicit = Number(input.requested_zone_count ?? input.zoneCount ?? input.zone_count);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  if (input.workload_basis === 'homes_per_area') {
    const target = Math.max(1, Math.floor(Number(input.target_homes_per_area ?? input.targetHomesPerZone) || 1));
    return Math.max(1, Math.ceil(doorCount / target));
  }
  const reps = input.selected_team_member_ids ?? input.selectedRepIds ?? [];
  return Math.max(1, new Set(Array.isArray(reps) ? reps.filter(Boolean) : []).size);
}

function unitComponents(units) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const unseen = new Set(byId.keys());
  const components = [];
  while (unseen.size) {
    const seed = [...unseen].sort(compareIds)[0];
    const queue = [seed];
    const ids = [];
    unseen.delete(seed);
    while (queue.length) {
      const unitId = queue.shift();
      ids.push(unitId);
      (byId.get(unitId)?.neighborIds || []).forEach((neighborId) => {
        if (!unseen.has(neighborId)) return;
        unseen.delete(neighborId);
        queue.push(neighborId);
      });
    }
    const doorCount = ids.reduce((sum, id) => sum + Number(byId.get(id)?.doorCount || 0), 0);
    const doorUnitCount = ids.filter((id) => Number(byId.get(id)?.doorCount || 0) > 0).length;
    if (doorCount > 0) components.push({ ids: ids.sort(compareIds), doorCount, doorUnitCount });
  }
  return components.sort((left, right) => compareIds(left.ids[0], right.ids[0]));
}

function allocateComponentZoneCounts(components, totalZoneCount) {
  const allocation = components.map(() => 1);
  let remaining = totalZoneCount - allocation.length;
  while (remaining > 0) {
    const candidates = components.map((component, index) => ({
      index,
      capacity: component.doorUnitCount - allocation[index],
      pressure: component.doorCount / allocation[index],
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
  while (queue.length) {
    const unitId = queue.shift();
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
  const candidates = componentIds.filter((id) => Number(byId.get(id)?.doorCount || 0) > 0).sort(compareIds);
  const first = [...candidates].sort((left, right) =>
    Number(byId.get(right)?.doorCount || 0) - Number(byId.get(left)?.doorCount || 0) || compareIds(left, right))[0];
  const seeds = [first];
  const distanceCache = new Map([[first, shortestDistances(first, componentIds, byId)]]);
  while (seeds.length < count) {
    const ranked = candidates.filter((id) => !seeds.includes(id)).map((id) => ({
      id,
      distance: Math.min(...seeds.map((seedId) => distanceCache.get(seedId).get(id) ?? Number.MAX_SAFE_INTEGER)),
      doors: Number(byId.get(id)?.doorCount || 0),
    })).sort((left, right) => right.distance - left.distance || right.doors - left.doors || compareIds(left.id, right.id));
    if (!ranked.length) break;
    seeds.push(ranked[0].id);
    distanceCache.set(ranked[0].id, shortestDistances(ranked[0].id, componentIds, byId));
  }
  return seeds;
}

function partitionComponent(component, zoneCount, byId) {
  const seeds = chooseSeeds(component.ids, zoneCount, byId);
  const componentSet = new Set(component.ids);
  const unassigned = new Set(component.ids.filter((id) => !seeds.includes(id)));
  const target = component.doorCount / zoneCount;
  const zones = seeds.map((seedId, index) => ({
    localIndex: index,
    seedId,
    unitIds: new Set([seedId]),
    doorCount: Number(byId.get(seedId)?.doorCount || 0),
  }));

  while (unassigned.size) {
    const choices = [];
    zones.forEach((zone) => {
      const frontier = [...new Set([...zone.unitIds].flatMap((unitId) => byId.get(unitId)?.neighborIds || []))]
        .filter((unitId) => componentSet.has(unitId) && unassigned.has(unitId));
      frontier.forEach((unitId) => {
        const unitDoors = Number(byId.get(unitId)?.doorCount || 0);
        choices.push({
          zone,
          unitId,
          loadRatio: zone.doorCount / Math.max(1, target),
          projectedError: Math.abs(zone.doorCount + unitDoors - target),
          unitDoors,
        });
      });
    });
    if (!choices.length) return null;
    choices.sort((left, right) => left.loadRatio - right.loadRatio
      || left.projectedError - right.projectedError
      || right.unitDoors - left.unitDoors
      || left.zone.localIndex - right.zone.localIndex
      || compareIds(left.unitId, right.unitId));
    const selected = choices[0];
    selected.zone.unitIds.add(selected.unitId);
    selected.zone.doorCount += selected.unitDoors;
    unassigned.delete(selected.unitId);
  }
  return zones;
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

function unitCorridor(unit, doorById, corridorMeters = 16) {
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
  (unit.doorIds || []).forEach((doorId) => {
    const door = doorById.get(doorId);
    if (!door) return;
    buffered.push(offsetPoint(door, corridorMeters / 2, corridorMeters / 2));
    buffered.push(offsetPoint(door, -corridorMeters / 2, -corridorMeters / 2));
  });
  const hull = convexHull(buffered);
  if (hull.length >= 3) return hull;
  const point = (unit.segments || [])[0]?.start || doorById.get(unit.doorIds?.[0]);
  return point ? [
    offsetPoint(point, -corridorMeters, -corridorMeters),
    offsetPoint(point, corridorMeters, -corridorMeters),
    offsetPoint(point, corridorMeters, corridorMeters),
    offsetPoint(point, -corridorMeters, corridorMeters),
  ] : [];
}

function centerOfDoors(doorIds, doorById, fallbackPoints = []) {
  const points = doorIds.map((id) => doorById.get(id)).filter(Boolean);
  const values = points.length ? points : fallbackPoints;
  if (!values.length) return null;
  return {
    lat: values.reduce((sum, point) => sum + Number(point.lat), 0) / values.length,
    lng: values.reduce((sum, point) => sum + Number(point.lng), 0) / values.length,
  };
}

function isConnected(unitIds, byId) {
  if (!unitIds.length) return false;
  const allowed = new Set(unitIds);
  const seen = new Set([unitIds[0]]);
  const queue = [unitIds[0]];
  while (queue.length) {
    const unitId = queue.shift();
    (byId.get(unitId)?.neighborIds || []).forEach((neighborId) => {
      if (!allowed.has(neighborId) || seen.has(neighborId)) return;
      seen.add(neighborId);
      queue.push(neighborId);
    });
  }
  return seen.size === allowed.size;
}

/**
 * Partitions a freehand Canvas polygon into deterministic, connected groups of
 * indivisible street work units. Geometry is only a display corridor; stable
 * door IDs and work-unit ownership are the assignment source of truth.
 */
export function planCanvasTerritories(input = {}) {
  const rawDoors = input.opportunities ?? input.doors ?? [];
  if (!Array.isArray(rawDoors)) return failure('blocked', 'INVALID_DOOR_INPUT', 'Canvas home input must be an array of stable IDs and coordinates.');
  const sourceDoors = normalizeDoors(rawDoors);
  if (sourceDoors.length !== rawDoors.length) {
    const invalidIndexes = rawDoors.map((door, index) => {
      const stableDoorId = canonicalDoorId(door);
      const lat = Number(door?.lat ?? door?.latitude);
      const lng = Number(door?.lng ?? door?.lon ?? door?.longitude);
      return stableDoorId && Number.isFinite(lat) && Number.isFinite(lng) ? null : index;
    }).filter((index) => index !== null);
    return failure('blocked', 'INVALID_DOOR_INPUT', 'Every Canvas home must have a stable ID and valid coordinates; invalid homes cannot be removed from QA.', { invalid_indexes: invalidIndexes });
  }
  if (!sourceDoors.length) return failure('blocked', 'DOORS_REQUIRED', 'Stable home opportunities are required before Canvas can divide this area.');
  if (new Set(sourceDoors.map((door) => door.stable_door_id)).size !== sourceDoors.length) {
    return failure('blocked', 'DUPLICATE_DOOR_IDS', 'Every Canvas home must have a unique stable ID.');
  }

  const topology = buildCanvasStreetWorkUnits({
    polygon: input.polygon,
    roadNetwork: input.roadNetwork,
    doors: sourceDoors,
    maxSnapDistanceMeters: input.max_snap_distance_meters ?? input.maxSnapDistanceMeters,
  });
  if (!topology.ok) return failure(topology.status || 'blocked', topology.code || 'TOPOLOGY_BLOCKED', topology.message || 'Street topology could not be verified.', topology.details);

  const byId = new Map(topology.workUnits.map((unit) => [unit.id, unit]));
  const components = unitComponents(topology.workUnits);
  const zoneCount = requestedZoneCount(input, sourceDoors.length);
  const doorUnitCount = topology.workUnits.filter((unit) => unit.doorCount > 0).length;
  if (zoneCount < components.length) {
    return failure('infeasible', 'TOO_FEW_ZONES_FOR_COMPONENTS', `At least ${components.length} areas are required because the selected streets have ${components.length} disconnected home groups.`, { minimum_zone_count: components.length });
  }
  if (zoneCount > doorUnitCount) {
    return failure('infeasible', 'TOO_MANY_ZONES_FOR_WORK_UNITS', `At most ${doorUnitCount} safe areas can be created without splitting an atomic street unit.`, { maximum_zone_count: doorUnitCount });
  }
  const allocation = allocateComponentZoneCounts(components, zoneCount);
  if (!allocation) return failure('infeasible', 'ZONE_ALLOCATION_INFEASIBLE', 'The requested area count cannot be allocated without splitting an atomic street unit.');

  const partitioned = [];
  components.forEach((component, componentIndex) => {
    const groups = partitionComponent(component, allocation[componentIndex], byId);
    if (groups) partitioned.push(...groups);
  });
  if (partitioned.length !== zoneCount) return failure('infeasible', 'CONNECTED_PARTITION_FAILED', 'Canvas could not form the requested number of connected street areas.');

  const doorById = new Map(sourceDoors.map((door) => [door.stable_door_id, door]));
  const boundary = normalizeBoundary(input.polygon);
  const workUnitZoneId = new Map();
  const zones = partitioned.map((group, index) => {
    const displayUnitIds = [...group.unitIds].sort(compareIds);
    const doorWorkUnitIds = displayUnitIds.filter((unitId) => Number(byId.get(unitId)?.doorCount || 0) > 0);
    const stableDoorIds = doorWorkUnitIds.flatMap((unitId) => byId.get(unitId).doorIds || []).sort(compareIds);
    const zoneId = `canvas-zone:${stableHash(doorWorkUnitIds.join('|'))}`;
    displayUnitIds.forEach((unitId) => workUnitZoneId.set(unitId, zoneId));
    const parts = displayUnitIds.flatMap((unitId) => clippedPolygonParts(unitCorridor(byId.get(unitId), doorById), boundary));
    const geometry = parts[0] || [];
    const center = centerOfDoors(stableDoorIds, doorById, geometry);
    const protectedOversize = doorWorkUnitIds.some((unitId) => byId.get(unitId)?.protected
      && Number(byId.get(unitId)?.doorCount || 0) > Number(input.target_homes_per_area ?? input.targetHomesPerZone ?? Number.MAX_SAFE_INTEGER));
    return {
      zone_id: zoneId,
      zone_number: index + 1,
      name: `Area ${index + 1}`,
      color: ZONE_COLORS[index % ZONE_COLORS.length],
      geometry: geometry.length >= 3 ? geometry : parts[0],
      parts,
      center,
      drop_point: center,
      work_unit_ids: doorWorkUnitIds,
      display_work_unit_ids: displayUnitIds,
      stable_door_ids: stableDoorIds,
      estimated_doors: stableDoorIds.length,
      estimated_minutes: Number(((stableDoorIds.length / Math.max(1, Number(input.doors_per_hour || 20))) * 60).toFixed(1)),
      protected_unit_over_target: protectedOversize,
    };
  });

  if (zones.some((zone) => !Array.isArray(zone.geometry) || zone.geometry.length < 3 || !zone.parts.length)) {
    return failure('blocked', 'DISPLAY_GEOMETRY_CLIP_FAILED', 'Canvas could not clip every street area to the manager-drawn boundary. Redraw the territory and try again.');
  }

  const doorZoneCounts = new Map();
  zones.forEach((zone) => zone.stable_door_ids.forEach((doorId) => doorZoneCounts.set(doorId, (doorZoneCounts.get(doorId) || 0) + 1)));
  const missingDoorIds = sourceDoors.map((door) => door.stable_door_id).filter((doorId) => !doorZoneCounts.has(doorId));
  const duplicateDoorIds = [...doorZoneCounts].filter(([, count]) => count !== 1).map(([doorId]) => doorId);
  const connectedZones = partitioned.every((group) => isConnected([...group.unitIds], byId));
  const doorWorkUnitCounts = new Map();
  zones.forEach((zone) => zone.work_unit_ids.forEach((unitId) => doorWorkUnitCounts.set(unitId, (doorWorkUnitCounts.get(unitId) || 0) + 1)));
  const expectedDoorWorkUnitIds = topology.workUnits.filter((unit) => unit.doorCount > 0).map((unit) => unit.id);
  const atomicWorkUnits = expectedDoorWorkUnitIds.every((unitId) => doorWorkUnitCounts.get(unitId) === 1)
    && [...doorWorkUnitCounts.keys()].every((unitId) => expectedDoorWorkUnitIds.includes(unitId));
  const protectedUnitsIntact = topology.workUnits.filter((unit) => unit.protected && unit.doorCount > 0)
    .every((unit) => doorWorkUnitCounts.get(unit.id) === 1);
  const averageHomes = sourceDoors.length / zones.length;
  const maxWorkloadDeviationPercent = Math.round(Math.max(...zones.map((zone) => Math.abs(zone.stable_door_ids.length - averageHomes) / Math.max(1, averageHomes))) * 100);
  const warnings = (topology.warnings || []).map((warning) => warning.message || String(warning));
  zones.filter((zone) => zone.protected_unit_over_target).forEach((zone) => warnings.push(`Area ${zone.zone_number} exceeds the home target because a protected terminal branch cannot be split.`));
  if (maxWorkloadDeviationPercent > 25) warnings.push(`Home-count imbalance reaches ${maxWorkloadDeviationPercent}% because only whole street units can move between areas.`);
  const coverageComplete = missingDoorIds.length === 0 && doorZoneCounts.size === sourceDoors.length;
  const hardGatesPass = coverageComplete && duplicateDoorIds.length === 0 && connectedZones && atomicWorkUnits && protectedUnitsIntact;
  const status = topology.status === 'degraded' || warnings.length ? 'degraded' : 'ready';
  const doorSnapsById = new Map(topology.doorSnaps.map((snap) => [snap.doorId, snap]));
  const doors = sourceDoors.map((door) => {
    const snap = doorSnapsById.get(door.stable_door_id);
    const zoneId = snap ? workUnitZoneId.get(snap.workUnitId) : null;
    return {
      stable_door_id: door.stable_door_id,
      address_hash: door.address_hash || door.addressHash || null,
      full_address: door.full_address || door.address || null,
      lat: door.lat,
      lng: door.lng,
      work_unit_id: snap?.workUnitId || null,
      zone_id: zoneId,
      data_source: door.discoverySource || door.data_source || 'canvas_analysis',
    };
  });
  const versionSnapshot = canonicalize({
    analysis_id: input.analysis_id || null,
    polygon: boundary.map((point) => [Number(point.lat.toFixed(8)), Number(point.lng.toFixed(8))]),
    doors: sourceDoors.map((door) => [door.stable_door_id, Number(door.lat.toFixed(8)), Number(door.lng.toFixed(8))]),
    road_elements: (input.roadNetwork?.elements || []).map((element) => ({
      type: element?.type || null,
      id: element?.id ?? null,
      lat: Number.isFinite(Number(element?.lat)) ? Number(Number(element.lat).toFixed(8)) : null,
      lon: Number.isFinite(Number(element?.lon)) ? Number(Number(element.lon).toFixed(8)) : null,
      nodes: canonicalWayNodes(element?.nodes),
      tags: element?.tags || {},
    })).sort((left, right) => compareIds(`${left.type}:${left.id}`, `${right.type}:${right.id}`)),
    snaps: topology.doorSnaps.map((snap) => [snap.doorId, snap.edgeId, snap.workUnitId]),
  });
  const dataVersion = `canvas-data:${stableHash(JSON.stringify(versionSnapshot))}`;

  return {
    ok: hardGatesPass,
    status: hardGatesPass ? status : 'blocked',
    deployable: hardGatesPass,
    planning_method: 'street_work_units',
    assignment_basis: 'stable_door_ids',
    workload_basis: input.workload_basis === 'homes_per_area' ? 'homes_per_area' : 'selected_reps',
    selected_team_member_ids: [...new Set((input.selected_team_member_ids || input.selectedRepIds || []).map(String).filter(Boolean))],
    method: 'street_work_units',
    algorithm_version: ALGORITHM_VERSION,
    data_version: dataVersion,
    road_aligned: true,
    street_aligned: true,
    culdesac_integrity: protectedUnitsIntact,
    zones,
    doors,
    work_units: topology.workUnits,
    qa: {
      deployable: hardGatesPass,
      coverage_complete: coverageComplete,
      no_duplicate_doors: duplicateDoorIds.length === 0,
      no_missing_doors: missingDoorIds.length === 0,
      connected_zones: connectedZones,
      atomic_work_units: atomicWorkUnits,
      cul_de_sac_splits: protectedUnitsIntact ? 0 : 1,
      protected_units_intact: protectedUnitsIntact,
      data_quality_status: hardGatesPass ? 'verified' : 'unverified',
      total_homes: sourceDoors.length,
      assigned_homes: doorZoneCounts.size,
      zone_count: zones.length,
      work_unit_count: expectedDoorWorkUnitIds.length,
      protected_terminal_branch_count: topology.diagnostics?.protectedTerminalBranchCount || 0,
      max_workload_deviation_percent: maxWorkloadDeviationPercent,
      missing_door_ids: missingDoorIds,
      duplicate_door_ids: duplicateDoorIds,
      warnings,
    },
    diagnostics: {
      ...topology.diagnostics,
      method: 'street_work_units',
      generation_method: ALGORITHM_VERSION,
      street_aligned: true,
      road_aligned: true,
      warnings,
    },
    warnings,
  };
}
