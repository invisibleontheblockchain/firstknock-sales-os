/**
 * Re-optimize ONE saved route — extracted from Home.jsx unchanged in behaviour.
 *
 * Two entry shapes:
 *  - Optimize modes: `{ mode: 'route_only' | 'home_round_trip' | 'car_round_trip' }`
 *    (plus the legacy `{ fromHome: true }`). Their anchors are personal, so their
 *    coordinates are never persisted on the shared route.
 *  - ANCHORS: `{ anchors: { start, end } }` sets a manager-typed fixed start and
 *    finish for this route, and `{ anchors: null }` clears them. Those points are
 *    shared crew locations, so they ARE persisted in start_location/end_location.
 */

import { toast } from 'sonner';

import { base44 } from '@/api/base44Client';
import { hydrateRouteForMap } from '@/components/logic/routeHydration';
import { hasCompleteRouteMapPoints } from '@/components/logic/routeHydrationCore';
import { loadSavedRouteSelection } from '@/components/logic/routeMapSelection';
import { isValidRoutePoint } from '@/lib/routeBounds';
import { captureParkedCarLocation, isLowAccuracyCapture, lowAccuracyConfirmationMessage } from '@/lib/parkedCarLocation';
import { startOptimizeProgress } from '@/lib/optimizeProgressToast';
import { LONG_OPTIMIZATION_STOPS, startRoadOptimizationJob } from '@/lib/roadOptimizationProgress';
import { claimRouteOptimization, finishInBackground, optimizeFirstThenFinish, routeGuardSnapshot } from '@/lib/backgroundRouteImprovement';
import { buildRoadOptimizationAttempt, describeAppliedRoadOptimization, describeRoadOptimizationOutcome } from '@/lib/routeOptimizationOutcome';
import { countChangedRouteStops, persistOptimizedRoute, syncOptimizedRoute } from '@/lib/routeOptimizePersistence';
import { ROAD_VERIFICATION, stampRoadVerification } from '@/lib/routeRoadVerification';
import { OPTIMIZE_MODES, ROUTE_ORIGIN_MODES, resolveOptimizeMode, routeOriginModeForOptimizeMode } from '@/lib/routeOriginModes';
import { clearRouteGeometry, verifiedRouteGeometry } from '../../base44/shared/routeDisplayGeometry.js';
import {
    buildRouteAnchorsUpdate,
    buildRouteOptimizeUpdate,
    normalizeRouteAnchor,
    optimizeSuccessMessage,
    routeBelongsToActingUser,
} from '@/lib/routeOptimizeUpdate';

const TOAST_ID = 'reoptimize-route';
// Pass 1 is saved; the remaining passes save only a shorter order onto an untouched route.
const BACKGROUND_NOTE = ' Still checking the remaining neighborhoods in the background.';

const propertyKey = (property) => property.address_hash || property.legacy_hash || property.id;

function loadingMessage({ usingCustomAnchors, customAnchors, optimizeFromCar, optimizeFromHome }) {
    if (usingCustomAnchors) return customAnchors ? 'Setting route anchors...' : 'Clearing route anchors...';
    if (optimizeFromCar) return 'Optimizing from your car...';
    if (optimizeFromHome) return 'Optimizing from Home Base...';
    return 'Optimizing route...';
}

