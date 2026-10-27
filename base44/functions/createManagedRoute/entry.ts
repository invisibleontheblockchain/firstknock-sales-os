import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { Client } from 'npm:@neondatabase/serverless@0.9.0';
import { loadAuthoritativeUser } from '../../shared/accountIdentity.js';
import { isPrecisionJob, precisionJobBelongsToSubject } from '../../shared/precisionOrderSafety.js';
import { isValidRoutePoint } from '../../shared/routeBounds.js';
import { isRepAccount, tenantManagerId } from '../../shared/accountTenancy.js';

const rows = value => Array.isArray(value) ? value : value?.items || [];
const normalized = value => String(value || '').trim().toLowerCase();
class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

// Browser entity creation can reject ordinary managers. Verify the caller and
// tenant here before using the service role; never accept a client tenant key.
Deno.serve(async req => {
    let release;
    try {
        if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
        const base44 = createClientFromRequest(req);
        const identity = await base44.auth.me();
        if (!identity?.id) throw new HttpError(401, 'Sign in to save this route.');
        const user = await loadAuthoritativeUser(base44, identity);
        const appRole = normalized(user.app_role || user.data?.app_role);
        const rep = isRepAccount(user);
        if (!rep && !user.is_owner && !['manager', 'admin'].includes(appRole) && !['manager', 'admin'].includes(normalized(user.role))) {
            throw new HttpError(403, 'Only managers can create generated routes.');
        }
        const { route, request_id: requestId } = await req.json();
        const managerId = tenantManagerId(user);
        if (!managerId) throw new HttpError(403, 'Join a workspace before saving routes.');
        if (!route || typeof route !== 'object' || Array.isArray(route)) throw new HttpError(400, 'Route details are required.');
        if (route.manager_id && route.manager_id !== managerId) throw new HttpError(403, 'Save the route in your own workspace.');
        const hashes = route.property_hashes;
        if (!Array.isArray(hashes) || !hashes.length || hashes.length > 10000
            || hashes.some(hash => typeof hash !== 'string' || !hash.trim() || hash.length > 500)
            || new Set(hashes).size !== hashes.length) throw new HttpError(400, 'The route must contain 1 to 10,000 unique home identifiers.');
        if (typeof route.name !== 'string' || !route.name.trim()) throw new HttpError(400, 'A route name is required.');
        if (route.route_mode && !['precision', 'canvas'].includes(route.route_mode)) throw new HttpError(400, 'Invalid route mode.');
        const service = base44.asServiceRole.entities;
        if (rep) {
            const membership = rows(await service.TeamMember.filter({ manager_id: managerId, user_id: user.id }, '-created_date', 100))
                .find(member => member.manager_id === managerId && member.user_id === user.id && normalized(member.status) !== 'inactive'
                    && normalized(member.email) === normalized(user.email));
            if (!membership || (route.assigned_to && route.assigned_to !== user.id && route.assigned_to !== membership.id)) {
                throw new HttpError(403, 'Save a route assigned to your own active team membership.');
            }
        }
        const assignedTo = rep ? user.id : route.assigned_to === null ? null : route.assigned_to || user.id;
        let assigneeName = assignedTo ? user.full_name || 'Me' : null;
        if (assignedTo && assignedTo !== user.id) {
            let member = await service.TeamMember.get(assignedTo).catch(() => null);
            if (!member) member = rows(await service.TeamMember.filter({ manager_id: user.id, user_id: assignedTo }, '-created_date', 100))
                .find(candidate => candidate.manager_id === user.id && candidate.user_id === assignedTo && normalized(candidate.status) !== 'inactive');
            if (!member || member.manager_id !== user.id || normalized(member.status) === 'inactive') {
                throw new HttpError(403, 'Choose an active member of your team.');
            }
            assigneeName = member.name || 'Team member';
        }
        const metadata = route.metadata && typeof route.metadata === 'object' && !Array.isArray(route.metadata) ? { ...route.metadata } : {};
        delete metadata.anchor;
        delete metadata.save_request_id;
        if (requestId !== undefined) {
            if (typeof requestId !== 'string' || !/^route-[a-f0-9]{64}$/.test(requestId)) throw new HttpError(400, 'Invalid save request identifier.');
            const databaseUrl = Deno.env.get('DATABASE_URL');
            if (!databaseUrl) throw new HttpError(503, 'Route save locking is temporarily unavailable.');
            const lockClient = new Client(databaseUrl);
            await lockClient.connect();
            try {
                await lockClient.query('BEGIN');
                const lock = await lockClient.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', [`route-save:${managerId}:${requestId}`]);
                if (lock.rows?.[0]?.acquired !== true) throw new HttpError(409, 'Another route is being saved. Retry in a moment.');
            } catch (error) { await lockClient.end().catch(() => {}); throw error; }
            release = async () => { try { await lockClient.query('COMMIT'); } finally { await lockClient.end(); } };
            const existing = rows(await service.SavedRoute.filter({ manager_id: managerId, 'metadata.save_request_id': requestId }, '-created_date', 2))
                .find(saved => saved.manager_id === managerId && saved.metadata?.save_request_id === requestId);
            if (existing) {
                if (existing.property_hashes?.length !== hashes.length || new Set(existing.property_hashes).size !== hashes.length
                    || existing.property_hashes.some(hash => !hashes.includes(hash)) || existing.assigned_to !== assignedTo) {
                    throw new HttpError(409, 'This save identifier already belongs to a different route.');
                }
                return Response.json({ route: existing, already_saved: true });
            }
            metadata.save_request_id = requestId;
        }
        if (route.parent_route_id) {
            const parent = await service.SavedRoute.get(String(route.parent_route_id)).catch(() => null);
            if (parent?.manager_id !== managerId) throw new HttpError(403, 'The source route does not belong to your workspace.');
        }
        const jobId = metadata.precision_area?.job_id;
        if (jobId) {
            const job = await service.FetchJob.get(String(jobId)).catch(() => null);
            if (!isPrecisionJob(job) || !precisionJobBelongsToSubject(job, user)) throw new HttpError(403, 'This import does not belong to your account.');
            if (job.status !== 'completed') throw new HttpError(409, 'The property import must complete before saving its route.');
            metadata.precision_area = { ...metadata.precision_area, polygon: job.polygon, last_pull_date: job.completed_at };
            // Recovery after a lost response or reload must not duplicate the same
            // imported homes. Preserve their original persisted order on replay.
            for (let offset = 0; metadata.newly_generated && !metadata.rerun_from_route_id && !route.parent_route_id; offset += 500) {
                // Routes live in the tenant workspace: the team manager's for a rep.
                const existing = rows(await service.SavedRoute.filter({ manager_id: managerId, 'metadata.precision_area.job_id': jobId }, '-created_date', 500, offset));
                const hashSet = new Set(hashes);
                const match = existing.find(saved => saved.manager_id === managerId && saved.metadata?.precision_area?.job_id === jobId
                    && saved.status !== 'ARCHIVED' && saved.property_hashes?.length === hashes.length
                    && new Set(saved.property_hashes).size === hashes.length && saved.property_hashes.every(hash => hashSet.has(hash)));
                if (match) return Response.json({ route: match, already_saved: true });
                if (existing.length < 500) break;
                if (offset >= 19500) throw new HttpError(503, 'Too many routes to verify this save.');
            }
        }
        const origin = route.route_origin_mode || 'none';
        if (!['none', 'home_round_trip', 'current_to_home', 'car_round_trip', 'custom_bounds', 'anchor_round_trip'].includes(origin)) throw new HttpError(400, 'Invalid route origin.');
        const personalBounds = !['none', 'custom_bounds'].includes(origin);
        if (personalBounds) {
            delete metadata.route_bounds;
            delete metadata.road_geometry;
            delete metadata.road_geometry_segments;
        }
        const fixedPoint = point => {
            if (!point) return null;
            if (!isValidRoutePoint(point)) throw new HttpError(400, 'Route bounds need valid coordinates.');
            return { lat: Number(point.lat), lng: Number(point.lng), ...(typeof point.address === 'string' ? { address: point.address.slice(0, 1000) } : {}) };
        };
        const routeRecord = {
            name: route.name.trim().slice(0, 250), route_mode: route.route_mode || 'precision',
            property_hashes: hashes, metrics: { ...(route.metrics || {}), house_count: hashes.length },
            status: ['PENDING', 'ACTIVE', 'IN_PROGRESS'].includes(route.status) ? route.status : 'ACTIVE', manager_id: managerId, assigned_to: assignedTo, assigned_to_name: assigneeName,
            route_origin_mode: origin, start_location: personalBounds ? null : fixedPoint(route.start_location),
            end_location: personalBounds ? null : fixedPoint(route.end_location), metadata,
        };
        for (const key of ['description', 'priority', 'parent_route_id', 'batch_number', 'batch_total', 'batch_date']) {
            if (route[key] !== undefined) routeRecord[key] = route[key];
        }
        const created = await service.SavedRoute.create(routeRecord);
        if (!created?.id) throw new HttpError(502, 'The server did not confirm the saved route.');
        const verified = await service.SavedRoute.get(created.id);
        if (verified?.manager_id !== managerId || verified.property_hashes?.length !== hashes.length
            || verified.property_hashes.some((hash, index) => hash !== hashes[index])) throw new HttpError(502, 'The saved route did not retain every home in order. Retry this save.');
        return Response.json({ route: verified });
    } catch (error) {
        console.error('[createManagedRoute]', error?.status || 500, error?.message || error);
        return Response.json({ error: 'route_save_failed', message: error?.message || 'Could not save this route.' }, { status: error?.status || 500 });
    } finally {
        if (release) await release().catch(error => console.warn('[createManagedRoute] Could not release save lock:', error.message));
    }
});

