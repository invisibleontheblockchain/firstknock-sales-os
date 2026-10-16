import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverRouteVehicleAccess } from '../base44/shared/routeAccessRecovery.js';

const stop = n => ({ address_hash: `door-${n}`, house_number: String(100 + n), street_name: 'Oak Ln',
    city: 'Tampa', state: 'FL', zip_code: '33617', lat: 28 + n / 100, lng: -82 });
const reply = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const pointKey = p => `${p.lng},${p.lat}`;
function fixture(homes, { rejectFallback = false, hangFallback = false, acceptCensus = [] } = {}) {
    const calls = [], roadCalls = [];
    const original = new Set(homes.map(pointKey));
    const censusPoints = new Map(homes.map(p => [pointKey({ ...p, lat: p.lat + 0.001 }), p]));
    const vehicleFetch = async raw => {
        const url = new URL(raw); roadCalls.push(url);
        const points = url.pathname.split('/').at(-1).split(';');
        const bad = points.findIndex(p => original.has(p));
        if (bad >= 0) return reply({ code: 'NoSegment', message: `Could not find a matching segment for coordinate ${bad}` }, 400);
        return reply({ code: 'Ok', waypoints: points.map(p => {
            const home = censusPoints.get(p);
            return { location: p.split(',').map(Number), distance: 0,
                name: (home && !acceptCensus.includes(home.address_hash)) || (!home && rejectFallback) ? 'Other Road' : 'Oak Lane' };
        }) });
    };
    const geocodeFetch = async (raw, init) => {
        calls.push(String(raw));
        if (String(raw).includes('census.gov')) return { ok: true, text: async () => homes.map(p =>
            `"${p.address_hash}","input","Match","Exact","${p.house_number} OAK LN, TAMPA, FL, 33617","${p.lng},${p.lat + 0.001}","1","R"`).join('\n') };
        const requested = JSON.parse(init.body);
        calls.push({ requested: Object.keys(requested) });
        if (hangFallback) return new Promise(() => {});
        return reply({ results: Object.fromEntries(homes.filter(p => requested[p.address_hash]).map(p => [p.address_hash, {
            response: { results: [{ location: { lat: p.lat + 0.002, lng: p.lng }, accuracy: 1, accuracy_type: 'rooftop',
                formatted_address: `${p.house_number} Oak Ln, Tampa, FL 33617`, address_components: { state_province: 'FL' } }] },
        }])) });
    };
    return { calls, roadCalls, options: { vehicleFetch, geocodeFetch, geocodioApiKey: 'test-only', countyAccessLookup: false,
        mappedAccessLookup: false } };
}

test('a Census address with unusable road access automatically falls through to a verified rooftop source', async () => {
    const homes = [stop(0)], before = structuredClone(homes), f = fixture(homes);
    const out = await recoverRouteVehicleAccess(homes, f.options);
    assert.equal(out.report.recovered, 1);
    assert.deepEqual(out.report.unresolved, []);
    assert.equal(out.properties[0].routing_access.evidence.geocodeSource, 'geocodio');
    assert.deepEqual(out.properties[0].routing_access.displayPoint, { lat: homes[0].lat, lng: homes[0].lng });
    assert.deepEqual(homes, before);
    assert.deepEqual(f.calls.find(c => c.requested)?.requested, ['door-0']);
    assert.equal(f.roadCalls.length, 3, 'one preflight and one road check for each candidate, with no duplicate checks');
    assert.ok(f.roadCalls.every(url => url.searchParams.get('radiuses') === '100'));
});

test('only failed road matches use the next address source, and the successful inventory remains exact', async () => {
    const homes = [stop(0), stop(1)], f = fixture(homes, { acceptCensus: ['door-0'] });
    const out = await recoverRouteVehicleAccess(homes, f.options);
    assert.deepEqual(f.calls.find(c => c.requested)?.requested, ['door-1']);
    assert.equal(out.report.recovered, 2);
    assert.deepEqual(out.properties.map(p => p.address_hash), ['door-0', 'door-1']);
    assert.equal(out.properties[0].routing_access.evidence.geocodeSource, 'census');
    assert.equal(out.properties[1].routing_access.evidence.geocodeSource, 'geocodio');
});

test('both address sources failing road validation leave the stop unresolved at its original pin', async () => {
    const homes = [stop(0)], f = fixture(homes, { rejectFallback: true });
    const out = await recoverRouteVehicleAccess(homes, f.options);
    assert.equal(out.report.recovered, 0);
    assert.equal(out.report.unresolved[0].reason, 'address_road_mismatch');
    assert.equal(out.properties[0].lat, homes[0].lat);
    assert.deepEqual(out.report.access_overrides, {});
});

test('a stalled second source stays within the existing budget and keeps earlier verified stops', async () => {
    const homes = [stop(0), stop(1)], f = fixture(homes, { acceptCensus: ['door-0'], hangFallback: true });
    const start = Date.now();
    const out = await recoverRouteVehicleAccess(homes, { ...f.options, geocodeBudgetMs: 50 });
    assert.ok(Date.now() - start < 1000);
    assert.equal(out.report.recovered, 1);
    assert.equal(out.properties[0].routing_access.evidence.geocodeSource, 'census');
    assert.deepEqual(out.report.unresolved.map(p => p.property_id), ['door-1']);
    assert.equal(out.properties[1].lat, homes[1].lat);
});
