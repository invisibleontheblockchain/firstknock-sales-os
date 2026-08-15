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
//   - pockets delegate to `findProtectedTerminalBranches` in
//     `streetTopologyCore.js`, the detector Canvas territory deployment is
//     validated against, so pocket detection exists in exactly one place
//
// Determinism is a hard requirement: every id and every ordering is derived
// from canonical sorted keys, never from input array order or iteration timing,
// so generation and optimization resolve identical assignments for identical
// input.

import { buildStreetBlocks } from './roadAwareStreetSweep.js';
import { haversineMiles, isValidPoint } from './routeContinuityOptimizer.js';
// Pockets are detected by the shared topology core — the same detector Canvas
// territory deployment uses — so "protected pocket" means one thing everywhere.
import {
    compareIds,
    edgeIdFor,
    findProtectedTerminalBranches,
    stableHash as topologyHash
} from './streetTopologyCore.js';
import { MAX_BLOCKS_PER_ROUTE, MAX_HOMES_PER_ROUTE } from './routingBudgets.js';

// Budgets are NOT defined here. `routingBudgets.js` is the single source, and
// the block ceiling is derived from MAX_ROUTE_MATRIX_POINTS there rather than
// restated as a literal. See src/tasks/large-territory-partitioning-plan.md.
//
// Note the currency: the road matrix carries one point per STREET BLOCK, and a
// protected pocket is one unit spanning possibly several blocks. Sizing must
// therefore be checked in blocks; units exist to keep pockets atomic.
export { MAX_BLOCKS_PER_ROUTE, MAX_HOMES_PER_ROUTE } from './routingBudgets.js';
// Retained name for existing callers, now derived rather than hardcoded.
export const ROUTING_UNIT_BUDGET = MAX_BLOCKS_PER_ROUTE;

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

function pointFrom(value) {
    const lat = Number(value?.lat ?? value?.latitude);
    const lng = Number(value?.lng ?? value?.lon ?? value?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
}

/**
 * Undirected routable graph from an OSM-shaped road network, in the shape the
 * shared topology core expects (`nodeMap` keeps tags so `noexit` and
 * turning-circle signals still reach the detector).
 * Edges are keyed canonically by `edgeIdFor`, so the graph is identical
 * regardless of the order elements arrive in.
 */
function buildTopologyGraph(roadNetwork, allowedHighways) {
    const allowed = new Set(allowedHighways);
    const nodeMap = new Map();
    const edgeMap = new Map();

    (roadNetwork?.elements || []).forEach((element) => {
        if (element?.type !== 'node') return;
        const point = pointFrom(element);
        if (!point) return;
        const id = String(element.id);
        nodeMap.set(id, { id, ...point, tags: element.tags || {} });
    });

    (roadNetwork?.elements || []).forEach((element) => {
        if (element?.type !== 'way' || !allowed.has(element?.tags?.highway)) return;
        const wayNodes = (element.nodes || []).map(String).filter((id) => nodeMap.has(id));
        for (let index = 0; index < wayNodes.length - 1; index += 1) {
            const from = wayNodes[index];
            const to = wayNodes[index + 1];
            if (from === to) continue;
            const id = edgeIdFor(from, to);
            if (edgeMap.has(id)) continue;
            edgeMap.set(id, { id, nodeIds: [from, to].sort(compareIds) });
        }
    });

    return { nodeMap, edgeMap };
}

/**
 * Protected pockets: areas that can only be entered and left through one throat,
 * so a route that leaves one mid-way pays that throat twice — cul-de-sacs,
 * dead-end stubs, and single-entrance enclaves.
 *
 * The detection itself is NOT implemented here. It delegates to the shared
 * topology core, which is the Canvas-validated detector, so a pocket found
 * during generation is the same pocket found during optimization. An edge is
 * claimed by the first branch that contains it, so pockets stay disjoint.
 */
function findTopologyPockets(graph, boundaryNodeIds) {
    const edgeIds = [...graph.edgeMap.keys()].sort(compareIds);
    const branches = findProtectedTerminalBranches(
        edgeIds,
        graph.edgeMap,
        graph.nodeMap,
        // Nodes where the routable graph leaves the drawn territory are exempt.
        // Without that exemption a road that merely stops at the edge of the
        // fetched data reads as a dead end, gets protected as a fake pocket, and
        // blocks legitimate cuts along the territory boundary.
        boundaryNodeIds,
        new Set()
    );

    const pocketByEdgeKey = new Map();
    const pockets = [];
    branches.forEach((branch) => {
        const unclaimed = branch.edgeIds.filter((edgeId) => !pocketByEdgeKey.has(edgeId));
        if (unclaimed.length === 0) return;
        // The id hashes the claimed edge set, so identical geography always
        // produces the same pocket id regardless of discovery order.
        const id = `pocket:${topologyHash(branch.edgeIds.join(','))}`;
        pockets.push({
            id,
            edgeKeys: branch.edgeIds,
            edgeCount: branch.edgeIds.length,
            terminalNodeIds: branch.terminalNodeIds,
            throatNodeIds: branch.throatNodeIds
        });
        unclaimed.forEach((edgeId) => pocketByEdgeKey.set(edgeId, id));
    });

    return { pockets, pocketByEdgeKey };
}

function normalizePolygon(polygon) {
    const ring = (Array.isArray(polygon) ? polygon : []).map(pointFrom).filter(Boolean);
    return ring.length >= 3 ? ring : null;
}

function isInsidePolygon(point, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
        const current = ring[index];
        const last = ring[previous];
        if ((current.lat > point.lat) !== (last.lat > point.lat)) {
            const crossing = current.lng
                + ((point.lat - current.lat) / (last.lat - current.lat)) * (last.lng - current.lng);
            if (point.lng < crossing) inside = !inside;
        }
    }
    return inside;
}

