import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { base44 } from '@/api/base44Client';
import { Map as MapIcon, Pencil, Layers, X, Check, Trash2, Loader2, List, Zap } from 'lucide-react';
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

export default function TerritoryPrompt({
    mode,
    setMode,
    activeRoute,
    routesGenerating,
    showCompare,
    setShowCompare,
    showRoutePanel,
    setShowRoutePanel,
    drawingMode,
    setDrawingMode,
    drawnPolygon,
    setDrawnPolygon,
    draftPolygon,
    setDraftPolygon,
    drawShape,
    setDrawShape,
    drawSizeMiles,
    setDrawSizeMiles,
    user,
    setZipCodeFilter,
    onPullComplete
}) {
    const queryClient = useQueryClient();
    const [pulling, setPulling] = useState(false);
    const [pullProgress, setPullProgress] = useState('');

    const isOwner = user?.is_owner === true || user?.email?.toLowerCase().includes('christian');

    const hasPulledData = !!user?.has_pulled_data;
    const hasDefinedMarket = user?.has_defined_market || user?.territory_zip_codes?.length > 0;
    
    // Show "Your Territory" prompt only for returning users who already pulled data
    const showInitialPrompt = hasPulledData && hasDefinedMarket && mode === 'generate' && !activeRoute && !routesGenerating && !showCompare && !showRoutePanel && !drawingMode && (!drawnPolygon || drawnPolygon.length === 0);

    return (
        <>
            {/* Simple prompt for returning users who already have data */}
            {showInitialPrompt && (
                <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-auto">
                    <div className="flex flex-col items-center gap-4 w-full px-4 max-w-sm">
                        <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-2 shadow-[0_0_30px_rgba(0,245,160,0.3)]">
                            <MapIcon className="w-8 h-8 text-green-400" />
                        </div>
                        <h2 className="text-2xl font-extrabold text-white text-center tracking-tight">
                            Your Territory
                        </h2>
                        <p className="text-gray-400 text-sm text-center">Your lead data is loaded and ready.</p>
                        <div className="flex flex-col gap-3 w-full">
                            <Button
                                onClick={() => setShowCompare(true)}
                                className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-14 text-base w-full rounded-xl shadow-[0_0_20px_rgba(255,215,0,0.4)] border-none"
                            >
                                <Zap className="w-5 h-5 mr-2" />
                                Generate Routes
                            </Button>
                            <Button
                                onClick={() => {
                                    setMode('analyze');
                                    setShowRoutePanel(true);
                                }}
                                className="bg-white/10 hover:bg-white/20 text-white font-bold h-12 text-sm w-full rounded-xl border border-white/10"
                            >
                                <List className="w-4 h-4 mr-2" />
                                View Saved Routes
                            </Button>
                            <Button
                                onClick={() => setMode('analyze')}
                                className="bg-white/5 hover:bg-white/10 text-gray-400 font-bold h-10 text-xs w-full rounded-xl border border-gray-800"
                            >
                                Just View Map
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Active Drawing Controls */}
            {drawingMode && (
                <div className="absolute top-24 left-1/2 -translate-x-1/2 z-[2000] bg-black/90 backdrop-blur-md border border-yellow-500/50 rounded-2xl p-3 shadow-2xl flex flex-col sm:flex-row items-center gap-3 animate-in slide-in-from-top-4 w-11/12 max-w-lg">
                    <div className="flex items-center gap-3 w-full sm:w-auto">
                        <div className="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center shrink-0">
                            <Pencil className="w-4 h-4 text-yellow-500" />
                        </div>
                        <div className="flex-1 sm:w-32">
                            <p className="text-xs font-bold text-white uppercase tracking-wider">Drawing Mode</p>
                            <p className="text-[10px] text-gray-400">Click map to drop shape</p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-start border-t sm:border-t-0 border-gray-800 pt-2 sm:pt-0 mt-1 sm:mt-0">
                        <div className="flex gap-2">
                            <select
                                value={drawShape || 'circle'}
                                onChange={(e) => setDrawShape(e.target.value)}
                                className="bg-gray-900 border border-gray-700 text-white text-xs rounded-md px-2 py-1 h-8"
                            >
                                <option value="circle">Circle</option>
                                <option value="square">Square</option>
                            </select>

                            <span className="text-xs text-gray-300 font-mono bg-gray-900 border border-gray-700 rounded-md px-2 py-1 h-8 flex items-center">200 sq mi</span>
                        </div>
                        <div className="flex gap-2">
                            <Button
                                size="icon"
                                onClick={() => {
                                    setDrawingMode(false);
                                    setDraftPolygon([]);
                                }}
                                className="h-8 w-8 rounded-full bg-red-500/20 text-red-500 hover:bg-red-500 hover:text-white border-none"
                            >
                                <X className="w-4 h-4" />
                            </Button>
                            <Button
                                size="icon"
                                disabled={draftPolygon.length < 3}
                                onClick={() => {
                                    setDrawnPolygon(draftPolygon);
                                    setDrawingMode(false);
                                    toast.success("Territory area saved!");
                                }}
                                className="h-8 w-8 rounded-full bg-green-500/20 text-green-500 hover:bg-green-500 hover:text-white border-none disabled:opacity-50"
                            >
                                <Check className="w-4 h-4" />
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Pull Progress Bar */}
            {
                pulling && (
                    <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[2000] w-11/12 max-w-sm animate-in fade-in">
                        <div className="bg-black/90 backdrop-blur-md border border-blue-500/50 rounded-xl p-4 shadow-2xl">
                            <div className="flex items-center gap-3 mb-3">
                                <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                                <div>
                                    <p className="text-xs font-bold text-white">Fetching Property Data</p>
                                    <p className="text-[10px] text-gray-400">{pullProgress}</p>
                                </div>
                            </div>
                            <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                                <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full animate-pulse" style={{ width: '70%', transition: 'width 2s ease' }} />
                            </div>
                            <p className="text-[9px] text-gray-500 mt-2 text-center">This may take 10-30 seconds depending on area size</p>
                        </div>
                    </div>
                )
            }

            {/* Drawn Polygon Controls */}
            {
                !drawingMode && !pulling && drawnPolygon && drawnPolygon.length > 2 && (
                    <div className="absolute top-20 left-1/2 -translate-x-1/2 z-[1000] bg-black/90 backdrop-blur-md border border-gray-800 rounded-full px-4 py-2 shadow-2xl flex items-center gap-3 animate-in fade-in">
                        <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse shrink-0" />
                        <span className="text-xs font-bold text-white whitespace-nowrap">Custom Area Active</span>
                        <Button
                            disabled={pulling}
                            onClick={async () => {
                                // Compute centroid and coverage radius
                                const centerLat = drawnPolygon.reduce((s, p) => s + p.lat, 0) / drawnPolygon.length;
                                const centerLng = drawnPolygon.reduce((s, p) => s + p.lng, 0) / drawnPolygon.length;

                                const R = 3959; // miles
                                const toRad = (v) => v * Math.PI / 180;
                                let maxDist = 0;
                                for (const p of drawnPolygon) {
                                    const dLat = toRad(p.lat - centerLat);
                                    const dLng = toRad(p.lng - centerLng);
                                    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(centerLat)) * Math.cos(toRad(p.lat)) * Math.sin(dLng / 2) ** 2;
                                    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                                    const d = R * c;
                                    if (d > maxDist) maxDist = d;
                                }
                                // Use exact radius from centroid to edge — the draw tool already constrains to 200 sq mi
                                const radius = Math.max(0.5, maxDist);
                                // The actual area is 200 sq mi (set by the draw tool), use that for display
                                const areaSqMiles = 200;
                                console.log(`[TerritoryPrompt] Centroid: ${centerLat.toFixed(4)}, ${centerLng.toFixed(4)}, maxDist: ${maxDist.toFixed(2)} miles, radius sent: ${radius.toFixed(2)} miles, polygon pts: ${drawnPolygon.length}`);

                                // Check pull limit — subscribers and owners get unlimited, free users get 1
                                const isSubscribed = user?.subscription_status === 'active' || user?.subscription_status === 'trialing';
                                const pullLimit = (isOwner || isSubscribed) ? 999 : 1;
                                const pullsUsed = user?.area_pulls_count || 0;

                                if (pullsUsed >= pullLimit) {
                                    toast.error("You've used your free data pull. Subscribe to pull fresh leads.", { duration: 5000 });
                                    return;
                                }

                                setPulling(true);
                                setPullProgress(`Pulling data for ~${areaSqMiles.toFixed(1)} sq mi...`);
                                const toastId = toast.loading(`Pulling data for approx ${areaSqMiles.toFixed(1)} sq miles...`);
                                try {
                                    const res = await base44.functions.invoke('fetchAreaProperties', {
                                        latitude: centerLat,
                                        longitude: centerLng,
                                        radius: radius,
                                        polygon: drawnPolygon
                                    });
                                    const d = res.data || {};
                                    if (d.error) {
                                        toast.error(d.message || d.error, { id: toastId });
                                    } else if (d.status === 'empty' || (d.count === 0 && d.in_polygon_count === 0)) {
                                        const base = d.total_found ? `${d.total_found} found, ${d.in_polygon_count || 0} in area` : '0 found';
                                        let extra = '';
                                        if ((d.in_polygon_count || 0) > 0 && (d.recent_sales_12mo || 0) > 0) {
                                            extra = ` • ${d.recent_sales_12mo} sold within last 12 months (may be excluded by your filters).`;
                                        }
                                        toast.info(d.message || `No houses to generate routes. ${base}.${extra}`, { id: toastId });
                                    } else {
                                        let note = '';
                                        if (d.recent_sales_12mo) {
                                            note = ` • Note: ${d.recent_sales_12mo} sold in last 12 months.`;
                                        }
                                        
                                        if (d.count === 0 && d.in_polygon_count > 0) {
                                            toast.success(`Area loaded! ${d.in_polygon_count} properties ready for routing.${note}`, { id: toastId });
                                        } else {
                                            toast.success(d.message || `Properties loaded onto the map!${note}`, { id: toastId });
                                        }

                                        // Mark user as having pulled data
                                        try {
                                            await base44.auth.updateMe({ 
                                                has_pulled_data: true,
                                                territory_property_count: d.count || d.in_polygon_count || 0,
                                                last_data_pull: new Date().toISOString()
                                            });
                                        } catch (e) { console.warn('Failed to update pull status', e); }

                                        if (onPullComplete) {
                                            onPullComplete();
                                            setShowCompare(true);
                                        } else {
                                            queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
                                            queryClient.invalidateQueries({ queryKey: ['user'] });
                                            setShowCompare(true);
                                            setDrawnPolygon(null);
                                        }
                                    }
                                } catch (e) {
                                    const msg = e.response?.data?.message || e.message;
                                    toast.error(`Failed to pull data: ${msg}`, { id: toastId });
                                } finally {
                                    setPulling(false);
                                    setPullProgress('');
                                }
                            }}
                            className={`text-white text-[10px] h-6 px-2 py-0 rounded-md ml-2 ${pulling ? 'bg-blue-800' : 'bg-blue-600 hover:bg-blue-500'}`}
                        >
                            {pulling ? (
                                <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Pulling...</>
                            ) : (
                                'Fetch data'
                            )}
                        </Button>
                        <button
                            onClick={() => {
                                setDrawnPolygon(null);
                                setDraftPolygon([]);
                            }}
                            className="text-gray-400 hover:text-red-500 transition-colors p-1 bg-white/5 rounded-full"
                        >
                            <Trash2 className="w-3 h-3" />
                        </button>
                    </div>
                )
            }
        </>
    );
}