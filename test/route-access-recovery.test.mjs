import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverRouteVehicleAccess as recoverAccess } from '../base44/shared/routeAccessRecovery.js';
import { discoverMappedDrivewayAccess } from '../base44/shared/mappedDrivewayAccess.js';
import { createMappedDrivewayFixture } from './fixtures/mapped-driveway-fixture.mjs';

// Isolate the geocoding stage; county topology has its own provider/graph tests.
const recoverRouteVehicleAccess = (properties, options = {}) => recoverAccess(properties, { countyAccessLookup: false, vehicleBaseUrl: 'https://roads.test', ...options });

test('automatic driveway recovery repairs only the failed street access and reuses its proof next time', async () => {
    const fixture = createMappedDrivewayFixture();
    const properties = [fixture.stop, stop(1)], original = structuredClone(properties);
    const access = await discoverMappedDrivewayAccess(fixture.stop, fixture);
    assert.ok(access);
    const road = provider(properties, { bad: [0] });
    const vehicleFetch = async (url, options) => {
        const reply = await road.fetch(url, options), data = await reply.json();
        for (const waypoint of data.waypoints || []) {
            if (waypoint.location.join(',') === pointKey(access.point)) waypoint.name = 'Emma Lane';
        }
        return response(data);
    };
    let mappedCalls = 0;
    const repaired = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch,
        geocode: async () => ({ results: {} }),
        countyAccessLookup: async (_stop, options) => { options.onAddressReference(fixture.referenceAddress); return null; },
        mappedAccessLookup: async (home, options) => {
            mappedCalls++;
            assert.equal(home.address_hash, fixture.stop.address_hash);
            assert.deepEqual(options.referenceAddress, fixture.referenceAddress, 'reuse the county identity lookup');
            return access;
        },
    });
    assert.equal(mappedCalls, 1);
    assert.equal(repaired.report.mapped_recovered, 1);
    assert.equal(repaired.report.recovered, 1);
    assert.deepEqual(repaired.report.unresolved, []);
    assert.deepEqual(repaired.properties.map(home => home.address_hash), properties.map(home => home.address_hash));
    assert.deepEqual(properties, original, 'the parcel display pin and input inventory stay intact');
    assert.deepEqual(repaired.properties[0].routing_access.displayPoint, { lat: original[0].lat, lng: original[0].lng });
    assert.equal(repaired.properties[0].lat, access.point.lat);
    const cached = properties.map((home, index) => index === 0 ? { ...home, routing_access: access } : home);
    const reused = await recoverRouteVehicleAccess(cached, { vehicleBaseUrl: 'https://roads.test', vehicleFetch,
        geocode: () => assert.fail('confirmed access must not be geocoded again'),
        mappedAccessLookup: () => assert.fail('confirmed access must not rediscover the driveway'),
    });
    assert.equal(reused.report.reused, 1);
    assert.equal(reused.report.attempted, 0);
    assert.deepEqual(reused.report.unresolved, []);
});

test('invalid cached driveway identity never suppresses automatic access validation', async () => {
    const fixture = createMappedDrivewayFixture();
    const access = await discoverMappedDrivewayAccess(fixture.stop, fixture);
    access.evidence.referenceAddress.attributes.add_number = '156';
    const properties = [{ ...fixture.stop, routing_access: access }];
    const road = provider(properties, { bad: [0] });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async () => ({ results: {} }), mappedAccessLookup: false });
    assert.equal(result.report.reused, 0);
    assert.equal(result.report.recovered, 0);
    assert.equal(result.report.unresolved.length, 1);
    assert.equal(result.properties[0].lat, fixture.stop.lat);
});

test('a cached driveway entrance is rejected when the current provider moves its road match beyond five metres', async () => {
    const fixture = createMappedDrivewayFixture();
    const access = await discoverMappedDrivewayAccess(fixture.stop, fixture);
    const properties = [{ ...fixture.stop, routing_access: access }];
    const result = await recoverRouteVehicleAccess(properties, {
        vehicleFetch: async () => response({ code: 'Ok', waypoints: [{ name: 'Emma Lane', distance: 6,
            location: [access.point.lng, access.point.lat + 0.000054] }] }),
        geocode: async () => ({ results: {} }), mappedAccessLookup: false,
    });
    assert.equal(result.report.unresolved.length, 1);
    assert.equal(result.report.recovered, 0);
    assert.equal(result.report.access_overrides[fixture.stop.address_hash], undefined);
    assert.equal(result.properties[0].routing_access.resolution_status, 'unresolved');
});

