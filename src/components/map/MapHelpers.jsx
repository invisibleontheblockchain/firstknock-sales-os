import React, { useEffect, useState } from 'react';
import { useMap } from 'react-map-gl/maplibre';
import { Marker } from 'react-map-gl/maplibre';

export function MapRefHandler({ mapRef }) {
    const { current: map } = useMap();
    useEffect(() => {
        if (mapRef && map) {
            mapRef.current = map.getMap();
        }
    }, [map, mapRef]);
    return null;
}

export function MapController({ fitBounds, onZoomChange, onMoveEnd }) {
    const { current: map } = useMap();

    useEffect(() => {
        if (!map) return;

        const handleZoom = () => {
             if (onZoomChange) onZoomChange(map.getZoom());
        };
        const handleMoveEnd = () => {
             if (onMoveEnd) onMoveEnd();
        };

        map.on('zoomend', handleZoom);
        map.on('moveend', handleMoveEnd);

        return () => {
            map.off('zoomend', handleZoom);
            map.off('moveend', handleMoveEnd);
        };
    }, [map, onZoomChange, onMoveEnd]);

    useEffect(() => {
        if (map && fitBounds && fitBounds.length > 0) {
             try {
                // Determine bounds
                const bounds = fitBounds.reduce((b, coord) => {
                     return b.extend(coord); // Already [lng, lat] from Home.jsx
                }, new window.maplibregl.LngLatBounds(fitBounds[0], fitBounds[0]));

                map.fitBounds(bounds, { padding: 50, maxZoom: 16 });
             } catch(e) {
                console.warn("Fitbounds error: ", e);
             }
        }
    }, [map, fitBounds]);

    return null;
}

export function LocationMarker({ autoCenter, userLocation }) {
    const { current: map } = useMap();
    const [position, setPosition] = useState(userLocation || null);

    useEffect(() => {
        if (userLocation) {
            setPosition(userLocation);
            if (map && autoCenter) {
                map.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: 16 });
            }
        }
    }, [userLocation, map, autoCenter]);

    if (!position) return null;

    return (
        <Marker longitude={position.lng} latitude={position.lat} anchor="center">
            <div style={{
                width: '18px', height: '18px', 
                backgroundColor: '#3b82f6', 
                border: '3px solid white', 
                borderRadius: '50%',
                boxShadow: '0 0 10px rgba(59, 130, 246, 0.5)'
            }} />
        </Marker>
    );
}

