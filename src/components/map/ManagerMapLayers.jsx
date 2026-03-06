import React from 'react';
import { CircleMarker, Polyline, Circle, LayerGroup, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { DarkRoomClient } from '@/components/logic/neonClient';

/**
 * ManagerMapLayers — extracted from Home.jsx
 * Renders all the map data layers: saved routes, generated routes, heatmap,
 * dark room clusters/pins, user property pins, active route, preview route.
 */
export default function ManagerMapLayers({
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
                                        <CircleMarker
                                            key={`saved-${route.id}-${p.address_hash || 'no-hash'}-${idx}`}
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
                                <CircleMarker
                                    key={`generated-${route.id}-${idx}`}
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

                        return (
                            <CircleMarker
                                key={p.address_hash || p.id}
                                center={[p.lat, p.lng]}
                                radius={isRecentlySold ? pinSize + 4 : (isUnvisited ? Math.max(2, pinSize - 2) : pinSize)}
                                eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setSelectedProperty(p); } }}
                                pathOptions={{
                                    fillColor: isRecentlySold ? '#FF00FF' : (STATUS_COLORS[p.effective_status] || STATUS_COLORS.OTHER),
                                    fillOpacity: isRecentlySold ? 1 : (isUnvisited ? 0.3 : ((mode === 'generate' ? 0.9 : 0.5) * mapSettings.pinOpacity)),
                                    color: isRecentlySold ? '#FFFFFF' : (mapSettings.fillStyle === 'outline' ? (STATUS_COLORS[p.effective_status] || STATUS_COLORS.OTHER) : (isUnvisited ? 'transparent' : (mapSettings.pinBorderColor || '#000'))),
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

            {/* Active Route - Mail Carrier Style */}
            {activeRoute && (
                <>
                    <Polyline
                        positions={activeRoute.properties.filter(p => p && p.lat && p.lng).map(p => [p.lat, p.lng])}
                        pathOptions={{
                            color: BRAND.gold,
                            weight: mapSettings.lineWidth ? mapSettings.lineWidth + 2 : 4,
                            opacity: mapSettings.lineOpacity ? Math.max(0.6, mapSettings.lineOpacity) : 0.8,
                            dashArray: lineDashArray
                        }}
                    />
                    {activeRoute.properties.map((p, idx) => (
                        <CircleMarker
                            key={p.address_hash}
                            center={[p.lat, p.lng]}
                            radius={5}
                            eventHandlers={{
                                click: (e) => {
                                    L.DomEvent.stopPropagation(e);
                                    setSelectedProperty(p);
                                }
                            }}
                            pathOptions={{
                                fillColor: idx === 0 ? '#22c55e' : '#f97316',
                                fillOpacity: 1,
                                color: '#fff',
                                weight: 1.5
                            }}
                        >
                            <Tooltip permanent direction="top" offset={[0, -6]} className="route-number-tooltip">
                                <span style={{
                                    color: '#fff',
                                    fontWeight: 'bold',
                                    fontSize: '11px',
                                    textShadow: '0 1px 3px #000, 0 0 5px #000'
                                }}>
                                    {idx + 1}
                                </span>
                            </Tooltip>
                        </CircleMarker>
                    ))}
                </>
            )}
        </>
    );
}