import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let vite, optimize;
before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    optimize = (await vite.ssrLoadModule('/src/lib/roadMatrixOptimize.js')).tryRoadMatrixOptimize;
});
after(async () => { await vite?.close(); });
const properties = ['A', 'B', 'C'].map((address_hash, i) => ({ address_hash, lat: 35, lng: -81 + i / 10000 }));
const client = (review, measurements = {}) => ({ functions: { invoke: async () => ({ data: {
    success: true, selected: 'road_aware', order: ['B', 'A', 'C'], routing_metadata: {
        input_measured: 10, winning_route_distance: 10, duration_improvement: 0,
        ...measurements,
        neighborhood_excursion_review: { applied: true, local_driving_review: review },
    },
} }) } });

test('Optimize adopts an independently verified service improvement when total travel costs tie', async () => {
    for (const validation of ['whole_route', 'overlapping_boundary_legs']) {
        const result = await optimize(properties, { client: client({ applied: true, validation }) });
        assert.deepEqual(result.order.map(p => p.address_hash), ['B', 'A', 'C']);
        assert.equal(result.objective.estimatedSavings, 0);
    }
});

test('partial road matching reports verified local savings separately from the estimated route total', async () => {
    const result = await optimize(properties, { client: client({ applied: true,
        validation: 'overlapping_boundary_legs', localMilesSaved: 1.25 }, {
        input_measured: 10, winning_route_distance: 11, duration_improvement: -1,
    }) });
    assert.deepEqual(result.order.map(p => p.address_hash), ['B', 'A', 'C']);
    assert.equal(result.objective.appliedDistance, 11);
    assert.equal(result.objective.estimatedSavings, 1.25);
});

test('an unverified or unapplied local preference cannot replace a tied current route', async () => {
    for (const review of [null, { applied: false, validation: 'whole_route' }, { applied: true, validation: 'unchecked' }]) {
        assert.equal(await optimize(properties, { client: client(review) }), null);
    }
});

test('a mail-carrier service improvement that drives farther never fabricates mileage savings', async () => {
    const result = await optimize(properties, { client: client({ applied: true,
        validation: 'overlapping_boundary_legs', localMilesSaved: -0.25 }, {
        input_measured: 10, winning_route_distance: 9, duration_improvement: 0,
    }) });
    assert.equal(result.objective.estimatedSavings, 0);
    assert.deepEqual(result.order.map(p => p.address_hash), ['B', 'A', 'C']);
});
test('old applied-review diagnostics cannot claim savings when the returned stop order is unchanged', async () => {
    let outcome;
    const api = client({ applied: true, validation: 'overlapping_boundary_legs', localMilesSaved: 24.32 });
    const invoke = api.functions.invoke;
    api.functions.invoke = async () => {
        const response = await invoke();
        response.data.order = properties.map(p => p.address_hash);
        return response;
    };
    const result = await optimize(properties, { client: api, onOutcome: reason => { outcome = reason; } });
    assert.equal(result, null);
    assert.equal(outcome, 'current_order_measured_best');
});

const unresolvedAccess = { status: 'partial', attempted: 2, recovered: 1, reused: 0,
    unresolved: [{ property_id: 'C', stop_number: 3, address: '3 Lake Lane, Troutman, 28166', reason: 'road_not_matched' }],
    access_overrides: {} };
const accessLimitedClient = (review, extra = {}) => ({ functions: { invoke: async () => ({ data: {
    success: true, selected: 'road_aware', order: ['B', 'A', 'C'], ...extra,
    routing_metadata: { strategy: 'access_guarded_neighborhood_repair', distance_estimate: 'unavailable',
        input_measured: null, winning_route_distance: null, road_path_validated: false,
        road_access_recovery: unresolvedAccess,
        neighborhood_excursion_review: { local_driving_review: review }, ...extra.routing_metadata },
} }) } });

test('access-limited optimization adopts verified healthy neighborhoods without inventing a whole-route total', async () => {
    const result = await optimize(properties, { client: accessLimitedClient({ applied: true,
        validation: 'overlapping_boundary_legs', localMilesSaved: 1.25 }) });
    assert.deepEqual(result.order.map(p => p.address_hash), ['B', 'A', 'C']);
    assert.equal(result.objective.applyCandidate, true);
    assert.equal(result.objective.appliedDistance, null);
    assert.equal(result.objective.estimatedSavings, 1.25);
    assert.equal(result.routingMetadata.distance_estimate, 'unavailable');
    assert.equal(result.routingMetadata.input_measured, null);
    assert.equal(result.routingMetadata.winning_route_distance, null);
    assert.equal(result.routingMetadata.road_path_validated, false);
    assert.deepEqual(result.routingMetadata.road_access_recovery, unresolvedAccess);
    assert.equal(result.order.at(-1), properties.at(-1), 'the unresolved stop remains present in its original position');
});

