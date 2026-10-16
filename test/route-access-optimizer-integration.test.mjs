import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as continuity from '../base44/shared/routeContinuityOptimizer.js';
import * as candidateSelection from '../base44/shared/routeCandidateSelection.js';
import * as legDistribution from '../base44/shared/roadLegDistribution.js';
import * as routeDisplayGeometry from '../base44/shared/routeDisplayGeometry.js';

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

const drivingMeasurement = (distanceMiles = 100, driveSeconds = 3000) => ({ distanceMiles, driveSeconds,
    directedLegs: [], geometry: [[-81, 35], [-80.99, 35]], graphIdentity: 'osrm-test-graph' });

for (const planTier of ['door', 'cluster']) test(`${planTier} response reuses complete geometry and binds recovered entrances to original display pins`, async () => {
    const properties = inputStops();
    const { invoke } = endpoint({ planTier,
        recover: submitted => ({ properties: submitted.map((stop, i) => i === 1 ? { ...stop, lat: 35.005 } : stop), report: readyReport() }),
        verify: input => {
            const order = input.baselineOrder;
            const geometry = order.map(stop => ({ lat: stop.lat, lng: stop.lng }));
            const measured = { ...drivingMeasurement(), geometry,
                directedLegs: order.slice(1).map((stop, i) => ({ from: order[i].address_hash, to: stop.address_hash,
                    distanceMiles: 1, geometry: [geometry[i], geometry[i + 1]] })) };
            return { properties: order, measurement: measured, baseline: measured, applied: false, keptCurrent: true,
                diagnostics: { applied: false, local_driving_review: { applied: false, validation: 'whole_route' } } };
        },
    });
    const { body } = await invoke(properties);
    assert.equal(body.success, true);
    const meta = { ...body.routing_metadata, routing: { property_order_fingerprint: body.routing_metadata.property_order_fingerprint } };
    const originalOrder = body.order.map(id => properties.find(stop => stop.address_hash === id));
    assert.ok(routeDisplayGeometry.verifiedRouteGeometry(meta, body.order, originalOrder));
    assert.equal(meta.road_geometry_segments[0].points.find(point => point.lat === 35.005)?.lat, 35.005);
    const anchored = await invoke(properties, { start_location: { lat: 35.1, lng: -81.1 } });
    assert.equal(anchored.body.routing_metadata.road_geometry_segments, undefined);
});

