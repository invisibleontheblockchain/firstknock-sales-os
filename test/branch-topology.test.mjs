// Single-entry branch detection and consolidation, on a synthetic peninsula.
//
// No network. The road graph is built by hand so the topology is known exactly
// and the assertions are about behaviour, not about whether OSRM was reachable.
//
// The fixture is the shape the rep described: a mainland strip, and a peninsula
// hanging off ONE gate door. Driving onto the peninsula and back off it is
// cheap along its spine and impossible any other way — which is what makes
// re-entering it wasteful rather than merely unlucky.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
    countEntries,
    findArticulationPoints,
    findSingleEntryBranches,
    scoreBranch
} from '../base44/shared/branchTopology.js';
import { repairBranchReentries } from '../base44/shared/branchConsolidationRepair.js';

// The fixture has to have an unambiguous mainland, or "which side is the
// branch" has no answer. A line of doors does NOT: every interior door is a cut
// vertex and both halves are single-entry with respect to each other. So the
// mainland here is a RING — biconnected, no internal bottleneck — with a
// peninsula hanging off exactly one of its doors.
//
//   mainland  0..7 as a ring
//   gate      3
//   peninsula 8..13 as a spine off the gate
const PENINSULA_EDGES = (() => {
    const edges = [];
    for (let i = 0; i < 8; i += 1) edges.push([i, (i + 1) % 8]);
    edges.push([3, 8]);
    for (let i = 8; i < 13; i += 1) edges.push([i, i + 1]);
    return edges;
})();

function peninsulaGraph() {
    const adjacency = Array.from({ length: 14 }, () => []);
    PENINSULA_EDGES.forEach(([a, b]) => { adjacency[a].push(b); adjacency[b].push(a); });
    return adjacency;
}

test('BR-01 the neck of a peninsula is an articulation point, the ring has none', () => {
    const isArticulation = findArticulationPoints(peninsulaGraph());
    assert.equal(isArticulation[3], true, 'the gate must be a cut vertex');
    assert.equal(isArticulation[0], false, 'a ring door has two ways out');
    assert.equal(isArticulation[13], false, 'the far tip strands nothing');
    assert.equal(isArticulation[10], true, 'a spine door strands everything beyond it');
});

test('BR-02 the peninsula is found as one single-entry branch behind that gate', () => {
    const branches = findSingleEntryBranches(peninsulaGraph(), { minDoors: 5 });
    const peninsula = branches.find((branch) => branch.memberSet.has(13));
    assert.ok(peninsula, 'the peninsula must be detected');
    assert.equal(peninsula.gate, 3);
    assert.equal(peninsula.size, 6, 'doors 8-13 sit behind the gate');
    assert.equal(peninsula.memberSet.has(3), false, 'the gate itself is not inside the branch');
    assert.equal(peninsula.maxDepth, 6, 'depth runs the length of the spine');
});

test('BR-03 nested branches collapse to the maximal one', () => {
    // Every door along the peninsula spine is itself a cut vertex stranding the
    // doors beyond it. Reporting all of them counts the same geography eight
    // times, which is what inflated an early audit past 1,000 doors.
    const branches = findSingleEntryBranches(peninsulaGraph(), { minDoors: 5 });
    const covering13 = branches.filter((branch) => branch.memberSet.has(13));
    assert.equal(covering13.length, 1, 'door 13 belongs to exactly one reported branch');
});

test('BR-04 a graph with no bottleneck reports no branches', () => {
    // A ring: every door has two ways out, so nothing is stranded and the repair
    // must find nothing to do. A layer that fires on a clean route is worse than
    // one that never fires.
    const adjacency = Array.from({ length: 10 }, () => []);
    for (let i = 0; i < 10; i += 1) {
        const next = (i + 1) % 10;
        adjacency[i].push(next);
        adjacency[next].push(i);
    }
    assert.equal(findSingleEntryBranches(adjacency, { minDoors: 3 }).length, 0);
});

test('BR-05 entries are counted as contiguous visits, not door touches', () => {
    const members = new Set(['c', 'd', 'e']);
    const identify = (x) => x;
    assert.equal(countEntries(['a', 'c', 'd', 'e', 'b'], members, identify), 1);
    assert.equal(countEntries(['c', 'a', 'd', 'b', 'e'], members, identify), 3);
    assert.equal(countEntries(['a', 'b'], members, identify), 0);
});

test('BR-06 priority ranks deep dense branches above shallow stubs', () => {
    const deep = { size: 40, maxDepth: 12 };
    const stub = { size: 40, maxDepth: 1 };
    const small = { size: 5, maxDepth: 12 };
    assert.ok(scoreBranch(deep) > scoreBranch(stub));
    assert.ok(scoreBranch(deep) > scoreBranch(small));
});

// --- consolidation ---------------------------------------------------------

const doorsFor = (ids) => ids.map((id) => ({ address_hash: String(id), lat: 35 + id * 0.001, lng: -80 }));

/**
 * Costs derived from the fixture's own edge list: adjacent doors are cheap,
 * everything else is far. An earlier version of this stub priced two groups
 * cheaply and everything between them expensively, which produced two
 * DISCONNECTED cliques with no gate — so there was no branch to find and the
 * test was asserting against a graph that did not contain the structure.
 */
