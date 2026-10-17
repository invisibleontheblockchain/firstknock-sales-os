import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as outcomes from '../src/lib/routeOptimizationOutcome.js';
import * as origins from '../src/lib/routeOriginModes.js';
import * as bounds from '../src/lib/routeBounds.js';
import * as hydrationCore from '../src/components/logic/routeHydrationCore.js';
import * as routeSelection from '../src/components/logic/routeMapSelection.js';
import * as routeDisplayGeometry from '../base44/shared/routeDisplayGeometry.js';

const updates = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/lib/routeOptimizeUpdate.js', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: updates, require: name => {
    if (name === './routeOriginModes') return origins;
    if (name === './routeAnchors') return {};
    if (name === '../../base44/shared/routeDisplayGeometry.js') return routeDisplayGeometry;
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

test('a processing limit differs from ordinary throttling without claiming optimality', () => {
    const cpu = outcomes.describeRoadOptimizationOutcome('backend_cpu_limit', { diagnostic: {
        httpStatus: 429, errorCode: 'cpu-exceeded', elapsedMs: 71000,
    } });
    assert.equal(cpu.status, 'processing_limit'); assert.equal(cpu.tone, 'error');
    assert.match(cpu.message, /reached its processing limit/);
    assert.doesNotMatch(cpu.message, /try again|no faster|already optimized/i);
    const throttle = outcomes.describeRoadOptimizationOutcome('backend_rate_limited');
    assert.equal(throttle.status, 'rate_limited'); assert.equal(throttle.tone, 'warning');
    assert.match(throttle.message, /busy/);
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

test('a verified complete driving route succeeds even when curb-side approaches remain unconfirmed', () => {
    const meta = measured({ ...complete, applied: true, validation: 'whole_route', streetSideService: {
        mode: 'mail_carrier_right_curb', knownStops: 20, totalStops: 24, unknownStops: 4,
    } }).routingMetadata;
    meta.road_path_validated = true;
    meta.winning_route_distance = 10;
    const applied = outcomes.describeAppliedRoadOptimization(meta);
    assert.equal(applied.tone, 'success');
    assert.equal(applied.message, 'Route updated. The complete driving route was verified.');
    meta.neighborhood_excursion_review.local_driving_review.applied = false;
    const unchanged = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', { distanceMiles: 10, routingMetadata: meta });
    assert.equal(unchanged.status, 'no_improvement');
    assert.equal(unchanged.tone, 'info');
    assert.match(unchanged.message, /^Complete driving route verified/);
    assert.match(unchanged.message, /No better order found among the orders checked/);
    assert.doesNotMatch(unchanged.message, /No faster|optimal|best route/i);
    const attempt = outcomes.buildRoadOptimizationAttempt('current_order_measured_best', { distanceMiles: 10, routingMetadata: meta });
    assert.equal(attempt.curb_sides_unconfirmed, 4);
    assert.equal(attempt.route_verification_complete, true);
    assert.match(attempt.message, /Curb-side approaches are unconfirmed for 4 stops/);
});

const verifiedWhole = (review = {}) => ({ distanceMiles: 241.95, routingMetadata: {
    road_path_validated: true, input_measured: 241.95, winning_route_distance: 220,
    matrix_tier: 'block', optimizer_version: 'road_matrix_neighborhood_area_service_v13',
    neighborhood_excursion_review: { local_driving_review: { ...complete,
        applied: true, validation: 'whole_route', ...review } },
} });

for (const [reason, wording] of [
    ['action_budget', /search time limit was reached/], ['pass_limit', /limit for this run/],
    ['no_progress', /remaining checks made no verified progress/], ['measurement_changed', /last verified result was kept/],
]) test(`incomplete search explains ${reason} without claiming the driving path failed`, () => {
    const measurement = verifiedWhole();
    Object.assign(measurement.routingMetadata, { road_search_passes: 2, road_search_stop_reason: reason,
        road_search_coverage: { version: 1, total_windows: 122, remaining_windows: 34, cycle_complete: false } });
    const outcome = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
    assert.match(outcome.message, /34 of 122 checks remain after 2 passes/);
    assert.match(outcome.message, wording);
    assert.match(outcome.message, /complete driving route was verified/);
    const saved = outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true });
    assert.equal(saved.search_stop_reason, reason);
    assert.equal(saved.route_verification_complete, true);
    measurement.routingMetadata.road_search_stop_reason = 'https://provider/35.1,-81.2';
    assert.equal(outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true }).search_stop_reason, undefined);
});

