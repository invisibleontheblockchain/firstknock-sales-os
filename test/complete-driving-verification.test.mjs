import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCompleteDrivingCandidate } from '../base44/shared/completeDrivingVerification.js';

const stops = () => ['a', 'b', 'c'].map((id, index) => ({ id, lat: 35.5 + index * 0.001, lng: -80.8, street_name: 'Example Dr' }));
const key = order => order.map(stop => stop.id).join(',');
const copyPoint = point => ({ lat: point.lat, lng: point.lng });

function measurement(order, bounds = {}, { seconds = 100, miles = 10, version = 'graph-a' } = {}) {
    const ordered = [bounds.startLocation, ...order, bounds.endLocation].filter(Boolean);
    const directedLegs = ordered.slice(1).map((to, index) => ({ from: ordered[index].id, to: to.id,
        driveSeconds: seconds / (ordered.length - 1), distanceMiles: miles / (ordered.length - 1),
        geometry: [copyPoint(ordered[index]), copyPoint(to)],
        pathKey: JSON.stringify([[ordered[index].lng, ordered[index].lat], [to.lng, to.lat]]) }));
    return { distanceMiles: miles, driveSeconds: seconds, geometry: ordered.map(copyPoint), directedLegs,
        objectiveSeconds: seconds, walkingAccessSeconds: 0, parkingSeconds: 0, dataVersion: version };
}

function factory(before, after, settings = {}) {
    const calls = [];
    const createDrivingContext = async (order, access, options) => {
        calls.push({ kind: 'context', order, access, options });
        return { routeSequence: async (sequence, bounds) => {
            calls.push({ kind: 'route', sequence, bounds });
            if (settings.route) return settings.route(sequence, bounds, calls);
            return measurement(sequence, bounds, key(sequence) === key(before) ? settings.before : settings.after || { seconds: 90, miles: 9 });
        } };
    };
    return { createDrivingContext, calls };
}

test('block candidate without neighborhood repairs receives complete before and after driving validation', async () => {
    const before = stops(); const after = [before[0], before[2], before[1]]; const provider = factory(before, after);
    const result = await verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after,
        neighborhood: { diagnostics: { local_driving_review: { repaired: 0, planned: 0, checked: 0 } } }, options: provider });
    assert.equal(result.applied, true); assert.equal(result.keptCurrent, false); assert.deepEqual(result.properties, after);
    assert.equal(result.measurement.driveSeconds, 90); assert.equal(result.baseline.driveSeconds, 100);
    assert.equal(result.diagnostics.local_driving_review.validation, 'whole_route');
    assert.equal(result.diagnostics.local_driving_review.repaired, 0);
    assert.equal(provider.calls.filter(call => call.kind === 'route').length, 2);
    const created = provider.calls[0];
    assert.equal(created.options.routeOnly, true); assert.equal(created.options.sparseCosts, true);
    assert.equal(created.options.requireDirectedLegs, true); assert.equal(created.options.maxGeometryPoints, 100000);
    assert.equal(created.options.servicePolicy.enabled, false); assert.equal(created.options.servicePolicy.parkingSecondsPerStop, 0);
    const withAccess = { ...before[0], routing_access: { point: copyPoint(before[0]) } };
    assert.deepEqual(created.access.accessFor(withAccess), withAccess.routing_access);
    assert.equal(typeof created.access.streetSegmentKey, 'function');
});

test('unchanged incumbent is measured once and cannot claim stale local repairs or savings', async () => {
    const before = stops(); const provider = factory(before, before);
    const result = await verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: [...before], options: provider,
        neighborhood: { diagnostics: { applied: true, reason: 'old provider failure', secondsSaved: 99, local_driving_review: { applied: true,
            repaired: 4, localMilesSaved: 8, localSecondsSaved: 99, validation: 'overlapping_boundary_legs',
            wholeRouteUnavailableReason: 'old NoSegment', reason: 'old failure' } } } });
    assert.equal(result.applied, false); assert.equal(result.keptCurrent, true);
    assert.equal(result.measurement, result.baseline);
    assert.equal(provider.calls.filter(call => call.kind === 'route').length, 1);
    assert.equal(result.diagnostics.applied, false); assert.equal(result.diagnostics.secondsSaved, 0);
    assert.equal(result.diagnostics.local_driving_review.applied, false);
    assert.equal(result.diagnostics.local_driving_review.repaired, 0);
    assert.equal(result.diagnostics.local_driving_review.localMilesSaved, 0);
    assert.equal(result.diagnostics.local_driving_review.localSecondsSaved, 0);
    assert.equal(result.diagnostics.local_driving_review.validation, 'whole_route');
    assert.equal(result.diagnostics.local_driving_review.wholeRouteUnavailableReason, undefined);
    assert.equal(result.diagnostics.reason, undefined);
});

