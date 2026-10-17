import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLocalDrivingCandidates, planLocalDrivingWindows, reviewLocalDrivingNeighborhoods } from '../base44/shared/localDrivingNeighborhoods.js';
import { reviewFinalNeighborhoodRoute } from '../base44/shared/finalNeighborhoodReview.js';
import { mailCarrierPassViolations } from '../base44/shared/mailCarrierRouting.js';

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

const measuredContext = (cost, accessFor = p => p.routing_access || null) => ({
    accessFor, optimizationCostBetween: cost, distanceBetween: (a, b) => cost(a, b) / 1609.344,
    async routeSequence(order) {
        const directedLegs = order.slice(1).map((p, i) => ({ from: order[i].id, to: p.id,
            pathKey: `${order[i].id}>${p.id}`, driveSeconds: cost(order[i], p), distanceMiles: cost(order[i], p) / 1609.344 }));
        return { directedLegs, driveSeconds: directedLegs.reduce((s, leg) => s + leg.driveSeconds, 0),
            distanceMiles: directedLegs.reduce((s, leg) => s + leg.distanceMiles, 0), estimatedTurnarounds: 0 };
    },
});

test('a finite neighborhood budget reaches high-impact detailed work before area and service queues can consume it', async () => {
    const order = Array.from({ length: 96 }, (_, i) => ({ id: `balanced-${i}`, street_name: `Street ${Math.floor(i / 4)}`,
        lat: 35, lng: -81 + Math.floor(i / 12) * 0.01 + [0, 9, 1, 8, 2, 7, 3, 6, 4, 5, 2, 8][i % 12] / 10000 }));
    const contexts = [];
    const result = await reviewLocalDrivingNeighborhoods(order, { mailCarrierMode: true,
        minAreaWindowStops: 20, maxAreaWindowStops: 24, maxLocalWindows: 2, localReviewBudgetMs: 5000,
        createLocalDrivingContext: async (section, config) => {
            if (!config.routeOnly) contexts.push(section);
            return measuredContext(() => 1);
        } });
    assert.equal(result.diagnostics.checked, 2);
    assert.ok(result.diagnostics.planned > result.diagnostics.checked);
    assert.equal(result.diagnostics.budgetExhausted, true);
    assert.ok(contexts.some(section => section.length >= 20), 'a larger area still receives its review');
    assert.ok(contexts.some(section => section.length <= 14), 'a detailed ten-door window receives review within the same finite budget');
    assert.equal(result.properties, order);
});

test('an unavoidable pass violation in fixed boundary stops does not block a verified interior reduction', async () => {
    const positions = [10, 0, 20, 0, 10, 30, 40];
    const order = positions.map((position, i) => ({ id: `boundary-${i}`, street_name: i >= 2 && i <= 4 ? 'Inside Lane' : 'Outside Lane',
        lat: 35, lng: -81 + i / 100000, locked: i < 2 || i > 4,
        routing_access: { confidence: 'high', chainKey: i >= 2 && i <= 4 ? 'inside' : 'outside', side: 'right',
            positionMeters: position, serviceBearing: 90, point: { lat: 35, lng: -81 + i / 100000 } } }));
    const desired = [order[0], order[1], order[3], order[4], order[2], order[5], order[6]];
    const position = new Map(desired.map((p, i) => [p.id, i]));
    const context = measuredContext((a, b) => 1 + Math.abs(position.get(a.id) - position.get(b.id)));
    const measured = [];
    const result = await reviewLocalDrivingNeighborhoods(order, { mailCarrierMode: true, areaDrivingReview: false,
        createLocalDrivingContext: async () => ({ ...context, routeSequence: async path => {
            measured.push(path.map(p => p.id)); return context.routeSequence(path);
        } }) });
    assert.deepEqual(result.properties.map(p => p.id), desired.map(p => p.id));
    assert.equal(result.diagnostics.validation, 'whole_route');
    assert.equal(result.diagnostics.streetSideService.passViolationsBefore, 2);
    assert.equal(result.diagnostics.streetSideService.passViolationsAfter, 1);
    assert.ok(measured.some(path => path.join() === desired.map(p => p.id).join()), 'the reduced-violation candidate must be measured on roads');
    for (const i of [0, 1, 5, 6]) assert.equal(result.properties[i], order[i]);
});