test('an applied complete driving route prominently reports the unfinished neighborhood search', () => {
    const measurement = verifiedWhole({ planned: 108, checked: 58, budgetExhausted: true,
        skipped: [{ reason: 'https://provider/private' }], streetSideService: { unknownStops: 256 } });
    const applied = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
    assert.equal(applied.status, 'applied_partial');
    assert.equal(applied.tone, 'warning');
    assert.match(applied.message, /^Route updated\. Neighborhood search is incomplete/);
    assert.match(applied.message, /complete driving route was verified/);
    assert.doesNotMatch(applied.message, /no faster|optimal|best route/i);
    const saved = outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true });
    assert.equal(saved.status, 'applied_partial');
    assert.equal(saved.route_verification_complete, true);
    assert.equal(saved.budget_exhausted, true);
    assert.equal(saved.neighborhoods_planned, 108); assert.equal(saved.neighborhoods_checked, 58);
    assert.equal(saved.neighborhoods_skipped, 1); assert.equal(saved.curb_sides_unconfirmed, 256);
    assert.match(saved.message, /time limit was reached after checking 58 of 108 neighborhoods/);
    assert.match(saved.message, /1 candidate check was skipped/);
    assert.match(saved.message, /Curb-side approaches are unconfirmed for 256 stops/);
    assert.doesNotMatch(saved.message, /https:|private|route.*unverified/i);
});

test('a complete unchanged driving route warns about the incomplete search without losing its path proof', () => {
    const measurement = verifiedWhole({ applied: false, planned: 108, checked: 58, budgetExhausted: true,
        streetSideService: { unknownStops: 256 } });
    const result = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measurement);
    assert.equal(result.status, 'incomplete'); assert.equal(result.tone, 'warning');
    assert.match(result.message, /^Your route was kept unchanged\. Neighborhood search is incomplete/);
    assert.match(result.message, /complete driving route was verified/);
    assert.doesNotMatch(result.message, /no faster|optimal|best route|unverified|curb-side/i);
    const saved = outcomes.buildRoadOptimizationAttempt('current_order_measured_best', measurement);
    assert.equal(saved.route_changed, false); assert.equal(saved.route_verification_complete, true);
    assert.equal(saved.budget_exhausted, true); assert.equal(saved.curb_sides_unconfirmed, 256);
    assert.match(saved.message, /Neighborhood search is incomplete: the time limit was reached/);
});

for (const [name, review, detail] of [
    ['skipped candidates', { skipped: [{ reason: 'OSRM request failed https://provider/private' }] }, /1 candidate check was skipped/],
    ['unchecked neighborhoods', { checked: 2, planned: 4 }, /only 2 of 4 neighborhoods were checked/],
]) {
    test(`whole driving verification remains true while ${name} make search completion explicit`, () => {
        const measurement = verifiedWhole(review);
        const applied = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
        assert.equal(applied.status, 'applied_partial'); assert.equal(applied.tone, 'warning');
        assert.match(applied.message, /^Route updated\. Neighborhood search is incomplete/);
        assert.match(applied.message, detail);
        assert.match(applied.message, /complete driving route was verified/);
        const unchanged = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measurement);
        assert.equal(unchanged.status, 'incomplete'); assert.equal(unchanged.tone, 'warning');
        assert.match(unchanged.message, /Neighborhood search is incomplete/);
        assert.match(unchanged.message, detail);
        assert.doesNotMatch(unchanged.message, /no faster|optimal|best route|https:/i);
        for (const adopted of [false, true]) {
            const saved = outcomes.buildRoadOptimizationAttempt(adopted ? null : 'current_order_measured_best', measurement, { applied: adopted });
            assert.equal(saved.route_verification_complete, true);
            assert.equal(saved.route_changed, adopted);
            assert.equal(saved.budget_exhausted, false);
            assert.match(saved.message, /Neighborhood search is incomplete/);
            assert.match(saved.message, detail);
        }
    });
}

test('whole-route wording requires both a verified continuous path and a usable candidate distance', () => {
    for (const distance of [null, undefined, NaN, Infinity, -1, '220']) {
        const measurement = verifiedWhole({ budgetExhausted: true });
        measurement.routingMetadata.winning_route_distance = distance;
        const result = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
        assert.equal(result.tone, 'warning');
        assert.doesNotMatch(result.message, /complete driving route was verified/);
        assert.equal(outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true }).route_verification_complete, false);
    }
    for (const change of [{ road_path_validated: false }, { fallback: true },
        { neighborhood_excursion_review: { local_driving_review: { applied: true, validation: 'overlapping_boundary_legs' } } }]) {
        const measurement = verifiedWhole({ budgetExhausted: true });
        Object.assign(measurement.routingMetadata, change);
        const result = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
        assert.equal(result.tone, 'warning');
        assert.doesNotMatch(result.message, /complete driving route was verified/);
    }
});

test('unresolved access remains visible even when returned metadata incorrectly claims a complete path', () => {
    const measurement = verifiedWhole();
    measurement.routingMetadata.road_access_recovery = roadRecovery(roadIssues);
    const applied = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
    assert.equal(applied.status, 'applied_partial'); assert.equal(applied.tone, 'warning');
    assert.ok(applied.message.includes(roadIssues[0].address));
    assert.doesNotMatch(applied.message, /complete driving route was verified/);
    const unchanged = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measurement);
    assert.equal(unchanged.status, 'road_access_unresolved');
    const saved = outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true });
    assert.equal(saved.route_verification_complete, false);
});

