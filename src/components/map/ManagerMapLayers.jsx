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
import { resolvePinSize, zoomAdjustedPinSize } from './densePinSize';
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

// Confirmed sales always render in this green, whatever color their route uses.
const SOLD_PIN_COLOR = '#2EEB57';
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

function ActiveRouteLayer({ activeRoute, BRAND, mapSettings, pinSize, lineDashArray, setSelectedProperty, decisionFilterActive }) {
    const map = useMap();
    const layerRef = useRef(null);
    const fittedRouteIdRef = useRef(null);
    // Only the styling *band* is tracked, never the raw zoom level: every stop
    // and label is rebuilt when this changes, so reacting to each zoom step is
    // what made zooming stutter. All thresholds below are band boundaries.
    const [zoom, setZoom] = React.useState(() => zoomStyleBand(map ? map.getZoom() : 0));
    // Padded box already drawn. Leaflet re-projects existing layers for free, so
    // the route only rebuilds once the view leaves that box — same approach as
    // the property pin and saved route layers.
    const [viewBox, setViewBox] = React.useState(null);
    const renderedBoxRef = useRef(null);

    React.useEffect(() => {
        if (!map) return;
        let timeoutId = null;

        const update = () => {
            const b = map.getBounds();
            const latPad = (b.getNorth() - b.getSouth()) * 0.25;
            const lngPad = (b.getEast() - b.getWest()) * 0.25;
            const box = {
                north: b.getNorth() + latPad, south: b.getSouth() - latPad,
                east: b.getEast() + lngPad, west: b.getWest() - lngPad
            };
            renderedBoxRef.current = box;
            setViewBox(box);
            setZoom(zoomStyleBand(map.getZoom()));
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
                // A zoom change alters pin/label styling, so it always rebuilds;
                // panning inside the drawn box costs nothing.
                if (zoomStyleBand(map.getZoom()) === zoom && insideRenderedBox()) return;
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
    }, [map, zoom]);

    useEffect(() => {
        if (!map || !viewBox || !activeRoute?.properties?.length) return;

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

        // Stop numbers turning a route into a black smear. Labels overlap into
        // solid text at normal zoom, so they stay hidden until the doors are far
        // enough apart to read, and they render small even then. Pins and the
        // route line always show; tapping a pin still gives its exact position.
        // Numbers appear as soon as the doors are far enough apart to read them.
        // A route that fits the screen at zoom 14 was previously numberless until
        // you zoomed two more steps, which read as "the numbers don't work".
        // One zoom step earlier than before at every size — reps were having to
        // zoom past the useful working view before stop numbers appeared.
        const showNumbers = props.length <= 150 ? zoom >= 12 : props.length <= 600 ? zoom >= 13 : zoom >= 14;
        const numberFontSize = zoom >= 17 ? 11 : zoom >= 15 ? 10 : 9;
        // Zoomed out the doors sit on top of each other, so the route reads as a
        // bright blob. Fade the dots and the line back until the view is close
        // enough for individual stops to mean something.

        // 1. Route line — suppressed while a decision filter is active so the
        // remaining outcome pins are readable without route noise.
        if (!decisionFilterActive && routeLinePoints.length > 1) {
            const line = L.polyline(
                routeLinePoints.map(p => [Number(p.lat), Number(p.lng)]),
                {
                    // Deliberately restrained: the selected route used to draw at
                    // +2 weight and a 0.6 opacity floor, which washed out the
                    // satellite imagery and the outcome pins underneath it.
                    // Thin and faint on purpose, but always visible: reps need to
                    // see the walking order between houses, so the line keeps a
                    // minimum opacity even when the user's line settings are low.
                    color: routeColor,
                    weight: 2.5,
                    opacity: Math.max(0.75, mapSettings.lineOpacity || 0),
                    dashArray: lineDashArray || null,
                }
            );
            group.addLayer(line);
        }

        // 2. Property pins with number labels.
        // Off-screen stops are skipped entirely: on a large route, drawing every
        // door plus a DOM label for each is what makes panning and zooming crawl.
        // The route line above still shows the full shape of the territory.
        const inView = (p) => (
            Number(p.lat) >= viewBox.south && Number(p.lat) <= viewBox.north
            && Number(p.lng) >= viewBox.west && Number(p.lng) <= viewBox.east
        );
        // Number labels are DOM markers, far heavier than canvas dots, so they
        // get their own budget on top of the zoom gate.
        const MAX_NUMBER_LABELS = 150;
        let labelsDrawn = 0;

        props.forEach((p, idx) => {
            const isFirst = idx === 0;
            const num = idx + 1;
            const point = [Number(p.lat), Number(p.lng)];
            if (!inView(p)) return;

            // No separate transparent hitbox layer: leafletPatches gives every
            // canvas pin ~12px of tap slop, so a second layer per stop only
            // doubled the layers Leaflet hit-tests on every mouse move.
            const sold = isConfirmedSale(p);
            const completedColor = activeRoute.status === 'COMPLETED'
                ? getCompletedPinColor(p.effective_status, routeColor)
                : routeColor;
            const baseColor = isFirst && activeRoute.status !== 'COMPLETED' ? '#FFFFFF' : completedColor;

            // Circle pin (canvas-rendered, fast)
            // Emphasis is reserved for outcomes that matter (sales, qualified) —
            // ordinary stops stay small with a thin ring so a long route reads as
            // a path rather than a wall of bright dots.
            const emphasized = sold || (activeRoute.status === 'COMPLETED' && p.effective_status === 'QUALIFIED');
            // Same dense dot size as the Routes-mode pins, so a 10k-door route
            // reads as pin detail instead of a solid yellow blob when zoomed out.
            // Floor of 3px: a 2px dense dot with no zoom bump disappeared at wide
            // views, which is what made an active route look like it wasn't there.
            // Soloed route stops render smaller than territory pins so a selected
            // route reads as a path instead of a chain of fat dots. Wide views of
            // a big route pack thousands of doors into a few hundred pixels, so
            // the dot (and its white ring) shrink further there — that overlap is
            // what turned a soloed route into one solid yellow blob.
            const wideView = zoom < 14;
            const activeDotSize = wideView
                ? Math.max(1.2, zoomAdjustedPinSize(pinSize, zoom) * 0.5)
                : Math.max(2.5, zoomAdjustedPinSize(pinSize, zoom) * 0.8);
            const circle = L.circleMarker(point, {
                radius: emphasized ? activeDotSize + 1.5 : activeDotSize,
                fillColor: sold ? SOLD_PIN_COLOR : baseColor,
                // Zoomed out the stops sit on top of each other, so plain doors
                // dim back and only sales / first stop stay at full strength.
                // Route stops keep the same solid look at every zoom — dimming
                // them made a zoomed-out route read as missing entirely.
                fillOpacity: 1,
                color: '#fff',
                weight: emphasized ? 1.5 : (wideView ? 0.4 : 1),
            });
            circle.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                setSelectedProperty({ ...p, route_position: num });
            });
            group.addLayer(circle);

            // Number label (lightweight DivIcon marker).
            // A sale always shows its stop number, at any zoom — there are few of
            // them, they never crowd the map, and knowing which stop sold is the
            // whole point of looking at a worked route.
            if (!showNumbers && !sold) return;
            if (labelsDrawn >= MAX_NUMBER_LABELS) return;
            labelsDrawn++;
            const labelColor = sold ? SOLD_PIN_COLOR : 'rgba(255,255,255,0.9)';
            const labelSize = sold ? Math.max(11, numberFontSize) : numberFontSize;
            const label = L.marker(point, {
                icon: L.divIcon({
                    className: '',
                    html: `<div style="color:${labelColor};font-weight:${sold ? 800 : 600};font-size:${labelSize}px;text-shadow:0 1px 3px #000;pointer-events:none;transform:translate(-50%,-100%);white-space:nowrap">${num}</div>`,
                    iconSize: [0, 0],
                    iconAnchor: [0, 5],
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
    }, [map, viewBox, activeRoute, zoom, pinSize, mapSettings.lineWidth, mapSettings.lineOpacity, lineDashArray, setSelectedProperty, decisionFilterActive]);

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
        const denseView = visiblePins.length > 1200;
        // Dots grow back at street-level zoom so they don't vanish into the map.
        const dotSize = zoomAdjustedPinSize(pinSize, zoomLevel);

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
            
            // No separate transparent hitbox layer: leafletPatches gives every
            // canvas pin ~12px of tap slop, so a second layer per pin only
            // doubled the layers Leaflet hit-tests on every mouse move.

            // Confidence ring: subtle outer glow for verified/high leads in any color scheme.
            // Skipped on dense views — a third layer per pin is what tips large
            // territories into unusable pan/zoom lag.
            const conf = p.sale_confidence;
            const showConfRing = !denseView && !useConfidenceColors && !isRecentlySold && !isUnvisited && conf && (conf === 'high' || conf === 'verified');
            if (showConfRing) {
                const ringColor = CONFIDENCE_COLORS[conf];
                const ring = L.circleMarker([p.lat, p.lng], {
                    radius: dotSize + 3,
                    fillColor: 'transparent',
                    fillOpacity: 0,
                    color: ringColor,
                    weight: 1.5,
                    opacity: 0.6,
                });
                group.addLayer(ring);
            }

            // Callback pins render slightly smaller than other outcome pins.
            const isCallback = effectiveColorStatus === 'CALLBACK';

            // Visible pin
            // Unvisited doors used to render smaller, borderless and at 0.3 opacity,
            // which read as "most of my pins are missing" on a dense territory.
            // Every pin now draws at the same size and strength as worked doors.
            const circle = L.circleMarker([p.lat, p.lng], {
                radius: isRecentlySold ? dotSize + 4 : (isCallback ? dotSize * 0.9 : dotSize),
                fillColor,
                fillOpacity: isRecentlySold ? 1 : (mapSettings.pinOpacity || 1),
                color: isRecentlySold ? '#FFFFFF' : (mapSettings.fillStyle === 'outline' ? fillColor : (mapSettings.pinBorderColor || '#000')),
                weight: isRecentlySold ? 2 : (mapSettings.fillStyle === 'outline' ? 2 : mapSettings.pinBorderWidth)
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
    }, [fastPinsMap, visiblePins, highlightRecentlySold, oneMonthAgo, STATUS_COLORS, pinSize, zoomLevel, mapSettings, mode, setSelectedProperty]);

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
    const layerRef = useRef(null);
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

    useEffect(() => {
        if (!map || !viewBox) return;
        const inView = (p) => (
            Number(p.lat) >= viewBox.south && Number(p.lat) <= viewBox.north
            && Number(p.lng) >= viewBox.west && Number(p.lng) <= viewBox.east
        );

        // Clean up previous layer
        if (layerRef.current) {
            map.removeLayer(layerRef.current);
            layerRef.current = null;
        }

        // Only show saved route overlays in Routes mode. Builder/draw mode stays visually clean,
        // while selecting an individual route still shows it through ActiveRouteLayer.
        const activeRouteHasMapPoints = activeRoute?.properties?.some(isRenderableMapPoint);
        if (activeRouteHasMapPoints || mode !== 'analyze' || !routesZoomEnabled) return;

        const group = L.layerGroup();
        // Every door of every visible route renders — a low budget meant only a
        // fraction of a dense territory's pins appeared.
        const MAX_ROUTE_DETAIL_PINS = 40000;
        // Same street-level growth as the property pins, so route doors stay
        // visible instead of shrinking into the imagery when fully zoomed in.
        const routeDotSize = zoomAdjustedPinSize(pinSize, zoomLevel);

        const filteredRoutes = filterRoutesByStatus(hydratedSavedRoutes, routeStatusView).filter(route => {
            // Off-screen routes contribute nothing visible, so they are skipped
            // entirely — pins, number label and lines.
            if (!route.properties.some(p => isRenderableMapPoint(p) && inView(p))) return false;
            if (mode === 'generate') return true;
            if (analyzeZipFilter === 'all') return true;
            return route.properties.some(p => p.zip_code === analyzeZipFilter);
        });

        // Build a global route number map from the full unfiltered list for consistent numbering
        const routeNumberMap = new Map();
        (allSavedRoutes || hydratedSavedRoutes).forEach((r, i) => routeNumberMap.set(r.id, i + 1));

        // The detail-pin budget is shared per route. A single first-come budget
        // meant one large route consumed it all and every other visible route
        // rendered with no door pins at all.
        const perRoutePinBudget = Math.max(
            15000,
            Math.floor(MAX_ROUTE_DETAIL_PINS / Math.max(1, filteredRoutes.length))
        );

        filteredRoutes.forEach((route, routeIdx) => {
            let detailPinsDrawn = 0;
            const globalNumber = routeNumberMap.get(route.id) || (routeIdx + 1);
            const repColor = getRouteColor(route, globalNumber);
            const isUnassigned = !route.assigned_to;
            const centerProp = route.properties[Math.floor(route.properties.length / 2)];

            // Center marker with route number — hidden while a decision filter
            // is active so only the matching outcome pins remain on the map.
            if (!decisionFilterActive && isRenderableMapPoint(centerProp)) {
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
                    if (!inView(p)) return;
                    if (quickFilter !== 'all') {
                        if (quickFilter === 'eligible' && p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'NO_ANSWER') return;
                        if (quickFilter === 'sold' && p.effective_status !== 'SOLD' && p.effective_status !== 'QUALIFIED') return;
                        if (quickFilter === 'rejected' && p.effective_status !== 'HARD_NO') return;
                    }

                    // Detail-pin budget: past this point the route lines and center
                    // markers still show the whole territory, but drawing every
                    // door of every saved route is what freezes a large account.
                    if (detailPinsDrawn >= perRoutePinBudget) return;
                    detailPinsDrawn++;

                    // No separate transparent hitbox: the global 12px canvas tap
                    // slop covers tapping without doubling the layer count.
                    const point = [Number(p.lat), Number(p.lng)];

                    // Visible pin — confirmed sales stay green regardless of route color
                    const sold = isConfirmedSale(p);
                    const pinColor = sold ? SOLD_PIN_COLOR : repColor;
                    const circle = L.circleMarker(point, {
                        radius: sold ? routeDotSize + 2 : routeDotSize,
                        fillColor: pinColor,
                        fillOpacity: sold ? 1 : (mapSettings.pinOpacity || 1),
                        color: sold ? '#FFFFFF' : (mapSettings.fillStyle === 'outline' ? repColor : (mapSettings.pinBorderColor || '#000')),
                        weight: sold ? 2 : (mapSettings.fillStyle === 'outline' ? 2 : (mapSettings.pinBorderWidth || 1))
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

            // Route line — tappable to select the route (with a wide invisible
            // hit line underneath so it's easy to tap on mobile)
            const routeLinePoints = getRouteLinePoints(route, route.properties);
            if (showRouteLines && routeLinePoints.length > 1) {
                const lineLatLngs = routeLinePoints.map(p => [Number(p.lat), Number(p.lng)]);
                const selectRoute = (e) => { L.DomEvent.stopPropagation(e); setActiveRoute({ ...route, route_number: globalNumber, display_color: repColor }); };

                const hitLine = L.polyline(lineLatLngs, {
                    color: 'transparent',
                    weight: 26,
                    opacity: 0,
                    interactive: true
                });
                hitLine.on('click', selectRoute);
                group.addLayer(hitLine);

                const line = L.polyline(lineLatLngs, {
                    color: repColor,
                    weight: mapSettings.lineWidth || 3,
                    opacity: mapSettings.lineOpacity || 0.7,
                    dashArray: lineDashArray || null
                });
                line.on('click', selectRoute);
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
    }, [map, viewBox, mode, activeRoute, routesZoomEnabled, hydratedSavedRoutes, analyzeZipFilter, quickFilter,
        routeStatusView, repColors, ROUTE_COLORS, showRouteDetails, showRouteLines, pinSize, mapSettings, lineDashArray, setActiveRoute, allSavedRoutes, decisionFilterActive]);

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
    const renderPrecisionLayers = shouldRenderPrecisionMapLayers({ mode, routeMode, activeRoute });
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