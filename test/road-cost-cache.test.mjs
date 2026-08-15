// Portfolio candidates solve the SAME doors under different groupings, so they ask
// the road engine for mostly the same pairs. Paying for each of them from zero is
// what made four attempts cost four times one. These tests pin the two properties
// the cache must have at once: it removes repeat purchases, and it never changes a
// value — a cached candidate must price identically to a cold one, or the portfolio
// would be selecting on cache artifacts instead of on measured miles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRoadMatrix } from '../base44/shared/roadMatrix.js';
import { createRoadCostCache } from '../base44/shared/roadCostCache.js';

const point = (index) => ({ lat: 35 + index / 1000, lng: -80 - index / 1000 });
const points = (count, offset = 0) => Array.from({ length: count }, (_, index) => point(index + offset));
const METERS_TO_MILES = 0.000621371;

/** Stub OSRM: every cell encodes its own global indexes, so a wrong reuse shows. */
function stubOsrm() {
    const calls = [];
    globalThis.fetch = async (url) => {
        const parsed = new URL(url);
        const coordinates = parsed.pathname.split('/').pop().split(';');
        const sources = parsed.searchParams.get('sources').split(';').map(Number);
        const destinations = parsed.searchParams.get('destinations').split(';').map(Number);
        calls.push({ coordinates: coordinates.length });
        const globalIndex = (position) => Math.round((Number(coordinates[position].split(',')[1]) - 35) * 1000);
        const table = sources.map((source) => destinations.map((destination) => (
            globalIndex(source) * 1000 + globalIndex(destination)
        )));
        return { ok: true, json: async () => ({ code: 'Ok', distances: table, durations: table }) };
    };
    return calls;
}

/** The cell value the stub engine must have produced for this pair, in miles. */
const expectedMiles = (from, to) => (from * 1000 + to) * METERS_TO_MILES;

test('CACHE-01 the same coordinate set is bought once and reused exactly', async () => {
    const calls = stubOsrm();
    const cache = createRoadCostCache({ fetchMatrix: fetchRoadMatrix });
    const set = points(92);

    const cold = await cache.fetchMatrix(set);
    const coldCalls = calls.length;
    const warm = await cache.fetchMatrix(set);

    assert.ok(coldCalls > 0, 'the first ask must reach the engine');
    assert.equal(calls.length, coldCalls, 'the repeat ask must not reach the engine');
    assert.deepEqual(warm.distances, cold.distances);
    assert.deepEqual(warm.durations, cold.durations);
    assert.equal(cache.stats().matrix_memo_hits, 1);
});

test('CACHE-02 a reused matrix is re-indexed onto the caller\'s point order', async () => {
    stubOsrm();
    const cache = createRoadCostCache({ fetchMatrix: fetchRoadMatrix });
    const set = points(46);
    await cache.fetchMatrix(set);

    // Same SET, different order — the memo may only be served after permuting it,
    // otherwise every lookup would silently price the wrong pair of houses.
    const shuffled = [...set].reverse();
    const reused = await cache.fetchMatrix(shuffled);
    assert.equal(cache.stats().matrix_memo_hits, 1);
    [[0, 1], [3, 45], [45, 0], [20, 20]].forEach(([row, column]) => {
        const from = 45 - row;
        const to = 45 - column;
        assert.ok(
            Math.abs(reused.distances[row][column] - expectedMiles(from, to)) < 1e-9,
            `reused cell ${row},${column} priced the wrong pair`
        );
    });
});

test('CACHE-03 a block whose pairs are all known is answered without an engine call', async () => {
    const calls = stubOsrm();
    const cache = createRoadCostCache({ fetchMatrix: fetchRoadMatrix });

    await cache.fetchMatrix(points(46));
    const afterFirst = calls.length;
    assert.equal(afterFirst, 1);

    // A superset: 4 blocks, of which the first is exactly the block already bought.
    const wider = await cache.fetchMatrix(points(92));
    assert.equal(calls.length - afterFirst, 3, 'only the genuinely new blocks may be fetched');
    assert.equal(wider.cachedBlocks, 1);

    // Exactness across the seam between a cached block and a fetched one.
    [[0, 0], [0, 45], [45, 45], [0, 91], [91, 0], [45, 46], [91, 91]].forEach(([from, to]) => {
        assert.ok(
            Math.abs(wider.distances[from][to] - expectedMiles(from, to)) < 1e-9,
            `cell ${from},${to} was not the value the engine returned`
        );
    });

    const stats = cache.stats();
    assert.ok(stats.pairs_served_from_cache > 0);
    assert.ok(stats.pair_cache_hit_rate_pct > 0);
    assert.equal(stats.blocks_avoided_by_reuse, 1);
});