test('access-limited results need a verified applied neighborhood review before any order is adopted', async () => {
    for (const review of [null, { applied: false, validation: 'overlapping_boundary_legs' },
        { applied: true, validation: 'unchecked' }, { applied: true, validation: 'whole_route' }]) {
        let outcome;
        const result = await optimize(properties, { client: accessLimitedClient(review),
            onOutcome: (reason, measurement) => { outcome = { reason, measurement }; } });
        assert.equal(result, null);
        assert.equal(outcome.reason, 'unverified_partial_order');
        assert.deepEqual(outcome.measurement.routingMetadata.road_access_recovery, unresolvedAccess);
        assert.equal(outcome.measurement.distanceMiles, undefined);
    }
});

test('access-limited unchanged results retain per-stop diagnostics without using stale local savings', async () => {
    let outcome;
    const result = await optimize(properties, { client: accessLimitedClient({ applied: true,
        validation: 'overlapping_boundary_legs', localMilesSaved: 24.32 }, { order: ['A', 'B', 'C'] }),
    onOutcome: (reason, measurement) => { outcome = { reason, measurement }; } });
    assert.equal(result, null);
    assert.equal(outcome.reason, 'road_access_unresolved');
    assert.deepEqual(outcome.measurement.routingMetadata.road_access_recovery, unresolvedAccess);
    assert.equal(outcome.measurement.distanceMiles, undefined);
});

test('an access-limited response cannot drop or duplicate any unresolved property', async () => {
    for (const order of [['B', 'A'], ['B', 'A', 'A'], ['B', 'A', 'unknown'], ['B', 'A', 'C', 'C']]) {
        let outcome;
        const result = await optimize(properties, { client: accessLimitedClient({ applied: true,
            validation: 'overlapping_boundary_legs', localMilesSaved: 1.25 }, { order }),
        onOutcome: (reason, measurement) => { outcome = { reason, measurement }; } });
        assert.equal(result, null);
        assert.equal(outcome.reason, 'order_failed_exact_once');
        assert.deepEqual(outcome.measurement.routingMetadata.road_access_recovery, unresolvedAccess);
    }
});

test('road-access recovery sends the full address and cached access while retaining the property display coordinates', async () => {
    const display = { ...properties[0], house_number: '1', street_name: 'Lake Lane', city: 'Troutman',
        state_code: 'NC', zip: '28166', routing_access: { resolution_status: 'resolved',
            point: { lat: 35.001, lng: -81.001 }, displayPoint: { lat: properties[0].lat, lng: properties[0].lng } } };
    const input = [display, ...properties.slice(1)];
    let payload;
    const api = accessLimitedClient({ applied: true, validation: 'overlapping_boundary_legs', localMilesSaved: 1 });
    const invoke = api.functions.invoke;
    api.functions.invoke = async (name, request) => { assert.equal(name, 'optimizeRouteRoadMatrix'); payload = request; return invoke(); };
    const result = await optimize(input, { client: api });
    assert.equal(payload.properties[0].house_number, '1');
    assert.equal(payload.properties[0].street_name, 'Lake Lane');
    assert.equal(payload.properties[0].state, 'NC');
    assert.equal(payload.properties[0].zip_code, '28166');
    assert.deepEqual(payload.properties[0].routing_access, display.routing_access);
    const returned = result.order.find(p => p.address_hash === display.address_hash);
    assert.equal(returned, display);
    assert.equal(returned.lat, properties[0].lat);
    assert.equal(returned.lng, properties[0].lng);
    assert.notEqual(returned.lat, returned.routing_access.point.lat);
});

test('a failed backend response retains road-access issues for the durable failure outcome', async () => {
    let outcome;
    const result = await optimize(properties, { client: { functions: { invoke: async () => ({ data: {
        success: false, error: 'https://provider/private', routing_metadata: { road_access_recovery: unresolvedAccess },
    } }) } }, onOutcome: (reason, measurement) => { outcome = { reason, measurement }; } });
    assert.equal(result, null);
    assert.equal(outcome.reason, 'backend_reported_failure');
    assert.deepEqual(outcome.measurement.routingMetadata.road_access_recovery, unresolvedAccess);
    assert.equal(outcome.measurement.distanceMiles, undefined);
    assert.equal(outcome.measurement.error, undefined);
});
