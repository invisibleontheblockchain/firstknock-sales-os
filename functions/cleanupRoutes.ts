import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Target Kevin's manager ID specifically to clean up his routes
        const managerId = '69763f1a301722430a232206';
        
        // Fetch Kevin's routes
        const routes = await base44.asServiceRole.entities.SavedRoute.filter({
            manager_id: managerId
        }, null, 500); // Fetch up to 500 routes
        
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        
        let updatedCount = 0;
        let deletedCount = 0;
        let processedCount = 0;
        
        for (const route of routes) {
            processedCount++;
            if (!route.property_hashes || route.property_hashes.length === 0) {
                await base44.asServiceRole.entities.SavedRoute.delete(route.id);
                deletedCount++;
                continue;
            }
            
            // Fetch properties for this route
            const props = await base44.asServiceRole.entities.MasterProperty.filter({
                address_hash: { $in: route.property_hashes }
            });
            
            const validHashes = [];
            
            for (const hash of route.property_hashes) {
                const prop = props.find(p => p.address_hash === hash);
                if (prop && prop.sold_date) {
                    const soldDate = new Date(prop.sold_date);
                    if (soldDate >= threeMonthsAgo) {
                        validHashes.push(hash);
                    }
                }
            }
            
            if (validHashes.length === 0) {
                // Delete route if empty
                await base44.asServiceRole.entities.SavedRoute.delete(route.id);
                deletedCount++;
            } else if (validHashes.length !== route.property_hashes.length) {
                // Update route with filtered hashes
                await base44.asServiceRole.entities.SavedRoute.update(route.id, {
                    property_hashes: validHashes,
                    metrics: {
                        ...route.metrics,
                        house_count: validHashes.length
                    }
                });
                updatedCount++;
            }
        }
        
        return Response.json({
            success: true,
            message: `Cleaned up Kevin's routes. Processed ${processedCount}, updated ${updatedCount}, deleted ${deletedCount} empty routes.`
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});