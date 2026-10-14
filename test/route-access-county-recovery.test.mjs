import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverRouteVehicleAccess } from '../base44/shared/routeAccessRecovery.js';
import { COUNTY_ROAD_SERVICE, COUNTY_ADDRESS_SERVICE, discoverCountyRoadAccess } from '../base44/shared/countyRoadAccess.js';

const identity = stop => stop.address_hash;
const point = stop => ({ lat: stop.lat, lng: stop.lng });
const key = value => `${Number(value.lng)},${Number(value.lat)}`;
const response = (payload, status = 200) => ({ ok: status === 200, status, json: async () => payload });
const fixture = () => [
    { address_hash: 'healthy-before', house_number: '1', street_name: 'Public Rd', state: 'NC', zip_code: '28147', lat: 35.644, lng: -80.615 },
    { address_hash: '1135 STONEGATE DR|28147', house_number: '1135', street_name: 'Stonegate Dr', city: 'Salisbury', state: 'NC', zip_code: '28147', lat: 35.64506, lng: -80.611529 },
    { address_hash: '1091 STONEGATE DR|28147', house_number: '1091', street_name: 'Stonegate Dr', city: 'Salisbury', state: 'NC', zip_code: '28147', lat: 35.645603, lng: -80.611865 },
    { address_hash: '200 WEATHERSTONE RANCH TRL|28166', house_number: '200', street_name: 'Weatherstone Ranch Trl', city: 'Troutman', state: 'NC', zip_code: '28166', lat: 35.681904, lng: -80.807922 },
    { address_hash: 'healthy-after', house_number: '2', street_name: 'Public Rd', state: 'NC', zip_code: '28147', lat: 35.643, lng: -80.615 },
];

// The county fixture is an address/range-bound road leading to one public
// junction. It never treats the nearest parallel public street as the house's
// entrance and does not move the parcel's map pin.
async function countyEvidence(stop, overrides = {}) {
    const service = { lat: stop.lat + 0.00002, lng: stop.lng - 0.00002 };
    const gateway = { lat: service.lat, lng: service.lng - 0.003 };
    const attributes = { objectid: Number(stop.house_number), st_name: stop.street_name,
        fromaddr_l: 1, toaddr_l: 1999, fromaddr_r: 2, toaddr_r: 2000,
        postcode_l: stop.zip_code, postcode_r: stop.zip_code, oneway: 'BI', ...overrides };
    const roads = [{ attributes, geometry: { paths: [[gateway, service,
        { lat: service.lat, lng: service.lng + 0.0001 }].map(p => [p.lng, p.lat])] } },
    { attributes: { ...attributes, objectid: Number(stop.house_number) + 10000, st_name: 'Public Road' },
        geometry: { paths: [[{ lat: gateway.lat - 0.001, lng: gateway.lng }, gateway,
            { lat: gateway.lat + 0.001, lng: gateway.lng }].map(p => [p.lng, p.lat])] } }];
    const candidate = await discoverCountyRoadAccess(stop, { vehicleBaseUrl: 'https://roads.test',
        fetchImpl: async rawUrl => {
            const url = new URL(rawUrl);
            if (url.origin + url.pathname === COUNTY_ROAD_SERVICE) return response({ features: roads });
            assert.equal(url.origin + url.pathname, COUNTY_ADDRESS_SERVICE);
            return response({ features: [{ attributes: { objectid: Number(stop.house_number), add_number: stop.house_number,
                st_address: `${stop.house_number} ${stop.street_name}`, post_code: stop.zip_code, state: 'NC' },
            geometry: { x: stop.lng, y: stop.lat } }] });
        }, vehicleFetch: async () => response({ code: 'Ok', waypoints: [{ name: 'Public Road', distance: 0,
            location: [gateway.lng, gateway.lat] }] }) });
    assert.ok(candidate, 'county fixture must pass actual discovery and canonical proof validation');
    return candidate;
}

function roadProvider(properties, options = {}) {
    const missing = properties.filter(stop => stop.street_name !== 'Public Rd');
    const missingPoints = new Set(missing.map(key));
    const geocoded = new Map(missing.map(stop => [key({ lat: stop.lat + 0.0001, lng: stop.lng }), stop]));
    const calls = [];
    const fetch = async rawUrl => {
        const url = new URL(rawUrl); calls.push(url);
        const points = url.pathname.split('/').at(-1).split(';').map(text => {
            const [lng, lat] = text.split(',').map(Number); return { lat, lng };
        });
        if (options.unavailable) return response({ code: 'InternalError' }, 503);
        const unmatchedIndex = points.findIndex(p => missingPoints.has(key(p)));
        if (unmatchedIndex >= 0) return response({ code: 'NoSegment',
            message: `Could not find a matching segment for coordinate ${unmatchedIndex}` }, 400);
        return response({ code: 'Ok', data_version: 'public-road-build-a', waypoints: points.map(p => ({
            location: [p.lng, p.lat], distance: 0,
            name: geocoded.has(key(p)) ? (geocoded.get(key(p)).street_name === 'Stonegate Dr' ? 'Coppergate Drive' : 'Davis Trail Lane') : 'Public Road',
        })), routes: [{ duration: 10, distance: 50, legs: points.slice(1).map(() => ({ duration: 10, distance: 50, steps: [] })) }] });
    };
    return { calls, fetch };
}

