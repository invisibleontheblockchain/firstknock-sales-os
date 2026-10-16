import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTY_ROAD_SERVICE, COUNTY_ADDRESS_SERVICE, discoverCountyRoadAccess, validateCountyRoadAccess,
    discoverCountyAddressReference, validateCountyAddressReference } from '../base44/shared/countyRoadAccess.js';

const stop = { address_hash: '1135 STONEGATE DR|28147', house_number: '1135', street_name: 'Stonegate Dr',
    city: 'Salisbury', state: 'NC', zip_code: '28147', lat: 35.645, lng: -80.6115 };
const gateway = { lat: 35.647, lng: -80.612 };
const middle = { lat: 35.6455, lng: -80.612 };
const end = { lat: 35.643, lng: -80.612 };
const pairs = points => points.map(p => [p.lng, p.lat]);
const response = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
const road = (id, name, points, fields = {}) => ({ attributes: { objectid: id, st_name: name, st_postyp: 'DRIVE',
    fromaddr_l: 1101, toaddr_l: 1199, fromaddr_r: 1100, toaddr_r: 1198, postcode_l: '28147', postcode_r: '28147',
    dateupdate: 1760000000000, oneway: 'BI', ...fields }, geometry: { paths: [pairs(points)] } });
const defaultRoads = () => [
    road(2, 'STONEGATE', [middle, end]),
    road(1, 'STONEGATE', [gateway, middle], { fromaddr_l: 1001, toaddr_l: 1099, fromaddr_r: 1000, toaddr_r: 1098 }),
    road(3, 'COPPERGATE', [{ lat: gateway.lat, lng: gateway.lng - 0.005 }, gateway, { lat: gateway.lat, lng: gateway.lng + 0.005 }]),
];
const countyAddress = point => ({ attributes: { objectid: 77, st_address: '1135 STONEGATE DRIVE', add_number: '1135',
    post_code: '28147', state: 'NC', dateupdate: 1760000000000, placement: 'ORTHO' }, geometry: { x: point.lng, y: point.lat } });

function providers({ roads = defaultRoads(), addresses = [countyAddress(stop)], nearest, roadPayload, addressPayload } = {}) {
    const calls = [];
    const fetchImpl = async raw => {
        const url = new URL(raw); calls.push(url);
        if (url.origin + url.pathname === COUNTY_ROAD_SERVICE) return response(roadPayload || { features: roads });
        if (url.origin + url.pathname === COUNTY_ADDRESS_SERVICE) return response(addressPayload || { features: addresses });
        throw new Error('Unexpected county source');
    };
    const vehicleFetch = async raw => {
        const url = new URL(raw); calls.push(url);
        return response(nearest || { code: 'Ok', waypoints: [{ name: 'Coppergate Drive', distance: 0,
            location: [gateway.lng, gateway.lat] }] });
    };
    return { fetchImpl, vehicleFetch, calls };
}

test('authoritative road discovery binds exact address ranges, connected geometry and real provider junction', async () => {
    const p = providers(); const before = structuredClone(stop);
    const access = await discoverCountyRoadAccess(stop, p);
    assert.ok(access); assert.equal(access.roadName, stop.street_name);
    assert.deepEqual(access.point, { lat: stop.lat, lng: -80.612 });
    assert.equal(access.network.segments.length, 2);
    assert.deepEqual(access.network.segments.map(s => s.id), ['nc911:1:0', 'nc911:2:0']);
    assert.deepEqual(access.gateway.point, gateway); assert.deepEqual(access.gateway.providerPoint, gateway);
    assert.equal(access.gateway.countyRoadId, 'nc911:3:0');
    assert.equal(access.evidence.propertyIdentity, stop.address_hash);
    assert.equal(access.evidence.addressRangeVerified, true);
    assert.equal(access.evidence.addressSource, 'nc_address_point');
    assert.deepEqual(access.address_match, { house_number: '1135', street_name: 'Stonegate Dr', zip_code: '28147',
        state: 'NC', point: { lat: stop.lat, lng: stop.lng }, source: 'nc_address_point' });
    assert.deepEqual(stop, before);
    assert.equal(p.calls.length, 3);
    const countyQuery = p.calls.find(url => url.origin + url.pathname === COUNTY_ROAD_SERVICE);
    assert.equal(countyQuery.searchParams.get('outSR'), '4326');
    assert.equal(countyQuery.searchParams.get('inSR'), '4326');
    assert.equal(countyQuery.searchParams.get('resultRecordCount'), '1000');
    const nearestQuery = p.calls.find(url => url.pathname.includes('/nearest/'));
    assert.equal(nearestQuery.searchParams.get('radiuses'), '10');
});

