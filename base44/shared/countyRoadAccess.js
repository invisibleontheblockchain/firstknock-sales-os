import { haversineDistanceMiles, isValidRoutePoint } from './routeBounds.js';
import { roadNetworkRoutingInternals } from './roadNetworkRouting.js';
import { vehicleProviderConfig } from './vehicleProviderConfig.js';

import { countyAuthorityFor, validAuthorityAttributes, COUNTY_ROAD_SERVICE, COUNTY_ADDRESS_SERVICE } from './countyRoadAuthorities.js';
export { COUNTY_ROAD_SERVICE, COUNTY_ADDRESS_SERVICE };
const MAX_COMPONENT_VERTICES = 5000;
const distance = (a, b) => haversineDistanceMiles(a, b) * 1609.344;
const streetKey = value => roadNetworkRoutingInternals.normalizeStreetName(String(value || ''));
const pointOf = value => ({ lat: Number(value.lat), lng: Number(value.lng) });
const roadName = a => [a.st_predir, a.st_name, a.st_postyp, a.st_posdir].filter(Boolean).join(' ');
const abortError = () => Object.assign(new Error('County road access discovery was cancelled.'), { name: 'AbortError' });

function hash(value) {
    let first = 2166136261;
    let second = 2246822507;
    for (let index = 0; index < value.length; index += 1) {
        first = Math.imul(first ^ value.charCodeAt(index), 16777619);
        second = Math.imul(second ^ value.charCodeAt(index), 3266489909);
    }
    return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function active(attributes, now) {
    const future = attributes.effective != null && Number(attributes.effective) > now;
    const expired = attributes.expire != null && Number(attributes.expire) <= now;
    return !future && !expired;
}

function oneWay(value) {
    const key = String(value || '').trim().toUpperCase();
    // The county legacy data represents an absent direction restriction as null.
    // Retain that provenance below while using the standard unrestricted default.
    if (['', 'B', 'BI', 'N', 'NO', '0'].includes(key)) return 'both';
    if (['FT', 'F', '1'].includes(key)) return 'forward';
    if (['TF', 'T', '-1'].includes(key)) return 'reverse';
    return null;
}

function withinRange(attributes, number, zip) {
    return ['l', 'r'].some(side => {
        const start = attributes[`fromaddr_${side}`];
        const end = attributes[`toaddr_${side}`];
        if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0
            || number < Math.min(start, end) || number > Math.max(start, end)
            || String(attributes[`postcode_${side}`] || '').slice(0, 5) !== zip) return false;
        const parity = String(attributes[`parity_${side}`] || '').toUpperCase();
        if (parity === 'O' && number % 2 !== 1) return false;
        if (parity === 'E' && number % 2 !== 0) return false;
        // Some counties omit the parity field but provide two odd/even bounds.
        if (!parity && start % 2 === end % 2 && number % 2 !== start % 2) return false;
        return true;
    });
}

function envelope(point, radius) {
    point = pointOf(point);
    const latDelta = radius / 111195;
    const lngDelta = radius / (111195 * Math.cos(point.lat * Math.PI / 180));
    return { xmin: point.lng - lngDelta, ymin: point.lat - latDelta,
        xmax: point.lng + lngDelta, ymax: point.lat + latDelta };
}

function queryUrl(service, box, fields, where = '1=1') {
    const url = new URL(service);
    url.searchParams.set('f', 'json');
    url.searchParams.set('where', where);
    url.searchParams.set('outFields', fields.join(','));
    url.searchParams.set('geometry', `${box.xmin},${box.ymin},${box.xmax},${box.ymax}`);
    url.searchParams.set('geometryType', 'esriGeometryEnvelope');
    url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
    url.searchParams.set('inSR', '4326');
    url.searchParams.set('outSR', '4326');
    url.searchParams.set('returnGeometry', 'true');
    url.searchParams.set('resultRecordCount', '1000');
    return url;
}

function diagnostic(options, service, stage, detail = {}) {
    if (typeof options?.onDiagnostic !== 'function') return;
    // Diagnostics are deliberately selected fields, never a URL, request body,
    // property identity, coordinate, address, or arbitrary exception object.
    try { options.onDiagnostic({ service, stage, ...detail }); } catch { /* Debugging cannot change route acceptance. */ }
}

