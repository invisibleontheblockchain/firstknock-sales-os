import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
    classifyActivePrecisionJobs,
    isActualPrecisionJob,
    isPrecisionReservationUnsettled,
    loadUserPrecisionJobs,
    precisionProcessorTokenHash
} from '../_shared/precisionActiveJobCriteria.js';

const PROCESSOR_CANCEL_WAIT_MS = 900;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function reservationIsUnsettled(job) {
    try {
        return isPrecisionReservationUnsettled(job);
    } catch (error) {
        console.warn(`[cancelFetchJob] Malformed settlement evidence for ${job?.id || 'unknown'}; treating it as unsettled: ${error.message}`);
        return true;
    }
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
        if (!isActualPrecisionJob(job)) {
            return Response.json({ error: 'fetch_job_not_precision' }, { status: 409 });
        }
        if (!job.precision_usage_user_id) {
            return Response.json({
                error: 'legacy_precision_ownership_unverifiable',
                message: 'This legacy Precision job cannot be changed until immutable ownership is backfilled.'
            }, { status: 409 });
        }
        if (String(job.precision_usage_user_id) !== String(user.id)) {
            return Response.json({ error: 'Not your job' }, { status: 403 });
        }
        const activeResolution = classifyActivePrecisionJobs(
            await loadUserPrecisionJobs(base44, user)
        );
        if (activeResolution.state === 'multiple') {
            return Response.json({
                error: 'multiple_active_precision_jobs',
                message: 'Multiple active Precision jobs require operator review. No job was selected or cancelled.',
                active_job_ids: activeResolution.jobs.map(activeJob => activeJob.id)
            }, { status: 409 });
        }

        if (!['pending', 'running', 'cancelled'].includes(job.status)) {
            return Response.json({ status: job.status, job_id, message: 'Job is not active' });
        }
        const initiallyUnsettled = reservationIsUnsettled(job);
        if (job.status === 'cancelled' && !initiallyUnsettled) {
            return Response.json({
                status: 'cancelled',
                job_id,
                settlement_pending: false
            });
        }

        const cancelledAt = new Date().toISOString();
        const processorToken = crypto.randomUUID();
        const processorTokenHash = await precisionProcessorTokenHash(processorToken);
        const updateMany = base44.asServiceRole.entities.FetchJob.updateMany;
        if (typeof updateMany !== 'function') {
            return Response.json({
                error: 'precision_cancellation_claim_unavailable',
                message: 'Precision cancellation could not acquire a durable state claim.'
            }, { status: 503 });
        }
        let cancellationRecorded = false;
        let observedJob = job;
        for (let attempt = 0; attempt < 3 && !cancellationRecorded; attempt++) {
            if (!['pending', 'running', 'cancelled'].includes(observedJob.status)) break;
            const observedMetadata = observedJob.dry_run_metadata || {};
            const cancellationFilter: any = {
                id: job_id,
                status: observedJob.status
            };
            if (Object.prototype.hasOwnProperty.call(observedJob, 'processor_claim_id')) {
                cancellationFilter.processor_claim_id = observedJob.processor_claim_id;
            }
            const cancellationClaim = await updateMany.call(
                base44.asServiceRole.entities.FetchJob,
                cancellationFilter,
                {
                    $set: {
                        status: 'cancelled',
                        // Preserve an in-flight worker claim. The Neon lease
                        // owner observes cancellation, rolls back, and settles;
                        // a successor may take over only after acquiring that
                        // same advisory lease.
                        processor_claim_id: observedJob.processor_claim_id ?? null,
                        precision_cancel_requested_at: observedJob.precision_cancel_requested_at || cancelledAt,
                        error_message: 'Cancelled by user',
                        error_log: [
                            ...(observedJob.error_log || []),
                            `[${cancelledAt}] Cancelled by user.`
                        ],
                        dry_run_metadata: {
                            ...observedMetadata,
                            processor_token: null,
                            processor_token_hash: processorTokenHash
                        }
                    }
                }
            );
            cancellationRecorded = cancellationClaim?.success === true
                && Number(cancellationClaim?.updated) === 1
                && cancellationClaim?.has_more !== true;
            if (!cancellationRecorded) {
                observedJob = await base44.asServiceRole.entities.FetchJob.get(job_id).catch(() => null);
                if (!observedJob) break;
            }
        }
        if (!cancellationRecorded) {
            return Response.json({
                error: 'precision_cancellation_conflict',
                message: 'The Precision job changed while cancellation was being recorded. No stale state was overwritten.'
            }, { status: 409 });
        }

        // Cancellation records intent but deliberately does not release billing
        // capacity. The processor owns exact settlement after it has stopped
        // writing, so a second pull cannot oversubscribe the account mid-cancel.
        if (initiallyUnsettled) {
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
        const settlementPending = !latestJob || reservationIsUnsettled(latestJob);
        if (latestJob?.precision_cancel_requested_at && !settlementPending && latestJob.status !== 'cancelled') {
            const finalFilter: any = { id: job_id, status: latestJob.status };
            if (Object.prototype.hasOwnProperty.call(latestJob, 'processor_claim_id')) {
                finalFilter.processor_claim_id = latestJob.processor_claim_id;
            }
            await updateMany.call(
                base44.asServiceRole.entities.FetchJob,
                finalFilter,
                {
                    $set: {
                        status: 'cancelled',
                        processor_claim_id: null,
                        error_message: 'Cancelled by user',
                        completed_at: latestJob.completed_at || cancelledAt
                    }
                }
            );
        }

        return Response.json({
            status: 'cancelled',
            job_id,
            settlement_pending: settlementPending
        });
    } catch (error) {
        console.error('[cancelFetchJob] Error:', error);
        return Response.json({
            error: 'precision_cancellation_unavailable',
            message: 'Precision cancellation could not be completed safely.'
        }, { status: 500 });
    }
});
