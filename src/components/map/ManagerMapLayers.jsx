import React, { useMemo, useEffect, useRef } from 'react';
import { CircleMarker, Polyline, Circle, LayerGroup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { DarkRoomClient } from '@/components/logic/neonClient';
import { CONFIDENCE_COLORS } from '@/components/map/ConfidenceLegend';
import CanvasZoneOverlay from './CanvasZoneOverlay';
import StateBoundariesLayer from './StateBoundariesLayer';
import { getCompletedPinColor } from '@/components/routes/routeRerunUtils';
import { isSoldDateInCustomOwnershipRange, normalizeOwnershipRangeDays } from '@/components/logic/soldDateRange';
import { routePropertyOrderFingerprint } from '@/components/logic/routeRoadContext';
import {
    filterRoutesByStatus,
    isRenderableMapPoint,
    shouldRenderPrecisionMapLayers,
} from './mapLayerVisibility.js';

/**
 * ActiveRouteLayer — High-performance active route renderer.
 * Uses a single native Leaflet layer group added imperatively instead of
 * hundreds of React-managed <CircleMarker> + <Tooltip permanent> combos.
 * This eliminates the ~15s delay when activating a route with many stops.
 */
const DEFAULT_ROUTE_COLORS = ['#FFD700', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316', '#ef4444', '#22c55e', '#3b82f6'];

const getRouteColor = (route, routeNumber = 1) => {
    if (route?.display_color) return route.display_color;
    return DEFAULT_ROUTE_COLORS[(Math.max(1, routeNumber) - 1) % DEFAULT_ROUTE_COLORS.length];
};

const getPersistedRoadGeometry = (route, properties) => {
    const geometry = route?.metadata?.road_geometry;
    if (!Array.isArray(geometry) || geometry.length < 2 || geometry.length > 12000) return null;
    const expectedFingerprint = route?.metadata?.routing?.property_order_fingerprint;
    const manifestFingerprint = routePropertyOrderFingerprint(
        route?.property_hashes?.length ? route.property_hashes : properties
    );
    const hydratedFingerprint = routePropertyOrderFingerprint(properties);
    if (
        !expectedFingerprint
        || manifestFingerprint !== expectedFingerprint
        || (Array.isArray(properties) && properties.length > 0 && hydratedFingerprint !== expectedFingerprint)
    ) return null;
    const points = geometry
        .map(point => ({
            lat: Number(point?.lat ?? point?.latitude),
            lng: Number(point?.lng ?? point?.lon ?? point?.longitude)
        }))
        .filter(isRenderableMapPoint);
    return points.length === geometry.length ? points : null;
};

const getRouteLinePoints = (route, properties) => {
    const roadGeometry = getPersistedRoadGeometry(route, properties);
    if (roadGeometry) return roadGeometry;
    const doors = (properties || []).filter(isRenderableMapPoint);
    const mode = route?.routeOriginMode || route?.route_origin_mode || route?.metadata?.route_bounds?.mode || 'none';
    if (!['home_round_trip', 'current_to_home'].includes(mode)) return doors;
    const start = route?.startLocation || route?.start_location;
    const end = route?.endLocation || route?.end_location;
    return [
        isRenderableMapPoint(start) ? start : null,
        ...doors,
        isRenderableMapPoint(end) ? end : null,
    ].filter(Boolean);
};

function ActiveRouteLayer({ activeRoute, BRAND, mapSettings, lineDashArray, setSelectedProperty }) {
    const map = useMap();
    const layerRef = useRef(null);
    const fittedRouteIdRef = useRef(null);

    useEffect(() => {
        if (!map || !activeRoute?.properties?.length) return;

        const routePoints = activeRoute.properties.filter(isRenderableMapPoint);
        const routeLinePoints = getRouteLinePoints(activeRoute, routePoints);
        if (routeLinePoints.length > 0 && fittedRouteIdRef.current !== activeRoute.id) {
            const bounds = L.latLngBounds(routeLinePoints.map(p => [Number(p.lat), Number(p.lng)]));
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16, animate: true });
            fittedRouteIdRef.current = activeRoute.id;
        }

        const routeColor = getRouteColor(activeRoute, activeRoute.route_number || 1);

        // Clean up previous layer
        if (layerRef.current) {
            map.removeLayer(layerRef.current);
            layerRef.current = null;
        }

        const group = L.layerGroup();
        const props = routePoints;

        // 1. Route line
        if (routeLinePoints.length > 1) {
            const line = L.polyline(
                routeLinePoints.map(p => [Number(p.lat), Number(p.lng)]),
                {
                    color: routeColor,
                    weight: mapSettings.lineWidth ? mapSettings.lineWidth + 2 : 4,
                    opacity: mapSettings.lineOpacity ? Math.max(0.6, mapSettings.lineOpacity) : 0.8,
                    dashArray: lineDashArray || null,
                }
            );
            group.addLayer(line);
        }

        // 2. Property pins with number labels (DivIcon — much lighter than Tooltip permanent)
        props.forEach((p, idx) => {
            const isFirst = idx === 0;
            const num = idx + 1;

            // Transparent hitbox for mobile tapping
            const point = [Number(p.lat), Number(p.lng)];
            const hitbox = L.circleMarker(point, {
                radius: 20,
                color: 'transparent',
                fillColor: 'transparent',
                interactive: true,
                stroke: false
            });
            hitbox.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                setSelectedProperty(p);
            });
            group.addLayer(hitbox);

            const completedColor = activeRoute.status === 'COMPLETED'
                ? getCompletedPinColor(p.effective_status, routeColor)
                : routeColor;

            // Circle pin (canvas-rendered, fast)
            const circle = L.circleMarker(point, {
                radius: activeRoute.status === 'COMPLETED' && (p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED') ? 7 : 5,
                fillColor: isFirst && activeRoute.status !== 'COMPLETED' ? '#22c55e' : completedColor,
                fillOpacity: 1,
                color: activeRoute.status === 'COMPLETED' && (p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED') ? '#ffffff' : '#fff',
                weight: activeRoute.status === 'COMPLETED' && (p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED') ? 2.5 : 1.5,
            });
            circle.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                setSelectedProperty(p);
            });
            group.addLayer(circle);

            // Number label (lightweight DivIcon marker)
            const label = L.marker(point, {
                icon: L.divIcon({
                    className: '',
                    html: `<div style="color:#fff;font-weight:bold;font-size:11px;text-shadow:0 1px 3px #000,0 0 5px #000;pointer-events:none;transform:translate(-50%,-100%);white-space:nowrap">${num}</div>`,
                    iconSize: [0, 0],
                    iconAnchor: [0, 6],
                }),
                interactive: false,
                keyboard: false,
            });
            group.addLayer(label);
        });

        group.addTo(map);
        layerRef.current = group;

        return () => {
            if (layerRef.current) {
                map.removeLayer(layerRef.current);
                layerRef.current = null;
            }
        };
    }, [map, activeRoute, mapSettings.lineWidth, mapSettings.lineOpacity, lineDashArray, setSelectedProperty]);

    return null; // Imperative layer — no React DOM output
}

