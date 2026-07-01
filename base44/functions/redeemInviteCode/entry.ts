import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Atomic server-side invite redemption.
// Validates the code with service role, enforces paid seat capacity,
// links the TeamMember record by user_id, and increments usage in one trusted call.
Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { code } = await req.json().catch(() => ({}));
        if (!code || typeof code !== 'string') {
            return Response.json({ error: 'Missing invite code' }, { status: 400 });
        }

        const svc = base44.asServiceRole;
        const toArr = (r) => Array.isArray(r) ? r : r?.items || [];
        const normalizedCode = code.trim().toUpperCase();
        const emailLower = user.email.trim().toLowerCase();

        // 1. Validate code
        const codes = toArr(await svc.entities.InviteCode.filter(
            { code: normalizedCode, is_active: true }, '-created_date', 1
        ));
        const validCode = codes[0];
        if (!validCode) {
            return Response.json({ error: 'Invalid or expired code' }, { status: 404 });
        }

        const managerId = validCode.linked_user_id || null;
        if (!managerId) {
            return Response.json({ error: 'This team code is not linked to a manager account' }, { status: 400 });
        }

        // 2. Find whether this user is already on this manager's team.
        const existing = toArr(await svc.entities.TeamMember.filter({ email: emailLower }, '-created_date', 10));
        let member = existing.find((m) => managerId && m.manager_id === managerId) || existing[0] || null;
        const alreadyOnThisTeam = !!member && member.manager_id === managerId;

        // 3. Enforce paid seat capacity before linking a new rep to the manager.
        if (!alreadyOnThisTeam && validCode.role !== 'manager') {
            const manager = await svc.entities.User.get(managerId);
            const isTestCode = validCode.code === '0000';
            const paidSeatLimit = isTestCode
                ? 2
                : (manager?.is_owner || manager?.subscription_paid_confirmed === true ? (manager?.total_seats || 1) : 0);
            const codeSeatLimit = Number.isFinite(Number(validCode.max_uses)) ? Number(validCode.max_uses) : paidSeatLimit;
            const usableSeatLimit = Math.max(0, Math.min(paidSeatLimit, codeSeatLimit));
            const teamMembers = toArr(await svc.entities.TeamMember.filter({ manager_id: managerId }, '-created_date', 500));
            const activeRepCount = teamMembers.filter((m) => m.status !== 'inactive' && m.role !== 'manager').length;

            if (activeRepCount >= usableSeatLimit) {
                return Response.json({ error: 'This team has no paid seats available. Ask your manager to add a seat first.' }, { status: 403 });
            }
        }

        // 4. Update the user's app role + team link (user-scoped, acts as the caller)
        await base44.auth.updateMe({
            app_role: validCode.role,
            team_manager_id: managerId,
            team_invite_code: validCode.code
        });

        // 5. Upsert TeamMember — linked by user_id for O(1) future lookups
        if (!member) {
            member = await svc.entities.TeamMember.create({
                name: user.full_name || emailLower.split('@')[0],
                email: emailLower,
                user_id: user.id,
                role: validCode.role,
                status: 'active',
                color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
                manager_id: managerId,
                invite_code: validCode.code
            });
        } else {
            const updates = {};
            if (member.user_id !== user.id) updates.user_id = user.id;
            if (member.manager_id !== managerId) updates.manager_id = managerId;
            if (member.invite_code !== validCode.code) updates.invite_code = validCode.code;
            if (member.role !== validCode.role) updates.role = validCode.role;
            if (member.status === 'inactive') updates.status = 'active';
            if (Object.keys(updates).length > 0) {
                member = await svc.entities.TeamMember.update(member.id, updates);
            }
        }

        // 6. Increment usage count only for a new team join.
        if (!alreadyOnThisTeam) {
            await svc.entities.InviteCode.update(validCode.id, {
                used_count: (validCode.used_count || 0) + 1
            });
        }

        return Response.json({
            success: true,
            role: validCode.role,
            manager_id: managerId,
            team_member_id: member.id
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});