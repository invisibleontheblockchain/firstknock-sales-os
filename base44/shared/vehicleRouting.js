import { haversineDistanceMiles, isValidRoutePoint } from './routeBounds.js';
import { streetSidePolicy } from './streetSideRouting.js';
import { vehicleProviderConfig } from './vehicleProviderConfig.js';
import { vehicleServicePoint, VEHICLE_MATCH_RADIUS_METERS } from './serviceAccess.js';
import { roadNetworkRoutingInternals } from './roadNetworkRouting.js';

const METERS_PER_MILE = 1609.344;

function timedSignal(source, milliseconds) {
    const controller = new AbortController();
    const abort = () => controller.abort(source?.reason);
    if (source?.aborted) abort();
    else source?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Vehicle routing timed out. The existing route was left unchanged.')), milliseconds);
    return { signal: controller.signal, abort: () => controller.abort(), close() {
        clearTimeout(timer); source?.removeEventListener('abort', abort);
    } };
}

function identity(point) {
    return String(point?.address_hash || point?.legacy_hash || point?.id || `${point?.lat},${point?.lng}`);
}

export function vehicleWaypoint(stop, accessFor) {
    const access = stop.routing_access?.resolution_status === 'resolved' ? stop.routing_access : accessFor?.(stop);
    const known = access?.confidence === 'high' && Number.isFinite(access.serviceBearing) && isValidRoutePoint(access.point);
    // Keep curb lateral information after projecting to the access road. The
    // display/door pin stays unchanged. Bearings describe the selected service
    // state, never a fabricated current vehicle heading.
    if (known) {
        const radians = access.serviceBearing * Math.PI / 180;
        const point = {
            lat: access.point.lat - Math.sin(radians) * 4 / 111320,
            lng: access.point.lng + Math.cos(radians) * 4 / (111320 * Math.cos(access.point.lat * Math.PI / 180)),
        };
        return { stop, point, access, approach: 'curb', bearing: `${Math.round(access.serviceBearing) % 360},45`, radius: 40 };
    }
    const supplied = stop.routing_access?.resolution_status === 'resolved' ? stop.routing_access : null;
    return { stop, point: vehicleServicePoint(stop),
        access: { ...access, ...supplied, confidence: supplied?.confidence || 'low', serviceBearing: null, side: 'unknown' },
        approach: 'unrestricted', bearing: '', radius: VEHICLE_MATCH_RADIUS_METERS };
}

function providerUrl(base, profile, service, points, options) {
    const coordinates = points.map(({ point }) => `${point.lng},${point.lat}`).join(';');
    const url = new URL(`${base.replace(/\/$/, '')}/${service}/v1/${profile}/${coordinates}`);
    url.searchParams.set('approaches', points.map(p => p.approach).join(';'));
    url.searchParams.set('bearings', points.map(p => p.bearing).join(';'));
    url.searchParams.set('radiuses', points.map(p => p.radius).join(';'));
    for (const [key, value] of Object.entries(options)) url.searchParams.set(key, value);
    return url;
}

