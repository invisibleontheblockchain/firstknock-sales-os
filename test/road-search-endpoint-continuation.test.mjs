import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as continuity from '../base44/shared/routeContinuityOptimizer.js';
import * as verification from '../base44/shared/completeDrivingVerification.js';
import * as geometry from '../base44/shared/routeDisplayGeometry.js';

const source = fs.readFileSync(new URL('../base44/functions/optimizeRouteRoadMatrix/entry.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const identity = stop => String(stop.address_hash || stop.id || `${stop.lat},${stop.lng}`);
const ids = stops => Array.from(stops, identity);
const key = stops => ids(stops).join(',');
const point = stop => ({ lat: stop.lat, lng: stop.lng });
const stops = () => ['a', 'b', 'c', 'd', 'e', 'f'].map((address_hash, index) => ({
    address_hash, lat: 35 + index * 0.001, lng: -81,
    street_name: 'Example Lane', ...(index === 2 ? { order_locked: true } : {}),
}));
const ready = () => ({ status: 'ready', attempted: 0, recovered: 0, reused: 0, unresolved: [],
    access_overrides: {}, inventory_complete: true, unverified_count: 0, failure_reason: null });

function measurement(stops, bounds, { miles = 10, seconds = 100, version = 'fresh-graph' } = {}) {
    const ordered = [bounds.startLocation, ...stops, bounds.endLocation].filter(Boolean);
    return { distanceMiles: miles, driveSeconds: seconds, dataVersion: version,
        geometry: ordered.map(point), directedLegs: ordered.slice(1).map((stop, index) => ({
            from: identity(ordered[index]), to: identity(stop), geometry: [point(ordered[index]), point(stop)],
            distanceMiles: miles / (ordered.length - 1), driveSeconds: seconds / (ordered.length - 1),
            pathKey: `${identity(ordered[index])}>${identity(stop)}`,
        })) };
}

function endpoint({ recover, local, costs, authenticated = true, failMeasure = false } = {}) {
    const calls = { events: [], recovery: [], local: [], verification: [], contexts: [], measured: [], global: [] };
    const forbidden = name => () => { calls.global.push(name); throw new Error(`Unexpected global work: ${name}`); };
    const unavailableModule = name => new Proxy({}, { get: (_, member) => forbidden(`${name}.${String(member)}`) });
    const modules = {
        'npm:@base44/sdk@0.8.40': { createClientFromRequest: () => ({ auth: { me: async () => authenticated ? { id: 'manager' } : null } }) },
        'base44:runtime': { secrets: { get: name => name === 'OSRM_BASE_URL' ? 'https://roads.test' : '' } },
        '../../shared/routeContinuityOptimizer.js': { ...continuity, createContinuityOptimizer: forbidden('canonical generation') },
        '../../shared/roadMatrix.js': { DEFAULT_OSRM_BASE_URL: 'https://roads.test', ROAD_MATRIX_VERSION: 'test-matrix',
            buildRoadMatrixCacheKey: forbidden('matrix cache key'), fetchRoadMatrix: forbidden('road matrix') },
        '../../shared/roadMatrixTiers.js': { MAX_TIERED_ROUTE_DOORS: 2500, planTieredRoadMatrix: forbidden('matrix plan') },
        '../../shared/osrmDispatcher.js': { fetchOsrmJson: forbidden('unstubbed provider') },
        '../../shared/osrmRequestCache.js': { createOsrmRequestCache: () => ({
            fetchJson: forbidden('unstubbed cached provider'), stats: () => ({ requests: 0 }),
        }) },
        '../../shared/routeAccessRecovery.js': { recoverRouteVehicleAccess: async (submitted, options) => {
            calls.events.push('recovery'); calls.recovery.push({ submitted, options });
            return recover ? recover(submitted) : { properties: submitted, report: ready() };
        } },
        '../../shared/localDrivingNeighborhoods.js': { reviewLocalDrivingNeighborhoods: async (submitted, options) => {
            calls.events.push('local'); calls.local.push({ submitted, options });
            return local ? local(submitted, options) : { properties: submitted, searchCoverage: options.searchCoverage,
                diagnostics: { applied: false, planned: 12, checked: 12, repaired: 0, skipped: [], budgetExhausted: false } };
        } },
        '../../shared/countyRoadRouting.js': { createCountyRoadRoutingAdapter: (_, config) => ({
            graphIdentity: '', fetchJson: config.fetchJson, vehicleFetch: forbidden('unstubbed county provider'),
            stats: () => ({ countyStopCount: 0, publicDataVersion: 'fresh-graph' }),
        }) },
        '../../shared/completeDrivingVerification.js': {
            verifyCompleteDrivingCandidate: forbidden('global complete verification'),
            verifyDrivingSearchContinuation: async input => {
                calls.events.push('verification'); calls.verification.push(input);
                return verification.verifyDrivingSearchContinuation({ ...input, options: { ...input.options,
                    createDrivingContext: async (submitted, access, options) => {
                        calls.contexts.push({ submitted, access, options });
                        return { routeSequence: async (order, bounds) => {
                            calls.measured.push({ order, bounds });
                            if (failMeasure) throw new Error('Fresh driving route unavailable');
                            return measurement(order, bounds, costs?.[key(order)]);
                        } };
                    },
                } });
            },
        },
        '../../shared/routeDisplayGeometry.js': geometry,
        '../../shared/routeCandidateSelection.js': { OBJECTIVE_VERSION: 'test-objective' },
    };
    for (const name of ['roadAwareStreetSweep', 'roadHierarchySequencer', 'roadPathMeasure', 'finalNeighborhoodReview',
        'neighborhoodExcursions', 'roadCostCache', 'routeMetricMemo', 'roadLegDistribution']) {
        modules[`../../shared/${name}.js`] = unavailableModule(name);
    }
    const exports = {};
    vm.runInNewContext(compiled, { exports, require: name => {
        assert.ok(modules[name], `Unexpected optimizer module ${name}`); return modules[name];
    }, Response, Request, URL, console: { info() {}, warn() {}, error() {} } }, { filename: 'optimizeRouteRoadMatrix/entry.ts' });
    return { calls, async invoke(submitted, extra = {}) {
        const response = await exports.default({ json: async () => ({ properties: structuredClone(submitted),
            search_phase: 'remaining_neighborhoods', comparison_order: ids(submitted), ...extra }) });
        return { status: response.status, body: await response.json() };
    } };
}

test('continuation reviews the incumbent without restarting global matrix or hierarchy work', async () => {
    const original = stops(), input = [original[1], original[0], ...original.slice(2)];
    const candidate = [input[0], input[1], input[2], input[4], input[3], input[5]];
    const coverage = { version: 1, completed_window_keys: ['previous-check'], cycle_complete: false };
    const f = endpoint({ costs: { [key(original)]: { miles: 15, seconds: 150 },
        [key(input)]: { miles: 12, seconds: 120 }, [key(candidate)]: { miles: 10, seconds: 100 } },
    local: (submitted, options) => ({ properties: candidate.map(stop => submitted.find(item => identity(item) === identity(stop))),
        searchCoverage: options.searchCoverage, diagnostics: { applied: true, checked: 12, planned: 12, repaired: 1,
            localMilesSaved: 2, localSecondsSaved: 20, skipped: [], budgetExhausted: false } }) });
    const { status, body } = await f.invoke(input, { comparison_order: ids(original), search_coverage: coverage });
    assert.equal(status, 200); assert.equal(body.success, true);
    assert.deepEqual(f.calls.events, ['recovery', 'local', 'verification']);
    assert.deepEqual(f.calls.global, []);
    assert.deepEqual(ids(f.calls.local[0].submitted), ids(input));
    assert.deepEqual(ids(f.calls.local[0].options.baselineOrder), ids(input));
    assert.deepEqual(f.calls.local[0].options.searchCoverage, coverage);
    assert.equal(f.calls.local[0].options.shortDrivingCleanup, true);
    assert.equal(f.calls.local[0].options.mailCarrierMode, true);
    assert.equal(f.calls.contexts.length, 1);
    assert.deepEqual(f.calls.measured.map(call => ids(call.order)), [ids(original), ids(input), ids(candidate)]);
    assert.deepEqual(body.order, ids(candidate));
    assert.equal(body.order[2], original[2].address_hash, 'locked stop stays fixed');
    assert.deepEqual([...body.order].sort(), ids(original).sort());
    const meta = body.routing_metadata;
    assert.equal(meta.optimizer_version, 'road_matrix_neighborhood_continuation_v19');
    assert.equal(meta.strategy, 'remaining_neighborhoods_verified');
    assert.equal(meta.road_path_validated, true); assert.equal(meta.exact_once_verified, true);
    assert.equal(meta.input_measured, 12); assert.equal(meta.winning_route_distance, 10);
    assert.equal(meta.neighborhood_excursion_review.local_driving_review.validation, 'whole_route');
    assert.equal(meta.neighborhood_excursion_review.local_driving_review.checked, 12);
    assert.deepEqual(meta.road_search_coverage, coverage);
    assert.equal(meta.road_search_comparison.original_miles, 15);
    assert.equal(meta.road_search_comparison.input_miles, 12);
    assert.equal(meta.road_search_comparison.output_miles, 10);
    assert.equal(meta.road_search_comparison.graph_version, 'fresh-graph');
    assert.equal(meta.road_search_comparison.output_order_fingerprint, meta.property_order_fingerprint);
});

test('fresh access is shared by original, input and output proofs while display pins retain their coordinates', async () => {
    const original = stops(), input = [original[1], original[0], ...original.slice(2)];
    const originalSnapshot = structuredClone(original);
    const access = { resolution_status: 'resolved', source: 'address_geocode_recovery',
        point: { lat: 35.02, lng: -81 }, side: 'unknown' };
    // Fresh local evidence is intentionally absent from the submitted/cached
    // stop. A no-op review must still provide it to the complete proof.
    const inferredAccess = { ...access, source: 'current_street_side_evidence', confidence: 'high' };
    const f = endpoint({ recover: submitted => ({ properties: submitted.map(stop => stop.address_hash === 'b'
        ? { ...stop, ...access.point, routing_access: access } : stop), report: { ...ready(), recovered: 1, status: 'recovered' } }),
    local: (submitted, options) => ({ properties: submitted, searchCoverage: options.searchCoverage,
        accessFor: stop => stop.address_hash === 'b' ? inferredAccess : null,
        diagnostics: { applied: false, planned: 12, checked: 12, repaired: 0 } }) });
    const { body } = await f.invoke(input, { comparison_order: ids(original) });
    assert.equal(body.success, true);
    assert.equal(f.calls.contexts.length, 1);
    for (const { order } of f.calls.measured) assert.equal(order.find(stop => stop.address_hash === 'b').lat, 35.02);
    assert.equal(f.calls.contexts[0].access.accessFor(input[0]), inferredAccess);
    assert.deepEqual(original, originalSnapshot);
    const meta = body.routing_metadata;
    assert.ok(geometry.verifiedRouteGeometry({ ...meta, routing: { property_order_fingerprint: meta.property_order_fingerprint } },
        body.order, body.order.map(id => original.find(stop => stop.address_hash === id))));
    assert.ok(meta.road_geometry_segments[0].points.some(stop => stop.lat === 35.02));
});

test('unchanged continuation still obtains a fresh anchored complete-route proof', async () => {
    const input = stops(), start = { lat: 35.1, lng: -81.1 }, end = { lat: 35.2, lng: -81.2 };
    const f = endpoint();
    const { body } = await f.invoke(input, { start_location: start, end_location: end });
    assert.equal(body.success, true); assert.equal(body.selected, 'current');
    assert.equal(f.calls.contexts.length, 1); assert.equal(f.calls.measured.length, 1);
    assert.deepEqual(f.calls.measured[0].bounds, { startLocation: start, endLocation: end });
    assert.equal(f.calls.contexts[0].options.requireDirectedLegs, true);
    assert.equal(body.routing_metadata.anchor_legs_measured, true);
    assert.equal(body.routing_metadata.road_path_validated, true);
    assert.equal(body.routing_metadata.road_geometry_segments, undefined, 'personal anchor geometry is never persisted');
});

test('candidate rejected by fresh complete comparison cannot retain candidate coverage or savings', async () => {
    const input = stops(), candidate = [input[1], input[0], ...input.slice(2)];
    const f = endpoint({ costs: { [key(candidate)]: { miles: 11, seconds: 110 } },
        local: submitted => ({ properties: [submitted[1], submitted[0], ...submitted.slice(2)],
            searchCoverage: { version: 1, completed_window_keys: ['candidate-only'] },
            diagnostics: { applied: true, planned: 12, checked: 12, repaired: 1, localMilesSaved: 20 } }) });
    const { body } = await f.invoke(input);
    assert.equal(body.success, true); assert.equal(body.selected, 'current');
    assert.deepEqual(body.order, ids(input));
    assert.equal(body.routing_metadata.road_search_coverage, undefined);
    assert.equal(body.routing_metadata.winning_route_distance, 10);
    assert.equal(body.routing_metadata.neighborhood_excursion_review.local_driving_review.localMilesSaved, 0);
});

for (const [name, comparison] of [['missing', undefined], ['too short', ['a']], ['duplicate', ['a', 'a', 'c', 'd', 'e', 'f']],
    ['unknown', ['a', 'b', 'c', 'd', 'e', 'other']], ['non-string', ['a', 'b', 'c', 'd', 'e', 1]]]) {
    test(`${name} original comparison is rejected before access or provider work`, async () => {
        const f = endpoint(); const { status, body } = await f.invoke(stops(), { comparison_order: comparison });
        assert.equal(status, 400); assert.equal(body.code, 'INVALID_SEARCH_COMPARISON');
        assert.deepEqual(f.calls.events, []); assert.deepEqual(f.calls.global, []);
    });
}

test('continuation does not authorize walking or unauthenticated callers', async () => {
    const walking = endpoint();
    assert.equal((await walking.invoke(stops(), { profile: 'walking' })).status, 400);
    assert.equal(walking.calls.recovery.length, 0);
    const anonymous = endpoint({ authenticated: false });
    assert.equal((await anonymous.invoke(stops())).status, 401);
    assert.equal(anonymous.calls.recovery.length, 0);
});

for (const [name, change] of [['missing stop', input => input.slice(1)],
    ['moved locked stop', input => [input[0], input[2], input[1], ...input.slice(3)]],
    ['changed coordinate', input => input.map((stop, index) => index === 0 ? { ...stop, lat: 35.5 } : stop)]]) {
    test(`${name} from neighborhood review fails closed before approval`, async () => {
        const f = endpoint({ local: input => ({ properties: change(input), diagnostics: { applied: true } }) });
        const { status, body } = await f.invoke(stops());
        assert.equal(status, 500); assert.equal(body.success, undefined);
        assert.equal(body.routing_metadata?.road_path_validated, undefined);
    });
}

test('provider or fresh whole-route verification failure cannot produce a verified result', async () => {
    const provider = endpoint({ recover: submitted => ({ properties: submitted, report: { ...ready(),
        status: 'provider_unavailable', inventory_complete: false } }) });
    const unavailable = await provider.invoke(stops());
    assert.equal(unavailable.body.success, false); assert.equal(unavailable.body.code, 'ROAD_ACCESS_PROVIDER_UNAVAILABLE');
    assert.equal(provider.calls.local.length, 0);
    const proof = endpoint({ failMeasure: true }); const failed = await proof.invoke(stops());
    assert.equal(failed.status, 500); assert.equal(failed.body.success, undefined);
    assert.equal(failed.body.routing_metadata?.road_path_validated, undefined);
});
