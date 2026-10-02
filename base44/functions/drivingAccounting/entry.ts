import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { DrivingError, drivingDate, tripMiles, tripPayment } from '../../shared/drivingAccounting.js';

const normalized = (value) => String(value || '').trim().toLowerCase();
const asArray = (value) => Array.isArray(value) ? value : value?.items || [];
const active = (member) => normalized(member.status || 'active') !== 'inactive';
function isManager(user) {
    return user?.is_owner === true || user?.data?.is_owner === true
        || ['manager', 'admin'].includes(normalized(user?.app_role || user?.data?.app_role))
        || ['manager', 'admin'].includes(normalized(user?.role || user?.data?.role));
}
async function allPages(entity, query, sort = '-created_date') {
    const result = [];
    for (let page = 0; page < 100; page += 1) {
        const rows = asArray(await entity.filter(query, sort, 500, page * 500));
        result.push(...rows);
        if (rows.length < 500) return result;
    }
    throw new DrivingError(503, 'Too many records. Choose a shorter date range.');
}
function text(value, label, max, required = true) {
    if (value !== undefined && typeof value !== 'string') throw new DrivingError(400, `${label} must be text.`);
    const result = (value || '').trim();
    if ((required && !result) || result.length > max) throw new DrivingError(400, `Enter ${label.toLowerCase()} (up to ${max} characters).`);
    return result;
}

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') throw new DrivingError(405, 'Method not allowed');
        const base44 = createClientFromRequest(req);
        const identity = await base44.auth.me();
        if (!identity?.id) throw new DrivingError(401, 'Sign in to view driving records.');
        const service = base44.asServiceRole.entities;
        const user = await service.User.get(identity.id);
        if (!user || user.id !== identity.id) throw new DrivingError(401, 'Account could not be verified.');
        const managesTeam = isManager(user);
        const managerId = managesTeam ? user.id : (user.team_manager_id || user.data?.team_manager_id);
        if (!managerId || (!managesTeam && normalized(user.app_role || user.data?.app_role) !== 'rep')) {
            throw new DrivingError(403, 'Join a team to record driving.');
        }
        const manager = managesTeam ? user : await service.User.get(managerId);
        if (!manager || manager.id !== managerId || !isManager(manager)) throw new DrivingError(403, 'Team manager could not be verified.');
        const members = (await allPages(service.TeamMember, { manager_id: managerId })).filter(m => m.manager_id === managerId);
        const ownMember = members.find(m => active(m) && m.user_id === user.id && normalized(m.role || 'rep') === 'rep');
        if (!managesTeam && !ownMember) throw new DrivingError(403, 'An active team membership is required.');
        const ownsTrip = (trip) => trip.rep_user_id === user.id || (!trip.rep_user_id && trip.member_id === ownMember?.id);
        let body;
        try { body = await req.json(); } catch { throw new DrivingError(400, 'Invalid request.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DrivingError(400, 'Invalid request.');
        const action = body.action || 'report';

        if (action === 'report') {
            const start = drivingDate(body.start_date);
            const end = drivingDate(body.end_date);
            if (start > end) throw new DrivingError(400, 'Start date must be before end date.');
            const query = { manager_id: managerId, trip_date: { $gte: start, $lte: end },
                ...(!managesTeam ? { $or: [{ rep_user_id: user.id }, { member_id: ownMember.id, rep_user_id: '' }] } : {}) };
            const trips = (await allPages(service.DrivingTrip, query, '-trip_date'))
                .filter(t => t.manager_id === managerId && t.trip_date >= start && t.trip_date <= end
                    && (managesTeam || ownsTrip(t)));
            return Response.json({ success: true, manager_id: managerId, trips });
        }

        if (action === 'submit') {
            const member = managesTeam
                ? (body.member_id === managerId ? { id: managerId, user_id: managerId, name: user.full_name || user.data?.full_name || 'Team Manager', email: user.email, status: 'active' }
                    : members.find(m => m.id === body.member_id && active(m)))
                : ownMember;
            if (!member) throw new DrivingError(403, 'Choose an active member of your team.');
            const submissionId = text(body.submission_id, 'Submission ID', 100);
            const mileage = tripMiles(body.odometer_start, body.odometer_end);
            const trip = {
                manager_id: managerId, member_id: member.id, rep_user_id: member.user_id || '',
                rep_name: member.name, rep_email: member.email || '', invite_code: member.invite_code || '',
                submission_id: submissionId, trip_date: drivingDate(body.trip_date),
                origin: text(body.origin, 'Starting location', 300), destination: text(body.destination, 'Destination', 300),
                purpose: text(body.purpose, 'Business purpose', 500), vehicle: text(body.vehicle, 'Vehicle', 100),
                notes: text(body.notes, 'Notes', 1000, false), ...mileage,
                status: 'submitted', recorded_by: user.id,
            };
            if (trip.trip_date > new Date(Date.now() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10)) {
                throw new DrivingError(400, 'Record completed trips only.');
            }
            const existing = asArray(await service.DrivingTrip.filter({ manager_id: managerId, submission_id: submissionId }, '-created_date', 10));
            const retry = existing.find(t => t.manager_id === managerId && t.submission_id === submissionId);
            if (retry) {
                if (retry.recorded_by !== user.id) throw new DrivingError(409, 'Submission ID already used.');
                if (['member_id', 'trip_date', 'origin', 'destination', 'purpose', 'vehicle', 'notes', 'odometer_start', 'odometer_end']
                    .some(key => retry[key] !== trip[key])) {
                    throw new DrivingError(409, 'This submission was already saved with different details. Refresh the report and cancel the original trip before correcting it.');
                }
                return Response.json({ success: true, trip: retry });
            }
            const dayTrips = await allPages(service.DrivingTrip, { manager_id: managerId, member_id: member.id, trip_date: trip.trip_date });
            if (dayTrips.some(t => t.manager_id === managerId && t.member_id === member.id
                && t.trip_date === trip.trip_date && normalized(t.vehicle) === normalized(trip.vehicle)
                && ['submitted', 'approved', 'paid'].includes(t.status)
                && trip.odometer_start < t.odometer_end && trip.odometer_end > t.odometer_start)) {
                throw new DrivingError(409, 'These odometer readings overlap an existing trip for this vehicle and date.');
            }
            return Response.json({ success: true, trip: await service.DrivingTrip.create(trip) });
        }

        if (!['approve', 'pay', 'reject', 'cancel'].includes(action)) throw new DrivingError(400, 'Unknown driving action.');
        if (action !== 'cancel' && !managesTeam) throw new DrivingError(403, 'Only your manager can review or mark trips paid.');
        const tripId = text(body.trip_id, 'Trip ID', 100);
        // Filter before reading, so a foreign ID cannot expose another team's trip.
        const trip = asArray(await service.DrivingTrip.filter({ id: tripId, manager_id: managerId }, '-created_date', 1))
            .find(t => t.id === tripId && t.manager_id === managerId);
        if (!trip || (!managesTeam && !ownsTrip(trip))) throw new DrivingError(404, 'Trip not found.');
        const timestamp = new Date().toISOString();
        let update;
        if (action === 'pay') {
            if (trip.status !== 'approved') throw new DrivingError(409, 'Only approved trips can be marked paid.');
            update = { status: 'paid', paid_by: user.id, paid_at: timestamp,
                payment_reference: text(body.payment_reference, 'Payment reference', 200) };
        } else {
            if (trip.status !== 'submitted') throw new DrivingError(409, 'Only submitted trips can be reviewed or cancelled.');
            if (action === 'approve') {
                const mileage = tripMiles(trip.odometer_start, trip.odometer_end);
                update = { status: 'approved', ...mileage, ...tripPayment(mileage.miles, body.rate_per_mile), approved_by: user.id, approved_at: timestamp };
            } else {
                update = { status: action === 'reject' ? 'rejected' : 'cancelled',
                    review_note: text(body.review_note, 'Reason', 500), reviewed_by: user.id, reviewed_at: timestamp };
            }
        }
        return Response.json({ success: true, trip: await service.DrivingTrip.update(trip.id, update) });
    } catch (error) {
        const status = error instanceof DrivingError ? error.status : 500;
        if (status === 500) console.error('Driving accounting failed:', error);
        return Response.json({ error: status === 500 ? 'Unable to save or load driving records. Please retry.' : error.message }, { status });
    }
});