test('an unchanged table winner does not consume the one useful continuous-candidate allowance', async () => {
    const order = ['a', 'b', 'c'].map((id, i) => ({ id, street_name: 'Short Lane', lat: 35, lng: -81 + i / 100000 }));
    const tableCost = (a, b) => ['a>b', 'b>c'].includes(`${a.id}>${b.id}`) ? 1 : 10;
    const tableContext = measuredContext(tableCost);
    const wanted = buildLocalDrivingCandidates(order, tableContext).find(c => c.order.some((p, i) => p !== order[i])).order;
    const calls = [];
    const result = await reviewLocalDrivingNeighborhoods(order, { areaDrivingReview: false, maxLocalCandidates: 1,
        createLocalDrivingContext: async () => ({ ...tableContext, async routeSequence(path) {
            calls.push(path.map(p => p.id));
            return measuredContext(() => path.every((p, i) => p === wanted[i]) ? 1 : 10).routeSequence(path);
        } }) });
    assert.equal(result.diagnostics.candidatesMeasured, 1);
    assert.equal(result.diagnostics.applied, true);
    assert.deepEqual(result.properties, wanted);
    assert.ok(calls.some(path => path.join() === wanted.map(p => p.id).join()));
});

test('one area review repairs the interior of a thirteen-door street run with fixed outer driving legs', async () => {
    const desired = Array.from({ length: 20 }, (_, rank) => ({ id: `long-street-${rank}`, rank,
        lat: 35, lng: -81 + rank / 100000,
        street_name: rank < 2 || rank > 17 ? 'Boundary Road' : rank < 15 ? 'Long Zigzag Lane' : 'Branch Court',
        locked: rank < 2 || rank > 17 }));
    const scrambled = [2, 8, 3, 9, 4, 10, 5, 11, 6, 12, 7, 13, 14].map(rank => desired[rank]);
    const order = [...desired.slice(0, 2), ...scrambled, ...desired.slice(15)];
    const originalIds = order.map(p => p.id);
    const context = measuredContext((a, b) => b.rank === a.rank + 1 ? 1 : 100 + Math.abs(b.rank - a.rank));
    const measured = [];
    const result = await reviewLocalDrivingNeighborhoods(order, { maxLocalWindows: 1, localReviewBudgetMs: 5000,
        createLocalDrivingContext: async () => ({ ...context, async routeSequence(path) {
            measured.push(path.map(p => p.id)); return context.routeSequence(path);
        } }) });
    assert.equal(scrambled.length, 13, 'the street run exceeds the twelve-door exact search cap');
    assert.equal(result.diagnostics.checked, 1);
    assert.equal(result.diagnostics.areaReview.checked, 1);
    assert.equal(result.diagnostics.areaReview.repaired, 1);
    assert.equal(result.diagnostics.validation, 'whole_route');
    assert.equal(result.diagnostics.applied, true);
    assert.deepEqual(result.properties, desired, 'the run must be repaired internally, rather than merely moved as one unit');
    assert.ok(measured.some(path => path.join() === desired.map(p => p.id).join()), 'the exact proposed full drive must be measured');
    assert.ok(result.measurement.driveSeconds < result.baseline.driveSeconds);
    assert.equal(result.measurement.directedLegs.length, order.length - 1);
    assert.deepEqual(new Set(result.properties.map(p => p.id)), new Set(originalIds));
    assert.deepEqual(order.map(p => p.id), originalIds);
    for (const i of [0, 1, 18, 19]) assert.equal(result.properties[i], order[i]);
    assert.deepEqual(result.measurement.directedLegs[0], result.baseline.directedLegs[0]);
    assert.deepEqual(result.measurement.directedLegs.at(-1), result.baseline.directedLegs.at(-1));
});

