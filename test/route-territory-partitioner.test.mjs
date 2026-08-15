// Proof that membership is now decided by road topology, not by slicing a sweep.
//
// Everything here runs offline against a synthetic territory and a FAKE road
// engine, because the property under test is the partitioner's decision-making,
// not OSRM. The fake engine has one deliberate feature: a river. Two banks sit
// close together on the map and far apart to drive, which is exactly the geometry
// that defeated the old splitter — a contiguous slice of a street sweep happily
// spans the river, and no amount of in-route optimization can undo the crossing.
//
// The same fake optimizer and the same fake measurement score BOTH models, so the
// old-vs-new comparison is a measurement rather than a claim.

import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionRouteTerritories } from '../base44/shared/routeTerritoryPartitioner.js';
import { buildSplitAtoms } from '../base44/shared/splitAtoms.js';

const BRIDGE_DETOUR_MILES = 6;
const DEGREES_TO_MILES = 69;

const bankOf = (point) => (Number(point.lng) < 0 ? 'west' : 'east');

/** Fake road cost: map distance, plus a real detour whenever a bank is crossed. */
function roadMiles(from, to) {
    const dLat = (Number(from.lat) - Number(to.lat)) * DEGREES_TO_MILES;
    const dLng = (Number(from.lng) - Number(to.lng)) * DEGREES_TO_MILES;
    const direct = Math.sqrt(dLat * dLat + dLng * dLng);
    return direct + (bankOf(from) === bankOf(to) ? 0 : BRIDGE_DETOUR_MILES);
}

const fetchRows = async (sources, destinations) => ({
    rows: sources.map((source) => destinations.map((destination) => roadMiles(source, destination))),
    requestCount: 1
});

/** Stand-in for the frozen optimizer: deterministic nearest-neighbour ordering. */
const optimizeRoute = async (doors) => {
    const remaining = [...doors].sort((first, second) => (first.address_hash < second.address_hash ? -1 : 1));
    const order = [remaining.shift()];
    while (remaining.length > 0) {
        let bestIndex = 0;
        let bestMiles = Infinity;
        remaining.forEach((door, index) => {
            const miles = roadMiles(order[order.length - 1], door);
            if (miles < bestMiles - 1e-12) {
                bestMiles = miles;
                bestIndex = index;
            }
        });
        order.push(remaining.splice(bestIndex, 1)[0]);
    }
    return { order };
};

const measurePath = async (order) => {
    let totalMiles = 0;
    for (let index = 0; index < order.length - 1; index += 1) totalMiles += roadMiles(order[index], order[index + 1]);
    return { ok: true, totalMiles };
};

/**
 * A two-bank territory: `streetsPerBank` streets each side of the river, every
 * street a run of houses. Street names and house numbers are real so the shared
 * street-block builder produces the same blocks it would in production.
 */
function makeTerritory({ streetsPerBank = 6, doorsPerStreet = 10 } = {}) {
    const doors = [];
    ['west', 'east'].forEach((bank) => {
        const lngBase = bank === 'west' ? -0.02 : 0.02;
        for (let street = 0; street < streetsPerBank; street += 1) {
            for (let house = 0; house < doorsPerStreet; house += 1) {
                doors.push({
                    address_hash: `${bank}-${street}-${house}`,
                    street_name: `${bank === 'west' ? 'Willow' : 'Elmwood'} ${street} St`,
                    house_number: 100 + house * 2,
                    full_address: `${100 + house * 2} ${bank} ${street} St`,
                    lat: 35 + street * 0.004,
                    lng: lngBase + (bank === 'west' ? -1 : 1) * house * 0.0012
                });
            }
        }
    });
    return doors;
}

const baseOptions = { fetchRows, optimizeRoute, measurePath };

/** The OLD model, reproduced: one good 1-D route, chopped into K contiguous pieces. */
async function oldSweepSliceSplit(doors, routeCount) {
    const { order } = await optimizeRoute(doors);
    const base = Math.floor(order.length / routeCount);
    const larger = order.length % routeCount;
    const routes = [];
    let offset = 0;
    for (let index = 0; index < routeCount; index += 1) {
        const size = base + (index < larger ? 1 : 0);
        routes.push(order.slice(offset, offset + size));
        offset += size;
    }
    let combined = 0;
    for (const group of routes) {
        const optimized = await optimizeRoute(group);
        const measured = await measurePath(optimized.order);
        combined += measured.totalMiles;
    }
    return { routes, combinedVerifiedRoadMiles: combined };
}

