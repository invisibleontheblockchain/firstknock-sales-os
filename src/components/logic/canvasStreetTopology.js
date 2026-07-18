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

const HIGHWAY_WORKLOAD_WEIGHTS = Object.freeze({
  residential: 1,
  living_street: 1,
  unclassified: 0.8,
  road: 0.8,
  service: 0.65,
  tertiary: 0.3,
  secondary: 0.15,
  primary: 0.05,
});

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

function segmentLengthMeters(start, end) {
  const referenceLatitude = (Number(start.lat) + Number(end.lat)) / 2;
  const projectedStart = projectMeters(start, referenceLatitude);
  const projectedEnd = projectMeters(end, referenceLatitude);
  return Math.hypot(projectedEnd.x - projectedStart.x, projectedEnd.y - projectedStart.y);
}

function distanceToPolygonBoundaryMeters(point, polygon) {
  if (polygon.length < 3) return Infinity;
  return polygon.reduce((best, current, index) => Math.min(
    best,
    distanceToSegmentMeters(point, current, polygon[(index + 1) % polygon.length]),
  ), Infinity);
}

function pointInPolygonInclusive(point, polygon) {
  if (pointInPolygon(point, polygon)) return true;
  return polygon.some((start, index) => pointOnSegment(point, start, polygon[(index + 1) % polygon.length]));
}

function cross2d(firstX, firstY, secondX, secondY) {
  return firstX * secondY - firstY * secondX;
}

function interpolatePoint(start, end, position) {
  return {
    lat: Number(start.lat) + (Number(end.lat) - Number(start.lat)) * position,
    lng: Number(start.lng) + (Number(end.lng) - Number(start.lng)) * position,
  };
}

function clippedSegmentIntervals(start, end, polygon) {
  if (!polygon.length) return [{ start, end, startPosition: 0, endPosition: 1 }];
  const deltaLng = Number(end.lng) - Number(start.lng);
  const deltaLat = Number(end.lat) - Number(start.lat);
  const lengthSquared = deltaLng * deltaLng + deltaLat * deltaLat;
  if (lengthSquared <= COORDINATE_EPSILON * COORDINATE_EPSILON) return [];
  const positions = [0, 1];
  const addPosition = (value) => {
    if (!Number.isFinite(value) || value < -COORDINATE_EPSILON || value > 1 + COORDINATE_EPSILON) return;
    const clamped = Math.max(0, Math.min(1, value));
    if (!positions.some((existing) => Math.abs(existing - clamped) <= COORDINATE_EPSILON)) positions.push(clamped);
  };

  polygon.forEach((boundaryStart, index) => {
    const boundaryEnd = polygon[(index + 1) % polygon.length];
    const boundaryDeltaLng = Number(boundaryEnd.lng) - Number(boundaryStart.lng);
    const boundaryDeltaLat = Number(boundaryEnd.lat) - Number(boundaryStart.lat);
    const offsetLng = Number(boundaryStart.lng) - Number(start.lng);
    const offsetLat = Number(boundaryStart.lat) - Number(start.lat);
    const denominator = cross2d(deltaLng, deltaLat, boundaryDeltaLng, boundaryDeltaLat);
    if (Math.abs(denominator) <= COORDINATE_EPSILON) {
      if (Math.abs(cross2d(offsetLng, offsetLat, deltaLng, deltaLat)) > COORDINATE_EPSILON) return;
      const firstPosition = (offsetLng * deltaLng + offsetLat * deltaLat) / lengthSquared;
      const secondOffsetLng = Number(boundaryEnd.lng) - Number(start.lng);
      const secondOffsetLat = Number(boundaryEnd.lat) - Number(start.lat);
      const secondPosition = (secondOffsetLng * deltaLng + secondOffsetLat * deltaLat) / lengthSquared;
      const overlapStart = Math.max(0, Math.min(firstPosition, secondPosition));
      const overlapEnd = Math.min(1, Math.max(firstPosition, secondPosition));
      if (overlapEnd >= overlapStart - COORDINATE_EPSILON) {
        addPosition(overlapStart);
        addPosition(overlapEnd);
      }
      return;
    }
    const segmentPosition = cross2d(offsetLng, offsetLat, boundaryDeltaLng, boundaryDeltaLat) / denominator;
    const boundaryPosition = cross2d(offsetLng, offsetLat, deltaLng, deltaLat) / denominator;
    if (boundaryPosition >= -COORDINATE_EPSILON && boundaryPosition <= 1 + COORDINATE_EPSILON) {
      addPosition(segmentPosition);
    }
  });

  positions.sort((left, right) => left - right);
  const intervals = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const startPosition = positions[index];
    const endPosition = positions[index + 1];
    if (endPosition - startPosition <= COORDINATE_EPSILON) continue;
    const midpoint = interpolatePoint(start, end, (startPosition + endPosition) / 2);
    if (!pointInPolygonInclusive(midpoint, polygon)) continue;
    intervals.push({
      start: startPosition <= COORDINATE_EPSILON ? start : interpolatePoint(start, end, startPosition),
      end: endPosition >= 1 - COORDINATE_EPSILON ? end : interpolatePoint(start, end, endPosition),
      startPosition,
      endPosition,
    });
  }
  return intervals;
}

