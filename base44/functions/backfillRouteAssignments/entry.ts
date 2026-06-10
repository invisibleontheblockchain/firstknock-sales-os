import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// One-time backfill (admin-only, idempotent, resumable):
// 1. Normalize TeamMember emails to lowercase + link user_id from auth users
// 2. Resolve name-only SavedRoute assignments to TeamMember IDs
// 3. Set SavedRoute.manager_id tenant key where missing
// 4. Set InteractionLog.manager_id tenant key where missing
// Writes are throttled + capped per invocation; re-run until has_more=false.
Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const { dry_run = true, max_writes = 100 } = await req.json().catch(() => ({}));
        const svc = base44.asServiceRole;
        const toArr = (r) => Array.isArray(r) ? r : r?.items || [];

        // Throttled writer with retry/backoff: avoids API rate limits;
        // caps writes per invocation (re-run until has_more=false)
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const withRetry = async (fn, attempts = 4) => {
            for (let i = 0; i < attempts; i++) {
                try {
                    return await fn();
                } catch (e) {
                    const isRate = /rate limit/i.test(e?.message || '');
                    if (!isRate || i === attempts - 1) throw e;
                    await sleep(2000 * (i + 1));
                }
            }
        };
        let writes = 0;
        let capReached = false;
        const write = async (fn) => {
            if (dry_run) return true;
            if (writes >= max_writes) { capReached = true; return false; }
            await withRetry(fn);
            writes++;
            await sleep(300);
            return true;
        };

        const report = {
            dry_run,
            members_normalized: 0,
            members_user_id_linked: 0,
            routes_resolved: 0,
            routes_unresolved: [],
            route_manager_ids_set: 0,
            log_manager_ids_set: 0,
            appointment_manager_ids_set: 0
        };

        const members = toArr(await withRetry(() => svc.entities.TeamMember.list('-created_date', 2000)));
        const users = toArr(await withRetry(() => svc.entities.User.list('-created_date', 2000)));
        const routes = toArr(await withRetry(() => svc.entities.SavedRoute.list('-created_date', 2000)));

        const usersByEmail = new Map(users.map((u) => [u.email?.trim().toLowerCase(), u]));
        const managerIdSet = new Set(users.filter((u) => u.app_role === 'manager' || u.role === 'admin').map((u) => u.id));

        // --- 1. Normalize TeamMember emails + link user_id ---
        for (const m of members) {
            if (capReached) break;
            const updates = {};
            const emailLower = m.email?.trim().toLowerCase();
            if (m.email && m.email !== emailLower) {
                updates.email = emailLower;
                report.members_normalized++;
            }
            if (!m.user_id && emailLower && usersByEmail.has(emailLower)) {
                updates.user_id = usersByEmail.get(emailLower).id;
                report.members_user_id_linked++;
            }
            if (Object.keys(updates).length > 0) {
                await write(() => svc.entities.TeamMember.update(m.id, updates));
            }
        }

        const memberById = new Map(members.map((m) => [m.id, m]));
        const membersByEmail = new Map();
        for (const m of members) {
            const e = m.email?.trim().toLowerCase();
            if (e && !membersByEmail.has(e)) membersByEmail.set(e, m);
        }

        const resolveManagerId = (creatorEmail) => {
            const email = creatorEmail?.trim().toLowerCase();
            if (!email) return null;
            const u = usersByEmail.get(email);
            if (u && managerIdSet.has(u.id)) return u.id;
            if (u?.team_manager_id) return u.team_manager_id;
            const m = membersByEmail.get(email);
            return m?.manager_id || null;
        };

        // --- 2 & 3. SavedRoute: resolve name-only assignments + set manager_id ---
        for (const r of routes) {
            if (capReached) break;

            // Resolve assigned_to that isn't a valid TeamMember ID via assigned_to_name
            if (r.assigned_to_name && (!r.assigned_to || !memberById.has(r.assigned_to))) {
                const nameLower = r.assigned_to_name.trim().toLowerCase();
                const match = members.find((m) => (m.name || '').trim().toLowerCase() === nameLower);
                if (match) {
                    report.routes_resolved++;
                    await write(() => svc.entities.SavedRoute.update(r.id, { assigned_to: match.id, assigned_to_name: match.name }));
                } else {
                    report.routes_unresolved.push({ route_id: r.id, name: r.assigned_to_name });
                }
            }

            // Set manager_id tenant key where missing
            if (!r.manager_id) {
                const assignee = r.assigned_to ? memberById.get(r.assigned_to) : null;
                const managerId = assignee?.manager_id || resolveManagerId(r.created_by);
                if (managerId) {
                    report.route_manager_ids_set++;
                    await write(() => svc.entities.SavedRoute.update(r.id, { manager_id: managerId }));
                }
            }
        }

        // --- 4. Backfill InteractionLog.manager_id in batches ---
        const MAX_BATCHES = 20;
        for (let batch = 0; batch < MAX_BATCHES && !capReached; batch++) {
            const logs = toArr(await withRetry(() => svc.entities.InteractionLog.filter({ manager_id: null }, '-created_date', 200)));
            const missing = logs.filter((l) => !l.manager_id);
            if (missing.length === 0) break;
            let progressed = false;
            for (const log of missing) {
                if (capReached) break;
                const managerId = resolveManagerId(log.created_by);
                if (managerId) {
                    report.log_manager_ids_set++;
                    const ok = await write(() => svc.entities.InteractionLog.update(log.id, { manager_id: managerId }));
                    if (ok) progressed = true;
                }
            }
            if (dry_run) break; // dry-run can't progress past the first batch (nothing is written)
            if (!progressed) break; // no progress possible
        }

        // --- 5. Backfill Appointment.manager_id in batches ---
        for (let batch = 0; batch < MAX_BATCHES && !capReached; batch++) {
            const appts = toArr(await withRetry(() => svc.entities.Appointment.filter({ manager_id: null }, '-created_date', 200)));
            const missingAppts = appts.filter((a) => !a.manager_id);
            if (missingAppts.length === 0) break;
            let progressed = false;
            for (const appt of missingAppts) {
                if (capReached) break;
                const managerId = resolveManagerId(appt.created_by);
                if (managerId) {
                    report.appointment_manager_ids_set++;
                    const ok = await write(() => svc.entities.Appointment.update(appt.id, { manager_id: managerId }));
                    if (ok) progressed = true;
                }
            }
            if (dry_run) break;
            if (!progressed) break;
        }

        report.writes = writes;
        report.has_more = capReached;
        return Response.json(report);
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});