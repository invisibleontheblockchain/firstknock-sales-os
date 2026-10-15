import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewLocalDrivingNeighborhoods } from '../base44/shared/localDrivingNeighborhoods.js';

function fixture(mode = 'normal') {
    const positions = [0, 0.1, 3, 2.5, 1, 4, 4.5, 20, 20.1, 23, 22.5, 21, 24, 24.5];
    const order = positions.map((position, i) => ({ id: `cleanup-${i}`, street_name: 'Branch Lane', lat: 35 + position / 1000, lng: -81 }));
    const major = [...order]; major.splice(2, 3, order[4], order[3], order[2]);
    const desired = [...major]; desired.splice(9, 3, order[11], order[10], order[9]);
    const edges = new Set(desired.slice(1).map((p, i) => `${desired[i].id}>${p.id}`));
    const cost = (a, b) => edges.has(`${a.id}>${b.id}`) ? 1 : 50;
    const known = new Map(), calls = [];
    const createLocalDrivingContext = async (section, config) => {
        const cleanup = config.inferStreetSides === false;
        calls.push({ section, config, cleanup });
        if (cleanup && mode === 'unavailable') throw new Error('Road provider unavailable.');
        if (cleanup && mode === 'fatal_graph') throw new Error('Road graph identity changed.');
        if (cleanup && mode === 'fatal_membership') throw new Error('Driving membership changed.');
        if (cleanup && mode === 'fatal_abort') throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        return { accessFor: p => p.routing_access || known.get(p.id), optimizationCostBetween: cost,
            distanceBetween: (a, b) => cost(a, b) / 1609.344,
            async routeSequence(sequence) {
                const whole = sequence.length === order.length;
                const secondRepaired = sequence.indexOf(order[11]) < sequence.indexOf(order[9]);
                const firstRepaired = sequence.indexOf(order[4]) < sequence.indexOf(order[2]);
                if (cleanup && whole && mode === 'partial_proof') throw new Error('NoSegment: no road match for coordinate 13');
                const extra = mode === 'major_pass_tradeoff' && firstRepaired ? 400
                    : mode === 'cleanup_pass_tradeoff' && cleanup && secondRepaired ? 400
                    : mode === 'major_worse' && !cleanup && whole && firstRepaired ? 500
                    : cleanup && whole && mode === 'worse' && secondRepaired ? 500
                    : cleanup && whole && mode === 'changed_cost_question' ? 20 : 0;
                const extraLeg = mode === 'major_pass_tradeoff' ? sequence.indexOf(order[4])
                    : mode === 'cleanup_pass_tradeoff' ? sequence.indexOf(order[11]) : 0;
                const directedLegs = sequence.slice(1).map((p, i) => ({ from: sequence[i].id, to: p.id,
                    pathKey: `${sequence[i].id}>${p.id}`, driveSeconds: cost(sequence[i], p) + (i === extraLeg ? extra : 0),
                    distanceMiles: (cost(sequence[i], p) + (i === extraLeg ? extra : 0)) / 1609.344 }));
                return { directedLegs, driveSeconds: directedLegs.reduce((sum, leg) => sum + leg.driveSeconds, 0),
                    distanceMiles: directedLegs.reduce((sum, leg) => sum + leg.distanceMiles, 0),
                    dataVersion: cleanup && mode === 'changed_version' ? 'roads-v2' : 'roads-v1', estimatedTurnarounds: 0,
                    geometry: sequence.map(p => ({ lat: p.lat, lng: p.lng })) };
            } };
    };
    const options = { reviewWindows: [{ start: 2, end: 5, local: true }], maxLocalWindows: 1,
        areaDrivingReview: false, maxShortWindows: 1, shortCleanupBudgetMs: 1000,
        createLocalDrivingContext, knownDrivingAccessFor: p => known.get(p.id) };
    return { order, major, desired, options, calls, known };
}

test('the cleanup flag leaves the existing major-only behavior unchanged by default', async () => {
    const f = fixture();
    const result = await reviewLocalDrivingNeighborhoods(f.order, f.options);
    assert.deepEqual(result.properties, f.major);
    assert.equal(result.diagnostics.shortCleanup, undefined);
    assert.equal(f.calls.some(call => call.cleanup), false);
    assert.equal(result.diagnostics.validation, 'whole_route');
});