test('exact official address corrects a parcel pin before selecting its road frontage', async () => {
    const property = { ...stop, lat: stop.lat + 0.0012, lng: stop.lng + 0.0008 };
    const p = providers({ addresses: [countyAddress(stop)] });
    const access = await discoverCountyRoadAccess(property, p);
    assert.ok(access);
    assert.deepEqual(access.point, { lat: stop.lat, lng: -80.612 });
    assert.deepEqual(access.evidence.displayPoint, { lat: property.lat, lng: property.lng });
    assert.equal(access.evidence.addressId, 'nc_address:77');
});

test('an exact county identity reference survives a parcel-centroid offset without proving a driveway', async () => {
    const parcelPin = { ...stop, lat: stop.lat + 0.006 };
    const p = providers();
    const reference = await discoverCountyAddressReference(parcelPin, p);
    assert.ok(reference);
    assert.equal(reference.source, 'nc_address_point');
    assert.deepEqual(reference.point, { lat: stop.lat, lng: stop.lng });
    assert.equal(validateCountyAddressReference(parcelPin, reference), true);
    assert.equal(reference.network, undefined, 'address identity alone cannot supply driving proof');
    assert.equal(p.calls.length, 1, 'only the exact county address inventory is read');
    assert.equal(p.calls[0].searchParams.get('where'), "add_number='1135' AND post_code='28147'");
});

test('county reference rejects ambiguous addresses, truncated inventory and distant exact matches', async () => {
    assert.equal(await discoverCountyAddressReference(stop, providers({ addresses: [countyAddress(stop),
        countyAddress({ ...stop, lat: stop.lat + 0.0001 })] })), null);
    assert.equal(await discoverCountyAddressReference(stop, providers({ addressPayload: {
        features: [countyAddress(stop)], exceededTransferLimit: true,
    } })), null);
    assert.equal(await discoverCountyAddressReference({ ...stop, lat: stop.lat + 0.01 }, providers()), null);
});

test('cached county identity references remain bound to exact house, ZIP and source record', async () => {
    const reference = await discoverCountyAddressReference(stop, providers());
    assert.ok(reference);
    assert.equal(validateCountyAddressReference({ ...stop, house_number: '1137' }, reference), false);
    assert.equal(validateCountyAddressReference({ ...stop, zip_code: '28148' }, reference), false);
    assert.equal(validateCountyAddressReference(stop, { ...reference, id: 'nc_address:78' }), false);
    assert.equal(validateCountyAddressReference(stop, { ...reference, source: 'property_pin' }), false);
});

test('missing county address uses a nearby pin only with exact street, ZIP and number range evidence', async () => {
    const access = await discoverCountyRoadAccess(stop, providers({ addresses: [] }));
    assert.ok(access); assert.equal(access.evidence.addressSource, 'property_pin');
});

test('oversized county components stop before graph construction or public gateway requests', async () => {
    const roads = defaultRoads();
    roads[0].geometry.paths[0] = Array.from({ length: 5001 }, (_, i) => [middle.lng,
        middle.lat + (end.lat - middle.lat) * i / 5000]);
    const p = providers({ roads });
    assert.equal(await discoverCountyRoadAccess(stop, p), null);
    assert.equal(p.calls.some(url => url.pathname.includes('/nearest/')), false);
});

test('component identity stays stable across stop positions and provider feature ordering', async () => {
    const first = await discoverCountyRoadAccess(stop, providers());
    const second = await discoverCountyRoadAccess({ ...stop, lat: stop.lat - 0.0002 }, providers({ roads: defaultRoads().reverse() }));
    assert.ok(first && second);
    assert.equal(first.network.id, second.network.id);
    assert.equal(first.network.version, second.network.version);
});

test('component identity and version change when authoritative geometry changes', async () => {
    const first = await discoverCountyRoadAccess(stop, providers());
    const roads = defaultRoads(); roads[0].geometry.paths[0].splice(1, 0, [-80.61199, 35.644]);
    const second = await discoverCountyRoadAccess(stop, providers({ roads }));
    assert.ok(first && second);
    assert.notEqual(first.network.id, second.network.id);
    assert.notEqual(first.network.version, second.network.version);
});