/**
 * ViewportCulledPins — Performance-optimized property pin layer.
 * Only renders pins within the current map viewport + a small buffer,
 * and caps the maximum rendered pins to prevent browser lag.
 */
function ViewportCulledPins({
    viewMode, zoomLevel, activeRoute, mode, showAllProperties,
    effectiveProperties, assignedHashes, zipCodeFilter, drawnPolygon,
    soldDateFilter, ownershipRangeDays, ownershipRangeReferenceDate, quickFilter, highlightRecentlySold, pinSize,
    mapSettings, STATUS_COLORS, setSelectedProperty, isPointInPolygon,
    subMonths, mapRef
}) {
    const map = useMap();
    const [viewBounds, setViewBounds] = React.useState(null);

    // Listen for map move/zoom to update visible pins safely deferring heavy math
    React.useEffect(() => {
        let timeoutId = null;

        const updateBounds = () => {
            const b = map.getBounds();
            setViewBounds({
                north: b.getNorth(), south: b.getSouth(),
                east: b.getEast(), west: b.getWest()
            });
        };

        const debouncedUpdate = () => {
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                updateBounds();
            }, 150);
        };

        updateBounds(); // initial
        
        map.on('moveend', debouncedUpdate);
        map.on('zoomend', debouncedUpdate);
        
        return () => {
            if (timeoutId) clearTimeout(timeoutId);
            map.off('moveend', debouncedUpdate);
            map.off('zoomend', debouncedUpdate);
        };
    }, [map]);

    const MAX_VISIBLE_PINS = 5000;

    const visiblePins = useMemo(() => {
        if (!viewBounds) return [];
        if (viewMode !== 'pins' || zoomLevel < 13 || activeRoute || !(mode === 'generate' || showAllProperties)) {
            return [];
        }

        const latBuffer = (viewBounds.north - viewBounds.south) * 0.15;
        const lngBuffer = (viewBounds.east - viewBounds.west) * 0.15;
        const north = viewBounds.north + latBuffer;
        const south = viewBounds.south - latBuffer;
        const east = viewBounds.east + lngBuffer;
        const west = viewBounds.west - lngBuffer;

        let filtered = [];
        const targetZips = (mode === 'generate' && zipCodeFilter && zipCodeFilter.trim())
            ? zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean)
            : [];
        const customOwnershipRange = mode === 'generate'
            ? normalizeOwnershipRangeDays(ownershipRangeDays)
            : null;
        const cutoff = soldDateFilter !== null ? subMonths(new Date(), parseInt(soldDateFilter)) : null;

        for (let i = 0; i < effectiveProperties.length; i++) {
            if (filtered.length >= MAX_VISIBLE_PINS) break;

            const p = effectiveProperties[i];
            if (p.is_dark_room) continue;

            // Viewport culling
            if (p.lat < south || p.lat > north || p.lng < west || p.lng > east) continue;

            if (mode === 'generate' && assignedHashes.has(p.address_hash)) continue;
            if (targetZips.length > 0) {
                const pZip = String(p.zip_code || '').trim().slice(0, 5);
                if (!targetZips.includes(pZip)) continue;
            }
            if (mode === 'generate' && drawnPolygon && drawnPolygon.length > 2) {
                if (!isPointInPolygon({ lat: p.lat, lng: p.lng }, drawnPolygon)) continue;
            }
            if (customOwnershipRange) {
                if (!isSoldDateInCustomOwnershipRange(
                    p.sold_date,
                    customOwnershipRange,
                    ownershipRangeReferenceDate || Date.now()
                )) continue;
            } else if (cutoff !== null) {
                const hasInteraction = ['CALLBACK', 'NO_ANSWER', 'QUALIFIED', 'SOLD'].includes(p.effective_status);
                if (!p.sold_date) { if (!hasInteraction) continue; }
                else {
                    const date = new Date(p.sold_date);
                    if (isNaN(date.getTime())) { if (!hasInteraction) continue; }
                    else if (date < cutoff) continue; // Exclude only if sold BEFORE cutoff
                }
            }
            if (quickFilter !== 'all') {
                if (quickFilter === 'eligible' && p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'NO_ANSWER') continue;
                if (quickFilter === 'sold' && p.effective_status !== 'SOLD' && p.effective_status !== 'QUALIFIED') continue;
                if (quickFilter === 'rejected' && p.effective_status !== 'HARD_NO') continue;
            }
            filtered.push(p);
        }
        return filtered;
    }, [viewBounds, viewMode, zoomLevel, activeRoute, mode, showAllProperties, effectiveProperties,
        assignedHashes, zipCodeFilter, drawnPolygon, soldDateFilter, ownershipRangeDays, ownershipRangeReferenceDate, quickFilter, subMonths, isPointInPolygon]);

    const oneMonthAgo = useMemo(() => subMonths(new Date(), 1), [subMonths]);
    const fastPinsMap = useMap();
    const layerRef = useRef(null);

    useEffect(() => {
        if (!fastPinsMap) return;

        // Clean up previous layer
        if (layerRef.current) {
            fastPinsMap.removeLayer(layerRef.current);
            layerRef.current = null;
        }

        if (visiblePins.length === 0) return;

        const group = L.layerGroup();

        visiblePins.forEach(p => {
            let isRecentlySold = false;
            if (highlightRecentlySold && p.sold_date) {
                isRecentlySold = new Date(p.sold_date) > oneMonthAgo;
            }
            const isUnvisited = ['ELIGIBLE', 'NO_ANSWER', 'OTHER'].includes(p.effective_status);
            let effectiveColorStatus = p.effective_status;
            if (p.effective_status === 'ELIGIBLE' && p.original_status) {
                if (p.original_status === 'SOLD' || p.original_status === 'RECENT_OFF_MARKET' || p.original_status === 'PENDING') {
                    effectiveColorStatus = p.original_status;
                }
            }
            // Fix #5: Confidence-tier coloring when 'confidence' color scheme is active
            const useConfidenceColors = mapSettings.colorScheme === 'confidence';
            let fillColor;
            if (isRecentlySold) {
                fillColor = '#FF00FF';
            } else if (useConfidenceColors && p.sale_confidence && CONFIDENCE_COLORS[p.sale_confidence]) {
                fillColor = CONFIDENCE_COLORS[p.sale_confidence];
            } else {
                fillColor = STATUS_COLORS[effectiveColorStatus] || STATUS_COLORS.OTHER;
            }
            
            // Transparent hitbox for mobile tapping
            const hitbox = L.circleMarker([p.lat, p.lng], {
                radius: 20,
                color: 'transparent',
                fillColor: 'transparent',
                interactive: true,
                stroke: false
            });
            hitbox.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                setSelectedProperty(p);
            });
            group.addLayer(hitbox);

            // Confidence ring: subtle outer glow for verified/high leads in any color scheme
            const conf = p.sale_confidence;
            const showConfRing = !useConfidenceColors && !isRecentlySold && !isUnvisited && conf && (conf === 'high' || conf === 'verified');
            if (showConfRing) {
                const ringColor = CONFIDENCE_COLORS[conf];
                const ring = L.circleMarker([p.lat, p.lng], {
                    radius: pinSize + 3,
                    fillColor: 'transparent',
                    fillOpacity: 0,
                    color: ringColor,
                    weight: 1.5,
                    opacity: 0.6,
                });
                group.addLayer(ring);
            }

            // Visible pin
            const circle = L.circleMarker([p.lat, p.lng], {
                radius: isRecentlySold ? pinSize + 4 : (isUnvisited ? Math.max(2, pinSize - 2) : pinSize),
                fillColor,
                fillOpacity: isRecentlySold ? 1 : (isUnvisited ? 0.3 : ((mode === 'generate' ? 0.9 : 0.5) * mapSettings.pinOpacity)),
                color: isRecentlySold ? '#FFFFFF' : (mapSettings.fillStyle === 'outline' ? fillColor : (isUnvisited ? 'transparent' : (mapSettings.pinBorderColor || '#000'))),
                weight: isRecentlySold ? 2 : (mapSettings.fillStyle === 'outline' ? 2 : (isUnvisited ? 0 : mapSettings.pinBorderWidth))
            });
            circle.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                setSelectedProperty(p);
            });
            group.addLayer(circle);
        });

        group.addTo(fastPinsMap);
        layerRef.current = group;

        return () => {
            if (layerRef.current) {
                fastPinsMap.removeLayer(layerRef.current);
                layerRef.current = null;
            }
        };
    }, [fastPinsMap, visiblePins, highlightRecentlySold, oneMonthAgo, STATUS_COLORS, pinSize, mapSettings, mode, setSelectedProperty]);

    return null; // Imperative layer — no React DOM output
}

