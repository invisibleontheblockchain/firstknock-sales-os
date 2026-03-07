import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

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

        return Response.json({
            status: job.status,
            progress_pct: job.progress_pct || 0,
            total_expected: job.total_expected || 0,
            total_fetched: job.total_fetched || 0,
            total_inserted: job.total_inserted || 0,
            total_existed: job.total_existed || 0,
            total_updated: job.total_updated || 0,
            zip_codes_found: job.zip_codes_found || [],
            error_message: job.error_message || null
        });

    } catch (error) {
        console.error('[fetchJobStatus] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});