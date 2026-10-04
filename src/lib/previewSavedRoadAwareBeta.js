import { prepareRoadAwareBetaComparison, applyRoadAwareBetaComparison, keepRoadAwareBetaCurrent } from './roadAwareRoutingBeta';
import { requestRoadAwareApproval } from './roadAwareBetaApproval';

export async function previewSavedRoadAwareBeta({ route, properties, bounds, entryPoint, buildUpdate,
    choose = requestRoadAwareApproval, client, status }) {
    if (route.property_hashes?.length !== properties.length) throw new Error('Load every saved route stop before comparing.');
    const manifestStops = properties.map((p, i) => ({ ...p, address_hash: String(route.property_hashes[i]) }));
    const result = await prepareRoadAwareBetaComparison(manifestStops, { bounds, routeId: route.id, entryPoint, client, status,
        enabledHint: route.metadata?.routing?.road_aware_routing_beta === true });
    if (!result) return null; // OFF: caller continues its unchanged production path.
    const accepted = result.comparison.changedStops > 0;
    const useNew = await choose({ routeName: route.name, properties: manifestStops, result, canApply: accepted });
    if (!useNew || !accepted) {
        await keepRoadAwareBetaCurrent(result, client);
        return { handled: true, applied: false, result };
    }
    const update = buildUpdate(result);
    const response = await applyRoadAwareBetaComparison(result, update, client);
    return { handled: true, applied: true, result, update, route: response.route, historyWarning: response.history_warning };
}
