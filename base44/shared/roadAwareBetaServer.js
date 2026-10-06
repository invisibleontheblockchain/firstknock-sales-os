import { compareRoadAwareBeta } from './roadAwareBetaOptimizer.js';
import { tenantManagerId, isRepAccount, toEntityArray } from './accountTenancy.js';
import { roadBetaEligibleOwner, assertRoadBetaProxyRequest } from './roadAwareBetaPolicy.js';
import { vehicleProviderConfig } from './vehicleProviderConfig.js';
import { roadAwareStreetSweep } from './roadAwareStreetSweep.js';
import { buildCanonicalStreetBlocks, haversineMiles } from './routeContinuityOptimizer.js';
import { fetchRoadBetaProxy } from './roadAwareBetaService.js';
import { reviewFinalNeighborhoodRoute } from './finalNeighborhoodReview.js';
import { reviewNeighborhoodExcursions } from './neighborhoodExcursions.js';
import { fetchOsrmJson } from './osrmDispatcher.js';
import { routePropertyOrderFingerprint } from './routeFingerprint.js';

/** Server generation uses its current sweep and boundaries, then the same frozen
 * guard. The workspace comes from a verified user, never a request enable flag. */
export async function completeServerRoadAwareRoutes(routes, { client, user, readSecret, entryPoint, fetchImpl = fetch }) {
    const finishStandard = async () => {
        const out = [];
        const baseUrl = readSecret('OSRM_BASE_URL');
        for (const route of routes) {
            const bounds = { startLocation: route.startLocation, endLocation: route.endLocation };
            const review = baseUrl ? await reviewFinalNeighborhoodRoute(route.properties, { ...bounds,
                vehicleBaseUrl: baseUrl, vehicleFetch: async url => {
                    const payload = await fetchOsrmJson(url);
                    return { ok: true, json: async () => payload };
                } }) : reviewNeighborhoodExcursions(route.properties, bounds);
            out.push({ ...route, properties: review.properties,
                totalDistance: review.measurement?.distanceMiles ?? route.totalDistance,
                metadata: { ...route.metadata, neighborhood_excursion_review: review.diagnostics,
                    routing: { ...route.metadata?.routing, neighborhood_excursion_review: review.diagnostics,
                        property_order_fingerprint: routePropertyOrderFingerprint(review.properties),
                        ...(review.diagnostics.applied ? { road_aware: true, fallback: false,
                            distance_estimate: 'vehicle-road-network', engine: 'osrm-neighborhood-review',
                            estimated_drive_seconds: review.measurement.driveSeconds } : {}) } } });
        }
        return out;
    };
    const workspace = tenantManagerId(user), service = client.asServiceRole;
    if (isRepAccount(user)) {
        const members = toEntityArray(await service.entities.TeamMember.filter({ manager_id: workspace, user_id: user.id }, '-created_date', 100));
        if (!members.some(m => m.manager_id === workspace && m.user_id === user.id && m.status === 'active')) return routes;
    }
    const owner = user.id === workspace ? user : await service.entities.User.get(workspace);
    if (!roadBetaEligibleOwner(owner, workspace, readSecret('ROAD_AWARE_ROUTING_BETA_WORKSPACE_IDS'))
        || readSecret('ROAD_AWARE_ROUTING_BETA_DISABLED') === 'true') return finishStandard();
    let settings;
    try { settings = toEntityArray(await service.entities.RoadAwareRoutingBetaSettings.filter({ manager_id: workspace }, '-updated_date', 10)); }
    catch { return finishStandard(); } // An undeployed OFF resource cannot break generation.
    if (settings.find(s => s.manager_id === workspace)?.enabled !== true) return finishStandard();
    const fingerprint = readSecret('ROAD_AWARE_OSRM_BUILD_FINGERPRINT'), dataVersion = readSecret('ROAD_AWARE_OSRM_DATA_VERSION');
    let config;
    try { config = vehicleProviderConfig({ baseUrl: readSecret('ROAD_AWARE_OSRM_BASE_URL'), profile: 'car', production: true }); } catch { /* Frozen fallback. */ }
    const available = Boolean(config && /^[a-f0-9]{64}$/.test(fingerprint) && dataVersion && readSecret('ROAD_AWARE_OSRM_GATEWAY_TOKEN'));
    const providerFetch = async input => {
        const url = new URL(input), match = url.pathname.match(/^\/(route|table|nearest)\/v1\/car\/(.+)$/);
        if (!match || url.origin !== 'https://firstknock-routing.invalid') throw new Error('Invalid internal provider request.');
        const query = Object.fromEntries(url.searchParams), coordinates = decodeURIComponent(match[2]);
        assertRoadBetaProxyRequest(match[1], coordinates, query);
        return fetchRoadBetaProxy({ provider: config, service: match[1], coordinates, query, dataVersion,
            token: readSecret('ROAD_AWARE_OSRM_GATEWAY_TOKEN'), fetchImpl });
    };
    const partitionRun = (stops, limit) => {
        const membership = new Map(buildCanonicalStreetBlocks(stops).flatMap(block => block.doors.map(door =>
            [door.property.address_hash || door.property.legacy_hash || door.property.id, block.streetKey])));
        const chunks = []; let chunk = [], lastStreet;
        for (const p of stops) {
            const street = membership.get(p.address_hash || p.legacy_hash || p.id);
            if (chunk.length && (chunk.length >= limit || (chunk.length >= limit / 2 && street !== lastStreet))) {
                chunks.push(chunk); chunk = [];
            }
            chunk.push(p); lastStreet = street;
        }
        if (chunk.length) chunks.push(chunk);
        return chunks;
    };
    const out = [];
    for (const route of routes) {
        const result = await compareRoadAwareBeta(route.properties, {
            provider: { available, fingerprint, dataVersion, baseUrl: 'https://firstknock-routing.invalid', fetch: providerFetch },
            continuityFor: () => ({ distanceBetween: haversineMiles }), partitionRun,
            bounds: { startLocation: route.startLocation, endLocation: route.endLocation },
            propose: (stops, context, bounds) => roadAwareStreetSweep(stops, { distanceBetween: context.distanceBetween, routingContext: context, ...bounds }),
        });
        // Do not adopt without history. A history failure keeps the full baseline.
        try {
            const row = await service.entities.RoadAwareRoutingComparison.create({
                manager_id: workspace, actor_user_id: user.id, entry_point: entryPoint,
                comparison: result.comparison, decision: 'generated' });
            const metadata = { ...route.metadata, ...result.metadata, road_aware_comparison_id: row.id,
                road_aware_legacy_order: result.comparison.beforeOrder };
            if (['home_round_trip', 'current_to_home', 'car_round_trip', 'anchor_round_trip', 'private_anchor_round_trip'].includes(route.routeOriginMode || route.route_origin_mode)) {
                delete metadata.road_geometry; delete metadata.road_geometry_segments;
            }
            out.push({ ...route, properties: result.properties, metadata,
                totalDistance: result.comparison.fullMeasurement ? result.distanceMiles : route.totalDistance });
        } catch { out.push(route); }
    }
    return out;
}
