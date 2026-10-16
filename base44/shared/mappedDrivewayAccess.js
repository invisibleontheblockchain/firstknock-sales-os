import { haversineDistanceMiles, isValidRoutePoint } from './routeBounds.js';
import { roadNetworkRoutingInternals } from './roadNetworkRouting.js';
import { discoverCountyAddressReference, validateCountyAddressReference } from './countyRoadAccess.js';
import { vehicleProviderConfig } from './vehicleProviderConfig.js';

const POLICY = 'county_address_mapped_driveway_v1';
const OSM_MAP = 'https://api.openstreetmap.org/api/0.6/map.json';
const MAX_BYTES = 2_000_000;
const MAX_ELEMENTS = 20_000;
const MAX_COMPONENT_WAYS = 16;
const MAX_COMPONENT_NODES = 1000;
const MAX_PROOF_BYTES = 128000;
const MAX_AGE = 86400000;
const PUBLIC_HIGHWAYS = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road']);
const TAGS = new Set(['highway', 'service', 'name', 'oneway', 'junction', 'access', 'vehicle', 'motor_vehicle', 'motorcar',
    'access:conditional', 'vehicle:conditional', 'motor_vehicle:conditional', 'motorcar:conditional', 'oneway:conditional',
    'barrier', 'area', 'type', 'restriction', 'addr:housenumber', 'addr:street', 'addr:postcode', 'addr:state', 'addr:country', 'addr:unit']);
const point = value => ({ lat: Number(value.lat), lng: Number(value.lng ?? value.lon) });
const id = value => String(value?.address_hash || value?.legacy_hash || value?.id || '');
const key = value => roadNetworkRoutingInternals.normalizeStreetName(value);
const meters = (a, b) => haversineDistanceMiles(point(a), point(b)) * 1609.344;
const cancelled = signal => { if (signal?.aborted) throw signal.reason || Object.assign(new Error('Mapped access lookup cancelled.'), { name: 'AbortError' }); };
const equal = (a, b, tolerance = 0.1) => isValidRoutePoint(point(a || {})) && isValidRoutePoint(point(b || {})) && meters(a, b) <= tolerance;
function tagsOf(tags) {
    if (tags === undefined) return {};
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return null;
    const selected = {};
    for (const [name, value] of Object.entries(tags)) if (TAGS.has(name)
        || /^(?:access|vehicle|motor_vehicle|motorcar|oneway|restriction):/.test(name)) {
        // Dropping a malformed restriction or highway tag would erase evidence
        // of a competing or forbidden access. Reject that inventory instead.
        if (typeof value !== 'string' || value.length > 150) return null;
        selected[name] = value;
    }
    return selected;
}

function bounds(reference) {
    const dy = 750 / 111195, dx = 750 / (111195 * Math.cos(reference.lat * Math.PI / 180));
    return { xmin: reference.lng - dx, ymin: reference.lat - dy, xmax: reference.lng + dx, ymax: reference.lat + dy };
}

function inside(p, box) {
    return p.lng > box.xmin && p.lng < box.xmax && p.lat > box.ymin && p.lat < box.ymax;
}

function projection(p, geometry) {
    let best = null;
    const sx = 111195 * Math.cos(p.lat * Math.PI / 180), sy = 111195;
    for (let i = 0; i < geometry.length - 1; i++) {
        const a = geometry[i], b = geometry[i + 1];
        const ax = (a.lng - p.lng) * sx, ay = (a.lat - p.lat) * sy;
        const dx = (b.lng - a.lng) * sx, dy = (b.lat - a.lat) * sy;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        const projected = { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
        const distance = meters(p, projected);
        if (!best || distance < best.meters) best = { point: projected, meters: distance };
    }
    return best;
}

function nearGeometry(left, right) {
    if (left.some(p => projection(p, right)?.meters <= 25) || right.some(p => projection(p, left)?.meters <= 25)) return true;
    const orient = (a, b, c) => (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
    for (let i = 1; i < left.length; i++) for (let j = 1; j < right.length; j++) {
        const a = left[i - 1], b = left[i], c = right[j - 1], d = right[j];
        if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) return true;
    }
    // A closed building outline may surround the driveway's house-side end.
    if (equal(left[0], left.at(-1))) for (const p of right) {
        let inside = false;
        for (let i = 0, j = left.length - 1; i < left.length; j = i++) {
            const a = left[i], b = left[j];
            if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lng < (b.lng - a.lng) * (p.lat - a.lat) / (b.lat - a.lat) + a.lng) inside = !inside;
        }
        if (inside) return true;
    }
    return false;
}

