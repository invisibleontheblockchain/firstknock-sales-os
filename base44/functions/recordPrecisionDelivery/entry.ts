import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import { isPrecisionJob, precisionJobBelongsToSubject } from '../../shared/precisionOrderSafety.js';

const DATABASE_URL = Deno.env.get('DATABASE_URL');
const MAX_COUNT = 1000000;

function deliveryReport(body) {
    const count = value => {
        if (!Number.isInteger(value) || value < 0 || value > MAX_COUNT) throw new Error('Invalid delivery count.');
        return value;
    };
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(body.attempt_id || '')) throw new Error('Invalid delivery attempt.');
    if (!['completed', 'partial', 'failed'].includes(body.status)) throw new Error('Invalid delivery status.');
    if (!Array.isArray(body.filter_stages) || body.filter_stages.length > 30) throw new Error('Invalid filter stages.');
    let previousCount = null;
    const stages = body.filter_stages.map(stage => {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(stage.name || '')) throw new Error('Invalid filter stage.');
        const stageCount = count(stage.count);
        if (previousCount !== null && stageCount > previousCount) throw new Error('Filter counts must not increase.');
        const dropped = previousCount === null ? 0 : previousCount - stageCount;
        previousCount = stageCount;
        return { name: stage.name, count: stageCount, dropped };
    });
    const failureStage = body.failure_stage || null;
    if (failureStage && !/^[a-zA-Z_]{1,40}$/.test(failureStage)) throw new Error('Invalid failure stage.');
    return {
        attempt_id: body.attempt_id, status: body.status, failure_stage: failureStage,
        candidate_homes_reported: count(body.candidate_homes),
        generated_homes_reported: count(body.generated_homes),
        in_memory_homes_reported: count(body.in_memory_homes),
        failed_route_saves_reported: count(body.failed_route_saves),
        filter_stages_reported: stages
    };
}

Deno.serve(async req => {
    try {
        if (req.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 });
        const body = await req.json();
        if (!body.job_id || typeof body.job_id !== 'string') return Response.json({ error: 'job_id_required' }, { status: 400 });
        let report;
        try { report = deliveryReport(body); }
        catch (error) { return Response.json({ error: 'invalid_delivery_report', message: error.message }, { status: 400 }); }
        const service = base44.asServiceRole.entities;
        const job = await service.FetchJob.get(body.job_id).catch(() => null);
        // Immutable identity wins over email; admin flags grant no cross-account writes.
        if (!isPrecisionJob(job) || !precisionJobBelongsToSubject(job, user)) {
            return Response.json({ error: 'job_not_found' }, { status: 404 });
        }
        if (job.status !== 'completed') return Response.json({ error: 'job_not_completed' }, { status: 409 });
        if (!DATABASE_URL) return Response.json({ error: 'delivery_verification_unavailable' }, { status: 503 });
        const sql = neon(DATABASE_URL);
        const imported = await sql`
            SELECT p.address_hash FROM workspace_properties wp JOIN properties p ON p.id = wp.property_id
            WHERE wp.fetch_job_id = ${job.id} AND wp.user_email = ${job.user_email || user.email}
              AND wp.route_active = TRUE
        `;
        const importedHashes = new Set(imported.map(row => String(row.address_hash)));
        const deliveredHashes = new Set();
        let savedRouteCount = 0;
        // Saved counts come from owned, job-associated routes, never client claims.
        for (let offset = 0; ; offset += 500) {
            const response = await service.SavedRoute.filter({
                manager_id: user.id, 'metadata.precision_area.job_id': job.id
            }, '-created_date', 500, offset);
            const routes = Array.isArray(response) ? response : response?.items;
            if (!Array.isArray(routes)) throw new Error('Invalid saved route verification response.');
            for (const route of routes) {
                if (route.manager_id !== user.id || route.metadata?.precision_area?.job_id !== job.id || route.status === 'ARCHIVED') continue;
                savedRouteCount++;
                for (const hash of route.property_hashes || []) {
                    if (importedHashes.has(String(hash))) deliveredHashes.add(String(hash));
                }
            }
            if (routes.length < 500) break;
        }
        const providerRecords = Math.max(0, Number(job.total_fetched) || 0);
        const finalDelivery = {
            version: 1, scope: 'whole_job', recorded_at: new Date().toISOString(), ...report,
            provider_records_returned: providerRecords,
            imported_route_active_homes_verified: importedHashes.size,
            saved_route_count_verified: savedRouteCount,
            saved_route_homes_verified: deliveredHashes.size,
            imported_homes_not_in_saved_routes: Math.max(0, importedHashes.size - deliveredHashes.size),
            returned_records_not_in_saved_routes: Math.max(0, providerRecords - deliveredHashes.size),
            saved_route_loss_percent: providerRecords > 0
                ? Math.round(10000 * Math.max(0, providerRecords - deliveredHashes.size) / providerRecords) / 100 : 0
        };
        // Observations cannot alter usage, reservations, job state, or provider counters.
        await service.FetchJob.update(job.id, {
            dry_run_metadata: { ...(job.dry_run_metadata || {}), final_delivery: finalDelivery }
        });
        return Response.json({ success: true, final_delivery: finalDelivery });
    } catch (error) {
        console.error('[recordPrecisionDelivery]', error.message);
        return Response.json({ error: 'delivery_verification_failed' }, { status: 500 });
    }
});
