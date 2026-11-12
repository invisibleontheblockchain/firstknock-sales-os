// Single-entry branches: the parts of a territory you can only reach one way.
//
// WHY THIS EXISTS
//
// A rep looking at a Lake Norman route said it "goes all the way out to the end
// of the peninsula, comes back in, then goes back out". That is not a mileage
// complaint. It is a topology complaint, and no amount of distance optimization
// states it: a shortest-path search is free to leave a peninsula half-done and
// return later if the arithmetic happens to work out, and on a route with 999
// legs the arithmetic frequently does.
//
// Measured on Charlotte Route 1H (scripts/route-branch-audit.mjs, real OSRM road
// costs over all 1,000 doors):
//
//   threshold   single-entry areas   doors behind one gate
//   0.25 mi     138                  687 / 1000  (69%)
//   0.35 mi     163                  840 / 1000  (84%)
//   0.50 mi      70                  776 / 1000  (78%)
//
// So this is not an edge case in suburban territory — it is the dominant shape.
// And after the pipeline fix took that route from 627.6 to 394.1 measured road
// miles, 53% of its branches were still entered more than once (87 of 163 at
// 0.35 mi, 164 wasted re-entries). Distance optimization halved the problem and
// left half of it, which is exactly what you would expect from an objective that
// cannot see the constraint.
//
// WHAT A BRANCH IS
//
// A vertex whose removal disconnects the road graph is an articulation point —
// a gate. Everything it strands, other than the main body of the territory, can
// only be entered through it. That is a peninsula, a gated subdivision, a
// cul-de-sac cluster, a road bridged over a creek: all the same structure, none
// of them named or hardcoded.
//
// Nothing here is tuned to a city. The inputs are doors and road costs.

import { isValidPoint } from './routeContinuityOptimizer.js';
import { fetchRoadMatrix, MAX_ROUTE_MATRIX_POINTS } from './roadMatrix.js';

/** Doors closer than this on the road are considered adjacent. */
export const DEFAULT_ADJACENCY_MILES = 0.35;
/** Smaller strandings are noise, not neighbourhoods. */
export const DEFAULT_MIN_BRANCH_DOORS = 5;
/** Coordinates per adjacency matrix. Matches the road matrix chunk size. */
const TILE_DOORS = 46;
/** Tile edge in miles. Two doors more than this apart cannot be adjacent. */
const TILE_MILES = 1.2;

const EARTH_MILES = 3958.7613;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

