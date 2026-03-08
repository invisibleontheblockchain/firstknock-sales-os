import React, { useState, useEffect, useMemo, useRef } from 'react';
import Map, { Source, Layer, Marker } from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Navigation, X, Locate, ChevronUp, ChevronDown } from 'lucide-react';

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
        solid: [1],
        dashed: [2, 2],
        dotted: [1, 2],
        dashdot: [3, 1, 1, 1],
    };
    const lineDashArray = mapSettings.lineStyle === 'solid' ? undefined : (LINE_DASH_MAP[mapSettings.lineStyle] || [2, 2]);

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
                mapRef.current.getMap().flyTo({ center: [position.lng, position.lat], zoom: 18, animate: false });
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
    const initialViewState = {
        longitude: position ? position.lng : (properties?.[0] ? properties[0].lng : -79.93),
        latitude: position ? position.lat : (properties?.[0] ? properties[0].lat : 32.78),
        zoom: 18
    };

    // GeoJSON Data Generation
    const geojsonData = useMemo(() => {
         const features = [];
         
         // 1. Property Pins
         if (properties?.length > 0) {
             properties.forEach((p, idx) => {
                  const isNearby = nearbyProps.some(n => n.address_hash === p.address_hash);
                  features.push({
                      type: 'Feature',
                      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                      properties: {
                          isPropertyNode: true,
                          index: idx + 1,
                          color: idx === 0 ? '#22c55e' : (STATUS_COLORS[p.effective_status] || '#6b7280'),
                          radius: isNearby ? 8 : 5,
                          isNearby: isNearby,
                          address_hash: p.address_hash
                      }
                  });
             });
             
             // 2. Route Path
             features.push({
                  type: 'Feature',
                  geometry: {
                      type: 'LineString',
                      coordinates: properties.map(p => [p.lng, p.lat])
                  },
                  properties: { isRoutePath: true }
             });
         }

         // 3. GPS Position & Lines
         if (position) {
              // Accuracy Circle
             features.push({
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [position.lng, position.lat] },
                  properties: { isAccuracyCircle: true, accuracyRadius: accuracy }
             });

             // Lines to nearby
             nearbyProps.slice(0, 3).forEach(p => {
                  features.push({
                       type: 'Feature',
                       geometry: {
                            type: 'LineString',
                            coordinates: [[position.lng, position.lat], [p.lng, p.lat]]
                       },
                       properties: { isNearbyLine: true }
                  });
             });
         }

         return { type: 'FeatureCollection', features };
    }, [properties, nearbyProps, position, accuracy]);

    const handleMapClick = (e) => {
        // MapLibre approach to feature clicking
        if (e.features && e.features.length > 0) {
            const feature = e.features.find(f => f.properties.isPropertyNode);
            if (feature) {
                 const prop = properties.find(p => p.address_hash === feature.properties.address_hash);
                 if (prop) onSelectProperty(prop);
            }
        }
    };

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
                                    mapRef.current.getMap().flyTo({ center: [position.lng, position.lat], zoom: 18, animate: true });
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
                <Map
                    ref={mapRef}
                    initialViewState={initialViewState}
                    mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" // Switching to Carto Positron for now
                    interactiveLayerIds={['property-points']}
                    onClick={handleMapClick}
                    style={{ width: '100%', height: '100%' }}
                    attributionControl={false}
                >
                    <Source id="rep-map-data" type="geojson" data={geojsonData}>
                        {/* Route Path */}
                        <Layer 
                            id="route-path" 
                            type="line" 
                            filter={['==', ['get', 'isRoutePath'], true]}
                            paint={{
                                'line-color': BRAND.gold,
                                'line-width': mapSettings.lineWidth ? mapSettings.lineWidth + 2 : 4,
                                'line-opacity': mapSettings.lineOpacity ? Math.max(0.6, mapSettings.lineOpacity) : 0.8,
                                'line-dasharray': lineDashArray || [1]
                            }}
                        />

                        {/* GPS to Nearby Lines */}
                        <Layer 
                            id="gps-nearby-lines" 
                            type="line" 
                            filter={['==', ['get', 'isNearbyLine'], true]}
                            paint={{
                                'line-color': BRAND.gold,
                                'line-width': 1.5,
                                'line-opacity': 0.4,
                                'line-dasharray': [4, 8]
                            }}
                        />

                        {/* GPS Accuracy Circle */}
                        <Layer 
                            id="gps-accuracy-circle" 
                            type="circle" 
                            filter={['==', ['get', 'isAccuracyCircle'], true]}
                            paint={{
                                'circle-radius': 50, // Approximation
                                'circle-color': BRAND.gold,
                                'circle-opacity': 0.08,
                                'circle-stroke-color': BRAND.gold,
                                'circle-stroke-width': 1,
                                'circle-stroke-opacity': 0.8
                            }}
                        />

                        {/* Property Pins */}
                        <Layer 
                            id="property-points" 
                            type="circle" 
                            filter={['==', ['get', 'isPropertyNode'], true]}
                            paint={{
                                'circle-radius': ['get', 'radius'],
                                'circle-color': ['get', 'color'],
                                'circle-opacity': 1,
                                'circle-stroke-color': '#fff',
                                'circle-stroke-width': ['case', ['get', 'isNearby'], 2, 1]
                            }}
                        />
                        
                        {/* Property Labels */}
                        <Layer 
                            id="property-labels" 
                            type="symbol" 
                            filter={['==', ['get', 'isPropertyNode'], true]}
                            layout={{
                                'text-field': ['to-string', ['get', 'index']],
                                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                                'text-size': ['case', ['get', 'isNearby'], 12, 10],
                                'text-offset': [0, -1.2],
                                'text-anchor': 'bottom'
                            }}
                            paint={{
                                'text-color': '#FFFFFF',
                                'text-halo-color': '#000000',
                                'text-halo-width': 1
                            }}
                        />
                    </Source>

                    {/* GPS Dot Marker */}
                    {position && (
                         <Marker longitude={position.lng} latitude={position.lat} anchor="center">
                              <div className="relative flex items-center justify-center">
                                   <div className="w-5 h-5 rounded-full border-2 border-black" style={{ backgroundColor: BRAND.gold }}></div>
                                   <div className="absolute -top-5 whitespace-nowrap" style={{ color: BRAND.gold, fontWeight: '900', fontSize: '10px', textShadow: '0 0 6px #000' }}>
                                       YOU
                                   </div>
                              </div>
                         </Marker>
                    )}
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

