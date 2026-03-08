// @ts-nocheck
import React, { useMemo, useEffect } from 'react';
import { useMap, Source, Layer, Marker } from 'react-map-gl/maplibre';
import { DarkRoomClient } from '@/components/logic/neonClient';

export default function ManagerMapLayers({
    mode, activeRoute, zoomLevel, viewMode, hydratedSavedRoutes, filteredRoutes,
    ROUTE_COLORS, effectiveProperties, darkRoomProperties, darkRoomClusters,
    heatmapData, previewRoute, analyzeZipFilter, quickFilter, zipCodeFilter,
    soldDateFilter, drawnPolygon, assignedHashes, showAllProperties,
    showRouteDetails, showRouteLines, highlightRecentlySold, mapSettings,
    pinSize, lineDashArray, STATUS_COLORS, repColors, BRAND,
    setActiveRoute, setSelectedProperty, mapRef, isPointInPolygon,
    getHeatColor, parseISO, subMonths, isAfter, darkRoom,
}) {
    const { current: map } = useMap();

    // -------------------------------------------------------------
    // Data processing for GeoJSON sources
    // -------------------------------------------------------------

    // 1. User Pins
    const userPinsGeoData = useMemo(() => {
        if (viewMode !== 'pins' || zoomLevel < 13 || activeRoute || !(mode === 'generate' || showAllProperties)) {
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
            if (!p.lat || !p.lng) continue;

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

            const isUnvisited = ['ELIGIBLE', 'NO_ANSWER', 'OTHER'].includes(p.effective_status);
            let recencyColor = null;
            let recencyRadius = 0;
            if (highlightRecentlySold && p.sold_date) {
                const daysAgo = Math.floor((Date.now() - new Date(p.sold_date).getTime()) / (1000 * 60 * 60 * 24));
                if (daysAgo >= 0 && daysAgo <= 30) { recencyColor = '#22c55e'; recencyRadius = 4; }
                else if (daysAgo <= 60) { recencyColor = '#eab308'; recencyRadius = 3; }
                else if (daysAgo <= 90) { recencyColor = '#f97316'; recencyRadius = 2; }
            }
            const isRecent = recencyColor !== null;
            const fillColor = isRecent ? recencyColor : (STATUS_COLORS[p.effective_status] || STATUS_COLORS.OTHER);
            const radius = isRecent ? pinSize + recencyRadius : (isUnvisited ? Math.max(2, pinSize - 2) : pinSize);
            const opacity = isRecent ? 1 : (isUnvisited ? 0.3 : ((mode === 'generate' ? 0.9 : 0.5) * mapSettings.pinOpacity));
            const color = isRecent ? '#FFFFFF' : (mapSettings.fillStyle === 'outline' ? fillColor : (isUnvisited ? 'transparent' : (mapSettings.pinBorderColor || '#000')));
            const weight = isRecent ? 2 : (mapSettings.fillStyle === 'outline' ? 2 : (isUnvisited ? 0 : mapSettings.pinBorderWidth));
            
            let label = '';
            if (mapSettings.showLabels) {
                label = mapSettings.labelType === 'number' ? String(p.house_number || '') 
                    : mapSettings.labelType === 'status' ? (p.effective_status || '').slice(0, 1) 
                    : (p.street_name || '').split(' ')[0];
            }

            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                properties: { id: p.id, fillColor, radius, opacity, color, weight, label }
            });
        }
        return { type: 'FeatureCollection', features };
    }, [viewMode, zoomLevel, activeRoute, mode, showAllProperties, effectiveProperties, assignedHashes, zipCodeFilter, drawnPolygon, soldDateFilter, quickFilter, highlightRecentlySold, pinSize, mapSettings, STATUS_COLORS, subMonths, isPointInPolygon]);

    // 2. Heatmap
    const heatmapGeoData = useMemo(() => {
        if (viewMode !== 'heatmap' || zoomLevel < 10) return { type: 'FeatureCollection', features: [] };
        return {
            type: 'FeatureCollection',
            features: heatmapData.map(cell => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [cell.lng, cell.lat] },
                properties: {
                    fillColor: getHeatColor(cell.avgScore),
                    opacity: 0.5 + (cell.intensity * 0.3)
                }
            }))
        };
    }, [viewMode, zoomLevel, heatmapData, getHeatColor]);

    // 3. Dark Room Pins
    const darkRoomPinsGeoData = useMemo(() => {
        if (zoomLevel < 10) return { type: 'FeatureCollection', features: [] };
        return {
            type: 'FeatureCollection',
            features: darkRoomProperties.map(p => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                properties: {
                    id: p.id,
                    fillColor: DarkRoomClient.getScoreColor(p.smart_score)
                }
            }))
        };
    }, [zoomLevel, darkRoomProperties]);

    // 4. Saved Routes (Lines & Pins)
    const savedRoutesLines = useMemo(() => {
        if (!(mode === 'analyze' || mode === 'generate') || activeRoute || zoomLevel < 8 || !showRouteLines) return { type: 'FeatureCollection', features: [] };
        const features = hydratedSavedRoutes.filter(route => {
            if (mode === 'generate') return true;
            if (analyzeZipFilter === 'all') return true;
            return route.properties.some(p => p.zip_code === analyzeZipFilter);
        }).map((route, routeIdx) => {
            const repColor = route.assigned_to ? (repColors[route.assigned_to] || '#3b82f6') : ROUTE_COLORS[routeIdx % ROUTE_COLORS.length];
            return {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: route.properties.filter(p => p.lat && p.lng).map(p => [p.lng, p.lat]) },
                properties: { route_id: route.id, color: repColor }
            };
        });
        return { type: 'FeatureCollection', features };
    }, [mode, activeRoute, zoomLevel, showRouteLines, hydratedSavedRoutes, analyzeZipFilter, repColors, ROUTE_COLORS]);

    const savedRoutesPins = useMemo(() => {
        if (!(mode === 'analyze' || mode === 'generate') || activeRoute || zoomLevel < 8 || !showRouteDetails) return { type: 'FeatureCollection', features: [] };
        const features = [];
        hydratedSavedRoutes.filter(route => {
            if (mode === 'generate') return true;
            if (analyzeZipFilter === 'all') return true;
            return route.properties.some(p => p.zip_code === analyzeZipFilter);
        }).forEach((route, routeIdx) => {
            const repColor = route.assigned_to ? (repColors[route.assigned_to] || '#3b82f6') : ROUTE_COLORS[routeIdx % ROUTE_COLORS.length];
            const isUnassigned = !route.assigned_to;
            route.properties.forEach((p, idx) => {
                if (!p || !p.lat || !p.lng) return;
                if (quickFilter !== 'all') {
                    if (quickFilter === 'eligible' && p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'NO_ANSWER') return;
                    if (quickFilter === 'sold' && p.effective_status !== 'SOLD' && p.effective_status !== 'QUALIFIED') return;
                    if (quickFilter === 'rejected' && p.effective_status !== 'HARD_NO') return;
                }
                
                let label = '';
                if (mapSettings.showLabels) {
                    label = mapSettings.labelType === 'number' ? String(p.house_number || '') 
                        : mapSettings.labelType === 'status' ? (p.effective_status || '').slice(0, 1) 
                        : (p.street_name || '').split(' ')[0];
                }

                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                    properties: {
                        route_id: route.id,
                        fillColor: repColor,
                        fillOpacity: (isUnassigned ? 0.6 : 0.8) * mapSettings.pinOpacity,
                        color: mapSettings.fillStyle === 'outline' ? repColor : (mapSettings.pinBorderColor || '#000'),
                        weight: mapSettings.fillStyle === 'outline' ? 2 : mapSettings.pinBorderWidth,
                        label
                    }
                });
            });
        });
        return { type: 'FeatureCollection', features };
    }, [mode, activeRoute, zoomLevel, showRouteDetails, hydratedSavedRoutes, analyzeZipFilter, repColors, ROUTE_COLORS, quickFilter, mapSettings]);

    // 5. Generate Mode New Routes
    const generatedRoutesLines = useMemo(() => {
        if (mode !== 'generate' || activeRoute || !showRouteLines) return { type: 'FeatureCollection', features: [] };
        return {
            type: 'FeatureCollection',
            features: filteredRoutes.map((route, rIdx) => ({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: route.properties.filter(p => p.lat && p.lng).map(p => [p.lng, p.lat]) },
                properties: { route_id: route.id, color: ROUTE_COLORS[rIdx % ROUTE_COLORS.length] }
            }))
        };
    }, [mode, activeRoute, showRouteLines, filteredRoutes, ROUTE_COLORS]);

    const generatedRoutesPins = useMemo(() => {
        if (mode !== 'generate' || activeRoute || !showRouteDetails) return { type: 'FeatureCollection', features: [] };
        const features = [];
        filteredRoutes.forEach((route, rIdx) => {
            const routeColor = ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
            route.properties.forEach((p, idx) => {
                if (!p || !p.lat || !p.lng) return;
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                    properties: {
                        route_id: route.id,
                        fillColor: routeColor,
                        fillOpacity: 0.6 * mapSettings.pinOpacity,
                        color: mapSettings.fillStyle === 'outline' ? routeColor : (mapSettings.pinBorderColor || '#000'),
                        weight: mapSettings.pinBorderWidth
                    }
                });
            });
        });
        return { type: 'FeatureCollection', features };
    }, [mode, activeRoute, showRouteDetails, filteredRoutes, ROUTE_COLORS, mapSettings]);


    // 6. Preview Route
    const previewRouteLines = useMemo(() => {
        if (!previewRoute || activeRoute) return { type: 'FeatureCollection', features: [] };
        return {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: previewRoute.properties.filter(p => p.lat && p.lng).map(p => [p.lng, p.lat]) },
                properties: { color: BRAND.gold }
            }]
        };
    }, [previewRoute, activeRoute, BRAND.gold]);

    // 7. Active Route
    const activeRouteLines = useMemo(() => {
        if (!activeRoute) return { type: 'FeatureCollection', features: [] };
        return {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: activeRoute.properties.filter(p => p.lat && p.lng).map(p => [p.lng, p.lat]) },
                properties: { color: BRAND.gold }
            }]
        };
    }, [activeRoute, BRAND.gold]);


    // -------------------------------------------------------------
    // Interactions (Clicks)
    // -------------------------------------------------------------
    useEffect(() => {
        if (!map) return;
        const handleEntityClick = async (e) => {
            if (!e.features || e.features.length === 0) return;
            const feature = e.features[0];
            const p = feature.properties;
            
            // Route Click
            if (p.route_id) {
                const route = hydratedSavedRoutes.find(r => r.id === p.route_id) || filteredRoutes.find(r => r.id === p.route_id);
                if (route) setActiveRoute(route);
                return;
            }
            
            // Property Pin Click
            if (p.id) {
                if (feature.layer.id === 'layer-dark-room-pins') {
                    const details = await darkRoom.fetchPropertyDetails(p.id);
                    setSelectedProperty(details || { id: p.id }); // Fallback sparse
                } else {
                    const realProp = effectiveProperties.find(x => x.id === p.id);
                    if (realProp) setSelectedProperty(realProp);
                }
            }
        };

        const layerIds = ['layer-user-pins', 'layer-dark-room-pins', 'layer-saved-routes-pins', 'layer-saved-routes-lines', 'layer-generated-routes-pins', 'layer-generated-routes-lines'];
        
        // Add listeners
        layerIds.forEach(id => {
            map.on('click', id, handleEntityClick);
            map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
        });

        return () => {
            layerIds.forEach(id => {
                map.off('click', id, handleEntityClick);
                map.off('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
                map.off('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
            });
        };
    }, [map, activeRoute, hydratedSavedRoutes, filteredRoutes, effectiveProperties, setActiveRoute, setSelectedProperty, darkRoom]);


    // Determine dash array
    const dashArrayParsed = lineDashArray ? lineDashArray.split(',').map(Number) : [1];

    return (
        <>
            {/* HEATMAP */}
            <Source id="src-heatmap" type="geojson" data={heatmapGeoData}>
                <Layer
                    id="layer-heatmap"
                    type="circle"
                    paint={{
                        'circle-color': ['get', 'fillColor'],
                        'circle-opacity': ['get', 'opacity'],
                        'circle-radius': 15,
                        'circle-blur': 0.8
                    }}
                />
            </Source>

            {/* DARK ROOM PINS */}
            <Source id="src-dark-room-pins" type="geojson" data={darkRoomPinsGeoData}>
                <Layer
                    id="layer-dark-room-pins"
                    type="circle"
                    paint={{
                        'circle-color': ['get', 'fillColor'],
                        'circle-opacity': 0.85,
                        'circle-radius': 5,
                        'circle-stroke-color': '#000',
                        'circle-stroke-width': 1,
                    }}
                />
            </Source>

            {/* DARK ROOM CLUSTERS (Markers) */}
            {zoomLevel < 10 && darkRoomClusters.map(cluster => (
                <Marker
                    key={cluster.id}
                    longitude={cluster.lng}
                    latitude={cluster.lat}
                    anchor="center"
                    onClick={(e) => {
                        e.originalEvent.stopPropagation();
                        if (map) map.flyTo({ center: [cluster.lng, cluster.lat], zoom: Math.min(zoomLevel + 3, 16) });
                    }}
                    style={{ cursor: 'pointer' }}
                >
                    <div style={{
                        width: `${Math.min(50, 16 + Math.sqrt(cluster.count) * 4)}px`,
                        height: `${Math.min(50, 16 + Math.sqrt(cluster.count) * 4)}px`,
                        backgroundColor: DarkRoomClient.getScoreColor(cluster.avgScore),
                        borderRadius: '50%',
                        border: '2px solid #000',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: 0.8,
                        color: '#fff',
                        fontWeight: 'bold',
                        fontSize: '10px',
                        textShadow: '0 0 3px #000'
                    }}>
                        {cluster.count}
                    </div>
                </Marker>
            ))}

            {/* SAVED ROUTES */}
            <Source id="src-saved-routes-lines" type="geojson" data={savedRoutesLines}>
                <Layer
                    id="layer-saved-routes-lines"
                    type="line"
                    paint={{
                        'line-color': ['get', 'color'],
                        'line-width': mapSettings.lineWidth || 3,
                        'line-opacity': mapSettings.lineOpacity || 0.8,
                        'line-dasharray': lineDashArray ? dashArrayParsed : [1]
                    }}
                />
            </Source>
            <Source id="src-saved-routes-pins" type="geojson" data={savedRoutesPins}>
                <Layer
                    id="layer-saved-routes-pins"
                    type="circle"
                    paint={{
                        'circle-color': ['get', 'fillColor'],
                        'circle-opacity': ['get', 'fillOpacity'],
                        'circle-radius': pinSize,
                        'circle-stroke-color': ['get', 'color'],
                        'circle-stroke-width': ['get', 'weight']
                    }}
                />
            </Source>
            
            {/* Saved Routes Labels (Center Markers) */}
            {(mode === 'analyze' || mode === 'generate') && !activeRoute && zoomLevel >= 8 && hydratedSavedRoutes.filter(route => {
                if (mode === 'generate') return true;
                if (analyzeZipFilter === 'all') return true;
                return route.properties.some(p => p.zip_code === analyzeZipFilter);
            }).map((route, rIdx) => {
                const centerProp = route.properties[Math.floor(route.properties.length / 2)];
                const repColor = route.assigned_to ? (repColors[route.assigned_to] || '#3b82f6') : ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
                if (!centerProp || !centerProp.lat || !centerProp.lng) return null;
                return (
                    <Marker key={`saved-lbl-${route.id}`} longitude={centerProp.lng} latitude={centerProp.lat} anchor="center"
                        onClick={e => { e.originalEvent.stopPropagation(); setActiveRoute(route); }}>
                        <div style={{ backgroundColor: 'rgba(0,0,0,0.7)', border: `2px solid ${repColor}`, borderRadius: '50%', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                            <span style={{ color: repColor, fontWeight: '900', fontSize: '10px' }}>#{rIdx + 1}</span>
                        </div>
                    </Marker>
                );
            })}

            {/* GENERATED ROUTES */}
            <Source id="src-generated-routes-lines" type="geojson" data={generatedRoutesLines}>
                <Layer
                    id="layer-generated-routes-lines"
                    type="line"
                    paint={{
                        'line-color': ['get', 'color'],
                        'line-width': mapSettings.lineWidth || 3,
                        'line-opacity': mapSettings.lineOpacity || 0.8,
                        'line-dasharray': lineDashArray ? dashArrayParsed : [1]
                    }}
                />
            </Source>
            <Source id="src-generated-routes-pins" type="geojson" data={generatedRoutesPins}>
                <Layer
                    id="layer-generated-routes-pins"
                    type="circle"
                    paint={{
                        'circle-color': ['get', 'fillColor'],
                        'circle-opacity': ['get', 'fillOpacity'],
                        'circle-radius': pinSize + 1,
                        'circle-stroke-color': ['get', 'color'],
                        'circle-stroke-width': ['get', 'weight']
                    }}
                />
            </Source>
            
            {/* Generated Routes Labels (Center Markers) */}
            {mode === 'generate' && !activeRoute && filteredRoutes.map((route, rIdx) => {
                const centerProp = route.properties[Math.floor(route.properties.length / 2)];
                const routeColor = ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
                if (!centerProp || !centerProp.lat || !centerProp.lng) return null;
                return (
                    <Marker key={`gen-lbl-${route.id}`} longitude={centerProp.lng} latitude={centerProp.lat} anchor="center"
                        onClick={e => { e.originalEvent.stopPropagation(); setActiveRoute(route); }}>
                        <div style={{ backgroundColor: 'rgba(0,0,0,0.8)', border: `3px solid ${routeColor}`, borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                            <span style={{ color: routeColor, fontWeight: '900', fontSize: '14px' }}>#{rIdx + 1}</span>
                        </div>
                    </Marker>
                );
            })}


            {/* USER PINS */}
            <Source id="src-user-pins" type="geojson" data={userPinsGeoData}>
                <Layer
                    id="layer-user-pins"
                    type="circle"
                    paint={{
                        'circle-color': ['get', 'fillColor'],
                        'circle-opacity': ['get', 'opacity'],
                        'circle-radius': ['get', 'radius'],
                        'circle-stroke-color': ['get', 'color'],
                        'circle-stroke-width': ['get', 'weight']
                    }}
                />
                {mapSettings.showLabels && (
                    <Layer
                        id="layer-user-pins-labels"
                        type="symbol"
                        layout={{
                            'text-field': ['get', 'label'],
                            'text-size': 9,
                            'text-anchor': 'center'
                        }}
                        paint={{
                            'text-color': '#ffffff',
                            'text-halo-color': '#000000',
                            'text-halo-width': 1
                        }}
                    />
                )}
            </Source>


            {/* PREVIEW ROUTE */}
            <Source id="src-preview-route" type="geojson" data={previewRouteLines}>
                <Layer
                    id="layer-preview-route"
                    type="line"
                    paint={{
                        'line-color': ['get', 'color'],
                        'line-width': 3,
                        'line-opacity': 0.6,
                        'line-dasharray': [5, 10]
                    }}
                />
            </Source>


            {/* ACTIVE ROUTE */}
            <Source id="src-active-route" type="geojson" data={activeRouteLines}>
                <Layer
                    id="layer-active-route"
                    type="line"
                    paint={{
                        'line-color': ['get', 'color'],
                        'line-width': mapSettings.lineWidth ? mapSettings.lineWidth + 2 : 4,
                        'line-opacity': mapSettings.lineOpacity ? Math.max(0.6, mapSettings.lineOpacity) : 0.8,
                        'line-dasharray': lineDashArray ? dashArrayParsed : [1]
                    }}
                />
            </Source>

            {/* Active Route Pins */}
            {activeRoute && activeRoute.properties.map((p, idx) => {
                if (!p || !p.lat || !p.lng) return null;
                return (
                    <Marker
                        key={`active-pin-${p.address_hash}`}
                        longitude={p.lng} latitude={p.lat} anchor="center"
                        onClick={e => { e.originalEvent.stopPropagation(); setSelectedProperty(p); }}
                        style={{ zIndex: 10 + idx }}
                    >
                        <div style={{
                            backgroundColor: idx === 0 ? '#22c55e' : '#f97316',
                            border: '1.5px solid #fff',
                            borderRadius: '50%',
                            width: '10px', height: '10px',
                            cursor: 'pointer',
                            position: 'relative'
                        }}>
                            <div style={{
                                position: 'absolute', top: '-18px', left: '50%', transform: 'translateX(-50%)',
                                color: '#fff', fontWeight: 'bold', fontSize: '11px', textShadow: '0 1px 3px #000, 0 0 5px #000',
                                pointerEvents: 'none'
                            }}>
                                {idx + 1}
                            </div>
                        </div>
                    </Marker>
                );
            })}
        </>
    );
}