/**
 * SavedRoutesLayer — Imperative saved routes renderer.
 * Replaces thousands of React-managed <CircleMarker> elements
 * with native Leaflet layers for dramatically better performance.
 */
function SavedRoutesLayer({
    mode, activeRoute, zoomLevel, hydratedSavedRoutes,
    analyzeZipFilter, quickFilter, repColors, ROUTE_COLORS,
    showRouteDetails, showRouteLines, routeStatusView, pinSize, mapSettings,
    lineDashArray, setActiveRoute, allSavedRoutes
}) {
    const map = useMap();
    const layerRef = useRef(null);

    useEffect(() => {
        if (!map) return;

        // Clean up previous layer
        if (layerRef.current) {
            map.removeLayer(layerRef.current);
            layerRef.current = null;
        }

        // Only show saved route overlays in Routes mode. Builder/draw mode stays visually clean,
        // while selecting an individual route still shows it through ActiveRouteLayer.
        const activeRouteHasMapPoints = activeRoute?.properties?.some(isRenderableMapPoint);
        if (activeRouteHasMapPoints || mode !== 'analyze' || zoomLevel < 8) return;

        const group = L.layerGroup();

        const filteredRoutes = filterRoutesByStatus(hydratedSavedRoutes, routeStatusView).filter(route => {
            if (mode === 'generate') return true;
            if (analyzeZipFilter === 'all') return true;
            return route.properties.some(p => p.zip_code === analyzeZipFilter);
        });

        // Build a global route number map from the full unfiltered list for consistent numbering
        const routeNumberMap = new Map();
        (allSavedRoutes || hydratedSavedRoutes).forEach((r, i) => routeNumberMap.set(r.id, i + 1));

        filteredRoutes.forEach((route, routeIdx) => {
            const globalNumber = routeNumberMap.get(route.id) || (routeIdx + 1);
            const repColor = getRouteColor(route, globalNumber);
            const isUnassigned = !route.assigned_to;
            const centerProp = route.properties[Math.floor(route.properties.length / 2)];

            // Center marker with route number
            if (isRenderableMapPoint(centerProp)) {
                const centerPoint = [Number(centerProp.lat), Number(centerProp.lng)];
                const centerCircle = L.circleMarker(centerPoint, {
                    radius: 14, fillColor: 'black', fillOpacity: 0.7, color: repColor, weight: 2
                });
                centerCircle.on('click', (e) => { L.DomEvent.stopPropagation(e); setActiveRoute({ ...route, route_number: globalNumber, display_color: repColor }); });
                group.addLayer(centerCircle);

                const label = L.marker(centerPoint, {
                    icon: L.divIcon({
                        className: '',
                        html: `<div style="color:${repColor};font-weight:900;font-size:10px;text-shadow:0 0 3px #000;pointer-events:none;transform:translate(-50%,-50%);white-space:nowrap">#${globalNumber}</div>`,
                        iconSize: [0, 0], iconAnchor: [0, 0],
                    }),
                    interactive: false, keyboard: false,
                });
                group.addLayer(label);
            }

            // Detail pins
            if (showRouteDetails) {
                route.properties.forEach(p => {
                    if (!isRenderableMapPoint(p)) return;
                    if (quickFilter !== 'all') {
                        if (quickFilter === 'eligible' && p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'NO_ANSWER') return;
                        if (quickFilter === 'sold' && p.effective_status !== 'SOLD' && p.effective_status !== 'QUALIFIED') return;
                        if (quickFilter === 'rejected' && p.effective_status !== 'HARD_NO') return;
                    }

                    // Transparent hitbox for tapping
                    const point = [Number(p.lat), Number(p.lng)];
                    const hitbox = L.circleMarker(point, {
                        radius: 20, color: 'transparent', fillColor: 'transparent', interactive: true, stroke: false
                    });
                    hitbox.on('click', (e) => { L.DomEvent.stopPropagation(e); setActiveRoute({ ...route, route_number: globalNumber, display_color: repColor }); });
                    group.addLayer(hitbox);

                    // Visible pin
                    const circle = L.circleMarker(point, {
                        radius: pinSize,
                        fillColor: repColor,
                        fillOpacity: (isUnassigned ? 0.6 : 0.8) * (mapSettings.pinOpacity || 1),
                        color: mapSettings.fillStyle === 'outline' ? repColor : (mapSettings.pinBorderColor || '#000'),
                        weight: mapSettings.fillStyle === 'outline' ? 2 : (mapSettings.pinBorderWidth || 1)
                    });
                    circle.on('click', (e) => { L.DomEvent.stopPropagation(e); setActiveRoute({ ...route, route_number: globalNumber, display_color: repColor }); });
                    group.addLayer(circle);

                    // Labels (optional)
                    if (mapSettings.showLabels) {
                        const labelText = mapSettings.labelType === 'number' ? p.house_number
                            : mapSettings.labelType === 'status' ? (p.effective_status || '').slice(0, 1)
                            : (p.street_name || '').split(' ')[0];
                        const pinLabel = L.marker(point, {
                            icon: L.divIcon({
                                className: '',
                                html: `<div style="color:#fff;font-weight:bold;font-size:8px;text-shadow:0 0 3px #000;pointer-events:none;transform:translate(-50%,-50%);white-space:nowrap">${labelText}</div>`,
                                iconSize: [0, 0], iconAnchor: [0, 0],
                            }),
                            interactive: false, keyboard: false,
                        });
                        group.addLayer(pinLabel);
                    }
                });
            }

            // Route line
            const routeLinePoints = getRouteLinePoints(route, route.properties);
            if (showRouteLines && routeLinePoints.length > 1) {
                const line = L.polyline(
                    routeLinePoints.map(p => [Number(p.lat), Number(p.lng)]),
                    {
                        color: repColor,
                        weight: mapSettings.lineWidth || 3,
                        opacity: mapSettings.lineOpacity || 0.7,
                        dashArray: lineDashArray || null
                    }
                );
                group.addLayer(line);
            }
        });

        group.addTo(map);
        layerRef.current = group;

        return () => {
            if (layerRef.current) {
                map.removeLayer(layerRef.current);
                layerRef.current = null;
            }
        };
    }, [map, mode, activeRoute, zoomLevel, hydratedSavedRoutes, analyzeZipFilter, quickFilter,
        routeStatusView, repColors, ROUTE_COLORS, showRouteDetails, showRouteLines, pinSize, mapSettings, lineDashArray, setActiveRoute, allSavedRoutes]);

    return null; // Imperative layer — no React DOM output
}

