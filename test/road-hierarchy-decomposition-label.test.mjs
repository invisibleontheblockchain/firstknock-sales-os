// The stored decomposition strategy must name the path that ACTUALLY ran.
//
// `telemetry.decomposition` is initialized to the preferred road-ordered strategy
// before the level-1 strategies are attempted. When a territory has more street
// blocks than one matrix can carry, the sequencer falls through to geometric
// (lat/lng k-d) windows — and that branch used to leave the optimistic label in
// place. A stored route then read `decomposition: "road_ordered_windows"` next to
// `window_grouping_road_priced: false` in the same record: two fields describing
// the same decision, disagreeing. Route audits trusted the label and concluded the
// windows had been cut from a road-priced block order when they had not.
//
// A great deal of work went into making this optimizer refuse to overstate what it
// priced on roads. Strategy telemetry is part of that contract, so the invariant is
// pinned here rather than left to review.
//
// The road network is injected, so these assertions are about the ALGORITHM rather
// than about OSRM being reachable from CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMiles } from '../base44/shared/routeContinuityOptimizer.js';
import { sequenceRoadHierarchy } from '../base44/shared/roadHierarchySequencer.js';
import { MAX_ROUTE_MATRIX_POINTS } from '../base44/shared/roadMatrix.js';

/** Labels that assert the windows were cut from a road-priced block order. */
const ROAD_GROUPED_LABELS = new Set(['road_ordered_windows', 'coarse_road_ordered_windows']);

const fixtureMatrix = (points) => ({
    distances: points.map((from) => points.map((to) => haversineMiles(from, to) * 1.25)),
    durations: null,
    objective: 'distance_miles',
    snapped: points.length,
    source: 'fixture:grid',
    blocks: 1,
    pointCount: points.length
});

/**
 * A plain grid, one street per row, `doorsPerStreet` doors on each. `streetCount`
 * is what decides which level-1 strategy is reachable: above the matrix point
 * limit, every block representative can no longer fit one matrix.
 */
function buildGridTerritory(streetCount, doorsPerStreet) {
    const doors = [];
    for (let street = 0; street < streetCount; street += 1) {
        for (let house = 0; house < doorsPerStreet; house += 1) {
            doors.push({
                address_hash: `s${street}-h${house}`,
                house_number: 101 + house * 2,
                street_name: `Grid ${street} St`,
                city: 'Testville',
                zip_code: '00001',
                lat: 35.2 + street * 0.003,
                lng: -80.8 + house * 0.0004
            });
        }
    }
    return doors;
}

const sequence = (doors, options = {}) => sequenceRoadHierarchy(doors, {
    fetchMatrix: async (points) => fixtureMatrix(points),
    ...options
});

test('geometric windows are labelled geometric, not road-ordered', async () => {
    // More blocks than one matrix can carry, and coarse ordering left off: this is
    // the production shape of a 1,000-door route, and the branch that used to store
    // the optimistic label.
    const doors = buildGridTerritory(MAX_ROUTE_MATRIX_POINTS + 50, 4);
    const result = await sequence(doors);

    assert.equal(result.ok, true);
    assert.equal(result.telemetry.window_grouping_road_priced, false, 'fixture must reach the geometric branch');
    assert.equal(
        result.telemetry.decomposition,
        'geometric_windows',
        'a route whose windows came from lat/lng boxes must not store a road-ordered strategy'
    );
});

test('forcing geometric windows stores the geometric label', async () => {
    const doors = buildGridTerritory(40, 8);
    const result = await sequence(doors, { forceGeometricWindows: true });

    assert.equal(result.ok, true);
    assert.equal(result.telemetry.window_grouping_road_priced, false);
    assert.equal(result.telemetry.decomposition, 'geometric_windows');
});

test('the road-ordered labels are only stored when the grouping really was road-priced', async () => {
    // Both strategies that DO cut windows out of a road-priced block order, so the
    // invariant below is proven to be discriminating rather than vacuously true.
    const smallEnoughForOneMatrix = await sequence(buildGridTerritory(40, 8));
    assert.equal(smallEnoughForOneMatrix.telemetry.decomposition, 'road_ordered_windows');
    assert.equal(smallEnoughForOneMatrix.telemetry.window_grouping_road_priced, true);

    const coarse = await sequence(buildGridTerritory(MAX_ROUTE_MATRIX_POINTS + 50, 4), { coarseBlockOrder: true });
    assert.equal(coarse.telemetry.decomposition, 'coarse_road_ordered_windows');
    assert.equal(coarse.telemetry.window_grouping_road_priced, true);
});

test('no reachable path stores a road-grouped label alongside road_priced=false', async () => {
    // The invariant itself, over every level-1 outcome the sequencer can reach.
    const cases = [
        { name: 'blocks fit one matrix', doors: buildGridTerritory(40, 8), options: {} },
        { name: 'forced geometric', doors: buildGridTerritory(40, 8), options: { forceGeometricWindows: true } },
        { name: 'too many blocks', doors: buildGridTerritory(MAX_ROUTE_MATRIX_POINTS + 50, 4), options: {} },
        {
            name: 'too many blocks, coarse enabled',
            doors: buildGridTerritory(MAX_ROUTE_MATRIX_POINTS + 50, 4),
            options: { coarseBlockOrder: true }
        }
    ];

    for (const { name, options, doors } of cases) {
        const { telemetry } = await sequence(doors, options);
        if (telemetry.window_grouping_road_priced) continue;
        assert.ok(
            !ROAD_GROUPED_LABELS.has(telemetry.decomposition),
            `${name}: stored "${telemetry.decomposition}" while the grouping was not road-priced`
        );
    }
});