import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { generateOptimizedRoutes } from "@/components/logic/routeOptimizer";
import {
    Navigation, X, BarChart3, User, Shield, MapPin,
    ArrowRight, Flame, Plus, Clock, CheckCircle2,
    AlertCircle, ChevronRight, Zap, Trash2
} from 'lucide-react';

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
    housesPerRoute = 50
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
                        onClick={() => setActiveTab('new')}
                        className={`flex-1 min-w-[100px] py-3 text-[10px] sm:text-xs font-bold tracking-wide border-b-2 transition-all flex items-center justify-center gap-1 sm:gap-2 ${activeTab === 'new'
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
                        onClick={() => setActiveTab('active')}
                        className={`flex-1 min-w-[100px] py-3 text-[10px] sm:text-xs font-bold tracking-wide border-b-2 transition-all flex items-center justify-center gap-1 sm:gap-2 ${activeTab === 'active'
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
                        onClick={() => setActiveTab('team')}
                        className={`flex-1 min-w-[100px] py-3 text-[10px] sm:text-xs font-bold tracking-wide border-b-2 transition-all flex items-center justify-center gap-1 sm:gap-2 ${activeTab === 'team'
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
                                                        <Button
                                                            onClick={() => {
                                                                if (confirm("Save all generated routes without assigning?")) {
                                                                    generatedRoutes.forEach(r => onSaveRoute(r, null, null));
                                                                }
                                                            }}
                                                            size="sm"
                                                            className="w-full h-8 bg-gray-700 hover:bg-gray-600 text-white font-bold text-[10px]"
                                                        >
                                                            SAVE ALL
                                                        </Button>
                                                        {/* @ts-ignore */}
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
import { HelpCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

function StatBox({ label, value, highlight = false, tooltip = undefined }) {
    return (
        <div className="bg-black/40 p-2 rounded-lg border border-white/5 text-center relative group">
            {tooltip && (
                <div className="absolute top-1 right-1 opacity-50 hover:opacity-100 cursor-help">
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger><HelpCircle className="w-3 h-3 text-gray-500" /></TooltipTrigger>
                            {/* @ts-ignore */}
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

function RouteSection({ title, icon, routes, repColors, onSelectRoute, activeRouteId, collapsed = false, onDeleteRoute }) {
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
                />
            ))}
        </div>
    );
}

function NewRouteCard({ route, rank, isActive, recommendation, onSelect, onSave }) {
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
                <div className={`absolute top-0 left-0 w-12 h-12 flex items-center justify-center rounded-br-2xl text-black font-bold text-lg shadow-lg z-10 ${rank === 1 ? 'bg-yellow-400' : rank === 2 ? 'bg-gray-300' : 'bg-orange-700'
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
                    <Badge variant="default" className="shrink-0" style={{
                        background: route.competitivenessScore >= 150 ? '#22c55e' :
                            route.competitivenessScore >= 100 ? '#eab308' : '#666',
                        color: '#000'
                    }}>
                        Score: {route.competitivenessScore}
                    </Badge>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                    <span>{route.houseCount} doors</span>
                    <span>{route.streetCount || '?'} streets</span>
                    <span>{route.totalDistance} mi</span>
                </div>
            </button>

            {/* Assignment Actions */}
            <div className="mt-3 flex gap-2 min-w-0">
                {/* @ts-ignore */}
                <Button
                    onClick={(e) => {
                        e.stopPropagation();
                        onSave(recommendation?.id, recommendation?.name);
                    }}
                    size="sm"
                    className="flex-1 h-8 text-[10px] font-bold bg-[#252525] hover:bg-green-600 text-white transition-all border border-gray-700"
                >
                    {recommendation ? (
                        <div className="flex items-center justify-between w-full">
                            <div className="flex items-center">
                                <span className={`w-2 h-2 rounded-full mr-2 ${recommendation.isAvailable ? 'bg-green-500' : 'bg-yellow-500'}`} />
                                <span>DISPATCH: {recommendation.name?.split(' ')[0]?.toUpperCase()}</span>
                            </div>
                            <span className="text-[9px] opacity-60">{recommendation.matchScore}%</span>
                        </div>
                    ) : 'SAVE ROUTE'}
                </Button>
                <Button
                    onClick={(e) => {
                        e.stopPropagation();
                        onSave(null, null);
                    }}
                    size="sm"
                    className="h-8 w-8 p-0 bg-black hover:bg-gray-800 border border-gray-700 text-gray-400"
                    title="Save Unassigned"
                >
                    <Shield className="w-3 h-3" />
                </Button>
            </div>

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

function SavedRouteCard({ route, repColor, isActive, onSelect, onDelete }) {
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
                    <div>
                        <span className="font-bold text-sm text-white block pr-6">{route.name}</span>
                        {route.assigned_to_name && (
                            <span className="text-[10px] text-gray-500">{route.assigned_to_name}</span>
                        )}
                    </div>
                    <Badge variant="default" className="shrink-0" style={{
                        background: route.status === 'COMPLETED' ? '#22c55e' :
                            route.status === 'IN_PROGRESS' ? '#3b82f6' : '#333',
                        color: '#fff'
                    }}>
                        {route.status}
                    </Badge>
                </div>
                <div className="flex gap-3 text-[10px] text-gray-600 mt-1">
                    <span>{route.houseCount || route.metrics?.house_count} doors</span>
                    <span>{route.competitivenessScore || route.metrics?.score || 0} score</span>
                </div>
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
        </div>
    );
}