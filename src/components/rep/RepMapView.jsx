import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MapContainer, TileLayer, CircleMarker, Circle, Polyline, Tooltip, useMap, LayerGroup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { routePropertyOrderFingerprint } from '@/components/logic/routeRoadContext';
import MapAttributionControl from '@/components/map/MapAttributionControl';
import { ESRI_IMAGERY_ATTRIBUTION } from '@/components/map/mapAttribution';

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

const BRAND = { gold: '#2EEB57', voidBlack: '#0A0A0F' };
const CANVAS_RENDERER = L.canvas({ padding: 0.5 });
// Thumb-sized hit area drawn into the shared canvas. A DOM marker per door is
// what made zooming stutter: every pin was an element the browser had to
// re-transform on each animation frame.
const TOUCH_TARGET_RADIUS = 22;

function isRoutePoint(point) {
    if (!point || point.lat === null || point.lat === undefined || point.lat === '' || point.lng === null || point.lng === undefined || point.lng === '') return false;
    return Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng));
}

const STATUS_COLORS = {
    ELIGIBLE: '#8888A0',
    SOLD: '#00F5A0',
    HARD_NO: '#FF6B6B',
    CALLBACK: '#39FF4A',
    NO_ANSWER: '#FF6B6B',
    QUALIFIED: '#2EEB57',
    RECENT_OFF_MARKET: '#39FF4A',
    NOT_MOVED_IN: '#FF6B6B',
    DM_NOT_HOME: '#FF6B6B',
    DO_NOT_KNOCK: '#FF6B6B',
};

function getOutcomeDotColor(property) {
    const status = property?.effective_status || property?.parsed_status || property?.original_status || 'ELIGIBLE';
    if (['SOLD', 'CALLBACK', 'QUALIFIED', 'RECENT_OFF_MARKET'].includes(status)) return '#2EEB57';
    if (['HARD_NO', 'NO_ANSWER', 'NOT_MOVED_IN', 'DM_NOT_HOME', 'DO_NOT_KNOCK'].includes(status)) return '#FF6B6B';
    return '#8888A0';
}

function getFieldRoutesPinStyle(property) {
    const tone = property?.fieldroutes_status?.tone;
    if (tone === 'synced') return { color: '#38BDF8', label: 'FieldRoutes sent' };
    if (tone === 'attention') return { color: '#FB7185', label: 'FieldRoutes needs review' };
    if (tone === 'device') return { color: '#FBBF24', label: 'FieldRoutes saved on device', dashArray: '3 3' };
    if (tone === 'pending') return { color: '#F59E0B', label: 'FieldRoutes sync pending', dashArray: '4 3' };
    return null;
}

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

    useEffect(() => {
        if (!map) return;
        map.options.wheelPxPerZoomLevel = 48;
        map.options.wheelDebounceTime = 35;
        map.options.zoomDelta = 1;
        map.options.zoomSnap = 0.25;
        map.options.zoomAnimationThreshold = 4;
        map.options.easeLinearity = 0.25;
    }, [map]);

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
                renderer={CANVAS_RENDERER}
                pathOptions={{ fillColor: BRAND.gold, fillOpacity: 0.08, color: BRAND.gold, weight: 1, dashArray: '4,4' }} />
            <CircleMarker center={[position.lat, position.lng]} radius={10}
                renderer={CANVAS_RENDERER}
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
        const color = getOutcomeDotColor(p);
        const fieldRoutes = getFieldRoutesPinStyle(p);
        return (
            <LayerGroup key={p.address_hash}>
                <CircleMarker
                    center={[p.lat, p.lng]}
                    radius={TOUCH_TARGET_RADIUS}
                    renderer={CANVAS_RENDERER}
                    eventHandlers={{ click: () => onSelectProperty(p) }}
                    bubblingMouseEvents={false}
                    pathOptions={{ fillOpacity: 0, opacity: 0, weight: 0 }}
                />
                {fieldRoutes && (
                    <CircleMarker
                        center={[p.lat, p.lng]}
                        radius={isNearby ? 12 : 10}
                        renderer={CANVAS_RENDERER}
                        interactive={false}
                        pathOptions={{
                            fillOpacity: 0,
                            color: fieldRoutes.color,
                            weight: 3,
                            dashArray: fieldRoutes.dashArray,
                        }}
                    />
                )}
                <CircleMarker
                    center={[p.lat, p.lng]}
                    radius={isNearby ? 8 : 6}
                    renderer={CANVAS_RENDERER}
                    eventHandlers={{ click: () => onSelectProperty(p) }}
                    bubblingMouseEvents={false}
                    pathOptions={{
                        fillColor: color,
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
                            {fieldRoutes && <span style={{ display: 'block', color: fieldRoutes.color, fontSize: '8px' }}>{fieldRoutes.label}</span>}
                        </span>
                    </Tooltip>
                </CircleMarker>
            </LayerGroup>
        );
    }) || null;
}