test('an unavailable mapped source preserves the precise access issue and every route member', async () => {
    const properties = [stop(0), stop(1)], road = provider(properties, { bad: [0] });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async () => ({ results: {} }),
        mappedAccessLookup: async () => { throw new Error('mapped source unavailable'); },
    });
    assert.equal(result.report.mapped_recovered, 0);
    assert.equal(result.report.unresolved[0].reason, 'address_not_matched');
    assert.deepEqual(result.properties.map(home => home.address_hash), properties.map(home => home.address_hash));
});

test('a non-cooperative mapped source remains bounded by the recovery deadline', async () => {
    const properties = [stop(0)], road = provider(properties, { bad: [0] });
    const started = Date.now();
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch, budgetMs: 30,
        geocode: async () => ({ results: {} }), mappedAccessLookup: () => new Promise(() => {}),
    });
    assert.ok(Date.now() - started < 500);
    assert.equal(result.report.recovered, 0);
    assert.equal(result.report.unresolved.length, 1);
});

const stop = index => ({ address_hash: `${6100 + index} LONG BRANCH RD|28147`, house_number: String(6100 + index),
    street_name: 'Long Branch Rd', city: 'Salisbury', state: 'NC', zip_code: '28147', lat: 35.7 + index / 10000, lng: -80.6 });
const pointKey = p => `${Number(p.lng)},${Number(p.lat)}`;
const hit = p => ({ lat: p.lat + 0.0007, lng: p.lng, source: 'geocodio', accuracy: 1, matchType: 'rooftop',
    matchedAddress: `${p.house_number} ${p.street_name}, ${p.city}, NC ${p.zip_code}` });
const response = (payload, status = 200) => ({ ok: status === 200, status, json: async () => payload });

function provider(properties, { bad = [], nearest, route, unavailable = false } = {}) {
    const badPoints = new Set(bad.map(index => pointKey(properties[index])));
    const calls = [];
    const fetch = async rawUrl => {
        const url = new URL(rawUrl);
        calls.push(url);
        if (unavailable) return response({ code: 'InternalError', message: 'unavailable' }, 503);
        const points = url.pathname.split('/').at(-1).split(';').map(text => {
            const [lng, lat] = text.split(',').map(Number); return { lat, lng };
        });
        const service = url.pathname.includes('/route/') ? 'route' : 'nearest';
        if (service === 'route' && route) return route(points, url);
        if (service === 'nearest' && nearest) return nearest(points[0], url);
        const badIndex = points.findIndex(p => badPoints.has(pointKey(p)));
        if (badIndex >= 0) return response({ code: 'NoSegment', message: `Could not find a matching segment for coordinate ${badIndex}` }, 400);
        return response({ code: 'Ok', waypoints: points.map(p => ({ name: 'Long Branch Road', distance: 0, location: [p.lng, p.lat] })) });
    };
    return { fetch, calls };
}

test('377-stop preflight isolates failures without dropping or reordering any route member', async () => {
    const properties = Array.from({ length: 377 }, (_, index) => stop(index));
    const before = structuredClone(properties);
    const road = provider(properties, { bad: [23, 24, 109, 322] });
    const requested = [];
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async items => { requested.push(...items); return { results: Object.fromEntries(
            items.map(item => [item.id, hit(properties.find(p => p.address_hash === item.id))])) }; } });
    assert.equal(result.report.status, 'recovered');
    assert.equal(result.report.attempted, 4); assert.equal(result.report.recovered, 4);
    assert.deepEqual(result.report.unresolved, []);
    assert.deepEqual(result.properties.map(p => p.address_hash), properties.map(p => p.address_hash));
    assert.deepEqual(properties, before, 'provider/map pins must not be mutated');
    assert.equal(requested.length, 4);
    assert.ok(road.calls.length <= 12, 'preflight uses bounded chunks instead of one call per property');
    for (const url of road.calls) {
        assert.ok(url.searchParams.get('radiuses').split(';').every(value => value === '100'));
        if (url.pathname.includes('/route/')) {
            assert.ok(url.searchParams.get('approaches').split(';').every(value => value === 'unrestricted'));
            assert.equal(url.searchParams.get('overview'), 'false');
            assert.ok(url.pathname.split('/').at(-1).split(';').length <= 100);
        }
    }
    for (const index of [23, 24, 109, 322]) {
        const access = result.properties[index].routing_access;
        assert.deepEqual(access.displayPoint, { lat: before[index].lat, lng: before[index].lng });
        assert.deepEqual(access.point, { lat: hit(before[index]).lat, lng: before[index].lng });
        assert.equal(result.properties[index].lat, access.point.lat, 'internal matrix uses service point');
        assert.equal(access.confidence, 'medium'); assert.equal(access.side, 'unknown');
        assert.equal(access.serviceBearing, null);
        assert.equal(access.evidence.propertyIdentity, before[index].address_hash);
    }
});