test('an incomplete road-match inventory cannot become a full-route success', () => {
    const measurement = verifiedWhole();
    measurement.routingMetadata.road_access_recovery = { status: 'provider_unavailable', attempted: 0, recovered: 0,
        unresolved: [], inventory_complete: false, unverified_count: 377 };
    assert.equal(outcomes.describeAppliedRoadOptimization(measurement.routingMetadata).status, 'applied_partial');
    assert.equal(outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measurement).status, 'road_provider_unavailable');
    assert.equal(outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true }).route_verification_complete, false);
});

test('failed attempts cannot inherit complete verification from stale measurement metadata', () => {
    for (const reason of ['backend_unavailable', 'deadline_exceeded', 'backend_cpu_limit']) {
        const measurement = verifiedWhole();
        const saved = outcomes.buildRoadOptimizationAttempt(reason, measurement);
        assert.equal(saved.route_verification_complete, false);
        assert.equal(saved.route_changed, false);
        assert.doesNotMatch(saved.message, /complete driving route verified/);
    }
    const guarded = verifiedWhole({ applied: false, repaired: 3, status: 'whole_route_guard_retained',
        reason: 'Final driving provider check failed' });
    const saved = outcomes.buildRoadOptimizationAttempt('current_order_measured_best', guarded);
    assert.equal(saved.status, 'verification_failed');
    assert.equal(saved.route_verification_complete, false);
});

test('county-mapped road evidence is disclosed in the saved full result without exposing graph or anchor data', () => {
    const measurement = verifiedWhole({ budgetExhausted: true });
    measurement.routingMetadata.road_matrix_source = 'osrm:driving+nc_ng911';
    measurement.routingMetadata.start_constraint = { lat: 33.45, lng: -112.01 };
    measurement.routingMetadata.county_road_routing = { graph: 'https://county/33.45,-112.01',
        localSpeedMph: 15, networks: [{ privateAnchor: { lat: 33.45, lng: -112.01 } }] };
    const toast = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
    assert.match(toast.message, /^Route updated\. Neighborhood search is incomplete/);
    const saved = outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true });
    assert.equal(saved.county_roads_included, true);
    assert.match(saved.message, /County-mapped local roads included; local-road travel times are estimated/);
    assert.doesNotMatch(JSON.stringify(saved), /https:|33\.45|-112\.01|privateAnchor|localSpeedMph|start_constraint/);
    delete measurement.routingMetadata.road_matrix_source;
    const ordinary = outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true });
    assert.equal(ordinary.county_roads_included, false);
    assert.doesNotMatch(ordinary.message, /County-mapped/);
});

test('county-road disclosure works for every registered authority and excludes ordinary provider graphs', () => {
    for (const metadata of [
        { road_matrix_source: 'osrm:driving+county_ng911' },
        { county_road_routing: { countyStopCount: 1, authoritySources: ['fl_lee_ng911_centerlines'] } },
    ]) {
        const measurement = verifiedWhole();
        Object.assign(measurement.routingMetadata, metadata);
        const saved = outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true });
        assert.equal(saved.county_roads_included, true);
        assert.match(saved.message, /local-road travel times are estimated/);
    }
    const measurement = verifiedWhole();
    measurement.routingMetadata.county_road_routing = { countyStopCount: 0, graphIdentity: 'public-provider-graph' };
    assert.equal(outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true }).county_roads_included, false);
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

test('attempt history saves HTTP status and elapsed time with no raw failure data', () => {
    const result = outcomes.buildRoadOptimizationAttempt('backend_cpu_limit', { diagnostic: {
        httpStatus: 429, errorCode: 'cpu-exceeded', elapsedMs: 71000.4,
        detail: 'https://provider/33.45,-112.01', error: { private: 'anchor' },
    } }, { mode: 'route_only', doorCount: 377 });
    assert.equal(result.status, 'processing_limit'); assert.equal(result.reason, 'backend_cpu_limit');
    assert.equal(result.http_status, 429); assert.equal(result.elapsed_ms, 71000);
    assert.doesNotMatch(JSON.stringify(result), /cpu-exceeded|33\.45|-112\.01|https:|detail|private|anchor/);
    const invalid = outcomes.buildRoadOptimizationAttempt('backend_unavailable', {
        diagnostic: { httpStatus: '429', elapsedMs: -1 },
    });
    assert.equal(invalid.http_status, null); assert.equal(invalid.elapsed_ms, null);
});

const roadRecovery = (unresolved = []) => ({ attempted: 4, recovered: 2, status: unresolved.length ? 'partial' : 'recovered', unresolved });
const roadIssues = [
    { property_id: 'hash_24', stop_number: 24, address: '101 Lake Lane, Troutman, NC 28166', reason: 'ambiguous_access' },
    { property_id: 'hash_110', stop_number: 110, address: '202 Cove Road, Troutman, NC 28166', reason: 'no_drivable_road' },
];
const withRecovery = (review, recovery = roadRecovery(roadIssues)) => {
    const measurement = measured(review);
    measurement.routingMetadata.road_access_recovery = recovery;
    return measurement;
};