function providerMessage(message) {
    if (typeof message !== 'string') return undefined;
    return message.replace(/https?:\/\/[^\s"']+/gi, '[url]')
        .replace(/(?:token|secret|api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, '[redacted]')
        .replace(/\bBearer\s+\S+/gi, '[redacted]')
        .replace(/(['"])[^'"]*\1/g, '[value]')
        .replace(/\d+/g, '[number]').replace(/[\r\n\t]+/g, ' ').slice(0, 200);
}

async function jsonRequest(url, fetchImpl, signal, options, service) {
    if (signal?.aborted) throw signal.reason || abortError();
    let response;
    // The deployed edge runtime supports manual/follow, but rejects "error"
    // before issuing the request. Manual plus explicit status rejection preserves
    // the same no-redirect policy without relying on an unsupported fetch value.
    try { response = await fetchImpl(url.toString(), { signal, redirect: 'manual' }); } catch (error) {
        diagnostic(options, service, 'error', { reason: signal?.aborted ? 'cancelled' : 'network_error',
            errorName: ['TypeError', 'Error', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
            message: providerMessage(error?.message) });
        throw error;
    }
    const httpStatus = Number.isInteger(response.status) ? response.status : null;
    if ((httpStatus >= 300 && httpStatus < 400) || response.type === 'opaqueredirect' || response.redirected === true) {
        diagnostic(options, service, 'error', { httpStatus, reason: 'redirect_rejected' });
        throw new Error('Authoritative road provider redirect was rejected.');
    }
    let payload;
    try { payload = await response.json(); } catch {
        const contentType = response.headers?.get?.('content-type') || '';
        diagnostic(options, service, 'error', { httpStatus, reason: 'response_not_json',
            bodyType: /html/i.test(contentType) ? 'html' : /json/i.test(contentType) ? 'json' : 'other' });
        throw new Error('Authoritative road provider returned a non-JSON response.');
    }
    diagnostic(options, service, 'response', { httpStatus,
        featureCount: Array.isArray(payload?.features) ? payload.features.length : null,
        waypointCount: Array.isArray(payload?.waypoints) ? payload.waypoints.length : null,
        futureFeatureCount: Array.isArray(payload?.features) ? payload.features.filter(feature =>
            feature.attributes?.effective != null && Number(feature.attributes.effective) > (options?.now ?? Date.now())).length : null,
        expiredFeatureCount: Array.isArray(payload?.features) ? payload.features.filter(feature =>
            feature.attributes?.expire != null && Number(feature.attributes.expire) <= (options?.now ?? Date.now())).length : null,
        exceededTransferLimit: payload?.exceededTransferLimit === true });
    if (signal?.aborted) throw signal.reason || abortError();
    if (!response.ok || payload?.error) {
        diagnostic(options, service, 'error', { httpStatus, reason: 'provider_error',
            errorCode: Number.isFinite(payload?.error?.code) ? payload.error.code : null,
            providerCode: ['NoSegment', 'NoRoute', 'InvalidQuery', 'InvalidValue'].includes(payload?.code) ? payload.code : null,
            message: providerMessage(payload?.error?.message || payload?.message) });
        throw new Error('Authoritative road evidence is unavailable.');
    }
    return payload;
}

function segmentsOf(payload, now, authority) {
    if (!Array.isArray(payload.features) || payload.exceededTransferLimit) return null;
    const segments = [];
    for (const feature of payload.features) {
        const a = feature.attributes && authority.normalizeRoad(feature.attributes);
        if (!a || a.objectid == null || !active(a, now) || !streetKey(roadName(a))) continue;
        for (const [index, path] of (feature.geometry?.paths || []).entries()) {
            const geometry = path.map(pair => ({ lat: pair[1], lng: pair[0] }));
            if (geometry.length < 2 || !geometry.every(isValidRoutePoint)) continue;
            segments.push({ id: `${authority.id}:${a.objectid}:${index}`, geometry,
                oneWay: authority.validRoad(a) ? oneWay(a.oneway) : null,
                roadName: roadName(a), attributes: a });
        }
    }
    return segments;
}

function project(point, geometry) {
    const scaleX = 111195 * Math.cos(point.lat * Math.PI / 180);
    const scaleY = 111195;
    let best = null;
    for (let index = 0; index < geometry.length - 1; index += 1) {
        const a = geometry[index]; const b = geometry[index + 1];
        const ax = (a.lng - point.lng) * scaleX; const ay = (a.lat - point.lat) * scaleY;
        const dx = (b.lng - a.lng) * scaleX; const dy = (b.lat - a.lat) * scaleY;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        const candidate = { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
        const meters = distance(point, candidate);
        if (!best || meters < best.meters) best = { point: candidate, meters, edgeIndex: index, fraction: t };
    }
    return best;
}

function connected(left, right) {
    return [left.geometry[0], left.geometry.at(-1)].some(a =>
        [right.geometry[0], right.geometry.at(-1)].some(b => distance(a, b) <= 1));
}

function componentOf(seed, named) {
    const pending = [seed]; const selected = new Map();
    while (pending.length > 0) {
        const segment = pending.pop();
        if (selected.has(segment.id)) continue;
        selected.set(segment.id, segment);
        for (const candidate of named) if (!selected.has(candidate.id) && connected(segment, candidate)) pending.push(candidate);
    }
    return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function incomplete(component, box) {
    // ArcGIS returns entire intersecting segments. An endpoint outside the query
    // envelope may have a continuation that the query did not include.
    return component.some(segment => segment.geometry.some(point =>
        point.lng <= box.xmin + 0.00001 || point.lng >= box.xmax - 0.00001
        || point.lat <= box.ymin + 0.00001 || point.lat >= box.ymax - 0.00001));
}

function authoritativePoint(payload, stop, number, zip, now, authority) {
    if (!Array.isArray(payload?.features) || payload.exceededTransferLimit) return { invalid: true };
    const candidates = payload.features.map(feature => ({ ...feature,
        attributes: feature.attributes && authority.normalizeAddress(feature.attributes) })).filter(feature => {
        const a = feature.attributes;
        const addressStreet = String(a?.st_address || '').replace(/^\s*\S+\s+/, '');
        return a && authority.validAddress(a) && active(a, now) && String(a.state || '').toUpperCase() === authority.state
            && String(a.add_number || '') === String(number) && !a.addnum_suf && !a.unit
            && String(a.post_code || '').slice(0, 5) === zip && streetKey(addressStreet) === streetKey(stop.street_name)
            && isValidRoutePoint({ lat: feature.geometry?.y, lng: feature.geometry?.x });
    });
    const distinct = new Map(candidates.map(feature => [
        `${feature.geometry.x.toFixed(7)},${feature.geometry.y.toFixed(7)}`, feature,
    ]));
    if (distinct.size > 1) return { invalid: true };
    const feature = distinct.values().next().value;
    if (!feature) return authority.requiresAddress ? { invalid: true } : { point: pointOf(stop), source: 'property_pin' };
    return { point: { lat: feature.geometry.y, lng: feature.geometry.x }, source: authority.addressSource,
        id: `${authority.addressId}:${feature.attributes.objectid}`, attributes: feature.attributes };
}

/** An exact county address can identify a house inside a large parcel even
 * when the saved display pin is its centroid. It is an identity reference,
 * not proof of a driveway or of a drivable connection to any nearby road. */
export function validateCountyAddressReference(stop, reference, { now = Date.now() } = {}) {
    const house = String(stop?.house_number || '').trim();
    const zip = String(stop?.zip_code || '').slice(0, 5);
    const attributes = reference?.attributes;
    const authority = countyAuthorityFor(stop);
    return isValidRoutePoint(stop) && isValidRoutePoint(reference?.point)
        && !!authority && reference.source === authority.addressSource
        && new RegExp(`^${authority.addressId}:\\d+$`).test(reference.id || '')
        && /^\d+$/.test(house) && /^\d{5}$/.test(zip)
        && distance(stop, reference.point) <= 1000
        && !!attributes && reference.id === `${authority.addressId}:${attributes.objectid}` && active(attributes, now)
        && validAuthorityAttributes(authority, attributes, 'address') && authority.validAddress(attributes)
        && String(attributes.state || '').toUpperCase() === authority.state
        && String(attributes.add_number || '') === house && !attributes.addnum_suf && !attributes.unit
        && String(attributes.post_code || '').slice(0, 5) === zip
        && streetKey(String(attributes.st_address || '').replace(/^\s*\S+\s+/, '')) === streetKey(stop.street_name);
}

export async function discoverCountyAddressReference(stop, options = {}) {
    if (!isValidRoutePoint(stop)) return null;
    const house = String(stop.house_number || '').trim();
    const zip = String(stop.zip_code || '').slice(0, 5);
    const authority = countyAuthorityFor(stop);
    if (!/^\d+$/.test(house) || !/^\d{5}$/.test(zip) || !streetKey(stop.street_name)
        || !authority) return null;
    try {
        const payload = await jsonRequest(queryUrl(authority.addressService, envelope(stop, 1200), authority.addressFields,
            authority.addressWhere(house, zip)), options.fetchImpl || globalThis.fetch,
        options.signal, options, 'county_addresses');
        const reference = authoritativePoint(payload, stop, Number(house), zip, options.now ?? Date.now(), authority);
        return validateCountyAddressReference(stop, reference, options) ? reference : null;
    } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError') throw error;
        return null;
    }
}

async function discover(stop, options) {
    const zip = String(stop.zip_code || '').slice(0, 5);
    const house = String(stop.house_number || '').trim();
    const authority = countyAuthorityFor(stop);
    if (!isValidRoutePoint(stop) || !/^\d+$/.test(house) || !/^\d{5}$/.test(zip)
        || !streetKey(stop.street_name) || !authority) return null;
    const number = Number(house);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const vehicleFetch = options.vehicleFetch || globalThis.fetch;
    const now = options.now ?? Date.now();
    let box = envelope(stop, 1200);
    const addressesUrl = queryUrl(authority.addressService, box, authority.addressFields, authority.addressWhere(house, zip));
    const [roadPayload, addressPayload] = await Promise.all([
        jsonRequest(queryUrl(authority.roadService, box, authority.roadFields), fetchImpl, options.signal, options, 'county_roads'),
        jsonRequest(addressesUrl, fetchImpl, options.signal, options, 'county_addresses'),
    ]);
    const address = authoritativePoint(addressPayload, stop, number, zip, now, authority);
    if (address.invalid || distance(stop, address.point) > 1000) {
        diagnostic(options, 'county_addresses', 'countyAddress', { outcome: 'rejected',
            reason: address.invalid ? 'ambiguous_or_incomplete_address_inventory' : 'address_too_far' });
        return null;
    }
    diagnostic(options, 'county_addresses', 'countyAddress', { outcome: 'accepted', source: address.source });
    if (validateCountyAddressReference(stop, address, options)) {
        // Reuse identity evidence in the bounded mapped-driveway recovery stage.
        try { options.onAddressReference?.(address); } catch { /* Evidence capture cannot change acceptance. */ }
    }
    let allSegments = segmentsOf(roadPayload, now, authority);
    if (!allSegments) {
        diagnostic(options, 'county_roads', 'component', { outcome: 'rejected', reason: 'incomplete_road_inventory' });
        return null;
    }
    const findTarget = segments => {
        const named = segments.filter(segment => streetKey(segment.roadName) === streetKey(stop.street_name));
        const inRange = named.filter(segment => withinRange(segment.attributes, number, zip)
            && authority.targetMatchesAddress(segment.attributes, address.attributes));
        const candidates = inRange
            .map(segment => ({ segment, projection: project(address.point, segment.geometry) }))
            .filter(candidate => candidate.projection && candidate.projection.meters <= 100);
        // Overlapping address ranges on distinct segments are not enough evidence
        // to choose a frontage. Shared endpoint projections are the same location.
        if (!candidates.length || candidates.some(candidate => distance(candidate.projection.point, candidates[0].projection.point) > 1)) {
            diagnostic(options, 'county_roads', 'targetRange', { outcome: 'rejected', namedCount: named.length,
                rangeCount: inRange.length, nearbyCount: candidates.length,
                reason: !candidates.length ? 'no_matching_frontage' : 'ambiguous_frontage' });
            return null;
        }
        diagnostic(options, 'county_roads', 'targetRange', { outcome: 'accepted', namedCount: named.length,
            rangeCount: inRange.length, nearbyCount: candidates.length });
        return { ...candidates[0], component: componentOf(candidates[0].segment, named) };
    };
    let target = findTarget(allSegments);
    if (!target) return null;
    if (incomplete(target.component, box)) {
        box = envelope(stop, 2400);
        allSegments = segmentsOf(await jsonRequest(queryUrl(authority.roadService, box, authority.roadFields), fetchImpl, options.signal, options, 'county_roads'), now, authority);
        if (!allSegments) return null;
        target = findTarget(allSegments);
        if (!target || incomplete(target.component, box)) {
            diagnostic(options, 'county_roads', 'component', { outcome: 'rejected', reason: 'component_outside_bounded_inventory' });
            return null;
        }
    }
    if (target.component.some(segment => segment.oneWay === null)
        || target.component.reduce((sum, segment) => sum + segment.geometry.length, 0) > MAX_COMPONENT_VERTICES) {
        diagnostic(options, 'county_roads', 'component', { outcome: 'rejected', reason: 'unsupported_or_oversized_component' });
        return null;
    }
    diagnostic(options, 'county_roads', 'component', { outcome: 'accepted', segmentCount: target.component.length });
    const componentIds = new Set(target.component.map(segment => segment.id));
    const gateways = [];
    for (const segment of target.component) for (const point of [segment.geometry[0], segment.geometry.at(-1)]) {
        const joining = allSegments.filter(other => !componentIds.has(other.id) && other.oneWay !== null
            && streetKey(other.roadName) !== streetKey(stop.street_name)
            && other.geometry.some(p => distance(point, p) <= 1));
        if (!joining.length || gateways.some(gateway => distance(point, gateway.point) <= 1)) continue;
        gateways.push({ point, joining });
    }
    const config = vehicleProviderConfig({ baseUrl: options.vehicleBaseUrl, profile: 'driving' });
    const accepted = [];
    // Only true county graph junctions are eligible. Bound requests even if a
    // malformed same-name component has dozens of intersecting road names.
    if (gateways.length > 8) {
        diagnostic(options, 'public_gateway', 'gatewayCount', { outcome: 'rejected', candidateCount: gateways.length,
            reason: 'too_many_gateway_candidates' }); return null;
    }
    for (const candidate of gateways) {
        const url = new URL(`${config.baseUrl}/nearest/v1/${config.profile}/${candidate.point.lng},${candidate.point.lat}`);
        url.searchParams.set('number', '3'); url.searchParams.set('radiuses', '10');
        let payload;
        try { payload = await jsonRequest(url, vehicleFetch, options.signal, options, 'public_gateway'); } catch (error) {
            if (options.signal?.aborted) throw error;
            continue;
        }
        if (payload.code !== 'Ok' || !Array.isArray(payload.waypoints)) continue;
        for (const waypoint of payload.waypoints) {
            const providerPoint = { lat: waypoint.location?.[1], lng: waypoint.location?.[0] };
            if (!isValidRoutePoint(providerPoint) || !Number.isFinite(waypoint.distance)
                || waypoint.distance < 0 || waypoint.distance > 10 || distance(providerPoint, candidate.point) > 10) continue;
            const match = candidate.joining.find(segment => streetKey(segment.roadName) === streetKey(waypoint.name));
            if (!match) continue;
            if (!accepted.some(gateway => distance(gateway.point, candidate.point) <= 1)) {
                accepted.push({ point: pointOf(candidate.point), providerPoint, roadName: waypoint.name,
                    countyRoadId: match.id, snapMeters: waypoint.distance,
                    countyRoad: { id: match.id, geometry: match.geometry.map(pointOf), roadName: match.roadName,
                        oneway: match.oneWay, attributes: { ...match.attributes } } });
            }
        }
    }
    diagnostic(options, 'public_gateway', 'gatewayCount', { outcome: accepted.length === 1 ? 'accepted' : 'rejected',
        candidateCount: gateways.length, acceptedCount: accepted.length });
    if (accepted.length !== 1) return null;
    const segments = target.component.map(segment => ({ id: segment.id, geometry: segment.geometry.map(pointOf),
        oneway: segment.oneWay, raw_oneway: segment.attributes.oneway ?? null,
        direction_source: String(segment.attributes.oneway || '').trim() ? 'recorded' : 'not_recorded',
        attributes: { ...segment.attributes } }));
    const networkId = `${authority.id}:${hash(JSON.stringify(segments.map(segment => ({ id: segment.id, geometry: segment.geometry }))))}`;
    return { point: target.projection.point, roadName: stop.street_name,
        network: { id: networkId, version: `${authority.id}:${hash(JSON.stringify(segments))}`, segments }, gateway: accepted[0],
        address_match: { house_number: house, street_name: stop.street_name, zip_code: zip, state: authority.state,
            point: address.point, source: address.source },
        evidence: { propertyIdentity: String(stop.address_hash || stop.id || ''), source: authority.source,
            sourceService: authority.roadService, addressSource: address.source, addressPoint: address.point,
            addressId: address.id || null, addressAttributes: address.attributes || null,
            displayPoint: pointOf(stop), targetSegmentId: target.segment.id, projectionMeters: target.projection.meters,
            addressRangeVerified: true, connectedCountyGeometry: true, completeComponent: true,
            queryBounds: box, uniqueGateway: true } };
}

/** Recheck saved evidence against this exact address/display pin. The driving
 * adapter separately checks legal directed paths from the stop to its gateway. */
export function validateCountyRoadAccess(stop, candidate, { now = Date.now() } = {}) {
    try {
        const authority = countyAuthorityFor(stop);
        if (!isValidRoutePoint(stop) || !isValidRoutePoint(candidate?.point)
            || streetKey(candidate.roadName) !== streetKey(stop.street_name)
            || !authority) return false;
        const e = candidate.evidence; const match = candidate.address_match;
        const segments = candidate.network?.segments; const gateway = candidate.gateway;
        const zip = String(stop.zip_code || '').slice(0, 5); const house = String(stop.house_number || '').trim();
        if (!e || !/^\d+$/.test(house) || !/^\d{5}$/.test(zip)
            || e.source !== authority.source || e.sourceService !== authority.roadService
            || e.propertyIdentity !== String(stop.address_hash || stop.id || '')
            || !isValidRoutePoint(e.displayPoint) || distance(stop, e.displayPoint) > 0.1
            || !isValidRoutePoint(e.addressPoint) || distance(stop, e.addressPoint) > 1000
            || distance(candidate.point, e.addressPoint) > 100
            || e.addressRangeVerified !== true || e.connectedCountyGeometry !== true
            || e.completeComponent !== true || e.uniqueGateway !== true
            || String(match?.house_number || '') !== house || String(match.zip_code || '') !== zip
            || streetKey(match.street_name) !== streetKey(stop.street_name) || match.state !== authority.state
            || !isValidRoutePoint(match.point) || distance(match.point, e.addressPoint) > 0.1
            || !Array.isArray(segments) || !segments.length || segments.length > 100
            || segments.reduce((sum, segment) => sum + (Array.isArray(segment.geometry) ? segment.geometry.length : MAX_COMPONENT_VERTICES + 1), 0) > MAX_COMPONENT_VERTICES) return false;
        if (e.addressSource === authority.addressSource) {
            const a = e.addressAttributes;
            if (!a || !active(a, now) || a.state !== authority.state || e.addressId !== `${authority.addressId}:${a.objectid}`
                || !validAuthorityAttributes(authority, a, 'address') || !authority.validAddress(a)
                || String(a.add_number || '') !== house || a.addnum_suf || a.unit
                || String(a.post_code || '').slice(0, 5) !== zip
                || streetKey(String(a.st_address || '').replace(/^\s*\S+\s+/, '')) !== streetKey(stop.street_name)) return false;
        } else if (authority.requiresAddress || e.addressSource !== 'property_pin' || distance(stop, e.addressPoint) > 0.1) return false;
        const seen = new Set();
        for (const segment of segments) {
            if (!new RegExp(`^${authority.id}:\\d+:\\d+$`).test(segment.id) || seen.has(segment.id)
                || !Array.isArray(segment.geometry) || segment.geometry.length < 2 || segment.geometry.length > 5000
                || !segment.geometry.every(isValidRoutePoint)
                || !segment.geometry.some((point, index) => index > 0 && distance(point, segment.geometry[index - 1]) > 0.01)
                || !['both', 'forward', 'reverse'].includes(segment.oneway)
                || oneWay(segment.attributes?.oneway) !== segment.oneway
                || !validAuthorityAttributes(authority, segment.attributes, 'road') || !authority.validRoad(segment.attributes)
                || !active(segment.attributes || {}, now)
                || streetKey(roadName(segment.attributes || {})) !== streetKey(stop.street_name)) return false;
            seen.add(segment.id);
        }
        const canonical = [...segments].sort((a, b) => a.id.localeCompare(b.id));
        if (candidate.network.id !== `${authority.id}:${hash(JSON.stringify(canonical.map(segment => ({ id: segment.id, geometry: segment.geometry }))))}`
            || candidate.network.version !== `${authority.id}:${hash(JSON.stringify(canonical))}`) return false;
        const target = segments.find(segment => segment.id === e.targetSegmentId);
        if (!target || !withinRange(target.attributes, Number(house), zip)
            || !authority.targetMatchesAddress(target.attributes, e.addressAttributes)
            || project(candidate.point, target.geometry)?.meters > 0.5
            || componentOf(target, segments).length !== segments.length) return false;
        const box = e.queryBounds;
        if (!box || ![box.xmin, box.xmax, box.ymin, box.ymax].every(Number.isFinite)
            || box.xmin >= box.xmax || box.ymin >= box.ymax || incomplete(segments, box)) return false;
        if (!isValidRoutePoint(gateway?.point) || !isValidRoutePoint(gateway.providerPoint)
            || distance(gateway.point, gateway.providerPoint) > 10 || !Number.isFinite(gateway.snapMeters)
            || gateway.snapMeters < 0 || gateway.snapMeters > 10
            || !segments.some(segment => [segment.geometry[0], segment.geometry.at(-1)].some(point => distance(point, gateway.point) <= 1))) return false;
        const crossroad = gateway.countyRoad;
        if (!crossroad || seen.has(crossroad.id) || crossroad.id !== gateway.countyRoadId
            || !Array.isArray(crossroad.geometry) || !crossroad.geometry.every(isValidRoutePoint)
            || !crossroad.geometry.some(point => distance(point, gateway.point) <= 1)
            || !active(crossroad.attributes || {}, now)
            || !validAuthorityAttributes(authority, crossroad.attributes, 'road') || !authority.validRoad(crossroad.attributes)
            || oneWay(crossroad.attributes?.oneway) === null
            || streetKey(roadName(crossroad.attributes || {})) !== streetKey(gateway.roadName)
            || streetKey(gateway.roadName) === streetKey(stop.street_name)) return false;
        return true;
    } catch { return false; }
}

/** Discover an address-bound county road component omitted by the driving
 * provider. Unavailable, ambiguous, or disconnected evidence is never accepted. */
export async function discoverCountyRoadAccess(stop, options = {}) {
    try {
        const candidate = await discover(stop, options);
        const valid = candidate && validateCountyRoadAccess(stop, candidate, options);
        if (candidate) diagnostic(options, 'county_roads', 'validation', { outcome: valid ? 'accepted' : 'rejected',
            reason: valid ? 'complete_proof' : 'invalid_proof' });
        return valid ? candidate : null;
    } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError') throw error;
        return null;
    }
}