test('healthy routes need no geocoder requests or access overrides', async () => {
    const properties = [stop(0), stop(1)]; const road = provider(properties);
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: () => { throw new Error('must not geocode healthy stops'); } });
    assert.equal(result.report.status, 'ready'); assert.equal(result.report.attempted, 0);
    assert.deepEqual(result.report.access_overrides, {});
    assert.deepEqual(result.properties.map(p => [p.lat, p.lng]), properties.map(p => [p.lat, p.lng]));
});

test('a one-stop failure is recovered using nearest rather than an invalid one-point route request', async () => {
    const properties = [stop(0)]; const road = provider(properties, { bad: [0] });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async () => ({ results: { [properties[0].address_hash]: hit(properties[0]) } }) });
    assert.equal(result.report.recovered, 1);
    assert.ok(road.calls.every(url => url.pathname.includes('/nearest/')));
});

test('a failed address does not prevent another stop from recovering', async () => {
    const properties = [stop(0), stop(1), stop(2)]; const road = provider(properties, { bad: [0, 1] });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async () => ({ results: { [properties[1].address_hash]: hit(properties[1]) } }) });
    assert.equal(result.report.status, 'partial'); assert.equal(result.report.recovered, 1);
    assert.deepEqual(result.report.unresolved, [{ property_id: properties[0].address_hash, stop_number: 1,
        address: '6100 Long Branch Rd, Salisbury, 28147', reason: 'address_not_matched' }]);
    assert.equal(result.properties[0].lat, properties[0].lat);
    assert.equal(result.properties[0].routing_access.resolution_status, 'unresolved');
    assert.equal(result.properties.length, properties.length);
});

for (const [name, change] of [
    ['wrong house number', value => ({ ...value, matchedAddress: '999 Long Branch Rd, Salisbury, NC 28147' })],
    ['wrong street', value => ({ ...value, matchedAddress: '6100 Other Rd, Salisbury, NC 28147' })],
    ['wrong postal code', value => ({ ...value, matchedAddress: '6100 Long Branch Rd, Salisbury, NC 28148' })],
    ['wrong state', value => ({ ...value, matchedAddress: '6100 Long Branch Rd, Salisbury, SC 28147' })],
    ['low confidence', value => ({ ...value, accuracy: 0.79 })],
    ['street-centre result', value => ({ ...value, matchType: 'place' })],
    ['non-exact Census result', value => ({ ...value, source: 'census', matchType: 'Non_Exact' })],
    ['geocode farther than one kilometre', value => ({ ...value, lat: value.lat + 0.02 })],
]) test(`recovery rejects ${name}`, async () => {
    const properties = [stop(0)]; const road = provider(properties, { bad: [0] });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async () => ({ results: { [properties[0].address_hash]: change(hit(properties[0])) } }) });
    assert.equal(result.report.status, 'unresolved');
    assert.equal(result.report.unresolved[0].reason, 'address_match_rejected');
    assert.equal(result.properties[0].lat, properties[0].lat);
    assert.deepEqual(result.report.access_overrides, {});
});

test('exact Census address may omit a unit while retaining the correct base house, street and ZIP', async () => {
    const p = { ...stop(0), house_number: '311', street_name: 'Fern Hill Rd # 313' };
    const properties = [p];
    const road = provider(properties, { bad: [0], nearest: point => pointKey(point) === pointKey(p)
        ? response({ code: 'NoSegment' }, 400)
        : response({ code: 'Ok', waypoints: [{ name: 'Fern Hill Road', distance: 0, location: [point.lng, point.lat] }] }) });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async () => ({ results: { [p.address_hash]: { ...hit(p), source: 'census', matchType: 'Exact',
            matchedAddress: '311 FERN HILL RD, SALISBURY, NC, 28147' } } }) });
    assert.equal(result.report.recovered, 1);
});

