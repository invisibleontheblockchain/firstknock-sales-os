import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const { target_email } = await req.json();
        if (!target_email) {
            return Response.json({ error: 'target_email required' }, { status: 400 });
        }

        // Find the target user
        const users = await base44.asServiceRole.entities.User.filter({ email: target_email });
        const targetUser = Array.isArray(users) ? users[0] : users?.items?.[0];
        
        if (!targetUser) {
            return Response.json({ error: `User ${target_email} not found` }, { status: 404 });
        }

        console.log(`[adminSetOwner] Found user ${targetUser.id} (${targetUser.email}), setting is_owner=true, subscription_status=active`);

        // Update using service role
        await base44.asServiceRole.entities.User.update(targetUser.id, {
            is_owner: true,
            subscription_status: 'active'
        });

        return Response.json({ 
            success: true, 
            message: `Updated ${target_email} to owner with active subscription`,
            user_id: targetUser.id
        });

    } catch (error) {
        console.error('[adminSetOwner] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});