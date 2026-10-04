import { evaluateCoreDrivingRoute, assertPilotMembership } from './coreDrivingPilot.js';
import { createVehicleRoutingContext, identifyUnmatchedVehicleStops } from './vehicleRouting.js';
import { planGuardedDrivingWindows, optimizeGuardedDrivingWindows, measureUnchangedDrivingLegs,
    summarizeStitchedDrivingLegs } from './guardedDrivingWindows.js';
import { routePropertyOrderFingerprint } from './routeFingerprint.js';
import { insideRoadBetaCoverage } from './roadAwareBetaPolicy.js';
import { calculateRouteDistanceMiles } from './routeBounds.js';

const id = p => String(p.address_hash || p.legacy_hash || p.id || '');
const score = value => value ? { miles: value.distanceMiles, seconds: value.driveSeconds } : null;
const fatal = error => { if (error?.name === 'AbortError' || /membership|graph identity|cancelled/i.test(error?.message || '')) throw error; };
const displaySegments = (points, extra = {}) => {
    if (!points?.length) return [];
    const segments = [];
    for (let start = 0; start < points.length - 1; start += 11999) segments.push({ ...extra, points: points.slice(start, start + 12000) });
    return segments;
};

/** The measured guard and window engine are reused unchanged. Callers supply
 * their existing sweep and street/access splitter; no membership or eligibility
 * decisions are delegated to the road provider. All display shapes are verified
 * independent segments, never a line through an unresolved gap. */
