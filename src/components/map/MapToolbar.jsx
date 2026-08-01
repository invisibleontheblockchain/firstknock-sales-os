import React, { useCallback, useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Navigation, Locate, List, X, Filter, MapPin, Zap, Eye, EyeOff, Save, Pencil, Check, RotateCcw, Download, MoreVertical, Scissors, Ghost, Flag } from 'lucide-react';
import { LayoutDashboard, Settings } from 'lucide-react';
import { toast } from "sonner";
import DataStatusIndicator from './DataStatusIndicator';
import SplitRouteModal from '@/components/routes/SplitRouteModal';
import RouteAnchorsDialog from '@/components/routes/RouteAnchorsDialog';
import { exportRouteToCsv } from '@/components/routes/exportRouteCsv';
import { FOLLOW_UP_STATUSES, getRouteOutcomeStats, getRerunHashes, getRerunProperties, buildRerunRoutePayload } from '@/components/routes/routeRerunUtils';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from "@tanstack/react-query";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { OptimizeRouteChoices, OptimizeRouteTrigger } from './OptimizeRouteInline';
import { routeBelongsToActingUser } from '@/lib/routeOptimizeUpdate';

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
  onRequestRouteModeChange,
  onConfirmCanvasDiscard,
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
  activeRoutePriceFilter, setActiveRoutePriceFilter,

  // Drawing state
  drawnPolygon,
  drawingMode = false,

  // Route Visibility
  showRouteDetails,
  setShowRouteDetails,
  showRouteLines,
  setShowRouteLines,
  routeStatusView,
  setRouteStatusView,

  // Filter Saving
  onSaveFilteredRoute,

  // Route Optimization
  onReoptimizeRoute,
  startLocation,

  // MLS data flag
  hasMlsData,
  logs = []
}) {
  const queryClient = useQueryClient();
  const hasDrawnArea = drawnPolygon && drawnPolygon.length > 2;
  const routeSelectClass = "h-6 md:h-7 text-[10px] md:text-[11px] font-extrabold rounded-lg px-2 md:px-2.5 outline-none cursor-pointer shrink-0 bg-[#050505]/95 border border-white/15 text-white shadow-[0_8px_24px_rgba(0,0,0,0.35)] hover:border-[#2EEB57]/50 hover:bg-[#0D0D0D] focus:border-[#2EEB57] focus:ring-2 focus:ring-[#2EEB57]/20 transition-all";
  const routeSelectAccentClass = `${routeSelectClass} border-[#2EEB57]/35 text-[#86efac]`;
  const routeSelectStyle = { backgroundColor: '#050505', color: '#F9FAFB', colorScheme: 'dark', WebkitAppearance: 'menulist' };
  const routeSelectAccentStyle = { ...routeSelectStyle, color: '#86efac' };
  const routeOptionStyle = { backgroundColor: '#050505', color: '#F9FAFB' };
  const routeOptionAccentStyle = { backgroundColor: '#050505', color: '#86efac' };
  const [routeMode, setRouteMode] = useState(() => {
    try {return localStorage.getItem('fk_routeMode') || 'precision';} catch {return 'precision';}
  });
  const [showGhostAreas, setShowGhostAreas] = useState(() => {
    try {return localStorage.getItem('fk_showGhostAreas') === 'true';} catch {return false;}
  });

  const allowCanvasDiscard = useCallback((action) => routeMode !== 'canvas'
    || typeof onConfirmCanvasDiscard !== 'function'
    || onConfirmCanvasDiscard(action), [onConfirmCanvasDiscard, routeMode]);

  const updateRouteMode = (nextMode) => {
    if (typeof onRequestRouteModeChange === 'function' && onRequestRouteModeChange(nextMode) === false) return;
    setRouteMode(nextMode);
    try {localStorage.setItem('fk_routeMode', nextMode);} catch {}
    window.dispatchEvent(new CustomEvent('fk-route-mode-changed', { detail: { routeMode: nextMode } }));
    toast.success(`${nextMode === 'canvas' ? 'Canvas' : 'Precision'} mode active`);
  };

  useEffect(() => {
    const handler = (event) => {
      const nextMode = event.detail?.routeMode;
      if (nextMode === 'canvas' || nextMode === 'precision') setRouteMode(nextMode);
    };
    window.addEventListener('fk-route-mode-changed', handler);
    return () => window.removeEventListener('fk-route-mode-changed', handler);
  }, []);

  const openCanvasPlannerView = (view) => {
    setMode('generate');
    setShowRoutePanel(false);
    setShowCompare(true);
    try { sessionStorage.setItem('fk_canvasPlannerView', view); } catch {}
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('fk-canvas-planner-view-requested', {
        detail: { view, startNew: view === 'new_area' },
      }));
    }, 0);
  };

  const toggleGhostAreas = () => {
    const next = !showGhostAreas;
    setShowGhostAreas(next);
    try {localStorage.setItem('fk_showGhostAreas', String(next));} catch {}
    if (next) {
      setShowCompare(false);
      setShowRoutePanel(false);
    }
    window.dispatchEvent(new CustomEvent('fk-ghost-areas-visibility', { detail: { visible: next } }));
    toast.success(next ? 'Previous Precision areas visible' : 'Previous areas hidden');
  };

  // Bottom Map tab should return to plain map view and close Builder/Route Command.
  useEffect(() => {
    const handler = () => {
      if (!allowCanvasDiscard('Opening the map view')) return;
      setMode('analyze');
      setShowCompare(false);
      setShowRoutePanel(false);
    };
    window.addEventListener('fk-map-tab-open', handler);
    return () => window.removeEventListener('fk-map-tab-open', handler);
  }, [allowCanvasDiscard, setMode, setShowCompare, setShowRoutePanel]);

  useEffect(() => {
    if (!activeRoute?.id) return;
    try {localStorage.setItem('fk_selectedKnockRouteId', activeRoute.id);} catch {}
  }, [activeRoute?.id]);

  useEffect(() => {
    const handler = (event) => setShowGhostAreas(!!event.detail?.visible);
    window.addEventListener('fk-ghost-areas-visibility', handler);
    return () => window.removeEventListener('fk-ghost-areas-visibility', handler);
  }, []);

  // Inline route name editing state
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [showSplitRouteModal, setShowSplitRouteModal] = useState(false);
  const [showAnchorsDialog, setShowAnchorsDialog] = useState(false);
  const [showRerunMenu, setShowRerunMenu] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);

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
        setActiveRoute((prev) => prev ? { ...prev, name: draftName.trim() } : prev);
      }
      setEditingName(false);
    } catch (e) {
      toast.error("Failed to rename route");
    }
  };

  const resetActiveRouteFilters = (e) => {
    e?.stopPropagation?.();
    setActiveRouteSoldFilter?.('all');
    setActiveRoutePriceFilter?.('all');
    toast.success('Filters reset');
  };

  const handleExportActiveRouteCsv = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    const count = exportRouteToCsv(activeRoute);
    if (count > 0) toast.success(`Exported ${count} route stops`);
    else toast.error('No route stops to export');
  };

  const handleSplitRoutesCreated = async (count) => {
    queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
    toast.success(`Created ${count} split route batches`);
  };

  const handleSaveVisibleFilteredRoute = async () => {
    if (!activeRoute?.properties?.length || !user?.id) return;
    const filterLabels = [];
    if (activeRouteSoldFilter !== 'all') filterLabels.push(`${activeRouteSoldFilter}M`);
    if (activeRoutePriceFilter !== 'all') filterLabels.push(`$${Number(activeRoutePriceFilter).toLocaleString()}+`);

    const routeName = `${activeRoute.name || 'Route'} (${filterLabels.join(', ') || 'Filtered'} Filter)`;
    await base44.entities.SavedRoute.create({
      name: routeName,
      property_hashes: activeRoute.properties.map((p) => p.address_hash || p.id).filter(Boolean),
      metrics: {
        distance: 0,
        house_count: activeRoute.properties.length,
        score: activeRoute.competitivenessScore || activeRoute.metrics?.score || 0
      },
      status: 'ACTIVE',
      route_origin_mode: 'none',
      assigned_to: activeRoute.assigned_to || user.id,
      assigned_to_name: activeRoute.assigned_to_name || user.full_name || 'Me',
      manager_id: user.id
    });
    queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
    setActiveRoute((prev) => prev ? { ...prev, name: routeName } : prev);
    setActiveRouteSoldFilter?.('all');
    setActiveRoutePriceFilter?.('all');
    toast.success('Filtered route saved');
  };

  const [showOptimizeMenu, setShowOptimizeMenu] = useState(false);
  const [reoptimizeBusy, setReoptimizeBusy] = useState(false);

  const toggleOptimizeMenu = useCallback(() => setShowOptimizeMenu(open => !open), []);

  // Switching routes must not leave the previous route's choices expanded.
  useEffect(() => { setShowOptimizeMenu(false); }, [activeRoute?.id]);
  useEffect(() => { setShowAnchorsDialog(false); }, [activeRoute?.id]);

  // ANCHORS runs through the same single-route action as Optimize, so the doors
  // are reordered around the chosen start/finish in one step.
  const handleApplyRouteAnchors = useCallback(async (anchors) => {
    window.__fkSuppressMapFitUntil = Date.now() + 1500;
    if (!onReoptimizeRoute) return;
    await onReoptimizeRoute(activeRoute, { anchors });
  }, [activeRoute, onReoptimizeRoute]);

  // "My Car" uses THIS device's GPS, so it is only meaningful for the person
  // holding the phone. A manager viewing a rep's route must never anchor it to
  // where the manager parked. Home Base has a server-side lookup for the
  // assignee; a parked car has no such source of truth, so this is stricter.
  // One shared predicate with the handler in Home.jsx: assigned_to may hold a
  // User id OR a TeamMember id linked by user_id or email, so a plain user.id
  // comparison disables the control for the very rep who should have it.
  const routeIsOptimizableFromCar = React.useMemo(
    () => routeBelongsToActingUser(activeRoute, user, teamMembers),
    [activeRoute, user, teamMembers]
  );

  const handleSelectOptimizeMode = useCallback(async (mode) => {
    window.__fkSuppressMapFitUntil = Date.now() + 1500;
    if (!onReoptimizeRoute || reoptimizeBusy) return;
    setShowOptimizeMenu(false);
    setReoptimizeBusy(true);
    try { await onReoptimizeRoute(activeRoute, { mode }); }
    finally { setReoptimizeBusy(false); }
  }, [activeRoute, onReoptimizeRoute, reoptimizeBusy]);

  const isCompletedRoute = activeRoute?.status === 'COMPLETED';
  const completedOutcomeStats = React.useMemo(() => getRouteOutcomeStats(activeRoute, logs), [activeRoute, logs]);
  const rerunOptions = [
    { filter: 'all', label: 'All Doors', count: completedOutcomeStats.total },
    { filter: 'no_answer', label: 'No Answer', count: completedOutcomeStats.byStatus.NO_ANSWER },
    { filter: 'callbacks', label: 'Callbacks', count: completedOutcomeStats.byStatus.CALLBACK },
    { filter: 'unsold', label: 'Unsold Follow-Up', count: completedOutcomeStats.routeHashes.filter(hash => !completedOutcomeStats.latestByHash.get(hash) || FOLLOW_UP_STATUSES.has(completedOutcomeStats.latestByHash.get(hash))).length }
  ];

  const handleRerunCompletedRoute = async (filter, label) => {
    if (rerunBusy) return;
    const selectedHashes = getRerunHashes(activeRoute, completedOutcomeStats, filter);
    if (selectedHashes.length === 0) {
      toast.error(`No ${label.toLowerCase()} doors found on this route`);
      return;
    }
    setRerunBusy(true);
    try {
      const rerunProperties = getRerunProperties(activeRoute, selectedHashes);
      const rerunRoute = await base44.entities.SavedRoute.create(buildRerunRoutePayload(activeRoute, selectedHashes, filter, label));
      queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
      try { localStorage.setItem('fk_selectedKnockRouteId', rerunRoute.id); } catch {}
      setShowRerunMenu(false);
      setActiveRoute({ ...rerunRoute, properties: rerunProperties, allProperties: rerunProperties, houseCount: selectedHashes.length });
      toast.success(`Created rerun with ${selectedHashes.length} doors`);
    } finally {
      setRerunBusy(false);
    }
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
              className="bg-black/80 hover:bg-black backdrop-blur-md border border-gray-800 shadow-xl h-8 sm:h-11 rounded-lg sm:rounded-xl px-2 sm:px-3 flex items-center gap-1.5 sm:gap-2">
              
                            <LayoutDashboard className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-[#2EEB57]" />
                            <span className="text-[10px] sm:text-xs font-bold text-white hidden sm:inline">COMMAND CENTER</span>
                        </Button>
                        <Button
              onClick={() => setShowMapSettings(true)}
              size="icon"
              className="bg-black/80 hover:bg-black backdrop-blur-md border border-gray-800 shadow-xl h-8 w-8 sm:h-11 sm:w-11 rounded-lg sm:rounded-xl">
              
                            <Settings className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-gray-400" />
                        </Button>
                    </div>

                    {/* MODE TOGGLE - Absolutely centered */}
                    <div className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/80 backdrop-blur-md rounded-xl p-1 border border-gray-800 flex gap-1 shadow-xl max-w-[42vw] sm:max-w-none">
                        <button
              onClick={() => {
                if (!allowCanvasDiscard('Opening Routes')) return;
                setMode('analyze');
                setShowCompare(false);
                setShowRoutePanel(false);
              }}
              className={`px-2.5 py-2 sm:px-4 sm:py-2.5 rounded-lg text-[10px] sm:text-xs font-bold transition-all whitespace-nowrap ${mode === 'analyze' ? 'bg-white text-black shadow-lg' : 'text-gray-400 hover:text-white'}`}>
              
                            ROUTES
                        </button>
                        <button
              onClick={() => {
                if (activeRoute) {
                  toast.error("Close the active route first");
                  return;
                }
                if (!allowCanvasDiscard('Closing the Canvas planner')) return;
                setMode('generate');
                setShowRoutePanel(false);
                setShowCompare(false);
              }}
              className={`px-2.5 py-2 sm:px-4 sm:py-2.5 rounded-lg text-[10px] sm:text-xs font-bold transition-all whitespace-nowrap ${mode === 'generate' ? 'bg-[#2EEB57] text-black shadow-lg' : activeRoute ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-white'}`}>
              
                            BUILDER
                        </button>
                    </div>

                    {/* DATA STATUS + FILTER BUTTON */}
                    <div className="pointer-events-auto shrink-0 flex items-center gap-1 sm:gap-2">

                        <div className="hidden xl:block">
                            <DataStatusIndicator user={user} />
                        </div>
                        <Button
              onClick={() => {
                const newVal = !showRouteDetails;
                setShowRouteDetails(newVal);
                setShowRouteLines(newVal);
                toast.success(newVal ? "Routes Visible" : "Routes Hidden");
              }}
              size="icon"
              className={`inline-flex bg-black/80 hover:bg-black backdrop-blur-md border shadow-xl h-8 w-8 sm:h-11 sm:w-11 rounded-lg sm:rounded-xl transition-all ${!showRouteDetails && !showRouteLines ? 'border-red-500/50' : 'border-gray-800'}`}>
              
                            {!showRouteDetails && !showRouteLines ?
              <EyeOff className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-red-500" /> :

              <Eye className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-blue-400" />
              }
                        </Button>
                        {mode !== 'generate' && (
                          <Button
                            onClick={() => {
                              const next = routeStatusView === 'all'
                                ? 'active'
                                : routeStatusView === 'active'
                                  ? 'completed'
                                  : 'all';
                              setRouteStatusView?.(next);
                              setMode('analyze');
                              setActiveRoute(null);
                              setShowCompare(false);
                              setShowRoutePanel(false);
                              setShowRouteDetails(true);
                              setShowRouteLines(true);
                              toast.success(
                                next === 'completed'
                                  ? 'Completed routes visible'
                                  : next === 'active'
                                    ? 'Active routes visible'
                                    : 'All routes visible'
                              );
                            }}
                            className={`inline-flex bg-black/80 hover:bg-black backdrop-blur-md border shadow-xl h-8 sm:h-11 rounded-lg sm:rounded-xl px-2 sm:px-3 text-[9px] sm:text-[10px] font-black transition-all ${routeStatusView === 'all' ? 'border-[#2EEB57]/50 text-[#39FF4A]' : 'border-gray-800 text-white/70'}`}>
                            {routeStatusView === 'completed' ? 'DONE' : routeStatusView === 'active' ? 'ACTIVE' : 'ALL'}
                          </Button>
                        )}
                        {mode === 'generate' && routeMode === 'precision' && !activeRoute && (
                          <Button
                            onClick={toggleGhostAreas}
                            size="icon"
                            title={showGhostAreas ? 'Hide previous Precision areas' : 'Show previous Precision areas'}
                            aria-label={showGhostAreas ? 'Hide previous Precision areas' : 'Show previous Precision areas'}
                            className={`inline-flex bg-black/80 hover:bg-black backdrop-blur-md border shadow-xl h-8 w-8 sm:h-11 sm:w-11 rounded-lg sm:rounded-xl transition-all ${showGhostAreas ? 'border-[#2EEB57]/60 text-[#39FF4A]' : 'border-gray-800 text-white/55'}`}>
                            <Ghost className="w-3.5 h-3.5 sm:w-5 sm:h-5" />
                          </Button>
                        )}
                        {!drawingMode && (
                          <Button
                            onClick={() => setShowCompare(true)}
                            size="icon"
                            className="inline-flex bg-black/80 hover:bg-black backdrop-blur-md rounded-lg sm:rounded-xl h-7 w-7 sm:h-11 sm:w-11 font-bold shadow-xl border border-[#2EEB57]/40">
                            {mode === 'generate' ? <Settings className="w-3 h-3 sm:w-5 sm:h-5 text-[#2EEB57]" /> : <Filter className="w-3 h-3 sm:w-5 sm:h-5 text-[#2EEB57]" />}
                          </Button>
                        )}
                    </div>


                </div>


                {/* Active Route Banner */}
                {activeRoute &&
        <div className="pointer-events-auto rounded-xl px-2 py-1.5 md:px-3 md:py-2 shadow-2xl border border-[#2EEB57]/30 animate-in slide-in-from-top-2 backdrop-blur-md" style={{ background: 'rgba(10,10,10,0.95)' }}>
                        {/* Row 1: Name + Actions — always horizontal */}
                        <div className="flex items-center gap-1.5 min-w-0">
                            <div className="w-5 h-5 md:w-6 md:h-6 rounded-full flex items-center justify-center shrink-0" style={{ background: BRAND.gold }}>
                                <Navigation className="w-2.5 h-2.5 md:w-3 md:h-3" style={{ color: BRAND.voidBlack }} />
                            </div>

                            {editingName ?
            <div className="flex items-center gap-1 flex-1 min-w-0" onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
                                    <input value={draftName} onChange={(e) => setDraftName(e.target.value)} onKeyDown={(e) => {if (e.key === 'Enter') handleSaveRename();if (e.key === 'Escape') setEditingName(false);}} className="bg-black/60 border border-white/20 text-white text-[11px] font-bold rounded px-1.5 py-0.5 flex-1 outline-none min-w-0" autoFocus />
                                    <button onClick={handleSaveRename} className="p-0.5 text-green-500"><Check className="w-3 h-3" /></button>
                                    <button onClick={() => setEditingName(false)} className="p-0.5 text-gray-500"><X className="w-3 h-3" /></button>
                                </div> :

            <button onClick={handleStartRename} className="group/name flex items-center gap-1 min-w-0 shrink" title="Rename">
                                    <span className="text-[11px] md:text-xs font-bold text-white truncate max-w-[90px] md:max-w-[160px]">{activeRoute.route_number && (!activeRoute.name || /^Route\s+\d+$/i.test(activeRoute.name)) ? `Route ${activeRoute.route_number}` : activeRoute.name}</span>
                                    <Pencil className="w-2.5 h-2.5 text-gray-600 opacity-0 group-hover/name:opacity-100 shrink-0" />
                                </button>
            }

                            {/* House count badge */}
                            <span className="text-[9px] md:text-[10px] font-mono text-gray-500 shrink-0">{activeRoute.houseCount || activeRoute.properties?.length || 0}h</span>

                            {isCompletedRoute && (
                                <button
                                  onPointerDown={(e) => {e.preventDefault();e.stopPropagation();}}
                                  onClick={(e) => {e.preventDefault();e.stopPropagation();setShowRerunMenu(!showRerunMenu);}}
                                  className="h-8 md:h-7 rounded-md bg-[#2EEB57] px-2 text-[9px] md:text-[10px] font-black text-black hover:bg-[#39FF4A] shrink-0"
                                  title="Rerun completed route">
                                  RERUN
                                </button>
                            )}

                            <div className="ml-auto flex items-center gap-1 shrink-0">
                                <button
                onPointerDown={(e) => {e.preventDefault();e.stopPropagation();}}
                onClick={(e) => {e.preventDefault();e.stopPropagation();setShowSplitRouteModal(true);}}
                className="hidden md:flex h-7 items-center gap-1 rounded-md bg-[#2EEB57] px-2 text-[10px] font-black text-black hover:bg-[#39FF4A] touch-manipulation select-none active:scale-95"
                title="Split route into daily batches">
                
                                    <Scissors className="w-2.5 h-2.5" /><span>SPLIT ROUTE</span>
                                </button>
                                <OptimizeRouteTrigger
                                  variant="mobile"
                                  open={showOptimizeMenu}
                                  busy={reoptimizeBusy}
                                  onToggle={toggleOptimizeMenu}
                                />
                                <button
                onPointerDown={(e) => {e.preventDefault();e.stopPropagation();}}
                onClick={handleExportActiveRouteCsv}
                className="hidden md:flex h-7 px-2 text-[10px] font-bold bg-white hover:bg-gray-200 text-black rounded-md items-center gap-1 touch-manipulation select-none active:scale-95"
                title="Export route as CSV">

                                    <Download className="w-2.5 h-2.5" /><span>EXPORT</span>
                                </button>
                                <OptimizeRouteTrigger
                                  variant="desktop"
                                  open={showOptimizeMenu}
                                  busy={reoptimizeBusy}
                                  onToggle={toggleOptimizeMenu}
                                />
                                <button
                onPointerDown={(e) => {e.preventDefault();e.stopPropagation();}}
                onClick={(e) => {e.preventDefault();e.stopPropagation();setShowAnchorsDialog(true);}}
                className="hidden md:flex h-7 items-center gap-1 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 text-[10px] font-black text-amber-300 hover:bg-amber-400/20 touch-manipulation select-none active:scale-95"
                title="Set the start and finish point of this route">

                                    <Flag className="w-2.5 h-2.5" /><span>ANCHORS</span>
                                </button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button onPointerDown={(e) => e.stopPropagation()} className="md:hidden flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white touch-manipulation active:scale-95" aria-label="More route actions">
                                      <MoreVertical className="h-4 w-4" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="z-[5000] bg-[#0A0A0A] border-white/10 text-white">
                                    <DropdownMenuItem onClick={handleExportActiveRouteCsv} className="focus:bg-white/10 focus:text-white">
                                      <Download className="mr-2 h-4 w-4" /> Export CSV
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={(e) => {e.stopPropagation();setShowSplitRouteModal(true);}} className="focus:bg-white/10 focus:text-white">
                                      <Scissors className="mr-2 h-4 w-4" /> Split Route
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={(e) => {e.stopPropagation();setShowAnchorsDialog(true);}} className="focus:bg-white/10 focus:text-white">
                                      <Flag className="mr-2 h-4 w-4" /> Anchors
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                                <button onPointerDown={(e) => {e.preventDefault();e.stopPropagation();}} onClick={(e) => {e.preventDefault();e.stopPropagation();setActiveRoute(null);}} className="flex items-center gap-1 h-8 md:h-6 px-2 md:px-2 rounded-md border border-white/10 text-[10px] font-bold text-gray-300 hover:text-white hover:bg-white/10 shrink-0 touch-manipulation active:scale-95">
                                    <X className="w-3 h-3 md:w-2.5 md:h-2.5" /><span className="hidden sm:inline">CLOSE</span>
                                </button>
                            </div>
                        </div>

                        {showOptimizeMenu && (
                            <OptimizeRouteChoices
                              busy={reoptimizeBusy}
                              carDisabled={!routeIsOptimizableFromCar}
                              onSelectMode={handleSelectOptimizeMode}
                              onCancel={() => setShowOptimizeMenu(false)}
                            />
                        )}

                        {isCompletedRoute && showRerunMenu && (
                            <div className="mt-2 grid grid-cols-2 gap-1.5 rounded-xl border border-white/10 bg-black/45 p-2" onClick={(e) => {e.stopPropagation();e.nativeEvent?.stopImmediatePropagation?.();}} onTouchStart={(e) => {e.stopPropagation();e.nativeEvent?.stopImmediatePropagation?.();}}>
                                {rerunOptions.map(option => (
                                  <button
                                    key={option.filter}
                                    disabled={rerunBusy}
                                    onPointerDown={(e) => {e.preventDefault();e.stopPropagation();e.nativeEvent?.stopImmediatePropagation?.();}}
                                    onClick={(e) => {e.preventDefault();e.stopPropagation();e.nativeEvent?.stopImmediatePropagation?.();handleRerunCompletedRoute(option.filter, option.label);}}
                                    className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-2 text-left text-[10px] font-black text-white/80 hover:border-[#2EEB57]/45 hover:bg-[#2EEB57]/10 disabled:opacity-50">
                                    <span className="block">{option.label}</span>
                                    <span className="text-[9px] text-white/40">{option.count} doors</span>
                                  </button>
                                ))}
                            </div>
                        )}

                        {/* Row 2: Filters — scrollable grid on mobile, inline on desktop */}
                        <div className="flex items-center gap-1 md:gap-1.5 mt-1.5 overflow-x-auto scrollbar-hide pb-0.5 -mx-0.5 px-0.5" onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
                            <select value={activeRoute.assigned_to || ""} onChange={(e) => {e.stopPropagation();handleAssignRoute(activeRoute.id, e.target.value);}} onPointerDown={(e) => e.stopPropagation()} className={routeSelectClass} style={routeSelectStyle}>
                                <option value="" style={routeOptionStyle}>Assign</option>
                                <option value={user?.id || 'manager'} style={routeOptionStyle}>Me</option>
                                {teamMembers.map((m) => <option key={m.id} value={m.id} style={routeOptionStyle}>{m.name}</option>)}
                            </select>

                            {setActiveRouteSoldFilter &&
            <select value={activeRouteSoldFilter} onChange={(e) => {e.stopPropagation();setActiveRouteSoldFilter(e.target.value);}} onPointerDown={(e) => e.stopPropagation()} className={routeSelectClass} style={routeSelectStyle}>
                                    <option value="all" style={routeOptionStyle}>Dates</option>
                                    <option value="0.5" style={routeOptionStyle}>2W</option>
                                    <option value="1" style={routeOptionStyle}>1M</option>
                                    <option value="3" style={routeOptionStyle}>3M</option>
                                    <option value="6" style={routeOptionStyle}>6M</option>
                                    <option value="12" style={routeOptionStyle}>1Y</option>
                                </select>
            }

                            {setActiveRoutePriceFilter &&
            <select value={activeRoutePriceFilter} onChange={(e) => {e.stopPropagation();setActiveRoutePriceFilter(e.target.value);}} onPointerDown={(e) => e.stopPropagation()} className={routeSelectAccentClass} style={routeSelectAccentStyle}>
                                    <option value="all" style={routeOptionAccentStyle}>Price</option>
                                    <option value="200000" style={routeOptionAccentStyle}>&gt;$200K</option>
                                    <option value="300000" style={routeOptionAccentStyle}>&gt;$300K</option>
                                    <option value="500000" style={routeOptionAccentStyle}>&gt;$500K</option>
                                    <option value="750000" style={routeOptionAccentStyle}>&gt;$750K</option>
                                    <option value="1000000" style={routeOptionAccentStyle}>&gt;$1M</option>
                                </select>
            }

                            {(activeRouteSoldFilter && activeRouteSoldFilter !== 'all' || activeRoutePriceFilter && activeRoutePriceFilter !== 'all') &&
            <button
              onClick={(e) => {e.stopPropagation();resetActiveRouteFilters();}}
              className="h-6 md:h-7 px-2 md:px-2.5 text-[9px] md:text-[10px] font-black bg-white hover:bg-gray-200 text-black border border-white/80 rounded-md flex items-center gap-1 shrink-0 shadow-[0_0_12px_rgba(255,255,255,0.18)]"
              title="Reset route filters">
              
                                <RotateCcw className="w-2.5 h-2.5" /> RESET FILTERS
                            </button>
            }

                            {(activeRouteSoldFilter !== 'all' || activeRoutePriceFilter !== 'all') && onSaveFilteredRoute &&
            <button onClick={(e) => {e.stopPropagation();handleSaveVisibleFilteredRoute();}} className="h-5 md:h-6 px-1.5 md:px-2 text-[9px] md:text-[10px] font-bold bg-blue-600 hover:bg-blue-500 text-white rounded-md flex items-center gap-0.5 shrink-0">
                                    <Save className="w-2.5 h-2.5" /> SAVE
                                </button>
            }
                        </div>
                    </div>
        }
            </div>

            {/* Team Analysis Legend (Top Right) - Hidden on mobile */}
            {!activeRoute &&
      <div className="hidden md:block absolute top-20 right-4 z-[900] pointer-events-auto bg-black/80 backdrop-blur-md border border-gray-800 rounded-xl p-3 max-w-[200px] animate-in slide-in-from-right">
                    <p className="text-[10px] font-bold text-gray-400 mb-2 uppercase">Team Analysis</p>
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                        {teamMembers.map((member) => {
            const memberRoutes = hydratedSavedRoutes.filter((r) => r.assigned_to === member.id);
            if (memberRoutes.length === 0) return null;
            return (
              <div key={member.id} className="flex items-center justify-between text-xs">
                                    <div className="flex items-center gap-2">
                                        <span className="w-2 h-2 rounded-full" style={{ background: repColors[member.id] }} />
                                        <span className="text-white truncate max-w-[80px]">{member.name}</span>
                                    </div>
                                    <span className="text-gray-500">{memberRoutes.length} Rts</span>
                                </div>);

          })}
                        <div className="flex items-center justify-between text-xs opacity-50">
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#666]" />
                                <span className="text-white">Unassigned</span>
                            </div>
                            <span className="text-gray-500">{hydratedSavedRoutes.filter((r) => !r.assigned_to).length}</span>
                        </div>
                    </div>
                </div>
      }

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
                    try {mapRef.current.setView([latitude, longitude], 18);} catch (err) {}
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
          style={{ background: 'rgba(31, 31, 31, 0.9)', color: '#3b82f6' }}>
          
                    <Locate className="w-4 h-4 sm:w-5 sm:h-5" />
                </Button>

                {fitBounds && fitBounds.length > 0 &&
        <Button
          onClick={(e) => {
            e.stopPropagation();
            if (mapRef.current && fitBounds && fitBounds.length > 0) {
              try {if (mapRef.current._mapPane) mapRef.current.fitBounds(fitBounds, { padding: [30, 30], maxZoom: 17 });} catch (e) {}
              toast.success("Centered on Territory");
            }
          }}
          size="icon"
          className="rounded-full w-9 h-9 sm:w-10 sm:h-10 shadow-2xl backdrop-blur-md"
          style={{ background: 'rgba(31, 31, 31, 0.9)', color: BRAND.gold, border: `1px solid ${BRAND.gold}40` }}>
          
                        <MapPin className="w-4 h-4" />
                    </Button>
        }
            </div>

            {/* Bottom Action Bar */}
            <div className="absolute bottom-4 sm:bottom-6 left-0 right-0 z-[1000] pointer-events-none flex justify-center px-2">
                <div className={`pointer-events-auto flex items-center justify-center gap-2 ${routeMode === 'canvas' && mode === 'generate' && !activeRoute ? 'max-w-[calc(100vw-1rem)] overflow-x-auto' : ''}`}>
                    {routeMode === 'canvas' && mode === 'generate' && !activeRoute ? !drawingMode &&
          <>
                            <Button
              onClick={() => openCanvasPlannerView('new_area')}
              className="rounded-full h-10 px-3 sm:px-4 text-[10px] sm:text-xs font-bold tracking-wide shadow-[0_0_20px_rgba(46,235,87,0.25)] transition-all active:scale-95 whitespace-nowrap bg-[#2EEB57] hover:bg-[#39FF4A] text-black">
              
                                <Pencil className="w-4 h-4 mr-1" /> NEW AREA
                            </Button>
                            <Button
              onClick={() => openCanvasPlannerView('areas')}
              className="rounded-full h-10 px-3 sm:px-4 text-[10px] sm:text-xs font-bold tracking-wide shadow-lg transition-all active:scale-95 whitespace-nowrap bg-black/90 text-[#2EEB57] border border-[#2EEB57]/40">
              
                                <List className="w-4 h-4 mr-1" /> AREAS
                            </Button>
                        </> :

          <>
                            {mode === 'generate' && !activeRoute &&
            <>
              <Button
                onClick={() => {
                  if (hasDrawnArea) {
                    setShowCompare(false);
                    window.dispatchEvent(new CustomEvent('fk-open-precision-pull'));
                  } else {
                    setShowCompare(false);
                    window.dispatchEvent(new CustomEvent('fk-start-drawing'));
                  }
                }}
                disabled={routesGenerating}
                className="rounded-full h-10 px-4 text-xs font-bold tracking-wide shadow-[0_0_20px_rgba(255,255,255,0.22)] transition-all active:scale-95 whitespace-nowrap bg-white text-black hover:bg-white/90">
                
                                      {routesGenerating ?
                <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> BUILDING</> :
                hasDrawnArea ?
                <><Zap className="w-4 h-4 mr-1.5" /> PULL DATA</> :


                <><Navigation className="w-4 h-4 mr-1.5" /> DRAW</>
                }
                                  </Button>
            </>
            }
                            {mode !== 'generate' &&
            <Button
              onClick={() => !activeRoute && setShowRoutePanel(true)}
              disabled={!!activeRoute}
              className={`rounded-full h-10 px-4 text-xs font-bold tracking-wide shadow-sm transition-all active:scale-95 whitespace-nowrap ${activeRoute ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/10'}`}
              style={{
                background: activeRoute ? 'rgba(0, 0, 0, 0.62)' : 'rgba(0, 0, 0, 0.78)',
                color: activeRoute ? 'rgba(255,255,255,0.48)' : 'rgba(255,255,255,0.86)',
                border: activeRoute ? '1px solid rgba(255,255,255,0.10)' : '1px solid rgba(255,255,255,0.14)'
              }}>
              
                                <List className="w-4 h-4 mr-1.5" />
                                ROUTES
                                {!routesGenerating && (hydratedSavedRoutes.length > 0 || routes.length > 0) &&
              <Badge className="ml-1.5 h-5 min-w-[20px] px-1.5 text-[10px] border border-white/10" style={{ background: 'rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.82)' }}>
                                        {hydratedSavedRoutes.length > 0 ? hydratedSavedRoutes.length : routes.length}
                                    </Badge>
              }
                            </Button>
            }
                        </>
          }

                    {activeRoute &&
          <Button
            onClick={() => setShowChecklist(true)}
            className="rounded-full h-10 px-4 text-xs font-bold tracking-wide shadow-lg backdrop-blur-md transition-all active:scale-95 whitespace-nowrap"
            style={{ background: 'rgba(31, 31, 31, 0.9)', color: BRAND.gold, border: `1px solid ${BRAND.gold}` }}>
            
                            <List className="w-4 h-4 mr-1.5" />
                            CHECKLIST
                        </Button>
          }
                </div>
            </div>

            {showAnchorsDialog && activeRoute && (
              <RouteAnchorsDialog
                route={activeRoute}
                onClose={() => setShowAnchorsDialog(false)}
                onApply={handleApplyRouteAnchors}
              />
            )}

            {showSplitRouteModal && activeRoute && (
              <SplitRouteModal
                route={activeRoute}
                teamMembers={teamMembers}
                managerId={activeRoute.manager_id || user?.id}
                onClose={() => setShowSplitRouteModal(false)}
                onCreated={handleSplitRoutesCreated}
              />
            )}
        </>);

}