function endpoint({ recover, local, finalReview, verify, winner, planTier = 'door', failProvider = false, authenticated = true } = {}) {
    const calls = { events: [], recovery: [], plan: [], continuity: [], matrix: [], provider: [], local: [],
        globalReview: [], county: [], roadCosts: [], paths: [], completeVerification: [],
        sweep: 0, hierarchy: 0, candidateComparison: 0 };
    const modules = {
        'npm:@base44/sdk@0.8.40': { createClientFromRequest: () => ({ auth: { me: async () => authenticated ? { id: 'manager' } : null } }) },
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
                return { ok: true, tier: planTier, matrixPoints: properties, anchorsIncluded: true, blockCount: properties.length };
            },
            createTieredMatrixMetricFns: () => ({ distanceBetween: () => 1, durationBetween: () => 1,
                unresolved: { count: 0 }, intraBlockLegCount: { count: 0 },
                aerialEvaluationCounts: { sameStreetBlock: 0, crossStreetSameUnit: 0 } }),
            classifyFinalRouteLegs: properties => ({ legCount: properties.length - 1, roadLegs: properties.length - 1,
                aerialCrossStreetLegs: 0, aerialSameStreetBlockLegs: 0 }),
        },
        '../../shared/roadHierarchySequencer.js': { HIERARCHY_REFINEMENT_STEP_BUDGET: 100,
            sequenceRoadHierarchy: async properties => {
                calls.hierarchy++;
                assert.equal(planTier, 'cluster', 'door-tier integration must not use hierarchy');
                return { ok: true, order: properties, telemetry: { degraded: false, degraded_cluster_reasons: [],
                    matrix_request_count: 1, street_block_count: properties.length } };
            } },
        '../../shared/roadPathMeasure.js': { measureRoadPath: async (properties, options) => {
            calls.paths.push({ properties, options });
            return planTier === 'cluster' ? { ok: true, totalMiles: 100, totalSeconds: 3000,
                longestLegMiles: 10, legDistribution: null } : drivingMeasurement();
        } },
        '../../shared/finalNeighborhoodReview.js': { reviewFinalNeighborhoodRoute: async (properties, options) => {
            calls.events.push('global-review');
            calls.globalReview.push({ properties, options });
            return finalReview ? finalReview(properties, options) : { properties, diagnostics: { applied: false } };
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
        '../../shared/roadCostCache.js': { createRoadCostCache: config => {
            calls.roadCosts.push(config); return { ...config, stats: () => ({}) };
        } },
        '../../shared/roadLegDistribution.js': legDistribution,
        '../../shared/routeDisplayGeometry.js': routeDisplayGeometry,
        '../../shared/routeMetricMemo.js': { createMemoizedRouteMetrics: metrics => metrics },
        '../../shared/routeAccessRecovery.js': { recoverRouteVehicleAccess: async (properties, options) => {
            calls.events.push('recovery'); calls.recovery.push({ properties, options });
            return recover ? recover(properties, options) : { properties, report: readyReport() };
        } },
        '../../shared/localDrivingNeighborhoods.js': { reviewLocalDrivingNeighborhoods: async (properties, options) => {
            calls.events.push('local'); calls.local.push({ properties, options });
            return local ? local(properties, options) : { properties, diagnostics: { applied: false, validation: 'unchanged' } };
        } },
        '../../shared/countyRoadRouting.js': { createCountyRoadRoutingAdapter: (properties, config) => {
            const adapter = { graphIdentity: '', fetchJson: (...args) => config.fetchJson(...args),
                vehicleFetch: async (url, options) => ({ ok: true,
                    json: async () => adapter.fetchJson(url, options) }),
                stats: () => ({ networks: 0, localSpeedMph: 15 }) };
            calls.county.push({ properties, config, adapter }); return adapter;
        } },
        '../../shared/completeDrivingVerification.js': { verifyCompleteDrivingCandidate: async input => {
            calls.events.push('complete-driving-verification'); calls.completeVerification.push(input);
            if (verify) return verify(input, calls.completeVerification.length - 1);
            const applied = JSON.stringify(ids(input.candidateOrder)) !== JSON.stringify(ids(input.baselineOrder));
            return { properties: input.candidateOrder, measurement: drivingMeasurement(), baseline: drivingMeasurement(),
                applied, keptCurrent: !applied, diagnostics: { ...input.neighborhood?.diagnostics, applied,
                    local_driving_review: { ...input.neighborhood?.diagnostics?.local_driving_review,
                        applied, validation: 'whole_route' } } };
        } },
        '../../shared/routeCandidateSelection.js': { ...candidateSelection, selectBestRouteCandidate: candidates => {
            calls.candidateComparison++;
            return winner ? winner(candidates) : candidateSelection.selectBestRouteCandidate(candidates);
        } },
    };
    const exports = {};
    vm.runInNewContext(compiled, {
        exports, require: name => {
            assert.ok(modules[name], `Unexpected optimizer module ${name}`);
            return modules[name];
        }, Response, Request, URL, console: { info() {}, warn() {}, error() {} },
    }, { filename: 'optimizeRouteRoadMatrix/entry.ts' });
    return { calls, async invoke(properties, request = {}) {
        const response = await exports.default({ json: async () => ({ properties: structuredClone(properties), ...request }) });
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
    assert.equal(calls.recovery[0].options.enableMappedDrivewayRecovery, true);
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
    assert.equal(reviewed.options.shortDrivingCleanup, true);
    assert.equal(reviewed.properties[3].order_locked, true);
    assert.equal(reviewed.properties[6].routing_access.resolution_status, 'unresolved');
    assert.equal(calls.matrix.length, 0); assert.equal(calls.hierarchy, 0); assert.equal(calls.sweep, 0);
    assert.equal(calls.candidateComparison, 0); assert.equal(calls.globalReview.length, 0);
    assert.equal(calls.completeVerification.length, 0, 'unresolved access bypasses the complete-route proof gate');
    assert.equal(calls.continuity.length, 0, 'unresolved access must not spend work generating global reshuffles');
    const expected = ids(properties); [expected[0], expected[1]] = [expected[1], expected[0]];
    assert.deepEqual(body.order, expected);
    for (const i of [3, 4, 5, 6, 7, 8]) assert.equal(body.order[i], properties[i].address_hash);
    assert.equal(body.routing_metadata.exact_once_verified, true);
    assert.equal(body.routing_metadata.road_path_validated, false);
    assert.equal(body.routing_metadata.input_measured, null);
    assert.equal(body.routing_metadata.winning_route_distance, null);
});

test('partial responses bind continuation to the public graph observed during local review', async () => {
    const properties = inputStops();
    const f = endpoint({ recover: unresolvedRecovery, local: submitted => {
        f.calls.county[0].adapter.stats = () => ({ networks: 0, localSpeedMph: 15,
            graphIdentity: '', publicDataVersion: 'live-public-graph' });
        return partialImprovement(submitted);
    } });
    const { body } = await f.invoke(properties);
    assert.equal(body.routing_metadata.county_road_routing.publicDataVersion, 'live-public-graph');
    assert.equal(body.routing_metadata.county_road_routing.graphIdentity, '');
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
    assert.equal(calls.county.length + calls.completeVerification.length, 0);
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

test('resolved routes send one county adapter through matrix, path, neighborhood, and complete driving checks', async () => {
    const properties = inputStops();
    const { calls, invoke } = endpoint();
    const { status, body } = await invoke(properties);
    assert.equal(status, 200); assert.equal(body.success, true);
    assert.equal(calls.county.length, 1); assert.equal(calls.completeVerification.length, 1);
    const { adapter, config } = calls.county[0];
    assert.equal(adapter.graphIdentity, '');
    assert.deepEqual(ids(calls.county[0].properties), ids(properties));
    assert.equal(config.baseUrl, 'https://roads.test'); assert.equal(config.profile, 'driving');
    assert.equal(calls.roadCosts[0].graphIdentity, '');
    assert.equal(calls.matrix[0].options.fetchJson, adapter.fetchJson);
    assert.equal(calls.globalReview[0].options.vehicleFetch, adapter.vehicleFetch);
    assert.equal(calls.globalReview[0].options.shortDrivingCleanup, true);
    assert.equal(calls.completeVerification[0].options.vehicleFetch, adapter.vehicleFetch);
    assert.deepEqual(ids(calls.completeVerification[0].baselineOrder), ids(properties));
    await calls.roadCosts[0].measurePath(properties, { timeoutMs: 1234 });
    assert.equal(calls.paths.at(-1).options.fetchJson, adapter.fetchJson);
    assert.equal(calls.paths.at(-1).options.timeoutMs, 1234);
    assert.equal(body.routing_metadata.road_path_validated, true);
    assert.equal(body.routing_metadata.distance_estimate, 'road_measured');
    assert.equal(body.routing_metadata.neighborhood_excursion_review.local_driving_review.validation, 'whole_route');
    assert.equal(body.routing_metadata.road_matrix_source, 'osrm:driving');
});

test('hierarchical driving review receives the bounded final cleanup flag before complete verification', async () => {
    const { calls, invoke } = endpoint({ planTier: 'cluster' });
    const { status, body } = await invoke(inputStops());
    assert.equal(status, 200); assert.equal(body.success, true);
    assert.equal(calls.hierarchy, 1); assert.equal(calls.matrix.length, 0, 'hierarchical success does not fall through to the door matrix');
    assert.equal(calls.globalReview.length, 1);
    assert.equal(calls.globalReview[0].options.vehicleProfile, 'driving');
    assert.equal(calls.globalReview[0].options.shortDrivingCleanup, true);
    assert.equal(calls.completeVerification.at(-1).options.shortDrivingCleanup, true);
    assert.equal(body.routing_metadata.strategy, 'road_hierarchy_cluster_exact_door_matrix');
    assert.equal(body.routing_metadata.road_path_validated, true);
});

test('walking review does not enable driving cleanup or invoke the driving verifier', async () => {
    const { calls, invoke } = endpoint();
    const { status, body } = await invoke(inputStops(), { profile: 'walking' });
    assert.equal(status, 200); assert.equal(body.success, true);
    assert.equal(calls.globalReview.length, 1);
    assert.equal(calls.globalReview[0].options.vehicleProfile, 'walking');
    assert.equal(calls.globalReview[0].options.shortDrivingCleanup, false);
    assert.equal(calls.recovery.length, 0); assert.equal(calls.completeVerification.length, 0);
    assert.equal(body.routing_metadata.road_path_validated, false);
});

test('a continuous driving gate can adopt a changed local order using measured candidate and baseline totals', async () => {
    const properties = inputStops();
    const { calls, invoke } = endpoint({ finalReview: submitted => {
        const proposal = partialImprovement(submitted);
        return { properties: proposal.properties, diagnostics: { applied: true, local_driving_review: proposal.diagnostics } };
    }, verify: input => ({ properties: input.candidateOrder, measurement: drivingMeasurement(90, 2400),
        baseline: drivingMeasurement(100, 3000), applied: true, keptCurrent: false,
        diagnostics: { ...input.neighborhood.diagnostics, applied: true,
            local_driving_review: { ...input.neighborhood.diagnostics.local_driving_review,
                applied: true, validation: 'whole_route' } } }) });
    const { body } = await invoke(properties);
    const expected = ids(properties); [expected[0], expected[1]] = [expected[1], expected[0]];
    assert.equal(calls.completeVerification.length, 1);
    assert.deepEqual(ids(calls.completeVerification[0].baselineOrder), ids(properties));
    assert.deepEqual(ids(calls.completeVerification[0].candidateOrder), expected);
    assert.deepEqual(body.order, expected); assert.equal(body.selected, 'road_aware');
    assert.equal(body.routing_metadata.input_measured, 100);
    assert.equal(body.routing_metadata.winning_route_distance, 90);
    assert.equal(body.routing_metadata.duration_improvement, 10);
    assert.equal(body.routing_metadata.road_path_validated, true);
});

const differentMatrixWinner = candidates => {
    const current = candidates.find(candidate => candidate.is_current);
    const order = [...current.order]; [order[4], order[5]] = [order[5], order[4]];
    return { ...current, order, type: 'road_aware', is_current: false, distance: 80, duration: 35 };
};
const proof = (input, { applied, miles = 90, seconds = 2400 } = {}) => ({
    properties: applied ? input.candidateOrder : input.baselineOrder,
    measurement: drivingMeasurement(applied ? miles : 100, applied ? seconds : 3000),
    baseline: drivingMeasurement(100, 3000), applied, keptCurrent: !applied,
    diagnostics: { ...input.neighborhood?.diagnostics, applied,
        local_driving_review: { ...input.neighborhood?.diagnostics?.local_driving_review,
            applied, validation: 'whole_route', status: applied ? 'whole_route_verified' : 'whole_route_guard_retained' } },
});

test('a rejected global matrix winner cannot consume the incumbent neighborhood budget or discard its valid repair', async () => {
    const properties = inputStops();
    const { calls, invoke } = endpoint({ winner: differentMatrixWinner,
        finalReview: submitted => {
            assert.deepEqual(ids(submitted), ids(properties), 'the bad global order must be discarded before neighborhood review');
            const repaired = partialImprovement(submitted);
            return { properties: repaired.properties, diagnostics: { applied: true, local_driving_review: repaired.diagnostics } };
        }, verify: (input, index) => {
            if (index === 0) {
                assert.equal(input.neighborhood, undefined);
                assert.notDeepEqual(ids(input.candidateOrder), ids(properties));
                return proof(input, { applied: false });
            }
            assert.ok(input.neighborhood, 'the final proof receives the neighborhood repair');
            return proof(input, { applied: true });
        } });
    const { status, body } = await invoke(properties);
    const expected = ids(properties); [expected[0], expected[1]] = [expected[1], expected[0]];
    assert.equal(status, 200); assert.equal(body.success, true);
    assert.equal(calls.globalReview.length, 1);
    assert.equal(calls.completeVerification.length, 2);
    assert.ok(calls.events.indexOf('complete-driving-verification') < calls.events.indexOf('global-review'));
    assert.equal(calls.completeVerification[0].options.vehicleFetch, calls.county[0].adapter.vehicleFetch);
    assert.equal(calls.completeVerification[1].options.vehicleFetch, calls.county[0].adapter.vehicleFetch);
    assert.deepEqual(ids(calls.globalReview[0].options.baselineOrder), ids(properties));
    assert.deepEqual(ids(calls.completeVerification[1].candidateOrder), expected);
    assert.deepEqual(body.order, expected); assert.equal(body.selected, 'road_aware');
    assert.equal(body.order[3], properties[3].address_hash);
    assert.equal(body.routing_metadata.exact_once_verified, true);
    assert.equal(body.routing_metadata.input_measured, 100);
    assert.equal(body.routing_metadata.winning_route_distance, 90);
    assert.equal(body.routing_metadata.global_candidate_verification, 'incumbent_retained');
    assert.equal(body.routing_metadata.road_path_validated, true);
});

test('a better complete global proposal receives neighborhood review and retains its proof in the final measured result', async () => {
    const properties = inputStops();
    const expected = ids(properties); [expected[4], expected[5]] = [expected[5], expected[4]];
    const { calls, invoke } = endpoint({ winner: differentMatrixWinner,
        finalReview: submitted => {
            assert.deepEqual(ids(submitted), expected);
            return { properties: submitted, diagnostics: { applied: false, checked: 1, repaired: 0 } };
        }, verify: input => proof(input, { applied: true, miles: 80, seconds: 2100 }) });
    const { status, body } = await invoke(properties);
    assert.equal(status, 200); assert.equal(body.success, true);
    assert.equal(calls.completeVerification.length, 2);
    assert.equal(calls.completeVerification[0].neighborhood, undefined);
    assert.deepEqual(ids(calls.completeVerification[0].baselineOrder), ids(properties));
    assert.deepEqual(ids(calls.completeVerification[0].candidateOrder), expected);
    assert.deepEqual(ids(calls.globalReview[0].properties), expected);
    assert.deepEqual(ids(calls.completeVerification[1].candidateOrder), expected);
    assert.deepEqual(body.order, expected); assert.equal(body.selected, 'road_aware');
    assert.equal(body.routing_metadata.input_measured, 100);
    assert.equal(body.routing_metadata.winning_route_distance, 80);
    assert.equal(body.routing_metadata.global_candidate_verification, 'accepted');
    assert.equal(body.routing_metadata.duration_improvement, 15);
    assert.equal(body.routing_metadata.neighborhood_excursion_review.local_driving_review.validation, 'whole_route');
});

test('a failed global complete-driving precheck cannot start local search or return a verified proposed order', async () => {
    const { calls, invoke } = endpoint({ winner: differentMatrixWinner,
        verify: () => { throw new Error('Driving provider graph identity changed.'); } });
    const { status, body } = await invoke(inputStops());
    assert.equal(status, 500);
    assert.equal(calls.completeVerification.length, 1);
    assert.equal(calls.globalReview.length, 0);
    assert.equal('order' in body, false);
    assert.notEqual(body.success, true);
    assert.notEqual(body.routing_metadata?.road_path_validated, true);
});

test('a worse final driving candidate retains the complete measured incumbent without a partial-failure warning', async () => {
    const properties = inputStops();
    const { calls, invoke } = endpoint({ finalReview: submitted => {
        const proposal = partialImprovement(submitted);
        return { properties: proposal.properties, diagnostics: { applied: true, local_driving_review: proposal.diagnostics } };
    }, verify: input => ({ properties: input.baselineOrder, measurement: drivingMeasurement(100, 3000),
        baseline: drivingMeasurement(100, 3000), applied: false, keptCurrent: true,
        diagnostics: { ...input.neighborhood.diagnostics, applied: false,
            local_driving_review: { applied: false, repaired: 1, status: 'whole_route_guard_retained',
                validation: 'whole_route', reason: null } } }) });
    const { body } = await invoke(properties);
    assert.equal(calls.completeVerification.length, 1);
    assert.equal(body.selected, 'current'); assert.deepEqual(body.order, ids(properties));
    assert.equal(body.routing_metadata.input_measured, 100);
    assert.equal(body.routing_metadata.winning_route_distance, 100);
    assert.equal(body.routing_metadata.duration_improvement, 0);
    assert.equal(body.routing_metadata.road_path_validated, true);
    assert.equal(body.routing_metadata.neighborhood_excursion_review.applied, false);
    assert.equal(body.routing_metadata.neighborhood_excursion_review.local_driving_review.validation, 'whole_route');
});

test('an unchanged order with zero neighborhood repairs still receives complete driving verification', async () => {
    const { calls, invoke } = endpoint();
    const properties = inputStops();
    const { body } = await invoke(properties);
    assert.equal(calls.globalReview.length, 1);
    assert.equal(calls.completeVerification.length, 1);
    assert.equal(calls.completeVerification[0].neighborhood.diagnostics.applied, false);
    assert.equal(body.selected, 'current'); assert.deepEqual(body.order, ids(properties));
    assert.equal(body.routing_metadata.road_path_validated, true);
    assert.equal(body.routing_metadata.input_measured, 100);
    assert.equal(body.routing_metadata.winning_route_distance, 100);
    assert.equal(body.routing_metadata.neighborhood_excursion_review.local_driving_review.validation, 'whole_route');
    assert.equal(body.routing_metadata.global_candidate_verification, 'not_required');
});

test('a failed complete driving check returns no order and preserves recovered access for the next attempt', async () => {
    const properties = inputStops();
    const access = { resolution_status: 'resolved', source: 'address_geocode_recovery',
        point: { lat: 35.0005, lng: -80.9995 }, displayPoint: { lat: properties[1].lat, lng: properties[1].lng } };
    const report = { ...readyReport(), status: 'recovered', attempted: 1, recovered: 1,
        access_overrides: { [properties[1].address_hash]: access } };
    const { calls, invoke } = endpoint({ recover: submitted => ({ properties: submitted, report }),
        verify: () => { throw new Error('Final continuous driving verification failed.'); } });
    const { status, body } = await invoke(properties);
    assert.equal(calls.completeVerification.length, 1);
    assert.equal(status, 500);
    assert.equal('order' in body, false);
    assert.notEqual(body.success, true);
    assert.match(body.error, /continuous driving verification failed/);
    assert.deepEqual(body.routing_metadata.road_access_recovery.access_overrides, report.access_overrides);
    assert.notEqual(body.routing_metadata.road_path_validated, true);
});

test('access inspection retains authentication and input guards while collecting diagnostics without running a solver', async () => {
    const properties = inputStops();
    const unauthorized = endpoint({ authenticated: false });
    const blocked = await unauthorized.invoke(properties, { inspect_access_only: true });
    assert.equal(blocked.status, 401);
    assert.equal(blocked.body.error, 'Unauthorized');
    assert.equal(unauthorized.calls.recovery.length, 0);

    const invalidCoordinates = properties.map((property, index) => index === 2 ? { ...property, lat: 95 } : property);
    const duplicates = properties.map((property, index) => index === 2 ? { ...property, address_hash: properties[0].address_hash } : property);
    const tooMany = Array.from({ length: 2501 }, (_, index) => ({ ...properties[0], address_hash: `unique-${index}` }));
    for (const [invalid, code] of [[properties.slice(0, 1), 'TOO_FEW_PROPERTIES'],
        [tooMany, 'TOO_MANY_PROPERTIES'], [invalidCoordinates, 'INVALID_PROPERTY_COORDINATES'], [duplicates, 'DUPLICATE_PROPERTIES']]) {
        const guarded = endpoint();
        const result = await guarded.invoke(invalid, { inspect_access_only: true });
        assert.equal(result.status, 400); assert.equal(result.body.code, code);
        assert.equal(guarded.calls.recovery.length, 0, `${code} must stop before diagnostic recovery`);
    }

    const report = { ...readyReport(), county_diagnostics: [{ stop_number: 3, service: 'county_roads',
        stage: 'response', httpStatus: 200, featureCount: 12 }] };
    const inspection = endpoint({ recover: (submitted, options) => {
        assert.equal(options.collectCountyDiagnostics, true);
        return { properties: submitted, report };
    } });
    const { status, body } = await inspection.invoke(properties, { inspect_access_only: true });
    assert.equal(status, 200); assert.equal(body.success, true);
    assert.deepEqual(body.road_access_recovery, report);
    assert.equal(typeof body.elapsed_ms, 'number');
    assert.equal(inspection.calls.recovery.length, 1);
    assert.equal('order' in body, false, 'inspection is not an optimization result');
    assert.equal(inspection.calls.plan.length + inspection.calls.matrix.length + inspection.calls.paths.length
        + inspection.calls.county.length + inspection.calls.local.length + inspection.calls.globalReview.length
        + inspection.calls.completeVerification.length + inspection.calls.continuity.length
        + inspection.calls.sweep + inspection.calls.hierarchy + inspection.calls.candidateComparison, 0);
});

const coverageReport = () => ({ version: 1, policy: 'entry_branch_return_v7_search_coverage',
    completed_window_keys: ['a'.repeat(32), 'b'.repeat(32)], total_windows: 3, remaining_windows: 1,
    checked_this_pass: 1, progress_this_pass: 1, cycle_complete: false });

for (const planTier of ['door', 'cluster']) {
    test(`unchanged ${planTier} driving responses carry scheduling coverage only at top-level metadata`, async () => {
        const properties = inputStops(), history = coverageReport(), report = coverageReport();
        const f = endpoint({ planTier, winner: candidates => candidates.find(candidate => candidate.is_current),
            finalReview: (submitted, options) => {
                assert.equal(JSON.stringify(options.searchCoverage), JSON.stringify(history));
                return { properties: submitted, searchCoverage: report, diagnostics: { applied: false,
                    local_driving_review: { applied: false, validation: 'unchanged' } } };
            } });
        const { status, body } = await f.invoke(properties, { search_coverage: history });
        assert.equal(status, 200);
        assert.deepEqual(body.order, ids(properties));
        assert.deepEqual(body.routing_metadata.road_search_coverage, report);
        assert.equal(JSON.stringify(body.routing_metadata.neighborhood_excursion_review).includes('completed_window_keys'), false);
        assert.equal(f.calls.globalReview.length, 1);
        assert.equal(f.calls.completeVerification.length, 1);
    });
}

test('access-limited incumbent search forwards coverage and returns the ledger outside neighborhood diagnostics', async () => {
    const history = coverageReport(), report = coverageReport();
    const f = endpoint({ recover: unresolvedRecovery, local: (submitted, options) => {
        assert.equal(JSON.stringify(options.searchCoverage), JSON.stringify(history));
        return { properties: submitted, searchCoverage: report,
            diagnostics: { applied: false, validation: 'unchanged' } };
    } });
    const { status, body } = await f.invoke(inputStops(), { search_coverage: history });
    assert.equal(status, 200);
    assert.deepEqual(body.routing_metadata.road_search_coverage, report);
    assert.equal(JSON.stringify(body.routing_metadata.neighborhood_excursion_review).includes('completed_window_keys'), false);
});

test('final driving rejection cannot attach completion history for a different proposed order', async () => {
    const properties = inputStops(), report = { ...coverageReport(), total_windows: 2, remaining_windows: 0, cycle_complete: true };
    const f = endpoint({ winner: candidates => candidates.find(candidate => candidate.is_current),
        finalReview: submitted => {
            const proposed = [...submitted];
            [proposed[1], proposed[2]] = [proposed[2], proposed[1]];
            return { properties: proposed, searchCoverage: report, diagnostics: { applied: true,
                local_driving_review: { applied: true, validation: 'whole_route' } } };
        },
        verify: input => ({ properties: input.baselineOrder, measurement: drivingMeasurement(), baseline: drivingMeasurement(),
            applied: false, keptCurrent: true, diagnostics: { applied: false,
                local_driving_review: { applied: false, validation: 'whole_route' } } }) });
    const { status, body } = await f.invoke(properties);
    assert.equal(status, 200);
    assert.deepEqual(body.order, ids(properties));
    assert.equal('road_search_coverage' in body.routing_metadata, false);
});

test('an unproved partial proposal cannot attach completion history for its discarded order', async () => {
    const properties = inputStops();
    const f = endpoint({ recover: unresolvedRecovery, local: submitted => ({ properties: [...submitted].reverse(),
        searchCoverage: { ...coverageReport(), remaining_windows: 0, cycle_complete: true },
        diagnostics: { applied: false, validation: 'unchanged' } }) });
    const { status, body } = await f.invoke(properties);
    assert.equal(status, 200);
    assert.deepEqual(body.order, ids(properties));
    assert.equal('road_search_coverage' in body.routing_metadata, false);
});
