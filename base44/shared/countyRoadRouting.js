import { haversineDistanceMiles, isValidRoutePoint } from './routeBounds.js';
import { roadNetworkRoutingInternals } from './roadNetworkRouting.js';

const METERS_PER_MILE = 1609.344;
const LOCAL_METERS_PER_SECOND = 15 * METERS_PER_MILE / 3600;
const MAX_GRAPH_VERTICES = 5000;
const distance = (a, b) => haversineDistanceMiles(a, b) * METERS_PER_MILE;
const streetKey = name => roadNetworkRoutingInternals.normalizeStreetName(name);
const coordinate = point => [point.lng, point.lat];
const pointOf = pair => ({ lng: Number(pair[0]), lat: Number(pair[1]) });
const key = point => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const dedupe = points => points.filter((p, i) => !i || !same(p, points[i - 1]));
const finite = value => Number.isFinite(value) && value >= 0;
function hash(text) {
    let value = 2166136261;
    for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
}
function project(point, a, b) {
    const cosine = Math.cos(point.lat * Math.PI / 180);
    const x = (b.lng - a.lng) * cosine, y = b.lat - a.lat;
    const length = x * x + y * y;
    const t = length ? Math.max(0, Math.min(1, ((point.lng - a.lng) * cosine * x + (point.lat - a.lat) * y) / length)) : 0;
    const projected = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    return { t, point: projected, meters: distance(point, projected) };
}
function normalizeCounty(county) {
    const network = county?.network || {};
    const id = String(county?.network_id || network.id || '');
    const version = String(county?.network_version || network.version || '');
    const segments = county?.segments || network.segments;
    const point = county?.point;
    const gateway = county?.gateway;
    if (!id || !Array.isArray(segments) || !segments.length || segments.length > 5000
        || !isValidRoutePoint(point) || !isValidRoutePoint(gateway?.point)
        || !isValidRoutePoint(gateway?.providerPoint) || !streetKey(gateway?.roadName)
        || distance(gateway.point, gateway.providerPoint) > 10.5) {
        throw new Error('County road access needs a connected, verified public gateway.');
    }
    return { id, version, segments, point, gateway };
}