function allowed(tags = {}) {
    if (Object.keys(tags).some(name => /^(?:access|vehicle|motor_vehicle|motorcar|oneway):/.test(name))) return false;
    if (['access', 'vehicle', 'motor_vehicle', 'motorcar'].some(name => tags[name] && !['yes', 'permissive', 'designated', 'destination'].includes(tags[name]))) return false;
    return !tags.barrier || ['entrance', 'no'].includes(tags.barrier);
}

function direction(tags) {
    const value = String(tags.oneway || (tags.junction === 'roundabout' ? 'yes' : 'no')).toLowerCase();
    return ['yes', 'true', '1'].includes(value) ? 1 : value === '-1' ? -1 : ['no', 'false', '0'].includes(value) ? 0 : null;
}

function explicitAddress(node, stop) {
    const tags = node.tags || {};
    return tags['addr:housenumber'] === String(stop.house_number || '').trim()
        && key(tags['addr:street']) === key(stop.street_name)
        && String(tags['addr:postcode'] || '').slice(0, 5) === String(stop.zip_code || '').slice(0, 5)
        && (!tags['addr:state'] || tags['addr:state'].toUpperCase() === 'NC')
        && (!tags['addr:country'] || tags['addr:country'].toUpperCase() === 'US') && !tags['addr:unit'];
}

function snapshotOf(payload) {
    if (!Array.isArray(payload?.elements) || payload.elements.length > MAX_ELEMENTS || payload.remark || payload.error) return null;
    const elements = payload.elements.filter(e => ['node', 'way', 'relation'].includes(e.type)).map(e => ({
        type: e.type, id: String(e.id), version: Number(e.version), tags: tagsOf(e.tags),
        ...(e.type === 'node' ? point(e) : e.type === 'way' ? { nodes: Array.isArray(e.nodes) ? e.nodes.map(String) : [] }
            : { members: Array.isArray(e.members) ? e.members.map(m => ({ type: m.type, ref: String(m.ref), role: m.role })) : null }),
    }));
    if (new Set(elements.map(e => `${e.type}:${e.id}`)).size !== elements.length
        || elements.some(e => !/^\d+$/.test(e.id) || !Number.isInteger(e.version) || e.version < 1
            || !e.tags || (e.type === 'node' && !isValidRoutePoint(e))
            || (e.type === 'relation' && (!e.members || e.members.length > MAX_ELEMENTS
                || e.members.some(m => !['node', 'way', 'relation'].includes(m.type) || !/^\d+$/.test(m.ref)
                    || typeof m.role !== 'string' || m.role.length > 150))))) return null;
    return { elements, rawElementCount: payload.elements.length };
}

