import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { toast } from 'sonner';
import { buildVerifiedRouteGeometry, verifiedRouteGeometry } from '../base44/shared/routeDisplayGeometry.js';
import { routePropertyOrderFingerprint } from '../base44/shared/routeFingerprint.js';
import { verifiedRouteSegments } from '../src/lib/roadAwareRouteGeometry.js';

const properties = [
    { address_hash: 'a', house_number: '102', street_name: 'Red Cedar Ln', lat: 35.80, lng: -80.90 },
    { address_hash: 'b', house_number: '103', street_name: 'Red Cedar Ln', lat: 35.80, lng: -80.89 },
    { address_hash: 'c', house_number: '108', street_name: 'Red Cedar Ln', lat: 35.79, lng: -80.90 },
];
const points = [{ lat: 35.80, lng: -80.895 }, { lat: 35.795, lng: -80.895 }, { lat: 35.79, lng: -80.895 }];
const measurement = (order = properties, geometry = points) => ({ geometry,
    directedLegs: order.slice(1).map((stop, i) => ({ from: order[i].address_hash, to: stop.address_hash,
        geometry: points.slice(i, i + 2) })) });
const metadata = (order = properties, geometry = points) => ({
    ...buildVerifiedRouteGeometry({ measurement: measurement(order, geometry), properties: order }),
    routing: { property_order_fingerprint: routePropertyOrderFingerprint(order) },
    property_order_fingerprint: routePropertyOrderFingerprint(order), road_path_validated: true,
    input_measured: 10, winning_route_distance: 8, road_network_used: true, distance_estimate: 'road_measured',
    neighborhood_excursion_review: { local_driving_review: { validation: 'whole_route' } },
});

test('retained driving geometry follows the measured road independently of stop-line display', () => {
    const meta = metadata();
    assert.deepEqual(verifiedRouteSegments(meta, properties, properties), [points]);
    assert.notDeepEqual(points, properties.map(({ lat, lng }) => ({ lat, lng })));
});

test('recovered vehicle entrances bind the path to original house pins, not shifted service coordinates', () => {
    const recovered = properties.map((stop, i) => i === 0 ? { ...stop, lat: 35.805, lng: -80.895,
        routing_access: { point: { lat: 35.805, lng: -80.895 }, displayPoint: { lat: stop.lat, lng: stop.lng } } } : stop);
    const meta = { ...metadata(), ...buildVerifiedRouteGeometry({ measurement: measurement(recovered),
        properties: recovered, displayProperties: properties }) };
    assert.deepEqual(verifiedRouteSegments(meta, properties, properties), [points]);
    assert.deepEqual(verifiedRouteSegments(meta, properties, recovered), []);
    assert.deepEqual(buildVerifiedRouteGeometry({ measurement: measurement(recovered), properties: recovered,
        displayProperties: properties.slice(1) }), {});
});

test('large verified geometry preserves every road vertex across bounded overlapping segments', () => {
    const geometry = Array.from({ length: 50000 }, (_, i) => ({ lat: 35.8 + i / 1000000, lng: -80.9 }));
    const segments = verifiedRouteSegments(metadata(properties, geometry), properties, properties);
    assert.equal(segments.length, 5);
    assert.ok(segments.every(segment => segment.length <= 12000));
    assert.deepEqual(segments.flatMap((segment, i) => i ? segment.slice(1) : segment), geometry);
});

test('geometry builder rejects incomplete directed measurements and oversized geometry', () => {
    for (const bad of [null, { ...measurement(), directedLegs: [] },
        { ...measurement(), directedLegs: [{ from: 'c', to: 'b', geometry: points }, measurement().directedLegs[1]] },
        measurement(properties, [{ lat: null, lng: -80.9 }, points[1]]),
        measurement(properties, Array(100001).fill(points[0]))]) {
        assert.deepEqual(buildVerifiedRouteGeometry({ measurement: bad, properties }), {});
    }
});

test('personal or custom trip boundaries cannot enter shared geometry', () => {
    for (const bounds of [{ startLocation: properties[0] }, { endLocation: properties[0] },
        { startLocation: properties[0], endLocation: properties[0] }]) {
        assert.deepEqual(buildVerifiedRouteGeometry({ measurement: measurement(), properties, ...bounds }), {});
    }
});

test('reorders, moved pins, partial inventories and damaged segments invalidate displayed geometry', () => {
    const meta = metadata();
    assert.deepEqual(verifiedRouteSegments(meta, [...properties].reverse(), properties), []);
    assert.deepEqual(verifiedRouteSegments(meta, properties, properties.slice(1)), []);
    assert.deepEqual(verifiedRouteSegments(meta, properties, properties.map((stop, i) => i ? stop : { ...stop, lat: 35.81 })), []);
    assert.deepEqual(verifiedRouteSegments({ ...meta, road_path_validated: false }, properties, properties), []);
    assert.deepEqual(verifiedRouteSegments({ ...meta, road_access_recovery: { unresolved: ['a'] } }, properties, properties), []);
    assert.deepEqual(verifiedRouteSegments({ ...meta, road_access_recovery: { inventory_complete: false } }, properties, properties), []);
    assert.deepEqual(verifiedRouteSegments({ ...meta, road_geometry_segments: [{ points: [points[0], { lat: 91, lng: 0 }] }] }, properties, properties), []);
    assert.deepEqual(verifiedRouteSegments({ ...meta, road_geometry_provenance: { ...meta.road_geometry_provenance, point_count: 4 } }, properties, properties), []);
    const large = metadata(properties, Array.from({ length: 13000 }, (_, i) => ({ lat: 35.8 + i / 1000000, lng: -80.9 })));
    large.road_geometry_segments[1].points[0].lat += 0.001;
    assert.deepEqual(verifiedRouteSegments(large, properties, properties), []);
});