/**
 * ManagerMapLayers — extracted from Home.jsx
 * Renders all the map data layers: saved routes, generated routes, heatmap,
 * dark room clusters/pins, user property pins, active route, preview route.
 */
const ManagerMapLayers = React.memo(function ManagerMapLayers({
    // Mode & state
    mode,
    routeMode = 'precision',
    canvasZonePreview,
    activeRoute,
    zoomLevel,
    viewMode,

    // Route data
    hydratedSavedRoutes,
    allSavedRoutes,
    filteredRoutes,
    ROUTE_COLORS,

    // Property data
    effectiveProperties,
    darkRoomProperties,
    darkRoomClusters,
    heatmapData,
    previewRoute,

    // Filters
    analyzeZipFilter,
    quickFilter,
    zipCodeFilter,
    soldDateFilter,
    ownershipRangeDays,
    ownershipRangeReferenceDate,
    drawnPolygon,
    assignedHashes,
    showAllProperties,
    showRouteDetails,
    showRouteLines,
    routeStatusView,
    highlightRecentlySold,

    // Map settings
    mapSettings,
    pinSize,
    lineDashArray,
    STATUS_COLORS,
    repColors,
    BRAND,

    // Handlers
    setActiveRoute,
    setSelectedProperty,
    mapRef,

    // Helpers
    isPointInPolygon,
    getHeatColor,

    // Date utils
    parseISO,
    subMonths,
    isAfter,

    // darkRoom instance
    darkRoom,
}) {
    const renderPrecisionLayers = shouldRenderPrecisionMapLayers({ mode, routeMode, activeRoute });

    return (
        <>
            <StateBoundariesLayer zoomLevel={zoomLevel} />
            <CanvasZoneOverlay routeMode={routeMode} preview={canvasZonePreview} />

            {renderPrecisionLayers && <>
            {/* --- Existing Routes (Imperative for performance) --- */}
            <SavedRoutesLayer
                mode={mode}
                activeRoute={activeRoute}
                zoomLevel={zoomLevel}
                hydratedSavedRoutes={hydratedSavedRoutes}
                allSavedRoutes={allSavedRoutes}
                analyzeZipFilter={analyzeZipFilter}
                quickFilter={quickFilter}
                repColors={repColors}
                ROUTE_COLORS={ROUTE_COLORS}
                showRouteDetails={showRouteDetails}
                showRouteLines={showRouteLines}
                routeStatusView={routeStatusView}
                pinSize={pinSize}
                mapSettings={mapSettings}
                lineDashArray={lineDashArray}
                setActiveRoute={setActiveRoute}
            />

            {/* Builder mode stays clean: generated route overviews are hidden until a specific route is selected. */}

            {/* HEATMAP LAYER (Only at Zoom >= 10) */}
            {viewMode === 'heatmap' && zoomLevel >= 10 && heatmapData.map(cell => (
                <Circle
                    key={cell.id}
                    center={[cell.lat, cell.lng]}
                    radius={200}
                    pathOptions={{
                        fillColor: getHeatColor(cell.avgScore),
                        fillOpacity: 0.5 + (cell.intensity * 0.3),
                        color: 'transparent',
                        weight: 0
                    }}
                />
            ))}

            {/* DARK ROOM CLUSTER LAYER (Very Low Zoom Only) */}
            <LayerGroup>
                {zoomLevel < 10 && darkRoomClusters.map(cluster => (
                    <CircleMarker
                        key={cluster.id}
                        center={[cluster.lat, cluster.lng]}
                        radius={Math.min(25, 8 + Math.sqrt(cluster.count) * 2)}
                        eventHandlers={{
                            click: () => {
                                if (mapRef.current) {
                                    try { if (mapRef.current._mapPane) mapRef.current.setView([cluster.lat, cluster.lng], Math.min(zoomLevel + 3, 16)); } catch (e) { }
                                }
                            }
                        }}
                        pathOptions={{
                            fillColor: DarkRoomClient.getScoreColor(cluster.avgScore),
                            fillOpacity: 0.7,
                            color: '#000',
                            weight: 2
                        }}
                    >
                        <Tooltip permanent direction="center" className="route-number-tooltip">
                            <span style={{ color: '#fff', fontWeight: 'bold', fontSize: '10px', textShadow: '0 0 3px #000' }}>
                                {cluster.count}
                            </span>
                        </Tooltip>
                    </CircleMarker>
                ))}
            </LayerGroup>

            {/* DARK ROOM INDIVIDUAL PINS (Zoom 10+) */}
            <LayerGroup>
                {zoomLevel >= 10 && darkRoomProperties.map(p => (
                    <CircleMarker
                        key={p.id}
                        center={[p.lat, p.lng]}
                        radius={5}
                        eventHandlers={{
                            click: async (e) => {
                                L.DomEvent.stopPropagation(e);
                                const details = await darkRoom.fetchPropertyDetails(p.id);
                                setSelectedProperty(details || p);
                            }
                        }}
                        pathOptions={{
                            fillColor: DarkRoomClient.getScoreColor(p.smart_score),
                            fillOpacity: 0.85,
                            color: '#000',
                            weight: 1
                        }}
                    />
                ))}
            </LayerGroup>

            {/* USER PROPERTIES PIN LAYER */}
            <ViewportCulledPins
                viewMode={viewMode}
                zoomLevel={zoomLevel}
                activeRoute={activeRoute}
                mode={mode}
                showAllProperties={showAllProperties}
                effectiveProperties={effectiveProperties}
                assignedHashes={assignedHashes}
                zipCodeFilter={zipCodeFilter}
                drawnPolygon={drawnPolygon}
                soldDateFilter={soldDateFilter}
                ownershipRangeDays={ownershipRangeDays}
                ownershipRangeReferenceDate={ownershipRangeReferenceDate}
                quickFilter={quickFilter}
                highlightRecentlySold={highlightRecentlySold}
                pinSize={pinSize}
                mapSettings={mapSettings}
                STATUS_COLORS={STATUS_COLORS}
                setSelectedProperty={setSelectedProperty}
                isPointInPolygon={isPointInPolygon}
                subMonths={subMonths}
                mapRef={mapRef}
            />

            {/* Preview Route (hover/tap from list) */}
            {previewRoute && !activeRoute && (
                <Polyline
                    positions={getRouteLinePoints(previewRoute, previewRoute.properties)
                        .map(p => [Number(p.lat), Number(p.lng)])}
                    pathOptions={{ color: BRAND.gold, weight: 3, opacity: 0.6, dashArray: '5,10' }}
                />
            )}

            {/* Active Route - Mail Carrier Style (Canvas-optimized) */}
            {activeRoute && (
                <ActiveRouteLayer
                    activeRoute={activeRoute}
                    BRAND={BRAND}
                    mapSettings={mapSettings}
                    lineDashArray={lineDashArray}
                    setSelectedProperty={setSelectedProperty}
                />
            )}
            </>}
        </>
    );
});

export default ManagerMapLayers;