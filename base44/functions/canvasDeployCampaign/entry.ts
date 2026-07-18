// canvasDeployCampaign.source.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import Stripe from "npm:stripe@14.14.0";

// src/components/logic/canvasStreetTopology.js
var DEFAULT_ALLOWED_HIGHWAYS = /* @__PURE__ */ new Set([
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "road"
]);
var DEFAULT_BLOCKING_BARRIERS = /* @__PURE__ */ new Set([
  "yes",
  "block",
  "bollard",
  "chain",
  "fence",
  "hedge",
  "lift_gate",
  "retaining_wall",
  "swing_gate",
  "wall"
]);
var HIGHWAY_WORKLOAD_WEIGHTS = Object.freeze({
  residential: 1,
  living_street: 1,
  unclassified: 0.8,
  road: 0.8,
  service: 0.65,
  tertiary: 0.3,
  secondary: 0.15,
  primary: 0.05
});
var EARTH_RADIUS_METERS = 63710088e-1;
var COORDINATE_EPSILON = 1e-10;
function canonicalId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized2 = String(value).trim();
  return normalized2 ? normalized2 : null;
}
function compareIds(left, right) {
  return String(left).localeCompare(String(right), "en", { numeric: true });
}
function stableHash(value) {
  let first = 2166136261;
  let second = 2246822507;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489909);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
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
    const crossesLatitude = current.lat > point.lat !== previous.lat > point.lat;
    const crossingLongitude = (previous.lng - current.lng) * (point.lat - current.lat) / (previous.lat - current.lat || COORDINATE_EPSILON) + current.lng;
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
  return point.lng >= Math.min(start.lng, end.lng) - COORDINATE_EPSILON && point.lng <= Math.max(start.lng, end.lng) + COORDINATE_EPSILON && point.lat >= Math.min(start.lat, end.lat) - COORDINATE_EPSILON && point.lat <= Math.max(start.lat, end.lat) + COORDINATE_EPSILON;
}
function segmentsIntersectInclusive(firstStart, firstEnd, secondStart, secondEnd) {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return true;
  return pointOnSegment(secondStart, firstStart, firstEnd) || pointOnSegment(secondEnd, firstStart, firstEnd) || pointOnSegment(firstStart, secondStart, secondEnd) || pointOnSegment(firstEnd, secondStart, secondEnd);
}
function polygonSelfIntersects(polygon) {
  if (polygon.length < 4) return false;
  for (let firstIndex = 0; firstIndex < polygon.length; firstIndex += 1) {
    const firstNextIndex = (firstIndex + 1) % polygon.length;
    for (let secondIndex = firstIndex + 1; secondIndex < polygon.length; secondIndex += 1) {
      const secondNextIndex = (secondIndex + 1) % polygon.length;
      const adjacent = firstIndex === secondIndex || firstNextIndex === secondIndex || secondNextIndex === firstIndex;
      if (adjacent) continue;
      if (segmentsIntersectInclusive(
        polygon[firstIndex],
        polygon[firstNextIndex],
        polygon[secondIndex],
        polygon[secondNextIndex]
      )) return true;
    }
  }
  return false;
}
function projectMeters(point, referenceLatitude) {
  const radians = Math.PI / 180;
  return {
    x: EARTH_RADIUS_METERS * point.lng * radians * Math.cos(referenceLatitude * radians),
    y: EARTH_RADIUS_METERS * point.lat * radians
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
  const position = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((projectedPoint.x - projectedStart.x) * deltaX + (projectedPoint.y - projectedStart.y) * deltaY) / lengthSquared));
  return Math.hypot(
    projectedPoint.x - (projectedStart.x + position * deltaX),
    projectedPoint.y - (projectedStart.y + position * deltaY)
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
    distanceToSegmentMeters(point, current, polygon[(index + 1) % polygon.length])
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
    lng: Number(start.lng) + (Number(end.lng) - Number(start.lng)) * position
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
      endPosition
    });
  }
  return intervals;
}
function virtualBoundaryNodeId(point) {
  return `clip-node:${Number(point.lat).toFixed(12)}:${Number(point.lng).toFixed(12)}`;
}
function normalizedStreetName(value) {
  return String(value || "").toLowerCase().replace(/\b(street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|circle|cir|place|pl|parkway|pkwy)\b/g, "").replace(/[^a-z0-9]/g, "");
}
function topologyFailure(status, code, message, details = {}) {
  return {
    ok: false,
    status,
    deployable: false,
    code,
    message,
    details
  };
}
function hasBlockingBarrier(node, blockingBarriers) {
  const barrier = String(node.tags?.barrier || "").toLowerCase();
  return barrier && blockingBarriers.has(barrier);
}
function graphComponents(edgeIds, edgeMap, barrierNodeIds) {
  const nodeEdges = /* @__PURE__ */ new Map();
  edgeIds.forEach((edgeId) => {
    const edge = edgeMap.get(edgeId);
    edge.nodeIds.forEach((nodeId) => {
      if (barrierNodeIds.has(nodeId)) return;
      nodeEdges.set(nodeId, [...nodeEdges.get(nodeId) || [], edgeId]);
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
  const nodeEdges = /* @__PURE__ */ new Map();
  edgeIds.forEach((edgeId) => {
    edgeMap.get(edgeId).nodeIds.forEach((nodeId) => {
      nodeEdges.set(nodeId, [...nodeEdges.get(nodeId) || [], edgeId]);
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
    throatNodeIds: [...nodes].filter((nodeId) => coreNodeIds.has(nodeId) || nodeDegrees.get(nodeId) >= 3).sort(compareIds)
  };
}
function findBridgeEdgeIds(edgeIds, edgeMap, barrierNodeIds) {
  const nodeEdges = componentNodeEdges(edgeIds, edgeMap);
  const discovery = /* @__PURE__ */ new Map();
  const low = /* @__PURE__ */ new Map();
  const bridgeEdgeIds = /* @__PURE__ */ new Set();
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
        stack.push({ nodeId: nextNodeId, parentEdgeId: edgeId, edgeIndex: 0, edges: nodeEdges.get(nextNodeId) || [] });
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
    throatNodeIds: [throatNodeId]
  };
}
function findTerminalEnclaveBranches(componentEdgeIds, edgeMap, nodeMap, boundaryNodeIds, barrierNodeIds, nodeDegrees) {
  const bridgeEdgeIds = findBridgeEdgeIds(componentEdgeIds, edgeMap, barrierNodeIds);
  if (!bridgeEdgeIds.size) return [];
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
        terminalSignalCount: 0
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
      remoteNodeId: edge.nodeIds[1]
    });
    blocks.get(secondBlockId).bridges.push({
      edgeId,
      neighborBlockId: firstBlockId,
      localNodeId: edge.nodeIds[1],
      remoteNodeId: edge.nodeIds[0]
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
        childNodeId: bridge.remoteNodeId
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
      (sum, child) => sum + subtreeBoundarySignals.get(child.childBlockId), 0
    ));
    subtreeTerminalSignals.set(blockId, block.terminalSignalCount + children.reduce(
      (sum, child) => sum + subtreeTerminalSignals.get(child.childBlockId), 0
    ));
  });
  const edgeSequence = [];
  const subtreeIntervals = new Map();
  const intervalStack = [{ blockId: rootBlock.id, entered: false, childIndex: 0 }];
  while (intervalStack.length) {
    const frame = intervalStack[intervalStack.length - 1];
    if (!frame.entered) {
      frame.entered = true;
      frame.start = edgeSequence.length;
      edgeSequence.push(...blocks.get(frame.blockId).internalEdgeIds);
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
          accepted.push(terminalEnclaveCandidate(
            [child.edgeId, ...edgeSequence.slice(interval.start, interval.end)],
            child.parentNodeId,
            edgeMap,
            nodeMap,
            boundaryNodeIds,
            nodeDegrees
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
  const minimumSideEdgeCount = Math.min(...terminalCandidates.map((candidate) => candidate.interval.end - candidate.interval.start));
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
    ...edgeSequence.slice(selected.interval.end)
  ];
  return [terminalEnclaveCandidate(
    protectedEdgeIds,
    selected.childNodeId,
    edgeMap,
    nodeMap,
    boundaryNodeIds,
    nodeDegrees
  )];
}
function findProtectedTerminalBranches(edgeIds, edgeMap, nodeMap, boundaryNodeIds, barrierNodeIds) {
  const protectedGroups = [];
  graphComponents(edgeIds, edgeMap, barrierNodeIds).forEach((componentEdgeIds) => {
    const nodeEdges = componentNodeEdges(componentEdgeIds, edgeMap);
    const nodeDegrees = new Map([...nodeEdges.entries()].map(([nodeId, ids]) => [nodeId, barrierNodeIds.has(nodeId) ? 0 : ids.length]));
    const terminalNodeIds = new Set([...nodeDegrees.entries()].filter(([nodeId, degree]) => degree === 1 && !boundaryNodeIds.has(nodeId) && !barrierNodeIds.has(nodeId)).map(([nodeId]) => nodeId));
    const enclaveBranches = findTerminalEnclaveBranches(
      componentEdgeIds,
      edgeMap,
      nodeMap,
      boundaryNodeIds,
      barrierNodeIds,
      nodeDegrees
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
      const explicitlyTerminal = String(terminalNode?.tags?.noexit || "").toLowerCase() === "yes";
      if (path.length && (nodeDegrees.get(endNodeId) >= 3 || explicitlyTerminal)) {
        path.forEach((edgeId) => claimed.add(edgeId));
        protectedGroups.push(branchMetadata(path, edgeMap, nodeDegrees, /* @__PURE__ */ new Set([endNodeId]), terminalNodeIds));
      }
    });
  });
  return protectedGroups.sort((left, right) => compareIds(left.edgeIds[0], right.edgeIds[0]));
}
function decomposeRemainingChains(edgeIds, edgeMap, claimedEdgeIds, protectedNodeIds, boundaryNodeIds, barrierNodeIds) {
  const remainingEdgeIds = edgeIds.filter((edgeId) => !claimedEdgeIds.has(edgeId));
  if (!remainingEdgeIds.length) return [];
  const nodeEdges = componentNodeEdges(remainingEdgeIds, edgeMap);
  const anchors = new Set([...nodeEdges.entries()].filter(([nodeId, ids]) => ids.length !== 2 || protectedNodeIds.has(nodeId) || boundaryNodeIds.has(nodeId) || barrierNodeIds.has(nodeId)).map(([nodeId]) => nodeId));
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
  const signature = sortedEdgeIds.join("|");
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
      classWeightedLengthMeters: Number((lengthMeters * workloadWeight).toFixed(2))
    };
  });
  return {
    id: `work-unit:${stableHash(signature)}`,
    signature,
    kind: metadata.protected ? "terminal_to_throat_branch" : "street_chain",
    protected: Boolean(metadata.protected),
    edgeIds: sortedEdgeIds,
    nodeIds,
    terminalNodeIds: [...metadata.terminalNodeIds || []].sort(compareIds),
    throatNodeIds: [...metadata.throatNodeIds || []].sort(compareIds),
    streetNames,
    segments,
    streetLengthMeters: Number(segments.reduce((sum, segment) => sum + segment.lengthMeters, 0).toFixed(2)),
    classWeightedLengthMeters: Number(segments.reduce((sum, segment) => sum + segment.classWeightedLengthMeters, 0).toFixed(2)),
    candidateIds: [],
    candidateCount: 0,
    neighborIds: []
  };
}
function buildUnitNeighbors(units, barrierNodeIds) {
  const nodeUnits = /* @__PURE__ */ new Map();
  units.forEach((unit) => unit.nodeIds.forEach((nodeId) => {
    if (barrierNodeIds.has(nodeId)) return;
    nodeUnits.set(nodeId, [...nodeUnits.get(nodeId) || [], unit.id]);
  }));
  const neighbors = new Map(units.map((unit) => [unit.id, /* @__PURE__ */ new Set()]));
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
  if (candidates === void 0 || candidates === null) return { ok: true, candidates: [] };
  if (!Array.isArray(candidates)) {
    return topologyFailure("blocked", "INVALID_CANDIDATE_INPUT", "Optional Canvas door estimates must be an array when supplied.");
  }
  if (!candidates.length) return { ok: true, candidates: [] };
  const normalized2 = [];
  const invalid = [];
  const duplicateIds = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set();
  candidates.forEach((candidate, index) => {
    const id = canonicalId(candidate?.id ?? candidate?.candidate_id ?? candidate?.stable_id ?? candidate?.address_hash ?? candidate?.property_id);
    const point = pointFrom(candidate);
    if (!id || !point) {
      invalid.push(index);
      return;
    }
    if (seen.has(id)) duplicateIds.add(id);
    seen.add(id);
    normalized2.push({
      id,
      ...point,
      streetName: String(candidate?.streetName ?? candidate?.street_name ?? candidate?.street ?? ""),
      explicitEdgeId: canonicalId(candidate?.roadEdgeId ?? candidate?.road_edge_id ?? candidate?.edgeId),
      explicitWayId: canonicalId(candidate?.roadWayId ?? candidate?.road_way_id ?? candidate?.wayId)
    });
  });
  if (invalid.length || duplicateIds.size) {
    return topologyFailure("blocked", "INVALID_CANDIDATE_IDENTITIES", "Every optional door estimate must have a unique ID and valid coordinates.", {
      invalidIndexes: invalid,
      duplicateCandidateIds: [...duplicateIds].sort(compareIds)
    });
  }
  return { ok: true, candidates: normalized2.sort((left, right) => compareIds(left.id, right.id)) };
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
  boundarySnapToleranceMeters
}) {
  if (!Array.isArray(roadNetwork?.elements) || !roadNetwork.elements.length) {
    return topologyFailure("blocked", "ROAD_NETWORK_REQUIRED", "No usable OSM road network was supplied. Canvas cannot deploy a geometry fallback.");
  }
  const allowed = new Set((allowedHighways || [...DEFAULT_ALLOWED_HIGHWAYS]).map((value) => String(value).toLowerCase()));
  const blockingBarriers = new Set((blockingBarrierValues || [...DEFAULT_BLOCKING_BARRIERS]).map((value) => String(value).toLowerCase()));
  const barrierNodeIds = new Set((explicitBarrierNodeIds || []).map(canonicalId).filter(Boolean));
  const barrierWayIds = new Set((explicitBarrierWayIds || []).map(canonicalId).filter(Boolean));
  const blockedEdgeIds = new Set((explicitBlockedEdgeIds || []).map(String));
  const boundaryNodeIds = new Set((explicitBoundaryNodeIds || []).map(canonicalId).filter(Boolean));
  const nodeMap = /* @__PURE__ */ new Map();
  const ways = [];
  [...roadNetwork.elements].sort((left, right) => {
    const typeComparison = String(left?.type).localeCompare(String(right?.type));
    return typeComparison || compareIds(left?.id, right?.id);
  }).forEach((element) => {
    const id = canonicalId(element?.id);
    if (element?.type === "node" && id) {
      const point = pointFrom(element);
      if (!point) return;
      const node = { id, ...point, tags: element.tags || {} };
      nodeMap.set(id, node);
      if (inferOsmBarriers !== false && hasBlockingBarrier(node, blockingBarriers)) barrierNodeIds.add(id);
    } else if (element?.type === "way" && id) {
      ways.push({ ...element, canonicalId: id });
    }
  });
  const malformedWayIds = [];
  const edgeMap = /* @__PURE__ */ new Map();
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
    const highway = String(way.tags?.highway || "").toLowerCase();
    if (!allowed.has(highway)) return;
    if (barrierWayIds.has(way.canonicalId) || inferOsmBarriers !== false && way.tags?.barrier) return;
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
      const streetName = String(way.tags?.name || "").trim();
      intervals.forEach((interval) => {
        const fragmentStart = nodeForClippedPosition(sourceStart, interval.start, interval.startPosition, 0);
        const fragmentEnd = nodeForClippedPosition(sourceEnd, interval.end, interval.endPosition, 1);
        if (fragmentStart.id === fragmentEnd.id) return;
        const id = edgeIdFor(fragmentStart.id, fragmentEnd.id);
        if (blockedEdgeIds.has(id)) return;
        const fragmentNodeIds = [fragmentStart.id, fragmentEnd.id].sort(compareIds);
        const existing = edgeMap.get(id);
        if (existing) {
          existing.wayIds = [.../* @__PURE__ */ new Set([...existing.wayIds, way.canonicalId])].sort(compareIds);
          existing.streetNames = [...new Set([...existing.streetNames, streetName].filter(Boolean))].sort(compareIds);
          existing.highwayTypes = [.../* @__PURE__ */ new Set([...existing.highwayTypes, highway])].sort(compareIds);
        } else {
          edgeMap.set(id, {
            id,
            nodeIds: fragmentNodeIds,
            start: nodeMap.get(fragmentNodeIds[0]),
            end: nodeMap.get(fragmentNodeIds[1]),
            wayIds: [way.canonicalId],
            streetNames: streetName ? [streetName] : [],
            highwayTypes: [highway]
          });
        }
      });
    }
  });
  if (malformedWayIds.length) {
    return topologyFailure("blocked", "MALFORMED_ROAD_NETWORK", "One or more eligible OSM ways reference missing or invalid nodes.", {
      malformedWayIds: [...new Set(malformedWayIds)].sort(compareIds)
    });
  }
  if (!edgeMap.size) {
    return topologyFailure("blocked", "NO_ELIGIBLE_ROADS", "The selected polygon contains no eligible street segments.");
  }
  if (polygon.length) {
    nodeMap.forEach((node, nodeId) => {
      if (!pointInPolygon(node, polygon) || distanceToPolygonBoundaryMeters(node, polygon) <= boundarySnapToleranceMeters) boundaryNodeIds.add(nodeId);
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
      clippedAwaySourceEdgeCount
    }
  };
}
function snapCandidatesToUnits(candidates, edgeMap, units, maxSnapDistanceMeters, roadSnapAmbiguityMeters, roadSnapAmbiguityRatio) {
  const edgeToUnit = /* @__PURE__ */ new Map();
  units.forEach((unit) => unit.edgeIds.forEach((edgeId) => edgeToUnit.set(edgeId, unit.id)));
  const edges = [...edgeMap.values()].sort((left, right) => compareIds(left.id, right.id));
  const snaps = [];
  const unsnappedCandidateIds = [];
  const streetNameFallbackCandidateIds = [];
  const ambiguousSnaps = [];
  candidates.forEach((door) => {
    let candidates2 = edges;
    const hasExplicitRoadLink = Boolean(door.explicitEdgeId || door.explicitWayId);
    if (door.explicitEdgeId) candidates2 = candidates2.filter((edge) => edge.id === door.explicitEdgeId);
    else if (door.explicitWayId) candidates2 = candidates2.filter((edge) => edge.wayIds.includes(door.explicitWayId));
    const normalizedName = normalizedStreetName(door.streetName);
    let streetNameResolved = false;
    if (!door.explicitEdgeId && !door.explicitWayId && normalizedName) {
      const namedCandidates = candidates2.filter((edge) => edge.streetNames.some((name) => normalizedStreetName(name) === normalizedName));
      if (namedCandidates.length) {
        candidates2 = namedCandidates;
        const namedUnitIds = new Set(namedCandidates.map((edge) => edgeToUnit.get(edge.id)).filter(Boolean));
        streetNameResolved = namedUnitIds.size === 1;
      } else streetNameFallbackCandidateIds.push(door.id);
    }
    const ranked = candidates2.map((edge) => ({
      edge,
      distanceMeters: distanceToSegmentMeters(door, edge.start, edge.end)
    })).sort((left, right) => left.distanceMeters - right.distanceMeters || compareIds(left.edge.id, right.edge.id));
    const selected = ranked[0];
    if (!selected || selected.distanceMeters > maxSnapDistanceMeters || !edgeToUnit.has(selected.edge.id)) {
      unsnappedCandidateIds.push(door.id);
      return;
    }
    if (!hasExplicitRoadLink && !streetNameResolved) {
      const nearestByUnit = [];
      const seenUnitIds = /* @__PURE__ */ new Set();
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
        const distanceRatio = nearest.distanceMeters <= 0.01 ? competing.distanceMeters <= 0.01 ? 1 : Number.POSITIVE_INFINITY : competing.distanceMeters / nearest.distanceMeters;
        if (distanceGapMeters <= roadSnapAmbiguityMeters && distanceRatio <= roadSnapAmbiguityRatio) {
          const candidateDetails = (candidate) => ({
            workUnitId: candidate.workUnitId,
            edgeId: candidate.edge.id,
            distanceMeters: Number(candidate.distanceMeters.toFixed(2)),
            streetNames: [...candidate.edge.streetNames].sort(compareIds)
          });
          ambiguousSnaps.push({
            candidateId: door.id,
            resolutionBasis: normalizedName ? "unresolved_street_name" : "spatial_only",
            nearest: candidateDetails(nearest),
            competing: candidateDetails(competing),
            distanceGapMeters: Number(distanceGapMeters.toFixed(2)),
            distanceRatio: Number(distanceRatio.toFixed(3))
          });
        }
      }
    }
    snaps.push({
      candidateId: door.id,
      edgeId: selected.edge.id,
      workUnitId: edgeToUnit.get(selected.edge.id),
      distanceMeters: Number(selected.distanceMeters.toFixed(2))
    });
  });
  if (unsnappedCandidateIds.length) {
    return topologyFailure("blocked", "UNSNAPPED_CANDIDATES", "One or more optional door estimates could not be matched to the supplied road network.", {
      unsnappedCandidateIds: unsnappedCandidateIds.sort(compareIds),
      maxSnapDistanceMeters
    });
  }
  if (ambiguousSnaps.length) {
    return topologyFailure("blocked", "AMBIGUOUS_CANDIDATE_SNAPS", "Optional door estimates are similarly close to different street work units.", {
      ambiguousCandidateIds: ambiguousSnaps.map((snap) => snap.candidateId).sort(compareIds),
      ambiguousSnaps: ambiguousSnaps.sort((left, right) => compareIds(left.candidateId, right.candidateId)),
      thresholds: {
        maxSnapDistanceMeters,
        roadSnapAmbiguityMeters,
        roadSnapAmbiguityRatio
      }
    });
  }
  return {
    ok: true,
    snaps: snaps.sort((left, right) => compareIds(left.candidateId, right.candidateId)),
    streetNameFallbackCandidateIds: [...new Set(streetNameFallbackCandidateIds)].sort(compareIds)
  };
}
function buildCanvasStreetWorkUnits(input = {}) {
  const polygon = normalizePolygon(input.polygon);
  if (input.polygon && polygonSelfIntersects(polygon)) {
    return topologyFailure("blocked", "SELF_INTERSECTING_POLYGON", "Canvas requires a simple polygon whose boundary does not cross or touch itself.");
  }
  if (input.polygon && (polygon.length < 3 || Math.abs(signedPolygonArea(polygon)) <= COORDINATE_EPSILON)) {
    return topologyFailure("blocked", "INVALID_POLYGON", "Canvas requires a valid, non-zero-area polygon.");
  }
  const normalizedCandidates = normalizeCandidates(input.candidates ?? input.doors);
  if (!normalizedCandidates.ok) return normalizedCandidates;
  if (polygon.length) {
    const outsideCandidateIds = normalizedCandidates.candidates.filter((door) => !pointInPolygon(door, polygon) && distanceToPolygonBoundaryMeters(door, polygon) > 1).map((door) => door.id);
    if (outsideCandidateIds.length) {
      return topologyFailure("blocked", "CANDIDATES_OUTSIDE_POLYGON", "Optional door estimates include points outside the selected Canvas polygon.", {
        outsideCandidateIds: outsideCandidateIds.sort(compareIds)
      });
    }
  }
  const maxSnapDistanceMeters = Number(input.maxSnapDistanceMeters ?? 150);
  const boundarySnapToleranceMeters = Number(input.boundarySnapToleranceMeters ?? 0.75);
  const roadSnapAmbiguityMeters = Number(input.roadSnapAmbiguityMeters ?? input.road_snap_ambiguity_meters ?? 12);
  const roadSnapAmbiguityRatio = Number(input.roadSnapAmbiguityRatio ?? input.road_snap_ambiguity_ratio ?? 1.5);
  if (!Number.isFinite(maxSnapDistanceMeters) || maxSnapDistanceMeters <= 0 || !Number.isFinite(boundarySnapToleranceMeters) || boundarySnapToleranceMeters < 0 || !Number.isFinite(roadSnapAmbiguityMeters) || roadSnapAmbiguityMeters < 0 || !Number.isFinite(roadSnapAmbiguityRatio) || roadSnapAmbiguityRatio < 1) {
    return topologyFailure("blocked", "INVALID_TOPOLOGY_OPTIONS", "Snap distances and ambiguity thresholds must be finite; the ambiguity ratio must be at least 1.");
  }
  const graphResult = parseRoadGraph({
    ...input,
    polygon,
    maxSnapDistanceMeters,
    boundarySnapToleranceMeters
  });
  if (!graphResult.ok) return graphResult;
  const {
    nodeMap,
    edgeMap,
    barrierNodeIds,
    boundaryNodeIds,
    clippingDiagnostics
  } = graphResult;
  const edgeIds = [...edgeMap.keys()].sort(compareIds);
  const protectedBranches = findProtectedTerminalBranches(
    edgeIds,
    edgeMap,
    nodeMap,
    boundaryNodeIds,
    barrierNodeIds
  );
  const claimedEdgeIds = new Set(protectedBranches.flatMap((branch) => branch.edgeIds));
  const protectedNodeIds = new Set(protectedBranches.flatMap((branch) => branch.edgeIds.flatMap((edgeId) => edgeMap.get(edgeId).nodeIds)));
  const chainGroups = decomposeRemainingChains(
    edgeIds,
    edgeMap,
    claimedEdgeIds,
    protectedNodeIds,
    boundaryNodeIds,
    barrierNodeIds
  );
  let workUnits = [
    ...protectedBranches.map((branch) => createWorkUnit(branch.edgeIds, edgeMap, { ...branch, protected: true })),
    ...chainGroups.map((group) => createWorkUnit(group, edgeMap))
  ].sort((left, right) => compareIds(left.id, right.id));
  const unitIds = /* @__PURE__ */ new Set();
  const duplicateUnitIds = [];
  workUnits.forEach((unit) => {
    if (unitIds.has(unit.id)) duplicateUnitIds.push(unit.id);
    unitIds.add(unit.id);
  });
  if (duplicateUnitIds.length) {
    return topologyFailure("blocked", "WORK_UNIT_ID_COLLISION", "Stable work-unit IDs collided; deployment is blocked.", {
      duplicateUnitIds: [...new Set(duplicateUnitIds)].sort(compareIds)
    });
  }
  const coveredEdges = workUnits.flatMap((unit) => unit.edgeIds);
  if (coveredEdges.length !== edgeIds.length || new Set(coveredEdges).size !== edgeIds.length) {
    return topologyFailure("blocked", "ATOMIC_COVERAGE_INVALID", "Street edges were not covered by exactly one atomic work unit.");
  }
  const snapped = snapCandidatesToUnits(
    normalizedCandidates.candidates,
    edgeMap,
    workUnits,
    maxSnapDistanceMeters,
    roadSnapAmbiguityMeters,
    roadSnapAmbiguityRatio
  );
  if (!snapped.ok) return snapped;
  const snapsByUnit = /* @__PURE__ */ new Map();
  snapped.snaps.forEach((snap) => snapsByUnit.set(snap.workUnitId, [...snapsByUnit.get(snap.workUnitId) || [], snap.candidateId]));
  workUnits = workUnits.map((unit) => {
    const candidateIds = [...snapsByUnit.get(unit.id) || []].sort(compareIds);
    return { ...unit, candidateIds, candidateCount: candidateIds.length };
  });
  const finalNeighbors = buildUnitNeighbors(workUnits, barrierNodeIds);
  workUnits = workUnits.map((unit) => ({ ...unit, neighborIds: finalNeighbors.get(unit.id) || [] }));
  return {
    ok: true,
    status: snapped.streetNameFallbackCandidateIds.length ? "degraded" : "ready",
    workUnits,
    candidateSnaps: snapped.snaps,
    components: connectedUnitComponents(workUnits),
    barriers: {
      nodeIds: [...barrierNodeIds].sort(compareIds)
    },
    warnings: snapped.streetNameFallbackCandidateIds.length ? [{
      code: "STREET_NAME_FALLBACK",
      message: "Some optional door-estimate street names did not match OSM names; nearest-road snapping was used.",
      candidateIds: snapped.streetNameFallbackCandidateIds
    }] : [],
    diagnostics: {
      roadNodeCount: new Set(workUnits.flatMap((unit) => unit.nodeIds)).size,
      roadEdgeCount: edgeMap.size,
      workUnitCount: workUnits.length,
      totalStreetLengthMeters: Number(workUnits.reduce((sum, unit) => sum + unit.streetLengthMeters, 0).toFixed(2)),
      protectedTerminalBranchCount: workUnits.filter((unit) => unit.protected).length,
      componentCount: connectedUnitComponents(workUnits).length,
      ...clippingDiagnostics
    }
  };
}
var canvasStreetTopologyInternals = Object.freeze({
  edgeIdFor
});