for (const [name, waypoint, reason] of [
    ['different service street', { name: 'Richard Road', distance: 0 }, 'address_road_mismatch'],
    ['unnamed road', { name: '', distance: 0 }, 'address_road_mismatch'],
    ['snap outside fixed radius', { name: 'Long Branch Road', distance: 101 }, 'address_road_mismatch'],
    ['invalid road coordinates', { name: 'Long Branch Road', distance: 0, location: [500, 500] }, 'address_road_mismatch'],
]) test(`recovery rejects ${name}`, async () => {
    const properties = [stop(0)];
    const road = provider(properties, { nearest: point => pointKey(point) === pointKey(properties[0])
        ? response({ code: 'NoSegment' }, 400)
        : response({ code: 'Ok', waypoints: [{ location: [point.lng, point.lat], ...waypoint }] }) });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async () => ({ results: { [properties[0].address_hash]: hit(properties[0]) } }) });
    assert.equal(result.report.recovered, 0); assert.equal(result.report.unresolved[0].reason, reason);
});

test('competing named street within five metres is retained as an explicit unresolved issue', async () => {
    const properties = [stop(0)];
    const road = provider(properties, { nearest: point => pointKey(point) === pointKey(properties[0])
        ? response({ code: 'NoSegment' }, 400)
        : response({ code: 'Ok', waypoints: ['Long Branch Road', 'Richard Road'].map(name => ({
            name, distance: 0, location: [point.lng, point.lat],
        })) }) });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async () => ({ results: { [properties[0].address_hash]: hit(properties[0]) } }) });
    assert.equal(result.report.unresolved[0].reason, 'ambiguous_service_road');
});

test('cached recovery is reused only for the same identity/display pin and is rematched', async () => {
    const p = stop(0), recovered = hit(p);
    p.routing_access = { resolution_status: 'resolved', confidence: 'medium', roadName: 'Long Branch Road',
        point: { lat: recovered.lat, lng: recovered.lng }, displayPoint: { lat: p.lat, lng: p.lng },
        evidence: { propertyIdentity: p.address_hash } };
    const road = provider([p], { bad: [0] });
    const result = await recoverRouteVehicleAccess([p], { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch });
    assert.equal(result.report.reused, 1); assert.equal(result.report.attempted, 0);
    assert.equal(road.calls.length, 1); assert.equal(result.properties[0].lat, recovered.lat);
    assert.equal(result.report.access_overrides[p.address_hash].displayPoint.lat, p.lat);
});

for (const [name, mutate] of [
    ['moved display pin', access => { access.displayPoint.lat += 0.01; }],
    ['different property identity', access => { access.evidence.propertyIdentity = 'another property'; }],
    ['different service street', access => { access.roadName = 'Richard Road'; }],
]) test(`cached recovery is discarded for ${name}`, async () => {
    const p = stop(0), recovered = hit(p);
    p.routing_access = { resolution_status: 'resolved', source: 'address_geocode_recovery', roadName: 'Long Branch Road', point: recovered,
        displayPoint: { lat: p.lat, lng: p.lng }, evidence: { propertyIdentity: p.address_hash } };
    mutate(p.routing_access);
    const road = provider([p]);
    const result = await recoverRouteVehicleAccess([p], { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch });
    assert.equal(result.report.reused, 0); assert.equal(result.properties[0].lat, p.lat);
    assert.equal(result.properties[0].routing_access, undefined);
});

test('existing supplied curb access survives recovery preflight without requiring new cache provenance', async () => {
    const p = stop(0), accessPoint = hit(p);
    p.routing_access = { resolution_status: 'resolved', source: 'mapped-driveway-frontage', confidence: 'high',
        side: 'right', serviceBearing: 90, point: { lat: accessPoint.lat, lng: accessPoint.lng } };
    const road = provider([p], { bad: [0] });
    const result = await recoverRouteVehicleAccess([p], { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch });
    assert.equal(result.report.attempted, 0); assert.equal(result.report.reused, 1);
    assert.equal(result.properties[0].lat, accessPoint.lat);
    assert.equal(result.properties[0].routing_access.side, 'right');
    assert.equal(result.properties[0].routing_access.serviceBearing, 90);
    assert.deepEqual(result.properties[0].routing_access.displayPoint, { lat: p.lat, lng: p.lng });
    assert.equal(result.properties[0].routing_access.evidence.propertyIdentity, p.address_hash);
    assert.equal(p.routing_access.displayPoint, undefined, 'caller data remains untouched');
});

test('preflight isolates NoSegment coordinate from a throwing cached dispatcher without an error code', async () => {
    const properties = [stop(0), stop(1), stop(2)]; const road = provider(properties);
    let first = true;
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: (url, options) => {
        if (first) { first = false; throw new Error('OSRM request failed with status 400 (NoSegment). Could not find a matching segment for coordinate 1'); }
        return road.fetch(url, options);
    }, geocode: async () => ({ results: { [properties[1].address_hash]: hit(properties[1]) } }) });
    assert.equal(result.report.recovered, 1); assert.equal(result.report.unresolved.length, 0);
    assert.equal(result.properties[1].routing_access.evidence.propertyIdentity, properties[1].address_hash);
});