test('SPLIT-01 every requested K produces exactly K routes holding every home exactly once', async () => {
    const doors = makeTerritory({ streetsPerBank: 12, doorsPerStreet: 10 }); // 240 homes
    for (const routeCount of [2, 3, 5, 10, 20, 50]) {
        const result = await partitionRouteTerritories(doors, routeCount, baseOptions);
        assert.equal(result.ok, true, `K=${routeCount} failed: ${result.code}`);
        assert.equal(result.routes.length, routeCount);
        assert.equal(result.report.route_count_exact, true);
        assert.equal(result.report.exact_once, true);
        assert.equal(result.report.door_count_out, doors.length);

        const identities = result.routes.flatMap((route) => route.doors.map((door) => door.address_hash));
        assert.equal(identities.length, doors.length, `K=${routeCount} lost or duplicated homes`);
        assert.equal(new Set(identities).size, doors.length);
        assert.ok(result.routes.every((route) => route.doorCount > 0));
    }
});

test('SPLIT-02 a road barrier separates territories instead of being sliced through', async () => {
    const doors = makeTerritory({ streetsPerBank: 8, doorsPerStreet: 10 });
    const result = await partitionRouteTerritories(doors, 2, baseOptions);
    assert.equal(result.ok, true);

    // No route may own homes on both banks: the two sides are near on the map and
    // six miles apart to drive, so a route spanning them is a route that crosses
    // the river twice for nothing.
    result.routes.forEach((route) => {
        const banks = new Set(route.doors.map(bankOf));
        assert.equal(banks.size, 1, 'a route straddled the river');
    });
    assert.equal(result.report.street_blocks_shared_across_routes, 0);
});

// Mileage superiority is a claim about real geography, so it is proven in the
// live benchmark (scripts/route-split-benchmark.mjs) against real territories and
// the real frozen solver — not manufactured here with a fake engine. What this
// fixture CAN prove offline is the structural difference, and that the new model
// is never materially worse on the same measurement.
test('SPLIT-03 sweep-slicing fragments streets; the partitioner does not, at equal or better mileage', async () => {
    const doors = makeTerritory({ streetsPerBank: 8, doorsPerStreet: 10 });
    const countSharedStreets = (routes) => {
        const owners = new Map();
        routes.forEach((group, index) => group.forEach((door) => {
            if (!owners.has(door.street_name)) owners.set(door.street_name, new Set());
            owners.get(door.street_name).add(index);
        }));
        return [...owners.values()].filter((set) => set.size > 1).length;
    };

    for (const routeCount of [2, 5]) {
        const [next, old] = await Promise.all([
            partitionRouteTerritories(doors, routeCount, baseOptions),
            oldSweepSliceSplit(doors, routeCount)
        ]);
        assert.equal(next.ok, true);
        assert.ok(
            next.report.combined_verified_road_miles <= old.combinedVerifiedRoadMiles * 1.001,
            `K=${routeCount}: new ${next.report.combined_verified_road_miles} mi vs old ${old.combinedVerifiedRoadMiles} mi`
        );
        assert.equal(
            next.report.street_blocks_shared_across_routes,
            0,
            `K=${routeCount} left a street block owned by more than one route`
        );
    }

    // At K=5 a contiguous slice of the sweep necessarily cuts through streets,
    // which is the fragmentation the new membership model removes by construction.
    const sliced = await oldSweepSliceSplit(doors, 5);
    assert.ok(countSharedStreets(sliced.routes) > 0, 'expected sweep-slicing to fragment streets');
});

test('SPLIT-04 the balance contract is enforced on both sides and reported in full', async () => {
    const doors = makeTerritory({ streetsPerBank: 10, doorsPerStreet: 10 }); // 200 homes
    const result = await partitionRouteTerritories(doors, 5, baseOptions);
    assert.equal(result.ok, true);
    assert.equal(result.report.homes_per_route.reduce((sum, count) => sum + count, 0), doors.length);

    // Balance policy is chosen by competition, so the report must name the policy
    // that won rather than a hard-coded tolerance.
    assert.ok(['tight', 'moderate', 'loose'].includes(result.report.selected_balance_policy));
    assert.deepEqual(result.report.balance_policies_tried, ['tight', 'moderate', 'loose']);

    // Both bounds, both actuals, and both kinds of violation are published, and
    // "relaxations" counts under-fill as well as over-fill.
    ['min_homes_allowed', 'max_homes_allowed', 'routes_below_min', 'routes_above_max', 'balance_relaxations']
        .forEach((field) => assert.equal(typeof result.report[field], 'number', `${field} missing`));
    assert.equal(
        result.report.balance_relaxations,
        result.report.routes_below_min + result.report.routes_above_max
    );
    assert.equal(result.report.balance_valid, result.report.balance_relaxations === 0);

    // A finalist is never outside the eligibility band, whichever tier it came from.
    assert.ok(['in_declared_band', 'within_atom_granularity_slack'].includes(result.report.balance_selection_tier));
    assert.ok(result.report.min_homes >= result.report.eligible_min_homes);
    assert.ok(result.report.max_homes <= result.report.eligible_max_homes);
    // The hard guarantee: no rep ever gets less than half the declared minimum.
    assert.ok(result.report.min_homes >= Math.ceil(result.report.min_homes_allowed / 2));
});

