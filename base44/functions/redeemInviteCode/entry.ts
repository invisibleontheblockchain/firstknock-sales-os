import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const CLAIM_EXISTING_ACTION = 'claim_existing';

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function toArray(result) {
    return Array.isArray(result) ? result : result?.items || [];
}

function normalized(value) {
    return String(value || '').trim().toLowerCase();
}

function isActiveRep(member) {
    return normalized(member?.status || 'active') !== 'inactive'
        && normalized(member?.role || 'rep') === 'rep';
}

function isManagerAccount(user) {
    const appRole = normalized(user?.app_role || user?.data?.app_role);
    const accountRole = normalized(user?.role || user?.data?.role);
    return user?.is_owner === true
        || appRole === 'manager'
        || appRole === 'admin'
        || accountRole === 'manager'
        || accountRole === 'admin';
}

async function getManager(service, managerId) {
    try {
        const manager = await service.entities.User.get(managerId);
        return manager && isManagerAccount(manager) ? manager : null;
    } catch {
        return null;
    }
}

async function claimExistingMembership(service, user) {
    const email = normalized(user?.email);
    if (!email) throw new HttpError(400, 'Your account needs a verified email before it can join a team.');

    // The client never supplies a manager or TeamMember ID. Resolve candidates from
    // authenticated identity only, then verify that the manager created email-only
    // roster records before allowing the account to claim them.
    const [linkedResult, emailResult] = await Promise.all([
        service.entities.TeamMember.filter({ user_id: user.id }, '-created_date', 50),
        service.entities.TeamMember.filter({ email }, '-created_date', 50)
    ]);

    const byId = new Map();
    for (const member of [...toArray(linkedResult), ...toArray(emailResult)]) {
        if (member?.id) byId.set(String(member.id), member);
    }

    const identityMatches = [...byId.values()].filter((member) => {
        const linkedUserId = String(member?.user_id || '').trim();
        return isActiveRep(member)
            && !!member?.manager_id
            && normalized(member?.email) === email
            && (!linkedUserId || linkedUserId === String(user.id));
    });

    const verified = [];
    for (const member of identityMatches) {
        const manager = await getManager(service, member.manager_id);
        if (!manager) continue;

        const alreadyLinked = String(member.user_id || '') === String(user.id);
        const createdByManager = normalized(member.created_by) === normalized(manager.email);
        if (alreadyLinked || createdByManager) verified.push({ member, manager });
    }

    const currentManagerId = String(user?.team_manager_id || user?.data?.team_manager_id || '').trim();
    const currentMatches = currentManagerId
        ? verified.filter(({ member }) => String(member.manager_id) === currentManagerId)
        : [];
    const linkedMatches = verified.filter(({ member }) => String(member.user_id || '') === String(user.id));
    const preferred = currentMatches.length > 0
        ? currentMatches
        : (linkedMatches.length > 0 ? linkedMatches : verified);

    const managerIds = new Set(preferred.map(({ member }) => String(member.manager_id)));
    if (managerIds.size === 0) {
        throw new HttpError(404, 'No active team membership could be verified. Ask your manager for a current invite code.');
    }
    if (managerIds.size > 1) {
        throw new HttpError(409, 'More than one team membership matches this account. Use the invite code for the team you want to join.');
    }

    const selectedManagerId = [...managerIds][0];
    const selected = preferred.find(({ member }) => String(member.manager_id) === selectedManagerId);
    let member = selected.member;

    if (String(member.user_id || '') !== String(user.id)) {
        member = await service.entities.TeamMember.update(member.id, { user_id: user.id });
    }

    const userUpdates = {
        app_role: 'rep',
        team_manager_id: selectedManagerId
    };
    if (member.invite_code) userUpdates.team_invite_code = member.invite_code;
    await service.entities.User.update(user.id, userUpdates);

    return {
        success: true,
        role: 'rep',
        manager_id: selectedManagerId,
        team_member_id: member.id,
        claimed_existing: true
    };
}

