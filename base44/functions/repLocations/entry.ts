import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { locationStatus, validLocation, LOCATION_FIX_MAX_AGE_MS } from '../../shared/repLocations.js';

const normalized = (value) => String(value || '').trim().toLowerCase();
const asArray = (value) => Array.isArray(value) ? value : value?.items || [];
const activeRep = (member) => normalized(member.status || 'active') === 'active' && normalized(member.role || 'rep') === 'rep';
const isManager = (user) => user?.is_owner === true || user?.data?.is_owner === true
    || ['manager', 'admin'].includes(normalized(user?.app_role || user?.data?.app_role))
    || ['manager', 'admin'].includes(normalized(user?.role || user?.data?.role));

class LocationError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

async function allPages(entity, query, sort = '-created_date') {
    const result = [];
    for (let page = 0; page < 100; page += 1) {
        const rows = asArray(await entity.filter(query, sort, 500, page * 500));
        result.push(...rows);
        if (rows.length < 500) return result;
    }
    throw new LocationError(503, 'Unable to load all rep locations. Contact support.');
}

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') throw new LocationError(405, 'Method not allowed');
        const base44 = createClientFromRequest(req);
        const identity = await base44.auth.me();
        if (!identity?.id) throw new LocationError(401, 'Sign in to use rep locations.');
        const service = base44.asServiceRole.entities;
        const user = await service.User.get(identity.id);
        if (!user || user.id !== identity.id) throw new LocationError(401, 'Account could not be verified.');
        let body;
        try { body = await req.json(); } catch { throw new LocationError(400, 'Invalid request.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LocationError(400, 'Invalid request.');
        const managesTeam = isManager(user);
        const action = body.action || 'report';
        if (!['report', 'publish', 'stop'].includes(action)) throw new LocationError(400, 'Unknown location action.');
        if (action === 'report' && !managesTeam) throw new LocationError(403, 'Only managers can view rep locations.');
        if (action !== 'report' && (managesTeam || normalized(user.app_role || user.data?.app_role) !== 'rep')) {
            throw new LocationError(403, 'Only active team reps can share a location.');
        }
        // Derive all identity and tenant fields from the saved account and membership.
        const managerId = managesTeam ? user.id : (user.team_manager_id || user.data?.team_manager_id);
        if (!managerId) throw new LocationError(403, 'Join a team before sharing your location.');
        const manager = managesTeam ? user : await service.User.get(managerId);
        if (!manager || manager.id !== managerId || !isManager(manager)) throw new LocationError(403, 'Team manager could not be verified.');
        const members = (await allPages(service.TeamMember, { manager_id: managerId,
            ...(action !== 'report' ? { user_id: user.id } : {}) }))
            .filter(m => m.manager_id === managerId && activeRep(m));
        const now = Date.now();

        if (action === 'report') {
            const locations = (await allPages(service.RepLocation, { manager_id: managerId }, '-received_at'))
                .filter(l => l.manager_id === managerId)
                .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
            const reps = members.map(member => {
                const latest = locations.find(l => l.member_id === member.id && l.rep_user_id === member.user_id);
                const status = locationStatus(latest, now);
                // Expired or stopped locations never expose coordinates to the UI.
                const location = status === 'offline' ? null : {
                    lat: latest.lat, lng: latest.lng, accuracy: latest.accuracy, observed_at: latest.observed_at, sharing: true,
                };
                return { member_id: member.id, user_id: member.user_id, name: member.name || 'Rep', color: member.color,
                    invite_code: member.invite_code, status, location };
            });
            return Response.json({ success: true, manager_id: managerId, reps, server_time: new Date(now).toISOString() });
        }

        const member = members.find(m => m.user_id === user.id);
        if (!member) throw new LocationError(403, 'An active team membership is required.');
        if (typeof body.session_id !== 'string' || !body.session_id.trim() || body.session_id.length > 100) {
            throw new LocationError(400, 'A location sharing session is required.');
        }
        const records = (await allPages(service.RepLocation, { manager_id: managerId, member_id: member.id, rep_user_id: user.id }, '-received_at'))
            .filter(l => l.manager_id === managerId && l.member_id === member.id && l.rep_user_id === user.id);
        if (action === 'stop') {
            await Promise.all(records.filter(l => l.session_id === body.session_id && l.sharing)
                .map(l => service.RepLocation.update(l.id, { sharing: false, received_at: new Date(now).toISOString() })));
            return Response.json({ success: true });
        }
        const observed = typeof body.observed_at === 'string' ? Date.parse(body.observed_at) : NaN;
        if (!validLocation(body) || typeof body.accuracy !== 'number' || !Number.isFinite(body.accuracy) || body.accuracy < 0
            || !Number.isFinite(observed) || observed > now + 10_000 || now - observed > LOCATION_FIX_MAX_AGE_MS) {
            throw new LocationError(400, 'A fresh, valid GPS location is required.');
        }
        records.sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
        const latest = records[0];
        if (latest?.sharing && Date.parse(latest.observed_at) > observed) return Response.json({ success: true, ignored: true });
        const data = { manager_id: managerId, member_id: member.id, rep_user_id: user.id, session_id: body.session_id,
            sharing: true, lat: body.lat, lng: body.lng, accuracy: body.accuracy,
            observed_at: new Date(observed).toISOString(), received_at: new Date(now).toISOString() };
        if (latest) await service.RepLocation.update(latest.id, data);
        else await service.RepLocation.create(data);
        return Response.json({ success: true });
    } catch (error) {
        const status = error instanceof LocationError ? error.status : 500;
        if (status === 500) console.error('Rep locations failed:', error);
        return Response.json({ error: status === 500 ? 'Unable to update rep locations. Please retry.' : error.message }, { status });
    }
});
