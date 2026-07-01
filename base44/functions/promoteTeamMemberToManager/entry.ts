import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function isManagerLike(user) {
  const appRole = user?.app_role || user?.data?.app_role || '';
  const accountRole = user?.role || user?.data?.role || '';
  return user?.is_owner === true || appRole === 'manager' || appRole === 'admin' || accountRole === 'manager' || accountRole === 'admin';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!isManagerLike(user)) return Response.json({ error: 'Only managers can switch team roles.' }, { status: 403 });

    const body = await req.json();
    const teamMemberId = body?.teamMemberId;
    if (!teamMemberId) return Response.json({ error: 'Missing team member.' }, { status: 400 });

    const member = await base44.asServiceRole.entities.TeamMember.get(teamMemberId);
    if (!member) return Response.json({ error: 'Team member not found.' }, { status: 404 });

    const accountRole = user?.role || user?.data?.role || '';
    const isPlatformAdmin = accountRole === 'admin' || user?.is_owner === true;
    if (!isPlatformAdmin && member.manager_id !== user.id) {
      return Response.json({ error: 'You can only switch roles for reps on your team.' }, { status: 403 });
    }

    if (!member.user_id) {
      return Response.json({ error: 'This rep must join/sign in before their account role can be upgraded.' }, { status: 400 });
    }

    await base44.asServiceRole.entities.User.update(member.user_id, {
      app_role: 'manager',
      team_manager_id: null
    });

    const updatedMember = await base44.asServiceRole.entities.TeamMember.update(member.id, {
      role: 'manager'
    });

    return Response.json({ success: true, team_member_id: updatedMember.id, role: 'manager' });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});