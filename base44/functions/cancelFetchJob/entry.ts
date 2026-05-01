import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

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
        if (job.user_email !== user.email) {
            return Response.json({ error: 'Not your job' }, { status: 403 });
        }

        if (!['pending', 'running'].includes(job.status)) {
            return Response.json({ status: job.status, job_id, message: 'Job is not active' });
        }

        const cancelledAt = new Date().toISOString();
        const errorLog = [...(job.error_log || []), `[${cancelledAt}] Cancelled by user.`];
        await base44.asServiceRole.entities.FetchJob.update(job_id, {
            status: 'cancelled',
            error_message: 'Cancelled by user',
            completed_at: cancelledAt,
            error_log: errorLog
        });

        const locks = await base44.asServiceRole.entities.PipelineLock.filter({ job_id }, null, 20).catch(() => []);
        const lockArr = Array.isArray(locks) ? locks : (locks?.items || []);
        await Promise.all(lockArr.map(lock => base44.asServiceRole.entities.PipelineLock.delete(lock.id).catch(() => {})));

        return Response.json({ status: 'cancelled', job_id });
    } catch (error) {
        console.error('[cancelFetchJob] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});