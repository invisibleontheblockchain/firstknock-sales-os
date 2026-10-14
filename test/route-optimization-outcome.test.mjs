import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as outcomes from '../src/lib/routeOptimizationOutcome.js';
import * as origins from '../src/lib/routeOriginModes.js';
import * as bounds from '../src/lib/routeBounds.js';

const updates = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/lib/routeOptimizeUpdate.js', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: updates, require: name => {
    if (name === './routeOriginModes') return origins;
    if (name === './routeAnchors') return {};
    assert.fail(`Unexpected update helper dependency ${name}`);
} });

const measured = review => ({ distanceMiles: 241.95, routingMetadata: {
    optimizer_version: 'road_matrix_neighborhood_entry_return_v5', matrix_tier: 'door',
    neighborhood_excursion_review: { local_driving_review: review },
} });
const complete = { planned: 4, checked: 4, skipped: [], budgetExhausted: false, validation: 'unchanged' };

test('timeouts and failed requests never become a no-improvement success', () => {
    assert.equal(outcomes.describeRoadOptimizationOutcome('deadline_exceeded').status, 'timed_out');
    for (const reason of ['backend_unavailable: provider error', 'aerial_fallback', 'backend_reported_failure', null]) {
        const result = outcomes.describeRoadOptimizationOutcome(reason);
        assert.equal(result.status, 'failed'); assert.equal(result.tone, 'error');
        assert.doesNotMatch(result.message, /already optimized|no faster/i);
    }
});

test('the real Troutman rejection reports improvements found and a failed final check', () => {
    const result = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measured({
        planned: 64, checked: 52, repaired: 25, applied: false,
        status: 'whole_route_guard_retained', budgetExhausted: true,
        validation: 'overlapping_boundary_legs', reason: 'OSRM request failed with status 520.',
    }));
    assert.equal(result.status, 'verification_failed'); assert.equal(result.tone, 'error');
    assert.match(result.message, /Improvements were found/);
    assert.doesNotMatch(result.message, /no faster|already optimized/i);
});

test('partial, failed, or missing neighborhood checks never claim the route is already optimized', () => {
    for (const review of [null, { ...complete, budgetExhausted: true }, { ...complete, checked: 2 },
        { ...complete, skipped: [{ start: 2, end: 5, reason: 'NoSegment' }] }]) {
        const result = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measured(review));
        assert.ok(['limited', 'incomplete'].includes(result.status));
        assert.equal(result.tone, 'warning'); assert.doesNotMatch(result.message, /already optimized/i);
    }
    const block = measured(complete); block.routingMetadata.matrix_tier = 'block';
    assert.equal(outcomes.describeRoadOptimizationOutcome('current_order_measured_best', block).status, 'limited');
});

test('a completed comparison describes only the orders checked, without asserting global optimality', () => {
    const result = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measured(complete));
    assert.equal(result.status, 'no_improvement'); assert.equal(result.tone, 'info');
    assert.match(result.message, /among the orders checked/);
    assert.doesNotMatch(result.message, /already optimized|optimal|best route/i);
    const rejected = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measured({
        ...complete, repaired: 2, applied: false, status: 'whole_route_guard_retained', validation: 'whole_route',
    }));
    assert.equal(rejected.status, 'no_improvement', 'a completed worse whole-trip check is not a provider failure');
});

test('partial adoption explicitly identifies verified neighborhood improvements and remaining checks', () => {
    const meta = measured({ ...complete, applied: true, validation: 'overlapping_boundary_legs' }).routingMetadata;
    const result = outcomes.describeAppliedRoadOptimization(meta);
    assert.equal(result.tone, 'warning'); assert.match(result.message, /Some parts.*still need checking/);
    meta.neighborhood_excursion_review.local_driving_review.validation = 'whole_route';
    assert.equal(outcomes.describeAppliedRoadOptimization(meta), null);
});