test('an unmatched full-route pin cannot approve a local repair that adds a known curb-pass violation beyond its context', async () => {
    const order = Array.from({ length: 9 }, (_, i) => ({ id: `distant-curb-${i}`, street_name: 'Context Lane',
        lat: 35, lng: -81 + i / 100000, locked: i < 3 || i > 5 }));
    for (const [index, positionMeters, side] of [[0, 0, 'right'], [3, 10, 'right'], [4, 20, 'left']]) {
        order[index].routing_access = { confidence: 'high', chainKey: 'same-road-outside-context',
            side, positionMeters, serviceBearing: side === 'right' ? 90 : 270,
            point: { lat: order[index].lat, lng: order[index].lng } };
    }
    const desired = [...order]; [desired[3], desired[4]] = [desired[4], desired[3]];
    const preferred = new Set(desired.slice(1).map((p, i) => `${desired[i].id}>${p.id}`));
    const context = measuredContext((a, b) => preferred.has(`${a.id}>${b.id}`) ? 1 : 50);
    assert.equal(mailCarrierPassViolations(order, context), 0);
    assert.equal(mailCarrierPassViolations(desired, context), 1);
    const measured = []; let fullRouteFailures = 0;
    const result = await reviewLocalDrivingNeighborhoods(order, { areaDrivingReview: false, mailCarrierMode: true,
        createLocalDrivingContext: async section => {
            if (section.includes(order[8])) {
                fullRouteFailures++;
                throw new Error('Vehicle routing failed (400: NoSegment). Could not find a matching segment for coordinate 8');
            }
            return { ...context, async routeSequence(path) { measured.push(path); return context.routeSequence(path); } };
        } });
    assert.ok(measured.some(path => path.indexOf(order[4]) < path.indexOf(order[3])), 'the locally faster order must reach continuous road validation');
    assert.ok(fullRouteFailures > 0, 'the full-route match must be unavailable outside the reviewed section');
    assert.equal(result.properties, order);
    assert.equal(result.diagnostics.applied, false);
    assert.equal(result.diagnostics.status, 'whole_route_guard_retained');
    assert.deepEqual(result.properties.map(p => p.id), order.map(p => p.id));
});

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

function unmatchedNeighborhood({ known = false, locked = false, extraFailure = false } = {}) {
    const input = Array.from({ length: extraFailure ? 20 : 12 }, (_, i) => ({
        id: `door-${i}`, street_name: 'Recovery Lane', lat: 35, lng: -81 + i / 100000,
        ...(i === 6 && known ? { routing_access: { resolution_status: 'unresolved' } } : {}),
        ...(i === 6 && locked ? { locked: true } : {}),
    }));
    const failedIds = new Set(extraFailure ? ['door-5', 'door-6'] : ['door-6']);
    const desired = [...input];
    [desired[0], desired[1]] = [desired[1], desired[0]];
    const rightStart = extraFailure ? 10 : 9;
    [desired[rightStart], desired[rightStart + 1]] = [desired[rightStart + 1], desired[rightStart]];
    const preferredEdges = new Set(desired.slice(1).map((p, i) => `${desired[i].id}>${p.id}`));
    const duration = (a, b) => preferredEdges.has(`${a.id}>${b.id}`) ? 1 : 40;
    const attempts = [];
    const createLocalDrivingContext = async (section, config) => {
        const failedIndex = section.findIndex(p => failedIds.has(p.id));
        attempts.push({ ids: section.map(p => p.id), failed: section[failedIndex]?.id,
            wholeRoute: config.sparseCosts === true });
        if (failedIndex >= 0) throw new Error(`Vehicle routing failed (400: NoSegment). Could not find a matching segment for coordinate ${failedIndex}`);
        return {
            optimizationCostBetween: duration, distanceBetween: (a, b) => duration(a, b) / 1000,
            async routeSequence(sequence) {
                const directedLegs = sequence.slice(1).map((p, i) => ({ from: sequence[i].id, to: p.id,
                    pathKey: `${sequence[i].id}>${p.id}`, driveSeconds: duration(sequence[i], p),
                    distanceMiles: duration(sequence[i], p) / 1000 }));
                return { directedLegs, driveSeconds: directedLegs.reduce((s, leg) => s + leg.driveSeconds, 0),
                    distanceMiles: directedLegs.reduce((s, leg) => s + leg.distanceMiles, 0) };
            },
        };
    };
    const options = { areaDrivingReview: false, maxLocalStops: 12, maxLocalWindows: 100,
        localReviewBudgetMs: 10000, createLocalDrivingContext };
    return { input, desired, attempts, failedIds, options };
}

