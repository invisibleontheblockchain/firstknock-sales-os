import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import {
    classifyActivePrecisionJobs,
    isActualPrecisionJob,
    loadUserPrecisionJobs,
    precisionCriteriaDiagnostic,
    precisionCriteriaReferenceMs,
    precisionErrorPayload,
    precisionProcessorTokenHash,
    verifyPrecisionJobCriteriaEvidence
} from '../_shared/precisionActiveJobCriteria.js';

const PROCESSOR_REKICK_PENDING_MS = 12 * 1000;
const PROCESSOR_REKICK_RUNNING_IDLE_MS = 30 * 1000;
const PROCESSOR_REKICK_COOLDOWN_MS = 20 * 1000;
const PROCESSOR_REKICK_WAIT_MS = 900;
const INITIAL_STALE_LOCK_MS = 90 * 1000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTimeMs(value) {
    const parsed = value ? new Date(value).getTime() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
}

function isoDateDaysAgo(days, referenceMs = Date.now()) {
    const date = new Date(referenceMs - days * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
}

function soldWindowDays(value) {
    const months = Number(value || 1);
    if (Math.abs(months - (1 / 30)) < 0.0001) return 1;
    if (Math.abs(months - (2 / 30)) < 0.0001) return 2;
    if (months === 0.25) return 7;
    if (months === 0.5) return 14;
    if (months === 1) return 30;
    if (months === 3) return 90;
    if (months === 6) return 180;
    if (months === 12) return 365;
    return Math.max(1, Math.min(365, Math.round(months * 30)));
}

function getCustomOwnershipRange(criteria) {
    if (criteria?.ownership_range_mode !== 'custom') return null;
    const min = criteria.ownership_range_days?.min;
    const max = criteria.ownership_range_days?.max;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 365 || min >= max) {
        throw new Error('FetchJob has invalid custom ownership range metadata.');
    }
    return { min, max };
}

function getProcessorRekickReason(job, metadata, now) {
    if (!['pending', 'running'].includes(job.status)) return null;

    const lastKickAt = parseTimeMs(metadata.processor_rekick_at);
    if (lastKickAt && now - lastKickAt < PROCESSOR_REKICK_COOLDOWN_MS) return null;

    const createdAt = parseTimeMs(job.created_date) || now;
    const updatedAt = parseTimeMs(
        job.processor_heartbeat_at
        || job.updated_date
        || job.started_at
        || job.created_date
    ) || createdAt;
    const progressPct = Number(job.progress_pct || 0);
    const totalFetched = Number(job.total_fetched || 0);

    if (job.status === 'pending' && now - createdAt >= PROCESSOR_REKICK_PENDING_MS) {
        return 'pending_processor_not_started';
    }

    if (
        job.status === 'running' &&
        totalFetched === 0 &&
        progressPct <= 8 &&
        now - updatedAt >= PROCESSOR_REKICK_RUNNING_IDLE_MS
    ) {
        return 'running_without_provider_progress';
    }

    return null;
}

