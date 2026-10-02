import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { DrivingError, drivingDate, tripMiles, tripPayment, drivingTotals } from '../base44/shared/drivingAccounting.js';
import { drivingCsv } from '../src/lib/drivingAccounting.js';

const manager = { id: 'manager-a', app_role: 'manager', role: 'user', full_name: 'Manager' };
const rep = { id: 'rep-a', app_role: 'rep', role: 'user', team_manager_id: manager.id };
const members = [{ id: 'member-a', user_id: rep.id, name: 'Rep A', manager_id: manager.id, role: 'rep', status: 'active' },
    { id: 'member-b', user_id: 'rep-b', name: 'Rep B', manager_id: manager.id, role: 'rep', status: 'active' }];
const payload = { action: 'submit', member_id: 'member-a', submission_id: 'request-a', trip_date: '2026-01-01',
    origin: 'Office', destination: 'Territory', purpose: 'Customer visits', vehicle: 'Car A', odometer_start: '1234.5', odometer_end: '1260.8' };
const baseTrip = { ...payload, id: 'trip-a', manager_id: manager.id, member_id: 'member-a', rep_user_id: rep.id,
    rep_name: 'Rep A', miles: 26.3, status: 'submitted', recorded_by: rep.id };

function harness({ caller = rep, storedUser = caller, records = members, trips = [], wrapped = false, failPage = false } = {}) {
    const writes = [], queries = [];
    const entityTrips = trips.map(t => ({ ...t }));
    const service = {
        User: { get: async id => id === storedUser?.id ? storedUser : id === manager.id ? manager : null },
        TeamMember: { filter: async (query, _sort, limit, skip) => records.filter(m => m.manager_id === query.manager_id).slice(skip, skip + limit) },
        DrivingTrip: {
            filter: async (query, _sort, limit, skip = 0) => {
                queries.push(query);
                if (failPage && skip) throw new Error('Page failed');
                const matches = (t, q) => Object.entries(q).every(([key, value]) => key === '$or' ? value.some(part => matches(t, part))
                    : typeof value === 'object' ? t[key] >= value.$gte && t[key] <= value.$lte : t[key] === value);
                const rows = entityTrips.filter(t => matches(t, query)).slice(skip, skip + limit).map(t => ({ ...t }));
                return wrapped ? { items: rows } : rows;
            },
            create: async data => { const trip = { ...data, id: `new-${entityTrips.length}` }; entityTrips.push(trip); writes.push(trip); return trip; },
            updateMany: async (query, { $set: data }) => {
                const trip = entityTrips.find(t => t.id === query.id && t.manager_id === query.manager_id && t.status === query.status);
                if (!trip) return { success: true, updated: 0 };
                Object.assign(trip, data); writes.push(data); return { success: true, updated: 1 };
            },
        },
    };
    let handler;
    const source = ts.transpileModule(fs.readFileSync('base44/functions/drivingAccounting/entry.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replace(/^import .*;\s*$/gm, '');
    vm.runInNewContext(source, {
        createClientFromRequest: () => ({ auth: { me: async () => caller }, asServiceRole: { entities: service } }),
        DrivingError, drivingDate, tripMiles, tripPayment, Response, Deno: { serve: fn => { handler = fn; } }, console: { error: () => {} },
    });
    return { writes, queries, trips: entityTrips, invoke: async (body, method = 'POST') => {
        const response = await handler(new Request('https://team.test/driving', { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }));
        return { status: response.status, data: response.status === 204 ? null : await response.json() };
    } };
}
const report = { action: 'report', start_date: '2026-01-01', end_date: '2026-01-31' };

test('odometer math is decimal exact and rejects invalid readings', () => {
    assert.deepEqual(tripMiles('100.1', '100.3'), { odometer_start: 100.1, odometer_end: 100.3, miles: 0.2 });
    for (const [start, end] of [['', '10'], ['-1', '10'], ['100', '90'], ['100', '100'], ['1.01', '10'], ['NaN', '10'], [Infinity, 10], ['0', '1000001']]) assert.throws(() => tripMiles(start, end));
    assert.deepEqual(tripPayment(26.3, '0.725'), { rate_per_mile: 0.725, reimbursement_cents: 1907 });
    assert.equal(tripPayment(0.1, '0.05').reimbursement_cents, 1);
    for (const rate of ['', '-0.2', '0.12345', '11', 'NaN']) assert.throws(() => tripPayment(1, rate));
    assert.throws(() => drivingDate('2026-02-30'));
});

test('only manager-approved cents enter due and paid totals', () => {
    const totals = drivingTotals([
        { miles: 0.1, status: 'submitted' }, { miles: 0.2, status: 'approved', reimbursement_cents: 15 },
        { miles: 3.5, status: 'paid', reimbursement_cents: 254 }, { miles: 100, status: 'rejected' }, { miles: 200, status: 'cancelled' },
    ]);
    assert.deepEqual(totals, { trips: 3, miles: 3.8, submitted_miles: 0.1, approved_miles: 3.7, due_cents: 15, paid_cents: 254 });
});

test('rep submissions derive tenant and rep identity and ignore forged amounts / status', async () => {
    const { invoke, writes } = harness();
    const { status, data } = await invoke({ ...payload, member_id: 'member-b', manager_id: 'foreign', rep_user_id: 'rep-b', miles: 999, status: 'paid', reimbursement_cents: 999999 });
    assert.equal(status, 200);
    assert.equal(data.trip.member_id, 'member-a');
    assert.equal(data.trip.manager_id, manager.id);
    assert.equal(data.trip.rep_user_id, rep.id);
    assert.equal(data.trip.miles, 26.3);
    assert.equal(data.trip.status, 'submitted');
    assert.equal(data.trip.reimbursement_cents, undefined);
    assert.equal(writes.length, 1);
});

test('report reads only own rep records; saved account overrides forged auth roles', async () => {
    const h = harness({ caller: { ...rep, role: 'admin', is_owner: true }, storedUser: rep,
        trips: [baseTrip, { ...baseTrip, id: 'other', rep_user_id: 'rep-b' }, { ...baseTrip, id: 'foreign', manager_id: 'foreign' }] });
    const result = await h.invoke({ ...report, manager_id: 'foreign', rep_user_id: 'rep-b' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.trips.map(t => t.id), ['trip-a']);
    assert.ok(h.queries.every(q => q.manager_id === manager.id && q.$or[0].rep_user_id === rep.id));
});

test('newly linked reps can see manager-entered history for their verified roster member', async () => {
    const h = harness({ trips: [{ ...baseTrip, rep_user_id: '' }, { ...baseTrip, id: 'other', member_id: 'member-b', rep_user_id: '' }] });
    const result = await h.invoke(report);
    assert.deepEqual(result.data.trips.map(t => t.id), ['trip-a']);
    assert.equal((await h.invoke({ action: 'cancel', trip_id: 'trip-a', review_note: 'Correction' })).status, 200);
});

test('rep cannot approve, pay, reject or cancel another rep’s trip', async () => {
    const h = harness({ trips: [baseTrip, { ...baseTrip, id: 'other', rep_user_id: 'rep-b' }] });
    for (const action of ['approve', 'pay', 'reject']) assert.equal((await h.invoke({ action, trip_id: baseTrip.id })).status, 403);
    assert.equal((await h.invoke({ action: 'cancel', trip_id: 'other', review_note: 'Correction' })).status, 404);
    assert.equal(h.writes.length, 0);
});

test('unlinked, inactive, removed and unauthenticated users cannot access logs', async () => {
    assert.equal((await harness({ caller: null }).invoke(report)).status, 401);
    for (const records of [[], members.map(m => ({ ...m, status: 'inactive' })), members.map(m => ({ ...m, user_id: undefined }))]) {
        assert.equal((await harness({ records }).invoke(report)).status, 403);
    }
    assert.equal((await harness().invoke(report, 'GET')).status, 405);
    assert.equal((await harness().invoke({ ...report, start_date: '2026-02-01' })).status, 400);
});

test('manager can submit for team, approve exact amounts and record a payment', async () => {
    const h = harness({ caller: manager, trips: [baseTrip] });
    assert.equal((await h.invoke({ ...payload, member_id: 'foreign' })).status, 403);
    assert.equal((await h.invoke({ ...payload, member_id: 'member-b', submission_id: 'manager-entry' })).status, 200);
    const approval = await h.invoke({ action: 'approve', trip_id: baseTrip.id, rate_per_mile: '0.725', reimbursement_cents: 9999 });
    assert.equal(approval.status, 200);
    assert.equal(approval.data.trip.reimbursement_cents, 1907);
    assert.equal(approval.data.trip.approved_by, manager.id);
    assert.equal((await h.invoke({ action: 'pay', trip_id: baseTrip.id, payment_reference: '' })).status, 400);
    const payment = await h.invoke({ action: 'pay', trip_id: baseTrip.id, payment_reference: 'Payroll 123' });
    assert.equal(payment.status, 200);
    assert.equal(payment.data.trip.rate_per_mile, 0.725);
    assert.equal(payment.data.trip.payment_reference, 'Payroll 123');
    assert.equal(payment.data.trip.paid_by, manager.id);
    for (const action of ['approve', 'pay', 'reject', 'cancel']) assert.equal((await h.invoke({ action, trip_id: baseTrip.id, rate_per_mile: 1, review_note: 'Change' })).status, 409);
});

test('submission retries are idempotent and overlapping readings cannot be double claimed', async () => {
    const h = harness();
    assert.equal((await h.invoke(payload)).status, 200);
    assert.equal((await h.invoke(payload)).status, 200);
    assert.equal(h.writes.length, 1);
    assert.equal((await h.invoke({ ...payload, odometer_end: '1270.1' })).status, 409);
    assert.equal((await h.invoke({ ...payload, submission_id: 'retry-new-id' })).status, 409);
    assert.equal((await h.invoke({ ...payload, submission_id: 'next', odometer_start: '1260.8', odometer_end: '1270.1' })).status, 200);
});

test('concurrent review and cancellation cannot overwrite an approved reimbursement', async () => {
    const h = harness({ caller: manager, trips: [baseTrip] });
    const results = await Promise.all([
        h.invoke({ action: 'approve', trip_id: baseTrip.id, rate_per_mile: '0.725' }),
        h.invoke({ action: 'cancel', trip_id: baseTrip.id, review_note: 'Concurrent correction' }),
    ]);
    assert.deepEqual(results.map(r => r.status), [200, 409]);
    assert.equal(h.trips[0].status, 'approved');
    assert.equal(h.trips[0].reimbursement_cents, 1907);
    assert.equal(h.writes.length, 1);
});

test('cancelling preserves original trip and permits corrected readings', async () => {
    const h = harness({ trips: [baseTrip] });
    assert.equal((await h.invoke({ action: 'cancel', trip_id: baseTrip.id, review_note: 'Incorrect ending reading' })).status, 200);
    assert.equal(h.trips[0].miles, 26.3);
    assert.equal(h.trips[0].status, 'cancelled');
    assert.equal((await h.invoke({ ...payload, submission_id: 'corrected', odometer_end: '1250.5' })).status, 200);
});

test('manager report paginates all records including historical reps and rejects partial results', async () => {
    const trips = Array.from({ length: 505 }, (_, i) => ({ ...baseTrip, id: `trip-${i}`, rep_user_id: 'removed-user', member_id: 'removed-member' }));
    assert.equal((await harness({ caller: manager, trips, wrapped: true }).invoke(report)).data.trips.length, 505);
    assert.equal((await harness({ caller: manager, trips, failPage: true }).invoke(report)).status, 500);
    const foreign = { ...baseTrip, id: 'foreign', manager_id: 'manager-other' };
    const h = harness({ caller: manager, trips: [foreign] });
    assert.equal((await h.invoke({ action: 'approve', trip_id: foreign.id, rate_per_mile: '1' })).status, 404);
    assert.equal(h.writes.length, 0);
});

test('CSV includes exact readings, payment audit and safe spreadsheet text', () => {
    const csv = drivingCsv([{ ...baseTrip, rep_name: '=HYPERLINK("evil")', purpose: 'Visits, "follow-up"\nNext stop', status: 'paid', rate_per_mile: 0.725, reimbursement_cents: 1907, payment_reference: 'Payroll 123' }], report.start_date, report.end_date);
    assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));
    assert.ok(csv.includes('"Visits, ""follow-up""\nNext stop"'));
    assert.ok(csv.includes('"26.3","paid","0.725","19.07"'));
    assert.ok(csv.includes('"Payroll 123"'));
    const schema = JSON.parse(fs.readFileSync('base44/entities/DrivingTrip.jsonc', 'utf8'));
    for (const action of ['create', 'read', 'update', 'delete']) assert.equal(schema.rls[action].user_condition.id, '__service_role_only__');
});
