import { createClientFromRequest } from 'npm:@base44/sdk@0.8.53';
import { Client } from 'npm:@neondatabase/serverless@0.9.0';
import { TimeClockError, timeClockRange, shiftOverlaps, shiftMilliseconds, clockDateRangeInZone, zonedClockDate, DEFAULT_CLOCK_TIMEZONE, validateClockTimezone } from '../../shared/timeClock.js';

const normalized = value => String(value || '').trim().toLowerCase();
const asArray = value => Array.isArray(value) ? value : value?.items || [];
const isManager = user => user?.is_owner === true || user?.data?.is_owner === true
    || ['manager', 'admin'].includes(normalized(user?.app_role || user?.data?.app_role))
    || ['manager', 'admin'].includes(normalized(user?.role || user?.data?.role));
const activeRep = member => normalized(member.status || 'active') === 'active' && normalized(member.role || 'rep') === 'rep';
const changed = result => result?.success === true && Number(result.updated) === 1 && result.has_more !== true;
const validRequest = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(id);
const reasonFor = body => {
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000) throw new TimeClockError(400, 'Enter a reason of up to 1,000 characters.');
    return body.reason.trim();
};
const correctedTimes = body => {
    const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
    if (!valid(body.start_at) || !valid(body.end_at) || Date.parse(body.end_at) <= Date.parse(body.start_at)) throw new TimeClockError(400, 'Finish must be after the start.');
    if (Date.parse(body.end_at) > Date.now() + 60000) throw new TimeClockError(400, 'Recorded times cannot be in the future.');
    return { clock_in_at: new Date(body.start_at).toISOString(), clock_out_at: new Date(body.end_at).toISOString() };
};

async function allPages(entity, query, sort = '-clock_in_at') {
    const result = [];
    for (let page = 0; page < 100; page++) {
        const rows = asArray(await entity.filter(query, sort, 500, page * 500));
        result.push(...rows);
        if (rows.length < 500) return result;
    }
    throw new TimeClockError(503, 'Too many time records. Choose a shorter date range.');
}

async function clearPointer(service, memberId, shiftId) {
    if (!memberId || memberId.startsWith('manager:')) return;
    await service.TeamMember.updateMany({ id: memberId, time_clock_active_shift_id: shiftId }, { $set: { time_clock_active_shift_id: '' } });
}

// Preserve and recover durable claims from the first release.
async function recoverShift(service, shift) {
    if (!shift || shift.status !== 'pending') return shift;
    const owner = await service.TeamMember.get(shift.member_id).catch(error => {
        if (error?.status === 404) return null;
        throw error;
    });
    if (owner?.user_id !== shift.rep_user_id || owner?.manager_id !== shift.manager_id || owner?.time_clock_active_shift_id !== shift.id) return null;
    await service.TimeShift.updateMany({ id: shift.id, status: 'pending' }, { $set: { status: 'active' } });
    return service.TimeShift.get(shift.id);
}

// All attendance writes for an account share this lock across teams, devices and roles.
// This uses the existing database only for transaction locks; attendance remains in Base44.
async function withAccountLock(userId, action) {
    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) throw new TimeClockError(503, 'Time clock saving is temporarily unavailable. Refresh and retry.');
    const client = new Client(databaseUrl);
    await client.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`time-clock:${userId}`]);
        const result = await action();
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error?.code === '55P03') throw new TimeClockError(409, 'Another clock action is saving. Refresh and retry.');
        throw error;
    } finally { await client.end(); }
}

async function accountShifts(service, userId) {
    const rows = await allPages(service.TimeShift, { rep_user_id: userId });
    const result = [];
    for (const row of rows.filter(row => row.rep_user_id === userId)) {
        const saved = await recoverShift(service, row);
        if (saved) result.push(saved);
    }
    return result;
}

function assertNoOverlap(rows, times, excludedId = null) {
    const start = Date.parse(times.clock_in_at), end = Date.parse(times.clock_out_at);
    if (rows.some(row => row.id !== excludedId && Date.parse(row.clock_in_at) < end
        && (row.status === 'active' ? Infinity : Date.parse(row.clock_out_at)) > start)) {
        throw new TimeClockError(409, 'These times overlap another shift for this person.');
    }
}