function assertUnknownBoundariesPreserved(result, input, failedIds) {
    assert.deepEqual(result.properties.map(p => p.id).sort(), input.map(p => p.id).sort());
    input.forEach((p, failed) => {
        if (!failedIds.has(p.id)) return;
        for (let i = Math.max(0, failed - 2); i <= Math.min(input.length - 1, failed + 2); i++) {
            assert.equal(result.properties[i], input[i], 'unmatched pins and two neighbors on either side must retain their exact slots');
        }
    });
    assert.ok(result.diagnostics.checked <= result.diagnostics.planned);
    assert.equal(result.diagnostics.budgetExhausted, false);
    assert.equal(result.diagnostics.applied, true);
    assert.equal(result.diagnostics.validation, 'overlapping_boundary_legs');
}

test('a discovered unmatched interior pin does not poison either healthy child window boundary', async () => {
    const { input, desired, attempts, failedIds, options } = unmatchedNeighborhood();
    const result = await reviewLocalDrivingNeighborhoods(input, options);
    assert.deepEqual(result.properties, desired);
    assertUnknownBoundariesPreserved(result, input, failedIds);
    assert.equal(attempts.filter(row => row.failed && !row.wholeRoute).length, 1,
        'overlapping scheduled windows must share the discovered unmatched-pin inventory');
    assert.match(result.diagnostics.wholeRouteUnavailableReason, /NoSegment/);
    assert.equal(result.measurement, undefined, 'verified local savings must not become a fabricated whole-route total');
});

test('an unmatched pin already in a fixed context is trimmed away while both healthy interiors remain searchable', async () => {
    const { input, desired, attempts, failedIds, options } = unmatchedNeighborhood({ locked: true });
    const result = await reviewLocalDrivingNeighborhoods(input, options);
    assert.deepEqual(result.properties, desired);
    assertUnknownBoundariesPreserved(result, input, failedIds);
    assert.equal(attempts.filter(row => row.failed && !row.wholeRoute).length, 1);
});

test('preflight unresolved flags or IDs keep failed pins out of local provider calls and preserve ordinary locks', async () => {
    for (const known of [false, true]) {
        const { input, attempts, failedIds, options } = unmatchedNeighborhood({ known });
        input[10].order_locked = true;
        const result = await reviewLocalDrivingNeighborhoods(input, {
            ...options, ...(known ? {} : { unresolvedStopIds: ['door-6'] }),
        });
        assertUnknownBoundariesPreserved(result, input, failedIds);
        assert.equal(result.properties[10], input[10]);
        assert.equal(attempts.filter(row => row.failed && !row.wholeRoute).length, 0);
        assert.notEqual(result.properties[0], input[0], 'a healthy unlocked interior must still improve');
    }
});

test('adjacent unmatched pins are discovered once each without retry cycles or inflated checked counts', async () => {
    const { input, attempts, failedIds, options } = unmatchedNeighborhood({ extraFailure: true });
    const result = await reviewLocalDrivingNeighborhoods(input, options);
    assertUnknownBoundariesPreserved(result, input, failedIds);
    const failedLocal = attempts.filter(row => row.failed && !row.wholeRoute);
    assert.equal(failedLocal.length, failedIds.size);
    assert.deepEqual(new Set(failedLocal.map(row => row.failed)), failedIds);
    assert.equal(result.diagnostics.checked, result.diagnostics.planned);
});

