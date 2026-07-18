const DEFAULT_ALLOWED_HIGHWAYS = new Set([
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'road',
]);

const DEFAULT_BLOCKING_BARRIERS = new Set([
  'yes',
  'block',
  'bollard',
  'chain',
  'fence',
  'hedge',
  'lift_gate',
  'retaining_wall',
  'swing_gate',
  'wall',
]);

const EARTH_RADIUS_METERS = 6371008.8;
const COORDINATE_EPSILON = 1e-10;

function canonicalId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function compareIds(left, right) {
  return String(left).localeCompare(String(right), 'en', { numeric: true });
}

function stableHash(value) {
  let first = 2166136261;
  let second = 2246822507;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489909);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function edgeIdFor(left, right) {
  const [first, second] = [String(left), String(right)].sort(compareIds);
  return `edge:${encodeURIComponent(first)}:${encodeURIComponent(second)}`;
}

function pointFrom(value) {
  const lat = Number(value?.lat ?? value?.latitude);
  const lng = Number(value?.lng ?? value?.lon ?? value?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function normalizePolygon(polygon) {
  if (!Array.isArray(polygon)) return [];
  const points = polygon.map(pointFrom).filter(Boolean);
  if (points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.lat - last.lat) < COORDINATE_EPSILON && Math.abs(first.lng - last.lng) < COORDINATE_EPSILON) points.pop();
  }
  return points;
}

function signedPolygonArea(polygon) {
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    area += current.lng * next.lat - next.lng * current.lat;
  }
  return area / 2;
}

function pointInPolygon(point, polygon) {
  if (!point || polygon.length < 3) return false;
  let inside = false;
  for (let currentIndex = 0, previousIndex = polygon.length - 1; currentIndex < polygon.length; previousIndex = currentIndex, currentIndex += 1) {
    const current = polygon[currentIndex];
    const previous = polygon[previousIndex];
    const crossesLatitude = (current.lat > point.lat) !== (previous.lat > point.lat);
    const crossingLongitude = ((previous.lng - current.lng) * (point.lat - current.lat))
      / ((previous.lat - current.lat) || COORDINATE_EPSILON) + current.lng;
    if (crossesLatitude && point.lng < crossingLongitude) inside = !inside;
  }
  return inside;
}

function orientation(first, second, third) {
  const value = (second.lng - first.lng) * (third.lat - first.lat) - (second.lat - first.lat) * (third.lng - first.lng);
  if (Math.abs(value) <= COORDINATE_EPSILON) return 0;
  return value > 0 ? 1 : -1;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  return firstOrientation !== secondOrientation && thirdOrientation !== fourthOrientation;
}

function pointOnSegment(point, start, end) {
  if (orientation(start, end, point) !== 0) return false;
  return point.lng >= Math.min(start.lng, end.lng) - COORDINATE_EPSILON
    && point.lng <= Math.max(start.lng, end.lng) + COORDINATE_EPSILON
    && point.lat >= Math.min(start.lat, end.lat) - COORDINATE_EPSILON
    && point.lat <= Math.max(start.lat, end.lat) + COORDINATE_EPSILON;
}

function segmentsIntersectInclusive(firstStart, firstEnd, secondStart, secondEnd) {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return true;
  return pointOnSegment(secondStart, firstStart, firstEnd)
    || pointOnSegment(secondEnd, firstStart, firstEnd)
    || pointOnSegment(firstStart, secondStart, secondEnd)
    || pointOnSegment(firstEnd, secondStart, secondEnd);
}

function polygonSelfIntersects(polygon) {
  if (polygon.length < 4) return false;
  for (let firstIndex = 0; firstIndex < polygon.length; firstIndex += 1) {
    const firstNextIndex = (firstIndex + 1) % polygon.length;
    for (let secondIndex = firstIndex + 1; secondIndex < polygon.length; secondIndex += 1) {
      const secondNextIndex = (secondIndex + 1) % polygon.length;
      const adjacent = firstIndex === secondIndex
        || firstNextIndex === secondIndex
        || secondNextIndex === firstIndex;
      if (adjacent) continue;
      if (segmentsIntersectInclusive(
        polygon[firstIndex],
        polygon[firstNextIndex],
        polygon[secondIndex],
        polygon[secondNextIndex],
      )) return true;
    }
  }
  return false;
}

function projectMeters(point, referenceLatitude) {
  const radians = Math.PI / 180;
  return {
    x: EARTH_RADIUS_METERS * point.lng * radians * Math.cos(referenceLatitude * radians),
    y: EARTH_RADIUS_METERS * point.lat * radians,
  };
}

function distanceToSegmentMeters(point, start, end) {
  const referenceLatitude = (point.lat + start.lat + end.lat) / 3;
  const projectedPoint = projectMeters(point, referenceLatitude);
  const projectedStart = projectMeters(start, referenceLatitude);
  const projectedEnd = projectMeters(end, referenceLatitude);
  const deltaX = projectedEnd.x - projectedStart.x;
  const deltaY = projectedEnd.y - projectedStart.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const position = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((projectedPoint.x - projectedStart.x) * deltaX + (projectedPoint.y - projectedStart.y) * deltaY) / lengthSquared));
  return Math.hypot(
    projectedPoint.x - (projectedStart.x + position * deltaX),
    projectedPoint.y - (projectedStart.y + position * deltaY),
  );
}

function distanceToPolygonBoundaryMeters(point, polygon) {
  if (polygon.length < 3) return Infinity;
  return polygon.reduce((best, current, index) => Math.min(
    best,
    distanceToSegmentMeters(point, current, polygon[(index + 1) % polygon.length]),
  ), Infinity);
}

