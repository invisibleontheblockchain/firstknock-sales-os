import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { writeAcquisitionMilestone } from '../_shared/acquisitionMilestones.js';

function asArray(value: any) {
    return Array.isArray(value) ? value : (value?.items || []);
}

function normalized(value: any) {
    return String(value || '').trim().toLowerCase();
}

Deno.serve(async (req: Request) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') {
            return Response.json({ error: 'Method not allowed' }, { status: 405 });
        }

        const base44 = createClientFromRequest(req);
        const authenticatedUser = await base44.auth.me();
        if (!authenticatedUser) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const user = await base44.asServiceRole.entities.User.get(authenticatedUser.id);
        if (!user || normalized(user.email) !== normalized(authenticatedUser.email)) {
            return Response.json({ error: 'The authenticated account could not be verified.' }, { status: 401 });
        }
        if (normalized(user.app_role) === 'manager') {
            return Response.json({ success: true, role: 'manager', reused: true });
        }
        if (user.app_role || user.team_manager_id) {
            return Response.json({
                error: 'This account already has a workspace role. Contact support before changing tenants.'
            }, { status: 409 });
        }

        const linkedMemberships = asArray(await base44.asServiceRole.entities.TeamMember.filter({
            user_id: user.id
        }, '-updated_date', 10)).filter((member: any) =>
            normalized(member?.status || 'active') !== 'inactive'
        );
        if (linkedMemberships.length > 0) {
            return Response.json({
                error: 'This account is already linked to a team. Resume that team or contact support.'
            }, { status: 409 });
        }

        await base44.asServiceRole.entities.User.update(user.id, {
            app_role: 'manager'
        });
        await writeAcquisitionMilestone(base44.asServiceRole, {
            eventName: 'role_selected',
            eventKey: `role_${user.id}_manager`,
            user: { ...user, app_role: 'manager' },
            manager: user,
            workspaceManagerId: user.id,
            evidenceId: user.id
        });
        return Response.json({ success: true, role: 'manager', reused: false });
    } catch (error: any) {
        console.error('createManagerWorkspace failed:', error?.message || error);
        return Response.json({ error: 'Unable to create the workspace role.' }, { status: 500 });
    }
});
