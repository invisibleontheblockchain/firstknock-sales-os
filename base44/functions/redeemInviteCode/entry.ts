import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Atomic server-side invite redemption.
// Validates the code with service role (codes are not readable by anonymous users under RLS),
// links the TeamMember record by user_id, and increments usage — all in one trusted call.
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

        // 1. Validate code
        const codes = toArr(await svc.entities.InviteCode.filter(
            { code: code.trim().toUpperCase(), is_active: true }, '-created_date', 1
        ));
        const validCode = codes[0];
        if (!validCode) {
            return Response.json({ error: 'Invalid or expired code' }, { status: 404 });
        }

        const emailLower = user.email.trim().toLowerCase();
        const managerId = validCode.linked_user_id || null;

        // 2. Update the user's app role + team link (user-scoped, acts as the caller)
        await base44.auth.updateMe({
            app_role: validCode.role,
            team_manager_id: managerId,
            team_invite_code: validCode.code
        });

        // 3. Upsert TeamMember — scoped lookup by email, linked by user_id for O(1) future lookups
        const existing = toArr(await svc.entities.TeamMember.filter({ email: emailLower }, '-created_date', 5));
        let member = existing.find((m) => managerId && m.manager_id === managerId) || existing[0] || null;

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
            if (managerId && member.manager_id !== managerId) updates.manager_id = managerId;
            if (member.invite_code !== validCode.code) updates.invite_code = validCode.code;
            if (Object.keys(updates).length > 0) {
                await svc.entities.TeamMember.update(member.id, updates);
            }
        }

        // 4. Increment usage count
        await svc.entities.InviteCode.update(validCode.id, {
            used_count: (validCode.used_count || 0) + 1
        });

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