function segmentTouchesPolygon(start, end, polygon) {
  if (!polygon.length) return true;
  if (pointInPolygon(start, polygon) || pointInPolygon(end, polygon)) return true;
  for (let index = 0; index < polygon.length; index += 1) {
    if (segmentsIntersect(start, end, polygon[index], polygon[(index + 1) % polygon.length])) return true;
  }
  return false;
}

function normalizedStreetName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|circle|cir|place|pl|parkway|pkwy)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function topologyFailure(status, code, message, details = {}) {
  return {
    ok: false,
    status,
    deployable: false,
    code,
    message,
    details,
  };
}

function hasBlockingBarrier(node, blockingBarriers) {
  const barrier = String(node.tags?.barrier || '').toLowerCase();
  return barrier && blockingBarriers.has(barrier);
}

function graphComponents(edgeIds, edgeMap, barrierNodeIds) {
  const nodeEdges = new Map();
  edgeIds.forEach((edgeId) => {
    const edge = edgeMap.get(edgeId);
    edge.nodeIds.forEach((nodeId) => {
      if (barrierNodeIds.has(nodeId)) return;
      nodeEdges.set(nodeId, [...(nodeEdges.get(nodeId) || []), edgeId]);
    });
  });
  nodeEdges.forEach((ids, nodeId) => nodeEdges.set(nodeId, ids.sort(compareIds)));

  const unseen = new Set(edgeIds);
  const components = [];
  while (unseen.size) {
    const seed = [...unseen].sort(compareIds)[0];
    const queue = [seed];
    const component = [];
    unseen.delete(seed);
    while (queue.length) {
      const edgeId = queue.shift();
      component.push(edgeId);
      const edge = edgeMap.get(edgeId);
      edge.nodeIds.forEach((nodeId) => {
        (nodeEdges.get(nodeId) || []).forEach((neighborId) => {
          if (!unseen.has(neighborId)) return;
          unseen.delete(neighborId);
          queue.push(neighborId);
        });
      });
    }
    components.push(component.sort(compareIds));
  }
  return components.sort((left, right) => compareIds(left[0], right[0]));
}

function componentNodeEdges(edgeIds, edgeMap) {
  const nodeEdges = new Map();
  edgeIds.forEach((edgeId) => {
    edgeMap.get(edgeId).nodeIds.forEach((nodeId) => {
      nodeEdges.set(nodeId, [...(nodeEdges.get(nodeId) || []), edgeId]);
    });
  });
  nodeEdges.forEach((ids, nodeId) => nodeEdges.set(nodeId, ids.sort(compareIds)));
  return nodeEdges;
}

function findTwoCoreEdges(edgeIds, edgeMap, barrierNodeIds) {
  const nodeEdges = componentNodeEdges(edgeIds, edgeMap);
  const activeEdges = new Set(edgeIds);
  const activeDegrees = new Map([...nodeEdges.entries()].map(([nodeId, ids]) => [nodeId, barrierNodeIds.has(nodeId) ? 0 : ids.length]));
  const queue = [...activeDegrees.entries()].filter(([, degree]) => degree <= 1).map(([nodeId]) => nodeId).sort(compareIds);

  while (queue.length) {
    const nodeId = queue.shift();
    (nodeEdges.get(nodeId) || []).forEach((edgeId) => {
      if (!activeEdges.has(edgeId)) return;
      activeEdges.delete(edgeId);
      edgeMap.get(edgeId).nodeIds.forEach((endpointId) => {
        if (endpointId === nodeId || barrierNodeIds.has(endpointId)) return;
        const nextDegree = (activeDegrees.get(endpointId) || 0) - 1;
        activeDegrees.set(endpointId, nextDegree);
        if (nextDegree === 1) queue.push(endpointId);
      });
    });
    queue.sort(compareIds);
  }
  return activeEdges;
}

function removedBranchComponents(removedEdgeIds, edgeMap, coreNodeIds, barrierNodeIds) {
  const nodeEdges = componentNodeEdges(removedEdgeIds, edgeMap);
  const unseen = new Set(removedEdgeIds);
  const groups = [];
  while (unseen.size) {
    const seed = [...unseen].sort(compareIds)[0];
    const queue = [seed];
    const group = [];
    unseen.delete(seed);
    while (queue.length) {
      const edgeId = queue.shift();
      group.push(edgeId);
      edgeMap.get(edgeId).nodeIds.forEach((nodeId) => {
        if (coreNodeIds.has(nodeId) || barrierNodeIds.has(nodeId)) return;
        (nodeEdges.get(nodeId) || []).forEach((neighborId) => {
          if (!unseen.has(neighborId)) return;
          unseen.delete(neighborId);
          queue.push(neighborId);
        });
      });
    }
    groups.push(group.sort(compareIds));
  }
  return groups.sort((left, right) => compareIds(left[0], right[0]));
}

function branchMetadata(edgeIds, edgeMap, nodeDegrees, coreNodeIds, terminalNodeIds) {
  const nodes = new Set(edgeIds.flatMap((edgeId) => edgeMap.get(edgeId).nodeIds));
  return {
    edgeIds: [...edgeIds].sort(compareIds),
    terminalNodeIds: [...nodes].filter((nodeId) => terminalNodeIds.has(nodeId) && nodeDegrees.get(nodeId) === 1).sort(compareIds),
    throatNodeIds: [...nodes].filter((nodeId) => coreNodeIds.has(nodeId) || nodeDegrees.get(nodeId) >= 3).sort(compareIds),
  };
}

