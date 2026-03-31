import { createClientFromRequest } from "npm:@base44/sdk@0.8.20";

export default async (req) => {
    const base44 = createClientFromRequest(req);
    
    try {
        const body = await req.json();
        const { properties } = body;
        
        if (!properties || !Array.isArray(properties)) {
            return new Response(JSON.stringify({ error: "No properties provided" }), { status: 400 });
        }
        
        console.log(`[cleanRoute] Processing ${properties.length} properties securely...`);
        
        let removedCount = 0;
        let keptCount = 0;
        
        for (const p of properties) {
            if (!p.id) continue;
            
            let isFalseDoor = false;
            
            // 1. County Lag Rule (>90 days)
            const targetDate = p.sold_date || p.created_date;
            if (targetDate) {
                const daysSinceSold = Math.round((new Date().getTime() - new Date(targetDate).getTime()) / (1000 * 3600 * 24));
                if (daysSinceSold > 90) isFalseDoor = true;
            }
            
            // 2. Listing failed
            if (p.days_on_market && p.days_on_market > 150) isFalseDoor = true;
            if (p.sale_confidence === 'REJECTED' || p.original_status === 'REJECTED') isFalseDoor = true;

            const existing = await base44.asServiceRole.entities.MasterProperty.get(p.id).catch(() => null);
            if (!existing) continue;

            if (isFalseDoor) {
                removedCount++;
                await base44.asServiceRole.entities.MasterProperty.update(p.id, {
                    original_status: 'REJECTED',
                    sale_confidence: 'REJECTED'
                });
            } else {
                keptCount++;
                if (existing.sale_confidence === 'low' || existing.sale_confidence === 'REJECTED') {
                    await base44.asServiceRole.entities.MasterProperty.update(p.id, {
                        original_status: 'HEURISTIC_SOLD',
                        sale_confidence: 'medium'
                    });
                }
            }
        }
        
        return new Response(JSON.stringify({ 
            success: true, 
            message: `Cleaned route`,
            stats: { removed: removedCount, kept: keptCount }
        }), { status: 200, headers: { "Content-Type": "application/json" } });

    } catch (err) {
        console.error("[cleanRoute] Error:", err.message);
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
};
