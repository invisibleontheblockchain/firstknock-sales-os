import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEE_ROAD_SERVICE, LEE_ADDRESS_SERVICE, countyAuthorityFor } from '../base44/shared/countyRoadAuthorities.js';
import { discoverCountyRoadAccess, validateCountyRoadAccess, discoverCountyAddressReference,
    validateCountyAddressReference } from '../base44/shared/countyRoadAccess.js';
import { createCountyRoadRoutingAdapter, validateCountyRoadNetwork } from '../base44/shared/countyRoadRouting.js';
import { recoverRouteVehicleAccess } from '../base44/shared/routeAccessRecovery.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/lee-county-equinox-access.json', import.meta.url), 'utf8'));
const stop = { address_hash: '6730 EQUINOX LN|33917', house_number: '6730', street_name: 'Equinox LN',
    city: 'North Fort Myers', state: 'FL', zip_code: '33917', lat: 26.71518450747428, lng: -81.84735500277874 };
const gateway = { lat: 26.7151212120713, lng: -81.85484731355 };
const now = Date.parse('2026-10-15T12:00:00Z');
const response = payload => ({ ok: true, status: 200, json: async () => payload });
function providers(alter = () => {}) {
    const data = structuredClone(fixture); alter(data);
    const calls = [];
    return { data, calls, now, fetchImpl: async raw => {
        const url = new URL(raw); calls.push(url);
        if (url.origin + url.pathname === LEE_ROAD_SERVICE) return response({ features: data.roads, ...data.roadResponse });
        if (url.origin + url.pathname === LEE_ADDRESS_SERVICE) return response({ features: data.addresses, ...data.addressResponse });
        throw new Error('An unregistered authority was queried');
    }, vehicleFetch: async raw => {
        const url = new URL(raw); calls.push(url);
        assert.equal(url.searchParams.get('radiuses'), '10');
        return response({ code: 'Ok', waypoints: [{ name: 'Slater Road', distance: 0.3979807514,
            location: [-81.854851, 26.715121] }] });
    } };
}

test('Lee County recovery resolves actual missing Equinox road using exact address, county topology and a fresh public gateway', async () => {
    const p = providers(), before = structuredClone(stop);
    const access = await discoverCountyRoadAccess(stop, p);
    assert.ok(access);
    assert.equal(access.evidence.source, 'fl_lee_ng911_centerlines');
    assert.equal(access.evidence.sourceService, LEE_ROAD_SERVICE);
    assert.equal(access.evidence.addressSource, 'fl_lee_address_point');
    assert.equal(access.evidence.addressId, 'fl_lee_address:40794');
    assert.equal(access.address_match.state, 'FL');
    assert.equal(access.network.segments.length, 4);
    assert.ok(access.network.segments.every(s => s.id.startsWith('fl_lee911:')));
    assert.deepEqual(access.gateway.point, gateway);
    assert.equal(access.gateway.roadName, 'Slater Road');
    assert.ok(access.evidence.projectionMeters < 22);
    assert.equal(validateCountyRoadAccess(stop, access, { now }), true);
    assert.equal(validateCountyRoadNetwork(access), true);
    assert.deepEqual(stop, before, 'the display location is preserved');
    assert.equal(p.calls.length, 3);
    const query = p.calls.find(u => u.pathname === new URL(LEE_ADDRESS_SERVICE).pathname);
    assert.equal(query.searchParams.get('where'), "Add_Number=6730 AND Post_Code='33917'");
});

test('the Lee adapter is address independent, with a different street and house using the same evidence rules', async () => {
    const other = { ...stop, address_hash: '6732 TEST LN|33917', house_number: '6732', street_name: 'Test Lane' };
    const p = providers(data => {
        for (const road of data.roads) if (road.attributes.St_Name === 'EQUINOX') road.attributes.St_Name = 'TEST';
        Object.assign(data.addresses[0].attributes, { Add_Number: 6732, Full_Address: '6732 TEST LN', LFull_St_Name: 'TEST LN' });
    });
    assert.ok(await discoverCountyRoadAccess(other, p));
});

test('registered authority choice never sends unsupported Florida or another-state stops to North Carolina', async () => {
    for (const other of [{ ...stop, state: 'NC' }, { ...stop, lat: 28.5 }, { ...stop, lng: -80.1 }]) {
        const p = providers();
        assert.equal(countyAuthorityFor(other), null);
        assert.equal(await discoverCountyRoadAccess(other, p), null);
        assert.equal(p.calls.length, 0);
    }
    assert.equal(countyAuthorityFor({ ...stop, state: '' }).id, 'fl_lee911');
});

test('Lee exact address reference is reusable identity evidence with source, state and raw record binding', async () => {
    const p = providers();
    const ref = await discoverCountyAddressReference(stop, p);
    assert.ok(ref);
    assert.equal(validateCountyAddressReference(stop, ref, { now }), true);
    assert.equal(validateCountyAddressReference({ ...stop, state: 'NC' }, ref, { now }), false);
    assert.equal(validateCountyAddressReference(stop, { ...ref, source: 'nc_address_point' }, { now }), false);
    const altered = structuredClone(ref); altered.attributes.add_number = 6731;
    assert.equal(validateCountyAddressReference(stop, altered, { now }), false);
});