for (const [label, costs] of [['driving time', { seconds: 101, miles: 9 }], ['driving distance', { seconds: 90, miles: 11 }]]) {
    test(`candidate worse in complete ${label} retains the incumbent and clears local savings`, async () => {
        const before = stops(); const after = [before[0], before[2], before[1]]; const provider = factory(before, after, { after: costs });
        const result = await verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after, options: provider,
            neighborhood: { diagnostics: { local_driving_review: { repaired: 2, localMilesSaved: 5, localSecondsSaved: 50 } } } });
        assert.equal(result.applied, false); assert.equal(result.keptCurrent, true); assert.deepEqual(result.properties, before);
        assert.equal(result.measurement.driveSeconds, 100);
        assert.equal(result.diagnostics.status, 'whole_route_guard_retained');
        assert.equal(result.diagnostics.local_driving_review.status, 'whole_route_guard_retained');
        assert.equal(result.diagnostics.local_driving_review.validation, 'whole_route');
        assert.equal(result.diagnostics.local_driving_review.repaired, 0);
        assert.equal(result.diagnostics.local_driving_review.localMilesSaved, 0);
    });
}

test('provider rounding inside the fixed guard tolerance is accepted', async () => {
    const before = stops(); const after = [before[0], before[2], before[1]];
    const result = await verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after,
        options: factory(before, after, { after: { seconds: 100.099, miles: 10.00009 } }) });
    assert.equal(result.applied, true);
});

test('previously approved complete mail carrier objective retains its validated whole-route decision', async () => {
    const before = stops(); const after = [before[0], before[2], before[1]];
    const neighborhood = { properties: after, baseline: measurement(before), measurement: measurement(after, {}, { seconds: 110, miles: 11 }),
        diagnostics: { applied: true, status: 'partially_reviewed', local_driving_review: { validation: 'whole_route', applied: true,
            repaired: 2, planned: 12, checked: 7, budgetExhausted: true, localMilesSaved: 0.4, localSecondsSaved: 5,
            streetSideService: { objective: 'coherent_side_passes_then_driving_cost', passViolationsBefore: 3, passViolationsAfter: 1 } } } };
    const result = await verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after, neighborhood,
        options: { createDrivingContext: () => { throw new Error('already verified'); } } });
    assert.equal(result.applied, true); assert.equal(result.measurement, neighborhood.measurement);
    assert.equal(result.diagnostics.local_driving_review.checked, 7);
    assert.equal(result.diagnostics.local_driving_review.planned, 12);
    assert.equal(result.diagnostics.local_driving_review.budgetExhausted, true);
});

for (const [label, change] of [
    ['partial local validation', neighborhood => { neighborhood.diagnostics.local_driving_review.validation = 'overlapping_boundary_legs'; }],
    ['unapproved local validation', neighborhood => { neighborhood.diagnostics.local_driving_review.applied = false; }],
    ['stale candidate order', neighborhood => { neighborhood.properties = stops(); }],
    ['missing directed legs', neighborhood => { neighborhood.measurement.directedLegs = null; }],
    ['wrong baseline order', neighborhood => { neighborhood.baseline.directedLegs[0].to = 'c'; }],
    ['changed graph identity', neighborhood => { neighborhood.measurement.dataVersion = 'other'; }],
]) test(`existing ${label} is remeasured rather than reused`, async () => {
    const before = stops(); const after = [before[0], before[2], before[1]]; const provider = factory(before, after);
    const neighborhood = { properties: after, baseline: measurement(before), measurement: measurement(after),
        diagnostics: { local_driving_review: { validation: 'whole_route', applied: true, repaired: 1 } } };
    change(neighborhood);
    const result = await verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after, neighborhood, options: provider });
    assert.equal(result.applied, true); assert.equal(result.measurement.driveSeconds, 90);
    assert.equal(provider.calls.filter(call => call.kind === 'route').length, 2);
});

for (const [label, candidate] of [
    ['missing stop', before => before.slice(0, 2)],
    ['repeated stop', before => [before[0], before[1], before[1]]],
    ['new stop', before => [before[0], before[1], { ...before[2], id: 'new' }]],
    ['changed coordinate', before => [before[0], before[1], { ...before[2], lat: before[2].lat + 0.01 }]],
]) test(`complete driving verification rejects ${label} before requesting road data`, async () => {
    const before = stops(); const provider = factory(before, before);
    await assert.rejects(verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: candidate(before), options: provider }),
        /membership|stop location/);
    assert.equal(provider.calls.length, 0);
});

for (const [label, protect, options] of [
    ['original order lock', before => { before[1].order_locked = true; }, {}],
    ['original legacy lock', before => { before[1].locked = true; }, {}],
    ['original unresolved access', before => { before[1].routing_access = { resolution_status: 'unresolved' }; }, {}],
    ['explicit locked identifier', () => {}, { lockedStopIds: ['b'] }],
    ['explicit unresolved identifier', () => {}, { unresolvedStopIds: ['b'] }],
]) test(`complete driving verification preserves ${label} at its original slot`, async () => {
    const before = stops(); protect(before); const after = [before[0], before[2], before[1]];
    const provider = factory(before, after);
    await assert.rejects(verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after, options: { ...provider, ...options } }),
        /locked stop|unresolved stop boundary/);
    assert.equal(provider.calls.length, 0);
});