test('attempt history contains evidence counts but never home/car anchors or raw provider URLs', () => {
    const measurement = measured(complete);
    measurement.routingMetadata.start_constraint = { lat: 33.45, lng: -112.01 };
    measurement.routingMetadata.end_constraint = { lat: 33.45, lng: -112.01 };
    const result = outcomes.buildRoadOptimizationAttempt('backend_unavailable: https://provider/33.45,-112.01', measurement,
        { mode: 'home_round_trip', doorCount: 377, finishedAt: '2026-10-14T14:00:00Z' });
    assert.equal(result.reason, 'backend_unavailable'); assert.equal(result.neighborhoods_checked, 4);
    assert.doesNotMatch(JSON.stringify(result), /33\.45|-112\.01|https:|start_constraint|end_constraint/);
});

function actionHarness(reason, measurement) {
    const calls = [], writes = [];
    const toast = Object.fromEntries(['loading', 'success', 'info', 'warning', 'error', 'dismiss'].map(tone =>
        [tone, message => calls.push({ tone, message })]));
    const client = { entities: { SavedRoute: { update: async (id, patch) => { writes.push({ id, patch }); } } } };
    const noFallback = () => assert.fail('a verified route must not be reordered by a failed-attempt fallback');
    const modules = {
        sonner: { toast }, '@/api/base44Client': { base44: client },
        '@/components/logic/routeOptimizer': { optimizeRouteByStreetSweep: noFallback },
        '@/components/logic/routeRoadContext': { createRouteRoadContext: noFallback, buildPersistedRoadRoutingMetadata: noFallback },
        '@/lib/routeBounds': bounds, '@/lib/parkedCarLocation': {},
        '@/lib/optimizeProgressToast': { startOptimizeProgress: () => ({ update() {}, stop() {} }) },
        '@/lib/roadMatrixOptimize': { tryRoadMatrixOptimize: async (_, options) => { options.onOutcome(reason, measurement); return null; } },
        '@/lib/routeOptimizationOutcome': outcomes, '@/lib/routeRoadVerification': {},
        '@/lib/routeContextGuard': {}, '@/lib/routeOriginModes': origins, '@/lib/routeOptimizeUpdate': updates,
    };
    const source = fs.readFileSync(new URL('../src/lib/reoptimizeRouteAction.js', import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, require: name => {
        assert.ok(modules[name], `Unexpected module ${name}`); return modules[name];
    }, console: { error() {} } });
    return { calls, writes, run: exports.reoptimizeRoute };
}

test('the real Optimize action keeps the stop order and records a timeout instead of success', async () => {
    const harness = actionHarness('deadline_exceeded');
    const properties = ['A', 'B', 'C'].map((address_hash, i) => ({ address_hash, lat: 35, lng: -81 + i / 10000 }));
    const route = { id: 'Troutman', property_hashes: properties.map(p => p.address_hash), route_origin_mode: 'none',
        metadata: { routing: { road_aware: true, fallback: false } } };
    await harness.run(route, { mode: 'route_only' }, { user: { id: 'manager' }, effectiveProperties: properties });
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0].patch.metadata.last_optimization_attempt.status, 'timed_out');
    assert.equal('property_hashes' in harness.writes[0].patch, false);
    assert.deepEqual(route.property_hashes, ['A', 'B', 'C']);
    assert.equal(harness.calls.at(-1).tone, 'warning');
    assert.match(harness.calls.at(-1).message, /timed out/);
    assert.ok(harness.calls.every(call => call.tone !== 'success'));
});

test('the real Optimize action distinguishes completed, incomplete, and failed checks', async () => {
    for (const [reason, measurement, expected] of [
        ['current_order_measured_best', measured(complete), 'info'],
        ['current_order_measured_best', measured({ ...complete, budgetExhausted: true }), 'warning'],
        ['backend_unavailable: failed', null, 'error'],
    ]) {
        const harness = actionHarness(reason, measurement);
        const properties = ['A', 'B', 'C'].map((address_hash, i) => ({ address_hash, lat: 35, lng: -81 + i / 10000 }));
        await harness.run({ id: 'route', property_hashes: properties.map(p => p.address_hash),
            metadata: { routing: { road_aware: true, fallback: false } } }, { mode: 'route_only' },
        { user: { id: 'manager' }, effectiveProperties: properties });
        assert.equal(harness.calls.at(-1).tone, expected); assert.equal(harness.writes.length, 1);
    }
});
