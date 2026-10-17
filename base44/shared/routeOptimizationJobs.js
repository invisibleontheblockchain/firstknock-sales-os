// Background road search for routes the SERVER generates (rep anchor change,
// backend generation, recent-sales routes). The server call returns at once;
// a RouteOptimizationJob then runs the app's exact multi-pass search
// (roadMatrixSearch.js), one pass per worker call:
//
// - Resumable: the search state is saved after every pass; any worker call can
//   continue it. A call that dies leaves its lease to expire, and the sweep
//   (every 5 minutes) or the next chained call resumes from the last pass.
// - Idempotent: a lease token admits one worker at a time; a pass that is
//   repeated after a crash recomputes the same answer; a route write happens
//   only when the result saves measurably more than what was already written.
// - Safe with edits: before every write the route must still have the job's
//   stop order, status (not started), assignee and bounds, and no door knocked
//   since the job began. Otherwise the job ends as "discarded" and never
//   touches the route. A newer job for the same route cancels the older one.

import { tryRoadMatrixOptimize } from './roadMatrixSearch.js';
import { signWorkerCredential } from './routeOptimizationWorkerAuth.js';
import { routePropertyOrderFingerprint } from './routeFingerprint.js';

export const JOB_LEASE_MS = 4 * 60 * 1000;
export const PASSES_PER_CALL = 1;
export const MAX_JOB_ATTEMPTS = 20;
export const AWAITING_ROUTE_MS = 60 * 60 * 1000;
export const MIN_IMPROVEMENT_MILES = 0.05;
const ACTIVE = ['awaiting_route', 'queued', 'running'];
const UNSTARTED = new Set(['PENDING', 'ACTIVE', '', undefined, null]);
// A pass that failed for these reasons is retried later from the last saved
// state (the sweep restarts the job); anything else is the search's answer.
const TRANSIENT = new Set(['backend_unavailable', 'deadline_exceeded', 'backend_cpu_limit', 'backend_rate_limited', 'aerial_fallback']);
const PRIVATE_BOUNDS_FIELDS = ['start_constraint', 'end_constraint', 'start_location', 'end_location', 'road_geometry', 'road_geometry_segments'];

const key = property => String(property?.address_hash || property?.legacy_hash || property?.id || '');
const asArray = value => (Array.isArray(value) ? value : value?.items || []);
const iso = ms => new Date(ms).toISOString();
const isPoint = value => Number.isFinite(Number(value?.lat)) && Number.isFinite(Number(value?.lng));

// Just what the search needs from each stop; nothing about the homeowner.
function searchStop(property) {
    const stop = { address_hash: key(property), lat: Number(property.lat), lng: Number(property.lng) };
    for (const field of ['house_number', 'street_name', 'street_address', 'address', 'city', 'state', 'zip_code', 'routing_access', 'order_locked', 'subdivision_name']) {
        if (property[field] !== undefined && property[field] !== null) stop[field] = property[field];
    }
    return stop;
}

function guardOf(route, at) {
    return { hashes: (route.property_hashes || []).map(String), status: route.status ?? null, assigned_to: route.assigned_to ?? null,
        bounds: JSON.stringify([route.start_location ?? null, route.end_location ?? null, route.route_origin_mode ?? null]), since: iso(at) };
}

/**
 * Queue a background search for a saved route (or, without `route`, for the
 * route that will be saved with `properties` in this order). Returns the job.
 */
