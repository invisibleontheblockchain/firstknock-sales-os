// PARITY GUARD — the frozen sequencer facade exposes the frozen optimizer, it
// does not change it.
//
// Splitting needed one entry point that can sequence a 500-home route AND a
// 10-home route, so `sequenceFrozenRoute` was added in front of the two frozen
// ordering paths. Because the Precision optimizer is formally frozen, the facade
// has to be provably transparent:
//
//   PARITY-01  a large route through the facade returns the SAME order, home for
//              home, as the already-frozen decomposition path called directly.
//   PARITY-02  the facade never reaches the small-route path for a large route.
//   PARITY-03  a small route — the input the frozen path REFUSES — is ordered on
//              the exact road matrix tier, which is the only new capability.
//   PARITY-04  the facade's default portfolio is the frozen production baseline
//              alone, so using it cannot quietly enable extra candidates.
//
// Everything runs offline against a fake road engine, because the property under
// test is which code path runs and what it returns, not OSRM. The same fake
// engine serves both sides of the comparison, so PARITY-01 is an equality of
// outputs rather than an equality of claims.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sequenceFrozenRoute,
    FROZEN_BASELINE_PORTFOLIO,
    FROZEN_SEQUENCER_VERSION
} from '../base44/shared/frozenRouteSequencer.js';
import { sequenceBestDecomposition, DEFAULT_DECOMPOSITION_PORTFOLIO } from '../base44/shared/roadDecompositionPortfolio.js';

const DEGREES_TO_MILES = 69;
const BARRIER_DETOUR_MILES = 4;

/** Fake road cost: map distance plus a real detour whenever the barrier is crossed. */
function roadMiles(from, to) {
    const dLat = (Number(from.lat) - Number(to.lat)) * DEGREES_TO_MILES;
    const dLng = (Number(from.lng) - Number(to.lng)) * DEGREES_TO_MILES;
    const direct = Math.sqrt(dLat * dLat + dLng * dLng);
    const crossed = (Number(from.lng) < 0) !== (Number(to.lng) < 0);
    return direct + (crossed ? BARRIER_DETOUR_MILES : 0);
}

/** Same response shape as `fetchRoadMatrix`: miles and minutes, fully resolved. */
async function fetchMatrix(points) {
    const distances = points.map((from) => points.map((to) => roadMiles(from, to)));
    return {
        distances,
        durations: distances.map((row) => row.map((miles) => miles * 2)),
        objective: 'distance_miles',
        snapped: points.length,
        source: 'test:fake',
        blocks: 1,
        pointCount: points.length
    };
}

async function measurePath(order) {
    let totalMiles = 0;
    let longestLegMiles = 0;
    for (let index = 0; index < order.length - 1; index += 1) {
        const leg = roadMiles(order[index], order[index + 1]);
        totalMiles += leg;
        longestLegMiles = Math.max(longestLegMiles, leg);
    }
    return { ok: true, totalMiles, longestLegMiles };
}

/** A two-sided territory of real street blocks, so shared block builders behave normally. */
function makeDoors({ streetsPerSide, doorsPerStreet }) {
    const doors = [];
    ['west', 'east'].forEach((side) => {
        const lngBase = side === 'west' ? -0.02 : 0.02;
        for (let street = 0; street < streetsPerSide; street += 1) {
            for (let house = 0; house < doorsPerStreet; house += 1) {
                doors.push({
                    address_hash: `${side}-${street}-${house}`,
                    street_name: `${side === 'west' ? 'Willow' : 'Elmwood'} ${street} St`,
                    house_number: 100 + house * 2,
                    city: 'Testville',
                    zip_code: '00001',
                    lat: 35 + street * 0.004,
                    lng: lngBase + (side === 'west' ? -1 : 1) * house * 0.0012
                });
            }
        }
    });
    return doors;
}

const identitiesOf = (order) => order.map((door) => door.address_hash);
const baseOptions = { fetchMatrix, measurePath };

// 420 homes: comfortably more than one matrix, so this is the input the frozen
// decomposition path already owns in production today.
const LARGE_DOORS = makeDoors({ streetsPerSide: 21, doorsPerStreet: 10 });
// 40 homes: fits one matrix, which is exactly what the frozen path refuses.
const SMALL_DOORS = makeDoors({ streetsPerSide: 2, doorsPerStreet: 10 });

