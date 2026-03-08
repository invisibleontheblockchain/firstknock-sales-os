// @ts-nocheck
import React, { useState, useEffect, useMemo } from 'react';
import { Source, Layer, Marker } from 'react-map-gl/maplibre';
import { Navigation, ChevronUp, ChevronDown } from 'lucide-react';
import { Badge } from "@/components/ui/badge";
import circle from '@turf/circle';

const BRAND = { gold: '#FFD700', voidBlack: '#0A0A0A' };

const STATUS_COLORS = {
    ELIGIBLE: '#6b7280',
    SOLD: '#22c55e',
    HARD_NO: '#8B5CF6',
    CALLBACK: '#eab308',
    NO_ANSWER: '#6b7280',
    QUALIFIED: '#22c55e',
    OTHER: '#6b7280'
};

function haversine(lat1, lng1, lat2, lng2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function useGpsTracker(properties, isTracking) {
    const [position, setPosition] = useState(null);
    const [accuracy, setAccuracy] = useState(50);

    useEffect(() => {
        if (!isTracking) {
            setPosition(null);
            return;
        }

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

        return () => {
            if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        };
    }, [isTracking]);

    const nearbyProperties = useMemo(() => {
        if (!position || !properties?.length) return [];
        return properties
            .map(p => {
                const dist = haversine(position.lat, position.lng, p.lat, p.lng);
                return { ...p, _dist: dist, _distFt: Math.round(dist * 5280) };
            })
            .filter(p => p._dist <= 0.1) // ~500ft
            .sort((a, b) => a._dist - b._dist)
            .slice(0, 15);
    }, [position, properties]);

    return { position, accuracy, nearbyProperties };
}

function GpsMapLayer({ properties, isTracking, onSelectProperty }) {
    const { position, accuracy, nearbyProperties } = useGpsTracker(properties, isTracking);

    const accuracyGeoJSON = useMemo(() => {
        if (!position) return null;
        if (accuracy && accuracy < 500) {
            return circle([position.lng, position.lat], accuracy, { steps: 64, units: 'meters' });
        }
        return null; // hide if ridiculously large
    }, [position, accuracy]);

    const lineGeoJSON = useMemo(() => {
        if (!position || nearbyProperties.length === 0) return null;
        const features = nearbyProperties.slice(0, 3).map(p => ({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[position.lng, position.lat], [p.lng, p.lat]] },
            properties: {}
        }));
        return { type: 'FeatureCollection', features };
    }, [position, nearbyProperties]);

    const dotsGeoJSON = useMemo(() => {
        if (nearbyProperties.length === 0) return null;
        return {
            type: 'FeatureCollection',
            features: nearbyProperties.map(p => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                properties: {
                    color: STATUS_COLORS[p.effective_status] || '#6b7280'
                }
            }))
        };
    }, [nearbyProperties]);

    if (!position) return null;

    return (
        <>
            {/* Accuracy circle */}
            {accuracyGeoJSON && (
                <Source id="gps-accuracy" type="geojson" data={accuracyGeoJSON}>
                    <Layer
                        id="gps-accuracy-fill"
                        type="fill"
                        paint={{ 'fill-color': BRAND.gold, 'fill-opacity': 0.08 }}
                    />
                    <Layer
                        id="gps-accuracy-line"
                        type="line"
                        paint={{ 'line-color': BRAND.gold, 'line-width': 1, 'line-dasharray': [4, 4] }}
                    />
                </Source>
            )}

            {/* Lines to nearby properties */}
            {lineGeoJSON && (
                <Source id="gps-lines" type="geojson" data={lineGeoJSON}>
                    <Layer
                        id="gps-lines-layer"
                        type="line"
                        paint={{ 'line-color': BRAND.gold, 'line-width': 1, 'line-opacity': 0.3, 'line-dasharray': [3, 6] }}
                    />
                </Source>
            )}

            {/* Highlight nearby pins */}
            {dotsGeoJSON && (
                <Source id="gps-dots" type="geojson" data={dotsGeoJSON}>
                    <Layer
                        id="gps-dots-layer"
                        type="circle"
                        paint={{ 'circle-color': ['get', 'color'], 'circle-opacity': 0.95, 'circle-radius': 9, 'circle-stroke-width': 2, 'circle-stroke-color': BRAND.gold }}
                    />
                </Source>
            )}

            {/* GPS dot & Nearby Markers */}
            <Marker longitude={position.lng} latitude={position.lat} anchor="center">
                <div style={{
                    width: '16px', height: '16px', borderRadius: '50%', backgroundColor: BRAND.gold, border: '3px solid #000',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                    <div style={{ position: 'absolute', top: '-18px', color: BRAND.gold, fontWeight: '900', fontSize: '9px', textShadow: '0 0 4px #000' }}>
                        YOU
                    </div>
                </div>
            </Marker>

            {nearbyProperties.map((p, i) => (
                <Marker key={`nearby-${p.address_hash}-${i}`} longitude={p.lng} latitude={p.lat} anchor="center" 
                    onClick={e => { e.originalEvent.stopPropagation(); onSelectProperty(p); }}>
                    <div style={{ position: 'absolute', left: '12px', top: '-10px', backgroundColor: 'rgba(0,0,0,0.7)', padding: '2px 4px', borderRadius: '4px', color: '#fff', fontSize: '9px', fontWeight: 'bold', textShadow: '0 0 3px #000', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                        {p.house_number} {p.street_name?.split(' ').slice(0, 2).join(' ')}
                    </div>
                </Marker>
            ))}
        </>
    );
}

function GpsHud({ properties, isTracking, onToggleTracking, onSelectProperty }) {
    const { position, nearbyProperties } = useGpsTracker(properties, isTracking);
    const [expanded, setExpanded] = useState(true);

    if (!isTracking) return null;

    return (
        <div className="absolute bottom-24 left-4 right-4 z-[1100] pointer-events-none">
            <div className="pointer-events-auto bg-black/90 backdrop-blur-xl border border-yellow-500/30 rounded-2xl shadow-[0_0_30px_rgba(255,215,0,0.15)] overflow-hidden">
                {/* Header */}
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="w-full flex items-center justify-between px-4 py-3 border-b border-gray-800"
                >
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                        <span className="text-xs font-bold text-yellow-500 tracking-wider">LIVE TRACKING</span>
                        <Badge variant="outline" className="text-[9px] h-4 border-gray-700 text-gray-400">
                            {nearbyProperties.length} NEARBY
                        </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={(e) => { e.stopPropagation(); onToggleTracking(); }}
                            className="text-[9px] font-bold text-red-400 hover:text-red-300 px-2 py-1 rounded bg-red-900/20"
                        >
                            STOP
                        </button>
                        {expanded ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronUp className="w-4 h-4 text-gray-500" />}
                    </div>
                </button>

                {/* Nearby List */}
                {expanded && position && nearbyProperties.length > 0 && (
                    <div className="max-h-[180px] overflow-y-auto">
                        {nearbyProperties.slice(0, 8).map((p, i) => (
                            <button
                                key={`hud-${p.address_hash}-${i}`}
                                onClick={() => onSelectProperty(p)}
                                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/50 transition-colors border-b border-gray-800/50 last:border-0"
                            >
                                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                                    style={{ background: STATUS_COLORS[p.effective_status] || '#333', color: '#fff' }}>
                                    {i + 1}
                                </div>
                                <div className="flex-1 text-left min-w-0">
                                    <p className="text-xs font-bold text-white truncate">{p.house_number} {p.street_name}</p>
                                    <p className="text-[10px] text-gray-500">{p.effective_status} • {p._distFt}ft away</p>
                                </div>
                                <Navigation className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                            </button>
                        ))}
                    </div>
                )}

                {expanded && position && nearbyProperties.length === 0 && (
                    <div className="px-4 py-6 text-center">
                        <p className="text-xs text-gray-500">No properties within 500ft. Keep moving!</p>
                    </div>
                )}
                
                {expanded && !position && (
                    <div className="px-4 py-6 text-center flex flex-col items-center gap-2">
                        <div className="w-4 h-4 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin"></div>
                        <p className="text-xs text-gray-500">Locating GPS...</p>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function GpsTracker() {
    return null;
}

export { GpsMapLayer, GpsHud, haversine };