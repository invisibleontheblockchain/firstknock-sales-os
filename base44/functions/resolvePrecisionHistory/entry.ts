import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
    precisionErrorPayload,
    resolveVerifiedPrecisionHistory
} from '../_shared/precisionActiveJobCriteria.js';

function hasOwn(value, key) {
    return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        let body;
        try {
            body = await req.json();
        } catch (_error) {
            return Response.json({
                error: 'precision_history_request_invalid',
                message: 'Precision history requires a JSON object request body.'
            }, { status: 400 });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return Response.json({
                error: 'precision_history_request_invalid',
                message: 'Precision history requires a JSON object request body.'
            }, { status: 400 });
        }

        const unexpectedFields = Object.keys(body).filter(field => field !== 'fetch_job_id');
        if (unexpectedFields.length) {
            return Response.json({
                error: 'precision_history_request_invalid',
                message: 'Precision history accepts only an optional fetch_job_id lookup hint.',
                rejected_fields: unexpectedFields
            }, { status: 400 });
        }
        if (
            hasOwn(body, 'fetch_job_id')
            && (
                typeof body.fetch_job_id !== 'string'
                || !body.fetch_job_id.trim()
            )
        ) {
            return Response.json({
                error: 'invalid_fetch_job_id',
                message: 'fetch_job_id must be a nonempty string.'
            }, { status: 400 });
        }

        // Browser-provided identity, workspace, email, polygon and criteria
        // fields are rejected above. The authenticated subject and service-role
        // FetchJob rows are the only authority.
        const resolution = await resolveVerifiedPrecisionHistory(base44, user, {
            fetchJobId: hasOwn(body, 'fetch_job_id') ? body.fetch_job_id.trim() : null,
            limit: 20
        });
        return Response.json(resolution);
    } catch (error) {
        const failure = precisionErrorPayload(error);
        return Response.json(failure.body, { status: failure.status });
    }
});
