import React, { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Loader2, MapPin, Zap, AlertTriangle, CheckCircle2, Info, List, Clock, Activity, BarChart3, Trash2 } from 'lucide-react';
import TestMetricsPanel from '@/components/test/TestMetricsPanel';
import TestPropertyTable from '@/components/test/TestPropertyTable';

// ==========================================
// ANDERSON COUNTY TEST AREAS
// ==========================================

const ANDERSON_TESTS = {
  small: {
    label: 'Anderson City Core',
    description: '~5 sq mi — downtown Anderson',
    center: { lat: 34.5034, lng: -82.6501 },
    radius: 1.3,
    polygon: [
      { lat: 34.5150, lng: -82.6650 },
      { lat: 34.5150, lng: -82.6350 },
      { lat: 34.4920, lng: -82.6350 },
      { lat: 34.4920, lng: -82.6650 },
    ],
    zip: '29621'
  },
  medium: {
    label: 'Anderson + Suburbs',
    description: '~25 sq mi — city + surrounding neighborhoods',
    center: { lat: 34.51, lng: -82.65 },
    radius: 3,
    polygon: [
      { lat: 34.5400, lng: -82.6900 },
      { lat: 34.5400, lng: -82.6100 },
      { lat: 34.4800, lng: -82.6100 },
      { lat: 34.4800, lng: -82.6900 },
    ],
    zip: '29621'
  },
  large: {
    label: 'North Anderson County',
    description: '~80 sq mi — Anderson to Clemson corridor',
    center: { lat: 34.55, lng: -82.72 },
    radius: 5.5,
    polygon: [
      { lat: 34.6100, lng: -82.8200 },
      { lat: 34.6100, lng: -82.6200 },
      { lat: 34.4900, lng: -82.6200 },
      { lat: 34.4900, lng: -82.8200 },
    ],
    zip: '29621'
  }
};

