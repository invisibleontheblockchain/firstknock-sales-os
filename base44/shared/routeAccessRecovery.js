import { geocodeAddressItems } from './addressGeocoder.js';
import { haversineDistanceMiles, isValidRoutePoint } from './routeBounds.js';
import { roadNetworkRoutingInternals } from './roadNetworkRouting.js';
import { vehicleProviderConfig } from './vehicleProviderConfig.js';
import { discoverCountyRoadAccess, validateCountyRoadAccess } from './countyRoadAccess.js';
import { validateCountyRoadNetwork } from './countyRoadRouting.js';

const MATCH_RADIUS = 100;
const MAX_FAILED_STOPS = 32;
const pointOf = value => ({ lat: Number(value?.lat), lng: Number(value?.lng) });
const identity = value => String(value?.address_hash || value?.legacy_hash || value?.id || '');
const distance = (a, b) => haversineDistanceMiles(a, b) * 1609.344;
const withoutUnit = value => String(value || '').replace(/\s*(?:#|\bapt\b|\bunit\b|\bsuite\b|\bste\b)\s*.*$/i, '').trim();
const streetKey = value => roadNetworkRoutingInternals.normalizeStreetName(withoutUnit(value));
const abortError = () => Object.assign(new Error('Route access recovery was cancelled.'), { name: 'AbortError' });

function deadline(parent, milliseconds) {
    const controller = new AbortController();
    const abort = () => controller.abort(parent?.reason || abortError());
    if (parent?.aborted) abort();
    else parent?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Route access recovery exceeded its time budget.'), {
        code: 'recovery_timeout',
    })), milliseconds);
    return { signal: controller.signal, close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}

// Some adapters cannot cancel an in-flight request. Stop awaiting them at the
// deadline as well as passing the signal through to cooperative fetch adapters.
function bounded(promise, signal) {
    if (signal.aborted) return Promise.reject(signal.reason || abortError());
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || abortError());
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

async function request(url, options, signal) {
    const response = await bounded((options.vehicleFetch || globalThis.fetch)(url.toString(), {
        signal, redirect: 'error',
    }), signal);
    const payload = await bounded(response.json(), signal);
    if (!response.ok || payload?.code !== 'Ok') {
        const error = Object.assign(new Error(payload?.message || 'Driving road matching is unavailable.'), {
            code: payload?.code || 'road_provider_unavailable', status: response.status,
        });
        throw error;
    }
    return payload;
}

function providerUrl(config, service, points) {
    const url = new URL(`${config.baseUrl}/${service}/v1/${config.profile}/${points.map(p => `${p.lng},${p.lat}`).join(';')}`);
    url.searchParams.set('radiuses', points.map(() => MATCH_RADIUS).join(';'));
    if (service === 'route') {
        url.searchParams.set('approaches', points.map(() => 'unrestricted').join(';'));
        url.searchParams.set('bearings', points.map(() => '').join(';'));
        url.searchParams.set('overview', 'false');
        url.searchParams.set('steps', 'false');
    } else url.searchParams.set('number', '3');
    return url;
}

function validSnap(waypoint, point) {
    const snapped = { lat: waypoint?.location?.[1], lng: waypoint?.location?.[0] };
    return isValidRoutePoint(snapped) && Number.isFinite(waypoint?.distance)
        && waypoint.distance >= 0 && waypoint.distance <= MATCH_RADIUS + 0.5
        && distance(snapped, point) <= MATCH_RADIUS + 0.5;
}

function addressItem(stop) {
    return { id: identity(stop), address: `${stop.house_number || ''} ${stop.street_name || ''}`.trim(),
        city: String(stop.city || ''), state: String(stop.state || ''), zip: String(stop.zip_code || '').slice(0, 5) };
}

function qualifiedAddressMatch(stop, hit) {
    if (!isValidRoutePoint(hit) || !hit?.matchedAddress) return false;
    if (hit.source === 'census') {
        if (hit.matchType !== 'Exact') return false;
    } else if (hit.source === 'geocodio') {
        if (!['rooftop', 'point', 'range_interpolation', 'nearest_rooftop_match'].includes(hit.matchType)
            || !(Number(hit.accuracy) >= 0.8)) return false;
    } else return false;
    const matched = String(hit.matchedAddress).trim();
    const street = matched.split(',')[0];
    const house = street.match(/^\s*(\S+)\s+(.+)$/);
    const zip = matched.match(/\b(\d{5})(?:-\d{4})?\s*$/)?.[1];
    const state = matched.match(/,\s*([A-Za-z]{2})\s*,?\s*\d{5}(?:-\d{4})?\s*$/)?.[1];
    const item = addressItem(stop);
    return !!house && !!item.zip && zip === item.zip
        && house[1].toUpperCase() === String(stop.house_number || '').trim().toUpperCase()
        && !!streetKey(stop.street_name) && streetKey(house[2]) === streetKey(stop.street_name)
        && (!item.state || !state || item.state.toUpperCase() === state.toUpperCase())
        && isValidRoutePoint(stop) && distance(stop, hit) <= 1000;
}