function findBridgeEdgeIds(edgeIds, edgeMap, barrierNodeIds) {
  const nodeEdges = componentNodeEdges(edgeIds, edgeMap);
  const discovery = new Map();
  const low = new Map();
  const bridgeEdgeIds = new Set();
  let clock = 0;

  const visit = (nodeId, parentEdgeId = null) => {
    clock += 1;
    discovery.set(nodeId, clock);
    low.set(nodeId, clock);
    if (barrierNodeIds.has(nodeId)) return;
    (nodeEdges.get(nodeId) || []).sort(compareIds).forEach((edgeId) => {
      if (edgeId === parentEdgeId) return;
      const edge = edgeMap.get(edgeId);
      const nextNodeId = edge.nodeIds[0] === nodeId ? edge.nodeIds[1] : edge.nodeIds[0];
      if (barrierNodeIds.has(nextNodeId)) {
        bridgeEdgeIds.add(edgeId);
        return;
      }
      if (!discovery.has(nextNodeId)) {
        visit(nextNodeId, edgeId);
        low.set(nodeId, Math.min(low.get(nodeId), low.get(nextNodeId)));
        if (low.get(nextNodeId) > discovery.get(nodeId)) bridgeEdgeIds.add(edgeId);
      } else {
        low.set(nodeId, Math.min(low.get(nodeId), discovery.get(nextNodeId)));
      }
    });
  };

  [...nodeEdges.keys()].sort(compareIds).forEach((nodeId) => {
    if (!discovery.has(nodeId)) visit(nodeId);
  });
  return bridgeEdgeIds;
}

function sideBeyondBridge(startNodeId, bridgeEdgeId, componentEdgeIds, edgeMap, barrierNodeIds) {
  const eligibleEdges = new Set(componentEdgeIds.filter((edgeId) => edgeId !== bridgeEdgeId));
  const nodeEdges = componentNodeEdges([...eligibleEdges], edgeMap);
  const nodeIds = new Set([startNodeId]);
  const sideEdgeIds = new Set();
  const queue = [startNodeId];
  while (queue.length) {
    const nodeId = queue.shift();
    if (barrierNodeIds.has(nodeId)) continue;
    (nodeEdges.get(nodeId) || []).sort(compareIds).forEach((edgeId) => {
      if (!eligibleEdges.has(edgeId)) return;
      sideEdgeIds.add(edgeId);
      const edge = edgeMap.get(edgeId);
      const nextNodeId = edge.nodeIds[0] === nodeId ? edge.nodeIds[1] : edge.nodeIds[0];
      if (nodeIds.has(nextNodeId)) return;
      nodeIds.add(nextNodeId);
      queue.push(nextNodeId);
    });
  }
  return { edgeIds: sideEdgeIds, nodeIds };
}

function hasTerminalNodeSignal(nodeIds, nodeMap) {
  return [...nodeIds].some((nodeId) => {
    const tags = nodeMap.get(nodeId)?.tags || {};
    return String(tags.noexit || '').toLowerCase() === 'yes'
      || String(tags.highway || '').toLowerCase() === 'turning_circle'
      || String(tags.highway || '').toLowerCase() === 'turning_loop';
  });
}

function findTerminalEnclaveBranches(componentEdgeIds, edgeMap, nodeMap, boundaryNodeIds, barrierNodeIds, nodeDegrees) {
  const candidates = [];
  [...findBridgeEdgeIds(componentEdgeIds, edgeMap, barrierNodeIds)].sort(compareIds).forEach((bridgeEdgeId) => {
    const bridge = edgeMap.get(bridgeEdgeId);
    const firstSide = sideBeyondBridge(bridge.nodeIds[0], bridgeEdgeId, componentEdgeIds, edgeMap, barrierNodeIds);
    const secondSide = sideBeyondBridge(bridge.nodeIds[1], bridgeEdgeId, componentEdgeIds, edgeMap, barrierNodeIds);
    const firstHasBoundaryExit = [...firstSide.nodeIds].some((nodeId) => boundaryNodeIds.has(nodeId));
    const secondHasBoundaryExit = [...secondSide.nodeIds].some((nodeId) => boundaryNodeIds.has(nodeId));
    const firstHasTerminalSignal = hasTerminalNodeSignal(firstSide.nodeIds, nodeMap);
    const secondHasTerminalSignal = hasTerminalNodeSignal(secondSide.nodeIds, nodeMap);

    let enclave = null;
    let throatNodeId = null;
    if (firstHasBoundaryExit !== secondHasBoundaryExit) {
      enclave = firstHasBoundaryExit ? secondSide : firstSide;
      throatNodeId = firstHasBoundaryExit ? bridge.nodeIds[0] : bridge.nodeIds[1];
    } else if (!firstHasBoundaryExit && !secondHasBoundaryExit && firstHasTerminalSignal !== secondHasTerminalSignal) {
      enclave = firstHasTerminalSignal ? firstSide : secondSide;
      throatNodeId = firstHasTerminalSignal ? bridge.nodeIds[1] : bridge.nodeIds[0];
    }
    if (!enclave) return;

    const protectedEdgeIds = [...enclave.edgeIds, bridgeEdgeId].sort(compareIds);
    const protectedNodeIds = new Set(protectedEdgeIds.flatMap((edgeId) => edgeMap.get(edgeId).nodeIds));
    const terminalNodeIds = [...protectedNodeIds].filter((nodeId) => (
      nodeDegrees.get(nodeId) === 1 && !boundaryNodeIds.has(nodeId)
    ) || hasTerminalNodeSignal(new Set([nodeId]), nodeMap));
    candidates.push({
      edgeIds: protectedEdgeIds,
      terminalNodeIds: terminalNodeIds.sort(compareIds),
      throatNodeIds: [throatNodeId],
    });
  });

  const accepted = [];
  candidates.sort((left, right) => right.edgeIds.length - left.edgeIds.length || compareIds(left.edgeIds[0], right.edgeIds[0])).forEach((candidate) => {
    if (accepted.some((existing) => candidate.edgeIds.some((edgeId) => existing.edgeIds.includes(edgeId)))) return;
    accepted.push(candidate);
  });
  return accepted.sort((left, right) => compareIds(left.edgeIds[0], right.edgeIds[0]));
}

