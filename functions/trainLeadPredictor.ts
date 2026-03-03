import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Fetch logs
        const logs = await base44.asServiceRole.entities.InteractionLog.list('-created_date', 10000);
        
        // Fetch properties
        const properties = await base44.asServiceRole.entities.MasterProperty.list('-created_date', 10000);
        
        const propMap = {};
        properties.forEach(p => propMap[p.address_hash || p.id] = p);

        let totalLogs = 0;
        let successLogs = 0;
        
        // Features
        let ageSuccess = 0, ageTotal = 0;
        let priceSuccess = 0, priceTotal = 0;
        let singleFamilySuccess = 0, singleFamilyTotal = 0;
        let recentSaleSuccess = 0, recentSaleTotal = 0;

        logs.forEach(log => {
            const prop = propMap[log.address_hash];
            if (!prop) return;

            totalLogs++;
            const isSuccess = log.parsed_status === 'QUALIFIED' || log.parsed_status === 'SOLD';
            if (isSuccess) successLogs++;

            // Age feature (e.g., > 10 years)
            if (prop.year_built) {
                const age = new Date().getFullYear() - prop.year_built;
                ageTotal++;
                if (isSuccess && age > 10) ageSuccess++;
            }

            // Price feature (e.g., > 300k)
            if (prop.price) {
                priceTotal++;
                if (isSuccess && prop.price > 300000) priceSuccess++;
            }

            // Property type
            if (prop.property_type) {
                const type = prop.property_type.toLowerCase();
                if (type.includes('single')) {
                    singleFamilyTotal++;
                    if (isSuccess) singleFamilySuccess++;
                }
            }

            // Recent sale (e.g., sold in last 3 years)
            if (prop.sold_date) {
                const yearsOwned = (new Date() - new Date(prop.sold_date)) / (1000 * 60 * 60 * 24 * 365);
                recentSaleTotal++;
                if (isSuccess && yearsOwned <= 3) recentSaleSuccess++;
            }
        });

        const baseConversionRate = totalLogs > 0 ? successLogs / totalLogs : 0.05;

        // Calculate weights (ratio of feature success rate to base conversion rate)
        const calcWeight = (success, total) => {
            if (total < 10) return 1.0; // Not enough data, neutral weight
            const rate = success / total;
            return rate / (baseConversionRate || 0.01);
        };

        const weights = {
            age_gt_10_weight: calcWeight(ageSuccess, ageTotal),
            price_gt_300k_weight: calcWeight(priceSuccess, priceTotal),
            single_family_weight: calcWeight(singleFamilySuccess, singleFamilyTotal),
            recent_sale_weight: calcWeight(recentSaleSuccess, recentSaleTotal),
            base_conversion_rate: baseConversionRate
        };

        // Save to LeadScoringWeights
        const existingWeights = await base44.asServiceRole.entities.LeadScoringWeights.list();
        if (existingWeights.length > 0) {
            await base44.asServiceRole.entities.LeadScoringWeights.update(existingWeights[0].id, {
                weights,
                last_trained: new Date().toISOString(),
                accuracy: baseConversionRate
            });
        } else {
            await base44.asServiceRole.entities.LeadScoringWeights.create({
                weights,
                last_trained: new Date().toISOString(),
                accuracy: baseConversionRate
            });
        }

        return Response.json({ success: true, weights, logsAnalyzed: totalLogs });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});