test('a fresh short branch cleanup retains the accepted major repair and verifies the complete final route', async () => {
    const f = fixture(), original = JSON.stringify(f.order);
    const result = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, shortDrivingCleanup: true });
    assert.deepEqual(result.properties, f.desired);
    assert.equal(result.diagnostics.shortCleanup.applied, true);
    assert.equal(result.diagnostics.validation, 'whole_route');
    assert.equal(result.diagnostics.repaired, 2);
    assert.equal(result.diagnostics.checked, 2);
    assert.equal(result.diagnostics.areaReview.repaired, 0);
    assert.equal(result.measurement.directedLegs.length, f.order.length - 1);
    assert.equal(result.diagnostics.localMilesSaved, result.baseline.distanceMiles - result.measurement.distanceMiles);
    assert.equal(result.diagnostics.localSecondsSaved, result.baseline.driveSeconds - result.measurement.driveSeconds);
    assert.ok(result.measurement.driveSeconds < result.previousMeasurement.driveSeconds);
    assert.deepEqual(new Set(result.properties), new Set(f.order));
    assert.equal(JSON.stringify(f.order), original);
});

for (const mode of ['unavailable', 'partial_proof', 'worse', 'changed_cost_question', 'changed_version']) {
    test(`an accepted major order and its full proof survive optional cleanup ${mode}`, async () => {
        const expected = fixture(mode);
        const major = await reviewLocalDrivingNeighborhoods(expected.order, expected.options);
        const f = fixture(mode);
        const result = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, shortDrivingCleanup: true });
        assert.deepEqual(result.properties.map(p => p.id), f.major.map(p => p.id));
        assert.deepEqual(result.measurement, major.measurement);
        assert.deepEqual(result.baseline, major.baseline);
        assert.equal(result.diagnostics.applied, true);
        assert.equal(result.diagnostics.repaired, 1);
        assert.equal(result.diagnostics.shortCleanup.applied, false);
        assert.equal(result.diagnostics.localMilesSaved, major.diagnostics.localMilesSaved);
        assert.equal(result.diagnostics.localSecondsSaved, major.diagnostics.localSecondsSaved);
        assert.ok(result.diagnostics.planned > major.diagnostics.planned);
        assert.ok(result.diagnostics.checked >= major.diagnostics.checked);
        if (mode === 'unavailable') {
            assert.equal(result.diagnostics.checked, 2);
            assert.equal(result.diagnostics.skipped.length, 1);
            assert.equal(result.diagnostics.shortCleanup.checked, 1);
        }
    });
}

test('cleanup reuses known curb policy and does not discover new sides for unknown cleanup doors', async () => {
    const f = fixture();
    for (const p of f.order.slice(0, 7)) f.known.set(p.id, { confidence: 'high', chainKey: p.id,
        side: 'right', positionMeters: 0, serviceBearing: 0, point: { lat: p.lat, lng: p.lng } });
    const result = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, shortDrivingCleanup: true, mailCarrierMode: true });
    const cleanupCalls = f.calls.filter(call => call.cleanup);
    assert.ok(cleanupCalls.length > 0);
    for (const call of cleanupCalls) {
        assert.equal(call.config.discoverStreetSides, undefined);
        assert.equal(call.config.inferStreetSides, false);
        assert.equal(call.config.knownDrivingAccessFor(f.order[0]), f.known.get(f.order[0].id));
    }
    assert.deepEqual(result.properties, f.desired);
    assert.equal(result.diagnostics.streetSideService.knownStops, 7);
    assert.equal(result.diagnostics.streetSideService.unknownStops, 7);
    assert.equal(result.accessFor(f.order[0]), f.known.get(f.order[0].id));
});