function findProtectedTerminalBranches(edgeIds, edgeMap, nodeMap, boundaryNodeIds, barrierNodeIds) {
  const protectedGroups = [];
  graphComponents(edgeIds, edgeMap, barrierNodeIds).forEach((componentEdgeIds) => {
    const nodeEdges = componentNodeEdges(componentEdgeIds, edgeMap);
    const nodeDegrees = new Map([...nodeEdges.entries()].map(([nodeId, ids]) => [nodeId, barrierNodeIds.has(nodeId) ? 0 : ids.length]));
    const terminalNodeIds = new Set([...nodeDegrees.entries()]
      .filter(([nodeId, degree]) => degree === 1 && !boundaryNodeIds.has(nodeId) && !barrierNodeIds.has(nodeId))
      .map(([nodeId]) => nodeId));
    const enclaveBranches = findTerminalEnclaveBranches(
      componentEdgeIds,
      edgeMap,
      nodeMap,
      boundaryNodeIds,
      barrierNodeIds,
      nodeDegrees,
    );
    protectedGroups.push(...enclaveBranches);
    const enclaveEdgeIds = new Set(enclaveBranches.flatMap((branch) => branch.edgeIds));
    if (!terminalNodeIds.size) return;

    const coreEdges = findTwoCoreEdges(componentEdgeIds, edgeMap, barrierNodeIds);
    const coreNodeIds = new Set([...coreEdges].flatMap((edgeId) => edgeMap.get(edgeId).nodeIds));
    if (coreEdges.size) {
      const removedEdges = componentEdgeIds.filter((edgeId) => !coreEdges.has(edgeId));
      removedBranchComponents(removedEdges, edgeMap, coreNodeIds, barrierNodeIds).forEach((branchEdgeIds) => {
        if (branchEdgeIds.some((edgeId) => enclaveEdgeIds.has(edgeId))) return;
        const metadata = branchMetadata(branchEdgeIds, edgeMap, nodeDegrees, coreNodeIds, terminalNodeIds);
        const attachmentCount = metadata.throatNodeIds.filter((nodeId) => coreNodeIds.has(nodeId)).length;
        if (metadata.terminalNodeIds.length && attachmentCount <= 1) protectedGroups.push(metadata);
      });
      return;
    }

    const claimed = new Set(enclaveEdgeIds);
    [...terminalNodeIds].sort(compareIds).forEach((terminalNodeId) => {
      const firstEdgeId = (nodeEdges.get(terminalNodeId) || [])[0];
      if (!firstEdgeId || claimed.has(firstEdgeId)) return;
      const path = [];
      let currentNodeId = terminalNodeId;
      let currentEdgeId = firstEdgeId;
      let endNodeId = terminalNodeId;
      while (currentEdgeId && !claimed.has(currentEdgeId)) {
        path.push(currentEdgeId);
        const edge = edgeMap.get(currentEdgeId);
        const nextNodeId = edge.nodeIds[0] === currentNodeId ? edge.nodeIds[1] : edge.nodeIds[0];
        endNodeId = nextNodeId;
        if (barrierNodeIds.has(nextNodeId) || boundaryNodeIds.has(nextNodeId) || nodeDegrees.get(nextNodeId) !== 2) break;
        const nextEdgeId = (nodeEdges.get(nextNodeId) || []).find((edgeId) => edgeId !== currentEdgeId && !claimed.has(edgeId));
        currentNodeId = nextNodeId;
        currentEdgeId = nextEdgeId;
      }
      const terminalNode = nodeMap.get(terminalNodeId);
      const explicitlyTerminal = String(terminalNode?.tags?.noexit || '').toLowerCase() === 'yes';
      if (path.length && (nodeDegrees.get(endNodeId) >= 3 || explicitlyTerminal)) {
        path.forEach((edgeId) => claimed.add(edgeId));
        protectedGroups.push(branchMetadata(path, edgeMap, nodeDegrees, new Set([endNodeId]), terminalNodeIds));
      }
    });
  });
  return protectedGroups.sort((left, right) => compareIds(left.edgeIds[0], right.edgeIds[0]));
}

function decomposeRemainingChains(edgeIds, edgeMap, claimedEdgeIds, protectedNodeIds, boundaryNodeIds, barrierNodeIds) {
  const remainingEdgeIds = edgeIds.filter((edgeId) => !claimedEdgeIds.has(edgeId));
  if (!remainingEdgeIds.length) return [];
  const nodeEdges = componentNodeEdges(remainingEdgeIds, edgeMap);
  const anchors = new Set([...nodeEdges.entries()]
    .filter(([nodeId, ids]) => ids.length !== 2
      || protectedNodeIds.has(nodeId)
      || boundaryNodeIds.has(nodeId)
      || barrierNodeIds.has(nodeId))
    .map(([nodeId]) => nodeId));
  const unseen = new Set(remainingEdgeIds);
  const groups = [];

  const trace = (startNodeId, startEdgeId) => {
    const path = [];
    let currentNodeId = startNodeId;
    let currentEdgeId = startEdgeId;
    while (currentEdgeId && unseen.has(currentEdgeId)) {
      unseen.delete(currentEdgeId);
      path.push(currentEdgeId);
      const edge = edgeMap.get(currentEdgeId);
      const nextNodeId = edge.nodeIds[0] === currentNodeId ? edge.nodeIds[1] : edge.nodeIds[0];
      if (anchors.has(nextNodeId)) break;
      const nextEdgeId = (nodeEdges.get(nextNodeId) || []).find((edgeId) => unseen.has(edgeId));
      currentNodeId = nextNodeId;
      currentEdgeId = nextEdgeId;
    }
    if (path.length) groups.push(path.sort(compareIds));
  };

  [...anchors].sort(compareIds).forEach((nodeId) => {
    (nodeEdges.get(nodeId) || []).filter((edgeId) => unseen.has(edgeId)).sort(compareIds).forEach((edgeId) => trace(nodeId, edgeId));
  });
  while (unseen.size) {
    const edgeId = [...unseen].sort(compareIds)[0];
    trace(edgeMap.get(edgeId).nodeIds[0], edgeId);
  }
  return groups.sort((left, right) => compareIds(left[0], right[0]));
}