test('SPLIT-09 severe under-fill is refused, not reported as balanced', async () => {
    const doors = makeTerritory({ streetsPerBank: 10, doorsPerStreet: 10 }); // 200 homes
    for (const routeCount of [10, 20, 40]) {
        const result = await partitionRouteTerritories(doors, routeCount, baseOptions);
        assert.equal(result.ok, true, `K=${routeCount} failed: ${result.code}`);
        const target = doors.length / routeCount;
        // The pre-fix failure mode: a 1–2 home route while the report claimed
        // zero relaxations. Half the target is the floor no split may cross.
        assert.ok(
            result.report.min_homes >= Math.ceil(result.report.min_homes_allowed / 2),
            `K=${routeCount} produced a ${result.report.min_homes}-home route against target ${target}`
        );
        assert.ok(result.report.min_homes >= result.report.eligible_min_homes);
        if (result.report.balance_relaxations > 0) assert.equal(result.report.balance_valid, false);
    }
});

test('SPLIT-05 granularity follows K: natural units at low K, blocks and doors at high K', async () => {
    const doors = makeTerritory({ streetsPerBank: 10, doorsPerStreet: 10 });
    const low = buildSplitAtoms(doors, 2);
    const high = buildSplitAtoms(doors, 50);
    assert.equal(low.ok, true);
    assert.equal(high.ok, true);
    assert.ok(high.telemetry.atom_count > low.telemetry.atom_count, 'atom count must grow with K');
    assert.ok(low.telemetry.max_atom_doors > high.telemetry.max_atom_doors);
    // At K=50 (target 4 homes) a 10-home street block cannot stay whole.
    assert.ok(high.telemetry.blocks_subdivided > 0);
    assert.equal(low.telemetry.blocks_subdivided, 0);
});

test('SPLIT-06 unmeasurable road cost fails the split instead of guessing', async () => {
    const doors = makeTerritory({ streetsPerBank: 4, doorsPerStreet: 8 });

    const noRoadCosts = await partitionRouteTerritories(doors, 3, {
        ...baseOptions,
        fetchRows: async () => { throw new Error('engine down'); }
    });
    assert.equal(noRoadCosts.ok, false);
    assert.equal(noRoadCosts.code, 'SPLIT_ROAD_COST_UNAVAILABLE');

    const unmeasured = await partitionRouteTerritories(doors, 3, {
        ...baseOptions,
        measurePath: async () => ({ ok: false, error: 'no route' })
    });
    assert.equal(unmeasured.ok, false);
    assert.equal(unmeasured.code, 'NO_VERIFIED_PARTITION');

    const noVerifier = await partitionRouteTerritories(doors, 3, { fetchRows });
    assert.equal(noVerifier.ok, false);
    assert.equal(noVerifier.code, 'VERIFICATION_FUNCTIONS_REQUIRED');
});

test('SPLIT-07 the winner is the measured winner, and every finalist is reported', async () => {
    const doors = makeTerritory({ streetsPerBank: 6, doorsPerStreet: 10 });
    const result = await partitionRouteTerritories(doors, 4, baseOptions);
    assert.equal(result.ok, true);

    const summed = result.routes.reduce((sum, route) => sum + route.verifiedRoadMiles, 0);
    assert.ok(Math.abs(result.report.combined_verified_road_miles - summed) < 0.01);
    assert.equal(result.report.all_routes_measured, true);

    const verified = result.report.candidates.filter((candidate) => candidate.verified);
    assert.ok(verified.length >= 1);
    const best = Math.min(...verified.map((candidate) => candidate.combined_verified_road_miles));
    assert.ok(Math.abs(best - result.report.combined_verified_road_miles) < 0.01);
    assert.equal(
        result.report.candidates.find((candidate) => candidate.id === result.selected_candidate).verified,
        true
    );
    // Surrogate scores exist for every candidate, including the ones that were
    // never paid for in frozen-solver runs.
    assert.ok(result.report.candidates.every((candidate) => Number.isFinite(candidate.surrogate_road_miles)));
});

test('SPLIT-08 refusals are explicit: K must be reachable from the homes available', async () => {
    const doors = makeTerritory({ streetsPerBank: 2, doorsPerStreet: 5 }); // 20 homes
    const tooMany = await partitionRouteTerritories(doors, 25, baseOptions);
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.code, 'ATOM_ROUTE_COUNT_EXCEEDS_DOORS');

    const tooFew = await partitionRouteTerritories(doors, 1, baseOptions);
    assert.equal(tooFew.ok, false);
    assert.equal(tooFew.code, 'ATOM_INPUT_INVALID_ROUTE_COUNT');

    const duplicated = await partitionRouteTerritories([...doors, doors[0]], 3, baseOptions);
    assert.equal(duplicated.ok, false);
    assert.equal(duplicated.code, 'ATOM_INPUT_DUPLICATE_DOORS');
});