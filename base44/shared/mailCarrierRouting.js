import { createRoadNetworkRoutingContext, roadNetworkRoutingInternals } from './roadNetworkRouting.js';
import { haversineDistanceMiles, isValidRoutePoint } from './routeBounds.js';
import { streetSideVariants, trustedAccess } from './streetSideRouting.js';

const identity = p => String(p?.address_hash || p?.legacy_hash || p?.id || '');
const street = p => roadNetworkRoutingInternals.normalizeStreetName(p?.street_name || '').replaceAll(' ', '');
const coordinateKey = p => `${Number(p[0]).toFixed(6)},${Number(p[1]).toFixed(6)}`;
// An internal graph label, never a claimed street name or driveway match.
const unnamedRoad = '__observed_unnamed_road__';

// These lines are observed road geometry, not house-to-house segments. They
// supply side/position evidence only; OSRM still decides every legal car leg.
function observedRoadNetwork(steps = []) {
    const roads = new Map(), locations = new Map();
    for (const step of steps) {
        if (step.driving_side !== 'right' || typeof step.name !== 'string') continue;
        const name = step.name || unnamedRoad;
        const key = street({ street_name: name });
        const road = roads.get(key) || { name, edges: new Map() };
        const points = step.geometry?.coordinates || [];
        for (let i = 1; i < points.length; i++) {
            const a = coordinateKey(points[i - 1]), b = coordinateKey(points[i]);
            if (a === b || ![points[i - 1], points[i]].every(p => isValidRoutePoint({ lat: p[1], lng: p[0] }))) continue;
            locations.set(a, points[i - 1]); locations.set(b, points[i]);
            road.edges.set([a, b].sort().join('|'), [a, b]);
        }
        roads.set(key, road);
    }
    const elements = [], usedNodes = new Set();
    for (const [key, road] of roads) {
        // Separate /route legs cut the same physical edge at different stops.
        // Split overlapping lines at every observed cut before deduplicating,
        // otherwise a straight street acquires fictitious graph branches.
        const nodes = [...new Set([...road.edges.values()].flat())];
        const atomic = new Map();
        for (const [first, last] of road.edges.values()) {
            const [a, b] = [locations.get(first), locations.get(last)];
            const cos = Math.cos(a[1] * Math.PI / 180);
            const dx = (b[0] - a[0]) * cos * 111320, dy = (b[1] - a[1]) * 111320;
            const lengthSquared = dx * dx + dy * dy;
            const cuts = nodes.map(n => {
                const p = locations.get(n), x = (p[0] - a[0]) * cos * 111320, y = (p[1] - a[1]) * 111320;
                return { n, t: (x * dx + y * dy) / lengthSquared, offset: Math.abs(x * dy - y * dx) / Math.sqrt(lengthSquared) };
            }).filter(p => p.t >= 0 && p.t <= 1 && p.offset <= 0.3).sort((p, q) => p.t - q.t);
            for (let i = 1; i < cuts.length; i++) {
                const pair = [cuts[i - 1].n, cuts[i].n]; atomic.set([...pair].sort().join('|'), pair);
            }
        }
        road.edges = atomic;
        const incident = new Map();
        for (const [edge, endpoints] of road.edges) for (const node of endpoints) {
            incident.set(node, [...(incident.get(node) || []), edge]);
        }
        const visited = new Set();
        const starts = [...incident.keys()].filter(n => incident.get(n).length !== 2).sort();
        for (const start of [...starts, ...[...incident.keys()].sort()]) {
            for (const first of incident.get(start)) {
                if (visited.has(first)) continue;
                const chain = [start]; let edge = first, node = start;
                while (edge && !visited.has(edge)) {
                    visited.add(edge);
                    node = road.edges.get(edge).find(n => n !== node); chain.push(node);
                    edge = incident.get(node).length === 2 ? incident.get(node).find(e => !visited.has(e)) : null;
                }
                // Route legs insert artificial vertices at service waypoints.
                // Remove collinear cuts; keep actual bends and junctions.
                const simplified = chain.filter((n, i) => {
                    if (!i || i === chain.length - 1) return true;
                    const [a, b, c] = [chain[i - 1], n, chain[i + 1]].map(k => locations.get(k));
                    const cos = Math.cos(b[1] * Math.PI / 180);
                    const x = [(b[0] - a[0]) * cos, b[1] - a[1]], y = [(c[0] - b[0]) * cos, c[1] - b[1]];
                    return x[0] * y[0] + x[1] * y[1] <= 0
                        || Math.abs(x[0] * y[1] - x[1] * y[0]) > 0.02 * Math.hypot(...x) * Math.hypot(...y);
                });
                const circular = simplified[0] === simplified.at(-1);
                if (circular) {
                    // A duplicated seam gives the geometric circle a cyclic
                    // position reference. This graph never supplies car costs;
                    // the provider validates travel across the real closure.
                    const closure = `${start}:closure:${key}`;
                    locations.set(closure, locations.get(start)); simplified[simplified.length - 1] = closure;
                }
                simplified.forEach(n => usedNodes.add(n));
                elements.push({ type: 'way', id: `${circular ? 'circuit:' : ''}${key}:${start}:${first}`, nodes: simplified,
                    tags: { highway: 'residential', name: road.name } });
            }
        }
    }
    for (const id of usedNodes) { const [lon, lat] = locations.get(id); elements.push({ type: 'node', id, lat, lon }); }
    return { elements };
}

