import React, { useState, useEffect, useRef } from 'react';
import { useMapEvents, useMap, Polygon, CircleMarker, Tooltip } from 'react-leaflet';
import L from 'leaflet';

export default function MapDrawTool({ active, onPointsUpdate, drawnPolygon, drawShape = 'circle', drawSizeMiles = 10 }) {
    const [points, setPoints] = useState([]);
    const map = useMap();
    const cursorLineRef = useRef(null);

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

    // Change cursor and disable map click default behavior when active
    useEffect(() => {
        const container = map.getContainer();
        if (active) {
            container.style.cursor = 'crosshair';
            map.doubleClickZoom.disable();
            map.dragging.disable(); // disable dragging to make clicking easier
        } else {
            container.style.cursor = '';
            map.doubleClickZoom.enable();
            map.dragging.enable();
        }
        return () => {
            container.style.cursor = '';
            map.doubleClickZoom.enable();
            if (map.dragging) map.dragging.enable();
        }
    }, [active, map]);

    useMapEvents({
        click(e) {
            if (!active) return;
            console.log(`[MapDrawTool] Clicked map! active shape=${drawShape} size=${drawSizeMiles}`);
            const generated = generateShape(e.latlng, drawShape, drawSizeMiles);
            console.log(`[MapDrawTool] Generated ${generated.length} points for Polygon:`, generated);
            setPoints(generated);
            if (onPointsUpdate) {
                onPointsUpdate(generated);
            }
        },
        mousemove(e) {
            if (!active) return;

            // Show preview of the shape that will be dropped
            const previewPoints = generateShape(e.latlng, drawShape, drawSizeMiles);

            if (!cursorLineRef.current) {
                cursorLineRef.current = L.polygon(previewPoints, {
                    color: '#FFD93D',
                    dashArray: '5,5',
                    weight: 2,
                    interactive: false,
                    fillOpacity: 0.1
                }).addTo(map);
            } else {
                cursorLineRef.current.setLatLngs(previewPoints);
            }
        }
    });

    useEffect(() => {
        if (!active) {
            setPoints([]);
            if (cursorLineRef.current) {
                cursorLineRef.current.remove();
                cursorLineRef.current = null;
            }
        }
    }, [active]);

    // Cleanup hover preview when unmounted or mode changes
    useEffect(() => {
        if (!active && cursorLineRef.current) {
            cursorLineRef.current.remove();
            cursorLineRef.current = null;
        }
    }, [active, drawShape, drawSizeMiles]);

    useEffect(() => {
        return () => {
            if (cursorLineRef.current) {
                cursorLineRef.current.remove();
                cursorLineRef.current = null;
            }
        };
    }, []);

    const displayPoints = active ? points : (drawnPolygon || []);

    if (displayPoints.length === 0) return null;

    const getAreaText = () => {
        return `~${drawSizeMiles} sq mi`;
    };

    return (
        <>
            {displayPoints.length > 2 && (
                <Polygon
                    positions={displayPoints}
                    pathOptions={{ fillColor: '#FFD93D', color: '#FFD93D', fillOpacity: 0.2, weight: active ? 0 : 2 }}
                >
                    <Tooltip permanent direction="center" className="bg-black/90 text-yellow-400 font-bold text-[10px] border border-yellow-500/50 rounded shadow-xl whitespace-nowrap text-center z-50">
                        {getAreaText()}
                    </Tooltip>
                </Polygon>
            )}
            {displayPoints.map((p, i) => (
                <CircleMarker
                    key={i}
                    center={p}
                    radius={active ? 4 : 2}
                    pathOptions={{ color: '#FFD93D', fillColor: '#000', fillOpacity: 1, weight: 1 }}
                />
            ))}
        </>
    );
}