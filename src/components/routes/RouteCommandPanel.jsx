import React, { useState, useMemo } from 'react';
import ActiveRoutesTab, { SavedRouteCard } from './ActiveRoutesTab';
import SplitRouteModal from './SplitRouteModal';
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Navigation, X, User, Clock, Search
} from 'lucide-react';
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { hydrateRouteForMap } from '@/components/logic/routeHydration';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const isOperationalRoute = (route) => !['ARCHIVED'].includes(
    String(route?.status || '').toUpperCase()
);

const canSplitRoute = (route) => isOperationalRoute(route)
    && !['COMPLETED'].includes(String(route?.status || '').toUpperCase())
    && (route?.houseCount || route?.properties?.length || route?.property_hashes?.length || 0) > 1;

export default function RouteCommandPanel({
    generatedRoutes = [],
    savedRoutes = [],
    repColors = {},
    teamMembers = [],
    viewerEmail = null,
    onSelectRoute,
    onSaveRoute,
    onDeleteAllRoutes,
    onDeleteRoute,
    onReplaceRoutes,
    onClose,
    activeRouteId,
    logs = [],
    onReoptimizeRoute,
    routeConfig
}) {
    const selectRouteForMapAndKnock = async (route) => {
        const hydratedRoute = route.isSaved === false ? route : await hydrateRouteForMap(route, viewerEmail);
        if (hydratedRoute?.id) {
            try { localStorage.setItem('fk_selectedKnockRouteId', hydratedRoute.id); } catch {}
        }
        onSelectRoute(hydratedRoute);
    };

    const [activeTab, setActiveTab] = useState('active');
    const [splitRoute, setSplitRoute] = useState(null);
    const [routeSearch, setRouteSearch] = useState('');
    const queryClient = useQueryClient();
    const normalizedRouteSearch = routeSearch.trim().toLowerCase();
    const matchesRouteSearch = (route) => !normalizedRouteSearch || String(route?.name || '').toLowerCase().includes(normalizedRouteSearch);
    const operationalSavedRoutes = useMemo(
        () => savedRoutes.filter(route => isOperationalRoute(route) && matchesRouteSearch(route)),
        [savedRoutes, normalizedRouteSearch]
    );
    const pendingGeneratedRoutes = useMemo(() => {
        const savedIds = new Set(savedRoutes.map(route => route.id));
        return generatedRoutes.filter(route => !savedIds.has(route.id) && matchesRouteSearch(route));
    }, [generatedRoutes, savedRoutes, normalizedRouteSearch]);

    // Build a global route number map: route.id → #1, #2, #3...
    const routeNumberMap = useMemo(() => {
        const map = new Map();
        operationalSavedRoutes.forEach((r, i) => map.set(r.id, i + 1));
        return map;
    }, [operationalSavedRoutes]);

    // Group saved routes by status
    const routesByStatus = useMemo(() => {
        const groups = {
            IN_PROGRESS: [],
            ACTIVE: [],
            PENDING: [],
            COMPLETED: []
        };
        operationalSavedRoutes.forEach(r => {
            const status = r.status || 'PENDING';
            if (groups[status]) groups[status].push(r);
            else groups.PENDING.push(r);
        });
        return groups;
    }, [operationalSavedRoutes]);

    // Group saved routes by rep
    const routesByRep = useMemo(() => {
        const groups = { unassigned: [] };
        teamMembers.forEach(m => groups[m.id] = { member: m, routes: [] });

        operationalSavedRoutes.forEach(r => {
            if (r.assigned_to && groups[r.assigned_to]) {
                groups[r.assigned_to].routes.push(r);
            } else {
                groups.unassigned.push(r);
            }
        });
        return groups;
    }, [operationalSavedRoutes, teamMembers]);

    const handleSplitRoutesCreated = async (result) => {
        queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
        if (result?.sourceArchived && activeRouteId === result.sourceRouteId) {
            try { localStorage.removeItem('fk_selectedKnockRouteId'); } catch {}
            onSelectRoute?.(null);
        }
        const count = Number(result?.count || 0);
        toast.success(`Created ${count} optimized route${count === 1 ? '' : 's'}. Assign them when ready.`);
    };

    return (
        <div className="fixed inset-0 z-[2000] overflow-hidden touch-manipulation">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
            <div
                onPointerDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                className="fixed top-0 bottom-0 left-0 right-0 w-dvw max-w-[100dvw] md:right-auto md:max-w-xl overflow-hidden flex flex-col z-[3000] backdrop-blur-xl shadow-2xl animate-in slide-in-from-left duration-300 border-r border-white/10 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgba(10, 10, 10, 0.98)' }}
            >
                {/* Header */}
                <div className="px-3 py-3 sm:p-4 border-b flex justify-between items-center shrink-0 min-w-0 gap-2" style={{ borderColor: BRAND.charcoal }}>
                    <div className="min-w-0">
                        <h2 className="flex items-center gap-2 text-base sm:text-lg font-bold tracking-wide truncate" style={{ color: BRAND.gold }}>
                            <Navigation className="w-5 h-5 shrink-0" />
                            ROUTE COMMAND
                        </h2>
                        <p className="text-[10px] mt-1" style={{ color: '#666' }}>
                            {operationalSavedRoutes.length + pendingGeneratedRoutes.length} Routes
                        </p>
                    </div>
                    <button
                        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
                        className="p-2 sm:p-3 -mr-1 hover:bg-white/5 rounded-lg transition-colors touch-manipulation shrink-0"
                    >
                        <X className="w-5 h-5" style={{ color: BRAND.offWhite }} />
                    </button>
                </div>

                <div className="shrink-0 border-b border-white/10 px-3 py-2.5 sm:px-4">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                        <input
                            type="text"
                            value={routeSearch}
                            onChange={(event) => {
                                setRouteSearch(event.target.value);
                                if (event.target.value.trim()) setActiveTab('active');
                            }}
                            placeholder="Search routes by name…"
                            aria-label="Search routes by name"
                            className="h-10 w-full rounded-xl border border-white/10 bg-black/60 pl-9 pr-9 text-sm text-white outline-none placeholder:text-white/30 focus:border-[#2EEB57]/55"
                        />
                        {routeSearch && <button type="button" onClick={() => setRouteSearch('')} aria-label="Clear route search" className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white"><X className="h-3.5 w-3.5" /></button>}
                    </div>
                </div>

                {/* Tab Navigation */}
                <div className="grid grid-cols-2 border-b px-1 sm:px-4 shrink-0 overflow-hidden" style={{ borderColor: BRAND.charcoal }}>
                    <button
                        onClick={() => setActiveTab('active')}
                        className={`min-w-0 py-3 text-[9px] sm:text-xs font-bold tracking-wide border-b-2 transition-all flex items-center justify-center gap-1 sm:gap-2 ${activeTab === 'active'
                            ? 'border-blue-500 text-blue-500'
                            : 'border-transparent text-gray-500 hover:text-white'
                            }`}
                    >
                        <Clock className="w-3 h-3 sm:w-4 sm:h-4" />
                        ACTIVE
                        <Badge variant="default" className="bg-blue-600 text-white text-[9px] h-4 px-1.5">
                            {routesByStatus.IN_PROGRESS.length + routesByStatus.ACTIVE.length + pendingGeneratedRoutes.length}
                        </Badge>
                    </button>
                    <button
                        onClick={() => setActiveTab('team')}
                        className={`min-w-0 py-3 text-[9px] sm:text-xs font-bold tracking-wide border-b-2 transition-all flex items-center justify-center gap-1 sm:gap-2 ${activeTab === 'team'
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
                    <ScrollArea className="h-full w-full [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!w-full [&_[data-radix-scroll-area-viewport]>div]:!min-w-0">
                        <div className="p-2 sm:p-4 space-y-2 sm:space-y-4 w-full max-w-full overflow-x-hidden">

                        {normalizedRouteSearch && operationalSavedRoutes.length === 0 && pendingGeneratedRoutes.length === 0 && (
                            <div className="py-12 text-center text-sm font-bold text-white/40">No routes match “{routeSearch.trim()}”.</div>
                        )}

                        {/* ACTIVE ROUTES TAB */}
                        {activeTab === 'active' && (
                            <>
                                {pendingGeneratedRoutes.map((route, index) => (
                                    <SavedRouteCard
                                        key={route.id}
                                        route={{ ...route, isSaved: false, status: 'ACTIVE',
                                            metadata: { ...route.metadata, newly_generated: true },
                                            created_date: route.created_date || new Date().toISOString() }}
                                        routeNumber={operationalSavedRoutes.length + index + 1}
                                        repColor="#666"
                                        isActive={activeRouteId === route.id}
                                        onSelect={() => selectRouteForMapAndKnock({ ...route, isSaved: false })}
                                        onSave={() => onSaveRoute?.(route)}
                                        logs={logs}
                                    />
                                ))}
                                {(operationalSavedRoutes.length > 0 || pendingGeneratedRoutes.length === 0) && (
                                    <ActiveRoutesTab
                                        savedRoutes={operationalSavedRoutes}
                                        routesByStatus={routesByStatus}
                                        repColors={repColors}
                                        onSelectRoute={selectRouteForMapAndKnock}
                                        activeRouteId={activeRouteId}
                                        onDeleteRoute={onDeleteRoute}
                                        onDeleteAllRoutes={onDeleteAllRoutes}
                                        onReoptimizeRoute={onReoptimizeRoute}
                                        routeConfig={routeConfig}
                                        logs={logs}
                                        onReplaceRoutes={onReplaceRoutes}
                                        teamMembers={teamMembers}
                                        onSplitRoute={setSplitRoute}
                                    />
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
                                                                     routeNumber={routeNumberMap.get(route.id)}
                                                                     repColor={repColors[member.id]}
                                                                     isActive={activeRouteId === route.id}
                                                                     onSelect={() => selectRouteForMapAndKnock(route)}
                                                                     onDelete={() => onDeleteRoute && onDeleteRoute(route)}
                                                                     logs={logs}
                                                                     onReoptimize={onReoptimizeRoute}
                                                                     routeConfig={routeConfig}
                                                                     onSplit={canSplitRoute(route) ? () => setSplitRoute(route) : undefined}
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
                                                routeNumber={routeNumberMap.get(route.id)}
                                                repColor="#666"
                                                isActive={activeRouteId === route.id}
                                                onSelect={() => selectRouteForMapAndKnock(route)}
                                                onDelete={() => onDeleteRoute && onDeleteRoute(route)}
                                                logs={logs}
                                                onReoptimize={onReoptimizeRoute}
                                                routeConfig={routeConfig}
                                                onSplit={canSplitRoute(route) ? () => setSplitRoute(route) : undefined}
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
            {splitRoute && (
                <SplitRouteModal
                    route={splitRoute}
                    managerId={splitRoute.manager_id}
                    replaceSource
                    onClose={() => setSplitRoute(null)}
                    onCreated={handleSplitRoutesCreated}
                />
            )}
        </div>
    );
}

// Sub-components
