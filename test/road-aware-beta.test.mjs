import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { compareRoadAwareBeta } from '../base44/shared/roadAwareBetaOptimizer.js';
import { createRoadAwareBetaHandler } from '../base44/shared/roadAwareBetaService.js';
import { assertRoadBetaProxyRequest } from '../base44/shared/roadAwareBetaPolicy.js';
import { routePropertyOrderFingerprint } from '../base44/shared/routeFingerprint.js';
import { verifiedBetaSegments } from '../src/lib/roadAwareRouteGeometry.js';
import { completeServerRoadAwareRoutes } from '../base44/shared/roadAwareBetaServer.js';

const graph = 'a'.repeat(64), version = 'frozen';
const config = { eligible: true, enabled: true, available: true, fingerprint: graph, dataVersion: version, workspaceId: 'owner' };
const stops = (count = 4) => Array.from({ length: count }, (_, i) => ({
    address_hash: String(i), street_name: 'Main St', lat: 35, lng: -81 + i / 100000 }));
const partition = (run, limit) => Array.from({ length: Math.ceil(run.length / limit) }, (_, i) => run.slice(i * limit, (i + 1) * limit));
const proposal = run => run.length === 4 ? [run[0], run[2], run[1], run[3]] : [...run].reverse();
const continuityFor = () => ({});
function roadEngine({ fail = false, worse = false, unmatched = new Set() } = {}) {
    const requests = [];
    const fetch = async input => {
        const url = new URL(input); requests.push(url);
        if (fail) return Response.json({ code: 'Unavailable' }, { status: 503 });
        const coordinates = url.pathname.split('/').at(-1).split(';').map(p => p.split(',').map(Number));
        const index = p => Math.round((p[0] + 81) * 100000);
        const cost = (a, b) => index(a) + 1 === index(b) ? 40 : worse ? 80 : 10;
        const waypoints = coordinates.map(location => ({ location, distance: 0 }));
        const data = { code: 'Ok', data_version: version, build_fingerprint: graph };
        if (url.pathname.includes('/nearest/')) {
            if (unmatched.has(String(index(coordinates[0])))) return Response.json({ code: 'NoSegment' }, { status: 422 });
            data.waypoints = waypoints;
        } else if (url.pathname.includes('/table/')) {
            const sources = url.searchParams.get('sources').split(';').map(Number);
            const destinations = url.searchParams.get('destinations').split(';').map(Number);
            data.sources = sources.map(i => waypoints[i]); data.destinations = destinations.map(i => waypoints[i]);
            data.durations = sources.map(a => destinations.map(b => a === b ? 0 : cost(coordinates[a], coordinates[b])));
            data.distances = data.durations.map(row => row.map(v => v * 10));
        } else {
            const legs = coordinates.slice(1).map((p, i) => ({ duration: cost(coordinates[i], p), distance: cost(coordinates[i], p) * 10,
                steps: [{ geometry: { coordinates: [coordinates[i], p] }, maneuver: { modifier: 'straight' } }] }));
            data.waypoints = waypoints;
            data.routes = [{ duration: legs.reduce((s, l) => s + l.duration, 0), distance: legs.reduce((s, l) => s + l.distance, 0),
                legs, geometry: { coordinates } }];
        }
        return Response.json(data);
    };
    return { fetch, requests };
}
const runKernel = (properties, engine = roadEngine(), overrides = {}) => compareRoadAwareBeta(properties, {
    provider: { ...config, baseUrl: 'https://private.example', fetch: engine.fetch },
    propose: proposal, partitionRun: partition, continuityFor, ...overrides });