export async function reoptimizeRoute(route, options = {}, deps = {}) {
    const {
        user,
        teamMembers = [],
        effectiveProperties = [],
        mapRef,
        queryClient,
        setActiveRoute,
        confirmLowAccuracyLocation = () => true,
        previewRoadAwareBeta = null,
        hydrateRoute = hydrateRouteForMap,
        client = base44,
    } = deps;

    // Explicit mode. The legacy { fromHome: true } shape still resolves, but every
    // call from the Optimize control names its mode, because the anchor is part of
    // the resulting order and inferring it was what made the old button unpredictable.
    const optimizeMode = resolveOptimizeMode(options);
    const optimizeFromHome = optimizeMode === OPTIMIZE_MODES.HOME_ROUND_TRIP;
    const optimizeFromCar = optimizeMode === OPTIMIZE_MODES.CAR_ROUND_TRIP;
    const usingCustomAnchors = Object.prototype.hasOwnProperty.call(options, 'anchors');
    const usingPrivateAnchor = route?.route_origin_mode === ROUTE_ORIGIN_MODES.PRIVATE_ANCHOR_ROUND_TRIP
        && !usingCustomAnchors && !options.mode && !options.fromHome;
    const customAnchors = usingCustomAnchors ? options.anchors : null;

    let carAnchor = null;
    if (optimizeFromCar) {
        // Authoritative refusal, before any GPS is requested. assigned_to may hold a
        // User id OR a TeamMember id, so a plain user.id comparison denies the real
        // assignee whenever the route stored a TeamMember id.
        if (!routeBelongsToActingUser(route, user, teamMembers)) {
            toast.error('The assigned rep must optimize this route from their car on their device.', { id: TOAST_ID, duration: 6000 });
            return;
        }
        toast.loading('Getting your parked-car location...', { id: TOAST_ID });
        const capture = await captureParkedCarLocation();
        if (!capture.ok) {
            toast.error(capture.message, { id: TOAST_ID, duration: 6000 });
            return;
        }
        if (isLowAccuracyCapture(capture.point) && !confirmLowAccuracyLocation(lowAccuracyConfirmationMessage(capture.point))) {
            toast.dismiss(TOAST_ID);
            return;
        }
        carAnchor = capture.point;
    }

    toast.loading(
        loadingMessage({ usingCustomAnchors, customAnchors, optimizeFromCar, optimizeFromHome }),
        { id: TOAST_ID }
    );
    const savedView = mapRef?.current ? { center: mapRef.current.getCenter(), zoom: mapRef.current.getZoom() } : null;
    // Ticks the elapsed seconds through the long road phases so the wait never
    // looks like a hang. Stopped in `finally`, so no path leaves it running.
    let progress = null;
    let job = null;
    // Set once pass 1 is saved and the rest of the search runs on its own;
    // `background` settles when it ends ({ saved, miles, reason }).
    let backgrounded = false;
    const run = { background: null };
    try {
        const hashes = (route.property_hashes || (route.properties || []).map(propertyKey)).filter(Boolean);
        if (!hashes.length) { toast.error('No properties found for this route.', { id: TOAST_ID }); return; }
        const selectedRoute = await loadSavedRouteSelection({ ...route, property_hashes: hashes },
            hasCompleteRouteMapPoints({ ...route, property_hashes: hashes }) ? [] : effectiveProperties,
            selected => {
                toast.loading('Loading homes for this route...', { id: TOAST_ID });
                return hydrateRoute(selected, user?.email);
            });
        const cachedAccess = route.metadata?.road_access_recovery?.access_overrides || {};
        const routeProperties = selectedRoute.properties
            .map(property => cachedAccess[propertyKey(property)]
                ? { ...property, routing_access: cachedAccess[propertyKey(property)] } : property);
        if (routeProperties.length === 0) { toast.error('No properties found for this route.', { id: TOAST_ID }); return; }
        if (routeProperties.length !== hashes.length) {
            toast.error(`Only ${routeProperties.length} of ${hashes.length} route properties loaded. Refresh and try again.`, { id: TOAST_ID, duration: 6000 });
            return;
        }
        const assignedMember = teamMembers.find(member =>
            member.id === route.assigned_to || member.user_id === route.assigned_to
        );
        const routeBelongsToCurrentUser = !route.assigned_to
            || route.assigned_to === user?.id
            || assignedMember?.user_id === user?.id
            || Boolean(assignedMember?.email && user?.email
                && String(assignedMember.email).toLowerCase() === String(user.email).toLowerCase());
        // A Home Base captured in this click (the prompt shown when none was set
        // yet) is authoritative: the cached `user` object in this closure can
        // still be the pre-save copy.
        let requestedHomeBase = isValidRoutePoint(options.homeBase)
            ? options.homeBase
            : routeBelongsToCurrentUser ? user?.home_base : null;
        if (optimizeFromHome && !routeBelongsToCurrentUser) {
            try {
                const response = await client.functions.invoke('getRouteHomeBase', { route_id: route.id });
                requestedHomeBase = response?.data?.home_base || null;
            } catch (error) {
                console.warn('[reoptimizeRoute] Could not load assigned rep Home Base:', error);
            }
        }
        if (optimizeFromHome && !isValidRoutePoint(requestedHomeBase)) {
            toast.error(
                assignedMember
                    ? `${assignedMember.name || 'This rep'} needs to set a Home Base first.`
                    : 'Set a Home Base in Precision Generate before optimizing from home.',
                { id: TOAST_ID, duration: 5000 }
            );
            return;
        }

        let privateAnchor = null;
        if (usingPrivateAnchor) {
            const response = await client.functions.invoke('manageRepAnchors', { action: 'get_route', route_id: route.id });
            privateAnchor = response.data.anchor;
            if (!isValidRoutePoint(privateAnchor)) throw new Error('Configure the route anchor before optimizing.');
        }

        // route_only means EXACTLY the doors: no map centre, no current GPS, no Home
        // Base, no stale saved bound. This path once fell back to the map centre,
        // silently anchoring the route to wherever the user happened to be looking.
        const start = optimizeFromCar ? carAnchor
            : optimizeFromHome ? requestedHomeBase
            : usingCustomAnchors ? normalizeRouteAnchor(customAnchors?.start)
            : usingPrivateAnchor ? privateAnchor : null;
        const end = optimizeFromCar ? carAnchor
            : optimizeFromHome ? requestedHomeBase
            : usingCustomAnchors ? normalizeRouteAnchor(customAnchors?.end)
            : usingPrivateAnchor ? privateAnchor : null;
        const routeOriginMode = usingPrivateAnchor ? ROUTE_ORIGIN_MODES.PRIVATE_ANCHOR_ROUND_TRIP : usingCustomAnchors
            ? (start || end ? ROUTE_ORIGIN_MODES.CUSTOM_BOUNDS : ROUTE_ORIGIN_MODES.NONE)
            : routeOriginModeForOptimizeMode(optimizeMode);
        // Hashes derived from personal trip bounds stay in this action only.
        const shareSearchCoverage = [ROUTE_ORIGIN_MODES.NONE, ROUTE_ORIGIN_MODES.CUSTOM_BOUNDS].includes(routeOriginMode);
        const beta = previewRoadAwareBeta ? await previewRoadAwareBeta({
            route, properties: routeProperties, bounds: { startLocation: start, endLocation: end },
            entryPoint: 'saved_route_optimize',
            buildUpdate: result => {
                const inputs = { start, end, optimizeMode, order: result.comparison.afterOrder,
                    distanceMiles: result.comparison.fullMeasurement ? result.distanceMiles : route.metrics?.distance,
                    existingMetrics: route.metrics, existingMetadata: route.metadata,
                    routingMetadata: { ...result.metadata, road_aware_comparison_id: result.comparisonId }, carCapture: carAnchor };
                const update = usingCustomAnchors ? buildRouteAnchorsUpdate(inputs) : buildRouteOptimizeUpdate(inputs);
                if (routeOriginMode === ROUTE_ORIGIN_MODES.NONE || routeOriginMode === ROUTE_ORIGIN_MODES.CUSTOM_BOUNDS) {
                    Object.assign(update.metadata, result.metadata);
                } else {
                    delete update.metadata.road_geometry;
                    delete update.metadata.road_geometry_segments;
                }
                if (usingPrivateAnchor) {
                    update.route_origin_mode = routeOriginMode;
                    update.metadata.route_bounds = { enabled: true, mode: routeOriginMode };
                } else delete update.metadata.anchor;
                return update;
            },
        }) : null;
        if (beta) {
            toast.dismiss(TOAST_ID);
            if (beta.applied) {
                await syncOptimizedRoute({ saved: { ...route, ...beta.update, ...beta.route },
                    properties: beta.result.properties, queryClient, setActiveRoute,
                    session: { startLocation: start, endLocation: end, routeOriginMode } });
                toast.success('Road-aware order applied. The previous order remains available in Routing Beta history.');
                if (beta.historyWarning) toast.warning(beta.historyWarning);
            }
            return;
        }
        // Address recovery and real driving checks run on the backend. Every
        // decline is saved and displayed before this action finishes.
        // A big route shows the progress screen (estimate, passes, checks,
        // miles saved) instead of the one-line toast, and can run in the
        // background while the user keeps working.
        if (routeProperties.length >= LONG_OPTIMIZATION_STOPS) {
            job = startRoadOptimizationJob({ routes: [{ name: route.name, stops: routeProperties.length }], background: true });
            job.startRoute(0);
            progress = { update() {}, stop() {} };
        } else {
            progress = startOptimizeProgress({
                id: TOAST_ID,
                label: `Checking real road distances for ${routeProperties.length} doors...`
            });
        }
        // Why the road pass declined decides what the saved route may claim about
        // itself. "The road engine measured your order and found nothing better"
        // is a verification; "the road engine was unreachable" is not, and the two
        // used to be the same anonymous null.
        // First result fast: pass 1 is saved and shown as soon as it is done;
        // the remaining passes continue in the background and save only a
        // measurably shorter order onto an untouched route.
        const optimizeRun = claimRouteOptimization(route.id);
        const search = optimizeFirstThenFinish(routeProperties, {
            client,
            start: isValidRoutePoint(start) ? start : null,
            end: isValidRoutePoint(end) ? end : null,
            searchCoverage: shareSearchCoverage ? route.metadata?.road_search_coverage : null,
            maxSearchPasses: 8,
            // Passes after the first run in the background: their progress goes to
            // the progress pill, never over the saved result's message.
            onSearchProgress: value => job?.progress(0, value),
        });
        const firstPhase = await search.first;
        const roadMatrixResult = firstPhase.result;
        const roadDeclineReason = firstPhase.reason;
        const roadMeasurement = firstPhase.measurement;
        const session = {
            startLocation: routeOriginMode !== ROUTE_ORIGIN_MODES.NONE ? start : null,
            endLocation: routeOriginMode !== ROUTE_ORIGIN_MODES.NONE ? end : null,
            routeOriginMode,
        };
        const continueInBackground = (savedRoute, firstResult) => {
            if (!firstPhase.more) return;
            backgrounded = true;
            job?.finishInBackground();
            run.background = finishInBackground({
                final: search.final, firstResult, client,
                snapshot: routeGuardSnapshot(savedRoute, { run: optimizeRun }),
                save: async (finalResult, current, miles) => {
                    const currentHashes = (current.property_hashes || []).map(String);
                    const built = buildAppliedUpdate(finalResult, current, currentHashes);
                    await persistOptimizedRoute({ route: { ...route, ...current }, update: built.routeUpdate,
                        properties: built.appliedProperties, client, queryClient, setActiveRoute, session });
                    toast.success(`Route improved by ${miles} mi while you worked.`, { duration: 6000 });
                },
                // Nothing shorter: keep the saved record accurate (coverage, verdict).
                quiet: async (finalValue, current) => {
                    const meta = finalValue.result?.routingMetadata || finalValue.measurement?.routingMetadata;
                    if (!meta) return;
                    const metadata = { ...(current.metadata || {}) };
                    if (shareSearchCoverage && meta.road_search_coverage) metadata.road_search_coverage = meta.road_search_coverage;
                    if (!finalValue.result) {
                        metadata.last_optimization_attempt = buildRoadOptimizationAttempt(finalValue.reason, finalValue.measurement, {
                            mode: optimizeMode, doorCount: routeProperties.length,
                        });
                    }
                    const saved = await client.entities.SavedRoute.update(current.id, { metadata });
                    await syncOptimizedRoute({ saved: { ...route, ...current, ...saved, metadata }, properties: routeProperties,
                        queryClient, setActiveRoute, metadataOnly: true });
                },
            }).catch(error => {
                console.warn('[reoptimizeRoute] background improvement was not saved', error);
                return { saved: false, reason: 'save_failed' };
            }).finally(() => job?.finish());
        };

        // Every explicit Optimize click needs a visible driving verdict. A failed
        // check cannot fall through to an unverified reorder, even on a new route.
        if (!roadMatrixResult) {
            const outcome = describeRoadOptimizationOutcome(roadDeclineReason, roadMeasurement);
            const confirmedGeometry = !start && !end && roadDeclineReason === 'current_order_measured_best'
                && roadMeasurement?.verifiedCurrentOrder === true
                ? verifiedRouteGeometry(roadMeasurement.routingMetadata, hashes, routeProperties) : null;
            const metadata = { ...(confirmedGeometry ? clearRouteGeometry(route.metadata) : route.metadata || {}),
                ...(confirmedGeometry ? { ...clearRouteGeometry(roadMeasurement.routingMetadata), ...confirmedGeometry } : {}),
                ...(roadMeasurement?.routingMetadata?.road_access_recovery
                    ? { road_access_recovery: roadMeasurement.routingMetadata.road_access_recovery } : {}),
                ...(shareSearchCoverage && roadMeasurement?.routingMetadata?.road_search_coverage
                    ? { road_search_coverage: roadMeasurement.routingMetadata.road_search_coverage } : {}),
                last_optimization_attempt: buildRoadOptimizationAttempt(roadDeclineReason, roadMeasurement, {
                    mode: optimizeMode, doorCount: routeProperties.length,
                }) };
            if (!shareSearchCoverage) delete metadata.road_search_coverage;
            const saved = await client.entities.SavedRoute.update(route.id, { metadata });
            await syncOptimizedRoute({ saved: { ...route, ...saved, metadata }, properties: routeProperties,
                queryClient, setActiveRoute, metadataOnly: true });
            toast[outcome.tone](`${outcome.message}${firstPhase.more ? BACKGROUND_NOTE : ''}`, {
                id: TOAST_ID,
                duration: outcome.tone === 'info' ? 6000 : 12000
            });
            continueInBackground({ ...route, ...saved, property_hashes: hashes }, null);
            return run;
        }

        function buildAppliedUpdate(result, baseRoute, baseHashes, baseProperties = routeProperties) {
            const optimized = result.order;
            if (!optimized || optimized.length === 0) throw new Error('Optimization produced no results.');
            const optimizedHashes = optimized.map(propertyKey).filter(Boolean);
            const expectedHashes = new Set(hashes);
            if (
                optimizedHashes.length !== hashes.length
                || new Set(optimizedHashes).size !== expectedHashes.size
                || optimizedHashes.some(hash => !expectedHashes.has(hash))
            ) {
                throw new Error('Route integrity verification failed, so the existing route was left unchanged.');
            }
            const objective = result.objective;
            const appliedProperties = objective.applyCandidate ? optimized : baseProperties;
            const appliedHashes = appliedProperties.map(propertyKey).filter(Boolean);
            const hasWholeRouteDistance = Number.isFinite(objective.appliedDistance);
            const newDistanceRounded = hasWholeRouteDistance ? Math.round(objective.appliedDistance * 100) / 100
                : baseRoute.metrics?.distance ?? null;
            const existingMetadata = { ...(baseRoute.metadata || {}) };
            if (!shareSearchCoverage) delete existingMetadata.road_search_coverage;
            // The same verdict contract generation writes, so a route's provenance
            // means one thing regardless of which entry point last touched it.
            const routingMetadata = {
                ...result.routingMetadata,
                ...stampRoadVerification({}, hasWholeRouteDistance ? ROAD_VERIFICATION.ADOPTED : ROAD_VERIFICATION.PARTIAL, {
                    reason: hasWholeRouteDistance ? null : 'verified_neighborhoods_only',
                    measuredMiles: hasWholeRouteDistance ? newDistanceRounded : null
                }).metadata
            };
            if (!shareSearchCoverage) delete routingMetadata.road_search_coverage;
            const routeUpdate = usingCustomAnchors
                ? buildRouteAnchorsUpdate({
                    start,
                    end,
                    order: appliedHashes,
                    distanceMiles: newDistanceRounded,
                    existingMetrics: baseRoute.metrics,
                    existingMetadata,
                    routingMetadata
                })
                : buildRouteOptimizeUpdate({
                    optimizeMode,
                    order: appliedHashes,
                    distanceMiles: newDistanceRounded,
                    existingMetrics: baseRoute.metrics,
                    existingMetadata,
                    routingMetadata,
                    carCapture: carAnchor
                });
            if (usingPrivateAnchor) {
                routeUpdate.route_origin_mode = ROUTE_ORIGIN_MODES.PRIVATE_ANCHOR_ROUND_TRIP;
                routeUpdate.metadata.route_bounds = { enabled: true, mode: ROUTE_ORIGIN_MODES.PRIVATE_ANCHOR_ROUND_TRIP };
            } else {
                delete routeUpdate.metadata.anchor;
            }
            routeUpdate.metadata.last_optimization_attempt = buildRoadOptimizationAttempt(null, {
                routingMetadata: result.routingMetadata,
            }, { mode: optimizeMode, doorCount: routeProperties.length, applied: true });
            routeUpdate.metadata.last_optimization_attempt.stops_reordered = countChangedRouteStops(baseHashes, appliedHashes);
            if (!hasWholeRouteDistance) {
                // Preserve the prior estimate; independently checked local savings
                // cannot be subtracted from an unverified whole-trip total.
                routeUpdate.metrics = { ...(baseRoute.metrics || {}), house_count: appliedHashes.length };
            }
            return { routeUpdate, appliedProperties, appliedHashes, objective, hasWholeRouteDistance, newDistanceRounded };
        }
        const { routeUpdate, appliedProperties, appliedHashes, objective, hasWholeRouteDistance, newDistanceRounded }
            = buildAppliedUpdate(roadMatrixResult, route, hashes);
        const savedRoute = await persistOptimizedRoute({
            route, update: routeUpdate, properties: appliedProperties, client, queryClient, setActiveRoute,
            // Personal anchors belong only to the current map session.
            session,
        });
        // Restore the map view so fitBounds cannot zoom out on a reorder.
        if (savedView && mapRef?.current) { try { mapRef.current.setView(savedView.center, savedView.zoom, { animate: false }); } catch { /* map already gone */ } }
        const savedMiles = Math.round(objective.estimatedSavings * 100) / 100;
        const partialOutcome = roadMatrixResult && describeAppliedRoadOptimization(roadMatrixResult.routingMetadata);
        const changedStops = countChangedRouteStops(hashes, appliedHashes);
        const localReview = roadMatrixResult?.routingMetadata?.neighborhood_excursion_review?.local_driving_review;
        const base = usingCustomAnchors
            ? (routeOriginMode === ROUTE_ORIGIN_MODES.CUSTOM_BOUNDS
                ? 'Route anchors set. The door order was rebuilt around your start and finish.'
                : 'Route anchors cleared.')
            : changedStops > 0
                ? `${partialOutcome?.message || optimizeSuccessMessage(optimizeMode)} ${changedStops} stops reordered.`
                : 'The stop order is unchanged.';
        const estimateLabel = 'road-distance estimate';
        const savingsLabel = localReview?.validation === 'overlapping_boundary_legs'
            ? `Verified neighborhood savings: ~${savedMiles} mi` : `Saved ~${savedMiles} estimated miles`;
        const msg = !hasWholeRouteDistance
            ? `${base}${savedMiles > 0 ? ` Verified neighborhood savings: ~${savedMiles} mi.` : ''} Whole-route distance remains unverified.`
            : changedStops > 0 && objective.applyCandidate && savedMiles > 0
            ? `${base} ${savingsLabel} (${newDistanceRounded} mi ${estimateLabel}).`
            : `${base} (${newDistanceRounded} mi ${estimateLabel})`;
        toast[changedStops > 0 ? partialOutcome?.tone || 'success' : usingCustomAnchors ? 'success' : 'info'](
            `${msg}${firstPhase.more ? BACKGROUND_NOTE : ''}`,
            { id: TOAST_ID, duration: partialOutcome?.tone === 'warning' ? 12000 : 6000 }
        );
        continueInBackground(savedRoute, roadMatrixResult);
    } catch (e) {
        console.error('Re-optimize error:', e);
        toast.error(
            e?.message || 'Failed to re-optimize route. The existing route was left unchanged.',
            { id: TOAST_ID, duration: 6000 }
        );
    } finally {
        progress?.stop();
        if (!backgrounded) job?.finish();
    }
    return run;
}
