import React, { useState, useEffect, useRef } from 'react';
import { useMapEvents, useMap, Polygon, CircleMarker } from 'react-leaflet';
import L from 'leaflet';

export default function MapDrawTool({ active, onPointsUpdate, drawnPolygon }) {
    const [points, setPoints] = useState([]);
    const map = useMap();
    const cursorLineRef = useRef(null);

    // Change cursor and disable map click default behavior when active
    useEffect(() => {
        const container = map.getContainer();
        if (active) {
            container.style.cursor = 'crosshair';
            // Disable double click zoom while drawing
            map.doubleClickZoom.disable();
        } else {
            container.style.cursor = '';
            map.doubleClickZoom.enable();
        }
        return () => {
            container.style.cursor = '';
            map.doubleClickZoom.enable();
        }
    }, [active, map]);

    useMapEvents({
        click(e) {
            if (!active) return;
            const newPoints = [...points, e.latlng];
            setPoints(newPoints);
            if (onPointsUpdate) {
                onPointsUpdate(newPoints);
            }
        },
        mousemove(e) {
            if (!active || points.length === 0) return;
            
            // Draw a temporary line to the cursor natively so it's perfectly smooth and 0 lag
            let linePoints = [...points, e.latlng];
            if (points.length >= 2) {
                // close the visual shape back to the start
                linePoints.push(points[0]);
            }
            
            if (!cursorLineRef.current) {
                cursorLineRef.current = L.polyline(linePoints, { 
                    color: '#FFD93D', 
                    dashArray: '5,5', 
                    weight: 2,
                    interactive: false
                }).addTo(map);
            } else {
                cursorLineRef.current.setLatLngs(linePoints);
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

    // Keep native polyline updated if points array changes (e.g. on click)
    useEffect(() => {
        if (active && cursorLineRef.current && points.length > 0) {
            const currentLinePoints = cursorLineRef.current.getLatLngs();
            if (currentLinePoints.length > 0) {
                // The last element before potentially closing is the mouse pos
                const mousePoint = currentLinePoints.length > points.length ? 
                    currentLinePoints[points.length] : currentLinePoints[currentLinePoints.length - 1];
                
                let linePoints = [...points, mousePoint];
                if (points.length >= 2) {
                    linePoints.push(points[0]);
                }
                cursorLineRef.current.setLatLngs(linePoints);
            }
        } else if (active && points.length === 0 && cursorLineRef.current) {
            cursorLineRef.current.remove();
            cursorLineRef.current = null;
        }
    }, [points, active]);

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

    return (
        <>
            {displayPoints.length > 2 && (
                <Polygon 
                    positions={displayPoints} 
                    pathOptions={{ fillColor: '#FFD93D', color: '#FFD93D', fillOpacity: 0.2, weight: active ? 0 : 2 }} 
                />
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