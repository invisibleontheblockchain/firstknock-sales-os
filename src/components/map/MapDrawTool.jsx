import React, { useState, useEffect, useRef } from 'react';
import { useMapEvents, useMap, Polygon, CircleMarker, Circle, Tooltip } from 'react-leaflet';
import L from 'leaflet';

export default function MapDrawTool({ active, onPointsUpdate, onConfirm, drawnPolygon, drawShape = 'circle', drawSizeMiles = 10 }) {
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

    // Change cursor when active — do NOT disable dragging (causes frozen map)
    useEffect(() => {
        const container = map.getContainer();
        if (active) {
            container.style.cursor = 'crosshair';
            map.doubleClickZoom.disable();
        } else {
            container.style.cursor = '';
            map.doubleClickZoom.enable();
        }
        return () => {
            container.style.cursor = '';
            map.doubleClickZoom.enable();
        };
    }, [active, map]);

    useMapEvents({
        click(e) {
            if (!active) return;
            const generated = generateShape(e.latlng, drawShape, drawSizeMiles);
            setPoints(generated);
            if (onPointsUpdate) {
                onPointsUpdate(generated);
            }
            // Auto-confirm: immediately commit the shape so user doesn't need to press confirm
            if (onConfirm) {
                onConfirm(generated);
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
                try { cursorLineRef.current.remove(); } catch(e) {}
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

    // Small preview circle at map center when drawing mode is active (helps on mobile)
    // Only update on moveend (not move) to prevent glitchy re-renders during zoom
    const [mapCenter, setMapCenter] = useState(null);
    useEffect(() => {
        if (active) {
            setMapCenter(map.getCenter());
            const onMoveEnd = () => setMapCenter(map.getCenter());
            map.on('moveend', onMoveEnd);
            return () => map.off('moveend', onMoveEnd);
        } else {
            setMapCenter(null);
        }
    }, [active, map]);

    const displayPoints = active ? points : (drawnPolygon || []);

    // Calculate preview radius in meters from drawSizeMiles
    const previewRadiusMeters = React.useMemo(() => {
        if (!active || !mapCenter) return 0;
        const radiusMiles = drawShape === 'circle'
            ? Math.sqrt(drawSizeMiles / Math.PI)
            : Math.sqrt(drawSizeMiles / 4);
        return radiusMiles * 1609.34; // miles to meters
    }, [active, mapCenter, drawSizeMiles, drawShape]);

    const getAreaText = () => {
        return `~${drawSizeMiles} sq mi`;
    };

    return (
        <>
            {/* Small preview circle at map center when in drawing mode */}
            {active && mapCenter && previewRadiusMeters > 0 && displayPoints.length === 0 && (
                <Circle
                    center={[mapCenter.lat, mapCenter.lng]}
                    radius={previewRadiusMeters}
                    pathOptions={{
                        color: '#FFD93D',
                        dashArray: '6,4',
                        weight: 1.5,
                        fillColor: '#FFD93D',
                        fillOpacity: 0.08,
                        interactive: false
                    }}
                />
            )}
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