const PAGE_SIZE = 500;
const MAX_PAGES = 100;
const normalized = value => String(value || '').trim().toLowerCase();
const asArray = value => Array.isArray(value) ? value : value?.items || [];
const isActive = member => normalized(member?.status || 'active') !== 'inactive';
const PUBLIC_FIELDS = ['id', 'user_id', 'manager_id', 'name', 'email', 'role', 'status', 'color', 'profile_image_url'];

function isManager(user) {
    return user?.is_owner === true || user?.data?.is_owner === true
        || ['manager', 'admin'].includes(normalized(user?.app_role || user?.data?.app_role))
        || ['manager', 'admin'].includes(normalized(user?.role || user?.data?.role));
}

export class TeamRosterError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

// Execute authoritative account/membership checks for every request. This
// helper avoids a nested HTTP function call; it does not cache authorization.
export async function loadAuthorizedTeamRoster(base44) {
    const identity = await base44.auth.me();
    if (!identity?.id) throw new TeamRosterError(401, 'Sign in to view your team.');
    const service = base44.asServiceRole.entities;
    const accountIds = Array.from(new Set([identity.id, identity.team_manager_id || identity.data?.team_manager_id].filter(Boolean)));
    const accounts = asArray(await service.User.filter({ id: accountIds }, '-created_date', accountIds.length, 0));
    const user = accounts.find(account => account.id === identity.id);
    if (!user) throw new TeamRosterError(401, 'Account could not be verified.');
    const managesTeam = isManager(user);
    const managerId = managesTeam ? user.id : (user.team_manager_id || user.data?.team_manager_id);
    if (!managerId || (!managesTeam && normalized(user.app_role || user.data?.app_role) !== 'rep')) {
        throw new TeamRosterError(403, 'Join a team before viewing its roster.');
    }
    const manager = managesTeam ? user : (accounts.find(account => account.id === managerId) || await service.User.get(managerId));
    if (!manager || manager.id !== managerId || !isManager(manager)) {
        throw new TeamRosterError(403, 'Your team manager could not be verified.');
    }

    const members = [];
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
        const rows = asArray(await service.TeamMember.filter({ manager_id: managerId }, '-created_date', PAGE_SIZE, page * PAGE_SIZE,
            managesTeam ? undefined : PUBLIC_FIELDS));
        members.push(...rows.filter(member => member.manager_id === managerId));
        if (rows.length < PAGE_SIZE) { complete = true; break; }
    }
    if (!complete) throw new TeamRosterError(503, 'The team roster is too large to load. Please contact support.');
    if (!managesTeam && !members.some(member => isActive(member)
        && member.user_id === user.id && normalized(member.role || 'rep') === 'rep')) {
        throw new TeamRosterError(403, 'An active team membership is required to view this roster.');
    }
    const managerProfile = {
        id: manager.id, user_id: manager.id, manager_id: manager.id,
        name: manager.full_name || manager.data?.full_name || 'Team Manager',
        email: manager.email, role: 'manager', status: 'active', color: '#FFD700',
        profile_image_url: manager.profile_image_url || manager.data?.profile_image_url || null,
    };
    if (managesTeam) managerProfile.assigned_zip_codes = manager.territory_zip_codes || manager.data?.territory_zip_codes || [];
    return {
        success: true, manager_id: managerId, manager: managerProfile,
        members: managesTeam ? members : members.filter(isActive).map(member => Object.fromEntries(
            PUBLIC_FIELDS.filter(key => member[key] !== undefined).map(key => [key, member[key]])
        )),
    };
}
