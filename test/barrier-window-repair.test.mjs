// Compactness-constrained barrier repair, exercised on a synthetic river.
//
// World: two banks separated at lng -80.75, the only bridge far to the south.
// Same-bank driving is aerial * 1.2 (excess well under the threshold); crossing
// costs the full detour via the bridge (excess of many miles). The geometric
// partitioner cuts this territory on latitude, so every window straddles the
// river — exactly the Route 1I window-0 defect, reproduced deterministically.
//
// The road network is injected; these assertions are about the ALGORITHM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMiles } from '../base44/shared/routeContinuityOptimizer.js';
import { repairBarrierWindows, DEFAULT_BARRIER_EXCESS_MILES } from '../base44/shared/barrierWindowRepair.js';
import { sequenceRoadHierarchy } from '../base44/shared/roadHierarchySequencer.js';

const RIVER_LNG = -80.75;
const BRIDGE = { lat: 34.9, lng: RIVER_LNG };
const bankOf = (point) => (Number(point.lng) < RIVER_LNG ? 'west' : 'east');

/** Driving cost: direct on the same bank, via the distant bridge across it. */
const roadCost = (from, to) => (bankOf(from) === bankOf(to)
    ? haversineMiles(from, to) * 1.2
    : (haversineMiles(from, BRIDGE) + haversineMiles(BRIDGE, to)) * 1.2);

const riverMatrix = async (points) => ({
    distances: points.map((from) => points.map((to) => roadCost(from, to))),
    durations: null,
    objective: 'distance_miles',
    snapped: points.length,
    source: 'fixture:river',
    blocks: 1,
    pointCount: points.length
});

/** One street block entry with `doors` doors at the given coordinate. */
const blockEntry = (id, lat, lng, doors = 4) => ({
    block: { doors: Array.from({ length: doors }, (_, house) => ({ address_hash: `${id}-h${house}`, lat, lng })) },
    representative: { lat, lng }
});

const blockIds = (windows) => windows
    .flatMap((window) => window.entries.map((entry) => entry.block.doors[0].address_hash))
    .sort();

test('coherent windows are left untouched', async () => {
    const windows = [
        { entries: [blockEntry('w0', 35.00, -80.77), blockEntry('w1', 35.005, -80.77)] },
        { entries: [blockEntry('w2', 35.05, -80.77), blockEntry('w3', 35.055, -80.77)] }
    ];
    const result = await repairBarrierWindows(windows, { maxDoors: 200, fetchMatrix: riverMatrix });

    assert.equal(result.ok, true);
    assert.equal(result.telemetry.barrier_straddling_windows, 0);
    assert.equal(result.telemetry.barrier_blocks_moved, 0);
    assert.equal(result.windows.length, 2);
    assert.deepEqual(blockIds(result.windows), blockIds(windows));
});

test('a straddling window sheds its minority component to the road-nearest coherent window', async () => {
    // Window 0 holds three west blocks and one stranded east block; window 1 is
    // pure east and sits road-near the stranded block. The repair must move the
    // COMPLETE east block into window 1 and nothing else.
    const stranded = blockEntry('east-stranded', 35.00, -80.74);
    const windows = [
        { entries: [blockEntry('west-a', 35.00, -80.77), blockEntry('west-b', 35.005, -80.77), blockEntry('west-c', 35.01, -80.77), stranded] },
        { entries: [blockEntry('east-a', 35.01, -80.74), blockEntry('east-b', 35.015, -80.74)] }
    ];
    const result = await repairBarrierWindows(windows, { maxDoors: 200, fetchMatrix: riverMatrix });

    assert.equal(result.ok, true);
    assert.equal(result.telemetry.barrier_straddling_windows, 1);
    assert.equal(result.telemetry.barrier_blocks_moved, 1);
    assert.equal(result.telemetry.barrier_doors_moved, 4);
    assert.equal(result.telemetry.barrier_new_windows, 0);
    // Exact-once at block level, and every final window is single-bank.
    assert.deepEqual(blockIds(result.windows), blockIds(windows));
    result.windows.forEach((window) => {
        const banks = new Set(window.entries.map((entry) => bankOf(entry.representative)));
        assert.equal(banks.size, 1, 'a repaired window must not straddle the river');
    });
});

test('a component with no coherent or capacious destination becomes its own window', async () => {
    // The only other window is across the river, so moving there repairs nothing;
    // the stranded component must stand alone rather than stay trapped.
    const windows = [
        { entries: [blockEntry('west-a', 35.00, -80.77), blockEntry('east-stranded', 35.00, -80.74)] },
        { entries: [blockEntry('west-b', 35.05, -80.77), blockEntry('west-c', 35.055, -80.77)] }
    ];
    const result = await repairBarrierWindows(windows, { maxDoors: 5, fetchMatrix: riverMatrix });

    assert.equal(result.ok, true);
    assert.equal(result.telemetry.barrier_new_windows, 1);
    assert.equal(result.windows.length, 3);
    assert.deepEqual(blockIds(result.windows), blockIds(windows));
    result.windows.forEach((window) => {
        assert.equal(new Set(window.entries.map((entry) => bankOf(entry.representative))).size, 1);
    });
});

test('the repair is deterministic', async () => {
    const build = () => [
        { entries: [blockEntry('w0', 35.00, -80.77), blockEntry('e0', 35.00, -80.74), blockEntry('w1', 35.005, -80.77)] },
        { entries: [blockEntry('e1', 35.01, -80.74), blockEntry('e2', 35.015, -80.74)] },
        { entries: [blockEntry('w2', 35.02, -80.77), blockEntry('w3', 35.025, -80.77)] }
    ];
    const first = await repairBarrierWindows(build(), { maxDoors: 200, fetchMatrix: riverMatrix });
    const second = await repairBarrierWindows(build(), { maxDoors: 200, fetchMatrix: riverMatrix });

    assert.equal(first.ok, true);
    assert.deepEqual(
        first.windows.map((window) => window.entries.map((entry) => entry.block.doors[0].address_hash)),
        second.windows.map((window) => window.entries.map((entry) => entry.block.doors[0].address_hash))
    );
});