test('discovery retries an infeasible previously inferred heading before classifying a healthy pin as unmatched', async () => {
    const input = Array.from({ length: 16 }, (_, i) => ({ id: `carrier-${i}`, street_name: 'Carrier Lane',
        lat: 35 + (i === 11 ? 0.0001 : -0.0001), lng: -81 + i / 100000 }));
    const original = JSON.stringify(input), calls = [];
    let rejectedDiscoveryHeadings = 0;
    const vehicleFetch = async value => {
        const url = new URL(value); calls.push(url);
        const coordinates = url.pathname.split('/').at(-1).split(';').map(p => p.split(',').map(Number));
        const bearings = url.searchParams.get('bearings').split(';');
        const failed = bearings.findIndex(Boolean);
        if (url.pathname.includes('/route/') && bearings.includes('') && failed >= 0 && rejectedDiscoveryHeadings === 0) {
            rejectedDiscoveryHeadings++;
            return Response.json({ code: 'NoSegment', message: `Could not find a matching segment for coordinate ${failed}` }, { status: 400 });
        }
        const waypoints = coordinates.map(p => ({ location: [p[0], 35], name: 'Carrier Lane' }));
        if (url.pathname.includes('/table/')) {
            const sources = url.searchParams.get('sources').split(';').map(Number);
            const targets = url.searchParams.get('destinations').split(';').map(Number);
            return Response.json({ code: 'Ok', sources: sources.map(i => waypoints[i]), destinations: targets.map(i => waypoints[i]),
                durations: sources.map(a => targets.map(b => a === b ? 0 : 10)), distances: sources.map(a => targets.map(b => a === b ? 0 : 100)) });
        }
        const legs = coordinates.slice(1).map(() => ({ duration: 10, distance: 100, steps: [{ name: 'Carrier Lane',
            driving_side: 'right', geometry: { coordinates: [[-81.00005, 35], [-80.9998, 35]] } }] }));
        return Response.json({ code: 'Ok', waypoints, routes: [{ duration: legs.length * 10, distance: legs.length * 100,
            geometry: { coordinates: waypoints.map(p => p.location) }, legs }] });
    };
    const result = await reviewLocalDrivingNeighborhoods(input, { mailCarrierMode: true, areaDrivingReview: false,
        maxServiceWindowStops: 10, vehicleBaseUrl: 'https://roads.test', vehicleFetch, localReviewBudgetMs: 10000 });
    assert.equal(rejectedDiscoveryHeadings, 1);
    assert.ok(result.diagnostics.skipped.every(row => !/NoSegment/.test(row.reason)),
        `inferred heading failure must not quarantine the raw pin: ${JSON.stringify(result.diagnostics.skipped)}`);
    assert.equal(result.diagnostics.streetSideService.knownStops, 15);
    assert.equal(result.diagnostics.streetSideService.unknownStops, 1);
    assert.equal(JSON.stringify(input), original);
    assert.ok(calls.every(url => url.searchParams.get('radiuses').split(';').every(radius => ['40', '100'].includes(radius))));
});

test('prefetching later windows changes timing only: same order, same diagnostics, fewer sequential waits', async () => {
    // Four separate twelve-door neighborhoods, each with one profitable swap.
    const input = Array.from({ length: 48 }, (_, i) => ({ id: `door-${i}`, street_name: `Street ${Math.floor(i / 12)}`,
        lat: 35, lng: -81 + Math.floor(i / 12) * 0.02 + (i % 12) / 100000 }));
    const desired = [...input];
    for (let cluster = 0; cluster < 4; cluster++) {
        const at = cluster * 12 + 4;
        [desired[at], desired[at + 1]] = [desired[at + 1], desired[at]];
    }
    const preferred = new Set(desired.slice(1).map((p, i) => `${desired[i].id}>${p.id}`));
    const duration = (a, b) => preferred.has(`${a.id}>${b.id}`) ? 1 : 40;
    const run = async contextLookahead => {
        let inFlight = 0, peak = 0;
        const createLocalDrivingContext = async () => {
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise(resolve => setTimeout(resolve, 5));
            inFlight--;
            return {
                optimizationCostBetween: duration, distanceBetween: (a, b) => duration(a, b) / 1000,
                async routeSequence(sequence) {
                    const directedLegs = sequence.slice(1).map((p, i) => ({ from: sequence[i].id, to: p.id,
                        pathKey: `${sequence[i].id}>${p.id}`, driveSeconds: duration(sequence[i], p),
                        distanceMiles: duration(sequence[i], p) / 1000 }));
                    return { directedLegs, driveSeconds: directedLegs.reduce((s, leg) => s + leg.driveSeconds, 0),
                        distanceMiles: directedLegs.reduce((s, leg) => s + leg.distanceMiles, 0), geometry: [] };
                },
            };
        };
        const result = await reviewLocalDrivingNeighborhoods(input, { areaDrivingReview: false, maxLocalStops: 12,
            maxLocalWindows: 100, localReviewBudgetMs: 30000, createLocalDrivingContext, contextLookahead });
        return { result, peak };
    };
    const sequential = await run(0), prefetched = await run(4);
    assert.deepEqual(prefetched.result.properties.map(p => p.id), sequential.result.properties.map(p => p.id));
    assert.deepEqual(prefetched.result.properties.map(p => p.id), desired.map(p => p.id));
    for (const key of ['planned', 'checked', 'repaired', 'candidatesMeasured', 'localSecondsSaved', 'localMilesSaved', 'skipped']) {
        assert.deepEqual(prefetched.result.diagnostics[key], sequential.result.diagnostics[key], key);
    }
    assert.equal(sequential.peak, 1);
    assert.ok(prefetched.peak > 1, 'later independent neighborhoods are fetched while one is reviewed');
});