function cachedAccess(stop) {
    const access = stop.routing_access;
    if (access?.resolution_status !== 'resolved' || !isValidRoutePoint(access.point) || !isValidRoutePoint(stop)) return null;
    const boundIdentity = access.evidence?.propertyIdentity || access.propertyIdentity;
    if ((boundIdentity && String(boundIdentity) !== identity(stop))
        || (access.displayPoint && (!isValidRoutePoint(access.displayPoint) || distance(stop, access.displayPoint) > 0.1))) return null;
    if (access.source === 'address_geocode_recovery'
        && (!isValidRoutePoint(access.displayPoint) || String(boundIdentity || '') !== identity(stop)
            || !streetKey(access.roadName) || streetKey(access.roadName) !== streetKey(stop.street_name))) return null;
    if (access.source === 'county_road_recovery') {
        const resolvedAt = Date.parse(access.resolved_at || '');
        if (!Number.isFinite(resolvedAt) || Date.now() - resolvedAt > 86400000 || resolvedAt > Date.now() + 300000
            || !validateCountyRoadAccess(stop, access.county_road) || !validateCountyRoadNetwork(access.county_road)
            || distance(access.point, access.county_road.point) > 0.1
            || streetKey(access.roadName) !== streetKey(stop.street_name)) return null;
    }
    // Existing manually supplied and mapped driveway/curb access was authorized
    // before recovery caches existed. Keep it, bind it to this display pin, and
    // still rematch it against the configured driving provider below.
    return { ...access, displayPoint: pointOf(stop), evidence: { ...access.evidence, propertyIdentity: identity(stop) } };
}

// A cached county road is checked at its proven public junction. The property
// remains on the real local road for the composite route/matrix measurements.
const probePoint = stop => stop.routing_access?.source === 'county_road_recovery'
    ? stop.routing_access.county_road.gateway.providerPoint : stop;
const probeRoadName = access => access?.source === 'county_road_recovery'
    ? access.county_road.gateway.roadName : access?.roadName;

/** Resolve parcel/rooftop pins that the driving graph cannot match. Address
 * identity and the requested service road must both agree; recovery never
 * broadens the driving radius or changes the property's display location. */
