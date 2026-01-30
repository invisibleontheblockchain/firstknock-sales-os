import { createClientFromRequest } from 'npm:@base44/sdk@0.8.3';

export default async function(req) {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Fetch logs - Server side fetching is faster and we can cache if needed
        // We'll fetch more history here since it's backend
        const logs = await base44.entities.InteractionLog.list('-created_date', 5000);
        const items = Array.isArray(logs) ? logs : (logs?.items || []);

        const metrics = {};
        const teamTotals = { doorsKnocked: 0, talkedTo: 0, sales: 0 };

        items.forEach(log => {
            const email = log.created_by;
            if (!metrics[email]) {
                metrics[email] = { doorsKnocked: 0, talkedTo: 0, sales: 0 };
            }

            metrics[email].doorsKnocked++;
            teamTotals.doorsKnocked++;
            
            if (log.parsed_status !== 'NO_ANSWER' && log.parsed_status !== 'ELIGIBLE') {
                metrics[email].talkedTo++;
                teamTotals.talkedTo++;
            }

            if (log.parsed_status === 'SOLD' || log.parsed_status === 'QUALIFIED') {
                metrics[email].sales++;
                teamTotals.sales++;
            }
        });

        return Response.json({
            metricsByRep: metrics,
            teamTotals: teamTotals,
            period: 'all_time' // or based on limit
        });

    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
}