test('unresolved driving access identifies every affected address without claiming the order changed', () => {
    const result = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', withRecovery(complete));
    assert.equal(result.status, 'road_access_unresolved');
    assert.equal(result.tone, 'error');
    assert.match(result.message, /Your route was kept unchanged/);
    assert.match(result.message, /recovered automatically for 2 stops/);
    for (const issue of roadIssues) {
        assert.ok(result.message.includes(`Stop ${issue.stop_number} (${issue.address})`));
    }
    assert.match(result.message, /All stops are retained/);
    assert.doesNotMatch(result.message, /no faster|applied|invalid address/i);
});

test('road-access diagnostics survive a failed measurement without a distance estimate', () => {
    const measurement = withRecovery(null);
    delete measurement.distanceMiles;
    const result = outcomes.describeRoadOptimizationOutcome('backend_reported_failure', measurement);
    assert.equal(result.status, 'road_access_unresolved');
    assert.ok(result.message.includes(roadIssues[0].address));
});

test('a backend timeout preserves both the timeout reason and known road-access issues', () => {
    const result = outcomes.describeRoadOptimizationOutcome('deadline_exceeded', withRecovery(null));
    assert.equal(result.status, 'timed_out');
    assert.match(result.message, /timed out/);
    assert.ok(result.message.includes(roadIssues[1].address));
});

test('verified partial adoption identifies retained unresolved stops rather than reporting full verification', () => {
    const measurement = withRecovery({ ...complete, applied: true, validation: 'overlapping_boundary_legs' });
    const result = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
    assert.equal(result.status, 'applied_partial');
    assert.equal(result.tone, 'warning');
    assert.match(result.message, /improvements applied/);
    assert.match(result.message, /complete driving route remains unverified/);
    for (const issue of roadIssues) assert.ok(result.message.includes(issue.address));
    assert.doesNotMatch(result.message, /kept unchanged/);
});

test('one unresolved stop does not hide the remaining search checks after automatic passes', () => {
    const issue = { property_id: '154 EMMA LN|28625', stop_number: 295,
        address: '154 Emma Ln, Statesville, 28625', reason: 'no_drivable_road' };
    const measurement = withRecovery({ ...complete, applied: true, validation: 'overlapping_boundary_legs' }, {
        attempted: 6, recovered: 5, unresolved: [issue], inventory_complete: true,
    });
    Object.assign(measurement.routingMetadata, {
        road_search_coverage: { version: 1, total_windows: 217, remaining_windows: 165, cycle_complete: false },
        road_search_passes: 3,
    });
    const result = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
    assert.equal(result.status, 'applied_partial');
    assert.equal(result.tone, 'warning');
    assert.ok(result.message.includes('the complete driving route remains unverified.'));
    assert.ok(result.message.includes('Neighborhood search is incomplete: 165 of 217 checks remain after 3 passes.'));
    assert.ok(result.message.includes(`Stop 295 (${issue.address})`));
    assert.ok(result.message.includes('Road access recovered automatically for 5 stops.'));
    assert.ok(result.message.includes('All stops are retained in the route.'));
    assert.doesNotMatch(result.message, /search completed|complete driving route was verified|retrying|retry is active/i);
    const attempt = outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true, mode: 'route_only', doorCount: 1000 });
    assert.equal(attempt.message, result.message);
    assert.equal(attempt.route_verification_complete, false);
    assert.equal(attempt.route_changed, true);
    assert.equal(attempt.neighborhoods_planned, 217);
    assert.equal(attempt.neighborhoods_checked, 52);
    assert.equal(attempt.search_passes, 3);
});

test('completed neighborhood coverage remains distinct from unresolved whole-route driving access', () => {
    const measurement = withRecovery({ ...complete, applied: true, checked: 2, budgetExhausted: true,
        skipped: [{ reason: 'https://provider/private' }], validation: 'overlapping_boundary_legs' });
    Object.assign(measurement.routingMetadata, {
        road_search_coverage: { version: 1, total_windows: 217, remaining_windows: 0, cycle_complete: true },
        road_search_passes: 3,
    });
    const result = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
    assert.equal(result.status, 'applied_partial');
    assert.equal(result.tone, 'warning');
    assert.ok(result.message.includes('Neighborhood search completed: 217 checks finished after 3 passes.'));
    assert.ok(result.message.includes('the complete driving route remains unverified.'));
    assert.ok(result.message.includes(roadIssues[0].address));
    assert.doesNotMatch(result.message, /search is incomplete|complete driving route was verified|optimal|best route|https:|private/i);
    const attempt = outcomes.buildRoadOptimizationAttempt(null, measurement, { applied: true });
    assert.equal(attempt.route_verification_complete, false);
    assert.equal(attempt.budget_exhausted, false);
    assert.equal(attempt.neighborhoods_checked, 217);
});

