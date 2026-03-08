import React, { useState, useEffect, useRef } from 'react';
import { useMap, Source, Layer, Marker } from 'react-map-gl/maplibre';
import circle from '@turf/circle';

export function LocationMarker({ autoCenter, userLocation }) {
    const [watchPosition, setWatchPosition] = useState(null);
    const [accuracy, setAccuracy] = useState(null);
    const { current: map } = useMap();
    const watchIdRef = useRef(null);

    // Use native Geolocation API for continuous watching
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
        if (watchPosition && autoCenter && !hasCenteredRef.current && map) {
            try {
                map.flyTo({ center: [watchPosition.lng, watchPosition.lat], zoom: 15 });
                hasCenteredRef.current = true;
            } catch (e) {}
        }
    }, [watchPosition, autoCenter, map]);

    // Also respond to explicit userLocation from "Center on Me" button
    const displayPos = userLocation || watchPosition;

    if (!displayPos) return null;

    let accuracyGeoJSON = null;
    if (accuracy && accuracy < 500) {
        accuracyGeoJSON = circle([displayPos.lng, displayPos.lat], accuracy, { steps: 64, units: 'meters' });
    }

    return (
        <>
            {/* Accuracy circle */}
            {accuracyGeoJSON && (
                <Source id="accuracy-source" type="geojson" data={accuracyGeoJSON}>
                    <Layer
                        id="accuracy-fill"
                        type="fill"
                        paint={{
                            'fill-color': '#3b82f6',
                            'fill-opacity': 0.08
                        }}
                    />
                    <Layer
                        id="accuracy-line"
                        type="line"
                        paint={{
                            'line-color': '#3b82f6',
                            'line-width': 1,
                            'line-opacity': 0.3
                        }}
                    />
                </Source>
            )}

            {/* Main blue dot - matches Apple Maps style using Marker for pixel-perfect sizing */}
            <Marker longitude={displayPos.lng} latitude={displayPos.lat} anchor="center">
                <div style={{
                    position: 'relative',
                    width: '18px',
                    height: '18px',
                    backgroundColor: '#3b82f6',
                    borderRadius: '50%',
                    border: '3px solid #ffffff',
                    boxShadow: '0 0 0 10px rgba(59, 130, 246, 0.15)'
                }} />
            </Marker>
        </>
    );
}

// MapController: handles bounds fitting, zoom change and move end callbacks
export function MapController({ fitBounds, onZoomChange, onMoveEnd }) {
    const { current: map } = useMap();
    
    // Use a ref to prevent aggressive re-fitting on data updates
    const lastBoundsRef = useRef(null);

    useEffect(() => {
        if (!map) return;
        
        const handleZoom = () => {
            try {
                if (map && onZoomChange) onZoomChange(map.getZoom());
            } catch (e) { /* Map destroyed */ }
        };

        const handleMove = () => {
            try {
                if (map && onMoveEnd) {
                    const bounds = map.getBounds();
                    // maplibre-gl bounds API matches our need, but we just pass the object
                    onMoveEnd({
                        getNorth: () => bounds.getNorth(),
                        getSouth: () => bounds.getSouth(),
                        getEast: () => bounds.getEast(),
                        getWest: () => bounds.getWest(),
                    });
                }
            } catch (e) { /* Map destroyed */ }
        };
        
        map.on('zoomend', handleZoom);
        map.on('moveend', handleMove);
        
        return () => {
            try {
                map.off('zoomend', handleZoom);
                map.off('moveend', handleMove);
            } catch (e) { /* Map already destroyed */ }
        };
    }, [map, onZoomChange, onMoveEnd]);

    useEffect(() => {
        if (fitBounds?.length > 0 && map) {
            try {
                // Determine min/max lng/lat
                let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
                let valid = false;

                for (const pos of fitBounds) {
                    let lat = pos.lat || pos[0];
                    let lng = pos.lng || pos[1];
                    if (lat !== undefined && lng !== undefined) {
                        if (lat < minLat) minLat = lat;
                        if (lat > maxLat) maxLat = lat;
                        if (lng < minLng) minLng = lng;
                        if (lng > maxLng) maxLng = lng;
                        valid = true;
                    }
                }

                if (valid) {
                    const boundsKey = `${minLat},${minLng},${maxLat},${maxLng}`;
                    if (lastBoundsRef.current !== boundsKey) {
                        map.fitBounds([
                            [minLng, minLat],
                            [maxLng, maxLat]
                        ], { padding: 30, maxZoom: 17, duration: 0 });
                        lastBoundsRef.current = boundsKey;
                    }
                }
            } catch (e) { console.warn('MapController fitBounds error:', e); }
        }
    }, [fitBounds, map]);
    return null;
}