import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDrivingSearchContinuation, verifyCompleteDrivingCandidate } from '../base44/shared/completeDrivingVerification.js';
import { routePropertyOrderFingerprint } from '../base44/shared/routeFingerprint.js';

const original = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, lat: 35 + i / 10000, lng: -81 }));
const incumbent = [original[0], original[2], original[1], original[3]];
const proposal = [original[0], original[2], original[3], original[1]];
const key = order => order.map(p => p.id).join();
function measured(order, bounds, miles, seconds, dataVersion = 'same-graph') {
    const points = [bounds.startLocation, ...order, bounds.endLocation].filter(Boolean);
    const geometry = points.map(p => ({ lat: p.lat, lng: p.lng }));
    const directedLegs = points.slice(1).map((p, i) => ({ from: points[i].id, to: p.id,
        distanceMiles: miles / (points.length - 1), driveSeconds: seconds / (points.length - 1),
        pathKey: `${points[i].id}:${p.id}`, geometry: geometry.slice(i, i + 2) }));
    return { distanceMiles: miles, driveSeconds: seconds, dataVersion, geometry, directedLegs };
}
function provider(costs = [[12, 120], [10, 100], [9, 90]], alter = value => value) {
    const calls = [], contexts = [];
    const values = new Map([original, incumbent, proposal].map((order, i) => [key(order), costs[i]]));
    return { calls, contexts, createDrivingContext: async (order, access, options) => {
        contexts.push({ order, access, options });
        return { routeSequence: async (sequence, bounds) => {
            calls.push(sequence);
            return alter(measured(sequence, bounds, ...values.get(key(sequence))), sequence);
        } };
    } };
}
const run = (options, extras = {}) => verifyDrivingSearchContinuation({ originalOrder: original,
    inputOrder: incumbent, candidateOrder: proposal, options, ...extras });

test('continued search freshly compares the original, incumbent and candidate in one access context', async () => {
    const options = provider(), access = { roadName: 'Test Road', side: 'right' };
    const result = await run(options, { neighborhood: { accessFor: () => access } });
    assert.deepEqual(result.properties, proposal);
    assert.equal(options.contexts.length, 1);
    assert.deepEqual(options.calls, [original, incumbent, proposal]);
    assert.equal(options.contexts[0].access.accessFor(original[0]), access);
    assert.equal(options.contexts[0].options.requireDirectedLegs, true);
    assert.equal(result.comparison.original_miles, 12);
    assert.equal(result.comparison.input_miles, 10);
    assert.equal(result.comparison.output_miles, 9);
    for (const [name, order] of [['original', original], ['input', incumbent], ['output', proposal]]) {
        assert.equal(result.comparison[`${name}_order_fingerprint`], routePropertyOrderFingerprint(order));
    }
    assert.equal(result.diagnostics.local_driving_review.validation, 'whole_route');
});

test('a no-op continuation preserves fresh curb evidence and only measures each unique order once', async () => {
    const options = provider(), access = { side: 'left' };
    const result = await run(options, { candidateOrder: incumbent, neighborhood: { accessFor: () => access } });
    assert.equal(result.applied, false);
    assert.equal(result.keptCurrent, true);
    assert.equal(options.calls.length, 2);
    assert.equal(result.measurement.distanceMiles, 10);
    assert.equal(options.contexts[0].access.accessFor(original[0]), access);
});

for (const [label, costs] of [['miles', [[12, 120], [10, 100], [11, 90]]],
    ['seconds', [[12, 120], [10, 100], [9, 110]]]]) {
    test(`a continuation that worsens incumbent ${label} retains its newly verified order`, async () => {
        const result = await run(provider(costs));
        assert.deepEqual(result.properties, incumbent);
        assert.equal(result.applied, false);
        assert.equal(result.comparison.output_miles, 10);
        assert.equal(result.diagnostics.local_driving_review.repaired, 0);
    });
}

test('the freshly measured original wins when both later orders became worse under current evidence', async () => {
    const result = await run(provider([[8, 80], [10, 100], [9, 90]]));
    assert.deepEqual(result.properties, original);
    assert.equal(result.comparison.output_miles, 8);
    assert.equal(result.comparison.output_order_fingerprint, routePropertyOrderFingerprint(original));
});

test('incomparable distance/time objectives fail closed instead of claiming a false improvement', async () => {
    await assert.rejects(run(provider([[8, 120], [10, 100], [11, 110]])), /cannot retain both/);
});

test('a changed graph during the fresh three-way comparison fails closed', async () => {
    const options = provider(undefined, (value, order) => ({ ...value,
        dataVersion: key(order) === key(proposal) ? 'changed-graph' : 'same-graph' }));
    await assert.rejects(run(options), /graph identity changed/);
});

test('provider failure cannot fabricate a comparison proof', async () => {
    const options = provider(undefined, () => { throw new Error('provider offline'); });
    await assert.rejects(run(options), /provider offline/);
});

test('truncated legs cannot certify a continued search', async () => {
    const options = provider(undefined, value => ({ ...value, directedLegs: value.directedLegs.slice(1) }));
    await assert.rejects(run(options), /incomplete/);
});

for (const [label, candidate] of [['duplicate', [original[0], original[0], original[1], original[2]]],
    ['moved pin', proposal.map((p, i) => i === 1 ? { ...p, lat: p.lat + 1 } : p)]]) {
    test(`invalid ${label} is rejected before provider calls`, async () => {
        const options = provider();
        await assert.rejects(run(options, { candidateOrder: candidate }), /membership|location/);
        assert.equal(options.calls.length, 0);
    });
}