// src/components/logic/canvasStreetTerritoryPlanner.js
import { polygon as geoJsonPolygon } from "npm:turf-helpers@3.0.12";
import intersectPolygons from "npm:turf-intersect@3.0.12";
var ALGORITHM_VERSION = "canvas_street_workload_v3";
var MAX_CANVAS_ZONE_COUNT = 250;
var MAX_CANVAS_INTERACTIVE_WORK_UNITS = 2e4;
var MAX_CANVAS_INTERACTIVE_COMPLEXITY = 2e6;
var MAX_CANVAS_INTERACTIVE_SEGMENTS = 5e4;
var MAX_DISPLAY_CORRIDOR_WORK_UNITS = 2e3;
var ZONE_COLORS = ["#A855F7", "#2563EB", "#059669", "#D97706", "#DC2626", "#0891B2", "#7C3AED", "#DB2777"];
var OPTIONAL_CANDIDATE_FAILURES = /* @__PURE__ */ new Set([
  "INVALID_CANDIDATE_INPUT",
  "INVALID_CANDIDATE_IDENTITIES",
  "CANDIDATES_OUTSIDE_POLYGON",
  "UNSNAPPED_CANDIDATES",
  "AMBIGUOUS_CANDIDATE_SNAPS"
]);
function compareIds2(left, right) {
  return String(left).localeCompare(String(right), "en", { numeric: true });
}
function stableHash2(value) {
  let first = 2166136261;
  let second = 2246822507;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489909);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
