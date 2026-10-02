import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { isValidRoutePoint, calculateRouteDistanceMiles } from '../base44/shared/routeBounds.js';
import { optimizeAnchoredStreetRoute } from '../base44/shared/routeAnchorRouting.js';
import { normalizeRouteOriginMode, isRoundTripRouteOriginMode, routeAnchorMarkerLabels } from '../src/lib/routeOriginModes.js';
import { mergeAnchoredRoute } from '../src/lib/routeAnchorState.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const home = { address: '123 Private Base, Phoenix, AZ', lat: 33.45, lng: -112.075 };
const custom = { address: '456 Route Meeting Point, Phoenix, AZ', lat: 33.46, lng: -112.065 };
const properties = [
    { address_hash: 'a', lat: 33.451, lng: -112.074 },
    { address_hash: 'b', lat: 33.471, lng: -112.064 },
    { address_hash: 'c', lat: 33.461, lng: -112.074 },
];
function setup({ actor = 'manager', base = home, auto = true, verified = true, pending = false, missingDoor = false } = {}) {
    const users = {
        manager: { id: 'manager', app_role: 'manager', full_name: 'Manager' },
        rep: { id: 'rep', app_role: 'rep', team_manager_id: verified ? 'manager' : 'other', email: 'rep@example.com', home_base: base, home_base_auto_assign: auto },
        peer: { id: 'peer', app_role: 'rep', team_manager_id: 'manager', email: 'peer@example.com', home_base: { ...home, address: 'Peer secret' } },
        other: { id: 'other', app_role: 'manager' },
    };
    const members = {
        member: { id: 'member', user_id: pending ? null : 'rep', manager_id: 'manager', name: 'Rep', email: 'rep@example.com', status: 'active' },
        peerMember: { id: 'peerMember', user_id: 'peer', manager_id: 'manager', name: 'Peer', email: 'peer@example.com', status: 'active' },
        foreign: { id: 'foreign', user_id: 'peer', manager_id: 'other', name: 'Foreign', email: 'peer@example.com', status: 'active' },
    };
    const route = { id: 'route', name: 'Excel imported route', manager_id: 'manager', assigned_to: 'member', status: 'ACTIVE', route_origin_mode: 'none', property_hashes: ['b', 'a', 'c'], metadata: { source: 'import', road_geometry: [[0, 0]], routing: {} }, metrics: { house_count: 3, distance: 2 } };
    const records = [];
    const writes = [];
    let failUpdate = false;
    const service = { entities: {
        User: { get: async id => users[id], update: async (id, value) => { writes.push(['user', id, value]); Object.assign(users[id], value); } },
        TeamMember: { get: async id => members[id], filter: async query => Object.values(members).filter(member => member.manager_id === query.manager_id) },
        SavedRoute: { get: async id => id === route.id ? JSON.parse(JSON.stringify(route)) : null, update: async (id, value) => { if (failUpdate) throw new Error('write failed'); writes.push(['route', id, value]); Object.assign(route, value); } },
        RouteAnchor: {
            filter: async query => records.filter(record => record.route_id === query.route_id && record.manager_id === query.manager_id),
            create: async value => { const record = { ...value, id: `anchor${records.length + 1}` }; records.push(record); return record; },
            delete: async id => { const index = records.findIndex(record => record.id === id); if (index >= 0) records.splice(index, 1); },
        },
    } };
    const client = { auth: { me: async () => users[actor] }, asServiceRole: service, functions: { invoke: async (name, body) => {
        assert.equal(name, 'getRoutePropertiesByHashes'); assert.equal(body.route_id, 'route');
        return { data: { properties: properties.filter(property => body.address_hashes.includes(property.address_hash) && (!missingDoor || property.address_hash !== 'c')) } };
    } } };
    const source = ts.transpileModule(read('base44/functions/manageRepAnchors/entry.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*;\s*$/gm, '');
    let handler;
    vm.runInNewContext(source, { createClientFromRequest: () => client, isValidRoutePoint, optimizeAnchoredStreetRoute, calculateRouteDistanceMiles, console: { error() {} }, Request, Response, Deno: { serve: fn => { handler = fn; } } });
    async function call(body) {
        const response = await handler(new Request('https://app.example.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
        return { status: response.status, data: await response.json() };
    }
    return { call, route, records, writes, users, members, setFailUpdate: () => { failUpdate = true; } };
}

test('only managers can list and edit rep bases; other teams cannot assign routes', async () => {
    for (const actor of ['rep', 'peer', 'other']) {
        const state = setup({ actor });
        if (actor !== 'other') {
            assert.equal((await state.call({ action: 'list' })).status, 403);
            assert.equal((await state.call({ action: 'save_base', member_id: 'member', home_base: custom })).status, 403);
        }
        assert.equal((await state.call({ action: 'assign', route_id: 'route', member_id: 'member' })).status, 403);
        assert.equal(state.writes.length, 0);
    }
});
test('manager bases list includes exact verified bases and rejects unverified links and foreign members', async () => {
    const state = setup();
    const result = await state.call({ action: 'list' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.bases.find(base => base.member_id === 'member').home_base, home);
    assert.equal(result.data.bases.some(base => base.member_id === 'foreign'), false);
    assert.equal((await state.call({ action: 'save_base', member_id: 'foreign', home_base: custom })).status, 403);
    const unverified = setup({ verified: false });
    assert.equal((await unverified.call({ action: 'list' })).data.bases.find(base => base.member_id === 'member').home_base, null);
    assert.equal((await unverified.call({ action: 'save_base', member_id: 'member', home_base: custom })).status, 409);
});
test('saving a base validates coordinates and changes only the verified user', async () => {
    const state = setup();
    assert.equal((await state.call({ action: 'save_base', member_id: 'member', home_base: { ...custom, lat: 200 } })).status, 400);
    assert.equal(state.writes.length, 0);
    assert.equal((await state.call({ action: 'save_base', member_id: 'member', home_base: custom, auto_assign: false })).status, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(state.users.rep.home_base)), custom);
    assert.equal(state.users.rep.home_base_auto_assign, false);
    assert.equal(state.users.peer.home_base.address, 'Peer secret');
});
test('assignment automatically anchors and optimizes every imported door without exposing coordinates on shared routes', async () => {
    const state = setup();
    const result = await state.call({ action: 'assign', route_id: 'route', member_id: 'member' });
    assert.equal(result.status, 200);
    assert.equal(state.route.route_origin_mode, 'anchor_round_trip');
    assert.deepEqual(new Set(state.route.property_hashes), new Set(['a', 'b', 'c']));
    assert.equal(state.route.start_location, null);
    assert.equal(state.route.end_location, null);
    assert.equal(state.route.metadata.anchor.source, 'rep_base');
    const persisted = JSON.stringify(state.route);
    assert.equal(persisted.includes(home.address), false);
    assert.equal(persisted.includes(String(home.lng)), false);
    assert.equal(state.route.metadata.road_geometry, undefined);
    assert.equal(state.route.metadata.road_network_used, false);
    assert.equal(state.route.metadata.road_verification.verdict, 'unverified_local_fallback');
    assert.equal(state.route.metrics.distance, Math.round(calculateRouteDistanceMiles(state.route.property_hashes.map(hash => properties.find(property => property.address_hash === hash)), { startLocation: home, endLocation: home }) * 100) / 100);
});
test('rep preferences, explicit opt-out and absent bases keep assignment unanchored', async () => {
    for (const options of [{ auto: false }, { base: null }, { pending: true }, {}]) {
        const state = setup(options);
        const result = await state.call({ action: 'assign', route_id: 'route', member_id: 'member', ...(Object.keys(options).length ? {} : { use_rep_base: false }) });
        assert.equal(result.status, 200);
        assert.equal(state.route.assigned_to, 'member');
        assert.equal(state.route.route_origin_mode, 'none');
        assert.equal(state.records.length, 0);
    }
});
test('custom route address stays in private storage and only the assigned rep can retrieve it', async () => {
    const state = setup();
    assert.equal((await state.call({ action: 'set_route', route_id: 'route', source: 'custom', location: custom })).status, 200);
    assert.equal(state.records.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(state.records[0].location)), custom);
    assert.equal(JSON.stringify(state.route).includes(custom.address), false);
    assert.deepEqual((await state.call({ action: 'get_route', route_id: 'route' })).data.anchor, custom);
    for (const actor of ['rep', 'peer', 'other']) {
        const reader = setup({ actor });
        Object.assign(reader.route, state.route);
        reader.records.push(...state.records);
        const result = await reader.call({ action: 'get_route', route_id: 'route' });
        assert.equal(result.status, actor === 'rep' ? 200 : 403);
        if (actor !== 'rep') assert.equal(JSON.stringify(result.data).includes(custom.address), false);
    }
});
test('private base lookup verifies membership independently of editable roster rows', async () => {
    const state = setup({ actor: 'rep', verified: false });
    state.route.route_origin_mode = 'anchor_round_trip';
    state.route.metadata.anchor = { source: 'rep_base' };
    const result = await state.call({ action: 'get_route', route_id: 'route' });
    assert.equal(result.status, 409);
    assert.equal(JSON.stringify(result.data).includes(home.address), false);
});
test('missing route coordinates fail before changing assignment or private anchor', async () => {
    const state = setup({ missingDoor: true });
    const before = JSON.stringify(state.route);
    assert.equal((await state.call({ action: 'set_route', route_id: 'route', source: 'custom', location: custom })).status, 409);
    assert.equal(JSON.stringify(state.route), before);
    assert.equal(state.records.length, 0);
    assert.equal(state.writes.length, 0);
});
test('failed route writes roll back new private anchors and retain the previous one', async () => {
    const state = setup();
    await state.call({ action: 'set_route', route_id: 'route', source: 'custom', location: custom });
    const before = JSON.stringify(state.route);
    state.setFailUpdate();
    assert.equal((await state.call({ action: 'set_route', route_id: 'route', source: 'custom', location: home })).status, 500);
    assert.equal(state.records.length, 1);
    assert.equal(JSON.stringify(state.route), before);
    assert.deepEqual((await state.call({ action: 'get_route', route_id: 'route' })).data.anchor, custom);
});
test('reassignment discards the previous custom anchor and selects the new rep base', async () => {
    const state = setup();
    await state.call({ action: 'set_route', route_id: 'route', source: 'custom', location: custom });
    const result = await state.call({ action: 'assign', route_id: 'route', member_id: 'peerMember' });
    assert.equal(result.status, 200);
    assert.equal(state.records.length, 0);
    assert.equal(state.route.assigned_to, 'peerMember');
    assert.equal(result.data.anchor.address, 'Peer secret');
});
test('unassigning removes the private anchor and recalculates distance between doors', async () => {
    const state = setup();
    await state.call({ action: 'set_route', route_id: 'route', source: 'custom', location: custom });
    const result = await state.call({ action: 'assign', route_id: 'route', member_id: '' });
    assert.equal(result.status, 200);
    assert.equal(state.records.length, 0);
    assert.equal(state.route.route_origin_mode, 'none');
    assert.equal(state.route.assigned_to, null);
    assert.equal(state.route.status, 'PENDING');
    assert.equal(state.route.metrics.distance, Math.round(calculateRouteDistanceMiles(state.route.property_hashes.map(hash => properties.find(property => property.address_hash === hash))) * 100) / 100);
});
test('private anchor entity denies direct client access and hydrated map doors follow saved order', () => {
    const schema = JSON.parse(read('base44/entities/route-anchor.jsonc'));
    for (const operation of ['read', 'create', 'update', 'delete']) assert.equal(schema.rls[operation], false);
    assert.equal(JSON.parse(read('base44/entities/TeamMember.jsonc')).properties.home_base, undefined);
    const merged = mergeAnchoredRoute({ properties, startLocation: home }, { property_hashes: ['c', 'a', 'b'], route_origin_mode: 'anchor_round_trip', metrics: { distance: 1, house_count: 3 } });
    assert.deepEqual(merged.properties.map(property => property.address_hash), ['c', 'a', 'b']);
    assert.equal(merged.startLocation, null);
});

test('anchor optimization keeps each street sweep contiguous and preserves its original order or reverse', () => {
    const stops = [
        { id: 'a1', street_name: 'A St', lat: 33.451, lng: -112.074 },
        { id: 'a2', street_name: 'A St', lat: 33.481, lng: -112.074 },
        { id: 'a3', street_name: 'A St', lat: 33.471, lng: -112.074 },
        { id: 'b1', street_name: 'B St', lat: 33.451, lng: -112.073 },
        { id: 'b2', street_name: 'B St', lat: 33.481, lng: -112.073 },
    ];
    const ordered = optimizeAnchoredStreetRoute(stops, home);
    assert.deepEqual(new Set(ordered.map(stop => stop.id)), new Set(stops.map(stop => stop.id)));
    assert.equal(ordered.filter((stop, index) => index && stop.street_name !== ordered[index - 1].street_name).length, 1);
    const aOrder = ordered.filter(stop => stop.street_name === 'A St').map(stop => stop.id).join(',');
    assert.ok(['a1,a2,a3', 'a3,a2,a1'].includes(aOrder));
});

test('private anchors are recognized as round trips with an accurate marker label', () => {
    assert.equal(normalizeRouteOriginMode('anchor_round_trip'), 'anchor_round_trip');
    assert.equal(isRoundTripRouteOriginMode('anchor_round_trip'), true);
    assert.deepEqual(routeAnchorMarkerLabels('anchor_round_trip'), { start: 'Anchor • Start / Finish', end: null });
});

test('pending reps can receive a custom route anchor without granting access to any private User base', async () => {
    const state = setup({ pending: true });
    const result = await state.call({ action: 'set_route', route_id: 'route', source: 'custom', location: custom });
    assert.equal(result.status, 200);
    assert.equal(state.route.metadata.anchor.source, 'custom');
});
