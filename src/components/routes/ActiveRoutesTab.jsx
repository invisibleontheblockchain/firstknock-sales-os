import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
    Navigation, X, Clock, CheckCircle2, AlertCircle,
    ChevronRight, Merge, Trash2, RefreshCw, Pencil, Check
} from 'lucide-react';
import { generateOptimizedRoutes } from "@/components/logic/routeOptimizer";
import { base44 } from '@/api/base44Client';
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

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
    onReplaceRoutes
}) {
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [mergeMode, setMergeMode] = useState(false);
    const isMultiSelect = mergeMode;

    // Build a global route number map: route.id → #1, #2, #3...
    const routeNumberMap = useMemo(() => {
        const map = new Map();
        savedRoutes.forEach((r, i) => map.set(r.id, i + 1));
        return map;
    }, [savedRoutes]);

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

        // Collect all properties from selected routes
        const seen = new Set();
        const allProps = [];
        for (const route of selectedRoutes) {
            const props = route.properties || [];
            for (const p of props) {
                const key = p.address_hash || p.id;
                if (key && !seen.has(key)) {
                    seen.add(key);
                    allProps.push(p);
                }
            }
        }

        if (allProps.length === 0) {
            toast.error("Selected routes have no properties to merge");
            return;
        }

        try {
            const merged = generateOptimizedRoutes(
                allProps, allProps.length, null, [],
                { minimizeTurns: true, use2Opt: true, walkingPattern: 'nearest' }
            );

            if (merged && merged.length > 0) {
                const mergedRoute = {
                    ...merged[0],
                    id: 'route_merged_' + Date.now(),
                    name: `Merged (${selectedRoutes.length} routes, ${allProps.length} doors)`
                };

                // Delete original routes
                for (const route of selectedRoutes) {
                    if (onDeleteRoute) await onDeleteRoute(route);
                }

                // Save the merged route
                if (onReplaceRoutes) {
                    onReplaceRoutes([mergedRoute]);
                } else {
                    onSelectRoute(mergedRoute);
                }

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
            {/* Header with actions */}
            <div className="flex justify-between items-center mb-2 px-1 gap-2">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">All Campaigns</span>
                <div className="flex items-center gap-2">
                    {isMultiSelect && (
                        <>
                            <Button
                                onClick={handleMerge}
                                size="sm"
                                disabled={selectedIds.size < 2}
                                className="h-7 text-[10px] bg-purple-600 hover:bg-purple-500 text-white font-bold px-3"
                            >
                                <Merge className="w-3 h-3 mr-1" />
                                MERGE {selectedNumbers || selectedIds.size}
                            </Button>
                            <Button
                                onClick={() => { setMergeMode(false); setSelectedIds(new Set()); }}
                                variant="ghost"
                                size="sm"
                                className="h-6 text-[10px] text-gray-400 hover:text-white px-2"
                            >
                                <X className="w-3 h-3 mr-1" /> CANCEL
                            </Button>
                        </>
                    )}
                    {!isMultiSelect && savedRoutes.length >= 2 && (
                        <Button
                            onClick={() => setMergeMode(true)}
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[10px] text-purple-400 hover:text-purple-300 hover:bg-purple-900/20 px-2"
                        >
                            <Merge className="w-3 h-3 mr-1" /> SELECT TO MERGE
                        </Button>
                    )}
                    {savedRoutes.length > 0 && !isMultiSelect && (
                        <Button
                            onClick={() => {
                                if (confirm("Delete ALL saved routes? This cannot be undone.")) {
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
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    isMultiSelect={isMultiSelect}
                    routeNumberMap={routeNumberMap}
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
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    isMultiSelect={isMultiSelect}
                    routeNumberMap={routeNumberMap}
                />
            )}

            {/* Pending */}
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
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    isMultiSelect={isMultiSelect}
                    routeNumberMap={routeNumberMap}
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
                    onDeleteRoute={onDeleteRoute}
                    logs={logs}
                    onReoptimize={onReoptimizeRoute}
                    routeConfig={routeConfig}
                    collapsed
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    isMultiSelect={isMultiSelect}
                    routeNumberMap={routeNumberMap}
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

function RouteSection({ title, icon, routes, repColors, onSelectRoute, activeRouteId, collapsed = false, onDeleteRoute, logs = [], onReoptimize, routeConfig, selectedIds, onToggleSelect, isMultiSelect, routeNumberMap }) {
    const [isExpanded, setIsExpanded] = useState(!collapsed);

    return (
        <div className="space-y-2">
            <button onClick={() => setIsExpanded(!isExpanded)} className="flex items-center gap-2 px-1 w-full text-left">
                {icon}
                <span className="text-xs font-bold text-gray-400 uppercase">{title}</span>
                <Badge variant="outline" className="bg-white/10 text-white text-[9px]">{routes.length}</Badge>
                <ChevronRight className={`w-4 h-4 text-gray-600 ml-auto transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            </button>

            {isExpanded && routes.map(route => (
                <SavedRouteCard
                    key={route.id}
                    route={route}
                    routeNumber={routeNumberMap?.get(route.id)}
                    repColor={route.assigned_to ? repColors[route.assigned_to] : '#666'}
                    isActive={activeRouteId === route.id}
                    onSelect={() => onSelectRoute(route)}
                    onDelete={() => onDeleteRoute && onDeleteRoute(route)}
                    logs={logs}
                    onReoptimize={onReoptimize}
                    routeConfig={routeConfig}
                    isSelected={selectedIds.has(route.id)}
                    onToggleSelect={() => onToggleSelect(route.id)}
                    isMultiSelect={isMultiSelect}
                />
            ))}
        </div>
    );
}

function SavedRouteCard({ route, routeNumber, repColor, isActive, onSelect, onDelete, logs = [], onReoptimize, routeConfig, isSelected, onToggleSelect, isMultiSelect }) {
    const [editing, setEditing] = useState(false);
    const [newName, setNewName] = useState(route.name);
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

    const handleRename = async () => {
        if (!newName.trim() || newName === route.name) { setEditing(false); return; }
        await base44.entities.SavedRoute.update(route.id, { name: newName.trim() });
        queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
        setEditing(false);
    };

    return (
        <div className={`relative group flex items-start gap-2 ${isSelected ? 'ring-2 ring-purple-500 rounded-xl' : ''}`}>
            {/* Multi-select checkbox */}
            {isMultiSelect && (
                <div className="flex items-center pt-4 pl-1 shrink-0" onClick={e => e.stopPropagation()}>
                    <Checkbox
                        checked={isSelected}
                        onCheckedChange={onToggleSelect}
                        className="border-gray-600 data-[state=checked]:bg-purple-600 data-[state=checked]:border-purple-600"
                    />
                </div>
            )}

            <div className="flex-1 min-w-0">
                <div
                    onClick={isMultiSelect ? onToggleSelect : onSelect}
                    role="button"
                    tabIndex={0}
                    className="w-full p-3 rounded-xl border transition-all text-left hover:border-gray-600 cursor-pointer"
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
                                    {routeNumber && (
                                        <span className="shrink-0 w-6 h-6 rounded-md bg-white/10 border border-white/20 flex items-center justify-center text-[11px] font-bold text-yellow-400">
                                            {routeNumber}
                                        </span>
                                    )}
                                    <span className="font-bold text-sm text-white truncate">{route.name}</span>
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
                </div>
                {!isMultiSelect && onDelete && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onDelete(); }}
                        className="absolute top-2 right-2 p-1.5 bg-red-500/20 hover:bg-red-500/40 text-red-500 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete Route"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                )}
                {!isMultiSelect && onReoptimize && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onReoptimize(route); }}
                        className="absolute top-2 right-10 p-1.5 bg-blue-500/20 hover:bg-blue-500/40 text-blue-400 rounded opacity-0 group-hover:opacity-100 transition-opacity"
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