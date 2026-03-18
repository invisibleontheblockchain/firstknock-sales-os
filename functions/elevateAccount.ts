import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204 });
        }

        const base44 = createClientFromRequest(req);
        
        console.log("Looking up Christian's account...");
        const users = await base44.asServiceRole.entities.User.filter({ email: "Christian@nativapest.com" });
        
        if (!users || users.length === 0) {
            return Response.json({ error: "Account not found." }, { status: 404 });
        }

        const user = users[0];
        console.log(`Found user: ${user.id}`);

        // 1. Elevate to Owner
        await base44.asServiceRole.entities.User.update(user.id, {
            is_owner: true,
            role: 'owner',
            area_pulls_count: 0 // Reset their pulls as a courtesy
        });
        
        let report = `✅ Elevated ${user.email} out of beta limits.\n`;

        // 2. Clear duplicate routes
        console.log("Looking for routes created by Christian...");
        const routes = await base44.asServiceRole.entities.SavedRoute.filter({ created_by: user.id });
        
        let deletedCount = 0;
        let skipCount = 0;
        
        if (routes && routes.length > 0) {
            for (const route of routes) {
                if (!route.property_hashes) {
                    skipCount++;
                    continue;
                }
                
                const uniqueHashes = new Set(route.property_hashes);
                if (uniqueHashes.size < route.property_hashes.length) {
                    console.log(`Route ${route.name} has duplicates. Deleting...`);
                    await base44.asServiceRole.entities.SavedRoute.delete(route.id);
                    deletedCount++;
                } else {
                    skipCount++;
                }
            }
        }
        
        report += `✅ Deleted ${deletedCount} duplicate routes. Kept ${skipCount} clean routes.`;
        
        return Response.json({ success: true, message: report });

    } catch (error) {
        console.error("Error:", error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});