test('an unchanged route with unresolved access also reports current neighborhood coverage', () => {
    const measurement = withRecovery(complete);
    Object.assign(measurement.routingMetadata, {
        road_search_coverage: { version: 1, total_windows: 123, remaining_windows: 45, cycle_complete: false },
        road_search_passes: 2,
    });
    const result = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measurement);
    assert.equal(result.status, 'road_access_unresolved');
    assert.equal(result.tone, 'error');
    assert.ok(result.message.includes('Your route was kept unchanged.'));
    assert.ok(result.message.includes('Neighborhood search is incomplete: 45 of 123 checks remain after 2 passes.'));
    assert.ok(result.message.includes('All stops are retained in the route.'));
    assert.doesNotMatch(result.message, /improvements applied|complete driving route was verified/);
    const attempt = outcomes.buildRoadOptimizationAttempt('current_order_measured_best', measurement);
    assert.equal(attempt.message, result.message);
    assert.equal(attempt.route_changed, false);
    assert.equal(attempt.route_verification_complete, false);
});

test('partial access messages use review counts when the coverage ledger is absent or invalid', () => {
    for (const coverage of [undefined, { version: 1, total_windows: 123, remaining_windows: 0, cycle_complete: false },
        { version: 1, total_windows: '123', remaining_windows: 0, cycle_complete: true },
        { version: 1, total_windows: 123, remaining_windows: -1, cycle_complete: false }]) {
        const measurement = withRecovery({ ...complete, applied: true, checked: 2, validation: 'overlapping_boundary_legs' });
        measurement.routingMetadata.road_search_coverage = coverage;
        const result = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
        assert.ok(result.message.includes('Neighborhood search is incomplete: only 2 of 4 neighborhoods were checked.'));
        assert.doesNotMatch(result.message, /search completed/);
    }
    const completeReview = outcomes.describeAppliedRoadOptimization(withRecovery({ ...complete, applied: true }).routingMetadata);
    assert.ok(completeReview.message.includes('Neighborhood search completed: 4 checks finished.'));
    assert.equal(completeReview.tone, 'warning');
});

test('missing search evidence cannot turn a road-access warning into a completed-search claim', () => {
    const measurement = withRecovery(null);
    const result = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
    assert.equal(result.tone, 'warning');
    assert.ok(result.message.includes('the complete driving route remains unverified.'));
    assert.ok(result.message.includes('All stops are retained in the route.'));
    assert.doesNotMatch(result.message, /search completed|checks finished|complete driving route was verified/);
});

test('automatically recovered road access is reported for an applied and an unchanged result', () => {
    const measurement = withRecovery({ ...complete, validation: 'whole_route' }, roadRecovery());
    const unchanged = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measurement);
    assert.equal(unchanged.status, 'no_improvement');
    assert.match(unchanged.message, /kept unchanged/);
    assert.match(unchanged.message, /recovered automatically for 2 stops/);
    const applied = outcomes.describeAppliedRoadOptimization(measurement.routingMetadata);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.tone, 'success');
    assert.match(applied.message, /recovered automatically for 2 stops/);
    assert.doesNotMatch(applied.message, /unresolved|kept unchanged/);
});

test('time budget, unavailable driving data, and unknown curb sides have distinct explanations', () => {
    const timed = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measured({
        ...complete, budgetExhausted: true, checked: 2, streetSideService: { unknownStops: 4 },
    }));
    assert.match(timed.message, /time limit.*checking 2 of 4 neighborhoods/);
    assert.match(timed.message, /Curb-side approaches are unconfirmed for 4 stops/);
    assert.doesNotMatch(timed.message, /could not be loaded|unresolved/);
    const unloaded = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measured({
        ...complete, skipped: [{ reason: 'OSRM request failed with status 520. https://provider/private' }],
    }));
    assert.match(unloaded.message, /could not be loaded for 1 neighborhood check/);
    assert.doesNotMatch(unloaded.message, /time limit|https:|curb-side/i);
    const unverified = outcomes.describeRoadOptimizationOutcome('current_order_measured_best', measured({
        ...complete, skipped: [{ reason: 'changed boundary driving path' }],
    }));
    assert.match(unverified.message, /1 neighborhood check could not be verified/);
    assert.doesNotMatch(unverified.message, /could not be loaded/);
});

test('applied neighborhood improvements explain remaining time limits and curb sides separately', () => {
    const result = outcomes.describeAppliedRoadOptimization(measured({
        ...complete, applied: true, validation: 'whole_route', budgetExhausted: true,
        areaReview: { repaired: 1 }, streetSideService: { unknownStops: 3 },
    }).routingMetadata);
    assert.equal(result.status, 'applied_partial');
    assert.match(result.message, /improvements applied/);
    assert.match(result.message, /time limit/);
    assert.match(result.message, /Curb-side approaches are unconfirmed for 3 stops/);
    assert.doesNotMatch(result.message, /could not be loaded|unresolved/);
});

