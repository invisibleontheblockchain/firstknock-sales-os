import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { storage } from '@/lib/storage';
import { Loader2, MapPin, Search, Navigation, Info, X } from 'lucide-react';
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { generateOptimizedRoutes } from '../components/logic/routeOptimizer';
import KanbanView from '@/components/list/KanbanView';
import TableView from '@/components/list/TableView';
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const ROUTE_SIZE_OPTIONS = [25, 50, 75, 100];

export default function ListPage() {
    const [searchTerm, setSearchTerm] = useState("");
    const [view, setView] = useState('routes'); // 'routes', 'properties', 'kanban', 'table'
    const [repFilter, setRepFilter] = useState('all');
    const [selectedSize, setSelectedSize] = useState(50);
    const [selectedRouteDetails, setSelectedRouteDetails] = useState(null); // Route object to show details for
    const [selectedIds, setSelectedIds] = useState([]); // For bulk actions
    const queryClient = useQueryClient();
    
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    // Fetch Team for assigning in list
    const { data: teamMembers = [] } = useQuery({
        queryKey: ['teamMembers', user?.id],
        queryFn: () => user?.id ? base44.entities.TeamMember.filter({ manager_id: user.id }, '-created_date', 100).then(res => Array.isArray(res) ? res : (res?.items || [])) : [],
        enabled: !!user?.id
    });

    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', user?.email],
        queryFn: () => user ? base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 1000) : [],
        enabled: !!user
    });

    const { data: savedRoutesRaw = [], isLoading: routesLoading } = useQuery({
        queryKey: ['savedRoutes', user?.id],
        queryFn: () => user?.id ? base44.entities.SavedRoute.filter({ manager_id: user.id }, '-created_date', 200) : [],
        enabled: !!user?.id
    });

    const { data: localRoutes = [] } = useQuery({
        queryKey: ['localRoutes'],
        queryFn: async () => await storage.getRoutes()
    });

    const savedRoutes = useMemo(() => {
        const backend = Array.isArray(savedRoutesRaw) ? savedRoutesRaw : (savedRoutesRaw?.items || []);
        // Combine local and backend. Local first so they appear at top if sorted by time?
        // Actually both should be sorted by date.
        // We'll trust the sort.
        const combined = [...localRoutes, ...backend];

        // Simple dedup by ID
        const seen = new Set();
        return combined.filter(r => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
        }).filter(r => repFilter === 'all' || (r.assigned_to_name && r.assigned_to_name.includes(repFilter)));
    }, [savedRoutesRaw, localRoutes, repFilter]);

    // Extract unique reps
    const uniqueReps = useMemo(() => {
        const backend = Array.isArray(savedRoutesRaw) ? savedRoutesRaw : (savedRoutesRaw?.items || []);
        const reps = new Set(backend.map(r => r.assigned_to_name).filter(Boolean));
        return Array.from(reps);
    }, [savedRoutesRaw]);

    const { data: logsRaw = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        queryFn: () => user ? base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 1000) : [],
        enabled: !!user
    });
    const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.items || []);

    const effectiveProperties = useMemo(() => {
        const propsArray = Array.isArray(properties) ? properties : (properties?.items || []);
        return propsArray
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

    const filteredProperties = useMemo(() => {
        return effectiveProperties.filter(p =>
            p.full_address?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.street_name?.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [effectiveProperties, searchTerm]);

    // Bulk Actions Handlers
    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['interactionLogs'] }),
    });

    const handleBulkStatusChange = async (newStatus) => {
        if (selectedIds.length === 0) return;
        const promises = selectedIds.map(id => {
            const prop = effectiveProperties.find(p => (p.address_hash || p.id) === id);
            if (!prop) return null;
            return createLogMutation.mutateAsync({
                address_hash: prop.address_hash,
                raw_input_text: `Bulk update to ${newStatus}`,
                parsed_status: newStatus,
                gps_proof_lat: prop.lat,
                gps_proof_lng: prop.lng
            });
        });
        await Promise.all(promises);
        setSelectedIds([]);
        toast.success(`Updated ${selectedIds.length} properties`);
    };

    const handleKanbanStatusChange = (property, newStatus) => {
        createLogMutation.mutate({
            address_hash: property.address_hash,
            raw_input_text: `Kanban move to ${newStatus}`,
            parsed_status: newStatus,
            gps_proof_lat: property.lat,
            gps_proof_lng: property.lng
        });
    };

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
                        LIST
                    </button>
                    <button
                        onClick={() => setView('kanban')}
                        className="flex-1 py-3 rounded-lg font-bold tracking-wide transition-all"
                        style={{
                            background: view === 'kanban' ? BRAND.gold : BRAND.charcoal,
                            color: view === 'kanban' ? BRAND.voidBlack : BRAND.offWhite
                        }}
                    >
                        KANBAN
                    </button>
                    <button
                        onClick={() => setView('table')}
                        className="flex-1 py-3 rounded-lg font-bold tracking-wide transition-all"
                        style={{
                            background: view === 'table' ? BRAND.gold : BRAND.charcoal,
                            color: view === 'table' ? BRAND.voidBlack : BRAND.offWhite
                        }}
                    >
                        TABLE
                    </button>
                </div>

                {(view === 'properties' || view === 'table') && (
                    <div className="flex gap-2 mb-2">
                        {selectedIds.length > 0 && (
                            <div className="flex items-center gap-2 bg-yellow-500/10 px-3 py-1 rounded-md border border-yellow-500/30">
                                <span className="text-xs font-bold text-yellow-500">{selectedIds.length} Selected</span>
                                <Button 
                                    size="sm" 
                                    className="h-6 text-[10px] bg-yellow-500 text-black hover:bg-yellow-400"
                                    onClick={() => handleBulkStatusChange('ELIGIBLE')}
                                >
                                    Reset
                                </Button>
                                <Button 
                                    size="sm" 
                                    className="h-6 text-[10px] bg-red-500 text-white hover:bg-red-600"
                                    onClick={() => handleBulkStatusChange('HARD_NO')}
                                >
                                    Reject
                                </Button>
                            </div>
                        )}
                    </div>
                )}

                {view === 'routes' && (
                    <div className="space-y-3">
                        {/* Filter by Rep */}
                        <select
                            value={repFilter}
                            onChange={(e) => setRepFilter(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333]"
                        >
                            <option value="all">Filter by Rep: All</option>
                            {uniqueReps.map(rep => (
                                <option key={rep} value={rep}>{rep}</option>
                            ))}
                        </select>
                    </div>
                )}

                {view !== 'routes' && (
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

            {/* Route Details Modal */}
            {selectedRouteDetails && (
                <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setSelectedRouteDetails(null)} />
                    <div
                        className="relative w-full max-w-2xl max-h-[80vh] rounded-2xl flex flex-col shadow-2xl overflow-hidden"
                        style={{ background: BRAND.charcoal, border: `1px solid ${BRAND.gold}40` }}
                    >
                        <div className="p-4 border-b flex justify-between items-center" style={{ borderColor: '#333' }}>
                            <div>
                                <h3 className="font-bold text-lg" style={{ color: BRAND.offWhite }}>{selectedRouteDetails.name}</h3>
                                <p className="text-xs text-gray-400">{selectedRouteDetails.metrics?.house_count} properties</p>
                            </div>
                            <button onClick={() => setSelectedRouteDetails(null)} className="p-2 hover:bg-[#333] rounded-full transition-colors">
                                <X className="w-5 h-5 text-gray-400" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-auto p-4">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="text-xs uppercase text-gray-500 border-b border-[#333]">
                                        <th className="pb-2 pl-2">#</th>
                                        <th className="pb-2">Address</th>
                                        <th className="pb-2">Details</th>
                                        <th className="pb-2">Sales Info</th>
                                        <th className="pb-2 text-right">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="text-sm">
                                    {selectedRouteDetails.property_hashes.map((hash, idx) => {
                                        const prop = properties.find(p => p.address_hash === hash);
                                        const propLogs = logs.filter(l => l.address_hash === hash);
                                        const status = prop ? determineEffectiveStatus(prop, propLogs) : 'UNKNOWN';

                                        if (!prop) return null;

                                        return (
                                            <tr key={hash} className="border-b border-[#333] hover:bg-[#252525]">
                                                <td className="py-3 pl-2 text-gray-500 font-mono text-xs">{idx + 1}</td>
                                                <td className="py-3 font-medium text-gray-200">
                                                    <div>{prop.house_number} {prop.street_name}</div>
                                                    <div className="text-xs text-gray-500">{prop.city}, {prop.state} {prop.zip_code}</div>
                                                </td>
                                                <td className="py-3 text-xs text-gray-400">
                                                    {prop.beds && <span className="mr-2">{prop.beds}bd</span>}
                                                    {prop.baths && <span className="mr-2">{prop.baths}ba</span>}
                                                    {prop.sqft && <span>{prop.sqft}sqft</span>}
                                                </td>
                                                <td className="py-3 text-xs text-gray-400">
                                                    {prop.price && <div className="text-green-500">${prop.price.toLocaleString()}</div>}
                                                    {prop.sold_date && <div className="text-[10px]">{new Date(prop.sold_date).toLocaleDateString()}</div>}
                                                </td>
                                                <td className="py-3 text-right">
                                                    <Badge variant="outline" className="text-[10px]" style={{
                                                        borderColor: status === 'SOLD' ? '#22c55e' : status === 'HARD_NO' ? '#ef4444' : '#6b7280',
                                                        color: status === 'SOLD' ? '#22c55e' : status === 'HARD_NO' ? '#ef4444' : '#6b7280'
                                                    }}>
                                                        {status}
                                                    </Badge>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

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

                                    <div className="flex gap-2 items-center mt-4 pt-3 border-t border-[#333]">
                                        <div className="flex-1">
                                            <p className="text-[10px] text-gray-500 uppercase mb-1">ASSIGNED TO</p>
                                            <div className="flex items-center gap-2">
                                                <div className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center text-xs text-white">
                                                    {route.assigned_to_name ? route.assigned_to_name[0] : '?'}
                                                </div>
                                                <span className="text-sm text-gray-300">
                                                    {route.assigned_to_name || 'Unassigned'}
                                                </span>
                                            </div>
                                        </div>
                                        
                                        <div className="flex gap-2">
                                            <Link to={`${createPageUrl('Home')}?savedRoute=${route.id}`}>
                                                <Button size="sm" className="bg-[#333] hover:bg-white hover:text-black">
                                                    <MapPin className="w-4 h-4" />
                                                </Button>
                                            </Link>
                                            <Button
                                                onClick={() => setSelectedRouteDetails(route)}
                                                size="sm"
                                                className="bg-yellow-500 text-black hover:bg-yellow-400 font-bold"
                                            >
                                                View Details
                                            </Button>
                                        </div>
                                    </div>
                                </Card>
                            ))
                        )}
                    </>
                ) : view === 'properties' ? (
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
                ) : view === 'kanban' ? (
                    <div className="h-full overflow-hidden">
                        <KanbanView 
                            properties={filteredProperties} 
                            onStatusChange={handleKanbanStatusChange} 
                        />
                    </div>
                ) : view === 'table' ? (
                    <TableView 
                        properties={filteredProperties}
                        selectedIds={selectedIds}
                        onSelect={(id) => {
                            if (selectedIds.includes(id)) setSelectedIds(selectedIds.filter(i => i !== id));
                            else setSelectedIds([...selectedIds, id]);
                        }}
                        onSelectAll={(checked) => {
                            if (checked) setSelectedIds(filteredProperties.map(p => p.address_hash || p.id));
                            else setSelectedIds([]);
                        }}
                    />
                ) : null}
            </div>
        </div>
    );
}