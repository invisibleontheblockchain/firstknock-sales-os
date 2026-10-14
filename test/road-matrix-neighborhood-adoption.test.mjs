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