test('a generic applied review does not hide unconfirmed curb sides after road access recovery', () => {
    const result = outcomes.describeAppliedRoadOptimization(withRecovery({
        ...complete, applied: true, validation: 'whole_route', streetSideService: { unknownStops: 3 },
    }, roadRecovery()).routingMetadata);
    assert.equal(result.status, 'applied_partial');
    assert.equal(result.tone, 'warning');
    assert.match(result.message, /Curb-side approaches are unconfirmed for 3 stops/);
    assert.match(result.message, /recovered automatically for 2 stops/);
});

test('attempt history persists the actionable public stop list and generated result message', () => {
    const result = outcomes.buildRoadOptimizationAttempt('current_order_measured_best', withRecovery(complete), {
        mode: 'route_only', doorCount: 377, finishedAt: '2026-10-14T14:00:00Z',
    });
    assert.equal(result.status, 'road_access_unresolved');
    assert.equal(result.route_changed, false);
    assert.equal(result.road_access_recovery.status, 'partial');
    assert.equal(result.road_access_recovery.attempted, 4);
    assert.equal(result.road_access_recovery.recovered, 2);
    assert.deepEqual(result.road_access_recovery.unresolved, roadIssues);
    assert.ok(result.message.includes(roadIssues[0].address));
});

test('attempt history records actual applied status instead of an earlier declined result', () => {
    const result = outcomes.buildRoadOptimizationAttempt('current_order_measured_best', withRecovery({
        ...complete, applied: true, validation: 'overlapping_boundary_legs',
    }), { applied: true, mode: 'route_only', doorCount: 377 });
    assert.equal(result.status, 'applied_partial');
    assert.equal(result.route_changed, true);
    assert.match(result.message, /improvements applied/);
    assert.doesNotMatch(result.message, /kept unchanged/);
});

