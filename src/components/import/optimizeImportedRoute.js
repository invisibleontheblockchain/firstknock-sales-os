import { calculateRouteDistanceMiles, isValidRoutePoint, optimizeRouteWithBounds } from '../../../base44/shared/routeBounds.js';
import { ROAD_VERIFICATION, stampRoadVerification } from '../../lib/routeRoadVerification.js';

// Personal anchors stay in memory. Never substitute the uploader's Home Base
// for the assigned rep's, or silently switch an anchored route to route-only.
async function importBounds(route, client, user) {
  const mode = route.route_origin_mode;
  if (mode === 'car_round_trip' || mode === 'current_to_home') return null;
  if (mode === 'home_round_trip' || mode === 'anchor_round_trip') {
    let point;
    if (mode === 'anchor_round_trip') {
      const response = await client.functions.invoke('manageRepAnchors', { action: 'get_route', route_id: route.id });
      point = response?.data?.anchor;
    } else if (route.assigned_to === user.id) {
      point = user.home_base;
    } else {
      const response = await client.functions.invoke('getRouteHomeBase', { route_id: route.id });
      point = response?.data?.home_base;
    }
    return isValidRoutePoint(point) ? { startLocation: point, endLocation: point } : null;
  }
  const start = route.start_location;
  const end = route.end_location;
  if ((start && !isValidRoutePoint(start)) || (end && !isValidRoutePoint(end))) return null;
  if ((mode === 'custom_bounds' || route.metadata?.route_bounds?.enabled) && !start && !end) return null;
  return { startLocation: start || null, endLocation: end || null };
}

function localMetadata(status, reason) {
  return {
    ...stampRoadVerification({}, ROAD_VERIFICATION.LOCAL_FALLBACK, { reason }).metadata,
    routing: { engine: 'aerial-fallback', road_aware: false, fallback: true, distance_estimate: 'straight_line' },
    import_optimization: { status, reason, checked_at: new Date().toISOString() },
  };
}

function safeRoutingMetadata(metadata) {
  const safe = { ...metadata };
  // The road service echoes trip constraints. Personal Home Base/anchor
  // coordinates must stay in memory even when its measured order is adopted.
  delete safe.start_constraint;
  delete safe.end_constraint;
  return safe;
}

/** Optimize the complete merged manifest, keeping every original identifier. */
export async function optimizeImportedRoute({ route, properties, hashes, client, user, optimizeRoad, optimizeLocal = (stops, start, end) => optimizeRouteWithBounds(stops, { startLocation: start, endLocation: end }) }) {
  const unchanged = (reason, bounds = null) => {
    const metadata = localMetadata('unavailable', reason);
    metadata.routing.distance_scope = bounds ? 'complete_route' : 'between_stops';
    return { hashes, status: 'unavailable', distance: calculateRouteDistanceMiles(properties, bounds || {}), metadata };
  };
  let bounds;
  try { bounds = await importBounds(route, client, user); }
  catch { return unchanged('starting_point_unavailable'); }
  if (!bounds) return unchanged('starting_point_unavailable');

  // The optimizer keys by address_hash; hydrated old records can instead have
  // been saved under a legacy hash or id. Give each stop its manifest identity.
  const stops = properties.map((property, index) => ({ ...property, address_hash: String(hashes[index]) }));
  const byHash = new Map(stops.map((stop, index) => [stop.address_hash, { stop, hash: hashes[index] }]));
  if (byHash.size !== hashes.length) return unchanged('duplicate_stop_identifiers', bounds);
  const exactOrder = candidate => {
    if (!Array.isArray(candidate) || candidate.length !== stops.length) return null;
    const keys = candidate.map(stop => String(stop?.address_hash || ''));
    if (new Set(keys).size !== stops.length || keys.some(key => !byHash.has(key))) return null;
    // Use authoritative coordinates, not any modified optimizer output.
    return keys.map(key => byHash.get(key).stop);
  };
  const originalHashes = order => order.map(stop => byHash.get(stop.address_hash).hash);
  let roadOutcome = 'road_service_unavailable';
  let roadMeasurement = null;
  if (optimizeRoad) {
    try {
      const result = await optimizeRoad(stops.map(stop => ({ ...stop })), {
        start: bounds.startLocation, end: bounds.endLocation,
        onOutcome: (reason, measurement) => { roadOutcome = reason; roadMeasurement = measurement; },
      });
      if (result) {
        const order = exactOrder(result.order);
        if (!order || !Number.isFinite(result.objective?.appliedDistance) || result.objective.appliedDistance < 0 || result.objective.applyCandidate !== true) {
          roadOutcome = 'invalid_road_result';
        } else {
          return {
            hashes: originalHashes(order), status: 'improved', distance: result.objective.appliedDistance,
            metadata: {
              ...safeRoutingMetadata(result.routingMetadata),
              ...stampRoadVerification({}, ROAD_VERIFICATION.ADOPTED, { measuredMiles: result.objective.appliedDistance, savedMiles: result.objective.estimatedSavings }).metadata,
              import_optimization: { status: 'improved', checked_at: new Date().toISOString() },
            },
          };
        }
      }
    } catch { roadOutcome = 'road_service_unavailable'; }
    // The road engine measured the merged order as best. A straight-line
    // candidate must not replace that verified order.
    if (roadOutcome === 'current_order_measured_best' && Number.isFinite(roadMeasurement?.distanceMiles) && roadMeasurement.distanceMiles >= 0) {
      return {
        hashes, status: 'unchanged', distance: roadMeasurement.distanceMiles,
        metadata: {
          ...safeRoutingMetadata(roadMeasurement.routingMetadata),
          ...stampRoadVerification({}, ROAD_VERIFICATION.CONFIRMED, { reason: roadOutcome, measuredMiles: roadMeasurement.distanceMiles }).metadata,
          import_optimization: { status: 'unchanged', reason: roadOutcome, checked_at: new Date().toISOString() },
        },
      };
    }
  }
  try {
    const order = exactOrder(await optimizeLocal(stops.map(stop => ({ ...stop })), bounds.startLocation, bounds.endLocation));
    if (!order) return unchanged('invalid_optimization_order', bounds);
    const baseline = calculateRouteDistanceMiles(stops, bounds);
    const candidate = calculateRouteDistanceMiles(order, bounds);
    // An automatic change needs a strict improvement; preserve ties and worse
    // candidates. Both are measured with exactly the same starting/ending legs.
    const improved = candidate < baseline - 1e-6;
    const status = improved ? 'improved' : 'unchanged';
    return { hashes: improved ? originalHashes(order) : hashes, status, distance: improved ? candidate : baseline, metadata: localMetadata(status, roadOutcome) };
  } catch { return unchanged('optimization_unavailable', bounds); }
}

export function importOptimizationMessage(optimization) {
  if (!optimization) return '';
  if (optimization.status === 'unavailable') return 'Stops added. Run Optimize on the route to check the combined order.';
  const estimated = optimization.metadata?.routing?.distance_estimate !== 'road';
  if (optimization.status === 'improved') return estimated ? 'All stops reordered using estimated distances. Run Optimize to check road distances.' : 'All stops optimized together on road distances.';
  return estimated ? 'All stops checked; no shorter estimated order found.' : 'All stops checked; the combined order was already best.';
}