function candidateOf(stop, reference, snapshot) {
    if (!snapshot?.elements || snapshot.elements.length > MAX_ELEMENTS) return null;
    const nodes = new Map(snapshot.elements.filter(e => e.type === 'node').map(e => [e.id, e]));
    const allWays = snapshot.elements.filter(e => e.type === 'way');
    const ways = allWays.filter(e => e.tags.highway);
    if (allWays.some(e => (e.tags.highway || e.tags['addr:housenumber'])
        && (e.nodes.length < 2 || e.nodes.length > MAX_COMPONENT_NODES || e.nodes.some(nodeId => !nodes.has(nodeId))))) return null;
    const box = bounds(reference.point);
    const addresses = [...nodes.values()].filter(n => explicitAddress(n, stop) && meters(n, reference.point) <= 25);
    if (!addresses.length || addresses.some(n => meters(n, addresses[0]) > 1)) return null;
    const address = addresses[0];
    const driveways = ways.filter(w => w.tags.highway === 'service' && w.tags.service === 'driveway' && w.tags.area !== 'yes');
    const nearby = driveways.filter(w => projection(reference.point, w.nodes.map(n => nodes.get(n)))?.meters <= 25
        && projection(address, w.nodes.map(n => nodes.get(n)))?.meters <= 25);
    if (!nearby.length) return null;
    const component = new Map(), pending = [nearby[0]];
    while (pending.length) {
        const way = pending.pop();
        if (component.has(way.id)) continue;
        component.set(way.id, way);
        if (component.size > MAX_COMPONENT_WAYS) return null;
        const current = new Set(way.nodes);
        for (const other of driveways) if (!component.has(other.id) && other.nodes.some(nodeId => current.has(nodeId))) pending.push(other);
    }
    if (nearby.some(way => !component.has(way.id))) return null;
    const componentNodes = new Set([...component.values()].flatMap(w => w.nodes));
    if (componentNodes.size > MAX_COMPONENT_NODES || [...componentNodes].some(nodeId => !inside(nodes.get(nodeId), box))) return null;
    // A shared farm driveway may serve several homes. An exact address alone
    // cannot assign that shared component to one home without further evidence.
    if ([...nodes.values()].some(n => n.tags['addr:housenumber'] && !explicitAddress(n, stop)
        && [...component.values()].some(w => projection(n, w.nodes.map(nodeId => nodes.get(nodeId)))?.meters <= 25))) return null;
    // OSM may attach a house address to its building outline rather than a
    // standalone address node. Those houses count toward shared access too.
    if (allWays.some(w => w.tags['addr:housenumber'] && !explicitAddress(w, stop)
        && [...component.values()].some(d => nearGeometry(w.nodes.map(n => nodes.get(n)), d.nodes.map(n => nodes.get(n)))))) return null;
    const connections = [];
    for (const road of ways) {
        if (component.has(road.id) || road.tags.service === 'driveway') continue;
        for (let index = 0; index < road.nodes.length; index++) if (componentNodes.has(road.nodes[index])) {
            if (!PUBLIC_HIGHWAYS.has(road.tags.highway) || road.tags.area === 'yes'
                || !road.tags.name || key(road.tags.name) !== key(stop.street_name) || !allowed(road.tags) || direction(road.tags) === null
                || !allowed(nodes.get(road.nodes[index]).tags)) return null;
            connections.push({ road, index, nodeId: road.nodes[index] });
        }
    }
    const frontages = new Set(connections.map(c => c.nodeId));
    if (frontages.size !== 1) return null;
    const nodeId = [...frontages][0], frontage = nodes.get(nodeId);
    const connectedWays = new Set([...component.keys(), ...connections.map(c => c.road.id)]);
    // The provider graph may lag the current OSM restriction. Without a full
    // turn-restriction interpreter, any applicable relation makes proof unsafe.
    if (snapshot.elements.some(e => e.type === 'relation'
        && (e.tags.type === 'restriction' || Object.keys(e.tags).some(tag => /^restriction(?::|$)/.test(tag)))
        && e.members.some(m => (m.type === 'node' && m.ref === nodeId) || (m.type === 'way' && connectedWays.has(m.ref))))) return null;
    const arrivals = [], departures = [];
    for (const { road, index } of connections) {
        const directed = direction(road.tags);
        for (const offset of [-1, 1]) {
            const neighborId = road.nodes[index + offset], neighbor = nodes.get(neighborId);
            if (!neighbor || !allowed(neighbor.tags) || meters(neighbor, frontage) < 10 || meters(neighbor, frontage) > 1000) continue;
            const edge = { road, neighbor, geometry: [neighbor, frontage] };
            if (directed === 0 || directed === -offset) arrivals.push(edge);
            if (directed === 0 || directed === offset) departures.push(edge);
        }
    }
    if (!arrivals.length || !departures.length) return null;
    const arrival = arrivals[0], departure = departures[0];
    return { frontage, address, component: [...component.values()], connections, arrival, departure, roadName: connections[0].road.tags.name };
}

