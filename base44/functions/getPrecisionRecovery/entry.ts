import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { loadAuthoritativeUser } from '../../shared/accountIdentity.js';
import { selectOwnedPrecisionJobs } from '../../shared/precisionOrderSafety.js';
import { tenantManagerId } from '../../shared/accountTenancy.js';

const rows = value => Array.isArray(value) ? value : value?.items || [];
const RECOVERY_FIELDS = [
    'id', 'status', 'provider', 'mode_tag', 'precision_usage_user_id', 'user_email',
    'created_date', 'precision_usage_count', 'dry_run_metadata.final_delivery',
    'dry_run_metadata.support_allowance_adjustment', 'dry_run_metadata.support_route_recovery',
    'dry_run_metadata.precision_route_delivery_confirmed_at', 'dry_run_metadata.precision_recovery_dismissed_at'
];

// A rep's routes are saved in the team manager's workspace, so a rep's import
// is delivered when its homes are on routes there. Counting only routes under
// the rep's own id never found them, and the import was rebuilt on every visit.
function routeWorkspaces(user) {
    return [...new Set([tenantManagerId(user), user.id].filter(Boolean).map(String))];
}

// The account owner can retire a finished import they do not want rebuilt.
// Only the recovery offer is retired: the imported homes and usage stay.
async function dismissRecovery(service, user, jobId) {
    if (typeof jobId !== 'string' || !jobId.trim()) return Response.json({ error: 'job_id required' }, { status: 400 });
    const job = await service.FetchJob.get(jobId).catch(() => null);
    if (!job || !selectOwnedPrecisionJobs([job], user).length) return Response.json({ error: 'Import not found.' }, { status: 404 });
    if (job.status !== 'completed') {
        return Response.json({ error: 'Only a finished import can be dismissed. Cancel a running import instead.' }, { status: 409 });
    }
    const metadata = job.dry_run_metadata || {};
    if (!metadata.precision_recovery_dismissed_at) {
        // The full record was read above, so replacing metadata keeps every other field.
        await service.FetchJob.update(job.id, { dry_run_metadata: {
            ...metadata, precision_recovery_dismissed_at: new Date().toISOString(), precision_recovery_dismissed_by: user.id,
        } });
    }
    return Response.json({ success: true, job_id: job.id, dismissed: true });
}

Deno.serve(async req => {
    try {
        const base44 = createClientFromRequest(req);
        const identity = await base44.auth.me();
        if (!identity?.id) return Response.json({ error: 'Sign in required.' }, { status: 401 });
        const user = await loadAuthoritativeUser(base44, identity);
        const service = base44.asServiceRole.entities;
        const body = await req.json().catch(() => ({}));
        if (body?.action === 'dismiss') return await dismissRecovery(service, user, body.job_id);
        const byId = new Map();
        for (const filter of [{ precision_usage_user_id: user.id }, { user_email: user.email }]) {
            for (let offset = 0; ; offset += 500) {
                const batch = rows(await service.FetchJob.filter(filter, '-created_date', 500, offset, RECOVERY_FIELDS));
                for (const job of batch) byId.set(job.id, job);
                if (batch.length < 500) break;
                if (offset >= 19500) throw new Error('Import recovery history is too large.');
            }
        }
        const jobs = selectOwnedPrecisionJobs([...byId.values()], user).sort((a, b) => String(b.created_date).localeCompare(String(a.created_date)));
        const active = jobs.find(job => ['running', 'pending'].includes(job.status));
        if (active) return Response.json({ job_id: active.id, status: active.status });
        const workspaces = routeWorkspaces(user);
        for (const job of jobs) {
            if (job.status !== 'completed' || !(Number(job.precision_usage_count) > 0)) continue;
            const metadata = job.dry_run_metadata || {};
            const delivery = metadata.final_delivery;
            // A route intentionally archived/deleted after a verified delivery
            // must never reappear. Support-restored and dismissed attempts are also retired.
            if (metadata.support_allowance_adjustment || metadata.support_route_recovery
                || metadata.precision_route_delivery_confirmed_at || metadata.precision_recovery_dismissed_at
                || (delivery?.status === 'completed' && delivery.saved_route_homes_verified > 0)) continue;
            const age = Date.now() - new Date(`${String(job.created_date).replace(/Z$/, '')}Z`).getTime();
            if (!delivery && !(age < 24 * 60 * 60 * 1000)) continue;
            const savedHashes = new Set();
            for (const workspace of workspaces) {
                for (let offset = 0; ; offset += 500) {
                    const saved = rows(await service.SavedRoute.filter({ manager_id: workspace, 'metadata.precision_area.job_id': job.id }, '-created_date', 500, offset,
                        ['manager_id', 'metadata.precision_area.job_id', 'property_hashes']));
                    for (const route of saved) {
                        if (route.manager_id === workspace && route.metadata?.precision_area?.job_id === job.id) {
                            for (const hash of route.property_hashes || []) savedHashes.add(hash);
                        }
                    }
                    if (saved.length < 500) break;
                    if (offset >= 19500) throw new Error('Too many saved routes to verify recovery.');
                }
            }
            const expected = Math.max(1, Math.min(Number(job.precision_usage_count), Number(delivery?.generated_homes_reported) || Number(job.precision_usage_count)));
            if (savedHashes.size >= expected) continue;
            return Response.json({ job_id: job.id, status: job.status, imported_homes: job.precision_usage_count,
                saved_homes: savedHashes.size, remaining_homes: expected - savedHashes.size });
        }
        return Response.json({ job_id: null });
    } catch (error) {
        console.error('[getPrecisionRecovery]', error.message);
        return Response.json({ error: 'Import recovery could not be checked. Your imported homes are retained.' }, { status: 503 });
    }
});