for (const [label, fields, expected] of [
    ['legacy absent direction', { oneway: null }, 'both'],
    ['explicit bidirectional', { oneway: 'BI' }, 'both'],
    ['legacy non-oneway', { oneway: 'N' }, 'both'],
    ['forward direction', { oneway: 'FT' }, 'forward'],
    ['reverse direction', { oneway: 'TF' }, 'reverse'],
]) test(`county routing preserves ${label} evidence`, async () => {
    const roads = defaultRoads(); Object.assign(roads[0].attributes, fields);
    const access = await discoverCountyRoadAccess(stop, providers({ roads }));
    assert.ok(access);
    const segment = access.network.segments.find(s => s.id === 'nc911:2:0');
    assert.equal(segment.oneway, expected);
    assert.equal(segment.raw_oneway, fields.oneway);
    assert.equal(segment.direction_source, fields.oneway ? 'recorded' : 'not_recorded');
});

for (const [label, alter] of [
    ['wrong number range', roads => { roads[0].attributes.fromaddr_l = 1201; roads[0].attributes.toaddr_l = 1299; }],
    ['wrong odd-even parity', roads => { roads[0].attributes.parity_l = 'E'; }],
    ['wrong postal code', roads => { roads[0].attributes.postcode_l = '28148'; roads[0].attributes.postcode_r = '28148'; }],
    ['unrecognized direction restriction', roads => { roads[0].attributes.oneway = 'X'; }],
    ['expired road', roads => { roads[0].attributes.expire = 1; }],
    ['wrong street name', roads => { roads[0].attributes.st_name = 'UNRELATED'; }],
    ['missing real county junction', roads => { roads[2].geometry.paths[0] = pairs([{ lat: gateway.lat + 0.0001, lng: gateway.lng }, { lat: gateway.lat + 0.001, lng: gateway.lng }]); }],
]) test(`county discovery rejects ${label}`, async () => {
    const roads = defaultRoads(); alter(roads);
    assert.equal(await discoverCountyRoadAccess(stop, providers({ roads })), null);
});

test('unrelated nearby provider road is never accepted as the county road gateway', async () => {
    const access = await discoverCountyRoadAccess(stop, providers({ nearest: { code: 'Ok', waypoints: [
        { name: 'Unrelated Drive', distance: 0, location: [gateway.lng, gateway.lat] },
    ] } }));
    assert.equal(access, null);
});

test('junction snap exceeding ten metres is rejected even when its street name agrees', async () => {
    const access = await discoverCountyRoadAccess(stop, providers({ nearest: { code: 'Ok', waypoints: [
        { name: 'Coppergate Drive', distance: 10.1, location: [gateway.lng, gateway.lat] },
    ] } }));
    assert.equal(access, null);
});

test('truncated road inventory is rejected instead of inventing a complete component', async () => {
    const access = await discoverCountyRoadAccess(stop, providers({ roadPayload: { features: defaultRoads(), exceededTransferLimit: true } }));
    assert.equal(access, null);
});

test('ambiguous exact county addresses are rejected instead of selecting the first', async () => {
    const access = await discoverCountyRoadAccess(stop, providers({ addresses: [countyAddress(stop), countyAddress({ ...stop, lat: stop.lat + 0.0001 })] }));
    assert.equal(access, null);
});

test('frontage farther than one hundred metres from the matched county address remains unresolved', async () => {
    const access = await discoverCountyRoadAccess({ ...stop, lng: -80.609 }, providers({ addresses: [] }));
    assert.equal(access, null);
});

test('two valid gateway junctions remain ambiguous', async () => {
    const roads = defaultRoads(); roads.push(road(4, 'SECOND', [{ lat: end.lat, lng: end.lng - 0.001 }, end]));
    const p = providers({ roads });
    p.vehicleFetch = async raw => {
        const point = new URL(raw).pathname.split('/').at(-1).split(',').map(Number);
        return response({ code: 'Ok', waypoints: [{ name: point[1] === gateway.lat ? 'Coppergate Drive' : 'Second Drive',
            distance: 0, location: point }] });
    };
    assert.equal(await discoverCountyRoadAccess(stop, p), null);
});

test('out-of-state stops do not query a North Carolina authority', async () => {
    const p = providers();
    assert.equal(await discoverCountyRoadAccess({ ...stop, state: 'SC' }, p), null);
    assert.equal(p.calls.length, 0);
});

test('county provider outages fail closed and cancellation propagates', async () => {
    assert.equal(await discoverCountyRoadAccess(stop, { fetchImpl: async () => { throw new Error('unavailable'); } }), null);
    const controller = new AbortController(); const error = new Error('cancelled'); controller.abort(error);
    await assert.rejects(discoverCountyRoadAccess(stop, { ...providers(), signal: controller.signal }), value => value === error);
});