test('cleanup may tighten a legitimately longer coherent major tour without undoing its curb-service objective', async () => {
    const f = fixture('major_pass_tradeoff');
    for (const [index, positionMeters] of [[2, 20], [3, 10], [4, 0]]) f.known.set(f.order[index].id,
        { confidence: 'high', chainKey: 'coherent-major-pass', side: 'right', positionMeters,
            serviceBearing: 0, point: { lat: f.order[index].lat, lng: f.order[index].lng } });
    const options = { ...f.options, mailCarrierMode: true };
    const major = await reviewLocalDrivingNeighborhoods(f.order, options);
    assert.deepEqual(major.properties, f.major);
    assert.ok(major.measurement.driveSeconds > major.baseline.driveSeconds);
    assert.ok(major.diagnostics.streetSideService.passViolationsAfter < major.diagnostics.streetSideService.passViolationsBefore);
    const result = await reviewLocalDrivingNeighborhoods(f.order, { ...options, shortDrivingCleanup: true });
    assert.deepEqual(result.properties, f.desired);
    assert.equal(result.diagnostics.shortCleanup.applied, true);
    assert.ok(result.measurement.driveSeconds < major.measurement.driveSeconds);
    assert.ok(result.measurement.distanceMiles < major.measurement.distanceMiles);
    assert.ok(result.measurement.driveSeconds > result.baseline.driveSeconds,
        'the cleanup must not be required to offset an already accepted curb-service tradeoff');
    assert.deepEqual(result.baseline, major.baseline);
    assert.equal(result.diagnostics.streetSideService.passViolationsAfter, 0);
});

test('cleanup cannot add driving even when its proposed curb passes would be more coherent', async () => {
    const f = fixture('cleanup_pass_tradeoff');
    for (const [index, positionMeters] of [[9, 20], [10, 10], [11, 0]]) f.known.set(f.order[index].id,
        { confidence: 'high', chainKey: 'cleanup-pass', side: 'right', positionMeters,
            serviceBearing: 0, point: { lat: f.order[index].lat, lng: f.order[index].lng } });
    const result = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, maxLocalCandidates: 1,
        shortDrivingCleanup: true, mailCarrierMode: true });
    assert.deepEqual(result.properties, f.major);
    assert.equal(result.diagnostics.shortCleanup.applied, false);
    assert.equal(result.diagnostics.repaired, 1);
});

test('a declined major repair cannot leave stale adopted counts or savings when optional cleanup is disabled by its cap', async () => {
    const f = fixture('major_worse');
    const defaultResult = await reviewLocalDrivingNeighborhoods(f.order, f.options);
    assert.equal(defaultResult.diagnostics.applied, false);
    assert.ok(defaultResult.diagnostics.repaired > 0, 'the major stage really found a proposal before its complete guard rejected it');
    const result = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, shortDrivingCleanup: true, maxShortWindows: 0 });
    assert.equal(result.properties, f.order);
    assert.equal(result.diagnostics.applied, false);
    assert.equal(result.diagnostics.repaired, 0);
    assert.equal(result.diagnostics.localMilesSaved, 0);
    assert.equal(result.diagnostics.localSecondsSaved, 0);
    assert.equal(result.diagnostics.shortCleanup.status, 'not_needed');
});

test('cleanup cannot move a lock, an unresolved pin or either of its two fixed neighbors', async () => {
    const f = fixture();
    f.order[9].routing_access = { resolution_status: 'unresolved' };
    f.order[10].order_locked = true;
    const result = await reviewLocalDrivingNeighborhoods(f.order, { ...f.options, shortDrivingCleanup: true });
    assert.deepEqual(result.properties, f.major);
    for (const i of [7, 8, 9, 10, 11]) assert.equal(result.properties[i], f.order[i]);
    assert.deepEqual(new Set(result.properties), new Set(f.order));
    assert.equal(result.diagnostics.shortCleanup.applied, false);
});

for (const mode of ['fatal_graph', 'fatal_membership', 'fatal_abort']) {
    test(`cleanup must propagate ${mode} rather than hide it behind a retained major result`, async () => {
        const f = fixture(mode);
        await assert.rejects(reviewLocalDrivingNeighborhoods(f.order, { ...f.options, shortDrivingCleanup: true }), /identity|membership|Cancelled/);
    });
}
