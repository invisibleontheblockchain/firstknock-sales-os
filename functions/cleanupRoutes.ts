import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // 1. Get all routes
        const routes = await base44.asServiceRole.entities.SavedRoute.list(null, 1000);
        
        // 2. Get all interaction logs to know what's been knocked
        // We might not have 10k logs, maybe 1000 is enough to not rate limit
        const logs = await base44.asServiceRole.entities.InteractionLog.list(null, 2000);
        const knockedHashes = new Set(logs.map(l => l.address_hash));
        
        // 3. Instead of fetching all properties, only fetch those that WERE sold in the last 3 months.
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        const threeMonthsAgoIso = threeMonthsAgo.toISOString();
        
        // This will only return properties that match, hopefully a small number!
        const recentlySold = await base44.asServiceRole.entities.MasterProperty.filter({
            sold_date: { $gte: threeMonthsAgoIso }
        }, null, 5000);
        
        const validSoldHashes = new Set(recentlySold.map(p => p.address_hash));
        
        let updatedCount = 0;
        let deletedCount = 0;
        
        const debugInfo = {
            totalRoutes: routes.length,
            totalLogsFetched: logs.length,
            totalRecentlySoldFetched: recentlySold.length,
            routeDetails: []
        };
        
        for (const route of routes) {
            if (!route.property_hashes) continue;
            
            const validHashes = route.property_hashes.filter(hash => {
                // Remove if already knocked
                if (knockedHashes.has(hash)) return false;
                
                // Remove if NOT in recentlySold
                if (!validSoldHashes.has(hash)) return false;
                
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