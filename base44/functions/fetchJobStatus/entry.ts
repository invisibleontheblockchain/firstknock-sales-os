import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

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

        let active_count = 0;
        try {
            const databaseUrl = Deno.env.get('DATABASE_URL');
            if (databaseUrl) {
                const sql = neon(databaseUrl);
                const rows = await sql`
                    SELECT COUNT(*)::int AS active_count
                    FROM workspace_properties wp
                    JOIN properties p ON p.id = wp.property_id
                    WHERE wp.fetch_job_id = ${job.id}
                      AND wp.user_email = ${job.user_email}
                      AND (
                          wp.route_active = TRUE
                          OR (
                              p.data_source = 'batchdata'
                              AND lower(coalesce(p.property_type, '')) NOT LIKE '%commercial%'
                              AND lower(coalesce(p.property_type, '')) NOT LIKE '%industrial%'
                              AND lower(coalesce(p.property_type, '')) NOT LIKE '%vacant%'
                              AND lower(coalesce(p.property_type, '')) NOT LIKE '%agricultural%'
                              AND lower(coalesce(p.property_type, '')) NOT LIKE '%land%'
                              AND lower(coalesce(p.property_type, '')) NOT LIKE '%lot%'
                          )
                      )
                `;
                active_count = Number(rows?.[0]?.active_count || 0);
            }
        } catch (e) {
            console.warn('[fetchJobStatus] active count diagnostic failed:', e.message);
        }

        return Response.json({
            job_id: job.id,
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
                requested_properties: metadata.requested_properties ?? job.total_expected ?? 0,
                requested_properties_before_cap: metadata.requested_properties_before_cap ?? metadata.requested_properties ?? job.total_expected ?? 0,
                limited_by_free_home_cap: metadata.limited_by_free_home_cap === true,
                free_properties_remaining: metadata.free_properties_remaining ?? null,
                free_property_cap: metadata.free_property_cap ?? null,
                sold_months: job.sold_months || null,
                area_sq_mi: job.area_sq_mi || null,
                count_mode: metadata.count_mode || null,
                filters: metadata.filters || null,
                completion_reason: metadata.completion_reason || null,
                batchdata_summary: metadata.batchdata_summary || null
            }
        });

    } catch (error) {
        console.error('[fetchJobStatus] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});