function workspace({ enabled = true, outside = false, engine = roadEngine() } = {}) {
    const user = { id: outside ? 'other' : 'owner', email: outside ? 'other@example.com' : 'invisibleontheblockchain@gmail.com' };
    const settings = enabled ? [{ id: 'settings', manager_id: 'owner', enabled: true }] : [];
    const comparisons = [], writes = [];
    let route = { id: 'route', manager_id: user.id, property_hashes: stops().map(p => p.address_hash),
        assigned_to: 'rep', status: 'ACTIVE', name: 'Test', updated_date: 'v1', metadata: { campaign: 'October' }, metrics: { distance: 5 } };
    const entities = {
        User: { get: async () => user }, TeamMember: { filter: async () => [] },
        RoadAwareRoutingBetaSettings: { filter: async () => structuredClone(settings),
            create: async value => { settings.push({ id: 'settings', ...value }); }, update: async (_id, value) => Object.assign(settings[0], value) },
        RoadAwareRoutingComparison: { filter: async () => structuredClone(comparisons), get: async id => structuredClone(comparisons.find(c => c.id === id)),
            create: async value => { const row = { id: 'comparison-' + comparisons.length, ...structuredClone(value) }; comparisons.push(row); return row; },
            update: async (id, value) => Object.assign(comparisons.find(c => c.id === id), value) },
        SavedRoute: { get: async () => structuredClone(route), update: async (_id, value) => {
            writes.push(structuredClone(value)); route = { ...route, ...value, updated_date: 'v' + (writes.length + 1) }; return structuredClone(route);
        } },
    };
    const secrets = { ROAD_AWARE_OSRM_BASE_URL: 'https://private.example', ROAD_AWARE_OSRM_BUILD_FINGERPRINT: graph,
        ROAD_AWARE_OSRM_DATA_VERSION: version, ROAD_AWARE_OSRM_GATEWAY_TOKEN: 'test-server-secret' };
    const sdk = { auth: { me: async () => user }, entities, asServiceRole: { entities } };
    const handler = createRoadAwareBetaHandler({ createClient: () => sdk, readSecret: name => secrets[name] || '', fetchImpl: engine.fetch });
    const call = async body => {
        const response = await handler(new Request('https://app.example/route-beta', { method: 'POST', body: JSON.stringify(body) }));
        return { status: response.status, data: await response.json() };
    };
    const client = { ...sdk, functions: { invoke: async (_name, body) => {
        const response = await call(body);
        if (response.status >= 400) throw Object.assign(new Error(response.data.error || 'Provider error'),
            { response: { status: response.status, data: response.data } });
        return { data: response.data };
    } } };
    return { client, sdk, call, writes, comparisons, secrets, getRoute: () => route, setRoute: value => { route = value; } };
}

let vite, beta, preview;
before(async () => {
    process.env.VITE_BASE44_APP_ID = 'routing-beta-test';
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    beta = await vite.ssrLoadModule('/src/lib/roadAwareRoutingBeta.js');
    preview = await vite.ssrLoadModule('/src/lib/previewSavedRoadAwareBeta.js');
});
after(async () => { await vite?.close(); delete process.env.VITE_BASE44_APP_ID; });

