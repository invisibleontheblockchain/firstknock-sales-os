import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// RETIRED: account-specific route mutations must never be exposed as a
// user-callable service-role function.
Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (String(user.role || user?.data?.role || '').toLowerCase() !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        return Response.json({
            error: 'account_route_restore_retired',
            message: 'Account-specific route restoration is retired. No records were changed.'
        }, { status: 410 });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
