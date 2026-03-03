import React from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Navigation, Locate, List, X, Filter, MapPin, Zap } from 'lucide-react';
import { LayoutDashboard, Settings } from 'lucide-react';
import { toast } from "sonner";

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

    // Route Filter
    activeRouteSoldFilter,
    setActiveRouteSoldFilter,
}) {
    return (
        <>
            {/* Top Stats Bar */}
            <div className="absolute top-1 left-1 right-1 sm:top-4 sm:left-4 sm:right-4 z-[1000] flex flex-col gap-1.5 sm:gap-2 pointer-events-none">
                <div className="flex flex-nowrap items-center justify-between gap-1 sm:gap-2 w-full">
                    {/* DASHBOARD & SETTINGS TOGGLES */}
                    <div className="pointer-events-auto shrink-0 flex gap-1">
                        <Button
                            onClick={() => setShowDashboard(true)}
                            size="icon"
                            className="bg-black/80 hover:bg-black backdrop-blur-md border border-gray-800 shadow-xl h-8 w-8 sm:h-11 sm:w-11 rounded-lg sm:rounded-xl"
                        >
                            <LayoutDashboard className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-yellow-500" />
                        </Button>
                        <Button
                            onClick={() => setShowMapSettings(true)}
                            size="icon"
                            className="bg-black/80 hover:bg-black backdrop-blur-md border border-gray-800 shadow-xl h-8 w-8 sm:h-11 sm:w-11 rounded-lg sm:rounded-xl"
                        >
                            <Settings className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-gray-400" />
                        </Button>
                    </div>

                    {/* MODE TOGGLE - Centered */}
                    <div className="pointer-events-auto bg-black/80 backdrop-blur-md rounded-lg sm:rounded-xl p-0.5 sm:p-1 border border-gray-800 flex gap-0.5 shadow-xl shrink-0">
                        <button
                            onClick={() => setMode('analyze')}
                            className={`px-2 py-1.5 sm:px-4 sm:py-2.5 rounded-md sm:rounded-lg text-[9px] sm:text-xs font-bold transition-all whitespace-nowrap ${mode === 'analyze' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}
                        >
                            DISPATCH
                        </button>
                        <button
                            onClick={() => setMode('generate')}
                            className={`px-2 py-1.5 sm:px-4 sm:py-2.5 rounded-md sm:rounded-lg text-[9px] sm:text-xs font-bold transition-all whitespace-nowrap ${mode === 'generate' ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-400 hover:text-white'}`}
                        >
                            BUILDER
                        </button>
                    </div>

                    {/* FILTER / SETTINGS BUTTON */}
                    <div className="pointer-events-auto shrink-0">
                        <Button
                            onClick={() => setShowCompare(true)}
                            size="icon"
                            className="bg-black/80 hover:bg-black backdrop-blur-md rounded-lg sm:rounded-xl h-8 w-8 sm:h-11 sm:w-11 font-bold shadow-xl border border-yellow-500/40"
                        >
                            {mode === 'generate' ? <Settings className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-yellow-500" /> : <Filter className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-yellow-500" />}
                        </Button>
                    </div>
                </div>

                {/* Active Route Banner - Compact */}
                {activeRoute && (
                    <div className="pointer-events-auto rounded-full px-1 py-1 sm:px-1.5 sm:py-1.5 flex items-center gap-1 sm:gap-2 shadow-2xl border border-yellow-600/40 animate-in slide-in-from-top-2 backdrop-blur-md" style={{ background: 'rgba(10,10,10,0.92)' }}>
                        <div className="w-6 h-6 sm:w-8 sm:h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: BRAND.gold }}>
                            <Navigation className="w-3 h-3 sm:w-4 sm:h-4" style={{ color: BRAND.voidBlack }} />
                        </div>
                        <span className="text-[10px] sm:text-sm font-bold truncate flex-1 min-w-0 max-w-[60px] sm:max-w-[120px]" style={{ color: BRAND.gold }}>{activeRoute.name}</span>
                        <div onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} className="shrink-0 flex items-center gap-1">
                            {setActiveRouteSoldFilter && (
                                <select
                                    value={activeRouteSoldFilter}
                                    onChange={(e) => {
                                        e.stopPropagation();
                                        setActiveRouteSoldFilter(e.target.value);
                                    }}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    className="text-[9px] sm:text-xs font-medium bg-white/10 border border-white/10 rounded-full px-1.5 py-0.5 sm:px-3 sm:py-1.5 outline-none cursor-pointer hover:bg-white/15 transition-colors appearance-auto max-w-[70px] sm:max-w-none"
                                    style={{ color: '#ccc', WebkitAppearance: 'menulist' }}
                                >
                                    <option value="all">All Time</option>
                                    <option value="12">1 Year</option>
                                    <option value="24">2 Years</option>
                                    <option value="36">3 Years</option>
                                </select>
                            )}
                            <select
                                value={activeRoute.assigned_to || ""}
                                onChange={(e) => {
                                    e.stopPropagation();
                                    handleAssignRoute(activeRoute.id, e.target.value);
                                }}
                                onPointerDown={(e) => e.stopPropagation()}
                                className="text-[9px] sm:text-xs font-medium bg-white/10 border border-white/10 rounded-full px-1.5 py-0.5 sm:px-3 sm:py-1.5 outline-none cursor-pointer hover:bg-white/15 transition-colors appearance-auto max-w-[70px] sm:max-w-none"
                                style={{ color: '#ccc', WebkitAppearance: 'menulist' }}
                            >
                                <option value="">Unassigned</option>
                                <option value={user?.id || 'manager'}>Me</option>
                                {teamMembers.map(m => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                            </select>
                        </div>
                        <button
                            onClick={() => {
                                setActiveRoute(null);
                                if (mapRef.current) {
                                    try { if (mapRef.current._mapPane) mapRef.current.setZoom(Math.max(13, mapRef.current.getZoom() - 2)); } catch (e) { }
                                }
                            }}
                            className="w-6 h-6 sm:w-8 sm:h-8 flex items-center justify-center hover:bg-white/10 active:bg-white/15 rounded-full transition-colors shrink-0"
                        >
                            <X className="w-3 h-3 sm:w-4 sm:h-4 text-gray-400" />
                        </button>
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
            <div className="absolute bottom-1 sm:bottom-6 left-0 right-12 sm:right-auto md:left-4 z-[1000] pointer-events-none flex justify-center md:justify-start px-2 sm:px-4">
                <div className="pointer-events-auto flex items-center justify-center gap-1.5 sm:gap-2 bg-black/70 backdrop-blur-lg p-1.5 sm:p-2 rounded-full border border-white/10 shadow-2xl">
                    {mode === 'generate' && !activeRoute && (
                        <Button
                            onClick={() => setShowCompare(true)}
                            disabled={routesGenerating}
                            className="rounded-full h-9 px-3 sm:h-10 sm:px-5 text-[11px] sm:text-sm font-bold tracking-wide shadow-[0_0_20px_rgba(255,215,0,0.3)] hover:shadow-[0_0_30px_rgba(255,215,0,0.5)] transition-all duration-300 transform active:scale-95 whitespace-nowrap"
                            style={{ background: 'linear-gradient(135deg, #FFD700 0%, #F59E0B 100%)', color: BRAND.voidBlack }}
                        >
                            {routesGenerating ? (
                                <><Loader2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-1 animate-spin" /> BUILDING</>
                            ) : (
                                <><Zap className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-1" /> GENERATE</>
                            )}
                        </Button>
                    )}

                    <Button
                        onClick={() => setShowRoutePanel(true)}
                        className="rounded-full h-9 px-3 sm:h-10 sm:px-5 text-[11px] sm:text-sm font-bold tracking-wide shadow-lg transition-all duration-300 transform active:scale-95 whitespace-nowrap"
                        style={{
                            background: mode === 'generate' && !activeRoute ? 'rgba(31, 31, 31, 0.9)' : 'linear-gradient(135deg, #FFD700 0%, #F59E0B 100%)',
                            color: mode === 'generate' && !activeRoute ? BRAND.gold : BRAND.voidBlack,
                            border: mode === 'generate' && !activeRoute ? `1px solid ${BRAND.gold}` : 'none'
                        }}
                    >
                        <List className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-1 sm:mr-2" />
                        ROUTES
                        {!routesGenerating && (hydratedSavedRoutes.length > 0 || routes.length > 0) && (
                            <Badge className="ml-1 sm:ml-2 h-5 min-w-[20px] px-1.5 text-[10px]" style={{ background: BRAND.voidBlack, color: BRAND.gold }}>
                                {hydratedSavedRoutes.length > 0 ? hydratedSavedRoutes.length : routes.length}
                            </Badge>
                        )}
                    </Button>

                    {activeRoute && (
                        <Button
                            onClick={() => setShowChecklist(true)}
                            className="rounded-full h-9 px-3 sm:h-10 sm:px-5 text-[11px] sm:text-sm font-bold tracking-wide shadow-lg backdrop-blur-md transition-all duration-300 transform active:scale-95 whitespace-nowrap"
                            style={{ background: 'rgba(31, 31, 31, 0.9)', color: BRAND.gold, border: `1px solid ${BRAND.gold}` }}
                        >
                            <List className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-1 sm:mr-2" />
                            CHECKLIST
                        </Button>
                    )}
                </div>
            </div>
        </>
    );
}