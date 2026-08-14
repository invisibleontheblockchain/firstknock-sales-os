// The shared geographic model: homes -> street blocks -> road-topology pockets.
//
// Stage 1 of the large-territory plan. Before this module, five paths each had
// their own idea of a "routing unit": generation grouped by canonical street +
// subdivision label, the sweep grouped by street with gap splitting, pocket
// detection read provider subdivision names, and the road context derived
// topology from the road graph. The optimizer therefore behaved differently
// depending on which path produced the route.
//
// This module is the single authority. It is deliberately runtime-agnostic ESM
// (no Deno, no browser, no network) so the backend functions and the frontend
// can consume the SAME representation:
//   - street blocks delegate to `buildStreetBlocks`, the definition the road
//     matrix already groups by, so a block is never redefined here
//   - pockets come from ROAD TOPOLOGY (terminal/dead-end branches and
//     single-entrance bridge pockets), not from provider labels
//
// Determinism is a hard requirement: every id and every ordering is derived
// from canonical sorted keys, never from input array order or iteration timing,
// so generation and optimization resolve identical assignments for identical
// input.

import { buildStreetBlocks } from './roadAwareStreetSweep.js';
import { haversineMiles, isValidPoint } from './routeContinuityOptimizer.js';

// The measured ceiling. A route stays road-priced at block tier only while its
// units plus its anchors fit inside MAX_ROUTE_MATRIX_POINTS (250), so the
// partitioner targets this many units — NOT a door count. See
// src/tasks/large-territory-partitioning-plan.md for the benchmark.
export const ROUTING_UNIT_BUDGET = 240;

// Roads a rep can actually canvass on foot or by car. Matches the routable set
// the road context already uses, so topology here agrees with routing there.
export const ROUTABLE_HIGHWAYS = Object.freeze([
    'residential', 'living_street', 'unclassified', 'tertiary', 'tertiary_link',
    'secondary', 'secondary_link', 'primary', 'primary_link', 'service'
]);

const METERS_PER_MILE = 1609.344;
const DEFAULT_MAX_SNAP_METERS = 60;

export const POCKET_PROVENANCE_TOPOLOGY = 'road_topology';
export const POCKET_PROVENANCE_NONE = 'none';

function compareKeys(left, right) {
    const first = String(left);
    const second = String(right);
    if (first < second) return -1;
    if (first > second) return 1;
    return 0;
}