async function clearInitialStaleLocks(base44, job, now) {
    if (!['pending', 'running'].includes(job.status)) return 0;
    if (Number(job.total_fetched || 0) > 0 || Number(job.progress_pct || 0) > 8) return 0;

    const updatedAt = parseTimeMs(job.updated_date || job.started_at || job.created_date) || now;
    if (now - updatedAt < INITIAL_STALE_LOCK_MS) return 0;

    const rawLocks = await base44.asServiceRole.entities.PipelineLock.filter({ job_id: job.id }, '-created_date', 10).catch(() => []);
    const locks = Array.isArray(rawLocks) ? rawLocks : (rawLocks?.items || []);
    let cleared = 0;

    for (const lock of locks) {
        const lockedAt = parseTimeMs(lock.locked_at || lock.created_date);
        if (!lockedAt || now - lockedAt >= INITIAL_STALE_LOCK_MS) {
            await base44.asServiceRole.entities.PipelineLock.delete(lock.id).catch(() => {});
            cleared++;
        }
    }

    return cleared;
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

        // Use service role to ensure we can read the job regardless of who created/updated it
        const jobs = await base44.asServiceRole.entities.FetchJob.filter({ id: job_id }, null, 1);
        const jobArr = Array.isArray(jobs) ? jobs : (jobs?.items || []);

        if (jobArr.length === 0) {
            return Response.json({ error: 'Job not found' }, { status: 404 });
        }

        const job = jobArr[0];
        if (!isActualPrecisionJob(job)) {
            return Response.json({
                error: 'fetch_job_not_precision',
                message: 'This status endpoint only accepts authoritative Precision FetchJobs.'
            }, { status: 409 });
        }

        // Security: only let the user see their own jobs
        const ownsJob = job.precision_usage_user_id
            ? String(job.precision_usage_user_id) === String(user.id)
            : String(job.user_email || '').toLowerCase() === String(user.email || '').toLowerCase();
        if (!ownsJob) {
            return Response.json({ error: 'Not your job' }, { status: 403 });
        }
        const activeResolution = classifyActivePrecisionJobs(
            await loadUserPrecisionJobs(base44, user)
        );
        if (activeResolution.state === 'multiple') {
            return Response.json({
                error: 'multiple_active_precision_jobs',
                message: 'Multiple active Precision jobs require operator review. Status did not select, mutate, or re-kick any job.',
                active_job_ids: activeResolution.jobs.map(activeJob => activeJob.id)
            }, { status: 409 });
        }

        const metadata = job.dry_run_metadata || {};
        const criteriaEvidence = await verifyPrecisionJobCriteriaEvidence(job, user);
        const canonicalCriteria = criteriaEvidence.ok
            ? precisionCriteriaDiagnostic(criteriaEvidence.criteria)
            : null;
        const deliveredCount = (
            criteriaEvidence.ok
            && ['completed', 'failed', 'cancelled'].includes(job.status)
            && typeof job.precision_usage_reserved === 'number'
            && Number.isSafeInteger(job.precision_usage_reserved)
            && job.precision_usage_reserved === 0
            && typeof job.precision_usage_recorded_at === 'string'
            && Number.isFinite(new Date(job.precision_usage_recorded_at).getTime())
            && typeof job.precision_usage_count === 'number'
            && Number.isSafeInteger(job.precision_usage_count)
            && job.precision_usage_count >= 0
            && job.precision_usage_count <= canonicalCriteria.effective_count
        )
            ? job.precision_usage_count
            : null;
        const now = Date.now();
        let processorKick = null;
        let customOwnershipRange = null;
        let ownershipRangeError = null;
        try {
            customOwnershipRange = getCustomOwnershipRange(canonicalCriteria);
        } catch (error) {
            ownershipRangeError = error.message;
            job.status = 'failed';
            job.error_message = ownershipRangeError;
        }
        const ownershipRangeMode = canonicalCriteria?.ownership_range_mode || null;
        const referenceMs = precisionCriteriaReferenceMs(job);
        const ownershipReferenceDate = referenceMs === null
            ? null
            : new Date(referenceMs).toISOString();
        const customSoldAtOrAfter = customOwnershipRange
            ? `${isoDateDaysAgo(customOwnershipRange.max, referenceMs)}T00:00:00.000Z`
            : null;
        const customSoldBefore = customOwnershipRange
            ? `${isoDateDaysAgo(customOwnershipRange.min - 1, referenceMs)}T00:00:00.000Z`
            : null;
        const quickSoldAtOrAfter = !customOwnershipRange && referenceMs !== null
            ? (
                canonicalCriteria?.repull_mode === 'max_since_last'
                    ? `${new Date(canonicalCriteria.previous_pull_date).toISOString().slice(0, 10)}T00:00:00.000Z`
                    : `${isoDateDaysAgo(soldWindowDays(canonicalCriteria?.sold_months), referenceMs)}T00:00:00.000Z`
            )
            : null;
        const quickSoldBefore = !customOwnershipRange && referenceMs !== null
            ? `${new Date(referenceMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T00:00:00.000Z`
            : null;
        const soldAtOrAfter = customSoldAtOrAfter || quickSoldAtOrAfter;
        const soldBefore = customSoldBefore || quickSoldBefore;

        let active_count = 0;
        try {
            if (ownershipRangeError) throw new Error(ownershipRangeError);
            if (criteriaEvidence.ok && referenceMs === null) {
                throw new Error('Precision criteria reference timestamp is unverifiable.');
            }
            const databaseUrl = Deno.env.get('DATABASE_URL');
            if (databaseUrl) {
                const sql = neon(databaseUrl);
                const rows = await sql`
                    SELECT COUNT(*)::int AS active_count
                    FROM workspace_properties wp
                    JOIN properties p ON p.id = wp.property_id
                    WHERE wp.fetch_job_id = ${job.id}
                      AND wp.route_active = TRUE
                      AND (${soldAtOrAfter === null} OR (p.sold_date IS NOT NULL AND p.sold_date >= ${soldAtOrAfter} AND p.sold_date < ${soldBefore}))
                `;
                active_count = Number(rows?.[0]?.active_count || 0);
            }
        } catch (e) {
            console.warn('[fetchJobStatus] active count diagnostic failed:', e.message);
        }

        // Never auto-rekick an active job whose full provenance is not
        // trustworthy. The watchdog/processor recovery path will settle it
        // exactly without a provider call.
        const hasDurableProcessorClaim = job.status === 'running'
            && typeof job.processor_claim_id === 'string'
            && Boolean(job.processor_claim_id.trim());
        const rekickReason = criteriaEvidence.ok && !hasDurableProcessorClaim
            ? getProcessorRekickReason(job, metadata, now)
            : null;
        if (!criteriaEvidence.ok && ['pending', 'running'].includes(job.status)) {
            processorKick = {
                requested: false,
                reason: criteriaEvidence.code || 'precision_job_evidence_unverifiable',
                at: null,
                count: Number(metadata.processor_rekick_count || 0)
            };
        }
        if (rekickReason) {
            const rekickAt = new Date(now).toISOString();
            const rekickCount = Number(metadata.processor_rekick_count || 0) + 1;
            const processorToken = crypto.randomUUID();
            const processorTokenHash = await precisionProcessorTokenHash(processorToken);
            const staleLocksCleared = 0;
            processorKick = { requested: true, reason: rekickReason, at: rekickAt, count: rekickCount, stale_locks_cleared: staleLocksCleared };

            try {
                const latestForRekick = await base44.asServiceRole.entities.FetchJob.get(job.id);
                const latestMetadata = latestForRekick.dry_run_metadata || {};
                const updateMany = base44.asServiceRole.entities.FetchJob.updateMany;
                const rotated = typeof updateMany === 'function'
                    ? await updateMany.call(
                        base44.asServiceRole.entities.FetchJob,
                        {
                            id: job.id,
                            status: job.status,
                            processor_claim_id: job.processor_claim_id ?? null
                        },
                        {
                            $set: {
                                dry_run_metadata: {
                                    ...latestMetadata,
                                    processor_token: null,
                                    processor_token_hash: processorTokenHash,
                                    processor_rekick_at: rekickAt,
                                    processor_rekick_reason: rekickReason,
                                    processor_rekick_count: rekickCount
                                }
                            }
                        }
                    )
                    : null;
                if (rotated?.success !== true || Number(rotated?.updated) !== 1) {
                    processorKick = {
                        ...processorKick,
                        requested: false,
                        metadata_error: 'processor_rekick_claim_changed'
                    };
                } else {
                    const invokePromise = base44.asServiceRole.functions.invoke('processFetchChunk', {
                        job_id: job.id,
                        expected_chunk: job.chunk_number || 0,
                        processor_token: processorToken
                    }).catch(error => {
                        processorKick = { ...processorKick, invoke_error: 'processor_rekick_unavailable' };
                        console.warn(`[fetchJobStatus] processor re-kick failed for ${job.id}: ${error.message}`);
                    });
                    await Promise.race([invokePromise, sleep(PROCESSOR_REKICK_WAIT_MS)]);
                }
            } catch (error) {
                console.warn(`[fetchJobStatus] processor credential rotation failed for ${job.id}: ${error.message}`);
                processorKick = {
                    ...processorKick,
                    requested: false,
                    metadata_error: 'processor_rekick_unavailable'
                };
            }
        }

        return Response.json({
            job_id: job.id,
            status: ownershipRangeError ? 'failed' : job.status,
            phase: job.phase || null,
            provider: job.provider || null,
            mode_tag: job.mode_tag || null,
            progress_pct: job.progress_pct || 0,
            total_expected: job.total_expected || 0,
            total_fetched: job.total_fetched || 0,
            total_inserted: job.total_inserted || 0,
            total_existed: job.total_existed || 0,
            total_updated: job.total_updated || 0,
            total_batchdata_calls: job.total_batchdata_calls || 0,
            active_count,
            zip_codes_found: job.zip_codes_found || [],
            error_message: ownershipRangeError || job.error_message || null,
            pull_mode: job.pull_mode || (job.is_delta_pull ? 'delta_refresh' : 'full_refresh'),
            completed_sub_circles: job.completed_sub_circles || 0,
            total_sub_circles: job.total_sub_circles || 1,
            current_offset: job.current_offset || 0,
            is_delta_pull: job.is_delta_pull || false,
            delta_savings: job.delta_savings || null,
            ownership_range_mode: ownershipRangeMode,
            ownership_min_days: customOwnershipRange?.min ?? null,
            ownership_max_days: customOwnershipRange?.max ?? null,
            ownership_range_days: customOwnershipRange,
            ownership_reference_date: ownershipReferenceDate,
            polygon: criteriaEvidence.ok ? criteriaEvidence.polygon : [],
            polygon_hash: criteriaEvidence.ok ? criteriaEvidence.polygon_hash : null,
            criteria_verified: criteriaEvidence.ok,
            criteria_verification_error: criteriaEvidence.ok ? null : criteriaEvidence.code,
            criteria_invalid_fields: criteriaEvidence.ok ? [] : criteriaEvidence.invalid_fields,
            criteria_invalid_reasons: criteriaEvidence.ok ? [] : criteriaEvidence.invalid_reasons,
            criteria_mismatched_fields: criteriaEvidence.ok ? [] : criteriaEvidence.mismatched_fields,
            criteria: canonicalCriteria,
            requested_properties: canonicalCriteria?.effective_count ?? metadata.requested_properties ?? job.total_expected ?? null,
            requested_properties_before_cap: canonicalCriteria?.entered_count ?? metadata.requested_properties_before_cap ?? null,
            entered_count: canonicalCriteria?.entered_count ?? null,
            effective_count: canonicalCriteria?.effective_count ?? null,
            delivered_count: deliveredCount,
            precision_usage_count: deliveredCount,
            diagnostics: {
                requested_properties: metadata.requested_properties ?? job.total_expected ?? 0,
                requested_properties_before_cap: metadata.requested_properties_before_cap ?? metadata.requested_properties ?? job.total_expected ?? 0,
                limited_by_free_home_cap: metadata.limited_by_free_home_cap === true,
                free_properties_remaining: metadata.free_properties_remaining ?? null,
                free_property_cap: metadata.free_property_cap ?? null,
                sold_months: job.sold_months || null,
                ownership_range_mode: ownershipRangeMode,
                ownership_min_days: customOwnershipRange?.min ?? null,
                ownership_max_days: customOwnershipRange?.max ?? null,
                ownership_range_days: customOwnershipRange,
                ownership_reference_date: ownershipReferenceDate,
                area_sq_mi: job.area_sq_mi || null,
                count_mode: metadata.count_mode || null,
                filters: metadata.filters || null,
                route_filters: metadata.route_filters || null,
                route_bounds: metadata.route_bounds || { enabled: false },
                repull_mode: metadata.repull_mode || job.pull_mode || 'new_area',
                previous_pull_date: metadata.previous_pull_date || null,
                force_full_refresh: metadata.force_full_refresh === true || job.force_full_refresh === true,
                include_unresolved_followups: metadata.include_unresolved_followups === true,
                workspace_id: metadata.workspace_id || null,
                completion_reason: metadata.completion_reason || null,
                batchdata_summary: metadata.batchdata_summary || null,
                criteria_verified: criteriaEvidence.ok,
                criteria_verification_error: criteriaEvidence.ok ? null : criteriaEvidence.code,
                criteria_invalid_fields: criteriaEvidence.ok ? [] : criteriaEvidence.invalid_fields,
                criteria_invalid_reasons: criteriaEvidence.ok ? [] : criteriaEvidence.invalid_reasons,
                criteria_mismatched_fields: criteriaEvidence.ok ? [] : criteriaEvidence.mismatched_fields,
                criteria: canonicalCriteria,
                delivered_count: deliveredCount,
                processor_rekick_at: processorKick?.at || metadata.processor_rekick_at || null,
                processor_rekick_reason: processorKick?.reason || metadata.processor_rekick_reason || null,
                processor_rekick_count: processorKick?.count || metadata.processor_rekick_count || 0,
                processor_rekick_requested: processorKick?.requested === true,
                processor_rekick_error: processorKick?.invoke_error || processorKick?.metadata_error || null,
                processor_stale_locks_cleared: processorKick?.stale_locks_cleared || 0
            }
        });

    } catch (error) {
        console.error('[fetchJobStatus] Error:', error);
        const controlFailure = precisionErrorPayload(error);
        if (controlFailure.body?.error !== 'precision_start_failed') {
            return Response.json(controlFailure.body, {
                status: controlFailure.status
            });
        }
        return Response.json({
            error: 'precision_status_unavailable',
            message: 'Precision status is temporarily unavailable.'
        }, { status: 500 });
    }
});