function createWorkUnit(edgeIds, edgeMap, metadata = {}) {
  const sortedEdgeIds = [...edgeIds].sort(compareIds);
  const signature = sortedEdgeIds.join('|');
  const edges = sortedEdgeIds.map((edgeId) => edgeMap.get(edgeId));
  const nodeIds = [...new Set(edges.flatMap((edge) => edge.nodeIds))].sort(compareIds);
  const streetNames = [...new Set(edges.flatMap((edge) => edge.streetNames))].sort(compareIds);
  return {
    id: `work-unit:${stableHash(signature)}`,
    signature,
    kind: metadata.protected ? 'terminal_to_throat_branch' : 'street_chain',
    protected: Boolean(metadata.protected),
    edgeIds: sortedEdgeIds,
    nodeIds,
    terminalNodeIds: [...(metadata.terminalNodeIds || [])].sort(compareIds),
    throatNodeIds: [...(metadata.throatNodeIds || [])].sort(compareIds),
    streetNames,
    segments: edges.map((edge) => ({
      edgeId: edge.id,
      start: edge.start,
      end: edge.end,
      streetNames: edge.streetNames,
      highwayTypes: edge.highwayTypes,
    })),
    doorIds: [],
    doorCount: 0,
    neighborIds: [],
  };
}

function buildUnitNeighbors(units, barrierNodeIds) {
  const nodeUnits = new Map();
  units.forEach((unit) => unit.nodeIds.forEach((nodeId) => {
    if (barrierNodeIds.has(nodeId)) return;
    nodeUnits.set(nodeId, [...(nodeUnits.get(nodeId) || []), unit.id]);
  }));
  const neighbors = new Map(units.map((unit) => [unit.id, new Set()]));
  nodeUnits.forEach((unitIds) => unitIds.forEach((unitId) => unitIds.forEach((neighborId) => {
    if (unitId !== neighborId) neighbors.get(unitId).add(neighborId);
  })));
  return new Map([...neighbors.entries()].map(([unitId, ids]) => [unitId, [...ids].sort(compareIds)]));
}

function connectedUnitComponents(units) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const unseen = new Set(byId.keys());
  const components = [];
  while (unseen.size) {
    const seed = [...unseen].sort(compareIds)[0];
    const queue = [seed];
    const component = [];
    unseen.delete(seed);
    while (queue.length) {
      const unitId = queue.shift();
      component.push(unitId);
      (byId.get(unitId)?.neighborIds || []).forEach((neighborId) => {
        if (!unseen.has(neighborId)) return;
        unseen.delete(neighborId);
        queue.push(neighborId);
      });
    }
    components.push(component.sort(compareIds));
  }
  return components.sort((left, right) => compareIds(left[0], right[0]));
}

function normalizeDoors(doors) {
  if (!Array.isArray(doors) || !doors.length) {
    return topologyFailure('blocked', 'DOORS_REQUIRED', 'Canvas street zoning requires address-level doors with stable IDs.');
  }
  const normalized = [];
  const invalid = [];
  const duplicateIds = new Set();
  const seen = new Set();
  doors.forEach((door, index) => {
    const id = canonicalId(door?.id ?? door?.stable_id ?? door?.address_hash ?? door?.property_id);
    const point = pointFrom(door);
    if (!id || !point) {
      invalid.push(index);
      return;
    }
    if (seen.has(id)) duplicateIds.add(id);
    seen.add(id);
    normalized.push({
      id,
      ...point,
      streetName: String(door?.streetName ?? door?.street_name ?? door?.street ?? ''),
      explicitEdgeId: canonicalId(door?.roadEdgeId ?? door?.road_edge_id ?? door?.edgeId),
      explicitWayId: canonicalId(door?.roadWayId ?? door?.road_way_id ?? door?.wayId),
    });
  });
  if (invalid.length || duplicateIds.size) {
    return topologyFailure('blocked', 'INVALID_DOOR_IDENTITIES', 'Every door must have a unique stable ID and valid coordinates.', {
      invalidIndexes: invalid,
      duplicateDoorIds: [...duplicateIds].sort(compareIds),
    });
  }
  return { ok: true, doors: normalized.sort((left, right) => compareIds(left.id, right.id)) };
}

