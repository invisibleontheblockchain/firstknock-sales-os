import React, { useMemo, useCallback, useEffect, useRef } from 'react';
import { CircleMarker, Polyline, Circle, LayerGroup, Tooltip, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { DarkRoomClient } from '@/components/logic/neonClient';

/**
 * ActiveRouteLayer — High-performance active route renderer.
 * Uses a single native Leaflet layer group added imperatively instead of
 * hundreds of React-managed <CircleMarker> + <Tooltip permanent> combos.
 * This eliminates the ~15s delay when activating a route with many stops.
 */
function ActiveRouteLayer({ activeRoute, BRAND, mapSettings, lineDashArray, setSelectedProperty }) {
    const map = useMap();
    const layerRef = useRef(null);

    useEffect(() => {
        if (!map || !activeRoute?.properties?.length) return;

        // Clean up previous layer
        if (layerRef.current) {
            map.removeLayer(layerRef.current);
            layerRef.current = null;
        }

        const group = L.layerGroup();
        const props = activeRoute.properties.filter(p => p && p.lat && p.lng);

        // 1. Route line
        if (props.length > 1) {
            const line = L.polyline(
                props.map(p => [p.lat, p.lng]),
                {
                    color: BRAND.gold,
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

            // Circle pin (canvas-rendered, fast)
            const circle = L.circleMarker([p.lat, p.lng], {
                radius: 5,
                fillColor: isFirst ? '#22c55e' : '#f97316',
                fillOpacity: 1,
                color: '#fff',
                weight: 1.5,
            });
            circle.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                setSelectedProperty(p);
            });
            group.addLayer(circle);

            // Number label (lightweight DivIcon marker)
            const label = L.marker([p.lat, p.lng], {
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
    }, [map, activeRoute, BRAND.gold, mapSettings.lineWidth, mapSettings.lineOpacity, lineDashArray, setSelectedProperty]);

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
    soldDateFilter, quickFilter, highlightRecentlySold, pinSize,
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
            if (cutoff !== null) {
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
        assignedHashes, zipCodeFilter, drawnPolygon, soldDateFilter, quickFilter, subMonths, isPointInPolygon]);

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
            const fillColor = isRecentlySold ? '#FF00FF' : (STATUS_COLORS[effectiveColorStatus] || STATUS_COLORS.OTHER);
            
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
 * ManagerMapLayers — extracted from Home.jsx
 * Renders all the map data layers: saved routes, generated routes, heatmap,
 * dark room clusters/pins, user property pins, active route, preview route.
 */
const ManagerMapLayers = React.memo(function ManagerMapLayers({
    // Mode & state
    mode,
    activeRoute,
    zoomLevel,
    viewMode,

    // Route data
    hydratedSavedRoutes,
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
    drawnPolygon,
    assignedHashes,
    showAllProperties,
    showRouteDetails,
    showRouteLines,
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
    return (
        <>
            {/* --- Existing Routes --- */}
            <LayerGroup>
                {(mode === 'analyze' || mode === 'generate') && !activeRoute && zoomLevel >= 8 && hydratedSavedRoutes
                    .filter(route => {
                        if (mode === 'generate') return true;
                        if (analyzeZipFilter === 'all') return true;
                        return route.properties.some(p => p.zip_code === analyzeZipFilter);
                    })
                    .map((route, routeIdx) => {
                        const repColor = route.assigned_to
                            ? (repColors[route.assigned_to] || '#3b82f6')
                            : ROUTE_COLORS[routeIdx % ROUTE_COLORS.length];

                        const isUnassigned = !route.assigned_to;
                        const centerProp = route.properties[Math.floor(route.properties.length / 2)];

                        return (
                            <React.Fragment key={`saved-group-${route.id}`}>
                                {centerProp && centerProp.lat && centerProp.lng && (
                                    <CircleMarker
                                        center={[centerProp.lat, centerProp.lng]}
                                        radius={14}
                                        pathOptions={{ fillColor: 'black', fillOpacity: 0.7, color: repColor, weight: 2 }}
                                        eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                    >
                                        <Tooltip permanent direction="center" className="route-number-tooltip">
                                            <span style={{ color: repColor, fontWeight: '900', fontSize: '10px' }}>#{routeIdx + 1}</span>
                                        </Tooltip>
                                    </CircleMarker>
                                )}

                                {showRouteDetails && route.properties
                                    .filter(p => {
                                        if (!p || p.lat === undefined || p.lng === undefined) return false;
                                        if (quickFilter === 'all') return true;
                                        if (quickFilter === 'eligible') return p.effective_status === 'ELIGIBLE' || p.effective_status === 'NO_ANSWER';
                                        if (quickFilter === 'sold') return p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED';
                                        if (quickFilter === 'rejected') return p.effective_status === 'HARD_NO';
                                        return true;
                                    })
                                    .map((p, idx) => (
                                        <React.Fragment key={`saved-${route.id}-${p.address_hash || 'no-hash'}-${idx}`}>
                                            <CircleMarker
                                                center={[p.lat, p.lng]}
                                                radius={20}
                                                eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                                pathOptions={{ fillColor: 'transparent', color: 'transparent', interactive: true, stroke: false }}
                                            />
                                            <CircleMarker
                                                center={[p.lat, p.lng]}
                                                radius={pinSize}
                                                eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                                pathOptions={{
                                                    fillColor: repColor,
                                                    fillOpacity: (isUnassigned ? 0.6 : 0.8) * mapSettings.pinOpacity,
                                                    color: mapSettings.fillStyle === 'outline' ? repColor : (mapSettings.pinBorderColor || '#000'),
                                                    weight: mapSettings.fillStyle === 'outline' ? 2 : mapSettings.pinBorderWidth
                                                }}
                                            >
                                                {mapSettings.showLabels && (
                                                    <Tooltip permanent direction="center" className="route-number-tooltip">
                                                        <span style={{ color: '#fff', fontWeight: 'bold', fontSize: '8px', textShadow: '0 0 3px #000' }}>
                                                            {mapSettings.labelType === 'number' ? p.house_number : mapSettings.labelType === 'status' ? (p.effective_status || '').slice(0, 1) : (p.street_name || '').split(' ')[0]}
                                                        </span>
                                                    </Tooltip>
                                                )}
                                            </CircleMarker>
                                        </React.Fragment>
                                    ))}
                                {showRouteLines && route.properties.length > 1 && (
                                    <Polyline
                                        positions={route.properties.map(p => [p.lat, p.lng])}
                                        pathOptions={{ color: repColor, weight: mapSettings.lineWidth, opacity: mapSettings.lineOpacity, dashArray: lineDashArray }}
                                    />
                                )}
                            </React.Fragment>
                        );
                    })}
            </LayerGroup>

            {/* --- GENERATE MODE: New Routes --- */}
            <LayerGroup>
                {mode === 'generate' && !activeRoute && filteredRoutes.length > 0 && filteredRoutes.map((route, rIdx) => {
                    const routeColor = ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
                    const centerProp = route.properties[Math.floor(route.properties.length / 2)];

                    return (
                        <React.Fragment key={`route-group-${route.id}`}>
                            {centerProp && centerProp.lat && centerProp.lng && (
                                <CircleMarker
                                    center={[centerProp.lat, centerProp.lng]}
                                    radius={16}
                                    pathOptions={{ fillColor: 'black', fillOpacity: 0.8, color: routeColor, weight: 3 }}
                                    eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                >
                                    <Tooltip permanent direction="center" className="route-number-tooltip">
                                        <span style={{ color: routeColor, fontWeight: '900', fontSize: '14px' }}>#{rIdx + 1}</span>
                                    </Tooltip>
                                </CircleMarker>
                            )}

                            {showRouteDetails && route.properties.filter(p => p && p.lat && p.lng).map((p, idx) => (
                                <React.Fragment key={`generated-${route.id}-${idx}`}>
                                    <CircleMarker
                                        center={[p.lat, p.lng]}
                                        radius={20}
                                        eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                        pathOptions={{ fillColor: 'transparent', color: 'transparent', interactive: true, stroke: false }}
                                    />
                                    <CircleMarker
                                        center={[p.lat, p.lng]}
                                        radius={pinSize + 1}
                                        eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                        pathOptions={{
                                            fillColor: routeColor,
                                            fillOpacity: 0.6 * mapSettings.pinOpacity,
                                            color: mapSettings.fillStyle === 'outline' ? routeColor : (mapSettings.pinBorderColor || '#000'),
                                            weight: mapSettings.pinBorderWidth
                                        }}
                                    />
                                </React.Fragment>
                            ))}
                            {showRouteLines && route.properties.length > 1 && (
                                <Polyline
                                    positions={route.properties.map(p => [p.lat, p.lng])}
                                    pathOptions={{ color: routeColor, weight: mapSettings.lineWidth, opacity: mapSettings.lineOpacity, dashArray: lineDashArray }}
                                />
                            )}
                        </React.Fragment>
                    );
                })}
            </LayerGroup>

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

            {/* Legacy pin layer kept as hidden reference — replaced by ViewportCulledPins above */}
            <LayerGroup>
                {false && viewMode === 'pins' && zoomLevel >= 13 && !activeRoute && (mode === 'generate' || showAllProperties) && effectiveProperties
                    .filter(p => !p.is_dark_room)
                    .filter(p => {
                        if (mode === 'generate' && assignedHashes.has(p.address_hash)) return false;
                        if (mode === 'generate' && zipCodeFilter && zipCodeFilter.trim()) {
                            const targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);
                            const pZip = String(p.zip_code || '').trim().slice(0, 5);
                            if (targetZips.length > 0 && !targetZips.includes(pZip)) return false;
                        }
                        if (mode === 'generate' && drawnPolygon && drawnPolygon.length > 2) {
                            if (!isPointInPolygon({ lat: p.lat, lng: p.lng }, drawnPolygon)) return false;
                        }
                        if (soldDateFilter !== null) {
                            if (!p.sold_date) return false;
                            try {
                                const date = new Date(p.sold_date);
                                const cutoff = subMonths(new Date(), parseInt(soldDateFilter));
                                if (date < cutoff) return false;
                            } catch (e) { return false; }
                        }
                        if (quickFilter === 'all') return true;
                        if (quickFilter === 'eligible') return p.effective_status === 'ELIGIBLE' || p.effective_status === 'NO_ANSWER';
                        if (quickFilter === 'sold') return p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED';
                        if (quickFilter === 'rejected') return p.effective_status === 'HARD_NO';
                        return true;
                    })
                    .map(p => {
                        let isRecentlySold = false;
                        if (highlightRecentlySold && p.sold_date) {
                            try {
                                isRecentlySold = new Date(p.sold_date) > subMonths(new Date(), 1);
                            } catch (e) { }
                        }

                        const isUnvisited = ['ELIGIBLE', 'NO_ANSWER', 'OTHER'].includes(p.effective_status);
                        const effColorStatus = p.effective_status === 'ELIGIBLE' && p.original_status && ['SOLD', 'RECENT_OFF_MARKET', 'PENDING'].includes(p.original_status)
                            ? p.original_status
                            : p.effective_status;

                        return (
                            <CircleMarker
                                key={p.address_hash || p.id}
                                center={[p.lat, p.lng]}
                                radius={isRecentlySold ? pinSize + 4 : (isUnvisited ? Math.max(2, pinSize - 2) : pinSize)}
                                eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setSelectedProperty(p); } }}
                                pathOptions={{
                                    fillColor: isRecentlySold ? '#FF00FF' : (STATUS_COLORS[effColorStatus] || STATUS_COLORS.OTHER),
                                    fillOpacity: isRecentlySold ? 1 : ((isUnvisited && p.effective_status === 'ELIGIBLE' && effColorStatus === 'ELIGIBLE') ? 0.3 : ((mode === 'generate' ? 0.9 : 0.5) * mapSettings.pinOpacity)),
                                    color: isRecentlySold ? '#FFFFFF' : (mapSettings.fillStyle === 'outline' ? (STATUS_COLORS[effColorStatus] || STATUS_COLORS.OTHER) : ((isUnvisited && p.effective_status === 'ELIGIBLE' && effColorStatus === 'ELIGIBLE') ? 'transparent' : (mapSettings.pinBorderColor || '#000'))),
                                    weight: isRecentlySold ? 2 : (mapSettings.fillStyle === 'outline' ? 2 : (isUnvisited ? 0 : mapSettings.pinBorderWidth))
                                }}
                            >
                                {mapSettings.showLabels && (
                                    <Tooltip permanent direction="center" className="route-number-tooltip">
                                        <span style={{ color: '#fff', fontWeight: 'bold', fontSize: '8px', textShadow: '0 0 3px #000' }}>
                                            {mapSettings.labelType === 'number' ? p.house_number : mapSettings.labelType === 'status' ? (p.effective_status || '').slice(0, 1) : (p.street_name || '').split(' ')[0]}
                                        </span>
                                    </Tooltip>
                                )}
                            </CircleMarker>
                        );
                    })}
            </LayerGroup>

            {/* Preview Route (hover/tap from list) */}
            {previewRoute && !activeRoute && (
                <Polyline
                    positions={previewRoute.properties.filter(p => p && p.lat && p.lng).map(p => [p.lat, p.lng])}
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
        </>
    );
});

export default ManagerMapLayers;