test('preflight rejects provider snap geometry outside radius even if claimed distance is zero', async () => {
    const properties = [stop(0), stop(1)];
    const road = provider(properties, { route: points => response({ code: 'Ok', waypoints: points.map(p => ({
        name: 'Long Branch Road', distance: 0, location: [p.lng, p.lat + 0.02],
    })) }) });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch, geocode: async () => ({ results: {} }) });
    assert.equal(result.report.attempted, 2); assert.equal(result.report.unresolved.length, 2);
});

test('provider outage returns an explicit failure inventory without geocoding or marking addresses invalid', async () => {
    const properties = [stop(0), stop(1)]; const road = provider(properties, { unavailable: true });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: () => { throw new Error('must not geocode during road outage'); } });
    assert.equal(result.report.status, 'provider_unavailable'); assert.equal(result.report.attempted, 0);
    assert.equal(road.calls.length, 1);
    assert.deepEqual(result.report.unresolved, []);
    assert.equal(result.report.inventory_complete, false); assert.equal(result.report.unverified_count, 2);
    assert.equal(result.report.failure_reason, 'road_provider_unavailable');
    assert.deepEqual(result.properties, properties);
});

test('geocoder outage is an explicit provider failure and preserves every original stop', async () => {
    const properties = [stop(0), stop(1)]; const road = provider(properties, { bad: [0] });
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async () => { throw new Error('geocoder unavailable'); } });
    assert.equal(result.report.status, 'provider_unavailable'); assert.equal(result.report.unresolved[0].reason, 'address_provider_unavailable');
    assert.equal(result.properties[0].lat, properties[0].lat); assert.equal(result.properties.length, 2);
});

test('failed-stop inventory and geocoding work are bounded with explicit remaining issues', async () => {
    const properties = Array.from({ length: 40 }, (_, index) => stop(index));
    const road = provider(properties, { bad: properties.map((_, index) => index) });
    let requested = 0;
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch, maxFailedStops: 3,
        geocode: async items => { requested += items.length; return { results: {} }; } });
    // Three geocoded stops, plus at most one own-street lookup for each.
    assert.equal(requested, 3); assert.ok(road.calls.length <= 6);
    assert.equal(result.properties.length, 40); assert.equal(result.report.unresolved.length, 40);
    assert.ok(result.report.unresolved.some(item => item.reason === 'recovery_limit_reached'));
});

test('global recovery budget ends a provider adapter that ignores cancellation', async () => {
    const started = Date.now();
    const result = await recoverRouteVehicleAccess([stop(0)], { budgetMs: 25, vehicleBaseUrl: 'https://roads.test', vehicleFetch: () => new Promise(() => {}) });
    assert.ok(Date.now() - started < 500); assert.equal(result.report.status, 'provider_unavailable');
});

test('explicit user cancellation propagates instead of reporting bad addresses', async () => {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    await assert.rejects(recoverRouteVehicleAccess([stop(0)], { signal: controller.signal,
        vehicleFetch: () => new Promise(() => {}) }), { name: 'AbortError' });
});

test('default waterfall retries an unqualified Census match through Geocodio before accepting recovery', async () => {
    const properties = [stop(0)]; const road = provider(properties, { bad: [0] }); const p = properties[0];
    const geocodeCalls = [];
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch, geocodioApiKey: 'test-key',
        geocodeFetch: async rawUrl => {
            geocodeCalls.push(String(rawUrl));
            if (String(rawUrl).includes('census.gov')) return { ok: true, text: async () =>
                `"${p.address_hash}","6100 Long Branch Rd, Salisbury, NC, 28147","Match","Non_Exact","6100 LONG BRANCH RD, SALISBURY, NC, 28147","-80.6,35.7007"` };
            return response({ results: { [p.address_hash]: { response: { results: [{ location: { lat: hit(p).lat, lng: hit(p).lng },
                accuracy_type: 'rooftop', accuracy: 1, formatted_address: hit(p).matchedAddress,
                address_components: { state_province: 'NC' } }] } } } });
        } });
    assert.equal(geocodeCalls.length, 2); assert.equal(result.report.recovered, 1);
    assert.equal(result.properties[0].routing_access.evidence.geocodeSource, 'geocodio');
});

