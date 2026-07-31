import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
    Navigation, X, Clock, CheckCircle2, AlertCircle,
    ChevronRight, Merge, Trash2, RefreshCw, Pencil, Check, Scissors, Play, Home
} from 'lucide-react';
import { generateOptimizedRoutes } from "@/components/logic/routeOptimizer";
import { createRouteContinuityContext } from "@/components/logic/routeRoadContext";
import { base44 } from '@/api/base44Client';
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FOLLOW_UP_STATUSES, getRouteOutcomeStats, getRerunHashes, getRerunProperties, buildRerunRoutePayload } from '@/components/routes/routeRerunUtils';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const isRerunRoute = (route) => Boolean(
    route?.metadata?.rerun_from_route_id ||
    route?.metadata?.rerun_filter ||
    (route?.name || '').includes(' Rerun — ')
);

function getRouteBoundsBadge(route) {
    const bounds = route?.metadata?.route_bounds;
    const mode = String(route?.route_origin_mode || bounds?.mode || bounds?.origin_mode || '').toLowerCase();
    const startSource = String(bounds?.start_source || bounds?.start?.source || '').toLowerCase();
    const isEnabled = mode === 'home_round_trip' || mode === 'current_to_home' || mode === 'custom_bounds' || mode.includes('current');

    if (!isEnabled) return null;
    if (mode === 'custom_bounds') return 'Custom start/finish';
    return mode === 'current_to_home' || mode.includes('current') || startSource.includes('current') || startSource.includes('gps')
        ? 'Current → home'
        : 'Home round trip';
}

