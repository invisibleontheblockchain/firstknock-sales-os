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
        
        // 4. Fetch properties in batches of 50
        const hashArray = Array.from(allRouteHashes);
        const propertiesMap = new Map();
        
        const chunkSize = 50;
        for (let i = 0; i < hashArray.length; i += chunkSize) {
            const chunk = hashArray.slice(i, i + chunkSize);
            try {
                // Fetch using $in if supported, or multiple ORs? 
                // The SDK might support $in
                const props = await base44.asServiceRole.entities.MasterProperty.filter({
                    address_hash: { $in: chunk }
                }, null, 100);
                
                if (props && props.length > 0) {
                    props.forEach(p => propertiesMap.set(p.address_hash, p));
                }
            } catch (e) {
                console.error("Error fetching batch", e);
            }
            // Add a delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
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
                if (!prop) return false; // Property not found or not fetched
                
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