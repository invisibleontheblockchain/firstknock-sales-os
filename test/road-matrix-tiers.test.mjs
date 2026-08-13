// A route bigger than the door matrix must still be ordered on real roads.
//
// Above 250 doors the road pass used to return nothing, so the route silently
// kept its aerial continuity order while still being labelled optimized. These
// tests pin the replacement: the matrix is bounded at the STREET BLOCK level, the
// blocks are exactly the ones the solver reorders, and the tier is always
// reported so a stored route cannot overstate how it was measured.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStreetBlocks } from '../base44/shared/roadAwareStreetSweep.js';
import { MAX_ROUTE_MATRIX_POINTS } from '../base44/shared/roadMatrix.js';
import {
    createTieredMatrixMetricFns,
    MAX_TIERED_ROUTE_DOORS,
    planTieredRoadMatrix,
    TIER_BLOCK,
    TIER_DOOR
} from '../base44/shared/roadMatrixTiers.js';

/**
 * `streetCount` streets of `perStreet` doors each. Streets are far enough apart
 * that the gap splitter keeps them separate; doors on a street are ~90ft apart so
 * they stay one block.
 */
function doors(streetCount, perStreet) {
    const out = [];
    for (let street = 0; street < streetCount; street += 1) {
        for (let house = 0; house < perStreet; house += 1) {
            out.push({
                address_hash: `s${street}-h${house}`,
                house_number: String(100 + house * 2),
                street_name: `Street ${street}`,
                city: 'Anderson',
                zip_code: '29621',
                lat: 34.5 + street * 0.02 + house * 0.00025,
                lng: -82.65 - street * 0.02
            });
        }
    }
    return out;
}