export async function enqueueRouteOptimizationJob(service, { route = null, properties, start = null, end = null, source,
    ownerUserId, managerId, now = Date.now(), kick = true }) {
    if (!Array.isArray(properties) || properties.length < 2 || !ownerUserId) return null;
    if (route?.id) {
        // A newer search for the same route replaces any older one.
        const older = asArray(await service.entities.RouteOptimizationJob.filter({ route_id: String(route.id) }));
        for (const job of older.filter(job => ACTIVE.includes(job.status))) {
            await service.entities.RouteOptimizationJob.update(job.id, { status: 'cancelled', reason: 'superseded', finished_at: iso(now) });
        }
    }
    const order = properties.map(key);
    const job = await service.entities.RouteOptimizationJob.create({
        status: route?.id ? 'queued' : 'awaiting_route', source,
        route_id: route?.id ? String(route.id) : '', manager_id: managerId ? String(managerId) : '',
        owner_user_id: String(ownerUserId), order_fingerprint: routePropertyOrderFingerprint(order),
        properties_json: JSON.stringify(properties.map(searchStop)),
        ...(isPoint(start) ? { start_location: { lat: Number(start.lat), lng: Number(start.lng) } } : {}),
        ...(isPoint(end) ? { end_location: { lat: Number(end.lat), lng: Number(end.lng) } } : {}),
        guard: route?.id ? guardOf(route, now) : { hashes: order, since: iso(now) },
        passes_done: 0, saved_savings_miles: 0, improved_miles: 0, attempts: 0,
    });
    if (kick) await kickRouteOptimizationJob(service, job.id);
    return job;
}

/** Start (or continue) a job in its own worker call without waiting for it. */
export async function kickRouteOptimizationJob(service, jobId, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const call = Promise.resolve().then(() => service.functions.invoke('advanceRouteOptimizationJob', { job_id: jobId }))
        .catch(error => console.warn(`[routeOptimizationJobs] could not start job ${jobId}: ${error?.message || error}`));
    // Give the request a moment to leave; the sweep restarts it if it never does.
    await Promise.race([call, sleep(250)]);
}

/** { ok, reason, route }: may the job still write to this route? */
export async function routeStillMatches(service, job) {
    let route;
    try { route = await service.entities.SavedRoute.get(job.route_id); } catch { return { ok: false, reason: 'unreadable' }; }
    if (!route) return { ok: false, reason: 'deleted' };
    const guard = job.guard || {};
    const hashes = (route.property_hashes || []).map(String);
    if (hashes.length !== (guard.hashes || []).length || hashes.some((hash, i) => hash !== guard.hashes[i])) return { ok: false, reason: 'edited' };
    if ((route.status ?? null) !== (guard.status ?? null) || !UNSTARTED.has(route.status)) return { ok: false, reason: 'started' };
    if ((route.assigned_to ?? null) !== (guard.assigned_to ?? null)) return { ok: false, reason: 'reassigned' };
    if (JSON.stringify([route.start_location ?? null, route.end_location ?? null, route.route_origin_mode ?? null]) !== guard.bounds) {
        return { ok: false, reason: 'edited' };
    }
    try {
        const [latest] = asArray(await service.entities.InteractionLog.filter({ route_id: String(job.route_id) }, '-created_date', 1));
        if (latest && Date.parse(latest.created_date) >= Date.parse(guard.since) - 1000) return { ok: false, reason: 'run' };
    } catch { return { ok: false, reason: 'unreadable' }; }
    return { ok: true, route };
}

/** An awaiting_route job (backend generation) binds to the saved route with its exact stop order. */
async function bindAwaitingRoute(service, job, now) {
    const routes = asArray(await service.entities.SavedRoute.filter(job.manager_id ? { manager_id: job.manager_id } : {}, '-created_date', 50));
    const match = routes.find(route => Array.isArray(route.property_hashes)
        && routePropertyOrderFingerprint(route.property_hashes.map(String)) === job.order_fingerprint);
    if (!match) return null;
    const guard = guardOf(match, Date.parse(job.created_date) || now);
    await service.entities.RouteOptimizationJob.update(job.id, { route_id: String(match.id), status: 'queued', guard });
    return { ...job, route_id: String(match.id), status: 'queued', guard };
}

function verificationStamp(verdict, { measuredMiles = null, savedMiles = null, reason = null } = {}) {
    return { verdict, verified: verdict === 'road_adopted' || verdict === 'road_confirmed_current',
        reason, measured_road_miles: Number.isFinite(measuredMiles) ? measuredMiles : null,
        road_miles_saved: Number.isFinite(savedMiles) ? savedMiles : null, stamped_at: new Date().toISOString() };
}

