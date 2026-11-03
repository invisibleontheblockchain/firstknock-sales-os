import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Base44 now rejects a filter on any field missing from the entity schema
// (400 unknown_filter_field), and one rejected query fails the whole function.
const BUILT_IN_FIELDS = ['id', 'created_date', 'updated_date', 'created_by', 'created_by_id'];
function schemaFields(entity) {
    const source = readFileSync(new URL(`../base44/entities/${entity}.jsonc`, import.meta.url), 'utf8');
    const { config, error } = ts.parseConfigFileTextToJson(`${entity}.jsonc`, source);
    assert.equal(error, undefined);
    return new Set([...BUILT_IN_FIELDS, ...Object.keys(config.properties)]);
}

function strictEntity(entity, rows) {
    const fields = schemaFields(entity);
    return {
        filter: async (query, sort, limit = 50, skip = 0) => {
            for (const field of Object.keys(query)) {
                if (!fields.has(field)) throw Object.assign(new Error(`Unknown field "${field}" in the filter`), { status: 400 });
            }
            return rows.filter(row => Object.entries(query).every(([field, value]) => (
                value && typeof value === 'object' && !Array.isArray(value)
                    ? (!value.$in || value.$in.includes(row[field]))
                    : row[field] === value
            ))).slice(skip, skip + limit);
        },
    };
}

const manager = { id: 'manager', app_role: 'manager', full_name: 'Manager', email: 'manager@example.com' };
const rep = { id: 'rep', app_role: 'rep', email: 'rep@example.com', team_manager_id: manager.id, team_member_id: 'member' };
const member = { id: 'member', user_id: rep.id, manager_id: manager.id, name: 'Rep', email: rep.email, role: 'rep', status: 'active' };

function clientFor(identity) {
    const date = new Date(Date.now() - 1000).toISOString();
    const users = new Map([[manager.id, manager], [rep.id, rep]]);
    return {
        auth: { me: async () => identity },
        asServiceRole: { entities: {
            User: { get: async id => users.get(id) || null },
            TeamMember: strictEntity('TeamMember', [member]),
            SavedRoute: strictEntity('SavedRoute', []),
            InteractionLog: strictEntity('InteractionLog', [
                { id: 'sold', manager_id: manager.id, logged_by_user_id: rep.id, created_date: date, parsed_status: 'SOLD' },
                { id: 'no-answer', manager_id: manager.id, logged_by_user_id: rep.id, created_date: date, parsed_status: 'NO_ANSWER' },
            ]),
        } },
    };
}

function handlerFor(name, client) {
    let handler;
    const source = readFileSync(new URL(`../base44/functions/${name}/entry.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
        .outputText.replace(/^import .*;\s*$/gm, '');
    vm.runInNewContext(code, { createClientFromRequest: () => client, Response, Request, Intl, URL, console,
        Deno: { serve: value => { handler = value; } } });
    return async body => {
        const response = await handler(new Request(`https://example.test/${name}`, { method: 'POST', body: JSON.stringify(body) }));
        return { status: response.status, data: await response.json() };
    };
}

for (const identity of [rep, manager]) {
    test(`team leaderboard loads for a ${identity.app_role} when only schema fields may be filtered`, async () => {
        const result = await handlerFor('getTeamLeaderboard', clientFor(identity))({ period: 'today', time_zone: 'UTC' });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(result.data.manager_id, manager.id);
        assert.equal(result.data.rows.find(row => row.user_id === rep.id)?.metrics.sales, 1);
    });

    test(`team metrics load for a ${identity.app_role} when only schema fields may be filtered`, async () => {
        const result = await handlerFor('getTeamMetrics', clientFor(identity))({ active_team_code: 'all', time_zone: 'UTC' });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(result.data.manager_id, manager.id);
    });
}
