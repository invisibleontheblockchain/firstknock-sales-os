import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const PROCESSOR_CANCEL_WAIT_MS = 900;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { job_id } = body;
        if (!job_id) {
            return Response.json({ error: 'job_id required' }, { status: 400 });
        }

        const jobs = await base44.asServiceRole.entities.FetchJob.filter({ id: job_id }, null, 1);
        const jobArr = Array.isArray(jobs) ? jobs : (jobs?.items || []);
        if (jobArr.length === 0) {
            return Response.json({ error: 'Job not found' }, { status: 404 });
        }

        const job = jobArr[0];
        const ownsJob = job.precision_usage_user_id
            ? String(job.precision_usage_user_id) === String(user.id)
            : String(job.user_email || '').toLowerCase() === String(user.email || '').toLowerCase();
        if (!ownsJob) {
            return Response.json({ error: 'Not your job' }, { status: 403 });
        }

        if (!['pending', 'running', 'cancelled'].includes(job.status)) {
            return Response.json({ status: job.status, job_id, message: 'Job is not active' });
        }

        const cancelledAt = new Date().toISOString();
        const errorLog = [...(job.error_log || []), `[${cancelledAt}] Cancelled by user.`];
        await base44.asServiceRole.entities.FetchJob.update(job_id, {
            status: 'cancelled',
            precision_cancel_requested_at: job.precision_cancel_requested_at || cancelledAt,
            error_message: 'Cancelled by user',
            error_log: errorLog
        });

        // Cancellation records intent but deliberately does not release billing
        // capacity. The processor owns exact settlement after it has stopped
        // writing, so a second pull cannot oversubscribe the account mid-cancel.
        const processorToken = job.dry_run_metadata?.processor_token;
        if (processorToken) {
            const invokePromise = base44.asServiceRole.functions.invoke('processFetchChunk', {
                job_id,
                expected_chunk: job.chunk_number || 0,
                processor_token: processorToken
            }).catch(error => {
                console.warn(`[cancelFetchJob] Processor cancellation handoff failed for ${job_id}: ${error.message}`);
            });
            await Promise.race([invokePromise, sleep(PROCESSOR_CANCEL_WAIT_MS)]);
        }

        const latestJob = await base44.asServiceRole.entities.FetchJob.get(job_id).catch(() => null);
        if (latestJob?.precision_cancel_requested_at && latestJob.precision_usage_recorded_at && latestJob.status !== 'cancelled') {
            await base44.asServiceRole.entities.FetchJob.update(job_id, {
                status: 'cancelled',
                error_message: 'Cancelled by user',
                completed_at: latestJob.completed_at || cancelledAt
            });
        }

        return Response.json({
            status: 'cancelled',
            job_id,
            settlement_pending: !latestJob?.precision_usage_recorded_at
        });
    } catch (error) {
        console.error('[cancelFetchJob] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});
