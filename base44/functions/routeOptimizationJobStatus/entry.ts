// The app's view of background road searches: status, passes, checks and
// miles saved for the routes the signed-in user manages or is assigned. The
// job records themselves stay service-only (they can hold a private anchor).

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { publicJobStatus } from '../../shared/routeOptimizationJobs.js';

const rows = (value) => Array.isArray(value) ? value : value?.items || [];
const RECENT_MS = 15 * 60 * 1000;

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
        const service = base44.asServiceRole;
        // Jobs in this user's workspace, or on routes assigned to them.
        const managerId = String(user.team_manager_id || user.data?.team_manager_id || user.id);
        const jobs = rows(await service.entities.RouteOptimizationJob.filter({ manager_id: managerId }, '-created_date', 50));
        const visible = [];
        for (const job of jobs) {
            const recent = !job.finished_at || Date.now() - Date.parse(job.finished_at) < RECENT_MS;
            if (!recent) continue;
            if (managerId !== String(user.id)) {
                // A rep sees only routes assigned to them.
                const route = job.route_id ? await service.entities.SavedRoute.get(job.route_id).catch(() => null) : null;
                const members = route?.assigned_to ? rows(await service.entities.TeamMember.filter({ id: route.assigned_to }, '-created_date', 1)) : [];
                if (!route || (route.assigned_to !== user.id && members[0]?.user_id !== user.id)) continue;
            }
            visible.push(publicJobStatus(job));
        }
        return Response.json({ jobs: visible });
    } catch (error) {
        console.error('[routeOptimizationJobStatus]', error);
        return Response.json({ error: 'Could not read background route optimization.' }, { status: 500 });
    }
});
