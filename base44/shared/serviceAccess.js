import { isValidRoutePoint, haversineDistanceMiles } from './routeBounds.js';
import { roadNetworkRoutingInternals } from './roadNetworkRouting.js';

export const VEHICLE_MATCH_RADIUS_METERS = 100;
const streetKey = value => roadNetworkRoutingInternals.normalizeStreetName(value).replaceAll(' ', '');

/** Candidate discovery is separate from acceptance. Name/distance alone never
 * establishes the service frontage. Callers retain rejected evidence for review. */
export function resolveServiceAccess(stop, candidates = []) {
    const supplied = stop.routing_access;
    if (isValidRoutePoint(supplied?.point) && supplied.resolution_status !== 'unresolved') {
        return { ...supplied, source: supplied.source || 'supplied-access', resolution_status: 'resolved',
            displayPoint: { lat: stop.lat, lng: stop.lng } };
    }
    const accepted = candidates.filter(candidate => {
        const e = candidate.evidence;
        return candidate.source === 'mapped-driveway-frontage' && isValidRoutePoint(candidate.point)
            && e?.propertyIdentity === String(stop.address_hash || stop.id || '')
            && isValidRoutePoint(e.displayPoint) && haversineDistanceMiles(stop, e.displayPoint) * 1609.344 < 0.1
            && e.uniquePropertyAssociation === true && e.uniqueFrontage === true
            && Number.isFinite(e.drivewayEndpointDistanceMeters) && e.drivewayEndpointDistanceMeters <= 25
            && isValidRoutePoint(e.drivewayEndpoint) && haversineDistanceMiles(stop, e.drivewayEndpoint) * 1609.344 <= 25
            && isValidRoutePoint(e.frontagePoint) && haversineDistanceMiles(candidate.point, e.frontagePoint) * 1609.344 <= 10
            && e.connectedDrivewayWayIds?.length > 0 && e.frontageNodeId != null && e.roadWayId != null
            && e.targetRoadRestricted === false && e.hasCompetingNamedFrontage === false
            && streetKey(candidate.roadName) && streetKey(candidate.roadName) === streetKey(stop.street_name)
            && e.provider?.dataVersion && e.provider?.buildFingerprint
            && Number.isFinite(e.provider.snapMeters) && e.provider.snapMeters <= 5
            && streetKey(e.provider.roadName) === streetKey(candidate.roadName)
            && e.provider.arrivalVerified === true && e.provider.departureVerified === true;
    });
    const unique = new Map(accepted.map(c => [`${c.evidence.roadWayId}:${c.evidence.frontageNodeId}`, c]));
    if (unique.size !== 1) return { resolution_status: 'unresolved', confidence: 'low', side: 'unknown',
        source: 'unverified-access', displayPoint: { lat: stop.lat, lng: stop.lng },
        reason: unique.size > 1 ? 'Competing verified frontage candidates.' : 'No evidence-backed vehicle frontage.' };
    return { ...unique.values().next().value, resolution_status: 'resolved', confidence: 'high',
        side: 'unknown', serviceBearing: null, displayPoint: { lat: stop.lat, lng: stop.lng } };
}

export function vehicleServicePoint(stop) {
    const access = resolveServiceAccess(stop);
    return access.resolution_status === 'resolved' ? access.point : stop;
}
