import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Target Kevin's manager ID specifically
        const managerId = '69763f1a301722430a232206';
        
        // Fetch Kevin's routes
        const routes = await base44.asServiceRole.entities.SavedRoute.filter({
            manager_id: managerId
        }, null, 500);
        
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        
        // Collect all unique hashes
        const allHashes = new Set();
        for (const route of routes) {
            if (route.property_hashes) {
                for (const hash of route.property_hashes) {
                    allHashes.add(hash);
                }
            }
        }
        
        const hashesArray = Array.from(allHashes);
        const validHashes = new Set();
        
        // Fetch properties in chunks to avoid rate limits
        const chunkSize = 200;
        for (let i = 0; i < hashesArray.length; i += chunkSize) {
            const chunk = hashesArray.slice(i, i + chunkSize);
            const props = await base44.asServiceRole.entities.MasterProperty.filter({
                address_hash: { $in: chunk }
            }, null, chunkSize);
            
            for (const prop of props) {
                if (prop.sold_date) {
                    const soldDate = new Date(prop.sold_date);
                    if (soldDate >= threeMonthsAgo) {
                        validHashes.add(prop.address_hash);
                    }
                }
            }
        }
        
        let updatedCount = 0;
        let deletedCount = 0;
        let processedCount = 0;
        
        // Now update the routes
        for (const route of routes) {
            processedCount++;
            if (!route.property_hashes || route.property_hashes.length === 0) {
                await base44.asServiceRole.entities.SavedRoute.delete(route.id);
                deletedCount++;
                continue;
            }
            
            const newHashes = route.property_hashes.filter(hash => validHashes.has(hash));
            
            if (newHashes.length === 0) {
                // Delete route if empty
                await base44.asServiceRole.entities.SavedRoute.delete(route.id);
                deletedCount++;
            } else if (newHashes.length !== route.property_hashes.length) {
                // Update route with filtered hashes
                await base44.asServiceRole.entities.SavedRoute.update(route.id, {
                    property_hashes: newHashes,
                    metrics: {
                        ...route.metrics,
                        house_count: newHashes.length
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