/**
 * Nodes where the routable graph leaves the drawn territory. Passed to the
 * pocket detector as boundary nodes so the territory edge is never mistaken for
 * a dead end. No polygon means no exemptions, exactly as before.
 */
function boundaryNodeIdsFor(graph, polygon) {
    const ring = normalizePolygon(polygon);
    if (!ring) return new Set();
    const boundary = new Set();
    graph.nodeMap.forEach((node, id) => {
        if (!isInsidePolygon(node, ring)) boundary.add(id);
    });
    return boundary;
}

/**
 * The access group a street block belongs to according to the caller's routing
 * context — the frontend's road-derived topology, which the street sweep already
 * treats as atomic. Only an unambiguous single key counts, so a block straddling
 * two groups (or missing a key on any door) stays a unit of its own.
 */
function accessUnitKeyForBlock(doors, routingContext) {
    if (typeof routingContext?.accessGroupKey !== 'function') return '';
    const keys = new Set();
    for (const door of doors) {
        let value = '';
        try {
            value = String(routingContext.accessGroupKey(door) ?? '').trim();
        } catch {
            return '';
        }
        if (!value) return '';
        keys.add(value);
        if (keys.size > 1) return '';
    }
    return keys.size === 1 ? `access:${[...keys][0]}` : '';
}

function distanceToEdgeMeters(point, edge, nodes) {
    const start = nodes.get(edge.nodeIds[0]);
    const end = nodes.get(edge.nodeIds[1]);
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
            const distance = distanceToEdgeMeters(point, graph.edgeMap.get(key), graph.nodeMap);
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
 * @param {object} options `{ roadNetwork, allowedHighways, maxSnapMeters,
 *   territoryPolygon, routingContext }`. `territoryPolygon` exempts the drawn
 *   boundary from dead-end detection. `routingContext` lets a caller that
 *   already resolved road topology (the frontend route context) supply its
 *   access groups instead of re-deriving them from a road graph.
 * @returns {object} `{ units, blocks, pockets, pocketProvenance, unitCount,
 *   doorCount, budget }` where `units` are the authoritative routing units: a
 *   protected pocket is ONE unit (its blocks travel together), and every other
 *   street block is a unit of its own. Units are returned in canonical key
 *   order, so callers order them by cost, never by luck.
 */
export function buildRoutingUnits(properties, options = {}) {
    const validProperties = (Array.isArray(properties) ? properties : [])
        .filter((property) => isValidPoint(property));
    const routingContext = options.routingContext || null;
    const blocks = buildStreetBlocks(validProperties).map((block) => ({
        key: block.key,
        doors: block.doors,
        doorCount: block.doors.length,
        pocketId: '',
        accessUnitKey: accessUnitKeyForBlock(block.doors, routingContext)
    }));

    const roadNetwork = options.roadNetwork || null;
    const graph = roadNetwork
        ? buildTopologyGraph(roadNetwork, options.allowedHighways || ROUTABLE_HIGHWAYS)
        : null;
    const topology = graph && graph.edgeMap.size > 0
        ? findTopologyPockets(graph, boundaryNodeIdsFor(graph, options.territoryPolygon))
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
        // cutting a cul-de-sac across two routes. A caller-supplied access group
        // is atomic for the same reason, and road topology wins when both exist.
        const unitKey = block.pocketId || block.accessUnitKey || `block:${block.key}`;
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
        // The matrix currency. Sizing is checked against this, not unitCount,
        // because a pocket unit can span several blocks.
        blockCount: blocks.length,
        doorCount: validProperties.length,
        budget: MAX_BLOCKS_PER_ROUTE
    };
}

/**
 * How many routes this territory's WORKLOAD needs — driven by routing units,
 * with door count only as a secondary signal. A sparse 750-door territory can
 * need more routes than a dense 1,500-door one, which is exactly why door count
 * cannot be the primary metric.
 */
export function routingUnitWorkload(model, options = {}) {
    // `unitBudget` is accepted as the historical alias; the budget is applied to
    // BLOCK count, which is what the road matrix actually spends its points on.
    const blockBudget = Number(options.blockBudget ?? options.unitBudget ?? MAX_BLOCKS_PER_ROUTE);
    // Was 1200 — the balance band's upper edge used as a cap, which let this
    // model propose routes above the 1,000-home product ceiling.
    const doorBudget = Number(options.doorBudget ?? MAX_HOMES_PER_ROUTE);
    const unitCount = Number(model?.unitCount) || 0;
    const blockCount = Number(model?.blockCount) || unitCount;
    const doorCount = Number(model?.doorCount) || 0;
    const routesByUnits = blockCount > 0 ? Math.ceil(blockCount / blockBudget) : 0;
    const routesByDoors = doorCount > 0 ? Math.ceil(doorCount / doorBudget) : 0;
    return {
        unitCount,
        blockCount,
        doorCount,
        unitBudget: blockBudget,
        blockBudget,
        doorBudget,
        routesByUnits,
        routesByDoors,
        // Whichever budget binds first decides, so neither metric can be
        // silently exceeded.
        routeCount: Math.max(routesByUnits, routesByDoors),
        bindingBudget: routesByUnits >= routesByDoors ? 'routing_units' : 'doors'
    };
}