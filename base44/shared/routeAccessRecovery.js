import { geocodeAddressItems } from './addressGeocoder.js';
import { haversineDistanceMiles, isValidRoutePoint } from './routeBounds.js';
import { roadNetworkRoutingInternals } from './roadNetworkRouting.js';
import { vehicleProviderConfig } from './vehicleProviderConfig.js';
import { describeRoadFailure } from './osrmDispatcher.js';
import { sameStreet, waypointOnRoad } from './roadNameMatch.js';
import { discoverCountyRoadAccess, validateCountyRoadAccess } from './countyRoadAccess.js';
import { validateCountyRoadNetwork } from './countyRoadRouting.js';
import { discoverMappedDrivewayAccess, validateMappedDrivewayAccess } from './mappedDrivewayAccess.js';

const MATCH_RADIUS = 100;
// A parcel pin can sit well back from its street (long rural lots, deep
// subdivisions). When the address cannot be geocoded onto a road, the pin may
// still be served from its OWN street, identified by name, within this distance.
const PIN_STREET_RADIUS = 250;
// Last resort for a stop no recovery could place: route it from the nearest
// road within this distance of its pin, and say so. Without it, one such stop
// held a whole 1,000-stop route to local repairs only (no global reordering,
// no whole-route verification); with it, Charlotte 1H went 486 -> 398 miles.
export const APPROXIMATE_ACCESS_RADIUS = 500;
// Reasons an approximate stand-in may replace: the address or the road could
// not be matched. Outages, limits and bad coordinates stay unresolved.
const APPROXIMABLE = new Set(['road_not_matched', 'address_not_matched', 'address_match_rejected',
    'address_road_not_matched', 'address_road_mismatch', 'ambiguous_service_road', 'no_drivable_road'])
const MAX_FAILED_STOPS = 32;
// Failures that depend only on the address and the road graph. Within one
// Optimize action they will fail the same way again, so a later pass may reuse
// them instead of re-matching, re-geocoding and re-searching county data.
// Outages, timeouts and budget limits are never reused.
export const REUSABLE_ACCESS_FAILURES = Object.freeze(new Set(['road_not_matched', 'address_not_matched',
    'address_match_rejected', 'address_road_not_matched', 'address_road_mismatch', 'ambiguous_service_road']));
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
        // Not 'error': the Base44 edge runtime rejects it. A 3xx is !ok and fails below.
        signal, redirect: 'manual',
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

function validSnap(waypoint, point, maximum = MATCH_RADIUS + 0.5) {
    const snapped = { lat: waypoint?.location?.[1], lng: waypoint?.location?.[0] };
    return isValidRoutePoint(snapped) && Number.isFinite(waypoint?.distance)
        && waypoint.distance >= 0 && waypoint.distance <= maximum
        && distance(snapped, point) <= maximum;
}

function addressItem(stop) {
    return { id: identity(stop), address: `${stop.house_number || ''} ${stop.street_name || ''}`.trim(),
        city: String(stop.city || ''), state: String(stop.state || ''), zip: String(stop.zip_code || '').slice(0, 5) };
}

