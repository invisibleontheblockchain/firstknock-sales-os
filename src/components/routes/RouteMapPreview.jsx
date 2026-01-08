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
    const displayRoutes = selectedRoute ? [selectedRoute] : routes;

    // Calculate center from all routes
    const allProps = displayRoutes.flatMap(r => r.properties);
    const center = allProps.length > 0 
        ? [allProps[0].lat, allProps[0].lng]
        : [34.0522, -118.2437];

    return (
        <MapContainer 
            center={center} 
            zoom={13} 
            style={{ height: '100%', width: '100%', background: '#1e293b' }}
            zoomControl={true}
        >
            <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {displayRoutes.map((route, routeIdx) => {
                const color = routeColors[routeIdx % routeColors.length];
                const positions = route.properties.map(p => [p.lat, p.lng]);

                return (
                    <React.Fragment key={route.id}>
                        {/* Route Line */}
                        <Polyline 
                            positions={positions}
                            pathOptions={{ color, weight: 3, opacity: 0.7 }}
                        />

                        {/* Markers */}
                        {route.properties.map((prop, idx) => (
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
                        ))}
                    </React.Fragment>
                );
            })}
        </MapContainer>
    );
}