test('beta OFF preserves the exact production route object and makes no road calls', async () => {
    const mock = workspace({ enabled: false });
    const routes = [{ properties: stops(), metadata: { existing: true } }];
    assert.equal(await beta.completeBetaGeneratedRoutes(routes, { client: mock.client }), routes);
    assert.equal(await beta.prepareRoadAwareBetaComparison(stops(), { client: mock.client }), null);
    assert.equal(mock.writes.length, 0); assert.equal(mock.comparisons.length, 0);
});
test('another workspace cannot opt in, proxy, record, apply, or read cohort history', async () => {
    const mock = workspace({ outside: true });
    const status = (await mock.call({ action: 'status', workspace_id: 'owner', enabled: true })).data;
    assert.equal(status.enabled, false); assert.equal(status.eligible, false);
    for (const action of ['set_enabled', 'proxy', 'record', 'history', 'apply', 'restore']) {
        assert.equal((await mock.call({ action, enabled: true, workspace_id: 'owner' })).status, 403);
    }
    const routes = [{ properties: stops() }];
    assert.equal(await beta.completeBetaGeneratedRoutes(routes, { client: mock.client }), routes);
});
test('beta ON uses directed road evidence and persists complete comparison telemetry', async () => {
    const mock = workspace();
    const result = await beta.prepareRoadAwareBetaComparison(stops(), { client: mock.client, routeId: 'route',
        propose: proposal, partitionRun: partition, continuityFor, entryPoint: 'saved_route_optimize' });
    assert.deepEqual(result.comparison.afterOrder, ['0', '2', '1', '3']);
    assert.equal(result.comparison.guard, 'road_aware'); assert.equal(result.comparison.acceptedRegressions, 0);
    assert.equal(result.metadata.routing.access_match_meters, 100);
    assert.equal(mock.comparisons[0].manager_id, 'owner'); assert.equal(mock.comparisons[0].route_id, 'route');
    assert.equal(mock.comparisons[0].entry_point, 'saved_route_optimize');
    assert.ok(result.comparison.secondsSaved > 0 && result.comparison.milesSaved > 0);
    assert.equal(mock.writes.length, 0);
});
test('worse raw proposal retains legacy and cannot increase either accepted metric', async () => {
    const properties = stops(), result = await runKernel(properties, roadEngine({ worse: true }));
    assert.deepEqual(result.properties, properties); assert.equal(result.comparison.guard, 'legacy_guard');
    assert.ok(result.comparison.rawProposal.seconds > result.comparison.before.seconds);
    assert.deepEqual(result.comparison.after, result.comparison.before);
});
test('giant Home route uses bounded guarded windows and preserves uncertain access indices', async () => {
    const properties = stops(605), engine = roadEngine({ unmatched: new Set(['290']) });
    const result = await runKernel(properties, engine);
    assert.ok(result.comparison.optimizationWindows >= 2);
    assert.ok(result.comparison.improvedWindows > 0); assert.equal(result.properties[290], properties[290]);
    assert.equal(result.comparison.unresolvedCount, 1); assert.equal(result.comparison.fullMeasurement, false);
    assert.equal(result.metadata.road_geometry, null);
    assert.equal(result.comparison.acceptedRegressions, 0);
    assert.deepEqual(result.properties.map(p => p.address_hash).sort(), properties.map(p => p.address_hash).sort());
    for (const request of engine.requests) {
        assert.ok(request.searchParams.get('radiuses').split(';').every(r => r === '100'));
        if (request.pathname.includes('/route/')) assert.ok(request.pathname.split('/').at(-1).split(';').length <= 502);
    }
});
test('unsupported coverage, provider failure, and unknown graph cannot fabricate eligibility', async () => {
    const properties = stops(), failed = await runKernel(properties, roadEngine({ fail: true }));
    assert.deepEqual(failed.properties, properties); assert.equal(failed.comparison.before, null);
    assert.equal(failed.comparison.guard, 'legacy_fallback');
    const engine = roadEngine();
    const outside = await runKernel(properties.map(p => ({ ...p, lat: 0 })), engine);
    assert.equal(outside.comparison.reason, 'OUTSIDE_GRAPH_COVERAGE'); assert.equal(engine.requests.length, 0);
});
test('preview and Keep Current never write SavedRoute; accepting persists exact order and matching geometry', async () => {
    const mock = workspace(), route = mock.getRoute();
    const buildUpdate = result => ({ property_hashes: result.comparison.afterOrder, metadata: result.metadata,
        route_origin_mode: 'none', metrics: { house_count: 4, distance: result.distanceMiles } });
    const pending = await beta.prepareRoadAwareBetaComparison(stops(), { client: mock.client, routeId: 'route',
        propose: proposal, partitionRun: partition, continuityFor });
    assert.equal(mock.writes.length, 0);
    await beta.keepRoadAwareBetaCurrent(pending, mock.client);
    assert.equal(mock.writes.length, 0); assert.deepEqual(mock.getRoute(), route);
    const next = await beta.prepareRoadAwareBetaComparison(stops(), { client: mock.client, routeId: 'route',
        propose: proposal, partitionRun: partition, continuityFor });
    await beta.applyRoadAwareBetaComparison(next, buildUpdate(next), mock.client);
    assert.deepEqual(mock.getRoute().property_hashes, ['0', '2', '1', '3']);
    assert.deepEqual(mock.getRoute().metadata.road_geometry, next.geometry.selected[0].points);
    assert.equal(mock.getRoute().assigned_to, 'rep'); assert.equal(mock.getRoute().status, 'ACTIVE');
    await beta.restoreRoadAwareBetaComparison(next.comparisonId, mock.client);
    assert.deepEqual(mock.getRoute().property_hashes, route.property_hashes);
    assert.deepEqual(mock.getRoute().metadata, route.metadata);
});
test('provider failure comparison preserves original route, membership, assignment, and geometry', async () => {
    const mock = workspace({ engine: roadEngine({ fail: true }) }), original = structuredClone(mock.getRoute());
    const result = await beta.prepareRoadAwareBetaComparison(stops(), { client: mock.client, routeId: 'route',
        propose: proposal, partitionRun: partition, continuityFor });
    assert.equal(result.comparison.changedStops, 0); assert.equal(result.comparison.guard, 'legacy_fallback');
    assert.deepEqual(mock.getRoute(), original); assert.equal(mock.writes.length, 0);
});
test('tampered membership, worse costs, stale geometry, stale route version, and changed graph fail before writes', async () => {
    const mock = workspace(), result = await runKernel(stops());
    for (const c of [{ ...result.comparison, afterOrder: ['0', '2', '1'] },
        { ...result.comparison, after: { miles: 10, seconds: 1 } }, { ...result.comparison, graphFingerprint: 'other' }]) {
        assert.equal((await mock.call({ action: 'record', route_id: 'route', comparison: c })).status, 409);
    }
    const row = (await mock.call({ action: 'record', route_id: 'route', comparison: result.comparison })).data;
    const update = { property_hashes: result.comparison.afterOrder, metadata: { ...result.metadata, road_geometry_segments: [{ points: stops() }] }, route_origin_mode: 'none' };
    assert.equal((await mock.call({ action: 'apply', comparison_id: row.id, route_update: update })).status, 409);
    mock.setRoute({ ...mock.getRoute(), updated_date: 'changed' });
    assert.equal((await mock.call({ action: 'apply', comparison_id: row.id, route_update: { ...update, metadata: result.metadata } })).status, 409);
    assert.equal(mock.writes.length, 0);
});
test('geometry consumers reject stale order and never join unknown gaps', async () => {
    const result = await runKernel(stops());
    assert.equal(verifiedBetaSegments(result.metadata, result.comparison.afterOrder).length, 1);
    assert.deepEqual(verifiedBetaSegments(result.metadata, result.comparison.beforeOrder), []);
    const metadata = { ...result.metadata, road_geometry: null, road_geometry_segments: [{ points: stops().slice(0, 2) }, { points: stops().slice(2) }] };
    assert.equal(verifiedBetaSegments(metadata, result.comparison.afterOrder).length, 2);
});
test('proxy enforces 100 m, national coverage, bounded table size, and no invented approaches', () => {
    const valid = { radiuses: '100;100', continue_straight: 'true', geometries: 'geojson' };
    assert.equal(assertRoadBetaProxyRequest('route', '-81,35;-80.99,35', valid).length, 2);
    for (const query of [{ ...valid, radiuses: '101;101' }, { ...valid, approaches: 'curb;curb' },
        { ...valid, bearings: '90,45;90,45' }, { ...valid, url: 'https://attacker.example' }]) {
        assert.throws(() => assertRoadBetaProxyRequest('route', '-81,35;-80.99,35', query));
    }
    assert.throws(() => assertRoadBetaProxyRequest('nearest', '-79.3832,43.6532', { radiuses: '100' }));
});
test('server completion OFF preserves canonical generation partitions and payloads exactly', async () => {
    const mock = workspace({ enabled: false }), routes = [{ properties: stops(), totalDistance: 5 }];
    assert.equal(await completeServerRoadAwareRoutes(routes, { client: mock.sdk, user: await mock.sdk.auth.me(),
        readSecret: key => mock.secrets[key] || '', entryPoint: 'backend_generation' }), routes);
});
test('saved preview workflow waits for an explicit decision and OFF reaches no comparison UI', async () => {
    const mock = workspace(), original = structuredClone(mock.getRoute());
    let choices = 0;
    const result = await preview.previewSavedRoadAwareBeta({ route: original, properties: stops(), client: mock.client,
        choose: async () => { choices++; assert.equal(mock.writes.length, 0); return false; },
        buildUpdate: () => { throw new Error('Keep Current must not build an update'); }, entryPoint: 'saved_route_optimize' });
    assert.equal(result.applied, false); assert.equal(choices, 1); assert.deepEqual(mock.getRoute(), original);
    const off = workspace({ enabled: false });
    assert.equal(await preview.previewSavedRoadAwareBeta({ route: off.getRoute(), properties: stops(), client: off.client,
        choose: () => { throw new Error('OFF must not show a comparison'); } }), null);
});
test('generated telemetry binds only to the saved route with its exact guarded manifest', async () => {
    const mock = workspace(), result = await runKernel(stops());
    const row = (await mock.call({ action: 'record', comparison: result.comparison, entry_point: 'home_generation' })).data;
    mock.setRoute({ ...mock.getRoute(), property_hashes: result.comparison.afterOrder,
        metadata: { ...result.metadata, road_aware_comparison_id: row.id } });
    await beta.bindBetaGeneratedRoutes(mock.getRoute(), mock.client);
    assert.equal(mock.comparisons[0].route_id, 'route'); assert.equal(mock.writes.length, 0);
    mock.setRoute({ ...mock.getRoute(), property_hashes: ['0', '1', '2', '3'] });
    assert.equal((await mock.call({ action: 'bind_generated', comparison_id: row.id, route_id: 'route' })).status, 409);
});
test('one outside-coverage stop is preserved while nearby windows remain eligible', async () => {
    const properties = stops(12); properties[6] = { ...properties[6], lat: 0 };
    const result = await runKernel(properties);
    assert.equal(result.properties[6], properties[6]); assert.equal(result.comparison.unresolvedCount, 1);
    assert.equal(result.comparison.optimizationWindows, 1); assert.equal(result.comparison.fullMeasurement, false);
});
test('server generation ON uses the same guard without changing route partitions, names, or bounds', async () => {
    const mock = workspace(), routes = [{ name: 'One visible route', properties: stops(8), totalDistance: 5 }];
    const result = await completeServerRoadAwareRoutes(routes, { client: mock.sdk, user: await mock.sdk.auth.me(),
        readSecret: key => mock.secrets[key] || '', entryPoint: 'backend_generation' });
    assert.equal(result.length, 1); assert.equal(result[0].name, routes[0].name);
    assert.deepEqual(result[0].properties.map(p => p.address_hash).sort(), routes[0].properties.map(p => p.address_hash).sort());
    assert.equal(result[0].metadata.routing.road_aware_routing_beta, true);
    assert.equal(mock.comparisons[0].entry_point, 'backend_generation');
});
test('status outage after workspace ON cannot silently return to an unguarded saved-route optimizer', async () => {
    const mock = workspace();
    await beta.getRoadAwareBetaStatus(mock.client);
    mock.client.functions.invoke = async () => { throw new Error('Status provider unavailable'); };
    await assert.rejects(preview.previewSavedRoadAwareBeta({ route: mock.getRoute(), properties: stops(), client: mock.client,
        choose: () => { throw new Error('No comparison can be adopted'); } }), /left unchanged/);
    assert.equal(mock.writes.length, 0);
    const routes = [{ properties: stops() }];
    assert.equal((await beta.applyRoadAwareBetaToGeneratedRoutes(routes, { client: mock.client })).routes, routes);
});