function parseRoadGraph({
  roadNetwork,
  polygon,
  allowedHighways,
  barrierNodeIds: explicitBarrierNodeIds,
  barrierWayIds: explicitBarrierWayIds,
  blockedEdgeIds: explicitBlockedEdgeIds,
  inferOsmBarriers,
  blockingBarrierValues,
  boundaryNodeIds: explicitBoundaryNodeIds,
  boundarySnapToleranceMeters,
}) {
  if (!Array.isArray(roadNetwork?.elements) || !roadNetwork.elements.length) {
    return topologyFailure('blocked', 'ROAD_NETWORK_REQUIRED', 'No usable OSM road network was supplied. Canvas cannot deploy a geometry fallback.');
  }
  const allowed = new Set((allowedHighways || [...DEFAULT_ALLOWED_HIGHWAYS]).map((value) => String(value).toLowerCase()));
  const blockingBarriers = new Set((blockingBarrierValues || [...DEFAULT_BLOCKING_BARRIERS]).map((value) => String(value).toLowerCase()));
  const barrierNodeIds = new Set((explicitBarrierNodeIds || []).map(canonicalId).filter(Boolean));
  const barrierWayIds = new Set((explicitBarrierWayIds || []).map(canonicalId).filter(Boolean));
  const blockedEdgeIds = new Set((explicitBlockedEdgeIds || []).map(String));
  const boundaryNodeIds = new Set((explicitBoundaryNodeIds || []).map(canonicalId).filter(Boolean));
  const nodeMap = new Map();
  const ways = [];

  [...roadNetwork.elements].sort((left, right) => {
    const typeComparison = String(left?.type).localeCompare(String(right?.type));
    return typeComparison || compareIds(left?.id, right?.id);
  }).forEach((element) => {
    const id = canonicalId(element?.id);
    if (element?.type === 'node' && id) {
      const point = pointFrom(element);
      if (!point) return;
      const node = { id, ...point, tags: element.tags || {} };
      nodeMap.set(id, node);
      if (inferOsmBarriers !== false && hasBlockingBarrier(node, blockingBarriers)) barrierNodeIds.add(id);
    } else if (element?.type === 'way' && id) {
      ways.push({ ...element, canonicalId: id });
    }
  });

  const malformedWayIds = [];
  const edgeMap = new Map();
  ways.forEach((way) => {
    const highway = String(way.tags?.highway || '').toLowerCase();
    if (!allowed.has(highway)) return;
    if (barrierWayIds.has(way.canonicalId) || (inferOsmBarriers !== false && way.tags?.barrier)) return;
    if (!Array.isArray(way.nodes) || way.nodes.length < 2) {
      malformedWayIds.push(way.canonicalId);
      return;
    }
    const nodeIds = way.nodes.map(canonicalId);
    if (nodeIds.some((nodeId) => !nodeId || !nodeMap.has(nodeId))) {
      malformedWayIds.push(way.canonicalId);
      return;
    }
    for (let index = 0; index < nodeIds.length - 1; index += 1) {
      const leftId = nodeIds[index];
      const rightId = nodeIds[index + 1];
      if (leftId === rightId) continue;
      const id = edgeIdFor(leftId, rightId);
      if (blockedEdgeIds.has(id)) continue;
      const start = nodeMap.get(leftId);
      const end = nodeMap.get(rightId);
      if (polygon.length && !segmentTouchesPolygon(start, end, polygon)) continue;
      const existing = edgeMap.get(id);
      const streetName = String(way.tags?.name || '').trim();
      if (existing) {
        existing.wayIds = [...new Set([...existing.wayIds, way.canonicalId])].sort(compareIds);
        existing.streetNames = [...new Set([...existing.streetNames, streetName].filter(Boolean))].sort(compareIds);
        existing.highwayTypes = [...new Set([...existing.highwayTypes, highway])].sort(compareIds);
      } else {
        const sortedNodeIds = [leftId, rightId].sort(compareIds);
        edgeMap.set(id, {
          id,
          nodeIds: sortedNodeIds,
          start: nodeMap.get(sortedNodeIds[0]),
          end: nodeMap.get(sortedNodeIds[1]),
          wayIds: [way.canonicalId],
          streetNames: streetName ? [streetName] : [],
          highwayTypes: [highway],
        });
      }
    }
  });

  if (malformedWayIds.length) {
    return topologyFailure('blocked', 'MALFORMED_ROAD_NETWORK', 'One or more eligible OSM ways reference missing or invalid nodes.', {
      malformedWayIds: [...new Set(malformedWayIds)].sort(compareIds),
    });
  }
  if (!edgeMap.size) {
    return topologyFailure('blocked', 'NO_ELIGIBLE_ROADS', 'The selected polygon contains no eligible street segments.');
  }

  if (polygon.length) {
    nodeMap.forEach((node, nodeId) => {
      if (!pointInPolygon(node, polygon)
        || distanceToPolygonBoundaryMeters(node, polygon) <= boundarySnapToleranceMeters) boundaryNodeIds.add(nodeId);
    });
  }
  return {
    ok: true,
    nodeMap,
    edgeMap,
    barrierNodeIds,
    boundaryNodeIds,
  };
}

