import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { loadAuthorizedTeamRoster, TeamRosterError } from '../base44/shared/teamRosterAuthorization.js';
import { buildTeamRoster } from '../base44/shared/teamRoster.js';
import { buildTeamLeaderboard } from '../base44/shared/teamLeaderboard.js';

const manager = { id: 'manager', app_role: 'manager', full_name: 'Manager', email: 'manager@example.com', territory_zip_codes: ['85001'] };
const rep = { id: 'rep', app_role: 'rep', email: 'rep@example.com', team_manager_id: manager.id };
const member = { id: 'member', user_id: rep.id, manager_id: manager.id, name: 'Rep', email: rep.email,
    role: 'rep', status: 'active', phone: 'private', invite_code: 'private-code', private_notes: 'private-notes' };

function clientFor({ identity = rep, savedUser = rep, members = [member], logs = [], ignoreScope = false } = {}) {
    const calls = [];
    const project = (row, fields) => fields ? Object.fromEntries(fields.filter(field => row[field] !== undefined).map(field => [field, row[field]])) : row;
    const client = { auth: { me: async () => { calls.push('auth'); return identity; } },
        functions: { invoke: async () => assert.fail('roster authorization must not make a nested function call') },
        asServiceRole: { entities: {
            User: {
                filter: async query => { calls.push({ users: query.id }); return [savedUser, manager]
                    .filter((user, index, users) => user && query.id.includes(user.id) && users.findIndex(value => value?.id === user.id) === index); },
                get: async id => { calls.push({ user: id }); return id === manager.id ? manager : null; },
            },
            TeamMember: { filter: async (query, sort, limit, skip, fields) => {
                calls.push({ members: query, fields });
                return (ignoreScope ? members : members.filter(row => row.manager_id === query.manager_id))
                    .slice(skip, skip + limit).map(row => project(row, fields));
            } },
            InteractionLog: { filter: async (query, sort, limit, skip, fields) => {
                calls.push({ logs: query, fields });
                return logs.slice(skip, skip + limit).map(row => project(row, fields));
            } },
        } },
    };
    return { client, calls };
}

test('roster checks saved caller and manager together while keeping rep contact data private', async () => {
    const { client, calls } = clientFor();
    const roster = await loadAuthorizedTeamRoster(client);
    assert.equal(roster.manager_id, manager.id);
    assert.equal(calls.length, 3, 'auth + one saved-account read + membership page');
    assert.deepEqual(calls[1].users, [rep.id, manager.id]);
    for (const key of ['phone', 'invite_code', 'private_notes']) assert.equal(roster.members[0][key], undefined);
    assert.equal(roster.manager.assigned_zip_codes, undefined);
});

test('manager retains full roster and territory controls', async () => {
    const roster = await loadAuthorizedTeamRoster(clientFor({ identity: manager, savedUser: manager }).client);
    assert.equal(roster.members[0].phone, member.phone);
    assert.deepEqual(roster.manager.assigned_zip_codes, ['85001']);
});

test('forged auth privilege and stale token tenant hints do not change saved account scope', async () => {
    const { client, calls } = clientFor({ identity: { ...rep, app_role: 'manager', role: 'admin', is_owner: true, team_manager_id: 'foreign' } });
    const roster = await loadAuthorizedTeamRoster(client);
    assert.equal(roster.manager_id, manager.id);
    assert.equal(roster.members[0].private_notes, undefined);
    assert.ok(calls.some(call => call.user === manager.id));
});

test('membership revocation is effective on the very next request without cached authorization', async () => {
    const members = [{ ...member }];
    const { client } = clientFor({ members });
    await loadAuthorizedTeamRoster(client);
    members[0].status = 'inactive';
    await assert.rejects(loadAuthorizedTeamRoster(client), error => error instanceof TeamRosterError && error.status === 403);
    await assert.rejects(loadAuthorizedTeamRoster(clientFor({ identity: null }).client), error => error.status === 401);
});

