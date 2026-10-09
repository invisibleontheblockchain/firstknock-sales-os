import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimeClockError, timeClockRange, shiftOverlaps, shiftMilliseconds, durationLabel } from '../base44/shared/timeClock.js';
import { clockDateRange, timeClockCsv } from '../src/lib/timeClock.js';
import * as clockHelpers from '../base44/shared/timeClock.js';
import { timesheetCsv, clockInputValue, clockInputInstant } from '../src/lib/timeClock.js';

const manager = { id: 'manager-a', app_role: 'manager' };
const rep = { id: 'rep-a', app_role: 'rep', team_manager_id: manager.id, email: 'rep@example.com' };
const member = { id: 'member-a', manager_id: manager.id, user_id: rep.id, status: 'active', role: 'rep', name: 'Alex', invite_code: 'TEAM1' };
const sample = (extra = {}) => ({ id: 'shift-a', manager_id: manager.id, member_id: member.id, rep_user_id: rep.id,
    rep_name: 'Alex', status: 'active', request_id: 'request-1', clock_in_at: '2026-10-08T23:00:00.000Z', ...extra });
const rangeBody = { action: 'report', start_at: '2026-10-01T00:00:00.000Z', end_at: '2026-11-01T00:00:00.000Z' };

function matches(row, query) {
    return Object.entries(query).every(([key, value]) => {
        if (key === '$or') return value.some(part => matches(row, part));
        if (value && typeof value === 'object') return Object.entries(value).every(([op, expected]) => {
            if (op === '$exists') return (row[key] !== undefined) === expected;
            if (op === '$in') return expected.includes(row[key]);
            if (op === '$gte') return row[key] >= expected;
            if (op === '$lt') return row[key] < expected;
            throw new Error(`Unsupported operator ${op}`);
        });
        return value === null ? row[key] == null : row[key] === value;
    });
}

