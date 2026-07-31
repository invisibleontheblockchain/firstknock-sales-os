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
    createRouteContinuityContext,
} from '@/components/logic/routeRoadContext';
import { haversineDistanceMiles, isValidRoutePoint } from '@/lib/routeBounds';
import { captureParkedCarLocation, isLowAccuracyCapture, lowAccuracyConfirmationMessage } from '@/lib/parkedCarLocation';
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
        let requestedHomeBase = routeBelongsToCurrentUser ? user?.home_base : null;
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
        const routingContext = createRouteContinuityContext(routeProperties);
        requireUsableRouteContext(routingContext);
        const optimized = optimizeRouteByStreetSweep(routeProperties, start, end, routingContext);
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
        const objective = compareRouteObjective({
            currentOrder: routeProperties,
            candidateOrder: optimized,
            start: isValidRoutePoint(start) ? start : null,
            end: isValidRoutePoint(end) ? end : null,
            distanceFn: (from, to) => haversineDistanceMiles(from, to)
        });
        const appliedProperties = objective.applyCandidate ? optimized : routeProperties;
        const appliedHashes = appliedProperties.map(propertyKey).filter(Boolean);
        const newDistanceRounded = Math.round(objective.appliedDistance * 100) / 100;
        const existingMetadata = { ...(route.metadata || {}) };
        const routingMetadata = buildPersistedRoadRoutingMetadata(routingContext, null, appliedHashes);
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
        const msg = objective.applyCandidate && savedMiles > 0
            ? `${base} Saved ~${savedMiles} estimated miles (${newDistanceRounded} mi street-continuity estimate).`
            : `${base} (${newDistanceRounded} mi street-continuity estimate)`;
        toast.success(msg, { id: TOAST_ID, duration: 4000 });
    } catch (e) {
        console.error('Re-optimize error:', e);
        toast.error(
            e?.message || 'Failed to re-optimize route. The existing route was left unchanged.',
            { id: TOAST_ID, duration: 6000 }
        );
    }
}