function proofSnapshot(snapshot, candidate, reference) {
    const componentNodes = new Set(candidate.component.flatMap(w => w.nodes));
    const ways = new Map(snapshot.elements.filter(e => e.type === 'way' && e.nodes.some(n => componentNodes.has(n))).map(w => [w.id, w]));
    const nodes = new Map(snapshot.elements.filter(e => e.type === 'node').map(e => [e.id, e]));
    for (const way of snapshot.elements) if (way.type === 'way' && way.tags['addr:housenumber']
        && candidate.component.some(w => nearGeometry(way.nodes.map(n => nodes.get(n)), w.nodes.map(n => nodes.get(n))))) ways.set(way.id, way);
    const nodeIds = new Set([...ways.values()].flatMap(w => w.nodes));
    for (const node of nodes.values()) if (node.tags['addr:housenumber']
        && (meters(node, reference.point) <= 25
            || candidate.component.some(w => projection(node, w.nodes.map(nodeId => nodes.get(nodeId)))?.meters <= 25))) nodeIds.add(node.id);
    return { elements: snapshot.elements.filter(e => e.type === 'way' ? ways.has(e.id) : e.type === 'node' ? nodeIds.has(e.id)
        : e.members.some(m => (m.type === 'node' && nodeIds.has(m.ref)) || (m.type === 'way' && ways.has(m.ref)))),
        inventory: { source: 'openstreetmap_api_v0.6', queryBounds: bounds(reference.point),
            rawElementCount: snapshot.rawElementCount, rawWayCount: snapshot.elements.filter(e => e.type === 'way').length,
            rawRelationCount: snapshot.elements.filter(e => e.type === 'relation').length,
            observedAt: new Date().toISOString(), completeComponent: true } };
}

function validInventory(snapshot, reference, now) {
    const inventory = snapshot?.inventory, observed = Date.parse(inventory?.observedAt || '');
    const expected = bounds(reference.point), box = inventory?.queryBounds;
    return inventory?.source === 'openstreetmap_api_v0.6' && inventory.completeComponent === true
        && Number.isFinite(observed) && now - observed <= MAX_AGE && observed <= now + 300000
        && Number.isInteger(inventory.rawElementCount) && inventory.rawElementCount >= snapshot.elements.length && inventory.rawElementCount <= MAX_ELEMENTS
        && Number.isInteger(inventory.rawWayCount) && inventory.rawWayCount >= snapshot.elements.filter(e => e.type === 'way').length
        && inventory.rawWayCount <= inventory.rawElementCount
        && Number.isInteger(inventory.rawRelationCount) && inventory.rawRelationCount >= snapshot.elements.filter(e => e.type === 'relation').length
        && inventory.rawRelationCount + inventory.rawWayCount <= inventory.rawElementCount
        && !!box && Object.keys(expected).every(k => Number.isFinite(box[k]) && Math.abs(box[k] - expected[k]) <= 1e-9);
}

