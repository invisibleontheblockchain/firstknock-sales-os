import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Navigation, Locate, List, X, Filter, MapPin, Zap, Eye, EyeOff, Save, Pencil, Check } from 'lucide-react';
import { LayoutDashboard, Settings } from 'lucide-react';
import { toast } from "sonner";
import DataStatusIndicator from './DataStatusIndicator';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from "@tanstack/react-query";

/**
 * MapToolbar — extracted from Home.jsx
 * Renders all the floating UI overlays on top of the map:
 * - Top bar (dashboard/settings buttons, mode toggle, filter button)
 * - Active route banner
 * - Bottom action bar (generate, routes, checklist)
 * - Right-side floating buttons (locate, center on territory)
 */
export default function MapToolbar({
    // Mode & state
    mode, setMode,
    activeRoute, setActiveRoute,
    routesGenerating,

    // Panel toggles
    setShowDashboard,
    setShowMapSettings,
    setShowCompare,
    setShowRoutePanel,
    setShowChecklist,

    // Data
    teamMembers,
    hydratedSavedRoutes,
    routes,
    filteredRoutes,
    fitBounds,
    repColors,
    user,

    // Map ref
    mapRef,
    setUserLocation,

    // Actions
    handleAssignRoute,

    // Brand
    BRAND,

    // Route Filters
    activeRouteSoldFilter, setActiveRouteSoldFilter,
    activeRoutePhaseFilter, setActiveRoutePhaseFilter,
    activeRoutePriceFilter, setActiveRoutePriceFilter,

    // Drawing state
    drawnPolygon,

    // Route Visibility
    showRouteDetails,
    setShowRouteDetails,
    showRouteLines,
    setShowRouteLines,

    // Filter Saving
    onSaveFilteredRoute,
    
    // Route Optimization
    onReoptimizeRoute,

    // MLS data flag
    hasMlsData,
}) {
    const queryClient = useQueryClient();
    const hasDrawnArea = drawnPolygon && drawnPolygon.length > 2;

    // Track whether data has been pulled for the current drawn territory
    const [territoryDataReady, setTerritoryDataReady] = useState(false);

    // Reset when polygon changes (new territory drawn)
    useEffect(() => {
        setTerritoryDataReady(false);
    }, [drawnPolygon]);

    // Listen for pull-complete signal from TerritoryPrompt
    useEffect(() => {
        const handler = () => setTerritoryDataReady(true);
        window.addEventListener('fk-territory-data-ready', handler);
        return () => window.removeEventListener('fk-territory-data-ready', handler);
    }, []);

    // Inline route name editing state
    const [editingName, setEditingName] = useState(false);
    const [draftName, setDraftName] = useState('');

    const handleStartRename = (e) => {
        e.stopPropagation();
        setDraftName(activeRoute?.name || '');
        setEditingName(true);
    };

    const handleSaveRename = async () => {
        if (!draftName.trim() || draftName === activeRoute?.name) {
            setEditingName(false);
            return;
        }
        try {
            await base44.entities.SavedRoute.update(activeRoute.id, { name: draftName.trim() });
            queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
            // Update local active route state immediately
            if (setActiveRoute) {
                setActiveRoute(prev => prev ? { ...prev, name: draftName.trim() } : prev);
            }
            setEditingName(false);
        } catch (e) {
            toast.error("Failed to rename route");
        }
    };

    const handleSaveVisibleFilteredRoute = async () => {
        if (!activeRoute?.properties?.length || !user?.id) return;
        const filterLabels = [];
        if (activeRouteSoldFilter !== 'all') filterLabels.push(`${activeRouteSoldFilter}M`);
        if (activeRoutePhaseFilter !== 'all') filterLabels.push(activeRoutePhaseFilter);
        if (activeRoutePriceFilter !== 'all') filterLabels.push(`$${Number(activeRoutePriceFilter).toLocaleString()}+`);

        const routeName = `${activeRoute.name || 'Route'} (${filterLabels.join(', ') || 'Filtered'} Filter)`;
        await base44.entities.SavedRoute.create({
            name: routeName,
            property_hashes: activeRoute.properties.map(p => p.address_hash || p.id).filter(Boolean),
            metrics: {
                distance: activeRoute.totalDistance || activeRoute.metrics?.distance || 0,
                house_count: activeRoute.properties.length,
                score: activeRoute.competitivenessScore || activeRoute.metrics?.score || 0
            },
            status: 'ACTIVE',
            assigned_to: activeRoute.assigned_to || user.id,
            assigned_to_name: activeRoute.assigned_to_name || user.full_name || 'Me',
            manager_id: user.id
        });
        queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
        setActiveRoute(prev => prev ? { ...prev, name: routeName } : prev);
        setActiveRouteSoldFilter?.('all');
        setActiveRoutePhaseFilter?.('all');
        setActiveRoutePriceFilter?.('all');
        toast.success('Filtered route saved');
    };

    return (
        <>
            {/* Top Stats Bar */}
            <div className="absolute top-1 left-1 right-1 sm:top-4 sm:left-4 sm:right-4 z-[1000] flex flex-col gap-1.5 sm:gap-2 pointer-events-none">
                <div className="relative flex flex-nowrap items-center justify-between gap-1 sm:gap-2 w-full">
                    {/* DASHBOARD & SETTINGS TOGGLES */}
                    <div className="pointer-events-auto shrink-0 flex gap-1 sm:gap-2">
                        <Button
                            onClick={() => setShowDashboard(true)}
                            className="bg-black/80 hover:bg-black backdrop-blur-md border border-gray-800 shadow-xl h-8 sm:h-11 rounded-lg sm:rounded-xl px-2 sm:px-3 flex items-center gap-1.5 sm:gap-2"
                        >
                            <LayoutDashboard className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-yellow-500" />
                            <span className="text-[10px] sm:text-xs font-bold text-white hidden sm:inline">COMMAND CENTER</span>
                        </Button>
                        <Button
                            onClick={() => setShowMapSettings(true)}
                            size="icon"
                            className="bg-black/80 hover:bg-black backdrop-blur-md border border-gray-800 shadow-xl h-8 w-8 sm:h-11 sm:w-11 rounded-lg sm:rounded-xl"
                        >
                            <Settings className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-gray-400" />
                        </Button>
                    </div>

                    {/* MODE TOGGLE - Absolutely centered */}
                    <div className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/80 backdrop-blur-md rounded-lg sm:rounded-xl p-0.5 sm:p-1 border border-gray-800 flex gap-0.5 shadow-xl">
                        <button
                            onClick={() => { setMode('analyze'); }}
                            className={`px-2 py-1.5 sm:px-4 sm:py-2.5 rounded-md sm:rounded-lg text-[9px] sm:text-xs font-bold transition-all whitespace-nowrap ${mode === 'analyze' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}
                        >
                            ROUTES
                        </button>
                        <button
                            onClick={() => {
                                if (activeRoute) {
                                    toast.error("Close the active route first");
                                    return;
                                }
                                setMode('generate');
                                setShowRoutePanel(false);
                                setShowCompare(false);
                            }}
                            className={`px-2 py-1.5 sm:px-4 sm:py-2.5 rounded-md sm:rounded-lg text-[9px] sm:text-xs font-bold transition-all whitespace-nowrap ${mode === 'generate' ? 'bg-yellow-500 text-black shadow-lg' : activeRoute ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-white'}`}
                        >
                            BUILDER
                        </button>
                    </div>

                    {/* DATA STATUS + FILTER BUTTON */}
                    <div className="pointer-events-auto shrink-0 flex items-center gap-1 sm:gap-2">
                        <DataStatusIndicator user={user} />
                        <Button
                            onClick={() => {
                                const newVal = !showRouteDetails;
                                setShowRouteDetails(newVal);
                                setShowRouteLines(newVal);
                                toast.success(newVal ? "Routes Visible" : "Routes Hidden");
                            }}
                            size="icon"
                            className={`bg-black/80 hover:bg-black backdrop-blur-md border shadow-xl h-8 w-8 sm:h-11 sm:w-11 rounded-lg sm:rounded-xl transition-all ${(!showRouteDetails && !showRouteLines) ? 'border-red-500/50' : 'border-gray-800'}`}
                        >
                            {(!showRouteDetails && !showRouteLines) ? (
                                <EyeOff className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-red-500" />
                            ) : (
                                <Eye className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-blue-400" />
                            )}
                        </Button>
                        <Button
                            onClick={() => {
                                if (mode === 'generate' && (!hasDrawnArea || !territoryDataReady)) {
                                    toast.info(hasDrawnArea ? "Pull property data before opening the builder." : "Draw a custom area first.");
                                    return;
                                }
                                setShowCompare(true);
                            }}
                            size="icon"
                            className="bg-black/80 hover:bg-black backdrop-blur-md rounded-lg sm:rounded-xl h-8 w-8 sm:h-11 sm:w-11 font-bold shadow-xl border border-yellow-500/40"
                        >
                            {mode === 'generate' ? <Settings className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-yellow-500" /> : <Filter className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-yellow-500" />}
                        </Button>
                    </div>
                </div>

                {/* Active Route Banner */}
                {activeRoute && (
                    <div className="pointer-events-auto rounded-xl px-2 py-1.5 md:px-3 md:py-2 shadow-2xl border border-yellow-600/30 animate-in slide-in-from-top-2 backdrop-blur-md" style={{ background: 'rgba(10,10,10,0.95)' }}>
                        {/* Row 1: Name + Actions — always horizontal */}
                        <div className="flex items-center gap-1.5 min-w-0">
                            <div className="w-5 h-5 md:w-6 md:h-6 rounded-full flex items-center justify-center shrink-0" style={{ background: BRAND.gold }}>
                                <Navigation className="w-2.5 h-2.5 md:w-3 md:h-3" style={{ color: BRAND.voidBlack }} />
                            </div>

                            {editingName ? (
                                <div className="flex items-center gap-1 flex-1 min-w-0" onClick={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}>
                                    <input value={draftName} onChange={e => setDraftName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleSaveRename(); if (e.key === 'Escape') setEditingName(false); }} className="bg-black/60 border border-yellow-500/50 text-yellow-500 text-[11px] font-bold rounded px-1.5 py-0.5 flex-1 outline-none min-w-0" autoFocus />
                                    <button onClick={handleSaveRename} className="p-0.5 text-green-500"><Check className="w-3 h-3" /></button>
                                    <button onClick={() => setEditingName(false)} className="p-0.5 text-gray-500"><X className="w-3 h-3" /></button>
                                </div>
                            ) : (
                                <button onClick={handleStartRename} className="group/name flex items-center gap-1 min-w-0 shrink" title="Rename">
                                    <span className="text-[11px] md:text-xs font-bold truncate max-w-[90px] md:max-w-[160px]" style={{ color: BRAND.gold }}>{activeRoute.name}</span>
                                    <Pencil className="w-2.5 h-2.5 text-gray-600 opacity-0 group-hover/name:opacity-100 shrink-0" />
                                </button>
                            )}

                            {/* House count badge */}
                            <span className="text-[9px] md:text-[10px] font-mono text-gray-500 shrink-0">{activeRoute.houseCount || activeRoute.properties?.length || 0}h</span>

                            <div className="ml-auto flex items-center gap-1 shrink-0">
                                <button onClick={(e) => { e.stopPropagation(); if (onReoptimizeRoute) onReoptimizeRoute(activeRoute); }} className="h-5 md:h-6 px-1.5 md:px-2 text-[9px] md:text-[10px] font-bold bg-yellow-500 hover:bg-yellow-400 text-black rounded-md flex items-center gap-0.5" title="Optimize">
                                    <Zap className="w-2.5 h-2.5" /><span>OPTIMIZE</span>
                                </button>
                                <button onClick={() => { setActiveRoute(null); if (mapRef.current) { try { if (mapRef.current._mapPane) mapRef.current.setZoom(Math.max(13, mapRef.current.getZoom() - 2)); } catch (e) { } } }} className="flex items-center gap-0.5 h-5 md:h-6 px-1.5 md:px-2 rounded-md border border-white/10 text-[9px] md:text-[10px] font-bold text-gray-400 hover:text-white hover:bg-white/10 shrink-0">
                                    <X className="w-2.5 h-2.5" /><span className="hidden sm:inline">CLOSE</span>
                                </button>
                            </div>
                        </div>

                        {/* Row 2: Filters — scrollable grid on mobile, inline on desktop */}
                        <div className="flex items-center gap-1 md:gap-1.5 mt-1.5 overflow-x-auto scrollbar-hide pb-0.5 -mx-0.5 px-0.5" onClick={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}>
                            <select value={activeRoute.assigned_to || ""} onChange={(e) => { e.stopPropagation(); handleAssignRoute(activeRoute.id, e.target.value); }} onPointerDown={(e) => e.stopPropagation()} className="text-[10px] md:text-[11px] font-medium bg-white/5 border border-white/10 rounded-md px-1 md:px-1.5 py-0.5 outline-none cursor-pointer hover:bg-white/10 shrink-0" style={{ color: '#ccc', WebkitAppearance: 'menulist' }}>
                                <option value="">Assign</option>
                                <option value={user?.id || 'manager'}>Me</option>
                                {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>

                            {setActiveRouteSoldFilter && (
                                <select value={activeRouteSoldFilter} onChange={(e) => { e.stopPropagation(); setActiveRouteSoldFilter(e.target.value); }} onPointerDown={(e) => e.stopPropagation()} className="text-[10px] md:text-[11px] font-medium bg-white/5 border border-white/10 rounded-md px-1 md:px-1.5 py-0.5 outline-none cursor-pointer hover:bg-white/10 shrink-0" style={{ color: '#ccc', WebkitAppearance: 'menulist' }}>
                                    <option value="all">Dates</option>
                                    <option value="0.25">1W</option>
                                    <option value="0.5">2W</option>
                                    <option value="1">1M</option>
                                    <option value="3">3M</option>
                                    <option value="6">6M</option>
                                    <option value="12">1Y</option>
                                </select>
                            )}

                            {setActiveRoutePhaseFilter && hasMlsData && (
                                <select value={activeRoutePhaseFilter} onChange={(e) => { e.stopPropagation(); setActiveRoutePhaseFilter(e.target.value); }} onPointerDown={(e) => e.stopPropagation()} className="text-[10px] md:text-[11px] font-medium bg-white/5 border border-purple-500/30 rounded-md px-1 md:px-1.5 py-0.5 outline-none cursor-pointer hover:bg-white/10 shrink-0" style={{ color: '#c4b5fd', WebkitAppearance: 'menulist' }}>
                                    <option value="all">Phase</option>
                                    <option value="deeds">P1 Deeds</option>
                                    <option value="listings">P2 MLS</option>
                                </select>
                            )}

                            {setActiveRoutePriceFilter && (
                                <select value={activeRoutePriceFilter} onChange={(e) => { e.stopPropagation(); setActiveRoutePriceFilter(e.target.value); }} onPointerDown={(e) => e.stopPropagation()} className="text-[10px] md:text-[11px] font-medium bg-white/5 border border-green-500/30 rounded-md px-1 md:px-1.5 py-0.5 outline-none cursor-pointer hover:bg-white/10 shrink-0" style={{ color: '#86efac', WebkitAppearance: 'menulist' }}>
                                    <option value="all">Price</option>
                                    <option value="50000">&gt;$50K</option>
                                    <option value="100000">&gt;$100K</option>
                                    <option value="200000">&gt;$200K</option>
                                    <option value="300000">&gt;$300K</option>
                                    <option value="500000">&gt;$500K</option>
                                    <option value="750000">&gt;$750K</option>
                                    <option value="1000000">&gt;$1M</option>
                                </select>
                            )}

                            {(activeRouteSoldFilter !== 'all' || activeRoutePhaseFilter !== 'all' || activeRoutePriceFilter !== 'all') && onSaveFilteredRoute && (
                                <button onClick={(e) => { e.stopPropagation(); handleSaveVisibleFilteredRoute(); }} className="h-5 md:h-6 px-1.5 md:px-2 text-[9px] md:text-[10px] font-bold bg-blue-600 hover:bg-blue-500 text-white rounded-md flex items-center gap-0.5 shrink-0">
                                    <Save className="w-2.5 h-2.5" /> SAVE
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Team Analysis Legend (Top Right) - Hidden on mobile */}
            {!activeRoute && (
                <div className="hidden md:block absolute top-20 right-4 z-[900] pointer-events-auto bg-black/80 backdrop-blur-md border border-gray-800 rounded-xl p-3 max-w-[200px] animate-in slide-in-from-right">
                    <p className="text-[10px] font-bold text-gray-400 mb-2 uppercase">Team Analysis</p>
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                        {teamMembers.map(member => {
                            const memberRoutes = hydratedSavedRoutes.filter(r => r.assigned_to === member.id);
                            if (memberRoutes.length === 0) return null;
                            return (
                                <div key={member.id} className="flex items-center justify-between text-xs">
                                    <div className="flex items-center gap-2">
                                        <span className="w-2 h-2 rounded-full" style={{ background: repColors[member.id] }} />
                                        <span className="text-white truncate max-w-[80px]">{member.name}</span>
                                    </div>
                                    <span className="text-gray-500">{memberRoutes.length} Rts</span>
                                </div>
                            );
                        })}
                        <div className="flex items-center justify-between text-xs opacity-50">
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#666]" />
                                <span className="text-white">Unassigned</span>
                            </div>
                            <span className="text-gray-500">{hydratedSavedRoutes.filter(r => !r.assigned_to).length}</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Right side floating buttons - GPS + Locate */}
            <div className="absolute bottom-2 right-1 sm:bottom-6 sm:right-4 z-[1000] pointer-events-auto flex flex-col gap-1.5 sm:gap-2 items-end">
                <Button
                    onClick={(e) => {
                        e.stopPropagation();
                        if (!navigator.geolocation) {
                            toast.error("Geolocation is not supported by this browser.");
                            return;
                        }
                        const toastId = toast.loading("Getting your location...");

                        const tryLocate = (highAccuracy) => {
                            navigator.geolocation.getCurrentPosition(
                                (position) => {
                                    const { latitude, longitude, accuracy } = position.coords;
                                    setUserLocation({ lat: latitude, lng: longitude });
                                    if (mapRef.current) {
                                        try { mapRef.current.setView([latitude, longitude], 18); } catch (err) { }
                                    }
                                    toast.success(`Location found (±${Math.round(accuracy)}m)`, { id: toastId });
                                },
                                (error) => {
                                    if (highAccuracy) {
                                        tryLocate(false);
                                    } else {
                                        const messages = {
                                            1: "Location permission denied. Enable location in settings.",
                                            2: "Location unavailable. Turn on GPS/Location Services.",
                                            3: "Location timed out. Try again."
                                        };
                                        toast.error(messages[error.code] || `Location error: ${error.message}`, { id: toastId, duration: 5000 });
                                    }
                                },
                                { enableHighAccuracy: highAccuracy, timeout: highAccuracy ? 8000 : 15000, maximumAge: 30000 }
                            );
                        };
                        tryLocate(true);
                    }}
                    size="icon"
                    className="rounded-full w-9 h-9 sm:w-10 sm:h-10 shadow-2xl backdrop-blur-md border border-blue-500/50 hover:bg-[#333]"
                    style={{ background: 'rgba(31, 31, 31, 0.9)', color: '#3b82f6' }}
                >
                    <Locate className="w-4 h-4 sm:w-5 sm:h-5" />
                </Button>

                {(fitBounds && fitBounds.length > 0) && (
                    <Button
                        onClick={(e) => {
                            e.stopPropagation();
                            if (mapRef.current && fitBounds && fitBounds.length > 0) {
                                try { if (mapRef.current._mapPane) mapRef.current.fitBounds(fitBounds, { padding: [30, 30], maxZoom: 17 }); } catch (e) { }
                                toast.success("Centered on Territory");
                            }
                        }}
                        size="icon"
                        className="rounded-full w-9 h-9 sm:w-10 sm:h-10 shadow-2xl backdrop-blur-md"
                        style={{ background: 'rgba(31, 31, 31, 0.9)', color: BRAND.gold, border: `1px solid ${BRAND.gold}40` }}
                    >
                        <MapPin className="w-4 h-4" />
                    </Button>
                )}
            </div>

            {/* Bottom Action Bar */}
            <div className="absolute bottom-4 sm:bottom-6 left-0 right-0 z-[1000] pointer-events-none flex justify-center px-2">
                <div className="pointer-events-auto flex items-center justify-center gap-2 bg-black/80 backdrop-blur-lg p-1.5 rounded-full border border-white/10 shadow-2xl">
                    {mode === 'generate' && !activeRoute && (
                        <Button
                            onClick={() => {
                                if (hasDrawnArea) {
                                    if (!territoryDataReady) {
                                        toast.error("Pull property data first!", { duration: 4000 });
                                        return;
                                    }
                                    setShowCompare(true);
                                } else {
                                    setShowCompare(false);
                                    window.dispatchEvent(new CustomEvent('fk-start-drawing'));
                                }
                            }}
                            disabled={routesGenerating || (hasDrawnArea && !territoryDataReady)}
                            className={`rounded-full h-10 px-4 text-xs font-bold tracking-wide shadow-[0_0_20px_rgba(255,215,0,0.3)] transition-all active:scale-95 whitespace-nowrap ${hasDrawnArea && !territoryDataReady ? 'opacity-50' : ''}`}
                            style={{ background: 'linear-gradient(135deg, #FFD700 0%, #F59E0B 100%)', color: BRAND.voidBlack }}
                        >
                            {routesGenerating ? (
                                <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> BUILDING</>  
                            ) : hasDrawnArea ? (
                                territoryDataReady ? (
                                    <><Zap className="w-4 h-4 mr-1.5" /> GENERATE</>  
                                ) : (
                                    <><Zap className="w-4 h-4 mr-1.5" /> PULL DATA</>  
                                )
                            ) : (
                                <><Navigation className="w-4 h-4 mr-1.5" /> DRAW</>  
                            )}
                        </Button>
                    )}

                    <Button
                        onClick={() => !activeRoute && setShowRoutePanel(true)}
                        disabled={!!activeRoute}
                        className={`rounded-full h-10 px-4 text-xs font-bold tracking-wide shadow-lg transition-all active:scale-95 whitespace-nowrap ${activeRoute ? 'opacity-50 cursor-not-allowed' : ''}`}
                        style={{
                            background: activeRoute ? 'rgba(31, 31, 31, 0.9)' : (mode === 'generate' && !activeRoute ? 'rgba(31, 31, 31, 0.9)' : 'linear-gradient(135deg, #FFD700 0%, #F59E0B 100%)'),
                            color: activeRoute ? BRAND.gold : (mode === 'generate' && !activeRoute ? BRAND.gold : BRAND.voidBlack),
                            border: activeRoute ? `1px solid ${BRAND.gold}` : (mode === 'generate' && !activeRoute ? `1px solid ${BRAND.gold}` : 'none')
                        }}
                    >
                        <List className="w-4 h-4 mr-1.5" />
                        ROUTES
                        {!routesGenerating && (hydratedSavedRoutes.length > 0 || routes.length > 0) && (
                            <Badge className="ml-1.5 h-5 min-w-[20px] px-1.5 text-[10px]" style={{ background: BRAND.voidBlack, color: BRAND.gold }}>
                                {hydratedSavedRoutes.length > 0 ? hydratedSavedRoutes.length : routes.length}
                            </Badge>
                        )}
                    </Button>

                    {activeRoute && (
                        <Button
                            onClick={() => setShowChecklist(true)}
                            className="rounded-full h-10 px-4 text-xs font-bold tracking-wide shadow-lg backdrop-blur-md transition-all active:scale-95 whitespace-nowrap"
                            style={{ background: 'rgba(31, 31, 31, 0.9)', color: BRAND.gold, border: `1px solid ${BRAND.gold}` }}
                        >
                            <List className="w-4 h-4 mr-1.5" />
                            CHECKLIST
                        </Button>
                    )}
                </div>
            </div>
        </>
    );
}