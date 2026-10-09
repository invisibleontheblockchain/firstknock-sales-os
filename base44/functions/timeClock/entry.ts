import { createClientFromRequest } from 'npm:@base44/sdk@0.8.53';
import { TimeClockError, timeClockRange, shiftOverlaps } from '../../shared/timeClock.js';

const normalized = value => String(value || '').trim().toLowerCase();
const asArray = value => Array.isArray(value) ? value : value?.items || [];
const isManager = user => user?.is_owner === true || user?.data?.is_owner === true
    || ['manager', 'admin'].includes(normalized(user?.app_role || user?.data?.app_role))
    || ['manager', 'admin'].includes(normalized(user?.role || user?.data?.role));
const activeRep = member => normalized(member.status || 'active') === 'active' && normalized(member.role || 'rep') === 'rep';
const changed = result => result?.success === true && Number(result.updated) === 1 && result.has_more !== true;

async function allPages(entity, query, sort = '-clock_in_at') {
    const result = [];
    for (let page = 0; page < 100; page++) {
        const rows = asArray(await entity.filter(query, sort, 500, page * 500));
        result.push(...rows);
        if (rows.length < 500) return result;
    }
    throw new TimeClockError(503, 'Too many time records. Choose a shorter date range.');
}

async function clearPointer(service, userId, shiftId) {
    await service.User.updateMany({ id: userId, time_clock_active_shift_id: shiftId },
        { $set: { time_clock_active_shift_id: '' } });
}

