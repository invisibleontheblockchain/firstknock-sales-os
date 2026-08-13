import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { asArray, sleep, timestampMs } from '../../shared/fetchJobSweep.ts';

// A chunked BatchData pull advances by chaining processFetchChunk invocations.
// That handoff is fire-and-forget, so a dropped chain leaves the job "running"
// with a valid resume offset and nothing working on it. This sweep re-invokes
// the processor for exactly those jobs. It is safe to run repeatedly: the
// processor's pipeline lock and expected_chunk guard reject duplicates, and a
// job that is genuinely mid-chunk still holds an unexpired lock.
const STALL_THRESHOLD_MS = 3 * 60 * 1000;
const HANDOFF_WAIT_MS = 500;
const QUERY_LIMIT = 25;
const RESUMABLE_PHASES = ['batchdata_precision', 'batchdata_requesting', 'batchdata_scanning'];

function isStalledChunkedPull(job, now) {
    if (job?.status !== 'running') return false;
    if (job?.precision_usage_recorded_at) return false;
    if (job?.precision_cancel_requested_at) return false;
    if (!RESUMABLE_PHASES.includes(String(job?.phase || ''))) return false;
    if (!job?.dry_run_metadata?.processor_token) return false;
    return now - timestampMs(job.updated_date || job.started_at || job.created_date) > STALL_THRESHOLD_MS;
}

async function hasActiveProcessor(base44, jobId, now) {
    const locks = asArray(await base44.asServiceRole.entities.PipelineLock.filter({ job_id: jobId }));
    return locks.some(lock => timestampMs(lock.expires_at) > now);
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const running = asArray(
            await base44.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', QUERY_LIMIT)
        );

        const resumed = [];
        for (const candidate of running) {
            if (!isStalledChunkedPull(candidate, now)) continue;
            // Re-read: the chain may have landed between the list and here.
            const job = await base44.asServiceRole.entities.FetchJob.get(candidate.id).catch(() => null);
            if (!job || !isStalledChunkedPull(job, now)) continue;
            if (await hasActiveProcessor(base44, job.id, now)) continue;

            await base44.asServiceRole.entities.FetchJob.update(job.id, {
                error_log: [
                    ...(job.error_log || []),
                    `[${nowIso}] Chunk chain stalled at offset ${job.current_offset || 0}; resume sweep re-invoked chunk ${job.chunk_number || 0}.`
                ]
            }).catch(() => {});

            const handoff = base44.asServiceRole.functions.invoke('processFetchChunk', {
                job_id: job.id,
                expected_chunk: job.chunk_number || 0,
                processor_token: job.dry_run_metadata.processor_token
            }).catch(error => {
                console.warn(`[resumeStalledFetchChunks] handoff failed for ${job.id}: ${error.message}`);
            });
            await Promise.race([handoff, sleep(HANDOFF_WAIT_MS)]);
            resumed.push({ job_id: job.id, chunk: job.chunk_number || 0, offset: job.current_offset || 0 });
        }

        console.log(`[resumeStalledFetchChunks] checked=${running.length}, resumed=${resumed.length}`);
        return Response.json({ status: 'ok', jobs_checked: running.length, jobs_resumed: resumed.length, resumed });
    } catch (error) {
        console.error('[resumeStalledFetchChunks] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});