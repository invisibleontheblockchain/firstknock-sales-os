import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        const threeMonthsAgoIso = threeMonthsAgo.toISOString();
        
        const recentlySold = await base44.asServiceRole.entities.MasterProperty.filter({
            sold_date: { $gte: threeMonthsAgoIso }
        }, null, 1000);
        
        return Response.json({
            count: recentlySold.length,
            sample: recentlySold.slice(0, 2)
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});