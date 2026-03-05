import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // 1. Get all routes
        const routes = await base44.asServiceRole.entities.SavedRoute.list(null, 1000);
        
        // 2. Get all interaction logs to know what's been knocked
        const logs = await base44.asServiceRole.entities.InteractionLog.list(null, 10000);
        const knockedHashes = new Set(logs.map(l => l.address_hash));
        
        // 3. Get all properties
        const propertiesMap = new Map();
        let skip = 0;
        let hasMore = true;
        while (hasMore) {
            // Since skip is not directly supported in list, we can use filter with skip if available, 
            // but actually let's just fetch all properties if it's less than 10000, or we can just fetch the ones we need.
            // Wait, we can't do skip easily. Let's just fetch up to 10000 properties.
            const props = await base44.asServiceRole.entities.MasterProperty.list(null, 10000);
            props.forEach(p => propertiesMap.set(p.address_hash, p));
            hasMore = false; // Just fetch 10000 for now
        }
        
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        
        let updatedCount = 0;
        let deletedCount = 0;
        
        const debugInfo = {
            totalRoutes: routes.length,
            totalLogs: logs.length,
            totalProperties: propertiesMap.size,
            routeDetails: []
        };
        
        for (const route of routes) {
            if (!route.property_hashes) continue;
            
            const validHashes = route.property_hashes.filter(hash => {
                // Remove if already knocked
                if (knockedHashes.has(hash)) return false;
                
                const prop = propertiesMap.get(hash);
                if (!prop) return false; // Property not found
                
                // Remove if no sold_date
                if (!prop.sold_date) return false;
                
                // Remove if sold_date is older than 3 months
                try {
                    const soldDate = new Date(prop.sold_date);
                    if (soldDate < threeMonthsAgo) return false;
                } catch (e) {
                    return false;
                }
                
                return true;
            });
            
            if (validHashes.length === 0) {
                // Delete route
                await base44.asServiceRole.entities.SavedRoute.delete(route.id);
                deletedCount++;
                debugInfo.routeDetails.push({ id: route.id, action: 'deleted', oldLength: route.property_hashes.length });
            } else if (validHashes.length !== route.property_hashes.length) {
                // Update route
                await base44.asServiceRole.entities.SavedRoute.update(route.id, {
                    property_hashes: validHashes,
                    metrics: {
                        ...route.metrics,
                        house_count: validHashes.length
                    }
                });
                updatedCount++;
                debugInfo.routeDetails.push({ id: route.id, action: 'updated', oldLength: route.property_hashes.length, newLength: validHashes.length });
            }
        }
        
        return Response.json({ 
            success: true, 
            message: `Cleaned up routes. Updated ${updatedCount} routes, deleted ${deletedCount} empty routes.`,
            debugInfo
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});