test('PARITY-01 a large route through the facade is identical to the frozen path called directly', async () => {
    const [viaFacade, viaFrozenPath] = await Promise.all([
        sequenceFrozenRoute(LARGE_DOORS, baseOptions),
        sequenceBestDecomposition(LARGE_DOORS, { ...baseOptions, portfolio: FROZEN_BASELINE_PORTFOLIO })
    ]);

    assert.equal(viaFrozenPath.ok, true, `frozen path failed: ${viaFrozenPath.code}`);
    assert.equal(viaFacade.ok, true, `facade failed: ${viaFacade.code}`);
    assert.deepEqual(
        identitiesOf(viaFacade.order),
        identitiesOf(viaFrozenPath.order),
        'the facade changed the frozen optimizer\'s order'
    );
    // Same objects, not just equal identities: the facade passes the solver's
    // output through rather than rebuilding doors along the way.
    assert.ok(viaFacade.order.every((door, index) => door === viaFrozenPath.order[index]));
    assert.equal(viaFacade.metadata.verified_road_miles, viaFrozenPath.best.verified_road_miles);
});

test('PARITY-02 a large route never falls through to the small-route path', async () => {
    const result = await sequenceFrozenRoute(LARGE_DOORS, baseOptions);
    assert.equal(result.ok, true);
    assert.equal(result.path, 'decomposition_portfolio');
    assert.equal(result.metadata.path, 'decomposition_portfolio');
    assert.equal(result.metadata.sequencer_version, FROZEN_SEQUENCER_VERSION);
    assert.equal(result.metadata.matrix_tier, undefined, 'a large route must not be ordered on one matrix');
    assert.equal(new Set(identitiesOf(result.order)).size, LARGE_DOORS.length);
});

test('PARITY-03 a small route is refused by the frozen path and ordered on the exact matrix tier', async () => {
    const viaFrozenPath = await sequenceBestDecomposition(SMALL_DOORS, {
        ...baseOptions,
        portfolio: FROZEN_BASELINE_PORTFOLIO
    });
    // The reason the facade exists: this input has no answer on the frozen path.
    assert.equal(viaFrozenPath.ok, false);
    assert.ok(
        viaFrozenPath.code === 'SINGLE_CLUSTER_USE_EXACT_MATRIX'
        || viaFrozenPath.candidates?.every((candidate) => candidate.reason === 'SINGLE_CLUSTER_USE_EXACT_MATRIX'),
        `expected a single-cluster refusal, got ${viaFrozenPath.code}`
    );

    const viaFacade = await sequenceFrozenRoute(SMALL_DOORS, baseOptions);
    assert.equal(viaFacade.ok, true, `facade failed on a small route: ${viaFacade.code}`);
    assert.equal(viaFacade.path, 'exact_matrix');
    assert.ok(viaFacade.metadata.matrix_tier, 'the small path must report which matrix tier it used');
    assert.ok(viaFacade.metadata.candidates_measured >= 2, 'both objectives must be swept and measured');
    assert.equal(viaFacade.order.length, SMALL_DOORS.length);
    assert.equal(new Set(identitiesOf(viaFacade.order)).size, SMALL_DOORS.length);

    // A one-home route has one order; a two-home route still goes through a path.
    const trivial = await sequenceFrozenRoute([SMALL_DOORS[0]], baseOptions);
    assert.equal(trivial.ok, true);
    assert.equal(trivial.path, 'trivial');
});

test('PARITY-04 the facade defaults to the frozen production baseline only', () => {
    assert.equal(FROZEN_BASELINE_PORTFOLIO.length, 1);
    assert.equal(FROZEN_BASELINE_PORTFOLIO[0].id, DEFAULT_DECOMPOSITION_PORTFOLIO[0].id);
    assert.equal(FROZEN_BASELINE_PORTFOLIO[0].mandatory, true);
    // Splitting runs the solver K times; silently enabling speculative
    // decompositions here would multiply cost and change frozen behavior at once.
    assert.ok(DEFAULT_DECOMPOSITION_PORTFOLIO.length > FROZEN_BASELINE_PORTFOLIO.length);
});