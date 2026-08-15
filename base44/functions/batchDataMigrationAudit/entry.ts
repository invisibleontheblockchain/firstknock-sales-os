import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import {
    hasPrecisionJobMarkers,
    isActualPrecisionJob,
    listAllPrecisionRecords,
    PrecisionControlError,
    precisionErrorPayload
} from '../_shared/precisionActiveJobCriteria.js';

const KEVIN_EMAIL = 'kevin@reifenvironmental.com';

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
        if (!databaseUrl) {
            return Response.json({
                error: 'migration_audit_incomplete',
                message: 'DATABASE_URL is required to prove migration safety.',
                audit_complete: false,
                safe_to_migrate_now: false
            }, { status: 503 });
        }
        const sql = neon(databaseUrl);

        const activeCandidateFilters = ['running', 'pending'].flatMap(status => ([
            { status, precision_usage_user_id: { $ne: null } },
            { status, precision_usage_kind: { $ne: null } },
            { status, precision_usage_reserved: { $gt: 0 } },
            { status, precision_usage_count: { $gt: 0 } },
            { status, precision_usage_period_start: { $ne: null } },
            { status, precision_usage_period_end: { $ne: null } },
            { status, precision_usage_recorded_at: { $ne: null } },
            { status, precision_cancel_requested_at: { $ne: null } },
            { status, precision_watchdog_recovery_at: { $ne: null } },
            { status, processor_claim_id: { $ne: null } },
            { status, source_fetch_job_id: { $ne: null } },
            { status, root_fetch_job_id: { $ne: null } },
            { status, attempt_reason: { $ne: null } }
        ]));
        const activeGroups = await Promise.all(activeCandidateFilters.map(filter =>
            listAllPrecisionRecords(
                base44.asServiceRole.entities.FetchJob,
                filter,
                '-updated_date'
            )
        ));
        const activeCandidatesById = new Map();
        for (const group of activeGroups) {
            for (const job of group) {
                if (job?.id) activeCandidatesById.set(String(job.id), job);
            }
        }
        const activeCandidates = [...activeCandidatesById.values()];
        const identityConflictIds = activeCandidates
            .filter(job => hasPrecisionJobMarkers(job) && !isActualPrecisionJob(job))
            .map(job => job.id);
        if (identityConflictIds.length) {
            throw new PrecisionControlError(
                'precision_job_identity_conflict',
                'Marker-bearing active rows have conflicting Precision identity. Migration safety is not proven.',
                409,
                {
                    audit_complete: false,
                    safe_to_migrate_now: false,
                    conflicting_job_ids: [...new Set(identityConflictIds)]
                }
            );
        }
        const activeJobs = activeCandidates.filter(isActualPrecisionJob);

        const teamMembers = await listAllPrecisionRecords(base44.asServiceRole.entities.TeamMember, { email: protectedEmail });
        const protectedMemberIds = new Set(teamMembers.map(member => member.id).filter(Boolean));

        const routesByEmail = await listAllPrecisionRecords(base44.asServiceRole.entities.SavedRoute, { assigned_to_name: protectedEmail });
        const allRoutes = await listAllPrecisionRecords(base44.asServiceRole.entities.SavedRoute, {}, '-updated_date', 500);
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
            const rows = await base44.asServiceRole.entities.InteractionLog.filter(
                { address_hash: batch },
                '-created_date',
                1000
            );
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

        const mustKeepRoutes = protectedRoutes
            .filter(route => /upper mount p|middle mount p|lower mount p/i.test(route.name || ''))
            .map(route => ({
                id: route.id,
                name: route.name,
                status: route.status,
                assigned_to: route.assigned_to,
                assigned_to_name: route.assigned_to_name,
                house_count: route.property_hashes?.length || 0
            }));

        return Response.json({
            success: true,
            audit_complete: true,
            safe_to_migrate_now: activeJobs.length === 0 && mustKeepRoutes.length === 3,
            blockers: [
                ...(activeJobs.length > 0 ? ['Active or pending FetchJob exists — do not migrate/purge until it completes or is cancelled.'] : []),
                ...(mustKeepRoutes.length !== 3 ? ['Upper/Middle/Lower Mount P protection is incomplete — do not migrate/purge.'] : [])
            ],
            protected_email: protectedEmail,
            active_jobs: activeJobs.map(job => ({ id: job.id, status: job.status, phase: job.phase, user_email: job.user_email, progress_pct: job.progress_pct, updated_date: job.updated_date })),
            protected_snapshot: {
                team_members: teamMembers.length,
                saved_routes: protectedRoutes.length,
                protected_property_hashes: protectedHashes.length,
                interaction_logs: interactionLogs.length,
                route_ids: protectedRoutes.map(route => route.id),
                must_keep_routes: mustKeepRoutes
            },
            neon: neonSummary,
            next_step: 'Use this snapshot before any purge. Protected hashes must be excluded from cleanup unless a route-safe replacement exists.'
        });
    } catch (error) {
        const failure = precisionErrorPayload(error);
        return Response.json(failure.body, { status: failure.status });
    }
});