function optionsFor(properties, extra = {}) {
    const road = roadProvider(properties);
    return { road, options: { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async items => ({ results: Object.fromEntries(items.map(item => {
            const stop = properties.find(p => identity(p) === item.id);
            return [item.id, { lat: stop.lat + 0.0001, lng: stop.lng, source: 'geocodio', accuracy: 1, matchType: 'rooftop',
                matchedAddress: `${stop.house_number} ${stop.street_name}, ${stop.city}, NC ${stop.zip_code}` }];
        })) }), countyAccessLookup: async stop => countyEvidence(stop), ...extra } };
}

test('three real address patterns recover through explicit county road evidence after wrong-road geocodes', async () => {
    const properties = fixture(), before = structuredClone(properties); const { options } = optionsFor(properties);
    const lookups = [];
    options.countyAccessLookup = async (stop, settings) => {
        lookups.push({ stop: structuredClone(stop), settings }); return countyEvidence(stop);
    };
    const result = await recoverRouteVehicleAccess(properties, options);
    assert.equal(result.report.recovered, 3); assert.equal(result.report.unresolved.length, 0);
    assert.equal(result.report.status, 'recovered');
    assert.equal(lookups.length, 3);
    assert.deepEqual(result.properties.map(identity), properties.map(identity));
    assert.deepEqual(properties, before);
    for (const stop of result.properties.slice(1, 4)) {
        const original = properties.find(p => identity(p) === identity(stop)); const access = stop.routing_access;
        assert.equal(access.resolution_status, 'resolved');
        assert.deepEqual(access.displayPoint, point(original));
        assert.deepEqual(point(stop), access.point);
        assert.equal(access.side, 'unknown'); assert.equal(access.serviceBearing, null);
        assert.ok(access.county_road, 'missing road geometry must accompany the recovered access point');
        assert.equal(access.evidence.propertyIdentity, identity(stop));
        assert.ok(result.report.access_overrides[identity(stop)]);
    }
});

test('fresh county access cache is rematched through its public gateway without repeat address or county lookups', async () => {
    const properties = fixture(); const first = optionsFor(properties);
    const recovered = await recoverRouteVehicleAccess(properties, first.options);
    assert.equal(recovered.report.recovered, 3);
    const cached = properties.map(stop => ({ ...stop,
        routing_access: recovered.report.access_overrides[identity(stop)] || stop.routing_access }));
    const second = optionsFor(cached, { geocode: () => { throw new Error('valid county cache must not be geocoded'); },
        countyAccessLookup: () => { throw new Error('valid county cache must not need rediscovery'); } });
    const result = await recoverRouteVehicleAccess(cached, second.options);
    assert.equal(result.report.status, 'ready'); assert.equal(result.report.attempted, 0);
    assert.equal(result.report.reused, 3);
    assert.ok(second.road.calls.length > 0, 'cached county gateways must still be road matched');
    for (const stop of properties.slice(1, 4)) {
        const gateway = (await countyEvidence(stop)).gateway.providerPoint;
        assert.ok(second.road.calls.some(url => url.pathname.split('/').at(-1).split(';').some(coordinate => {
            const [lng, lat] = coordinate.split(',').map(Number);
            return Math.abs(lng - gateway.lng) < 1e-7 && Math.abs(lat - gateway.lat) < 1e-7;
        })),
            'raw road provider receives the verified public gateway');
        assert.deepEqual(result.report.access_overrides[identity(stop)].displayPoint, point(stop));
    }
});

for (const [name, mutate] of [
    ['invalid county geometry', stop => { stop.routing_access.county_road.network.segments[0].geometry[1].lat = 95; }],
    ['revised address street', stop => { stop.street_name = 'A Different Street'; }],
    ['expired county evidence', stop => { stop.routing_access.resolved_at = '2000-01-01T00:00:00.000Z'; }],
]) test(`cached county access cannot silently survive ${name}`, async () => {
    const properties = [fixture()[1]]; const first = optionsFor(properties);
    const recovered = await recoverRouteVehicleAccess(properties, first.options);
    assert.equal(recovered.report.recovered, 1);
    const cached = [{ ...properties[0], routing_access: structuredClone(recovered.report.access_overrides[identity(properties[0])]) }];
    mutate(cached[0]);
    const { options } = optionsFor(cached, { geocode: async () => ({ results: {} }), countyAccessLookup: async () => null });
    const result = await recoverRouteVehicleAccess(cached, options);
    assert.equal(result.report.reused, 0); assert.equal(result.report.recovered, 0);
    assert.equal(result.report.unresolved.length, 1);
    assert.equal(result.properties[0].routing_access.resolution_status, 'unresolved');
    assert.deepEqual(point(result.properties[0]), point(cached[0]));
});

