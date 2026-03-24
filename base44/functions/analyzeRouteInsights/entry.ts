import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Fetch completed routes
        const routes = await base44.entities.SavedRoute.filter({ status: 'COMPLETED' }, '-updated_date', 20);
        
        if (!routes || routes.length === 0) {
            return Response.json({ 
                bestTime: "Late Afternoon (4pm - 7pm)",
                insights: ["Not enough completed route data yet to analyze specific patterns."]
            });
        }

        // Fetch logs associated with these routes? 
        // For simplicity, we'll analyze the route metadata and mock some log correlation or assume route score reflects success.
        
        const prompt = `
            Analyze these completed door-to-door sales routes to find patterns for success.
            Routes Data: ${JSON.stringify(routes.map(r => ({
                name: r.name,
                houses: r.metrics?.house_count,
                score: r.metrics?.score, // Competitiveness score
                rep: r.assigned_to_name
            })))}

            1. Identify the characteristics of the most successful routes.
            2. Suggest the best time of day to knock (infer from typical sales hours).
            3. Recommend one strategy adjustment.

            Output JSON.
        `;

        const aiRes = await base44.integrations.Core.InvokeLLM({
            prompt: prompt,
            response_json_schema: {
                type: "object",
                properties: {
                    bestTime: { type: "string" },
                    successPatterns: { type: "array", items: { type: "string" } },
                    recommendation: { type: "string" }
                }
            }
        });

        return Response.json(aiRes);

    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});