export default function FetchTest() {
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(null);
  const [activeJobId, setActiveJobId] = useState(null);
  const [jobData, setJobData] = useState(null);
  const [properties, setProperties] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [soldMonths, setSoldMonths] = useState(6);
  const pollRef = useRef(null);

  const log = (msg, type = 'info') => {
    setLogs(prev => [...prev, { msg, type, time: new Date().toLocaleTimeString() }]);
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, []);

  // =====================
  // AREA FETCH TEST
  // =====================
  const testAreaFetch = async (testKey) => {
    const test = ANDERSON_TESTS[testKey];
    if (!test) return;

    setRunning(testKey);
    setMetrics(null);
    setProperties([]);
    log(`🔄 Starting AREA FETCH — ${test.label}`, 'info');
    log(`Center: ${test.center.lat}, ${test.center.lng} | Radius: ${test.radius}mi | Sold months: ${soldMonths}`);

    const fetchStart = Date.now();
    try {
      const res = await base44.functions.invoke('fetchAreaProperties', {
        latitude: test.center.lat,
        longitude: test.center.lng,
        radius: test.radius,
        polygon: test.polygon,
        sold_months: soldMonths
      });
      const d = res.data;
      const invokeTime = ((Date.now() - fetchStart) / 1000).toFixed(1);
      log(`Job created in ${invokeTime}s — ID: ${d.job_id}`, 'success');

      if (d.optimized_radius !== undefined) {
        log(`Radius: ${d.original_radius}mi → ${d.optimized_radius}mi`, d.optimized_radius < d.original_radius ? 'success' : 'info');
      }

      if (d.error) {
        log(`⚠️ ${d.error}: ${d.message}`, 'warn');
        setRunning(null);
        return;
      }

      if (d.job_id) {
        setActiveJobId(d.job_id);
        setMetrics({ startTime: fetchStart, invokeMs: Date.now() - fetchStart });
        pollJob(d.job_id, fetchStart);
      } else {
        setRunning(null);
      }
    } catch (e) {
      log(`❌ CRASH: ${e.message}`, 'error');
      if (e.response?.data) log(JSON.stringify(e.response.data), 'error');
      setRunning(null);
    }
  };

  // =====================
  // ZIP FETCH TEST
  // =====================
  const testZipFetch = async (zip) => {
    setRunning('zip');
    setMetrics(null);
    setProperties([]);
    log(`🔄 Starting ZIP FETCH — ${zip}, sold_months=${soldMonths}`);

    const fetchStart = Date.now();
    try {
      const res = await base44.functions.invoke('fetchZipProperties', {
        zip_code: zip, sold_months: soldMonths, force_sync: true
      });
      const elapsed = ((Date.now() - fetchStart) / 1000).toFixed(1);
      const d = res.data;

      log(`✅ Completed in ${elapsed}s`, 'success');
      log(`Status: ${d.status} | Found: ${d.total_found || 0} | Imported: ${d.count || 0}`, 'info');
      log(`Sold: ${d.sold_count || 0} | MLS: ${d.mls_count || 0} | API calls: ${d.api_calls || 0}`, 'info');

      setMetrics({
        startTime: fetchStart,
        totalDurationMs: Date.now() - fetchStart,
        apiCalls: d.api_calls || 0,
        totalFound: d.total_found || 0,
        inserted: d.count || 0,
        soldCount: d.sold_count || 0,
        mlsCount: d.mls_count || 0,
        source: 'zip'
      });

      // Load properties for this zip
      loadProperties([zip]);
    } catch (e) {
      log(`❌ CRASH: ${e.message}`, 'error');
      if (e.response?.data) log(JSON.stringify(e.response.data), 'error');
    }
    setRunning(null);
  };

  // =====================
  // POLL JOB
  // =====================
  const pollJob = async (jobId, startTime) => {
    let attempts = 0;
    const maxAttempts = 120;

    const poll = async () => {
      attempts++;
      try {
        const jobs = await base44.entities.FetchJob.filter({ id: jobId }, null, 1);
        const arr = Array.isArray(jobs) ? jobs : (jobs?.items || []);
        if (arr.length === 0) { log('Job not found', 'error'); setRunning(null); return; }

        const j = arr[0];
        setJobData(j);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        log(`[${elapsed}s] ${j.phase || 'deed_records'} | ${j.progress_pct}% | Fetched: ${j.total_fetched}/${j.total_expected} | Ins: ${j.total_inserted} | Exist: ${j.total_existed} | MLS: ${j.mls_fetched || 0} | API: ${j.total_api_calls}`);

        if (j.status === 'completed') {
          const totalMs = Date.now() - startTime;
          log(`✅ JOB COMPLETE in ${(totalMs / 1000).toFixed(1)}s`, 'success');
          log(`Deed records: ${j.total_fetched} | MLS listings: ${j.mls_fetched || 0}`, 'success');
          log(`Inserted: ${j.total_inserted} | Existed: ${j.total_existed} | Updated: ${j.total_updated || 0}`, 'success');
          log(`Total API calls: ${j.total_api_calls} | MLS-only new: ${j.mls_new || 0}`, 'info');

          if (j.error_log && j.error_log.length > 0) {
            log(`⚠️ ${j.error_log.length} warnings/errors during job:`, 'warn');
            j.error_log.forEach(e => log(`  ${e}`, 'warn'));
          }

          setMetrics({
            startTime,
            totalDurationMs: totalMs,
            apiCalls: j.total_api_calls,
            mlsApiCalls: j.mls_api_calls || 0,
            totalFetched: j.total_fetched,
            totalExpected: j.total_expected,
            inserted: j.total_inserted,
            existed: j.total_existed,
            updated: j.total_updated || 0,
            mlsFetched: j.mls_fetched || 0,
            mlsNew: j.mls_new || 0,
            chunkTimings: j.chunk_timings || [],
            errorCount: (j.error_log || []).length,
            errors: j.error_log || [],
            source: 'area'
          });

          loadProperties(j.zip_codes_found || []);
          setRunning(null);
          return;
        }

        if (j.status === 'failed') {
          log(`❌ JOB FAILED: ${j.error_message}`, 'error');
          if (j.error_log && j.error_log.length > 0) {
            j.error_log.forEach(e => log(`  ${e}`, 'error'));
          }
          setMetrics({
            startTime, totalDurationMs: Date.now() - startTime,
            apiCalls: j.total_api_calls, errorCount: (j.error_log || []).length,
            errors: j.error_log || [], failed: true, source: 'area'
          });
          setRunning(null);
          return;
        }

        if (attempts >= maxAttempts) {
          log('⚠️ Max poll attempts reached (10 min)', 'warn');
          setRunning(null);
          return;
        }

        pollRef.current = setTimeout(poll, 3000);
      } catch (e) {
        log(`Poll error: ${e.message}`, 'error');
        if (attempts < maxAttempts) pollRef.current = setTimeout(poll, 5000);
        else setRunning(null);
      }
    };

    poll();
  };

  const loadProperties = async (zipCodes) => {
    try {
      const zips = zipCodes.length > 0 ? zipCodes : ['29621'];
      let allProps = [];
      for (const zip of zips) {
        const props = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 200);
        const list = Array.isArray(props) ? props : (props?.items || []);
        allProps = [...allProps, ...list];
      }
      setProperties(allProps);
      log(`Loaded ${allProps.length} properties for display`, 'success');
    } catch (e) {
      log(`Failed to load properties: ${e.message}`, 'error');
    }
  };

  // Cancel / cleanup
  const cancelJob = async () => {
    if (!activeJobId) return;
    try {
      await base44.entities.FetchJob.update(activeJobId, { status: 'failed', error_message: 'Cancelled by user' });
      log('Job cancelled', 'warn');
    } catch (e) { log(`Cancel failed: ${e.message}`, 'error'); }
    if (pollRef.current) clearTimeout(pollRef.current);
    setRunning(null);
    setActiveJobId(null);
  };

  const typeStyles = {
    info: 'text-gray-400', success: 'text-green-400',
    warn: 'text-yellow-400', error: 'text-red-400',
  };

  return (
    <div className="h-full overflow-auto bg-[#09090b] text-white p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-black tracking-tight">Pipeline Tester v3</h1>
            <p className="text-xs text-gray-500 mt-1">Anderson County SC — Deed Records + MLS Sold Listings</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-gray-500 font-bold">SOLD MONTHS:</label>
            <select
              value={soldMonths}
              onChange={e => setSoldMonths(Number(e.target.value))}
              className="bg-white/5 border border-white/10 text-white text-xs rounded-lg px-2 py-1"
            >
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
              <option value={24}>24 months</option>
            </select>
          </div>
        </div>

        {/* Pipeline Info */}
        <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 flex gap-3">
          <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
          <div className="text-[11px] text-blue-300/80 space-y-1">
            <p><strong>v3 Pipeline:</strong> Phase 1 fetches deed records (/properties?saleDateRange). Phase 2 fetches MLS sold listings (/listings/sale?status=Inactive) to catch recent closings not yet in courthouse records.</p>
            <p><strong>Metrics:</strong> Every chunk logs duration, API calls, insert/exist counts, and any errors. Watch for rate limits (429) and auth failures (401).</p>
          </div>
        </div>

        {/* Anderson County Area Tests */}
        <div>
          <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Area Fetch Tests — Anderson County</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {Object.entries(ANDERSON_TESTS).map(([key, test]) => (
              <button
                key={key}
                onClick={() => testAreaFetch(key)}
                disabled={!!running}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-left hover:bg-white/[0.04] transition-all disabled:opacity-50"
              >
                <MapPin className={`w-5 h-5 mb-2 ${key === 'small' ? 'text-green-400' : key === 'medium' ? 'text-yellow-400' : 'text-red-400'}`} />
                <p className="text-sm font-bold text-white">{test.label}</p>
                <p className="text-[10px] text-gray-500 mt-1">{test.description}</p>
                <p className="text-[10px] text-gray-600 mt-0.5">radius: {test.radius}mi</p>
              </button>
            ))}
          </div>
        </div>

        {/* Zip Fetch Tests */}
        <div>
          <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Zip Fetch Tests — Compare</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {['29621', '29625', '29626', '29627'].map(zip => (
              <button
                key={zip}
                onClick={() => testZipFetch(zip)}
                disabled={!!running}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 text-left hover:bg-white/[0.04] transition-all disabled:opacity-50"
              >
                <Zap className="w-4 h-4 text-yellow-400 mb-1" />
                <p className="text-sm font-bold text-white">{zip}</p>
                <p className="text-[10px] text-gray-500">Zip fetch</p>
              </button>
            ))}
          </div>
        </div>

        {/* Running indicator + cancel */}
        {running && (
          <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />
              <span className="text-xs font-bold text-yellow-400">
                Running: {running === 'zip' ? 'Zip Fetch' : ANDERSON_TESTS[running]?.label || running}
                {jobData && ` — ${jobData.phase || 'deed_records'} ${jobData.progress_pct || 0}%`}
              </span>
            </div>
            <button onClick={cancelJob} className="text-[10px] font-bold text-red-400 hover:text-red-300">CANCEL</button>
          </div>
        )}

        {/* Metrics Panel */}
        {metrics && <TestMetricsPanel metrics={metrics} />}

        {/* Properties Table */}
        {properties.length > 0 && (
          <TestPropertyTable
            properties={properties}
            onClear={() => setProperties([])}
          />
        )}

        {/* Console Logs */}
        <div className="rounded-2xl border border-white/[0.06] bg-[#0c0c0e] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/[0.04] flex items-center justify-between">
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Console ({logs.length})</span>
            <div className="flex items-center gap-3">
              <button onClick={() => setLogs([])} className="text-[10px] font-bold text-gray-600 hover:text-white">Clear</button>
            </div>
          </div>
          <div className="p-3 max-h-[350px] overflow-auto font-mono text-[11px] space-y-0.5">
            {logs.length === 0 ? (
              <p className="text-gray-600 italic">Run a test to see output...</p>
            ) : (
              logs.map((r, i) => (
                <div key={i} className={`flex gap-2 ${typeStyles[r.type]} leading-tight`}>
                  <span className="text-gray-700 shrink-0 w-16">{r.time}</span>
                  <span className="break-all">{r.msg}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}