import React, { useMemo, useEffect, useRef } from 'react';
import { CircleMarker, Polyline, Circle, LayerGroup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { DarkRoomClient } from '@/components/logic/neonClient';
import CanvasZoneOverlay from './CanvasZoneOverlay';
import StateBoundariesLayer from './StateBoundariesLayer';
import { getCompletedPinColor } from '@/components/routes/routeRerunUtils';
import { isSoldDateInCustomOwnershipRange, normalizeOwnershipRangeDays } from '@/components/logic/soldDateRange';
import { routePropertyOrderFingerprint } from '@/components/logic/routeRoadContext';
import { verifiedBetaSegments } from '@/lib/roadAwareRouteGeometry';
import { resolvePinSize, zoomAdjustedPinSize } from './densePinSize';
import { buildPinStyle, pinKey, pinPropertyStyleKey, pinStyleContextKey } from './pinStyle';
import { buildSavedRouteGroup, savedRouteStyleKey } from './savedRouteLayer';
import { createLabelCanvas } from './labelCanvas';
import { reconcileMapPins } from './reconcileMapPins';
import { outcomeColor } from '@/components/logic/outcomeStatus';
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
// Green is reserved for confirmed sales, so no route is assigned a green color.
const DEFAULT_ROUTE_COLORS = ['#FFD700', '#ec4899', '#a855f7', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316', '#ef4444', '#e11d48', '#3b82f6'];

const isConfirmedSale = (property) => property?.effective_status === 'SOLD';

// Route styling only changes at these zoom boundaries. Quantizing keeps a
// pinch-zoom from rebuilding every stop on each intermediate level.
// A 16 band is required, not cosmetic: without it a zoom of 16 quantized down to
// 15, so any threshold written as `zoom >= 16` never fired until 17 and numbers
// appeared a full step later than intended.
const zoomStyleBand = (z) => (z >= 17 ? 17 : z >= 16 ? 16 : z >= 15 ? 15 : z >= 14 ? 14 : z >= 13 ? 13 : 12);

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
    if (route?.metadata?.routing?.road_aware_routing_beta) return [];
    const roadGeometry = getPersistedRoadGeometry(route, properties);
    if (roadGeometry) return roadGeometry;
    const doors = (properties || []).filter(isRenderableMapPoint);
    const mode = route?.routeOriginMode || route?.route_origin_mode || route?.metadata?.route_bounds?.mode || 'none';
    if (!['home_round_trip', 'current_to_home', 'anchor_round_trip'].includes(mode)) return doors;
    const start = route?.startLocation || route?.start_location;
    const end = route?.endLocation || route?.end_location;
    return [
        isRenderableMapPoint(start) ? start : null,
        ...doors,
        isRenderableMapPoint(end) ? end : null,
    ].filter(Boolean);
};

export function ActiveRouteLayer({ activeRoute, mapSettings, pinSize, lineDashArray, setSelectedProperty, decisionFilterActive }) {
    const map = useMap();
    const groupRef = useRef(null);
    const pinsRef = useRef(new Map());
    const lineRef = useRef(null);
    const selectedRef = useRef(setSelectedProperty);
    selectedRef.current = setSelectedProperty;
    const labelCanvas = useMemo(() => createLabelCanvas(L), [map]);
    const [zoom, setZoom] = React.useState(() => zoomStyleBand(map.getZoom()));
    const [viewBox, setViewBox] = React.useState(null);
    const renderedBoxRef = useRef(null);
    const routePoints = useMemo(() => (activeRoute?.properties || []).filter(isRenderableMapPoint), [activeRoute?.properties]);
    const routeLinePoints = useMemo(() => getRouteLinePoints(activeRoute, routePoints), [activeRoute, routePoints]);
    const betaSegments = useMemo(() => verifiedBetaSegments(activeRoute?.metadata, activeRoute?.property_hashes || routePoints, routePoints), [activeRoute, routePoints]);

    useEffect(() => {
        let timeoutId;
        const update = () => {
            const b = map.getBounds();
            const old = renderedBoxRef.current;
            if (old && b.getNorth() <= old.north && b.getSouth() >= old.south
                && b.getEast() <= old.east && b.getWest() >= old.west) return;
            const padded = b.pad(0.25);
            const box = { north: padded.getNorth(), south: padded.getSouth(), east: padded.getEast(), west: padded.getWest() };
            renderedBoxRef.current = box;
            setViewBox(box);
        };
        const settle = () => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => { setZoom(zoomStyleBand(map.getZoom())); update(); }, 120);
        };
        update();
        map.on('moveend zoomend', settle);
        return () => { clearTimeout(timeoutId); map.off('moveend zoomend', settle); };
    }, [map]);

    useEffect(() => {
        if (!viewBox) return;
        if (!groupRef.current) groupRef.current = L.layerGroup().addTo(map);
        const group = groupRef.current;
        const routeColor = getRouteColor(activeRoute, activeRoute?.route_number || 1);
        const showNumbers = routePoints.length <= 1000 ? zoom >= 12 : zoom >= 14;
        const numberFontSize = zoom >= 17 ? 11 : zoom >= 15 ? 10 : 9;
        const wideView = zoom < 14;
        const dotSize = wideView ? Math.max(1.2, zoomAdjustedPinSize(pinSize, zoom) * 0.5)
            : Math.max(2.5, zoomAdjustedPinSize(pinSize, zoom) * 0.8);
        let labelsDrawn = 0;
        const entries = [];
        routePoints.forEach((p, idx) => {
            const point = [Number(p.lat), Number(p.lng)];
            if (point[0] < viewBox.south || point[0] > viewBox.north || point[1] < viewBox.west || point[1] > viewBox.east) return;
            const sold = isConfirmedSale(p);
            const status = p.effective_status || p.parsed_status || p.original_status || 'ELIGIBLE';
            const hasDecision = status !== 'ELIGIBLE';
            const completed = activeRoute?.status === 'COMPLETED';
            const color = hasDecision ? outcomeColor(status) : idx === 0 && !completed ? '#FFFFFF'
                : completed ? getCompletedPinColor(status, routeColor) : routeColor;
            const emphasized = sold || (completed && p.effective_status === 'QUALIFIED');
            const showLabel = (showNumbers || sold) && labelsDrawn < 1000;
            if (showLabel) labelsDrawn++;
            entries.push({
                key: `${pinKey(p)}:${idx}`, point, payload: { ...p, route_position: idx + 1 },
                style: {
                    radius: emphasized ? dotSize + 1.5 : dotSize, fillColor: color, fillOpacity: 1,
                    color: '#fff', weight: emphasized ? 1.5 : wideView ? 0.4 : 1,
                    stopLabel: showLabel ? { text: idx + 1, color: hasDecision ? outcomeColor(status) : 'rgba(255,255,255,0.9)',
                        size: sold ? Math.max(11, numberFontSize) : numberFontSize, weight: sold ? 800 : 600, offsetY: -5 } : null,
                },
            });
        });
        reconcileMapPins(pinsRef.current, entries, {
            create: ({ point, style }) => {
                const circle = labelCanvas.circleMarker(point, style);
                circle.on('click', event => { L.DomEvent.stopPropagation(event); selectedRef.current(circle.__payload); });
                group.addLayer(circle);
                return circle;
            },
            remove: marker => group.removeLayer(marker),
        });
    }, [map, viewBox, activeRoute, routePoints, zoom, pinSize, labelCanvas]);

    // Viewport movement never replaces or reprojects the full road geometry.
    useEffect(() => {
        if (!groupRef.current) groupRef.current = L.layerGroup().addTo(map);
        const group = groupRef.current;
        const visible = !decisionFilterActive && (routeLinePoints.length > 1 || betaSegments?.length);
        if (!visible) {
            if (lineRef.current) group.removeLayer(lineRef.current);
            lineRef.current = null;
            return;
        }
        const points = betaSegments ? betaSegments.map(segment => segment.map(p => [Number(p.lat), Number(p.lng)]))
            : routeLinePoints.map(p => [Number(p.lat), Number(p.lng)]);
        const style = { color: getRouteColor(activeRoute, activeRoute?.route_number || 1), weight: 2.5,
            opacity: Math.max(0.75, mapSettings.lineOpacity || 0), dashArray: lineDashArray || null, interactive: false };
        if (!lineRef.current) {
            lineRef.current = L.polyline(points, style);
            group.addLayer(lineRef.current);
        } else lineRef.current.setLatLngs(points).setStyle(style);
        lineRef.current.bringToBack();
    }, [map, activeRoute, routeLinePoints, betaSegments, mapSettings.lineOpacity, lineDashArray, decisionFilterActive]);

    useEffect(() => () => {
        if (groupRef.current) map.removeLayer(groupRef.current);
        if (map.hasLayer(labelCanvas.renderer)) map.removeLayer(labelCanvas.renderer);
        groupRef.current = null;
        lineRef.current = null;
        pinsRef.current.clear();
    }, [map, labelCanvas]);
    return null;
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
    // Padded box already rendered. Leaflet re-projects existing markers for free on
    // zoom/pan, so we only rebuild the pin layer once the view leaves that box.
    const renderedBoxRef = useRef(null);

    // Listen for map move/zoom to update visible pins safely deferring heavy math
    React.useEffect(() => {
        let timeoutId = null;

        const updateBounds = () => {
            const b = map.getBounds();
            const next = {
                north: b.getNorth(), south: b.getSouth(),
                east: b.getEast(), west: b.getWest()
            };
            const latBuffer = (next.north - next.south) * 0.15;
            const lngBuffer = (next.east - next.west) * 0.15;
            renderedBoxRef.current = {
                north: next.north + latBuffer, south: next.south - latBuffer,
                east: next.east + lngBuffer, west: next.west - lngBuffer
            };
            setViewBounds(next);
        };

        const isInsideRenderedBox = () => {
            const box = renderedBoxRef.current;
            if (!box) return false;
            const b = map.getBounds();
            return b.getNorth() <= box.north && b.getSouth() >= box.south
                && b.getEast() <= box.east && b.getWest() >= box.west;
        };

        const debouncedUpdate = () => {
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                if (isInsideRenderedBox()) return;
                updateBounds();
            }, 120);
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

    // Load shedding. Every rendered pin is a Canvas layer that Leaflet hit-tests
    // on each mouse move and re-projects on each pan, so the ceiling scales with
    // zoom: wide views draw a readable sample, street-level views draw detail.
    // A flat 5,000 cap is what made a 16k-property territory unusable. Banded so
    // the layer only rebuilds when the budget actually changes.
    const MAX_VISIBLE_PINS = React.useMemo(
        () => (zoomLevel >= 16 ? 12000 : zoomLevel >= 14 ? 8000 : 5000),
        [zoomLevel]
    );

    // Only the zoom *band* matters here — using the raw zoom level would rebuild
    // every pin on each zoom step even though nothing about the set changes.
    const pinsZoomEnabled = zoomLevel >= 13;

    const visiblePins = useMemo(() => {
        if (!viewBounds) return [];
        if (viewMode !== 'pins' || !pinsZoomEnabled || activeRoute || !(mode === 'generate' || showAllProperties)) {
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
    }, [viewBounds, viewMode, pinsZoomEnabled, activeRoute, mode, showAllProperties, effectiveProperties, MAX_VISIBLE_PINS,
        assignedHashes, zipCodeFilter, drawnPolygon, soldDateFilter, ownershipRangeDays, ownershipRangeReferenceDate, quickFilter, subMonths, isPointInPolygon]);

    const oneMonthAgo = useMemo(() => subMonths(new Date(), 1), [subMonths]);
    const fastPinsMap = useMap();
    const groupRef = useRef(null);
    // Identity model for the pin layer. Without it, every settled pan destroyed and
    // recreated up to 12,000 native markers in one synchronous task to achieve what a
    // small add/remove delta accomplishes — the dominant cost of high-pin-count lag.
    const markerStoreRef = useRef(new Map());
    const styleCacheRef = useRef({ key: '', styles: new Map() });

    const denseView = visiblePins.length > 1200;
    // Dots grow back at street-level zoom so they don't vanish into the map.
    const dotSize = zoomAdjustedPinSize(pinSize, zoomLevel);
    const styleContext = useMemo(() => ({
        statusColors: STATUS_COLORS,
        colorScheme: mapSettings.colorScheme,
        pinOpacity: mapSettings.pinOpacity,
        pinBorderColor: mapSettings.pinBorderColor,
        pinBorderWidth: mapSettings.pinBorderWidth,
        fillStyle: mapSettings.fillStyle,
        highlightRecentlySold,
        oneMonthAgo,
        denseView,
        dotSize,
    }), [STATUS_COLORS, mapSettings.colorScheme, mapSettings.pinOpacity, mapSettings.pinBorderColor,
        mapSettings.pinBorderWidth, mapSettings.fillStyle, highlightRecentlySold, oneMonthAgo, denseView, dotSize]);

    // One shared handler instead of a fresh closure allocated per pin per rebuild.
    const handlePinClick = React.useCallback((event) => {
        L.DomEvent.stopPropagation(event);
        const property = event.target?.__property;
        if (property) setSelectedProperty(property);
    }, [setSelectedProperty]);

    // Diffed update: add pins that entered the view, remove pins that left it, and
    // restyle a surviving pin only when its cheap style key actually changed.
    useEffect(() => {
        if (!fastPinsMap) return;
        if (!groupRef.current) groupRef.current = L.layerGroup().addTo(fastPinsMap);
        const group = groupRef.current;
        const store = markerStoreRef.current;

        const contextKey = pinStyleContextKey(styleContext);
        if (styleCacheRef.current.key !== contextKey) {
            styleCacheRef.current = { key: contextKey, styles: new Map() };
        }
        const styleCache = styleCacheRef.current.styles;

        const nextPins = new Map();
        visiblePins.forEach(p => nextPins.set(pinKey(p), p));

        store.forEach((entry, key) => {
            if (nextPins.has(key)) return;
            group.removeLayer(entry.marker);
            if (entry.ring) group.removeLayer(entry.ring);
            store.delete(key);
        });

        nextPins.forEach((p, key) => {
            const propertyStyleKey = pinPropertyStyleKey(p);
            let style = styleCache.get(propertyStyleKey);
            if (!style) {
                style = buildPinStyle(p, styleContext);
                styleCache.set(propertyStyleKey, style);
            }

            const entry = store.get(key);
            if (!entry) {
                // Ring first so it stays underneath the dot, exactly as before.
                const ring = style.ring ? L.circleMarker([p.lat, p.lng], style.ring) : null;
                if (ring) group.addLayer(ring);
                const marker = L.circleMarker([p.lat, p.lng], style.marker);
                marker.__property = p;
                marker.on('click', handlePinClick);
                group.addLayer(marker);
                store.set(key, { marker, ring, styleKey: style.styleKey });
                return;
            }

            // Same door, possibly a fresher record — keep the click payload current.
            entry.marker.__property = p;
            if (entry.styleKey === style.styleKey) return;
            entry.marker.setStyle(style.marker);
            entry.marker.setRadius(style.marker.radius);
            if (entry.ring && !style.ring) {
                group.removeLayer(entry.ring);
                entry.ring = null;
            } else if (!entry.ring && style.ring) {
                entry.ring = L.circleMarker([p.lat, p.lng], style.ring);
                group.addLayer(entry.ring);
            } else if (entry.ring && style.ring) {
                entry.ring.setStyle(style.ring);
                entry.ring.setRadius(style.ring.radius);
            }
            entry.styleKey = style.styleKey;
        });
    }, [fastPinsMap, visiblePins, styleContext, handlePinClick]);

    // Teardown belongs to unmount only. Running it on every dependency change is
    // what made marker reuse impossible.
    useEffect(() => () => {
        if (groupRef.current && fastPinsMap) fastPinsMap.removeLayer(groupRef.current);
        groupRef.current = null;
        markerStoreRef.current = new Map();
    }, [fastPinsMap]);

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
    lineDashArray, setActiveRoute, allSavedRoutes, decisionFilterActive
}) {
    const map = useMap();
    // Persistent container plus one cached layer group per route. Zoom/pan now
    // attaches and detaches those groups instead of rebuilding their markers.
    const containerRef = useRef(null);
    const cacheRef = useRef(new Map());
    const labelCanvas = useMemo(() => createLabelCanvas(L), [map]);
    // Zoom band only — rebuilding these layers on every zoom step made zooming stutter.
    const routesZoomEnabled = zoomLevel >= 8;

    // Viewport culling. Routes mode used to draw every door, number label and
    // line of every saved route in the account at once, which is what spiked the
    // load the moment Routes was opened. Same padded-box + debounce approach as
    // the property pin layer: rebuild only when the view leaves the drawn box.
    const [viewBox, setViewBox] = React.useState(null);
    const renderedBoxRef = useRef(null);

    React.useEffect(() => {
        let timeoutId = null;

        const paddedBox = () => {
            const b = map.getBounds();
            const latPad = (b.getNorth() - b.getSouth()) * 0.25;
            const lngPad = (b.getEast() - b.getWest()) * 0.25;
            return {
                north: b.getNorth() + latPad, south: b.getSouth() - latPad,
                east: b.getEast() + lngPad, west: b.getWest() - lngPad
            };
        };

        const update = () => {
            const box = paddedBox();
            renderedBoxRef.current = box;
            setViewBox(box);
        };

        const insideRenderedBox = () => {
            const box = renderedBoxRef.current;
            if (!box) return false;
            const b = map.getBounds();
            return b.getNorth() <= box.north && b.getSouth() >= box.south
                && b.getEast() <= box.east && b.getWest() >= box.west;
        };

        const debouncedUpdate = () => {
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                if (insideRenderedBox()) return;
                update();
            }, 120);
        };

        update();
        map.on('moveend', debouncedUpdate);
        map.on('zoomend', debouncedUpdate);
        return () => {
            if (timeoutId) clearTimeout(timeoutId);
            map.off('moveend', debouncedUpdate);
            map.off('zoomend', debouncedUpdate);
        };
    }, [map]);

    // Dot radius is applied to cached pins imperatively, so crossing a zoom band
    // resizes them instead of rebuilding every route.
    const dotSize = zoomAdjustedPinSize(pinSize, zoomLevel);
    const dotSizeRef = useRef(dotSize);

    const styleKey = useMemo(() => savedRouteStyleKey({
        quickFilter, showRouteDetails, showRouteLines, decisionFilterActive,
        pinOpacity: mapSettings.pinOpacity, fillStyle: mapSettings.fillStyle,
        pinBorderColor: mapSettings.pinBorderColor, pinBorderWidth: mapSettings.pinBorderWidth,
        showLabels: mapSettings.showLabels, labelType: mapSettings.labelType,
        lineWidth: mapSettings.lineWidth, lineOpacity: mapSettings.lineOpacity, lineDashArray,
    }), [quickFilter, showRouteDetails, showRouteLines, decisionFilterActive, mapSettings.pinOpacity,
        mapSettings.fillStyle, mapSettings.pinBorderColor, mapSettings.pinBorderWidth, mapSettings.showLabels,
        mapSettings.labelType, mapSettings.lineWidth, mapSettings.lineOpacity, lineDashArray]);

    useEffect(() => {
        if (!map || !viewBox) return;
        if (!containerRef.current) containerRef.current = L.layerGroup().addTo(map);
        const container = containerRef.current;
        const cache = cacheRef.current;

        const inView = (p) => (
            Number(p.lat) >= viewBox.south && Number(p.lat) <= viewBox.north
            && Number(p.lng) >= viewBox.west && Number(p.lng) <= viewBox.east
        );

        // Only show saved route overlays in Routes mode. Builder/draw mode stays visually clean,
        // while selecting an individual route still shows it through ActiveRouteLayer.
        const activeRouteHasMapPoints = activeRoute?.properties?.some(isRenderableMapPoint);
        const routesVisible = !activeRouteHasMapPoints && mode === 'analyze' && routesZoomEnabled;

        const visibleRoutes = routesVisible
            ? filterRoutesByStatus(hydratedSavedRoutes, routeStatusView).filter(route => {
                // Off-screen routes contribute nothing visible, so their cached
                // group is simply detached — pins, number label and lines.
                if (!route.properties.some(p => isRenderableMapPoint(p) && inView(p))) return false;
                if (analyzeZipFilter === 'all') return true;
                return route.properties.some(p => p.zip_code === analyzeZipFilter);
            })
            : [];

        // Build a global route number map from the full unfiltered list for consistent numbering
        const routeNumberMap = new Map();
        (allSavedRoutes || hydratedSavedRoutes).forEach((r, i) => routeNumberMap.set(r.id, i + 1));

        const keep = new Set();
        visibleRoutes.forEach((route, routeIdx) => {
            const globalNumber = routeNumberMap.get(route.id) || (routeIdx + 1);
            const repColor = getRouteColor(route, globalNumber);
            // Anything that changes the drawn route invalidates its cached group.
            const decisionFingerprint = route.properties
                .map(property => `${property.address_hash || property.id || ''}:${property.effective_status || property.parsed_status || property.original_status || 'ELIGIBLE'}`)
                .join(',');
            const signature = [
                route.properties.length, route.status, route.assigned_to || '',
                route.updated_date || '', repColor, styleKey, decisionFingerprint,
            ].join('|');
            keep.add(route.id);

            let entry = cache.get(route.id);
            if (entry && entry.signature !== signature) {
                if (entry.attached) container.removeLayer(entry.group);
                cache.delete(route.id);
                entry = null;
            }
            if (!entry) {
                const centerProp = route.properties[Math.floor(route.properties.length / 2)];
                const built = buildSavedRouteGroup({
                    circleMarker: labelCanvas.circleMarker,
                    doors: route.properties.filter(isRenderableMapPoint),
                    linePoints: getRouteLinePoints(route, route.properties),
                    lineSegments: verifiedBetaSegments(route.metadata, route.property_hashes || route.properties, route.properties),
                    centerPoint: isRenderableMapPoint(centerProp)
                        ? [Number(centerProp.lat), Number(centerProp.lng)]
                        : null,
                    number: globalNumber,
                    color: repColor,
                    style: {
                        quickFilter, showRouteDetails, showRouteLines, decisionFilterActive,
                        pinOpacity: mapSettings.pinOpacity, fillStyle: mapSettings.fillStyle,
                        pinBorderColor: mapSettings.pinBorderColor, pinBorderWidth: mapSettings.pinBorderWidth,
                        showLabels: mapSettings.showLabels, labelType: mapSettings.labelType,
                        lineWidth: mapSettings.lineWidth, lineOpacity: mapSettings.lineOpacity, lineDashArray,
                    },
                    dotSize: dotSizeRef.current,
                    onSelect: () => setActiveRoute({ ...route, route_number: globalNumber, display_color: repColor }),
                });
                entry = { ...built, signature, attached: false };
                cache.set(route.id, entry);
            }
            if (!entry.attached) {
                container.addLayer(entry.group);
                entry.attached = true;
            }
        });

        // Routes that left the view are detached but kept built, so panning back
        // costs nothing.
        cache.forEach((entry, routeId) => {
            if (keep.has(routeId) || !entry.attached) return;
            container.removeLayer(entry.group);
            entry.attached = false;
        });
    }, [map, viewBox, mode, activeRoute, routesZoomEnabled, hydratedSavedRoutes, analyzeZipFilter, quickFilter,
        routeStatusView, showRouteDetails, showRouteLines, styleKey, mapSettings, lineDashArray, setActiveRoute,
        allSavedRoutes, decisionFilterActive, labelCanvas]);

    // Zoom band change: resize the cached pins in place.
    useEffect(() => {
        dotSizeRef.current = dotSize;
        cacheRef.current.forEach(entry => {
            entry.doorPins.forEach(pin => pin.setRadius(pin.__sold ? dotSize + 2 : dotSize));
        });
    }, [dotSize]);

    // Teardown on unmount only — dropping the container on every dependency
    // change is what would make the cache pointless.
    useEffect(() => () => {
        if (containerRef.current && map) map.removeLayer(containerRef.current);
        if (map.hasLayer(labelCanvas.renderer)) map.removeLayer(labelCanvas.renderer);
        containerRef.current = null;
        cacheRef.current = new Map();
    }, [map, labelCanvas]);

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
    decisionFilterActive,
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
    const renderPrecisionLayers = shouldRenderPrecisionMapLayers({ routeMode });
    // Dense dots are the default unless the user picked a size.
    const effectivePinSize = resolvePinSize(pinSize);

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
                decisionFilterActive={decisionFilterActive}
                routeStatusView={routeStatusView}
                pinSize={effectivePinSize}
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
                pinSize={effectivePinSize}
                mapSettings={mapSettings}
                STATUS_COLORS={STATUS_COLORS}
                setSelectedProperty={setSelectedProperty}
                isPointInPolygon={isPointInPolygon}
                subMonths={subMonths}
                mapRef={mapRef}
            />

            {/* Preview Route (hover/tap from list) */}
            {previewRoute && !activeRoute && (
                previewRoute.metadata?.routing?.road_aware_routing_beta
                ? (verifiedBetaSegments(previewRoute.metadata, previewRoute.property_hashes || previewRoute.properties, previewRoute.properties) || []).map((points, i) =>
                    <Polyline key={i} positions={points.map(p => [Number(p.lat), Number(p.lng)])}
                        pathOptions={{ color: BRAND.gold, weight: 3, opacity: 0.6, dashArray: '5,10' }} />)
                :
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
                    pinSize={effectivePinSize}
                    lineDashArray={lineDashArray}
                    setSelectedProperty={setSelectedProperty}
                    decisionFilterActive={decisionFilterActive}
                />
            )}
            </>}
        </>
    );
});

export default ManagerMapLayers;