function failure(status, code, message, details = {}) {
  return {
    ok: false,
    status,
    deployable: false,
    code,
    message,
    details,
    planning_method: "street_workload",
    assignment_basis: "street_work_unit_ids",
    ownership_geometry: "clipped_street_segments",
    method: "street_workload",
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
      data_quality_status: "unverified",
      warnings: [message]
    }
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
function normalizeCandidates2(input = {}) {
  const raw = input.door_candidates ?? input.estimated_door_candidates ?? input.opportunities ?? input.doors ?? [];
  if (!Array.isArray(raw)) {
    return {
      candidates: [],
      warnings: ["Optional door estimates were ignored because they were not supplied as an array."]
    };
  }
  const warnings = [];
  const normalized2 = [];
  let invalidCount = 0;
  raw.forEach((candidate) => {
    const lat = Number(candidate?.lat ?? candidate?.latitude);
    const lng = Number(candidate?.lng ?? candidate?.lon ?? candidate?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      invalidCount += 1;
      return;
    }
    const explicitId = String(candidate?.candidate_id ?? candidate?.id ?? candidate?.stable_door_id ?? candidate?.stable_id ?? candidate?.address_hash ?? candidate?.property_id ?? "").trim();
    const id = explicitId || `estimate:${stableHash2(`${lat.toFixed(7)}:${lng.toFixed(7)}`)}`;
    const rawWeight = Number(candidate?.weight ?? candidate?.estimated_doors ?? 1);
    normalized2.push({
      ...candidate,
      id,
      candidate_id: id,
      lat,
      lng,
      weight: Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 1
    });
  });
  if (invalidCount) warnings.push(`${invalidCount} invalid optional door estimate${invalidCount === 1 ? " was" : "s were"} ignored.`);
  normalized2.sort((left, right) => compareIds2(left.id, right.id) || left.lat - right.lat || left.lng - right.lng);
  const deduplicated = [];
  const seen = /* @__PURE__ */ new Set();
  let duplicateCount = 0;
  normalized2.forEach((candidate) => {
    if (seen.has(candidate.id)) {
      duplicateCount += 1;
      return;
    }
    seen.add(candidate.id);
    deduplicated.push(candidate);
  });
  if (duplicateCount) warnings.push(`${duplicateCount} duplicate optional door estimate${duplicateCount === 1 ? " was" : "s were"} ignored.`);
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
      geoJsonPolygon([closedCoordinateRing(boundary)])
    );
    if (!intersection?.geometry) return [];
    const polygons = intersection.geometry.type === "Polygon" ? [intersection.geometry.coordinates] : intersection.geometry.type === "MultiPolygon" ? intersection.geometry.coordinates : [];
    return polygons.map((polygon) => (polygon?.[0] || []).slice(0, -1).map(([lng, lat]) => ({ lat, lng }))).filter((part) => part.length >= 3);
  } catch {
    return [];
  }
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}
function selectedRepIds(input = {}) {
  const raw = input.selected_team_member_ids ?? input.selectedRepIds ?? [];
  return [...new Set((Array.isArray(raw) ? raw : []).map(String).filter(Boolean))].sort(compareIds2);
}
function resolveZoneRequest(input, totalStreetWorkloadMeters, reps) {
  const explicitRaw = input.area_count ?? input.requested_zone_count ?? input.zone_count ?? input.zoneCount;
  if (explicitRaw !== void 0 && explicitRaw !== null && explicitRaw !== "") {
    const explicit = Number(explicitRaw);
    if (!Number.isInteger(explicit) || explicit <= 0) {
      return { error: failure("blocked", "INVALID_AREA_COUNT", "Area count must be a positive whole number.") };
    }
    if (reps.length && explicit !== reps.length) {
      return {
        error: failure(
          "blocked",
          "AREA_COUNT_REP_MISMATCH",
          `Selected-rep plans require exactly ${reps.length} areas, one for each selected rep.`,
          { selected_rep_count: reps.length, requested_area_count: explicit }
        )
      };
    }
    return { zoneCount: explicit, divisionMode: reps.length ? "selected_reps" : "area_count" };
  }
  if (reps.length) return { zoneCount: reps.length, divisionMode: "selected_reps" };
  const targetRaw = input.target_street_workload_meters_per_area ?? input.target_workload_meters_per_area ?? input.target_workload ?? input.target_street_length_meters_per_area;
  if (targetRaw !== void 0 && targetRaw !== null && targetRaw !== "") {
    const target = Number(targetRaw);
    if (!Number.isFinite(target) || target <= 0) {
      return { error: failure("blocked", "INVALID_STREET_WORKLOAD_TARGET", "Street workload target must be a positive number of meters.") };
    }
    return {
      zoneCount: Math.max(1, Math.ceil(totalStreetWorkloadMeters / target)),
      divisionMode: "street_workload_target",
      targetStreetWorkloadMeters: target
    };
  }
  return { zoneCount: 1, divisionMode: "area_count" };
}
function decorateWorkUnits(workUnits, candidateById, candidateEquivalentMeters) {
  return workUnits.map((unit) => {
    const estimatedDoorWeight = (unit.candidateIds || []).reduce((sum, candidateId) => sum + Number(candidateById.get(candidateId)?.weight || 0), 0);
    const classWeightedLengthMeters = Number(unit.classWeightedLengthMeters ?? unit.streetLengthMeters ?? 0);
    return {
      ...unit,
      estimatedDoorWeight: Number(estimatedDoorWeight.toFixed(2)),
      workloadScore: Number((classWeightedLengthMeters + estimatedDoorWeight * candidateEquivalentMeters).toFixed(2))
    };
  });
}
function unitComponents(units) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const unseen = new Set(byId.keys());
  const orderedIds = [...byId.keys()].sort(compareIds2);
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
    const sortedIds = ids.sort(compareIds2);
    components.push({
      ids: sortedIds,
      unitCount: sortedIds.length,
      workloadScore: sortedIds.reduce((sum, id) => sum + Number(byId.get(id)?.workloadScore || 0), 0),
      streetLengthMeters: sortedIds.reduce((sum, id) => sum + Number(byId.get(id)?.streetLengthMeters || 0), 0),
      classWeightedLengthMeters: sortedIds.reduce((sum, id) => sum + Number(byId.get(id)?.classWeightedLengthMeters || 0), 0),
      estimatedDoorWeight: sortedIds.reduce((sum, id) => sum + Number(byId.get(id)?.estimatedDoorWeight || 0), 0)
    });
  }
  return components.sort((left, right) => compareIds2(left.ids[0], right.ids[0]));
}
function allocateComponentZoneCounts(components, totalZoneCount) {
  const allocation = components.map(() => 1);
  let remaining = totalZoneCount - allocation.length;
  while (remaining > 0) {
    const candidates = components.map((component, index) => ({
      index,
      capacity: component.unitCount - allocation[index],
      pressure: component.workloadScore / allocation[index],
      firstId: component.ids[0]
    })).filter((candidate) => candidate.capacity > 0).sort((left, right) => right.pressure - left.pressure || compareIds2(left.firstId, right.firstId));
    if (!candidates.length) return null;
    allocation[candidates[0].index] += 1;
    remaining -= 1;
  }
  return allocation;
}
function shortestDistances(seedId, allowedIds, byId) {
  const allowed = new Set(allowedIds);
  const distances = /* @__PURE__ */ new Map([[seedId, 0]]);
  const queue = [seedId];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const unitId = queue[queueIndex];
    const distance = distances.get(unitId);
    (byId.get(unitId)?.neighborIds || []).filter((id) => allowed.has(id)).sort(compareIds2).forEach((neighborId) => {
      if (distances.has(neighborId)) return;
      distances.set(neighborId, distance + 1);
      queue.push(neighborId);
    });
  }
  return distances;
}
function chooseSeeds(componentIds, count, byId) {
  const candidates = [...componentIds].sort(compareIds2);
  const first = [...candidates].sort((left, right) => Number(byId.get(right)?.workloadScore || 0) - Number(byId.get(left)?.workloadScore || 0) || compareIds2(left, right))[0];
  const seeds = [first];
  const firstDistances = shortestDistances(first, componentIds, byId);
  const nearestSeedDistance = new Map(candidates.map((id) => [id, firstDistances.get(id) ?? Number.MAX_SAFE_INTEGER]));
  const seedSet = new Set(seeds);
  while (seeds.length < count) {
    const ranked = candidates.filter((id) => !seedSet.has(id)).map((id) => ({
      id,
      distance: nearestSeedDistance.get(id) ?? Number.MAX_SAFE_INTEGER,
      workload: Number(byId.get(id)?.workloadScore || 0)
    })).sort((left, right) => right.distance - left.distance || right.workload - left.workload || compareIds2(left.id, right.id));
    if (!ranked.length) break;
    const nextSeed = ranked[0].id;
    seeds.push(nextSeed);
    seedSet.add(nextSeed);
    const distances = shortestDistances(nextSeed, componentIds, byId);
    candidates.forEach((id) => {
      nearestSeedDistance.set(id, Math.min(nearestSeedDistance.get(id) ?? Number.MAX_SAFE_INTEGER, distances.get(id) ?? Number.MAX_SAFE_INTEGER));
    });
  }
  return seeds;
}
function compareFrontierEntry(left, right) {
  return left.distance - right.distance || compareIds2(left.unitId, right.unitId);
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
    heapPush(zone.frontier, { unitId: neighborId, distance: seedDistances.get(neighborId) ?? Number.MAX_SAFE_INTEGER });
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
    return leftError - rightError || rightNeighbors - leftNeighbors || rightWorkload - leftWorkload || compareIds2(left.unitId, right.unitId);
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
    unitIds: /* @__PURE__ */ new Set([seedId]),
    workloadScore: Number(byId.get(seedId)?.workloadScore || 0),
    frontier: [],
    frontierQueued: /* @__PURE__ */ new Set(),
    seedDistances: shortestDistances(seedId, component.ids, byId)
  }));
  zones.forEach((zone) => enqueueZoneFrontier(zone, zone.seedId, unassigned, byId, zone.seedDistances));
  while (unassigned.size) {
    const availableZones = zones.filter((zone) => discardAssignedFrontierEntries(zone, unassigned)).sort((left, right) => left.workloadScore / Math.max(1, target) - right.workloadScore / Math.max(1, target) || left.workloadScore - right.workloadScore || left.localIndex - right.localIndex);
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
  const unique = [...new Map(points.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng)).map((point) => [`${Number(point.lat).toFixed(8)}:${Number(point.lng).toFixed(8)}`, { lat: Number(point.lat), lng: Number(point.lng) }])).values()].sort((left, right) => left.lng - right.lng || left.lat - right.lat);
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
  const longitudeScale = Math.max(1e3, 111320 * Math.cos(Number(point.lat) * Math.PI / 180));
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
    const length = Math.max(1e-3, Math.hypot(dx, dy));
    const east = -dy / length * corridorMeters;
    const north = dx / length * corridorMeters;
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
    offsetPoint(point, -corridorMeters, corridorMeters)
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
    lng: longitudeTotal / pointCount
  };
}
function ownedStreetPointNearest(units, target) {
  if (!target) return null;
  let best = null;
  units.forEach((unit) => (unit.segments || []).forEach((segment) => {
    const referenceLatitude = (Number(target.lat) + Number(segment.start.lat) + Number(segment.end.lat)) / 3;
    const longitudeScale = Math.max(1e3, 111320 * Math.cos(referenceLatitude * Math.PI / 180));
    const latitudeScale = 110540;
    const startX = (Number(segment.start.lng) - Number(target.lng)) * longitudeScale;
    const startY = (Number(segment.start.lat) - Number(target.lat)) * latitudeScale;
    const endX = (Number(segment.end.lng) - Number(target.lng)) * longitudeScale;
    const endY = (Number(segment.end.lat) - Number(target.lat)) * latitudeScale;
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const position = lengthSquared <= 0 ? 0 : Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / lengthSquared));
    const point = {
      lat: Number(segment.start.lat) + (Number(segment.end.lat) - Number(segment.start.lat)) * position,
      lng: Number(segment.start.lng) + (Number(segment.end.lng) - Number(segment.start.lng)) * position
    };
    const candidate = {
      point,
      distanceSquared: (startX + position * deltaX) ** 2 + (startY + position * deltaY) ** 2,
      edgeId: segment.edgeId,
      unitId: unit.id
    };
    if (!best || candidate.distanceSquared < best.distanceSquared || candidate.distanceSquared === best.distanceSquared && compareIds2(candidate.edgeId, best.edgeId) < 0 || candidate.distanceSquared === best.distanceSquared && compareIds2(candidate.edgeId, best.edgeId) === 0 && compareIds2(candidate.unitId, best.unitId) < 0) {
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
  const seen = /* @__PURE__ */ new Set([unitIds[0]]);
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
  const adjacency = new Map(zones.map((zone) => [zone.zone_id, /* @__PURE__ */ new Set()]));
  workUnits.forEach((unit) => (unit.neighborIds || []).forEach((neighborId) => {
    const zoneId = zoneByUnitId.get(unit.id);
    const neighborZoneId = zoneByUnitId.get(neighborId);
    if (!zoneId || !neighborZoneId || zoneId === neighborZoneId) return;
    adjacency.get(zoneId)?.add(neighborZoneId);
    adjacency.get(neighborZoneId)?.add(zoneId);
  }));
  const colors = /* @__PURE__ */ new Map();
  [...zones].sort((left, right) => (adjacency.get(right.zone_id)?.size || 0) - (adjacency.get(left.zone_id)?.size || 0) || left.zone_number - right.zone_number || compareIds2(left.zone_id, right.zone_id)).forEach((zone) => {
    const neighborColors = [...adjacency.get(zone.zone_id) || []].map((neighborZoneId) => colors.get(neighborZoneId)).filter(Boolean);
    const available = ZONE_COLORS.find((color) => !neighborColors.includes(color));
    if (available) {
      colors.set(zone.zone_id, available);
      return;
    }
    const usage = new Map(ZONE_COLORS.map((color) => [color, neighborColors.filter((value) => value === color).length]));
    colors.set(zone.zone_id, [...ZONE_COLORS].sort((left, right) => usage.get(left) - usage.get(right) || ZONE_COLORS.indexOf(left) - ZONE_COLORS.indexOf(right))[0]);
  });
  return zones.map((zone) => ({ ...zone, color: colors.get(zone.zone_id) || ZONE_COLORS[0] }));
}
function finitePositive(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}
function planCanvasTerritories(input = {}) {
  const candidateInput = normalizeCandidates2(input);
  let candidates = candidateInput.candidates;
  const warnings = [...candidateInput.warnings];
  const topologyInput = {
    polygon: input.polygon,
    roadNetwork: input.roadNetwork,
    candidates,
    maxSnapDistanceMeters: input.max_snap_distance_meters ?? input.maxSnapDistanceMeters,
    roadSnapAmbiguityMeters: input.road_snap_ambiguity_meters ?? input.roadSnapAmbiguityMeters,
    roadSnapAmbiguityRatio: input.road_snap_ambiguity_ratio ?? input.roadSnapAmbiguityRatio
  };
  let topology = buildCanvasStreetWorkUnits(topologyInput);
  if (!topology.ok && candidates.length && OPTIONAL_CANDIDATE_FAILURES.has(topology.code)) {
    warnings.push(`Optional door estimates were ignored: ${topology.message}`);
    candidates = [];
    topology = buildCanvasStreetWorkUnits({ ...topologyInput, candidates: [] });
  }
  if (!topology.ok) {
    return failure(
      topology.status || "blocked",
      topology.code || "TOPOLOGY_BLOCKED",
      topology.message || "Street topology could not be verified.",
      topology.details
    );
  }
  warnings.push(...(topology.warnings || []).map((warning) => warning.message || String(warning)));
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const candidateEquivalentMeters = finitePositive(input.candidate_equivalent_meters, 35);
  const workUnits = decorateWorkUnits(topology.workUnits, candidateById, candidateEquivalentMeters);
  const segmentCount = workUnits.reduce((sum, unit) => sum + (unit.segments?.length || 0), 0);
  const reps = selectedRepIds(input);
  const totalStreetWorkloadMeters = workUnits.reduce((sum, unit) => sum + unit.workloadScore, 0);
  const totalClassWeightedLengthMeters = workUnits.reduce((sum, unit) => sum + Number(unit.classWeightedLengthMeters || 0), 0);
  const request = resolveZoneRequest(input, totalClassWeightedLengthMeters, reps);
  if (request.error) return request.error;
  const zoneCount = request.zoneCount;
  if (zoneCount > MAX_CANVAS_ZONE_COUNT) {
    return failure(
      "infeasible",
      "CANVAS_ZONE_LIMIT_EXCEEDED",
      `Canvas supports at most ${MAX_CANVAS_ZONE_COUNT} areas in one campaign.`,
      { requested_zone_count: zoneCount, maximum_zone_count: MAX_CANVAS_ZONE_COUNT, production_zone_limit: MAX_CANVAS_ZONE_COUNT }
    );
  }
  if (workUnits.length > MAX_CANVAS_INTERACTIVE_WORK_UNITS || segmentCount > MAX_CANVAS_INTERACTIVE_SEGMENTS || zoneCount * workUnits.length > MAX_CANVAS_INTERACTIVE_COMPLEXITY) {
    return failure(
      "blocked",
      "CANVAS_PLAN_TOO_COMPLEX",
      "This street network is too complex to verify safely as one campaign. Review the limits below, then reduce the boundary or area count that exceeded them.",
      {
        zone_count: zoneCount,
        work_unit_count: workUnits.length,
        segment_count: segmentCount,
        interactive_complexity: zoneCount * workUnits.length,
        maximum_work_unit_count: MAX_CANVAS_INTERACTIVE_WORK_UNITS,
        maximum_segment_count: MAX_CANVAS_INTERACTIVE_SEGMENTS,
        maximum_interactive_complexity: MAX_CANVAS_INTERACTIVE_COMPLEXITY
      }
    );
  }
  const byId = new Map(workUnits.map((unit) => [unit.id, unit]));
  const components = unitComponents(workUnits);
  const minimumZoneCount = components.length;
  const maximumZoneCount = Math.min(workUnits.length, MAX_CANVAS_ZONE_COUNT);
  if (minimumZoneCount > MAX_CANVAS_ZONE_COUNT) {
    return failure(
      "infeasible",
      "TOO_MANY_DISCONNECTED_COMPONENTS",
      `The selected streets contain ${minimumZoneCount} disconnected groups, exceeding the ${MAX_CANVAS_ZONE_COUNT}-area Canvas limit.`,
      {
        minimum_zone_count: minimumZoneCount,
        maximum_zone_count: MAX_CANVAS_ZONE_COUNT,
        production_zone_limit: MAX_CANVAS_ZONE_COUNT
      }
    );
  }
  if (zoneCount < minimumZoneCount) {
    return failure(
      "infeasible",
      "TOO_FEW_ZONES_FOR_COMPONENTS",
      `At least ${minimumZoneCount} areas are required because the selected streets have ${minimumZoneCount} disconnected road groups.`,
      { minimum_zone_count: minimumZoneCount, maximum_zone_count: maximumZoneCount }
    );
  }
  if (zoneCount > maximumZoneCount) {
    const exceedsProductionLimit = zoneCount > MAX_CANVAS_ZONE_COUNT;
    return failure(
      "infeasible",
      exceedsProductionLimit ? "CANVAS_ZONE_LIMIT_EXCEEDED" : "TOO_MANY_ZONES_FOR_WORK_UNITS",
      exceedsProductionLimit ? `Canvas supports at most ${MAX_CANVAS_ZONE_COUNT} areas in one campaign.` : `At most ${maximumZoneCount} connected areas can be created without splitting an atomic street unit.`,
      {
        requested_zone_count: zoneCount,
        minimum_zone_count: minimumZoneCount,
        maximum_zone_count: maximumZoneCount,
        production_zone_limit: MAX_CANVAS_ZONE_COUNT
      }
    );
  }
  const allocation = allocateComponentZoneCounts(components, zoneCount);
  if (!allocation) {
    return failure(
      "infeasible",
      "ZONE_ALLOCATION_INFEASIBLE",
      "The requested area count cannot be allocated without splitting an atomic street unit.",
      { minimum_zone_count: minimumZoneCount, maximum_zone_count: maximumZoneCount }
    );
  }
  const partitioned = [];
  components.forEach((component, componentIndex) => {
    const groups = partitionComponent(component, allocation[componentIndex], byId);
    if (groups) partitioned.push(...groups);
  });
  if (partitioned.length !== zoneCount) {
    return failure("infeasible", "CONNECTED_PARTITION_FAILED", "Canvas could not form the requested number of connected street areas.");
  }
  const boundary = normalizeBoundary(input.polygon);
  const workUnitZoneId = /* @__PURE__ */ new Map();
  const averageWorkload = totalStreetWorkloadMeters / zoneCount;
  const walkingMetersPerMinute = finitePositive(input.walking_meters_per_minute, 75);
  const streetPassMultiplier = finitePositive(input.street_pass_multiplier, 2);
  const doorsPerHour = finitePositive(input.doors_per_hour, 20);
  const includeDisplayCorridors = workUnits.length <= MAX_DISPLAY_CORRIDOR_WORK_UNITS;
  let zones = partitioned.map((group, index) => {
    const workUnitIds = [...group.unitIds].sort(compareIds2);
    const units = workUnitIds.map((unitId) => byId.get(unitId));
    const zoneId = `canvas-zone:${stableHash2(workUnitIds.join("|"))}`;
    workUnitIds.forEach((unitId) => workUnitZoneId.set(unitId, zoneId));
    const parts = includeDisplayCorridors ? units.flatMap((unit) => clippedPolygonParts(unitDisplayCorridor(unit), boundary)) : [];
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
      class_weighted_length_meters: segment.classWeightedLengthMeters
    })));
    const estimatedMinutes = streetLengthMeters * streetPassMultiplier / walkingMetersPerMinute + (candidates.length ? estimatedDoorWeight / doorsPerHour * 60 : 0);
    return {
      zone_id: zoneId,
      zone_number: index + 1,
      name: `Area ${index + 1}`,
      color: null,
      geometry,
      parts,
      geometry_role: "display_only",
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
      protected_unit_over_target: protectedOversize
    };
  });
  zones = colorAdjacentZones(zones, workUnits, workUnitZoneId);
  const displayGeometryComplete = zones.every((zone) => Array.isArray(zone.geometry) && zone.geometry.length >= 3 && zone.parts.length > 0);
  if (!displayGeometryComplete) warnings.push(includeDisplayCorridors ? "Some legacy display corridors could not be rendered; clipped street segments remain the authoritative territory view." : "Legacy display corridors were skipped for this large plan; colored street segments remain the authoritative territory view.");
  const workUnitZoneCounts = /* @__PURE__ */ new Map();
  zones.forEach((zone) => zone.work_unit_ids.forEach((unitId) => {
    workUnitZoneCounts.set(unitId, (workUnitZoneCounts.get(unitId) || 0) + 1);
  }));
  const expectedWorkUnitIds = workUnits.map((unit) => unit.id).sort(compareIds2);
  const missingWorkUnitIds = expectedWorkUnitIds.filter((unitId) => !workUnitZoneCounts.has(unitId));
  const duplicateWorkUnitIds = [...workUnitZoneCounts].filter(([, count]) => count !== 1).map(([unitId]) => unitId).sort(compareIds2);
  const connectedZones = zones.every((zone) => isConnected(zone.work_unit_ids, byId));
  const atomicWorkUnits = missingWorkUnitIds.length === 0 && duplicateWorkUnitIds.length === 0 && workUnitZoneCounts.size === expectedWorkUnitIds.length;
  const protectedUnitsIntact = workUnits.filter((unit) => unit.protected).every((unit) => workUnitZoneCounts.get(unit.id) === 1);
  const streetCoverageComplete = atomicWorkUnits;
  const maxWorkloadDeviationPercent = Math.round(Math.max(...zones.map((zone) => Math.abs(zone.workload_score - averageWorkload) / Math.max(1, averageWorkload))) * 100);
  const zoneByUnitId = new Map(zones.flatMap((zone) => zone.work_unit_ids.map((unitId) => [unitId, zone.zone_id])));
  const adjacencyPairs = /* @__PURE__ */ new Set();
  const crossZonePairs = /* @__PURE__ */ new Set();
  const adjacentZonePairs = /* @__PURE__ */ new Set();
  workUnits.forEach((unit) => (unit.neighborIds || []).forEach((neighborId) => {
    const pair = [unit.id, neighborId].sort(compareIds2).join("|");
    adjacencyPairs.add(pair);
    const zoneId = zoneByUnitId.get(unit.id);
    const neighborZoneId = zoneByUnitId.get(neighborId);
    if (zoneId !== neighborZoneId) {
      crossZonePairs.add(pair);
      adjacentZonePairs.add([zoneId, neighborZoneId].sort(compareIds2).join("|"));
    }
  }));
  const colorByZoneId = new Map(zones.map((zone) => [zone.zone_id, zone.color]));
  const adjacentZoneColorConflicts = [...adjacentZonePairs].filter((pair) => {
    const [firstZoneId, secondZoneId] = pair.split("|");
    return colorByZoneId.get(firstZoneId) === colorByZoneId.get(secondZoneId);
  }).length;
  const compactnessScore = adjacencyPairs.size ? Number((1 - crossZonePairs.size / adjacencyPairs.size).toFixed(3)) : 1;
  zones.filter((zone) => zone.protected_unit_over_target).forEach((zone) => {
    warnings.push(`Area ${zone.zone_number} exceeds the average workload because a protected terminal branch cannot be split.`);
  });
  if (maxWorkloadDeviationPercent > 25) {
    warnings.push(`Street-workload imbalance reaches ${maxWorkloadDeviationPercent}% because only whole connected street units can move between areas.`);
  }
  if (adjacentZoneColorConflicts) warnings.push(`${adjacentZoneColorConflicts} adjacent area color conflict${adjacentZoneColorConflicts === 1 ? "" : "s"} could not be avoided with the available palette.`);
  const hardGatesPass = streetCoverageComplete && connectedZones && atomicWorkUnits && protectedUnitsIntact;
  const status = topology.status === "degraded" || warnings.length ? "degraded" : "ready";
  const candidateSnapsById = new Map((topology.candidateSnaps || []).map((snap) => [snap.candidateId, snap]));
  const doorCandidates = candidates.map((candidate) => {
    const snap = candidateSnapsById.get(candidate.id);
    return {
      candidate_id: candidate.id,
      lat: candidate.lat,
      lng: candidate.lng,
      weight: candidate.weight,
      work_unit_id: snap?.workUnitId || null,
      zone_id: snap ? workUnitZoneId.get(snap.workUnitId) || null : null
    };
  });
  const versionSnapshot = canonicalize({
    polygon: boundary.map((point) => [Number(point.lat.toFixed(8)), Number(point.lng.toFixed(8))]),
    road_work_units: workUnits.map((unit) => ({
      id: unit.id,
      protected: unit.protected,
      neighbor_ids: [...unit.neighborIds || []].sort(compareIds2),
      segments: (unit.segments || []).map((segment) => ({
        edge_id: segment.edgeId,
        start: [Number(segment.start.lat.toFixed(10)), Number(segment.start.lng.toFixed(10))],
        end: [Number(segment.end.lat.toFixed(10)), Number(segment.end.lng.toFixed(10))],
        street_names: segment.streetNames,
        highway_types: segment.highwayTypes,
        class_weighted_length_meters: segment.classWeightedLengthMeters
      }))
    })).sort((left, right) => compareIds2(left.id, right.id)),
    candidates: doorCandidates.map((candidate) => [
      candidate.candidate_id,
      Number(candidate.lat.toFixed(8)),
      Number(candidate.lng.toFixed(8)),
      candidate.weight,
      candidate.work_unit_id
    ]),
    area_count: zoneCount,
    division_mode: request.divisionMode,
    target_street_workload_meters_per_area: request.targetStreetWorkloadMeters ?? null,
    target_street_workload_meters: request.targetStreetWorkloadMeters ?? null,
    candidate_equivalent_meters: candidateEquivalentMeters
  });
  const dataVersion = `canvas-territory:${stableHash2(JSON.stringify(versionSnapshot))}`;
  const totalStreetLengthMeters = workUnits.reduce((sum, unit) => sum + Number(unit.streetLengthMeters || 0), 0);
  const totalEstimatedDoors = candidates.length ? candidates.reduce((sum, candidate) => sum + candidate.weight, 0) : null;
  return {
    ok: hardGatesPass,
    status: hardGatesPass ? status : "blocked",
    deployable: hardGatesPass,
    planning_method: "street_workload",
    assignment_basis: "street_work_unit_ids",
    ownership_geometry: "clipped_street_segments",
    division_mode: request.divisionMode,
    workload_basis: candidates.length ? "street_length_plus_estimated_doors" : "street_length",
    selected_team_member_ids: reps,
    area_count: zoneCount,
    target_street_workload_meters_per_area: request.targetStreetWorkloadMeters ?? null,
    target_street_workload_meters: request.targetStreetWorkloadMeters ?? null,
    method: "street_workload",
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
      data_quality_status: hardGatesPass ? "verified" : "unverified",
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
      warnings
    },
    diagnostics: {
      ...topology.diagnostics,
      method: "street_workload",
      generation_method: ALGORITHM_VERSION,
      street_aligned: true,
      road_aligned: true,
      class_weighted_street_workload_meters: Number(totalClassWeightedLengthMeters.toFixed(2)),
      optional_door_estimates_used: candidates.length > 0,
      warnings
    },
    warnings
  };
}