test('continued comparisons preserve locked stops', async () => {
    const order = original.map(p => ({ ...p, order_locked: p.id === 'b' }));
    await assert.rejects(verifyDrivingSearchContinuation({ originalOrder: order, inputOrder: [order[0], order[2], order[1], order[3]],
        candidateOrder: order, options: provider() }), /locked stop/);
});

test('original locked positions survive even if an intermediate caller omits lock flags', async () => {
    const lockedOriginal = original.map(p => ({ ...p, order_locked: p.id === 'b' }));
    const options = provider();
    await assert.rejects(verifyDrivingSearchContinuation({ originalOrder: lockedOriginal, inputOrder: original,
        candidateOrder: proposal, options }), /locked stop/);
    assert.equal(options.calls.length, 0);
});

test('personal bounds are measured but never copied into comparison metadata', async () => {
    const options = { ...provider(), startLocation: { id: 'private-home', lat: 35.987654, lng: -81.123456 } };
    const result = await run(options);
    assert.equal(result.measurement.directedLegs[0].from, 'private-home');
    assert.equal(JSON.stringify(result.comparison).includes('35.987654'), false);
    assert.equal(JSON.stringify(result.comparison).includes('private-home'), false);
});

test('ordinary whole-route no-op verification keeps the local curb evidence', async () => {
    const options = provider(), access = { side: 'right' };
    await verifyCompleteDrivingCandidate({ baselineOrder: incumbent, candidateOrder: incumbent,
        neighborhood: { accessFor: () => access }, options });
    assert.equal(options.contexts[0].access.accessFor(original[0]), access);
});

const curbAccess = stop => ({ confidence: 'high', chainKey: 'test-street',
    side: ['a', 'c'].includes(stop.id) ? 'right' : 'left',
    positionMeters: ['a', 'b'].includes(stop.id) ? 10 : 20,
    point: { lat: stop.lat, lng: stop.lng }, serviceBearing: ['a', 'c'].includes(stop.id) ? 0 : 180 });

test('coherent curb passes can win despite longer driving while reporting the true increased mileage', async () => {
    const options = { ...provider([[8, 80], [10, 100], [12, 120]]), mailCarrierMode: true };
    const result = await run(options, { neighborhood: { accessFor: curbAccess,
        diagnostics: { local_driving_review: { streetSideService: { knownStops: 4 } } } } });
    assert.deepEqual(result.properties, proposal);
    assert.equal(result.comparison.original_pass_violations, 3);
    assert.equal(result.comparison.input_pass_violations, 1);
    assert.equal(result.comparison.output_pass_violations, 0);
    assert.equal(result.comparison.original_miles, 8);
    assert.equal(result.comparison.input_miles, 10);
    assert.equal(result.comparison.output_miles, 12);
    assert.equal(result.diagnostics.local_driving_review.streetSideService.passViolationsAfter, 0);
    assert.equal(options.contexts[0].options.servicePolicy.enabled, false);
    assert.equal(options.contexts[0].options.servicePolicy.parkingSecondsPerStop, 0);
});

test('a cheaper proposal cannot undo the incumbent coherent curb passes', async () => {
    const result = await run({ ...provider([[12, 120], [9, 90], [10, 100]]), mailCarrierMode: true }, {
        inputOrder: proposal, candidateOrder: incumbent, neighborhood: { accessFor: curbAccess },
    });
    assert.deepEqual(result.properties, proposal);
    assert.equal(result.applied, false);
    assert.equal(result.comparison.input_pass_violations, 0);
    assert.equal(result.comparison.output_pass_violations, 0);
    assert.equal(result.comparison.output_miles, 10);
});

test('untrusted curb hints cannot justify increased driving costs', async () => {
    const result = await run({ ...provider([[8, 80], [10, 100], [12, 120]]), mailCarrierMode: true }, {
        neighborhood: { accessFor: stop => ({ ...curbAccess(stop), confidence: 'medium' }),
            diagnostics: { local_driving_review: { streetSideService: { passViolationsBefore: 99, passViolationsAfter: 0 } } } },
    });
    assert.deepEqual(result.properties, original);
    assert.equal(result.comparison.output_miles, 8);
    assert.equal(result.comparison.original_pass_violations, 0);
    assert.equal(result.comparison.input_pass_violations, 0);
    assert.equal(result.diagnostics.local_driving_review.streetSideService.passViolationsAfter, 0);
});

test('equal coherent-pass scores still fail closed when mileage and time are incomparable', async () => {
    await assert.rejects(run({ ...provider([[8, 120], [10, 100], [11, 110]]), mailCarrierMode: true }, {
        neighborhood: { accessFor: stop => ({ ...curbAccess(stop), side: 'right', positionMeters: 10 }) },
    }), /cannot retain both/);
});

test('the new comparison remeasures even when prior neighborhood proof claims an impossible winner', async () => {
    const options = provider([[12, 120], [10, 100], [14, 140]]);
    const result = await run(options, { neighborhood: { properties: proposal,
        measurement: measured(proposal, {}, 1, 1), baseline: measured(incumbent, {}, 100, 1000),
        diagnostics: { applied: true, local_driving_review: { applied: true, validation: 'whole_route', repaired: 5 } } } });
    assert.deepEqual(options.calls, [original, incumbent, proposal]);
    assert.deepEqual(result.properties, incumbent);
    assert.equal(result.comparison.output_miles, 10);
    assert.equal(result.diagnostics.local_driving_review.repaired, 0);
});

test('a missing graph version on only one measurement cannot compare against the known graph', async () => {
    await assert.rejects(run(provider(undefined, (value, order) => key(order) === key(incumbent)
        ? { ...value, dataVersion: null } : value)), /graph identity changed/);
});