function snapDoorsToUnits(
  doors,
  edgeMap,
  units,
  maxSnapDistanceMeters,
  roadSnapAmbiguityMeters,
  roadSnapAmbiguityRatio,
) {
  const edgeToUnit = new Map();
  units.forEach((unit) => unit.edgeIds.forEach((edgeId) => edgeToUnit.set(edgeId, unit.id)));
  const edges = [...edgeMap.values()].sort((left, right) => compareIds(left.id, right.id));
  const snaps = [];
  const unsnappedDoorIds = [];
  const streetNameFallbackDoorIds = [];
  const ambiguousSnaps = [];

  doors.forEach((door) => {
    let candidates = edges;
    const hasExplicitRoadLink = Boolean(door.explicitEdgeId || door.explicitWayId);
    if (door.explicitEdgeId) candidates = candidates.filter((edge) => edge.id === door.explicitEdgeId);
    else if (door.explicitWayId) candidates = candidates.filter((edge) => edge.wayIds.includes(door.explicitWayId));

    const normalizedName = normalizedStreetName(door.streetName);
    let streetNameResolved = false;
    if (!door.explicitEdgeId && !door.explicitWayId && normalizedName) {
      const namedCandidates = candidates.filter((edge) => edge.streetNames.some((name) => normalizedStreetName(name) === normalizedName));
      if (namedCandidates.length) {
        candidates = namedCandidates;
        const namedUnitIds = new Set(namedCandidates.map((edge) => edgeToUnit.get(edge.id)).filter(Boolean));
        streetNameResolved = namedUnitIds.size === 1;
      }
      else streetNameFallbackDoorIds.push(door.id);
    }

    const ranked = candidates.map((edge) => ({
      edge,
      distanceMeters: distanceToSegmentMeters(door, edge.start, edge.end),
    })).sort((left, right) => left.distanceMeters - right.distanceMeters || compareIds(left.edge.id, right.edge.id));
    const selected = ranked[0];
    if (!selected || selected.distanceMeters > maxSnapDistanceMeters || !edgeToUnit.has(selected.edge.id)) {
      unsnappedDoorIds.push(door.id);
      return;
    }

    if (!hasExplicitRoadLink && !streetNameResolved) {
      const nearestByUnit = [];
      const seenUnitIds = new Set();
      ranked.forEach((candidate) => {
        const workUnitId = edgeToUnit.get(candidate.edge.id);
        if (!workUnitId || seenUnitIds.has(workUnitId)) return;
        seenUnitIds.add(workUnitId);
        nearestByUnit.push({ ...candidate, workUnitId });
      });
      const nearest = nearestByUnit[0];
      const competing = nearestByUnit[1];
      if (nearest && competing && competing.distanceMeters <= maxSnapDistanceMeters) {
        const distanceGapMeters = competing.distanceMeters - nearest.distanceMeters;
        const distanceRatio = nearest.distanceMeters <= 0.01
          ? (competing.distanceMeters <= 0.01 ? 1 : Number.POSITIVE_INFINITY)
          : competing.distanceMeters / nearest.distanceMeters;
        if (distanceGapMeters <= roadSnapAmbiguityMeters && distanceRatio <= roadSnapAmbiguityRatio) {
          const candidateDetails = (candidate) => ({
            workUnitId: candidate.workUnitId,
            edgeId: candidate.edge.id,
            distanceMeters: Number(candidate.distanceMeters.toFixed(2)),
            streetNames: [...candidate.edge.streetNames].sort(compareIds),
          });
          ambiguousSnaps.push({
            doorId: door.id,
            resolutionBasis: normalizedName ? 'unresolved_street_name' : 'spatial_only',
            nearest: candidateDetails(nearest),
            competing: candidateDetails(competing),
            distanceGapMeters: Number(distanceGapMeters.toFixed(2)),
            distanceRatio: Number(distanceRatio.toFixed(3)),
          });
        }
      }
    }
    snaps.push({
      doorId: door.id,
      edgeId: selected.edge.id,
      workUnitId: edgeToUnit.get(selected.edge.id),
      distanceMeters: Number(selected.distanceMeters.toFixed(2)),
    });
  });
  if (unsnappedDoorIds.length) {
    return topologyFailure('blocked', 'UNSNAPPED_DOORS', 'One or more doors could not be safely matched to the supplied road network.', {
      unsnappedDoorIds: unsnappedDoorIds.sort(compareIds),
      maxSnapDistanceMeters,
    });
  }
  if (ambiguousSnaps.length) {
    return topologyFailure('blocked', 'AMBIGUOUS_DOOR_SNAPS', 'One or more doors are similarly close to different street work units, so ownership cannot be verified safely.', {
      ambiguousDoorIds: ambiguousSnaps.map((snap) => snap.doorId).sort(compareIds),
      ambiguousSnaps: ambiguousSnaps.sort((left, right) => compareIds(left.doorId, right.doorId)),
      thresholds: {
        maxSnapDistanceMeters,
        roadSnapAmbiguityMeters,
        roadSnapAmbiguityRatio,
      },
    });
  }
  return {
    ok: true,
    snaps: snaps.sort((left, right) => compareIds(left.doorId, right.doorId)),
    streetNameFallbackDoorIds: [...new Set(streetNameFallbackDoorIds)].sort(compareIds),
  };
}

/**
 * Converts an OSM-like graph and stable door points into indivisible street work units.
 * Terminal branches are atomic from their terminal node through their topology throat.
 * The result is JSON-serializable and independent of input ordering.
 */