test('legacy and beta geometry still require the exact manifest and reject invalid coordinates', () => {
    const legacy = { road_geometry: points, routing: { property_order_fingerprint: routePropertyOrderFingerprint(properties) } };
    assert.deepEqual(verifiedRouteSegments(legacy, properties, properties), [points]);
    assert.deepEqual(verifiedRouteSegments(legacy, [...properties].reverse()), []);
    assert.deepEqual(verifiedRouteSegments({ ...legacy, road_geometry: [{ lat: null, lng: 0 }, points[1]] }, properties), []);
});

let vite, buildUpdate, buildAnchors, optimize;
const originalToast = {};
before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    ({ buildRouteOptimizeUpdate: buildUpdate } = await vite.ssrLoadModule('/src/lib/routeOptimizeUpdate.js'));
    ({ buildRouteAnchorsUpdate: buildAnchors } = await vite.ssrLoadModule('/src/lib/routeAnchors.js'));
    ({ reoptimizeRoute: optimize } = await vite.ssrLoadModule('/src/lib/reoptimizeRouteAction.js'));
    for (const key of ['loading', 'success', 'error', 'info', 'warning']) { originalToast[key] = toast[key]; toast[key] = () => {}; }
});
after(async () => { Object.assign(toast, originalToast); await vite?.close(); });

test('a new route-only save keeps fresh geometry and deletes stale legacy paths', () => {
    const hashes = properties.map(stop => stop.address_hash);
    const update = buildUpdate({ optimizeMode: 'route_only', order: hashes, distanceMiles: 8,
        existingMetadata: { road_geometry: [properties[0], properties[2]], road_geometry_segments: ['old'], keep: 1 },
        routingMetadata: metadata() });
    assert.equal(update.metadata.keep, 1);
    assert.equal(update.metadata.road_geometry, undefined);
    assert.deepEqual(verifiedRouteSegments(update.metadata, hashes, properties), [points]);
    const stale = buildUpdate({ optimizeMode: 'route_only', order: [...hashes].reverse(), distanceMiles: 8,
        existingMetadata: metadata(), routingMetadata: metadata() });
    assert.equal(stale.metadata.road_geometry_segments, undefined);
    assert.equal(stale.metadata.road_geometry_provenance, undefined);
});

test('home/car saves and setting custom anchors strip every geometry field', () => {
    const common = { order: properties.map(stop => stop.address_hash), distanceMiles: 8,
        existingMetadata: metadata(), routingMetadata: metadata() };
    for (const result of ['home_round_trip', 'car_round_trip'].map(optimizeMode => buildUpdate({ ...common, optimizeMode }))
        .concat(buildAnchors({ ...common, start: properties[0] }))) {
        assert.equal(result.metadata.road_geometry, undefined);
        assert.equal(result.metadata.road_geometry_segments, undefined);
        assert.equal(result.metadata.road_geometry_provenance, undefined);
    }
    assert.ok(verifiedRouteGeometry(buildAnchors(common).metadata, common.order, properties));
});

async function runOptimize({ current = false } = {}) {
    const originalHashes = properties.map(stop => stop.address_hash);
    const order = current ? properties : [properties[1], properties[0], properties[2]];
    const route = { id: 'red-cedar', property_hashes: originalHashes, properties, allProperties: properties,
        route_origin_mode: 'none', metrics: { distance: 10 }, metadata: { road_geometry: ['stale'] } };
    let written, active = route;
    const client = { functions: { invoke: async () => ({ data: { success: true, selected: current ? 'current' : 'road_aware',
        order: order.map(stop => stop.address_hash), routing_metadata: metadata(order) } }) },
    entities: { SavedRoute: { update: async (_id, update) => { written = update; return { ...route, ...update }; } } } };
    await optimize(route, { mode: 'route_only' }, { client, setActiveRoute: updater => { active = updater(active); } });
    return { written, active, order, originalHashes };
}

test('the real Optimize action persists geometry together with the accepted order', async () => {
    const { written, active, order } = await runOptimize();
    assert.deepEqual(written.property_hashes, order.map(stop => stop.address_hash));
    assert.deepEqual(verifiedRouteSegments(written.metadata, written.property_hashes, order), [points]);
    assert.deepEqual(verifiedRouteSegments(active.metadata, active.property_hashes, active.properties), [points]);
});

test('a verified unchanged order still publishes its freshly measured driving line', async () => {
    const { written, active, originalHashes } = await runOptimize({ current: true });
    assert.equal(written.property_hashes, undefined, 'no manifest rewrite for an unchanged order');
    assert.equal(written.metadata.road_geometry, undefined);
    assert.deepEqual(active.property_hashes, originalHashes);
    assert.deepEqual(verifiedRouteSegments(active.metadata, originalHashes, active.properties), [points]);
});
