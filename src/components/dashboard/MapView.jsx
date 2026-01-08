import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, Circle, Polyline } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { parseResult } from '../logic/nlpParser';
import { generateGhostLeads } from '../logic/ghostLeadGenerator';
import { determineEffectiveStatus, generateSweepRoute } from '../logic/territoryLogic';
import { Locate, Navigation, Plus, Search, Layers, Maximize } from 'lucide-react';
import moment from 'moment';

// Fix Leaflet icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Custom Icons
const createIcon = (color) => new L.DivIcon({
    className: 'custom-icon',
    html: `<div style="background-color: ${color}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
});

const createGhostIcon = () => new L.DivIcon({
    className: 'ghost-icon',
    html: `<div style="background-color: #10b981; width: 10px; height: 10px; border-radius: 50%; border: 2px dashed white; opacity: 0.6;"></div>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5]
});

const Icons = {
    ELIGIBLE: createIcon('#22c55e'), // Green
    SOLD: createIcon('#ef4444'),     // Red
    HARD_NO: createIcon('#ef4444'),  // Red
    CALLBACK: createIcon('#eab308'), // Yellow
    NO_ANSWER: createIcon('#94a3b8'),// Grey
    GHOST: createGhostIcon()         // Ghost
};

function LocationMarker() {
    const [position, setPosition] = useState(null);
    const map = useMap();

    useEffect(() => {
        map.locate().on("locationfound", function (e) {
            setPosition(e.latlng);
            // map.flyTo(e.latlng, map.getZoom()); // Don't auto-fly to GPS on load if we have properties to show
        });
    }, [map]);

    return position === null ? null : (
        <Circle center={position} radius={20} pathOptions={{ fillColor: '#3b82f6', fillOpacity: 0.2, color: '#3b82f6', weight: 1 }} />
    );
}

// Component to auto-fit map bounds to properties
function MapAutoFitter({ markers }) {
    const map = useMap();
    const [fitted, setFitted] = React.useState(false);

    useEffect(() => {
        if (!fitted && markers.length > 0 && map) {
            setTimeout(() => {
                try {
                    const validMarkers = markers.filter(m => 
                        m && m.lat && m.lng && 
                        !isNaN(parseFloat(m.lat)) && !isNaN(parseFloat(m.lng)) &&
                        Math.abs(m.lat) <= 90 && Math.abs(m.lng) <= 180
                    );
                    if (validMarkers.length > 0) {
                        const bounds = L.latLngBounds(validMarkers.map(m => [parseFloat(m.lat), parseFloat(m.lng)]));
                        if (bounds.isValid()) {
                            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
                            setFitted(true);
                        }
                    }
                } catch (err) {
                    console.error("Error fitting bounds:", err);
                }
            }, 200);
        }
    }, [markers.length, map, fitted]);

    return null;
}