// Only supplied line vertices join the county graph. Geometric crossings of
// unrelated lines never create an intersection. The discovery layer must bind
// this authoritative connected component to the qualified property address.
function buildGraph(counties) {
    const segments = new Map(), nodes = [], adjacency = new Map(), pieces = [];
    let vertexBudget = 0;
    for (const county of counties) for (const segment of county.segments) {
        if (!segment.id || !['both', 'forward', 'reverse'].includes(segment.oneway)
            || !Array.isArray(segment.geometry) || segment.geometry.length < 2 || segment.geometry.length > MAX_GRAPH_VERTICES
            || !segment.geometry.every(isValidRoutePoint)) throw new Error('Invalid county road geometry or direction.');
        const signature = JSON.stringify([String(segment.id), segment.oneway, segment.geometry]);
        if (segments.has(String(segment.id)) && segments.get(String(segment.id)).signature !== signature) {
            throw new Error('County road graph identity changed.');
        }
        if (!segments.has(String(segment.id))) {
            vertexBudget += segment.geometry.length;
            if (vertexBudget > MAX_GRAPH_VERTICES) throw new Error('County road graph exceeds its vertex budget.');
        }
        segments.set(String(segment.id), { ...segment, signature });
    }
    const nodeFor = (point, tolerance = 1) => {
        // County centerlines may differ by sub-meter endpoint rounding. This
        // tolerance cannot connect a crossing without a supplied line vertex.
        let index = nodes.findIndex(existing => distance(existing, point) <= tolerance);
        if (index < 0) {
            if (nodes.length >= MAX_GRAPH_VERTICES) throw new Error('County road graph exceeds its vertex budget.');
            index = nodes.length; nodes.push({ ...point }); adjacency.set(index, []);
        }
        return index;
    };
    for (const segment of [...segments.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
        for (let i = 1; i < segment.geometry.length; i++) {
            const a = segment.geometry[i - 1], b = segment.geometry[i];
            if (distance(a, b) < 0.001) continue;
            pieces.push({ a, b, direction: segment.oneway, cuts: [{ t: 0, node: nodeFor(a) }, { t: 1, node: nodeFor(b) }] });
        }
    }
    const attach = point => {
        const ranked = pieces.map(piece => ({ piece, ...project(point, piece.a, piece.b) }))
            .sort((a, b) => a.meters - b.meters);
        const best = ranked[0];
        if (!best || best.meters > 1) throw new Error('County service point is outside its mapped road geometry.');
        const node = nodeFor(best.point, 0.001);
        best.piece.cuts.push({ t: best.t, node });
        return node;
    };
    const attached = new Map(counties.map(county => [county, { point: attach(county.point), gateway: attach(county.gateway.point) }]));
    const add = (from, to) => {
        if (from === to) return;
        adjacency.get(from).push({ to, meters: distance(nodes[from], nodes[to]) });
    };
    for (const piece of pieces) {
        const cuts = piece.cuts.sort((a, b) => a.t - b.t);
        for (let i = 1; i < cuts.length; i++) {
            if (piece.direction !== 'reverse') add(cuts[i - 1].node, cuts[i].node);
            if (piece.direction !== 'forward') add(cuts[i].node, cuts[i - 1].node);
        }
    }
    const cache = new Map();
    const path = (from, to) => {
        const pathKey = `${from}>${to}`;
        if (cache.has(pathKey)) return cache.get(pathKey);
        const costs = new Map([[from, 0]]), previous = new Map(), remaining = new Set([from]);
        while (remaining.size) {
            let current = null;
            for (const next of remaining) if (current === null || costs.get(next) < costs.get(current)) current = next;
            remaining.delete(current);
            if (current === to) break;
            for (const arc of adjacency.get(current)) {
                const cost = costs.get(current) + arc.meters;
                if (cost + 1e-8 >= (costs.get(arc.to) ?? Infinity)) continue;
                costs.set(arc.to, cost); previous.set(arc.to, current); remaining.add(arc.to);
            }
        }
        if (!costs.has(to)) return null;
        const indices = [to];
        while (indices[0] !== from) indices.unshift(previous.get(indices[0]));
        const result = { distance: costs.get(to), duration: costs.get(to) / LOCAL_METERS_PER_SECOND,
            geometry: indices.map(index => coordinate(nodes[index])) };
        cache.set(pathKey, result);
        return result;
    };
    return { attached, path, signature: JSON.stringify([...segments.values()]
        .sort((a, b) => String(a.id).localeCompare(String(b.id))).map(segment => segment.signature)) };
}

export function validateCountyRoadNetwork(value) {
    try {
        const county = normalizeCounty(value), graph = buildGraph([county]);
        const attached = graph.attached.get(county);
        return !!graph.path(attached.point, attached.gateway) && !!graph.path(attached.gateway, attached.point);
    } catch { return false; }
}

function syntheticSteps(path, name) {
    const geometry = path.geometry.length === 1 ? [path.geometry[0], path.geometry[0]] : path.geometry;
    return [{ name, mode: 'driving', distance: path.distance, duration: path.duration,
        county_road_estimate: true, geometry: { type: 'LineString', coordinates: geometry },
        maneuver: { type: 'depart', location: geometry[0] } },
    { name, mode: 'driving', distance: 0, duration: 0, county_road_estimate: true,
        geometry: { type: 'LineString', coordinates: [geometry.at(-1)] },
        maneuver: { type: 'arrive', location: geometry.at(-1) } }];
}
function geometryFor(leg) {
    const geometry = dedupe((leg.steps || []).flatMap(step => step.geometry?.coordinates || []));
    if (!geometry.length || !geometry.every(pair => Array.isArray(pair) && isValidRoutePoint(pointOf(pair)))) {
        throw new Error('Public driving provider omitted directed leg geometry.');
    }
    return geometry;
}
function compose(parts, name) {
    const steps = parts.flatMap(part => part.steps || syntheticSteps(part, name));
    const geometry = dedupe(steps.flatMap(step => step.geometry.coordinates));
    // A full consecutive leg has one depart and one arrive. Keep all public
    // turn modifiers and shapes while demoting internal request endpoints.
    const normalized = steps.map((step, i) => ({ ...step, maneuver: {
        ...step.maneuver, type: i === 0 ? 'depart' : i === steps.length - 1 ? 'arrive'
            : ['depart', 'arrive'].includes(step.maneuver?.type) ? 'continue' : step.maneuver?.type,
    } }));
    return { distance: parts.reduce((s, part) => s + part.distance, 0), duration: parts.reduce((s, part) => s + part.duration, 0),
        steps: normalized, geometry };
}

/** Adds authoritative county centerline paths to verified public OSRM gateways.
 * County travel time uses an explicit 15 mph estimate, never curb-side proof. */
export function createCountyRoadRoutingAdapter(properties, { fetchJson: rawFetchJson, baseUrl, profile = 'driving' } = {}) {
    if (typeof rawFetchJson !== 'function') throw new Error('County routing needs the configured public road provider.');
    const records = properties.filter(p => p.routing_access?.county_road).map(property => {
        const county = normalizeCounty(property.routing_access.county_road);
        return { county, property, point: county.point, roadName: property.routing_access.roadName || property.street_name || '' };
    });
    const authoritySources = [...new Set(records.map(record => record.property.routing_access.county_road.evidence?.source)
        .filter(source => ['nc_ng911_centerlines', 'fl_lee_ng911_centerlines'].includes(source)))].sort();
    const byNetwork = new Map();
    for (const record of records) byNetwork.set(record.county.id, [...(byNetwork.get(record.county.id) || []), record]);
    for (const network of byNetwork.values()) {
        const identity = county => JSON.stringify([county.version, county.gateway.point, county.gateway.providerPoint, streetKey(county.gateway.roadName)]);
        if (new Set(network.map(record => identity(record.county))).size !== 1) throw new Error('County road graph identity or gateway changed.');
        const graph = buildGraph(network.map(record => record.county));
        for (const record of network) {
            record.graph = graph; record.nodes = graph.attached.get(record.county);
            if (!graph.path(record.nodes.point, record.nodes.gateway) || !graph.path(record.nodes.gateway, record.nodes.point)) {
                throw new Error('County service point has no connected arrival and departure path to its public gateway.');
            }
        }
    }
    const graphIdentity = records.length ? hash(JSON.stringify([...byNetwork].sort(([a], [b]) => a.localeCompare(b))
        .map(([id, network]) => [id, [...new Set(network.map(record => record.county.version))].sort(), network[0].graph.signature,
            [...new Set(network.map(record => JSON.stringify([record.county.gateway.point,
                record.county.gateway.providerPoint, streetKey(record.county.gateway.roadName)])))].sort()]))) : '';
    const counters = { providerRequests: 0, countyRouteLegs: 0, countyTableCells: 0 };
    let publicVersion = null;
    const stamp = data => {
        const observedVersion = data.data_version || 'unversioned';
        if (publicVersion !== null && publicVersion !== observedVersion) throw new Error('Public driving provider graph identity changed.');
        publicVersion = observedVersion;
        if (!records.length) return data;
        return { ...data, data_version: `public:${observedVersion}|county:${graphIdentity}` };
    };
    const raw = async (url, options) => {
        counters.providerRequests++;
        const data = await rawFetchJson(url.toString(), options);
        if (data?.code !== 'Ok') {
            const error = new Error(`${data?.code || 'InvalidResponse'}: ${data?.message || 'Public driving provider returned an invalid response.'}`);
            error.code = data?.code || 'InvalidResponse';
            throw error;
        }
        return data;
    };
    const indexedRaw = async (url, options, indices) => {
        try { return await raw(url, options); }
        catch (original) {
            const message = String(original?.message || '');
            const coordinateIndex = /coordinate\s+(\d+)/i.exec(message);
            if ((original?.code === 'NoSegment' || /NoSegment/i.test(message)) && coordinateIndex
                && Number.isInteger(indices[Number(coordinateIndex[1])])) {
                // A connector request starts at a county waypoint. Its local
                // coordinate index must refer back to the complete request so
                // retry and split-window recovery protect the correct stop.
                const mappedMessage = message.replace(/coordinate\s+\d+/i, `coordinate ${indices[Number(coordinateIndex[1])]}`);
                const error = Object.assign(new Error(mappedMessage, { cause: original }), original);
                error.message = mappedMessage;
                throw error;
            }
            throw original;
        }
    };
    const match = point => {
        const found = records.filter(record => key(record.point) === key(point) || distance(record.point, point) <= 0.2);
        if (new Set(found.map(record => record.county.id)).size > 1) throw new Error('Ambiguous county service point graph identity.');
        return found[0] || null;
    };
    const countyPath = (from, to) => {
        const path = from.graph.path(from.nodes.point, to.nodes.point);
        if (!path) throw new Error('County road has no legal directed connection between these stops.');
        return path;
    };
    const withGatewayConnector = (record, outgoing) => {
        const path = record.graph.path(outgoing ? record.nodes.point : record.nodes.gateway,
            outgoing ? record.nodes.gateway : record.nodes.point);
        const a = record.county.gateway.point, b = record.county.gateway.providerPoint;
        const connector = { distance: distance(a, b), duration: distance(a, b) / LOCAL_METERS_PER_SECOND,
            geometry: outgoing ? [coordinate(a), coordinate(b)] : [coordinate(b), coordinate(a)] };
        return { distance: path.distance + connector.distance, duration: path.duration + connector.duration,
            geometry: dedupe(outgoing ? [...path.geometry, ...connector.geometry] : [...connector.geometry, ...path.geometry]) };
    };
    const toGateway = record => withGatewayConnector(record, true);
    const fromGateway = record => withGatewayConnector(record, false);
    const gatewayOK = (waypoint, record) => {
        if (!waypoint || !isValidRoutePoint(pointOf(waypoint.location || []))
            || distance(pointOf(waypoint.location), record.county.gateway.providerPoint) > 5.5
            || streetKey(waypoint.name) !== streetKey(record.county.gateway.roadName)) {
            throw new Error('Public provider matched a different county gateway road.');
        }
    };
    const waypoint = (record, original) => record ? { name: record.roadName, location: coordinate(record.point), distance: 0,
        county_road: true } : original;
    const rewrite = (original, indices, points, mapped, service) => {
        const url = new URL(original);
        url.pathname = `${url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)}${indices.map(i => coordinate(mapped[i]?.county.gateway.providerPoint || points[i]).join(',')).join(';')}`;
        for (const [parameter, defaultValue] of [['approaches', 'unrestricted'], ['bearings', ''], ['radiuses', '100'], ['hints', '']]) {
            if (!url.searchParams.has(parameter) && parameter !== 'radiuses') continue;
            const values = (original.searchParams.get(parameter) || '').split(';');
            url.searchParams.set(parameter, indices.map(i => mapped[i] ? defaultValue : values[i] ?? defaultValue).join(';'));
        }
        if (service === 'route') {
            url.searchParams.set('steps', 'true'); url.searchParams.set('geometries', 'geojson'); url.searchParams.set('overview', 'full');
        }
        return url;
    };
    const parse = value => {
        const url = new URL(value), service = /\/(route|table|nearest)\/v1\//.exec(url.pathname)?.[1];
        const points = decodeURIComponent(url.pathname.split('/').at(-1)).split(';').map(pair => pointOf(pair.split(',')));
        return { url, service, points, mapped: points.map(match) };
    };
    const fetchJson = async (value, options = {}) => {
        if (!records.length) { counters.providerRequests++; return stamp(await rawFetchJson(value, options)); }
        const { url, service, points, mapped } = parse(value);
        if (!mapped.some(Boolean) || !service) return stamp(await raw(url, options));
        if (service === 'nearest') {
            if (points.length !== 1) throw new Error('County nearest matching requires one point.');
            const data = await raw(rewrite(url, [0], points, mapped, service), options);
            gatewayOK(data.waypoints?.[0], mapped[0]);
            return stamp({ ...data, waypoints: [waypoint(mapped[0])] });
        }
        if (service === 'table') {
            const data = await raw(rewrite(url, points.map((_, i) => i), points, mapped, service), options);
            const indices = parameter => !url.searchParams.has(parameter) || url.searchParams.get(parameter) === 'all'
                ? points.map((_, i) => i) : url.searchParams.get(parameter).split(';').map(Number);
            const sources = indices('sources'), destinations = indices('destinations');
            for (const [indices, name] of [[sources, 'sources'], [destinations, 'destinations']]) {
                indices.forEach((index, i) => { if (mapped[index]) gatewayOK(data[name]?.[i], mapped[index]); });
            }
            const costs = sources.map((from, i) => destinations.map((to, j) => {
                const a = mapped[from], b = mapped[to];
                if (a && b && a.county.id === b.county.id) {
                    counters.countyTableCells++;
                    return a.graph.path(a.nodes.point, b.nodes.point);
                }
                const duration = data.durations?.[i]?.[j], meters = data.distances?.[i]?.[j];
                if (!finite(duration) && !finite(meters)) return null;
                const local = [a && toGateway(a), b && fromGateway(b)].filter(Boolean);
                return { duration: finite(duration) ? duration + local.reduce((s, p) => s + p.duration, 0) : null,
                    distance: finite(meters) ? meters + local.reduce((s, p) => s + p.distance, 0) : null };
            }));
            return stamp({ ...data, sources: sources.map((index, i) => waypoint(mapped[index], data.sources[i])),
                destinations: destinations.map((index, i) => waypoint(mapped[index], data.destinations[i])),
                ...(Array.isArray(data.durations) ? { durations: costs.map(row => row.map(cost => cost?.duration ?? null)) } : {}),
                ...(Array.isArray(data.distances) ? { distances: costs.map(row => row.map(cost => cost?.distance ?? null)) } : {}) });
        }
        const legs = new Array(Math.max(0, points.length - 1)), waypoints = new Array(points.length);
        let observed = null;
        for (let first = 0; first < points.length - 1;) {
            const a = mapped[first], b = mapped[first + 1];
            if (a && b && a.county.id === b.county.id) {
                const path = countyPath(a, b);
                legs[first] = compose([path], a.roadName); counters.countyRouteLegs++;
                waypoints[first] = waypoint(a); waypoints[first + 1] = waypoint(b); first++; continue;
            }
            let last = first + 1;
            while (last < points.length - 1 && !mapped[last]) last++;
            const indices = Array.from({ length: last - first + 1 }, (_, i) => first + i);
            const data = await indexedRaw(rewrite(url, indices, points, mapped, service), options, indices);
            const route = data.routes?.[0];
            if (data.code !== 'Ok' || route?.legs?.length !== indices.length - 1) throw new Error('Public driving provider returned incomplete county connector legs.');
            stamp(data); observed = data;
            indices.forEach((index, offset) => {
                if (mapped[index]) gatewayOK(data.waypoints?.[offset], mapped[index]);
                waypoints[index] = waypoint(mapped[index], data.waypoints?.[offset]);
            });
            route.legs.forEach((leg, offset) => {
                if (!finite(leg.distance) || !finite(leg.duration)) throw new Error('Invalid public county connector cost.');
                geometryFor(leg);
                const index = first + offset, localA = mapped[index], localB = mapped[index + 1];
                const parts = [localA && toGateway(localA), leg, localB && fromGateway(localB)].filter(Boolean);
                legs[index] = compose(parts, localA?.roadName || localB?.roadName || '');
                if (localA || localB) counters.countyRouteLegs++;
            });
            first = last;
        }
        if (!observed) {
            // A wholly local trip still checks its public gateway against the
            // live configured graph; it never borrows a stale road label.
            const record = mapped.find(Boolean);
            const nearest = new URL(`${(baseUrl || url.origin).replace(/\/$/, '')}/nearest/v1/${profile}/${coordinate(record.county.gateway.providerPoint).join(',')}`);
            nearest.searchParams.set('radiuses', '100'); nearest.searchParams.set('number', '1');
            observed = await raw(nearest, options); gatewayOK(observed.waypoints?.[0], record);
        }
        const geometry = dedupe(legs.flatMap(leg => leg.geometry));
        if (geometry.length === 1) geometry.push([...geometry[0]]);
        const route = { distance: legs.reduce((s, leg) => s + leg.distance, 0), duration: legs.reduce((s, leg) => s + leg.duration, 0),
            weight: legs.reduce((s, leg) => s + leg.duration, 0), weight_name: 'duration_with_county_estimates',
            geometry: { type: 'LineString', coordinates: geometry },
            legs: legs.map(({ geometry: _, ...leg }) => leg), county_road_time_estimate: true };
        return stamp({ code: 'Ok', data_version: observed.data_version, waypoints, routes: [route] });
    };
    return { fetchJson, graphIdentity,
        vehicleFetch: async (url, options) => { const data = await fetchJson(url, options); return { ok: true, status: 200, json: async () => data }; },
        stats: () => ({ ...counters, countyStopCount: records.length, networkCount: byNetwork.size, graphIdentity, authoritySources,
            localSpeedMph: 15, localDurationIsEstimate: records.length > 0, publicDataVersion: publicVersion }),
    };
}
