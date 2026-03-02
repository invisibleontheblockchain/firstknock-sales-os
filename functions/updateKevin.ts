import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const users = await base44.asServiceRole.entities.User.filter({ email: 'kevin@reifenvironmental.com' });
        if (users.length > 0) {
            await base44.asServiceRole.entities.User.update(users[0].id, {
                subscription_status: 'active',
                total_seats: 999
            });
            return Response.json({ success: true, user: users[0].id });
        }
        return Response.json({ success: false, message: 'User not found' });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});