/** The route update for a result that saves more than what was written. */
function improvementUpdate(route, result, job) {
    const applied = Number.isFinite(result.objective.appliedDistance) ? Math.round(result.objective.appliedDistance * 100) / 100 : null;
    const routingMetadata = { ...result.routingMetadata };
    // Anchors are private trip bounds: keep the measured order, not the points or path.
    if (job.start_location || job.end_location) for (const field of PRIVATE_BOUNDS_FIELDS) delete routingMetadata[field];
    const metadata = { ...(route.metadata || {}), ...routingMetadata,
        road_verification: verificationStamp(applied !== null ? 'road_adopted' : 'road_verified_neighborhoods', {
            measuredMiles: applied, savedMiles: Number(result.objective.estimatedSavings) || 0,
            reason: applied !== null ? `background_${job.source}` : 'verified_neighborhoods_only' }),
        road_network_used: applied !== null,
        background_road_search: { job_id: job.id, source: job.source, passes: routingMetadata.road_search_passes ?? null,
            saved_at: new Date().toISOString() } };
    return { property_hashes: result.order.map(key),
        metrics: { ...(route.metrics || {}), ...(applied !== null ? { distance: applied } : {}), house_count: result.order.length },
        metadata };
}

async function finish(service, job, status, fields = {}) {
    await service.entities.RouteOptimizationJob.update(job.id, { status, lease_token: '', lease_until: null,
        finished_at: new Date().toISOString(), ...fields });
    return { status, ...fields };
}

/**
 * One worker call: lease the job, check the route, run the next pass(es),
 * write a measurably shorter order, save the search state, chain the next call.
 */
