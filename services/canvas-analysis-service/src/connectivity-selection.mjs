const CONNECTIVITY_CONTEXT_METERS = 2_000;
const MAX_OUTSIDE_CONNECTOR_LENGTH_METERS = 10_000;
const EARTH_RADIUS_METERS = 6_371_008.8;

function pointOnSegment(point, start, end) {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) - (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-12) return false;
  return point[0] >= Math.min(start[0], end[0]) - 1e-12
    && point[0] <= Math.max(start[0], end[0]) + 1e-12
    && point[1] >= Math.min(start[1], end[1]) - 1e-12
    && point[1] <= Math.max(start[1], end[1]) + 1e-12;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const start = polygon[previous];
    const end = polygon[index];
    if (pointOnSegment(point, start, end)) return true;
    if ((end[1] > point[1]) !== (start[1] > point[1])) {
      const intersectionLng = ((start[0] - end[0]) * (point[1] - end[1])) / (start[1] - end[1]) + end[0];
      if (point[0] < intersectionLng) inside = !inside;
    }
  }
  return inside;
}

function orientation(first, second, third) {
  const value = (second[1] - first[1]) * (third[0] - second[0]) - (second[0] - first[0]) * (third[1] - second[1]);
  if (Math.abs(value) <= 1e-12) return 0;
  return value > 0 ? 1 : 2;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const one = orientation(firstStart, firstEnd, secondStart);
  const two = orientation(firstStart, firstEnd, secondEnd);
  const three = orientation(secondStart, secondEnd, firstStart);
  const four = orientation(secondStart, secondEnd, firstEnd);
  if (one !== two && three !== four) return true;
  return (one === 0 && pointOnSegment(secondStart, firstStart, firstEnd))
    || (two === 0 && pointOnSegment(secondEnd, firstStart, firstEnd))
    || (three === 0 && pointOnSegment(firstStart, secondStart, secondEnd))
    || (four === 0 && pointOnSegment(firstEnd, secondStart, secondEnd));
}

function lineIntersectsPolygon(line, polygon) {
  if (line.some((point) => pointInPolygon(point, polygon))) return true;
  for (let lineIndex = 1; lineIndex < line.length; lineIndex += 1) {
    for (let polygonIndex = 0; polygonIndex < polygon.length; polygonIndex += 1) {
      if (segmentsIntersect(line[lineIndex - 1], line[lineIndex], polygon[polygonIndex], polygon[(polygonIndex + 1) % polygon.length])) return true;
    }
  }
  return false;
}

function distanceMeters(first, second) {
  const lat1 = first[1] * Math.PI / 180;
  const lat2 = second[1] * Math.PI / 180;
  const deltaLat = lat2 - lat1;
  const deltaLng = (second[0] - first[0]) * Math.PI / 180;
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(value)));
}

function lineLengthMeters(line) {
  let total = 0;
  for (let index = 1; index < line.length; index += 1) total += distanceMeters(line[index - 1], line[index]);
  return total;
}

function pointToSegmentMeters(point, start, end) {
  const latitude = point[1] * Math.PI / 180;
  const scale = Math.cos(latitude);
  const projectedPoint = [point[0] * scale, point[1]];
  const projectedStart = [start[0] * scale, start[1]];
  const projectedEnd = [end[0] * scale, end[1]];
  const dx = projectedEnd[0] - projectedStart[0];
  const dy = projectedEnd[1] - projectedStart[1];
  const denominator = dx * dx + dy * dy;
  const ratio = denominator ? Math.max(0, Math.min(1, ((projectedPoint[0] - projectedStart[0]) * dx + (projectedPoint[1] - projectedStart[1]) * dy) / denominator)) : 0;
  return distanceMeters(point, [(projectedStart[0] + ratio * dx) / scale, projectedStart[1] + ratio * dy]);
}

function pointDistanceFromPolygonMeters(point, polygon) {
  if (pointInPolygon(point, polygon)) return 0;
  return Math.min(...polygon.map((start, index) => pointToSegmentMeters(point, start, polygon[(index + 1) % polygon.length])));
}

