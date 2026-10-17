// Background road search worker. Called with { job_id } it runs the next pass
// of that RouteOptimizationJob (under a lease) and chains itself; called with
// no arguments (the 5-minute sweep) it restarts queued and stalled jobs.
// It reads and writes only through the service role and returns no route data.

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';
import { advanceRouteOptimizationJob, sweepRouteOptimizationJobs } from '../../shared/routeOptimizationJobs.js';

function readSecret(name: string): string {
    try { return String(secrets.get(name) || '').trim(); } catch { return ''; }
}

Deno.serve(async (req) => {
    try {
        const service = createClientFromRequest(req).asServiceRole;
        const body = await req.json().catch(() => ({}));
        const jobId = typeof body?.job_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.job_id) ? body.job_id : null;
        const result = jobId
            ? await advanceRouteOptimizationJob(service, jobId, { readSecret })
            : await sweepRouteOptimizationJobs(service);
        return Response.json({ success: true, ...result });
    } catch (error) {
        console.error('[advanceRouteOptimizationJob]', error);
        return Response.json({ error: 'Background route optimization could not advance.' }, { status: 500 });
    }
});
