/**
 * Background road searches the SERVER runs (after a rep anchor change, backend
 * generation or the recent-sales routes) are silent: while one is active the
 * app checks routeOptimizationJobStatus, and when one saves a shorter order it
 * refreshes the routes and map. No progress pill, no notice.
 */

import { base44 } from '@/api/base44Client';
import { queryClientInstance } from '@/lib/query-client';

const POLL_MS = 15000;
const ACTIVE = new Set(['awaiting_route', 'queued', 'running']);
let timer = null, polling = false, client = base44;
const refreshed = new Set();
const seenActive = new Set();

async function poll() {
    if (polling) return;
    polling = true;
    let jobs = [];
    try { jobs = (await client.functions.invoke('routeOptimizationJobStatus', {}))?.data?.jobs || []; }
    catch { jobs = []; }
    finally { polling = false; }
    const active = jobs.filter(job => ACTIVE.has(job.status));
    for (const job of active) seenActive.add(job.id);
    const improved = jobs.filter(job => job.status === 'improved' && seenActive.has(job.id) && !refreshed.has(job.id));
    if (improved.length) {
        for (const job of improved) refreshed.add(job.id);
        await Promise.allSettled(['savedRoutes', 'myRoutes', 'allRoutes'].map(root => queryClientInstance.invalidateQueries({ queryKey: [root] })));
    }
    clearTimeout(timer);
    timer = active.length ? setTimeout(poll, POLL_MS) : null;
}

/** Check once (app start, tab focus); keeps checking only while a job is active. */
export function watchServerRouteOptimizations(options = {}) {
    if (options.client) client = options.client;
    return poll();
}

/** After a server call that may have queued a search (it returns optimization_job_id). */
export function noteServerRouteOptimization(response) {
    if (response?.optimization_job_id || response?.data?.optimization_job_id) return poll();
    return null;
}