for (const [label, alter] of [
    ['missing exact address', data => { data.addresses = []; }],
    ['wrong county', data => { data.addresses[0].attributes.County = 'COLLIER COUNTY'; }],
    ['wrong state', data => { data.addresses[0].attributes.State = 'NC'; }],
    ['unit address', data => { data.addresses[0].attributes.Unit = '2'; }],
    ['house prefix', data => { data.addresses[0].attributes.AddNum_Pre = 'REAR'; }],
    ['unlinked target road', data => { data.addresses[0].attributes.MSLINK_RCL = 90000; }],
    ['wrong parity', data => { data.roads.find(r => r.attributes.OBJECTID === 75172).attributes.Parity_R = 'O'; }],
    ['ambiguous exact addresses', data => { const copy = structuredClone(data.addresses[0]); copy.geometry.x += 0.0001; data.addresses.push(copy); }],
    ['truncated road inventory', data => { data.roadResponse = { exceededTransferLimit: true }; }],
    ['truncated address inventory', data => { data.addressResponse = { exceededTransferLimit: true }; }],
    ['expired address', data => { data.addresses[0].attributes.Expire = now - 1; }],
    ['future address', data => { data.addresses[0].attributes.Effective = now + 1; }],
    ['malformed effective date', data => { data.addresses[0].attributes.Effective = 'unknown'; }],
    ['turn restriction', data => { data.roads[0].attributes.turn_mask = '1'; }],
    ['unrecognized road class', data => { data.roads[0].attributes.RoadClass = 'P'; }],
    ['grade-separated geometry', data => { data.roads[0].attributes.F_ELEV = 1; }],
    ['county data error', data => { data.roads[0].attributes.ErrorCode = 2; }],
    ['unsupported direction', data => { data.roads[0].attributes.OneWay = 'unknown'; }],
]) test(`Lee road recovery rejects ${label}`, async () => {
    assert.equal(await discoverCountyRoadAccess(stop, providers(alter)), null);
});

test('Lee source proof rejects edited cached attributes, source identity and address-road linkage', async () => {
    const original = await discoverCountyRoadAccess(stop, providers());
    for (const alter of [
        a => { a.evidence.source = 'nc_ng911_centerlines'; },
        a => { a.evidence.sourceService = 'https://example.com/query'; },
        a => { a.evidence.addressAttributes.mslink_rcl = 90000; },
        a => { a.evidence.addressId = 'fl_lee_address:123'; },
        a => { a.network.segments[0].attributes.oneway = 'FT'; },
        a => { a.gateway.countyRoad.attributes.country_l = 'CA'; },
    ]) {
        const copy = structuredClone(original); alter(copy);
        assert.equal(validateCountyRoadAccess(stop, copy, { now }), false);
    }
});

test('Lee composite routing reports the correct authority and estimated local travel time', async () => {
    const county = await discoverCountyRoadAccess(stop, providers());
    const adapter = createCountyRoadRoutingAdapter([{ ...stop, ...county.point, routing_access: {
        source: 'county_road_recovery', county_road: county, roadName: stop.street_name,
    } }], { fetchJson: async () => assert.fail('metadata requires no request') });
    assert.deepEqual(adapter.stats().authoritySources, ['fl_lee_ng911_centerlines']);
    assert.equal(adapter.stats().countyStopCount, 1);
    assert.equal(adapter.stats().localDurationIsEstimate, true);
});

test('serialized Lee evidence accepts reordered keys without losing source attribute validation', async () => {
    const county = await discoverCountyRoadAccess(stop, providers());
    const reorder = value => value && typeof value === 'object'
        ? Array.isArray(value) ? value.map(reorder)
            : Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
    // Network signatures intentionally preserve serialized segments. Only reorder
    // source records/attributes whose proof is a semantic field comparison.
    county.evidence.addressAttributes = reorder(county.evidence.addressAttributes);
    county.gateway.countyRoad.attributes = reorder(county.gateway.countyRoad.attributes);
    assert.equal(validateCountyRoadAccess(stop, county, { now }), true);
});

test('automatic recovery uses the Lee authority and freshly rematches the cached public gateway on retry', async () => {
    const p = providers();
    const vehicleFetch = async raw => {
        const coords = new URL(raw).pathname.split('/').at(-1).split(',').map(Number);
        if (Math.abs(coords[0] - gateway.lng) > 0.0001) throw Object.assign(new Error('NoSegment coordinate 0'), { code: 'NoSegment' });
        return p.vehicleFetch(raw);
    };
    const recovered = await recoverRouteVehicleAccess([stop], { countyFetch: p.fetchImpl, vehicleFetch,
        geocode: async () => ({ results: {} }), mappedAccessLookup: false });
    assert.equal(recovered.report.county_recovered, 1);
    assert.equal(recovered.report.unresolved.length, 0);
    const cached = { ...stop, routing_access: recovered.report.access_overrides[stop.address_hash] };
    const reused = await recoverRouteVehicleAccess([cached], { vehicleFetch,
        geocode: async () => assert.fail('cached access should not geocode'),
        countyFetch: async () => assert.fail('cached proof should not query the county'), mappedAccessLookup: false });
    assert.equal(reused.report.reused, 1);
    assert.equal(reused.report.unresolved.length, 0);
    assert.deepEqual(reused.properties[0].routing_access.displayPoint, { lat: stop.lat, lng: stop.lng });
});

test('a Lee provider outage does not certify the cached road or remove its stop', async () => {
    const county = await discoverCountyRoadAccess(stop, providers());
    const cached = { ...stop, routing_access: { source: 'county_road_recovery', resolution_status: 'resolved',
        resolved_at: new Date().toISOString(), point: county.point, displayPoint: { lat: stop.lat, lng: stop.lng },
        roadName: stop.street_name, county_road: county, evidence: county.evidence } };
    const result = await recoverRouteVehicleAccess([cached], { vehicleFetch: async () => { throw new Error('offline'); },
        countyAccessLookup: false, mappedAccessLookup: false });
    assert.equal(result.report.status, 'provider_unavailable');
    assert.equal(result.report.inventory_complete, false);
    assert.equal(result.report.unverified_count, 1);
    assert.equal(result.properties.length, 1);
    assert.equal(result.properties[0].address_hash, stop.address_hash);
});