export async function compareRoadAwareBeta(legacyOrder, { propose, partitionRun, continuityFor, provider,
    bounds = {}, signal, resume, onCheckpoint } = {}) {
    // The frozen engine uses address_hash/id; production also supports legacy_hash.
    // Normalize only its input, then return the original production records.
    const originals = new Map(legacyOrder.map(p => [id(p), p]));
    legacyOrder = legacyOrder.map(p => ({ ...p, address_hash: id(p) }));
    assertPilotMembership(legacyOrder, legacyOrder);
    const shapes = new Map();
    const result = (properties, before, after, details = {}) => {
        assertPilotMembership(legacyOrder, properties);
        const comparison = {
            beforeOrder: legacyOrder.map(id), afterOrder: properties.map(id),
            beforeFingerprint: routePropertyOrderFingerprint(legacyOrder), afterFingerprint: routePropertyOrderFingerprint(properties),
            membershipCount: properties.length, before, after,
            milesSaved: before && after ? before.miles - after.miles : null,
            secondsSaved: before && after ? before.seconds - after.seconds : null,
            changedStops: properties.filter((p, i) => id(p) !== id(legacyOrder[i])).length,
            graphFingerprint: provider.fingerprint, dataVersion: provider.dataVersion, acceptedRegressions: 0,
            ...details,
        };
        const geometry = details.geometry || { current: [], selected: [] };
        delete comparison.geometry;
        comparison.geometryFingerprint = routePropertyOrderFingerprint(geometry.selected.map(segment => JSON.stringify(segment.points)));
        return { properties: properties.map(p => originals.get(id(p))), comparison, geometry,
            distanceMiles: comparison.fullMeasurement && after ? after.miles : calculateRouteDistanceMiles(properties, bounds),
            metadata: { road_geometry: comparison.fullMeasurement && !comparison.optimizationWindows && geometry.selected.length === 1 ? geometry.selected[0]?.points || null : null,
                road_geometry_segments: geometry.selected,
                routing: { engine: 'guarded-road-aware-beta-v1', road_aware_routing_beta: true, travel_mode: 'driving',
                    road_aware: Boolean(after), fallback: !after, fallback_reason: comparison.reason || null,
                    property_order_fingerprint: comparison.afterFingerprint,
                    distance_estimate: comparison.fullMeasurement ? 'vehicle-road-network' : 'partial-road-measurement',
                    estimated_drive_seconds: comparison.fullMeasurement ? after?.seconds ?? null : null,
                    legacy_road_miles: before?.miles ?? null, legacy_drive_seconds: before?.seconds ?? null,
                    measurable_road_miles: after?.miles ?? null, measurable_drive_seconds: after?.seconds ?? null,
                    measured_leg_count: comparison.measuredLegs ?? null, unresolved_stop_count: comparison.unresolvedCount || 0,
                    fallback_window_count: comparison.fallbackWindows || 0, guard_result: comparison.guard,
                    provider_epoch: provider.fingerprint, access_match_meters: 100, accepted_regressions: 0,
                    guard_policy: 'strictly-lower-complete-driving-time-and-no-more-road-miles; real-window-connectors' } } };
    };
    if (!provider.available) return result(legacyOrder, null, null, { guard: 'legacy_fallback', reason: 'PROVIDER_NOT_CONFIGURED' });
    const outside = legacyOrder.filter(point => !insideRoadBetaCoverage(point));
    if (outside.length === legacyOrder.length || [bounds.startLocation, bounds.endLocation].filter(Boolean)
        .some(point => !insideRoadBetaCoverage(point))) return result(legacyOrder, null, null, { guard: 'legacy_fallback', reason: 'OUTSIDE_GRAPH_COVERAGE' });
    const options = { vehicleBaseUrl: provider.baseUrl, vehicleProfile: 'car', vehicleFetch: provider.fetch,
        production: true, expectedDataVersion: provider.dataVersion, requireDirectedLegs: true,
        maxGeometryPoints: 100000, signal, servicePolicy: { enabled: true, parkingSecondsPerStop: 0 } };
    // Personal anchor coordinates stay in memory only. Curb/parking inference is
    // disabled, exactly as in the frozen core driving experiment.
    const makeContext = async (stops, routeOnly = false, routeBounds = {}) => {
        const context = await createVehicleRoutingContext(stops.map(p => p.routing_access
            ? { ...p, routing_access: { ...p.routing_access, serviceBearing: null, side: 'unknown' } } : p),
            { ...continuityFor(stops), accessFor: () => null }, { ...options, ...routeBounds, routeOnly });
        return { ...context, async routeSequence(order, suppliedBounds = {}) {
            const route = await context.routeSequence(order, suppliedBounds);
            if (route.geometry) shapes.set(routePropertyOrderFingerprint(order), route.geometry);
            return route;
        } };
    };
    const unknown = new Set([...outside, ...legacyOrder.filter(p => p.routing_access?.resolution_status === 'unresolved')].map(id));
    try { for (const key of await identifyUnmatchedVehicleStops(legacyOrder.filter(p => insideRoadBetaCoverage(p)), options)) unknown.add(key); }
    catch (error) { fatal(error); return result(legacyOrder, null, null, { guard: 'legacy_fallback', reason: 'ROAD_EVIDENCE_UNAVAILABLE' }); }
    if (legacyOrder.length <= 500 && !unknown.size) {
        const outcome = await evaluateCoreDrivingRoute({ legacyOrder, bounds,
            createContext: stops => makeContext(stops, false, bounds), propose });
        const current = outcome.baseline?.geometry, selected = outcome.selected?.geometry;
        return result(outcome.properties, score(outcome.baseline), score(outcome.selected), {
            guard: outcome.selection, reason: outcome.reason, fullMeasurement: outcome.eligible,
            measuredLegs: outcome.eligible ? Math.max(0, legacyOrder.length - 1) : 0,
            unmeasurableLegs: outcome.eligible ? 0 : Math.max(0, legacyOrder.length - 1), unresolvedCount: 0,
            rawProposal: score(outcome.candidate),
            geometry: { current: displaySegments(current), selected: displaySegments(selected) } });
    }
    const plan = planGuardedDrivingWindows(legacyOrder, { unresolvedIds: [...unknown], maxWindowStops: 500, partitionRun });
    const output = await optimizeGuardedDrivingWindows(legacyOrder, plan, { providerEpoch: provider.fingerprint,
        expectedDataVersion: provider.dataVersion, resume, signal, onCheckpoint,
        createContext: stops => makeContext(stops), propose });
    if (output.results.some(row => row.reason === 'ROAD_PROVIDER_UNAVAILABLE')) return result(legacyOrder, null, null, {
        guard: 'legacy_fallback', reason: 'ROAD_PROVIDER_UNAVAILABLE', unresolvedCount: unknown.size,
        unresolvedIds: [...unknown], fallbackWindows: plan.windows.length });
    let unchanged = [];
    if (!output.results.some(row => row.reason === 'ROAD_PROVIDER_UNAVAILABLE')) {
        try {
            unchanged = await measureUnchangedDrivingLegs(legacyOrder, output, { unresolvedIds: [...unknown], signal,
                measureSequence: async stops => (await makeContext(stops, true)).routeSequence(stops) });
        } catch (error) {
            fatal(error);
            return result(legacyOrder, null, null, { guard: 'legacy_fallback', reason: 'ROAD_EVIDENCE_UNAVAILABLE',
                unresolvedCount: unknown.size, unresolvedIds: [...unknown], fallbackWindows: plan.windows.length });
        }
    }
    const totals = summarizeStitchedDrivingLegs(legacyOrder, output, unchanged);
    const geometry = { current: [], selected: [] };
    for (const row of output.results.filter(row => row.eligible)) for (const arm of ['current', 'selected']) {
        const stops = arm === 'current' ? legacyOrder.slice(row.start, row.end) : output.properties.slice(row.start, row.end);
        const points = shapes.get(routePropertyOrderFingerprint(stops));
        if (points) geometry[arm].push(...displaySegments(points, { firstStop: row.start, lastStop: row.end - 1 }));
    }
    return result(output.properties,
        totals.measuredLegs ? { miles: totals.legacyMeasurableMiles, seconds: totals.legacyMeasurableSeconds } : null,
        totals.measuredLegs ? { miles: totals.selectedMeasurableMiles, seconds: totals.selectedMeasurableSeconds } : null, {
            guard: output.summary.improvedWindows ? 'road_aware_sections' : 'legacy_guard',
            reason: totals.unmeasurableLegs ? 'PARTIAL_ROAD_COVERAGE' : null,
            fullMeasurement: totals.fullRoadTotalAvailable && !bounds.startLocation && !bounds.endLocation,
            measuredLegs: totals.measuredLegs, unmeasurableLegs: totals.unmeasurableLegs,
            unresolvedCount: unknown.size, unresolvedIds: [...unknown], fallbackWindows: output.summary.fallbackWindows,
            improvedWindows: output.summary.improvedWindows, guardRetainedWindows: output.summary.guardRetainedWindows,
            optimizationWindows: plan.windows.length, geometry,
        });
}