export async function advanceRouteOptimizationJob(service, jobId, { readSecret, now = () => Date.now(), passesPerCall = PASSES_PER_CALL,
    kick = id => kickRouteOptimizationJob(service, id), invoke = (name, payload) => service.functions.invoke(name, payload) } = {}) {
    let job = await service.entities.RouteOptimizationJob.get(jobId).catch(() => null);
    if (!job || !ACTIVE.includes(job.status)) return { status: job?.status || 'missing' };
    if (job.status === 'running' && job.lease_until && Date.parse(job.lease_until) > now()) return { status: 'busy' };
    if ((job.attempts || 0) >= MAX_JOB_ATTEMPTS) return finish(service, job, 'failed', { reason: 'too_many_attempts' });
    if (job.status === 'awaiting_route') {
        const bound = await bindAwaitingRoute(service, job, now());
        if (!bound) {
            if (now() - Date.parse(job.created_date || iso(now())) > AWAITING_ROUTE_MS) return finish(service, job, 'cancelled', { reason: 'route_never_saved' });
            return { status: 'awaiting_route' };
        }
        job = bound;
    }
    const token = crypto.randomUUID();
    await service.entities.RouteOptimizationJob.update(job.id, { status: 'running', lease_token: token,
        lease_until: iso(now() + JOB_LEASE_MS), attempts: (job.attempts || 0) + 1 });
    job = await service.entities.RouteOptimizationJob.get(job.id);
    if (job.lease_token !== token) return { status: 'busy' };

    const check = await routeStillMatches(service, job);
    if (!check.ok) return finish(service, job, 'discarded', { reason: check.reason });

    const properties = JSON.parse(job.properties_json);
    const secret = readSecret('ROUTE_SEARCH_CONTINUATION_SECRET');
    const client = { functions: { invoke: async (name, payload) => invoke(name, { ...payload,
        worker_credential: await signWorkerCredential(secret, { ownerUserId: job.owner_user_id, jobId: job.id }) }) } };
    let suspended = null, outcome = null, progress = null;
    let result;
    try {
        result = await tryRoadMatrixOptimize(properties, { client, maxSearchPasses: 8,
            start: job.start_location || null, end: job.end_location || null,
            resume: job.state_json ? JSON.parse(job.state_json) : null,
            suspendAfterPasses: passesPerCall, onSuspend: state => { suspended = state; },
            onSearchProgress: value => { progress = value; },
            onOutcome: (reason, measurement) => { outcome = { reason, measurement }; } });
    } catch (error) {
        // Leave the lease to expire: the sweep retries from the last saved pass.
        await service.entities.RouteOptimizationJob.update(job.id, { error: String(error?.message || error).slice(0, 500) });
        return { status: 'error', error: String(error?.message || error) };
    }

    // The best result so far: the suspended state's accepted result, or the final one.
    const byHash = new Map(properties.map(stop => [stop.address_hash, stop]));
    const best = suspended ? (suspended.accepted ? { ...suspended.accepted,
        order: suspended.accepted.order.map(({ h }) => byHash.get(h)) } : null) : result;
    const savings = Number(best?.objective?.estimatedSavings) || 0;
    const gain = best?.objective?.applyCandidate ? savings - (job.saved_savings_miles || 0) : 0;
    const coverage = suspended?.coverage;
    const fields = { passes_done: suspended?.passesDone ?? progress?.passesDone ?? (job.passes_done || 0) + 1,
        ...(coverage ? { checks_done: coverage.total_windows - coverage.remaining_windows, checks_total: coverage.total_windows }
            : progress ? { checks_done: progress.checksDone ?? null, checks_total: progress.checksTotal ?? null } : {}), error: '' };
    if (gain >= MIN_IMPROVEMENT_MILES) {
        const recheck = await routeStillMatches(service, job);
        if (!recheck.ok) return finish(service, job, 'discarded', { ...fields, reason: recheck.reason });
        const update = improvementUpdate(recheck.route, best, job);
        await service.entities.SavedRoute.update(job.route_id, update);
        // From now on the route should still have the order the job wrote.
        Object.assign(fields, { saved_savings_miles: savings, improved_miles: Math.round(((job.improved_miles || 0) + gain) * 100) / 100,
            guard: { ...job.guard, hashes: update.property_hashes } });
    }
    const failure = !suspended && (result ? result.routingMetadata?.road_search_stop_reason : outcome?.reason);
    if (TRANSIENT.has(failure)) {
        // Keep the last saved state; the sweep retries this pass.
        await service.entities.RouteOptimizationJob.update(job.id, { ...fields, passes_done: job.passes_done || 0,
            status: 'queued', lease_token: '', lease_until: null, error: failure });
        return { status: 'retry', reason: failure };
    }
    if (suspended) {
        await service.entities.RouteOptimizationJob.update(job.id, { ...fields, state_json: JSON.stringify(suspended),
            status: 'queued', lease_token: '', lease_until: null });
        await kick(job.id);
        return { status: 'queued', passes_done: fields.passes_done, improved_miles: fields.improved_miles ?? job.improved_miles ?? 0 };
    }
    const improved = (fields.improved_miles ?? job.improved_miles ?? 0) > 0;
    return finish(service, job, improved ? 'improved' : 'kept', { ...fields, state_json: '',
        reason: improved ? null : outcome?.reason || 'no_improvement' });
}

/** The 5-minute sweep: restart queued jobs and jobs whose worker died. */
export async function sweepRouteOptimizationJobs(service, { now = () => Date.now(), limit = 20,
    kick = id => kickRouteOptimizationJob(service, id) } = {}) {
    const kicked = [];
    for (const status of ACTIVE) {
        const jobs = asArray(await service.entities.RouteOptimizationJob.filter({ status }, 'created_date', limit));
        for (const job of jobs) {
            if (status === 'running' && job.lease_until && Date.parse(job.lease_until) > now()) continue;
            await kick(job.id);
            kicked.push(job.id);
        }
    }
    return { kicked: kicked.length };
}

/** What the app may see about a job: no stops, bounds, state or tokens. */
export function publicJobStatus(job) {
    return { id: job.id, route_id: job.route_id || null, source: job.source, status: job.status,
        passes_done: job.passes_done || 0, checks_done: job.checks_done ?? null, checks_total: job.checks_total ?? null,
        improved_miles: job.improved_miles || 0, reason: job.reason || null,
        created_date: job.created_date || null, finished_at: job.finished_at || null };
}
