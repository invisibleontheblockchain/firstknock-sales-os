import React, { useState, useEffect, useRef } from 'react';
import { useMap, Source, Layer, Marker } from 'react-map-gl/maplibre';
import * as turf from '@turf/turf';

export default function MapDrawTool({ active, onPointsUpdate, drawnPolygon, drawShape = 'circle', drawSizeMiles = 10 }) {
    const { current: map } = useMap();
    const [points, setPoints] = useState([]);
    const [previewPoints, setPreviewPoints] = useState([]);
    
    // Helper: generate shape points around a center using Turf.js
    const generateShape = (centerLngLat, shape, areaSqMiles) => {
        let radiusInMiles = 1;
        if (shape === 'circle') {
            radiusInMiles = Math.sqrt(areaSqMiles / Math.PI);
        } else if (shape === 'square') {
             radiusInMiles = Math.sqrt(areaSqMiles);
        } else if (shape === 'triangle') {
             radiusInMiles = Math.sqrt(areaSqMiles / (Math.sqrt(3)/4));
        }

        const center = [centerLngLat.lng, centerLngLat.lat];
        let polyFeature;
        
        if (shape === 'circle') {
             polyFeature = turf.circle(center, radiusInMiles, { units: 'miles', steps: 32 });
        } else if (shape === 'square') {
             // Create a bounding box then convert to polygon
             const halfSide = radiusInMiles / 2;
             const pt = turf.point(center);
             const n = turf.destination(pt, halfSide, 0, {units: 'miles'}).geometry.coordinates[1];
             const s = turf.destination(pt, halfSide, 180, {units: 'miles'}).geometry.coordinates[1];
             const e = turf.destination(pt, halfSide, 90, {units: 'miles'}).geometry.coordinates[0];
             const w = turf.destination(pt, halfSide, -90, {units: 'miles'}).geometry.coordinates[0];
             polyFeature = turf.bboxPolygon([w, s, e, n]);
        } else if (shape === 'triangle') {
             // Equilateral triangle around center
             const pt = turf.point(center);
             const p1 = turf.destination(pt, radiusInMiles, 0, {units: 'miles'}).geometry.coordinates;
             const p2 = turf.destination(pt, radiusInMiles, 120, {units: 'miles'}).geometry.coordinates;
             const p3 = turf.destination(pt, radiusInMiles, 240, {units: 'miles'}).geometry.coordinates;
             polyFeature = turf.polygon([[p1, p2, p3, p1]]);
        }

        // Return array of {lat, lng} objects to match previous interface
        if (polyFeature && polyFeature.geometry && polyFeature.geometry.coordinates[0]) {
             return polyFeature.geometry.coordinates[0].map(coord => ({
                 lng: coord[0],
                 lat: coord[1]
             }));
        }
        return [];
    };

    useEffect(() => {
        if (!map) return;
        const canvas = map.getCanvas();
        
        const handleMouseMove = (e) => {
            if (!active) return;
            setPreviewPoints(generateShape(e.lngLat, drawShape, drawSizeMiles));
        };

        const handleClick = (e) => {
            if (!active) return;
             console.log(`[MapDrawTool] Clicked map! active shape=${drawShape} size=${drawSizeMiles}`);
             const generated = generateShape(e.lngLat, drawShape, drawSizeMiles);
             setPoints(generated);
             if (onPointsUpdate) {
                 onPointsUpdate(generated);
             }
        };

        if (active) {
            canvas.style.cursor = 'crosshair';
            map.dragPan.disable();
            map.doubleClickZoom.disable();
            map.on('mousemove', handleMouseMove);
            map.on('click', handleClick);
        } else {
            canvas.style.cursor = '';
            map.dragPan.enable();
            map.doubleClickZoom.enable();
            setPreviewPoints([]);
        }

        return () => {
             map.off('mousemove', handleMouseMove);
             map.off('click', handleClick);
             canvas.style.cursor = '';
             map.dragPan.enable();
             map.doubleClickZoom.enable();
        };
    }, [map, active, drawShape, drawSizeMiles]);


    useEffect(() => {
        if (!active) {
            setPoints([]);
            setPreviewPoints([]);
        }
    }, [active]);

    const displayPoints = active ? points : (drawnPolygon || []);
    
    const getAreaText = () => {
        return `~${drawSizeMiles} sq mi`;
    };

    // GeoJSON for drawn shape
    const polygonGeoJSON = useMemo(() => {
        if (displayPoints.length > 2) {
            return {
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [displayPoints.map(p => [p.lng, p.lat])]
                    }
                }]
            };
        }
        return null;
    }, [displayPoints]);

    // GeoJSON for preview shape (hover)
    const previewGeoJSON = useMemo(() => {
        if (active && previewPoints.length > 2) {
            return {
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [previewPoints.map(p => [p.lng, p.lat])]
                    }
                }]
            };
        }
        return null;
    }, [active, previewPoints]);

    return (
        <>
            {/* Real Drawn Polygon */}
            {polygonGeoJSON && (
                <Source id="drawn-polygon" type="geojson" data={polygonGeoJSON}>
                     <Layer 
                        id="drawn-polygon-fill" 
                        type="fill" 
                        paint={{'fill-color': '#FFD93D', 'fill-opacity': 0.2}} 
                     />
                     <Layer 
                        id="drawn-polygon-line" 
                        type="line" 
                        paint={{'line-color': '#FFD93D', 'line-width': active ? 0 : 2}} 
                     />
                </Source>
            )}

            {/* Preview Polygon */}
            {previewGeoJSON && (
                <Source id="preview-polygon" type="geojson" data={previewGeoJSON}>
                     <Layer 
                        id="preview-polygon-line" 
                        type="line" 
                        paint={{'line-color': '#FFD93D', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.8}} 
                     />
                     <Layer 
                         id="preview-polygon-fill" 
                         type="fill" 
                         paint={{'fill-color': '#FFD93D', 'fill-opacity': 0.1}} 
                     />
                </Source>
            )}
            
            {/* Tooltip equivalent using a Marker centered on the bounds */}
            {displayPoints.length > 2 && (
                 <Marker 
                    longitude={displayPoints.reduce((sum, p) => sum + p.lng, 0) / displayPoints.length}
                    latitude={displayPoints.reduce((sum, p) => sum + p.lat, 0) / displayPoints.length}
                    anchor="center"
                 >
                     <div className="bg-black/90 text-yellow-400 font-bold text-[10px] border border-yellow-500/50 rounded shadow-xl whitespace-nowrap text-center px-2 py-1 z-50 pointer-events-none">
                         {getAreaText()}
                     </div>
                 </Marker>
            )}

            {/* Vertices shown as points */}
            {displayPoints.length > 0 && (
                <Source id="drawn-vertices" type="geojson" data={{
                    type: 'FeatureCollection',
                    features: displayPoints.map(p => ({
                         type: 'Feature',
                         geometry: { type: 'Point', coordinates: [p.lng, p.lat] }
                    }))
                }}>
                    <Layer
                        id="drawn-vertices-layer"
                        type="circle"
                        paint={{
                            'circle-radius': active ? 4 : 2,
                            'circle-color': '#000',
                            'circle-stroke-color': '#FFD93D',
                            'circle-stroke-width': 1
                        }}
                    />
                </Source>
            )}
        </>
    );
}
