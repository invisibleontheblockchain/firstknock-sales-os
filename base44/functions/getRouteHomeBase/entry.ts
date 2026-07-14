import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

function normalizePoint(point) {
    if (!point || point.lat === null || point.lat === undefined || point.lat === '' || point.lng === null || point.lng === undefined || point.lng === '') {
        return null;
    }
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return null;
    }
    return { lat, lng };
}

function firstItem(result) {
    if (Array.isArray(result)) return result[0] || null;
    return result?.items?.[0] || null;
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const requester = await base44.auth.me();
        if (!requester) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const routeId = String(body.route_id || '').trim();
        if (!routeId) return Response.json({ error: 'route_id is required' }, { status: 400 });

        const route = await base44.asServiceRole.entities.SavedRoute.get(routeId).catch(() => null);
        if (!route) return Response.json({ error: 'Route not found' }, { status: 404 });
        if (!route.assigned_to) {
            return Response.json({ error: 'Assign the route before using a rep Home Base.' }, { status: 409 });
        }

        const isAdmin = requester.role === 'admin' || requester.app_role === 'admin';
        let homeBase = null;

        if (route.assigned_to === requester.id) {
            homeBase = normalizePoint(requester.home_base);
        } else {
            if (!isAdmin && route.manager_id !== requester.id) {
                return Response.json({ error: 'Forbidden' }, { status: 403 });
            }

            let member = await base44.asServiceRole.entities.TeamMember.get(route.assigned_to).catch(() => null);
            if (!member || (!isAdmin && member.manager_id !== requester.id)) {
                const byUserId = await base44.asServiceRole.entities.TeamMember.filter({
                    user_id: route.assigned_to,
                    ...(!isAdmin ? { manager_id: requester.id } : {})
                }, '-updated_date', 5).catch(() => []);
                member = firstItem(byUserId);
            }
            if (!member || (!isAdmin && member.manager_id !== requester.id)) {
                return Response.json({ error: 'Assigned rep not found on your team.' }, { status: 404 });
            }

            // Never trust a freely created roster row or an email lookup as
            // proof of team membership. Invite redemption links both records,
            // and the private User must independently name this requester as
            // its manager before service-role data can be returned.
            const repUser = member.user_id
                ? await base44.asServiceRole.entities.User.get(member.user_id).catch(() => null)
                : null;
            const memberEmail = String(member.email || '').trim().toLowerCase();
            const userEmail = String(repUser?.email || '').trim().toLowerCase();
            const verifiedTeamLink = repUser && (
                isAdmin || (
                    repUser.team_manager_id === requester.id
                    && member.user_id === repUser.id
                    && memberEmail
                    && memberEmail === userEmail
                )
            );
            if (!verifiedTeamLink) {
                return Response.json({ error: 'Assigned rep team link is not verified.' }, { status: 403 });
            }
            homeBase = normalizePoint(repUser?.home_base);
        }

        if (!homeBase) {
            return Response.json({ error: 'The assigned rep has not saved a Home Base yet.' }, { status: 404 });
        }

        // Managers only receive a neighborhood-level point, never the typed
        // address or the exact coordinates stored on the rep's private User.
        return Response.json({
            home_base: {
                lat: Math.round(homeBase.lat * 1000) / 1000,
                lng: Math.round(homeBase.lng * 1000) / 1000,
                address: 'Private home base'
            }
        });
    } catch (error) {
        console.error('[getRouteHomeBase]', error);
        return Response.json({ error: error?.message || 'Could not load the route Home Base.' }, { status: 500 });
    }
});
