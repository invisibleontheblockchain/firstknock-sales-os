// @ts-nocheck
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Map, Source, Layer, Marker } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Navigation, X, Locate, ChevronUp, ChevronDown } from 'lucide-react';
import circle from '@turf/circle';

const BRAND = { gold: '#FFD93D', voidBlack: '#0A0A0F' };

const STATUS_COLORS = {
    ELIGIBLE: '#8888A0',
    SOLD: '#00F5A0',
    HARD_NO: '#FF6B6B',
    CALLBACK: '#FFD93D',
    NO_ANSWER: '#8888A0',
    QUALIFIED: '#00F5A0',
};

function haversine(lat1, lng1, lat2, lng2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function RepMapView({ properties, onSelectProperty, onClose }) {
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
        dashed: [8, 6],
        dotted: [2, 4],
        dashdot: [10, 4, 2, 4],
    };
    const lineDashArray = mapSettings.lineStyle === 'solid' ? undefined : (LINE_DASH_MAP[mapSettings.lineStyle] || [8, 6]);

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
            mapRef.current.flyTo({ center: [position.lng, position.lat], zoom: 18, animate: false });
            hasCentered.current = true;
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
        ? { longitude: position.lng, latitude: position.lat }
        : properties?.[0]
            ? { longitude: properties[0].lng, latitude: properties[0].lat }
            : { longitude: -79.93, latitude: 32.78 };

    // GeoJSON calculations
    const accuracyGeoJSON = useMemo(() => {
        if (!position || !accuracy || accuracy >= 500) return null;
        return circle([position.lng, position.lat], accuracy, { steps: 64, units: 'meters' });
    }, [position, accuracy]);

    const lineGeoJSON = useMemo(() => {
        if (!position || nearbyProps.length === 0) return null;
        return {
            type: 'FeatureCollection',
            features: nearbyProps.slice(0, 3).map(p => ({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: [[position.lng, position.lat], [p.lng, p.lat]] }
            }))
        };
    }, [position, nearbyProps]);

    const routePathGeoJSON = useMemo(() => {
        if (!properties?.length) return null;
        return {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: properties.map(p => [p.lng, p.lat]) }
        };
    }, [properties]);

    const propertyMarkersGeoJSON = useMemo(() => {
        if (!properties?.length) return null;
        return {
            type: 'FeatureCollection',
            features: properties.map((p, idx) => {
                const isNearby = nearbyProps.some(n => n.address_hash === p.address_hash);
                const color = STATUS_COLORS[p.effective_status] || '#6b7280';
                return {
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                    properties: { ...p, idx, isNearby, color: idx === 0 ? '#22c55e' : color }
                };
            })
        };
    }, [properties, nearbyProps]);

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
                                mapRef.current.flyTo({ center: [position.lng, position.lat], zoom: 18 });
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
            <div className="flex-1 relative">
                <Map
                    ref={mapRef}
                    initialViewState={{
                        longitude: center.longitude,
                        latitude: center.latitude,
                        zoom: 18
                    }}
                    style={{ height: '100%', width: '100%' }}
                    mapStyle={{
                        version: 8,
                        sources: {
                            satellite: {
                                type: 'raster',
                                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                                tileSize: 256
                            },
                            labels: {
                                type: 'raster',
                                tiles: ['https://a.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}@2x.png'],
                                tileSize: 256
                            }
                        },
                        layers: [
                            { id: 'satellite-layer', type: 'raster', source: 'satellite', minzoom: 0, maxzoom: 22 },
                            { id: 'labels-layer', type: 'raster', source: 'labels', minzoom: 0, maxzoom: 22 }
                        ]
                    }}
                    interactiveLayerIds={['property-markers']}
                    onClick={(e) => {
                        const feature = e.features && e.features[0];
                        if (feature && feature.source === 'properties' && onSelectProperty) {
                            onSelectProperty(feature.properties);
                        }
                    }}
                >
                    {/* Route Path (Mail Carrier Style) */}
                    {routePathGeoJSON && (
                        <Source id="route-path" type="geojson" data={routePathGeoJSON}>
                            <Layer
                                id="route-path-layer"
                                type="line"
                                paint={{
                                    'line-color': BRAND.gold,
                                    'line-width': mapSettings.lineWidth ? mapSettings.lineWidth + 2 : 4,
                                    'line-opacity': mapSettings.lineOpacity ? Math.max(0.6, mapSettings.lineOpacity) : 0.8,
                                    'line-dasharray': lineDashArray
                                }}
                            />
                        </Source>
                    )}

                    {/* Lines to nearest 3 */}
                    {lineGeoJSON && (
                        <Source id="nearby-lines" type="geojson" data={lineGeoJSON}>
                            <Layer
                                id="nearby-lines-layer"
                                type="line"
                                paint={{
                                    'line-color': BRAND.gold,
                                    'line-width': 1.5,
                                    'line-opacity': 0.4,
                                    'line-dasharray': [4, 8]
                                }}
                            />
                        </Source>
                    )}

                    {/* GPS Accuracy */}
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

                    {/* GPS Position */}
                    {position && (
                        <Marker longitude={position.lng} latitude={position.lat} anchor="center">
                            <div style={{
                                width: '20px', height: '20px', borderRadius: '50%', backgroundColor: BRAND.gold, border: '3px solid #000',
                                display: 'flex', alignItems: 'center', justifyContent: 'center'
                            }}>
                                <div style={{ position: 'absolute', top: '-20px', color: BRAND.gold, fontWeight: '900', fontSize: '10px', textShadow: '0 0 6px #000' }}>
                                    YOU
                                </div>
                            </div>
                        </Marker>
                    )}

                    {/* Property Pins */}
                    {propertyMarkersGeoJSON && (
                        <Source id="properties" type="geojson" data={propertyMarkersGeoJSON}>
                            <Layer
                                id="property-markers"
                                type="circle"
                                paint={{
                                    'circle-color': ['get', 'color'],
                                    'circle-radius': ['case', ['get', 'isNearby'], 8, 5],
                                    'circle-stroke-color': '#ffffff',
                                    'circle-stroke-width': ['case', ['get', 'isNearby'], 2, 1]
                                }}
                            />
                        </Source>
                    )}

                    {/* Property Labels */}
                    {properties?.map((p, idx) => {
                        const isNearby = nearbyProps.some(n => n.address_hash === p.address_hash);
                        return (
                            <Marker key={`label-${p.address_hash}`} longitude={p.lng} latitude={p.lat} anchor="bottom" offset={[0, -5]} style={{pointerEvents:'none'}}>
                                <span style={{
                                    color: '#fff',
                                    fontSize: isNearby ? '12px' : '10px',
                                    fontWeight: 'bold',
                                    textShadow: '0 1px 3px #000, 0 0 5px #000'
                                }}>
                                    {idx + 1}
                                </span>
                            </Marker>
                        )
                    })}
                </Map>
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