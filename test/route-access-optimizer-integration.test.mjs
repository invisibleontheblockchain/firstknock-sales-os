import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as continuity from '../base44/shared/routeContinuityOptimizer.js';
import * as candidateSelection from '../base44/shared/routeCandidateSelection.js';

const source = fs.readFileSync(new URL('../base44/functions/optimizeRouteRoadMatrix/entry.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const ids = properties => Array.from(properties, p => String(p.address_hash || p.id));
const inputStops = () => ['L', 'C', 'K', 'A', 'I', 'B', 'H', 'D', 'G', 'E', 'F', 'J'].map((address_hash, i) => ({
    address_hash, house_number: String(100 + i), street_name: 'Test Lane', city: 'Test City', zip_code: '28056',
    lat: 35, lng: -81 + i / 100000,
    ...(i === 3 ? { order_locked: true } : {}),
}));
const readyReport = () => ({ status: 'ready', attempted: 0, recovered: 0, reused: 0,
    unresolved: [], access_overrides: {}, inventory_complete: true, unverified_count: 0, failure_reason: null });

function endpoint({ recover, local, failProvider = false } = {}) {
    const calls = { events: [], recovery: [], plan: [], continuity: [], matrix: [], provider: [], local: [],
        globalReview: [], sweep: 0, hierarchy: 0, candidateComparison: 0 };
    const modules = {
        'npm:@base44/sdk@0.8.40': { createClientFromRequest: () => ({ auth: { me: async () => ({ id: 'manager' }) } }) },
        'base44:runtime': { secrets: { get: key => key === 'OSRM_BASE_URL' ? 'https://roads.test' : 'test-geocoder-key' } },
        '../../shared/routeContinuityOptimizer.js': { ...continuity,
            createContinuityOptimizer: metric => {
                const original = continuity.createContinuityOptimizer(metric);
                return { ...original, buildRouteChunks: (...args) => {
                    calls.events.push('continuity'); calls.continuity.push(args[0]);
                    return original.buildRouteChunks(...args);
                } };
            } },
        '../../shared/roadAwareStreetSweep.js': { roadAwareStreetSweep: properties => { calls.sweep++; return [...properties].reverse(); } },
        '../../shared/roadMatrix.js': {
            DEFAULT_OSRM_BASE_URL: 'https://roads.test', ROAD_MATRIX_VERSION: 'test-matrix',
            buildRoadMatrixCacheKey: async () => 'test-cache-key',
            fetchRoadMatrix: async (points, options) => {
                calls.events.push('matrix'); calls.matrix.push({ points, options });
                return { objective: 'road_miles', source: 'osrm:driving', snapped: points.length, pointCount: points.length };
            },
        },
        '../../shared/roadMatrixTiers.js': {
            MAX_TIERED_ROUTE_DOORS: 2500, TIER_CLUSTER: 'cluster', TIER_DOOR: 'door', BLOCK_TIER_REFINEMENT_STEP_BUDGET: 100,
            planTieredRoadMatrix: (properties, anchors) => {
                calls.events.push('plan'); calls.plan.push({ properties, anchors });
                return { ok: true, tier: 'door', matrixPoints: properties, anchorsIncluded: true, blockCount: properties.length };
            },
            createTieredMatrixMetricFns: () => ({ distanceBetween: () => 1, durationBetween: () => 1,
                unresolved: { count: 0 }, intraBlockLegCount: { count: 0 },
                aerialEvaluationCounts: { sameStreetBlock: 0, crossStreetSameUnit: 0 } }),
            classifyFinalRouteLegs: properties => ({ legCount: properties.length - 1, roadLegs: properties.length - 1,
                aerialCrossStreetLegs: 0, aerialSameStreetBlockLegs: 0 }),
        },
        '../../shared/roadHierarchySequencer.js': { HIERARCHY_REFINEMENT_STEP_BUDGET: 100,
            sequenceRoadHierarchy: async () => { calls.hierarchy++; assert.fail('door-tier integration must not use hierarchy'); } },
        '../../shared/roadPathMeasure.js': { measureRoadPath: async () => assert.fail('unexpected whole-route path call') },
        '../../shared/finalNeighborhoodReview.js': { reviewFinalNeighborhoodRoute: async (properties, options) => {
            calls.globalReview.push({ properties, options }); return { properties, diagnostics: { applied: false } };
        } },
        '../../shared/neighborhoodExcursions.js': { reviewNeighborhoodExcursions: properties => ({ properties,
            diagnostics: { detected: 0, remaining: 0, applied: false } }) },
        '../../shared/osrmDispatcher.js': { fetchOsrmJson: async () => assert.fail('unexpected unstubbed road request') },
        '../../shared/osrmRequestCache.js': { createOsrmRequestCache: () => ({
            fetchJson: async url => {
                calls.provider.push(url);
                if (failProvider) throw new Error('OSRM request failed with status 503.');
                return { code: 'Ok' };
            }, stats: () => ({ requests: calls.provider.length }),
        }) },
        '../../shared/roadCostCache.js': { createRoadCostCache: config => ({ ...config, stats: () => ({}) }) },
        '../../shared/routeMetricMemo.js': { createMemoizedRouteMetrics: metrics => metrics },
        '../../shared/routeAccessRecovery.js': { recoverRouteVehicleAccess: async (properties, options) => {
            calls.events.push('recovery'); calls.recovery.push({ properties, options });
            return recover ? recover(properties, options) : { properties, report: readyReport() };
        } },
        '../../shared/localDrivingNeighborhoods.js': { reviewLocalDrivingNeighborhoods: async (properties, options) => {
            calls.events.push('local'); calls.local.push({ properties, options });
            return local ? local(properties, options) : { properties, diagnostics: { applied: false, validation: 'unchanged' } };
        } },
        '../../shared/routeCandidateSelection.js': { ...candidateSelection, selectBestRouteCandidate: candidates => {
            calls.candidateComparison++; return candidateSelection.selectBestRouteCandidate(candidates);
        } },
    };
    const exports = {};
    vm.runInNewContext(compiled, {
        exports, require: name => {
            assert.ok(modules[name], `Unexpected optimizer module ${name}`);
            return modules[name];
        }, Response, Request, URL, console: { info() {}, warn() {}, error() {} },
    }, { filename: 'optimizeRouteRoadMatrix/entry.ts' });
    return { calls, async invoke(properties) {
        const response = await exports.default({ json: async () => ({ properties: structuredClone(properties) }) });
        return { status: response.status, body: await response.json() };
    } };
}

function unresolvedRecovery(properties) {
    return { properties: properties.map((p, i) => i === 6 ? { ...p,
        routing_access: { resolution_status: 'unresolved', reason: 'address_not_matched' } } : p),
    report: { ...readyReport(), status: 'unresolved', attempted: 1,
        unresolved: [{ property_id: properties[6].address_hash, stop_number: 7, reason: 'address_not_matched' }] } };
}

function partialImprovement(properties) {
    const revised = [...properties];
    [revised[0], revised[1]] = [revised[1], revised[0]];
    return { properties: revised, diagnostics: { applied: true, validation: 'overlapping_boundary_legs',
        repaired: 1, planned: 2, checked: 2, skipped: [], budgetExhausted: false,
        localMilesSaved: 1.25, localSecondsSaved: 60 } };
}

test('recovered access points reach canonical generation and road matrices without altering display input pins', async () => {
    const properties = inputStops(), original = JSON.stringify(properties);
    const recoveredId = properties[1].address_hash;
    const point = { lat: 35.0005, lng: -80.9995 };
    const access = { resolution_status: 'resolved', source: 'address_geocode_recovery', confidence: 'medium',
        side: 'unknown', point, displayPoint: { lat: properties[1].lat, lng: properties[1].lng }, roadName: 'Test Lane' };
    const { calls, invoke } = endpoint({ recover: submitted => ({
        properties: submitted.map(p => p.address_hash === recoveredId ? { ...p, ...point, routing_access: access } : p),
        report: { ...readyReport(), status: 'recovered', attempted: 1, recovered: 1, access_overrides: { [recoveredId]: access } },
    }) });
    const { status, body } = await invoke(properties);
    assert.equal(status, 200); assert.equal(body.success, true);
    assert.equal(calls.recovery.length, 1);
    assert.ok(calls.matrix.length > 0); assert.ok(calls.continuity.length > 0);
    for (const observed of [calls.plan[0].properties, calls.matrix[0].points, calls.continuity[0]]) {
        const recovered = observed.find(p => p.address_hash === recoveredId);
        assert.equal(recovered.lat, point.lat); assert.equal(recovered.lng, point.lng);
        assert.deepEqual(recovered.routing_access.displayPoint, access.displayPoint);
    }
    assert.deepEqual(ids(calls.continuity[0]), [...ids(properties)].sort());
    assert.equal(calls.events[0], 'recovery');
    assert.equal(JSON.stringify(properties), original);
    assert.deepEqual(body.routing_metadata.road_access_recovery.access_overrides[recoveredId].point, point);
    assert.deepEqual([...body.order].sort(), [...ids(properties)].sort());
});

test('residual unresolved access applies only a verified local incumbent repair and preserves every fixed stop', async () => {
    const properties = inputStops();
    const { calls, invoke } = endpoint({ recover: unresolvedRecovery, local: partialImprovement });
    const { body } = await invoke(properties);
    assert.equal(body.success, true); assert.equal(body.selected, 'road_aware');
    assert.equal(calls.local.length, 1);
    const reviewed = calls.local[0];
    assert.deepEqual(ids(reviewed.properties), ids(properties), 'partial review must begin from the saved incumbent, never canonical/global order');
    assert.deepEqual(ids(reviewed.options.baselineOrder), ids(properties));
    assert.equal(reviewed.properties[3].order_locked, true);
    assert.equal(reviewed.properties[6].routing_access.resolution_status, 'unresolved');
    assert.equal(calls.matrix.length, 0); assert.equal(calls.hierarchy, 0); assert.equal(calls.sweep, 0);
    assert.equal(calls.candidateComparison, 0); assert.equal(calls.globalReview.length, 0);
    assert.equal(calls.continuity.length, 0, 'unresolved access must not spend work generating global reshuffles');
    const expected = ids(properties); [expected[0], expected[1]] = [expected[1], expected[0]];
    assert.deepEqual(body.order, expected);
    for (const i of [3, 4, 5, 6, 7, 8]) assert.equal(body.order[i], properties[i].address_hash);
    assert.equal(body.routing_metadata.exact_once_verified, true);
    assert.equal(body.routing_metadata.road_path_validated, false);
    assert.equal(body.routing_metadata.input_measured, null);
    assert.equal(body.routing_metadata.winning_route_distance, null);
});

test('a road-access inventory outage returns diagnostic failure before any solver or repeated provider work', async () => {
    const { calls, invoke } = endpoint({ failProvider: true, recover: async (properties, options) => {
        await assert.rejects(options.vehicleFetch('https://roads.test/route/v1/driving/fixture', {}), /503/);
        return { properties, report: { ...readyReport(), status: 'provider_unavailable', inventory_complete: false,
            unverified_count: properties.length, failure_reason: 'road_provider_unavailable' } };
    } });
    const { body } = await invoke(inputStops());
    assert.equal(body.success, false);
    assert.equal(body.code, 'ROAD_ACCESS_PROVIDER_UNAVAILABLE');
    assert.equal(body.routing_metadata.road_access_recovery.unverified_count, 12);
    assert.equal(calls.provider.length, 1);
    assert.equal(calls.plan.length + calls.continuity.length + calls.matrix.length + calls.local.length + calls.globalReview.length, 0);
    assert.equal(calls.candidateComparison + calls.sweep + calls.hierarchy, 0);
    assert.equal('order' in body, false);
});

test('an unapplied local proposal cannot replace the incumbent with a shuffled fallback', async () => {
    const properties = inputStops();
    const { invoke } = endpoint({ recover: unresolvedRecovery, local: submitted => ({
        properties: [...submitted].reverse(), diagnostics: { applied: false, validation: 'whole_route_guard_retained' },
    }) });
    const { body } = await invoke(properties);
    assert.equal(body.selected, 'current'); assert.deepEqual(body.order, ids(properties));
    assert.equal(body.routing_metadata.neighborhood_excursion_review.applied, false);
});

test('unchanged local orders cannot turn stale applied diagnostics into a new optimization success', async () => {
    const properties = inputStops();
    const { invoke } = endpoint({ recover: unresolvedRecovery, local: submitted => ({
        properties: submitted, diagnostics: { applied: true, validation: 'overlapping_boundary_legs', repaired: 1, localMilesSaved: 2 },
    }) });
    const { body } = await invoke(properties);
    assert.equal(body.selected, 'current'); assert.deepEqual(body.order, ids(properties));
    assert.equal(body.routing_metadata.neighborhood_excursion_review.applied, false);
});

for (const damage of ['missing', 'duplicate', 'substituted']) {
    test(`partial response rejects ${damage} stop membership before certifying exact once`, async () => {
        const { invoke } = endpoint({ recover: unresolvedRecovery, local: submitted => {
            const proposal = partialImprovement(submitted);
            if (damage === 'missing') proposal.properties.pop();
            if (damage === 'duplicate') proposal.properties[2] = proposal.properties[0];
            if (damage === 'substituted') proposal.properties[2] = { ...proposal.properties[2], address_hash: 'not-in-route' };
            return proposal;
        } });
        const { status, body } = await invoke(inputStops());
        assert.ok(status >= 400 || body.success === false, 'invalid membership must fail before a route can be adopted');
        assert.notEqual(body.routing_metadata?.exact_once_verified, true);
    });
}

for (const fixedIndex of [3, 6]) {
    test(`an otherwise exact-once local proposal must retain fixed stop ${fixedIndex}`, async () => {
        const { invoke } = endpoint({ recover: unresolvedRecovery, local: submitted => {
            const proposal = partialImprovement(submitted);
            [proposal.properties[fixedIndex], proposal.properties[fixedIndex + 1]] =
                [proposal.properties[fixedIndex + 1], proposal.properties[fixedIndex]];
            return proposal;
        } });
        const { status, body } = await invoke(inputStops());
        assert.ok(status >= 400 || body.success === false);
        assert.notEqual(body.routing_metadata?.exact_once_verified, true);
    });
}

test('a road-provider failure during access recovery stops subsequent road optimization even after inventory completed', async () => {
    const { calls, invoke } = endpoint({ recover: properties => {
        const recovered = unresolvedRecovery(properties);
        recovered.report.status = 'provider_unavailable';
        recovered.report.unresolved[0].reason = 'road_provider_unavailable';
        return recovered;
    } });
    const { body } = await invoke(inputStops());
    assert.equal(body.success, false);
    assert.equal(body.code, 'ROAD_ACCESS_PROVIDER_UNAVAILABLE');
    assert.equal(calls.local.length + calls.matrix.length + calls.continuity.length, 0);
});

test('a geocoder-only outage leaves healthy road sections eligible for a verified partial improvement', async () => {
    const { calls, invoke } = endpoint({ recover: properties => {
        const recovered = unresolvedRecovery(properties);
        recovered.report.status = 'provider_unavailable';
        recovered.report.unresolved[0].reason = 'address_provider_unavailable';
        return recovered;
    }, local: partialImprovement });
    const { body } = await invoke(inputStops());
    assert.equal(body.success, true); assert.equal(body.selected, 'road_aware');
    assert.equal(calls.local.length, 1);
    assert.equal(calls.matrix.length + calls.continuity.length, 0);
    assert.equal(body.routing_metadata.road_access_recovery.unresolved[0].reason, 'address_provider_unavailable');
});
