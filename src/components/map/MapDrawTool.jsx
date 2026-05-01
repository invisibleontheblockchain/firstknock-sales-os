import React, { useState, useEffect, useRef } from 'react';
import { useMapEvents, useMap, Polygon, CircleMarker, Circle, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { calculatePolygonAreaSqMiles, formatSqMiles } from '@/components/logic/geoArea';

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
            radiusInMiles = Math.sqrt(areaSqMiles) / 2; // half side-length
        } else if (shape === 'triangle') {
            radiusInMiles = Math.sqrt(areaSqMiles / 2);
        }

        // Mercator-corrected deltas
        const radiusLat = radiusInMiles / 69.0;
        const radiusLng = radiusInMiles / (69.0 * Math.cos(centerLatlng.lat * Math.PI / 180));

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
            // Mercator-corrected square: 4 corners + closing 5th point
            const nw = { lat: centerLatlng.lat + radiusLat, lng: centerLatlng.lng - radiusLng };
            const ne = { lat: centerLatlng.lat + radiusLat, lng: centerLatlng.lng + radiusLng };
            const se = { lat: centerLatlng.lat - radiusLat, lng: centerLatlng.lng + radiusLng };
            const sw = { lat: centerLatlng.lat - radiusLat, lng: centerLatlng.lng - radiusLng };
            // Closed ring (5 points) so downstream polygon checks work
            newPoints = [nw, ne, se, sw, nw];
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
            // Fire confirm FIRST so parent can do its work (state updates, polygon save).
            if (onConfirm) {
                onConfirm(generated);
            }
            // Then focus the drawn area as the main subject WITHOUT zooming out.
            // We run this LAST (and on next tick) so it wins over any caller-side fitBounds
            // that would expand the view and zoom OUT from where the user tapped.
            //   • If the shape already fits in current view → just pan to its center
            //   • If it doesn't fit → fit bounds but cap max-zoom at current zoom
            //     (so we never zoom further in/out than the user was).
            // The requestAnimationFrame ensures this runs after React flushes parent state
            // (including any fitBounds the parent's onConfirm may trigger).
            requestAnimationFrame(() => {
                try {
                    if (generated && generated.length > 2) {
                        const b = L.latLngBounds(generated.map(pt => [pt.lat, pt.lng]));
                        if (b.isValid() && map?._mapPane) {
                            const center = b.getCenter();
                            const curZoom = map.getZoom();
                            const curBounds = map.getBounds();
                            if (curBounds.contains(b)) {
                                map.panTo(center, { animate: true, duration: 0.4 });
                            } else {
                                map.fitBounds(b, { padding: [40, 40], maxZoom: curZoom, animate: true });
                            }
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