test('both private boundaries are part of every checked directed leg sequence', async () => {
    const before = stops(); const after = [before[0], before[2], before[1]];
    const startLocation = { id: 'home', lat: 35.4, lng: -80.8 }; const endLocation = { id: 'end', lat: 35.6, lng: -80.8 };
    const provider = factory(before, after);
    const result = await verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after,
        options: { ...provider, startLocation, endLocation } });
    assert.deepEqual(result.measurement.directedLegs.map(leg => [leg.from, leg.to]), [['home', 'a'], ['a', 'c'], ['c', 'b'], ['b', 'end']]);
    assert.ok(provider.calls.filter(call => call.kind === 'route').every(call => call.bounds.startLocation === startLocation && call.bounds.endLocation === endLocation));
});

test('return-to-start checks the final directed leg back to the supplied origin', async () => {
    const before = stops(); const home = { id: 'home', lat: 35.4, lng: -80.8 };
    const result = await verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: before,
        options: { ...factory(before, before), startLocation: home, returnToStart: true } });
    assert.equal(result.measurement.directedLegs.at(-1).to, 'home');
});

for (const [label, alter] of [
    ['negative distance', value => { value.distanceMiles = -1; }],
    ['non-finite driving time', value => { value.driveSeconds = Infinity; }],
    ['missing geometry', value => { value.geometry = []; }],
    ['invalid geometry coordinate', value => { value.geometry[0].lat = 100; }],
    ['missing consecutive leg', value => { value.directedLegs.pop(); }],
    ['wrong consecutive leg identity', value => { value.directedLegs[0].to = 'other'; }],
    ['negative consecutive cost', value => { value.directedLegs[0].driveSeconds = -1; }],
    ['missing directed path key', value => { value.directedLegs[0].pathKey = ''; }],
    ['missing directed geometry', value => { value.directedLegs[0].geometry = []; }],
    ['inconsistent driving totals', value => { value.driveSeconds += 2; }],
    ['inconsistent distance totals', value => { value.distanceMiles += 0.01; }],
]) test(`incomplete whole-route ${label} cannot approve an order`, async () => {
    const before = stops(); const after = [before[0], before[2], before[1]];
    const provider = factory(before, after, { route: (sequence, bounds) => {
        const value = measurement(sequence, bounds); alter(value); return value;
    } });
    await assert.rejects(verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after, options: provider }),
        /incomplete|mismatched|totals|invalid route costs/);
});

test('provider failures and changed live graph identity propagate instead of returning an unverified reorder', async () => {
    const before = stops(); const after = [before[0], before[2], before[1]];
    const failure = new Error('road service unavailable');
    await assert.rejects(verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after,
        options: factory(before, after, { route: () => { throw failure; } }) }), value => value === failure);
    await assert.rejects(verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after,
        options: factory(before, after, { after: { seconds: 90, miles: 9, version: 'other' } }) }), /graph identity changed/);
});

test('whole verification preserves incomplete search counts without implying exhaustive optimization', async () => {
    const before = stops(); const after = [before[0], before[2], before[1]];
    const neighborhood = { diagnostics: { local_driving_review: { planned: 99, checked: 7, repaired: 1, budgetExhausted: true,
        skipped: [{ start: 3, end: 6, reason: 'search budget' }], localMilesSaved: 0.4, localSecondsSaved: 4 } } };
    const prior = structuredClone(neighborhood);
    const result = await verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: after, neighborhood,
        options: factory(before, after) });
    assert.equal(result.diagnostics.local_driving_review.validation, 'whole_route');
    assert.equal(result.diagnostics.local_driving_review.checked, 7);
    assert.equal(result.diagnostics.local_driving_review.planned, 99);
    assert.equal(result.diagnostics.local_driving_review.budgetExhausted, true);
    assert.deepEqual(neighborhood, prior);
});

test('real vehicle context uses directed route calls and verifies an incumbent even without local repairs', async () => {
    const before = stops(); const calls = [];
    const vehicleFetch = async raw => {
        const url = new URL(raw); calls.push(url);
        assert.match(url.pathname, /\/route\/v1\/driving\//);
        const points = url.pathname.split('/').at(-1).split(';').map(pair => pair.split(',').map(Number));
        const legs = points.slice(1).map((point, index) => ({ duration: 10, distance: 100,
            steps: [{ geometry: { coordinates: [points[index], point] }, maneuver: { modifier: 'straight' } }] }));
        return { ok: true, json: async () => ({ code: 'Ok', data_version: 'live-graph',
            waypoints: points.map(location => ({ location })), routes: [{ duration: legs.length * 10,
                distance: legs.length * 100, geometry: { coordinates: points }, legs }] }) };
    };
    const result = await verifyCompleteDrivingCandidate({ baselineOrder: before, candidateOrder: before,
        neighborhood: { diagnostics: { local_driving_review: { repaired: 0 } } },
        options: { vehicleFetch, vehicleBaseUrl: 'https://roads.test' } });
    assert.equal(result.applied, false); assert.equal(calls.length, 1);
    assert.equal(result.measurement.directedLegs.length, 2);
    assert.equal(result.diagnostics.local_driving_review.validation, 'whole_route');
});