test('road-access attempt diagnostics reject provider URLs, private coordinates, and arbitrary failure data', () => {
    const measurement = withRecovery(complete, {
        attempted: '4', recovered: -2, status: 'https://provider/private',
        start_constraint: { lat: 33.45, lng: -112.01 },
        unresolved: [{ property_id: 'https://provider/33.45,-112.01', stop_number: '24',
            address: 'https://provider/33.45,-112.01', reason: 'provider https://provider/33.45,-112.01',
            detail: 'secret anchor', point: { lat: 33.45, lng: -112.01 } },
        { property_id: 'hash_24', stop_number: 24, address: '33.45,-112.01', reason: 'provider_unavailable' }],
    });
    const result = outcomes.buildRoadOptimizationAttempt('backend_reported_failure', measurement);
    assert.equal(result.road_access_recovery.status, 'provider_unavailable');
    assert.equal(result.road_access_recovery.attempted, 0);
    assert.equal(result.road_access_recovery.recovered, 0);
    assert.deepEqual(result.road_access_recovery.unresolved, [
        { property_id: null, stop_number: null, address: null, reason: 'unmatched_stop' },
        { property_id: 'hash_24', stop_number: 24, address: null, reason: 'provider_unavailable' },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /33\.45|-112\.01|https:|secret|start_constraint|point/);
});

test('a global driving-provider outage is preserved without labeling every address invalid', () => {
    const measurement = withRecovery(null, { status: 'provider_unavailable', attempted: 0, recovered: 0,
        inventory_complete: false, unverified_count: 377, unresolved: [] });
    delete measurement.distanceMiles;
    const result = outcomes.buildRoadOptimizationAttempt('backend_reported_failure', measurement);
    assert.equal(result.status, 'road_provider_unavailable');
    assert.equal(result.road_access_recovery.status, 'provider_unavailable');
    assert.equal(result.road_access_recovery.inventory_complete, false);
    assert.equal(result.road_access_recovery.unverified_count, 377);
    assert.deepEqual(result.road_access_recovery.unresolved, []);
    assert.match(result.message, /driving service could not load/);
    assert.match(result.message, /kept unchanged/);
    assert.match(result.message, /Road access could not be checked for 377 stops/);
    assert.doesNotMatch(result.message, /invalid|not found|unresolved for Stop/);
});

test('actual recovery reason codes and address-hash identities remain useful in safe attempt history', () => {
    const measurement = withRecovery(null, { attempted: 5, recovered: 0, unresolved: [
        { property_id: '156 WINDING FOREST DR|28166', stop_number: 24, address: '156 Winding Forest Dr', reason: 'road_not_matched' },
        { property_id: 'B', stop_number: 25, address: '25 Lake Lane', reason: 'address_not_matched' },
        { property_id: 'C', stop_number: 26, address: '26 Lake Lane', reason: 'ambiguous_service_road' },
        { property_id: 'D', stop_number: 27, address: '27 Lake Lane', reason: 'address_provider_unavailable' },
        { property_id: 'E', stop_number: 28, address: '28 Lake Lane', reason: 'recovery_limit_reached' },
    ] });
    const result = outcomes.buildRoadOptimizationAttempt('backend_reported_failure', measurement);
    assert.equal(result.road_access_recovery.unresolved[0].property_id, '156 WINDING FOREST DR|28166');
    assert.deepEqual(result.road_access_recovery.unresolved.map(issue => issue.reason), [
        'no_drivable_road', 'address_not_found', 'ambiguous_access', 'provider_unavailable', 'recovery_budget_exhausted',
    ]);
});

function actionHarness(reason, measurement) {
    const calls = [], writes = [];
    const toast = Object.fromEntries(['loading', 'success', 'info', 'warning', 'error', 'dismiss'].map(tone =>
        [tone, message => calls.push({ tone, message })]));
    const client = { entities: { SavedRoute: { update: async (id, patch) => { writes.push({ id, patch }); } } } };
    const noFallback = () => assert.fail('a verified route must not be reordered by a failed-attempt fallback');
    const modules = {
        sonner: { toast }, '@/api/base44Client': { base44: client },
        '@/components/logic/routeHydration': { hydrateRouteForMap: () => assert.fail('fixture homes are already loaded') },
        '@/components/logic/routeHydrationCore': hydrationCore,
        '@/components/logic/routeMapSelection': routeSelection,
        '@/components/logic/routeOptimizer': { optimizeRouteByStreetSweep: noFallback },
        '@/components/logic/routeRoadContext': { createRouteRoadContext: noFallback, buildPersistedRoadRoutingMetadata: noFallback },
        '@/lib/routeBounds': bounds, '@/lib/parkedCarLocation': {},
        '@/lib/optimizeProgressToast': { startOptimizeProgress: () => ({ update() {}, stop() {} }) },
        '@/lib/roadOptimizationProgress': { LONG_OPTIMIZATION_STOPS: 150, startRoadOptimizationJob: () => ({ startRoute() {}, progress() {}, finish() {} }) },
        '@/lib/roadMatrixOptimize': { tryRoadMatrixOptimize: async (_, options) => { options.onOutcome(reason, measurement); return null; } },
        '@/lib/routeOptimizePersistence': { syncOptimizedRoute: async () => {} },
        '@/lib/routeOptimizationOutcome': outcomes, '@/lib/routeRoadVerification': {},
        '@/lib/routeContextGuard': {}, '@/lib/routeOriginModes': origins, '@/lib/routeOptimizeUpdate': updates,
        '../../base44/shared/routeDisplayGeometry.js': routeDisplayGeometry,
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

test('the real Optimize action saves exact unresolved stops and displays them without dropping a stop', async () => {
    const harness = actionHarness('current_order_measured_best', withRecovery(complete));
    const properties = ['A', 'B', 'C'].map((address_hash, i) => ({ address_hash, lat: 35, lng: -81 + i / 10000 }));
    const route = { id: 'Troutman', property_hashes: properties.map(p => p.address_hash), route_origin_mode: 'none',
        metadata: { routing: { road_aware: true, fallback: false } } };
    await harness.run(route, { mode: 'route_only' }, { user: { id: 'manager' }, effectiveProperties: properties });
    assert.equal(harness.writes.length, 1);
    const attempt = harness.writes[0].patch.metadata.last_optimization_attempt;
    assert.equal(attempt.status, 'road_access_unresolved');
    assert.deepEqual(attempt.road_access_recovery.unresolved, roadIssues);
    assert.equal('property_hashes' in harness.writes[0].patch, false);
    assert.deepEqual(route.property_hashes, ['A', 'B', 'C']);
    assert.equal(harness.calls.at(-1).tone, 'error');
    for (const issue of roadIssues) assert.ok(harness.calls.at(-1).message.includes(issue.address));
    assert.ok(harness.calls.every(call => call.tone !== 'success'));
});

test('the real Optimize action distinguishes completed, incomplete, and failed checks', async () => {
    for (const [reason, measurement, expected] of [
        ['current_order_measured_best', measured(complete), 'info'],
        ['current_order_measured_best', measured({ ...complete, budgetExhausted: true }), 'warning'],
        ['backend_unavailable: failed', null, 'error'],
        ['backend_cpu_limit', { diagnostic: { httpStatus: 429, errorCode: 'cpu-exceeded', elapsedMs: 71000 } }, 'error'],
        ['backend_rate_limited', { diagnostic: { httpStatus: 429, errorCode: 'rate-limited', elapsedMs: 500 } }, 'warning'],
    ]) {
        const harness = actionHarness(reason, measurement);
        const properties = ['A', 'B', 'C'].map((address_hash, i) => ({ address_hash, lat: 35, lng: -81 + i / 10000 }));
        await harness.run({ id: 'route', property_hashes: properties.map(p => p.address_hash),
            metadata: { routing: { road_aware: true, fallback: false } } }, { mode: 'route_only' },
        { user: { id: 'manager' }, effectiveProperties: properties });
        assert.equal(harness.calls.at(-1).tone, expected); assert.equal(harness.writes.length, 1);
        if (measurement?.diagnostic) {
            assert.equal(harness.writes[0].patch.metadata.last_optimization_attempt.http_status, 429);
            assert.equal(harness.writes[0].patch.metadata.last_optimization_attempt.elapsed_ms, measurement.diagnostic.elapsedMs);
            assert.equal('property_hashes' in harness.writes[0].patch, false);
        }
    }
});

test('a road-access outage says why: could not connect, key refused, or too slow', () => {
    const outage = detail => ({ routingMetadata: { road_access_recovery: { status: 'provider_unavailable',
        inventory_complete: false, unverified_count: 184, unresolved: [], failure_detail: detail } } });
    const network = outcomes.describeRoadOptimizationOutcome('backend_reported_failure', outage({ kind: 'network', status: null,
        osrm_code: null, host: '131-153-164-35.sslip.io',
        message: 'OSRM request failed: fetch failed: ENOTFOUND: getaddrinfo ENOTFOUND 131-153-164-35.sslip.io' }));
    assert.equal(network.status, 'road_provider_unavailable');
    assert.match(network.message, /could not be checked for 184 stops: couldn't connect to the road server 131-153-164-35\.sslip\.io \(fetch failed: ENOTFOUND/);
    const auth = outcomes.describeRoadOptimizationOutcome('backend_reported_failure', outage({ kind: 'auth', status: 401, message: 'Unauthorized' }));
    assert.match(auth.message, /184 stops: the road server rejected the key \(401\)\./);
    const timeout = outcomes.describeRoadOptimizationOutcome('backend_reported_failure', outage({ kind: 'timeout' }));
    assert.match(timeout.message, /184 stops: the road server did not answer in time\./);
    // Unknown or unsafe details are dropped rather than displayed.
    const unsafe = outcomes.describeRoadOptimizationOutcome('backend_reported_failure', outage({ kind: 'shell', message: 'x' }));
    assert.match(unsafe.message, /could not be checked for 184 stops\./);
    const coordinates = outcomes.describeRoadOptimizationOutcome('backend_reported_failure', outage({ kind: 'network', message: 'near 35.1234, -80.5678' }));
    assert.doesNotMatch(coordinates.message, /35\.1234/);
});

test('the continuity fallback names its cause', () => {
    const fallback = detail => ({ routingMetadata: { fallback: true, road_failure_detail: detail } });
    assert.match(outcomes.describeRoadOptimizationOutcome('aerial_fallback', fallback({ kind: 'config' })).message,
        /Road distances were unavailable, so your route was kept unchanged: no road server is configured\./);
    assert.match(outcomes.describeRoadOptimizationOutcome('aerial_fallback', fallback({ kind: 'http', status: 503 })).message,
        /the road server returned an error \(HTTP 503\)/);
    assert.equal(outcomes.describeRoadOptimizationOutcome('aerial_fallback', fallback(null)).status, 'failed');
});

test('a failed driving check shows the server reason, never its URLs or coordinates', () => {
    const failed = serverMessage => outcomes.describeRoadOptimizationOutcome('backend_unavailable',
        { diagnostic: { httpStatus: 500, errorCode: null, elapsedMs: 13000, serverMessage } });
    assert.equal(failed('Vehicle route has inconsistent turn continuity at a chunk seam.').message,
        'Could not complete the driving check: Vehicle route has inconsistent turn continuity at a chunk seam. Your route was kept unchanged. Try again.');
    assert.equal(failed(undefined).message, 'Could not complete the driving check. Your route was kept unchanged. Try again.');
    assert.equal(failed('see https://roads.example/route at 35.12, -80.84').message,
        'Could not complete the driving check. Your route was kept unchanged. Try again.', 'unsafe text is dropped');
});

test('a verified result says how many stops used approximate road access, and names them', () => {
    const meta = { road_access_recovery: { status: 'ready', recovered: 0, unresolved: [], approximate: [
        { property_id: 'ALCOVE RD|28117', stop_number: 170, address: '0 Alcove Rd, Mooresville, 28117', snap_meters: 150 },
        { property_id: '116 HUNT CAMP TRL|28036', stop_number: 353, address: '116 Hunt Camp Trl, Davidson, 28036', snap_meters: 180 },
    ] } };
    const message = outcomes.approximateAccessMessage({ approximate: [
        { stop_number: 170, address: '0 Alcove Rd, Mooresville, 28117' }, { stop_number: 353, address: '116 Hunt Camp Trl, Davidson, 28036' }] });
    assert.equal(message, ' Approximate road access for 2 stops, routed from the nearest road: Stop 170 (0 Alcove Rd, Mooresville, 28117); Stop 353 (116 Hunt Camp Trl, Davidson, 28036).');
    const failed = outcomes.describeRoadOptimizationOutcome('backend_unavailable', { routingMetadata: meta });
    assert.match(failed.message, /Approximate road access for 2 stops/);
});
