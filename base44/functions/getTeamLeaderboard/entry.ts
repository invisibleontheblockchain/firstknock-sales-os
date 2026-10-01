import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { buildTeamRoster } from '../../shared/teamRoster.js';
import { buildTeamLeaderboard } from '../../shared/teamLeaderboard.js';

const asArray = (value) => Array.isArray(value) ? value : value?.items || [];

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({}));
        const period = ({ '7d': 'week', '30d': 'month' })[body.period] || body.period || 'today';
        if (!['today', 'week', 'month', 'all'].includes(period)) throw new HttpError(400, 'Choose a valid leaderboard period.');
        const timeZone = String(body.time_zone || 'UTC');
        try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date()); }
        catch { throw new HttpError(400, 'Choose a valid time zone.'); }

        // Reuse the roster endpoint's service-loaded account and active membership
        // checks. Caller-supplied team/user IDs never select the reporting scope.
        const roster = (await base44.functions.invoke('getTeamRoster', {})).data;
        if (!roster?.success || !roster.manager_id || roster.manager?.id !== roster.manager_id) {
            throw new HttpError(403, 'Your team could not be verified.');
        }
        const members = buildTeamRoster(roster.members, roster.manager);
        const now = new Date();
        const days = { today: 1, week: 7, month: 30 }[period];
        const query = {
            manager_id: roster.manager_id,
            created_date: {
                $lte: now.toISOString(),
                ...(days ? { $gte: new Date(now.getTime() - (days + 2) * 86400000).toISOString() } : {}),
            },
        };
        const logs = [];
        let complete = false;
        for (let page = 0; page < 100; page += 1) {
            const rows = asArray(await base44.asServiceRole.entities.InteractionLog.filter(query, '-created_date', 5000, page * 5000));
            logs.push(...rows.filter((log) => log.manager_id === roster.manager_id));
            if (rows.length < 5000) { complete = true; break; }
        }
        if (!complete) throw new HttpError(503, 'There is too much activity to rank. Choose a shorter period.');
        // Return only roster identity and performance totals, never raw interactions
        // containing addresses, customer details, GPS proofs, or private notes.
        return Response.json({
            success: true,
            manager_id: roster.manager_id,
            period,
            rows: buildTeamLeaderboard({ members, logs, period, timeZone, now }),
        });
    } catch (error) {
        const status = error instanceof HttpError ? error.status : (error?.response?.status === 401 || error?.response?.status === 403 ? error.response.status : 500);
        if (status === 500) console.error('Team leaderboard load failed:', error);
        return Response.json({ error: error instanceof HttpError ? error.message : 'Unable to load your team leaderboard. Please retry.' }, { status });
    }
});

