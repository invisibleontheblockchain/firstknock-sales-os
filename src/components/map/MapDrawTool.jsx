// @ts-nocheck
import React, { useState, useEffect, useMemo } from 'react';
import { useMap, Source, Layer, Marker } from 'react-map-gl/maplibre';

export default function MapDrawTool({ active, onPointsUpdate, onConfirm, drawnPolygon, drawShape = 'circle', drawSizeMiles = 10 }) {
    const [points, setPoints] = useState([]);
    const [previewPoints, setPreviewPoints] = useState([]);
    const { current: map } = useMap();

    // Helper: generate shape points around a center
    const generateShape = (centerLatlng, shape, areaSqMiles) => {
        let radiusInMiles = 1;
        if (shape === 'circle') {
            radiusInMiles = Math.sqrt(areaSqMiles / Math.PI);
        } else if (shape === 'square') {
            radiusInMiles = Math.sqrt(areaSqMiles / 4);
        } else if (shape === 'triangle') {
            radiusInMiles = Math.sqrt(areaSqMiles / 2);
        }

        // approximate miles to degrees (rough estimate: 1 lat deg = 69 miles, 1 lng deg at 40N = ~53 miles)
        const radiusLat = radiusInMiles / 69.0;
        const radiusLng = radiusInMiles / (69.0 * Math.cos(centerLatlng.lat * Math.PI / 180));

        let newPoints = [];
        if (shape === 'circle') {
            // Generate a 32-point polygon approximating a circle
            for (let i = 0; i < 32; i++) {
                const angle = (i / 32) * Math.PI * 2;
                newPoints.push({
                    lat: centerLatlng.lat + (Math.cos(angle) * radiusLat),
                    lng: centerLatlng.lng + (Math.sin(angle) * radiusLng)
                });
            }
        } else if (shape === 'square') {
            newPoints = [
                { lat: centerLatlng.lat + radiusLat, lng: centerLatlng.lng - radiusLng },
                { lat: centerLatlng.lat + radiusLat, lng: centerLatlng.lng + radiusLng },
                { lat: centerLatlng.lat - radiusLat, lng: centerLatlng.lng + radiusLng },
                { lat: centerLatlng.lat - radiusLat, lng: centerLatlng.lng - radiusLng }
            ];
        } else if (shape === 'triangle') {
            newPoints = [
                { lat: centerLatlng.lat + radiusLat, lng: centerLatlng.lng },
                { lat: centerLatlng.lat - radiusLat, lng: centerLatlng.lng + radiusLng },
                { lat: centerLatlng.lat - radiusLat, lng: centerLatlng.lng - radiusLng }
            ];
        }
        return newPoints;
    };

    // Change cursor when active
    useEffect(() => {
        if (!map) return;
        const container = map.getContainer();
        if (active) {
            container.style.cursor = 'crosshair';
            map.doubleClickZoom.disable();
        } else {
            container.style.cursor = '';
            map.doubleClickZoom.enable();
            setPreviewPoints([]);
        }
        return () => {
            if (map) {
                container.style.cursor = '';
                map.doubleClickZoom.enable();
            }
        };
    }, [active, map]);

    // Handle map events
    useEffect(() => {
        if (!active || !map) return;

        const onClick = (e) => {
            const latlng = { lat: e.lngLat.lat, lng: e.lngLat.lng };
            const generated = generateShape(latlng, drawShape, drawSizeMiles);
            setPoints(generated);
            if (onPointsUpdate) {
                onPointsUpdate(generated);
            }
            if (onConfirm) {
                onConfirm(generated);
            }
        };

        const onMouseMove = (e) => {
            const latlng = { lat: e.lngLat.lat, lng: e.lngLat.lng };
            setPreviewPoints(generateShape(latlng, drawShape, drawSizeMiles));
        };

        map.on('click', onClick);
        map.on('mousemove', onMouseMove);

        return () => {
            map.off('click', onClick);
            map.off('mousemove', onMouseMove);
        };
    }, [active, map, drawShape, drawSizeMiles, onPointsUpdate, onConfirm]);

    useEffect(() => {
        if (!active) {
            setPoints([]);
            setPreviewPoints([]);
        }
    }, [active]);

    const displayPoints = active ? points : (drawnPolygon || []);
    
    // Convert to GeoJSON
    const activePolygonGeoJSON = useMemo(() => {
        if (displayPoints.length < 3) return null;
        // Make sure it's closed
        const coords = displayPoints.map(p => [p.lng, p.lat]);
        coords.push([...coords[0]]);
        return {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [coords] },
                properties: {}
            }]
        };
    }, [displayPoints]);

    const activePointsGeoJSON = useMemo(() => {
        if (displayPoints.length === 0) return null;
        return {
            type: 'FeatureCollection',
            features: displayPoints.map(p => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                properties: {}
            }))
        };
    }, [displayPoints]);

    const previewGeoJSON = useMemo(() => {
        if (!active || previewPoints.length < 3) return null;
        const coords = previewPoints.map(p => [p.lng, p.lat]);
        coords.push([...coords[0]]);
        return {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [coords] },
                properties: {}
            }]
        };
    }, [active, previewPoints]);

    // Centroid for label
    const centroid = useMemo(() => {
        if (displayPoints.length < 3) return null;
        const sumLng = displayPoints.reduce((s, p) => s + p.lng, 0);
        const sumLat = displayPoints.reduce((s, p) => s + p.lat, 0);
        return { lng: sumLng / displayPoints.length, lat: sumLat / displayPoints.length };
    }, [displayPoints]);


    return (
        <>
            {/* Draw Polygon Preview Follow Cursor */}
            {previewGeoJSON && (
                <Source id="draw-preview" type="geojson" data={previewGeoJSON}>
                    <Layer
                        id="draw-preview-fill"
                        type="fill"
                        paint={{ 'fill-color': '#FFD93D', 'fill-opacity': 0.1 }}
                    />
                    <Layer
                        id="draw-preview-line"
                        type="line"
                        paint={{ 'line-color': '#FFD93D', 'line-width': 2, 'line-dasharray': [5, 5] }}
                    />
                </Source>
            )}

            {/* Dropped Polygon */}
            {activePolygonGeoJSON && (
                <Source id="draw-active" type="geojson" data={activePolygonGeoJSON}>
                    <Layer
                        id="draw-active-fill"
                        type="fill"
                        paint={{ 'fill-color': '#FFD93D', 'fill-opacity': 0.2 }}
                    />
                    <Layer
                        id="draw-active-line"
                        type="line"
                        paint={{ 'line-color': '#FFD93D', 'line-width': active ? 0 : 2 }}
                    />
                </Source>
            )}

            {/* Polygon Corner Nodes */}
            {activePointsGeoJSON && (
                <Source id="draw-active-points" type="geojson" data={activePointsGeoJSON}>
                    <Layer
                        id="draw-active-points-layer"
                        type="circle"
                        paint={{ 'circle-color': '#000', 'circle-radius': active ? 4 : 2, 'circle-stroke-color': '#FFD93D', 'circle-stroke-width': 1 }}
                    />
                </Source>
            )}

            {/* Label Tooltip */}
            {centroid && (
                <Marker longitude={centroid.lng} latitude={centroid.lat} anchor="center">
                    <div className="bg-black/90 text-yellow-400 font-bold text-[10px] border border-yellow-500/50 rounded shadow-xl whitespace-nowrap text-center px-1.5 py-0.5">
                        ~{drawSizeMiles} sq mi
                    </div>
                </Marker>
            )}
        </>
    );
}