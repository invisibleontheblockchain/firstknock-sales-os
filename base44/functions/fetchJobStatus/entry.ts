import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

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

function getCustomOwnershipRange(job) {
    const metadata = job?.dry_run_metadata || {};
    if (metadata.ownership_range_mode !== 'custom') return null;
    const min = Number(metadata.ownership_range_days?.min);
    const max = Number(metadata.ownership_range_days?.max);
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
    const updatedAt = parseTimeMs(job.updated_date || job.started_at || job.created_date) || createdAt;
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

        // Security: only let the user see their own jobs
        if (job.user_email !== user.email) {
            return Response.json({ error: 'Not your job' }, { status: 403 });
        }

        const metadata = job.dry_run_metadata || {};
        const now = Date.now();
        let processorKick = null;
        let customOwnershipRange = null;
        let ownershipRangeError = null;
        try {
            customOwnershipRange = getCustomOwnershipRange(job);
        } catch (error) {
            ownershipRangeError = error.message;
            job.status = 'failed';
            job.error_message = ownershipRangeError;
            await base44.asServiceRole.entities.FetchJob.update(job.id, {
                status: 'failed',
                error_message: ownershipRangeError
            }).catch(() => {});
        }
        const ownershipRangeMode = metadata.ownership_range_mode === 'custom' ? 'custom' : 'quick';
        const referenceMs = parseTimeMs(job.created_date || job.started_at) || now;
        const customSoldAtOrAfter = customOwnershipRange
            ? `${isoDateDaysAgo(customOwnershipRange.max, referenceMs)}T00:00:00.000Z`
            : null;
        const customSoldBefore = customOwnershipRange
            ? `${isoDateDaysAgo(customOwnershipRange.min - 1, referenceMs)}T00:00:00.000Z`
            : null;

        let active_count = 0;
        try {
            if (ownershipRangeError) throw new Error(ownershipRangeError);
            const databaseUrl = Deno.env.get('DATABASE_URL');
            if (databaseUrl) {
                const sql = neon(databaseUrl);
                const rows = await sql`
                    SELECT COUNT(*)::int AS active_count
                    FROM workspace_properties wp
                    JOIN properties p ON p.id = wp.property_id
                    WHERE wp.fetch_job_id = ${job.id}
                      AND wp.user_email = ${job.user_email}
                      AND wp.route_active = TRUE
                      AND (${customOwnershipRange === null} OR (p.sold_date IS NOT NULL AND p.sold_date >= ${customSoldAtOrAfter} AND p.sold_date < ${customSoldBefore}))
                `;
                active_count = Number(rows?.[0]?.active_count || 0);
            }
        } catch (e) {
            console.warn('[fetchJobStatus] active count diagnostic failed:', e.message);
        }

        const rekickReason = getProcessorRekickReason(job, metadata, now);
        if (rekickReason && !metadata.processor_token) {
            const legacyMessage = 'This import predates the secured processor handoff. Retry the import to continue with the original criteria.';
            job.status = 'failed';
            job.error_message = legacyMessage;
            processorKick = {
                requested: false,
                reason: 'missing_processor_token',
                at: new Date(now).toISOString(),
                count: Number(metadata.processor_rekick_count || 0)
            };
            await base44.asServiceRole.entities.FetchJob.update(job.id, {
                status: 'failed',
                error_message: legacyMessage,
                error_log: [...(job.error_log || []), `[${new Date(now).toISOString()}] ${legacyMessage}`]
            }).catch(error => {
                processorKick = { ...processorKick, metadata_error: error.message };
            });
        } else if (rekickReason) {
            const rekickAt = new Date(now).toISOString();
            const rekickCount = Number(metadata.processor_rekick_count || 0) + 1;
            const processorToken = metadata.processor_token;
            const staleLocksCleared = await clearInitialStaleLocks(base44, job, now);
            processorKick = { requested: true, reason: rekickReason, at: rekickAt, count: rekickCount, stale_locks_cleared: staleLocksCleared };

            await base44.asServiceRole.entities.FetchJob.update(job.id, {
                dry_run_metadata: {
                    ...metadata,
                    processor_rekick_at: rekickAt,
                    processor_rekick_reason: rekickReason,
                    processor_rekick_count: rekickCount
                }
            }).catch(error => {
                processorKick = { ...processorKick, metadata_error: error.message };
            });

            const invokePromise = base44.asServiceRole.functions.invoke('processFetchChunk', {
                job_id: job.id,
                expected_chunk: job.chunk_number || 0,
                processor_token: processorToken
            }).catch(error => {
                processorKick = { ...processorKick, invoke_error: error.message };
                console.warn(`[fetchJobStatus] processor re-kick failed for ${job.id}: ${error.message}`);
            });

            await Promise.race([invokePromise, sleep(PROCESSOR_REKICK_WAIT_MS)]);
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
            ownership_reference_date: job.created_date || job.started_at || null,
            polygon: job.polygon || [],
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
                ownership_reference_date: job.created_date || job.started_at || null,
                area_sq_mi: job.area_sq_mi || null,
                count_mode: metadata.count_mode || null,
                filters: metadata.filters || null,
                route_filters: metadata.route_filters || null,
                completion_reason: metadata.completion_reason || null,
                batchdata_summary: metadata.batchdata_summary || null,
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
        return Response.json({ error: error.message }, { status: 500 });
    }
});
