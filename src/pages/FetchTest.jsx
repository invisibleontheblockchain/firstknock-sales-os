import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Loader2, MapPin, Zap, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

// ~10 sq mile polygon around downtown Charleston, SC
const TEST_POLYGON = [
  { lat: 32.8100, lng: -79.9700 },
  { lat: 32.8100, lng: -79.9100 },
  { lat: 32.7600, lng: -79.9100 },
  { lat: 32.7600, lng: -79.9700 },
];

const TEST_CENTER = { lat: 32.785, lng: -79.940 };
const TEST_RADIUS = 2; // ~2 mile radius ≈ ~12.5 sq miles

export default function FetchTest() {
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(null);

  const log = (msg, type = 'info') => {
    setResults(prev => [...prev, { msg, type, time: new Date().toLocaleTimeString() }]);
  };

  const clearLogs = () => setResults([]);

  // Test 1: fetchZipProperties with sold_months param
  const testZipFetch = async () => {
    setRunning('zip');
    log('Starting ZIP fetch test — zip=29401, sold_months=3');
    log('This should ONLY fetch recently sold homes (no density fill)');
    try {
      const start = Date.now();
      const res = await base44.functions.invoke('fetchZipProperties', {
        zip_code: '29401',
        sold_months: 3,
        force_sync: true
      });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const d = res.data;
      log(`✅ Completed in ${elapsed}s`, 'success');
      log(`Status: ${d.status}`, 'success');
      log(`Properties found: ${d.total_found || 0}`, 'info');
      log(`Imported: ${d.count || 0}`, 'info');
      log(`Sold: ${d.sold_count || 0}, MLS: ${d.mls_count || 0}`, 'info');
      log(`API calls used: ${d.api_calls || '?'}`, d.api_calls > 20 ? 'warn' : 'success');
      if (d.api_calls > 20) log('⚠️ API calls > 20 — may need further optimization', 'warn');
      log(d.message || JSON.stringify(d));
    } catch (e) {
      log(`❌ Error: ${e.message}`, 'error');
      if (e.response?.data) log(JSON.stringify(e.response.data), 'error');
    }
    setRunning(null);
  };

  // Test 2: fetchAreaProperties with small polygon
  const testAreaFetch = async () => {
    setRunning('area');
    log('Starting AREA fetch test — Charleston SC ~10 sq mi polygon');
    log(`Center: ${TEST_CENTER.lat}, ${TEST_CENTER.lng} | Radius: ${TEST_RADIUS}mi`);
    log(`Polygon: ${TEST_POLYGON.length} points`);
    try {
      const start = Date.now();
      const res = await base44.functions.invoke('fetchAreaProperties', {
        latitude: TEST_CENTER.lat,
        longitude: TEST_CENTER.lng,
        radius: TEST_RADIUS,
        polygon: TEST_POLYGON
      });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const d = res.data;
      log(`✅ Job created in ${elapsed}s`, 'success');
      log(`Status: ${d.status}`, 'info');
      log(`Job ID: ${d.job_id || 'N/A'}`, 'info');
      log(d.message || JSON.stringify(d));

      if (d.job_id) {
        log('Polling job status every 5s...');
        pollJob(d.job_id);
      }
    } catch (e) {
      log(`❌ Error: ${e.message}`, 'error');
      if (e.response?.data) log(JSON.stringify(e.response.data), 'error');
      setRunning(null);
    }
  };

  const pollJob = async (jobId) => {
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes max

    const poll = async () => {
      attempts++;
      try {
        const jobs = await base44.entities.FetchJob.filter({ id: jobId }, null, 1);
        const arr = Array.isArray(jobs) ? jobs : (jobs?.items || []);
        if (arr.length === 0) {
          log('Job not found', 'error');
          setRunning(null);
          return;
        }
        const job = arr[0];
        log(`[Poll ${attempts}] Status: ${job.status} | Progress: ${job.progress_pct}% | Fetched: ${job.total_fetched}/${job.total_expected} | Inserted: ${job.total_inserted} | Existed: ${job.total_existed}`);

        if (job.status === 'completed') {
          log(`✅ JOB COMPLETE — ${job.total_inserted} inserted, ${job.total_existed} existed, ${job.total_updated || 0} updated`, 'success');
          log(`Zip codes found: ${(job.zip_codes_found || []).join(', ')}`, 'info');
          setRunning(null);
          return;
        }
        if (job.status === 'failed') {
          log(`❌ JOB FAILED: ${job.error_message}`, 'error');
          setRunning(null);
          return;
        }
        if (attempts >= maxAttempts) {
          log('⚠️ Max poll attempts reached', 'warn');
          setRunning(null);
          return;
        }

        setTimeout(poll, 5000);
      } catch (e) {
        log(`Poll error: ${e.message}`, 'error');
        if (attempts < maxAttempts) setTimeout(poll, 5000);
        else setRunning(null);
      }
    };

    poll();
  };

  // Test 3: Check current RentCast usage
  const testUsageCheck = async () => {
    setRunning('usage');
    log('Checking current zip usage...');
    try {
      const res = await base44.functions.invoke('fetchZipProperties', { check_usage_only: true });
      const d = res.data;
      log(`✅ Zips used: ${d.zips_used}`, 'success');
      log(`Generated zips: ${(d.generated_zips || []).join(', ') || 'none'}`, 'info');
    } catch (e) {
      log(`❌ Error: ${e.message}`, 'error');
    }
    setRunning(null);
  };

  const typeStyles = {
    info: 'text-gray-400',
    success: 'text-green-400',
    warn: 'text-yellow-400',
    error: 'text-red-400',
  };

  return (
    <div className="h-full overflow-auto bg-[#09090b] text-white p-4 md:p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-black tracking-tight">API Fetch Tester</h1>
          <p className="text-sm text-gray-500 mt-1">Test RentCast API calls with conservative limits before scaling</p>
        </div>

        {/* Info box */}
        <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 flex gap-3">
          <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
          <div className="text-xs text-blue-300/80 space-y-1">
            <p><strong>v8 Changes:</strong> Removed Phase 3 (density fill). Now only fetches recently sold properties.</p>
            <p><strong>processFetchChunk:</strong> Reduced from 60→20 pages/chunk and 15→5 parallel requests.</p>
            <p><strong>Test area:</strong> ~10 sq mi polygon around downtown Charleston, SC (29401).</p>
          </div>
        </div>

        {/* Test buttons */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            onClick={testUsageCheck}
            disabled={!!running}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-left hover:bg-white/[0.04] transition-all disabled:opacity-50"
          >
            <MapPin className="w-5 h-5 text-purple-400 mb-2" />
            <p className="text-sm font-bold text-white">Check Usage</p>
            <p className="text-[10px] text-gray-500 mt-1">See current zip count</p>
          </button>

          <button
            onClick={testZipFetch}
            disabled={!!running}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-left hover:bg-white/[0.04] transition-all disabled:opacity-50"
          >
            <Zap className="w-5 h-5 text-yellow-400 mb-2" />
            <p className="text-sm font-bold text-white">Test Zip Fetch</p>
            <p className="text-[10px] text-gray-500 mt-1">29401 • 3 months • force sync</p>
          </button>

          <button
            onClick={testAreaFetch}
            disabled={!!running}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-left hover:bg-white/[0.04] transition-all disabled:opacity-50"
          >
            <MapPin className="w-5 h-5 text-green-400 mb-2" />
            <p className="text-sm font-bold text-white">Test Area Fetch</p>
            <p className="text-[10px] text-gray-500 mt-1">Charleston ~10 sq mi polygon</p>
          </button>
        </div>

        {/* Running indicator */}
        {running && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
            <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />
            <span className="text-xs font-bold text-yellow-400">
              Running: {running === 'zip' ? 'Zip Fetch' : running === 'area' ? 'Area Fetch' : 'Usage Check'}...
            </span>
          </div>
        )}

        {/* Log output */}
        <div className="rounded-2xl border border-white/[0.06] bg-[#0c0c0e] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/[0.04] flex items-center justify-between">
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Console Output</span>
            <button onClick={clearLogs} className="text-[10px] font-bold text-gray-600 hover:text-white transition-colors">Clear</button>
          </div>
          <div className="p-4 max-h-[400px] overflow-auto font-mono text-xs space-y-1">
            {results.length === 0 ? (
              <p className="text-gray-600 italic">Run a test to see output...</p>
            ) : (
              results.map((r, i) => (
                <div key={i} className={`flex gap-2 ${typeStyles[r.type]}`}>
                  <span className="text-gray-700 shrink-0">[{r.time}]</span>
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