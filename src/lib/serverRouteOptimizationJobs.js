/**
 * Background road searches the SERVER runs (after a rep anchor change, backend
 * generation or the recent-sales routes) show on the same progress pill as
 * the app's own: polled from routeOptimizationJobStatus only while one is
 * active, then a "Route improved by X mi" notice when one saves a shorter order.
 */

import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { queryClientInstance } from '@/lib/query-client';
import { startRoadOptimizationJob } from '@/lib/roadOptimizationProgress';

const POLL_MS = 15000;
const ACTIVE = new Set(['awaiting_route', 'queued', 'running']);
let timer = null, polling = false, progressJob = null, client = base44;
const announced = new Set();
const seenActive = new Set();

function showProgress(active) {
    if (!active.length) {
        progressJob?.finish();
        progressJob = null;
        return;
    }
    const routes = active.map((job, index) => ({ name: `Route ${index + 1}`, stops: 0 }));
    if (!progressJob || progressJob.size !== routes.length) {
        progressJob?.finish();
        progressJob = startRoadOptimizationJob({ title: 'Improving routes on the server', routes, background: true });
        progressJob.size = routes.length;
        progressJob.finishInBackground();
    }
    active.forEach((job, index) => {
        progressJob.startRoute(index);
        progressJob.progress(index, { passesDone: job.passes_done, maxPasses: 8, checksDone: job.checks_done,
            checksTotal: job.checks_total, savedMiles: job.improved_miles, bestMiles: null });
    });
}

async function poll() {
    if (polling) return;
    polling = true;
    let jobs = [];
    try { jobs = (await client.functions.invoke('routeOptimizationJobStatus', {}))?.data?.jobs || []; }
    catch { jobs = []; }
    finally { polling = false; }
    const active = jobs.filter(job => ACTIVE.has(job.status));
    for (const job of active) seenActive.add(job.id);
    const improved = jobs.filter(job => job.status === 'improved' && seenActive.has(job.id) && !announced.has(job.id));
    if (improved.length) {
        for (const job of improved) announced.add(job.id);
        const miles = Math.round(improved.reduce((sum, job) => sum + (job.improved_miles || 0), 0) * 100) / 100;
        await Promise.allSettled(['savedRoutes', 'myRoutes', 'allRoutes'].map(root => queryClientInstance.invalidateQueries({ queryKey: [root] })));
        toast.success(improved.length === 1 ? `Route improved by ${miles} mi in the background.`
            : `${improved.length} routes improved by ${miles} mi in the background.`, { duration: 6000 });
    }
    showProgress(active.filter(job => job.status !== 'awaiting_route'));
    clearTimeout(timer);
    timer = active.length ? setTimeout(poll, POLL_MS) : null;
}

/** Check once (app start, tab focus); keeps polling only while a job is active. */
export function watchServerRouteOptimizations(options = {}) {
    if (options.client) client = options.client;
    return poll();
}

/** After a server call that may have queued a search (it returns optimization_job_id). */
export function noteServerRouteOptimization(response) {
    if (response?.optimization_job_id || response?.data?.optimization_job_id) return poll();
    return null;
}