test('component extending outside the first envelope is fetched once more with a bounded larger envelope', async () => {
    const roads = defaultRoads(); roads[0].geometry.paths[0].push([-80.612, 35.630]);
    const p = providers({ roads });
    const access = await discoverCountyRoadAccess(stop, p);
    assert.ok(access);
    const countyQueries = p.calls.filter(url => url.origin + url.pathname === COUNTY_ROAD_SERVICE);
    assert.equal(countyQueries.length, 2);
    const firstBox = countyQueries[0].searchParams.get('geometry').split(',').map(Number);
    const lastBox = countyQueries[1].searchParams.get('geometry').split(',').map(Number);
    assert.ok(lastBox[0] < firstBox[0] && lastBox[1] < firstBox[1]);
    assert.equal(validateCountyRoadAccess(stop, access), true);
});

test('component still extending outside the second envelope remains unresolved after two bounded inventories', async () => {
    const roads = defaultRoads(); roads[0].geometry.paths[0].push([-80.612, 35.600]);
    const p = providers({ roads });
    assert.equal(await discoverCountyRoadAccess(stop, p), null);
    assert.equal(p.calls.filter(url => url.origin + url.pathname === COUNTY_ROAD_SERVICE).length, 2);
    assert.equal(p.calls.filter(url => url.pathname.includes('/nearest/')).length, 0);
});

for (const [label, alter] of [
    ['another property identity', access => { access.evidence.propertyIdentity = 'other'; }],
    ['moved display pin', access => { access.evidence.displayPoint.lat += 0.001; }],
    ['wrong address number', access => { access.address_match.house_number = '999'; }],
    ['wrong address ZIP', access => { access.address_match.zip_code = '28148'; }],
    ['wrong address street', access => { access.address_match.street_name = 'Unrelated Dr'; }],
    ['wrong authoritative source', access => { access.evidence.sourceService = 'https://example.com'; }],
    ['unproven address range', access => { access.evidence.addressRangeVerified = false; }],
    ['incomplete component', access => { access.evidence.completeComponent = false; }],
    ['changed graph geometry', access => { access.network.segments[0].geometry[0].lat += 0.001; }],
    ['changed graph direction', access => { access.network.segments[0].oneway = 'reverse'; }],
    ['changed graph version', access => { access.network.version = 'invented'; }],
    ['service point off the road', access => { access.point.lng += 0.0001; }],
    ['gateway off the county junction', access => { access.gateway.point.lat += 0.001; }],
    ['provider gateway across a field', access => { access.gateway.providerPoint.lng += 0.001; }],
    ['gateway snap beyond ten metres', access => { access.gateway.snapMeters = 10.01; }],
    ['unrelated provider gateway street', access => { access.gateway.roadName = 'Unrelated Dr'; }],
    ['missing crossroad evidence', access => { delete access.gateway.countyRoad; }],
    ['moved mapped crossroad', access => { access.gateway.countyRoad.geometry.forEach(point => { point.lat += 0.001; }); }],
    ['stale expired address', access => { access.evidence.addressAttributes.expire = 1; }],
    ['changed official address', access => { access.evidence.addressAttributes.st_address = '1135 OTHER DRIVE'; }],
]) test(`cached county road evidence rejects ${label}`, async () => {
    const access = await discoverCountyRoadAccess(stop, providers());
    assert.ok(access); alter(access);
    assert.equal(validateCountyRoadAccess(stop, access), false);
});

test('opt-in county diagnostics identify source and selection stages without exposing requests or properties', async () => {
    const diagnostics = [];
    const access = await discoverCountyRoadAccess(stop, { ...providers(), onDiagnostic: event => diagnostics.push(event) });
    assert.ok(access);
    assert.ok(diagnostics.some(event => event.service === 'county_roads' && event.stage === 'response' && event.featureCount === 3));
    assert.ok(diagnostics.some(event => event.stage === 'targetRange' && event.outcome === 'accepted'));
    assert.ok(diagnostics.some(event => event.stage === 'countyAddress' && event.outcome === 'accepted'));
    assert.ok(diagnostics.some(event => event.service === 'public_gateway' && event.stage === 'gatewayCount' && event.acceptedCount === 1));
    assert.ok(diagnostics.some(event => event.stage === 'validation' && event.reason === 'complete_proof'));
    const serialized = JSON.stringify(diagnostics);
    for (const privateValue of ['1135', '28147', 'Stonegate', '35.645', '-80.6115', 'https://', 'geometry=', 'where=']) {
        assert.ok(!serialized.includes(privateValue), `diagnostics must omit ${privateValue}`);
    }
});

