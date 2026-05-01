import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const KEVIN_USER_ID = '69763f1a301722430a232206';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const routes = await base44.asServiceRole.entities.SavedRoute.filter({
            manager_id: KEVIN_USER_ID
        }, '-updated_date', 200);

        const restored = [];
        for (const route of routes) {
            const updates = {
                status: 'ACTIVE',
                manager_id: KEVIN_USER_ID
            };

            await base44.asServiceRole.entities.SavedRoute.update(route.id, updates);
            restored.push({
                id: route.id,
                name: route.name,
                previous_status: route.status,
                property_count: Array.isArray(route.property_hashes) ? route.property_hashes.length : 0
            });
        }

        return Response.json({
            restored_count: restored.length,
            restored
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});