test('mail-carrier curb discovery and whole windows run ahead without changing any decision', async () => {
    // Twelve separate four-door neighborhoods, each with one profitable swap.
    const input = Array.from({ length: 48 }, (_, i) => ({ id: `door-${i}`, street_name: `Street ${Math.floor(i / 4)}`,
        lat: 35, lng: -81 + Math.floor(i / 4) * 0.02 + (i % 4) / 100000 }));
    const desired = [...input];
    for (let cluster = 0; cluster < 12; cluster++) {
        const at = cluster * 4 + 1;
        [desired[at], desired[at + 1]] = [desired[at + 1], desired[at]];
    }
    const preferred = new Set(desired.slice(1).map((p, i) => `${desired[i].id}>${p.id}`));
    const duration = (a, b) => preferred.has(`${a.id}>${b.id}`) ? 1 : 40;
    const run = async contextLookahead => {
        let inFlight = 0, peak = 0, discoveries = 0;
        const createLocalDrivingContext = async (_section, config) => {
            if (config.discoverStreetSides) discoveries++;
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise(resolve => setTimeout(resolve, 5));
            inFlight--;
            return {
                optimizationCostBetween: duration, distanceBetween: (a, b) => duration(a, b) / 1000,
                async routeSequence(sequence) {
                    const directedLegs = sequence.slice(1).map((p, i) => ({ from: sequence[i].id, to: p.id,
                        pathKey: `${sequence[i].id}>${p.id}`, driveSeconds: duration(sequence[i], p),
                        distanceMiles: duration(sequence[i], p) / 1000 }));
                    return { directedLegs, driveSeconds: directedLegs.reduce((s, leg) => s + leg.driveSeconds, 0),
                        distanceMiles: directedLegs.reduce((s, leg) => s + leg.distanceMiles, 0), geometry: [],
                        ...(config.discoverStreetSides ? { streetSideEvidence: { waypoints: [], steps: [] } } : {}) };
                },
            };
        };
        // A priority-ordered schedule is scattered along the route, like live
        // ones: consecutive entries are not neighbors.
        const reviewWindows = [0, 6, 2, 8, 4, 10, 1, 7, 3, 9, 5, 11].map((cluster, rank) => ({
            start: cluster * 4, end: cluster * 4 + 4, short: true, priority: 100 - rank }));
        const result = await reviewLocalDrivingNeighborhoods(input, { areaDrivingReview: false, mailCarrierMode: true,
            reviewWindows, maxLocalWindows: 100, localReviewBudgetMs: 30000, createLocalDrivingContext, contextLookahead });
        return { result, peak, discoveries };
    };
    const sequential = await run(0), ahead = await run(8);
    assert.deepEqual(ahead.result.properties.map(p => p.id), sequential.result.properties.map(p => p.id));
    for (const key of ['planned', 'checked', 'repaired', 'candidatesMeasured', 'localSecondsSaved', 'localMilesSaved', 'skipped']) {
        assert.deepEqual(ahead.result.diagnostics[key], sequential.result.diagnostics[key], key);
    }
    assert.equal(ahead.discoveries, sequential.discoveries, 'each section is discovered exactly once either way');
    assert.equal(sequential.peak, 1);
    assert.ok(ahead.peak > 1, 'independent neighborhoods, including their curb discovery, run ahead');
});