export default function ActiveRoutesTab({
    savedRoutes = [],
    routesByStatus,
    repColors = {},
    onSelectRoute,
    activeRouteId,
    onDeleteRoute,
    onDeleteAllRoutes,
    onReoptimizeRoute,
    routeConfig,
    logs = [],
    onReplaceRoutes,
    teamMembers = [],
    onSplitRoute
}) {
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [mergeMode, setMergeMode] = useState(false);
    const isMultiSelect = mergeMode;
    const queryClient = useQueryClient();

    // Build a global route number map: route.id → #1, #2, #3...
    const routeNumberMap = useMemo(() => {
        const map = new Map();
        savedRoutes.forEach((r, i) => map.set(r.id, i + 1));
        return map;
    }, [savedRoutes]);

    const rerunRoutes = useMemo(() => savedRoutes.filter(isRerunRoute), [savedRoutes]);
    // Newest routes first so a freshly generated route always appears at the top of its section
    const byNewestFirst = (a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0);
    const normalRoutesByStatus = useMemo(() => ({
        IN_PROGRESS: (routesByStatus.IN_PROGRESS || []).filter(route => !isRerunRoute(route)).sort(byNewestFirst),
        ACTIVE: (routesByStatus.ACTIVE || []).filter(route => !isRerunRoute(route)).sort(byNewestFirst),
        PENDING: (routesByStatus.PENDING || []).filter(route => !isRerunRoute(route)).sort(byNewestFirst),
        COMPLETED: (routesByStatus.COMPLETED || []).filter(route => !isRerunRoute(route)).sort(byNewestFirst)
    }), [routesByStatus]);

    const toggleSelect = (routeId) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(routeId)) next.delete(routeId);
            else next.add(routeId);
            return next;
        });
    };

    const selectedRoutes = useMemo(() => {
        return savedRoutes.filter(r => selectedIds.has(r.id));
    }, [savedRoutes, selectedIds]);

    // Build display string for selected route numbers (e.g. "#1, #3, #5")
    const selectedNumbers = useMemo(() => {
        return [...selectedIds]
            .map(id => routeNumberMap.get(id))
            .filter(Boolean)
            .sort((a, b) => a - b)
            .map(n => `#${n}`)
            .join(', ');
    }, [selectedIds, routeNumberMap]);

    const handleMerge = async () => {
        if (selectedRoutes.length < 2) {
            toast.error("Select at least 2 routes to merge");
            return;
        }

        if (!confirm(`Merge ${selectedRoutes.length} routes? The originals will be deleted and replaced with one optimized route.`)) {
            return;
        }

        // Collect all full saved-route properties; display filters should not shrink merged routes.
        const seen = new Set();
        const allProps = [];
        for (const route of selectedRoutes) {
            const props = route.allProperties || route.properties || [];
            console.log(`[RoutePipeline] merge_input route=${route.id} hashes=${route.property_hashes?.length || 0} props=${props.length}`);
            for (const p of props) {
                const key = p.address_hash || p.id;
                if (key && !seen.has(key)) {
                    seen.add(key);
                    allProps.push(p);
                }
            }
        }
        console.log(`[RoutePipeline] after_merge_union selected=${selectedRoutes.length} union=${allProps.length}`);

        if (allProps.length === 0) {
            toast.error("Selected routes have no properties to merge");
            return;
        }

        try {
            const firstSelectedRoute = selectedRoutes[0];
            const sameAssignee = selectedRoutes.every(route => route.assigned_to === firstSelectedRoute.assigned_to);
            const boundsKey = (route) => JSON.stringify({
                mode: route?.route_origin_mode || 'none',
                start: route?.start_location || null,
                end: route?.end_location || null
            });
            const hasStoredBounds = (route) => {
                const start = route?.start_location;
                const end = route?.end_location;
                return start && end && start.lat != null && start.lat !== '' && start.lng != null && start.lng !== ''
                    && end.lat != null && end.lat !== '' && end.lng != null && end.lng !== ''
                    && Number.isFinite(Number(start.lat)) && Number.isFinite(Number(start.lng))
                    && Number.isFinite(Number(end.lat)) && Number.isFinite(Number(end.lng));
            };
            const sharedRouteBounds = sameAssignee && firstSelectedRoute?.route_origin_mode && firstSelectedRoute.route_origin_mode !== 'none' &&
                hasStoredBounds(firstSelectedRoute) &&
                selectedRoutes.every(route => boundsKey(route) === boundsKey(firstSelectedRoute));
            const mergeStart = sharedRouteBounds ? firstSelectedRoute.start_location : null;
            const mergeEnd = sharedRouteBounds ? firstSelectedRoute.end_location : null;
            const routingContext = createRouteContinuityContext(allProps);
            const merged = generateOptimizedRoutes(
                allProps, allProps.length, mergeStart, [],
                { minimizeTurns: true, use2Opt: true, walkingPattern: 'nearest', endLocation: mergeEnd, routeOriginMode: sharedRouteBounds ? firstSelectedRoute.route_origin_mode : 'none', excludeTerminal: false, preserveInputMembership: true, routingContext }
            );

            if (merged && merged.length > 0) {
                const optimizedRoute = merged[0];
                const firstRoute = selectedRoutes[0];
                const mergedRouteData = {
                    name: `Merged (${selectedRoutes.length} routes, ${allProps.length} doors)`,
                    property_hashes: optimizedRoute.properties.map(p => p.address_hash || p.id).filter(Boolean),
                    metrics: {
                        distance: optimizedRoute.totalDistance || 0,
                        house_count: optimizedRoute.houseCount || allProps.length,
                        score: optimizedRoute.competitivenessScore || 0
                    },
                    status: 'ACTIVE',
                    manager_id: firstRoute.manager_id,
                    assigned_to: sameAssignee ? firstRoute.assigned_to : null,
                    assigned_to_name: sameAssignee ? firstRoute.assigned_to_name : null,
                    start_location: null,
                    end_location: null,
                    route_origin_mode: sharedRouteBounds ? firstRoute.route_origin_mode : 'none',
                    ...(sharedRouteBounds && firstRoute.metadata ? { metadata: firstRoute.metadata } : {})
                };

                // Save the merged route first so Optimize and Knock use a real SavedRoute ID.
                const savedMergedRoute = await base44.entities.SavedRoute.create(mergedRouteData);

                // Delete original routes only after the replacement exists.
                await Promise.all(
                    selectedRoutes.map(route => base44.entities.SavedRoute.delete(route.id).catch(() => {}))
                );
                queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });

                const routeForDisplay = {
                    ...savedMergedRoute,
                    ...optimizedRoute,
                    id: savedMergedRoute.id,
                    name: savedMergedRoute.name,
                    property_hashes: savedMergedRoute.property_hashes,
                    metrics: savedMergedRoute.metrics,
                    status: savedMergedRoute.status,
                    manager_id: savedMergedRoute.manager_id,
                    assigned_to: savedMergedRoute.assigned_to,
                    assigned_to_name: savedMergedRoute.assigned_to_name,
                    properties: optimizedRoute.properties,
                    allProperties: optimizedRoute.properties,
                    houseCount: optimizedRoute.houseCount || allProps.length,
                    totalDistance: optimizedRoute.totalDistance || 0,
                    competitivenessScore: optimizedRoute.competitivenessScore || 0,
                    isSaved: true
                };

                if (onReplaceRoutes) onReplaceRoutes([]);
                try { localStorage.setItem('fk_selectedKnockRouteId', routeForDisplay.id); } catch {}
                onSelectRoute(routeForDisplay);

                toast.success(`Merged ${selectedRoutes.length} routes → ${allProps.length} doors`);
                setSelectedIds(new Set());
                setMergeMode(false);
            }
        } catch (e) {
            toast.error("Failed to merge routes");
        }
    };

    return (
        <>
            {/* Top command bar */}
            <div className="mb-3 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#151515] via-[#0f0f0f] to-black p-3 shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#39FF4A]">Route Command</p>
                        <h3 className="truncate text-base font-black text-white">{savedRoutes.length} active route{savedRoutes.length === 1 ? '' : 's'}</h3>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-bold text-white/60">
                            {isMultiSelect ? `${selectedIds.size} selected` : 'Ready'}
                        </div>
                        {!isMultiSelect && savedRoutes.length > 0 && (
                            <button
                                onClick={() => {
                                    if (confirm("Delete all routes?")) {
                                        onDeleteAllRoutes && onDeleteAllRoutes();
                                    }
                                }}
                                className="rounded-lg p-1.5 text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
                                title="Delete all routes"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                    {isMultiSelect ? (
                        <>
                            <Button
                                onClick={handleMerge}
                                size="sm"
                                disabled={selectedIds.size < 2}
                                className="h-10 rounded-xl bg-[#2EEB57] px-3 text-[10px] font-black text-black hover:bg-[#39FF4A] disabled:opacity-40"
                            >
                                <Merge className="mr-1 h-3.5 w-3.5" />
                                MERGE {selectedNumbers || selectedIds.size}
                            </Button>
                            <Button
                                onClick={() => { setMergeMode(false); setSelectedIds(new Set()); }}
                                variant="ghost"
                                size="sm"
                                className="h-10 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black text-white/70 hover:bg-white/10 hover:text-white"
                            >
                                <X className="mr-1 h-3.5 w-3.5" /> CANCEL
                            </Button>
                        </>
                    ) : (
                        <>
                            {savedRoutes.length >= 2 && (
                                <Button
                                    onClick={() => setMergeMode(true)}
                                    variant="ghost"
                                    size="sm"
                                    className="h-10 rounded-xl border border-[#2EEB57]/25 bg-[#2EEB57]/10 px-3 text-[10px] font-black text-[#39FF4A] hover:bg-[#2EEB57]/20"
                                >
                                    <Merge className="mr-1 h-3.5 w-3.5" /> SELECT TO MERGE
                                </Button>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* In Progress */}
            {normalRoutesByStatus.IN_PROGRESS.length > 0 && (
                <RouteSection
                    title="In Progress"
                    icon={<Clock className="w-4 h-4 text-blue-500" />}
                    routes={normalRoutesByStatus.IN_PROGRESS}
                    repColors={repColors}
                    onSelectRoute={onSelectRoute}
                    activeRouteId={activeRouteId}
                    onDeleteRoute={onDeleteRoute}
                    logs={logs}
                    onReoptimize={onReoptimizeRoute}
                    routeConfig={routeConfig}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    isMultiSelect={isMultiSelect}
                    routeNumberMap={routeNumberMap}
                    onSplitRoute={onSplitRoute}
                />
            )}

            {/* Active/Queued */}
            {normalRoutesByStatus.ACTIVE.length > 0 && (
                <RouteSection
                    title="Queued"
                    icon={<Navigation className="w-4 h-4 text-yellow-500" />}
                    routes={normalRoutesByStatus.ACTIVE}
                    repColors={repColors}
                    onSelectRoute={onSelectRoute}
                    activeRouteId={activeRouteId}
                    onDeleteRoute={onDeleteRoute}
                    logs={logs}
                    onReoptimize={onReoptimizeRoute}
                    routeConfig={routeConfig}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    isMultiSelect={isMultiSelect}
                    routeNumberMap={routeNumberMap}
                    onSplitRoute={onSplitRoute}
                />
            )}

            {/* Pending */}
            {normalRoutesByStatus.PENDING.length > 0 && (
                <RouteSection
                    title="Pending Assignment"
                    icon={<AlertCircle className="w-4 h-4 text-orange-500" />}
                    routes={normalRoutesByStatus.PENDING}
                    repColors={repColors}
                    onSelectRoute={onSelectRoute}
                    activeRouteId={activeRouteId}
                    onDeleteRoute={onDeleteRoute}
                    logs={logs}
                    onReoptimize={onReoptimizeRoute}
                    routeConfig={routeConfig}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    isMultiSelect={isMultiSelect}
                    routeNumberMap={routeNumberMap}
                    onSplitRoute={onSplitRoute}
                />
            )}

            {/* Reruns */}
            {rerunRoutes.length > 0 && (
                <RouteSection
                    title="Reruns"
                    icon={<RefreshCw className="w-4 h-4 text-[#39FF4A]" />}
                    routes={rerunRoutes}
                    repColors={repColors}
                    onSelectRoute={onSelectRoute}
                    activeRouteId={activeRouteId}
                    onDeleteRoute={onDeleteRoute}
                    logs={logs}
                    onReoptimize={onReoptimizeRoute}
                    routeConfig={routeConfig}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    isMultiSelect={isMultiSelect}
                    routeNumberMap={routeNumberMap}
                    onSplitRoute={onSplitRoute}
                />
            )}

            {/* Completed */}
            {normalRoutesByStatus.COMPLETED.length > 0 && (
                <RouteSection
                    title="Completed"
                    icon={<CheckCircle2 className="w-4 h-4 text-green-500" />}
                    routes={normalRoutesByStatus.COMPLETED}
                    repColors={repColors}
                    onSelectRoute={onSelectRoute}
                    activeRouteId={activeRouteId}
                    onDeleteRoute={onDeleteRoute}
                    logs={logs}
                    onReoptimize={onReoptimizeRoute}
                    routeConfig={routeConfig}
                    collapsed
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    isMultiSelect={isMultiSelect}
                    routeNumberMap={routeNumberMap}
                    onSplitRoute={onSplitRoute}
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
    );
}

function RouteSection({ title, icon, routes, repColors, onSelectRoute, activeRouteId, collapsed = false, onDeleteRoute, logs = [], onReoptimize, routeConfig, selectedIds, onToggleSelect, isMultiSelect, routeNumberMap, onSplitRoute }) {
    const [isExpanded, setIsExpanded] = useState(!collapsed);

    return (
        <div className="space-y-2">
            <button onClick={() => setIsExpanded(!isExpanded)} className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-left transition-colors hover:bg-white/[0.06]">
                {icon}
                <span className="min-w-0 truncate text-xs font-black uppercase tracking-[0.16em] text-white/70">{title}</span>
                <Badge variant="outline" className="shrink-0 border-white/10 bg-white/10 text-[9px] text-white">{routes.length}</Badge>
                <ChevronRight className={`ml-auto h-4 w-4 shrink-0 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            </button>

            {isExpanded && routes.map(route => (
                <SavedRouteCard
                    key={route.id}
                    route={route}
                    routeNumber={routeNumberMap?.get(route.id)}
                    repColor={route.assigned_to ? repColors[route.assigned_to] : '#666'}
                    isActive={activeRouteId === route.id}
                    onSelect={() => onSelectRoute({ ...route, route_number: routeNumberMap?.get(route.id) })}
                    onDelete={() => onDeleteRoute && onDeleteRoute(route)}
                    logs={logs}
                    onReoptimize={onReoptimize}
                    routeConfig={routeConfig}
                    isSelected={selectedIds.has(route.id)}
                    onToggleSelect={() => onToggleSelect(route.id)}
                    isMultiSelect={isMultiSelect}
                    onSplit={() => onSplitRoute?.(route)}
                />
            ))}
        </div>
    );
}

function SavedRouteCard({ route, routeNumber, repColor, isActive, onSelect, onDelete, logs = [], onReoptimize, routeConfig, isSelected, onToggleSelect, isMultiSelect, onSplit }) {
    const [editing, setEditing] = useState(false);
    const [newName, setNewName] = useState(route.name);
    const [showRerunMenu, setShowRerunMenu] = useState(false);
    const [rerunBusy, setRerunBusy] = useState(false);
    const queryClient = useQueryClient();

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
        const dates = props.map(p => p.sold_date ? new Date(p.sold_date).getTime() : null).filter(Boolean);
        if (dates.length === 0) return null;
        const min = new Date(Math.min(...dates));
        const max = new Date(Math.max(...dates));
        return formatDateRange(min, max);
    }, [route.properties]);

    const isCompletedRoute = route.status === 'COMPLETED';
    const outcomeStats = useMemo(() => getRouteOutcomeStats(route, logs), [route, logs]);

    const handleRerun = async (filter, label) => {
        if (rerunBusy) return;
        const selectedHashes = getRerunHashes(route, outcomeStats, filter);
        if (selectedHashes.length === 0) {
            toast.error(`No ${label.toLowerCase()} doors found on this route`);
            return;
        }

        setRerunBusy(true);
        try {
            const rerunProperties = getRerunProperties(route, selectedHashes);
            const rerunRoute = await base44.entities.SavedRoute.create(buildRerunRoutePayload(route, selectedHashes, filter, label));

            queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
            try { localStorage.setItem('fk_selectedKnockRouteId', rerunRoute.id); } catch {}
            setShowRerunMenu(false);
            toast.success(`Created rerun with ${selectedHashes.length} doors`);
            onSelect({ ...rerunRoute, properties: rerunProperties, allProperties: rerunProperties, houseCount: selectedHashes.length, route_number: routeNumber });
        } finally {
            setRerunBusy(false);
        }
    };

    const handleRename = async () => {
        if (!newName.trim() || newName === route.name) { setEditing(false); return; }
        await base44.entities.SavedRoute.update(route.id, { name: newName.trim() });
        queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
        setEditing(false);
    };

    const displayName = routeNumber && (!route.name || /^Route\s+\d+$/i.test(route.name)) ? `Route ${routeNumber}` : route.name;
    const isNew = route.metadata?.newly_generated && route.created_date && (Date.now() - new Date(route.created_date).getTime()) < 24 * 60 * 60 * 1000;
    const routeBoundsBadge = getRouteBoundsBadge(route);

    return (
        <div className={`relative group flex items-start gap-1.5 sm:gap-2 min-w-0 max-w-full overflow-hidden ${isSelected ? 'ring-2 ring-[#39FF4A] rounded-2xl' : ''}`}>
            {/* Multi-select checkbox */}
            {isMultiSelect && (
                <div className="flex items-center pt-2.5 pl-0.5 pr-0.5 shrink-0 z-10" onClick={e => e.stopPropagation()}>
                    <Checkbox
                        checked={isSelected}
                        onCheckedChange={onToggleSelect}
                        className="h-5 w-5 shrink-0 border-2 border-purple-400 bg-black/70 data-[state=checked]:bg-purple-600 data-[state=checked]:border-purple-500"
                    />
                </div>
            )}

            <div className="flex-1 min-w-0 max-w-full overflow-hidden">
                <div
                    onClick={isMultiSelect ? onToggleSelect : onSelect}
                    role="button"
                    tabIndex={0}
                    className="w-full max-w-full overflow-hidden rounded-2xl border p-3 text-left shadow-[0_10px_28px_rgba(0,0,0,0.28)] transition-all hover:-translate-y-0.5 hover:border-[#2EEB57]/40 cursor-pointer"
                    style={{
                        background: isActive ? 'linear-gradient(135deg, rgba(46,235,87,0.16), rgba(21,21,21,0.98))' : 'linear-gradient(135deg, rgba(255,255,255,0.045), rgba(10,10,10,0.98))',
                        borderColor: isActive ? '#2EEB57' : 'rgba(255,255,255,0.08)',
                        borderLeftWidth: '3px',
                        borderLeftColor: repColor
                    }}
                >
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between min-w-0 gap-1.5 pr-12 sm:pr-0">
                        <div className="flex-1 min-w-0">
                            {editing ? (
                                <div className="flex items-center gap-1 min-w-0" onClick={e => e.stopPropagation()}>
                                    <input
                                        value={newName}
                                        onChange={e => setNewName(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(false); }}
                                        className="bg-black/60 border border-gray-600 text-white text-sm font-bold rounded px-2 py-0.5 w-full min-w-0"
                                        autoFocus
                                    />
                                    <button onClick={handleRename} className="p-1 text-green-500 hover:text-green-400"><Check className="w-4 h-4" /></button>
                                    <button onClick={() => { setNewName(route.name); setEditing(false); }} className="p-1 text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
                                </div>
                            ) : (
                                <div className="flex items-center gap-1.5 min-w-0">
                                    {routeNumber && (
                                        <span className="shrink-0 w-6 h-6 rounded-md bg-white/10 border border-white/20 flex items-center justify-center text-[11px] font-bold text-yellow-400">
                                            {routeNumber}
                                        </span>
                                    )}
                                    <span className="font-bold text-sm text-white truncate">{displayName}</span>
                                    {isNew && (
                                        <span className="shrink-0 rounded-full bg-[#2EEB57] px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-black">New</span>
                                    )}
                                    {!isMultiSelect && (
                                        <button
                                            onClick={e => { e.stopPropagation(); setEditing(true); }}
                                            className="p-0.5 text-gray-600 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
                                            title="Rename"
                                        >
                                            <Pencil className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>
                            )}
                            {route.assigned_to_name && (
                                <span className="text-[10px] text-gray-500">{route.assigned_to_name}</span>
                            )}
                        </div>
                        <div className="flex flex-row sm:flex-col items-center sm:items-end gap-1 min-w-0 sm:shrink-0 sm:max-w-none">
                            {dateRange && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 leading-none truncate max-w-[120px]">
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
                    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-gray-600 mt-0.5 min-w-0">
                        <span>{route.houseCount || route.metrics?.house_count} doors</span>
                        <span>{route.competitivenessScore || route.metrics?.score || 0} score</span>
                        {knockStats.knocked > 0 && (
                            <span className="text-yellow-500 font-bold">{knockStats.knocked}/{knockStats.total} knocked</span>
                        )}
                        {routeBoundsBadge && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-400/10 px-1.5 py-0.5 font-bold text-amber-300">
                                <Home className="h-3 w-3" /> {routeBoundsBadge}
                            </span>
                        )}
                    </div>
                    {isCompletedRoute && outcomeStats.knocked > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            <span className="rounded-full border border-[#2EEB57]/25 bg-[#2EEB57]/10 px-2 py-1 text-[9px] font-black text-[#39FF4A]">Sold {outcomeStats.byStatus.SOLD}</span>
                            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[9px] font-black text-white/70">No Answer {outcomeStats.byStatus.NO_ANSWER}</span>
                            <span className="rounded-full border border-blue-400/20 bg-blue-400/10 px-2 py-1 text-[9px] font-black text-blue-300">Callback {outcomeStats.byStatus.CALLBACK}</span>
                            <span className="rounded-full border border-red-400/20 bg-red-400/10 px-2 py-1 text-[9px] font-black text-red-300">Not Int. {outcomeStats.byStatus.HARD_NO}</span>
                        </div>
                    )}
                    {knockStats.total > 0 && (
                        <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ background: '#222' }}>
                            <div className="h-full rounded-full transition-all" style={{ width: `${(knockStats.knocked / knockStats.total) * 100}%`, background: knockStats.knocked === knockStats.total ? '#22c55e' : '#FFD700' }} />
                        </div>
                    )}
                    {!isMultiSelect && (
                        <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                            {isCompletedRoute ? (
                                <div className="space-y-2">
                                    <button
                                        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowRerunMenu(!showRerunMenu); }}
                                        className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#2EEB57] text-[11px] font-black text-black shadow-[0_8px_24px_rgba(46,235,87,0.24)] hover:bg-[#39FF4A] md:h-9"
                                        title="Create a new active route from this completed route"
                                    >
                                        <RefreshCw className="h-4 w-4" /> RERUN ROUTE
                                    </button>
                                    {showRerunMenu && (
                                        <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-white/10 bg-black/55 p-2">
                                            {[
                                                { filter: 'all', label: 'All Doors', count: outcomeStats.total },
                                                { filter: 'no_answer', label: 'No Answer', count: outcomeStats.byStatus.NO_ANSWER },
                                                { filter: 'callbacks', label: 'Callbacks', count: outcomeStats.byStatus.CALLBACK },
                                                { filter: 'unsold', label: 'Unsold Follow-Up', count: outcomeStats.routeHashes.filter(hash => !outcomeStats.latestByHash.get(hash) || FOLLOW_UP_STATUSES.has(outcomeStats.latestByHash.get(hash))).length }
                                            ].map(option => (
                                                <button
                                                    key={option.filter}
                                                    disabled={rerunBusy}
                                                    onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); e.nativeEvent?.stopImmediatePropagation?.(); }}
                                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); e.nativeEvent?.stopImmediatePropagation?.(); handleRerun(option.filter, option.label); }}
                                                    className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-2 text-left text-[10px] font-black text-white/80 hover:border-[#2EEB57]/45 hover:bg-[#2EEB57]/10 disabled:opacity-50"
                                                >
                                                    <span className="block">{option.label}</span>
                                                    <span className="text-[9px] text-white/40">{option.count} doors</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="grid grid-cols-[1fr_auto] gap-2">
                                    <button
                                        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(); }}
                                        className="flex h-11 items-center justify-center gap-2 rounded-xl border border-[#2EEB57]/25 bg-[#2EEB57]/10 text-[11px] font-black text-[#86efac] shadow-none hover:border-[#2EEB57]/45 hover:bg-[#2EEB57]/15 md:h-9"
                                        title="Start this route"
                                    >
                                        <Play className="h-4 w-4 fill-[#86efac]" /> START ROUTE
                                    </button>
                                    {onSplit && (
                                        <button
                                            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSplit(); }}
                                            className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black text-white/70 hover:bg-white/10 hover:text-white md:h-9"
                                            title="Split route into daily batches"
                                        >
                                            <Scissors className="h-4 w-4" /> SPLIT
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
                {!isMultiSelect && onDelete && (
                    <button
                        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(); }}
                        className="absolute top-2 right-2 p-1.5 bg-red-500/20 hover:bg-red-500/40 text-red-500 rounded opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity touch-manipulation"
                        title="Delete Route"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                )}
                {!isMultiSelect && onReoptimize && (
                    <button
                        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReoptimize(route); }}
                        className="absolute top-2 right-10 p-1.5 bg-blue-500/20 hover:bg-blue-500/40 text-blue-400 rounded opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity touch-manipulation"
                        title={`Re-optimize order (${routeConfig?.walkingPattern?.replace(/_/g, ' ') || 'current pattern'})`}
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
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