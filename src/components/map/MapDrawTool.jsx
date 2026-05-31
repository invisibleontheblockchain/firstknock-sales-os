import React, { useState, useEffect, useRef } from 'react';
import { useMapEvents, useMap, Polygon, CircleMarker, Tooltip } from 'react-leaflet';
import { calculatePolygonAreaSqMiles, formatSqMiles } from '@/components/logic/geoArea';

export default function MapDrawTool({ active, onPointsUpdate, onConfirm, drawnPolygon }) {
    const [points, setPoints] = useState([]);
    const [isDrawing, setIsDrawing] = useState(false);
    const [builderMode, setBuilderMode] = useState(false);
    const map = useMap();
    const pointsRef = useRef([]);

    const setFreehandPoints = (nextPoints) => {
        pointsRef.current = nextPoints;
        setPoints(nextPoints);
        if (onPointsUpdate) onPointsUpdate(nextPoints);
    };

    const distance = (a, b) => {
        if (!a || !b) return Infinity;
        return Math.sqrt((a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2);
    };

    const startDrawing = (latlng) => {
        if (!active || !latlng) return;
        window.__fkSuppressMapFitUntil = Date.now() + 1800;
        const firstPoint = { lat: latlng.lat, lng: latlng.lng };
        setIsDrawing(true);
        setFreehandPoints([firstPoint]);
        try { map.dragging.disable(); } catch { }
    };

    const addPoint = (latlng) => {
        if (!active || !isDrawing || !latlng) return;
        const nextPoint = { lat: latlng.lat, lng: latlng.lng };
        const current = pointsRef.current;
        const last = current[current.length - 1];
        if (distance(last, nextPoint) < 0.00008) return;
        setFreehandPoints([...current, nextPoint]);
    };

    const finishDrawing = () => {
        if (!isDrawing) return;
        const finalPoints = pointsRef.current;
        setIsDrawing(false);
        try { map.dragging.enable(); } catch { }
        if (finalPoints.length > 2 && onConfirm) {
            onConfirm(finalPoints);
        }
    };

    useEffect(() => {
        const handler = (event) => setBuilderMode(event.detail?.mode === 'generate');
        window.addEventListener('fk-builder-mode-change', handler);
        return () => window.removeEventListener('fk-builder-mode-change', handler);
    }, []);

    useEffect(() => {
        const container = map.getContainer();
        if (active) {
            container.style.cursor = 'crosshair';
            map.doubleClickZoom.disable();
        } else {
            container.style.cursor = '';
            map.doubleClickZoom.enable();
            try { map.dragging.enable(); } catch { }
            setIsDrawing(false);
            setFreehandPoints([]);
        }
        return () => {
            container.style.cursor = '';
            map.doubleClickZoom.enable();
            try { map.dragging.enable(); } catch { }
        };
    }, [active, map]);

    useMapEvents({
        mousedown(e) { startDrawing(e.latlng); },
        mousemove(e) { addPoint(e.latlng); },
        mouseup() { finishDrawing(); },
        touchstart(e) { startDrawing(e.latlng); },
        touchmove(e) { addPoint(e.latlng); },
        touchend() { finishDrawing(); }
    });

    const displayPoints = active ? points : (builderMode ? (drawnPolygon || []) : []);
    const getAreaText = () => {
        const actualArea = calculatePolygonAreaSqMiles(displayPoints);
        return actualArea > 0 ? `~${formatSqMiles(actualArea)}` : 'Freehand area';
    };

    return (
        <>
            {displayPoints.length > 2 && (
                <Polygon
                    positions={displayPoints}
                    pathOptions={{ fillColor: '#FFD93D', color: '#FFD93D', fillOpacity: 0.2, weight: 2 }}
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
                    radius={i === 0 ? 5 : 3}
                    pathOptions={{ color: '#FFD93D', fillColor: '#000', fillOpacity: 1, weight: 1 }}
                />
            ))}
        </>
    );
}