test('foreign roster rows are filtered and every page remains tenant-scoped', async () => {
    const members = Array.from({ length: 501 }, (_, i) => ({ ...member, id: `member-${i}`, user_id: i ? `rep-${i}` : rep.id }));
    members.push({ ...member, id: 'foreign', manager_id: 'foreign' });
    const { client, calls } = clientFor({ members, ignoreScope: true });
    const roster = await loadAuthorizedTeamRoster(client);
    assert.equal(roster.members.length, 501);
    assert.equal(calls.filter(call => call.members).length, 2);
    assert.ok(calls.filter(call => call.members).every(call => call.members.manager_id === manager.id));
});

function leaderboardHandler(client) {
    let handler;
    const source = readFileSync(new URL('../base44/functions/getTeamLeaderboard/entry.ts', import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*;\s*$/gm, '');
    vm.runInNewContext(code, { createClientFromRequest: () => client, loadAuthorizedTeamRoster, TeamRosterError,
        buildTeamRoster, buildTeamLeaderboard, Response, console, Deno: { serve: value => { handler = value; } } });
    return async body => {
        const response = await handler(new Request('https://example.test/leaderboard', { method: 'POST', body: JSON.stringify(body) }));
        return { status: response.status, data: await response.json() };
    };
}

test('leaderboard uses four direct reads and compact logs while preserving actor identity and metrics', async () => {
    const date = new Date(Date.now() - 1000).toISOString();
    const logs = [
        { id: 'one', manager_id: manager.id, created_date: date, actor_user_id: rep.id, parsed_status: 'SOLD', private_notes: 'secret', gps_proof_lat: 33 },
        { id: 'two', manager_id: manager.id, created_date: date, created_by: rep.email, parsed_status: 'NO_ANSWER' },
        { id: 'workflow', manager_id: manager.id, created_date: date, rep_id: rep.id, parsed_status: 'SOLD', counts_as_knock: false },
        { id: 'foreign', manager_id: 'foreign', created_date: date, rep_id: rep.id, parsed_status: 'SOLD' },
    ];
    const { client, calls } = clientFor({ logs });
    const result = await leaderboardHandler(client)({ period: 'all', time_zone: 'UTC', manager_id: 'foreign' });
    assert.equal(result.status, 200);
    const row = result.data.rows.find(row => row.id === member.id);
    assert.equal(row.metrics.sales, 1);
    assert.equal(row.metrics.knocks, 2);
    assert.equal(row.metrics.conversion, 50);
    assert.equal(calls.length, 4);
    const projected = calls.find(call => call.logs).fields;
    assert.ok(projected.includes('actor_user_id') && projected.includes('rep_id') && projected.includes('counts_as_knock'));
    assert.ok(!projected.includes('private_notes') && !projected.includes('gps_proof_lat') && !projected.includes('raw_input_text'));
    assert.ok(!JSON.stringify(result.data).includes('secret'));
});

test('leaderboard denies revoked members before reading team activity', async () => {
    const { client, calls } = clientFor({ members: [{ ...member, status: 'inactive' }] });
    assert.equal((await leaderboardHandler(client)({ period: 'today' })).status, 403);
    assert.equal(calls.some(call => call.logs), false);
});

test('leaderboard hook serves one-minute cached results across repeated mounts', () => {
    const source = readFileSync(new URL('../src/lib/useTeamLeaderboard.js', import.meta.url), 'utf8');
    const code = source.replace(/^import .*;\s*$/gm, '').replace('export function', 'function');
    const sandbox = { Intl, Date, base44: {}, useQuery: query => query,
        getManagerIdForAccount: () => manager.id, isManagerAccount: () => true, isRepAccount: () => false,
        leaderboardDayKey: () => '2026-10-14' };
    vm.runInNewContext(`${code}\nglobalThis.config = useTeamLeaderboard({ id: 'manager' });`, sandbox);
    assert.equal(sandbox.config.staleTime, 60_000);
    assert.equal(sandbox.config.refetchInterval, 60_000);
    assert.equal(sandbox.config.refetchOnMount, undefined);
});
