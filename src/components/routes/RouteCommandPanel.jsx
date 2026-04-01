import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { HelpCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
// cache-bust v2
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { generateOptimizedRoutes } from "@/components/logic/routeOptimizer";
import {
    Navigation, X, BarChart3, User, Shield, MapPin,
    ArrowRight, Flame, Plus, Clock, CheckCircle2,
    AlertCircle, ChevronRight, Zap, Trash2, Scissors, Pencil, Check, RefreshCw
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from "@tanstack/react-query";

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

export default function RouteCommandPanel({
    generatedRoutes = [],
    savedRoutes = [],
    filteredRoutes = [],
    genStats,
    repColors = {},
    teamMembers = [],
    getRepRecommendations,
    onSelectRoute,
    onSaveRoute,
    onAutoAssignAll,
    onDeleteAllRoutes,
    onDeleteRoute,
    onReplaceRoutes,
    onClose,
    activeRouteId,
    streetCooldownDays = 30,
    zipCodeFilter = '',
    housesPerRoute = 50,
    logs = [],
    onReoptimizeRoute,
    routeConfig
}) {
    const [activeTab, setActiveTab] = useState(generatedRoutes.length > 0 ? 'new' : 'active');

    // Group saved routes by status
    const routesByStatus = useMemo(() => {
        const groups = {
            IN_PROGRESS: [],
            ACTIVE: [],
            PENDING: [],
            COMPLETED: []
        };
        savedRoutes.forEach(r => {
            const status = r.status || 'PENDING';
            if (groups[status]) groups[status].push(r);
            else groups.PENDING.push(r);
        });
        return groups;
    }, [savedRoutes]);

    // Group saved routes by rep
    const routesByRep = useMemo(() => {
        const groups = { unassigned: [] };
        teamMembers.forEach(m => groups[m.id] = { member: m, routes: [] });

        savedRoutes.forEach(r => {
            if (r.assigned_to && groups[r.assigned_to]) {
                groups[r.assigned_to].routes.push(r);
            } else {
                groups.unassigned.push(r);
            }
        });
        return groups;
    }, [savedRoutes, teamMembers]);

    return (
        <div className="fixed inset-0 z-[2000]">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
            <div
                className="fixed top-0 bottom-0 left-0 w-full md:max-w-xl overflow-hidden flex flex-col z-[3000] backdrop-blur-xl shadow-2xl animate-in slide-in-from-left duration-300 border-r border-white/10 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgba(10, 10, 10, 0.98)' }}
            >
                {/* Header */}
                <div className="p-4 border-b flex justify-between items-center shrink-0" style={{ borderColor: BRAND.charcoal }}>
                    <div>
                        <h2 className="flex items-center gap-2 text-lg font-bold tracking-wide" style={{ color: BRAND.gold }}>
                            <Navigation className="w-5 h-5" />
                            ROUTE COMMAND
                        </h2>
                        <p className="text-[10px] mt-1" style={{ color: '#666' }}>
                            {generatedRoutes.length > 0 && <span className="text-yellow-500 font-bold mr-2">{generatedRoutes.length} New</span>}
                            {savedRoutes.length} Active Campaigns
                        </p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                        <X className="w-5 h-5" style={{ color: BRAND.offWhite }} />
                    </button>
                </div>

                {/* Tab Navigation */}
                <div className="flex border-b px-2 sm:px-4 shrink-0 overflow-x-auto no-scrollbar" style={{ borderColor: BRAND.charcoal }}>
                    <button
                        onClick={() => !activeRouteId && setActiveTab('new')}
                        disabled={!!activeRouteId}
                        className={`flex-1 min-w-[100px] py-3 text-[10px] sm:text-xs font-bold tracking-wide border-b-2 transition-all flex items-center justify-center gap-1 sm:gap-2 ${activeRouteId ? 'opacity-50 cursor-not-allowed' : ''} ${activeTab === 'new'
                            ? 'border-yellow-500 text-yellow-500'
                            : 'border-transparent text-gray-500 hover:text-white'
                            }`}
                    >
                        <Zap className="w-4 h-4" />
                        NEW ROUTES
                        {generatedRoutes.length > 0 && (
                            <Badge variant="default" className="bg-yellow-500 text-black text-[9px] h-4 px-1.5">{generatedRoutes.length}</Badge>
                        )}
                    </button>
                    <button
                        onClick={() => !activeRouteId && setActiveTab('active')}
                        disabled={!!activeRouteId}
                        className={`flex-1 min-w-[100px] py-3 text-[10px] sm:text-xs font-bold tracking-wide border-b-2 transition-all flex items-center justify-center gap-1 sm:gap-2 ${activeRouteId ? 'opacity-50 cursor-not-allowed' : ''} ${activeTab === 'active'
                            ? 'border-blue-500 text-blue-500'
                            : 'border-transparent text-gray-500 hover:text-white'
                            }`}
                    >
                        <Clock className="w-3 h-3 sm:w-4 sm:h-4" />
                        ACTIVE
                        <Badge variant="default" className="bg-blue-600 text-white text-[9px] h-4 px-1.5">
                            {routesByStatus.IN_PROGRESS.length + routesByStatus.ACTIVE.length}
                        </Badge>
                    </button>
                    <button
                        onClick={() => !activeRouteId && setActiveTab('team')}
                        disabled={!!activeRouteId}
                        className={`flex-1 min-w-[100px] py-3 text-[10px] sm:text-xs font-bold tracking-wide border-b-2 transition-all flex items-center justify-center gap-1 sm:gap-2 ${activeRouteId ? 'opacity-50 cursor-not-allowed' : ''} ${activeTab === 'team'
                            ? 'border-green-500 text-green-500'
                            : 'border-transparent text-gray-500 hover:text-white'
                            }`}
                    >
                        <User className="w-3 h-3 sm:w-4 sm:h-4" />
                        BY REP
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 min-h-0">
                    <ScrollArea className="h-full w-full">
                        <div className="p-4 space-y-4">

                        {/* NEW ROUTES TAB */}
                        {activeTab === 'new' && (
                            <>
                                {generatedRoutes.length === 0 ? (
                                    <div className="text-center py-12">
                                        <div className="w-16 h-16 rounded-full bg-[#1A1A1A] flex items-center justify-center mx-auto mb-4">
                                            <Plus className="w-8 h-8 text-gray-600" />
                                        </div>
                                        <h3 className="text-lg font-bold text-gray-400 mb-2">No New Routes</h3>
                                        <p className="text-xs text-gray-600 max-w-xs mx-auto">
                                            Switch to "Build Routes" mode and generate new routes from available properties.
                                        </p>
                                    </div>
                                ) : (
                                    <>
                                        {/* Generation Summary */}
                                        {genStats && (
                                            <div className="bg-gradient-to-br from-[#1A1A1A] to-[#0F0F0F] rounded-xl p-4 border border-yellow-900/30 relative overflow-hidden">
                                                <div className="absolute top-0 right-0 w-32 h-32 bg-yellow-500/5 rounded-full blur-3xl pointer-events-none" />

                                                <div className="flex flex-col mb-4 gap-3">
                                                    <div className="flex-1 min-w-0">
                                                        <h3 className="text-sm font-bold text-white flex items-center gap-2">
                                                            <BarChart3 className="w-4 h-4 text-yellow-500" />
                                                            GENERATION SUMMARY
                                                        </h3>
                                                        <p className="text-[10px] text-gray-500 mt-1">
                                                            {zipCodeFilter || 'All Areas'} • {housesPerRoute} homes/route
                                                        </p>
                                                    </div>
                                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 w-full">
                                                        {/* @ts-ignore */}
                                                        <Button
                                                            onClick={onAutoAssignAll}
                                                            size="sm"
                                                            className="w-full h-8 bg-green-600 hover:bg-green-500 text-white font-bold text-[10px]"
                                                        >
                                                            <User className="w-3 h-3 mr-1" />
                                                            AUTO-DISPATCH
                                                        </Button>
                                                        <div className="w-full flex items-center justify-center p-2 bg-green-500/10 border border-green-500/30 rounded-lg">
                                                            <span className="text-[10px] font-bold text-green-500 flex items-center gap-1.5">
                                                                <CheckCircle2 className="w-3 h-3" />
                                                                AUTO-SAVING TO ACTIVE
                                                            </span>
                                                        </div>
                                                        {/* @ts-ignore */}
                                                        {generatedRoutes.length === 1 ? (
                                                            <SplitRouteButton
                                                                route={generatedRoutes[0]}
                                                                onReplaceRoutes={onReplaceRoutes}
                                                            />
                                                        ) : (
                                                            <Button
                                                                onClick={() => {
                                                                    const baseRoutes = (filteredRoutes && filteredRoutes.length > 0) ? filteredRoutes : generatedRoutes;
                                                                    const seen = new Set();
                                                                    const allProps = [];
                                                                    baseRoutes.forEach(r => (r.properties || []).forEach(p => {
                                                                        const key = p.address_hash || p.id;
                                                                        if (key && !seen.has(key)) { seen.add(key); allProps.push(p); }
                                                                    }));
                                                                    if (allProps.length === 0) return;
                                                                    const merged = generateOptimizedRoutes(allProps, allProps.length, null, [], { minimizeTurns: true, use2Opt: true, walkingPattern: 'nearest' });
                                                                    if (merged && merged.length > 0) {
                                                                        const big = { ...merged[0], id: 'route_merged', name: 'All-in-One Route' };
                                                                        if (onReplaceRoutes) {
                                                                            onReplaceRoutes([big]);
                                                                        } else {
                                                                            onSelectRoute(big);
                                                                        }
                                                                    }
                                                                }}
                                                                size="sm"
                                                                className="w-full h-8 bg-yellow-600 hover:bg-yellow-500 text-black font-bold text-[10px]" title="Combine all into one optimized mega route"
                                                            >
                                                                MERGE ALL
                                                            </Button>
                                                        )}
                                                        <Button
                                                            onClick={() => {
                                                                if (confirm("Are you sure you want to clear all generated routes?")) {
                                                                    if (onReplaceRoutes) onReplaceRoutes([]);
                                                                }
                                                            }}
                                                            size="sm"
                                                            className="w-full h-8 bg-red-900/40 hover:bg-red-900/60 text-red-500 border border-red-900/50 font-bold text-[10px]"
                                                        >
                                                            <Trash2 className="w-3 h-3 mr-1" />
                                                            CLEAR ALL
                                                        </Button>
                                                    </div>
                                                </div>

                                                <div className="grid grid-cols-4 gap-2">
                                                    <StatBox label="Doors" value={genStats.totalHouses} />
                                                    <StatBox label="Routes" value={genStats.routeCount} highlight />
                                                    <StatBox label="Avg Score" value={genStats.avgScore} tooltip="Score based on Equity, Sales Activity, and Efficiency. High Score = Better Route." />
                                                    <StatBox label="Miles" value={genStats.totalDist} />
                                                </div>

                                                {genStats.excludedCount > 0 && (
                                                    <div className="flex items-center gap-2 text-[10px] text-gray-400 bg-black/30 p-2 rounded-lg mt-3 border border-red-900/30">
                                                        <Shield className="w-3 h-3 text-red-500" />
                                                        <span className="text-white font-bold">{genStats.excludedCount}</span> properties excluded (Sold/Hard No/Cooldown) to prevent double dipping.
                                                    </div>
                                                )}

                                                {genStats.highPotentialCount > 0 && (
                                                    <div className="flex items-center gap-2 text-[10px] text-gray-400 bg-black/30 p-2 rounded-lg mt-3">
                                                        <Flame className="w-3 h-3 text-orange-500" />
                                                        <span className="text-white font-bold">{genStats.highPotentialCount}</span> high potential routes (100+ score)
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Route List */}
                                        <div className="space-y-3">
                                            {filteredRoutes.map((route, idx) => (
                                                <NewRouteCard
                                                    key={route.id}
                                                    route={route}
                                                    rank={idx + 1}
                                                    isActive={activeRouteId === route.id}
                                                    recommendation={getRepRecommendations?.(route.properties[0])?.[0]}
                                                    onSelect={() => onSelectRoute(route)}
                                                    onSave={(repId, repName) => onSaveRoute(route, repId, repName)}
                                                    logs={logs}
                                                />
                                            ))}
                                        </div>
                                    </>
                                )}
                            </>
                        )}

                        {/* ACTIVE ROUTES TAB */}
                        {activeTab === 'active' && (
                            <>
                                <div className="flex justify-between items-center mb-2 px-1">
                                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">All Campaigns</span>
                                    {savedRoutes.length > 0 && (
                                        <Button
                                            onClick={() => {
                                                if (confirm("Are you sure you want to delete ALL saved routes? This action cannot be undone.")) {
                                                    onDeleteAllRoutes && onDeleteAllRoutes();
                                                }
                                            }}
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 text-[10px] text-red-500 hover:text-red-400 hover:bg-red-900/20 px-2"
                                        >
                                            <X className="w-3 h-3 mr-1" /> DELETE ALL
                                        </Button>
                                    )}
                                </div>

                                {/* In Progress */}
                                {routesByStatus.IN_PROGRESS.length > 0 && (
                                    <RouteSection
                                        title="In Progress"
                                        icon={<Clock className="w-4 h-4 text-blue-500" />}
                                        routes={routesByStatus.IN_PROGRESS}
                                        repColors={repColors}
                                        onSelectRoute={onSelectRoute}
                                        activeRouteId={activeRouteId}
                                        onDeleteRoute={onDeleteRoute}
                                        logs={logs}
                                        onReoptimize={onReoptimizeRoute}
                                        routeConfig={routeConfig}
                                    />
                                )}

                                {/* Active/Queued */}
                                {routesByStatus.ACTIVE.length > 0 && (
                                    <RouteSection
                                        title="Queued"
                                        icon={<Navigation className="w-4 h-4 text-yellow-500" />}
                                        routes={routesByStatus.ACTIVE}
                                        repColors={repColors}
                                        onSelectRoute={onSelectRoute}
                                        activeRouteId={activeRouteId}
                                        onDeleteRoute={onDeleteRoute}
                                        logs={logs}
                                        onReoptimize={onReoptimizeRoute}
                                        routeConfig={routeConfig}
                                    />
                                )}

                                {/* Pending Assignment */}
                                {routesByStatus.PENDING.length > 0 && (
                                    <RouteSection
                                        title="Pending Assignment"
                                        icon={<AlertCircle className="w-4 h-4 text-orange-500" />}
                                        routes={routesByStatus.PENDING}
                                        repColors={repColors}
                                        onSelectRoute={onSelectRoute}
                                        activeRouteId={activeRouteId}
                                        onDeleteRoute={onDeleteRoute}
                                        logs={logs}
                                        onReoptimize={onReoptimizeRoute}
                                        routeConfig={routeConfig}
                                    />
                                )}

                                {/* Completed */}
                                {routesByStatus.COMPLETED.length > 0 && (
                                    <RouteSection
                                        title="Completed"
                                        icon={<CheckCircle2 className="w-4 h-4 text-green-500" />}
                                        routes={routesByStatus.COMPLETED}
                                        repColors={repColors}
                                        onSelectRoute={onSelectRoute}
                                        activeRouteId={activeRouteId}
                                        collapsed
                                        onDeleteRoute={onDeleteRoute}
                                        logs={logs}
                                        onReoptimize={onReoptimizeRoute}
                                        routeConfig={routeConfig}
                                    />
                                )}

                                {savedRoutes.length === 0 && (
                                    <div className="text-center py-12">
                                        <div className="w-16 h-16 rounded-full bg-[#1A1A1A] flex items-center justify-center mx-auto mb-4">
                                            <Navigation className="w-8 h-8 text-gray-600" />
                                        </div>
                                        <h3 className="text-lg font-bold text-gray-400 mb-2">No Active Routes</h3>
                                        <p className="text-xs text-gray-600">Generate and save routes to see them here.</p>
                                    </div>
                                )}
                            </>
                        )}

                        {/* BY REP TAB */}
                        {activeTab === 'team' && (
                            <>
                                {teamMembers.map(member => {
                                    const memberData = routesByRep[member.id];
                                    if (!memberData || memberData.routes.length === 0) return null;

                                    return (
                                        <div key={member.id} className="space-y-2">
                                            <div className="flex items-center gap-2 px-1">
                                                <span
                                                    className="w-3 h-3 rounded-full"
                                                    style={{ background: repColors[member.id] || '#666' }}
                                                />
                                                <span className="text-sm font-bold text-white">{member.name}</span>
                                                <Badge variant="outline" className="bg-white/10 text-white text-[9px]">
                                                    {memberData.routes.length} routes
                                                </Badge>
                                            </div>
                                            {memberData.routes.map(route => (
                                                <SavedRouteCard
                                                    key={route.id}
                                                    route={route}
                                                    repColor={repColors[member.id]}
                                                    isActive={activeRouteId === route.id}
                                                    onSelect={() => onSelectRoute(route)}
                                                    onDelete={() => onDeleteRoute && onDeleteRoute(route)}
                                                    logs={logs}
                                                    onReoptimize={onReoptimizeRoute}
                                                    routeConfig={routeConfig}
                                                />
                                            ))}
                                        </div>
                                    );
                                })}

                                {/* Unassigned */}
                                {routesByRep.unassigned.length > 0 && (
                                    <div className="space-y-2 pt-4 border-t border-gray-800">
                                        <div className="flex items-center gap-2 px-1">
                                            <span className="w-3 h-3 rounded-full bg-gray-600" />
                                            <span className="text-sm font-bold text-gray-400">Unassigned</span>
                                            <Badge variant="secondary" className="bg-red-900/30 text-red-400 text-[9px]">
                                                {routesByRep.unassigned.length}
                                            </Badge>
                                        </div>
                                        {routesByRep.unassigned.map(route => (
                                            <SavedRouteCard
                                                key={route.id}
                                                route={route}
                                                repColor="#666"
                                                isActive={activeRouteId === route.id}
                                                onSelect={() => onSelectRoute(route)}
                                                onDelete={() => onDeleteRoute && onDeleteRoute(route)}
                                                logs={logs}
                                                onReoptimize={onReoptimizeRoute}
                                                routeConfig={routeConfig}
                                            />
                                        ))}
                                    </div>
                                )}

                                {teamMembers.length === 0 && (
                                    <div className="text-center py-12">
                                        <User className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                                        <h3 className="text-lg font-bold text-gray-400 mb-2">No Team Members</h3>
                                        <p className="text-xs text-gray-600">Add team members in the Team page.</p>
                                    </div>
                                )}
                            </>
                        )}
                        </div>
                    </ScrollArea>
                </div>
            </div>
        </div>
    );
}

// Sub-components
function SplitRouteButton({ route, onReplaceRoutes }) {
    const [showSplit, setShowSplit] = useState(false);
    const splitOptions = [2, 3, 4, 5, 10];
    const totalHouses = route?.houseCount || route?.properties?.length || 0;

    if (showSplit) {
        return (
            <div className="w-full flex flex-col gap-1">
                <p className="text-[9px] text-gray-400 font-bold text-center">SPLIT INTO:</p>
                <div className="flex gap-1 flex-wrap justify-center">
                    {splitOptions.filter(n => n < totalHouses).map(n => (
                        <Button
                            key={n}
                            onClick={() => {
                                const perRoute = Math.ceil(totalHouses / n);
                                const splits = generateOptimizedRoutes(
                                    route.properties, perRoute, null, [],
                                    { minimizeTurns: true, use2Opt: true, walkingPattern: 'nearest' }
                                );
                                if (splits && splits.length > 0 && onReplaceRoutes) {
                                    onReplaceRoutes(splits);
                                }
                                setShowSplit(false);
                            }}
                            size="sm"
                            className="h-7 px-3 bg-purple-600 hover:bg-purple-500 text-white font-bold text-[10px]"
                        >
                            {n} routes (~{Math.ceil(totalHouses / n)} ea)
                        </Button>
                    ))}
                    <Button onClick={() => setShowSplit(false)} size="sm" className="h-7 px-2 bg-gray-800 hover:bg-gray-700 text-gray-400 text-[10px]">
                        <X className="w-3 h-3" />
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <Button
            onClick={() => setShowSplit(true)}
            size="sm"
            className="w-full h-8 bg-purple-600 hover:bg-purple-500 text-white font-bold text-[10px]"
            title="Split this route into smaller routes"
        >
            <Scissors className="w-3 h-3 mr-1" />
            SPLIT ROUTE
        </Button>
    );
}

function StatBox({ label, value, highlight = false, tooltip = undefined }) {
    return (
        <div className="bg-black/40 p-2 rounded-lg border border-white/5 text-center relative group">
            {tooltip && (
                <div className="absolute top-1 right-1 opacity-50 hover:opacity-100 cursor-help">
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger><HelpCircle className="w-3 h-3 text-gray-500" /></TooltipTrigger>
                            <TooltipContent className="bg-black border border-gray-800 text-white text-xs max-w-[200px]">
                                <p>{tooltip}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                </div>
            )}
            <p className={`text-lg font-bold ${highlight ? 'text-yellow-500' : 'text-white'}`}>{value}</p>
            <p className="text-[9px] text-gray-500 uppercase font-bold">{label}</p>
        </div>
    );
}

function RouteSection({ title, icon, routes, repColors, onSelectRoute, activeRouteId, collapsed = false, onDeleteRoute, logs = [], onReoptimize, routeConfig }) {
    const [isExpanded, setIsExpanded] = useState(!collapsed);

    return (
        <div className="space-y-2">
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-2 px-1 w-full text-left"
            >
                {icon}
                <span className="text-xs font-bold text-gray-400 uppercase">{title}</span>
                <Badge variant="outline" className="bg-white/10 text-white text-[9px]">{routes.length}</Badge>
                <ChevronRight className={`w-4 h-4 text-gray-600 ml-auto transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            </button>

            {isExpanded && routes.map(route => (
                <SavedRouteCard
                    key={route.id}
                    route={route}
                    repColor={route.assigned_to ? repColors[route.assigned_to] : '#666'}
                    isActive={activeRouteId === route.id}
                    onSelect={() => onSelectRoute(route)}
                    onDelete={() => onDeleteRoute && onDeleteRoute(route)}
                    logs={logs}
                    onReoptimize={onReoptimize}
                    routeConfig={routeConfig}
                />
            ))}
        </div>
    );
}

function NewRouteCard({ route, rank, isActive, recommendation, onSelect, onSave, logs = [] }) {
    // Compute knock stats from logs
    const knockStats = useMemo(() => {
        const hashes = new Set((route.properties || []).map(p => p.address_hash).filter(Boolean));
        const routeLogs = logs.filter(l => hashes.has(l.address_hash));
        const knockedHashes = new Set(routeLogs.map(l => l.address_hash));
        return { knocked: knockedHashes.size, total: hashes.size };
    }, [route.properties, logs]);

    const dateRange = useMemo(() => {
        const dates = (route.properties || [])
            .map(p => p.sold_date ? new Date(p.sold_date).getTime() : null)
            .filter(Boolean);
        if (dates.length === 0) return null;
        const min = new Date(Math.min(...dates));
        const max = new Date(Math.max(...dates));
        return formatDateRange(min, max);
    }, [route.properties]);

    return (
        <div
            className="p-4 rounded-xl border transition-all relative overflow-hidden w-full box-border"
            style={{
                background: isActive ? `${BRAND.gold}15` : BRAND.charcoal,
                borderColor: isActive ? BRAND.gold : '#333'
            }}
        >
            {/* Rank Ribbon */}
            {rank <= 3 && (
                <div className={`absolute top-0 left-0 w-12 h-12 flex items-center justify-center rounded-br-2xl text-black font-bold text-lg shadow-lg z-10 ${rank === 1 ? 'bg-yellow-400' : rank === 2 ? 'bg-gray-300' : rank === 3 ? 'bg-orange-700' : ''
                    }`}>
                    #{rank}
                </div>
            )}

            <button onClick={onSelect} className={`w-full text-left ${rank <= 3 ? 'pl-8' : ''}`}>
                <div className="flex items-center justify-between mb-2 gap-2 min-w-0">
                    <span className="font-bold text-white flex items-center gap-2 min-w-0 flex-1">
                        {rank > 3 && <span className="text-gray-500 text-xs">#{rank}</span>}
                        <span className="truncate">{route.name}</span>
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                        {dateRange && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
                                {dateRange}
                            </span>
                        )}
                        <Badge variant="default" className="shrink-0" style={{
                            background: route.competitivenessScore >= 150 ? '#22c55e' :
                                route.competitivenessScore >= 100 ? '#eab308' : '#666',
                            color: '#000'
                        }}>
                            {route.competitivenessScore || 0}
                        </Badge>
                    </div>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                    <span>{route.houseCount} doors</span>
                    <span>{route.streetCount || '?'} streets</span>
                    <span>{route.totalDistance} mi</span>
                    {knockStats.knocked > 0 && (
                        <span className="text-yellow-500 font-bold">{knockStats.knocked}/{knockStats.total} knocked</span>
                    )}
                </div>
                {knockStats.total > 0 && (
                    <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: '#222' }}>
                        <div className="h-full rounded-full transition-all" style={{ width: `${(knockStats.knocked / knockStats.total) * 100}%`, background: knockStats.knocked === knockStats.total ? '#22c55e' : '#FFD700' }} />
                    </div>
                )}
            </button>

            {/* Rep Info */}
            {recommendation && (
                <div className="flex items-center justify-between text-[9px] text-gray-500 mt-2 px-1">
                    <span className="flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {recommendation.distance ? `${recommendation.distance}mi` : 'N/A'}
                    </span>
                    <span>Perf: {recommendation.performanceScore}</span>
                    {recommendation.activeRoutesCount > 0 && (
                        <span className="text-yellow-500">{recommendation.activeRoutesCount} active</span>
                    )}
                </div>
            )}
        </div>
    );
}

function SavedRouteCard({ route, repColor, isActive, onSelect, onDelete, logs = [], onReoptimize, routeConfig }) {
    const [editing, setEditing] = useState(false);
    const [newName, setNewName] = useState(route.name);
    const queryClient = useQueryClient();

    // Compute knock stats from logs
    const knockStats = useMemo(() => {
        const hashes = new Set(
            (route.property_hashes || (route.properties || []).map(p => p.address_hash)).filter(Boolean)
        );
        const routeLogs = logs.filter(l => hashes.has(l.address_hash));
        const knockedHashes = new Set(routeLogs.map(l => l.address_hash));
        return { knocked: knockedHashes.size, total: hashes.size };
    }, [route.property_hashes, route.properties, logs]);

    const dateRange = useMemo(() => {
        const props = route.properties || [];
        const dates = props
            .map(p => p.sold_date ? new Date(p.sold_date).getTime() : null)
            .filter(Boolean);
        if (dates.length === 0) return null;
        const min = new Date(Math.min(...dates));
        const max = new Date(Math.max(...dates));
        return formatDateRange(min, max);
    }, [route.properties]);

    const handleRename = async () => {
        if (!newName.trim() || newName === route.name) { setEditing(false); return; }
        await base44.entities.SavedRoute.update(route.id, { name: newName.trim() });
        queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
        setEditing(false);
    };

    return (
        <div className="relative group">
            <button
                onClick={onSelect}
                className="w-full p-3 rounded-xl border transition-all text-left hover:border-gray-600"
                style={{
                    background: isActive ? `${BRAND.gold}15` : '#151515',
                    borderColor: isActive ? BRAND.gold : '#222',
                    borderLeftWidth: '3px',
                    borderLeftColor: repColor
                }}
            >
                <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0 pr-12">
                        {editing ? (
                            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                                <input
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(false); }}
                                    className="bg-black/60 border border-gray-600 text-white text-sm font-bold rounded px-2 py-0.5 w-full"
                                    autoFocus
                                />
                                <button onClick={handleRename} className="p-1 text-green-500 hover:text-green-400"><Check className="w-4 h-4" /></button>
                                <button onClick={() => { setNewName(route.name); setEditing(false); }} className="p-1 text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-1.5">
                                <span className="font-bold text-sm text-white truncate">{route.name}</span>
                                <button
                                    onClick={e => { e.stopPropagation(); setEditing(true); }}
                                    className="p-0.5 text-gray-600 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
                                    title="Rename"
                                >
                                    <Pencil className="w-3 h-3" />
                                </button>
                            </div>
                        )}
                        {route.assigned_to_name && (
                            <span className="text-[10px] text-gray-500">{route.assigned_to_name}</span>
                        )}
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                        {dateRange && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 leading-none">
                                {dateRange}
                            </span>
                        )}
                        <Badge variant="default" className="shrink-0" style={{
                            background: route.status === 'COMPLETED' ? '#22c55e' :
                                route.status === 'IN_PROGRESS' ? '#3b82f6' : '#333',
                            color: '#fff'
                        }}>
                            {route.status}
                        </Badge>
                    </div>
                </div>
                <div className="flex gap-3 text-[10px] text-gray-600 mt-1">
                    <span>{route.houseCount || route.metrics?.house_count} doors</span>
                    <span>{route.competitivenessScore || route.metrics?.score || 0} score</span>
                    {knockStats.knocked > 0 && (
                        <span className="text-yellow-500 font-bold">{knockStats.knocked}/{knockStats.total} knocked</span>
                    )}
                </div>
                {knockStats.total > 0 && (
                    <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: '#222' }}>
                        <div className="h-full rounded-full transition-all" style={{ width: `${(knockStats.knocked / knockStats.total) * 100}%`, background: knockStats.knocked === knockStats.total ? '#22c55e' : '#FFD700' }} />
                    </div>
                )}
            </button>
            {onDelete && (
                <button
                    onClick={(e) => { e.stopPropagation(); onDelete(); }}
                    className="absolute top-2 right-2 p-1.5 bg-red-500/20 hover:bg-red-500/40 text-red-500 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Delete Route"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            )}
            {onReoptimize && (
                <button
                    onClick={(e) => { e.stopPropagation(); onReoptimize(route); }}
                    className="absolute top-2 right-10 p-1.5 bg-blue-500/20 hover:bg-blue-500/40 text-blue-400 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    title={`Re-optimize order (${routeConfig?.walkingPattern?.replace(/_/g, ' ') || 'current pattern'})`}
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    );
}

function formatDateRange(min, max) {
    if (!min || !max) return null;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const minM = months[min.getMonth()];
    const minY = min.getFullYear();
    const maxM = months[max.getMonth()];
    const maxY = max.getFullYear();

    if (minY === maxY && minM === maxM) return `${minM} ${minY}`;
    if (minY === maxY) return `${minM} – ${maxM} ${minY}`;
    return `${minM} ${minY} – ${maxM} ${maxY}`;
}