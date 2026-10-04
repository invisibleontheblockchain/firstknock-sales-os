import { routePropertyOrderFingerprint } from '../../base44/shared/routeFingerprint.js';

export function verifiedBetaSegments(metadata, manifest, properties = []) {
    if (!metadata?.routing?.road_aware_routing_beta) return null;
    const expected = metadata.routing.property_order_fingerprint;
    if (!expected || routePropertyOrderFingerprint(manifest) !== expected
        || (properties.length && routePropertyOrderFingerprint(properties) !== expected)) return [];
    const candidates = metadata.road_geometry_segments || (metadata.road_geometry ? [{ points: metadata.road_geometry }] : []);
    return candidates.map(segment => segment.points).filter(points => Array.isArray(points) && points.length > 1 && points.length <= 12000
        && points.every(p => p?.lat != null && p?.lng != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))));
}
