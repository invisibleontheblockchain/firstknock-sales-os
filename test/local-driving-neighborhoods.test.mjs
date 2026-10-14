import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLocalDrivingCandidates, planLocalDrivingWindows, reviewLocalDrivingNeighborhoods } from '../base44/shared/localDrivingNeighborhoods.js';
import { reviewFinalNeighborhoodRoute } from '../base44/shared/finalNeighborhoodReview.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/troutman-neighborhood-311-317.json', import.meta.url), 'utf8'));
const points = fixture.properties, stops = points.slice(1, -1);
const desired = fixture.desiredOrder;
const bounds = { startLocation: points[0], endLocation: points.at(-1) };
const matching = sequence => fixture.measurements.find(row => row.order.join(',') === sequence.filter(p => p.stop !== 310 && p.stop !== 318).map(p => p.stop).join(','));
const frozenContext = options => {
    const index = p => points.findIndex(q => q.address_hash === p.address_hash);
    return {
        accessFor: p => p.routing_access,
        optimizationCostBetween: (a, b) => fixture.matrix.durations[index(a)][index(b)],
        distanceBetween: (a, b) => fixture.matrix.distances[index(a)][index(b)] / 1609.344,
        async routeSequence(sequence, suppliedBounds = {}) {
            const path = [suppliedBounds.startLocation, ...sequence, suppliedBounds.endLocation].filter(Boolean);
            const recorded = matching(path) || fixture.measurements[0];
            const changed = sequence.some((p, i) => p.stop !== stops[i]?.stop);
            const driveSeconds = options?.slower && recorded.order.join(',') === desired.join(',') ? 900 : recorded.seconds;
            const distanceMiles = options?.slower && recorded.order.join(',') === desired.join(',') ? 4 : recorded.miles;
            const legs = path.slice(1).map((p, i) => ({ from: path[i].address_hash, to: p.address_hash,
                pathKey: `${path[i].address_hash}->${p.address_hash}`, driveSeconds: 1, distanceMiles: 0.01 }));
            if (options?.wholeRouteWorse && sequence.length === 7 && changed) return { driveSeconds: 999, distanceMiles: 9, directedLegs: legs };
            return { driveSeconds, distanceMiles, directedLegs: legs, estimatedTurnarounds: recorded.uturns,
                geometry: path.map(p => ({ lat: p.lat, lng: p.lng })) };
        },
    };
};
const create = options => async () => frozenContext(options);

test('Troutman exact local search discovers the entrance/branch/return order without street atomicity', () => {
    const context = frozenContext();
    for (const input of [stops, [...stops].reverse(), [stops[3], ...stops.slice(0, 3), ...stops.slice(4)]]) {
        const candidates = buildLocalDrivingCandidates(input, context, points[0], points.at(-1));
        assert.deepEqual(candidates[0].order.map(p => p.stop), desired);
        assert.equal(candidates[0].seconds, 371.5);
        assert.deepEqual(new Set(candidates[0].order), new Set(stops));
    }
});

test('the real neighborhood remains searchable when it straddles a ten-stop chunk boundary', () => {
    const context = fixture.windowBoundaryProperties;
    const first = context.findIndex(p => p.stop === 311), last = context.findIndex(p => p.stop === 317);
    const windows = planLocalDrivingWindows(context);
    assert.ok(windows.some(w => w.start <= first && w.end > last));
    assert.ok(windows.every(w => w.end - w.start <= 10));
});

test('trusted road sides prefer outbound service and return service without guessing from parity', () => {
    const supplied = stops.map(p => p.street_name !== 'Crooked Branch Way' ? p : { ...p, routing_access: {
        confidence: 'high', chainKey: 'crooked-road-chain', side: p.stop === 316 ? 'left' : 'right',
        positionMeters: ({ 317: 0, 316: 31, 315: 106, 314: 172 })[p.stop],
    } });
    const context = frozenContext();
    const best = buildLocalDrivingCandidates(supplied, context, points[0], points.at(-1))[0];
    assert.deepEqual(best.order.map(p => p.stop), desired);
    assert.equal(best.crossings, 1); assert.equal(best.passovers, 0);
    const unknown = buildLocalDrivingCandidates(stops, context, points[0], points.at(-1))[0];
    assert.equal(unknown.crossings, 0, 'unknown sides must not fabricate crossing evidence');
});

