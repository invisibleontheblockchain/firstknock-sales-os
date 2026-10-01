const normalized = (value) => String(value || '').trim().toLowerCase();
const isActive = (member) => normalized(member?.status || 'active') !== 'inactive';

function matchesManager(member, manager) {
    return member.user_id ? member.user_id === manager.id
        : member.id === manager.id || (!!member.email && normalized(member.email) === normalized(manager.email));
}

export function buildTeamRoster(members = [], manager, currentUserId, activeTeamCode = 'all') {
    const unique = new Map();
    for (const member of members) {
        if (!member?.id || (manager && matchesManager(member, manager))) continue;
        if (activeTeamCode !== 'all' && member.invite_code !== activeTeamCode) continue;
        const key = member.user_id ? `user:${member.user_id}` : normalized(member.email) || `member:${member.id}`;
        if (!unique.has(key) || (!isActive(unique.get(key)) && isActive(member))) unique.set(key, member);
    }
    const roster = [...unique.values()];
    if (!manager?.id) return roster;
    const existing = members.find((member) => matchesManager(member, manager));
    return [{
        ...existing,
        ...manager,
        id: existing?.id || manager.id,
        isTeamManager: true,
        isManagerSelf: currentUserId === manager.id,
        auto_assign_enabled: false,
    }, ...roster];
}

export function getActiveTeamSize(roster = []) {
    return roster.filter(isActive).length;
}

export function getRepSeatCount(members = []) {
    return members.filter((member) => isActive(member) && normalized(member.role || 'rep') === 'rep').length;
}

