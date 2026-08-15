import React, { useState, useEffect, useRef } from 'react';
import { CircleMarker, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';

if (typeof window !== 'undefined' && !window.__fkLeafletCameraGuardInstalled) {
    window.__fkLeafletCameraGuardInstalled = true;

    const shouldSuppressCameraChange = () =>
        window.__fkSuppressMapFitUntil && Date.now() < window.__fkSuppressMapFitUntil;

    const guardCameraMethod = (methodName) => {
        const original = L.Map.prototype[methodName];
        if (!original) return;
        L.Map.prototype[methodName] = function (...args) {
            if (shouldSuppressCameraChange()) return this;
            return original.apply(this, args);
        };
    };

    ['fitBounds', 'flyToBounds', 'setView', 'flyTo', 'panTo', 'panInsideBounds'].forEach(guardCameraMethod);
}

export function LocationMarker({ autoCenter, userLocation }) {
    const [watchPosition, setWatchPosition] = useState(null);
    const [accuracy, setAccuracy] = useState(null);
    const map = useMap();
    const watchIdRef = useRef(null);

    // Use native Geolocation API for continuous watching (more reliable than Leaflet's)
    useEffect(() => {
        if (!navigator.geolocation) return;

        const onSuccess = (pos) => {
            const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            setWatchPosition(latlng);
            setAccuracy(pos.coords.accuracy);
        };

        const onError = (err) => {
            console.log('[LocationMarker] Watch error:', err.code, err.message);
        };

        watchIdRef.current = navigator.geolocation.watchPosition(onSuccess, onError, {
            enableHighAccuracy: true,
            timeout: 20000,
            maximumAge: 5000
        });

        return () => {
            if (watchIdRef.current !== null) {
                navigator.geolocation.clearWatch(watchIdRef.current);
            }
        };
    }, []);

    // Auto-center on first position if requested
    const hasCenteredRef = useRef(false);
    useEffect(() => {
        if (watchPosition && autoCenter && !hasCenteredRef.current) {
            try {
                map.setView([watchPosition.lat, watchPosition.lng], 15);
                hasCenteredRef.current = true;
            } catch (e) {}
        }
    }, [watchPosition, autoCenter, map]);

    // Also respond to explicit userLocation from "Center on Me" button
    const displayPos = userLocation || watchPosition;

    if (!displayPos) return null;

    return (
        <>
            {/* Accuracy circle - subtle blue ring */}
            {accuracy && accuracy < 500 && (
                <Circle
                    center={[displayPos.lat, displayPos.lng]}
                    radius={accuracy}
                    pathOptions={{
                        fillColor: '#3b82f6',
                        fillOpacity: 0.08,
                        color: '#3b82f6',
                        weight: 1,
                        opacity: 0.3
                    }}
                />
            )}
            {/* Outer glow ring */}
            <CircleMarker
                center={[displayPos.lat, displayPos.lng]}
                radius={16}
                pathOptions={{
                    fillColor: '#3b82f6',
                    fillOpacity: 0.15,
                    color: '#3b82f6',
                    weight: 0,
                    opacity: 0
                }}
            />
            {/* Main blue dot - matches Apple Maps style */}
            <CircleMarker
                center={[displayPos.lat, displayPos.lng]}
                radius={9}
                pathOptions={{
                    fillColor: '#3b82f6',
                    fillOpacity: 1,
                    color: '#ffffff',
                    weight: 3,
                    opacity: 1
                }}
            />
        </>
    );
}

export function MapRefHandler({ mapRef }) {
    const map = useMap();
    useEffect(() => {
        if (mapRef) mapRef.current = map;
    }, [map, mapRef]);

    // Wheel/zoom tuning lives on <MapContainer> only. This effect used to
    // overwrite map.options after init (wheelPxPerZoomLevel 100,
    // wheelDebounceTime 80), silently winning over the values passed as props —
    // so the tuned props were dead and trackpad zoom ran on the slower debounce.
    return null;
}

export function MapController({ fitBounds, onZoomChange, onMoveEnd }) {
    const map = useMap();
    
    // Track zoom & move
    useEffect(() => {
        if (!map) return;
        
        let zoomTimeout;
        let moveTimeout;

        const handleZoom = () => {
            if (zoomTimeout) clearTimeout(zoomTimeout);
            zoomTimeout = setTimeout(() => {
                try {
                    // Fractional zoom (zoomSnap < 1) is what makes trackpad zoom
                    // smooth, but the data layers key their pin budget and dot
                    // size off this value, so an unrounded zoom would rebuild
                    // every pin at each intermediate step. Layers only ever
                    // change at integer boundaries, so band it here.
                    if (map && map.getZoom) onZoomChange(Math.floor(map.getZoom()));
                } catch (e) { /* Map destroyed */ }
            }, 100);
        };
        const handleMove = () => {
            if (moveTimeout) clearTimeout(moveTimeout);
            moveTimeout = setTimeout(() => {
                try {
                    if (map && map.getBounds) onMoveEnd(map.getBounds());
                } catch (e) { /* Map destroyed */ }
            }, 100);
        };
        
        map.on('zoomend', handleZoom);
        map.on('moveend', handleMove);
        
        return () => {
            if (zoomTimeout) clearTimeout(zoomTimeout);
            if (moveTimeout) clearTimeout(moveTimeout);
            try {
                map.off('zoomend', handleZoom);
                map.off('moveend', handleMove);
            } catch (e) { /* Map already destroyed */ }
        };
    }, [map, onZoomChange, onMoveEnd]);

    // Use a ref to prevent aggressive re-fitting on data updates
    const lastBoundsRef = useRef(null);

    useEffect(() => {
        if (typeof window !== 'undefined' && window.__fkSuppressMapFitUntil && Date.now() < window.__fkSuppressMapFitUntil) {
            return;
        }
        if (fitBounds?.length > 0) {
            try {
                const bounds = L.latLngBounds(fitBounds);
                // Use the bounding box corners as the key (stable regardless of property order)
                if (bounds.isValid()) {
                    const sw = bounds.getSouthWest();
                    const ne = bounds.getNorthEast();
                    const boundsKey = `${sw.lat.toFixed(4)},${sw.lng.toFixed(4)},${ne.lat.toFixed(4)},${ne.lng.toFixed(4)}`;
                    if (lastBoundsRef.current !== boundsKey) {
                        if (map._mapPane) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17, animate: false });
                        lastBoundsRef.current = boundsKey;
                    }
                }
            } catch (e) { }
        }
    }, [fitBounds, map]);
    return null;
}