Deno.serve(async req => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') throw new TimeClockError(405, 'Method not allowed.');
        const base44 = createClientFromRequest(req);
        const identity = await base44.auth.me();
        if (!identity?.id) throw new TimeClockError(401, 'Sign in to use the time clock.');
        const service = base44.asServiceRole.entities;
        const user = await service.User.get(identity.id);
        if (!user || user.id !== identity.id) throw new TimeClockError(401, 'Account could not be verified.');
        let body;
        try { body = await req.json(); } catch { throw new TimeClockError(400, 'Invalid request.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TimeClockError(400, 'Invalid request.');
        const action = body.action || 'report';
        if (!['report', 'status', 'clock_in', 'clock_out', 'close_shift', 'edit_shift', 'add_shift', 'request_correction', 'set_timezone', 'check_saving'].includes(action)) throw new TimeClockError(400, 'Unknown time clock action.');
        const managesTeam = isManager(user);
        const managerId = managesTeam ? user.id : (user.team_manager_id || user.data?.team_manager_id);
        if (!managerId || (!managesTeam && normalized(user.app_role || user.data?.app_role) !== 'rep')) throw new TimeClockError(403, 'Join a team to use the time clock.');
        const manager = managesTeam ? user : await service.User.get(managerId);
        if (!manager || manager.id !== managerId || !isManager(manager)) throw new TimeClockError(403, 'Team manager could not be verified.');
        const members = (await allPages(service.TeamMember, { manager_id: managerId }, '-created_date')).filter(member => member.manager_id === managerId);
        const ownMatches = members.filter(member => member.user_id === user.id && activeRep(member)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const ownMember = ownMatches.find(member => member.id === (user.team_member_id || user.data?.team_member_id)) || ownMatches[0];
        if (!managesTeam && !ownMember) throw new TimeClockError(403, 'An active team membership is required.');
        const scope = { manager_id: managerId, ...(!managesTeam ? { rep_user_id: user.id } : {}) };
        const inScope = shift => shift?.manager_id === managerId && (managesTeam || shift.rep_user_id === user.id);
        const timezone = validateClockTimezone(manager.time_clock_timezone || manager.data?.time_clock_timezone || DEFAULT_CLOCK_TIMEZONE);
        const now = new Date().toISOString();
        const personName = user.full_name || user.email || 'Manager';

        if (action === 'check_saving') {
            if (!managesTeam) throw new TimeClockError(403, 'Only managers can run saving diagnostics.');
            return await withAccountLock(user.id, () => Response.json({ success: true }));
        }

        if (action === 'set_timezone') {
            if (!managesTeam) throw new TimeClockError(403, 'Only managers can change the reporting timezone.');
            await service.User.update(managerId, { time_clock_timezone: validateClockTimezone(body.timezone) });
            return Response.json({ success: true, timezone: body.timezone });
        }
        if (action === 'report' || action === 'status') {
            const today = zonedClockDate(Date.now(), timezone);
            const todayRange = clockDateRangeInZone(today, today, timezone);
            const range = action === 'status' ? todayRange : body.start_date || body.end_date ? clockDateRangeInZone(body.start_date, body.end_date, timezone) : timeClockRange(body.start_at, body.end_at);
            const records = action === 'status' ? [] : await allPages(service.TimeShift, { ...scope, clock_in_at: { $lt: new Date(range.end).toISOString() },
                $or: [{ status: { $in: ['active', 'pending'] } }, { clock_out_at: { $gte: new Date(range.start).toISOString() } }] });
            const shifts = [];
            for (const row of records.filter(inScope)) {
                const shift = await recoverShift(service, row);
                if (shift && shiftOverlaps(shift, range)) shifts.push(shift);
            }
            const activeRows = await allPages(service.TimeShift, { ...scope, status: { $in: ['pending', 'active'] } });
            const activeShifts = [];
            for (const row of activeRows.filter(inScope)) {
                const shift = await recoverShift(service, row);
                if (shift?.status === 'active') activeShifts.push(shift);
            }
            const ownRows = await accountShifts(service, user.id);
            const current = ownRows.find(row => row.status === 'active');
            const todayMs = ownRows.filter(row => row.status === 'closed').reduce((sum, row) => sum + shiftMilliseconds(row, Date.now(), todayRange), 0);
            const people = new Map();
            if (managesTeam) {
                people.set(managerId, { id: managerId, name: personName, member_id: `manager:${managerId}`, invite_code: '', can_add: true });
                for (const member of members.filter(member => member.user_id)) people.set(member.user_id, {
                    id: member.user_id, name: member.name || member.email || 'Team member', member_id: member.id, invite_code: member.invite_code || '', can_add: true,
                });
            } else people.set(user.id, { id: user.id, name: ownMember.name || user.email || 'You' });
            for (const shift of [...shifts, ...activeShifts]) if (!people.has(shift.rep_user_id)) people.set(shift.rep_user_id, {
                id: shift.rep_user_id, name: shift.rep_name || shift.rep_email || 'Team member', member_id: shift.member_id, invite_code: shift.invite_code || '', can_add: false,
            });
            return Response.json({ success: true, manager_id: managerId, shifts, active_shifts: activeShifts,
                current_shift: current || null, can_clock: true, completed_today_ms: todayMs, people: [...people.values()], timezone,
                range: { ...range, start_at: new Date(range.start).toISOString(), end_at: new Date(range.end).toISOString() }, server_time: new Date().toISOString() });
        }

        const managerAction = ['close_shift', 'edit_shift', 'add_shift'].includes(action);
        if (managerAction && !managesTeam) throw new TimeClockError(403, 'Only managers can change recorded team times.');
        if (['clock_in', 'add_shift', 'edit_shift', 'close_shift', 'request_correction'].includes(action) && !validRequest(body.request_id)) throw new TimeClockError(400, 'A valid save request is required.');
        let initialShift = null;
        let targetId = user.id;
        let targetMember = ownMember;
        if (action === 'add_shift') {
            targetId = body.person_id;
            targetMember = members.find(row => row.user_id === targetId);
            if (targetId !== managerId && !targetMember) throw new TimeClockError(403, 'Choose a member of your team.');
        } else if (action !== 'clock_in') {
            if (typeof body.shift_id !== 'string' || !body.shift_id || body.shift_id.length > 100) throw new TimeClockError(400, 'Choose a shift.');
            initialShift = await service.TimeShift.get(body.shift_id);
            const ownClockOut = action === 'clock_out' && initialShift?.rep_user_id === user.id;
            if ((!ownClockOut && !inScope(initialShift)) || (['clock_out', 'request_correction'].includes(action) && initialShift.rep_user_id !== user.id)) throw new TimeClockError(403, 'This shift is outside your permissions.');
            targetId = initialShift.rep_user_id;
        }

        return await withAccountLock(targetId, async () => {
            const rows = await accountShifts(service, targetId);
            if (action === 'clock_in') {
                const retry = rows.find(row => row.manager_id === managerId && row.request_id === body.request_id);
                if (retry) return Response.json({ success: true, shift: retry, server_time: now });
                if (rows.some(row => row.status === 'active')) throw new TimeClockError(409, 'You are already clocked in. Refresh to see your current shift.');
                const shift = await service.TimeShift.create({ manager_id: managerId, member_id: ownMember?.id || `manager:${user.id}`,
                    rep_user_id: user.id, rep_name: ownMember?.name || personName, rep_email: user.email || '', invite_code: ownMember?.invite_code || '',
                    request_id: body.request_id, revision: 0, status: ownMember ? 'pending' : 'active', clock_in_at: new Date().toISOString() });
                if (ownMember) {
                    // Retain the existing durable membership claim for backwards-compatible recovery.
                    if (ownMember.time_clock_active_shift_id) {
                        const previous = await service.TimeShift.get(ownMember.time_clock_active_shift_id);
                        if (previous?.status === 'closed') await clearPointer(service, ownMember.id, previous.id);
                    }
                    const result = await service.TeamMember.updateMany({ id: ownMember.id, user_id: user.id, manager_id: managerId,
                        role: ownMember.role ?? null, status: ownMember.status ?? null,
                        $or: [{ time_clock_active_shift_id: '' }, { time_clock_active_shift_id: null }, { time_clock_active_shift_id: { $exists: false } }] },
                        { $set: { time_clock_active_shift_id: shift.id } });
                    if (!changed(result)) throw new TimeClockError(409, 'Your time clock changed. Refresh before trying again.');
                }
                const saved = await recoverShift(service, shift);
                if (!saved) throw new TimeClockError(503, 'Clock-in could not be verified. Refresh before trying again.');
                return Response.json({ success: true, shift: saved, server_time: new Date().toISOString() });
            }

            if (action === 'add_shift') {
                const retry = rows.find(row => row.manager_id === managerId && row.request_id === body.request_id);
                if (retry) return Response.json({ success: true, shift: retry });
                const times = correctedTimes(body), reason = reasonFor(body);
                assertNoOverlap(rows, times);
                const target = await service.User.get(targetId);
                if (!target?.id || target.id !== targetId) throw new TimeClockError(400, 'This person does not have a linked account.');
                const shift = await service.TimeShift.create({ manager_id: managerId, member_id: targetMember?.id || `manager:${managerId}`,
                    rep_user_id: targetId, rep_name: targetMember?.name || target.full_name || target.email || 'Manager', rep_email: target.email || '',
                    invite_code: targetMember?.invite_code || '', request_id: body.request_id, status: 'closed', ...times, closed_by: user.id,
                    revision: 1, adjusted: true, audit_trail: [{ request_id: body.request_id, action, actor_id: user.id, actor_name: personName, at: now, reason,
                        before_start: '', before_end: '', after_start: times.clock_in_at, after_end: times.clock_out_at }] });
                return Response.json({ success: true, shift });
            }

            let shift = await service.TimeShift.get(initialShift.id);
            if ((!(action === 'clock_out' && shift?.rep_user_id === user.id) && !inScope(shift)) || shift.rep_user_id !== targetId) throw new TimeClockError(403, 'This shift is outside your permissions.');
            shift = await recoverShift(service, shift);
            if (!shift) throw new TimeClockError(409, 'This shift was not clocked in. Refresh before trying again.');
            if (action === 'clock_out') {
                if (shift.status !== 'closed') {
                    const finish = new Date().toISOString();
                    if (Date.parse(finish) <= Date.parse(shift.clock_in_at)) throw new TimeClockError(409, 'Refresh before ending this shift.');
                    await service.TimeShift.updateMany({ id: shift.id, status: 'active' }, { $set: {
                        status: 'closed', clock_out_at: finish, closed_by: user.id, revision: (shift.revision || 0) + 1,
                    } });
                    shift = await service.TimeShift.get(shift.id);
                    if (shift.status !== 'closed') throw new TimeClockError(409, 'The shift changed. Refresh before trying again.');
                }
                await clearPointer(service, shift.member_id, shift.id);
                return Response.json({ success: true, shift, server_time: new Date().toISOString() });
            }

            const existing = [...(shift.audit_trail || []), ...(shift.correction_requests || [])].find(item => item.request_id === body.request_id);
            if (existing) return Response.json({ success: true, shift });
            if (!Number.isInteger(body.revision) || body.revision !== (shift.revision || 0)) throw new TimeClockError(409, 'This shift changed. Refresh before editing.');
            const times = correctedTimes(body), reason = reasonFor(body);
            const update = { revision: (shift.revision || 0) + 1 };
            if (action === 'request_correction') {
                const requests = shift.correction_requests || [];
                if (requests.length >= 100) throw new TimeClockError(400, 'This shift has too many correction requests.');
                Object.assign(update, { correction_requests: [...requests, { request_id: body.request_id, actor_id: user.id, at: now, reason,
                    start_at: times.clock_in_at, end_at: times.clock_out_at, status: 'pending' }] });
            } else {
                if (action === 'close_shift' && shift.status !== 'active') throw new TimeClockError(409, 'This shift is already closed.');
                assertNoOverlap(rows, times, shift.id);
                const audit = shift.audit_trail || [];
                if (audit.length >= 100) throw new TimeClockError(400, 'This shift has too many adjustments.');
                Object.assign(update, times, { status: 'closed', closed_by: shift.status === 'active' ? user.id : shift.closed_by, adjusted: true,
                    audit_trail: [...audit, { request_id: body.request_id, action, actor_id: user.id, actor_name: personName, at: now, reason,
                        before_start: shift.clock_in_at, before_end: shift.clock_out_at || '', after_start: times.clock_in_at, after_end: times.clock_out_at }],
                    correction_requests: (shift.correction_requests || []).map(request => request.status === 'pending'
                        ? { ...request, status: 'resolved', resolved_at: now, resolved_by: user.id } : request) });
            }
            const result = await service.TimeShift.updateMany({ id: shift.id, status: shift.status, clock_in_at: shift.clock_in_at,
                $or: [{ revision: shift.revision || 0 }, { revision: { $exists: false } }] }, { $set: update });
            if (!changed(result)) throw new TimeClockError(409, 'This shift changed. Refresh before editing.');
            const saved = await service.TimeShift.get(shift.id);
            if (action !== 'request_correction') await clearPointer(service, saved.member_id, saved.id);
            return Response.json({ success: true, shift: saved, server_time: new Date().toISOString() });
        });
    } catch (error) {
        const status = error instanceof TimeClockError ? error.status : 500;
        if (status === 500) console.error('Time clock failed:', error?.message);
        return Response.json({ error: status === 500 ? 'Unable to save the time clock. Refresh to check your status, then retry.' : error.message }, { status });
    }
});
