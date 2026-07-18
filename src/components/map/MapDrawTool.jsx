import React, { useState, useEffect, useRef } from 'react';
import { useMapEvents, useMap, Polygon, CircleMarker, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { calculatePolygonAreaSqMiles, formatSqMiles } from '@/components/logic/geoArea';

export default function MapDrawTool({ active, onPointsUpdate, onConfirm, drawnPolygon }) {
    const [points, setPoints] = useState([]);
    const [isDrawing, setIsDrawing] = useState(false);
    const [builderMode, setBuilderMode] = useState(false);
    const map = useMap();
    const pointsRef = useRef([]);
    const drawingRef = useRef(false);
    const touchPointerIdRef = useRef(null);

    const eventToLatLng = (event) => {
        const source = event?.originalEvent || event;
        const touch = source?.touches?.[0] || source?.changedTouches?.[0] || source;
        if (!touch || touch.clientX == null || touch.clientY == null) return event?.latlng || null;
        const container = map.getContainer();
        const rect = container.getBoundingClientRect();
        const point = L.point(touch.clientX - rect.left, touch.clientY - rect.top);
        return map.containerPointToLatLng(point);
    };

    const stopTouchMapGesture = (event) => {
        const source = event?.originalEvent || event;
        source?.preventDefault?.();
        source?.stopPropagation?.();
    };

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
        window.__fkSuppressMapFitUntil = Date.now() + 8000;
        const firstPoint = { lat: latlng.lat, lng: latlng.lng };
        drawingRef.current = true;
        setIsDrawing(true);
        setFreehandPoints([firstPoint]);
        try { map.dragging.disable(); } catch { }
    };

    const addPoint = (latlng) => {
        if (!active || !drawingRef.current || !latlng) return;
        const nextPoint = { lat: latlng.lat, lng: latlng.lng };
        const current = pointsRef.current;
        const last = current[current.length - 1];
        if (distance(last, nextPoint) < 0.00008) return;
        setFreehandPoints([...current, nextPoint]);
    };

    const finishDrawing = (confirmImmediately = false) => {
        if (!drawingRef.current) return;
        const finalPoints = pointsRef.current;
        drawingRef.current = false;
        touchPointerIdRef.current = null;
        setIsDrawing(false);
        if (!active) {
            try { map.dragging.enable(); } catch { }
        }
        if (finalPoints.length > 2) {
            onPointsUpdate?.(finalPoints);
            if (confirmImmediately) onConfirm?.(finalPoints);
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
            container.style.touchAction = 'none';
            map.doubleClickZoom.disable();
            try { map.dragging.disable(); } catch { }
            try { map.touchZoom.disable(); } catch { }
            try { map.boxZoom.disable(); } catch { }
            try { map.scrollWheelZoom.disable(); } catch { }
        } else {
            container.style.cursor = '';
            container.style.touchAction = '';
            map.doubleClickZoom.enable();
            try { map.dragging.enable(); } catch { }
            try { map.touchZoom.enable(); } catch { }
            try { map.boxZoom.enable(); } catch { }
            try { map.scrollWheelZoom.enable(); } catch { }
            drawingRef.current = false;
            touchPointerIdRef.current = null;
            setIsDrawing(false);
            setFreehandPoints([]);
        }
        return () => {
            container.style.cursor = '';
            container.style.touchAction = '';
            map.doubleClickZoom.enable();
            try { map.dragging.enable(); } catch { }
            try { map.touchZoom.enable(); } catch { }
            try { map.boxZoom.enable(); } catch { }
            try { map.scrollWheelZoom.enable(); } catch { }
        };
    }, [active, map]);

    useEffect(() => {
        const container = map.getContainer();

        const onPointerDown = (event) => {
            if (!active || event.pointerType === 'mouse') return;
            stopTouchMapGesture(event);
            touchPointerIdRef.current = event.pointerId;
            container.setPointerCapture?.(event.pointerId);
            startDrawing(eventToLatLng(event));
        };

        const onPointerMove = (event) => {
            if (!active || event.pointerType === 'mouse' || touchPointerIdRef.current !== event.pointerId) return;
            stopTouchMapGesture(event);
            addPoint(eventToLatLng(event));
        };

        const onPointerUp = (event) => {
            if (!active || event.pointerType === 'mouse' || touchPointerIdRef.current !== event.pointerId) return;
            stopTouchMapGesture(event);
            container.releasePointerCapture?.(event.pointerId);
            finishDrawing(false);
        };

        const onTouchStart = (event) => {
            if (!active || window.PointerEvent) return;
            stopTouchMapGesture(event);
            startDrawing(eventToLatLng(event));
        };

        const onTouchMove = (event) => {
            if (!active || window.PointerEvent) return;
            stopTouchMapGesture(event);
            addPoint(eventToLatLng(event));
        };

        const onTouchEnd = (event) => {
            if (!active || window.PointerEvent) return;
            stopTouchMapGesture(event);
            finishDrawing(false);
        };

        container.addEventListener('pointerdown', onPointerDown, { passive: false });
        container.addEventListener('pointermove', onPointerMove, { passive: false });
        container.addEventListener('pointerup', onPointerUp, { passive: false });
        container.addEventListener('pointercancel', onPointerUp, { passive: false });
        container.addEventListener('touchstart', onTouchStart, { passive: false });
        container.addEventListener('touchmove', onTouchMove, { passive: false });
        container.addEventListener('touchend', onTouchEnd, { passive: false });
        container.addEventListener('touchcancel', onTouchEnd, { passive: false });

        return () => {
            container.removeEventListener('pointerdown', onPointerDown);
            container.removeEventListener('pointermove', onPointerMove);
            container.removeEventListener('pointerup', onPointerUp);
            container.removeEventListener('pointercancel', onPointerUp);
            container.removeEventListener('touchstart', onTouchStart);
            container.removeEventListener('touchmove', onTouchMove);
            container.removeEventListener('touchend', onTouchEnd);
            container.removeEventListener('touchcancel', onTouchEnd);
        };
    }, [active, map]);

    useMapEvents({
        mousedown(e) { startDrawing(e.latlng); },
        mousemove(e) { addPoint(e.latlng); },
        mouseup() { finishDrawing(true); }
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
                    pathOptions={{ fillColor: '#2EEB57', color: '#2EEB57', fillOpacity: 0.22, weight: 2 }}
                >
                    <Tooltip permanent direction="center" className="bg-black/90 text-[#39FF4A] font-bold text-[10px] border border-[#2EEB57]/50 rounded shadow-xl whitespace-nowrap text-center z-50">
                        {getAreaText()}
                    </Tooltip>
                </Polygon>
            )}
            {active && displayPoints.map((p, i) => (
                <CircleMarker
                    key={i}
                    center={p}
                    radius={i === 0 ? 5 : 3}
                    pathOptions={{ color: '#2EEB57', fillColor: '#000', fillOpacity: 1, weight: 1 }}
                />
            ))}
        </>
    );
}
