import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { isValidRoutePoint, calculateRouteDistanceMiles } from '../../shared/routeBounds.js';
import { optimizeAnchoredStreetRoute } from '../../shared/routeAnchorRouting.js';
import { secrets } from 'base44:runtime';
import { completeServerRoadAwareRoutes } from '../../shared/roadAwareBetaServer.js';

const rows = (value) => Array.isArray(value) ? value : value?.items || [];
const normalized = (value) => String(value || '').trim().toLowerCase();
const isManager = (user) => user?.is_owner === true || user?.data?.is_owner === true
    || ['manager', 'admin'].includes(normalized(user?.app_role || user?.data?.app_role))
    || ['manager', 'admin'].includes(normalized(user?.role || user?.data?.role));
class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
function location(value) {
    if (!isValidRoutePoint(value)) throw new HttpError(400, 'Choose a valid anchor address.');
    const address = String(value.address || '').trim();
    if (!address || address.length > 1000) throw new HttpError(400, 'An anchor address is required.');
    return { lat: Number(value.lat), lng: Number(value.lng), address };
}
function savedBase(value) {
    return isValidRoutePoint(value) ? location({ ...value, address: value.address || 'Rep base' }) : null;
}
async function verifiedMember(service, managerId, memberId) {
    if (memberId === managerId) {
        const user = await service.entities.User.get(managerId);
        return { user, member: { id: managerId, name: user.full_name || 'Manager' } };
    }
    let member = await service.entities.TeamMember.get(memberId).catch(() => null);
    if (!member) {
        member = rows(await service.entities.TeamMember.filter({ manager_id: managerId, user_id: memberId }, '-created_date', 100))
            .find(row => row.manager_id === managerId && row.user_id === memberId && normalized(row.status) !== 'inactive');
    }
    if (!member || member.manager_id !== managerId || normalized(member.status) === 'inactive') {
        throw new HttpError(403, 'Choose an active member of your team.');
    }
    const user = member.user_id ? await service.entities.User.get(member.user_id).catch(() => null) : null;
    if (!user || user.id !== member.user_id || (user.team_manager_id || user.data?.team_manager_id) !== managerId
        || !normalized(member.email) || normalized(member.email) !== normalized(user.email)) {
        throw new HttpError(409, 'This rep must join your team before you can configure their base.');
    }
    return { user, member };
}
async function privateRows(service, route) {
    // Rep bases live on User; only custom anchors require this private store.
    if (route.metadata?.anchor?.source !== 'custom' || !route.metadata?.anchor?.record_id) return [];
    return rows(await service.entities.RouteAnchor.filter({ manager_id: route.manager_id, route_id: route.id }, '-created_date', 100));
}
async function getAnchor(service, route) {
    const source = route.metadata?.anchor?.source;
    if (route.route_origin_mode !== 'anchor_round_trip') return null;
    if (source === 'custom') {
        const record = (await privateRows(service, route)).find(row => row.id === route.metadata?.anchor?.record_id);
        return record ? location(record.location) : null;
    }
    if (source === 'rep_base' && route.assigned_to) {
        const { user } = await verifiedMember(service, route.manager_id, route.assigned_to);
        return savedBase(user.home_base);
    }
    return null;
}
async function optimize(base44, route, anchor, user) {
    if (!anchor && route.route_origin_mode !== 'anchor_round_trip') return {};
    const hashes = route.property_hashes || [];
    if (!hashes.length || new Set(hashes).size !== hashes.length) throw new HttpError(409, 'The route needs a valid list of unique doors before anchoring.');
    const byHash = new Map();
    for (let offset = 0; offset < hashes.length; offset += 1000) {
        const batch = hashes.slice(offset, offset + 1000);
        const response = await base44.functions.invoke('getRoutePropertiesByHashes', {
            route_id: route.id, address_hashes: batch, limit: batch.length,
        });
        for (const property of response.data?.properties || []) {
            for (const key of [property.address_hash, property.legacy_hash, property.id]) if (key) byHash.set(String(key), property);
        }
    }
    const properties = hashes.map(hash => ({ ...byHash.get(hash), anchor_hash: hash }));
    if (properties.some(property => !isValidRoutePoint(property))) {
        throw new HttpError(409, 'Some route doors are missing coordinates. Reload or repair the route before applying an anchor.');
    }
    const bounds = anchor ? { startLocation: anchor, endLocation: anchor } : {};
    const legacy = anchor ? optimizeAnchoredStreetRoute(properties, anchor) : properties;
    const baselineRoutes = [{ properties: legacy.map(p => ({ ...p, address_hash: p.anchor_hash })),
        totalDistance: calculateRouteDistanceMiles(legacy, bounds), ...bounds, routeOriginMode: anchor ? 'anchor_round_trip' : 'none' }];
    const readSecret = name => { try { return String(secrets.get(name) || '').trim(); } catch { return ''; } };
    const [completed] = readSecret('ROAD_AWARE_OSRM_BASE_URL')
        ? await completeServerRoadAwareRoutes(baselineRoutes, { client: base44, user, entryPoint: 'rep_anchor_change', readSecret })
        : baselineRoutes;
    const ordered = completed.properties;
    return {
        property_hashes: ordered.map(property => property.anchor_hash),
        metrics: { ...route.metrics, distance: Math.round(completed.totalDistance * 100) / 100, house_count: hashes.length },
        ...(completed.metadata ? { metadata: completed.metadata } : {}),
    };
}

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const base44 = createClientFromRequest(req);
        const identity = await base44.auth.me();
        if (!identity?.id) throw new HttpError(401, 'Sign in to manage anchors.');
        const service = base44.asServiceRole;
        const user = await service.entities.User.get(identity.id);
        if (!user || user.id !== identity.id) throw new HttpError(401, 'Account could not be verified.');
        const body = await req.json();
        const action = String(body.action || '');
        if (action !== 'get_route' && !isManager(user)) throw new HttpError(403, 'Only managers can manage team anchors.');

        if (action === 'list') {
            const members = [];
            for (let page = 0; page < 100; page++) {
                const batch = rows(await service.entities.TeamMember.filter({ manager_id: user.id }, '-created_date', 500, page * 500));
                members.push(...batch.filter(member => member.manager_id === user.id && normalized(member.status) !== 'inactive'));
                if (batch.length < 500) break;
                if (page === 99) throw new HttpError(503, 'The team is too large to load.');
            }
            const bases = [];
            for (const member of [{ id: user.id, name: user.full_name || 'Manager' }, ...members]) {
                try {
                    const verified = await verifiedMember(service, user.id, member.id);
                    bases.push({ member_id: member.id, home_base: savedBase(verified.user.home_base),
                        auto_assign: verified.user.home_base_auto_assign !== false, configurable: true });
                } catch (error) {
                    if (!(error instanceof HttpError)) throw error;
                    bases.push({ member_id: member.id, home_base: null, auto_assign: true, configurable: false });
                }
            }
            return Response.json({ bases });
        }
        if (action === 'save_base') {
            const { user: rep } = await verifiedMember(service, user.id, String(body.member_id || ''));
            const update = {};
            if (Object.hasOwn(body, 'home_base')) update.home_base = body.home_base === null ? null : location(body.home_base);
            if (Object.hasOwn(body, 'auto_assign')) {
                if (typeof body.auto_assign !== 'boolean') throw new HttpError(400, 'Choose whether to use the base automatically.');
                update.home_base_auto_assign = body.auto_assign;
            }
            if (!Object.keys(update).length) throw new HttpError(400, 'Choose a base or assignment preference to save.');
            await service.entities.User.update(rep.id, update);
            return Response.json({ success: true });
        }
        if (!['assign', 'set_route', 'get_route'].includes(action)) throw new HttpError(400, 'Unknown anchor action.');
        const route = await service.entities.SavedRoute.get(String(body.route_id || '')).catch(() => null);
        if (!route) throw new HttpError(404, 'Route not found.');
        const ownsRoute = isManager(user) && route.manager_id === user.id;
        if (!ownsRoute) {
            if (action !== 'get_route') throw new HttpError(403, 'This route belongs to another team.');
            const verified = await verifiedMember(service, route.manager_id, route.assigned_to);
            if (verified.user.id !== user.id || (user.team_manager_id || user.data?.team_manager_id) !== route.manager_id) {
                throw new HttpError(403, 'This route is not assigned to you.');
            }
        }
        if (action === 'get_route') return Response.json({ anchor: await getAnchor(service, route), source: route.metadata?.anchor?.source || 'none' });
        if (['COMPLETED', 'ARCHIVED'].includes(route.status)) throw new HttpError(409, 'Choose an active route to configure its anchor.');
        const memberId = action === 'assign' ? String(body.member_id || '') : route.assigned_to;
        let assignee = null;
        if (memberId) {
            try { assignee = await verifiedMember(service, user.id, memberId); }
            catch (error) {
                // Pending invitations may receive routes, but never grant access
                // to a User profile or private base until redemption links them.
                if ((action !== 'assign' && body.source !== 'custom' && body.source !== 'none') || !(error instanceof HttpError) || error.status !== 409) throw error;
                const member = await service.entities.TeamMember.get(memberId);
                assignee = { member, user: {} };
            }
        }
        let source = action === 'assign' ? 'rep_base' : String(body.source || '');
        if (!['rep_base', 'custom', 'none'].includes(source)) throw new HttpError(400, 'Choose a rep base or custom address.');
        let notice = null;
        let anchor = null;
        if (source === 'rep_base') {
            if (action === 'assign' && (body.use_rep_base === false || assignee?.user.home_base_auto_assign === false)) source = 'none';
            else if (assignee && isValidRoutePoint(assignee.user.home_base)) anchor = savedBase(assignee.user.home_base);
            else if (action === 'assign') { source = 'none'; if (memberId) notice = 'Assigned without an anchor. Configure this rep’s base in Teams → Bases.'; }
            else throw new HttpError(409, 'Assign a rep with a configured base first.');
        }
        if (source === 'custom') anchor = location(body.location);
        const optimized = await optimize(base44, route, anchor, user);
        const latest = await service.entities.SavedRoute.get(route.id);
        if (!latest || latest.assigned_to !== route.assigned_to || latest.status !== route.status
            || latest.updated_date !== route.updated_date
            || JSON.stringify(latest.property_hashes) !== JSON.stringify(route.property_hashes)
            || JSON.stringify(latest.metadata?.anchor) !== JSON.stringify(route.metadata?.anchor)) {
            throw new HttpError(409, 'This route changed while the anchor was being applied. Reload and retry.');
        }
        const oldRecords = await privateRows(service, route);
        // Publish the private record first; readers select its ID from the route.
        // If the route write fails, remove only the new record and retain the old anchor.
        let newRecord = null;
        if (source === 'custom') newRecord = await service.entities.RouteAnchor.create({ manager_id: user.id, route_id: route.id, location: anchor });
        const metadata = { ...(route.metadata || {}) };
        delete metadata.road_geometry;
        delete metadata.road_geometry_segments;
        delete metadata.routing;
        if (optimized.property_hashes) {
            metadata.road_network_used = false;
            metadata.road_verification = { verdict: 'unverified_local_fallback', verified: false,
                reason: 'anchor_street_sweep', measured_road_miles: null, road_miles_saved: null, stamped_at: new Date().toISOString() };
        }
        metadata.anchor = { source, ...(newRecord ? { record_id: newRecord.id } : {}) };
        metadata.route_bounds = anchor ? { enabled: true, mode: 'anchor_round_trip' } : { enabled: false, cleared_reason: 'anchor_changed' };
        Object.assign(metadata, optimized.metadata || {});
        const update = { ...optimized, start_location: null, end_location: null, route_origin_mode: anchor ? 'anchor_round_trip' : 'none', metadata,
            ...(action === 'assign' ? { assigned_to: memberId || null, assigned_to_name: assignee?.member.name || null, status: memberId ? 'ACTIVE' : 'PENDING' } : {}) };
        try { await service.entities.SavedRoute.update(route.id, update); }
        catch (error) { if (newRecord) await service.entities.RouteAnchor.delete(newRecord.id); throw error; }
        if (optimized.metadata?.road_aware_comparison_id) await service.entities.RoadAwareRoutingComparison.update(
            optimized.metadata.road_aware_comparison_id, { route_id: route.id }).catch(() => {});
        for (const record of oldRecords) await service.entities.RouteAnchor.delete(record.id).catch(() => {});
        return Response.json({ success: true, route: { ...route, ...update }, anchor, notice });
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error('[manageRepAnchors]', error);
        return Response.json({ error: status === 500 ? 'Could not update anchors. Please retry.' : error.message }, { status });
    }
});