async function providerRequest(url, fetchImpl, signal) {
    const request = timedSignal(signal, 15000);
    try {
    const res = await fetchImpl(url.toString(), { signal: request.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`Vehicle routing failed (${res.status}). The existing route was left unchanged.`);
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error(`Vehicle routing failed (${data.code || 'invalid response'}). The existing route was left unchanged.`);
    return data;
    } finally { request.close(); }
}

function validateSnaps(waypoints, points) {
    if (!Array.isArray(waypoints) || waypoints.length !== points.length) throw new Error('Vehicle provider returned incomplete access points.');
    waypoints.forEach((waypoint, i) => {
        const expected = points[i].access;
        const location = { lat: waypoint.location?.[1], lng: waypoint.location?.[0] };
        if (!isValidRoutePoint(location)) throw new Error('Vehicle provider returned an invalid access coordinate.');
        if (haversineDistanceMiles(location, points[i].point) * METERS_PER_MILE > points[i].radius + 0.5) {
            throw new Error('Vehicle provider snapped outside the fixed road-match radius.');
        }
        if (expected?.confidence === 'high' && haversineDistanceMiles(location, expected.point) * METERS_PER_MILE > 25) {
            throw new Error('Vehicle provider snapped a house away from its inferred access road. Repair its access point before optimizing.');
        }
        if (expected?.resolution_status === 'resolved' && expected.roadName) {
            const key = value => roadNetworkRoutingInternals.normalizeStreetName(value).replaceAll(' ', '');
            if (key(waypoint.name) !== key(expected.roadName)) throw new Error('Vehicle provider matched a different service road.');
        }
    });
}

export async function createVehicleRoutingContext(properties, accessContext, options = {}) {
    if (properties.length > 500) throw new Error('Split driving routes into at most 500 stops before optimizing.');
    if (!properties.every(isValidRoutePoint)) throw new Error('Every driving stop requires valid coordinates.');
    if (new Set(properties.map(identity)).size !== properties.length) throw new Error('Driving route stops must have unique stable identifiers.');
    const policy = streetSidePolicy({ ...options.servicePolicy, travelMode: 'driving' });
    const { baseUrl, profile } = vehicleProviderConfig({ baseUrl: options.vehicleBaseUrl,
        profile: options.vehicleProfile || 'driving', production: options.production === true });
    const fetchImpl = options.vehicleFetch || fetch;
    const bounds = [options.startLocation, options.endLocation].filter(isValidRoutePoint);
    const stops = [...properties, ...bounds].filter((stop, i, all) => all.findIndex(p => identity(p) === identity(stop)) === i);
    const pointById = new Map(stops.map(stop => [identity(stop), vehicleWaypoint(stop, accessContext.accessFor)]));
    for (const boundary of bounds) {
        if (boundary.vehicle_heading_degrees == null) continue;
        const heading = boundary.vehicle_heading_degrees;
        if (!Number.isFinite(heading) || heading < 0 || heading >= 360) throw new Error('Vehicle boundary heading must be between 0 and 360 degrees.');
        if (properties.some(stop => identity(stop) === identity(boundary))) {
            throw new Error('Give the vehicle origin a distinct identifier when supplying its heading.');
        }
        pointById.set(identity(boundary), { stop: boundary, point: boundary, access: null,
            approach: 'unrestricted', bearing: `${Math.round(heading) % 360},45`, radius: 100 });
    }
    const durationByPair = new Map(), distanceByPair = new Map();
    const routeCache = new Map();
    const dataVersions = new Set();
    const verifyDataVersion = data => {
        if (data.data_version) dataVersions.add(data.data_version);
        if (dataVersions.size > 1 || (options.expectedDataVersion && data.data_version !== options.expectedDataVersion)) {
            throw new Error('Vehicle provider graph identity changed. No routes may be saved.');
        }
    };
    const matrix = timedSignal(options.signal, 60000);
    const matrixSignal = matrix.signal;
    const jobs = [];
    // Table batches have at most 100 unique coordinates. No aerial substitution
    // or OSRM fallback_speed is used for an unreachable directed transition.
    const batchSize = 50;
    for (let from = 0; !options.routeOnly && from < stops.length; from += batchSize) {
        for (let to = 0; to < stops.length; to += batchSize) {
            const sources = stops.slice(from, from + batchSize);
            const targets = stops.slice(to, to + batchSize);
            const batch = [...sources, ...targets].filter((stop, i, all) => all.findIndex(p => identity(p) === identity(stop)) === i);
            const batchPoints = batch.map(stop => pointById.get(identity(stop)));
            const indexFor = stop => batch.findIndex(p => identity(p) === identity(stop));
            jobs.push(async () => {
            const data = await providerRequest(providerUrl(baseUrl, profile, 'table', batchPoints, {
                sources: sources.map(indexFor).join(';'), destinations: targets.map(indexFor).join(';'), annotations: 'duration,distance',
            }), fetchImpl, matrixSignal);
            verifyDataVersion(data);
            validateSnaps(data.sources, sources.map(stop => pointById.get(identity(stop))));
            validateSnaps(data.destinations, targets.map(stop => pointById.get(identity(stop))));
            sources.forEach((source, i) => targets.forEach((target, j) => {
                const key = `${identity(source)}->${identity(target)}`;
                const duration = data.durations?.[i]?.[j];
                const distance = data.distances?.[i]?.[j];
                durationByPair.set(key, typeof duration === 'number' && duration >= 0 ? duration : Infinity);
                distanceByPair.set(key, typeof distance === 'number' && distance >= 0 ? distance : Infinity);
            }));
            });
        }
    }
    let nextJob = 0;
    try {
        await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
            while (nextJob < jobs.length) {
                if (matrixSignal.aborted) throw matrixSignal.reason || new Error('Vehicle routing was cancelled.');
                await jobs[nextJob++]();
            }
        }));
    } catch (error) { matrix.abort(); throw error; } finally { matrix.close(); }
    const pair = (left, right) => `${identity(left)}->${identity(right)}`;
    return Object.freeze({
        ...accessContext, source: 'osrm-driving-curb', status: 'ready', mode: 'full', roadAware: true, costOnly: false,
        servicePolicy: policy, vehicleAware: true, routeBetween: undefined, pathBetween: undefined,
        accessFor: stop => pointById.get(identity(stop))?.access || null,
        optimizationCostBetween: (left, right) => durationByPair.get(pair(left, right)) ?? Infinity,
        distanceBetween: (left, right) => (distanceByPair.get(pair(left, right)) ?? Infinity) / METERS_PER_MILE,
        distanceBetweenMeters: (left, right) => distanceByPair.get(pair(left, right)) ?? Infinity,
        streetSegmentKey: stop => [accessContext.streetSegmentKey?.(stop) || '',
            accessContext.accessGroupKey?.(stop) || '', accessContext.accessFor?.(stop)?.chainKey || ''].join('|'),
        diagnostics: Object.freeze({ ...accessContext.diagnostics, vehicleProfile: profile, vehicleBaseUrl: baseUrl,
            vehicleMatrixPointCount: stops.length, dataVersion: [...dataVersions][0] || null }),
        async routeSequence(sequence, bounds = {}) {
            const ordered = [bounds.startLocation, ...sequence, bounds.endLocation].filter(isValidRoutePoint);
            const points = ordered.map(stop => pointById.get(identity(stop)) || vehicleWaypoint(stop, accessContext.accessFor));
            if (!points.length) throw new Error('A driving route needs a usable stop.');
            if (points.length === 1) points.push(points[0]);
            const url = providerUrl(baseUrl, profile, 'route', points, {
                geometries: 'geojson', overview: 'full', steps: 'true', continue_straight: 'true',
            });
            // Full URL includes profile, order, service directions and approaches.
            const key = url.toString();
            const cached = routeCache.get(key);
            if (cached && Date.now() - cached.at < 60000) return cached.result;
            const data = await providerRequest(url, fetchImpl, options.signal);
            verifyDataVersion(data);
            validateSnaps(data.waypoints, points);
            const route = data.routes?.[0];
            const geometry = route?.geometry?.coordinates;
            if (!Number.isFinite(route?.duration) || !Number.isFinite(route?.distance) || route.duration < 0 || route.distance < 0
                || !Array.isArray(geometry) || geometry.length < 2 || geometry.length > (options.maxGeometryPoints || 12000)
                || !geometry.every(([lng, lat]) => isValidRoutePoint({ lat, lng }))) {
                throw new Error('Vehicle provider returned an incomplete route. The existing route was left unchanged.');
            }
            const walkingAccessSeconds = sequence.reduce((sum, stop) => {
                const access = accessContext.accessFor?.(stop);
                return sum + (isValidRoutePoint(access?.point) ? haversineDistanceMiles(stop, access.point) * METERS_PER_MILE * 2 / policy.walkingMetersPerSecond : 0);
            }, 0);
            const parkingSeconds = sequence.length * Math.max(0, Number(policy.parkingSecondsPerStop) || 0);
            const turnarounds = (route.legs || []).flatMap(leg => leg.steps || []).filter(step => step.maneuver?.modifier === 'uturn').length;
            let directedLegs = null;
            if (options.requireDirectedLegs) {
                if (route.legs?.length !== ordered.length - 1 || route.legs.some(leg => !Number.isFinite(leg.duration)
                    || !Number.isFinite(leg.distance) || leg.duration < 0 || leg.distance < 0)) {
                    throw new Error('Vehicle provider returned incomplete directed consecutive legs.');
                }
                directedLegs = route.legs.map((leg, index) => {
                    const rawGeometry = (leg.steps || []).flatMap(step => step.geometry?.coordinates || []);
                    const legGeometry = rawGeometry.filter((p, i) => i === 0 || p[0] !== rawGeometry[i - 1][0] || p[1] !== rawGeometry[i - 1][1]);
                    if (!legGeometry.length || !legGeometry.every(([lng, lat]) => isValidRoutePoint({ lat, lng }))) {
                        throw new Error('Vehicle provider omitted a directed leg geometry.');
                    }
                    return { from: identity(ordered[index]), to: identity(ordered[index + 1]),
                        driveSeconds: leg.duration, distanceMiles: leg.distance / METERS_PER_MILE,
                        pathKey: JSON.stringify(legGeometry), };
                });
                if (Math.abs(directedLegs.reduce((sum, leg) => sum + leg.driveSeconds, 0) - route.duration) > 0.11 * directedLegs.length
                    || Math.abs(directedLegs.reduce((sum, leg) => sum + leg.distanceMiles * METERS_PER_MILE, 0) - route.distance) > 0.11 * directedLegs.length) {
                    throw new Error('Vehicle route totals disagree with consecutive leg costs.');
                }
            }
            const result = {
                distanceMiles: route.distance / METERS_PER_MILE,
                objectiveSeconds: route.duration + walkingAccessSeconds + parkingSeconds,
                driveSeconds: route.duration, walkingAccessSeconds, parkingSeconds, estimatedTurnarounds: turnarounds,
                geometry: geometry.map(([lng, lat]) => ({ lat, lng })),
                directedLegs, dataVersion: [...dataVersions][0] || null,
            };
            if (routeCache.size >= 100) routeCache.delete(routeCache.keys().next().value);
            routeCache.set(key, { at: Date.now(), result });
            return result;
        },
    });
}