function qualifiedAddressMatch(stop, hit, { lastResort = false } = {}) {
    if (!isValidRoutePoint(hit) || !hit?.matchedAddress) return false;
    if (hit.source === 'census') {
        // Census reports Non_Exact for cosmetic differences (a dropped "W" on
        // "Nc Highway 90 W") and Tie when two spellings match. Those are used
        // only after every other geocoder failed, and every check below still
        // binds house number, ZIP, street and distance.
        if (hit.matchType !== 'Exact' && !(lastResort && ['Non_Exact', 'Tie'].includes(hit.matchType))) return false;
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
        && !!streetKey(stop.street_name) && sameStreet(house[2], stop.street_name, streetKey)
        && (!item.state || !state || item.state.toUpperCase() === state.toUpperCase())
        && isValidRoutePoint(stop) && distance(stop, hit) <= 1000;
}

// The route number of an unnamed road ("NC 90"): highways in OSM often carry
// only a ref, which /nearest does not report but a /route step does.
async function roadReference(location, config, options, signal) {
    const point = `${location[0]},${location[1]}`;
    const url = new URL(`${config.baseUrl}/route/v1/${config.profile}/${point};${point}`);
    url.searchParams.set('steps', 'true'); url.searchParams.set('overview', 'false');
    url.searchParams.set('radiuses', '5;5');
    const payload = await request(url, options, signal);
    return payload.routes?.[0]?.legs?.[0]?.steps?.find(step => step.ref)?.ref || null;
}

const lastResortCandidate = hit => hit?.source === 'census' && ['Non_Exact', 'Tie'].includes(hit.matchType);

/**
 * Last fallback after geocoding: the nearest road to the pin that carries the
 * stop's own street name, within PIN_STREET_RADIUS. Live, 1680 Mecklenburg Hwy
 * sat 158 m from "Mecklenburg Highway" while Census placed the address 3 km
 * away, and 124 Wellcraft Ct sat 120 m from "Wellcraft Court" while Census
 * snapped onto an unnamed driveway. A road with a different name is never used.
 */
async function pinStreetAccess(stop, config, options, signal) {
    if (!streetKey(stop.street_name)) return null;
    const url = new URL(`${config.baseUrl}/nearest/v1/${config.profile}/${stop.lng},${stop.lat}`);
    url.searchParams.set('number', '5'); url.searchParams.set('radiuses', String(PIN_STREET_RADIUS));
    let payload;
    try { payload = await request(url, options, signal); }
    catch (error) { if (signal.aborted) throw signal.reason || abortError(); return null; }
    // Only a pin genuinely set back beyond the normal match radius qualifies:
    // a street within 100 m that still failed did so for another reason.
    const own = (payload.waypoints || []).find(waypoint => waypoint?.name
        && sameStreet(waypoint.name, stop.street_name, streetKey) && validSnap(waypoint, stop, PIN_STREET_RADIUS + 0.5)
        && Number(waypoint.distance) > MATCH_RADIUS);
    if (!own) return null;
    const point = { lat: own.location[1], lng: own.location[0] };
    return { resolution_status: 'resolved', source: 'pin_street_recovery', confidence: 'medium', side: 'unknown',
        serviceBearing: null, point, displayPoint: pointOf(stop), roadName: own.name,
        evidence: { propertyIdentity: identity(stop), displayPoint: pointOf(stop), snapMeters: Number(own.distance), roadName: own.name } };
}

/**
 * The labeled stand-in: the nearest drivable road to the pin, any name, within
 * APPROXIMATE_ACCESS_RADIUS. The stop is routed and verified from there, and is
 * listed as approximate in the result and marked on the map.
 */
async function approximateAccess(stop, reason, config, options, signal) {
    const url = new URL(`${config.baseUrl}/nearest/v1/${config.profile}/${stop.lng},${stop.lat}`);
    url.searchParams.set('number', '1'); url.searchParams.set('radiuses', String(APPROXIMATE_ACCESS_RADIUS));
    let payload;
    try { payload = await request(url, options, signal); }
    catch (error) { if (signal.aborted) throw signal.reason || abortError(); return null; }
    const near = payload.waypoints?.[0];
    if (!near || !validSnap(near, stop, APPROXIMATE_ACCESS_RADIUS + 0.5)) return null;
    return { resolution_status: 'resolved', source: 'approximate_nearest_road', confidence: 'low', approximate: true,
        side: 'unknown', serviceBearing: null, point: { lat: near.location[1], lng: near.location[0] },
        displayPoint: pointOf(stop), roadName: near.name || '',
        evidence: { propertyIdentity: identity(stop), displayPoint: pointOf(stop), snapMeters: Number(near.distance),
            roadName: near.name || '', unresolvedReason: reason } };
}

async function verifyGeocodedAccess(stop, hit, config, options, signal, { lastResort = false } = {}) {
    if (!qualifiedAddressMatch(stop, hit, { lastResort })) return { reason: 'address_match_rejected' };
    try {
        const payload = await request(providerUrl(config, 'nearest', [hit]), options, signal);
        const nearest = payload.waypoints?.[0];
        if (!validSnap(nearest, hit)) return { reason: 'address_road_mismatch' };
        let roadRef = null;
        if (!sameStreet(nearest.name, stop.street_name, streetKey)) {
            // A named road that is not the address's street is a mismatch. An
            // unnamed one is confirmed by its route number instead.
            if (nearest.name) return { reason: 'address_road_mismatch' };
            roadRef = await roadReference(nearest.location, config, options, signal);
            if (!roadRef || !sameStreet(roadRef, stop.street_name, streetKey)) return { reason: 'address_road_mismatch' };
        }
        const competing = payload.waypoints.slice(1).some(candidate => candidate.name
            && !sameStreet(candidate.name, stop.street_name, streetKey)
            && Number(candidate.distance) <= Number(nearest.distance) + 5);
        if (competing) return { reason: 'ambiguous_service_road' };
        const point = { lat: nearest.location[1], lng: nearest.location[0] };
        return { access: { resolution_status: 'resolved', source: 'address_geocode_recovery', confidence: 'medium',
            side: 'unknown', serviceBearing: null, point, displayPoint: pointOf(stop), roadName: nearest.name,
            ...(roadRef ? { roadRef } : {}),
            evidence: { propertyIdentity: identity(stop), displayPoint: pointOf(stop), geocodePoint: pointOf(hit),
                geocodeSource: hit.source, matchedAddress: hit.matchedAddress, matchType: hit.matchType,
                ...(Number.isFinite(hit.accuracy) ? { accuracy: hit.accuracy } : {}),
                displacementMeters: distance(stop, hit), snapMeters: Number(nearest.distance), roadName: nearest.name,
                ...(roadRef ? { roadRef } : {}) } } };
    } catch (error) {
        if (signal.aborted) throw signal.reason || abortError();
        return { reason: error.code === 'NoSegment' ? 'address_road_not_matched' : 'road_provider_unavailable' };
    }
}

function cachedAccess(stop) {
    const access = stop.routing_access;
    if (access?.resolution_status !== 'resolved' || !isValidRoutePoint(access.point) || !isValidRoutePoint(stop)) return null;
    if (access.source === 'approximate_nearest_road' || access.approximate) return null;
    const boundIdentity = access.evidence?.propertyIdentity || access.propertyIdentity;
    if ((boundIdentity && String(boundIdentity) !== identity(stop))
        || (access.displayPoint && (!isValidRoutePoint(access.displayPoint) || distance(stop, access.displayPoint) > 0.1))) return null;
    if (access.source === 'address_geocode_recovery'
        && (!isValidRoutePoint(access.displayPoint) || String(boundIdentity || '') !== identity(stop)
            || !streetKey(access.roadName || access.roadRef)
            || !sameStreet(access.roadName || access.roadRef, stop.street_name, streetKey))) return null;
    if (access.source === 'county_road_recovery') {
        const resolvedAt = Date.parse(access.resolved_at || '');
        if (!Number.isFinite(resolvedAt) || Date.now() - resolvedAt > 86400000 || resolvedAt > Date.now() + 300000
            || !validateCountyRoadAccess(stop, access.county_road) || !validateCountyRoadNetwork(access.county_road)
            || distance(access.point, access.county_road.point) > 0.1
            || streetKey(access.roadName) !== streetKey(stop.street_name)) return null;
    }
    if (access.source === 'mapped_driveway_recovery' && !validateMappedDrivewayAccess(stop, access)) return null;
    if (access.source === 'pin_street_recovery'
        && (String(boundIdentity || '') !== identity(stop) || !sameStreet(access.roadName, stop.street_name, streetKey)
            || distance(access.point, stop) > PIN_STREET_RADIUS + 0.5)) return null;
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
        inventory_complete: true, unverified_count: 0, failure_reason: null, county_recovered: 0, mapped_recovered: 0 };
    const original = properties.map(stop => ({ ...stop }));
    const result = original.map(stop => {
        const access = cachedAccess(stop);
        if (!access) return { ...stop, routing_access: undefined };
        report.reused += 1;
        report.access_overrides[identity(stop)] = access;
        return { ...stop, ...pointOf(access.point), routing_access: access };
    });
    const failed = new Map();
    // Stops this action already proved unresolvable (sent back by the client
    // for its later passes). Only for stops without usable cached access.
    const known = new Map();
    for (const [id, reason] of options.knownUnresolved instanceof Map ? options.knownUnresolved : []) {
        if (REUSABLE_ACCESS_FAILURES.has(reason)) known.set(String(id), reason);
    }
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
            // Each chunk's first request is fixed before any answer arrives, so
            // they go out together and are consumed in order below. Retries after
            // a NoSegment depend on that answer and are still asked one by one.
            const firstRequests = new Map();
            for (let start = 0; start < result.length; start += 100) {
                const indices = result.slice(start, start + 100).map((_, offset) => start + offset)
                    .filter(index => isValidRoutePoint(result[index])
                        && !(!result[index].routing_access && known.has(identity(original[index]))));
                if (!indices.length) continue;
                const url = providerUrl(config, indices.length === 1 ? 'nearest' : 'route', indices.map(index => probePoint(result[index])));
                const pending = request(url, options, preflight.signal);
                pending.catch(() => {}); // Surfaced when (and only if) the chunk uses it.
                firstRequests.set(url.toString(), pending);
            }
            const ask = url => {
                const key = url.toString(), early = firstRequests.get(key);
                if (early) { firstRequests.delete(key); return early; }
                return request(url, options, preflight.signal);
            };
            for (let start = 0; start < result.length; start += 100) {
                let indices = result.slice(start, start + 100).map((_, offset) => start + offset);
                for (const index of indices) if (!isValidRoutePoint(result[index])) fail(index, 'invalid_coordinates');
                for (const index of indices) {
                    if (!failed.has(index) && !result[index].routing_access && known.has(identity(original[index]))) {
                        fail(index, known.get(identity(original[index]))); report.reused_failures = (report.reused_failures || 0) + 1;
                    }
                }
                indices = indices.filter(index => !failed.has(index));
                while (indices.length > 0) {
                    if (failed.size >= failLimit) {
                        for (let index = start; index < result.length; index += 1) if (!failed.has(index)) fail(index, 'recovery_limit_reached');
                        inventoryComplete = false; break;
                    }
                    const service = indices.length === 1 ? 'nearest' : 'route';
                    let payload;
                    try {
                        payload = await ask(providerUrl(config, service, indices.map(index => probePoint(result[index]))));
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
                        if (!validSnap(waypoint, probePoint(result[index]), access?.source === 'mapped_driveway_recovery' ? 5 : MATCH_RADIUS + 0.5)
                            || (expectedName && !waypointOnRoad(waypoint.name, expectedName, streetKey))) fail(index, 'road_not_matched');
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
            // WHY no road match could be loaded: could not connect, key refused,
            // too slow, or the engine said no. Without it every cause reads alike.
            report.failure_detail = describeRoadFailure(error, { baseUrl: config.baseUrl });
            report.unresolved = [...failed].map(([index, reason]) => issue(index, reason));
            return { properties: original, report };
        } finally { preflight.close(); }

        const fresh = index => !known.has(identity(original[index]));
        const recoverable = [...failed.keys()].filter(fresh).slice(0, failLimit)
            .filter(index => isValidRoutePoint(original[index]) && addressItem(original[index]).address && addressItem(original[index]).zip);
        report.attempted = recoverable.length;
        if (recoverable.length > 0) {
            const geocodeScope = deadline(scope.signal, Math.min(15000, Number(options.geocodeBudgetMs) || 15000));
            const verified = new Map(), rejected = new Map(), lastResort = new Map();
            try {
                const geocode = options.geocode || geocodeAddressItems;
                const originalById = new Map(recoverable.map(index => [identity(original[index]), original[index]]));
                const geocoded = await bounded(geocode(recoverable.map(index => addressItem(original[index])), {
                    geocodioApiKey: options.geocodioApiKey,
                    // An exact address is not enough: Census may interpolate it
                    // onto a road the driving provider cannot use. Let the next
                    // geocoder try that address unless its road match also works.
                    acceptResult: async (candidate, item) => {
                        const stop = item && originalById.get(String(item.id));
                        if (!stop || geocodeScope.signal.aborted) return false;
                        const check = await verifyGeocodedAccess(stop, candidate, config, options, geocodeScope.signal);
                        if (geocodeScope.signal.aborted) return false;
                        // Remember the first near-exact Census candidate in case
                        // no other geocoder resolves this address.
                        if (!check.access && lastResortCandidate(candidate) && !lastResort.has(identity(stop))) {
                            lastResort.set(identity(stop), candidate);
                        }
                        if (check.access) verified.set(identity(stop), check.access);
                        else rejected.set(identity(stop), check.reason);
                        return !!check.access;
                    },
                    signal: geocodeScope.signal,
                    fetchImpl: (url, init) => bounded((options.geocodeFetch || globalThis.fetch)(url, {
                        ...init, signal: geocodeScope.signal,
                    }), geocodeScope.signal),
                }), geocodeScope.signal);
                const hits = geocoded?.results || geocoded || {};
                // Keep these independent: one bad address must not abort recovery
                // of the other verified addresses in the route.
                const tryLastResort = async stop => {
                    const candidate = lastResort.get(identity(stop));
                    if (!candidate || geocodeScope.signal.aborted) return null;
                    const check = await verifyGeocodedAccess(stop, candidate, config, options, geocodeScope.signal, { lastResort: true });
                    return check.access || null;
                };
                for (const index of recoverable) {
                    const stop = original[index], hit = hits[identity(stop)];
                    const check = !hit ? { reason: rejected.get(identity(stop)) || 'address_not_matched' }
                        : verified.has(identity(stop)) ? { access: verified.get(identity(stop)) }
                            : await verifyGeocodedAccess(stop, hit, config, options, geocodeScope.signal);
                    const access = check.access || await tryLastResort(stop)
                        || (geocodeScope.signal.aborted ? null : await pinStreetAccess(stop, config, options, geocodeScope.signal));
                    if (!access) { fail(index, check.reason); continue; }
                    verified.set(identity(stop), access);
                }
            } catch (error) {
                if (options.signal?.aborted) throw options.signal.reason || abortError();
                for (const index of recoverable) if (failed.has(index) && !verified.has(identity(original[index]))) {
                    fail(index, rejected.get(identity(original[index])) || 'address_provider_unavailable');
                }
            } finally { geocodeScope.close(); }
            // Preserve successful stops even if another lookup exceeds the
            // shared budget. Only checks completed before the deadline enter here.
            for (const index of recoverable) {
                const stop = original[index], access = verified.get(identity(stop));
                if (!access) continue;
                result[index] = { ...stop, ...access.point, routing_access: access };
                report.access_overrides[identity(stop)] = access;
                report.recovered++; failed.delete(index);
            }
        }
        const countyReferences = new Map();
        const countyLookup = options.countyAccessLookup === false ? null : options.countyAccessLookup || discoverCountyRoadAccess;
        const countyCandidates = [...failed.keys()].filter(fresh).filter(index => !['road_provider_unavailable',
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
                            onAddressReference: reference => countyReferences.set(index, reference),
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
        // A parcel centroid or rooftop may be far from its street. Use an exact
        // county address AND connected mapped driveway evidence to identify a
        // public-street entrance; never widen the provider's matching radius.
        const mappedLookup = options.mappedAccessLookup === false ? null : options.mappedAccessLookup
            || (options.enableMappedDrivewayRecovery === true ? discoverMappedDrivewayAccess : null);
        const mappedCandidates = [...failed.keys()].filter(fresh).filter(index => !['road_provider_unavailable',
            'recovery_limit_reached', 'invalid_coordinates'].includes(failed.get(index))).slice(0, 8);
        if (mappedLookup && mappedCandidates.length && !scope.signal.aborted) {
            const mappedScope = deadline(scope.signal, 10000);
            try {
                for (const index of mappedCandidates) {
                    if (mappedScope.signal.aborted) break;
                    const stop = original[index];
                    try {
                        const access = await bounded(mappedLookup(stop, {
                            fetchImpl: options.mappedFetch || options.countyFetch || globalThis.fetch,
                            vehicleFetch: options.vehicleFetch, vehicleBaseUrl: config.baseUrl,
                            referenceAddress: countyReferences.get(index), signal: mappedScope.signal,
                        }), mappedScope.signal);
                        if (!validateMappedDrivewayAccess(stop, access)) continue;
                        result[index] = { ...stop, ...pointOf(access.point), routing_access: access };
                        report.access_overrides[identity(stop)] = access;
                        report.recovered++; report.mapped_recovered++; failed.delete(index);
                    } catch (error) {
                        if (options.signal?.aborted) throw options.signal.reason || abortError();
                        // Keep the original issue if independent driveway proof
                        // is absent, ambiguous, unavailable, or over budget.
                    }
                }
            } finally { mappedScope.close(); }
        }
        // Every stop still unplaced for an address/road reason gets the labeled
        // stand-in, so it no longer blocks global routing and verification.
        report.approximate = [];
        if (options.approximateAccess === true && inventoryComplete && !scope.signal.aborted) {
            for (const [index, reason] of [...failed]) {
                if (!APPROXIMABLE.has(reason) || !isValidRoutePoint(original[index])) continue;
                const access = await approximateAccess(original[index], reason, config, options, scope.signal);
                if (!access) continue;
                result[index] = { ...original[index], ...access.point, routing_access: access };
                report.access_overrides[identity(original[index])] = access;
                report.approximate.push({ ...issue(index, reason),
                    snap_meters: Math.round(access.evidence.snapMeters), road_name: access.roadName });
                failed.delete(index);
            }
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