// A pending row becomes a real shift only after an atomic claim on the unique User row.
// Recover that claim if the request stopped before it could mark the shift active.
async function recoverShift(service, shift) {
    if (!shift || shift.status !== 'pending') return shift;
    const owner = await service.User.get(shift.rep_user_id);
    if (owner?.time_clock_active_shift_id !== shift.id) return null;
    await service.TimeShift.updateMany({ id: shift.id, status: 'pending' }, { $set: { status: 'active' } });
    return service.TimeShift.get(shift.id);
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
        if (!['report', 'clock_in', 'clock_out', 'close_shift'].includes(action)) throw new TimeClockError(400, 'Unknown time clock action.');
        const managesTeam = isManager(user);
        const managerId = managesTeam ? user.id : (user.team_manager_id || user.data?.team_manager_id);
        if (!managerId || (!managesTeam && normalized(user.app_role || user.data?.app_role) !== 'rep')) {
            throw new TimeClockError(403, 'Join a team to use the time clock.');
        }
        const manager = managesTeam ? user : await service.User.get(managerId);
        if (!manager || manager.id !== managerId || !isManager(manager)) throw new TimeClockError(403, 'Team manager could not be verified.');
        const members = (await allPages(service.TeamMember, { manager_id: managerId }, '-created_date'))
            .filter(member => member.manager_id === managerId);
        const ownMember = members.find(member => member.user_id === user.id && activeRep(member));
        if (!managesTeam && !ownMember) throw new TimeClockError(403, 'An active team membership is required.');
        const scope = { manager_id: managerId, ...(!managesTeam ? { rep_user_id: user.id } : {}) };
        const inScope = shift => shift?.manager_id === managerId && (managesTeam || shift.rep_user_id === user.id);
        const now = new Date().toISOString();
        let current = user.time_clock_active_shift_id ? await service.TimeShift.get(user.time_clock_active_shift_id) : null;
        if (current && current.rep_user_id !== user.id) throw new TimeClockError(409, 'Time clock identity could not be verified.');
        if (current?.status === 'closed') {
            await clearPointer(service, user.id, current.id);
            current = null;
        }
        if (current && current.manager_id !== managerId) {
            throw new TimeClockError(409, 'Your previous team has an open shift. Ask that manager to close it first.');
        }
        current = await recoverShift(service, current);

        if (action === 'report') {
            const range = timeClockRange(body.start_at, body.end_at);
            const records = await allPages(service.TimeShift, { ...scope, clock_in_at: { $lt: new Date(range.end).toISOString() },
                $or: [{ status: { $in: ['active', 'pending'] } }, { clock_out_at: { $gte: new Date(range.start).toISOString() } }] });
            const shifts = [];
            for (const row of records.filter(inScope)) {
                const shift = await recoverShift(service, row);
                if (shift && shiftOverlaps(shift, range)) shifts.push(shift);
            }
            // Active shifts are returned independently so the current status stays visible for past date ranges.
            const activeRows = await allPages(service.TimeShift, { ...scope, status: { $in: ['pending', 'active'] } });
            const activeShifts = [];
            for (const row of activeRows.filter(inScope)) {
                const shift = await recoverShift(service, row);
                if (shift?.status === 'active') activeShifts.push(shift);
            }
            return Response.json({ success: true, manager_id: managerId, shifts, active_shifts: activeShifts,
                current_shift: current, server_time: new Date().toISOString() });
        }

        if (action === 'clock_in') {
            if (typeof body.request_id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.request_id)) {
                throw new TimeClockError(400, 'A valid clock-in request is required.');
            }
            const retries = (await allPages(service.TimeShift, { manager_id: managerId, rep_user_id: user.id, request_id: body.request_id }))
                .filter(row => inScope(row) && row.rep_user_id === user.id && row.request_id === body.request_id);
            for (const row of retries) {
                const saved = await recoverShift(service, row);
                if (saved) return Response.json({ success: true, shift: saved, server_time: now });
            }
            if (current) throw new TimeClockError(409, 'You are already clocked in. Refresh to see your current shift.');
            const shift = await service.TimeShift.create({ manager_id: managerId, member_id: ownMember?.id || user.id,
                rep_user_id: user.id, rep_name: ownMember?.name || user.full_name || user.email || 'Team Manager',
                rep_email: user.email || '', invite_code: ownMember?.invite_code || '', request_id: body.request_id,
                status: 'pending', clock_in_at: now });
            // Never replace another device's claim. Empty and unset are both supported for existing users.
            const result = await service.User.updateMany({ id: user.id,
                $or: [{ time_clock_active_shift_id: '' }, { time_clock_active_shift_id: null }, { time_clock_active_shift_id: { $exists: false } }] },
                { $set: { time_clock_active_shift_id: shift.id } });
            if (!changed(result)) {
                // An unclaimed pending row is excluded from all reports.
                throw new TimeClockError(409, 'Your time clock changed on another device. Refresh before trying again.');
            }
            const saved = await recoverShift(service, shift);
            if (!saved) throw new TimeClockError(503, 'Clock-in could not be verified. Refresh before trying again.');
            return Response.json({ success: true, shift: saved, server_time: now });
        }

        if (action === 'close_shift' && !managesTeam) throw new TimeClockError(403, 'Only managers can close team shifts.');
        if (typeof body.shift_id !== 'string' || !body.shift_id || body.shift_id.length > 100) throw new TimeClockError(400, 'Choose a shift to clock out.');
        let shift = await service.TimeShift.get(body.shift_id);
        if (!inScope(shift) || (action === 'clock_out' && shift.rep_user_id !== user.id)) throw new TimeClockError(403, 'This shift is not yours to close.');
        if (shift.status !== 'closed') {
            shift = await recoverShift(service, shift);
            if (!shift) throw new TimeClockError(409, 'This shift was not clocked in. Refresh before trying again.');
            await service.TimeShift.updateMany({ id: shift.id, manager_id: managerId, rep_user_id: shift.rep_user_id, status: 'active' },
                { $set: { status: 'closed', clock_out_at: new Date().toISOString(), closed_by: user.id } });
            shift = await service.TimeShift.get(shift.id);
            if (shift.status !== 'closed') throw new TimeClockError(409, 'The shift changed. Refresh before trying again.');
        }
        // A delayed clock-out can never clear a newer shift's pointer.
        await clearPointer(service, shift.rep_user_id, shift.id);
        return Response.json({ success: true, shift, server_time: new Date().toISOString() });
    } catch (error) {
        const status = error instanceof TimeClockError ? error.status : 500;
        if (status === 500) console.error('Time clock failed:', error);
        return Response.json({ error: status === 500 ? 'Unable to save the time clock. Refresh to check your status, then retry.' : error.message }, { status });
    }
});
