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
import { optimizeRouteByStreetSweep } from '@/components/logic/routeOptimizer';
import {
    buildPersistedRoadRoutingMetadata,
    createRouteRoadContext,
} from '@/components/logic/routeRoadContext';
import { haversineDistanceMiles, isValidRoutePoint } from '@/lib/routeBounds';
import { captureParkedCarLocation, isLowAccuracyCapture, lowAccuracyConfirmationMessage } from '@/lib/parkedCarLocation';
import { startOptimizeProgress } from '@/lib/optimizeProgressToast';
import { tryRoadMatrixOptimize } from '@/lib/roadMatrixOptimize';
import { ROAD_VERIFICATION, stampRoadVerification } from '@/lib/routeRoadVerification';
import { requireUsableRouteContext } from '@/lib/routeContextGuard';
import { OPTIMIZE_MODES, ROUTE_ORIGIN_MODES, resolveOptimizeMode, routeOriginModeForOptimizeMode } from '@/lib/routeOriginModes';
import {
    buildRouteAnchorsUpdate,
    buildRouteOptimizeUpdate,
    compareRouteObjective,
    normalizeRouteAnchor,
    optimizeSuccessMessage,
    routeBelongsToActingUser,
} from '@/lib/routeOptimizeUpdate';

const TOAST_ID = 'reoptimize-route';

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
        activeRoute,
        setActiveRoute,
        confirmLowAccuracyLocation = () => true,
    } = deps;

    // Explicit mode. The legacy { fromHome: true } shape still resolves, but every
    // call from the Optimize control names its mode, because the anchor is part of
    // the resulting order and inferring it was what made the old button unpredictable.
    const optimizeMode = resolveOptimizeMode(options);
    const optimizeFromHome = optimizeMode === OPTIMIZE_MODES.HOME_ROUND_TRIP;
    const optimizeFromCar = optimizeMode === OPTIMIZE_MODES.CAR_ROUND_TRIP;
    const usingCustomAnchors = Object.prototype.hasOwnProperty.call(options, 'anchors');
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
    try {
        const hashes = (route.property_hashes || (route.properties || []).map(propertyKey)).filter(Boolean);
        const routePropsByHash = new Map((route.properties || route.allProperties || []).map(p => [propertyKey(p), p]));
        const effectivePropsByHash = new Map(effectiveProperties.map(p => [propertyKey(p), p]));
        const routeProperties = hashes.map(hash => effectivePropsByHash.get(hash) || routePropsByHash.get(hash)).filter(Boolean);
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
                const response = await base44.functions.invoke('getRouteHomeBase', { route_id: route.id });
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

        // route_only means EXACTLY the doors: no map centre, no current GPS, no Home
        // Base, no stale saved bound. This path once fell back to the map centre,
        // silently anchoring the route to wherever the user happened to be looking.
        const start = optimizeFromCar ? carAnchor
            : optimizeFromHome ? requestedHomeBase
            : usingCustomAnchors ? normalizeRouteAnchor(customAnchors?.start)
            : null;
        const end = optimizeFromCar ? carAnchor
            : optimizeFromHome ? requestedHomeBase
            : usingCustomAnchors ? normalizeRouteAnchor(customAnchors?.end)
            : null;
        const routeOriginMode = usingCustomAnchors
            ? (start || end ? ROUTE_ORIGIN_MODES.CUSTOM_BOUNDS : ROUTE_ORIGIN_MODES.NONE)
            : routeOriginModeForOptimizeMode(optimizeMode);
        // Optimize is an explicit, user-initiated action, so unlike route
        // GENERATION it can afford to load the real street network and order the
        // doors by actual driving distance. createRouteRoadContext degrades to the
        // synchronous continuity context on every failure path (point limits, no
        // routable roads, network unavailable), so a slow or offline road service
        // still produces exactly today's route rather than an error.
        // OSRM ROAD-MATRIX BETA: try the backend optimizer first. It fetches a
        // real driving-distance matrix, prices BOTH today's continuity order and
        // a road-aware street sweep with that same matrix, and only returns a
        // result when the road-aware order beats the route's current order.
        // Every failure mode (timeout, rate limit, unsnapped door, a route beyond
        // the supported size, no improvement) returns null and the existing local
        // path runs instead.
        progress = startOptimizeProgress({
            id: TOAST_ID,
            label: `Checking real road distances for ${routeProperties.length} doors...`
        });
        // Why the road pass declined decides what the saved route may claim about
        // itself. "The road engine measured your order and found nothing better"
        // is a verification; "the road engine was unreachable" is not, and the two
        // used to be the same anonymous null.
        let roadDeclineReason = null;
        const roadMatrixResult = await tryRoadMatrixOptimize(routeProperties, {
            start: isValidRoutePoint(start) ? start : null,
            end: isValidRoutePoint(end) ? end : null,
            onOutcome: (reason) => { roadDeclineReason = reason; }
        });

        // A route whose saved order was already validated on a real road matrix
        // must not be re-ordered by the straight-line fallback: that is exactly how
        // Anderson's 449-minute route was replaced by a 454.6-minute one. Either the
        // road pipeline found something faster, or this route stays as it is.
        // ...but only when the ANCHORS are unchanged. Choosing HOME on a route
        // previously optimized without a start/finish used to stop here and
        // report "already optimized", so the requested Home anchor was never
        // applied and nothing moved on screen.
        const savedRoadRouting = route.metadata?.routing;
        const anchorModeUnchanged = (route.route_origin_mode || ROUTE_ORIGIN_MODES.NONE) === routeOriginMode;
        if (!roadMatrixResult
            && !usingCustomAnchors
            && anchorModeUnchanged
            && savedRoadRouting?.road_aware === true
            && savedRoadRouting?.fallback !== true) {
            toast.success('Already optimized on real road distances — no faster order found.', {
                id: TOAST_ID,
                duration: 4000
            });
            return;
        }

        let routingContext = null;
        let roadAware = true;
        let optimized;
        if (roadMatrixResult) {
            optimized = roadMatrixResult.order;
        } else {
            progress.update('Loading road distances...');
            routingContext = await createRouteRoadContext(routeProperties, {
                startLocation: isValidRoutePoint(start) ? start : null,
                endLocation: isValidRoutePoint(end) ? end : null,
            });
            requireUsableRouteContext(routingContext);
            // Cost-only mode prices street blocks by a single representative door, so
            // only full mode can measure a whole door order.
            roadAware = routingContext.roadAware === true
                && routingContext.costOnly !== true
                && typeof routingContext.distanceBetween === 'function';
            // This local sweep is synchronous and blocks the main thread, so the
            // ticker cannot repaint during it. Yield one frame first, otherwise the
            // last message the user sees is whatever was on screen before it began.
            progress.update('Building the best door order...');
            await new Promise(resolve => requestAnimationFrame(() => resolve()));
            optimized = optimizeRouteByStreetSweep(routeProperties, start, end, routingContext);
        }
        if (!optimized || optimized.length === 0) { toast.error('Optimization produced no results.', { id: TOAST_ID }); return; }
        const optimizedHashes = optimized.map(propertyKey).filter(Boolean);
        const expectedHashes = new Set(hashes);
        if (
            optimizedHashes.length !== hashes.length
            || new Set(optimizedHashes).size !== expectedHashes.size
            || optimizedHashes.some(hash => !expectedHashes.has(hash))
        ) {
            throw new Error('Route integrity verification failed, so the existing route was left unchanged.');
        }
        // Compare the CURRENT order against the CANDIDATE order under the SAME
        // anchors. Comparing a stored metric from a previous mode would report the
        // gap between two anchors as optimizer savings.
        const objective = roadMatrixResult ? roadMatrixResult.objective : compareRouteObjective({
            currentOrder: routeProperties,
            candidateOrder: optimized,
            start: isValidRoutePoint(start) ? start : null,
            end: isValidRoutePoint(end) ? end : null,
            // Both sides must be measured with the objective the order was built
            // for. Judging a road-aware order by straight-line distance can reject
            // a genuinely shorter drive, which would silently discard the gain.
            distanceFn: roadAware
                ? (from, to) => routingContext.distanceBetween(from, to)
                : (from, to) => haversineDistanceMiles(from, to)
        });
        const appliedProperties = objective.applyCandidate ? optimized : routeProperties;
        const appliedHashes = appliedProperties.map(propertyKey).filter(Boolean);
        const newDistanceRounded = Math.round(objective.appliedDistance * 100) / 100;
        const existingMetadata = { ...(route.metadata || {}) };
        // The same verdict contract generation writes, so a route's provenance
        // means one thing regardless of which entry point last touched it.
        const verificationVerdict = roadMatrixResult
            ? ROAD_VERIFICATION.ADOPTED
            : roadDeclineReason === 'current_order_measured_best'
                ? ROAD_VERIFICATION.CONFIRMED
                : ROAD_VERIFICATION.LOCAL_FALLBACK;
        const routingMetadata = {
            ...(roadMatrixResult
                ? roadMatrixResult.routingMetadata
                : buildPersistedRoadRoutingMetadata(routingContext, null, appliedHashes)),
            ...stampRoadVerification({}, verificationVerdict, {
                reason: roadMatrixResult ? null : roadDeclineReason,
                measuredMiles: newDistanceRounded
            }).metadata
        };
        const routeUpdate = usingCustomAnchors
            ? buildRouteAnchorsUpdate({
                start,
                end,
                order: appliedHashes,
                distanceMiles: newDistanceRounded,
                existingMetrics: route.metrics,
                existingMetadata,
                routingMetadata
            })
            : buildRouteOptimizeUpdate({
                optimizeMode,
                order: appliedHashes,
                distanceMiles: newDistanceRounded,
                existingMetrics: route.metrics,
                existingMetadata,
                routingMetadata,
                carCapture: carAnchor
            });
        await base44.entities.SavedRoute.update(route.id, routeUpdate);
        queryClient?.invalidateQueries({ queryKey: ['savedRoutes'] });
        if (activeRoute && activeRoute.id === route.id && setActiveRoute) {
            setActiveRoute(prev => ({
                ...prev,
                ...routeUpdate,
                // For the Optimize modes the exact anchor lives in SESSION state only;
                // SavedRoute must not carry a personal home/current coordinate.
                startLocation: routeOriginMode !== ROUTE_ORIGIN_MODES.NONE ? start : null,
                endLocation: routeOriginMode !== ROUTE_ORIGIN_MODES.NONE ? end : null,
                routeOriginMode,
                property_hashes: appliedHashes,
                properties: appliedProperties,
                allProperties: appliedProperties,
                houseCount: appliedProperties.length,
                totalDistance: newDistanceRounded,
                metrics: { ...prev?.metrics, distance: newDistanceRounded, house_count: appliedProperties.length }
            }));
        }
        // Restore the map view so fitBounds cannot zoom out on a reorder.
        if (savedView && mapRef?.current) { try { mapRef.current.setView(savedView.center, savedView.zoom, { animate: false }); } catch { /* map already gone */ } }
        const savedMiles = Math.round(objective.estimatedSavings * 100) / 100;
        const base = usingCustomAnchors
            ? (routeOriginMode === ROUTE_ORIGIN_MODES.CUSTOM_BOUNDS
                ? 'Route anchors set. The door order was rebuilt around your start and finish.'
                : 'Route anchors cleared.')
            : optimizeSuccessMessage(optimizeMode, { alreadyOptimal: !objective.applyCandidate });
        const estimateLabel = roadAware ? 'road-distance estimate' : 'street-continuity estimate';
        const msg = objective.applyCandidate && savedMiles > 0
            ? `${base} Saved ~${savedMiles} estimated miles (${newDistanceRounded} mi ${estimateLabel}).`
            : `${base} (${newDistanceRounded} mi ${estimateLabel})`;
        toast.success(msg, { id: TOAST_ID, duration: 4000 });
    } catch (e) {
        console.error('Re-optimize error:', e);
        toast.error(
            e?.message || 'Failed to re-optimize route. The existing route was left unchanged.',
            { id: TOAST_ID, duration: 6000 }
        );
    } finally {
        progress?.stop();
    }
}