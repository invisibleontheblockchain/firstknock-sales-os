import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { loadAuthorizedTeamRoster, TeamRosterError } from '../../shared/teamRosterAuthorization.js';

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') throw new TeamRosterError(405, 'Method not allowed');
        return Response.json(await loadAuthorizedTeamRoster(createClientFromRequest(req)));
    } catch (error) {
        const status = error instanceof TeamRosterError ? error.status : 500;
        if (status === 500) console.error('Team roster load failed:', error);
        return Response.json({ error: status === 500 ? 'Unable to load the team roster. Please retry.' : error.message }, { status });
    }
});
