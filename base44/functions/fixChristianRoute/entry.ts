import { createClientFromRequest } from "npm:@base44/sdk@0.8.20";

export default async (req) => {
    const base44 = createClientFromRequest(req);
    
    try {
        console.log('[fixChristianRoute] Starting one-time retroactive cleanup');

        // Get Christian's User ID to find his zip codes
        const users = await base44.asServiceRole.entities.User.filter({ email: 'christian@nativapest.com' }, null, 1);
        const userArr = Array.isArray(users) ? users : (users?.items || []);
        
        if (userArr.length === 0) {
            return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });
        }
        
        const christian = userArr[0];
        
        // Find his territories to get zip codes
        const territories = await base44.asServiceRole.entities.Territory.filter({ user_id: christian.id }, null, 100);
        const territoryArr = Array.isArray(territories) ? territories : (territories?.items || []);
        
        let allZips = [];
        for (const t of territoryArr) {
            if (t.zip_codes && Array.isArray(t.zip_codes)) {
                allZips.push(...t.zip_codes);
            }
        }
        // Fallback to exactly Anderson SC zips if his territory zip list is empty
        if (allZips.length === 0) {
            allZips = ['29621', '29624', '29625', '29626', '29627']; 
        }
        
        const uniqueZips = [...new Set(allZips)];
        console.log(`[fixChristianRoute] Cleaning Zips: ${uniqueZips.join(', ')}`);

        // Get all Recent Off Market / Low Confidence properties in his zones
        let cleanCount = 0;
        let rejectedCount = 0;
        let likelySold = 0;
        let sentToBatch = 0;

        for (const zip of uniqueZips) {
            const props = await base44.asServiceRole.entities.MasterProperty.filter({ 
                zip_code: zip,
                original_status: 'RECENT_OFF_MARKET',
                sale_confidence: 'low'
            }, null, 5000);
            
            const pArr = Array.isArray(props) ? props : (props?.items || []);
            
            for (const p of pArr) {
                if (!p.sold_date) continue;
                
                const removed = new Date(p.sold_date); // In Phase 2, removedDate is mapped to sold_date
                const daysSinceRemoved = Math.round((new Date().getTime() - removed.getTime()) / (1000 * 3600 * 24));
                
                let origStatus = 'RECENT_OFF_MARKET';
                let confidence = 'low';
                
                if (daysSinceRemoved > 90) {
                    origStatus = 'REJECTED';
                    confidence = 'REJECTED';
                    rejectedCount++;
                } else {
                    // Approximate heuristic based strictly on days
                    const dom = p.days_on_market || daysSinceRemoved;
                    let hScore = 0;
                    
                    if (Math.abs(dom - 90) <= 3) hScore -= 3;
                    if (Math.abs(dom - 180) <= 3) hScore -= 3;
                    if (dom > 150) hScore -= 3;
                    else if (dom > 60) hScore -= 2;
                    if (dom < 7) hScore -= 2;
                    
                    if (dom >= 30 && dom <= 45) hScore += 3;
                    if (dom >= 14 && dom < 30) hScore += 2;
                    
                    if (hScore <= -4) {
                        origStatus = 'REJECTED';
                        confidence = 'REJECTED';
                        rejectedCount++;
                    } else if (hScore >= 3) {
                        origStatus = 'HEURISTIC_SOLD';
                        confidence = 'medium';
                        likelySold++;
                    } else {
                        // Queue to BatchData
                        sentToBatch++;
                        await base44.asServiceRole.entities.ValidationQueue.create({
                            address_hash: p.address_hash,
                            normalized_address: `${p.house_number} ${p.street_name}, ${p.city}, ${p.state} ${p.zip_code}`,
                            status: 'pending',
                            provider_id: 'batchdata'
                        }).catch(() => {});
                    }
                }
                
                if (origStatus !== 'RECENT_OFF_MARKET' || confidence !== 'low') {
                    await base44.asServiceRole.entities.MasterProperty.update(p.id, {
                        original_status: origStatus,
                        sale_confidence: confidence
                    });
                    cleanCount++;
                }
            }
        }

        return new Response(JSON.stringify({ 
            success: true, 
            message: `Cleaned route`,
            stats: { totalUpdated: cleanCount, rejected: rejectedCount, likelySold, sentToBatchData: sentToBatch }
        }), { status: 200 });

    } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
};