export function buildCanvasStreetWorkUnits(input = {}) {
  const polygon = normalizePolygon(input.polygon);
  if (input.polygon && polygonSelfIntersects(polygon)) {
    return topologyFailure('blocked', 'SELF_INTERSECTING_POLYGON', 'Canvas requires a simple polygon whose boundary does not cross or touch itself.');
  }
  if (input.polygon && (polygon.length < 3 || Math.abs(signedPolygonArea(polygon)) <= COORDINATE_EPSILON)) {
    return topologyFailure('blocked', 'INVALID_POLYGON', 'Canvas requires a valid, non-zero-area polygon.');
  }
  const normalizedDoors = normalizeDoors(input.doors);
  if (!normalizedDoors.ok) return normalizedDoors;
  if (polygon.length) {
    const outsideDoorIds = normalizedDoors.doors
      .filter((door) => !pointInPolygon(door, polygon) && distanceToPolygonBoundaryMeters(door, polygon) > 1)
      .map((door) => door.id);
    if (outsideDoorIds.length) {
      return topologyFailure('blocked', 'DOORS_OUTSIDE_POLYGON', 'Door input contains homes outside the selected Canvas polygon.', {
        outsideDoorIds: outsideDoorIds.sort(compareIds),
      });
    }
  }

  const maxSnapDistanceMeters = Number(input.maxSnapDistanceMeters ?? 150);
  const boundarySnapToleranceMeters = Number(input.boundarySnapToleranceMeters ?? 30);
  const roadSnapAmbiguityMeters = Number(input.roadSnapAmbiguityMeters ?? input.road_snap_ambiguity_meters ?? 12);
  const roadSnapAmbiguityRatio = Number(input.roadSnapAmbiguityRatio ?? input.road_snap_ambiguity_ratio ?? 1.5);
  if (!Number.isFinite(maxSnapDistanceMeters) || maxSnapDistanceMeters <= 0
    || !Number.isFinite(boundarySnapToleranceMeters) || boundarySnapToleranceMeters < 0
    || !Number.isFinite(roadSnapAmbiguityMeters) || roadSnapAmbiguityMeters < 0
    || !Number.isFinite(roadSnapAmbiguityRatio) || roadSnapAmbiguityRatio < 1) {
    return topologyFailure('blocked', 'INVALID_TOPOLOGY_OPTIONS', 'Snap distances and ambiguity thresholds must be finite; the ambiguity ratio must be at least 1.');
  }
  const graphResult = parseRoadGraph({
    ...input,
    polygon,
    maxSnapDistanceMeters,
    boundarySnapToleranceMeters,
  });
  if (!graphResult.ok) return graphResult;

  const { nodeMap, edgeMap, barrierNodeIds, boundaryNodeIds } = graphResult;
  const edgeIds = [...edgeMap.keys()].sort(compareIds);
  const protectedBranches = findProtectedTerminalBranches(
    edgeIds,
    edgeMap,
    nodeMap,
    boundaryNodeIds,
    barrierNodeIds,
  );
  const claimedEdgeIds = new Set(protectedBranches.flatMap((branch) => branch.edgeIds));
  const protectedNodeIds = new Set(protectedBranches.flatMap((branch) => branch.edgeIds.flatMap((edgeId) => edgeMap.get(edgeId).nodeIds)));
  const chainGroups = decomposeRemainingChains(
    edgeIds,
    edgeMap,
    claimedEdgeIds,
    protectedNodeIds,
    boundaryNodeIds,
    barrierNodeIds,
  );
  let workUnits = [
    ...protectedBranches.map((branch) => createWorkUnit(branch.edgeIds, edgeMap, { ...branch, protected: true })),
    ...chainGroups.map((group) => createWorkUnit(group, edgeMap)),
  ].sort((left, right) => compareIds(left.id, right.id));

  const unitIds = new Set();
  const duplicateUnitIds = [];
  workUnits.forEach((unit) => {
    if (unitIds.has(unit.id)) duplicateUnitIds.push(unit.id);
    unitIds.add(unit.id);
  });
  if (duplicateUnitIds.length) {
    return topologyFailure('blocked', 'WORK_UNIT_ID_COLLISION', 'Stable work-unit IDs collided; deployment is blocked.', {
      duplicateUnitIds: [...new Set(duplicateUnitIds)].sort(compareIds),
    });
  }
  const coveredEdges = workUnits.flatMap((unit) => unit.edgeIds);
  if (coveredEdges.length !== edgeIds.length || new Set(coveredEdges).size !== edgeIds.length) {
    return topologyFailure('blocked', 'ATOMIC_COVERAGE_INVALID', 'Street edges were not covered by exactly one atomic work unit.');
  }

  const snapped = snapDoorsToUnits(
    normalizedDoors.doors,
    edgeMap,
    workUnits,
    maxSnapDistanceMeters,
    roadSnapAmbiguityMeters,
    roadSnapAmbiguityRatio,
  );
  if (!snapped.ok) return snapped;
  const snapsByUnit = new Map();
  snapped.snaps.forEach((snap) => snapsByUnit.set(snap.workUnitId, [...(snapsByUnit.get(snap.workUnitId) || []), snap.doorId]));
  workUnits = workUnits.map((unit) => {
    const doorIds = [...(snapsByUnit.get(unit.id) || [])].sort(compareIds);
    return { ...unit, doorIds, doorCount: doorIds.length };
  });

  const finalNeighbors = buildUnitNeighbors(workUnits, barrierNodeIds);
  workUnits = workUnits.map((unit) => ({ ...unit, neighborIds: finalNeighbors.get(unit.id) || [] }));

  return {
    ok: true,
    status: snapped.streetNameFallbackDoorIds.length ? 'degraded' : 'ready',
    workUnits,
    doorSnaps: snapped.snaps,
    components: connectedUnitComponents(workUnits),
    barriers: {
      nodeIds: [...barrierNodeIds].sort(compareIds),
    },
    warnings: snapped.streetNameFallbackDoorIds.length ? [{
      code: 'STREET_NAME_FALLBACK',
      message: 'Some door street names did not match OSM names; those doors used nearest-road snapping.',
      doorIds: snapped.streetNameFallbackDoorIds,
    }] : [],
    diagnostics: {
      roadNodeCount: nodeMap.size,
      roadEdgeCount: edgeMap.size,
      workUnitCount: workUnits.length,
      protectedTerminalBranchCount: workUnits.filter((unit) => unit.protected).length,
      componentCount: connectedUnitComponents(workUnits).length,
    },
  };
}

export const canvasStreetTopologyInternals = Object.freeze({
  edgeIdFor,
});
