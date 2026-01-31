import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // 1. Authenticate
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // 2. Parse payload
        const { question } = await req.json();

        if (!question) {
            return Response.json({ error: 'Question is required' }, { status: 400 });
        }

        // 3. Invoke LLM with platform context
        // We provide context about the app features so it can answer effectively.
        const systemContext = `
You are the AI Assistant for "FirstKnock", a door-to-door territory management and route optimization platform.
Your goal is to help users (Sales Reps and Managers) understand how to use the platform.

PLATFORM FEATURES:
1. **Command Center (Map Page)**:
   - "Analyze Mode": View existing routes, filter by rep, see heatmaps of sales activity.
   - "Build Mode": Generate new optimized walking routes.
   - Filters: Filter properties by status (Not Visited, Sold, etc.), Score (0-200), and Rep.
   - Routing: Uses K-Means clustering and genetic algorithms to create efficient walking paths.

2. **Routes**:
   - Routes are collections of properties optimized for walking.
   - "Checklist Mode": A sequential list of houses to knock.
   - "Navigation": Integration with Apple/Google Maps.
   - Statuses: ELIGIBLE (Gray), SOLD (Green), HARD_NO (Purple), CALLBACK (Yellow).

3. **Team Management (Admin Only)**:
   - Add/Invite new reps.
   - Assign routes to specific reps.
   - View Analytics: Close rates, doors knocked, sales count.
   - "Rep Score": Based on close rate percentage.

4. **Data & Setup**:
   - Upload CSV files with property data.
   - Filter territories by Zip Code.
   - "Dark Room": Advanced predictive analytics feature (if enabled).

5. **General**:
   - Offline Mode: Works without internet (syncs when back online).
   - GPS Verification: Logs location when a result is submitted.

USER QUESTION: "${question}"

Provide a clear, helpful, and concise answer. If the user asks how to do something, provide step-by-step instructions.
`;

        const response = await base44.integrations.Core.InvokeLLM({
            prompt: systemContext,
            add_context_from_internet: false
        });

        return Response.json({ answer: response });

    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});