function validProvider(candidate, proof) {
    const nearest = proof?.nearest, route = proof?.roundtrip;
    const snapped = { lat: nearest?.location?.[1], lng: nearest?.location?.[0] };
    const publicNodes = new Set(candidate.connections.flatMap(c => c.road.nodes));
    if (!isValidRoutePoint(snapped) || !Number.isFinite(nearest?.distance) || nearest.distance < 0 || nearest.distance > 5
        || meters(candidate.frontage, snapped) > 5 || key(nearest.name) !== key(candidate.roadName)
        || !nearest.nodes?.some(nodeId => publicNodes.has(String(nodeId)))) return false;
    if (!Array.isArray(route?.waypoints) || route.waypoints.length !== 3 || !Array.isArray(route.legs) || route.legs.length !== 2) return false;
    const endpoints = [candidate.arrival.neighbor, candidate.frontage, candidate.departure.neighbor];
    if (route.waypoints.some((w, i) => !Number.isFinite(w.distance) || w.distance < 0 || w.distance > 5
        || !equal({ lat: w.location?.[1], lng: w.location?.[0] }, endpoints[i], 5)
        || !String(w.name || '').split(' / ').every(name => key(name) === key(candidate.roadName)))) return false;
    const coordinates = route.geometry?.coordinates;
    if (route.geometry?.type !== 'LineString' || !Array.isArray(coordinates) || coordinates.length < 3 || coordinates.length > 1000
        || coordinates.some(c => !Array.isArray(c) || !isValidRoutePoint({ lat: c[1], lng: c[0] })
            || ![candidate.arrival, candidate.departure].some(edge => projection({ lat: c[1], lng: c[0] }, edge.geometry)?.meters <= 10))) return false;
    if (!equal({ lat: coordinates[0][1], lng: coordinates[0][0] }, endpoints[0], 5)
        || !equal({ lat: coordinates.at(-1)[1], lng: coordinates.at(-1)[0] }, endpoints[2], 5)
        || !coordinates.some(c => equal({ lat: c[1], lng: c[0] }, endpoints[1], 5))) return false;
    return route.legs.every((leg, index) => Number.isFinite(leg.distance) && leg.distance > 0
        && leg.distance <= meters(endpoints[index], endpoints[index + 1]) * 1.25 + 10
        && Number.isFinite(leg.duration) && leg.duration >= 0);
}

async function jsonRequest(url, fetchImpl, signal) {
    cancelled(signal);
    const response = await fetchImpl(url.toString(), { signal, redirect: 'manual', headers: { Accept: 'application/json' } });
    if (!response.ok || response.type === 'opaqueredirect' || response.redirected === true || (response.status >= 300 && response.status < 400)) throw new Error('Mapped access evidence unavailable.');
    const length = Number(response.headers?.get?.('content-length'));
    if (length > MAX_BYTES) throw new Error('Mapped access evidence exceeds bounds.');
    let encoded;
    if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let size = 0; encoded = '';
        try {
            while (true) {
                cancelled(signal);
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Mapped access evidence exceeds bounds.'); }
                encoded += decoder.decode(value, { stream: true });
            }
            encoded += decoder.decode();
        } finally { reader.releaseLock(); }
    } else encoded = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    if (new TextEncoder().encode(encoded).length > MAX_BYTES) throw new Error('Mapped access evidence exceeds bounds.');
    cancelled(signal);
    return JSON.parse(encoded);
}

export function validateMappedDrivewayAccess(stop, access, { now = Date.now() } = {}) {
    try {
        const evidence = access?.evidence, resolvedAt = Date.parse(access?.resolved_at || '');
        if (access?.source !== 'mapped_driveway_recovery' || access.resolution_status !== 'resolved'
            || !Number.isFinite(resolvedAt) || now - resolvedAt > MAX_AGE || resolvedAt > now + 300000
            || evidence?.policy !== POLICY || evidence.propertyIdentity !== id(stop) || !equal(stop, access.displayPoint)
            || !equal(stop, evidence.displayPoint) || !validateCountyAddressReference(stop, evidence.referenceAddress, { now })
            || new TextEncoder().encode(JSON.stringify(access)).length > MAX_PROOF_BYTES
            || !validInventory(evidence.snapshot, evidence.referenceAddress, now)) return false;
        const snapshot = snapshotOf(evidence.snapshot);
        const candidate = snapshot && candidateOf(stop, evidence.referenceAddress, snapshot);
        return !!candidate && equal(candidate.frontage, access.point) && key(candidate.roadName) === key(access.roadName)
            && validProvider(candidate, evidence.providerProof);
    } catch { return false; }
}