export function inferMailCarrierAccess(stops, evidence) {
    const accesses = new Map();
    if (evidence?.waypoints?.length !== stops.length || !evidence.steps?.length) return accesses;
    const context = createRoadNetworkRoutingContext({ roadNetwork: observedRoadNetwork(evidence.steps),
        travelMode: 'driving', maxSnapDistanceMeters: 100, serviceSideOnly: true });
    const unnamed = new Map();
    stops.forEach((stop, i) => {
        if (stop.locked || stop.order_locked || stop.routing_access?.resolution_status === 'unresolved') return;
        const waypoint = evidence.waypoints[i], matched = { lat: waypoint?.location?.[1], lng: waypoint?.location?.[0] };
        if (!isValidRoutePoint(matched) || !street(stop)) return;
        const anonymous = waypoint.name === '';
        if (!anonymous && street({ street_name: waypoint.name }) !== street(stop)) return;
        const access = context.accessFor(anonymous ? { ...stop, street_name: unnamedRoad } : stop);
        if (!trustedAccess(access) || !Number.isFinite(access.serviceBearing)
            || haversineDistanceMiles(access.point, matched) * 1609.344 > 2) return;
        const inferred = { ...access, roadName: waypoint.name || '',
            source: anonymous ? 'osrm-unnamed-road-side' : 'osrm-named-road-side',
            resolution_status: 'resolved', frontageVerified: false,
            circular: String(access.roadId).startsWith('circuit:') };
        if (anonymous) unnamed.set(identity(stop), { stop, matched, access: inferred });
        else accesses.set(identity(stop), inferred);
    });
    // Some residential streets have complete routable geometry but no name in
    // the provider. Three distinct matches from one address street corroborate
    // an unbranched service chain. Geometry establishes curb side only; it does
    // not establish frontage or rename the provider's road. Conflicting address
    // streets on a chain, corners and isolated matches remain uncertain.
    const chains = new Map();
    for (const item of unnamed.values()) {
        const key = item.access.chainKey;
        chains.set(key, [...(chains.get(key) || []), item]);
    }
    for (const items of chains.values()) {
        if (items.length < 3 || new Set(items.map(item => street(item.stop))).size !== 1
            || new Set(items.map(item => coordinateKey([item.matched.lng, item.matched.lat]))).size < 3) continue;
        for (const { stop, access } of items) accesses.set(identity(stop), access);
    }
    return accesses;
}

