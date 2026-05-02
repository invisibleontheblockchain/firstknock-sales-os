import React, { useState, useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Circle, Polyline, Tooltip, useMap, Marker } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix Leaflet unmount error during scroll wheel zoom
const originalGetMapPanePos = L.Map.prototype._getMapPanePos;
if (originalGetMapPanePos && !L.Map.prototype._getMapPanePos.isPatched) {
    L.Map.prototype._getMapPanePos = function () {
        if (!this._mapPane) return L.point(0, 0);
        return originalGetMapPanePos.call(this);
    };
    L.Map.prototype._getMapPanePos.isPatched = true;
}

// Fix leaflet fast-unmount/interaction error
const originalSetPosition = L.DomUtil.setPosition;
if (originalSetPosition && !L.DomUtil.setPosition.isPatched) {
    L.DomUtil.setPosition = function (el, point) {
        if (!el) return;
        return originalSetPosition.call(this, el, point);
    };
    L.DomUtil.setPosition.isPatched = true;
}
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Navigation, X, Locate, ChevronUp, ChevronDown } from 'lucide-react';

const BRAND = { gold: '#FFD93D', voidBlack: '#0A0A0F' };
const TOUCH_TARGET_ICON = L.divIcon({
    className: 'fk-property-touch-target',
    html: '<div style="width:48px;height:48px;border-radius:9999px;background:transparent;"></div>',
    iconSize: [48, 48],
    iconAnchor: [24, 24]
});

const STATUS_COLORS = {
    ELIGIBLE: '#8888A0',
    SOLD: '#00F5A0',
    HARD_NO: '#FF6B6B',
    CALLBACK: '#FFD93D',
    NO_ANSWER: '#8888A0',
    QUALIFIED: '#00F5A0',
    RECENT_OFF_MARKET: '#FFD93D',
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

function FlyToProperty({ focusProperty }) {
    const map = useMap();
    const hasFocused = useRef(false);
    useEffect(() => {
        if (focusProperty && map && !hasFocused.current) {
            try {
                map.setView([focusProperty.lat, focusProperty.lng], 18, { animate: true });
                hasFocused.current = true;
            } catch (e) {
                console.warn('FlyToProperty error', e);
            }
        }
    }, [focusProperty, map]);
    return null;
}

const GpsLayer = React.memo(function GpsLayer({ position, accuracy }) {
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
});

function PropertyPinLayer({ properties, nearbyHashes, onSelectProperty }) {
    return properties?.map((p, idx) => {
        const isNearby = nearbyHashes.has(p.address_hash);
        const effColorStatus = p.effective_status === 'ELIGIBLE' && p.original_status && ['SOLD', 'RECENT_OFF_MARKET', 'PENDING'].includes(p.original_status)
            ? p.original_status
            : p.effective_status;
        const color = STATUS_COLORS[effColorStatus] || '#6b7280';
        return (
            <React.Fragment key={p.address_hash}>
                <Marker
                    position={[p.lat, p.lng]}
                    icon={TOUCH_TARGET_ICON}
                    zIndexOffset={1000}
                    eventHandlers={{ click: () => onSelectProperty(p) }}
                />
                <CircleMarker
                    center={[p.lat, p.lng]}
                    radius={isNearby ? 8 : 6}
                    eventHandlers={{ click: () => onSelectProperty(p) }}
                    pathOptions={{
                        fillColor: idx === 0 ? '#22c55e' : color,
                        fillOpacity: 1,
                        color: '#fff',
                        weight: isNearby ? 2 : 1
                    }}
                >
                    <Tooltip direction="top" offset={[0, -5]} className="route-number-tooltip">
                        <span style={{
                            color: '#fff',
                            fontSize: isNearby ? '12px' : '10px',
                            fontWeight: 'bold',
                            textShadow: '0 1px 3px #000, 0 0 5px #000'
                        }}>
                            {p.house_number || idx + 1}
                        </span>
                    </Tooltip>
                </CircleMarker>
            </React.Fragment>
        );
    }) || null;
}

const MemoizedPropertyPinLayer = React.memo(PropertyPinLayer);

export default function RepMapView({ properties, onSelectProperty, onClose, focusProperty }) {
    const mapRef = useRef(null);
    const [position, setPosition] = useState(null);
    const [accuracy, setAccuracy] = useState(50);
    const [hudExpanded, setHudExpanded] = useState(true);

    const [mapSettings] = useState(() => {
        try {
            const saved = localStorage.getItem('fk_mapSettings_v2');
            return saved ? JSON.parse(saved) : {};
        } catch(e) { return {}; }
    });

    const LINE_DASH_MAP = {
        solid: null,
        dashed: '8,6',
        dotted: '2,4',
        dashdot: '10,4,2,4',
    };
    const lineDashArray = mapSettings.lineStyle === 'solid' ? undefined : (LINE_DASH_MAP[mapSettings.lineStyle] || '8,6');

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

    // Center map on GPS when first acquired (skip if focusing on a specific property)
    const hasCentered = useRef(false);
    useEffect(() => {
        if (focusProperty) return; // Don't auto-center on GPS when viewing a specific property
        if (position && mapRef.current && !hasCentered.current) {
            try {
                mapRef.current.setView([position.lat, position.lng], 18, { animate: false });
                hasCentered.current = true;
            } catch (e) {
                console.warn('Map not ready yet for setView', e);
            }
        }
    }, [position, focusProperty]);

    // Calculate nearby properties
    const nearbyProps = useMemo(() => {
        if (!position || !properties?.length) return [];
        return properties
            .map(p => {
                const distance = haversine(position.lat, position.lng, p.lat, p.lng);
                return {
                    ...p,
                    _dist: distance,
                    _distFt: Math.round(distance * 5280)
                };
            })
            .filter(p => p._dist <= 0.15) // ~800 ft
            .sort((a, b) => a._dist - b._dist)
            .slice(0, 15);
    }, [position, properties]);

    const nearbyHashes = useMemo(() => new Set(nearbyProps.map(p => p.address_hash)), [nearbyProps]);

    // Map center: prioritize focused property, then GPS, then first property
    const center = focusProperty
        ? [focusProperty.lat, focusProperty.lng]
        : position
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
                            try {
                                if (position && mapRef.current) {
                                    mapRef.current.setView([position.lat, position.lng], 18, { animate: true });
                                }
                            } catch (e) {
                                console.warn('Map setView error', e);
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
                    {focusProperty && <FlyToProperty focusProperty={focusProperty} />}
                    <TileLayer
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                        attribution="&copy; Esri"
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

                    {/* Route Path (Mail Carrier Style) */}
                    {properties?.length > 0 && (
                        <Polyline
                            positions={properties.map(p => [p.lat, p.lng])}
                            pathOptions={{ 
                                color: BRAND.gold, 
                                weight: mapSettings.lineWidth ? mapSettings.lineWidth + 2 : 4, 
                                opacity: mapSettings.lineOpacity ? Math.max(0.6, mapSettings.lineOpacity) : 0.8,
                                dashArray: lineDashArray 
                            }}
                        />
                    )}

                    {/* Property Pins */}
                    <MemoizedPropertyPinLayer
                        properties={properties}
                        nearbyHashes={nearbyHashes}
                        onSelectProperty={onSelectProperty}
                    />
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