// Match only; no access search, expanded radius, inferred frontage or geocoding.
export async function identifyUnmatchedVehicleStops(properties, options = {}) {
    const { baseUrl, profile } = vehicleProviderConfig({ baseUrl: options.vehicleBaseUrl,
        profile: options.vehicleProfile || 'car', production: options.production === true });
    const uncertain = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, properties.length) }, async () => {
        while (next < properties.length) {
            if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled', 'AbortError');
            const stop = properties[next++];
            if (stop.routing_access?.resolution_status === 'unresolved' || !isValidRoutePoint(stop)) {
                uncertain.push(identity(stop)); continue;
            }
            const point = vehicleWaypoint({ ...stop, routing_access: stop.routing_access
                ? { ...stop.routing_access, serviceBearing: null, side: 'unknown' } : undefined }, () => null);
            const url = new URL(`${baseUrl}/nearest/v1/${profile}/${point.point.lng},${point.point.lat}`);
            url.searchParams.set('number', '1'); url.searchParams.set('radiuses', '100');
            try {
                const data = await providerRequest(url, options.vehicleFetch || fetch, options.signal);
                if (options.expectedDataVersion && data.data_version !== options.expectedDataVersion) throw new Error('Vehicle provider graph identity changed.');
                validateSnaps(data.waypoints, [point]);
            } catch (error) {
                if (error.name === 'AbortError' || /graph identity|cancelled/i.test(error.message)) throw error;
                // A provider outage fails this inventory, rather than making
                // thousands more requests to the same unavailable service.
                if (/failed \(5|timed out|fetch failed/i.test(error.message)) throw error;
                uncertain.push(identity(stop));
            }
        }
    }));
    return uncertain;
}

export async function finalizeVehicleRoute(properties, context, bounds = {}, baseline = null) {
    if (!context?.vehicleAware) throw new Error('Vehicle road costs are unavailable. The existing route was left unchanged.');
    if (baseline && JSON.stringify(baseline.map(identity).sort()) !== JSON.stringify(properties.map(identity).sort())) {
        throw new Error('Optimization changed route membership. The existing route was left unchanged.');
    }
    let selected = properties;
    let route = null;
    try { route = await context.routeSequence(properties, bounds); } catch (error) { if (!baseline) throw error; }
    if (baseline && baseline.map(identity).join('|') !== properties.map(identity).join('|')) {
        let previous = null;
        try { previous = await context.routeSequence(baseline, bounds); } catch { /* Baseline is infeasible with the same curb policy. */ }
        if (previous && (!route || previous.objectiveSeconds <= route.objectiveSeconds)) { selected = baseline; route = previous; }
    }
    if (!route) throw new Error('No complete curbside driving route was found. The existing route was left unchanged.');
    return { properties: selected, ...route };
}
