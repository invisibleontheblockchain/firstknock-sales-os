import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import {
    hasPrecisionJobMarkers,
    isActualPrecisionJob,
    listAllPrecisionRecords,
    PrecisionControlError,
    precisionErrorPayload
} from '../_shared/precisionActiveJobCriteria.js';

function jobTimestamp(job) {
    const parsed = new Date(job?.updated_date || job?.completed_at || job?.created_date || 0).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });

        const sql = neon(databaseUrl);
        const body = await req.json().catch(() => ({}));
        const targetEmail = body.user_email || user.email;

        const propertyStats = await sql`
            SELECT
                COUNT(*)::int AS global_properties,
                COUNT(*) FILTER (WHERE sold_date >= NOW() - INTERVAL '30 days')::int AS sold_last_30_days,
                COUNT(*) FILTER (WHERE sale_type = 'MLS')::int AS mls_properties,
                COUNT(*) FILTER (WHERE original_status = 'REJECTED' OR sale_confidence = 'REJECTED')::int AS rejected_properties
            FROM properties
        `;

        const workspaceStats = await sql`
            SELECT
                COUNT(*)::int AS workspace_properties,
                COUNT(*) FILTER (WHERE route_active = TRUE)::int AS active_workspace_properties,
                COUNT(DISTINCT p.zip_code)::int AS zip_count
            FROM workspace_properties wp
            JOIN properties p ON p.id = wp.property_id
            WHERE wp.user_email = ${targetEmail}
        `;

        const storage = await sql`
            SELECT
                relname AS table_name,
                pg_total_relation_size(relid)::bigint AS total_bytes,
                pg_relation_size(relid)::bigint AS table_bytes,
                (pg_total_relation_size(relid) - pg_relation_size(relid))::bigint AS index_bytes
            FROM pg_catalog.pg_statio_user_tables
            WHERE relname IN ('properties', 'workspace_properties', 'property_sources', 'ingestion_metrics')
            ORDER BY relname
        `;

        // Query only strong Precision identity/evidence classes. FetchJob's
        // former provider/mode/phase defaults make those fields unsafe as
        // standalone global discovery predicates.
        const fetchJobs = base44.asServiceRole.entities.FetchJob;
        const candidateFilters = [
            { precision_usage_user_id: { $ne: null } },
            { precision_usage_kind: { $ne: null } },
            { precision_usage_reserved: { $gt: 0 } },
            { precision_usage_count: { $gt: 0 } },
            { precision_usage_period_start: { $ne: null } },
            { precision_usage_period_end: { $ne: null } },
            { precision_usage_recorded_at: { $ne: null } },
            { precision_subscription_id: { $ne: null } },
            { precision_invoice_id: { $ne: null } },
            { precision_cancel_requested_at: { $ne: null } },
            { precision_watchdog_recovery_at: { $ne: null } },
            { processor_claim_id: { $ne: null } },
            { source_fetch_job_id: { $ne: null } },
            { root_fetch_job_id: { $ne: null } },
            { attempt_reason: { $ne: null } }
        ];
        const candidateGroups = await Promise.all(candidateFilters.map(filter =>
            listAllPrecisionRecords(fetchJobs, filter, '-updated_date')
        ));
        const precisionJobsById = new Map();
        const identityConflictIds = [];
        for (const group of candidateGroups) {
            for (const job of group) {
                if (job?.id && hasPrecisionJobMarkers(job) && !isActualPrecisionJob(job)) {
                    identityConflictIds.push(String(job.id));
                } else if (job?.id && isActualPrecisionJob(job)) {
                    precisionJobsById.set(String(job.id), job);
                }
            }
        }
        if (identityConflictIds.length) {
            throw new PrecisionControlError(
                'precision_job_identity_conflict',
                'Marker-bearing rows have conflicting Precision identity, so diagnostics cannot prove completeness.',
                409,
                {
                    conflicting_job_ids: [...new Set(identityConflictIds)],
                    discovery_complete: false
                }
            );
        }
        const allPrecisionJobs = [...precisionJobsById.values()]
            .sort((left, right) =>
                jobTimestamp(right) - jobTimestamp(left)
                || String(left.id).localeCompare(String(right.id))
            );
        const recentJobs = allPrecisionJobs
            .slice(0, 20)
            .filter(isActualPrecisionJob)
            .map(job => ({
            id: job.id,
            status: job.status,
            phase: job.phase,
            progress_pct: job.progress_pct,
            user_email: job.user_email,
            error_message: job.error_message,
            updated_date: job.updated_date,
            completed_at: job.completed_at
            }));

        const failedJobs = recentJobs.filter(job => job.status === 'failed');
        const runningJobs = recentJobs.filter(job => job.status === 'running');
        const totalStorageBytes = storage.reduce((sum, row) => sum + Number(row.total_bytes || 0), 0);

        return Response.json({
            success: true,
            checked_at: new Date().toISOString(),
            user_email: targetEmail,
            property_stats: propertyStats[0],
            workspace_stats: workspaceStats[0],
            storage: {
                total_mb: Math.round((totalStorageBytes / 1024 / 1024) * 100) / 100,
                tables: storage.map(row => ({
                    table_name: row.table_name,
                    total_mb: Math.round((Number(row.total_bytes) / 1024 / 1024) * 100) / 100,
                    table_mb: Math.round((Number(row.table_bytes) / 1024 / 1024) * 100) / 100,
                    index_mb: Math.round((Number(row.index_bytes) / 1024 / 1024) * 100) / 100
                }))
            },
            jobs: {
                recent_count: recentJobs.length,
                precision_jobs_scanned: allPrecisionJobs.length,
                discovery_complete: true,
                recent_truncated: allPrecisionJobs.length > recentJobs.length,
                failed_count: failedJobs.length,
                running_count: runningJobs.length,
                recent: recentJobs
            }
        });
    } catch (error) {
        const failure = precisionErrorPayload(error);
        return Response.json(failure.body, { status: failure.status });
    }
});
