import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPin, Search, Navigation } from 'lucide-react';
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { generateOptimizedRoutes } from '../components/logic/routeOptimizer';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const ROUTE_SIZE_OPTIONS = [25, 50, 75, 100];

export default function ListPage() {
    const [searchTerm, setSearchTerm] = useState("");
    const [view, setView] = useState('routes'); // 'routes' or 'properties'
    const [selectedSize, setSelectedSize] = useState(50);
    
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties'],
        queryFn: () => base44.entities.MasterProperty.list('-created_date', 5000),
    });

    const { data: savedRoutes = [], isLoading: routesLoading } = useQuery({
        queryKey: ['savedRoutes'],
        queryFn: () => base44.entities.SavedRoute.list('-created_date', 100),
    });

    const { data: logs = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs'],
        queryFn: () => base44.entities.InteractionLog.list('-created_date', 10000),
    });

    const effectiveProperties = useMemo(() => {
        return properties
            .filter(p => p?.lat && p?.lng && !isNaN(p.lat) && !isNaN(p.lng))
            .map(p => {
                const propLogs = logs.filter(l => l.address_hash === p.address_hash);
                return {
                    ...p,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    effective_status: determineEffectiveStatus(p, propLogs)
                };
            });
    }, [properties, logs]);

    const filteredProperties = effectiveProperties.filter(p => 
        p.full_address?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.street_name?.toLowerCase().includes(searchTerm.toLowerCase())
    );

    // Generate routes for selected size
    const [routes, setRoutes] = useState([]);
    const [routesGenerating, setRoutesGenerating] = useState(false);

    const generateRoutes = () => {
        if (effectiveProperties.length === 0) {
            setRoutes([]);
            return;
        }
        setRoutesGenerating(true);
        setTimeout(() => {
            const generated = generateOptimizedRoutes(effectiveProperties, selectedSize);
            setRoutes(generated);
            setRoutesGenerating(false);
        }, 100);
    };

    const isLoading = propsLoading || logsLoading;

    return (
        <div className="h-full flex flex-col" style={{ background: BRAND.voidBlack }}>
            {/* Header */}
            <div className="p-4 border-b sticky top-0 z-10" style={{ background: BRAND.voidBlack, borderColor: BRAND.charcoal }}>
                <div className="flex gap-2 mb-4">
                    <button
                        onClick={() => setView('routes')}
                        className="flex-1 py-3 rounded-lg font-bold tracking-wide transition-all"
                        style={{ 
                            background: view === 'routes' ? BRAND.gold : BRAND.charcoal,
                            color: view === 'routes' ? BRAND.voidBlack : BRAND.offWhite
                        }}
                    >
                        <Navigation className="w-4 h-4 inline mr-2" />
                        MY ROUTES
                    </button>
                    <button
                        onClick={() => setView('properties')}
                        className="flex-1 py-3 rounded-lg font-bold tracking-wide transition-all"
                        style={{ 
                            background: view === 'properties' ? BRAND.gold : BRAND.charcoal,
                            color: view === 'properties' ? BRAND.voidBlack : BRAND.offWhite
                        }}
                    >
                        <MapPin className="w-4 h-4 inline mr-2" />
                        PROPERTIES
                    </button>
                </div>

                {view === 'routes' && (
                    <div className="space-y-3">
                        {/* Saved routes, no generation here anymore, just listing */}
                    </div>
                )}

                {view === 'properties' && (
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: '#666' }} />
                        <Input 
                            placeholder="Search addresses..." 
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-9"
                            style={{ background: BRAND.charcoal, borderColor: '#333', color: BRAND.offWhite }}
                        />
                    </div>
                )}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto p-4 space-y-3">
                {isLoading ? (
                    <div className="flex justify-center p-8">
                        <Loader2 className="w-8 h-8 animate-spin" style={{ color: BRAND.gold }} />
                    </div>
                ) : view === 'routes' ? (
                    <>
                        {savedRoutes.length === 0 ? (
                            <div className="text-center py-10">
                                <p style={{ color: '#888' }} className="mb-4">No saved routes yet</p>
                                <Link to={createPageUrl('Home')}>
                                    <Button className="bg-yellow-500 text-black font-bold">CREATE ROUTES ON MAP</Button>
                                </Link>
                            </div>
                        ) : (
                            savedRoutes.map((route, idx) => (
                                <Card 
                                    key={route.id} 
                                    className="p-4 cursor-pointer transition-all hover:opacity-90"
                                    style={{ background: BRAND.charcoal, borderColor: '#333', borderLeft: `3px solid ${BRAND.gold}` }}
                                >
                                    <div className="flex justify-between items-start mb-3">
                                        <div>
                                            <h3 className="font-bold" style={{ color: BRAND.offWhite }}>{route.name}</h3>
                                            <p className="text-xs mt-1" style={{ color: '#888' }}>
                                                {route.metrics?.house_count} homes • {route.metrics?.distance} mi
                                            </p>
                                            {route.start_location && (
                                                <p className="text-[10px] text-gray-500">Start: {route.start_location.address}</p>
                                            )}
                                        </div>
                                        <Badge style={{ 
                                            background: route.status === 'COMPLETED' ? '#22c55e' : '#eab308',
                                            color: '#000'
                                        }}>
                                            {route.status}
                                        </Badge>
                                    </div>

                                    <div className="flex gap-2">
                                        <Link 
                                            to={`${createPageUrl('Home')}?savedRoute=${route.id}`}
                                            className="flex-1"
                                        >
                                            <Button 
                                                className="w-full h-10 font-bold tracking-wide"
                                                style={{ background: BRAND.gold, color: BRAND.voidBlack }}
                                            >
                                                <Navigation className="w-4 h-4 mr-2" />
                                                LOAD ROUTE
                                            </Button>
                                        </Link>
                                    </div>
                                </Card>
                            ))
                        )}
                    </>
                ) : (
                    <>
                        {filteredProperties.length === 0 ? (
                            <div className="text-center py-10" style={{ color: '#888' }}>
                                No properties found
                            </div>
                        ) : (
                            filteredProperties.map(prop => (
                                <Card key={prop.id} className="p-4" style={{ background: BRAND.charcoal, borderColor: '#333' }}>
                                    <div className="flex justify-between items-start">
                                        <div>
                                            <h3 className="font-semibold" style={{ color: BRAND.offWhite }}>{prop.full_address}</h3>
                                            <div className="flex items-center gap-2 mt-1 text-sm" style={{ color: '#888' }}>
                                                <MapPin className="w-3 h-3" />
                                                <span>{prop.street_name}</span>
                                            </div>
                                        </div>
                                        <Badge variant="outline" style={{
                                            background: prop.effective_status === 'SOLD' ? '#22c55e20' : 
                                                        prop.effective_status === 'HARD_NO' ? '#ef444420' : '#6b728020',
                                            color: prop.effective_status === 'SOLD' ? '#22c55e' : 
                                                    prop.effective_status === 'HARD_NO' ? '#ef4444' : '#6b7280',
                                            borderColor: prop.effective_status === 'SOLD' ? '#22c55e' : 
                                                            prop.effective_status === 'HARD_NO' ? '#ef4444' : '#6b7280'
                                        }}>
                                            {prop.effective_status || 'ELIGIBLE'}
                                        </Badge>
                                    </div>
                                </Card>
                            ))
                        )}
                    </>
                )}
            </div>
        </div>
    );
}