test('record completion preserves manifest aliases and never persists personal trip geometry', async () => {
    const mock = workspace(), properties = stops().map(p => ({ ...p, legacy_hash: 'legacy-' + p.address_hash }));
    const records = [{ property_hashes: properties.map(p => p.legacy_hash), metadata: { existing: true },
        route_origin_mode: 'current_to_home', assigned_to: 'rep', name: 'Keep me', metrics: { house_count: 4 } }];
    const off = workspace({ enabled: false });
    assert.equal(await beta.completeBetaRouteRecords(records, properties, { client: off.client }), records);
    const completed = await beta.completeBetaRouteRecords(records, properties, { client: mock.client });
    assert.deepEqual([...completed[0].property_hashes].sort(), [...records[0].property_hashes].sort());
    assert.equal(completed[0].metadata.routing.road_aware_routing_beta, true);
    assert.equal(completed[0].metadata.road_geometry, undefined);
    assert.equal(completed[0].metadata.road_geometry_segments, undefined);
    assert.equal(completed[0].assigned_to, 'rep'); assert.equal(completed[0].name, 'Keep me');
});

test('provider outage after an improved giant-route window retains the whole supplied order', async () => {
    const properties = stops(605), engine = roadEngine(); let measuredRoutes = 0;
    const fetch = async input => {
        const url = new URL(input);
        if (measuredRoutes >= 2 && url.pathname.includes('/table/')) return Response.json({ code: 'Unavailable' }, { status: 503 });
        if (url.pathname.includes('/route/')) measuredRoutes++;
        return engine.fetch(input);
    };
    const result = await runKernel(properties, { fetch });
    assert.ok(measuredRoutes >= 2);
    assert.deepEqual(result.properties, properties);
    assert.equal(result.comparison.guard, 'legacy_fallback'); assert.equal(result.comparison.changedStops, 0);
    assert.equal(result.comparison.before, null); assert.deepEqual(result.geometry.selected, []);
});

test('a failed decision write after apply reports the saved route accurately and retains its recovery snapshot', async () => {
    const mock = workspace(), result = await beta.prepareRoadAwareBetaComparison(stops(), { client: mock.client,
        routeId: 'route', propose: proposal, partitionRun: partition, continuityFor });
    mock.sdk.asServiceRole.entities.RoadAwareRoutingComparison.update = async () => { throw new Error('History write unavailable'); };
    const response = await beta.applyRoadAwareBetaComparison(result, { property_hashes: result.comparison.afterOrder,
        metadata: result.metadata, route_origin_mode: 'none' }, mock.client);
    assert.deepEqual(response.route.property_hashes, result.comparison.afterOrder);
    assert.match(response.history_warning, /New order saved/); assert.equal(mock.writes.length, 1);
    assert.deepEqual(mock.comparisons[0].original_route.property_hashes, result.comparison.beforeOrder);
});