/** FNV-1a over a canonical string — stable across runs and platforms. */
function stableHash(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function pointFrom(value) {
    const lat = Number(value?.lat ?? value?.latitude);
    const lng = Number(value?.lng ?? value?.lon ?? value?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
}

function edgeKey(firstNodeId, secondNodeId) {
    return compareKeys(firstNodeId, secondNodeId) <= 0
        ? `${firstNodeId}|${secondNodeId}`
        : `${secondNodeId}|${firstNodeId}`;
}

/**
 * Undirected routable graph from an OSM-shaped road network.
 * Edges are keyed canonically, so the graph is identical regardless of the order
 * elements arrive in.
 */
function buildRoadGraph(roadNetwork, allowedHighways) {
    const allowed = new Set(allowedHighways);
    const nodes = new Map();
    const edges = new Map();
    const adjacency = new Map();

    (roadNetwork?.elements || []).forEach((element) => {
        if (element?.type !== 'node') return;
        const point = pointFrom(element);
        if (point) nodes.set(String(element.id), point);
    });

    (roadNetwork?.elements || []).forEach((element) => {
        if (element?.type !== 'way' || !allowed.has(element?.tags?.highway)) return;
        const wayNodes = (element.nodes || []).map(String).filter((id) => nodes.has(id));
        for (let index = 0; index < wayNodes.length - 1; index += 1) {
            const from = wayNodes[index];
            const to = wayNodes[index + 1];
            if (from === to) continue;
            const key = edgeKey(from, to);
            if (edges.has(key)) continue;
            edges.set(key, { key, from, to });
            if (!adjacency.has(from)) adjacency.set(from, new Set());
            if (!adjacency.has(to)) adjacency.set(to, new Set());
            adjacency.get(from).add(key);
            adjacency.get(to).add(key);
        }
    });

    return { nodes, edges, adjacency };
}

const otherEnd = (edge, nodeId) => (edge.from === nodeId ? edge.to : edge.from);

/**
 * Bridge edges via iterative Tarjan low-link. Iterative because a residential
 * graph is deep enough to blow a recursive stack.
 */
function findBridgeKeys(graph) {
    const discovery = new Map();
    const low = new Map();
    const bridges = new Set();
    let counter = 0;

    [...graph.adjacency.keys()].sort(compareKeys).forEach((rootId) => {
        if (discovery.has(rootId)) return;
        const stack = [{ nodeId: rootId, parentEdgeKey: null, pending: null }];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            if (frame.pending === null) {
                counter += 1;
                discovery.set(frame.nodeId, counter);
                low.set(frame.nodeId, counter);
                frame.pending = [...(graph.adjacency.get(frame.nodeId) || [])].sort(compareKeys);
            }
            if (frame.pending.length === 0) {
                stack.pop();
                const parent = stack[stack.length - 1];
                if (parent && frame.parentEdgeKey) {
                    low.set(parent.nodeId, Math.min(low.get(parent.nodeId), low.get(frame.nodeId)));
                    if (low.get(frame.nodeId) > discovery.get(parent.nodeId)) {
                        bridges.add(frame.parentEdgeKey);
                    }
                }
                continue;
            }
            const nextEdgeKey = frame.pending.pop();
            if (nextEdgeKey === frame.parentEdgeKey) continue;
            const neighborId = otherEnd(graph.edges.get(nextEdgeKey), frame.nodeId);
            if (discovery.has(neighborId)) {
                low.set(frame.nodeId, Math.min(low.get(frame.nodeId), discovery.get(neighborId)));
                continue;
            }
            stack.push({ nodeId: neighborId, parentEdgeKey: nextEdgeKey, pending: null });
        }
    });

    return bridges;
}

/** Edges reachable from `startNodeId` without crossing `blockedEdgeKey`. */
function reachableEdgeKeys(graph, startNodeId, blockedEdgeKey) {
    const seenNodes = new Set([startNodeId]);
    const reached = new Set();
    const queue = [startNodeId];
    while (queue.length > 0) {
        const nodeId = queue.shift();
        [...(graph.adjacency.get(nodeId) || [])].sort(compareKeys).forEach((key) => {
            if (key === blockedEdgeKey) return;
            reached.add(key);
            const neighborId = otherEnd(graph.edges.get(key), nodeId);
            if (seenNodes.has(neighborId)) return;
            seenNodes.add(neighborId);
            queue.push(neighborId);
        });
    }
    return reached;
}

/**
 * Protected pockets: an area that can only be entered and left through one
 * throat, so a route that leaves it mid-way pays the throat twice.
 *
 * Every bridge edge is a candidate throat. The side of the bridge that does not
 * contain the rest of the network is the pocket — which covers cul-de-sacs and
 * dead-end stubs (the degenerate one-edge case) and single-entrance
 * subdivisions and bridge-connected enclaves (the many-edge case) with one
 * rule instead of three.
 *
 * Pockets are emitted smallest-first and an edge is claimed by the smallest
 * pocket containing it, so nested pockets resolve to their innermost unit.
 */
function findTopologyPockets(graph) {
    const bridges = [...findBridgeKeys(graph)].sort(compareKeys);
    const candidates = [];

    bridges.forEach((bridgeKey) => {
        const bridge = graph.edges.get(bridgeKey);
        const fromSide = reachableEdgeKeys(graph, bridge.from, bridgeKey);
        const toSide = reachableEdgeKeys(graph, bridge.to, bridgeKey);
        // The pocket is the smaller side plus the throat itself. Equal sides
        // mean neither side is an enclave, so there is nothing to protect.
        if (fromSide.size === toSide.size) return;
        const inner = fromSide.size < toSide.size ? fromSide : toSide;
        const edgeKeys = [...inner, bridgeKey].sort(compareKeys);
        candidates.push({ throatEdgeKey: bridgeKey, edgeKeys });
    });

    candidates.sort((first, second) => (
        first.edgeKeys.length - second.edgeKeys.length
        || compareKeys(first.throatEdgeKey, second.throatEdgeKey)
    ));

    const pocketByEdgeKey = new Map();
    const pockets = [];
    candidates.forEach((candidate) => {
        const unclaimed = candidate.edgeKeys.filter((key) => !pocketByEdgeKey.has(key));
        if (unclaimed.length === 0) return;
        // The id is a hash of the claimed edge set, so the same geography always
        // produces the same pocket id regardless of discovery order.
        const id = `pocket:${stableHash(candidate.edgeKeys.join(','))}`;
        const pocket = {
            id,
            throatEdgeKey: candidate.throatEdgeKey,
            edgeKeys: candidate.edgeKeys,
            edgeCount: candidate.edgeKeys.length
        };
        pockets.push(pocket);
        unclaimed.forEach((key) => pocketByEdgeKey.set(key, id));
    });

    return { pockets, pocketByEdgeKey };
}

function distanceToEdgeMeters(point, edge, nodes) {
    const start = nodes.get(edge.from);
    const end = nodes.get(edge.to);
    if (!start || !end) return Infinity;
    const referenceLatitude = (start.lat + end.lat) / 2;
    const scale = Math.cos(referenceLatitude * Math.PI / 180);
    const toX = (value) => value.lng * scale;
    const pointX = toX(point);
    const startX = toX(start);
    const endX = toX(end);
    const deltaX = endX - startX;
    const deltaY = end.lat - start.lat;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const position = lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((pointX - startX) * deltaX + (point.lat - start.lat) * deltaY) / lengthSquared));
    const nearest = {
        lat: start.lat + deltaY * position,
        lng: (startX + deltaX * position) / (scale === 0 ? 1 : scale)
    };
    return haversineMiles(point, nearest) * METERS_PER_MILE;
}

