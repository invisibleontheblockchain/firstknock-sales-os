import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PAGE_SIZE = 500;
const MAX_PAGES = 100;
const normalized = (value) => String(value || '').trim().toLowerCase();
const asArray = (value) => Array.isArray(value) ? value : value?.items || [];
const isActive = (member) => normalized(member?.status || 'active') !== 'inactive';

function isManager(user) {
    return user?.is_owner === true || user?.data?.is_owner === true
        || ['manager', 'admin'].includes(normalized(user?.app_role || user?.data?.app_role))
        || ['manager', 'admin'].includes(normalized(user?.role || user?.data?.role));
}

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function loadMembers(service, managerId) {
    const members = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
        const rows = asArray(await service.entities.TeamMember.filter(
            { manager_id: managerId }, '-created_date', PAGE_SIZE, page * PAGE_SIZE
        ));
        // Keep an explicit tenant check even when the underlying query is scoped.
        members.push(...rows.filter((member) => member.manager_id === managerId));
        if (rows.length < PAGE_SIZE) return members;
    }
    throw new HttpError(503, 'The team roster is too large to load. Please contact support.');
}

function publicMember(member) {
    // Reps need directory identity, not private notes, contact numbers or invite codes.
    return Object.fromEntries([
        'id', 'user_id', 'manager_id', 'name', 'email', 'role', 'status', 'color', 'profile_image_url'
    ].filter((key) => member[key] !== undefined).map((key) => [key, member[key]]));
}

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const base44 = createClientFromRequest(req);
        const identity = await base44.auth.me();
        if (!identity?.id) throw new HttpError(401, 'Sign in to view your team.');

        const service = base44.asServiceRole;
        const user = await service.entities.User.get(identity.id);
        if (!user || user.id !== identity.id) throw new HttpError(401, 'Account could not be verified.');
        const managesTeam = isManager(user);
        // Team scope comes only from the saved account, never a request-supplied ID.
        const managerId = managesTeam ? user.id : (user.team_manager_id || user.data?.team_manager_id);
        if (!managerId || (!managesTeam && normalized(user.app_role || user.data?.app_role) !== 'rep')) {
            throw new HttpError(403, 'Join a team before viewing its roster.');
        }
        const manager = managesTeam ? user : await service.entities.User.get(managerId);
        if (!manager || manager.id !== managerId || !isManager(manager)) {
            throw new HttpError(403, 'Your team manager could not be verified.');
        }

        const members = await loadMembers(service, managerId);
        if (!managesTeam && !members.some((member) => isActive(member)
            && member.user_id === user.id
            && normalized(member.role || 'rep') === 'rep')) {
            throw new HttpError(403, 'An active team membership is required to view this roster.');
        }
        const managerProfile = {
            id: manager.id,
            user_id: manager.id,
            manager_id: manager.id,
            name: manager.full_name || manager.data?.full_name || 'Team Manager',
            email: manager.email,
            role: 'manager',
            status: 'active',
            color: '#FFD700',
            profile_image_url: manager.profile_image_url || manager.data?.profile_image_url || null,
        };
        if (managesTeam) managerProfile.assigned_zip_codes = manager.territory_zip_codes || manager.data?.territory_zip_codes || [];

        return Response.json({
            success: true,
            manager_id: managerId,
            manager: managerProfile,
            members: managesTeam ? members : members.filter(isActive).map(publicMember),
        });
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error('Team roster load failed:', error);
        return Response.json({ error: status === 500 ? 'Unable to load the team roster. Please retry.' : error.message }, { status });
    }
});

