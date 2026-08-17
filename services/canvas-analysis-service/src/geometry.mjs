import { canonicalStringify } from './canonical.mjs';
import { ServiceError } from './errors.mjs';

function coordinate(value, index) {
  const lng = Number(value?.[0]);
  const lat = Number(value?.[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new ServiceError(502, 'evidence_geometry_invalid', `Evidence coordinate ${index} is invalid.`);
  }
  return [lng, lat];
}

export function polygonCoordinates(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) throw new ServiceError(400, 'invalid_polygon', 'Polygon requires at least three points.');
  return polygon.map((point, index) => coordinate([point?.lng, point?.lat], index));
}

export function polygonBounds(polygon) {
  const coordinates = polygonCoordinates(polygon);
  const longitudes = coordinates.map(([lng]) => lng);
  const latitudes = coordinates.map(([, lat]) => lat);
  return {
    min_lng: Math.min(...longitudes),
    min_lat: Math.min(...latitudes),
    max_lng: Math.max(...longitudes),
    max_lat: Math.max(...latitudes),
  };
}

export function boundsIntersect(left, right) {
  return !(left.max_lng < right.min_lng
    || left.min_lng > right.max_lng
    || left.max_lat < right.min_lat
    || left.min_lat > right.max_lat);
}

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
      if (segmentsIntersect(
        line[lineIndex - 1],
        line[lineIndex],
        polygon[polygonIndex],
        polygon[(polygonIndex + 1) % polygon.length],
      )) return true;
    }
  }
  return false;
}

export function selectTileWorkUnits(tile, boundary) {
  const polygon = polygonCoordinates(boundary);
  const selectedIds = new Set(tile.work_units
    .filter((unit) => lineIntersectsPolygon(unit.geometry.coordinates.map(coordinate), polygon))
    .map((unit) => unit.work_unit_id));
  for (const group of tile.protected_groups) {
    if (group.member_work_unit_ids.some((id) => selectedIds.has(id))) {
      group.member_work_unit_ids.forEach((id) => selectedIds.add(id));
    }
  }
  const workUnits = tile.work_units.filter((unit) => selectedIds.has(unit.work_unit_id));
  const properties = (tile.properties || []).filter((property) => pointInPolygon([property.point.lng, property.point.lat], polygon));
  const protectedGroups = tile.protected_groups.filter((group) => group.member_work_unit_ids.some((id) => selectedIds.has(id)));
  const externalNeighborIds = new Set();
  for (const unit of workUnits) {
    for (const neighborId of unit.neighbor_ids) if (!selectedIds.has(neighborId)) externalNeighborIds.add(neighborId);
  }
  return { work_units: workUnits, properties, protected_groups: protectedGroups, external_neighbor_ids: [...externalNeighborIds].sort() };
}

export function stitchSelections(selections) {
  const workUnits = new Map();
  const properties = new Map();
  const protectedGroups = new Map();
  const externalCandidates = new Set();
  for (const selection of selections) {
    for (const unit of selection.work_units) {
      const existing = workUnits.get(unit.work_unit_id);
      if (existing && canonicalStringify(existing) !== canonicalStringify(unit)) {
        throw new ServiceError(502, 'evidence_work_unit_conflict', `Work unit ${unit.work_unit_id} differs across tiles.`);
      }
      workUnits.set(unit.work_unit_id, unit);
    }
    for (const property of selection.properties || []) {
      const existing = properties.get(property.property_id);
      if (existing && canonicalStringify(existing) !== canonicalStringify(property)) {
        throw new ServiceError(502, 'evidence_property_conflict', `Property ${property.property_id} differs across tiles.`);
      }
      properties.set(property.property_id, property);
    }
    for (const group of selection.protected_groups) {
      const existing = protectedGroups.get(group.protected_group_id);
      if (existing && canonicalStringify(existing) !== canonicalStringify(group)) {
        throw new ServiceError(502, 'evidence_protected_group_conflict', `Protected group ${group.protected_group_id} differs across tiles.`);
      }
      protectedGroups.set(group.protected_group_id, group);
    }
    selection.external_neighbor_ids.forEach((id) => externalCandidates.add(id));
  }
  for (const unit of workUnits.values()) {
    for (const neighborId of unit.neighbor_ids) {
      const neighbor = workUnits.get(neighborId);
      if (neighbor && !neighbor.neighbor_ids.includes(unit.work_unit_id)) {
        throw new ServiceError(502, 'evidence_topology_asymmetric', `Neighbor topology is asymmetric at ${unit.work_unit_id}.`);
      }
      if (!neighbor) externalCandidates.add(neighborId);
    }
  }
  const selectedIds = new Set(workUnits.keys());
  return {
    work_units: [...workUnits.values()].sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id)),
    properties: [...properties.values()].sort((left, right) => left.property_id.localeCompare(right.property_id)),
    protected_groups: [...protectedGroups.values()].sort((left, right) => left.protected_group_id.localeCompare(right.protected_group_id)),
    external_neighbor_ids: [...externalCandidates].filter((id) => !selectedIds.has(id)).sort(),
  };
}