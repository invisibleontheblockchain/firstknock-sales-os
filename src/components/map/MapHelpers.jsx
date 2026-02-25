import React, { useState, useEffect, useRef } from 'react';
import { CircleMarker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';

export function LocationMarker({ autoCenter }) {
    const [position, setPosition] = useState(null);
    const map = useMap();
    useEffect(() => {
        const handleLocationFound = (e) => {
            setPosition(e.latlng);
            if (autoCenter) {
                map.setView(e.latlng, 15);
            }
        };
        map.locate({ setView: autoCenter, maxZoom: 16 }).on("locationfound", handleLocationFound);
        return () => {
            map.off("locationfound", handleLocationFound);
            try { map.stopLocate(); } catch (e) {}
        };
    }, [map, autoCenter]);
    return position ? (
        <CircleMarker center={position} radius={8} pathOptions={{ fillColor: '#3b82f6', fillOpacity: 1, color: '#ffffff', weight: 3 }}>
            <Tooltip permanent direction="right" offset={[10, 0]} className="route-number-tooltip">
                <span style={{ color: '#fff', fontWeight: 'bold', fontSize: '11px', textShadow: '0 1px 3px #000, 0 0 5px #000', backgroundColor: '#3b82f6', padding: '2px 6px', borderRadius: '12px' }}>
                    YOU ARE HERE
                </span>
            </Tooltip>
        </CircleMarker>
    ) : null;
}

export function MapRefHandler({ mapRef }) {
    const map = useMap();
    useEffect(() => {
        if (mapRef) mapRef.current = map;
    }, [map, mapRef]);
    return null;
}

export function MapController({ fitBounds, onZoomChange, onMoveEnd }) {
    const map = useMap();
    
    // Track zoom & move
    useEffect(() => {
        if (!map) return;
        
        const handleZoom = () => {
            setTimeout(() => {
                try {
                    if (map && map.getZoom) onZoomChange(map.getZoom());
                } catch (e) { /* Map destroyed */ }
            }, 0);
        };
        const handleMove = () => {
            setTimeout(() => {
                try {
                    if (map && map.getBounds) onMoveEnd(map.getBounds());
                } catch (e) { /* Map destroyed */ }
            }, 0);
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

    // Use a ref to prevent aggressive re-fitting on data updates
    const lastBoundsRef = useRef(null);

    useEffect(() => {
        if (fitBounds?.length > 0) {
            try {
                // Only fit bounds if they have significantly changed (e.g. new route selected)
                // or if it's the very first load
                const bounds = L.latLngBounds(fitBounds);
                const boundsKey = JSON.stringify(fitBounds.slice(0, 1)); // Simple check on first point to detect route switch

                if (bounds.isValid() && lastBoundsRef.current !== boundsKey) {
                    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17, animate: false });
                    lastBoundsRef.current = boundsKey;
                }
            } catch (e) { }
        }
    }, [fitBounds, map]);
    return null;
}