test('final review runs even without a repeated street/neighborhood label and verifies the continuous trip', async () => {
    const result = await reviewFinalNeighborhoodRoute(stops, { ...bounds, localDrivingReview: true,
        baselineOrder: stops, createLocalDrivingContext: create() });
    assert.equal(result.diagnostics.detected, 0);
    assert.equal(result.diagnostics.applied, true);
    assert.deepEqual(result.properties.map(p => p.stop), desired);
    assert.equal(result.diagnostics.local_driving_review.validation, 'whole_route');
    assert.equal(result.measurement.driveSeconds, 562.5);
    assert.equal(result.baseline.driveSeconds, 821);
    assert.ok(Math.abs(result.diagnostics.local_driving_review.localMilesSaved - 1.298665791776028) < 1e-6);
});

test('a pairwise improvement cannot replace the route when the continuous drive is worse', async () => {
    const result = await reviewLocalDrivingNeighborhoods(stops, { ...bounds, createLocalDrivingContext: create({ slower: true }) });
    assert.equal(result.properties, stops); assert.equal(result.diagnostics.applied, false);
});

test('the independent whole-trip check retains the incumbent when a proposed splice changes turn continuity', async () => {
    const result = await reviewLocalDrivingNeighborhoods(stops, { ...bounds, createLocalDrivingContext: create({ wholeRouteWorse: true }) });
    assert.equal(result.properties, stops);
    assert.equal(result.diagnostics.status, 'whole_route_guard_retained');
    assert.equal(result.diagnostics.applied, false);
});

test('changed arrival geometry on an overlapping boundary leg refuses the local splice', async () => {
    const outerLeft = { ...points[0], stop: 300, address_hash: 'outer-left', locked: true };
    const outerRight = { ...points.at(-1), stop: 320, address_hash: 'outer-right', locked: true };
    const input = [outerLeft, { ...points[0], locked: true }, ...stops, { ...points.at(-1), locked: true }, outerRight];
    const result = await reviewLocalDrivingNeighborhoods(input, {
        createLocalDrivingContext: async () => ({ ...frozenContext(), async routeSequence(path) {
            const service = path.filter(p => p.stop >= 311 && p.stop <= 317);
            const recorded = matching(service) || fixture.measurements[0];
            const changed = service.map(p => p.stop).join(',') !== stops.map(p => p.stop).join(',');
            const legs = path.slice(1).map((p, i) => ({ from: path[i].address_hash, to: p.address_hash,
                pathKey: `${i === 0 && changed ? 'different-arrival-road:' : ''}${path[i].address_hash}->${p.address_hash}`,
                driveSeconds: 1, distanceMiles: 0.01 }));
            return { driveSeconds: recorded.seconds, distanceMiles: recorded.miles,
                estimatedTurnarounds: recorded.uturns, directedLegs: legs };
        } }),
    });
    assert.equal(result.properties, input); assert.equal(result.diagnostics.applied, false);
});

test('repeating the review preserves a route already using the verified service tour', async () => {
    const input = desired.map(n => stops.find(p => p.stop === n));
    const result = await reviewLocalDrivingNeighborhoods(input, { ...bounds, createLocalDrivingContext: create() });
    assert.equal(result.properties, input); assert.equal(result.diagnostics.repaired, 0);
});

