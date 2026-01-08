import React from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Navigation } from 'lucide-react';

const createNumberedIcon = (num, color) => new L.DivIcon({
    className: 'route-marker',
    html: `<div style="background:${color};width:22px;height:22px;border-radius:50%;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:10px;color:white;">${num}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
});

const COLORS = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#f97316'];

export default function RouteMap({ route, colorIndex = 0 }) {
    if (!route || !route.properties?.length) {
        return (
            <div className="h-full w-full bg-slate-900 flex items-center justify-center">
                <div className="text-center text-slate-500">
                    <Navigation className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">Select a route to preview</p>
                </div>
            </div>
        );
    }
    
    const color = COLORS[colorIndex % COLORS.length];
    const positions = route.properties.map(p => [p.lat, p.lng]);
    const center = positions[0];
    
    return (
        <MapContainer 
            key={route.id}
            center={center} 
            zoom={15} 
            style={{ height: '100%', width: '100%' }}
            zoomControl={true}
        >
            <TileLayer
                attribution='&copy; Mapbox'
                url="https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/{z}/{x}/{y}?access_token=pk.eyJ1IjoibWFwYm94IiwiYSI6ImNpejY4NXVycTA2emYycXBndHRqcmZ3N3gifQ.rJcFIG214AriISLbB6B5aw"
            />
            
            <Polyline positions={positions} pathOptions={{ color, weight: 4, opacity: 0.8 }} />
            
            {route.properties.map((prop, idx) => {
                // Show first, last, and every 5th
                if (idx !== 0 && idx !== route.properties.length - 1 && idx % 5 !== 0) return null;
                
                return (
                    <Marker
                        key={prop.address_hash}
                        position={[prop.lat, prop.lng]}
                        icon={createNumberedIcon(idx + 1, color)}
                    >
                        <Popup>
                            <div className="text-xs">
                                <div className="font-bold">{prop.full_address}</div>
                                <div>Stop #{idx + 1} • {prop.effective_status}</div>
                            </div>
                        </Popup>
                    </Marker>
                );
            })}
        </MapContainer>
    );
}