/** An exact independent county address identifies the house. Shared OSM nodes
 * prove its mapped driveway reaches the addressed public street. The private
 * driveway establishes association only; the routing point stays on that street. */
export async function discoverMappedDrivewayAccess(stop, options = {}) {
    const parentSignal = options.signal, controller = new AbortController();
    const abort = () => controller.abort(parentSignal.reason || Object.assign(new Error('Mapped access lookup cancelled.'), { name: 'AbortError' }));
    if (parentSignal?.aborted) abort(); else parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Mapped access lookup exceeded its budget.'), { name: 'AbortError' })), 10000);
    options = { ...options, signal: controller.signal };
    try {
        const reference = options.referenceAddress || await discoverCountyAddressReference(stop, options);
        if (!validateCountyAddressReference(stop, reference, options)) return null;
        const box = bounds(reference.point), mapUrl = new URL(OSM_MAP);
        mapUrl.searchParams.set('bbox', `${box.xmin},${box.ymin},${box.xmax},${box.ymax}`);
        const snapshot = snapshotOf(await jsonRequest(mapUrl, options.fetchImpl || globalThis.fetch, options.signal));
        const candidate = snapshot && candidateOf(stop, reference, snapshot);
        if (!candidate) return null;
        const config = vehicleProviderConfig({ baseUrl: options.vehicleBaseUrl, profile: 'driving' });
        const providerFetch = options.vehicleFetch || globalThis.fetch;
        const nearestUrl = new URL(`${config.baseUrl}/nearest/v1/driving/${candidate.frontage.lng},${candidate.frontage.lat}`);
        nearestUrl.searchParams.set('radiuses', '5'); nearestUrl.searchParams.set('number', '3');
        const nearestResult = await jsonRequest(nearestUrl, providerFetch, options.signal);
        const nearest = nearestResult.waypoints?.[0];
        if (nearestResult.code !== 'Ok' || !nearest || nearestResult.waypoints.slice(1).some(w => key(w.name) !== key(candidate.roadName)
            && Number(w.distance) <= Number(nearest.distance) + 5)) return null;
        const endpoints = [candidate.arrival.neighbor, candidate.frontage, candidate.departure.neighbor];
        const routeUrl = new URL(`${config.baseUrl}/route/v1/driving/${endpoints.map(p => `${p.lng},${p.lat}`).join(';')}`);
        for (const [name, value] of Object.entries({ radiuses: '5;5;5', approaches: 'unrestricted;unrestricted;unrestricted',
            continue_straight: 'false', overview: 'full', geometries: 'geojson', steps: 'false' })) routeUrl.searchParams.set(name, value);
        const route = await jsonRequest(routeUrl, providerFetch, options.signal);
        if (route.code !== 'Ok' || route.routes?.length !== 1) return null;
        const providerProof = { nearest: { location: nearest.location, name: nearest.name, distance: nearest.distance, nodes: nearest.nodes },
            roundtrip: { waypoints: route.waypoints.map(w => ({ location: w.location, name: w.name, distance: w.distance })),
                legs: route.routes[0].legs.map(l => ({ distance: l.distance, duration: l.duration })), geometry: route.routes[0].geometry } };
        if (!validProvider(candidate, providerProof)) return null;
        const retainedSnapshot = proofSnapshot(snapshot, candidate, reference);
        const access = { source: 'mapped_driveway_recovery', resolution_status: 'resolved', confidence: 'medium', side: 'unknown', serviceBearing: null,
            point: point(candidate.frontage), displayPoint: point(stop), roadName: candidate.roadName, resolved_at: new Date().toISOString(),
            evidence: { policy: POLICY, propertyIdentity: id(stop), displayPoint: point(stop), referenceAddress: reference,
                attribution: 'OpenStreetMap contributors; North Carolina AddressNC', snapshot: retainedSnapshot, providerProof } };
        return validateMappedDrivewayAccess(stop, access, options) ? access : null;
    } catch (error) {
        if (parentSignal?.aborted) throw error;
        return null;
    } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); }
}
