import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const KEVIN_EMAIL = 'kevin@reifenvironmentals.com';

async function listAll(entity, filter = {}, sort = '-created_date', pageSize = 1000) {
    const records = [];
    for (let skip = 0; skip < 20000; skip += pageSize) {
        const page = await entity.filter(filter, sort, pageSize, skip).catch(() => []);
        const arr = Array.isArray(page) ? page : (page?.items || []);
        records.push(...arr);
        if (arr.length < pageSize) break;
    }
    return records;
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const body = await req.json().catch(() => ({}));
        const protectedEmail = String(body.protected_email || KEVIN_EMAIL).toLowerCase();
        const databaseUrl = Deno.env.get('DATABASE_URL');
        const sql = databaseUrl ? neon(databaseUrl) : null;

        const activeJobsRaw = await base44.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', 20).catch(() => []);
        const pendingJobsRaw = await base44.asServiceRole.entities.FetchJob.filter({ status: 'pending' }, '-updated_date', 20).catch(() => []);
        const activeJobs = [...(Array.isArray(activeJobsRaw) ? activeJobsRaw : activeJobsRaw?.items || []), ...(Array.isArray(pendingJobsRaw) ? pendingJobsRaw : pendingJobsRaw?.items || [])];

        const teamMembers = await listAll(base44.asServiceRole.entities.TeamMember, { email: protectedEmail });
        const protectedMemberIds = new Set(teamMembers.map(member => member.id).filter(Boolean));

        const routesByEmail = await listAll(base44.asServiceRole.entities.SavedRoute, { assigned_to_name: protectedEmail });
        const allRoutes = await listAll(base44.asServiceRole.entities.SavedRoute, {}, '-updated_date', 500);
        const protectedRoutes = allRoutes.filter(route =>
            String(route.assigned_to_name || '').toLowerCase() === protectedEmail ||
            protectedMemberIds.has(route.assigned_to) ||
            String(route.created_by || '').toLowerCase() === protectedEmail ||
            String(route.manager_id || '').toLowerCase() === protectedEmail ||
            routesByEmail.some(match => match.id === route.id)
        );
        const protectedHashes = [...new Set(protectedRoutes.flatMap(route => route.property_hashes || []).filter(Boolean))];

        const interactionLogs = [];
        for (let i = 0; i < protectedHashes.length; i += 100) {
            const batch = protectedHashes.slice(i, i + 100);
            const rows = await base44.asServiceRole.entities.InteractionLog.filter({ address_hash: batch }, '-created_date', 1000).catch(() => []);
            interactionLogs.push(...(Array.isArray(rows) ? rows : rows?.items || []));
        }

        let neonSummary = null;
        if (sql) {
            const protectedRouteRows = protectedHashes.length > 0 ? await sql`
                SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE data_source ILIKE '%rentcast%')::int AS rentcast_rows,
                    COUNT(*) FILTER (WHERE data_source ILIKE '%batchdata%')::int AS batchdata_rows,
                    COUNT(*) FILTER (WHERE COALESCE(original_status, '') = 'REJECTED' OR COALESCE(sale_confidence, '') = 'REJECTED')::int AS rejected_rows
                FROM properties
                WHERE address_hash = ANY(${protectedHashes}) OR legacy_hash = ANY(${protectedHashes})
            ` : [{ total: 0, rentcast_rows: 0, batchdata_rows: 0, rejected_rows: 0 }];

            const globalRows = await sql`
                SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE data_source ILIKE '%rentcast%')::int AS rentcast_rows,
                    COUNT(*) FILTER (WHERE data_source ILIKE '%batchdata%')::int AS batchdata_rows,
                    COUNT(*) FILTER (WHERE COALESCE(original_status, '') = 'REJECTED' OR COALESCE(sale_confidence, '') = 'REJECTED')::int AS rejected_rows
                FROM properties
            `;

            neonSummary = {
                protected_routes: protectedRouteRows[0] || {},
                global: globalRows[0] || {},
                purge_candidates: {
                    rentcast_rows_total: Number(globalRows[0]?.rentcast_rows || 0),
                    rentcast_rows_protected: Number(protectedRouteRows[0]?.rentcast_rows || 0),
                    rentcast_rows_safe_to_review: Math.max(0, Number(globalRows[0]?.rentcast_rows || 0) - Number(protectedRouteRows[0]?.rentcast_rows || 0))
                }
            };
        }

        return Response.json({
            success: true,
            safe_to_migrate_now: activeJobs.length === 0,
            blockers: activeJobs.length > 0 ? ['Active or pending FetchJob exists — do not migrate/purge until it completes or is cancelled.'] : [],
            protected_email: protectedEmail,
            active_jobs: activeJobs.map(job => ({ id: job.id, status: job.status, phase: job.phase, user_email: job.user_email, progress_pct: job.progress_pct, updated_date: job.updated_date })),
            protected_snapshot: {
                team_members: teamMembers.length,
                saved_routes: protectedRoutes.length,
                protected_property_hashes: protectedHashes.length,
                interaction_logs: interactionLogs.length,
                route_ids: protectedRoutes.map(route => route.id)
            },
            neon: neonSummary,
            next_step: 'Use this snapshot before any purge. Protected hashes must be excluded from cleanup unless a route-safe replacement exists.'
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});