export function aerialMiles(first, second) {
    const deltaLat = toRadians(Number(second.lat) - Number(first.lat));
    const deltaLng = toRadians(Number(second.lng) - Number(first.lng));
    const haversine = Math.sin(deltaLat / 2) ** 2
        + Math.cos(toRadians(Number(first.lat))) * Math.cos(toRadians(Number(second.lat)))
        * Math.sin(deltaLng / 2) ** 2;
    return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

/**
 * Road-cost adjacency over every door, without a full N x N matrix.
 *
 * A complete 1,000-door matrix is 484 OSRM requests. Adjacency only needs SHORT
 * pairs, and two doors further apart than a tile cannot be adjacent on the road,
 * so one matrix per spatial tile finds every edge that matters. Tiles include
 * their eight neighbours, so an edge crossing a tile boundary is still inside
 * some tile. Cost is linear in doors: 1,000 doors cost ~70 requests.
 *
 * @returns {Promise<{adjacency: Array<Array<number>>, edgeCount: number, requestCount: number, failedTiles: number}>}
 */
export async function buildRoadAdjacency(doors, {
    thresholdMiles = DEFAULT_ADJACENCY_MILES,
    fetchMatrix = fetchRoadMatrix,
    baseUrl,
    profile = 'driving',
    timeoutMs = 20000
} = {}) {
    const count = doors.length;
    const cell = TILE_MILES / 69;
    const buckets = new Map();
    doors.forEach((door, index) => {
        const key = `${Math.floor(Number(door.lat) / cell)}:${Math.floor(Number(door.lng) / cell)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(index);
    });

    // Deterministic tile order, so the same territory always spends the same
    // requests and a cached run reproduces an uncached one exactly.
    const tiles = [...buckets.keys()].sort().map((key) => {
        const [gridLat, gridLng] = key.split(':').map(Number);
        const pool = [];
        for (let deltaLat = -1; deltaLat <= 1; deltaLat += 1) {
            for (let deltaLng = -1; deltaLng <= 1; deltaLng += 1) {
                const near = buckets.get(`${gridLat + deltaLat}:${gridLng + deltaLng}`);
                if (near) pool.push(...near);
            }
        }
        const members = buckets.get(key);
        const centre = {
            lat: members.reduce((total, i) => total + Number(doors[i].lat), 0) / members.length,
            lng: members.reduce((total, i) => total + Number(doors[i].lng), 0) / members.length
        };
        return [...new Set(pool)]
            .sort((a, b) => (aerialMiles(centre, doors[a]) - aerialMiles(centre, doors[b])) || (a - b))
            .slice(0, TILE_DOORS);
    });

    const edges = new Map();
    let requestCount = 0;
    let failedTiles = 0;
    for (const tile of tiles) {
        if (tile.length < 2) continue;
        let matrix;
        try {
            matrix = await fetchMatrix(tile.map((i) => doors[i]), { baseUrl, profile, timeoutMs });
        } catch {
            // A tile that cannot be priced leaves its edges unknown. The graph is
            // then sparser than reality, which can only cause branches to be
            // MISSED, never invented — the safe direction for a repair that must
            // not fire on a structure that is not there.
            failedTiles += 1;
            continue;
        }
        requestCount += 1;
        for (let a = 0; a < tile.length; a += 1) {
            for (let b = a + 1; b < tile.length; b += 1) {
                const forward = matrix.distances?.[a]?.[b];
                const backward = matrix.distances?.[b]?.[a];
                const miles = Math.min(
                    Number.isFinite(forward) ? forward : Infinity,
                    Number.isFinite(backward) ? backward : Infinity
                );
                if (!Number.isFinite(miles) || miles > thresholdMiles) continue;
                const low = Math.min(tile[a], tile[b]);
                const high = Math.max(tile[a], tile[b]);
                const key = `${low},${high}`;
                const existing = edges.get(key);
                if (existing === undefined || miles < existing) edges.set(key, miles);
            }
        }
    }

    const adjacency = Array.from({ length: count }, () => []);
    edges.forEach((_, key) => {
        const [a, b] = key.split(',').map(Number);
        adjacency[a].push(b);
        adjacency[b].push(a);
    });
    adjacency.forEach((list) => list.sort((first, second) => first - second));
    return { adjacency, edgeCount: edges.size, requestCount, failedTiles };
}

/** Articulation points (Tarjan), iteratively — a 1,000-door chain would blow the stack. */
export function findArticulationPoints(adjacency) {
    const count = adjacency.length;
    const discovery = new Array(count).fill(0);
    const low = new Array(count).fill(0);
    const parent = new Array(count).fill(-1);
    const visited = new Array(count).fill(false);
    const isArticulation = new Array(count).fill(false);
    let timer = 0;

    for (let root = 0; root < count; root += 1) {
        if (visited[root]) continue;
        let rootChildren = 0;
        const stack = [[root, 0]];
        visited[root] = true;
        discovery[root] = low[root] = ++timer;

        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const [node, cursor] = frame;
            if (cursor < adjacency[node].length) {
                frame[1] += 1;
                const next = adjacency[node][cursor];
                if (next === parent[node]) continue;
                if (visited[next]) {
                    low[node] = Math.min(low[node], discovery[next]);
                    continue;
                }
                parent[next] = node;
                visited[next] = true;
                discovery[next] = low[next] = ++timer;
                if (node === root) rootChildren += 1;
                stack.push([next, 0]);
            } else {
                stack.pop();
                const above = parent[node];
                if (above !== -1) {
                    low[above] = Math.min(low[above], low[node]);
                    if (above !== root && low[node] >= discovery[above]) isArticulation[above] = true;
                }
            }
        }
        if (rootChildren > 1) isArticulation[root] = true;
    }
    return isArticulation;
}

/** Connected components of the graph with one vertex removed. */
function componentsWithout(adjacency, skip) {
    const count = adjacency.length;
    const seen = new Array(count).fill(false);
    seen[skip] = true;
    const components = [];
    for (let start = 0; start < count; start += 1) {
        if (seen[start] || adjacency[start].length === 0) continue;
        const stack = [start];
        seen[start] = true;
        const component = [];
        while (stack.length > 0) {
            const node = stack.pop();
            component.push(node);
            for (const next of adjacency[node]) if (!seen[next]) { seen[next] = true; stack.push(next); }
        }
        components.push(component);
    }
    return components;
}

/** Hop distance from the gate to every door of a branch, over the branch only. */
function depthsFromGate(adjacency, gate, memberSet) {
    const depth = new Map([[gate, 0]]);
    let frontier = [gate];
    while (frontier.length > 0) {
        const next = [];
        for (const node of frontier) {
            for (const neighbour of adjacency[node]) {
                if (!memberSet.has(neighbour) || depth.has(neighbour)) continue;
                depth.set(neighbour, depth.get(node) + 1);
                next.push(neighbour);
            }
        }
        frontier = next;
    }
    return depth;
}

/**
 * Every MAXIMAL single-entry area in the territory.
 *
 * Branches nest: a large gated neighbourhood contains its own cul-de-sacs, each
 * of which is an articulation point stranding its own component. Reporting all
 * of them triple-counts the same geography — an early version of this audit
 * summed "doors behind a gate" to 2,786 across a 1,000-door route. Only maximal
 * branches are returned: a branch contained by another is dropped.
 *
 * @returns {Array<{gate:number, members:number[], memberSet:Set<number>, size:number, maxDepth:number}>}
 *   sorted largest first, deterministically.
 */
export function findSingleEntryBranches(adjacency, {
    minDoors = DEFAULT_MIN_BRANCH_DOORS
} = {}) {
    const isArticulation = findArticulationPoints(adjacency);
    const gates = isArticulation.map((flag, index) => (flag ? index : -1)).filter((index) => index >= 0);

    const candidates = [];
    for (const gate of gates) {
        const components = componentsWithout(adjacency, gate);
        if (components.length < 2) continue;
        // The largest surviving piece is the rest of the territory; everything
        // else is stranded behind this gate.
        //
        // Both sides of a bridge are technically single-entry with respect to
        // each other, so "which side is the branch" needs a tie-break that is
        // not arbitrary. Size is the honest one: the rep is working the bulk of
        // the territory and detouring into the rest. A component holding half
        // the doors or more is the bulk BY DEFINITION and is never a branch,
        // whichever side of the gate it sits on.
        components.sort((first, second) => (second.length - first.length) || (first[0] - second[0]));
        const half = adjacency.length / 2;
        for (const component of components.slice(1)) {
            if (component.length < minDoors) continue;
            if (component.length >= half) continue;
            const members = [...component].sort((first, second) => first - second);
            const memberSet = new Set(members);
            const depth = depthsFromGate(adjacency, gate, memberSet);
            let maxDepth = 0;
            memberSet.forEach((node) => { maxDepth = Math.max(maxDepth, depth.get(node) ?? 0); });
            candidates.push({ gate, members, memberSet, size: members.length, maxDepth });
        }
    }

    // Keep only maximal branches. Sorting by size descending means the first
    // branch covering a door set is the biggest one that does.
    candidates.sort((first, second) => (second.size - first.size)
        || (first.gate - second.gate)
        || (first.members[0] - second.members[0]));
    const maximal = [];
    for (const candidate of candidates) {
        const containedByKept = maximal.some((kept) => candidate.members.every((door) => kept.memberSet.has(door)));
        if (!containedByKept) maximal.push(candidate);
    }
    return maximal;
}

/** How many separate times an order enters a door set. */
export function countEntries(order, memberSet, identify) {
    let entries = 0;
    let inside = false;
    for (const item of order) {
        const now = memberSet.has(identify(item));
        if (now && !inside) entries += 1;
        inside = now;
    }
    return entries;
}

/**
 * Priority: what it costs to get this branch wrong.
 *
 * Doors times depth. A deep, dense pocket punishes a re-entry heavily; a shallow
 * five-door stub barely notices. Repair effort and matrix budget go to the top of
 * this list, so a bounded pass spends itself where the miles are.
 */
export function scoreBranch(branch) {
    return branch.size * Math.max(1, branch.maxDepth);
}

export { MAX_ROUTE_MATRIX_POINTS, isValidPoint };