const MemoizedPropertyPinLayer = React.memo(PropertyPinLayer);

export default function RepMapView({
    properties,
    onSelectProperty,
    onClose,
    focusProperty,
    startLocation = null,
    endLocation = null,
    roadGeometry = null,
    roadGeometryFingerprint = '',
}) {
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
    const routePathPositions = useMemo(() => {
        const currentFingerprint = routePropertyOrderFingerprint(properties);
        if (
            roadGeometryFingerprint
            && currentFingerprint === roadGeometryFingerprint
            && Array.isArray(roadGeometry)
            && roadGeometry.length > 1
            && roadGeometry.length <= 12000
        ) {
            const persisted = roadGeometry
                .filter(isRoutePoint)
                .map(point => [Number(point.lat), Number(point.lng)]);
            if (persisted.length === roadGeometry.length) return persisted;
        }
        const positions = (properties || []).filter(isRoutePoint).map(p => [Number(p.lat), Number(p.lng)]);
        const effectiveStart = isRoutePoint(startLocation)
            ? startLocation
            : isRoutePoint(endLocation) && isRoutePoint(position)
                ? position
                : null;
        if (effectiveStart) positions.unshift([Number(effectiveStart.lat), Number(effectiveStart.lng)]);
        if (isRoutePoint(endLocation)) positions.push([Number(endLocation.lat), Number(endLocation.lng)]);
        return positions;
    }, [endLocation, position, properties, roadGeometry, roadGeometryFingerprint, startLocation]);
    const endpointsMatch = isRoutePoint(startLocation) && isRoutePoint(endLocation)
        && Number(startLocation.lat) === Number(endLocation.lat)
        && Number(startLocation.lng) === Number(endLocation.lng);

    // Map center: prioritize focused property, then GPS, then first property
    const center = focusProperty
        ? [focusProperty.lat, focusProperty.lng]
        : position
            ? [position.lat, position.lng]
            : properties?.[0]
                ? [properties[0].lat, properties[0].lng]
                : [32.78, -79.93];

    const overlay = (
        <div className="fixed inset-0 z-[9999] isolate bg-black flex flex-col">
            {/* Header */}
            <div className="absolute top-[calc(env(safe-area-inset-top)+0.75rem)] left-0 right-0 z-[1200] px-3 flex items-center justify-between pointer-events-none">
                <Button
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onClose();
                    }}
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                    size="sm"
                    aria-label="Close FirstKnock map and return to Knock tab"
                    className="pointer-events-auto touch-manipulation select-none bg-black/95 backdrop-blur-xl text-white border border-white/20 hover:bg-gray-800 rounded-full h-12 sm:h-14 px-4 sm:px-6 shadow-[0_12px_35px_rgba(0,0,0,0.65)] active:scale-95"
                >
                    <X className="w-4 h-4 sm:mr-1" /> <span className="hidden sm:inline">Close Map</span>
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
                        className="touch-manipulation select-none bg-black/80 backdrop-blur-xl border border-[#2EEB57]/50 text-[#39FF4A] hover:bg-[#2EEB57] hover:text-black rounded-full w-12 h-12 shadow-xl active:scale-95"
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
                    maxZoom={22}
                    zoomSnap={0.25}
                    zoomDelta={1}
                    wheelPxPerZoomLevel={48}
                    wheelDebounceTime={35}
                    style={{ height: '100%', width: '100%', touchAction: 'pan-x pan-y pinch-zoom' }}
                    zoomControl={false}
                    attributionControl
                    preferCanvas={true}
                    zoomAnimation={true}
                    fadeAnimation={false}
                    markerZoomAnimation={false}
                    zoomAnimationThreshold={4}
                    easeLinearity={0.25}
                    inertia={true}
                    inertiaDeceleration={3000}
                    tapTolerance={24}
                >
                    <MapRefCapture mapRef={mapRef} />
                    {focusProperty && <FlyToProperty focusProperty={focusProperty} />}
                    <TileLayer
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                        attribution=""
                        maxNativeZoom={19}
                        maxZoom={22}
                        updateWhenZooming={false}
                        updateWhenIdle={false}
                        updateInterval={120}
                        keepBuffer={2}
                    />

                    {/* GPS Position */}
                    <GpsLayer position={position} accuracy={accuracy} />

                    {/* Lines to nearest 3 */}
                    {position && nearbyProps.slice(0, 3).map((p, i) => (
                        <Polyline key={`line-${i}`}
                            positions={[[position.lat, position.lng], [p.lat, p.lng]]}
                            renderer={CANVAS_RENDERER}
                            pathOptions={{ color: BRAND.gold, weight: 1.5, opacity: 0.4, dashArray: '4,8' }}
                        />
                    ))}

                    {/* Route Path (Mail Carrier Style) */}
                    {routePathPositions.length > 1 && (
                        <Polyline
                            positions={routePathPositions}
                            renderer={CANVAS_RENDERER}
                            smoothFactor={2}
                            pathOptions={{ 
                                color: BRAND.gold, 
                                weight: mapSettings.lineWidth ? mapSettings.lineWidth + 2 : 4, 
                                opacity: mapSettings.lineOpacity ? Math.max(0.6, mapSettings.lineOpacity) : 0.8,
                                dashArray: lineDashArray 
                            }}
                        />
                    )}

                    {isRoutePoint(startLocation) && (
                        <CircleMarker
                            center={[Number(startLocation.lat), Number(startLocation.lng)]}
                            radius={8}
                            pathOptions={{ color: '#ffffff', fillColor: BRAND.gold, fillOpacity: 1, weight: 2 }}
                        >
                            <Tooltip permanent direction="top" offset={[0, -8]}>{endpointsMatch ? 'Home • Start / Finish' : 'Start'}</Tooltip>
                        </CircleMarker>
                    )}
                    {!endpointsMatch && isRoutePoint(endLocation) && (
                        <CircleMarker
                            center={[Number(endLocation.lat), Number(endLocation.lng)]}
                            radius={8}
                            pathOptions={{ color: '#ffffff', fillColor: '#60A5FA', fillOpacity: 1, weight: 2 }}
                        >
                            <Tooltip permanent direction="top" offset={[0, -8]}>Finish</Tooltip>
                        </CircleMarker>
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
                <div className="bg-black/90 backdrop-blur-2xl border-t border-[#2EEB57]/25 rounded-t-3xl shadow-[0_-18px_55px_rgba(0,0,0,0.65)]">
                    {/* Toggle Bar */}
                    <button
                        onClick={() => setHudExpanded(!hudExpanded)}
                        className="w-full touch-manipulation select-none flex items-center justify-between px-4 py-4 active:bg-white/5"
                    >
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            <span className="text-[10px] font-black text-[#39FF4A] tracking-[0.22em]">NEARBY</span>
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
                                        className="w-full touch-manipulation select-none flex items-center gap-3 px-4 py-3.5 hover:bg-gray-800/50 active:bg-gray-800/70 transition-colors border-b border-gray-800/50 last:border-0"
                                    >
                                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                                            style={{ background: getOutcomeDotColor(p), color: '#fff' }}>
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
                                        <Navigation className="w-3.5 h-3.5 text-[#39FF4A] shrink-0" />
                                    </button>
                                ))
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );

    return typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay;
}