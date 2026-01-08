import React from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Custom Route Marker Icons
const createNumberedIcon = (number, color) => new L.DivIcon({
    className: 'numbered-icon',
    html: `<div style="background-color: ${color}; width: 24px; height: 24px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 11px; color: white;">${number}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
});

const routeColors = [
    '#6366f1', // Indigo
    '#ec4899', // Pink
    '#10b981', // Green
    '#f59e0b', // Amber
    '#8b5cf6', // Purple
    '#ef4444', // Red
    '#06b6d4', // Cyan
    '#f97316', // Orange
];

export default function RouteMapPreview({ routes, selectedRouteId }) {
    const selectedRoute = routes.find(r => r.id === selectedRouteId);
    
    // ONLY show selected route to prevent performance issues
    if (!selectedRoute) {
        return (
            <div className="h-full w-full bg-slate-900 flex items-center justify-center">
                <div className="text-center text-slate-400">
                    <MapPin className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">Select a route to preview</p>
                </div>
            </div>
        );
    }

    const color = routeColors[routes.findIndex(r => r.id === selectedRoute.id) % routeColors.length];
    const positions = selectedRoute.properties.map(p => [p.lat, p.lng]);
    const center = [selectedRoute.properties[0].lat, selectedRoute.properties[0].lng];

    return (
        <MapContainer 
            key={selectedRoute.id}
            center={center} 
            zoom={15} 
            style={{ height: '100%', width: '100%', background: '#1a1a1a' }}
            zoomControl={true}
        >
            <TileLayer
                attribution='&copy; <a href="https://www.mapbox.com/">Mapbox</a>'
                url="https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/{z}/{x}/{y}?access_token=pk.eyJ1IjoibWFwYm94IiwiYSI6ImNpejY4NXVycTA2emYycXBndHRqcmZ3N3gifQ.rJcFIG214AriISLbB6B5aw"
            />

            {/* Route Line */}
            <Polyline 
                positions={positions}
                pathOptions={{ color, weight: 4, opacity: 0.8 }}
            />

            {/* Only show first, last, and every 5th marker to reduce load */}
            {selectedRoute.properties.map((prop, idx) => {
                const showMarker = idx === 0 || idx === selectedRoute.properties.length - 1 || idx % 5 === 0;
                if (!showMarker) return null;
                
                return (
                    <Marker
                        key={prop.address_hash}
                        position={[prop.lat, prop.lng]}
                        icon={createNumberedIcon(idx + 1, color)}
                    >
                        <Popup>
                            <div className="text-xs">
                                <div className="font-bold">{prop.full_address}</div>
                                <div className="text-slate-600">Stop #{idx + 1}</div>
                                <div className="text-slate-600">Status: {prop.effective_status}</div>
                            </div>
                        </Popup>
                    </Marker>
                );
            })}
        </MapContainer>
    );
}