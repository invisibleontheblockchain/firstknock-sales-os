import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';
import { asArray, sleep, timestampMs } from '../../shared/fetchJobSweep.ts';

// Sweeps stalled Precision jobs and hands exact usage settlement back to the
// processor. A watchdog must never release a reservation itself: the worker
// may have persisted properties immediately before stalling.
const STALE_THRESHOLD_MS = 30 * 60 * 1000;
const PROCESSOR_RECOVERY_WAIT_MS = 900;
const QUERY_LIMIT = 50;
const TERMINAL_PAGE_SIZE = 500;
const TERMINAL_SCAN_LIMIT = 20000;

function reservedUsage(job) {
    return Math.max(0, Math.floor(Number(job?.precision_usage_reserved || 0)));
}

function isUnsettled(job) {
    return reservedUsage(job) > 0 && !job?.precision_usage_recorded_at;
}

function staleReferenceMs(job) {
    return job?.status === 'pending'
        ? timestampMs(job.created_date)
        : timestampMs(job.updated_date || job.started_at || job.created_date);
}

function needsRecovery(job, now) {
    if (job?.precision_watchdog_recovery_at && !job?.precision_usage_recorded_at) return true;
    if (['cancelled', 'failed'].includes(job?.status)) return isUnsettled(job);
    if (!['pending', 'running'].includes(job?.status)) return false;
    return now - staleReferenceMs(job) > STALE_THRESHOLD_MS;
}

function isAuthorizedWatchdogRequest(req) {
    const expected = Deno.env.get('PRECISION_WATCHDOG_SECRET');
    const received = req.headers.get('x-precision-watchdog-secret');
    return Boolean(expected) && received === expected;
}

async function listTerminalJobs(entity, status) {
    const records = [];
    for (let skip = 0; skip < TERMINAL_SCAN_LIMIT; skip += TERMINAL_PAGE_SIZE) {
        const page = asArray(await entity.filter({ status }, '-updated_date', TERMINAL_PAGE_SIZE, skip));
        records.push(...page);
        if (page.length < TERMINAL_PAGE_SIZE) return records;
    }
    throw new Error(`FetchJob ${status} history exceeds the watchdog recovery scan limit.`);
}

async function invokeProcessorRecovery(base44, job, processorToken) {
    const invocation = base44.asServiceRole.functions.invoke('processFetchChunk', {
        job_id: job.id,
        expected_chunk: job.chunk_number || 0,
        processor_token: processorToken
    }).catch(error => {
        console.warn(`[watchdog] Processor recovery handoff failed for ${job.id}: ${error.message}`);
        return null;
    });
    await Promise.race([invocation, sleep(PROCESSOR_RECOVERY_WAIT_MS)]);
}

Deno.serve(async (req) => {
    try {
        if (!isAuthorizedWatchdogRequest(req)) {
            return Response.json({ error: 'Forbidden: watchdog authorization required' }, { status: 403 });
        }
        const base44 = createClientFromRequest(req);

        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const fetchJobs = base44.asServiceRole.entities.FetchJob;
        const groups = await Promise.all([
            fetchJobs.filter({ status: 'running' }, '-updated_date', QUERY_LIMIT),
            fetchJobs.filter({ status: 'pending' }, '-created_date', QUERY_LIMIT),
            listTerminalJobs(fetchJobs, 'cancelled'),
            listTerminalJobs(fetchJobs, 'failed')
        ]);
        const jobsById = new Map();
        for (const group of groups) {
            for (const job of asArray(group)) jobsById.set(job.id, job);
        }

        let recovered = 0;
        let pending = 0;
        let requested = 0;

        for (const candidate of jobsById.values()) {
            if (!needsRecovery(candidate, now)) continue;

            let job = await base44.asServiceRole.entities.FetchJob.get(candidate.id).catch(() => candidate);
            const watchdogInitiated = Boolean(job.precision_watchdog_recovery_at)
                || ['pending', 'running', 'failed'].includes(job.status);

            // A prior handoff may have settled asynchronously after the last
            // sweep. Only terminalize after the exact count is durable.
            if (job.precision_usage_recorded_at) {
                if (job.precision_watchdog_recovery_at && job.status !== 'failed') {
                    await base44.asServiceRole.entities.FetchJob.update(job.id, {
                        status: 'failed',
                        completed_at: job.completed_at || nowIso,
                        error_message: 'Job stalled and was stopped safely. Please try pulling data again.',
                        error_log: [
                            ...(job.error_log || []),
                            `[${nowIso}] Watchdog finalized the job after exact Precision usage settlement.`
                        ]
                    });
                    recovered++;
                }
                continue;
            }

            if (!isUnsettled(job)) {
                // Legacy/non-Precision stale jobs have no allowance to settle.
                if (['pending', 'running'].includes(job.status)) {
                    await base44.asServiceRole.entities.FetchJob.update(job.id, {
                        status: 'failed',
                        completed_at: nowIso,
                        error_message: 'Job stalled with no Precision reservation. Please try again.',
                        error_log: [
                            ...(job.error_log || []),
                            `[${nowIso}] Watchdog marked an unreserved stale job as failed.`
                        ]
                    });
                    recovered++;
                }
                continue;
            }

            let processorToken = String(job.dry_run_metadata?.processor_token || '');
            const recoveryUpdate: any = {};
            if (watchdogInitiated && !job.precision_watchdog_recovery_at) {
                recoveryUpdate.precision_watchdog_recovery_at = nowIso;
                recoveryUpdate.precision_cancel_requested_at = job.precision_cancel_requested_at || nowIso;
                recoveryUpdate.error_log = [
                    ...(job.error_log || []),
                    `[${nowIso}] Watchdog requested processor-owned recovery; the ${reservedUsage(job)}-property reservation remains held until exact settlement.`
                ];
            }
            if (!processorToken) {
                processorToken = crypto.randomUUID();
                recoveryUpdate.dry_run_metadata = {
                    ...(job.dry_run_metadata || {}),
                    processor_token: processorToken
                };
            }
            if (Object.keys(recoveryUpdate).length > 0) {
                await base44.asServiceRole.entities.FetchJob.update(job.id, recoveryUpdate);
                requested++;
                job = await base44.asServiceRole.entities.FetchJob.get(job.id).catch(() => ({ ...job, ...recoveryUpdate }));
            }

            await invokeProcessorRecovery(base44, job, processorToken);
            const latest = await base44.asServiceRole.entities.FetchJob.get(job.id).catch(() => null);
            if (latest?.precision_usage_recorded_at) {
                if ((watchdogInitiated || latest.precision_watchdog_recovery_at) && latest.status !== 'failed') {
                    await base44.asServiceRole.entities.FetchJob.update(job.id, {
                        status: 'failed',
                        completed_at: latest.completed_at || nowIso,
                        error_message: 'Job stalled and was stopped safely. Please try pulling data again.',
                        error_log: [
                            ...(latest.error_log || []),
                            `[${nowIso}] Watchdog finalized the job after exact Precision usage settlement.`
                        ]
                    });
                }
                recovered++;
            } else {
                // Keep the reservation in force. The persisted recovery marker
                // makes the next sweep retry without another 30-minute delay.
                pending++;
            }
        }

        console.log(`[watchdog] Sweep complete: recovered=${recovered}, pending_settlement=${pending}, recovery_requested=${requested}, checked=${jobsById.size}`);
        return Response.json({
            status: 'ok',
            stale_jobs_fixed: recovered,
            recovery_requested: requested,
            settlement_pending: pending,
            jobs_checked: jobsById.size
        });
    } catch (error) {
        console.error('[watchdog] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});