export async function recoverRouteVehicleAccess(properties, options = {}) {
    const config = vehicleProviderConfig({ baseUrl: options.vehicleBaseUrl,
        profile: options.vehicleProfile || 'driving', production: options.production === true });
    const scope = deadline(options.signal, Math.max(1, Math.min(45000, Number(options.budgetMs) || 45000)));
    const report = { status: 'ready', attempted: 0, recovered: 0, reused: 0, unresolved: [], access_overrides: {},
        inventory_complete: true, unverified_count: 0, failure_reason: null, county_recovered: 0 };
    const original = properties.map(stop => ({ ...stop }));
    const result = original.map(stop => {
        const access = cachedAccess(stop);
        if (!access) return { ...stop, routing_access: undefined };
        report.reused += 1;
        report.access_overrides[identity(stop)] = access;
        return { ...stop, ...pointOf(access.point), routing_access: access };
    });
    const failed = new Map();
    const issue = (index, reason) => ({ property_id: identity(original[index]), stop_number: index + 1,
        address: [addressItem(original[index]).address, original[index].city, original[index].zip_code].filter(Boolean).join(', '), reason });
    const fail = (index, reason) => {
        failed.set(index, reason);
        delete report.access_overrides[identity(original[index])];
        result[index] = { ...original[index], routing_access: { resolution_status: 'unresolved', confidence: 'low',
            side: 'unknown', serviceBearing: null, displayPoint: pointOf(original[index]), reason } };
    };
    const failLimit = Math.max(1, Math.min(MAX_FAILED_STOPS, Number(options.maxFailedStops) || MAX_FAILED_STOPS));
    let inventoryComplete = true;
    try {
        const preflight = deadline(scope.signal, Math.max(1, Math.min(20000, Number(options.preflightBudgetMs) || 15000)));
        try {
            for (let start = 0; start < result.length; start += 100) {
                let indices = result.slice(start, start + 100).map((_, offset) => start + offset);
                for (const index of indices) if (!isValidRoutePoint(result[index])) fail(index, 'invalid_coordinates');
                indices = indices.filter(index => !failed.has(index));
                while (indices.length > 0) {
                    if (failed.size >= failLimit) {
                        for (let index = start; index < result.length; index += 1) if (!failed.has(index)) fail(index, 'recovery_limit_reached');
                        inventoryComplete = false; break;
                    }
                    const service = indices.length === 1 ? 'nearest' : 'route';
                    let payload;
                    try {
                        payload = await request(providerUrl(config, service, indices.map(index => probePoint(result[index]))), options, preflight.signal);
                    } catch (error) {
                        const coordinate = /coordinate\s+(\d+)/i.exec(String(error?.message || ''));
                        if ((error.code === 'NoSegment' || /NoSegment/.test(error.message)) && coordinate
                            && Number(coordinate[1]) < indices.length) {
                            const position = Number(coordinate[1]);
                            fail(indices[position], 'road_not_matched');
                            indices.splice(position, 1); continue;
                        }
                        // A single-point nearest response has no coordinate index.
                        if (service === 'nearest' && (error.code === 'NoSegment' || /NoSegment/.test(error.message))) {
                            fail(indices[0], 'road_not_matched'); indices = []; continue;
                        }
                        throw error;
                    }
                    const waypoints = payload.waypoints;
                    if (!Array.isArray(waypoints) || (service === 'route' && waypoints.length !== indices.length)
                        || (service === 'nearest' && waypoints.length === 0)) throw new Error('Driving provider returned incomplete road matches.');
                    indices.forEach((index, offset) => {
                        const waypoint = waypoints[service === 'nearest' ? 0 : offset];
                        const access = result[index].routing_access;
                        const expectedName = probeRoadName(access);
                        if (!validSnap(waypoint, probePoint(result[index]))
                            || (expectedName && streetKey(waypoint.name) !== streetKey(expectedName))) fail(index, 'road_not_matched');
                    });
                    indices = [];
                }
                if (!inventoryComplete) break;
            }
        } catch (error) {
            if (options.signal?.aborted) throw options.signal.reason || abortError();
            inventoryComplete = false; report.status = 'provider_unavailable';
            // Do not mistake a provider outage for hundreds of bad addresses.
            report.inventory_complete = false; report.unverified_count = original.length;
            report.failure_reason = error?.code === 'recovery_timeout' ? 'road_provider_timeout' : 'road_provider_unavailable';
            report.unresolved = [...failed].map(([index, reason]) => issue(index, reason));
            return { properties: original, report };
        } finally { preflight.close(); }

        const recoverable = [...failed.keys()].slice(0, failLimit)
            .filter(index => isValidRoutePoint(original[index]) && addressItem(original[index]).address && addressItem(original[index]).zip);
        report.attempted = recoverable.length;
        if (recoverable.length > 0) {
            const geocodeScope = deadline(scope.signal, Math.min(15000, Number(options.geocodeBudgetMs) || 15000));
            try {
                const geocode = options.geocode || geocodeAddressItems;
                const originalById = new Map(recoverable.map(index => [identity(original[index]), original[index]]));
                const geocoded = await bounded(geocode(recoverable.map(index => addressItem(original[index])), {
                    geocodioApiKey: options.geocodioApiKey,
                    acceptResult: (candidate, item) => !!item && qualifiedAddressMatch(originalById.get(String(item.id)), candidate),
                    signal: geocodeScope.signal,
                    fetchImpl: (url, init) => bounded((options.geocodeFetch || globalThis.fetch)(url, {
                        ...init, signal: geocodeScope.signal,
                    }), geocodeScope.signal),
                }), geocodeScope.signal);
                const hits = geocoded?.results || geocoded || {};
                // Keep these independent: one bad address must not abort recovery
                // of the other verified addresses in the route.
                for (const index of recoverable) {
                    const stop = original[index], hit = hits[identity(stop)];
                    if (!hit) { fail(index, 'address_not_matched'); continue; }
                    if (!qualifiedAddressMatch(stop, hit)) { fail(index, 'address_match_rejected'); continue; }
                    try {
                        const payload = await request(providerUrl(config, 'nearest', [hit]), options, geocodeScope.signal);
                        const nearest = payload.waypoints?.[0];
                        if (!validSnap(nearest, hit) || streetKey(nearest?.name) !== streetKey(stop.street_name)) {
                            fail(index, 'address_road_mismatch'); continue;
                        }
                        const competing = payload.waypoints.slice(1).some(candidate => candidate.name
                            && streetKey(candidate.name) !== streetKey(stop.street_name)
                            && Number(candidate.distance) <= Number(nearest.distance) + 5);
                        if (competing) { fail(index, 'ambiguous_service_road'); continue; }
                        const point = { lat: nearest.location[1], lng: nearest.location[0] };
                        const access = { resolution_status: 'resolved', source: 'address_geocode_recovery', confidence: 'medium',
                            side: 'unknown', serviceBearing: null, point, displayPoint: pointOf(stop), roadName: nearest.name,
                            evidence: { propertyIdentity: identity(stop), displayPoint: pointOf(stop), geocodePoint: pointOf(hit),
                                geocodeSource: hit.source, matchedAddress: hit.matchedAddress, matchType: hit.matchType,
                                ...(Number.isFinite(hit.accuracy) ? { accuracy: hit.accuracy } : {}),
                                displacementMeters: distance(stop, hit), snapMeters: Number(nearest.distance), roadName: nearest.name } };
                        result[index] = { ...stop, ...point, routing_access: access };
                        report.access_overrides[identity(stop)] = access;
                        report.recovered += 1; failed.delete(index);
                    } catch (error) {
                        if (options.signal?.aborted) throw options.signal.reason || abortError();
                        fail(index, error.code === 'NoSegment' ? 'address_road_not_matched' : 'road_provider_unavailable');
                    }
                }
            } catch (error) {
                if (options.signal?.aborted) throw options.signal.reason || abortError();
                for (const index of recoverable) if (failed.has(index)) fail(index, 'address_provider_unavailable');
            } finally { geocodeScope.close(); }
        }
        const countyLookup = options.countyAccessLookup === false ? null : options.countyAccessLookup || discoverCountyRoadAccess;
        const countyCandidates = [...failed.keys()].filter(index => !['road_provider_unavailable',
            'recovery_limit_reached', 'invalid_coordinates'].includes(failed.get(index))).slice(0, 8);
        if (countyLookup && countyCandidates.length && !scope.signal.aborted) {
            const countyScope = deadline(scope.signal, 15000);
            try {
                for (const index of countyCandidates) {
                    if (countyScope.signal.aborted) break;
                    const stop = original[index];
                    try {
                        const county = await bounded(countyLookup(stop, { fetchImpl: options.countyFetch || globalThis.fetch,
                            vehicleFetch: options.vehicleFetch, vehicleBaseUrl: config.baseUrl,
                            onDiagnostic: options.collectCountyDiagnostics ? event => {
                                report.county_diagnostics ||= [];
                                report.county_diagnostics.push({ stop_number: index + 1, ...event });
                            } : undefined,
                            signal: countyScope.signal }), countyScope.signal);
                        if (!validateCountyRoadAccess(stop, county) || !validateCountyRoadNetwork(county)) continue;
                        const access = { resolution_status: 'resolved', source: 'county_road_recovery',
                            confidence: 'medium', side: 'unknown', serviceBearing: null,
                            resolved_at: new Date().toISOString(), point: pointOf(county.point),
                            displayPoint: pointOf(stop), roadName: stop.street_name,
                            county_road: county, evidence: county.evidence };
                        result[index] = { ...stop, ...access.point, routing_access: access };
                        report.access_overrides[identity(stop)] = access;
                        report.recovered++; report.county_recovered++; failed.delete(index);
                    } catch (error) {
                        if (options.signal?.aborted) throw options.signal.reason || abortError();
                        // Preserve the precise address/road issue when county
                        // evidence is unavailable; another stop may still recover.
                    }
                }
            } finally { countyScope.close(); }
        }
        report.unresolved = [...failed].map(([index, reason]) => issue(index, reason));
        report.inventory_complete = inventoryComplete;
        report.unverified_count = report.unresolved.filter(item => item.reason === 'recovery_limit_reached').length;
        if (!inventoryComplete) report.failure_reason = 'recovery_limit_reached';
        report.status = report.unresolved.some(item => /provider_unavailable/.test(item.reason)) ? 'provider_unavailable'
            : report.unresolved.length ? (report.recovered ? 'partial' : 'unresolved')
            : report.recovered ? 'recovered' : 'ready';
        return { properties: result, report };
    } finally { scope.close(); }
}