function virtualBoundaryNodeId(point) {
  return `clip-node:${Number(point.lat).toFixed(12)}:${Number(point.lng).toFixed(12)}`;
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
  const orderedEdgeIds = [...edgeIds].sort(compareIds);
  let seedIndex = 0;
  const components = [];
  while (unseen.size) {
    while (seedIndex < orderedEdgeIds.length && !unseen.has(orderedEdgeIds[seedIndex])) seedIndex += 1;
    const seed = orderedEdgeIds[seedIndex];
    seedIndex += 1;
    const queue = [seed];
    const component = [];
    unseen.delete(seed);
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const edgeId = queue[queueIndex];
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

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const nodeId = queue[queueIndex];
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
  }
  return activeEdges;
}

function removedBranchComponents(removedEdgeIds, edgeMap, coreNodeIds, barrierNodeIds) {
  const nodeEdges = componentNodeEdges(removedEdgeIds, edgeMap);
  const unseen = new Set(removedEdgeIds);
  const orderedEdgeIds = [...removedEdgeIds].sort(compareIds);
  let seedIndex = 0;
  const groups = [];
  while (unseen.size) {
    while (seedIndex < orderedEdgeIds.length && !unseen.has(orderedEdgeIds[seedIndex])) seedIndex += 1;
    const seed = orderedEdgeIds[seedIndex];
    seedIndex += 1;
    const queue = [seed];
    const group = [];
    unseen.delete(seed);
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const edgeId = queue[queueIndex];
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

  [...nodeEdges.keys()].sort(compareIds).forEach((nodeId) => {
    if (discovery.has(nodeId)) return;
    clock += 1;
    discovery.set(nodeId, clock);
    low.set(nodeId, clock);
    if (barrierNodeIds.has(nodeId)) return;
    const stack = [{ nodeId, parentEdgeId: null, edgeIndex: 0, edges: nodeEdges.get(nodeId) || [] }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.edgeIndex >= frame.edges.length) {
        stack.pop();
        if (!stack.length || frame.parentEdgeId === null) continue;
        const parent = stack[stack.length - 1];
        low.set(parent.nodeId, Math.min(low.get(parent.nodeId), low.get(frame.nodeId)));
        if (low.get(frame.nodeId) > discovery.get(parent.nodeId)) bridgeEdgeIds.add(frame.parentEdgeId);
        continue;
      }
      const edgeId = frame.edges[frame.edgeIndex];
      frame.edgeIndex += 1;
      if (edgeId === frame.parentEdgeId) continue;
      const edge = edgeMap.get(edgeId);
      const nextNodeId = edge.nodeIds[0] === frame.nodeId ? edge.nodeIds[1] : edge.nodeIds[0];
      if (barrierNodeIds.has(nextNodeId)) {
        bridgeEdgeIds.add(edgeId);
        continue;
      }
      if (!discovery.has(nextNodeId)) {
        clock += 1;
        discovery.set(nextNodeId, clock);
        low.set(nextNodeId, clock);
        stack.push({
          nodeId: nextNodeId,
          parentEdgeId: edgeId,
          edgeIndex: 0,
          edges: nodeEdges.get(nextNodeId) || [],
        });
        continue;
      }
      low.set(frame.nodeId, Math.min(low.get(frame.nodeId), discovery.get(nextNodeId)));
    }
  });
  return bridgeEdgeIds;
}

