import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// This function creates a backup of critical data (properties, logs, routes)
// and returns it as a JSON object. In a production environment, you might
// stream this to a file storage and return a signed URL.

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user || user.role !== 'admin') {
            return Response.json({ error: 'Unauthorized: Admin access required' }, { status: 403 });
        }

        // Fetch data in parallel
        const [properties, logs, routes, team] = await Promise.all([
            base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 5000), // Limit for performance
            base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 5000),
            base44.entities.SavedRoute.list('-created_date', 100),
            base44.entities.TeamMember.list('-created_date', 50)
        ]);

        const backupData = {
            metadata: {
                timestamp: new Date().toISOString(),
                exported_by: user.email,
                version: '1.0'
            },
            stats: {
                properties_count: properties.items ? properties.items.length : properties.length,
                logs_count: logs.items ? logs.items.length : logs.length,
                routes_count: routes.items ? routes.items.length : routes.length
            },
            data: {
                properties: properties.items || properties,
                logs: logs.items || logs,
                routes: routes.items || routes,
                team: team.items || team
            }
        };

        return new Response(JSON.stringify(backupData, null, 2), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="backup_${new Date().toISOString().split('T')[0]}.json"`
            }
        });

    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});