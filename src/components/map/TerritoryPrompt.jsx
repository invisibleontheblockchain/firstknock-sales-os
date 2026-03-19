import React, { useState, useEffect, useRef } from 'react';
import { Button } from "@/components/ui/button";
import { base44 } from '@/api/base44Client';
import { Map as MapIcon, Pencil, X, Trash2, Loader2, List, Zap, Lock, ArrowRight } from 'lucide-react';
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';


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
    const [fetchMonths, setFetchMonths] = useState(12);
    const [pullPct, setPullPct] = useState(0);
    const [displayPct, setDisplayPct] = useState(0);
    const [etaText, setEtaText] = useState('');
    const [totalExpected, setTotalExpected] = useState(0);
    const [isDeltaPull, setIsDeltaPull] = useState(false);
    const pollRef = useRef(null);
    const animRef = useRef(null);
    const pctHistoryRef = useRef([]);
    const targetPctRef = useRef(0);

    // Smooth progress animation — ticks display forward toward real target
    useEffect(() => {
        if (pulling) {
            animRef.current = setInterval(() => {
                setDisplayPct(prev => {
                    const target = targetPctRef.current;
                    if (prev >= target) return prev;
                    // Move 20% of the gap each tick for smooth easing
                    const step = Math.max(0.3, (target - prev) * 0.2);
                    return Math.min(target, prev + step);
                });
            }, 100);
        } else {
            if (animRef.current) clearInterval(animRef.current);
        }
        return () => { if (animRef.current) clearInterval(animRef.current); };
    }, [pulling]);

    // Cleanup polling on unmount
    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    // Auto-resume: check for running/pending fetch jobs on mount
    useEffect(() => {
        if (!user?.email) return;
        let cancelled = false;
        
        const checkRunningJobs = async () => {
            try {
                const jobs = await base44.entities.FetchJob.filter(
                    { user_email: user.email, status: 'running' },
                    '-created_date',
                    1
                );
                const jobList = Array.isArray(jobs) ? jobs : (jobs?.items || []);
                let job = jobList[0];
                
                // Also check pending
                if (!job) {
                    const pendingJobs = await base44.entities.FetchJob.filter(
                        { user_email: user.email, status: 'pending' },
                        '-created_date',
                        1
                    );
                    const pendingList = Array.isArray(pendingJobs) ? pendingJobs : (pendingJobs?.items || []);
                    job = pendingList[0];
                }
                
                if (job && !cancelled && !pulling) {
                    // If job already completed, skip resume
                    if (job.status === 'completed') {
                        console.log('[TerritoryPrompt] Job already completed, skipping resume');
                        return;
                    }
                    console.log('[TerritoryPrompt] Resuming running job:', job.id);
                    setPulling(true);
                    setPullProgress('Resuming data import...');
                    const pct = job.progress_pct || 0;
                    setPullPct(pct);
                    setDisplayPct(Math.max(pct - 5, 0)); // Start close to real progress instead of 0
                    targetPctRef.current = pct;
                    setEtaText('Resuming...');
                    pctHistoryRef.current = [];
                    startPolling(job.id);
                }
            } catch (e) {
                console.warn('[TerritoryPrompt] Error checking running jobs:', e);
            }
        };
        
        checkRunningJobs();
        return () => { cancelled = true; };
    }, [user?.email]);

    const hasPulledData = !!user?.has_pulled_data;
    const hasDefinedMarket = user?.has_defined_market || user?.territory_zip_codes?.length > 0;
    const isPaid = user?.subscription_status === 'active' || user?.is_owner;
    const pullCount = user?.area_pulls_count || 0;
    const maxPulls = 9999; // Beta mode — unlimited pulls for all users
    const canPullAgain = true; // Beta mode — no limits
    
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
                targetPctRef.current = pct;
                const fetched = d.total_fetched || 0;
                const expected = d.total_expected || 0;
                const inserted = d.total_inserted || 0;
                setTotalExpected(expected);

                // Detect delta pull from job status (important for resume)
                if (d.is_delta_pull && !isDeltaPull) {
                    setIsDeltaPull(true);
                }
                
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
                    // Immediately show 100% — skip animation
                    setPullPct(100);
                    targetPctRef.current = 100;
                    setDisplayPct(100);
                    setEtaText('');
                    setPullProgress('Complete!');
                    // Small delay so user sees 100% before we clear
                    await new Promise(r => setTimeout(r, 800));
                    setPulling(false);

                    const totalLoaded = (d.total_inserted || 0) + (d.total_existed || 0);
                    const deltaSavings = d.delta_savings;
                    const savingsMsg = deltaSavings?.savings_pct > 0 
                        ? ` Saved ${deltaSavings.savings_pct}% on DB writes (${deltaSavings.records_skipped?.toLocaleString() || 0} unchanged records skipped)!` 
                        : '';
                    toast.success(`${totalLoaded.toLocaleString()} properties loaded!${savingsMsg} Tap "Generate Routes" to build your first route.`, { duration: 6000 });

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
        };

        // Start fast — poll every 1s for first 30s, then 2s after
        pollRef.current = setInterval(doPoll, 1000);
        // Also fire first poll immediately
        doPoll();
    };

    const handleFetchData = async () => {
        // Don't allow double-trigger
        if (pulling) return;
        
        // Check pull limit on frontend too for instant feedback
        // Beta mode — no pull limits enforced on frontend
        // if (!canPullAgain) { ... }

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
        setDisplayPct(0);
        targetPctRef.current = 2;
        setEtaText('Initializing...');
        setTotalExpected(0);
        pctHistoryRef.current = [];

        try {
            const res = await base44.functions.invoke('fetchAreaProperties', {
                latitude: centerLat,
                longitude: centerLng,
                radius: radius,
                polygon: drawnPolygon,
                sold_months: fetchMonths
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
                targetPctRef.current = 10;
                setPullProgress('Resuming existing fetch...');
                startPolling(d.job_id);
                return;
            }

            if (d.status === 'started' && d.job_id) {
                if (d.is_delta_pull) {
                    setIsDeltaPull(true);
                    toast.success('Smart refresh — only pulling changes since last import!');
                } else {
                    toast.success('Pulling property data now!');
                }
                targetPctRef.current = 5;
                setPullProgress(d.is_delta_pull ? 'Delta sync — fetching only new & changed records...' : 'Scanning property records...');
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
                <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[2000] bg-black/85 backdrop-blur-md border border-yellow-500/40 rounded-xl px-2.5 py-1.5 shadow-xl flex items-center gap-2 animate-in slide-in-from-top-4 max-w-xs">
                    <Pencil className="w-3 h-3 text-yellow-500 shrink-0" />
                    <p className="text-[10px] font-bold text-white whitespace-nowrap">Tap map</p>
                    <select
                        value={drawShape === 'circle' && drawSizeMiles === 5 ? 'test' : (drawShape || 'circle')}
                        onChange={(e) => {
                            if (e.target.value === 'test') {
                                setDrawShape('circle');
                                setDrawSizeMiles(5);
                            } else {
                                setDrawShape(e.target.value);
                                if (drawSizeMiles === 5) setDrawSizeMiles(10);
                            }
                        }}
                        className="bg-gray-900 border border-gray-700 text-white text-[10px] rounded-md px-1.5 py-0.5 h-6"
                    >
                        {!hasPulledData && <option value="test">Test (5mi²)</option>}
                        <option value="circle">Circle</option>
                        <option value="square">Square</option>
                    </select>
                    <button
                        onClick={() => { setDrawingMode(false); setDraftPolygon([]); }}
                        className="w-5 h-5 rounded-full bg-red-500/20 text-red-500 hover:bg-red-500 hover:text-white flex items-center justify-center shrink-0"
                    >
                        <X className="w-3 h-3" />
                    </button>
                </div>
            )}

            {/* Pull Progress Bar */}
            {pulling && (
                <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[2000] w-11/12 max-w-sm animate-in fade-in">
                    <div className="bg-black/90 backdrop-blur-md border border-blue-500/50 rounded-xl p-4 shadow-2xl">
                        <div className="flex items-center gap-3 mb-2">
                            <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                            <div className="flex-1">
                                <p className="text-xs font-bold text-white">
                                    {isDeltaPull ? '⚡ Smart Refresh (Delta Sync)' : 'Importing Property Data'}
                                </p>
                                <p className="text-[10px] text-gray-400">{pullProgress}</p>
                            </div>
                            <span className="text-sm font-mono font-bold text-blue-400">{Math.round(displayPct)}%</span>
                        </div>
                        <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-300 ease-out"
                                style={{ width: `${Math.max(displayPct, 2)}%` }}
                            />
                        </div>
                        {etaText && (
                            <p className="text-[11px] text-cyan-400 font-semibold mt-2 text-center">
                                ⏱ {etaText}
                            </p>
                        )}
                        <div className="mt-2 bg-gray-900/80 rounded-lg p-2.5 border border-gray-800">
                            <p className="text-[10px] text-gray-300 leading-relaxed text-center">
                                {isDeltaPull 
                                    ? (displayPct < 30
                                        ? '⚡ Only fetching records that changed since your last pull — much faster!'
                                        : displayPct < 80
                                            ? '🔄 Comparing against your existing data — unchanged records are skipped automatically.'
                                            : '✅ Delta sync almost complete! Only new & changed properties were written.')
                                    : (displayPct < 5
                                        ? '🔍 Scanning your area for every property on record — this is a one-time setup that gives you the full picture.'
                                        : displayPct < 30
                                            ? '📦 Pulling property data in batches from public records. Larger areas have more homes to process.'
                                            : displayPct < 70
                                                ? '⚡ Deduplicating and writing to your database. You can close this page — it will keep running.'
                                                : displayPct < 95
                                                    ? '🏁 Almost there! Writing final records and updating your territory map.'
                                                    : '✅ Wrapping up! Your territory will be ready in seconds.')}
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
                <div className="absolute top-11 sm:top-16 left-1 sm:left-4 z-[1001] bg-black/90 backdrop-blur-md border border-gray-800 rounded-full px-3 py-1.5 sm:px-4 sm:py-2 shadow-2xl flex items-center gap-2 sm:gap-3 animate-in fade-in slide-in-from-top-2">
                    <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse shrink-0" />
                    <span className="text-xs font-bold text-white whitespace-nowrap">Custom Area Active</span>
                    {canPullAgain ? (
                        <div className="flex items-center gap-2 ml-2">
                            <select
                                value={fetchMonths}
                                onChange={(e) => setFetchMonths(Number(e.target.value))}
                                className="bg-gray-900 border border-gray-700 text-white text-[10px] rounded-md px-1.5 py-0.5 h-6"
                                disabled={pulling}
                            >
                                <option value={0.25}>Past 1 Wk</option>
                                <option value={6}>Past 6 Mo</option>
                                <option value={12}>Past 12 Mo</option>
                                <option value={24}>Past 24 Mo</option>
                                <option value={36}>Past 36 Mo</option>
                            </select>
                            <Button
                                disabled={pulling}
                                onClick={handleFetchData}
                                className="text-white text-[10px] h-6 px-2 py-0 rounded-md bg-blue-600 hover:bg-blue-500"
                            >
                                Fetch data
                            </Button>
                        </div>
                    ) : (
                        <Button
                            disabled={pulling}
                            onClick={handleFetchData}
                            className="text-white text-[10px] h-6 px-2 py-0 rounded-md bg-blue-600 hover:bg-blue-500"
                        >
                            Fetch data
                        </Button>
                    )}
                    <button
                        onClick={() => { setDrawnPolygon(null); setDraftPolygon([]); }}
                        className="text-gray-400 hover:text-red-500 transition-colors p-1 bg-white/5 rounded-full"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                    {canPullAgain && (
                        <div className="absolute top-full left-0 mt-2 w-48 bg-black/90 border border-gray-800 rounded-lg p-2 shadow-xl animate-in fade-in slide-in-from-top-1">
                            <p className="text-[9px] text-gray-400 leading-tight">
                                <span className="text-blue-400 font-bold">Note:</span> Public records have a <span className="text-white">1-3 month recording lag</span>. Very recent sales may not appear until digitized by the county.
                            </p>
                        </div>
                    )}
                </div>
            )}
        </>
    );
}