// test/helpers/canvasLifecycleSignature.mjs
var LIFECYCLE_STATES = /* @__PURE__ */ new Set(["active", "completed", "recalled"]);
function asArray(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
function canonicalize2(value) {
  if (Array.isArray(value)) return value.map(canonicalize2);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize2(value[key])]));
}
async function sha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize2(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function canvasRepTeamMemberIds(session) {
  return [...new Set(asArray(session?.zones).map((zone) => String(zone?.assigned_team_member_id || "").trim()).filter(Boolean))].sort();
}
function canvasStoredPlanForHash(session) {
  const deploymentPlanVersion = Number(session?.deployment_plan_version);
  const planVersion = Number.isInteger(deploymentPlanVersion) && deploymentPlanVersion > 0 ? deploymentPlanVersion : Number(session?.version);
  return {
    session_name: session?.session_name || "Canvas Campaign",
    territory_model: session?.territory_model || "street_territory_v1",
    polygon: asArray(session?.polygon),
    rep_count: Number(session?.rep_count || 0),
    planning_method: session?.planning_method,
    assignment_basis: session?.assignment_basis,
    workload_basis: session?.workload_basis,
    division_mode: session?.division_mode,
    target_workload: session?.target_workload === null || session?.target_workload === void 0 ? null : Number(session.target_workload),
    ...Array.isArray(session?.selected_team_member_ids) ? { selected_team_member_ids: session.selected_team_member_ids } : {},
    zones: asArray(session?.zones),
    work_units: asArray(session?.work_units),
    qa: session?.qa || {},
    algorithm_version: session?.algorithm_version || null,
    data_version: session?.data_version || null,
    manager_id: session?.manager_id,
    version: planVersion
  };
}
function canvasLifecycleSignaturePayload(session, repIds = canvasRepTeamMemberIds(session)) {
  return {
    purpose: "firstknock-canvas-lifecycle-v2",
    session_id: session?.id,
    manager_id: session?.manager_id,
    status: session?.status,
    version: Number(session?.version),
    deployment_plan_version: Number(session?.deployment_plan_version),
    plan_hash: session?.plan_hash,
    deployed_at: session?.deployed_at,
    deployed_by_user_id: session?.deployed_by_user_id,
    deployment_idempotency_key: session?.deployment_idempotency_key,
    rep_team_member_ids: [...new Set(asArray(repIds).map(String).filter(Boolean))].sort(),
    lifecycle_state: session?.lifecycle_state || null,
    lifecycle_evidence: session?.lifecycle_evidence || null,
    closed_at: session?.closed_at || null,
    closed_by_user_id: session?.closed_by_user_id || null,
    close_action: session?.close_action || null,
    close_idempotency_key: session?.close_idempotency_key || null,
    deployment_qa: session?.deployment_qa || null
  };
}
async function signCanvasLifecycle(secret, session, repIds = canvasRepTeamMemberIds(session)) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const payload = canvasLifecycleSignaturePayload(session, repIds);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(JSON.stringify(canonicalize2(payload)))
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function hasExactLifecycleShape(session, requiredState) {
  const state = String(session?.lifecycle_state || "");
  const qa = session?.deployment_qa || {};
  const evidence = session?.lifecycle_evidence || {};
  if (!LIFECYCLE_STATES.has(state) || requiredState && state !== requiredState || String(qa.lifecycle_state || "") !== state || String(evidence.state || "") !== state || Number(evidence.schema_version) !== 1 || String(evidence.transitioned_at || "") !== String(qa.lifecycle_transitioned_at || "") || String(evidence.transitioned_by_user_id || "") !== String(qa.lifecycle_transitioned_by_user_id || "") || Number(evidence.to_version) !== Number(session?.version)) return false;
  const deploymentPlanVersion = Number(session?.deployment_plan_version);
  if (!Number.isInteger(deploymentPlanVersion) || deploymentPlanVersion < 1) return false;
  if (state === "active") {
    return session?.status === "deployed" && evidence.transition === "deploy" && qa.lifecycle_transition === "deploy" && String(evidence.transitioned_at || "") === String(session?.deployed_at || "") && String(evidence.transitioned_by_user_id || "") === String(session?.deployed_by_user_id || "") && String(evidence.idempotency_key || "") === String(session?.deployment_idempotency_key || "") && Number(evidence.from_version) === Number(session?.version) && evidence.previous_signature === null && !session?.closed_at && !session?.closed_by_user_id && !session?.close_action && !session?.close_idempotency_key;
  }
  const action = state === "completed" ? "complete" : "recall";
  return session?.status === state && String(session?.close_action || "") === action && String(session?.close_idempotency_key || "") !== "" && String(session?.closed_at || "") !== "" && String(session?.closed_by_user_id || "") !== "" && evidence.transition === action && qa.lifecycle_transition === action && String(evidence.transitioned_at || "") === String(session.closed_at) && String(evidence.transitioned_by_user_id || "") === String(session.closed_by_user_id) && String(evidence.idempotency_key || "") === String(session.close_idempotency_key) && Number(evidence.from_version) === Number(session.version) - 1 && deploymentPlanVersion <= Number(evidence.from_version) && /^[a-f0-9]{64}$/.test(String(evidence.previous_signature || ""));
}
async function verifyCanvasLifecycleSession(secret, session, requiredState = null) {
  if (!session?.plan_hash || !session?.deployment_signature || !hasExactLifecycleShape(session, requiredState)) return false;
  const calculatedPlanHash = await sha256(canvasStoredPlanForHash(session));
  if (calculatedPlanHash !== session.plan_hash) return false;
  const calculatedSignature = await signCanvasLifecycle(secret, session, canvasRepTeamMemberIds(session));
  return calculatedSignature === session.deployment_signature;
}

// canvasDeployCampaign.source.ts
var CANVAS_PRICE_FLOOR_CENTS = 1900;
var MAX_ZONES = 250;
var MAX_WORK_UNITS = 2e4;
var MAX_CONFLICT_SCAN_SESSIONS = 1e3;
var MAX_LIFECYCLE_SCAN_SESSIONS = 1e4;
var LIFECYCLE_PAGE_SIZE = 500;
var TEAM_VALIDATION_BATCH_SIZE = 100;
var MAX_OSM_JSON_BYTES = 2e7;
var MAX_OSM_ELEMENTS = 25e4;
var MAX_OSM_TILE_JSON_BYTES = 8e6;
var OVERPASS_TIMEOUT_MS = 15e3;
var OVERPASS_TOTAL_TIMEOUT_MS = 9e4;
var OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
var OVERPASS_TILE_THRESHOLD_SQ_MI = 20;
var OVERPASS_TILE_SIDE_MILES = 5;
var MAX_OVERPASS_TILES = 144;
var OVERPASS_TILE_CONCURRENCY = 2;
var CANVAS_HIGHWAY_FILTER = "primary|secondary|tertiary|unclassified|residential|living_street";
var WORKLOAD_BASES = /* @__PURE__ */ new Set(["street_length", "street_length_plus_estimated_doors"]);
var DIVISION_MODES = /* @__PURE__ */ new Set(["selected_reps", "area_count", "street_workload_target"]);
var LEASE_DURATION_MS = 12e4;
var CAMPAIGN_TRANSITION_LOCK_MS = 3e4;
var HttpError = class extends Error {
  status;
  code;
  details;
  constructor(status, code, message, details = void 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
};
function normalized(value) {
  return String(value || "").trim().toLowerCase();
}
function isoInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}
function betaGrantResolution(user) {
  const userId = String(user?.id || "");
  if (!userId) return { present: false, grant: null };
  const encoded = Deno.env.get("BETA_ACCESS_GRANTS");
  if (!encoded) return { present: false, grant: null };
  let document;
  try {
    document = JSON.parse(encoded);
  } catch {
    return { present: false, grant: null };
  }
  if (!document || Array.isArray(document) || document.version !== 1 || !document.grants || Array.isArray(document.grants) || typeof document.grants !== "object") {
    return { present: false, grant: null };
  }
  if (!Object.prototype.hasOwnProperty.call(document.grants, userId)) return { present: false, grant: null };
  const candidate = document.grants[userId];
  const startsAt = isoInstant(candidate?.starts_at);
  const endsAt = isoInstant(candidate?.ends_at);
  const precisionLimit = Number(candidate?.precision_limit);
  const canvasSeats = Number(candidate?.canvas_seats);
  if (!candidate || Array.isArray(candidate) || typeof candidate !== "object" || typeof candidate.grant_id !== "string" || !candidate.grant_id.trim() || candidate.grant_id.length > 256 || candidate.status !== "active" || !Number.isInteger(precisionLimit) || precisionLimit < 1 || precisionLimit > 1e3 || !Number.isInteger(canvasSeats) || canvasSeats < 1 || canvasSeats > 100 || startsAt === null || endsAt === null || startsAt >= endsAt) {
    return { present: true, grant: null };
  }
  const now = Date.now();
  if (now < startsAt || now >= endsAt) return { present: true, grant: null };
  return {
    present: true,
    grant: {
      grant_id: candidate.grant_id,
      precision_limit: precisionLimit,
      canvas_seats: canvasSeats,
      starts_at: candidate.starts_at,
      ends_at: candidate.ends_at
    }
  };
}
function canManageCanvas(user) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ["manager", "admin"].includes(appRole) || ["manager", "admin"].includes(accountRole);
}
function isPrivileged(user) {
  return normalized(user?.role || user?.data?.role) === "admin";
}
function stripeResourceId(value) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id || null;
}
function subscriptionPriceCents(subscription) {
  return Math.max(0, ...(subscription?.items?.data || []).map((item) => Number(item?.price?.unit_amount || 0)));
}
function subscriptionTier(subscription) {
  const priceTier = (subscription?.items?.data || []).map((item) => normalized(item?.price?.metadata?.subscription_tier)).find(Boolean);
  return priceTier || normalized(subscription?.metadata?.subscription_tier);
}
function subscriptionSeats(subscription) {
  return Math.max(0, (subscription?.items?.data || []).reduce((sum, item) => {
    const itemTier = normalized(item?.price?.metadata?.subscription_tier) || subscriptionTier(subscription);
    return sum + (itemTier === "canvas" ? Math.max(0, Math.floor(Number(item?.quantity || 1))) : 0);
  }, 0));
}
function invoiceCoversCurrentPeriod(subscription, invoice) {
  const periodStart = Number(subscription?.current_period_start);
  if (!Number.isFinite(periodStart) || periodStart <= 0) return false;
  if ((invoice?.lines?.data || []).some((line) => {
    const lineSubscription = stripeResourceId(line?.subscription);
    const start2 = Number(line?.period?.start);
    const end2 = Number(line?.period?.end);
    return (!lineSubscription || lineSubscription === subscription.id) && Number.isFinite(start2) && Number.isFinite(end2) && start2 <= periodStart && periodStart < end2;
  })) return true;
  const start = Number(invoice?.period_start);
  const end = Number(invoice?.period_end);
  return Number.isFinite(start) && Number.isFinite(end) && start <= periodStart && periodStart < end;
}
function hasPaidCurrentInvoice(subscription) {
  const invoice = subscription?.latest_invoice;
  if (!invoice || typeof invoice === "string") return false;
  const invoiceSubscription = stripeResourceId(invoice.subscription);
  return invoice.status === "paid" && Number(invoice.amount_paid || 0) > 0 && (!invoiceSubscription || invoiceSubscription === subscription.id) && invoiceCoversCurrentPeriod(subscription, invoice);
}
function ownedCanvasSubscription(subscription, user) {
  return subscription && String(subscription?.metadata?.base44_user_id || "") === String(user.id) && subscriptionTier(subscription) === "canvas" && subscriptionPriceCents(subscription) >= CANVAS_PRICE_FLOOR_CENTS;
}
async function retrieveSubscription(stripe, id) {
  try {
    return await stripe.subscriptions.retrieve(id, { expand: ["latest_invoice", "default_payment_method", "customer.invoice_settings.default_payment_method"] });
  } catch (error) {
    if (error?.raw?.code === "resource_missing" || error?.code === "resource_missing") return null;
    throw error;
  }
}
async function trialHasLivePaymentMethod(stripe, subscription, user) {
  if (stripeResourceId(subscription?.default_payment_method)) return true;
  const customer = typeof subscription?.customer === "object" ? subscription.customer : await stripe.customers.retrieve(stripeResourceId(subscription?.customer));
  if (!customer || customer.deleted) return false;
  if (customer.metadata?.base44_user_id && String(customer.metadata.base44_user_id) !== String(user.id)) return false;
  return Boolean(stripeResourceId(customer?.invoice_settings?.default_payment_method));
}
async function resolveCanvasEntitlement(user) {
  if (isPrivileged(user)) return { kind: "privileged", seats: Number.POSITIVE_INFINITY, subscription_id: null };
  const beta = betaGrantResolution(user);
  if (beta.grant) {
    return {
      kind: "beta",
      seats: beta.grant.canvas_seats,
      canvas_seats: beta.grant.canvas_seats,
      subscription_id: null,
      grant_id: beta.grant.grant_id
    };
  }
  const secret = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secret) throw new HttpError(503, "canvas_billing_unavailable", "Canvas billing verification is unavailable. Deployment was not changed.");
  const stripe = new Stripe(secret);
  const candidates = /* @__PURE__ */ new Map();
  if (user?.subscription_id) {
    const direct = await retrieveSubscription(stripe, String(user.subscription_id));
    if (direct) candidates.set(direct.id, direct);
  }
  if (user?.stripe_customer_id) {
    const listed = await stripe.subscriptions.list({
      customer: String(user.stripe_customer_id),
      status: "all",
      limit: 20,
      expand: ["data.latest_invoice", "data.default_payment_method", "data.customer.invoice_settings.default_payment_method"]
    });
    for (const subscription of listed.data || []) candidates.set(subscription.id, subscription);
  }
  if (typeof stripe.subscriptions.search === "function") {
    const escapedUserId = String(user.id).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const found = await stripe.subscriptions.search({
      query: `metadata['base44_user_id']:'${escapedUserId}'`,
      limit: 20,
      expand: ["data.latest_invoice", "data.default_payment_method", "data.customer.invoice_settings.default_payment_method"]
    });
    for (const subscription of found.data || []) candidates.set(subscription.id, subscription);
  }
  const ordered = [...candidates.values()].sort(
    (left, right) => Number(right.current_period_start || right.created || 0) - Number(left.current_period_start || left.created || 0) || String(left.id).localeCompare(String(right.id))
  );
  for (const subscription of ordered) {
    if (!ownedCanvasSubscription(subscription, user)) continue;
    const seats = subscriptionSeats(subscription);
    if (subscription.status === "active" && hasPaidCurrentInvoice(subscription)) {
      return { kind: "paid", seats, subscription_id: subscription.id };
    }
    const trialEndsAt = Number(subscription.trial_end || 0) * 1e3;
    if (subscription.status === "trialing" && trialEndsAt > Date.now() && await trialHasLivePaymentMethod(stripe, subscription, user)) {
      return { kind: "trial", seats, subscription_id: subscription.id };
    }
  }
  throw new HttpError(403, "canvas_entitlement_required", "A live paid or card-backed trial Canvas subscription is required to deploy.");
}
function requiredString(value, field, maxLength = 512) {
  const result = String(value || "").trim();
  if (!result || result.length > maxLength) throw new HttpError(400, "invalid_deploy_request", `${field} is required or invalid.`);
  return result;
}
function asArray2(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
function optionalUniqueIdList(value, field, maxItems = MAX_CONFLICT_SCAN_SESSIONS) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new HttpError(400, "invalid_deploy_request", `${field} must be an array with at most ${maxItems} IDs.`);
  const ids = value.map((id, index) => requiredString(id, `${field}[${index}]`, 256));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "invalid_deploy_request", `${field} contains duplicate IDs.`);
  return ids;
}
function sameIdSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}
function canonicalize3(value) {
  if (Array.isArray(value)) return value.map(canonicalize3);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize3(value[key])]));
}
async function sha2562(value) {
  const data = new TextEncoder().encode(JSON.stringify(canonicalize3(value)));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function deploymentSigningSecret() {
  const secret = Deno.env.get("CANVAS_DEPLOYMENT_SIGNING_SECRET") || "";
  if (secret.length < 32) throw new HttpError(503, "canvas_signing_unavailable", "Canvas deployment signing is not configured. Deployment was not changed.");
  return secret;
}
function validatePlan(session) {
  if (session.status !== "draft") throw new HttpError(409, "invalid_plan_status", "Only a draft Canvas plan can be deployed.");
  if (session.territory_model !== "street_territory_v1" || session.planning_method !== "street_workload" || session.assignment_basis !== "street_work_unit_ids") {
    throw new HttpError(422, "territory_plan_required", "Canvas deployment requires a territory-first street-workload plan.");
  }
  if (!WORKLOAD_BASES.has(session.workload_basis)) throw new HttpError(422, "invalid_workload_basis", "Canvas workload basis is missing or invalid.");
  if (!DIVISION_MODES.has(session.division_mode)) throw new HttpError(422, "invalid_division_mode", "Canvas division mode is missing or invalid.");
  if (session.division_mode === "street_workload_target" && !(Number(session.target_workload) > 0)) {
    throw new HttpError(422, "invalid_workload_target", "Workload-sized Canvas plans require positive class-weighted street meters per area.");
  }
  if (session.workload_basis !== "street_length") {
    throw new HttpError(422, "estimated_workload_preview_only", "Optional door estimates are preview-only in this release. Regenerate using street-length workload before deployment.");
  }
  if (!String(session.algorithm_version || "").trim() || !String(session.data_version || "").trim()) {
    throw new HttpError(422, "unversioned_plan", "Canvas algorithm_version and data_version are required for deployment.");
  }
  const zones = asArray2(session.zones);
  const workUnits = asArray2(session.work_units);
  if (zones.length < 1 || zones.length > MAX_ZONES || workUnits.length < 1 || workUnits.length > MAX_WORK_UNITS) {
    throw new HttpError(422, "invalid_plan_size", "Canvas deployment requires supported zones and street work units.");
  }
  const segmentCount = workUnits.reduce((sum, unit) => sum + asArray2(unit?.segments).length, 0);
  if (workUnits.length > MAX_CANVAS_INTERACTIVE_WORK_UNITS || segmentCount > MAX_CANVAS_INTERACTIVE_SEGMENTS || zones.length * workUnits.length > MAX_CANVAS_INTERACTIVE_COMPLEXITY) {
    throw new HttpError(422, "plan_too_complex", "This street plan exceeds the supported street-unit, segment, or area-by-unit limit. Reduce the boundary or area count that exceeded its limit.");
  }
  const expectedUnitIds = /* @__PURE__ */ new Set();
  for (const unit of workUnits) {
    const unitId = requiredString(unit?.id, "work_unit.id");
    if (expectedUnitIds.has(unitId)) throw new HttpError(422, "duplicate_work_unit", `Work unit ${unitId} is duplicated.`);
    if (!asArray2(unit?.segments).length) throw new HttpError(422, "invalid_work_unit", `Work unit ${unitId} has no canonical road segments.`);
    expectedUnitIds.add(unitId);
  }
  const counts = /* @__PURE__ */ new Map();
  const zoneIds = /* @__PURE__ */ new Set();
  const assignedRepIds = /* @__PURE__ */ new Set();
  const zoneAssigneeIds = [];
  for (const zone of zones) {
    const zoneId = requiredString(zone?.zone_id, "zone_id");
    if (zoneIds.has(zoneId)) throw new HttpError(422, "duplicate_zone", `Zone ${zoneId} is duplicated.`);
    zoneIds.add(zoneId);
    if (!String(zone?.assigned_team_member_id || "").trim()) {
      throw new HttpError(422, "selected_rep_contract_failed", `Zone ${zoneId} must be assigned before deployment.`);
    }
    const repId = requiredString(zone?.assigned_team_member_id, `Zone ${zoneId} assigned_team_member_id`, 256);
    assignedRepIds.add(repId);
    zoneAssigneeIds.push(repId);
    const ids = asArray2(zone?.work_unit_ids).map((id) => requiredString(id, `Zone ${zoneId} work_unit_ids`));
    if (!ids.length || new Set(ids).size !== ids.length) throw new HttpError(422, "work_unit_integrity_failed", `Zone ${zoneId} needs unique street work units.`);
    for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const missing = [...expectedUnitIds].filter((id) => !counts.has(id));
  const duplicate = [...counts].filter(([, count]) => count !== 1).map(([id]) => id);
  const extra = [...counts.keys()].filter((id) => !expectedUnitIds.has(id));
  if (missing.length || duplicate.length || extra.length) {
    throw new HttpError(422, "work_unit_integrity_failed", "Street work units must form one complete, exclusive territory partition.", {
      missing_work_unit_ids: missing.slice(0, 100),
      duplicate_work_unit_ids: duplicate.slice(0, 100),
      extra_work_unit_ids: extra.slice(0, 100)
    });
  }
  const selected = asArray2(session.selected_team_member_ids).map((id, index) => requiredString(id, `selected_team_member_ids[${index}]`, 256));
  if (!selected.length || new Set(selected).size !== selected.length || !sameIdSet(selected, [...assignedRepIds])) {
    throw new HttpError(422, "selected_rep_contract_failed", "Every assigned rep must be in the manager-selected roster with no omitted or extra reps.");
  }
  if (session.division_mode === "selected_reps" && (zones.length !== selected.length || new Set(zoneAssigneeIds).size !== zones.length)) {
    throw new HttpError(422, "selected_rep_contract_failed", "Selected-rep planning requires exactly one area per selected rep.");
  }
  const qa = session.qa || {};
  if (qa.deployable !== true || qa.street_coverage_complete !== true || qa.no_duplicate_work_units !== true || qa.connected_zones !== true || qa.atomic_work_units !== true || qa.protected_units_intact !== true || Number(qa.cul_de_sac_splits || 0) !== 0) {
    throw new HttpError(422, "street_partition_qa_failed", "Canvas street coverage, connectivity, or protected cul-de-sac QA did not pass.");
  }
  const workloadScores = zones.map((zone) => Number(zone?.workload_score));
  const averageWorkload = workloadScores.length && workloadScores.every((score) => Number.isFinite(score) && score >= 0)
    ? workloadScores.reduce((sum, score) => sum + score, 0) / workloadScores.length
    : 0;
  if (!(averageWorkload > 0)) {
    throw new HttpError(422, "workload_balance_unverified", "Canvas could not verify territory workload balance. Regenerate before deployment.");
  }
  const maxWorkloadDeviationPercent = Math.round(Math.max(...workloadScores.map((score) => Math.abs(score - averageWorkload) / averageWorkload)) * 100);
  if (maxWorkloadDeviationPercent > 25 && (qa.manager_workload_exception_acknowledged !== true
    || Number(qa.manager_workload_exception_deviation_percent) !== maxWorkloadDeviationPercent
    || !String(qa.manager_workload_exception_acknowledged_at || "").trim()
    || String(qa.manager_workload_exception_acknowledged_by_user_id || "") !== String(session.manager_id || ""))) {
    throw new HttpError(422, "workload_exception_acknowledgement_required", "The manager must review and accept this uneven territory split before deployment.");
  }
  return {
    zones,
    workUnits,
    assignedRepIds: [...assignedRepIds],
    deploymentQa: {
      identity_validator_version: 2,
      territory_model: "street_territory_v1",
      street_work_units_complete_and_exclusive: true,
      selected_reps_one_to_one: session.division_mode === "selected_reps" ? true : null,
      zone_count: zones.length,
      work_unit_count: workUnits.length,
      total_street_length_meters: Number(qa.total_street_length_meters || 0),
      max_workload_deviation_percent: maxWorkloadDeviationPercent,
      manager_workload_exception_acknowledged: maxWorkloadDeviationPercent > 25 ? true : null,
      manager_workload_exception_acknowledged_at: maxWorkloadDeviationPercent > 25 ? qa.manager_workload_exception_acknowledged_at : null,
      manager_workload_exception_acknowledged_by_user_id: maxWorkloadDeviationPercent > 25 ? qa.manager_workload_exception_acknowledged_by_user_id : null
    }
  };
}
async function filterRowsByIds(entity, ids, extraFilter) {
  const rows = [];
  for (let index = 0; index < ids.length; index += TEAM_VALIDATION_BATCH_SIZE) {
    const chunk = ids.slice(index, index + TEAM_VALIDATION_BATCH_SIZE);
    rows.push(...asArray2(await entity.filter({ ...extraFilter, id: { $in: chunk } }, null, chunk.length, 0)));
  }
  return rows;
}
async function validateTeamMembers(base44, managerId, memberIds) {
  const requestedMemberIds = [...new Set(memberIds.map(String))];
  if (requestedMemberIds.length !== memberIds.length) {
    throw new HttpError(422, "invalid_team_assignment", "The selected Canvas roster contains duplicate team members.");
  }
  const memberRows = await filterRowsByIds(base44.entities.TeamMember, requestedMemberIds, { manager_id: managerId });
  const membersById = new Map(memberRows.map((member) => [String(member?.id || ""), member]));
  if (membersById.size !== requestedMemberIds.length || memberRows.length !== requestedMemberIds.length) {
    throw new HttpError(422, "invalid_team_assignment", "One or more selected team members are missing or belong to another manager.");
  }
  const members = requestedMemberIds.map((memberId) => membersById.get(memberId));
  for (const member of members) {
    if (!member || member.manager_id !== managerId || member.status !== "active" || !member.user_id || normalized(member.role) !== "rep") {
      throw new HttpError(422, "invalid_team_assignment", `Team member ${member?.id || "unknown"} is not an active linked rep owned by this manager.`);
    }
  }
  const userIds = members.map((member) => String(member.user_id));
  if (new Set(userIds).size !== userIds.length) {
    throw new HttpError(422, "unverified_team_link", "Each selected Canvas rep must be linked to a distinct authenticated user.");
  }
  const userRows = await filterRowsByIds(base44.asServiceRole.entities.User, userIds, { team_manager_id: managerId });
  const usersById = new Map(userRows.map((repUser) => [String(repUser?.id || ""), repUser]));
  if (usersById.size !== userIds.length || userRows.length !== userIds.length) {
    throw new HttpError(422, "unverified_team_link", "One or more selected reps are not linked to an authenticated user in this manager's tenant.");
  }
  for (const member of members) {
    const repUser = usersById.get(String(member.user_id));
    if (!repUser || repUser.id !== member.user_id || repUser.team_manager_id !== managerId || normalized(repUser.email) !== normalized(member.email)) {
      throw new HttpError(422, "unverified_team_link", `Team member ${member.id} is not linked to an authenticated user in this manager's tenant.`);
    }
  }
  return members;
}
function activeValidDeployments(validSessions) {
  const validById = new Map(validSessions.map((session) => [session.id, session]));
  const supersededIds = /* @__PURE__ */ new Set();
  for (const newer of validSessions) {
    const newerTimestamp = Date.parse(newer.deployed_at || "");
    for (const supersededId of asArray2(newer.deployment_qa?.superseded_session_ids)) {
      const older = validById.get(supersededId);
      if (!older || older.id === newer.id || older.manager_id !== newer.manager_id) continue;
      const olderTimestamp = Date.parse(older.deployed_at || "");
      if (Number.isFinite(newerTimestamp) && Number.isFinite(olderTimestamp) && newerTimestamp >= olderTimestamp) supersededIds.add(older.id);
    }
  }
  return validSessions.filter((session) => session.status === "deployed" && session.lifecycle_state === "active" && !supersededIds.has(session.id));
}
async function loadActiveValidDeployments(base44, managerId, signingSecret) {
  const results = [];
  for (const status of ["deployed", "completed", "recalled"]) {
    let skip = 0;
    while (true) {
      const page = asArray2(await base44.entities.CanvasSession.filter({ manager_id: managerId, status }, "-deployed_at", LIFECYCLE_PAGE_SIZE, skip));
      results.push(...page);
      if (results.length > MAX_LIFECYCLE_SCAN_SESSIONS) throw new HttpError(503, "canvas_lifecycle_scan_limit", "Canvas lifecycle history exceeds the safe verification limit. No deployment was changed.");
      if (page.length < LIFECYCLE_PAGE_SIZE) break;
      skip += page.length;
    }
  }
  const candidates = [...new Map(results.filter((session) => session.manager_id === managerId).map((session) => [session.id, session])).values()];
  const valid = [];
  const invalid = [];
  for (const candidate of candidates) {
    if (await verifyCanvasLifecycleSession(signingSecret, candidate)) valid.push(candidate);
    else invalid.push(candidate.id);
  }
  if (invalid.length) throw new HttpError(409, "canvas_lifecycle_integrity_failed", "Existing Canvas lifecycle history failed signature verification. No deployment was changed.", { invalid_session_ids: invalid.slice(0, 100) });
  const active = activeValidDeployments(valid);
  if (active.length > MAX_CONFLICT_SCAN_SESSIONS) throw new HttpError(503, "canvas_conflict_scan_limit", "Too many active Canvas sessions exist to verify overlap safely.");
  return active;
}
function orientation2(a, b, c) {
  return (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
}
function properSegmentCross(a, b, c, d) {
  const o1 = orientation2(a, b, c);
  const o2 = orientation2(a, b, d);
  const o3 = orientation2(c, d, a);
  const o4 = orientation2(c, d, b);
  const epsilon = 1e-12;
  return Math.abs(o1) > epsilon && Math.abs(o2) > epsilon && Math.abs(o3) > epsilon && Math.abs(o4) > epsilon && Math.sign(o1) !== Math.sign(o2) && Math.sign(o3) !== Math.sign(o4);
}
function pointStrictlyInside(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = a.lat > point.lat !== b.lat > point.lat && point.lng < (b.lng - a.lng) * (point.lat - a.lat) / (b.lat - a.lat || Number.EPSILON) + a.lng;
    if (intersects) inside = !inside;
  }
  return inside;
}
function canonicalPolygon(polygon) {
  return asArray2(polygon).map((point) => [Number(Number(point?.lat ?? point?.[0]).toFixed(7)), Number(Number(point?.lng ?? point?.[1]).toFixed(7))]);
}
function polygonsOverlap(left, right) {
  if (JSON.stringify(canonicalPolygon(left)) === JSON.stringify(canonicalPolygon(right))) return true;
  if (left.some((point) => pointStrictlyInside(point, right)) || right.some((point) => pointStrictlyInside(point, left))) return true;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = left[(i + 1) % left.length];
    for (let j = 0; j < right.length; j += 1) {
      if (properSegmentCross(a, b, right[j], right[(j + 1) % right.length])) return true;
    }
  }
  return false;
}
function deploymentOverlapConflicts(session, activeDeployments) {
  const incomingUnits = new Set(asArray2(session.work_units).map((unit) => String(unit?.id || "")).filter(Boolean));
  return activeDeployments.filter((candidate) => candidate.id !== session.id).map((candidate) => {
    const sharedWorkUnitIds = asArray2(candidate.work_units).map((unit) => String(unit?.id || "")).filter((id) => incomingUnits.has(id)).sort();
    const boundaryOverlap = polygonsOverlap(asArray2(session.polygon), asArray2(candidate.polygon));
    return {
      session_id: candidate.id,
      session_name: candidate.session_name || "Canvas Campaign",
      deployed_at: candidate.deployed_at,
      boundary_overlap: boundaryOverlap,
      work_unit_id_count: sharedWorkUnitIds.length,
      work_unit_ids: sharedWorkUnitIds.slice(0, 100),
      details_truncated: sharedWorkUnitIds.length > 100
    };
  }).filter((conflict) => conflict.boundary_overlap || conflict.work_unit_id_count > 0).sort((left, right) => String(left.session_id).localeCompare(String(right.session_id)));
}
function requireExactSupersedeConfirmation(providedIds, conflicts) {
  const requiredIds = conflicts.map((conflict) => conflict.session_id).sort();
  const provided = [...providedIds].sort();
  if (sameIdSet(provided, requiredIds)) return requiredIds;
  const requiredSet = new Set(requiredIds);
  const providedSet = new Set(provided);
  throw new HttpError(409, "canvas_deployment_overlap", "This territory overlaps active Canvas campaigns. Confirm the exact campaigns to replace them.", {
    required_supersede_session_ids: requiredIds,
    provided_supersede_session_ids: provided,
    missing_supersede_session_ids: requiredIds.filter((id) => !providedSet.has(id)),
    unexpected_supersede_session_ids: provided.filter((id) => !requiredSet.has(id)),
    conflicts
  });
}
function polygonToOverpassPoly(polygon) {
  return asArray2(polygon).map((point) => `${Number(point.lat).toFixed(7)} ${Number(point.lng).toFixed(7)}`).join(" ");
}
function buildOverpassRoadQuery(polygon) {
  const poly = polygonToOverpassPoly(polygon);
  return `[out:json][timeout:25];
(
  way["highway"~"^(${CANVAS_HIGHWAY_FILTER})$"]["bridge"!="yes"]["tunnel"!="yes"](poly:"${poly}");
);
out body;
>;
out body qt;`;
}
function canvasRoadBounds(polygon) {
  const points = asArray2(polygon);
  if (!points.length) return null;
  return {
    south: Math.min(...points.map((point) => Number(point.lat))),
    west: Math.min(...points.map((point) => Number(point.lng))),
    north: Math.max(...points.map((point) => Number(point.lat))),
    east: Math.max(...points.map((point) => Number(point.lng)))
  };
}
function canvasRoadTiles(polygon) {
  const bounds = canvasRoadBounds(polygon);
  if (!bounds) return [];
  const centerLatitude = (bounds.south + bounds.north) / 2;
  const widthMiles = Math.max(0, (bounds.east - bounds.west) * 69 * Math.cos(centerLatitude * Math.PI / 180));
  const heightMiles = Math.max(0, (bounds.north - bounds.south) * 69);
  if (widthMiles * heightMiles <= OVERPASS_TILE_THRESHOLD_SQ_MI && asArray2(polygon).length <= 120) return [];
  const columns = Math.max(1, Math.ceil(widthMiles / OVERPASS_TILE_SIDE_MILES));
  const rows = Math.max(1, Math.ceil(heightMiles / OVERPASS_TILE_SIDE_MILES));
  if (columns * rows > MAX_OVERPASS_TILES) {
    throw new HttpError(413, "canvas_topology_area_too_complex", "This boundary spans too many road-verification tiles. Nothing was deployed.", { tile_count: columns * rows, max_tiles: MAX_OVERPASS_TILES });
  }
  const latitudeStep = (bounds.north - bounds.south) / rows;
  const longitudeStep = (bounds.east - bounds.west) / columns;
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      tiles.push({
        south: bounds.south + latitudeStep * row,
        west: bounds.west + longitudeStep * column,
        north: row === rows - 1 ? bounds.north : bounds.south + latitudeStep * (row + 1),
        east: column === columns - 1 ? bounds.east : bounds.west + longitudeStep * (column + 1)
      });
    }
  }
  return tiles;
}
function buildOverpassRoadTileQuery(bounds) {
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].map((value) => Number(value).toFixed(7)).join(",");
  return `[out:json][timeout:25];
(
  way["highway"~"^(${CANVAS_HIGHWAY_FILTER})$"]["bridge"!="yes"]["tunnel"!="yes"](${bbox});
);
out body;
>;
out body qt;`;
}
async function readBoundedOverpassText(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("response exceeds the supported size");
  if (!response.body?.getReader) {
    const encoded2 = await response.text();
    const byteLength2 = new TextEncoder().encode(encoded2).byteLength;
    if (byteLength2 > maxBytes) throw new Error("response exceeds the supported size");
    return { encoded: encoded2, byteLength: byteLength2 };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
    byteLength += chunk.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("response exceeds the supported size");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { encoded: new TextDecoder().decode(bytes), byteLength };
}
async function fetchOverpassEndpoint(url, query, { signal, maxResponseBytes = MAX_OSM_JSON_BYTES } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
  const abortFromBatch = () => controller.abort(signal?.reason);
  signal?.addEventListener?.("abort", abortFromBatch, { once: true });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "FirstKnock-Canvas-Territory/2.0",
        "Referer": "https://firstknock.io/"
      },
      body: new URLSearchParams({ data: query }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { encoded, byteLength } = await readBoundedOverpassText(response, maxResponseBytes);
    const parsed = JSON.parse(encoded);
    if (!Array.isArray(parsed?.elements) || parsed.elements.length > MAX_OSM_ELEMENTS) throw new Error("response has an invalid element count");
    return { roadNetwork: parsed, endpoint: new URL(url).hostname, byteLength };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", abortFromBatch);
  }
}
async function fetchServerRoadQuery(query, options = {}) {
  const failures = [];
  for (const url of OVERPASS_URLS) {
    if (options.signal?.aborted) throw new Error("Canvas road verification was cancelled.");
    try {
      return await fetchOverpassEndpoint(url, query, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failures.push(`${new URL(url).hostname}: ${String(error?.message || error).slice(0, 160)}`);
    }
  }
  throw new HttpError(503, "canvas_topology_source_unavailable", "Server-owned OSM road verification is unavailable. Nothing was deployed.", { failures });
}
async function fetchServerRoadNetwork(polygon) {
  const tiles = canvasRoadTiles(polygon);
  const batchController = new AbortController();
  let overallTimedOut = false;
  const overallTimeout = setTimeout(() => {
    overallTimedOut = true;
    batchController.abort();
  }, OVERPASS_TOTAL_TIMEOUT_MS);
  if (!tiles.length) {
    try {
      return await fetchServerRoadQuery(buildOverpassRoadQuery(polygon), {
        signal: batchController.signal,
        maxResponseBytes: MAX_OSM_JSON_BYTES
      });
    } catch (error) {
      if (overallTimedOut) throw new HttpError(503, "canvas_topology_source_timeout", "Server-owned OSM road verification exceeded its safe time limit. Nothing was deployed.");
      throw error;
    } finally {
      clearTimeout(overallTimeout);
    }
  }
  const endpoints = /* @__PURE__ */ new Set();
  const byIdentity = /* @__PURE__ */ new Map();
  let cursor = 0;
  let cumulativeBytes = 0;
  let fatalError = null;
  const worker = async () => {
    while (cursor < tiles.length && !fatalError) {
      const index = cursor;
      cursor += 1;
      const fetched = await fetchServerRoadQuery(buildOverpassRoadTileQuery(tiles[index]), {
        signal: batchController.signal,
        maxResponseBytes: MAX_OSM_TILE_JSON_BYTES
      });
      cumulativeBytes += fetched.byteLength;
      for (const element of asArray2(fetched.roadNetwork?.elements)) {
        const key = `${String(element?.type || "")}:${String(element?.id ?? "")}`;
        if (key === ":") continue;
        const existing = byIdentity.get(key);
        if (!existing || JSON.stringify(element).length > JSON.stringify(existing).length) byIdentity.set(key, element);
      }
      if (cumulativeBytes > MAX_OSM_JSON_BYTES || byIdentity.size > MAX_OSM_ELEMENTS) {
        fatalError = new HttpError(413, "canvas_topology_too_complex", "The verified street network exceeds the supported campaign size. Nothing was deployed.", {
          cumulative_response_bytes: cumulativeBytes,
          element_count: byIdentity.size,
          max_bytes: MAX_OSM_JSON_BYTES,
          max_elements: MAX_OSM_ELEMENTS
        });
        batchController.abort();
        throw fatalError;
      }
      endpoints.add(fetched.endpoint);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(OVERPASS_TILE_CONCURRENCY, tiles.length) }, () => worker()));
  } catch (error) {
    if (fatalError) throw fatalError;
    if (overallTimedOut) throw new HttpError(503, "canvas_topology_source_timeout", "Server-owned OSM road verification exceeded its safe time limit. Nothing was deployed.");
    throw error;
  } finally {
    clearTimeout(overallTimeout);
  }
  const elements = [...byIdentity.values()].sort((left, right) => String(left.type).localeCompare(String(right.type)) || Number(left.id) - Number(right.id));
  if (elements.length > MAX_OSM_ELEMENTS) throw new HttpError(413, "canvas_topology_too_complex", "The verified street network is too large for one Canvas campaign. Nothing was deployed.", { element_count: elements.length, max_elements: MAX_OSM_ELEMENTS });
  const roadNetwork = { elements };
  if (JSON.stringify(roadNetwork).length > MAX_OSM_JSON_BYTES) throw new HttpError(413, "canvas_topology_too_complex", "The verified street network exceeds the supported payload size. Nothing was deployed.");
  return { roadNetwork, endpoint: `tiled:${[...endpoints].sort().join(",")}` };
}
function canonicalPoint(point) {
  const lat = Number(point?.lat ?? point?.[0]);
  const lng = Number(point?.lng ?? point?.lon ?? point?.[1]);
  return [Number(lat.toFixed(8)), Number(lng.toFixed(8))];
}
function canonicalPointSequence(value) {
  return asArray2(value).map(canonicalPoint);
}
function canonicalWorkUnit(unit) {
  return {
    id: String(unit?.id || ""),
    protected: unit?.protected === true,
    neighbor_ids: asArray2(unit?.neighbor_ids ?? unit?.neighborIds).map(String).sort(),
    street_length_meters: Number(Number(unit?.street_length_meters ?? unit?.streetLengthMeters ?? 0).toFixed(2)),
    segments: asArray2(unit?.segments).map((segment) => {
      const start = canonicalPoint(segment?.start);
      const end = canonicalPoint(segment?.end);
      const ordered = JSON.stringify(start).localeCompare(JSON.stringify(end)) <= 0 ? [start, end] : [end, start];
      return { start: ordered[0], end: ordered[1], length_meters: Number(Number(segment?.length_meters ?? segment?.lengthMeters ?? 0).toFixed(2)) };
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  };
}
function zoneSignature(zone) {
  return JSON.stringify(asArray2(zone?.work_unit_ids ?? zone?.street_work_unit_ids).map(String).sort());
}
function canonicalZoneDisplay(zone) {
  return {
    zone_id: String(zone?.zone_id || ""),
    geometry: canonicalPointSequence(zone?.geometry),
    parts: asArray2(zone?.parts).map(canonicalPointSequence),
    drop_point: zone?.drop_point ? canonicalPoint(zone.drop_point) : null
  };
}
async function verifyServerTopology(session) {
  const { roadNetwork, endpoint } = await fetchServerRoadNetwork(session.polygon);
  const serverPlan = planCanvasTerritories({
    polygon: session.polygon,
    roadNetwork,
    ...session.division_mode === "street_workload_target" ? {
      target_street_workload_meters_per_area: Number(session.target_workload)
    } : {
      requested_zone_count: asArray2(session.zones).length,
      zoneCount: asArray2(session.zones).length
    },
    workload_basis: session.workload_basis,
    division_mode: session.division_mode,
    selected_team_member_ids: session.division_mode === "selected_reps" ? asArray2(session.selected_team_member_ids) : []
  });
  if (!serverPlan?.ok || serverPlan?.deployable !== true) {
    throw new HttpError(422, "server_topology_verification_failed", "The server could not reproduce a deployable street territory.", {
      topology_code: serverPlan?.code || "TOPOLOGY_BLOCKED",
      topology_message: serverPlan?.message || "Street topology verification failed."
    });
  }
  if (String(session.algorithm_version || "") !== String(serverPlan.algorithm_version || "")) {
    throw new HttpError(409, "topology_algorithm_version_mismatch", "This draft uses a different territory algorithm version. Regenerate it before deployment.");
  }
  if (String(session.data_version || "") !== String(serverPlan.data_version || "")) {
    throw new HttpError(409, "topology_data_version_mismatch", "The OSM street snapshot changed. Regenerate this territory before deployment.");
  }
  const submittedUnits = asArray2(session.work_units).map(canonicalWorkUnit).sort((a, b) => a.id.localeCompare(b.id));
  const expectedUnits = asArray2(serverPlan.work_units ?? serverPlan.workUnits).map(canonicalWorkUnit).sort((a, b) => a.id.localeCompare(b.id));
  if (!expectedUnits.length || JSON.stringify(submittedUnits) !== JSON.stringify(expectedUnits)) {
    throw new HttpError(422, "server_work_unit_snapshot_mismatch", "Stored street segments do not match the server-recomputed OSM work units.");
  }
  const expectedBySignature = new Map(asArray2(serverPlan.zones).map((zone) => [zoneSignature(zone), zone]));
  const submittedSignatures = asArray2(session.zones).map(zoneSignature).sort();
  const expectedSignatures = [...expectedBySignature.keys()].sort();
  if (JSON.stringify(submittedSignatures) !== JSON.stringify(expectedSignatures)) {
    throw new HttpError(422, "server_zone_topology_mismatch", "Submitted areas do not match the connected street partition recomputed by the server.");
  }
  const workloadMismatches = asArray2(session.zones).filter((zone) => {
    const expected = expectedBySignature.get(zoneSignature(zone));
    return !expected || Math.abs(Number(zone?.workload_score) - Number(expected?.workload_score)) > 0.01;
  }).map((zone) => zone.zone_id);
  if (workloadMismatches.length) {
    throw new HttpError(422, "server_zone_workload_mismatch", "Area workload scores do not match the server-recomputed street territory.", { mismatch_zone_ids: workloadMismatches });
  }
  const displayMismatches = asArray2(session.zones).filter((zone) => {
    const expected = expectedBySignature.get(zoneSignature(zone));
    return !expected || JSON.stringify(canonicalZoneDisplay(zone)) !== JSON.stringify(canonicalZoneDisplay(expected));
  }).map((zone) => zone.zone_id);
  if (displayMismatches.length) throw new HttpError(422, "server_zone_geometry_mismatch", "Area geometry does not match the server-recomputed street territory.", { mismatch_zone_ids: displayMismatches });
  return {
    validator_version: 3,
    topology_validator: "server_osm_street_territory_v1",
    server_topology_verified: true,
    server_algorithm_version: serverPlan.algorithm_version,
    server_data_version: serverPlan.data_version,
    road_source: endpoint,
    road_element_count: asArray2(roadNetwork.elements).length,
    street_work_unit_snapshot_verified: true,
    zone_partition_verified: true,
    zone_display_geometry_verified: true,
    connected_zones: serverPlan.qa?.connected_zones === true,
    atomic_work_units: serverPlan.qa?.atomic_work_units === true,
    protected_units_intact: serverPlan.qa?.protected_units_intact === true,
    cul_de_sac_splits: Number(serverPlan.qa?.cul_de_sac_splits) || 0,
    street_coverage_complete: serverPlan.qa?.street_coverage_complete === true,
    total_street_length_meters: Number(serverPlan.qa?.total_street_length_meters || 0)
  };
}
function leaseToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function acquireManagerLease(base44, managerId) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const token = leaseToken();
  const expiresAt = new Date(now + LEASE_DURATION_MS).toISOString();
  const mutation = await base44.asServiceRole.entities.User.updateMany({
    id: managerId,
    $or: [
      { canvas_deployment_lock_token: null },
      { canvas_deployment_lock_token: { $exists: false } },
      { canvas_deployment_lock_expires_at: { $lte: nowIso } }
    ]
  }, { $set: {
    canvas_deployment_lock_token: token,
    canvas_deployment_lock_acquired_at: nowIso,
    canvas_deployment_lock_expires_at: expiresAt
  } });
  if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
    throw new HttpError(409, "canvas_deployment_in_progress", "Another Canvas deployment won the manager lock. Retry in a moment.");
  }
  const lockedUser = await base44.asServiceRole.entities.User.get(managerId).catch(() => null);
  if (!lockedUser || String(lockedUser.canvas_deployment_lock_token || "") !== token || String(lockedUser.canvas_deployment_lock_expires_at || "") !== expiresAt) {
    throw new HttpError(503, "canvas_deployment_lease_unverified", "Canvas could not verify its manager deployment lock. Nothing was deployed.");
  }
  return { token, expires_at: expiresAt };
}
async function releaseManagerLease(base44, managerId, lease) {
  if (!lease) return;
  await base44.asServiceRole.entities.User.updateMany({
    id: managerId,
    canvas_deployment_lock_token: lease.token
  }, { $unset: {
    canvas_deployment_lock_token: "",
    canvas_deployment_lock_acquired_at: "",
    canvas_deployment_lock_expires_at: ""
  } }).catch(() => null);
}
async function acquireCampaignTransitionLock(base44, session) {
  const now = /* @__PURE__ */ new Date();
  const lockToken = leaseToken();
  const mutation = await base44.asServiceRole.entities.CanvasSession.updateMany({
    id: session.id,
    manager_id: session.manager_id,
    status: "deployed",
    $or: [
      { canvas_field_write_lock_token: null },
      { canvas_field_write_lock_token: { $exists: false } },
      { canvas_field_write_lock_expires_at: { $lte: now.toISOString() } }
    ]
  }, { $set: {
    canvas_field_write_lock_token: lockToken,
    canvas_field_write_lock_acquired_at: now.toISOString(),
    canvas_field_write_lock_expires_at: new Date(now.getTime() + CAMPAIGN_TRANSITION_LOCK_MS).toISOString()
  } });
  if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
    throw new HttpError(409, "campaign_field_write_in_progress", `Campaign ${session.session_name || session.id} is saving a house decision or another lifecycle transition. Retry deployment.`);
  }
  const locked = await base44.asServiceRole.entities.CanvasSession.get(session.id).catch(() => null);
  if (!locked || locked.canvas_field_write_lock_token !== lockToken) {
    throw new HttpError(503, "campaign_transition_lock_unverified", "Canvas could not verify a replacement lock. Nothing was deployed.");
  }
  return { session_id: session.id, manager_id: session.manager_id, token: lockToken };
}
async function releaseCampaignTransitionLock(base44, lock) {
  await base44.asServiceRole.entities.CanvasSession.updateMany({
    id: lock.session_id,
    manager_id: lock.manager_id,
    canvas_field_write_lock_token: lock.token
  }, { $unset: {
    canvas_field_write_lock_token: "",
    canvas_field_write_lock_acquired_at: "",
    canvas_field_write_lock_expires_at: ""
  } }).catch(() => null);
}
Deno.serve(async (req) => {
  let lease = null;
  let leaseBase44 = null;
  let leaseManagerId = null;
  const transitionLocks = [];
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: "Only managers can deploy Canvas campaigns." }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const sessionId = requiredString(body?.session_id, "session_id", 256);
    const idempotencyKey = requiredString(body?.idempotency_key, "idempotency_key", 128);
    if (idempotencyKey.length < 8 || !/^[A-Za-z0-9:_-]+$/.test(idempotencyKey)) {
      throw new HttpError(400, "invalid_deploy_request", "idempotency_key must be 8-128 letters, numbers, colons, underscores, or hyphens.");
    }
    const session = await base44.entities.CanvasSession.get(sessionId).catch(() => null);
    if (!session) throw new HttpError(404, "session_not_found", "Canvas session not found.");
    if (session.manager_id !== user.id) throw new HttpError(403, "forbidden", "This Canvas session belongs to another manager.");
    const signingSecret = deploymentSigningSecret();
    if (session.status === "deployed") {
      if (session.deployment_idempotency_key !== idempotencyKey) throw new HttpError(409, "already_deployed", "This Canvas campaign is already deployed.");
      if (!await verifyCanvasLifecycleSession(signingSecret, session, "active")) throw new HttpError(409, "deployment_signature_invalid", "The deployed Canvas snapshot failed integrity verification.");
      return Response.json({ success: true, idempotent: true, session_id: session.id, version: Number(session.version), status: "deployed", deployed_at: session.deployed_at, delivery_count: Number(session.rep_count || 0), rep_team_member_ids: canvasRepTeamMemberIds(session), superseded_session_ids: asArray2(session.deployment_qa?.superseded_session_ids) });
    }
    if (session.status === "completed" || session.status === "recalled") throw new HttpError(409, "campaign_closed", "This Canvas campaign is closed. Create a new draft.");
    const expectedVersion = Number(body?.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(session.version)) throw new HttpError(409, "version_conflict", "The Canvas draft changed. Reload it before deploying.");
    const expectedHash = await sha2562(canvasStoredPlanForHash(session));
    if (!session.plan_hash || session.plan_hash !== expectedHash) throw new HttpError(409, "plan_hash_mismatch", "The Canvas draft changed outside the trusted save flow. Save it again.");
    const validation = validatePlan(session);
    const entitlement = await resolveCanvasEntitlement(user);
    const members = await validateTeamMembers(base44, user.id, validation.assignedRepIds);
    if (Number.isFinite(entitlement.seats) && members.length > entitlement.seats) throw new HttpError(403, "canvas_seat_limit_exceeded", `This deployment assigns ${members.length} reps, but the verified subscription has ${entitlement.seats} seats.`);
    const topologyVerification = await verifyServerTopology(session);
    const providedSupersedeIds = optionalUniqueIdList(body?.supersede_session_ids, "supersede_session_ids");
    lease = await acquireManagerLease(base44, user.id);
    leaseBase44 = base44;
    leaseManagerId = user.id;
    const lockedSession = await base44.entities.CanvasSession.get(session.id).catch(() => null);
    const lockedHash = lockedSession ? await sha2562(canvasStoredPlanForHash(lockedSession)) : null;
    if (!lockedSession || lockedSession.manager_id !== user.id || lockedSession.status !== "draft" || Number(lockedSession.version) !== expectedVersion || lockedSession.plan_hash !== session.plan_hash || lockedSession.plan_hash !== lockedHash) {
      throw new HttpError(409, "version_conflict", "The Canvas draft changed before deployment committed. Reload before retrying.");
    }
    const activeDeployments = await loadActiveValidDeployments(base44, user.id, signingSecret);
    const conflicts = deploymentOverlapConflicts(lockedSession, activeDeployments);
    const supersededSessionIds = requireExactSupersedeConfirmation(providedSupersedeIds, conflicts);
    for (const supersededId of supersededSessionIds) {
      const predecessor = activeDeployments.find((candidate) => candidate.id === supersededId);
      if (!predecessor) throw new HttpError(409, "canvas_deployment_overlap_changed", "An overlapping campaign changed before replacement. Reload and confirm again.");
      transitionLocks.push(await acquireCampaignTransitionLock(base44, predecessor));
      const lockedPredecessor = await base44.asServiceRole.entities.CanvasSession.get(predecessor.id).catch(() => null);
      if (!lockedPredecessor || !await verifyCanvasLifecycleSession(signingSecret, lockedPredecessor, "active")) {
        throw new HttpError(409, "canvas_deployment_overlap_changed", "An overlapping campaign closed or changed before replacement. Reload and confirm again.");
      }
    }
    const deployedAt = (/* @__PURE__ */ new Date()).toISOString();
    const lifecycleEvidence = {
      schema_version: 1,
      state: "active",
      transition: "deploy",
      transitioned_at: deployedAt,
      transitioned_by_user_id: user.id,
      idempotency_key: idempotencyKey,
      from_version: Number(lockedSession.version),
      to_version: Number(lockedSession.version),
      previous_signature: null
    };
    const deploymentQa = {
      ...validation.deploymentQa,
      ...topologyVerification,
      verified_team_member_ids: members.map((member) => member.id),
      verified_team_member_bindings: members.map((member) => ({ team_member_id: String(member.id), user_id: String(member.user_id), email: normalized(member.email) })).sort((a, b) => a.team_member_id.localeCompare(b.team_member_id)),
      entitlement_kind: entitlement.kind,
      entitlement_subscription_id: entitlement.subscription_id,
      entitlement_canvas_seats: Number.isFinite(entitlement.canvas_seats) ? entitlement.canvas_seats : null,
      entitlement_grant_id: entitlement.grant_id || null,
      superseded_session_ids: supersededSessionIds,
      overlap_conflict_count: conflicts.length,
      verified_at: deployedAt,
      lifecycle_state: "active",
      lifecycle_transition: "deploy",
      lifecycle_transitioned_at: deployedAt,
      lifecycle_transitioned_by_user_id: user.id
    };
    const lifecycleUpdate = {
      status: "deployed",
      deployment_plan_version: Number(lockedSession.version),
      deployed_at: deployedAt,
      deployed_by_user_id: user.id,
      deployment_idempotency_key: idempotencyKey,
      deployment_qa: deploymentQa,
      lifecycle_state: "active",
      lifecycle_evidence: lifecycleEvidence,
      closed_at: null,
      closed_by_user_id: null,
      close_action: null,
      close_idempotency_key: null
    };
    const signature = await signCanvasLifecycle(signingSecret, { ...lockedSession, ...lifecycleUpdate }, members.map((member) => member.id));
    const mutation = await base44.asServiceRole.entities.CanvasSession.updateMany({
      id: lockedSession.id,
      manager_id: user.id,
      status: "draft",
      version: Number(lockedSession.version),
      plan_hash: lockedSession.plan_hash
    }, { $set: { ...lifecycleUpdate, deployment_signature: signature } });
    if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) throw new HttpError(409, "version_conflict", "The Canvas draft changed before deployment committed.");
    const updated = await base44.entities.CanvasSession.get(lockedSession.id).catch(() => null);
    if (!updated || !await verifyCanvasLifecycleSession(signingSecret, updated, "active")) throw new HttpError(503, "canvas_deploy_commit_unverified", "The Canvas deployment commit could not be verified.");
    return Response.json({ success: true, idempotent: false, session_id: updated.id, version: Number(updated.version), status: "deployed", deployed_at: deployedAt, delivery_count: members.length, rep_team_member_ids: members.map((member) => member.id), superseded_session_ids: supersededSessionIds, deployment_qa: updated.deployment_qa });
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message, ...error.details ? { details: error.details } : {} }, { status: error.status });
    console.error("[canvasDeployCampaign]", error?.message || error);
    return Response.json({ error: "canvas_deploy_failed", message: "Canvas deployment could not be verified. The draft was not changed." }, { status: 503 });
  } finally {
    if (leaseBase44) {
      for (const lock of [...transitionLocks].reverse()) await releaseCampaignTransitionLock(leaseBase44, lock);
    }
    if (lease && leaseBase44 && leaseManagerId) await releaseManagerLease(leaseBase44, leaseManagerId, lease);
  }
});