test('CACHE-04 an identical final order is measured once, and a failure is never remembered', async () => {
    stubOsrm();
    let measureCalls = 0;
    let failNext = true;
    const cache = createRoadCostCache({
        fetchMatrix: fetchRoadMatrix,
        measurePath: async () => {
            measureCalls += 1;
            if (failNext) {
                failNext = false;
                return { ok: false, error: 'engine_unavailable' };
            }
            return { ok: true, totalMiles: 12.5 };
        }
    });

    const order = points(5);
    const failed = await cache.measurePath(order);
    assert.equal(failed.ok, false);
    const retried = await cache.measurePath(order);
    assert.equal(retried.ok, true, 'a transient failure must be retryable, not memoized');
    assert.equal(measureCalls, 2);

    const memoized = await cache.measurePath(order);
    assert.equal(memoized.totalMiles, 12.5);
    assert.equal(measureCalls, 2, 'a verified order must not be re-measured');

    // The order, not the set, decides the miles — a reversed order is a new ask.
    await cache.measurePath([...order].reverse());
    assert.equal(measureCalls, 3);
});

// A road network is not symmetric: one-way streets, divided roads, turn
// restrictions and ramps all make A->B cost differently from B->A. A cache that
// canonicalized the pair would hand the optimizer a cheaper reverse leg than the
// engine ever quoted, and the route would be "verified" against a cost that does
// not exist on the ground.
test('CACHE-06 A->B and B->A are cached and served as separate directed costs', async () => {
    // One-way stub: travelling up-index is cheap, travelling down-index is dear.
    const calls = [];
    globalThis.fetch = async (url) => {
        const parsed = new URL(url);
        const coordinates = parsed.pathname.split('/').pop().split(';');
        const sources = parsed.searchParams.get('sources').split(';').map(Number);
        const destinations = parsed.searchParams.get('destinations').split(';').map(Number);
        calls.push(1);
        const globalIndex = (position) => Math.round((Number(coordinates[position].split(',')[1]) - 35) * 1000);
        const meters = (from, to) => (from === to ? 0 : (from < to ? 100 : 900));
        const distances = sources.map((s) => destinations.map((d) => meters(globalIndex(s), globalIndex(d))));
        const durations = sources.map((s) => destinations.map((d) => meters(globalIndex(s), globalIndex(d)) / 10));
        return { ok: true, json: async () => ({ code: 'Ok', distances, durations }) };
    };

    const cache = createRoadCostCache({ fetchMatrix: fetchRoadMatrix });
    const cold = await cache.fetchMatrix(points(46));
    const coldCalls = calls.length;

    // Served from the pair store on the next, wider ask — the asymmetry must survive.
    const warm = await cache.fetchMatrix(points(92));
    assert.ok(cache.stats().pairs_served_from_cache > 0, 'the directed pairs must have been reused');

    [cold, warm].forEach((matrix, index) => {
        const label = index === 0 ? 'fetched' : 'cache-served';
        assert.ok(Math.abs(matrix.distances[3][20] - 100 * METERS_TO_MILES) < 1e-9, `${label} forward cost changed`);
        assert.ok(Math.abs(matrix.distances[20][3] - 900 * METERS_TO_MILES) < 1e-9, `${label} reverse cost changed`);
        assert.notEqual(matrix.distances[3][20], matrix.distances[20][3], `${label} matrix was symmetrized`);
        assert.ok(Math.abs(matrix.durations[3][20] - 10 / 60) < 1e-9, `${label} forward duration changed`);
        assert.ok(Math.abs(matrix.durations[20][3] - 90 / 60) < 1e-9, `${label} reverse duration changed`);
    });
    assert.ok(coldCalls > 0);
});

