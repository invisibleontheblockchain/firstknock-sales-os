// The authoritative road-topology core.
//
// Stage 1 of the large-territory plan: there must be exactly ONE definition of a
// protected pocket. This module holds that definition, extracted verbatim from
// src/components/logic/canvasStreetTopology.js — the detector that Canvas
// territory deployment has been validated against — so the backend routing-unit
// model and the frontend Canvas planner share the same code instead of each
// carrying their own bridge/dead-end logic.
//
// Scope is deliberately narrow: pure undirected-graph topology over an edge map,
// with no geometry, no polygon clipping, no door snapping, and no work-unit
// shaping. Those layers stay with their callers (Canvas keeps its clipping and
// candidate snapping; routingUnits keeps its block/door model), which is what
// keeps this extraction narrower than moving the whole Canvas subsystem.
//
// Runtime-agnostic ESM (no Deno, no browser, no network) so backend functions and
// frontend code can both import it.
//
// Expected edge map shape — `Map<edgeId, { id, nodeIds: [a, b], ... }>` — and node
// map shape — `Map<nodeId, { id, lat, lng, tags }>`. Build edge ids with
// `edgeIdFor` so both callers produce identical, canonically ordered ids.
//
// Determinism is a hard requirement: every traversal seeds and iterates in
// canonical id order, so identical geography yields identical pockets regardless
// of input ordering or iteration timing.

export function canonicalId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

export function compareIds(left, right) {
  return String(left).localeCompare(String(right), 'en', { numeric: true });
}

export function stableHash(value) {
  let first = 2166136261;
  let second = 2246822507;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489909);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function edgeIdFor(left, right) {
  const [first, second] = [String(left), String(right)].sort(compareIds);
  return `edge:${encodeURIComponent(first)}:${encodeURIComponent(second)}`;
}

export function graphComponents(edgeIds, edgeMap, barrierNodeIds) {
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

export function componentNodeEdges(edgeIds, edgeMap) {
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

export function findBridgeEdgeIds(edgeIds, edgeMap, barrierNodeIds) {
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

export function hasTerminalNodeSignal(nodeId, nodeMap) {
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

/**
 * THE pocket definition. Returns the atomic terminal branches — cul-de-sacs,
 * dead-end stubs, and single-throat enclaves — each as
 * `{ edgeIds, terminalNodeIds, throatNodeIds }`, canonically ordered.
 *
 * A branch is atomic because it can only be entered and left through its throat,
 * so any consumer that splits one pays that throat twice.
 */
export function findProtectedTerminalBranches(edgeIds, edgeMap, nodeMap, boundaryNodeIds, barrierNodeIds) {
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

export function decomposeRemainingChains(edgeIds, edgeMap, claimedEdgeIds, protectedNodeIds, boundaryNodeIds, barrierNodeIds) {
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