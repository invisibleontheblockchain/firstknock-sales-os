// A route bigger than one OSRM request must still get ONE complete matrix.
//
// The Anderson audit found a 183-door route that skipped OSRM entirely because
// the matrix layer refused anything over 100 coordinates — so no candidate was
// road-priced, the previous order never competed, and a 449.0-minute route was
// replaced by a 454.6-minute one. These tests pin the chunk assembly, the index
// mapping, and the refusal to ever hand back a partial matrix.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    fetchRoadMatrix,
    MATRIX_CHUNK_SIZE,
    MAX_MATRIX_COORDINATES,
    MAX_ROUTE_MATRIX_POINTS
} from '../base44/shared/roadMatrix.js';

const points = (count) => Array.from({ length: count }, (_, index) => ({
    lat: 35 + index / 1000,
    lng: -80 - index / 1000
}));

/**
 * Stub OSRM. Every cell encodes its own global source/destination indexes, so a
 * mis-assembled block cannot pass: meters = source * 1000 + destination.
 */
function stubOsrm({ holeAt = null, shapeBreak = false } = {}) {
    const calls = [];
    globalThis.fetch = async (url) => {
        const parsed = new URL(url);
        const coordinates = parsed.pathname.split('/').pop().split(';');
        const sources = parsed.searchParams.get('sources').split(';').map(Number);
        const destinations = parsed.searchParams.get('destinations').split(';').map(Number);
        calls.push({ coordinates: coordinates.length, sources: sources.length, destinations: destinations.length });
        // Recover the global index from the coordinate itself, the same way the
        // caller must: request position -> coordinate -> canonical index.
        const globalIndex = (position) => Math.round((Number(coordinates[position].split(',')[1]) - 35) * 1000);
        const table = sources.map((source) => destinations.map((destination) => {
            const from = globalIndex(source);
            const to = globalIndex(destination);
            if (holeAt && holeAt.from === from && holeAt.to === to) return null;
            return from * 1000 + to;
        }));
        if (shapeBreak) table.pop();
        return {
            ok: true,
            json: async () => ({ code: 'Ok', distances: table, durations: table })
        };
    };
    return calls;
}

test('MTX-01 a 183-door route assembles one complete matrix from 16 blocks', async () => {
    const calls = stubOsrm();
    const matrix = await fetchRoadMatrix(points(183));

    assert.equal(matrix.pointCount, 183);
    assert.equal(matrix.blocks, 16);
    assert.equal(calls.length, 16);
    assert.equal(matrix.distances.length, 183);
    assert.ok(matrix.distances.every((row) => row.length === 183));
    assert.ok(matrix.durations.every((row) => row.length === 183));
    assert.ok(calls.every((call) => call.coordinates <= MAX_MATRIX_COORDINATES));
    assert.equal(matrix.snapped, 183);
});

test('MTX-02 every cell lands on its canonical source and destination index', async () => {
    stubOsrm();
    const matrix = await fetchRoadMatrix(points(183));
    const metersToMiles = 0.000621371;

    // Cells from the far corners of the block grid, where a transposed or
    // offset block would be invisible in aggregate totals.
    [[0, 0], [0, 182], [182, 0], [182, 182], [45, 46], [46, 45], [91, 137]].forEach(([from, to]) => {
        assert.equal(
            Math.round(matrix.distances[from][to] / metersToMiles),
            from * 1000 + to,
            `cell ${from},${to} came from the wrong block`
        );
    });
});

test('MTX-03 a route inside one request still uses a single block', async () => {
    const calls = stubOsrm();
    const matrix = await fetchRoadMatrix(points(MATRIX_CHUNK_SIZE));
    assert.equal(matrix.blocks, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].coordinates, MATRIX_CHUNK_SIZE);
});

test('MTX-04 an unresolved cell fails the whole matrix instead of returning a hole', async () => {
    stubOsrm({ holeAt: { from: 7, to: 120 } });
    await assert.rejects(fetchRoadMatrix(points(183)), /incomplete: 1 unresolved cells/);
});

test('MTX-05 a block whose shape does not match its request is rejected', async () => {
    stubOsrm({ shapeBreak: true });
    await assert.rejects(fetchRoadMatrix(points(183)), /did not match its requested source\/destination shape/);
});

// A window can decompose onto a boundary that leaves ONE coordinate in a chunk.
// OSRM rejects a one-coordinate table outright (400, invalid options), which
// killed optimization for every route that happened to cut that way. A single
// point is trivially zero cost from itself, so it must be answered locally.
test('MTX-07 a single-point matrix is answered locally instead of calling the road service', async () => {
    const calls = stubOsrm();
    const matrix = await fetchRoadMatrix(points(1));
    assert.equal(calls.length, 0, 'a one-point matrix must not hit the road service');
    assert.equal(matrix.pointCount, 1);
    assert.deepEqual(matrix.distances, [[0]]);
    assert.deepEqual(matrix.durations, [[0]]);
});

test('MTX-06 the product size limit is stated in route terms, not request terms', async () => {
    stubOsrm();
    assert.ok(MAX_ROUTE_MATRIX_POINTS > MAX_MATRIX_COORDINATES);
    await assert.rejects(
        fetchRoadMatrix(points(MAX_ROUTE_MATRIX_POINTS + 1)),
        new RegExp(`limit is ${MAX_ROUTE_MATRIX_POINTS} coordinates per route`)
    );
});