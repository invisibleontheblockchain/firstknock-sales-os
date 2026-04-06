import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Fix #1: Stale Job Watchdog
// Sweeps for FetchJobs stuck in 'running' or 'pending' for more than 30 minutes
// and marks them as failed so users aren't stuck with frozen progress bars.

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const now = Date.now();
        let fixed = 0;

        // Check running jobs
        const runningJobs = await base44.asServiceRole.entities.FetchJob.filter(
            { status: 'running' }, '-updated_date', 50
        );
        const runningArr = Array.isArray(runningJobs) ? runningJobs : (runningJobs?.items || []);

        for (const job of runningArr) {
            const lastUpdate = job.updated_date ? new Date(job.updated_date).getTime() : 0;
            const age = now - lastUpdate;
            if (age > STALE_THRESHOLD_MS) {
                console.log(`[watchdog] Marking stale RUNNING job ${job.id} as failed (last updated ${Math.round(age / 60000)}min ago)`);
                await base44.asServiceRole.entities.FetchJob.update(job.id, {
                    status: 'failed',
                    error_message: `Job stalled — no progress for ${Math.round(age / 60000)} minutes. The processing chain likely broke mid-execution. Please try pulling data again.`,
                    error_log: [...(job.error_log || []), `[${new Date().toISOString()}] Watchdog: marked as failed after ${Math.round(age / 60000)}min stall`]
                });
                fixed++;
            }
        }

        // Check pending jobs
        const pendingJobs = await base44.asServiceRole.entities.FetchJob.filter(
            { status: 'pending' }, '-created_date', 50
        );
        const pendingArr = Array.isArray(pendingJobs) ? pendingJobs : (pendingJobs?.items || []);

        for (const job of pendingArr) {
            const created = job.created_date ? new Date(job.created_date).getTime() : 0;
            const age = now - created;
            if (age > STALE_THRESHOLD_MS) {
                console.log(`[watchdog] Marking stale PENDING job ${job.id} as failed (created ${Math.round(age / 60000)}min ago, never started)`);
                await base44.asServiceRole.entities.FetchJob.update(job.id, {
                    status: 'failed',
                    error_message: `Job never started processing — stuck in pending for ${Math.round(age / 60000)} minutes. Please try again.`,
                    error_log: [...(job.error_log || []), `[${new Date().toISOString()}] Watchdog: marked as failed — never started after ${Math.round(age / 60000)}min`]
                });
                fixed++;
            }
        }

        console.log(`[watchdog] Sweep complete: ${fixed} stale jobs fixed out of ${runningArr.length + pendingArr.length} checked`);
        return Response.json({ status: 'ok', stale_jobs_fixed: fixed, running_checked: runningArr.length, pending_checked: pendingArr.length });

    } catch (error) {
        console.error('[watchdog] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});