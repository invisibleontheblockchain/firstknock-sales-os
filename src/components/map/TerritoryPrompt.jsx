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
import PrecisionPullPanel from '@/components/map/PrecisionPullPanel';

function isPrecisionProUser(user) {
  const tier = String(user?.subscription_tier || '').toLowerCase();
  const status = String(user?.subscription_status || '').toLowerCase();
  if (user?.is_owner || user?.role === 'admin') return true;
  return ['active', 'trialing'].includes(status) && ['pro', 'precision'].includes(tier);
}

function hasConfirmedPaidPrecisionAccess(user) {
  const tier = String(user?.subscription_tier || '').toLowerCase();
  const status = String(user?.subscription_status || '').toLowerCase();
  if (user?.is_owner || user?.role === 'admin') return true;
  return status === 'active' && user?.subscription_paid_confirmed === true && ['pro', 'precision'].includes(tier);
}

function formatWholeNumber(value) {
  const number = Math.max(0, Math.round(Number(value) || 0));
  return number.toLocaleString();
}

function formatSoldWindow(months) {
  const value = Number(months);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 1) {
    const days = Math.max(1, Math.round(value * 30));
    if (days <= 2) return `${days} day${days === 1 ? '' : 's'} sold window`;
    const weeks = Math.max(1, Math.round(days / 7));
    return `${weeks} week${weeks === 1 ? '' : 's'} sold window`;
  }
  const label = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${label} month${value === 1 ? '' : 's'} sold window`;
}

function buildPrecisionShortfallMessage({ loadedCount, requestedCount, intendedCount, diagnostics, soldMonths, minHomeValue, maxHomeValue }) {
  const loaded = Math.max(0, Number(loadedCount) || 0);
  const requested = Math.max(0, Number(requestedCount) || 0);
  const intended = Math.max(requested, Number(intendedCount) || 0);

  if (diagnostics?.limited_by_free_home_cap && requested > 0 && intended > requested) {
    return `This pull was capped at ${formatWholeNumber(requested)} homes because that is all the included Precision homes left on this account. Upgrade to Precision for larger routes.`;
  }

  if (requested <= 0 || loaded >= requested) return null;

  const filters = [];
  const soldWindow = formatSoldWindow(soldMonths ?? diagnostics?.sold_months);
  if (soldWindow) filters.push(soldWindow);

  const minValue = Number(minHomeValue ?? diagnostics?.filters?.min_price);
  if (Number.isFinite(minValue) && minValue > 0) filters.push(`minimum value $${formatWholeNumber(minValue)}`);

  const maxValue = Number(maxHomeValue ?? diagnostics?.filters?.max_price);
  if (Number.isFinite(maxValue) && maxValue > 0) filters.push(`maximum value $${formatWholeNumber(maxValue)}`);

  const filterText = filters.length ? ` with your ${filters.join(', ')}` : '';
  const summary = diagnostics?.batchdata_summary || {};
  const reviewed = Number(summary.reviewed || 0);
  const skippedExisting = Number(summary.skipped_existing_route || 0);
  const reviewedText = reviewed > 0 ? ` We checked ${formatWholeNumber(reviewed)} provider records.` : '';
  const skippedText = skippedExisting > 0 ? ` We skipped ${formatWholeNumber(skippedExisting)} homes already in saved routes.` : '';
  const nextStep = skippedExisting > 0
    ? 'Draw beyond the previous route area or widen the boundary to reach new homes.'
    : 'Draw a larger area, widen the sold-date range, or loosen the value range, then generate again to keep filling the route.';

  return `Found ${formatWholeNumber(loaded)} new qualifying sold homes in this area${filterText}; you requested ${formatWholeNumber(requested)}.${reviewedText}${skippedText} ${nextStep}`;
}

function countUniquePrecisionRouteHomes(routes = []) {
  const hashes = new Set();
  routes.forEach((route) => {
    if (!route || route.route_mode === 'canvas' || route.status === 'ARCHIVED') return;
    (route.property_hashes || []).forEach((hash) => {
      if (hash) hashes.add(hash);
    });
  });
  return hashes.size;
}

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
  savedRoutes = [],
  savedRoutesLoaded = false,
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
  const [repullMode, setRepullMode] = useState('fill_gaps');
  const [includeUnresolvedFollowUps, setIncludeUnresolvedFollowUps] = useState(true);
  const [recoverableJob, setRecoverableJob] = useState(null);
  const [requestedPropertyCount, setRequestedPropertyCount] = useState(50);
  const [propertyCountMode, setPropertyCountMode] = useState('max_available');
  const [minHomeValue, setMinHomeValue] = useState(100000);
  const [maxHomeValue, setMaxHomeValue] = useState('');
  const [showPrecisionPullPanel, setShowPrecisionPullPanel] = useState(false);
  const [pullError, setPullError] = useState(null); // { message, upgrade } — persistent in-panel error, not a transient toast
  const [previewResult, setPreviewResult] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [paidPullStarting, setPaidPullStarting] = useState(false);
  const [routeMode, setRouteMode] = useState(() => {
    try {return localStorage.getItem('fk_routeMode') || 'precision';} catch {return 'precision';}
  });
  const [ghostAreasVisible, setGhostAreasVisible] = useState(() => {
    try {return localStorage.getItem('fk_showGhostAreas') === 'true';} catch {return false;}
  });
  // v15: MLS Phase 2 always runs with verification — no toggle needed
  const pollRef = useRef(null);
  const activeJobIdRef = useRef(null);
  const animRef = useRef(null);
  const pctHistoryRef = useRef([]);
  const targetPctRef = useRef(0);
  const restoredCompletedJobRef = useRef(false);
  const pullIntentRef = useRef({});

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

  useEffect(() => {
    const handler = (event) => {
      const visible = !!event.detail?.visible;
      setGhostAreasVisible(visible);
      if (!visible) {
        setSelectedHistoryArea(null);
        setRepullMode('fill_gaps');
        setForceFullRefresh(false);
        setIncludeUnresolvedFollowUps(true);
      }
    };
    window.addEventListener('fk-ghost-areas-visibility', handler);
    return () => window.removeEventListener('fk-ghost-areas-visibility', handler);
  }, []);

  useEffect(() => {
    if (!selectedHistoryArea) return;
    const historyPolygon = selectedHistoryArea.polygon || [];
    const samePolygon = ghostAreasVisible && drawnPolygon?.length === historyPolygon.length && drawnPolygon.every((point, index) => {
      const historyPoint = historyPolygon[index] || {};
      return Math.abs(Number(point.lat) - Number(historyPoint.lat)) < 0.000001 && Math.abs(Number(point.lng) - Number(historyPoint.lng)) < 0.000001;
    });
    if (!samePolygon) {
      setSelectedHistoryArea(null);
      setRepullMode('fill_gaps');
      setForceFullRefresh(false);
      setIncludeUnresolvedFollowUps(true);
    }
  }, [drawnPolygon, ghostAreasVisible, selectedHistoryArea]);

  // Listen for toolbar draw button and previous-area selection events
  useEffect(() => {
    const drawHandler = () => {
      setDrawnPolygon(null);
      setDraftPolygon([]);
      setSelectedHistoryArea(null);
      setRepullMode('fill_gaps');
      setForceFullRefresh(false);
      setIncludeUnresolvedFollowUps(true);
      setDrawingMode(true);
    };
    const precisionPullHandler = () => {
      if (!drawnPolygon || drawnPolygon.length < 3) {
        toast.error('Draw a freehand area first.');
        return;
      }
      setMode('generate');
      setShowCompare(false);
      setShowRoutePanel(false);
      if (!ghostAreasVisible) {
        setSelectedHistoryArea(null);
        setRepullMode('fill_gaps');
        setForceFullRefresh(false);
        setIncludeUnresolvedFollowUps(true);
      }
      setShowPrecisionPullPanel(true);
    };
    const historyHandler = (event) => {
      let ghostOn = false;
      try {ghostOn = localStorage.getItem('fk_showGhostAreas') === 'true';} catch {}
      if (!ghostOn) return;
      const polygon = event.detail?.polygon;
      if (!polygon || polygon.length < 3) return;
      setMode('generate');
      const historyEntry = event.detail || { polygon };
      const criteria = historyEntry.criteria || {};
      setDrawnPolygon(polygon);
      setDraftPolygon([]);
      setDrawingMode(false);
      setSelectedHistoryArea(historyEntry);
      setRepullMode('fill_gaps');
      setForceFullRefresh(true);
      setIncludeUnresolvedFollowUps(true);
      if (criteria.requested_properties) setRequestedPropertyCount(criteria.requested_properties);
      if (criteria.sold_months) setFetchMonths(criteria.sold_months);
      if (criteria.min_price !== undefined && criteria.min_price !== null) setMinHomeValue(criteria.min_price);
      if (criteria.max_price !== undefined && criteria.max_price !== null) setMaxHomeValue(criteria.max_price || '');
      setShowPrecisionPullPanel(true);
      toast.success('Previous area selected');
    };
    window.addEventListener('fk-start-drawing', drawHandler);
    window.addEventListener('fk-open-precision-pull', precisionPullHandler);
    window.addEventListener('fk-select-polygon-history', historyHandler);
    return () => {
      window.removeEventListener('fk-start-drawing', drawHandler);
      window.removeEventListener('fk-open-precision-pull', precisionPullHandler);
      window.removeEventListener('fk-select-polygon-history', historyHandler);
    };
  }, [setMode, setDrawnPolygon, setDraftPolygon, setDrawingMode, setShowCompare, setShowRoutePanel, drawnPolygon, ghostAreasVisible]);

  const stopMapTouch = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.nativeEvent?.stopImmediatePropagation?.();
  };

  const monthsSinceHistoryPull = (value) => {
    const date = value ? new Date(value) : null;
    const ms = date && !isNaN(date.getTime()) ? Date.now() - date.getTime() : 30 * 24 * 60 * 60 * 1000;
    const days = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
    return Math.max(1 / 30, Math.min(12, days / 30));
  };

  const confirmDraftPolygon = (event) => {
    stopMapTouch(event);
    window.__fkSuppressMapFitUntil = Date.now() + 8000;
    if (!draftPolygon || draftPolygon.length < 3) {
      toast.error('Draw a complete area first.');
      return;
    }
    setDrawnPolygon(draftPolygon);
    setDraftPolygon([]);
    setSelectedHistoryArea(null);
    setRepullMode('fill_gaps');
    setForceFullRefresh(false);
    setIncludeUnresolvedFollowUps(true);
    setDrawingMode(false);
    toast.success('Area selected. Run Preview to check available data.');
  };

  const activeAreaPolygon = drawingMode && draftPolygon?.length > 2 ? draftPolygon : drawnPolygon;
  const actualAreaSqMiles = useMemo(() => calculatePolygonAreaSqMiles(activeAreaPolygon), [activeAreaPolygon]);
  const actualAreaLabel = actualAreaSqMiles > 0 ? formatSqMiles(actualAreaSqMiles) : `${drawSizeMiles}mi²`;
  const isLargeArea = actualAreaSqMiles >= 250 || drawSizeMiles === 300;

  const hasPulledData = !!user?.has_pulled_data;
  const hasDefinedMarket = user?.has_defined_market || user?.territory_zip_codes?.length > 0;
  const isPaid = user?.subscription_status === 'active' || user?.subscription_status === 'trialing' || user?.is_owner || user?.role === 'admin';
  const freePropertyLimit = 50;
  const hasPaidPrecisionCapacity = hasConfirmedPaidPrecisionAccess(user);
  const routeDeliveredPropertiesUsed = useMemo(() => countUniquePrecisionRouteHomes(savedRoutes), [savedRoutes]);
  const accountReportedPropertiesUsed = Math.max(0, Number(user?.precision_properties_used ?? 0) || 0);
  const freePropertiesUsed = savedRoutesLoaded ? routeDeliveredPropertiesUsed : accountReportedPropertiesUsed;
  const freePropertiesRemaining = Math.max(0, freePropertyLimit - freePropertiesUsed);
  const maxRequestedProperties = hasPaidPrecisionCapacity ? 1000 : freePropertiesRemaining;
  const safeRequestedPropertyCount = maxRequestedProperties <= 0
    ? 0
    : Math.max(1, Math.min(Number(requestedPropertyCount) || 1, maxRequestedProperties));
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
        const phase = d.phase || '';
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

        const elapsedSec = Math.max(1, Math.round((Date.now() - pollStartTime) / 1000));
        if (pct < 100) {
          if (phase === 'batchdata_requesting') {
            setEtaText('Contacting property provider...');
          } else if (pct < 8 || elapsedSec < 10) {
            setEtaText('Starting import...');
          } else if (pct < 85) {
            setEtaText('Usually under 2 minutes');
          } else {
            setEtaText('Almost done');
          }
        }

        const readyCount = Math.max(d.active_count || 0, inserted + (d.total_existed || 0), inserted + (d.total_updated || 0));
        if (phase === 'batchdata_requesting' && fetched === 0) {
          setPullProgress(expected > 0
            ? `Contacting property provider for up to ${expected.toLocaleString()} homes...`
            : 'Contacting property provider...');
        } else if (expected > 0) {
          setPullProgress(`${fetched.toLocaleString()} of ${expected.toLocaleString()} records checked • ${readyCount.toLocaleString()} ready for routes`);
        } else {
          setPullProgress(`${fetched.toLocaleString()} records checked • ${readyCount.toLocaleString()} ready for routes`);
        }

        if (d.status === 'completed') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          activeJobIdRef.current = null;
          // Immediately show 100% — skip animation
          setPullPct(100);
          targetPctRef.current = 100;
          setDisplayPct(100);
          setEtaText('Building routes now');
          setPullProgress('Data ready — building optimized routes...');

          const totalLoaded = (d.active_count || 0) || (d.total_inserted || 0) + (d.total_existed || 0);
          const diagnostics = d.diagnostics || {};
          const intent = pullIntentRef.current[jobId] || {};
          const requestedCount = d.total_expected || diagnostics.requested_properties || 0;
          const intendedCount = intent.requestedCount || diagnostics.requested_properties_before_cap || requestedCount;
          const shortfallMessage = buildPrecisionShortfallMessage({
            loadedCount: totalLoaded,
            requestedCount,
            intendedCount,
            diagnostics,
            soldMonths: intent.soldMonths ?? diagnostics.sold_months ?? fetchMonths,
            minHomeValue: intent.minHomeValue ?? diagnostics.filters?.min_price,
            maxHomeValue: intent.maxHomeValue ?? diagnostics.filters?.max_price
          });
          if (shortfallMessage) {
            toast.info(shortfallMessage, { duration: 14000 });
          }
          toast.success(`${totalLoaded.toLocaleString()} properties ready. Building routes now...`, { duration: 4000 });

          // Update user status
          try {
            await base44.auth.updateMe({
              has_pulled_data: true,
              last_data_pull: new Date().toISOString()
            });
          } catch (e) {console.warn('Failed to update pull status', e);}

          // Signal to MapToolbar that data is now available for this territory
          window.dispatchEvent(new CustomEvent('fk-territory-data-ready'));

          if (onPullComplete) {
            setMode('generate');
            setShowRoutePanel(false);
            setShowCompare(false);
            await onPullComplete(fetchMonths, isPaid, d);
          } else {
            queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
            queryClient.invalidateQueries({ queryKey: ['user'] });
            setMode('generate');
            setShowRoutePanel(false);
            setShowCompare(false);
          }
          setPulling(false);
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

      savePolygonToHistory(drawnPolygon, {
        previewed_at: new Date().toISOString(),
        criteria: {
          requested_properties: d.requested_properties ?? safeRequestedPropertyCount,
          sold_months: fetchMonths,
          min_price: minHomeValue ? Number(minHomeValue) : null,
          max_price: maxHomeValue ? Number(maxHomeValue) : null
        }
      });
      localStorage.setItem('fk_drawnPolygonQueried', 'true');
      setDrawnPolygon(drawnPolygon, true);
      window.dispatchEvent(new CustomEvent('fk-polygon-history-updated'));
      toast.success(`Preview ready: up to ${(d.returned_property_count ?? safeRequestedPropertyCount).toLocaleString()} homes can be requested. Final count depends on sold homes in the area.`);
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

    const isPreviousAreaPull = ghostAreasVisible && !!selectedHistoryArea;
    const historyCriteria = isPreviousAreaPull ? selectedHistoryArea?.criteria || {} : {};
    const historyDate = isPreviousAreaPull ? selectedHistoryArea?.last_pull_date || selectedHistoryArea?.date : null;
    const effectiveSoldMonths = isPreviousAreaPull && repullMode === 'max_since_last' ? monthsSinceHistoryPull(historyDate) : Number(historyCriteria.sold_months || fetchMonths || 12);
    const usingMaxAvailable = (isPreviousAreaPull && repullMode === 'max_since_last') || propertyCountMode === 'max_available';
    const effectiveRequestedPropertyCount = usingMaxAvailable ? maxRequestedProperties : safeRequestedPropertyCount;
    const effectiveMinPrice = minHomeValue ? Number(minHomeValue) : null;
    const effectiveMaxPrice = maxHomeValue ? Number(maxHomeValue) : null;
    const premiumRecentRange = effectiveSoldMonths <= 1;
    const latestUser = (effectiveRequestedPropertyCount > freePropertyLimit || premiumRecentRange) ? await base44.auth.me() : user;
    const hasPaidPrecision = hasConfirmedPaidPrecisionAccess(latestUser);
    const hasPrecisionPro = isPrecisionProUser(latestUser);

    if (effectiveRequestedPropertyCount <= 0 && !hasPaidPrecision) {
      setPullError({
        message: 'Your current plan has used its included Precision homes. Upgrade to Precision to generate larger routes.',
        upgrade: true
      });
      return;
    }

    if (effectiveRequestedPropertyCount > freePropertyLimit && !hasPaidPrecision) {
      toast.info('Precision pulls over 50 houses require the paid $99/month Precision plan after the first payment clears.');
      setShowPrecisionPullPanel(false);
      navigate(createPageUrl('Billing') + '?plan=precision');
      return;
    }

    if (premiumRecentRange && !hasPrecisionPro) {
      toast.info('Your date range has been updated to 3 months. Upgrade to Pro for shorter ranges.');
      setFetchMonths(3);
      return;
    }

    setPaidPullStarting(true);
    setPullError(null);
    try {
      const res = await base44.functions.invoke('startBatchDataPull', {
        polygon: drawnPolygon,
        requested_properties: effectiveRequestedPropertyCount,
        count_mode: usingMaxAvailable ? 'max_available' : 'fixed',
        sold_months: effectiveSoldMonths,
        min_price: effectiveMinPrice,
        max_price: effectiveMaxPrice,
        force_full_refresh: isPreviousAreaPull ? repullMode === 'fill_gaps' || forceFullRefresh : false,
        include_unresolved_followups: isPreviousAreaPull ? includeUnresolvedFollowUps : false,
        repull_mode: isPreviousAreaPull ? repullMode : 'new_area',
        previous_pull_date: isPreviousAreaPull ? selectedHistoryArea?.last_pull_date || selectedHistoryArea?.date || null : null
      });
      const data = res.data || {};
      if (data.error) {
        const isPlanGate = ['trial_required', 'paid_precision_required', 'upgrade_required'].includes(data.error);
        setPullError({ message: data.message || data.error, upgrade: isPlanGate });
        return;
      }
      const startedRequestedCount = Number(data.requested_properties ?? effectiveRequestedPropertyCount) || effectiveRequestedPropertyCount;
      if (data.job_id) {
        pullIntentRef.current[data.job_id] = {
          requestedCount: effectiveRequestedPropertyCount,
          serverRequestedCount: startedRequestedCount,
          soldMonths: effectiveSoldMonths,
          minHomeValue: effectiveMinPrice,
          maxHomeValue: effectiveMaxPrice,
          limitedByFreeHomeCap: data.limited_by_free_home_cap === true
        };
      }
      savePolygonToHistory(drawnPolygon, {
        last_pull_date: new Date().toISOString(),
        job_id: data.job_id,
        repull_mode: isPreviousAreaPull ? repullMode : 'new_area',
        criteria: {
          requested_properties: data.requested_properties ?? effectiveRequestedPropertyCount,
          count_mode: usingMaxAvailable ? 'max_available' : 'fixed',
          sold_months: effectiveSoldMonths,
          min_price: effectiveMinPrice,
          max_price: effectiveMaxPrice,
          force_full_refresh: isPreviousAreaPull ? repullMode === 'fill_gaps' || forceFullRefresh : false,
          include_unresolved_followups: isPreviousAreaPull ? includeUnresolvedFollowUps : false
        }
      });
      localStorage.setItem('fk_drawnPolygonQueried', 'true');
      setDrawnPolygon(drawnPolygon, true);
      window.dispatchEvent(new CustomEvent('fk-polygon-history-updated'));
      setPulling(true);
      setPullPct(0);
      setDisplayPct(0);
      targetPctRef.current = 0;
      setPullProgress('Starting property import...');
      setEtaText('Starting import...');
      startPolling(data.job_id);
      setShowPrecisionPullPanel(false);
      toast.success(`Property import started for up to ${startedRequestedCount.toLocaleString()} homes. Routes will build automatically.`);
    } catch (e) {
      const errCode = e.response?.data?.error;
      const msg = e.response?.data?.message || errCode || e.message;
      const isPlanGate = e.response?.status === 403 || ['trial_required', 'paid_precision_required', 'upgrade_required'].includes(errCode);
      // Persistent in-panel error — a transient toast made blocked pulls look like a silent failure.
      setPullError({ message: msg, upgrade: isPlanGate });
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
                    <div className="bg-black/85 backdrop-blur-md border border-[#2EEB57]/30 rounded-2xl px-3 py-2 shadow-2xl flex flex-wrap items-center gap-2 max-w-[calc(100vw-1.5rem)] sm:max-w-[640px]">
                        <div className="flex items-center gap-2 shrink-0">
                            <div className="w-6 h-6 rounded-full bg-[#2EEB57]/20 flex items-center justify-center">
                                <Pencil className="w-3 h-3 text-[#39FF4A]" />
                            </div>
                            <span className="text-xs font-bold text-white whitespace-nowrap">Draw Territory</span>
                        </div>

                        <div className="flex flex-col gap-0.5 min-w-[210px] flex-1">
                            <span className="text-[10px] text-[#39FF4A] font-bold">Freehand draw mode</span>
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
                    <div className="bg-black/90 backdrop-blur-md border border-[#2EEB57]/50 rounded-xl p-4 shadow-2xl">
                        <p className="text-xs font-bold text-white mb-1">Incomplete data pull found</p>
                        <p className="text-[10px] text-gray-400 mb-3">Your last import stopped at {Math.round(recoverableJob.progress_pct || 0)}%. Retry resumes from the saved job instead of starting a new full pull.</p>
                        <div className="flex gap-2">
                            <Button onClick={retryRecoverableJob} className="h-8 flex-1 text-xs bg-[#2EEB57] text-black hover:bg-[#39FF4A]">Retry Import</Button>
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
                    <div className="bg-black/90 backdrop-blur-md border border-[#2EEB57]/50 rounded-xl p-4 shadow-2xl">
                        <div className="flex items-center gap-3 mb-2">
                            <Loader2 className="w-5 h-5 text-[#2EEB57] animate-spin shrink-0" />
                            <div className="flex-1">
                                <p className="text-xs font-bold text-white">
                                    {isDeltaPull ? '⚡ Smart Refresh (Delta Sync)' : 'Importing Property Data'}
                                </p>
                                <p className="text-[10px] text-gray-400">{pullProgress}</p>
                            </div>
                            <span className="text-sm font-mono font-bold text-[#2EEB57]">{Math.round(displayPct)}%</span>
                        </div>
                        <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                            <div
              className="h-full bg-gradient-to-r from-[#2EEB57] to-[#39FF4A] rounded-full transition-all duration-300 ease-out"
              style={{ width: `${Math.max(displayPct, 2)}%` }} />
            
                        </div>
                        {etaText &&
          <p className="text-[11px] text-[#39FF4A] font-semibold mt-2 text-center">
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
                        <div className="w-2 h-2 rounded-full bg-[#2EEB57] animate-pulse shrink-0" />
                        <span className="text-xs font-bold text-white whitespace-nowrap">Custom Area Active</span>
                    </div>
                    <div className="flex items-center gap-2 flex-1 sm:flex-none min-w-0 sm:ml-2">
                        <Button
            disabled={paidPullStarting || pulling}
            onClick={() => setShowPrecisionPullPanel(true)}
            className="flex h-11 flex-1 items-center justify-center rounded-xl border border-[#2EEB57]/25 bg-[#2EEB57]/10 px-4 text-[11px] font-black tracking-wide text-white shadow-none hover:border-[#2EEB57]/45 hover:bg-[#2EEB57]/15 sm:h-9 sm:flex-none min-w-0">
            
                            PULL DATA
                        </Button>
                    </div>
                    <button
          onClick={() => {setDrawnPolygon(null);setDraftPolygon([]);setDrawingMode(false);setShowPrecisionPullPanel(false);}}
          className="absolute top-2 right-2 sm:static text-gray-400 hover:text-red-500 transition-colors p-2 sm:p-1 bg-white/5 rounded-full shrink-0 ml-auto sm:ml-0">
          
                        <Trash2 className="w-3 h-3" />
                    </button>
                    <div className="static sm:absolute sm:top-full sm:left-0 sm:right-auto mt-1 sm:mt-2 w-full sm:w-72 bg-white/5 sm:bg-black/90 border border-gray-800 rounded-xl sm:rounded-lg p-2 shadow-xl animate-in fade-in slide-in-from-top-1">
                        <p className="text-[9px] text-gray-400 leading-tight">
                            <span className="text-[#2EEB57] font-bold">Area:</span> selected freehand polygon is about <span className="text-white">{actualAreaLabel}</span>.
                            <br /><span className="text-[#39FF4A] font-bold">FirstKnock:</span> pulls up to <span className="text-white">{maxRequestedProperties}</span> properties for this account.
                        </p>
                    </div>
                </div>
      }

            {showPrecisionPullPanel && !drawingMode && !pulling && routeMode === 'precision' && drawnPolygon && drawnPolygon.length > 2 &&
      <PrecisionPullPanel
        areaLabel={actualAreaLabel}
        maxProperties={maxRequestedProperties}
        requestedPropertyCount={requestedPropertyCount}
        setRequestedPropertyCount={setRequestedPropertyCount}
        propertyCountMode={propertyCountMode}
        setPropertyCountMode={setPropertyCountMode}
        minHomeValue={minHomeValue}
        setMinHomeValue={setMinHomeValue}
        maxHomeValue={maxHomeValue}
        setMaxHomeValue={setMaxHomeValue}
        soldMonths={fetchMonths}
        setSoldMonths={setFetchMonths}
        onClose={() => {setShowPrecisionPullPanel(false);setPullError(null);}}
        onGenerate={handlePaidBatchDataPull}
        generating={paidPullStarting}
        pullError={pullError}
        onUpgrade={() => {setShowPrecisionPullPanel(false);setPullError(null);navigate(createPageUrl('Billing') + '?plan=precision');}}
        user={user}
        selectedHistoryArea={ghostAreasVisible ? selectedHistoryArea : null}
        repullMode={repullMode}
        setRepullMode={setRepullMode}
        forceFullRefresh={forceFullRefresh}
        setForceFullRefresh={setForceFullRefresh}
        includeUnresolvedFollowUps={includeUnresolvedFollowUps}
        setIncludeUnresolvedFollowUps={setIncludeUnresolvedFollowUps}
        onClearArea={() => {setDrawnPolygon(null);setDraftPolygon([]);setDrawingMode(false);setShowPrecisionPullPanel(false);setSelectedHistoryArea(null);}}
      />
      }
        </>);

}