test('an unresolvable road cost fails the repair instead of guessing', async () => {
    const windows = [
        { entries: [blockEntry('w0', 35.00, -80.77), blockEntry('e0', 35.00, -80.74)] },
        { entries: [blockEntry('w1', 35.01, -80.77), blockEntry('w2', 35.015, -80.77)] }
    ];
    const result = await repairBarrierWindows(windows, {
        maxDoors: 200,
        fetchMatrix: async () => { throw new Error('engine unreachable'); }
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'BARRIER_REPAIR_ROAD_COST_UNAVAILABLE');
});

// ---- Integration: the full sequencer on a river territory. ----

/** Paired streets on a NARROW river: the banks are ~0.15 mi apart in the air, so
 *  latitude is always the wider axis and the geometric k-d cut puts both banks in
 *  every window — the aerial-near / road-far straddle, reproduced exactly. */
function buildRiverTerritory(rows = 48, doorsPerStreet = 4) {
    const doors = [];
    for (let row = 0; row < rows; row += 1) {
        const lat = 35.0 + row * 0.008;
        [['W', -80.752], ['E', -80.7496]].forEach(([side, lng]) => {
            for (let house = 0; house < doorsPerStreet; house += 1) {
                doors.push({
                    address_hash: `${side}${row}-h${house}`,
                    house_number: 101 + house * 2,
                    street_name: `${side === 'W' ? 'West' : 'East'} ${row} St`,
                    city: 'Riverton',
                    zip_code: '00001',
                    lat,
                    lng: lng + house * 0.0004
                });
            }
        });
    }
    return doors;
}

const orderCost = (order) => order.slice(1).reduce((total, door, index) => total + roadCost(order[index], door), 0);
const bankSwitches = (order) => order.slice(1).reduce((total, door, index) => (
    total + (bankOf(order[index]) === bankOf(door) ? 0 : 1)
), 0);

test('barrier repair removes forced river crossings and measures shorter than the geometric cut', async () => {
    // Production-sized windows, so seam refinement (which re-solves up to 44 doors
    // per side of each cut) cannot untangle a whole window by itself — membership
    // is the only thing that can free the interior doors, as on Route 1I.
    const doors = buildRiverTerritory();
    const shared = { fetchMatrix: riverMatrix, forceGeometricWindows: true };

    const baseline = await sequenceRoadHierarchy(doors, shared);
    const repaired = await sequenceRoadHierarchy(doors, { ...shared, barrierRepair: true });

    assert.equal(baseline.ok, true);
    assert.equal(repaired.ok, true);
    // Exact-once under repair.
    assert.equal(repaired.order.length, doors.length);
    assert.equal(new Set(repaired.order.map((door) => door.address_hash)).size, doors.length);
    // Honest strategy telemetry: repaired memberships get their own label, and the
    // grouping flag still says the BODY of the cut was not road-priced.
    assert.equal(repaired.telemetry.decomposition, 'barrier_repaired_geometric_windows');
    assert.equal(repaired.telemetry.window_grouping_road_priced, false);
    assert.ok(repaired.telemetry.barrier_blocks_moved > 0);
    // The point of the exercise: membership repair removes crossings the solver
    // could never remove, and the route measures shorter on the same road world.
    assert.ok(
        bankSwitches(repaired.order) < bankSwitches(baseline.order),
        `expected fewer river crossings (${bankSwitches(repaired.order)} vs ${bankSwitches(baseline.order)})`
    );
    assert.ok(
        orderCost(repaired.order) < orderCost(baseline.order),
        `expected shorter measured route (${orderCost(repaired.order).toFixed(2)} vs ${orderCost(baseline.order).toFixed(2)})`
    );
});

test('barrier repair leaves a coherent territory byte-identical to the geometric cut', async () => {
    // No barrier: every door on one bank. The repair must detect nothing, move
    // nothing, and keep the label geometric — compactness is preserved by default.
    const doors = buildRiverTerritory().filter((door) => bankOf(door) === 'west');
    const shared = { fetchMatrix: riverMatrix, forceGeometricWindows: true };

    const baseline = await sequenceRoadHierarchy(doors, shared);
    const repaired = await sequenceRoadHierarchy(doors, { ...shared, barrierRepair: true });

    assert.equal(repaired.ok, true);
    assert.equal(repaired.telemetry.barrier_blocks_moved, 0);
    assert.equal(repaired.telemetry.decomposition, 'geometric_windows');
    assert.deepEqual(
        repaired.order.map((door) => door.address_hash),
        baseline.order.map((door) => door.address_hash)
    );
});

test(`default excess threshold sits far from both populations (${DEFAULT_BARRIER_EXCESS_MILES} mi)`, () => {
    // Same-bank suburban excess (road = aerial * 1.2 over <= 2 mi spans) stays far
    // below the threshold; the Route 1I barrier measured 9.7 mi of pure excess,
    // far above it. The threshold separating two well-separated populations is
    // what makes a single constant defensible.
    const sameBankExcess = 2 * 0.2; // 2 mi aerial at 1.2x
    assert.ok(sameBankExcess < DEFAULT_BARRIER_EXCESS_MILES / 2);
    assert.ok(9.7 > DEFAULT_BARRIER_EXCESS_MILES * 2);
});