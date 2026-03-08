import React, { useMemo } from 'react';
import { Source, Layer, Popup } from 'react-map-gl/maplibre';
import { DarkRoomClient } from '@/components/logic/neonClient';

// Helper to reliably compute dynamic colors for mapbox data driven styling
const getStatusColor = (statusColorsMap, defaultColor) => {
    // We create a match expression based on status
    const stops = [];
    Object.keys(statusColorsMap).forEach(status => {
        stops.push(status);
        stops.push(statusColorsMap[status]);
    });

    return [
        'match',
        ['get', 'effective_status'],
        ...stops,
        defaultColor
    ];
};

export default function ManagerMapLayers({
    mode,
    activeRoute,
    zoomLevel,
    viewMode,
    hydratedSavedRoutes,
    filteredRoutes,
    ROUTE_COLORS,
    effectiveProperties,
    darkRoomProperties,
    darkRoomClusters,
    heatmapData,
    previewRoute,
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
    mapSettings,
    pinSize,
    STATUS_COLORS,
    repColors,
    BRAND,
    setActiveRoute,
    setSelectedProperty,
    mapRef,
    isPointInPolygon,
    getHeatColor,
    parseISO,
    subMonths,
    isAfter,
    darkRoom,
}) {
    // --------------------------------------------------------------------------------
    // 1. FILTER PROPERTIES FOR VIEWPORT CULLING & GEOJSON CONVERSION
    // --------------------------------------------------------------------------------
    const pinsGeoJSON = useMemo(() => {
        if (viewMode !== 'pins' || activeRoute || !(mode === 'generate' || showAllProperties)) {
            return { type: 'FeatureCollection', features: [] };
        }

        const targetZips = (mode === 'generate' && zipCodeFilter && zipCodeFilter.trim())
            ? zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean)
            : [];
        const cutoff = soldDateFilter !== null ? subMonths(new Date(), parseInt(soldDateFilter)) : null;

        const features = [];
        for (let i = 0; i < effectiveProperties.length; i++) {
            const p = effectiveProperties[i];
            if (p.is_dark_room) continue;
            if (mode === 'generate' && assignedHashes.has(p.address_hash)) continue;
            if (targetZips.length > 0) {
                const pZip = String(p.zip_code || '').trim().slice(0, 5);
                if (!targetZips.includes(pZip)) continue;
            }
            if (mode === 'generate' && drawnPolygon && drawnPolygon.length > 2) {
                if (!isPointInPolygon({ lat: p.lat, lng: p.lng }, drawnPolygon)) continue;
            }
            if (cutoff !== null) {
                if (!p.sold_date) continue;
                const date = new Date(p.sold_date);
                if (isNaN(date.getTime()) || date < cutoff) continue;
            }
            if (quickFilter !== 'all') {
                if (quickFilter === 'eligible' && p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'NO_ANSWER') continue;
                if (quickFilter === 'sold' && p.effective_status !== 'SOLD' && p.effective_status !== 'QUALIFIED') continue;
                if (quickFilter === 'rejected' && p.effective_status !== 'HARD_NO') continue;
            }

            // Highlight recently sold logic handled gracefully by pushing properties
            let isRecentlySold = false;
            if (highlightRecentlySold && p.sold_date) {
                isRecentlySold = new Date(p.sold_date) > subMonths(new Date(), 1);
            }

            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                properties: {
                    ...p,
                    isRecentlySold: isRecentlySold,
                    isUnvisited: ['ELIGIBLE', 'NO_ANSWER', 'OTHER'].includes(p.effective_status),
                    label: mapSettings.labelType === 'number' ? p.house_number : mapSettings.labelType === 'status' ? (p.effective_status || '').slice(0, 1) : (p.street_name || '').split(' ')[0]
                }
            });
        }
        return { type: 'FeatureCollection', features };
    }, [viewMode, activeRoute, mode, showAllProperties, effectiveProperties, assignedHashes, zipCodeFilter, drawnPolygon, soldDateFilter, quickFilter, subMonths, isPointInPolygon, highlightRecentlySold, mapSettings.labelType]);


    // --------------------------------------------------------------------------------
    // 2. SAVED ROUTES GEOJSON CONVERSION
    // --------------------------------------------------------------------------------
    const savedRoutesGeoJSON = useMemo(() => {
        const features = [];
        const lines = [];

        if ((mode === 'analyze' || mode === 'generate') && !activeRoute && hydratedSavedRoutes) {
            hydratedSavedRoutes
                .filter(route => {
                    if (mode === 'generate') return true;
                    if (analyzeZipFilter === 'all') return true;
                    return route.properties.some(p => p.zip_code === analyzeZipFilter);
                })
                .forEach((route, routeIdx) => {
                    const repColor = route.assigned_to
                        ? (repColors[route.assigned_to] || '#3b82f6')
                        : ROUTE_COLORS[routeIdx % ROUTE_COLORS.length];

                    const isUnassigned = !route.assigned_to;
                    const centerProp = route.properties[Math.floor(route.properties.length / 2)];

                    // Add Route Center Bubble
                    if (centerProp && centerProp.lat && centerProp.lng && zoomLevel >= 8) {
                        features.push({
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [centerProp.lng, centerProp.lat] },
                            properties: {
                                isRouteCenter: true,
                                routeId: route.id,
                                routeNumber: `#${routeIdx + 1}`,
                                color: repColor
                            }
                        });
                    }

                    // Add Route Pins
                    if (showRouteDetails) {
                        route.properties.forEach((p, idx) => {
                            features.push({
                                type: 'Feature',
                                geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                                properties: {
                                    isRoutePin: true,
                                    routeId: route.id,
                                    color: repColor,
                                    isUnassigned: isUnassigned,
                                    label: mapSettings.labelType === 'number' ? p.house_number : (p.street_name || '').split(' ')[0]
                                }
                            });
                        });
                    }

                    // Add Route Line
                    if (showRouteLines && route.properties.length > 1) {
                        lines.push({
                            type: 'Feature',
                            geometry: {
                                type: 'LineString',
                                coordinates: route.properties.map(p => [p.lng, p.lat])
                            },
                            properties: {
                                color: repColor,
                                routeId: route.id
                            }
                        });
                    }
                });
        }

        return {
            points: { type: 'FeatureCollection', features },
            lines: { type: 'FeatureCollection', features: lines }
        };
    }, [mode, activeRoute, hydratedSavedRoutes, analyzeZipFilter, repColors, ROUTE_COLORS, zoomLevel, showRouteDetails, showRouteLines, mapSettings.labelType]);


    // --------------------------------------------------------------------------------
    // 3. GENERATED ROUTES GEOJSON CONVERSION
    // --------------------------------------------------------------------------------
    const generatedRoutesGeoJSON = useMemo(() => {
        const features = [];
        const lines = [];

        if (mode === 'generate' && !activeRoute && filteredRoutes.length > 0) {
            filteredRoutes.forEach((route, rIdx) => {
                const routeColor = ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
                const centerProp = route.properties[Math.floor(route.properties.length / 2)];

                if (centerProp && centerProp.lat && centerProp.lng) {
                    features.push({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [centerProp.lng, centerProp.lat] },
                        properties: {
                            isRouteCenter: true,
                            routeId: route.id,
                            routeNumber: `#${rIdx + 1}`,
                            color: routeColor
                        }
                    });
                }

                if (showRouteDetails) {
                    route.properties.forEach(p => {
                        features.push({
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                            properties: {
                                isRoutePin: true,
                                routeId: route.id,
                                color: routeColor,
                            }
                        });
                    });
                }

                if (showRouteLines && route.properties.length > 1) {
                    lines.push({
                        type: 'Feature',
                        geometry: {
                            type: 'LineString',
                            coordinates: route.properties.map(p => [p.lng, p.lat])
                        },
                        properties: {
                            color: routeColor,
                            routeId: route.id
                        }
                    });
                }
            });
        }

        return {
            points: { type: 'FeatureCollection', features },
            lines: { type: 'FeatureCollection', features: lines }
        };
    }, [mode, activeRoute, filteredRoutes, ROUTE_COLORS, showRouteDetails, showRouteLines]);

    // --------------------------------------------------------------------------------
    // 4. ACTIVE ROUTE GEOJSON CONVERSION
    // --------------------------------------------------------------------------------
    const activeRouteGeoJSON = useMemo(() => {
        if (!activeRoute) return { points: { type: 'FeatureCollection', features: [] }, line: null };
        const points = [];
        activeRoute.properties.forEach((p, idx) => {
            points.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                properties: {
                    ...p,
                    index: idx,
                    color: idx === 0 ? '#22c55e' : '#f97316'
                }
            });
        });

        const line = {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: activeRoute.properties.map(p => [p.lng, p.lat])
            }
        };

        return {
            points: { type: 'FeatureCollection', features: points },
            line: { type: 'FeatureCollection', features: [line] }
        };
    }, [activeRoute]);


    // --------------------------------------------------------------------------------
    // 5. LAYER STYLES
    // --------------------------------------------------------------------------------

    // Base properties pins
    const layerStyleProperties = {
        id: 'user-properties-points',
        type: 'circle',
        source: 'user-properties',
        paint: {
            'circle-radius': [
                'case',
                ['get', 'isRecentlySold'], pinSize + 4,
                ['get', 'isUnvisited'], Math.max(2, pinSize - 2),
                pinSize
            ],
            'circle-color': [
                'case',
                ['get', 'isRecentlySold'], '#FF00FF',
                getStatusColor(STATUS_COLORS, STATUS_COLORS.OTHER)
            ],
            'circle-opacity': [
                'case',
                ['get', 'isRecentlySold'], 1,
                ['get', 'isUnvisited'], 0.3,
                mode === 'generate' ? 0.9 * mapSettings.pinOpacity : 0.5 * mapSettings.pinOpacity
            ],
            'circle-stroke-color': [
                'case',
                ['get', 'isRecentlySold'], '#FFFFFF',
                mapSettings.fillStyle === 'outline' ? getStatusColor(STATUS_COLORS, STATUS_COLORS.OTHER) : (['get', 'isUnvisited'] ? 'transparent' : (mapSettings.pinBorderColor || '#000'))
            ],
            'circle-stroke-width': [
                'case',
                ['get', 'isRecentlySold'], 2,
                mapSettings.fillStyle === 'outline' ? 2 : (['get', 'isUnvisited'] ? 0 : mapSettings.pinBorderWidth)
            ]
        }
    };

    return (
        <>
            {/* 1. Base Properties */}
            <Source id="user-properties" type="geojson" data={pinsGeoJSON}>
                <Layer {...layerStyleProperties} />
                {mapSettings.showLabels && (
                    <Layer
                        id="user-properties-labels"
                        type="symbol"
                        source="user-properties"
                        layout={{
                            'text-field': ['get', 'label'],
                            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                            'text-size': 10,
                            'text-offset': [0, 1.2],
                            'text-anchor': 'top'
                        }}
                        paint={{
                            'text-color': '#FFFFFF',
                            'text-halo-color': '#000000',
                            'text-halo-width': 1
                        }}
                    />
                )}
            </Source>

            {/* 2. Saved Routes Lines & Points */}
            <Source id="saved-routes-lines" type="geojson" data={savedRoutesGeoJSON.lines}>
                <Layer
                    id="saved-routes-lines-layer"
                    type="line"
                    source="saved-routes-lines"
                    paint={{
                        'line-color': ['get', 'color'],
                        'line-width': mapSettings.lineWidth || 3,
                        'line-opacity': mapSettings.lineOpacity || 0.8,
                        'line-dasharray': mapSettings.lineStyle === 'solid' ? [1] : [2, 2] // Simplified dash
                    }}
                />
            </Source>
            <Source id="saved-routes-points" type="geojson" data={savedRoutesGeoJSON.points}>
                <Layer
                    id="saved-routes-points-layer"
                    type="circle"
                    source="saved-routes-points"
                    filter={['==', ['get', 'isRoutePin'], true]}
                    paint={{
                        'circle-radius': pinSize,
                        'circle-color': ['get', 'color'],
                        'circle-opacity': [
                            'case',
                            ['get', 'isUnassigned'], 0.6 * mapSettings.pinOpacity,
                            0.8 * mapSettings.pinOpacity
                        ],
                        'circle-stroke-color': mapSettings.fillStyle === 'outline' ? ['get', 'color'] : (mapSettings.pinBorderColor || '#000'),
                        'circle-stroke-width': mapSettings.fillStyle === 'outline' ? 2 : mapSettings.pinBorderWidth
                    }}
                />
                <Layer
                    id="saved-routes-centers-layer"
                    type="circle"
                    source="saved-routes-points"
                    filter={['==', ['get', 'isRouteCenter'], true]}
                    paint={{
                        'circle-radius': 14,
                        'circle-color': '#000000',
                        'circle-opacity': 0.7,
                        'circle-stroke-color': ['get', 'color'],
                        'circle-stroke-width': 2
                    }}
                />
                <Layer
                    id="saved-routes-center-labels"
                    type="symbol"
                    source="saved-routes-points"
                    filter={['==', ['get', 'isRouteCenter'], true]}
                    layout={{
                        'text-field': ['get', 'routeNumber'],
                        'text-size': 10,
                        'text-allow-overlap': true
                    }}
                    paint={{
                        'text-color': ['get', 'color']
                    }}
                />
            </Source>

            {/* 3. Generated Routes Lines & Points */}
            <Source id="generated-routes-lines" type="geojson" data={generatedRoutesGeoJSON.lines}>
                <Layer
                    id="generated-routes-lines-layer"
                    type="line"
                    source="generated-routes-lines"
                    paint={{
                        'line-color': ['get', 'color'],
                        'line-width': mapSettings.lineWidth || 3,
                        'line-opacity': mapSettings.lineOpacity || 0.8,
                        'line-dasharray': mapSettings.lineStyle === 'solid' ? [1] : [2, 2]
                    }}
                />
            </Source>
            <Source id="generated-routes-points" type="geojson" data={generatedRoutesGeoJSON.points}>
                <Layer
                    id="generated-routes-points-layer"
                    type="circle"
                    source="generated-routes-points"
                    filter={['==', ['get', 'isRoutePin'], true]}
                    paint={{
                        'circle-radius': pinSize + 1,
                        'circle-color': ['get', 'color'],
                        'circle-opacity': 0.6 * mapSettings.pinOpacity,
                        'circle-stroke-color': mapSettings.fillStyle === 'outline' ? ['get', 'color'] : (mapSettings.pinBorderColor || '#000'),
                        'circle-stroke-width': mapSettings.pinBorderWidth || 1
                    }}
                />
                <Layer
                    id="generated-routes-centers-layer"
                    type="circle"
                    source="generated-routes-points"
                    filter={['==', ['get', 'isRouteCenter'], true]}
                    paint={{
                        'circle-radius': 16,
                        'circle-color': '#000000',
                        'circle-opacity': 0.8,
                        'circle-stroke-color': ['get', 'color'],
                        'circle-stroke-width': 3
                    }}
                />
                <Layer
                    id="generated-routes-center-labels"
                    type="symbol"
                    source="generated-routes-points"
                    filter={['==', ['get', 'isRouteCenter'], true]}
                    layout={{
                        'text-field': ['get', 'routeNumber'],
                        'text-size': 14,
                        'text-allow-overlap': true
                    }}
                    paint={{
                        'text-color': ['get', 'color']
                    }}
                />
            </Source>

            {/* 4. Active Route Lines & Points */}
            {activeRoute && (
                <>
                    <Source id="active-route-line" type="geojson" data={activeRouteGeoJSON.line}>
                        <Layer
                            id="active-route-line-layer"
                            type="line"
                            source="active-route-line"
                            paint={{
                                'line-color': BRAND.gold,
                                'line-width': mapSettings.lineWidth ? mapSettings.lineWidth + 2 : 4,
                                'line-opacity': mapSettings.lineOpacity ? Math.max(0.6, mapSettings.lineOpacity) : 0.8,
                            }}
                        />
                    </Source>
                    <Source id="active-route-points" type="geojson" data={activeRouteGeoJSON.points}>
                        <Layer
                            id="active-route-points-layer"
                            type="circle"
                            source="active-route-points"
                            paint={{
                                'circle-radius': 5,
                                'circle-color': ['get', 'color'],
                                'circle-opacity': 1,
                                'circle-stroke-color': '#ffffff',
                                'circle-stroke-width': 1.5
                            }}
                        />
                    </Source>
                </>
            )}

            {/* 5. Draw Polygon (Placeholder / Manual handling) */}
            {drawnPolygon && drawnPolygon.length > 2 && (
                <Source id="drawn-polygon-source" type="geojson" data={{
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [drawnPolygon.map(p => [p.lng, p.lat])]
                    }
                }}>
                    <Layer
                        id="drawn-polygon-fill"
                        type="fill"
                        paint={{
                            'fill-color': '#FFD93D',
                            'fill-opacity': 0.2
                        }}
                    />
                    <Layer
                        id="drawn-polygon-line"
                        type="line"
                        paint={{
                            'line-color': '#FFD93D',
                            'line-width': 2
                        }}
                    />
                </Source>
            )}

            {/* 6. Martin Vector Tiles (Phase 3 Integration) */}
            <Source
                id="martin-tiles"
                type="vector"
                url={`${import.meta.env.VITE_MARTIN_URL || 'http://localhost:3000'}/public.properties`}
            >
                {/* Points */}
                <Layer
                    id="martin-points"
                    type="circle"
                    source="martin-tiles"
                    source-layer="public.properties"
                    paint={{
                        'circle-radius': 4,
                        'circle-color': '#6C5CE7',
                        'circle-stroke-width': 1,
                        'circle-stroke-color': '#ffffff'
                    }}
                />
            </Source>
        </>
    );
}

