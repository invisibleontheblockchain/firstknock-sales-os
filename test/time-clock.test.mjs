import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { TimeClockError, timeClockRange, shiftOverlaps, shiftMilliseconds, durationLabel } from '../base44/shared/timeClock.js';
import { clockDateRange, timeClockCsv } from '../src/lib/timeClock.js';

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

function harness({ caller = rep, savedUser = caller, members = [member], activeShiftId = '', shifts = [], users = [], ignoreShiftScope = false, failActivation = false, failClear = false } = {}) {
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
            updateMany: async () => { throw Object.assign(new Error('Bulk user update not allowed'), { status: 405 }); } },
        TeamMember: { filter: filter(members), get: async id => structuredClone(members.find(row => row.id === id)), updateMany: updateMany(members, 'TeamMember') },
        TimeShift: { filter: filter(shifts, ignoreShiftScope), get: async id => structuredClone(shifts.find(shift => shift.id === id)),
            create: async data => { const row = { id: `new-${shifts.length}`, ...data }; shifts.push(row); return structuredClone(row); },
            updateMany: updateMany(shifts, 'TimeShift') },
    };
    const code = ts.transpileModule(fs.readFileSync('base44/functions/timeClock/entry.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replace(/^import .*;\s*$/gm, '');
    vm.runInNewContext(code, { createClientFromRequest: () => ({ auth: { me: async () => caller }, asServiceRole: { entities: service } }),
        Deno: { serve: fn => { handler = fn; } }, TimeClockError, timeClockRange, shiftOverlaps, Response, console: { error() {} } });
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
    const shifts = [sample(), sample({ id: 'foreign', manager_id: 'other-manager' })];
    const h = harness({ caller: manager, shifts, members: [{ ...member, status: 'inactive' }], ignoreShiftScope: true,
        activeShiftId: 'shift-a', users: [rep] });
    assert.deepEqual((await h.invoke(rangeBody)).data.shifts.map(shift => shift.id), ['shift-a']);
    assert.equal((await h.invoke({ action: 'close_shift', shift_id: 'foreign' })).status, 403);
    assert.equal((await h.invoke({ action: 'clock_out', shift_id: 'shift-a' })).status, 403);
    const result = await h.invoke({ action: 'close_shift', shift_id: 'shift-a' });
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

test('managers without canvasser membership can report and close shifts but cannot clock in themselves', async () => {
    const h = harness({ caller: manager });
    assert.equal((await h.invoke(rangeBody)).data.can_clock, false);
    assert.equal((await h.invoke({ action: 'clock_in', request_id: 'request-1' })).status, 403);
    assert.equal(h.shifts.length, 0);
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