test('a preflight outage records why no road match loaded, without URLs or coordinates', async () => {
    const properties = [stop(0), stop(1), stop(2)];
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test',
        vehicleFetch: async () => {
            throw Object.assign(new Error('OSRM request failed: fetch failed: ENOTFOUND: getaddrinfo ENOTFOUND roads.test'), { kind: 'network' });
        } });
    assert.equal(result.report.status, 'provider_unavailable');
    assert.equal(result.report.failure_reason, 'road_provider_unavailable');
    assert.deepEqual(result.report.failure_detail, { kind: 'network', status: null, osrm_code: null,
        message: 'OSRM request failed: fetch failed: ENOTFOUND: getaddrinfo ENOTFOUND roads.test', host: 'roads.test' });
    const refused = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test',
        vehicleFetch: async () => ({ ok: false, status: 401, json: async () => ({ code: 'Unauthorized', message: 'A valid gateway key is required.' }) }) });
    assert.equal(refused.report.failure_detail.kind, 'auth');
    assert.equal(refused.report.failure_detail.status, 401);
});

test('access recovery asks for an edge-supported redirect mode', async () => {
    const seen = [];
    await recoverRouteVehicleAccess([stop(0), stop(1)], { vehicleBaseUrl: 'https://roads.test',
        vehicleFetch: async (_url, options) => {
            seen.push(options.redirect);
            if (options.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
            return { ok: true, status: 200, json: async () => ({ code: 'Ok', waypoints: [] }) };
        } });
    assert.ok(seen.length > 0);
    assert.ok(seen.every(mode => mode === 'manual'));
});

// The two live stops this was built from: a pin 122 m from an unnamed state
// highway, and a pin 137 m from a road Census spells two ways.
const highwayStop = { address_hash: '1770 NC HWY 90 W|28681', house_number: '1770', street_name: 'Nc Highway 90 W',
    city: 'Taylorsville', state: 'NC', zip_code: '28681', lat: 35.92061, lng: -81.206043 };
const saddleStop = { address_hash: '109 SADDLE TREE RD|28092', house_number: '109', street_name: 'Saddle Tree Rd',
    city: 'Lincolnton', state: 'NC', zip_code: '28092', lat: 35.462278, lng: -81.235464 };
function roads({ name, ref = null }) {
    const calls = [];
    const fetch = async rawUrl => {
        const url = new URL(rawUrl); calls.push(url);
        const points = url.pathname.split('/').at(-1).split(';').map(text => text.split(',').map(Number));
        const [lng, lat] = points[0];
        // The pin itself is farther than 100 m from any road.
        if (Math.abs(lat - highwayStop.lat) < 1e-6 || Math.abs(lat - saddleStop.lat) < 1e-6) {
            return response({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 0' }, 400);
        }
        const location = [lng + 0.00005, lat];
        if (url.pathname.includes('/nearest/')) return response({ code: 'Ok', waypoints: [{ name, distance: 6, location }] });
        return response({ code: 'Ok', waypoints: points.map(() => ({ name, location })),
            routes: [{ legs: [{ steps: [{ name, ref }] }] }] });
    };
    return { fetch, calls };
}
const censusBatch = row => async rawUrl => String(rawUrl).includes('addressbatch')
    ? { ok: true, text: async () => row } : null;

test('an unnamed state highway is confirmed by its route number after a near-exact Census match', async () => {
    const road = roads({ name: '', ref: 'NC 90' });
    const result = await recoverRouteVehicleAccess([highwayStop], { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocodeFetch: censusBatch(`"${highwayStop.address_hash}","1770 Nc Highway 90 W, Taylorsville, NC, 28681","Match","Non_Exact","1770 STATE HWY 90, TAYLORSVILLE, NC, 28681","-81.205936804448,35.919422664137"`) });
    assert.equal(result.report.recovered, 1, JSON.stringify(result.report.unresolved));
    const access = result.properties[0].routing_access;
    assert.equal(access.roadRef, 'NC 90');
    assert.equal(access.evidence.matchType, 'Non_Exact');
    assert.ok(road.calls.some(url => url.pathname.includes('/route/') && url.searchParams.get('steps') === 'true'),
        'the unnamed road is identified by a /route step ref');
});

test('a Census tie between two spellings of the same road recovers through the single-address candidates', async () => {
    const road = roads({ name: 'Saddletree Road' });
    const geocodeFetch = async rawUrl => {
        if (String(rawUrl).includes('addressbatch')) {
            return { ok: true, text: async () => `"${saddleStop.address_hash}","109 Saddle Tree Rd, Lincolnton, NC, 28092","Tie"` };
        }
        return response({ result: { addressMatches: [
            { matchedAddress: '109 SADDLETREE RD, LINCOLNTON, NC, 28092', coordinates: { x: -81.234476365175, y: 35.461079957415 } },
            { matchedAddress: '109 SADDLE TREE RD, LINCOLNTON, NC, 28092', coordinates: { x: -81.234232464978, y: 35.461718205258 } },
        ] } });
    };
    const result = await recoverRouteVehicleAccess([saddleStop], { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch, geocodeFetch });
    assert.equal(result.report.recovered, 1, JSON.stringify(result.report.unresolved));
    assert.equal(result.properties[0].routing_access.roadName, 'Saddletree Road');
    assert.equal(result.properties[0].routing_access.evidence.matchedAddress, '109 SADDLETREE RD, LINCOLNTON, NC, 28092');
});

test('a near-exact Census match is still rejected for a different road, number, ZIP or distance', async () => {
    for (const [label, matched, coordinates, roadName, ref] of [
        ['road', '1770 STATE HWY 16, TAYLORSVILLE, NC, 28681', '-81.205936804448,35.919422664137', '', 'NC 16'],
        ['house number', '1771 STATE HWY 90, TAYLORSVILLE, NC, 28681', '-81.205936804448,35.919422664137', '', 'NC 90'],
        ['ZIP', '1770 STATE HWY 90, TAYLORSVILLE, NC, 28682', '-81.205936804448,35.919422664137', '', 'NC 90'],
        ['distance', '1770 STATE HWY 90, TAYLORSVILLE, NC, 28681', '-81.145628991217,35.91653031475', '', 'NC 90'],
        ['unnamed road with the wrong route number', '1770 STATE HWY 90, TAYLORSVILLE, NC, 28681', '-81.205936804448,35.919422664137', '', 'US 421'],
    ]) {
        const road = roads({ name: roadName, ref });
        const result = await recoverRouteVehicleAccess([highwayStop], { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
            geocodeFetch: censusBatch(`"${highwayStop.address_hash}","x","Match","Non_Exact","${matched}","${coordinates}"`) });
        assert.equal(result.report.recovered, 0, label);
        assert.equal(result.properties[0].routing_access.resolution_status, 'unresolved', label);
    }
});

// Live: the pins of 1680 Mecklenburg Hwy and 124 Wellcraft Ct sit 158 m and
// 120 m from their own named street, beyond the 100 m match radius, while the
// geocoded address was 3 km away or on an unnamed driveway.
function streetBehindPin({ name, distance }) {
    const calls = [];
    const fetch = async rawUrl => {
        const url = new URL(rawUrl); calls.push(url);
        const [lng, lat] = url.pathname.split('/').at(-1).split(';')[0].split(',').map(Number);
        const radius = Number((url.searchParams.get('radiuses') || '100').split(';')[0]);
        if (radius < distance) return response({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 0' }, 400);
        const location = [lng, lat + distance / 111320];
        return response({ code: 'Ok', waypoints: [{ name, distance, location }] });
    };
    return { fetch, calls };
}
const mecklenburg = { address_hash: '1680 MECKLENBURG HWY|28115', house_number: '1680', street_name: 'Mecklenburg Hwy',
    city: 'Mooresville', state: 'NC', zip_code: '28115', lat: 35.532392, lng: -80.847665 };
const noGeocode = async () => ({ results: {} });

test('a pin behind its own named street is served from that street when geocoding cannot place it', async () => {
    const road = streetBehindPin({ name: 'Mecklenburg Highway', distance: 158 });
    const result = await recoverRouteVehicleAccess([mecklenburg], { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch, geocode: noGeocode });
    assert.equal(result.report.recovered, 1, JSON.stringify(result.report.unresolved));
    const access = result.properties[0].routing_access;
    assert.equal(access.source, 'pin_street_recovery');
    assert.equal(access.roadName, 'Mecklenburg Highway');
    assert.ok(road.calls.some(url => url.searchParams.get('radiuses') === '250'));
});

test('the pin fallback never uses a differently named road or one beyond 250 m', async () => {
    for (const [name, distance] of [['Pauls Lane', 150], ['Mecklenburg Highway', 260]]) {
        const road = streetBehindPin({ name, distance });
        const result = await recoverRouteVehicleAccess([mecklenburg], { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch, geocode: noGeocode });
        assert.equal(result.report.recovered, 0, `${name} at ${distance} m`);
        assert.equal(result.properties[0].routing_access.resolution_status, 'unresolved');
    }
});

test('a stop this action already failed is not re-matched, re-geocoded or re-searched on a later pass', async () => {
    const properties = [stop(0), stop(1), stop(2)];
    const road = provider(properties, { bad: [1] });
    let geocoded = 0, county = 0;
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        knownUnresolved: new Map([[properties[1].address_hash, 'address_road_not_matched']]),
        geocode: async items => { geocoded += items.length; return { results: {} }; },
        countyAccessLookup: async () => { county += 1; return null; } });
    assert.equal(result.report.unresolved.length, 1);
    assert.equal(result.report.unresolved[0].reason, 'address_road_not_matched');
    assert.equal(result.report.reused_failures, 1);
    assert.equal(geocoded + county, 0, 'no geocoding or county search for a known failure');
    assert.ok(road.calls.every(url => !url.pathname.includes(`${properties[1].lng},${properties[1].lat}`)),
        'the known failure is left out of the road match');
});

test('outages and budget limits are never reused as known failures', async () => {
    const properties = [stop(0), stop(1)];
    const road = provider(properties);
    const result = await recoverRouteVehicleAccess(properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        knownUnresolved: new Map([[properties[0].address_hash, 'road_provider_unavailable'], [properties[1].address_hash, 'recovery_limit_reached']]),
        geocode: async () => ({ results: {} }) });
    assert.equal(result.report.unresolved.length, 0, 'both are matched fresh');
});

test('with approximate access on, an unplaceable stop is routed from the nearest road and listed as approximate', async () => {
    const road = streetBehindPin({ name: 'Pauls Lane', distance: 150 });
    const result = await recoverRouteVehicleAccess([mecklenburg], { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: noGeocode, approximateAccess: true });
    assert.equal(result.report.unresolved.length, 0);
    assert.equal(result.report.approximate.length, 1);
    assert.equal(result.report.approximate[0].stop_number, 1);
    assert.equal(result.report.approximate[0].snap_meters, 150);
    const access = result.properties[0].routing_access;
    assert.equal(access.source, 'approximate_nearest_road'); assert.equal(access.approximate, true);
    assert.equal(access.evidence.unresolvedReason, 'address_not_matched');
    // A stand-in is never reused as cached access: the next action retries.
    const again = await recoverRouteVehicleAccess(result.properties, { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch, geocode: noGeocode });
    assert.equal(again.report.reused, 0);
    assert.equal(again.report.unresolved.length, 1);
});

test('approximate access stays off unless asked for, and never replaces an outage or a stop beyond 500 m', async () => {
    const off = await recoverRouteVehicleAccess([mecklenburg], { vehicleBaseUrl: 'https://roads.test',
        vehicleFetch: streetBehindPin({ name: 'Pauls Lane', distance: 150 }).fetch, geocode: noGeocode });
    assert.equal(off.report.unresolved.length, 1); assert.deepEqual(off.report.approximate, []);
    const far = await recoverRouteVehicleAccess([mecklenburg], { vehicleBaseUrl: 'https://roads.test',
        vehicleFetch: streetBehindPin({ name: 'Pauls Lane', distance: 600 }).fetch, geocode: noGeocode, approximateAccess: true });
    assert.equal(far.report.unresolved.length, 1); assert.deepEqual(far.report.approximate, []);
    const outage = await recoverRouteVehicleAccess([mecklenburg], { vehicleBaseUrl: 'https://roads.test', approximateAccess: true,
        vehicleFetch: async () => response({ code: 'InternalError' }, 503), geocode: noGeocode });
    assert.equal(outage.report.status, 'provider_unavailable');
    assert.equal(outage.report.approximate, undefined);
});

test('a stop an earlier pass already failed goes straight to the approximate stand-in', async () => {
    const road = streetBehindPin({ name: 'Pauls Lane', distance: 150 });
    let geocoded = 0;
    const result = await recoverRouteVehicleAccess([mecklenburg], { vehicleBaseUrl: 'https://roads.test', vehicleFetch: road.fetch,
        geocode: async items => { geocoded += items.length; return { results: {} }; }, approximateAccess: true,
        knownUnresolved: new Map([[mecklenburg.address_hash, 'address_not_matched']]) });
    assert.equal(geocoded, 0);
    assert.equal(result.report.reused_failures, 1);
    assert.equal(result.report.approximate.length, 1);
    assert.equal(result.report.approximate[0].reason, 'address_not_matched');
    assert.equal(road.calls.length, 1, 'only the nearest-road lookup for the stand-in');
});
