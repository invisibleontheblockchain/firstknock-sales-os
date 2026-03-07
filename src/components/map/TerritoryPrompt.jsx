import React, { useState, useEffect, useRef } from 'react';
import { Button } from "@/components/ui/button";
import { base44 } from '@/api/base44Client';
import { Map as MapIcon, Pencil, X, Check, Trash2, Loader2, List, Zap, Lock } from 'lucide-react';
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
    const [pullPct, setPullPct] = useState(0);
    const [etaText, setEtaText] = useState('');
    const [totalExpected, setTotalExpected] = useState(0);
    const pollRef = useRef(null);
    const pctHistoryRef = useRef([]);

    // Cleanup polling on unmount
    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    const hasPulledData = !!user?.has_pulled_data;
    const hasDefinedMarket = user?.has_defined_market || user?.territory_zip_codes?.length > 0;
    const isPaid = user?.subscription_status === 'active' || user?.is_owner;
    const pullCount = user?.area_pulls_count || 0;
    const canPullAgain = isPaid || pullCount < 5;
    
    const showInitialPrompt = hasPulledData && hasDefinedMarket && mode === 'generate' && !activeRoute && !routesGenerating && !showCompare && !showRoutePanel && !drawingMode && (!drawnPolygon || drawnPolygon.length === 0);

    const startPolling = (jobId) => {
        if (pollRef.current) clearInterval(pollRef.current);
        
        let pollCount = 0;
        const MAX_POLLS = 1800; // 30 minutes at 1s intervals
        const pollStartTime = Date.now();

        const doPoll = async () => {
            pollCount++;
            if (pollCount > MAX_POLLS) {
                clearInterval(pollRef.current);
                pollRef.current = null;
                setPulling(false);
                toast.info("Still running in the background — come back and your data will be here!");
                return;
            }

            // After first 30s, slow polling to 2s intervals
            if (pollCount === 30) {
                clearInterval(pollRef.current);
                pollRef.current = setInterval(doPoll, 2000);
            }

            try {
                const res = await base44.functions.invoke('fetchJobStatus', { job_id: jobId });
                const d = res.data;

                if (!d) return;

                const pct = d.progress_pct || 0;
                setPullPct(pct);
                const fetched = d.total_fetched || 0;
                const expected = d.total_expected || 0;
                const inserted = d.total_inserted || 0;
                setTotalExpected(expected);
                
                // Track progress history for ETA calculation
                pctHistoryRef.current.push({ pct, time: Date.now() });
                // Keep last 10 samples
                if (pctHistoryRef.current.length > 10) pctHistoryRef.current.shift();
                
                // Calculate ETA from progress rate
                if (pctHistoryRef.current.length >= 2 && pct > 0 && pct < 100) {
                    const first = pctHistoryRef.current[0];
                    const last = pctHistoryRef.current[pctHistoryRef.current.length - 1];
                    const pctDelta = last.pct - first.pct;
                    const timeDelta = (last.time - first.time) / 1000; // seconds
                    if (pctDelta > 0 && timeDelta > 0) {
                        const pctPerSec = pctDelta / timeDelta;
                        const remainPct = 100 - pct;
                        const remainSec = remainPct / pctPerSec;
                        if (remainSec < 60) {
                            setEtaText('Less than 1 min remaining');
                        } else {
                            const mins = Math.ceil(remainSec / 60);
                            setEtaText(`~${mins} min remaining`);
                        }
                    }
                } else if (pct === 0 && expected > 0) {
                    // Give rough estimate based on total expected
                    const estMins = Math.ceil(expected / 15000); // ~15000 per chunk, ~1 min per chunk
                    setEtaText(`Estimated ${estMins} min for ${expected.toLocaleString()} properties`);
                }
                
                if (expected > 0) {
                    setPullProgress(`${fetched.toLocaleString()} / ${expected.toLocaleString()} properties fetched, ${inserted.toLocaleString()} new`);
                } else {
                    setPullProgress(`${fetched.toLocaleString()} properties fetched so far...`);
                }

                if (d.status === 'completed') {
                    clearInterval(pollRef.current);
                    pollRef.current = null;
                    setPulling(false);
                    setPullPct(100);

                    const totalLoaded = (d.total_inserted || 0) + (d.total_existed || 0);
                    toast.success(`Done! ${d.total_inserted?.toLocaleString()} new + ${d.total_existed?.toLocaleString()} existing properties.`);

                    // Update user status
                    try {
                        await base44.auth.updateMe({ 
                            has_pulled_data: true,
                            territory_property_count: totalLoaded,
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
                } else if (d.status === 'failed') {
                    clearInterval(pollRef.current);
                    pollRef.current = null;
                    setPulling(false);
                    toast.error(d.error_message || 'Fetch job failed.');
                }
            } catch (e) {
                // Silent — network hiccup, keep polling
                console.warn('Poll error:', e.message);
            }
        }, 2000); // Poll every 2 seconds
    };

    const handleFetchData = async () => {
        // Check pull limit on frontend too for instant feedback
        if (!canPullAgain) {
            toast.error("You've used all 5 free data pulls. Upgrade for more.");
            return;
        }

        const centerLat = drawnPolygon.reduce((s, p) => s + p.lat, 0) / drawnPolygon.length;
        const centerLng = drawnPolygon.reduce((s, p) => s + p.lng, 0) / drawnPolygon.length;

        const R = 3959;
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
        const radius = Math.max(0.5, maxDist);

        setPulling(true);
        setPullProgress('Connecting to property database...');
        setPullPct(2);
        setEtaText('Initializing...');
        setTotalExpected(0);
        pctHistoryRef.current = [];

        try {
            const res = await base44.functions.invoke('fetchAreaProperties', {
                latitude: centerLat,
                longitude: centerLng,
                radius: radius,
                polygon: drawnPolygon
            });
            const d = res.data || {};

            if (d.error) {
                if (d.error === 'pull_limit_reached') {
                    toast.error(d.message || "Upgrade to pull fresh leads.", { duration: 5000 });
                } else {
                    toast.error(d.message || d.error);
                }
                setPulling(false);
                return;
            }

            if (d.status === 'already_running') {
                toast.info(d.message);
                // Start polling the existing job
                startPolling(d.job_id);
                return;
            }

            if (d.status === 'started' && d.job_id) {
                toast.success('Fetch started in background!');
                startPolling(d.job_id);
            } else {
                // Fallback for any other response shape
                setPulling(false);
                toast.success(d.message || 'Done!');
            }
        } catch (e) {
            const msg = e.response?.data?.message || e.message;
            toast.error(`Failed to start fetch: ${msg}`);
            setPulling(false);
        }
    };

    return (
        <>
            {/* Simple prompt for returning users who already have data */}
            {/* Returning user prompt — skip straight to map, no modal blocking */}

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
                            <span className="text-xs text-gray-300 font-mono bg-gray-900 border border-gray-700 rounded-md px-2 py-1 h-8 flex items-center">40 sq mi</span>
                        </div>
                        <div className="flex gap-2">
                            <Button
                                size="icon"
                                onClick={() => { setDrawingMode(false); setDraftPolygon([]); }}
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
            {pulling && (
                <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[2000] w-11/12 max-w-sm animate-in fade-in">
                    <div className="bg-black/90 backdrop-blur-md border border-blue-500/50 rounded-xl p-4 shadow-2xl">
                        <div className="flex items-center gap-3 mb-2">
                            <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                            <div className="flex-1">
                                <p className="text-xs font-bold text-white">Importing Property Data</p>
                                <p className="text-[10px] text-gray-400">{pullProgress}</p>
                            </div>
                            <span className="text-sm font-mono font-bold text-blue-400">{Math.round(pullPct)}%</span>
                        </div>
                        <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-1000"
                                style={{ width: `${Math.max(pullPct, 3)}%` }}
                            />
                        </div>
                        {etaText && (
                            <p className="text-[11px] text-cyan-400 font-semibold mt-2 text-center">
                                ⏱ {etaText}
                            </p>
                        )}
                        <div className="mt-2 bg-gray-900/80 rounded-lg p-2.5 border border-gray-800">
                            <p className="text-[10px] text-gray-300 leading-relaxed text-center">
                                {pullPct < 5
                                    ? '🔍 Scanning your area for every property on record — this is a one-time setup that gives you the full picture.'
                                    : pullPct < 30
                                        ? '📦 Pulling property data in batches from public records. Larger areas have more homes to process.'
                                        : pullPct < 70
                                            ? '⚡ Deduplicating and writing to your database. You can close this page — it will keep running.'
                                            : pullPct < 95
                                                ? '🏁 Almost there! Writing final records and updating your territory map.'
                                                : '✅ Wrapping up! Your territory will be ready in seconds.'}
                            </p>
                        </div>
                        <p className="text-[9px] text-gray-600 mt-1.5 text-center">
                            Safe to leave — data imports continue in the background
                        </p>
                    </div>
                </div>
            )}

            {/* Drawn Polygon Controls */}
            {!drawingMode && !pulling && drawnPolygon && drawnPolygon.length > 2 && (
                <div className="absolute bottom-20 sm:bottom-24 left-1/2 -translate-x-1/2 z-[999] bg-black/90 backdrop-blur-md border border-gray-800 rounded-full px-4 py-2 shadow-2xl flex items-center gap-3 animate-in fade-in">
                    <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse shrink-0" />
                    <span className="text-xs font-bold text-white whitespace-nowrap">Custom Area Active</span>
                    {canPullAgain ? (
                        <Button
                            disabled={pulling}
                            onClick={handleFetchData}
                            className="text-white text-[10px] h-6 px-2 py-0 rounded-md ml-2 bg-blue-600 hover:bg-blue-500"
                        >
                            Fetch data
                        </Button>
                    ) : (
                        <div className="flex items-center gap-1 ml-2 text-[10px] font-bold text-gray-500">
                            <Lock className="w-3 h-3" />
                            <span>Upgrade for more pulls</span>
                        </div>
                    )}
                    <button
                        onClick={() => { setDrawnPolygon(null); setDraftPolygon([]); }}
                        className="text-gray-400 hover:text-red-500 transition-colors p-1 bg-white/5 rounded-full"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            )}
        </>
    );
}