const coordinateKey = (point) => `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;

/** Matrix whose cells encode their own endpoints, so a mis-mapped leg is visible. */
function stubMatrix(points) {
    const index = new Map(points.map((point, position) => [coordinateKey(point), position]));
    const table = points.map((_, from) => points.map((__, to) => (from === to ? 0 : from * 1000 + to)));
    return {
        matrix: { distances: table, durations: table, objective: 'distance_miles', pointCount: points.length },
        index
    };
}

test('TIER-01 a route inside the door limit is unchanged and exact', () => {
    const properties = doors(10, 8); // 80 doors
    const plan = planTieredRoadMatrix(properties, []);

    assert.equal(plan.ok, true);
    assert.equal(plan.tier, TIER_DOOR);
    assert.equal(plan.matrixPoints.length, 80, 'every door is priced door-to-door');
    assert.equal(plan.blockCount, 0);
});

test('TIER-02 anchors join the door matrix only while they fit', () => {
    const anchor = [{ lat: 34.4, lng: -82.7 }];
    const fits = planTieredRoadMatrix(doors(10, 8), anchor);
    assert.equal(fits.anchorsIncluded, true);
    assert.equal(fits.matrixPoints.length, 81);

    // Exactly at the door ceiling there is no room left for an anchor, which is
    // the pre-existing behaviour: doors stay exact, the anchor goes unmeasured.
    const full = planTieredRoadMatrix(doors(25, 10), anchor); // 250 doors
    assert.equal(full.tier, TIER_DOOR);
    assert.equal(full.anchorsIncluded, false);
    assert.equal(full.matrixPoints.length, MAX_ROUTE_MATRIX_POINTS);
});

test('TIER-03 a large route is bounded at the block level, not abandoned', () => {
    const properties = doors(60, 10); // 600 doors — far beyond the door matrix
    const plan = planTieredRoadMatrix(properties, [{ lat: 34.4, lng: -82.7 }]);

    assert.equal(plan.ok, true, 'a 600-door route must still get a matrix');
    assert.equal(plan.tier, TIER_BLOCK);
    assert.equal(plan.blockCount, 60, 'one block per street');
    assert.equal(plan.matrixPoints.length, 61, '60 representatives + the anchor');
    assert.ok(plan.matrixPoints.length <= MAX_ROUTE_MATRIX_POINTS);
    assert.equal(plan.anchorsIncluded, true, 'anchor legs are priced at block tier');
});

test('TIER-04 the matrix blocks are exactly the blocks the solver reorders', () => {
    const properties = doors(60, 10);
    const plan = planTieredRoadMatrix(properties, []);
    const solverBlocks = buildStreetBlocks(properties);

    assert.equal(plan.blockCount, solverBlocks.length);
    // Every door maps to the same block key the sweep will group it under, so no
    // leg the solver prices BETWEEN blocks can collapse inside a matrix group.
    solverBlocks.forEach((block) => {
        block.doors.forEach((door) => {
            assert.equal(plan.blockKeyByCoordKey.get(coordinateKey(door)), block.key);
        });
    });
    assert.equal(plan.blockKeyByCoordKey.size, properties.length);
});

test('TIER-05 block tier prices between blocks on the road matrix', () => {
    const properties = doors(60, 10);
    const plan = planTieredRoadMatrix(properties, []);
    const { matrix, index } = stubMatrix(plan.matrixPoints);
    const { distanceBetween, intraBlockLegCount, unresolved } = createTieredMatrixMetricFns(matrix, plan);

    const first = properties[0];               // street 0
    const other = properties[properties.length - 1]; // street 59
    const expected = index.get(coordinateKey(plan.representativeByCoordKey.get(coordinateKey(first))))
        * 1000
        + index.get(coordinateKey(plan.representativeByCoordKey.get(coordinateKey(other))));

    assert.equal(distanceBetween(first, other), expected, 'a cross-block leg is a road lookup');
    assert.equal(intraBlockLegCount.count, 0);
    assert.equal(unresolved.count, 0, 'no leg may be unpriceable');
});

test('TIER-06 same-street legs stay aerial and are counted, never silent', () => {
    const properties = doors(60, 10);
    const plan = planTieredRoadMatrix(properties, []);
    const { matrix } = stubMatrix(plan.matrixPoints);
    const { distanceBetween, durationBetween, intraBlockLegCount } = createTieredMatrixMetricFns(matrix, plan);

    const miles = distanceBetween(properties[0], properties[1]);
    assert.ok(miles > 0 && miles < 0.1, `neighbouring doors are a short hop, got ${miles}`);
    assert.equal(intraBlockLegCount.count, 1, 'the approximation is reported, not hidden');

    const minutes = durationBetween(properties[0], properties[1]);
    assert.ok(minutes > 0, 'duration keeps its own units');
    assert.equal(intraBlockLegCount.count, 2);
});

test('TIER-07 anchors are road-priced at block tier, not treated as a block', () => {
    const properties = doors(60, 10);
    const anchor = { lat: 34.4, lng: -82.7 };
    const plan = planTieredRoadMatrix(properties, [anchor]);
    const { matrix, index } = stubMatrix(plan.matrixPoints);
    const { distanceBetween, intraBlockLegCount, unresolved } = createTieredMatrixMetricFns(matrix, plan);

    const representative = plan.representativeByCoordKey.get(coordinateKey(properties[0]));
    assert.equal(
        distanceBetween(anchor, properties[0]),
        index.get(coordinateKey(anchor)) * 1000 + index.get(coordinateKey(representative))
    );
    assert.equal(intraBlockLegCount.count, 0);
    assert.equal(unresolved.count, 0);
});

test('TIER-08 representatives are deterministic across identical plans', () => {
    const properties = doors(60, 10);
    const first = planTieredRoadMatrix(properties, []);
    // A shuffled request must not move the matrix, or the cache key would churn.
    const shuffled = [...properties].reverse();
    const second = planTieredRoadMatrix(shuffled, []);

    assert.deepEqual(
        first.matrixPoints.map(coordinateKey),
        second.matrixPoints.map(coordinateKey)
    );
});

test('TIER-09 a route with too many blocks refuses instead of mispricing', () => {
    // One door per street: blocks == doors, so no block grouping can bound it.
    const plan = planTieredRoadMatrix(doors(400, 1), []);
    assert.equal(plan.ok, false);
    assert.equal(plan.code, 'STREET_BLOCKS_EXCEED_MATRIX_LIMIT');
    assert.equal(plan.blockCount, 400);
});

test('TIER-10 the door ceiling is a refusal, never a silent aerial order', () => {
    const plan = planTieredRoadMatrix(doors(300, 10), []); // 3000 doors
    assert.equal(plan.ok, false);
    assert.equal(plan.code, 'ROUTE_EXCEEDS_TIERED_DOOR_LIMIT');
    assert.equal(plan.limit, MAX_TIERED_ROUTE_DOORS);
});