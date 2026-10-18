import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../src/components/logic/routeHydrationCore.js';

const working = { lat: 35.47, lng: -81.25 };
const route = (id, extra = {}) => ({ id, status: 'ACTIVE', property_hashes: [`${id}-h`], ...extra });
const at = (lat, lng) => ({ metadata: { road_geometry_segments: [{ points: [{ lat, lng }, { lat: lat + 0.01, lng }] }] } });

test('a route is located before its homes load: homes on the device, then its path, area or start', () => {
    const homes = new Map([['a-h', { address_hash: 'a-h', lat: 35.1, lng: -81.1 }]]);
    assert.deepEqual(core.routeLocationHint(route('a'), homes), { lat: 35.1, lng: -81.1 });
    assert.deepEqual(core.routeLocationHint(route('b', at(30, -82))), { lat: 30, lng: -82 });
    assert.deepEqual(core.routeLocationHint(route('c', { metadata: { precision_area: { polygon: [[33, -84], [33.1, -84], [33, -84.1]] } } })), { lat: 33, lng: -84 });
    assert.deepEqual(core.routeLocationHint(route('d', { start_location: { lat: 31, lng: -83 } })), { lat: 31, lng: -83 });
    assert.equal(core.routeLocationHint(route('e')), null);
});

test('routes nearest the map view load first; routes with no known place keep their order, last', () => {
    const routes = [route('far', at(27, -82)), route('unknown1'), route('near', at(35.48, -81.24)), route('mid', at(34, -80)), route('unknown2')];
    assert.deepEqual(core.orderRoutesNearView(routes, working).map(r => r.id), ['near', 'mid', 'far', 'unknown1', 'unknown2']);
    assert.equal(core.orderRoutesNearView(routes, null), routes, 'no view: unchanged');
});

test('while the territory overview loads, the routes where the map is looking are looked up too', () => {
    // 17 routes, newest first; the one the person works (Lincolnton) is the 11th.
    const routes = Array.from({ length: 17 }, (_, i) => route(`r${i}`, at(i === 10 ? 35.47 : 25 + i, i === 10 ? -81.25 : -82)));
    const before = core.selectRoutesToHydrate(routes, { overviewLoading: true });
    assert.deepEqual(before.map(r => r.id), ['r0', 'r1', 'r2'], 'without a view: the 3 newest, as before');
    const after = core.selectRoutesToHydrate(routes, { overviewLoading: true, center: working });
    assert.equal(after[0].id, 'r10', 'the working route is looked up first');
    assert.ok(['r0', 'r1', 'r2'].every(id => after.some(r => r.id === id)), 'the newest routes still load early');
    const settled = core.selectRoutesToHydrate(routes, { overviewLoading: false, center: working });
    assert.equal(settled.length, 17);
    assert.equal(settled[0].id, 'r10');
});