for (const [name, mutate] of [
    ['different property identity', proof => { proof.evidence.propertyIdentity = 'another property'; }],
    ['different addressed street', proof => { proof.roadName = 'Other Road'; }],
    ['changed display pin', proof => { proof.evidence.displayPoint.lat += 0.001; }],
    ['wrong house number', proof => { proof.address_match.house_number = '9999'; }],
    ['wrong postal code', proof => { proof.address_match.zip_code = '00000'; }],
    ['invalid service point', proof => { proof.point.lat = 95; }],
    ['invalid provider point', proof => { proof.gateway.providerPoint.lng = 500; }],
    ['road geometry absent', proof => { proof.network.segments = []; }],
    ['road geometry malformed', proof => { proof.network.segments[0].geometry[1].lat = NaN; }],
    ['unverified address range', proof => { proof.evidence.addressRangeVerified = false; }],
    ['ambiguous public gateway', proof => { proof.evidence.uniqueGateway = false; }],
]) test(`county recovery rejects ${name}`, async () => {
    const properties = [fixture()[1]];
    const { options } = optionsFor(properties, { countyAccessLookup: async stop => {
        const evidence = await countyEvidence(stop); mutate(evidence); return evidence;
    } });
    const result = await recoverRouteVehicleAccess(properties, options);
    assert.equal(result.report.recovered, 0);
    assert.equal(result.report.unresolved.length, 1);
    assert.deepEqual(result.properties.map(point), properties.map(point));
    assert.equal(result.properties[0].routing_access.resolution_status, 'unresolved');
    assert.deepEqual(result.report.access_overrides, {});
});

test('a missing county proof leaves one explicit issue while other county addresses recover', async () => {
    const properties = fixture(); const { options } = optionsFor(properties, { countyAccessLookup: async stop =>
        stop.house_number === '1091' ? null : countyEvidence(stop) });
    const result = await recoverRouteVehicleAccess(properties, options);
    assert.equal(result.report.recovered, 2); assert.equal(result.report.status, 'partial');
    assert.equal(result.report.unresolved.length, 1);
    assert.equal(result.report.unresolved[0].property_id, properties[2].address_hash);
    assert.deepEqual(result.properties.map(identity), properties.map(identity));
});

test('county provider failure is bounded and preserves the route with explicit unresolved stops', async () => {
    const properties = fixture(); let calls = 0;
    const { options } = optionsFor(properties, { countyAccessLookup: async () => {
        calls += 1; throw new Error('County service unavailable');
    } });
    const result = await recoverRouteVehicleAccess(properties, options);
    assert.equal(result.report.recovered, 0); assert.equal(calls, 3);
    assert.equal(result.report.unresolved.length, 3);
    assert.deepEqual(result.properties.map(identity), properties.map(identity));
    assert.deepEqual(result.properties.map(point), properties.map(point));
});

test('a driving provider outage prevents county lookup and never relabels healthy properties as invalid', async () => {
    const properties = fixture(); let calls = 0;
    const { options } = optionsFor(properties, { vehicleFetch: roadProvider(properties, { unavailable: true }).fetch,
        countyAccessLookup: async () => { calls += 1; return null; } });
    const result = await recoverRouteVehicleAccess(properties, options);
    assert.equal(result.report.status, 'provider_unavailable'); assert.equal(calls, 0);
    assert.equal(result.report.inventory_complete, false);
    assert.deepEqual(result.report.unresolved, []);
    assert.deepEqual(result.properties, properties);
});

test('a valid county address proof cannot resolve a road with no legal departure back to its public gateway', async () => {
    const properties = [fixture()[1]];
    const { options } = optionsFor(properties, { countyAccessLookup: async stop => countyEvidence(stop, { oneway: 'FT' }) });
    const result = await recoverRouteVehicleAccess(properties, options);
    assert.equal(result.report.recovered, 0);
    assert.equal(result.report.unresolved.length, 1);
    assert.equal(result.properties[0].routing_access.resolution_status, 'unresolved');
    assert.deepEqual(result.properties.map(point), properties.map(point));
});

test('cached county address proof still requires legal arrival and departure paths', async () => {
    const p = fixture()[1], county = await countyEvidence(p, { oneway: 'FT' });
    const properties = [{ ...p, routing_access: { resolution_status: 'resolved', source: 'county_road_recovery',
        resolved_at: new Date().toISOString(), confidence: 'medium', side: 'unknown', serviceBearing: null,
        point: county.point, displayPoint: point(p), roadName: p.street_name, county_road: county, evidence: county.evidence } }];
    const { options } = optionsFor(properties, { countyAccessLookup: async () => null });
    const result = await recoverRouteVehicleAccess(properties, options);
    assert.equal(result.report.reused, 0); assert.equal(result.report.recovered, 0);
    assert.equal(result.report.unresolved.length, 1);
    assert.equal(result.properties[0].routing_access.resolution_status, 'unresolved');
});