export default function MapView({ properties, logs, onLogInteraction }) {
    const [selectedProp, setSelectedProp] = useState(null);
    const [interactionText, setInteractionText] = useState("");
    const [parsedResult, setParsedResult] = useState(null);

    // Validate and calculate effective status for all properties
    const effectiveProperties = properties
        .filter(prop => 
            prop && prop.lat && prop.lng && 
            !isNaN(parseFloat(prop.lat)) && !isNaN(parseFloat(prop.lng)) &&
            Math.abs(prop.lat) <= 90 && Math.abs(prop.lng) <= 180
        )
        .map(prop => {
            const propLogs = logs.filter(l => l.address_hash === prop.address_hash);
            const status = determineEffectiveStatus(prop, propLogs);
            return { 
                ...prop, 
                lat: parseFloat(prop.lat), 
                lng: parseFloat(prop.lng),
                effective_status: status 
            };
        });

    // Generate Ghost Leads only if we have valid properties
    const ghostLeads = properties.length > 0 ? generateGhostLeads(properties) : [];

    // Apply logs to Ghost Leads so they maintain status
    const effectiveGhostLeads = ghostLeads
        .filter(prop => 
            prop && prop.lat && prop.lng && 
            !isNaN(parseFloat(prop.lat)) && !isNaN(parseFloat(prop.lng)) &&
            Math.abs(prop.lat) <= 90 && Math.abs(prop.lng) <= 180
        )
        .map(prop => {
            const propLogs = logs.filter(l => l.address_hash === prop.address_hash);
            const status = determineEffectiveStatus(prop, propLogs);
            return { 
                ...prop,
                lat: parseFloat(prop.lat), 
                lng: parseFloat(prop.lng),
                effective_status: status 
            };
        });

    const allMarkers = [...effectiveProperties, ...effectiveGhostLeads];

    // Generate Sweep Route with validation
    const sweepRoute = allMarkers.length > 0 
        ? generateSweepRoute(allMarkers).filter(pos => 
            pos && Array.isArray(pos) && pos.length === 2 && 
            !isNaN(parseFloat(pos[0])) && !isNaN(parseFloat(pos[1]))
          )
        : [];

    const handleInteractionChange = (e) => {
        const text = e.target.value;
        setInteractionText(text);
        setParsedResult(parseResult(text));
    };

    const submitInteraction = () => {
        if (!selectedProp || !parsedResult) return;
        
        onLogInteraction({
            address_hash: selectedProp.address_hash,
            raw_input_text: interactionText,
            parsed_status: parsedResult.status,
            next_eligible_date: parsedResult.nextDate,
            gps_proof_lat: selectedProp.lat, // In real app, use actual GPS
            gps_proof_lng: selectedProp.lng
        });
        
        setSelectedProp(null);
        setInteractionText("");
        setParsedResult(null);
    };

    // Calculate center with validation
    const center = effectiveProperties.length > 0 
        ? [effectiveProperties[0].lat, effectiveProperties[0].lng] 
        : [34.0522, -118.2437]; // Default LA

    return (
        <div className="relative w-full h-full">
            <MapContainer 
                center={center} 
                zoom={18} 
                style={{ height: '100%', width: '100%', background: '#1e293b' }}
                zoomControl={false}
            >
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <LocationMarker />
                <MapAutoFitter markers={allMarkers} />
                
                {/* Sweep Route Line */}
                {sweepRoute.length > 0 && (
                    <Polyline 
                        positions={sweepRoute} 
                        pathOptions={{ color: '#6366f1', weight: 3, opacity: 0.5, dashArray: '10, 10' }} 
                    />
                )}

                {allMarkers.map((prop) => {
                    if (!prop.lat || !prop.lng || isNaN(prop.lat) || isNaN(prop.lng)) return null;
                    return (
                        <Marker 
                            key={prop.address_hash} 
                            position={[prop.lat, prop.lng]}
                            icon={prop.is_ghost ? Icons.GHOST : Icons[prop.effective_status] || Icons.ELIGIBLE}
                            eventHandlers={{
                                click: () => setSelectedProp(prop),
                            }}
                        />
                    );
                })}
            </MapContainer>

            {/* Floating Action Buttons */}
            <div className="absolute bottom-24 right-4 flex flex-col gap-2 z-[400]">
                 <Button 
                    className="rounded-full w-12 h-12 shadow-lg bg-slate-800 hover:bg-slate-700"
                    size="icon"
                    onClick={() => {
                        try {
                            const map = document.querySelector('.leaflet-container')?._leaflet_map;
                            if (map && allMarkers.length > 0) {
                                const validMarkers = allMarkers.filter(m => m.lat && m.lng && !isNaN(m.lat) && !isNaN(m.lng));
                                if (validMarkers.length > 0) {
                                    const bounds = L.latLngBounds(validMarkers.map(m => [m.lat, m.lng]));
                                    if (bounds.isValid()) {
                                        map.fitBounds(bounds, { padding: [50, 50] });
                                    }
                                }
                            }
                        } catch (err) {
                            console.error("Error fitting bounds:", err);
                        }
                    }}
                    title="Fit to Properties"
                >
                    <Maximize className="w-5 h-5 text-white" />
                </Button>
                <Button 
                    className="rounded-full w-12 h-12 shadow-lg bg-slate-800 hover:bg-slate-700"
                    size="icon"
                >
                    <Locate className="w-5 h-5 text-white" />
                </Button>
            </div>

            {/* Interaction Drawer */}
            <Drawer open={!!selectedProp} onOpenChange={(open) => !open && setSelectedProp(null)}>
                <DrawerContent className="bg-slate-900 border-t-slate-700 text-slate-100">
                    <div className="mx-auto w-full max-w-sm">
                        <DrawerHeader>
                            <div className="flex justify-between items-start">
                                <div>
                                    <DrawerTitle className="text-xl font-bold">{selectedProp?.full_address}</DrawerTitle>
                                    <DrawerDescription className="text-slate-400">
                                        Current Status: <span className={
                                            selectedProp?.effective_status === 'ELIGIBLE' ? 'text-green-400' :
                                            selectedProp?.effective_status === 'SOLD' ? 'text-red-400' :
                                            selectedProp?.effective_status === 'CALLBACK' ? 'text-yellow-400' : 'text-slate-400'
                                        }>{selectedProp?.effective_status}</span>
                                        {selectedProp?.is_ghost && <span className="ml-2 text-xs bg-slate-800 px-2 py-0.5 rounded text-slate-400">GHOST</span>}
                                    </DrawerDescription>
                                </div>
                                <Badge variant="outline" className="bg-slate-800 text-indigo-400 border-indigo-900">
                                    {selectedProp?.house_number % 2 === 0 ? 'EVEN' : 'ODD'}
                                </Badge>
                            </div>
                        </DrawerHeader>
                        
                        <div className="p-4 space-y-4">
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-slate-300">Log Interaction</label>
                                <Input 
                                    placeholder="Type result (e.g., 'Not home', 'Sold', 'Come back tomorrow')..." 
                                    value={interactionText}
                                    onChange={handleInteractionChange}
                                    className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
                                    autoFocus
                                />
                            </div>

                            {parsedResult && interactionText && (
                                <div className="bg-slate-800/50 p-3 rounded-lg border border-slate-700/50">
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="text-xs text-slate-400 uppercase tracking-wider">Detected Status</span>
                                        <Badge className={
                                            parsedResult.status === 'SOLD' ? 'bg-red-900 text-red-200' :
                                            parsedResult.status === 'HARD_NO' ? 'bg-red-900 text-red-200' :
                                            parsedResult.status === 'CALLBACK' ? 'bg-yellow-900 text-yellow-200' :
                                            parsedResult.status === 'NO_ANSWER' ? 'bg-slate-700 text-slate-300' :
                                            'bg-green-900 text-green-200'
                                        }>
                                            {parsedResult.status}
                                        </Badge>
                                    </div>
                                    {parsedResult.nextDate && (
                                        <div className="text-xs text-slate-400">
                                            Next Eligible: {moment(parsedResult.nextDate).format('MMM D, h:mm a')}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <DrawerFooter>
                            <Button onClick={submitInteraction} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white">
                                Save Log
                            </Button>
                            <DrawerClose asChild>
                                <Button variant="outline" className="w-full border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white">Cancel</Button>
                            </DrawerClose>
                        </DrawerFooter>
                    </div>
                </DrawerContent>
            </Drawer>
        </div>
    );
}