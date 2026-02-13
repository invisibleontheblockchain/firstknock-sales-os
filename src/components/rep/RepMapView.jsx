import React, { useState, useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Circle, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Navigation, X, Locate, ChevronUp, ChevronDown } from 'lucide-react';

const BRAND = { gold: '#FFD700', voidBlack: '#0A0A0A' };

const STATUS_COLORS = {
    ELIGIBLE: '#6b7280',
    SOLD: '#22c55e',
    HARD_NO: '#8B5CF6',
    CALLBACK: '#eab308',
    NO_ANSWER: '#f97316',
    QUALIFIED: '#22c55e',
};

function haversine(lat1, lng1, lat2, lng2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function MapRefCapture({ mapRef }) {
    const map = useMap();
    useEffect(() => {
        if (mapRef && map) {
            map.whenReady(() => { mapRef.current = map; });
        }
    }, [map, mapRef]);
    return null;
}

function GpsLayer({ position, accuracy }) {
    if (!position) return null;
    return (
        <>
            <Circle center={[position.lat, position.lng]} radius={accuracy}
                pathOptions={{ fillColor: BRAND.gold, fillOpacity: 0.08, color: BRAND.gold, weight: 1, dashArray: '4,4' }} />
            <CircleMarker center={[position.lat, position.lng]} radius={10}
                pathOptions={{ fillColor: BRAND.gold, fillOpacity: 1, color: '#000', weight: 3 }}>
                <Tooltip permanent direction="top" className="route-number-tooltip">
                    <span style={{ color: BRAND.gold, fontWeight: '900', fontSize: '10px', textShadow: '0 0 6px #000' }}>YOU</span>
                </Tooltip>
            </CircleMarker>
        </>
    );
}

export default function RepMapView({ properties, onSelectProperty, onClose }) {
    const mapRef = useRef(null);
    const [position, setPosition] = useState(null);
    const [accuracy, setAccuracy] = useState(50);
    const [hudExpanded, setHudExpanded] = useState(true);

    // Live GPS
    useEffect(() => {
        let watchId = null;
        if (navigator.geolocation) {
            watchId = navigator.geolocation.watchPosition(
                (pos) => {
                    setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                    setAccuracy(pos.coords.accuracy || 50);
                },
                (err) => console.warn('GPS error:', err),
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 }
            );
        }
        return () => { if (watchId !== null) navigator.geolocation.clearWatch(watchId); };
    }, []);

    // Center map on GPS when first acquired
    const hasCentered = useRef(false);
    useEffect(() => {
        if (position && mapRef.current && !hasCentered.current) {
            try {
                mapRef.current.setView([position.lat, position.lng], 18);
                hasCentered.current = true;
            } catch (e) {
                console.warn('Map not ready yet for setView', e);
            }
        }
    }, [position]);

    // Calculate nearby properties
    const nearbyProps = useMemo(() => {
        if (!position || !properties?.length) return [];
        return properties
            .map(p => ({
                ...p,
                _dist: haversine(position.lat, position.lng, p.lat, p.lng),
                _distFt: Math.round(haversine(position.lat, position.lng, p.lat, p.lng) * 5280)
            }))
            .filter(p => p._dist <= 0.15) // ~800 ft
            .sort((a, b) => a._dist - b._dist)
            .slice(0, 15);
    }, [position, properties]);

    // Map center fallback
    const center = position
        ? [position.lat, position.lng]
        : properties?.[0]
            ? [properties[0].lat, properties[0].lng]
            : [32.78, -79.93];

    return (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
            {/* Header */}
            <div className="absolute top-0 left-0 right-0 z-[1100] p-3 flex items-center justify-between pointer-events-none">
                <Button
                    onClick={onClose}
                    size="sm"
                    className="pointer-events-auto bg-black/80 backdrop-blur-xl text-white border border-gray-700 hover:bg-gray-800 rounded-full h-10 px-4 shadow-xl"
                >
                    <X className="w-4 h-4 mr-1" /> Close Map
                </Button>

                <div className="pointer-events-auto flex gap-2">
                    <Button
                        onClick={() => {
                            if (position && mapRef.current) {
                                mapRef.current.setView([position.lat, position.lng], 18, { animate: true });
                            }
                        }}
                        size="icon"
                        className="bg-black/80 backdrop-blur-xl border border-yellow-500/50 text-yellow-500 hover:bg-yellow-500 hover:text-black rounded-full w-10 h-10 shadow-xl"
                    >
                        <Locate className="w-5 h-5" />
                    </Button>
                </div>
            </div>

            {/* Map */}
            <div className="flex-1">
                <MapContainer
                    center={center}
                    zoom={18}
                    style={{ height: '100%', width: '100%' }}
                    zoomControl={false}
                    attributionControl={false}
                >
                    <MapRefCapture mapRef={mapRef} />
                    <TileLayer
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                        attribution="&copy; Esri"
                    />
                    {/* Street labels on top of satellite */}
                    <TileLayer
                        url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
                        attribution=""
                    />

                    {/* GPS Position */}
                    <GpsLayer position={position} accuracy={accuracy} />

                    {/* Lines to nearest 3 */}
                    {position && nearbyProps.slice(0, 3).map((p, i) => (
                        <Polyline key={`line-${i}`}
                            positions={[[position.lat, position.lng], [p.lat, p.lng]]}
                            pathOptions={{ color: BRAND.gold, weight: 1.5, opacity: 0.4, dashArray: '4,8' }}
                        />
                    ))}

                    {/* Property Pins */}
                    {properties?.map((p) => {
                        const isNearby = nearbyProps.some(n => n.address_hash === p.address_hash);
                        const color = STATUS_COLORS[p.effective_status] || '#6b7280';
                        return (
                            <CircleMarker
                                key={p.address_hash}
                                center={[p.lat, p.lng]}
                                radius={isNearby ? 10 : 6}
                                eventHandlers={{ click: () => onSelectProperty(p) }}
                                pathOptions={{
                                    fillColor: color,
                                    fillOpacity: isNearby ? 0.95 : 0.6,
                                    color: isNearby ? BRAND.gold : '#000',
                                    weight: isNearby ? 2 : 1
                                }}
                            >
                                {isNearby && (
                                    <Tooltip direction="right" className="route-number-tooltip">
                                        <span style={{ color: '#fff', fontSize: '10px', fontWeight: 'bold', textShadow: '0 0 4px #000' }}>
                                            {p.house_number} {p.street_name?.split(' ').slice(0, 2).join(' ')}
                                        </span>
                                    </Tooltip>
                                )}
                            </CircleMarker>
                        );
                    })}
                </MapContainer>
            </div>

            {/* Bottom HUD - Nearby Properties */}
            <div className="absolute bottom-0 left-0 right-0 z-[1100] safe-area-bottom">
                <div className="bg-black/90 backdrop-blur-xl border-t border-yellow-500/30 rounded-t-2xl shadow-[0_-10px_30px_rgba(0,0,0,0.5)]">
                    {/* Toggle Bar */}
                    <button
                        onClick={() => setHudExpanded(!hudExpanded)}
                        className="w-full flex items-center justify-between px-4 py-3"
                    >
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            <span className="text-[10px] font-bold text-yellow-500 tracking-widest">NEARBY</span>
                            <Badge variant="outline" className="text-[9px] h-4 border-gray-700 text-gray-400">
                                {nearbyProps.length}
                            </Badge>
                        </div>
                        {hudExpanded ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronUp className="w-4 h-4 text-gray-500" />}
                    </button>

                    {hudExpanded && (
                        <div className="max-h-[200px] overflow-y-auto pb-4">
                            {nearbyProps.length === 0 ? (
                                <div className="px-4 py-6 text-center">
                                    <p className="text-xs text-gray-500">No properties within 800ft</p>
                                    <p className="text-[10px] text-gray-600 mt-1">Walk closer to your route</p>
                                </div>
                            ) : (
                                nearbyProps.map((p, i) => (
                                    <button
                                        key={p.address_hash}
                                        onClick={() => onSelectProperty(p)}
                                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/50 transition-colors border-b border-gray-800/50 last:border-0"
                                    >
                                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                                            style={{ background: STATUS_COLORS[p.effective_status] || '#333', color: '#fff' }}>
                                            {i + 1}
                                        </div>
                                        <div className="flex-1 text-left min-w-0">
                                            <p className="text-xs font-bold text-white truncate">
                                                {p.house_number} {p.street_name}
                                            </p>
                                            <p className="text-[10px] text-gray-500">
                                                {p.effective_status} • {p._distFt}ft
                                            </p>
                                        </div>
                                        <Navigation className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                                    </button>
                                ))
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}