const NEIGHBOURS = (() => {
    const map = new Map();
    PENINSULA_EDGES.forEach(([a, b]) => {
        if (!map.has(a)) map.set(a, new Set());
        if (!map.has(b)) map.set(b, new Set());
        map.get(a).add(b);
        map.get(b).add(a);
    });
    return map;
})();

const edgeCost = (from, to) => {
    const a = Number(from.address_hash);
    const b = Number(to.address_hash);
    if (a === b) return 0;
    return NEIGHBOURS.get(a)?.has(b) ? 0.1 : 5;
};

/** Adjacency stub: a matrix whose costs come from a supplied function. */
function stubMatrix(costOf) {
    return async (points) => ({
        distances: points.map((from) => points.map((to) => costOf(from, to))),
        durations: null,
        pointCount: points.length,
        blocks: 1,
        snapped: points.length,
        source: 'stub',
        objective: 'distance'
    });
}

/** Path cost under the fixture's graph, used as the measurer. */
const measureByEdges = async (path) => {
    let total = 0;
    for (let i = 0; i < path.length - 1; i += 1) total += edgeCost(path[i], path[i + 1]);
    return { ok: true, totalMiles: total, legMiles: [], longestLegMiles: 0, legDistribution: null };
};

test('BR-07 a route that re-enters a branch is consolidated into one visit', async () => {
    // Enters the peninsula, leaves for the mainland, goes back in.
    const order = doorsFor([0, 1, 8, 9, 10, 2, 3, 11, 12, 13, 4, 5, 6, 7]);
    const branchIds = new Set(['8', '9', '10', '11', '12', '13']);

    const result = await repairBranchReentries(order, {
        measurePath: measureByEdges,
        fetchMatrix: stubMatrix(edgeCost),
        adjacencyMiles: 0.5,
        minBranchDoors: 5
    });

    const entries = countEntries(result.order, branchIds, (d) => d.address_hash);
    assert.equal(entries, 1, 'the branch must be entered exactly once after repair');
    assert.equal(result.order.length, order.length, 'no door may be lost');
    assert.equal(
        new Set(result.order.map((d) => d.address_hash)).size, order.length,
        'no door may be duplicated'
    );
    assert.ok(result.telemetry.branches_repaired >= 1);
    assert.ok(result.telemetry.branch_miles_saved > 0, 'a kept repair must have measured shorter');
});

test('BR-08 a repair that does not measure shorter is discarded', async () => {
    const order = doorsFor([0, 1, 8, 9, 10, 2, 3, 11, 12, 13, 4, 5, 6, 7]);
    const before = order.map((d) => d.address_hash).join(',');
    // Every order costs the same, so consolidating cannot win and nothing may
    // be applied. A repair layer that fires without a measured gain is worse
    // than one that never fires.
    const measurePath = async (path) => ({ ok: true, totalMiles: path.length, legMiles: [], longestLegMiles: 0, legDistribution: null });

    const result = await repairBranchReentries(order, {
        measurePath, fetchMatrix: stubMatrix(edgeCost), adjacencyMiles: 0.5, minBranchDoors: 5
    });
    assert.equal(result.order.map((d) => d.address_hash).join(','), before, 'order must be untouched');
    assert.equal(result.telemetry.branches_repaired, 0);
});

test('BR-09 an unmeasurable route is returned exactly as given', async () => {
    const order = doorsFor([0, 1, 8, 9, 10, 2, 3, 11, 12, 13, 4, 5, 6, 7]);
    const before = order.map((d) => d.address_hash).join(',');
    const result = await repairBranchReentries(order, {
        measurePath: async () => ({ ok: false, error: 'road engine unavailable' }),
        fetchMatrix: stubMatrix(edgeCost),
        adjacencyMiles: 0.5,
        minBranchDoors: 5
    });
    assert.equal(result.order.map((d) => d.address_hash).join(','), before);
    assert.equal(result.telemetry.branch_repair_ran, false);
});

test('BR-10 with no measurer the layer declines rather than guessing', async () => {
    const order = doorsFor([0, 1, 8, 9, 10, 2, 3, 11, 12, 13, 4, 5, 6, 7]);
    const result = await repairBranchReentries(order, { fetchMatrix: stubMatrix(edgeCost) });
    assert.equal(result.order, order, 'the input order is returned by identity');
    assert.equal(result.telemetry.branch_repair_ran, false);
});

test('BR-11 a road engine that cannot price the territory leaves the route alone', async () => {
    const order = doorsFor([0, 1, 8, 9, 10, 2, 3, 11, 12, 13, 4, 5, 6, 7]);
    const before = order.map((d) => d.address_hash).join(',');
    const result = await repairBranchReentries(order, {
        measurePath: measureByEdges,
        fetchMatrix: async () => { throw new Error('OSRM unreachable'); },
        adjacencyMiles: 0.5,
        minBranchDoors: 5
    });
    assert.equal(result.order.map((d) => d.address_hash).join(','), before);
    assert.equal(result.telemetry.branches_found, 0);
});