function harness({ caller = rep, savedUser = caller, members = [member], activeShiftId = '', shifts = [], users = [], ignoreShiftScope = false, failActivation = false, failClear = false, databaseAvailable = true } = {}) {
    members = members.map(row => ({ ...row, ...(row.user_id === rep.id && activeShiftId ? { time_clock_active_shift_id: activeShiftId } : {}) }));
    const accounts = [structuredClone(manager), ...(savedUser?.id !== manager.id && savedUser ? [structuredClone(savedUser)] : []), ...users];
    if (savedUser?.id === manager.id) accounts[0] = structuredClone(savedUser);
    const queries = [];
    let handler;
    const filter = (rows, ignoreScope = false) => async (query, sort, limit = 500, skip = 0) => {
        queries.push(query);
        return { items: (ignoreScope ? rows : rows.filter(row => matches(row, query)))
            .slice().sort((a, b) => sort === '-clock_in_at' ? String(b.clock_in_at).localeCompare(String(a.clock_in_at)) : 0)
            .slice(skip, skip + limit).map(row => structuredClone(row)) };
    };
    const updateMany = (rows, entity) => async (query, data) => {
        if (entity === 'TimeShift' && data.$set.status === 'active' && failActivation) { failActivation = false; throw new Error('Activation interrupted'); }
        if (entity === 'TeamMember' && data.$set.time_clock_active_shift_id === '' && failClear) { failClear = false; throw new Error('Cleanup interrupted'); }
        const selected = rows.filter(row => matches(row, query));
        for (const row of selected) Object.assign(row, data.$set);
        return { success: true, updated: selected.length };
    };
    const service = {
        User: { get: async id => structuredClone(accounts.find(user => user.id === id)),
            update: async (id, data) => Object.assign(accounts.find(user => user.id === id), data),
            updateMany: async () => { throw Object.assign(new Error('Bulk user update not allowed'), { status: 405 }); } },
        TeamMember: { filter: filter(members), get: async id => structuredClone(members.find(row => row.id === id)), updateMany: updateMany(members, 'TeamMember') },
        TimeShift: { filter: filter(shifts, ignoreShiftScope), get: async id => structuredClone(shifts.find(shift => shift.id === id)),
            create: async data => { const row = { id: `new-${shifts.length}`, ...data }; shifts.push(row); return structuredClone(row); },
            updateMany: updateMany(shifts, 'TimeShift') },
    };
    const code = ts.transpileModule(fs.readFileSync('base44/functions/timeClock/entry.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replace(/^import .*;\s*$/gm, '');
    const locks = new Map();
    class Client {
        async connect() {}
        async query(sql, args) {
            if (sql.includes('pg_advisory_xact_lock')) {
                const previous = locks.get(args[0]) || Promise.resolve();
                locks.set(args[0], new Promise(resolve => { this.release = resolve; }));
                await previous;
            } else if (sql === 'COMMIT' || sql === 'ROLLBACK') this.release?.();
            return { rows: [] };
        }
        async end() { this.release?.(); }
    }
    vm.runInNewContext(code, { createClientFromRequest: () => ({ auth: { me: async () => caller }, asServiceRole: { entities: service } }), Client,
        Deno: { env: { get: () => databaseAvailable ? 'test-database' : '' }, serve: fn => { handler = fn; } }, ...clockHelpers, Response, console: { error() {} } });
    return { shifts, accounts, members, queries, invoke: async (body = {}) => {
        const response = await handler(new Request('https://team.test/time-clock', { method: 'POST', body: JSON.stringify(body) }));
        return { status: response.status, data: await response.json() };
    } };
}

test('clock in binds identity, membership and time to the server; reload restores status', async () => {
    const h = harness();
    const before = Date.now();
    const result = await h.invoke({ action: 'clock_in', request_id: 'request-1', manager_id: 'foreign', rep_user_id: 'foreign', member_id: 'foreign', clock_in_at: '2000-01-01' });
    assert.equal(result.status, 200);
    assert.equal(result.data.shift.manager_id, manager.id);
    assert.equal(result.data.shift.rep_user_id, rep.id);
    assert.equal(result.data.shift.member_id, member.id);
    assert.equal(result.data.shift.status, 'active');
    assert.ok(Date.parse(result.data.shift.clock_in_at) >= before);
    const report = await h.invoke(rangeBody);
    assert.equal(report.data.current_shift.id, result.data.shift.id);
    assert.equal(report.data.active_shifts.length, 1);
});

test('clock-in retries are idempotent and an already active rep cannot start another shift', async () => {
    const h = harness();
    const first = await h.invoke({ action: 'clock_in', request_id: 'request-1' });
    const retry = await h.invoke({ action: 'clock_in', request_id: 'request-1' });
    assert.equal(retry.data.shift.id, first.data.shift.id);
    assert.equal(h.shifts.length, 1);
    assert.equal((await h.invoke({ action: 'clock_in', request_id: 'request-2' })).status, 409);
});

test('simultaneous clock-ins on multiple devices claim exactly one active shift', async () => {
    const h = harness();
    const results = await Promise.all(['request-1', 'request-2'].map(request_id => h.invoke({ action: 'clock_in', request_id })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(h.shifts.filter(shift => shift.status === 'active').length, 1);
    const report = await h.invoke(rangeBody);
    assert.equal(report.data.active_shifts.length, 1);
    assert.equal(report.data.shifts.filter(shift => shift.status === 'pending').length, 0);
});

test('an interrupted clock-in recovers its durable claim without duplicating a shift', async () => {
    const h = harness({ failActivation: true });
    assert.equal((await h.invoke({ action: 'clock_in', request_id: 'request-1' })).status, 500);
    assert.equal(h.shifts[0].status, 'pending');
    const report = await h.invoke(rangeBody);
    assert.equal(report.data.current_shift.status, 'active');
    assert.equal((await h.invoke({ action: 'clock_in', request_id: 'request-1' })).data.shift.id, h.shifts[0].id);
    assert.equal(h.shifts.length, 1);
});

test('clock out records server time once; delayed retries cannot clear a newer shift', async () => {
    const shift = sample();
    const h = harness({ activeShiftId: shift.id, shifts: [shift] });
    const before = Date.now();
    const first = await h.invoke({ action: 'clock_out', shift_id: shift.id, clock_out_at: '2000-01-01' });
    assert.equal(first.status, 200);
    assert.ok(Date.parse(first.data.shift.clock_out_at) >= before);
    assert.equal(first.data.shift.closed_by, rep.id);
    const newer = await h.invoke({ action: 'clock_in', request_id: 'request-2' });
    assert.equal(newer.status, 200);
    const retry = await h.invoke({ action: 'clock_out', shift_id: shift.id });
    assert.equal(retry.data.shift.clock_out_at, first.data.shift.clock_out_at);
    assert.equal(h.members.find(row => row.id === member.id).time_clock_active_shift_id, newer.data.shift.id);
});

test('clock-out cleanup failure is recovered by refresh and permits the next shift', async () => {
    const h = harness({ shifts: [sample()], activeShiftId: 'shift-a', failClear: true });
    assert.equal((await h.invoke({ action: 'clock_out', shift_id: 'shift-a' })).status, 500);
    assert.equal(h.shifts[0].status, 'closed');
    assert.equal((await h.invoke(rangeBody)).data.current_shift, null);
    assert.equal((await h.invoke({ action: 'clock_in', request_id: 'request-2' })).status, 200);
});

test('rep reports exclude other reps and tenants even when the entity filter overreturns', async () => {
    const shifts = [sample(), sample({ id: 'other-rep', rep_user_id: 'rep-b' }), sample({ id: 'foreign', manager_id: 'other-manager' })];
    const h = harness({ shifts, activeShiftId: 'shift-a', ignoreShiftScope: true });
    const report = await h.invoke({ ...rangeBody, manager_id: 'other-manager' });
    assert.equal(report.data.manager_id, manager.id);
    assert.deepEqual(report.data.shifts.map(shift => shift.id), ['shift-a']);
    assert.deepEqual(report.data.active_shifts.map(shift => shift.id), ['shift-a']);
    assert.equal((await h.invoke({ action: 'clock_out', shift_id: 'other-rep' })).status, 403);
    assert.equal((await h.invoke({ action: 'close_shift', shift_id: 'other-rep' })).status, 403);
});

test('stored roles and active linked membership govern access', async () => {
    assert.equal((await harness({ caller: null }).invoke(rangeBody)).status, 401);
    for (const members of [[], [{ ...member, status: 'inactive' }], [{ ...member, role: 'manager' }], [{ ...member, user_id: 'other' }], [{ ...member, manager_id: 'other' }]]) {
        assert.equal((await harness({ members }).invoke(rangeBody)).status, 403);
    }
    const forged = harness({ caller: { ...rep, app_role: 'admin', is_owner: true }, savedUser: rep, shifts: [sample({ id: 'other-rep', rep_user_id: 'rep-b' })] });
    assert.deepEqual((await forged.invoke(rangeBody)).data.shifts, []);
});

test('manager reports retain historical and inactive members and can close a forgotten shift with attribution', async () => {
    const shifts = [sample(), sample({ id: 'foreign', manager_id: 'other-manager', rep_user_id: 'other-rep' })];
    const h = harness({ caller: manager, shifts, members: [{ ...member, status: 'inactive' }], ignoreShiftScope: true,
        activeShiftId: 'shift-a', users: [rep] });
    assert.deepEqual((await h.invoke(rangeBody)).data.shifts.map(shift => shift.id), ['shift-a']);
    assert.equal((await h.invoke({ action: 'close_shift', shift_id: 'foreign', request_id: 'close-foreign' })).status, 403);
    assert.equal((await h.invoke({ action: 'clock_out', shift_id: 'shift-a' })).status, 403);
    const result = await h.invoke({ action: 'close_shift', shift_id: 'shift-a', request_id: 'close-missing', revision: 0,
        start_at: shifts[0].clock_in_at, end_at: '2026-10-09T00:00:00.000Z', reason: 'Finished yesterday' });
    assert.equal(result.status, 200);
    assert.equal(result.data.shift.closed_by, manager.id);
    assert.equal(h.members.find(row => row.id === member.id).time_clock_active_shift_id, '');
});

test('historical range includes overnight overlaps; active status remains visible outside history filters', async () => {
    const shifts = [sample({ clock_in_at: '2026-10-07T23:00:00.000Z', clock_out_at: '2026-10-08T02:00:00.000Z', status: 'closed' }),
        sample({ id: 'open-now', clock_in_at: '2026-10-09T00:00:00.000Z' })];
    const h = harness({ shifts, activeShiftId: 'open-now' });
    const result = await h.invoke({ action: 'report', start_at: '2026-10-08T00:00:00.000Z', end_at: '2026-10-09T00:00:00.000Z' });
    assert.deepEqual(result.data.shifts.map(shift => shift.id), ['shift-a']);
    assert.equal(result.data.active_shifts[0].id, 'open-now');
    assert.equal(result.data.current_shift.id, 'open-now');
});

test('reports paginate beyond 500 shifts and validate ranges and request shape', async () => {
    const shifts = Array.from({ length: 501 }, (_, i) => sample({ id: `shift-${i}`, status: 'closed', clock_out_at: '2026-10-09T00:00:00.000Z' }));
    const h = harness({ shifts });
    assert.equal((await h.invoke(rangeBody)).data.shifts.length, 501);
    for (const body of [null, [], { action: 'unknown' }, { ...rangeBody, end_at: rangeBody.start_at }, { ...rangeBody, start_at: 'invalid' }, { action: 'clock_in', request_id: '' }]) {
        assert.equal((await h.invoke(body)).status, 400);
    }
});

test('duration calculations clip overnight and running shifts to the selected dates', () => {
    const range = timeClockRange('2026-10-08T00:00:00.000Z', '2026-10-09T00:00:00.000Z');
    const closed = sample({ clock_in_at: '2026-10-07T23:00:00.000Z', clock_out_at: '2026-10-08T02:00:00.000Z' });
    assert.equal(shiftMilliseconds(closed, Date.now(), range), 2 * 3600000);
    assert.equal(shiftMilliseconds(sample(), Date.parse('2026-10-09T01:00:00.000Z'), range), 3600000);
    assert.equal(durationLabel(9000000), '2h 30m');
    assert.equal(clockDateRange('2026-02-30', '2026-03-01'), null);
    assert.equal(clockDateRange('2026-10-09', '2026-10-08'), null);
});

test('CSV escapes formulas and quotes, and exports selected-range hours with explicit UTC bounds', () => {
    const range = clockDateRange('2026-10-08', '2026-10-08');
    const csv = timeClockCsv([sample({ rep_name: '=SUM(A1)', rep_email: 'a"b@example.com', clock_in_at: range.start_at,
        clock_out_at: new Date(range.start + 9000000).toISOString() })], range, Date.now());
    assert.ok(csv.includes("\"'=SUM(A1)\""));
    assert.ok(csv.includes('"a""b@example.com"'));
    assert.ok(csv.includes('"2.5000"'));
    assert.ok(csv.includes('Clock in (UTC)'));
});

test('time clock is placed in Teams and all shift writes are restricted to backend service role', () => {
    const page = fs.readFileSync('src/pages/AdminTeam.jsx', 'utf8');
    assert.match(page, /TabsTrigger value="time-clock"/);
    assert.match(page, /TabsContent value="time-clock"/);
    const entity = JSON.parse(fs.readFileSync('base44/entities/TimeShift.jsonc', 'utf8'));
    assert.equal(entity.name, 'TimeShift');
    for (const action of ['read', 'create', 'update', 'delete']) assert.equal(entity.rls[action].user_condition.id, '__service_role_only__');
    const membership = JSON.parse(fs.readFileSync('base44/entities/TeamMember.jsonc', 'utf8'));
    assert.equal(membership.properties.time_clock_active_shift_id.rls.write.user_condition.id, '__service_role_only__');
});

test('managers without canvasser membership record their own shifts in team reports', async () => {
    const h = harness({ caller: manager });
    assert.equal((await h.invoke(rangeBody)).data.can_clock, true);
    const results = await Promise.all(['manager-1', 'manager-2'].map(request_id => h.invoke({ action: 'clock_in', request_id })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(h.shifts.length, 1);
    assert.equal(h.shifts[0].rep_user_id, manager.id);
    assert.equal((await h.invoke(rangeBody)).data.active_shifts[0].rep_user_id, manager.id);
    assert.equal((await harness().invoke(rangeBody)).data.can_clock, true);
});

test('duplicate roster memberships resolve to one stable claim across devices', async () => {
    const h = harness({ members: [{ ...member, id: 'member-b' }, member] });
    const results = await Promise.all(['request-1', 'request-2'].map(request_id => h.invoke({ action: 'clock_in', request_id })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(h.shifts.filter(row => row.status === 'active').length, 1);
    assert.equal(h.shifts.find(row => row.status === 'active').member_id, member.id);
});

test('a transferred canvasser cannot start a new shift while a previous membership still has an open shift', async () => {
    const oldMember = { ...member, id: 'old-member', manager_id: 'old-manager', time_clock_active_shift_id: 'old-shift' };
    const h = harness({ members: [member, oldMember], shifts: [sample({ id: 'old-shift', manager_id: 'old-manager', member_id: oldMember.id })] });
    assert.equal((await h.invoke({ action: 'clock_in', request_id: 'request-1' })).status, 409);
    assert.equal(h.shifts.length, 1);
});

test('backend deployment validation rejects schema filenames that differ from the SDK entity identity', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'firstknock-time-clock-schema-'));
    try {
        fs.mkdirSync(path.join(fixture, 'base44/entities'), { recursive: true });
        fs.mkdirSync(path.join(fixture, 'base44/functions'));
        fs.writeFileSync(path.join(fixture, 'base44/config.jsonc'), '{}');
        fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
        const wrongPath = path.join(fixture, 'base44/entities/time-shift.jsonc');
        fs.writeFileSync(wrongPath, fs.readFileSync('base44/entities/TimeShift.jsonc'));
        const validator = path.resolve('scripts/validate-backend.mjs');
        const invalid = spawnSync(process.execPath, [validator], { cwd: fixture, encoding: 'utf8' });
        assert.equal(invalid.status, 1);
        assert.match(invalid.stderr, /filename.*must match the schema name exactly/);
        fs.renameSync(wrongPath, path.join(fixture, 'base44/entities/TimeShift.jsonc'));
        const valid = spawnSync(process.execPath, [validator], { cwd: fixture, encoding: 'utf8' });
        assert.equal(valid.status, 0, valid.stderr);
    } finally {
        // Only remove the dedicated fixture created above, never an unchecked computed path.
        assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(fixture).startsWith('firstknock-time-clock-schema-'));
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('corrections preserve original values, reason, editor, and idempotency', async () => {
    const shift = sample({ status: 'closed', clock_out_at: '2026-10-09T01:00:00.000Z' });
    const h = harness({ caller: manager, shifts: [shift] });
    const body = { action: 'edit_shift', shift_id: shift.id, revision: 0, request_id: 'edit-times-1',
        start_at: '2026-10-08T22:00:00.000Z', end_at: '2026-10-09T00:00:00.000Z', reason: 'Corrected finish' };
    const result = await h.invoke(body);
    assert.equal(result.status, 200);
    assert.equal(result.data.shift.adjusted, true);
    assert.equal(result.data.shift.audit_trail[0].before_start, '2026-10-08T23:00:00.000Z');
    assert.equal(result.data.shift.audit_trail[0].before_end, '2026-10-09T01:00:00.000Z');
    assert.equal(result.data.shift.audit_trail[0].actor_id, manager.id);
    assert.equal(result.data.shift.audit_trail[0].reason, body.reason);
    assert.equal((await h.invoke(body)).data.shift.audit_trail.length, 1);
    assert.equal((await h.invoke({ ...body, request_id: 'another-edit' })).status, 409);
    const visible = await harness({ shifts: h.shifts }).invoke(rangeBody);
    assert.equal(visible.data.shifts[0].audit_trail[0].reason, body.reason);
});

test('reps request corrections; only their manager changes actual recorded times', async () => {
    const h = harness({ shifts: [sample({ status: 'closed', clock_out_at: '2026-10-09T01:00:00.000Z' })] });
    const request = { action: 'request_correction', shift_id: 'shift-a', revision: 0, request_id: 'request-change',
        start_at: '2026-10-08T22:00:00.000Z', end_at: '2026-10-09T00:00:00.000Z', reason: 'Stopped earlier' };
    assert.equal((await h.invoke({ ...request, action: 'edit_shift' })).status, 403);
    const result = await h.invoke(request);
    assert.equal(result.status, 200);
    assert.equal(result.data.shift.clock_out_at, '2026-10-09T01:00:00.000Z');
    assert.equal(result.data.shift.correction_requests[0].status, 'pending');
    const reviewer = harness({ caller: manager, shifts: h.shifts });
    const corrected = await reviewer.invoke({ ...request, action: 'edit_shift', revision: 1, request_id: 'approve-change' });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.data.shift.correction_requests[0].status, 'resolved');
    assert.equal(corrected.data.shift.correction_requests[0].resolved_by, manager.id);
    assert.equal((await harness({ caller: { ...rep, id: 'rep-b' }, members: [{ ...member, user_id: 'rep-b' }], shifts: h.shifts }).invoke(request)).status, 403);
});

test('missing shifts are audited, linked to the selected account, and reject overlaps and foreign people', async () => {
    const h = harness({ caller: manager, shifts: [], users: [rep] });
    const body = { action: 'add_shift', person_id: rep.id, request_id: 'missing-time',
        start_at: '2026-10-08T20:00:00.000Z', end_at: '2026-10-08T22:00:00.000Z', reason: 'Missed clock-in' };
    assert.equal((await h.invoke({ ...body, person_id: 'foreign-person' })).status, 403);
    const saved = await h.invoke(body);
    assert.equal(saved.status, 200);
    assert.equal(saved.data.shift.rep_user_id, rep.id);
    assert.equal(saved.data.shift.status, 'closed');
    assert.equal(saved.data.shift.audit_trail[0].before_start, '');
    assert.equal((await h.invoke(body)).data.shift.id, saved.data.shift.id);
    assert.equal((await h.invoke({ ...body, request_id: 'overlap-time' })).status, 409);
    assert.equal((await h.invoke({ ...body, request_id: 'backward-time', end_at: body.start_at })).status, 400);
    assert.equal((await h.invoke({ ...body, request_id: 'no-reason-1', reason: '' })).status, 400);
    assert.equal(h.shifts.length, 1);
});

test('simultaneous corrections keep one audit and require refresh before overwriting', async () => {
    const h = harness({ caller: manager, shifts: [sample({ status: 'closed', clock_out_at: '2026-10-09T01:00:00.000Z' })] });
    const body = { action: 'edit_shift', shift_id: 'shift-a', revision: 0,
        start_at: '2026-10-08T22:00:00.000Z', end_at: '2026-10-09T00:00:00.000Z', reason: 'Correction' };
    const results = await Promise.all(['correction-a', 'correction-b'].map(request_id => h.invoke({ ...body, request_id })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(h.shifts[0].audit_trail.length, 1);
});

test('transferred people can end their own old-team shift without exposing another person’s shift', async () => {
    const h = harness({ shifts: [sample({ manager_id: 'old-manager' })] });
    assert.equal((await h.invoke({ action: 'clock_out', shift_id: 'shift-a' })).status, 200);
    const foreign = harness({ shifts: [sample({ manager_id: 'old-manager', rep_user_id: 'someone-else' })] });
    assert.equal((await foreign.invoke({ action: 'clock_out', shift_id: 'shift-a' })).status, 403);
});

test('saving fails closed if account locking is unavailable; reports remain readable', async () => {
    const h = harness({ databaseAvailable: false });
    assert.equal((await h.invoke(rangeBody)).status, 200);
    assert.equal((await h.invoke({ action: 'clock_in', request_id: 'lock-required' })).status, 503);
    assert.equal(h.shifts.length, 0);
});

test('one team timezone governs date bounds, daily hours, presets, and correction inputs across DST', async () => {
    const { clockDateRangeInZone, clockPresetDates } = clockHelpers;
    const spring = clockDateRangeInZone('2026-03-08', '2026-03-08', 'America/New_York');
    const fall = clockDateRangeInZone('2026-11-01', '2026-11-01', 'America/New_York');
    assert.equal(spring.end - spring.start, 23 * 3600000);
    assert.equal(fall.end - fall.start, 25 * 3600000);
    assert.throws(() => clockInputInstant('2026-03-08T02:30:00', 'America/New_York'), /does not exist/);
    assert.equal(clockInputInstant(clockInputValue('2026-11-01T06:30:00.000Z', 'America/New_York'), 'America/New_York', '2026-11-01T06:30:00.000Z'), '2026-11-01T06:30:00.000Z');
    assert.deepEqual(clockPresetDates('this-week', Date.parse('2026-10-09T16:00:00Z'), 'America/Phoenix'), { start: '2026-10-05', end: '2026-10-09' });
    assert.deepEqual(clockPresetDates('last-week', Date.parse('2026-10-09T16:00:00Z'), 'America/Phoenix'), { start: '2026-09-28', end: '2026-10-04' });
    const h = harness({ caller: manager, shifts: [sample({ status: 'closed', clock_in_at: '2026-10-09T06:00:00.000Z', clock_out_at: '2026-10-09T08:00:00.000Z' })] });
    assert.equal((await h.invoke({ action: 'set_timezone', timezone: 'America/Phoenix' })).status, 200);
    const report = await h.invoke({ action: 'report', start_date: '2026-10-09', end_date: '2026-10-09' });
    assert.equal(report.data.range.start_at, '2026-10-09T07:00:00.000Z');
    const personal = await harness({ shifts: h.shifts }).invoke({ action: 'report', start_date: '2026-10-09', end_date: '2026-10-09' });
    assert.equal(personal.data.completed_today_ms, 3600000);
    assert.equal((await harness().invoke({ action: 'set_timezone', timezone: 'UTC' })).status, 403);
});

test('completed totals and both CSV formats exclude open time and preserve selected-period allocation', () => {
    const range = clockHelpers.clockDateRangeInZone('2026-10-09', '2026-10-09', 'America/Phoenix');
    const now = range.start + 5 * 3600000;
    const shifts = [sample({ status: 'closed', clock_in_at: new Date(range.start - 3600000).toISOString(), clock_out_at: new Date(range.start + 90 * 60000).toISOString(), adjusted: true }),
        sample({ id: 'open-shift', clock_in_at: range.start_at })];
    const summaries = clockHelpers.summarizeTimeClock(shifts, range, now);
    assert.equal(summaries[0].completed_ms, 90 * 60000);
    assert.equal(summaries[0].completed_shifts, 1);
    assert.equal(summaries[0].open_shifts, 1);
    const totals = timesheetCsv(shifts, range, now, 'America/Phoenix');
    assert.ok(totals.includes('"1.50"'));
    const details = timesheetCsv(shifts, range, now, 'America/Phoenix', 'details');
    assert.ok(details.includes('"2.50","1.50","America/Phoenix","Yes"'));
    assert.equal(details.includes('open-shift'), false);
    assert.equal(details.split('\r\n').length, 2);
});

test('manager screen renders personal controls and the whole live roster before filtered timesheets, including its empty state', () => {
    const range = clockHelpers.clockDateRangeInZone('2026-10-05', '2026-10-09');
    const data = { success: true, can_clock: true, timezone: 'America/Phoenix', range, completed_today_ms: 0,
        people: [{ id: manager.id, name: 'Morgan', can_add: true }, { id: rep.id, name: 'Alex', can_add: true }],
        active_shifts: [sample(), sample({ id: 'manager-shift', rep_user_id: manager.id, rep_name: 'Morgan' })], shifts: [], current_shift: null };
    const native = ({ children }) => React.createElement('div', null, children);
    const Button = ({ children, onClick, disabled, 'aria-label': label }) => React.createElement('button', { onClick, disabled, 'aria-label': label }, children);
    const modules = {
        react: React,
        '@tanstack/react-query': { useQuery: () => ({ data, dataUpdatedAt: Date.now(), isSuccess: true }), useMutation: () => ({ mutate() {} }), useQueryClient: () => ({}) },
        'lucide-react': new Proxy({}, { get: () => () => null }), sonner: { toast: {} }, '@/api/base44Client': { base44: {} },
        '@/components/ui/button': { Button }, '@/components/ui/input': { Input: native },
        '@/components/ui/dialog': { Dialog: () => null, DialogContent: native, DialogHeader: native, DialogTitle: native, DialogDescription: native },
        '@/components/ui/dropdown-menu': { DropdownMenu: native, DropdownMenuContent: native, DropdownMenuItem: native, DropdownMenuTrigger: native },
        '@/lib/timeClock': { ...clockHelpers, clockInputValue, clockInputInstant },
    };
    const code = ts.transpileModule(fs.readFileSync('src/components/team/TimeClockTab.jsx', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, require: name => modules[name], navigator: { onLine: true }, crypto: { randomUUID: () => 'render-test-id' } });
    const render = () => renderToStaticMarkup(React.createElement(exports.default, { currentUser: manager, managerId: manager.id, canManage: true, activeTeamCode: 'OTHER_TEAM' }));
    let html = render();
    assert.match(html, /Your shift/);
    assert.match(html, /Clock in/);
    assert.match(html, /Clocked in now · 2/);
    assert.ok(html.indexOf('Clocked in now') < html.indexOf('Timesheets'));
    assert.match(html, /Alex/);
    assert.match(html, /Morgan/);
    assert.doesNotMatch(html, /Clock in when you start canvassing|Canvassers clock in and out here/);
    data.active_shifts = [];
    html = render();
    assert.match(html, /Clocked in now · 0/);
    assert.match(html, /No one is clocked in\./);
});