/**
 * Pocket assignment for one street block: the pocket its doors overwhelmingly
 * snap to. A block is protected only on a clear majority, so a block that
 * merely brushes a pocket entrance is not dragged inside it.
 */
function pocketForBlock(doors, graph, pocketByEdgeKey, maxSnapMeters) {
    const pocketEdgeKeys = [...pocketByEdgeKey.keys()].sort(compareKeys);
    if (pocketEdgeKeys.length === 0) return '';
    const counts = new Map();
    let snapped = 0;

    doors.forEach((door) => {
        const point = pointFrom(door);
        if (!point) return;
        let bestKey = '';
        let bestDistance = maxSnapMeters;
        pocketEdgeKeys.forEach((key) => {
            const distance = distanceToEdgeMeters(point, graph.edges.get(key), graph.nodes);
            if (distance + 1e-9 < bestDistance) {
                bestDistance = distance;
                bestKey = key;
            }
        });
        if (!bestKey) return;
        snapped += 1;
        const pocketId = pocketByEdgeKey.get(bestKey);
        counts.set(pocketId, (counts.get(pocketId) || 0) + 1);
    });

    if (snapped === 0) return '';
    const [winner] = [...counts.entries()].sort((first, second) => (
        second[1] - first[1] || compareKeys(first[0], second[0])
    ));
    return winner && winner[1] * 2 > doors.length ? winner[0] : '';
}