test('non-JSON HTML source failures reveal content class and status without response body', async () => {
    const diagnostics = [];
    const access = await discoverCountyRoadAccess(stop, { onDiagnostic: event => diagnostics.push(event), fetchImpl: async () => ({
        ok: false, status: 403, headers: { get: () => 'text/html' },
        json: async () => { throw new Error('<html>1135 Stonegate secret=private</html>'); },
    }) });
    assert.equal(access, null);
    assert.ok(diagnostics.some(event => event.stage === 'error' && event.reason === 'response_not_json'
        && event.httpStatus === 403 && event.bodyType === 'html'));
    assert.ok(!JSON.stringify(diagnostics).includes('private'));
    assert.ok(!JSON.stringify(diagnostics).includes('Stonegate'));
});

test('structured source errors expose bounded sanitized provider information', async () => {
    const diagnostics = [];
    const access = await discoverCountyRoadAccess(stop, { ...providers(), onDiagnostic: event => diagnostics.push(event),
        fetchImpl: async () => response({ error: { code: 499, message:
            'Token required at https://example.com/query?where=1135 secret=private Bearer abc123 "1135 Stonegate Dr"' } }, 403) });
    assert.equal(access, null);
    const event = diagnostics.find(event => event.stage === 'error');
    assert.equal(event.errorCode, 499); assert.equal(event.httpStatus, 403);
    assert.ok(event.message.length <= 200);
    for (const privateValue of ['https://', '1135', 'private', 'abc123', 'Stonegate']) assert.ok(!event.message.includes(privateValue));
});

test('diagnostic callback exceptions cannot alter road access acceptance', async () => {
    const access = await discoverCountyRoadAccess(stop, { ...providers(), onDiagnostic: () => { throw new Error('debug failed'); } });
    assert.ok(access);
});

test('native fetch network diagnostics expose sanitized exception classification without request data', async () => {
    const diagnostics = [];
    const access = await discoverCountyRoadAccess(stop, { onDiagnostic: event => diagnostics.push(event), fetchImpl: async () => {
        throw new TypeError('error sending request for url https://example.com/query?where=1135 secret=private "1135 Stonegate Dr": TLS certificate expired');
    } });
    assert.equal(access, null);
    const event = diagnostics.find(value => value.reason === 'network_error');
    assert.equal(event.errorName, 'TypeError');
    assert.match(event.message, /TLS certificate expired/);
    for (const privateValue of ['https://', '1135', 'private', 'Stonegate']) assert.ok(!event.message.includes(privateValue));
});

test('county discovery uses edge-supported manual redirect mode for every source and gateway request', async () => {
    const p = providers(); const redirects = [];
    const edge = fetchImpl => async (url, options) => {
        if (options.redirect === 'error') throw new TypeError('Invalid redirect value, must be follow or manual');
        redirects.push(options.redirect);
        return fetchImpl(url, options);
    };
    const access = await discoverCountyRoadAccess(stop, { fetchImpl: edge(p.fetchImpl), vehicleFetch: edge(p.vehicleFetch) });
    assert.ok(access);
    assert.equal(redirects.length, 3);
    assert.ok(redirects.every(value => value === 'manual'));
});

for (const [label, properties] of [
    ['HTTP redirect', { status: 302, ok: false }],
    ['opaque redirect', { status: 0, ok: false, type: 'opaqueredirect' }],
    ['already followed redirect', { status: 200, ok: true, redirected: true }],
]) test(`county discovery rejects ${label} before reading or trusting the body`, async () => {
    const diagnostics = []; let parsed = false;
    const access = await discoverCountyRoadAccess(stop, { onDiagnostic: event => diagnostics.push(event),
        fetchImpl: async () => ({ ...properties, json: async () => { parsed = true; return { features: defaultRoads() }; } }) });
    assert.equal(access, null); assert.equal(parsed, false);
    assert.ok(diagnostics.some(event => event.reason === 'redirect_rejected'));
});

test('a redirecting public gateway cannot establish accepted county road access', async () => {
    const p = providers(); const diagnostics = []; let parsed = false;
    const access = await discoverCountyRoadAccess(stop, { ...p, onDiagnostic: event => diagnostics.push(event),
        vehicleFetch: async () => ({ ok: false, status: 301, json: async () => { parsed = true; return {}; } }) });
    assert.equal(access, null); assert.equal(parsed, false);
    assert.ok(diagnostics.some(event => event.service === 'public_gateway' && event.reason === 'redirect_rejected'));
});
