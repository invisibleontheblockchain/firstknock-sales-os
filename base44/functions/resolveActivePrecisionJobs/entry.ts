import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
    buildVerifiedActiveJobContext,
    precisionErrorPayload,
    resolveActivePrecisionJobs
} from '../_shared/precisionActiveJobCriteria.js';

function activeDescriptor(job) {
    return {
        id: job.id,
        status: job.status,
        created_at: job.created_date || null,
        started_at: job.started_at || null
    };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        // Identity is always the authenticated user. Request-body email, user ID
        // and workspace hints intentionally have no role in this resolver.
        const resolution = await resolveActivePrecisionJobs(base44, user);
        if (resolution.state === 'none') {
            return Response.json({ state: 'none', jobs: [] });
        }
        if (resolution.state === 'multiple') {
            return Response.json({
                error: 'multiple_active_precision_jobs',
                message: 'Multiple active Precision jobs exist for this account. No job was selected or changed.',
                state: 'multiple',
                jobs: resolution.jobs.map(activeDescriptor)
            }, { status: 409 });
        }

        const job = await buildVerifiedActiveJobContext(resolution.job, user);
        return Response.json({ state: 'single', job });
    } catch (error) {
        const failure = precisionErrorPayload(error);
        return Response.json(failure.body, { status: failure.status });
    }
});