function connectedComponents(ids, byId) {
  const remaining = new Set(ids);
  const result = [];
  while (remaining.size) {
    const root = [...remaining].sort()[0];
    const component = [];
    const queue = [root];
    remaining.delete(root);
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      component.push(id);
      for (const neighborId of (byId.get(id)?.neighbor_ids || []).filter((value) => remaining.has(value)).sort()) {
        remaining.delete(neighborId);
        queue.push(neighborId);
      }
    }
    result.push(component.sort());
  }
  return result.sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]));
}

function shortestConnectorPath(sourceIds, targetIds, traversable) {
  const distances = new Map();
  const parents = new Map();
  const queue = [...sourceIds].sort().map((id) => ({ id, distance: 0 }));
  queue.forEach(({ id }) => distances.set(id, 0));
  while (queue.length) {
    queue.sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
    const current = queue.shift();
    if (current.distance !== distances.get(current.id)) continue;
    if (targetIds.has(current.id)) {
      const path = [];
      for (let cursor = current.id; cursor; cursor = parents.get(cursor)) path.push(cursor);
      return path.reverse();
    }
    const unit = traversable.get(current.id);
    for (const neighborId of (unit?.neighbor_ids || []).filter((id) => traversable.has(id)).sort()) {
      const neighbor = traversable.get(neighborId);
      const weight = (lineLengthMeters(unit.geometry.coordinates) + lineLengthMeters(neighbor.geometry.coordinates)) / 2;
      const candidate = current.distance + Math.max(0.01, weight);
      const known = distances.get(neighborId);
      if (known === undefined || candidate < known - 1e-6 || (Math.abs(candidate - known) <= 1e-6 && current.id.localeCompare(parents.get(neighborId) || '') < 0)) {
        distances.set(neighborId, candidate);
        parents.set(neighborId, current.id);
        queue.push({ id: neighborId, distance: candidate });
      }
    }
  }
  return null;
}

function expandProtectedGroups(selectedIds, protectedGroups) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of protectedGroups) {
      if (!group.member_work_unit_ids.some((id) => selectedIds.has(id))) continue;
      for (const id of group.member_work_unit_ids) {
        if (!selectedIds.has(id)) {
          selectedIds.add(id);
          changed = true;
        }
      }
    }
  }
}

export function connectivityContextBounds(polygon) {
  const averageLat = polygon.reduce((sum, point) => sum + Number(point.lat), 0) / polygon.length;
  const latitudeMargin = CONNECTIVITY_CONTEXT_METERS / 111_320;
  const longitudeMargin = CONNECTIVITY_CONTEXT_METERS / (111_320 * Math.max(0.1, Math.cos(averageLat * Math.PI / 180)));
  const lngs = polygon.map((point) => Number(point.lng));
  const lats = polygon.map((point) => Number(point.lat));
  return {
    min_lng: Math.min(...lngs) - longitudeMargin,
    min_lat: Math.min(...lats) - latitudeMargin,
    max_lng: Math.max(...lngs) + longitudeMargin,
    max_lat: Math.max(...lats) + latitudeMargin,
  };
}

