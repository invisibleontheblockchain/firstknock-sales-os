import { routePropertyOrderFingerprint } from '../../base44/shared/routeFingerprint.js';
import { verifiedRouteGeometry } from '../../base44/shared/routeDisplayGeometry.js';
import { isValidRoutePoint } from '../../base44/shared/routeBounds.js';

// The same geometry selection feeds manager, saved-route and rep maps. New
// optimization geometry carries stricter order/location proof; legacy and beta
// geometry remain usable only while their original manifest still matches.
export function verifiedRouteSegments(metadata, manifest, properties = []) {
    if (metadata?.road_geometry_provenance) {
        return verifiedRouteGeometry(metadata, manifest, properties)?.road_geometry_segments.map(segment => segment.points) || [];
    }
    const expected = metadata?.routing?.property_order_fingerprint;
    if (!expected || routePropertyOrderFingerprint(manifest) !== expected
        || (properties.length && routePropertyOrderFingerprint(properties) !== expected)) return [];
    const candidates = metadata?.road_geometry_segments || (metadata?.road_geometry ? [{ points: metadata.road_geometry }] : []);
    if (!Array.isArray(candidates) || !candidates.length) return [];
    const segments = candidates.map(segment => segment?.points);
    if (!segments.every(points => Array.isArray(points) && points.length > 1 && points.length <= 12000
        && points.every(isValidRoutePoint))) return [];
    return segments;
}

export function verifiedBetaSegments(metadata, manifest, properties = []) {
    if (!metadata?.routing?.road_aware_routing_beta) return null;
    return verifiedRouteSegments(metadata, manifest, properties);
}