// Trusted team onboarding. Both invite redemption and returning-rep claims write
// User.team_manager_id through service role because clients cannot own tenant links.
Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) throw new HttpError(401, 'Unauthorized');

        const body = await req.json().catch(() => ({}));
        const service = base44.asServiceRole;

        if (body?.action === CLAIM_EXISTING_ACTION) {
            return Response.json(await claimExistingMembership(service, user));
        }

        const code = body?.code;
        if (!code || typeof code !== 'string') {
            throw new HttpError(400, 'Missing invite code');
        }

        const email = normalized(user.email);
        if (!email) throw new HttpError(400, 'Your account needs a verified email before it can join a team.');
        const normalizedCode = code.trim().toUpperCase();

        // 1. Validate the manager-owned code.
        const codes = toArray(await service.entities.InviteCode.filter(
            { code: normalizedCode, is_active: true }, '-created_date', 1
        ));
        const validCode = codes[0];
        if (!validCode) throw new HttpError(404, 'Invalid or expired code');

        const managerId = String(validCode.linked_user_id || '').trim();
        if (!managerId) {
            throw new HttpError(400, 'This team code is not linked to a manager account');
        }

        const manager = await getManager(service, managerId);
        if (!manager) throw new HttpError(400, 'This team code is not linked to an active manager account');

        // Public team codes can only establish rep membership. Manager/admin roles
        // are granted through their dedicated trusted flows, never from legacy or
        // client-minted invite records.
        if (normalized(validCode.role) !== 'rep') {
            throw new HttpError(403, 'Only rep invite codes can be redeemed. Ask an administrator to grant elevated access.');
        }

        // 2. Match only this manager's roster record. Never repoint a membership
        // belonging to another team just because it uses the same email address.
        const [linkedResult, emailResult] = await Promise.all([
            service.entities.TeamMember.filter({ user_id: user.id, manager_id: managerId }, '-created_date', 10),
            service.entities.TeamMember.filter({ email, manager_id: managerId }, '-created_date', 10)
        ]);
        const candidates = [...toArray(linkedResult), ...toArray(emailResult)];
        let member = candidates.find((candidate) => (
            String(candidate?.manager_id || '') === managerId
            && normalized(candidate?.email) === email
            && (!candidate?.user_id || String(candidate.user_id) === String(user.id))
        )) || null;
        const alreadyActiveOnThisTeam = !!member && normalized(member.status || 'active') !== 'inactive';

        // A roster record already bound to another auth account cannot be taken over,
        // even if an email happens to match.
        const conflictingMember = candidates.find((candidate) => (
            String(candidate?.manager_id || '') === managerId
            && normalized(candidate?.email) === email
            && candidate?.user_id
            && String(candidate.user_id) !== String(user.id)
        ));
        if (!member && conflictingMember) {
            throw new HttpError(409, 'This team membership is already linked to another account.');
        }

        // 3. Enforce paid seat capacity before creating or reactivating a rep.
        if (!alreadyActiveOnThisTeam && normalized(validCode.role) !== 'manager') {
            const isTestCode = validCode.code === '0000';
            const paidSeatLimit = isTestCode
                ? 2
                : (manager.is_owner || manager.subscription_paid_confirmed === true ? (manager.total_seats || 1) : 0);
            const codeSeatLimit = Number.isFinite(Number(validCode.max_uses)) ? Number(validCode.max_uses) : paidSeatLimit;
            const usableSeatLimit = Math.max(0, Math.min(paidSeatLimit, codeSeatLimit));
            const teamMembers = toArray(await service.entities.TeamMember.filter({ manager_id: managerId }, '-created_date', 500));
            const activeRepCount = teamMembers.filter((candidate) => (
                normalized(candidate.status || 'active') !== 'inactive'
                && normalized(candidate.role || 'rep') !== 'manager'
            )).length;

            if (activeRepCount >= usableSeatLimit) {
                throw new HttpError(403, 'This team has no paid seats available. Ask your manager to add a seat first.');
            }
        }

        // 4. Upsert the roster link first so a successful User tenant link always
        // has a corresponding TeamMember source of truth.
        const isNewMembership = !member;
        if (!member) {
            member = await service.entities.TeamMember.create({
                name: user.full_name || email.split('@')[0],
                email,
                user_id: user.id,
                role: validCode.role,
                status: 'active',
                color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
                manager_id: managerId,
                invite_code: validCode.code
            });
        } else {
            const updates = {};
            if (String(member.user_id || '') !== String(user.id)) updates.user_id = user.id;
            if (member.invite_code !== validCode.code) updates.invite_code = validCode.code;
            if (member.role !== validCode.role) updates.role = validCode.role;
            if (normalized(member.status) === 'inactive') updates.status = 'active';
            if (Object.keys(updates).length > 0) {
                member = await service.entities.TeamMember.update(member.id, updates);
            }
        }

        // 5. Tenant ownership is server-authored because User.team_manager_id is
        // protected by field-level security.
        await service.entities.User.update(user.id, {
            app_role: validCode.role,
            team_manager_id: managerId,
            team_invite_code: validCode.code
        });

        // 6. Count only a newly created membership, not a returning/retry claim.
        if (isNewMembership) {
            await service.entities.InviteCode.update(validCode.id, {
                used_count: (validCode.used_count || 0) + 1
            });
        }

        return Response.json({
            success: true,
            role: validCode.role,
            manager_id: managerId,
            team_member_id: member.id,
            claimed_existing: false
        });
    } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        return Response.json({ error: error?.message || 'Unable to join team' }, { status });
    }
});