export function selectBoundaryConnectivity(stitched, boundary) {
  const polygon = boundary.map((point) => [Number(point.lng), Number(point.lat)]);
  const byId = new Map(stitched.work_units.map((unit) => [unit.work_unit_id, unit]));
  const properties = (stitched.properties || []).filter((property) => pointInPolygon([property.point.lng, property.point.lat], polygon));
  const selectedIds = new Set(stitched.work_units
    .filter((unit) => lineIntersectsPolygon(unit.geometry.coordinates, polygon))
    .map((unit) => unit.work_unit_id));
  properties.forEach((property) => selectedIds.add(property.work_unit_id));
  expandProtectedGroups(selectedIds, stitched.protected_groups || []);

  const traversable = new Map(stitched.work_units
    .filter((unit) => unit.canvas_role === 'opportunity' || unit.canvas_role === 'transit')
    .map((unit) => [unit.work_unit_id, unit]));
  const selectedTraversable = [...selectedIds].filter((id) => traversable.has(id));
  const components = connectedComponents(selectedTraversable, traversable);
  const connectedIds = new Set(components[0] || []);
  const pending = components.slice(1).map((ids) => new Set(ids));
  const connectorIds = new Set();
  const rejectedComponentIds = [];

  while (pending.length) {
    const targets = new Set(pending.flatMap((component) => [...component]));
    const path = shortestConnectorPath(connectedIds, targets, traversable);
    if (!path) {
      rejectedComponentIds.push(...pending.flatMap((component) => [...component]));
      break;
    }
    const reachedIndex = pending.findIndex((component) => component.has(path.at(-1)));
    const outsideUnits = path.map((id) => traversable.get(id)).filter((unit) => !lineIntersectsPolygon(unit.geometry.coordinates, polygon));
    const outsideLength = outsideUnits.reduce((sum, unit) => sum + lineLengthMeters(unit.geometry.coordinates), 0);
    const maxExcursion = Math.max(0, ...outsideUnits.flatMap((unit) => unit.geometry.coordinates.map((point) => pointDistanceFromPolygonMeters(point, polygon))));
    if (outsideLength > MAX_OUTSIDE_CONNECTOR_LENGTH_METERS || maxExcursion > CONNECTIVITY_CONTEXT_METERS) {
      rejectedComponentIds.push(...pending[reachedIndex]);
      pending.splice(reachedIndex, 1);
      continue;
    }
    path.forEach((id) => {
      selectedIds.add(id);
      connectedIds.add(id);
      if (!lineIntersectsPolygon(traversable.get(id).geometry.coordinates, polygon)) connectorIds.add(id);
    });
    pending[reachedIndex].forEach((id) => connectedIds.add(id));
    pending.splice(reachedIndex, 1);
  }

  expandProtectedGroups(selectedIds, stitched.protected_groups || []);
  for (const id of selectedIds) {
    const unit = byId.get(id);
    if (unit && !lineIntersectsPolygon(unit.geometry.coordinates, polygon)) connectorIds.add(id);
  }
  const workUnits = stitched.work_units.filter((unit) => selectedIds.has(unit.work_unit_id));
  const protectedGroups = (stitched.protected_groups || []).filter((group) => group.member_work_unit_ids.some((id) => selectedIds.has(id)));
  const externalNeighborIds = new Set();
  workUnits.forEach((unit) => unit.neighbor_ids.forEach((id) => { if (!selectedIds.has(id)) externalNeighborIds.add(id); }));
  const connectorUnits = workUnits.filter((unit) => connectorIds.has(unit.work_unit_id));
  const connectorSegments = connectorUnits.reduce((sum, unit) => sum + Math.max(0, unit.geometry.coordinates.length - 1), 0);
  const connectorLength = connectorUnits.reduce((sum, unit) => sum + lineLengthMeters(unit.geometry.coordinates), 0);
  const maximumExcursion = Math.max(0, ...connectorUnits.flatMap((unit) => unit.geometry.coordinates.map((point) => pointDistanceFromPolygonMeters(point, polygon))));
  return {
    work_units: workUnits,
    properties,
    protected_groups: protectedGroups,
    external_neighbor_ids: [...externalNeighborIds].sort(),
    connectivity_context: {
      source: 'signed_authoritative_road_topology',
      outside_connector_work_unit_ids: [...connectorIds].sort(),
      outside_connector_segment_count: connectorSegments,
      outside_connector_length_meters: Number(connectorLength.toFixed(2)),
      maximum_connector_excursion_meters: Number(maximumExcursion.toFixed(2)),
      rejected_component_work_unit_ids: [...new Set(rejectedComponentIds)].sort(),
      connectors_contribute_zero_doors: true,
      outside_properties_included: 0,
      max_connector_excursion_meters: CONNECTIVITY_CONTEXT_METERS,
      max_outside_connector_length_meters: MAX_OUTSIDE_CONNECTOR_LENGTH_METERS,
    },
  };
}