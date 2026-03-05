import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // 1. Get all routes
        const routes = await base44.asServiceRole.entities.SavedRoute.list(null, 1000);
        
        // 2. Get all interaction logs to know what's been knocked
        const logs = await base44.asServiceRole.entities.InteractionLog.list(null, 10000);
        const knockedHashes = new Set(logs.map(l => l.address_hash));
        
        // 3. Get all property hashes from routes
        const allRouteHashes = new Set();
        routes.forEach(r => {
            if (r.property_hashes) {
                r.property_hashes.forEach(h => allRouteHashes.add(h));
            }
        });
        
        // 4. Fetch properties in parallel batches
        const hashArray = Array.from(allRouteHashes);
        const propertiesMap = new Map();
        
        const chunkSize = 100; // Increase chunk size
        const chunks = [];
        for (let i = 0; i < hashArray.length; i += chunkSize) {
            chunks.push(hashArray.slice(i, i + chunkSize));
        }
        
        // Process chunks with concurrency limit
        const CONCURRENCY = 5;
        const results = [];
        
        for (let i = 0; i < chunks.length; i += CONCURRENCY) {
            const batch = chunks.slice(i, i + CONCURRENCY);
            const promises = batch.map(async (chunk) => {
                try {
                    const props = await base44.asServiceRole.entities.MasterProperty.filter({
                        address_hash: { $in: chunk }
                    }, null, 1000); // Limit needs to be >= chunk size
                    return props;
                } catch (e) {
                    console.error("Error fetching chunk", e);
                    return [];
                }
            });
            
            const batchResults = await Promise.all(promises);
            results.push(...batchResults.flat());
        }
        
        results.forEach(p => {
            if (p) propertiesMap.set(p.address_hash, p);
        });
        
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        
        let updatedCount = 0;
        let deletedCount = 0;
        
        const debugInfo = {
            totalRoutes: routes.length,
            totalLogs: logs.length,
            totalPropertiesFetched: propertiesMap.size,
            routeDetails: []
        };
        
        for (const route of routes) {
            if (!route.property_hashes) continue;
            
            const validHashes = route.property_hashes.filter(hash => {
                // Remove if already knocked
                if (knockedHashes.has(hash)) return false;
                
                const prop = propertiesMap.get(hash);
                // If property not found, keep it? No, if we can't verify it, remove it or keep it?
                // Assuming we fetched all properties for the hashes in the routes, if it's missing it might be deleted or invalid hash.
                // Let's assume if it's missing, we remove it to be safe, or check if we should keep.
                // The prompt says "ensure all generated routes and their associated properties reflect only those sold within the last 3 months".
                // So if we don't have the property data, we can't verify sold date, so remove it.
                if (!prop) return false; 
                
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