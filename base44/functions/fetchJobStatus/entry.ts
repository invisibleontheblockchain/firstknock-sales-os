import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const PROCESSOR_REKICK_PENDING_MS = 12 * 1000;
const PROCESSOR_REKICK_RUNNING_IDLE_MS = 30 * 1000;
const PROCESSOR_REKICK_COOLDOWN_MS = 20 * 1000;
const PROCESSOR_REKICK_WAIT_MS = 900;
const INITIAL_STALE_LOCK_MS = 90 * 1000;
const JOB_MEMBERSHIP_CONTRACT = 'property_sources_v1';
const PRECISION_PIPELINE_CONTRACT = 'precision_generate_v2';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTimeMs(value) {
    const parsed = value ? new Date(value).getTime() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
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
        const body = await req.json();
        if (body.contract_probe === true) {
            return Response.json({
                success: true,
                precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
                component: 'fetchJobStatus',
                paid_provider_requests: 0
            });
        }
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

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
        const submittedPolygon = Array.isArray(job.polygon) && job.polygon.length >= 3
            ? job.polygon
            : (Array.isArray(metadata.submitted_polygon) ? metadata.submitted_polygon : []);
        const allowLegacyPointerMembership = metadata.job_membership_contract !== JOB_MEMBERSHIP_CONTRACT;
        const excludeAssigned = metadata.route_filters?.excludeAssigned !== false;
        const explicitlyReopenedHashes = [
            ...(Array.isArray(metadata.unresolved_followup_hashes_included) ? metadata.unresolved_followup_hashes_included : []),
            ...(Array.isArray(metadata.event_released_prior_route_hashes) ? metadata.event_released_prior_route_hashes : [])
        ].map(String);
        const now = Date.now();
        let processorKick = null;

        let active_count = 0;
        try {
            const databaseUrl = Deno.env.get('DATABASE_URL');
            if (databaseUrl) {
                const sql = neon(databaseUrl);
                const rows = await sql`
                    SELECT COUNT(DISTINCT wp.property_id)::int AS active_count
                    FROM workspace_properties wp
                    JOIN properties p ON p.id = wp.property_id
                    LEFT JOIN property_sources ps
                      ON ps.property_id = wp.property_id
                     AND ps.provider = 'batchdata_job'
                     AND ps.provider_record_id = ${job.id}
                    WHERE wp.user_email = ${job.user_email}
                      AND wp.route_active = TRUE
                      AND (
                          ${!excludeAssigned}
                          OR wp.assigned_route_id IS NULL
                          OR p.address_hash = ANY(${explicitlyReopenedHashes})
                      )
                      AND (
                          ps.property_id IS NOT NULL
                          OR (
                              ${allowLegacyPointerMembership}
                              AND
                              wp.fetch_job_id = ${job.id}
                          )
                      )
                `;
                active_count = Number(rows?.[0]?.active_count || 0);
            }
        } catch (e) {
            console.warn('[fetchJobStatus] active count diagnostic failed:', e.message);
        }

        const rekickReason = getProcessorRekickReason(job, metadata, now);
        if (rekickReason) {
            const rekickAt = new Date(now).toISOString();
            const rekickCount = Number(metadata.processor_rekick_count || 0) + 1;
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
                expected_chunk: job.chunk_number || 0
            }).catch(error => {
                processorKick = { ...processorKick, invoke_error: error.message };
                console.warn(`[fetchJobStatus] processor re-kick failed for ${job.id}: ${error.message}`);
            });

            await Promise.race([invokePromise, sleep(PROCESSOR_REKICK_WAIT_MS)]);
        }

        return Response.json({
            job_id: job.id,
            precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
            // Return the immutable geometry captured by this FetchJob. The UI must
            // not rebuild an exact-job route against whatever polygon happens to
            // be on the canvas when asynchronous processing finishes.
            polygon: submittedPolygon,
            polygon_hash: job.polygon_hash || null,
            status: job.status,
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
            error_message: job.error_message || null,
            pull_mode: job.pull_mode || (job.is_delta_pull ? 'delta_refresh' : 'full_refresh'),
            completed_sub_circles: job.completed_sub_circles || 0,
            total_sub_circles: job.total_sub_circles || 1,
            current_offset: job.current_offset || 0,
            is_delta_pull: job.is_delta_pull || false,
            delta_savings: job.delta_savings || null,
            diagnostics: {
                precision_pipeline_contract: metadata.precision_pipeline_contract || null,
                requested_properties: metadata.requested_properties ?? job.total_expected ?? 0,
                requested_properties_before_cap: metadata.requested_properties_before_cap ?? metadata.requested_properties ?? job.total_expected ?? 0,
                limited_by_free_home_cap: metadata.limited_by_free_home_cap === true,
                free_properties_remaining: metadata.free_properties_remaining ?? null,
                free_property_cap: metadata.free_property_cap ?? null,
                sold_months: job.sold_months || null,
                area_sq_mi: job.area_sq_mi || null,
                count_mode: metadata.count_mode || null,
                filters: metadata.filters || null,
                route_filters: metadata.route_filters || null,
                include_unresolved_followups: metadata.include_unresolved_followups === true,
                unresolved_followup_hashes_included: Array.isArray(metadata.unresolved_followup_hashes_included) ? metadata.unresolved_followup_hashes_included : [],
                event_released_prior_route_hashes: Array.isArray(metadata.event_released_prior_route_hashes) ? metadata.event_released_prior_route_hashes : [],
                prior_route_event_window_min_date: metadata.prior_route_event_window_min_date || null,
                sold_min_date: metadata.sold_min_date || metadata.batchdata_summary?.sold_min_date || null,
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
