import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { base44 } from '@/api/base44Client';
import { Map as MapIcon, Pencil, X, Trash2, Loader2, List, Zap, Lock, ArrowRight, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { calculatePolygonAreaSqMiles, formatSqMiles } from '@/components/logic/geoArea';
import { savePolygonToHistory } from '@/components/map/PolygonHistory';


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
  const navigate = useNavigate();
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState('');
  const [fetchMonths, setFetchMonths] = useState(() => user?.pull_months_back || 12);
  const [pullPct, setPullPct] = useState(0);
  const [displayPct, setDisplayPct] = useState(0);
  const [etaText, setEtaText] = useState('');
  const [totalExpected, setTotalExpected] = useState(0);
  const [isDeltaPull, setIsDeltaPull] = useState(false);
  const [forceFullRefresh, setForceFullRefresh] = useState(false);
  const [selectedHistoryArea, setSelectedHistoryArea] = useState(null);
  const [recoverableJob, setRecoverableJob] = useState(null);
  const [requestedPropertyCount, setRequestedPropertyCount] = useState(50);
  const [previewResult, setPreviewResult] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [paidPullStarting, setPaidPullStarting] = useState(false);
  const [routeMode, setRouteMode] = useState(() => {
    try {return localStorage.getItem('fk_routeMode') || 'precision';} catch {return 'precision';}
  });
  // v15: MLS Phase 2 always runs with verification — no toggle needed
  const pollRef = useRef(null);
  const activeJobIdRef = useRef(null);
  const animRef = useRef(null);
  const pctHistoryRef = useRef([]);
  const targetPctRef = useRef(0);
  const restoredCompletedJobRef = useRef(false);

  // Smooth progress animation — ticks display forward toward real target
  useEffect(() => {
    if (pulling) {
      animRef.current = setInterval(() => {
        setDisplayPct((prev) => {
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
    return () => {if (animRef.current) clearInterval(animRef.current);};
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
        const jobList = Array.isArray(jobs) ? jobs : jobs?.items || [];
        let job = jobList[0];

        // Also check pending
        if (!job) {
          const pendingJobs = await base44.entities.FetchJob.filter(
            { user_email: user.email, status: 'pending' },
            '-created_date',
            1
          );
          const pendingList = Array.isArray(pendingJobs) ? pendingJobs : pendingJobs?.items || [];
          job = pendingList[0];
        }

        if (!job) {
          const failedJobs = await base44.entities.FetchJob.filter(
            { user_email: user.email, status: 'failed' },
            '-updated_date',
            1
          );
          const failedList = Array.isArray(failedJobs) ? failedJobs : failedJobs?.items || [];
          const failedJob = failedList[0];
          if (failedJob && !cancelled) {
            const dismissedKey = `fk_dismissedRecoverableJob_${failedJob.id}`;
            if (localStorage.getItem(dismissedKey) !== '1') {
              setRecoverableJob(failedJob);
            }
          }
          return;
        }

        setRecoverableJob(null);
        if (job && !cancelled && !pulling) {
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
        console.warn('[TerritoryPrompt] Error checking running/completed jobs:', e);
      }
    };

    checkRunningJobs();
    return () => {cancelled = true;};
  }, [user?.email, drawnPolygon]);

  // Clear unqueried restored areas so draft polygons do not come back as ghost map areas.
  useEffect(() => {
    const restoredPolygon = localStorage.getItem('fk_drawnPolygon');
    if (drawnPolygon?.length > 2 && restoredPolygon && localStorage.getItem('fk_drawnPolygonQueried') !== 'true') {
      localStorage.removeItem('fk_drawnPolygon');
      setDrawnPolygon(null);
    }
  }, [drawnPolygon, setDrawnPolygon]);

  // Clear only in-progress drawing when switching away; keep the confirmed area
  // so users can return after a pull/reload and still generate routes for it.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fk-builder-mode-change', { detail: { mode } }));
    if (mode !== 'generate') {
      setDrawingMode(false);
      setDraftPolygon([]);
      setForceFullRefresh(false);
      setSelectedHistoryArea(null);
    }
  }, [mode]);

  useEffect(() => {
    const handler = (event) => setRouteMode(event.detail?.routeMode || 'precision');
    window.addEventListener('fk-route-mode-changed', handler);
    return () => window.removeEventListener('fk-route-mode-changed', handler);
  }, []);

  // Listen for toolbar draw button and previous-area selection events
  useEffect(() => {
    const drawHandler = () => {
      setDrawnPolygon(null);
      setDraftPolygon([]);
      setDrawingMode(true);
    };
    const historyHandler = (event) => {
      const polygon = event.detail?.polygon;
      if (!polygon || polygon.length < 3) return;
      setMode('generate');
      setDrawnPolygon(polygon);
      setDraftPolygon([]);
      setDrawingMode(false);
      setSelectedHistoryArea(event.detail || { polygon });
      setForceFullRefresh(false);
      toast.success('Previous area selected');
    };
    window.addEventListener('fk-start-drawing', drawHandler);
    window.addEventListener('fk-select-polygon-history', historyHandler);
    return () => {
      window.removeEventListener('fk-start-drawing', drawHandler);
      window.removeEventListener('fk-select-polygon-history', historyHandler);
    };
  }, [setMode, setDrawnPolygon, setDraftPolygon, setDrawingMode]);

  const stopMapTouch = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.nativeEvent?.stopImmediatePropagation?.();
  };

  const confirmDraftPolygon = (event) => {
    stopMapTouch(event);
    window.__fkSuppressMapFitUntil = Date.now() + 2500;
    if (!draftPolygon || draftPolygon.length < 3) {
      toast.error('Draw a complete area first.');
      return;
    }
    setDrawnPolygon(draftPolygon);
    setDraftPolygon([]);
    setDrawingMode(false);
    toast.success('Area selected. Run Sandbox Preview to check available data.');
  };

  const activeAreaPolygon = drawingMode && draftPolygon?.length > 2 ? draftPolygon : drawnPolygon;
  const actualAreaSqMiles = useMemo(() => calculatePolygonAreaSqMiles(activeAreaPolygon), [activeAreaPolygon]);
  const actualAreaLabel = actualAreaSqMiles > 0 ? formatSqMiles(actualAreaSqMiles) : `${drawSizeMiles}mi²`;
  const isLargeArea = actualAreaSqMiles >= 250 || drawSizeMiles === 300;

  const hasPulledData = !!user?.has_pulled_data;
  const hasDefinedMarket = user?.has_defined_market || user?.territory_zip_codes?.length > 0;
  const isPaid = user?.subscription_status === 'active' || user?.is_owner || user?.role === 'admin';
  const maxRequestedProperties = isPaid ? 1000 : 50;
  const safeRequestedPropertyCount = Math.max(1, Math.min(Number(requestedPropertyCount) || 1, maxRequestedProperties));
  const pullCount = user?.area_pulls_count || 0;
  const maxPulls = 9999; // unlimited for testing
  const canPullAgain = pullCount < maxPulls;

  const showInitialPrompt = hasPulledData && hasDefinedMarket && mode === 'generate' && !activeRoute && !routesGenerating && !showCompare && !showRoutePanel && !drawingMode && (!drawnPolygon || drawnPolygon.length === 0);

  const startPolling = (jobId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    activeJobIdRef.current = jobId;

    let pollCount = 0;
    const MAX_POLLS = 450; // ~30 minutes at slower intervals
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

      // After first 30s, slow polling to reduce backend rate-limit pressure.
      if (pollCount === 30) {
        clearInterval(pollRef.current);
        pollRef.current = setInterval(doPoll, 5000);
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
          activeJobIdRef.current = null;
          // Immediately show 100% — skip animation
          setPullPct(100);
          targetPctRef.current = 100;
          setDisplayPct(100);
          setEtaText('');
          setPullProgress('Complete!');
          // Small delay so user sees 100% before we clear
          await new Promise((r) => setTimeout(r, 800));
          setPulling(false);

          const totalLoaded = (d.total_inserted || 0) + (d.total_existed || 0);
          const deltaSavings = d.delta_savings;
          const savingsMsg = deltaSavings?.savings_pct > 0 ?
          ` Saved ${deltaSavings.savings_pct}% on DB writes (${deltaSavings.records_skipped?.toLocaleString() || 0} unchanged records skipped)!` :
          '';
          toast.success(`${totalLoaded.toLocaleString()} properties loaded!${savingsMsg} Tap "Generate Routes" to build your first route.`, { duration: 6000 });

          // Update user status
          try {
            await base44.auth.updateMe({
              has_pulled_data: true,
              territory_property_count: totalLoaded,
              last_data_pull: new Date().toISOString()
            });
          } catch (e) {console.warn('Failed to update pull status', e);}

          // Signal to MapToolbar that data is now available for this territory
          window.dispatchEvent(new CustomEvent('fk-territory-data-ready'));

          if (onPullComplete) {
            setMode('generate');
            setShowRoutePanel(false);
            await onPullComplete(fetchMonths, isPaid);
            setMode('generate');
            setShowCompare(true);
          } else {
            queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
            queryClient.invalidateQueries({ queryKey: ['user'] });
            setMode('generate');
            setShowRoutePanel(false);
            setShowCompare(true);
          }
        } else if (d.status === 'cancelled') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          activeJobIdRef.current = null;
          setPulling(false);
          setEtaText('');
          setPullProgress('Cancelled');
          toast.info('Data import cancelled.');
        } else if (d.status === 'failed') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          activeJobIdRef.current = null;
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

  const handleCancelImport = async () => {
    const jobId = activeJobIdRef.current;
    if (!jobId) {
      setPulling(false);
      return;
    }
    if (!confirm('Cancel this data import? Any data already saved will stay, but no more records will be added.')) return;
    await base44.functions.invoke('cancelFetchJob', { job_id: jobId });
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    activeJobIdRef.current = null;
    setPulling(false);
    setEtaText('');
    setPullProgress('Cancelled');
    queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
    toast.info('Data import cancelled.');
  };

  const retryRecoverableJob = async () => {
    if (!recoverableJob) return;
    setRecoverableJob(null);
    setPulling(true);
    setPullProgress('Retrying incomplete import from last checkpoint...');
    setPullPct(recoverableJob.progress_pct || 0);
    setDisplayPct(Math.max((recoverableJob.progress_pct || 0) - 5, 0));
    targetPctRef.current = recoverableJob.progress_pct || 0;
    setEtaText('Retrying...');
    const res = await base44.functions.invoke('fetchAreaProperties', {
      latitude: recoverableJob.latitude,
      longitude: recoverableJob.longitude,
      radius: recoverableJob.radius,
      polygon: recoverableJob.polygon || [],
      sold_months: recoverableJob.sold_months || fetchMonths,
      include_mls: recoverableJob.include_mls !== false,
      force_full_refresh: recoverableJob.force_full_refresh || false
    });
    const data = res.data || {};
    startPolling(data.job_id || recoverableJob.id);
  };

  const handleFetchData = async () => {
    if (previewLoading || pulling) return;
    if (!drawnPolygon || drawnPolygon.length < 3) {
      toast.error('Draw a freehand area first.');
      return;
    }

    setPreviewLoading(true);
    setPreviewResult(null);

    try {
      const res = await base44.functions.invoke('previewBatchDataArea', {
        polygon: drawnPolygon,
        requested_properties: safeRequestedPropertyCount,
        sandbox: true,
        sandbox_probe: true
      });
      const d = res.data || {};
      setPreviewResult(d);

      if (d.error || d.hard_rejected) {
        toast.error(d.message || d.rejection_reason || d.error || 'Area rejected. Please redraw smaller.');
        return;
      }

      savePolygonToHistory(drawnPolygon);
      localStorage.setItem('fk_drawnPolygonQueried', 'true');
      setDrawnPolygon(drawnPolygon, true);
      window.dispatchEvent(new CustomEvent('fk-polygon-history-updated'));
      toast.success(`Sandbox preview ready: ${d.returned_property_count || safeRequestedPropertyCount} properties allowed. No paid BatchData credits used.`);
    } catch (e) {
      const msg = e.response?.data?.message || e.message;
      toast.error(`Sandbox preview failed: ${msg}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handlePaidBatchDataPull = async () => {
    if (paidPullStarting || pulling) return;
    if (!drawnPolygon || drawnPolygon.length < 3) {
      toast.error('Draw a freehand area first.');
      return;
    }

    setPaidPullStarting(true);
    try {
      const res = await base44.functions.invoke('startBatchDataPull', {
        polygon: drawnPolygon,
        requested_properties: safeRequestedPropertyCount,
        sold_months: fetchMonths
      });
      const data = res.data || {};
      if (data.error) {
        toast.error(data.message || data.error);
        return;
      }
      savePolygonToHistory(drawnPolygon);
      localStorage.setItem('fk_drawnPolygonQueried', 'true');
      setDrawnPolygon(drawnPolygon, true);
      window.dispatchEvent(new CustomEvent('fk-polygon-history-updated'));
      setPulling(true);
      setPullPct(0);
      setDisplayPct(0);
      targetPctRef.current = 0;
      setPullProgress('Starting paid BatchData pull...');
      setEtaText('Starting...');
      startPolling(data.job_id);
      toast.success(data.message || 'Paid BatchData pull started.');
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      toast.error(`Paid BatchData pull failed: ${msg}`);
    } finally {
      setPaidPullStarting(false);
    }
  };

  return (
    <>
            {/* Simple prompt for returning users who already have data */}
            {/* Returning user prompt — skip straight to map, no modal blocking */}

            {/* Active Drawing Controls */}
            {drawingMode &&
      <div
        className="absolute top-3 left-3 right-3 sm:top-16 sm:left-4 sm:right-auto z-[2000] animate-in slide-in-from-top-4"
        onPointerDown={stopMapTouch}
        onTouchStart={stopMapTouch}
        onMouseDown={stopMapTouch}
      >
                    <div className="bg-black/85 backdrop-blur-md border border-yellow-500/30 rounded-2xl px-3 py-2 shadow-2xl flex flex-wrap items-center gap-2 max-w-[calc(100vw-1.5rem)] sm:max-w-[640px]">
                        <div className="flex items-center gap-2 shrink-0">
                            <div className="w-6 h-6 rounded-full bg-yellow-500/20 flex items-center justify-center">
                                <Pencil className="w-3 h-3 text-yellow-400" />
                            </div>
                            <span className="text-xs font-bold text-white whitespace-nowrap">Draw Territory</span>
                        </div>

                        <div className="flex flex-col gap-0.5 min-w-[210px] flex-1">
                            <span className="text-[10px] text-yellow-400 font-bold">Freehand draw mode</span>
                            <span className="text-[10px] text-gray-400 leading-tight">Hold and drag on the map to outline the area, then tap the checkmark.</span>
                        </div>

                        {draftPolygon?.length > 2 &&
          <button
            type="button"
            onPointerDown={stopMapTouch}
            onPointerUp={confirmDraftPolygon}
            onTouchStart={stopMapTouch}
            onTouchEnd={(event) => {
              if (!window.PointerEvent) confirmDraftPolygon(event);
            }}
            onMouseDown={stopMapTouch}
            onClick={stopMapTouch}
            className="w-10 h-10 rounded-full bg-green-500 hover:bg-green-400 text-black flex items-center justify-center transition-all shrink-0 shadow-[0_0_18px_rgba(34,197,94,0.45)] touch-manipulation"
            aria-label="Confirm drawn area">
            
                                <Check className="w-5 h-5" />
                            </button>
          }

                        <div className="hidden sm:flex items-center gap-2 px-2 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 shrink-0">
                            <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                            <span className="text-[10px] font-bold text-cyan-300">BatchData Sandbox</span>
                        </div>

                        <button
            onClick={() => {setDrawingMode(false);setDraftPolygon([]);}}
            className="ml-auto w-7 h-7 rounded-full bg-white/5 hover:bg-red-500/20 text-gray-500 hover:text-red-400 flex items-center justify-center transition-all shrink-0">
            
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                </div>
      }

            {/* Recover incomplete fetch job */}
            {!pulling && recoverableJob && mode === 'generate' &&
      <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[2000] w-11/12 max-w-sm animate-in fade-in">
                    <div className="bg-black/90 backdrop-blur-md border border-yellow-500/50 rounded-xl p-4 shadow-2xl">
                        <p className="text-xs font-bold text-white mb-1">Incomplete data pull found</p>
                        <p className="text-[10px] text-gray-400 mb-3">Your last import stopped at {Math.round(recoverableJob.progress_pct || 0)}%. Retry resumes from the saved job instead of starting a new full pull.</p>
                        <div className="flex gap-2">
                            <Button onClick={retryRecoverableJob} className="h-8 flex-1 text-xs bg-yellow-500 text-black hover:bg-yellow-400">Retry Import</Button>
                            <Button
              onClick={() => {
                if (recoverableJob?.id) {
                  localStorage.setItem(`fk_dismissedRecoverableJob_${recoverableJob.id}`, '1');
                }
                setRecoverableJob(null);
              }}
              variant="outline"
              className="h-8 text-xs">
              
                                Dismiss
                            </Button>
                        </div>
                    </div>
                </div>
      }

            {/* Pull Progress Bar */}
            {pulling &&
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
              style={{ width: `${Math.max(displayPct, 2)}%` }} />
            
                        </div>
                        {etaText &&
          <p className="text-[11px] text-cyan-400 font-semibold mt-2 text-center">
                                ⏱ {etaText}
                            </p>
          }
                        <div className="mt-2 bg-gray-900/80 rounded-lg p-2.5 border border-gray-800">
                            <p className="text-[10px] text-gray-300 leading-relaxed text-center">
                                {isDeltaPull ?
              displayPct < 30 ?
              '⚡ Smart sync — only fetching what changed since your last pull.' :
              displayPct < 80 ?
              '🔄 Skipping unchanged records — writing only what is new.' :
              '✅ Almost done! Only fresh leads are being added.' :
              displayPct < 5 ?
              '🗺️ Mapping every door in your territory — one-time setup.' :
              displayPct < 30 ?
              '📦 Fetching property records in batches. Bigger areas take a little longer.' :
              displayPct < 70 ?
              '⚡ Deduplicating leads. Feel free to close — this keeps running in the background.' :
              displayPct < 95 ?
              '🏁 Almost there! Writing your final records to the map.' :
              '✅ Done! Your territory is ready to route.'}
                            </p>
                        </div>
                        <div className="mt-3 flex items-center justify-center">
                            <button
              onClick={handleCancelImport}
              className="px-4 py-1.5 rounded-lg text-[10px] font-bold tracking-wide border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors">
              
                                Cancel Import
                            </button>
                        </div>
                        <p className="text-[9px] text-gray-600 mt-1.5 text-center">
                            Safe to leave — data imports continue in the background unless cancelled
                        </p>
                    </div>
                </div>
      }

            {/* Drawn Polygon Controls */}
            {!drawingMode && !pulling && routeMode === 'precision' && drawnPolygon && drawnPolygon.length > 2 && mode === 'generate' &&
      <div className="absolute top-3 sm:top-16 left-3 right-3 sm:left-4 sm:right-auto z-[1001] max-w-[calc(100vw-1.5rem)] sm:max-w-none backdrop-blur-md border border-gray-800 rounded-2xl sm:rounded-full p-3 sm:px-4 sm:py-2 shadow-2xl flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 animate-in fade-in slide-in-from-top-2 overflow-visible bg-[#000000]">
                    <div className="flex items-center gap-2 shrink-0">
                        <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse shrink-0" />
                        <span className="text-xs font-bold text-white whitespace-nowrap">Custom Area Active</span>
                    </div>
                    <div className="grid grid-cols-[auto_minmax(0,72px)_1fr] sm:flex sm:items-center gap-2 flex-1 sm:flex-none min-w-0 sm:ml-2">
                        <label className="text-[9px] text-gray-400 font-bold whitespace-nowrap">PROPERTIES</label>
                        <input
            type="number"
            min="1"
            max={maxRequestedProperties}
            value={requestedPropertyCount}
            onChange={(e) => {
              const value = e.target.value;
              if (value === '') {
                setRequestedPropertyCount('');
                return;
              }
              setRequestedPropertyCount(Math.min(Number(value) || 1, maxRequestedProperties));
            }}
            onBlur={() => setRequestedPropertyCount(safeRequestedPropertyCount)}
            className="w-full sm:w-16 h-9 sm:h-6 bg-white/5 border border-white/10 rounded-md px-2 text-[12px] sm:text-[11px] text-white outline-none" />
          
                        <Button
            disabled={paidPullStarting || pulling}
            onClick={handlePaidBatchDataPull}
            className="text-black text-[10px] h-9 sm:h-6 px-2 sm:px-3 py-0 rounded-md font-bold tracking-wide bg-yellow-500 hover:bg-yellow-400 shadow-[0_0_15px_rgba(234,179,8,0.35)] flex-1 sm:flex-none min-w-0">
            
                            {paidPullStarting ? 'Starting...' : 'Pull Data'}
                        </Button>
                    </div>
                    <button
          onClick={() => {setDrawnPolygon(null);setDraftPolygon([]);setDrawingMode(false);}}
          className="absolute top-2 right-2 sm:static text-gray-400 hover:text-red-500 transition-colors p-2 sm:p-1 bg-white/5 rounded-full shrink-0 ml-auto sm:ml-0">
          
                        <Trash2 className="w-3 h-3" />
                    </button>
                    <div className="static sm:absolute sm:top-full sm:left-0 sm:right-auto mt-1 sm:mt-2 w-full sm:w-72 bg-white/5 sm:bg-black/90 border border-gray-800 rounded-xl sm:rounded-lg p-2 shadow-xl animate-in fade-in slide-in-from-top-1">
                        <p className="text-[9px] text-gray-400 leading-tight">
                            <span className="text-blue-400 font-bold">Area:</span> selected freehand polygon is about <span className="text-white">{actualAreaLabel}</span>.
                            <br /><span className="text-cyan-300 font-bold">Firstknock:</span> pulls up to <span className="text-white">{maxRequestedProperties}</span> properties for this account.
                            {previewResult &&
            <span className="block mt-1 text-white">
                                    {previewResult.hard_rejected ?
              `Rejected: ${previewResult.rejection_reason || previewResult.message}` :
              `Allowed: ${previewResult.returned_property_count || safeRequestedPropertyCount} properties · ${previewResult.area_sq_mi} sq mi`}
                                </span>
            }
                        </p>
                    </div>
                </div>
      }
        </>);

}