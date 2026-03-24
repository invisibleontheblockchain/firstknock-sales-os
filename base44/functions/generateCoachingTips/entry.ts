import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const { repEmail, repName } = await req.json();

        // 1. Fetch Rep's Logs
        const logs = await base44.entities.InteractionLog.filter({ created_by: repEmail }, '-created_date', 100);
        
        if (!logs || logs.length === 0) {
             return Response.json({ tips: ["No data available yet to generate tips. Start knocking!"] });
        }

        // 2. Calculate Stats
        const total = logs.length;
        const sales = logs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status)).length;
        const hardNos = logs.filter(l => l.parsed_status === 'HARD_NO').length;
        const conversionRate = (sales / total * 100).toFixed(1);

        // 3. Generate Prompt
        const prompt = `
            Analyze the performance of a door-to-door sales rep named ${repName}.
            Data:
            - Total Knocks: ${total}
            - Sales/Leads: ${sales}
            - Hard Nos: ${hardNos}
            - Conversion Rate: ${conversionRate}%
            - Recent Outcomes: ${logs.slice(0, 10).map(l => l.parsed_status).join(', ')}

            Provide 3 specific, actionable, and encouraging coaching tips to improve their performance. 
            Focus on ${conversionRate < 5 ? 'closing techniques' : 'upselling and efficiency'}.
            Keep it brief and punchy.
        `;

        // 4. Call LLM
        const aiRes = await base44.integrations.Core.InvokeLLM({
            prompt: prompt,
            response_json_schema: {
                type: "object",
                properties: {
                    tips: { type: "array", items: { type: "string" } }
                }
            }
        });

        return Response.json(aiRes);

    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});