test('locks and unresolved stops keep their exact slots; a zero window budget makes no changes', async () => {
    for (const flag of [{ locked: true }, { order_locked: true }, { routing_access: { resolution_status: 'unresolved' } }]) {
        const input = stops.map((p, i) => i === 3 ? { ...p, ...flag } : p);
        const windows = planLocalDrivingWindows(input);
        assert.ok(windows.every(w => w.end <= 3 || w.start > 3));
        const result = await reviewLocalDrivingNeighborhoods(input, { ...bounds, createLocalDrivingContext: create() });
        assert.equal(result.properties[3], input[3]);
    }
    const exhausted = await reviewLocalDrivingNeighborhoods(stops, { ...bounds, maxLocalWindows: 0,
        createLocalDrivingContext: async () => { throw new Error('should not fetch'); } });
    assert.equal(exhausted.properties, stops); assert.equal(exhausted.diagnostics.budgetExhausted, true);
    await assert.rejects(reviewLocalDrivingNeighborhoods([...stops, stops[0]]), /membership/);
    await assert.rejects(reviewLocalDrivingNeighborhoods(stops, { lockedStopIds: ['missing'] }), /Locked stop/);
});

test('NoSegment in another neighborhood does not disable valid local repair or fabricate a full-route total', async () => {
    const other = Array.from({ length: 5 }, (_, i) => ({ stop: 100 + i, address_hash: `other-${i}`,
        street_name: `Other ${i}`, lat: 36 + i, lng: -81 }));
    const tail = Array.from({ length: 2 }, (_, i) => ({ stop: 200 + i, address_hash: `tail-${i}`,
        street_name: 'Tail', lat: 39 + i, lng: -81 }));
    const input = [...other, ...stops, ...tail];
    const context = async section => {
        if (section.some(p => p.address_hash === 'other-0')) throw new Error('Vehicle routing failed (400: NoSegment). Could not find a matching segment for coordinate 0');
        const base = frozenContext();
        const resolve = p => p.stop === 104 ? points[0] : p.stop === 200 ? points.at(-1) : p;
        return { ...base,
            optimizationCostBetween: (a, b) => base.optimizationCostBetween(resolve(a), resolve(b)),
            distanceBetween: (a, b) => base.distanceBetween(resolve(a), resolve(b)),
            async routeSequence(path) {
                const service = path.filter(p => p.stop >= 311 && p.stop <= 317);
                const recorded = matching(service) || fixture.measurements[0];
                return { driveSeconds: recorded.seconds, distanceMiles: recorded.miles, estimatedTurnarounds: recorded.uturns,
                    directedLegs: path.slice(1).map((p, i) => ({ from: path[i].address_hash, to: p.address_hash,
                        pathKey: `${path[i].address_hash}->${p.address_hash}`, driveSeconds: 1, distanceMiles: 1 })),
                    geometry: path.map(p => ({ lat: p.lat, lng: p.lng })) };
            },
        };
    };
    const result = await reviewLocalDrivingNeighborhoods(input, { createLocalDrivingContext: context });
    assert.deepEqual(result.properties.slice(5, 12).map(p => p.stop), desired);
    assert.equal(result.properties[0], input[0]);
    assert.equal(result.diagnostics.applied, true);
    assert.equal(result.diagnostics.validation, 'overlapping_boundary_legs');
    assert.match(result.diagnostics.wholeRouteUnavailableReason, /NoSegment/);
    assert.equal(result.measurement, undefined);
});

test('new generation and Optimize both reach the same enabled driving review', () => {
    const backend = fs.readFileSync(new URL('../base44/functions/optimizeRouteRoadMatrix/entry.ts', import.meta.url), 'utf8');
    const generation = fs.readFileSync(new URL('../src/lib/roadMatrixRouteGeneration.js', import.meta.url), 'utf8');
    const optimize = fs.readFileSync(new URL('../src/lib/roadMatrixOptimize.js', import.meta.url), 'utf8');
    assert.match(backend, /localDrivingReview: profile === 'driving'/);
    assert.match(generation, /tryRoadMatrixOptimize/); assert.match(optimize, /invoke\('optimizeRouteRoadMatrix'/);
});
