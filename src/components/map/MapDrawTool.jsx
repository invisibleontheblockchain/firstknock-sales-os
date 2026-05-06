import React, { useState, useEffect, useRef } from 'react';
import { useMapEvents, useMap, Polygon, CircleMarker, Circle, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { calculatePolygonAreaSqMiles, formatSqMiles } from '@/components/logic/geoArea';

export default function MapDrawTool({ active, onPointsUpdate, onConfirm, drawnPolygon, drawShape = 'circle', drawSizeMiles = 10 }) {
    const [points, setPoints] = useState([]);
    const [builderMode, setBuilderMode] = useState(false);
    const map = useMap();
    const cursorLineRef = useRef(null);

    // Helper: generate shape points around a center
    const generateShape = (centerLatlng, shape, areaSqMiles) => {
        const safeArea = Math.max(Number(areaSqMiles) || 1, 0.01);
        let radiusInMiles = 1;
        let halfSideMiles = 1;
        if (shape === 'circle') {
            radiusInMiles = Math.sqrt(safeArea / Math.PI);
        } else if (shape === 'square') {
            halfSideMiles = Math.sqrt(safeArea) / 2; // true half side-length: 40 sq mi => 6.32mi side, 300 => 17.32mi side
            radiusInMiles = halfSideMiles;
        } else if (shape === 'triangle') {
            radiusInMiles = Math.sqrt(safeArea / 2);
        }

        // Local tangent-plane conversion keeps preset square areas accurate at 40/300 sq mi.
        const milesPerLat = 69.0;
        const milesPerLng = Math.max(1, 69.0 * Math.cos(centerLatlng.lat * Math.PI / 180));
        const radiusLat = radiusInMiles / milesPerLat;
        const radiusLng = radiusInMiles / milesPerLng;
        const halfSideLat = halfSideMiles / milesPerLat;
        const halfSideLng = halfSideMiles / milesPerLng;

        let newPoints = [];
        if (shape === 'circle') {
            const segments = 128;
            for (let i = 0; i < segments; i++) {
                const angle = (i / segments) * Math.PI * 2;
                newPoints.push({
                    lat: centerLatlng.lat + (Math.cos(angle) * radiusLat),
                    lng: centerLatlng.lng + (Math.sin(angle) * radiusLng)
                });
            }
        } else if (shape === 'square') {
            const nw = { lat: centerLatlng.lat + halfSideLat, lng: centerLatlng.lng - halfSideLng };
            const ne = { lat: centerLatlng.lat + halfSideLat, lng: centerLatlng.lng + halfSideLng };
            const se = { lat: centerLatlng.lat - halfSideLat, lng: centerLatlng.lng + halfSideLng };
            const sw = { lat: centerLatlng.lat - halfSideLat, lng: centerLatlng.lng - halfSideLng };
            newPoints = [nw, ne, se, sw];
        } else if (shape === 'triangle') {
            newPoints = [
                { lat: centerLatlng.lat + radiusLat, lng: centerLatlng.lng },
                { lat: centerLatlng.lat - radiusLat, lng: centerLatlng.lng + radiusLng },
                { lat: centerLatlng.lat - radiusLat, lng: centerLatlng.lng - radiusLng }
            ];
        }
        return newPoints;
    };

    useEffect(() => {
        const handler = (event) => setBuilderMode(event.detail?.mode === 'generate');
        window.addEventListener('fk-builder-mode-change', handler);
        return () => window.removeEventListener('fk-builder-mode-change', handler);
    }, []);

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
            window.__fkSuppressMapFitUntil = Date.now() + 1800;
            setPoints(generated);
            if (onPointsUpdate) {
                onPointsUpdate(generated);
            }
            // Fire confirm after the no-fit guard is active so parent effects cannot zoom out.
            if (onConfirm) {
                onConfirm(generated);
            }
            // Preserve the user's zoom on confirm. Using fitBounds here can zoom far out
            // for larger selected areas, so we only pan to the selected area's center.
            requestAnimationFrame(() => {
                try {
                    if (generated && generated.length > 2) {
                        const b = L.latLngBounds(generated.map(pt => [pt.lat, pt.lng]));
                        if (b.isValid() && map?._mapPane) {
                            map.setView(b.getCenter(), map.getZoom(), { animate: true });
                        }
                    }
                } catch (err) { /* non-fatal focus adjustment */ }
            });
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
            return () => { map.off('moveend', onMoveEnd); };
        } else {
            setMapCenter(null);
        }
    }, [active, map]);

    const displayPoints = active ? points : (builderMode ? (drawnPolygon || []) : []);

    // Calculate preview radius in meters from drawSizeMiles
    const previewRadiusMeters = React.useMemo(() => {
        if (!active || !mapCenter) return 0;
        const radiusMiles = drawShape === 'circle'
            ? Math.sqrt(drawSizeMiles / Math.PI)
            : Math.sqrt(drawSizeMiles) / 2;
        return radiusMiles * 1609.34; // miles to meters
    }, [active, mapCenter, drawSizeMiles, drawShape]);

    const getAreaText = () => {
        const actualArea = calculatePolygonAreaSqMiles(displayPoints);
        return actualArea > 0 ? `~${formatSqMiles(actualArea)}` : `~${drawSizeMiles} sq mi`;
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
                >
                    <Tooltip permanent direction="center" className="bg-yellow-500 text-black font-bold text-[11px] border-none shadow-xl whitespace-nowrap text-center z-50 animate-pulse px-3 py-1.5 rounded-lg opacity-90">
                        TAP TO CONFIRM
                        <div className="text-[9px] opacity-70 mt-0.5 leading-none">{getAreaText()}</div>
                    </Tooltip>
                </Circle>
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
            {active && displayPoints.map((p, i) => (
                <CircleMarker
                    key={i}
                    center={p}
                    radius={4}
                    pathOptions={{ color: '#FFD93D', fillColor: '#000', fillOpacity: 1, weight: 1 }}
                />
            ))}
        </>
    );
}