import { routePropertyOrderFingerprint } from './routeFingerprint.js';
import { isValidRoutePoint } from './routeBounds.js';

const MAX_POINTS = 100000;
const SEGMENT_POINTS = 12000;
const identity = stop => String(stop?.address_hash || stop?.legacy_hash || stop?.id || '');
const point = value => ({ lat: Number(value.lat), lng: Number(value.lng) });

export function routeLocationsFingerprint(properties) {
    if (!Array.isArray(properties) || !properties.length || properties.some(stop => !identity(stop) || !isValidRoutePoint(stop))) return '';
    return routePropertyOrderFingerprint(properties.map(stop =>
        `${identity(stop)}|${Number(stop.lat)}|${Number(stop.lng)}`));
}

// Reuse the complete directed measurement that approved this exact order. No
// road requests, straight-line interpolation or point thinning are involved.
// Anchored trips are deliberately excluded: a shared route must never retain
// a personal home or current-location leg inside otherwise innocuous geometry.
export function buildVerifiedRouteGeometry({ measurement, properties, displayProperties = properties, startLocation = null, endLocation = null }) {
    if (startLocation || endLocation || !Array.isArray(properties) || properties.length < 2) return {};
    if (!Array.isArray(displayProperties) || displayProperties.length !== properties.length) return {};
    const displays = new Map(displayProperties.map(stop => [identity(stop), stop]));
    if (displays.size !== properties.length || properties.some(stop => !displays.has(identity(stop)))) return {};
    const fingerprint = routePropertyOrderFingerprint(properties);
    // Recovery changes the solver's service coordinates while house pins stay
    // where they were. Bind display freshness to the original submitted pins.
    const locations = routeLocationsFingerprint(properties.map(stop => displays.get(identity(stop))));
    const geometry = measurement?.geometry;
    const legs = measurement?.directedLegs;
    if (!fingerprint || !locations || !Array.isArray(geometry) || geometry.length < 2 || geometry.length > MAX_POINTS
        || !geometry.every(isValidRoutePoint) || !Array.isArray(legs) || legs.length !== properties.length - 1
        || legs.some((leg, i) => leg.from !== identity(properties[i]) || leg.to !== identity(properties[i + 1])
            || !Array.isArray(leg.geometry) || !leg.geometry.length || !leg.geometry.every(isValidRoutePoint))) return {};
    const segments = [];
    for (let start = 0; start < geometry.length - 1; start += SEGMENT_POINTS - 1) {
        segments.push({ points: geometry.slice(start, start + SEGMENT_POINTS).map(point) });
    }
    return {
        road_geometry_segments: segments,
        road_geometry_provenance: { version: 1, scope: 'route_doors', source: 'complete_driving_verification',
            property_order_fingerprint: fingerprint, property_locations_fingerprint: locations,
            point_count: geometry.length },
    };
}

// Used before persistence and again by both maps. A stale order or moved house
// cannot reuse a line merely because some earlier optimization was verified.
export function verifiedRouteGeometry(metadata, manifest, properties = []) {
    const proof = metadata?.road_geometry_provenance;
    const fingerprint = routePropertyOrderFingerprint(manifest);
    if (!proof || proof.version !== 1 || proof.scope !== 'route_doors' || proof.source !== 'complete_driving_verification'
        || !fingerprint || proof.property_order_fingerprint !== fingerprint
        || metadata?.routing?.property_order_fingerprint !== fingerprint
        || metadata?.road_path_validated !== true
        || metadata.fallback === true || metadata.road_access_recovery?.inventory_complete === false
        || metadata.road_access_recovery?.unresolved?.length
        || (properties.length && (routePropertyOrderFingerprint(properties) !== fingerprint
            || routeLocationsFingerprint(properties) !== proof.property_locations_fingerprint))) return null;
    const segments = metadata.road_geometry_segments;
    if (!Array.isArray(segments) || !segments.length || segments.length > 9) return null;
    let count = 0;
    for (let i = 0; i < segments.length; i++) {
        const points = segments[i]?.points;
        if (!Array.isArray(points) || points.length < 2 || points.length > SEGMENT_POINTS || !points.every(isValidRoutePoint)) return null;
        if (i) {
            const prior = segments[i - 1].points.at(-1);
            if (Number(prior.lat) !== Number(points[0].lat) || Number(prior.lng) !== Number(points[0].lng)) return null;
        }
        count += points.length - (i ? 1 : 0);
    }
    if (count !== proof.point_count || count > MAX_POINTS) return null;
    return { road_geometry_segments: segments.map(segment => ({ points: segment.points.map(point) })),
        road_geometry_provenance: { ...proof } };
}

export function clearRouteGeometry(metadata) {
    const result = { ...metadata };
    delete result.road_geometry;
    delete result.road_geometry_segments;
    delete result.road_geometry_provenance;
    return result;
}