function hasTerminalNodeSignal(nodeId, nodeMap) {
  const tags = nodeMap.get(nodeId)?.tags || {};
  return String(tags.noexit || '').toLowerCase() === 'yes'
    || String(tags.highway || '').toLowerCase() === 'turning_circle'
    || String(tags.highway || '').toLowerCase() === 'turning_loop';
}

function terminalEnclaveCandidate(edgeIds, throatNodeId, edgeMap, nodeMap, boundaryNodeIds, nodeDegrees) {
  const protectedEdgeIds = [...edgeIds].sort(compareIds);
  const protectedNodeIds = new Set(protectedEdgeIds.flatMap((edgeId) => edgeMap.get(edgeId).nodeIds));
  const terminalNodeIds = [...protectedNodeIds].filter((nodeId) => (
    nodeDegrees.get(nodeId) === 1 && !boundaryNodeIds.has(nodeId)
  ) || hasTerminalNodeSignal(nodeId, nodeMap));
  return {
    edgeIds: protectedEdgeIds,
    terminalNodeIds: terminalNodeIds.sort(compareIds),
    throatNodeIds: [throatNodeId],
  };
}

function findTerminalEnclaveBranches(componentEdgeIds, edgeMap, nodeMap, boundaryNodeIds, barrierNodeIds, nodeDegrees) {
  const bridgeEdgeIds = findBridgeEdgeIds(componentEdgeIds, edgeMap, barrierNodeIds);
  if (!bridgeEdgeIds.size) return [];

  // Collapse every non-bridge region into one block. The remaining bridges form
  // a tree, so each bridge side can be described by one subtree interval rather
  // than rediscovered with a graph traversal for every bridge.
  const componentNodeIds = [...new Set(componentEdgeIds.flatMap((edgeId) => edgeMap.get(edgeId).nodeIds))].sort(compareIds);
  const disjointParent = new Map(componentNodeIds.map((nodeId) => [nodeId, nodeId]));
  const findRoot = (nodeId) => {
    let root = nodeId;
    while (disjointParent.get(root) !== root) root = disjointParent.get(root);
    let current = nodeId;
    while (disjointParent.get(current) !== current) {
      const next = disjointParent.get(current);
      disjointParent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (leftNodeId, rightNodeId) => {
    const leftRoot = findRoot(leftNodeId);
    const rightRoot = findRoot(rightNodeId);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort(compareIds);
    disjointParent.set(second, first);
  };
  componentEdgeIds.forEach((edgeId) => {
    if (bridgeEdgeIds.has(edgeId)) return;
    const edge = edgeMap.get(edgeId);
    union(edge.nodeIds[0], edge.nodeIds[1]);
  });

  const blocks = new Map();
  componentNodeIds.forEach((nodeId) => {
    const blockId = findRoot(nodeId);
    if (!blocks.has(blockId)) {
      blocks.set(blockId, {
        id: blockId,
        nodeIds: [],
        internalEdgeIds: [],
        bridges: [],
        boundarySignalCount: 0,
        terminalSignalCount: 0,
      });
    }
    const block = blocks.get(blockId);
    block.nodeIds.push(nodeId);
    if (boundaryNodeIds.has(nodeId)) block.boundarySignalCount += 1;
    if (hasTerminalNodeSignal(nodeId, nodeMap)) block.terminalSignalCount += 1;
  });
  componentEdgeIds.forEach((edgeId) => {
    const edge = edgeMap.get(edgeId);
    const firstBlockId = findRoot(edge.nodeIds[0]);
    if (!bridgeEdgeIds.has(edgeId)) {
      blocks.get(firstBlockId).internalEdgeIds.push(edgeId);
      return;
    }
    const secondBlockId = findRoot(edge.nodeIds[1]);
    if (firstBlockId === secondBlockId) return;
    blocks.get(firstBlockId).bridges.push({
      edgeId,
      neighborBlockId: secondBlockId,
      localNodeId: edge.nodeIds[0],
      remoteNodeId: edge.nodeIds[1],
    });
    blocks.get(secondBlockId).bridges.push({
      edgeId,
      neighborBlockId: firstBlockId,
      localNodeId: edge.nodeIds[1],
      remoteNodeId: edge.nodeIds[0],
    });
  });
  blocks.forEach((block) => {
    block.internalEdgeIds.sort(compareIds);
    block.bridges.sort((left, right) => compareIds(left.edgeId, right.edgeId));
  });

  const orderedBlocks = [...blocks.values()].sort((left, right) => compareIds(left.id, right.id));
  const totalBoundarySignals = orderedBlocks.reduce((sum, block) => sum + block.boundarySignalCount, 0);
  const totalTerminalSignals = orderedBlocks.reduce((sum, block) => sum + block.terminalSignalCount, 0);
  if (!totalBoundarySignals && !totalTerminalSignals) return [];
  const rootBlock = orderedBlocks.find((block) => totalBoundarySignals
    ? block.boundarySignalCount > 0
    : block.terminalSignalCount > 0);

  const parentBlockId = new Map([[rootBlock.id, null]]);
  const childrenByBlockId = new Map(orderedBlocks.map((block) => [block.id, []]));
  const traversalOrder = [];
  const traversalStack = [rootBlock.id];
  while (traversalStack.length) {
    const blockId = traversalStack.pop();
    traversalOrder.push(blockId);
    const childConnections = blocks.get(blockId).bridges
      .filter((bridge) => !parentBlockId.has(bridge.neighborBlockId));
    childConnections.forEach((bridge) => {
      parentBlockId.set(bridge.neighborBlockId, blockId);
      childrenByBlockId.get(blockId).push({
        edgeId: bridge.edgeId,
        childBlockId: bridge.neighborBlockId,
        parentNodeId: bridge.localNodeId,
        childNodeId: bridge.remoteNodeId,
      });
    });
    [...childConnections].reverse().forEach((bridge) => traversalStack.push(bridge.neighborBlockId));
  }
  childrenByBlockId.forEach((children) => children.sort((left, right) => compareIds(left.edgeId, right.edgeId)));

  const subtreeBoundarySignals = new Map();
  const subtreeTerminalSignals = new Map();
  [...traversalOrder].reverse().forEach((blockId) => {
    const block = blocks.get(blockId);
    const children = childrenByBlockId.get(blockId);
    subtreeBoundarySignals.set(blockId, block.boundarySignalCount + children.reduce(
      (sum, child) => sum + subtreeBoundarySignals.get(child.childBlockId), 0,
    ));
    subtreeTerminalSignals.set(blockId, block.terminalSignalCount + children.reduce(
      (sum, child) => sum + subtreeTerminalSignals.get(child.childBlockId), 0,
    ));
  });

  // Each child block's interval contains exactly the edges on its side of the
  // parent bridge, excluding that bridge. This makes both subtree and complement
  // candidates materializable once after aggregate selection.
  const edgeSequence = [];
  const subtreeIntervals = new Map();
  const intervalStack = [{ blockId: rootBlock.id, entered: false, childIndex: 0 }];
  while (intervalStack.length) {
    const frame = intervalStack[intervalStack.length - 1];
    if (!frame.entered) {
      frame.entered = true;
      frame.start = edgeSequence.length;
      blocks.get(frame.blockId).internalEdgeIds.forEach((edgeId) => edgeSequence.push(edgeId));
    }
    const children = childrenByBlockId.get(frame.blockId);
    if (frame.childIndex < children.length) {
      const child = children[frame.childIndex];
      frame.childIndex += 1;
      edgeSequence.push(child.edgeId);
      intervalStack.push({ blockId: child.childBlockId, entered: false, childIndex: 0 });
      continue;
    }
    subtreeIntervals.set(frame.blockId, { start: frame.start, end: edgeSequence.length });
    intervalStack.pop();
  }

  if (totalBoundarySignals) {
    const accepted = [];
    const pendingBlockIds = [rootBlock.id];
    while (pendingBlockIds.length) {
      const blockId = pendingBlockIds.pop();
      const children = childrenByBlockId.get(blockId);
      [...children].reverse().forEach((child) => {
        if (subtreeBoundarySignals.get(child.childBlockId) === 0) {
          const interval = subtreeIntervals.get(child.childBlockId);
          const protectedEdgeIds = [child.edgeId].concat(edgeSequence.slice(interval.start, interval.end));
          accepted.push(terminalEnclaveCandidate(
            protectedEdgeIds,
            child.parentNodeId,
            edgeMap,
            nodeMap,
            boundaryNodeIds,
            nodeDegrees,
          ));
          return;
        }
        pendingBlockIds.push(child.childBlockId);
      });
    }
    return accepted.sort((left, right) => compareIds(left.edgeIds[0], right.edgeIds[0]));
  }

  const terminalCandidates = traversalOrder.flatMap((blockId) => childrenByBlockId.get(blockId))
    .filter((child) => subtreeTerminalSignals.get(child.childBlockId) === 0)
    .map((child) => ({ ...child, interval: subtreeIntervals.get(child.childBlockId) }));
  if (!terminalCandidates.length) return [];
  const minimumSideEdgeCount = terminalCandidates.reduce((minimum, candidate) => (
    Math.min(minimum, candidate.interval.end - candidate.interval.start)
  ), Number.POSITIVE_INFINITY);
  const sizeTies = terminalCandidates.filter((candidate) => (
    candidate.interval.end - candidate.interval.start === minimumSideEdgeCount
  ));
  const globalMinimumEdgeId = [...componentEdgeIds].sort(compareIds)[0];
  const globalMinimumPosition = edgeSequence.indexOf(globalMinimumEdgeId);
  const minimumIdTies = sizeTies.filter((candidate) => (
    globalMinimumPosition < candidate.interval.start || globalMinimumPosition >= candidate.interval.end
  ));
  const selected = [...(minimumIdTies.length ? minimumIdTies : sizeTies)]
    .sort((left, right) => compareIds(left.edgeId, right.edgeId))[0];
  const protectedEdgeIds = [
    ...edgeSequence.slice(0, selected.interval.start),
    ...edgeSequence.slice(selected.interval.end),
  ];
  return [terminalEnclaveCandidate(
    protectedEdgeIds,
    selected.childNodeId,
    edgeMap,
    nodeMap,
    boundaryNodeIds,
    nodeDegrees,
  )];
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
  const orderedRemainingEdgeIds = [...remainingEdgeIds].sort(compareIds);
  let remainingIndex = 0;
  while (unseen.size) {
    while (remainingIndex < orderedRemainingEdgeIds.length && !unseen.has(orderedRemainingEdgeIds[remainingIndex])) remainingIndex += 1;
    const edgeId = orderedRemainingEdgeIds[remainingIndex];
    remainingIndex += 1;
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
  const segments = edges.map((edge) => {
    const lengthMeters = segmentLengthMeters(edge.start, edge.end);
    const workloadWeight = Math.max(...edge.highwayTypes.map((type) => HIGHWAY_WORKLOAD_WEIGHTS[type] ?? 0.5));
    return {
      edgeId: edge.id,
      start: edge.start,
      end: edge.end,
      streetNames: edge.streetNames,
      highwayTypes: edge.highwayTypes,
      lengthMeters: Number(lengthMeters.toFixed(2)),
      workloadWeight,
      classWeightedLengthMeters: Number((lengthMeters * workloadWeight).toFixed(2)),
    };
  });
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
    segments,
    streetLengthMeters: Number(segments.reduce((sum, segment) => sum + segment.lengthMeters, 0).toFixed(2)),
    classWeightedLengthMeters: Number(segments.reduce((sum, segment) => sum + segment.classWeightedLengthMeters, 0).toFixed(2)),
    candidateIds: [],
    candidateCount: 0,
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
  const orderedUnitIds = [...byId.keys()].sort(compareIds);
  let seedIndex = 0;
  const components = [];
  while (unseen.size) {
    while (seedIndex < orderedUnitIds.length && !unseen.has(orderedUnitIds[seedIndex])) seedIndex += 1;
    const seed = orderedUnitIds[seedIndex];
    seedIndex += 1;
    const queue = [seed];
    const component = [];
    unseen.delete(seed);
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const unitId = queue[queueIndex];
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

function normalizeCandidates(candidates) {
  if (candidates === undefined || candidates === null) return { ok: true, candidates: [] };
  if (!Array.isArray(candidates)) {
    return topologyFailure('blocked', 'INVALID_CANDIDATE_INPUT', 'Optional Canvas door estimates must be an array when supplied.');
  }
  if (!candidates.length) return { ok: true, candidates: [] };
  const normalized = [];
  const invalid = [];
  const duplicateIds = new Set();
  const seen = new Set();
  candidates.forEach((candidate, index) => {
    const id = canonicalId(candidate?.id ?? candidate?.candidate_id ?? candidate?.stable_id ?? candidate?.address_hash ?? candidate?.property_id);
    const point = pointFrom(candidate);
    if (!id || !point) {
      invalid.push(index);
      return;
    }
    if (seen.has(id)) duplicateIds.add(id);
    seen.add(id);
    normalized.push({
      id,
      ...point,
      streetName: String(candidate?.streetName ?? candidate?.street_name ?? candidate?.street ?? ''),
      explicitEdgeId: canonicalId(candidate?.roadEdgeId ?? candidate?.road_edge_id ?? candidate?.edgeId),
      explicitWayId: canonicalId(candidate?.roadWayId ?? candidate?.road_way_id ?? candidate?.wayId),
    });
  });
  if (invalid.length || duplicateIds.size) {
    return topologyFailure('blocked', 'INVALID_CANDIDATE_IDENTITIES', 'Every optional door estimate must have a unique ID and valid coordinates.', {
      invalidIndexes: invalid,
      duplicateCandidateIds: [...duplicateIds].sort(compareIds),
    });
  }
  return { ok: true, candidates: normalized.sort((left, right) => compareIds(left.id, right.id)) };
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
  let eligibleSourceEdgeCount = 0;
  let clippedFragmentCount = 0;
  let clippedAwaySourceEdgeCount = 0;
  const nodeForClippedPosition = (originalNode, point, position, endpointPosition) => {
    if (Math.abs(position - endpointPosition) <= COORDINATE_EPSILON) return originalNode;
    const id = virtualBoundaryNodeId(point);
    if (!nodeMap.has(id)) nodeMap.set(id, { id, ...point, tags: {} });
    boundaryNodeIds.add(id);
    return nodeMap.get(id);
  };
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
      const sourceEdgeId = edgeIdFor(leftId, rightId);
      if (blockedEdgeIds.has(sourceEdgeId)) continue;
      eligibleSourceEdgeCount += 1;
      const sortedNodeIds = [leftId, rightId].sort(compareIds);
      const sourceStart = nodeMap.get(sortedNodeIds[0]);
      const sourceEnd = nodeMap.get(sortedNodeIds[1]);
      const intervals = clippedSegmentIntervals(sourceStart, sourceEnd, polygon);
      if (!intervals.length) {
        clippedAwaySourceEdgeCount += 1;
        continue;
      }
      clippedFragmentCount += intervals.length;
      const streetName = String(way.tags?.name || '').trim();
      intervals.forEach((interval) => {
        const fragmentStart = nodeForClippedPosition(sourceStart, interval.start, interval.startPosition, 0);
        const fragmentEnd = nodeForClippedPosition(sourceEnd, interval.end, interval.endPosition, 1);
        if (fragmentStart.id === fragmentEnd.id) return;
        const id = edgeIdFor(fragmentStart.id, fragmentEnd.id);
        if (blockedEdgeIds.has(id)) return;
        const fragmentNodeIds = [fragmentStart.id, fragmentEnd.id].sort(compareIds);
        const existing = edgeMap.get(id);
        if (existing) {
          existing.wayIds = [...new Set([...existing.wayIds, way.canonicalId])].sort(compareIds);
          existing.streetNames = [...new Set([...existing.streetNames, streetName].filter(Boolean))].sort(compareIds);
          existing.highwayTypes = [...new Set([...existing.highwayTypes, highway])].sort(compareIds);
        } else {
          edgeMap.set(id, {
            id,
            nodeIds: fragmentNodeIds,
            start: nodeMap.get(fragmentNodeIds[0]),
            end: nodeMap.get(fragmentNodeIds[1]),
            wayIds: [way.canonicalId],
            streetNames: streetName ? [streetName] : [],
            highwayTypes: [highway],
          });
        }
      });
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
    clippingDiagnostics: {
      eligibleSourceEdgeCount,
      clippedFragmentCount,
      clippedAwaySourceEdgeCount,
    },
  };
}

function snapCandidatesToUnits(
  candidates,
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
  const unsnappedCandidateIds = [];
  const streetNameFallbackCandidateIds = [];
  const ambiguousSnaps = [];

  candidates.forEach((door) => {
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
      else streetNameFallbackCandidateIds.push(door.id);
    }

    const ranked = candidates.map((edge) => ({
      edge,
      distanceMeters: distanceToSegmentMeters(door, edge.start, edge.end),
    })).sort((left, right) => left.distanceMeters - right.distanceMeters || compareIds(left.edge.id, right.edge.id));
    const selected = ranked[0];
    if (!selected || selected.distanceMeters > maxSnapDistanceMeters || !edgeToUnit.has(selected.edge.id)) {
      unsnappedCandidateIds.push(door.id);
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
            candidateId: door.id,
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
      candidateId: door.id,
      edgeId: selected.edge.id,
      workUnitId: edgeToUnit.get(selected.edge.id),
      distanceMeters: Number(selected.distanceMeters.toFixed(2)),
    });
  });
  if (unsnappedCandidateIds.length) {
    return topologyFailure('blocked', 'UNSNAPPED_CANDIDATES', 'One or more optional door estimates could not be matched to the supplied road network.', {
      unsnappedCandidateIds: unsnappedCandidateIds.sort(compareIds),
      maxSnapDistanceMeters,
    });
  }
  if (ambiguousSnaps.length) {
    return topologyFailure('blocked', 'AMBIGUOUS_CANDIDATE_SNAPS', 'Optional door estimates are similarly close to different street work units.', {
      ambiguousCandidateIds: ambiguousSnaps.map((snap) => snap.candidateId).sort(compareIds),
      ambiguousSnaps: ambiguousSnaps.sort((left, right) => compareIds(left.candidateId, right.candidateId)),
      thresholds: {
        maxSnapDistanceMeters,
        roadSnapAmbiguityMeters,
        roadSnapAmbiguityRatio,
      },
    });
  }
  return {
    ok: true,
    snaps: snaps.sort((left, right) => compareIds(left.candidateId, right.candidateId)),
    streetNameFallbackCandidateIds: [...new Set(streetNameFallbackCandidateIds)].sort(compareIds),
  };
}

/**
 * Converts an OSM-like graph into indivisible street work units. Door points are
 * optional, ephemeral workload estimates; roads remain the assignment source of truth.
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
  const normalizedCandidates = normalizeCandidates(input.candidates ?? input.doors);
  if (!normalizedCandidates.ok) return normalizedCandidates;
  if (polygon.length) {
    const outsideCandidateIds = normalizedCandidates.candidates
      .filter((door) => !pointInPolygon(door, polygon) && distanceToPolygonBoundaryMeters(door, polygon) > 1)
      .map((door) => door.id);
    if (outsideCandidateIds.length) {
      return topologyFailure('blocked', 'CANDIDATES_OUTSIDE_POLYGON', 'Optional door estimates include points outside the selected Canvas polygon.', {
        outsideCandidateIds: outsideCandidateIds.sort(compareIds),
      });
    }
  }

  const maxSnapDistanceMeters = Number(input.maxSnapDistanceMeters ?? 150);
  const boundarySnapToleranceMeters = Number(input.boundarySnapToleranceMeters ?? 0.75);
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

  const {
    nodeMap,
    edgeMap,
    barrierNodeIds,
    boundaryNodeIds,
    clippingDiagnostics,
  } = graphResult;
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

  const snapped = snapCandidatesToUnits(
    normalizedCandidates.candidates,
    edgeMap,
    workUnits,
    maxSnapDistanceMeters,
    roadSnapAmbiguityMeters,
    roadSnapAmbiguityRatio,
  );
  if (!snapped.ok) return snapped;
  const snapsByUnit = new Map();
  snapped.snaps.forEach((snap) => snapsByUnit.set(snap.workUnitId, [...(snapsByUnit.get(snap.workUnitId) || []), snap.candidateId]));
  workUnits = workUnits.map((unit) => {
    const candidateIds = [...(snapsByUnit.get(unit.id) || [])].sort(compareIds);
    return { ...unit, candidateIds, candidateCount: candidateIds.length };
  });

  const finalNeighbors = buildUnitNeighbors(workUnits, barrierNodeIds);
  workUnits = workUnits.map((unit) => ({ ...unit, neighborIds: finalNeighbors.get(unit.id) || [] }));

  return {
    ok: true,
    status: snapped.streetNameFallbackCandidateIds.length ? 'degraded' : 'ready',
    workUnits,
    candidateSnaps: snapped.snaps,
    components: connectedUnitComponents(workUnits),
    barriers: {
      nodeIds: [...barrierNodeIds].sort(compareIds),
    },
    warnings: snapped.streetNameFallbackCandidateIds.length ? [{
      code: 'STREET_NAME_FALLBACK',
      message: 'Some optional door-estimate street names did not match OSM names; nearest-road snapping was used.',
      candidateIds: snapped.streetNameFallbackCandidateIds,
    }] : [],
    diagnostics: {
      roadNodeCount: new Set(workUnits.flatMap((unit) => unit.nodeIds)).size,
      roadEdgeCount: edgeMap.size,
      workUnitCount: workUnits.length,
      totalStreetLengthMeters: Number(workUnits.reduce((sum, unit) => sum + unit.streetLengthMeters, 0).toFixed(2)),
      protectedTerminalBranchCount: workUnits.filter((unit) => unit.protected).length,
      componentCount: connectedUnitComponents(workUnits).length,
      ...clippingDiagnostics,
    },
  };
}

export const canvasStreetTopologyInternals = Object.freeze({
  edgeIdFor,
});
