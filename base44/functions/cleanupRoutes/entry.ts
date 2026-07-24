import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// RETIRED: the former implementation permanently deleted SavedRoute records or
// removed property_hashes when a separate property lookup failed. A missing
// hydration link is not proof that a route or door should be deleted.
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
            error: 'cleanup_routes_retired',
            message: 'Saved routes are never deleted or rewritten because property hydration is incomplete. No records were changed.'
        }, { status: 410 });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
