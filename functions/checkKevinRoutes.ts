import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Kevin's manager ID is 69763f1a301722430a232206
        const managerId = '69763f1a301722430a232206';
        
        // Fetch Kevin's routes
        const routes = await base44.asServiceRole.entities.SavedRoute.filter({
            manager_id: managerId
        }, null, 100);
        
        let totalRoutes = routes.length;
        let totalProperties = 0;
        
        // Just check the first route to see its properties
        let sampleRoute = routes[0];
        let sampleProperties = [];
        let validCount = 0;
        let invalidCount = 0;
        
        if (sampleRoute && sampleRoute.property_hashes) {
            totalProperties = sampleRoute.property_hashes.length;
            
            // Check properties for the first route
            for (const hash of sampleRoute.property_hashes.slice(0, 50)) {
                const props = await base44.asServiceRole.entities.MasterProperty.filter({
                    address_hash: hash
                });
                
                if (props.length > 0) {
                    const p = props[0];
                    sampleProperties.push({
                        hash,
                        sold_date: p.sold_date
                    });
                    
                    if (p.sold_date) {
                        const soldDate = new Date(p.sold_date);
                        const threeMonthsAgo = new Date();
                        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
                        
                        if (soldDate >= threeMonthsAgo) {
                            validCount++;
                        } else {
                            invalidCount++;
                        }
                    } else {
                        invalidCount++;
                    }
                }
            }
        }
        
        return Response.json({
            totalRoutes,
            sampleRouteId: sampleRoute?.id,
            sampleRouteName: sampleRoute?.name,
            sampleRoutePropertyCount: totalProperties,
            samplePropertiesChecked: sampleProperties.length,
            validCount,
            invalidCount,
            sampleProperties
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});