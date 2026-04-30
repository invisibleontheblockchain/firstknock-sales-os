import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

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

        const recentJobsRaw = await base44.asServiceRole.entities.FetchJob.list('-updated_date', 20);
        const recentJobs = (Array.isArray(recentJobsRaw) ? recentJobsRaw : (recentJobsRaw?.items || [])).map(job => ({
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
                failed_count: failedJobs.length,
                running_count: runningJobs.length,
                recent: recentJobs
            }
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});