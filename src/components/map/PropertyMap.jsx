import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Status color icons
const createIcon = (color) => new L.DivIcon({
    className: 'property-marker',
    html: `<div style="background:${color};width:12px;height:12px;border-radius:50%;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6]
});

const STATUS_ICONS = {
    ELIGIBLE: createIcon('#22c55e'),
    QUALIFIED: createIcon('#3b82f6'),
    CALLBACK: createIcon('#eab308'),
    NO_ANSWER: createIcon('#94a3b8'),
    SOLD: createIcon('#ef4444'),
    HARD_NO: createIcon('#ef4444'),
    DO_NOT_KNOCK: createIcon('#7c3aed'),
    OTHER: createIcon('#64748b')
};

// Auto-fit bounds component
function AutoFit({ properties }) {
    const map = useMap();
    const [fitted, setFitted] = useState(false);
    
    useEffect(() => {
        if (!fitted && properties.length > 0) {
            const valid = properties.filter(p => p.lat && p.lng && !isNaN(p.lat) && !isNaN(p.lng));
            if (valid.length > 0) {
                const bounds = L.latLngBounds(valid.map(p => [p.lat, p.lng]));
                if (bounds.isValid()) {
                    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
                    setFitted(true);
                }
            }
        }
    }, [properties, map, fitted]);
    
    return null;
}

// GPS location marker
function LocationMarker() {
    const [position, setPosition] = useState(null);
    const map = useMap();
    
    useEffect(() => {
        map.locate().on('locationfound', (e) => setPosition(e.latlng));
    }, [map]);
    
    return position ? (
        <Circle 
            center={position} 
            radius={15} 
            pathOptions={{ fillColor: '#3b82f6', fillOpacity: 0.3, color: '#3b82f6', weight: 2 }} 
        />
    ) : null;
}

export default function PropertyMap({ properties, onSelectProperty }) {
    const validProps = properties.filter(p => 
        p.lat && p.lng && !isNaN(p.lat) && !isNaN(p.lng)
    );
    
    const center = validProps.length > 0 
        ? [validProps[0].lat, validProps[0].lng] 
        : [34.0522, -118.2437];
    
    return (
        <MapContainer 
            center={center} 
            zoom={16} 
            style={{ height: '100%', width: '100%' }}
            zoomControl={false}
        >
            <TileLayer
                attribution='&copy; Mapbox'
                url="https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/{z}/{x}/{y}?access_token=pk.eyJ1IjoibWFwYm94IiwiYSI6ImNpejY4NXVycTA2emYycXBndHRqcmZ3N3gifQ.rJcFIG214AriISLbB6B5aw"
            />
            <LocationMarker />
            <AutoFit properties={validProps} />
            
            {validProps.map(prop => (
                <Marker
                    key={prop.address_hash}
                    position={[prop.lat, prop.lng]}
                    icon={STATUS_ICONS[prop.effective_status] || STATUS_ICONS.OTHER}
                    eventHandlers={{ click: () => onSelectProperty(prop) }}
                />
            ))}
        </MapContainer>
    );
}