// Two doors can legitimately snap to one coordinate (duplex halves, a corrected
// geocode, a shared driveway). The set key must therefore behave as a MULTISET,
// and the permutation back to caller order must return every row and column to the
// coordinate it actually belongs to.
test('CACHE-07 duplicate coordinates keep their identity through memo reuse', async () => {
    const calls = stubOsrm();
    const cache = createRoadCostCache({ fetchMatrix: fetchRoadMatrix });

    // point(1) appears twice, as two distinct objects at one coordinate.
    const withDuplicate = [point(0), point(1), { ...point(1) }, point(2), point(3)];
    await cache.fetchMatrix(withDuplicate);
    const afterFirst = calls.length;

    // A set that only DROPS the duplicate is a different question, not a hit.
    await cache.fetchMatrix([point(0), point(1), point(2), point(3)]);
    // It must miss the MATRIX memo (its pairs are all known, so the pair store
    // answers it — that is reuse of the same directed pairs, not of a matrix whose
    // shape does not match).
    assert.equal(cache.stats().matrix_memo_hits, 0, 'a smaller multiset must not hit the matrix memo');

    // The same multiset in a different caller order must reuse and re-index.
    const reordered = [point(3), { ...point(1) }, point(0), point(1), point(2)];
    const reused = await cache.fetchMatrix(reordered);
    assert.equal(cache.stats().matrix_memo_hits, 1);
    assert.equal(calls.length, afterFirst, 'a memo reuse must not reach the engine');

    // Every cell must equal the engine value for the coordinates at those caller
    // positions — including both copies of the duplicate, in both directions.
    const index = [3, 1, 0, 1, 2];
    for (let row = 0; row < reordered.length; row += 1) {
        for (let column = 0; column < reordered.length; column += 1) {
            assert.ok(
                Math.abs(reused.distances[row][column] - expectedMiles(index[row], index[column])) < 1e-9,
                `reindexed cell ${row},${column} lost its coordinate identity`
            );
        }
    }
});

// A hit must mean "exactly this road-cost question was already asked". Anything
// that can change road truth — profile, engine endpoint, annotation mode — has to
// be part of the identity, or a technically valid hit answers a different question.
test('CACHE-08 cache identity covers profile, engine endpoint and annotation mode', async () => {
    const calls = stubOsrm();
    const cache = createRoadCostCache({ fetchMatrix: fetchRoadMatrix });
    const set = points(46);

    await cache.fetchMatrix(set, { profile: 'driving' });
    assert.equal(calls.length, 1);

    await cache.fetchMatrix(set, { profile: 'walking' });
    assert.equal(calls.length, 2, 'a different profile is a different question');

    await cache.fetchMatrix(set, { profile: 'driving', baseUrl: 'https://osrm.internal.example' });
    assert.equal(calls.length, 3, 'a different engine endpoint is a different question');

    await cache.fetchMatrix(set, { profile: 'driving', annotations: 'duration' });
    assert.equal(calls.length, 4, 'a different annotation mode is a different question');

    // The original question is still a hit, so identity is precise, not just strict.
    await cache.fetchMatrix(set, { profile: 'driving' });
    assert.equal(calls.length, 4);
    assert.equal(cache.stats().matrix_memo_hits, 1);

    // Measured paths carry the same identity.
    let measured = 0;
    const measuring = createRoadCostCache({
        fetchMatrix: fetchRoadMatrix,
        measurePath: async () => ({ ok: true, totalMiles: (measured += 1) })
    });
    await measuring.measurePath(points(4), { profile: 'driving' });
    await measuring.measurePath(points(4), { profile: 'walking' });
    await measuring.measurePath(points(4), { profile: 'driving' });
    assert.equal(measured, 2, 'profile must separate measured paths');
    assert.equal(measuring.stats().measure_memo_hits, 1);

    // The stored shape is versioned, so old entries can never be served to new
    // key semantics after a schema change.
    const stats = cache.stats();
    assert.ok(stats.cache_schema, 'the cache must report its schema version');
    assert.ok(stats.road_matrix_version, 'the cache must report the engine/matrix version');
});

test('CACHE-05 at the pair ceiling the cache stops storing and keeps returning engine truth', async () => {
    const calls = stubOsrm();
    const cache = createRoadCostCache({ fetchMatrix: fetchRoadMatrix, maxPairs: 10 });

    await cache.fetchMatrix(points(46));
    const afterFirst = calls.length;
    const second = await cache.fetchMatrix(points(46, 46));

    const stats = cache.stats();
    assert.ok(stats.pair_stores_skipped_at_ceiling > 0, 'the ceiling must be reported, not silent');
    assert.ok(stats.pair_cache_at_ceiling);
    assert.equal(calls.length - afterFirst, 1, 'an uncached block is still fetched');
    assert.ok(Math.abs(second.distances[0][0] - expectedMiles(46, 46)) < 1e-9);
});