export function planMailCarrierWindows(order, options = {}) {
    const max = Math.max(3, Math.min(40, options.maxServiceWindowStops || 40));
    const groups = new Map(), windows = [];
    order.forEach((p, i) => { const key = street(p); if (key) groups.set(key, [...(groups.get(key) || []), i]); });
    for (const indices of groups.values()) {
        let run = [];
        const flush = () => { if (run.length >= 3) windows.push({ start: run[0], end: run.at(-1) + 1, service: true }); run = []; };
        for (const index of indices) {
            if (run.length && (index - run[0] >= max
                || haversineDistanceMiles(order[run.at(-1)], order[index]) > 0.45)) flush();
            if (order[index].locked || order[index].order_locked || order[index].routing_access?.resolution_status === 'unresolved') { flush(); continue; }
            run.push(index);
        }
        flush();
    }
    return [...new Map(windows.filter(w => !order.slice(w.start, w.end).some(p => p.locked || p.order_locked
        || p.routing_access?.resolution_status === 'unresolved')).map(w => [`${w.start}:${w.end}`, w])).values()];
}

export function buildMailCarrierCandidates(stops, context, start, end) {
    const groups = new Map();
    stops.forEach((p, i) => { const a = context.accessFor?.(p); if (trustedAccess(a)) groups.set(a.chainKey, [...(groups.get(a.chainKey) || []), i]); });
    const candidates = [];
    for (const indices of groups.values()) {
        if (indices.length < 3) continue;
        const group = indices.map(i => stops[i]);
        const variants = streetSideVariants(group, group, context.accessFor);
        const along = [...group].sort((a, b) => context.accessFor(a).positionMeters - context.accessFor(b).positionMeters);
        const right = along.filter(p => context.accessFor(p).side === 'right');
        const left = along.filter(p => context.accessFor(p).side === 'left').reverse();
        variants.push([...right, ...left], [...left, ...right]);
        if (group.every(p => context.accessFor(p).circular)) {
            const rotate = (items, i) => [...items.slice(i), ...items.slice(0, i)];
            for (let r = 0; r < Math.max(1, right.length); r++) for (let l = 0; l < Math.max(1, left.length); l++) {
                variants.push([...rotate(right, r), ...rotate(left, l)], [...rotate(left, l), ...rotate(right, r)]);
            }
        }
        for (const variant of variants) {
            if (!hasCoherentMailCarrierPasses(variant, context)) continue;
            const order = [...stops]; indices.forEach((i, j) => { order[i] = variant[j]; });
            const path = [start, ...order, end].filter(Boolean);
            const seconds = path.slice(1).reduce((s, p, i) => s + context.optimizationCostBetween(path[i], p), 0);
            const miles = path.slice(1).reduce((s, p, i) => s + context.distanceBetween(path[i], p), 0);
            if (Number.isFinite(seconds) && Number.isFinite(miles)) candidates.push({ order, seconds, miles, crossings: 0, passovers: 0 });
        }
    }
    return candidates.sort((a, b) => a.seconds - b.seconds || a.miles - b.miles);
}

export function hasCoherentMailCarrierPasses(order, context) {
    return mailCarrierPassViolations(order, context) === 0;
}

export function mailCarrierPassViolations(order, context) {
    const groups = new Map();
    for (const p of order) {
        const a = context.accessFor?.(p);
        if (trustedAccess(a)) groups.set(a.chainKey, [...(groups.get(a.chainKey) || []), a]);
    }
    let violations = 0;
    for (const accesses of groups.values()) {
        violations += Math.max(0, accesses.slice(1).filter((a, i) => a.side !== accesses[i].side).length - 1);
        for (const side of ['right', 'left']) {
            const pass = accesses.filter(a => a.side === side);
            const reversals = pass.slice(1).filter((a, i) => side === 'right'
                ? a.positionMeters < pass[i].positionMeters - 0.1 : a.positionMeters > pass[i].positionMeters + 0.1).length;
            violations += Math.max(0, reversals - (pass.every(a => a.circular) ? 1 : 0));
        }
    }
    return violations;
}

export const mailCarrierRoutingInternals = Object.freeze({ observedRoadNetwork });