/**
 * The shared model.
 *
 * @param {Array} properties doors to model
 * @param {object} options `{ roadNetwork, allowedHighways, maxSnapMeters }`
 * @returns {object} `{ units, blocks, pockets, pocketProvenance, unitCount,
 *   doorCount, budget }` where `units` are the authoritative routing units: a
 *   protected pocket is ONE unit (its blocks travel together), and every other
 *   street block is a unit of its own. Units are returned in canonical key
 *   order, so callers order them by cost, never by luck.
 */
export function buildRoutingUnits(properties, options = {}) {
    const validProperties = (Array.isArray(properties) ? properties : [])
        .filter((property) => isValidPoint(property));
    const blocks = buildStreetBlocks(validProperties).map((block) => ({
        key: block.key,
        doors: block.doors,
        doorCount: block.doors.length,
        pocketId: ''
    }));

    const roadNetwork = options.roadNetwork || null;
    const graph = roadNetwork
        ? buildRoadGraph(roadNetwork, options.allowedHighways || ROUTABLE_HIGHWAYS)
        : null;
    const topology = graph && graph.edges.size > 0
        ? findTopologyPockets(graph)
        : { pockets: [], pocketByEdgeKey: new Map() };

    if (graph && topology.pockets.length > 0) {
        const maxSnapMeters = Number(options.maxSnapMeters) > 0
            ? Number(options.maxSnapMeters)
            : DEFAULT_MAX_SNAP_METERS;
        blocks.forEach((block) => {
            block.pocketId = pocketForBlock(
                block.doors,
                graph,
                topology.pocketByEdgeKey,
                maxSnapMeters
            );
        });
    }

    const unitByKey = new Map();
    blocks.forEach((block) => {
        // A protected pocket is one unit: this is what stops a partitioner from
        // cutting a cul-de-sac across two routes.
        const unitKey = block.pocketId || `block:${block.key}`;
        if (!unitByKey.has(unitKey)) {
            unitByKey.set(unitKey, {
                key: unitKey,
                protected: Boolean(block.pocketId),
                pocketId: block.pocketId || '',
                blockKeys: [],
                doorCount: 0
            });
        }
        const unit = unitByKey.get(unitKey);
        unit.blockKeys.push(block.key);
        unit.doorCount += block.doorCount;
    });

    const units = [...unitByKey.values()]
        .sort((first, second) => compareKeys(first.key, second.key))
        .map((unit) => ({ ...unit, blockKeys: [...unit.blockKeys].sort(compareKeys) }));

    return {
        units,
        blocks,
        pockets: topology.pockets,
        pocketProvenance: topology.pockets.length > 0
            ? POCKET_PROVENANCE_TOPOLOGY
            : POCKET_PROVENANCE_NONE,
        unitCount: units.length,
        doorCount: validProperties.length,
        budget: ROUTING_UNIT_BUDGET
    };
}

/**
 * How many routes this territory's WORKLOAD needs — driven by routing units,
 * with door count only as a secondary signal. A sparse 750-door territory can
 * need more routes than a dense 1,500-door one, which is exactly why door count
 * cannot be the primary metric.
 */
export function routingUnitWorkload(model, { unitBudget = ROUTING_UNIT_BUDGET, doorBudget = 1200 } = {}) {
    const unitCount = Number(model?.unitCount) || 0;
    const doorCount = Number(model?.doorCount) || 0;
    const routesByUnits = unitCount > 0 ? Math.ceil(unitCount / unitBudget) : 0;
    const routesByDoors = doorCount > 0 ? Math.ceil(doorCount / doorBudget) : 0;
    return {
        unitCount,
        doorCount,
        unitBudget,
        doorBudget,
        routesByUnits,
        routesByDoors,
        // Whichever budget binds first decides, so neither metric can be
        // silently exceeded.
        routeCount: Math.max(routesByUnits, routesByDoors),
        bindingBudget: routesByUnits >= routesByDoors ? 'routing_units' : 'doors'
    };
}