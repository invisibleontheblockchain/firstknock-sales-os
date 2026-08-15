import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

function loadHandler(
  base44,
  milestoneWriter = async () => null,
  path = 'base44/functions/redeemInviteCode/entry.ts',
) {
  const transpiled = ts.transpileModule(readSource(path), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript syntax errors`);

  let handler;
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    writeAcquisitionMilestone: milestoneWriter,
    Deno: { serve: (registeredHandler) => { handler = registeredHandler; } },
    Request,
    Response,
  }, { filename: path });
  assert.equal(typeof handler, 'function');
  return handler;
}

function matches(record, query) {
  return Object.entries(query || {}).every(([key, value]) => {
    if (key === 'email') return String(record[key] || '').toLowerCase() === String(value || '').toLowerCase();
    return record[key] === value;
  });
}

function makeBase44(authUser, seed = {}) {
  const state = {
    users: structuredClone(seed.users || []),
    members: structuredClone(seed.members || []),
    codes: structuredClone(seed.codes || []),
    userUpdates: [],
    memberUpdates: [],
    createdMembers: [],
    codeUpdates: [],
    authUpdates: [],
  };

  const entity = (records, updateLog) => ({
    filter: async (query, _sort, limit = 50) => records.filter((record) => matches(record, query)).slice(0, limit),
    get: async (id) => records.find((record) => record.id === id) || null,
    update: async (id, updates) => {
      const record = records.find((candidate) => candidate.id === id);
      if (!record) throw new Error(`Missing record ${id}`);
      Object.assign(record, structuredClone(updates));
      updateLog.push({ id, updates: structuredClone(updates) });
      return structuredClone(record);
    },
  });

  const users = entity(state.users, state.userUpdates);
  const members = entity(state.members, state.memberUpdates);
  members.create = async (data) => {
    const record = { id: `member_${state.members.length + 1}`, ...structuredClone(data) };
    state.members.push(record);
    state.createdMembers.push(structuredClone(record));
    return structuredClone(record);
  };
  const codes = entity(state.codes, state.codeUpdates);

  const base44 = {
    auth: {
      me: async () => structuredClone(authUser),
      updateMe: async (updates) => {
        state.authUpdates.push(structuredClone(updates));
        throw new Error('team ownership must not use auth.updateMe');
      },
    },
    asServiceRole: {
      entities: {
        User: users,
        TeamMember: members,
        InviteCode: codes,
      },
    },
  };

  return { base44, state };
}

function manager(id, email) {
  return {
    id,
    email,
    app_role: 'manager',
    subscription_paid_confirmed: true,
    total_seats: 5,
  };
}

async function invoke(handler, body) {
  const response = await handler(new Request('https://app.example.com/api/redeemInviteCode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { response, data: await response.json() };
}

test('invite redemption writes the authenticated User tenant link with service role', async () => {
  const authUser = { id: 'rep_1', email: 'Rep@Example.com', full_name: 'Rep One' };
  const { base44, state } = makeBase44(authUser, {
    users: [authUser, manager('manager_1', 'manager@example.com')],
    members: [
      { id: 'old_member', email: 'rep@example.com', user_id: 'rep_1', manager_id: 'old_manager', role: 'rep', status: 'active' },
    ],
    codes: [
      { id: 'code_1', code: 'JOIN12', role: 'rep', is_active: true, linked_user_id: 'manager_1', max_uses: 5, used_count: 0 },
    ],
  });

  const milestones = [];
  const { response, data } = await invoke(loadHandler(
    base44,
    async (_service, payload) => milestones.push(structuredClone(payload)),
  ), { code: ' join12 ' });

  assert.equal(response.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.manager_id, 'manager_1');
  assert.equal(state.authUpdates.length, 0);
  assert.deepEqual(state.userUpdates, [{
    id: 'rep_1',
    updates: { app_role: 'rep', team_manager_id: 'manager_1', team_invite_code: 'JOIN12' },
  }]);
  assert.equal(state.createdMembers.length, 1);
  assert.equal(state.createdMembers[0].manager_id, 'manager_1');
  assert.equal(state.members.find((member) => member.id === 'old_member').manager_id, 'old_manager');
  assert.deepEqual(state.codeUpdates, [{ id: 'code_1', updates: { used_count: 1 } }]);
  assert.deepEqual(
    milestones.map((milestone) => milestone.eventName),
    ['role_selected', 'invite_redeemed'],
  );
});

test('returning rep claims a manager-created email roster record without client-selected tenant input', async () => {
  const authUser = { id: 'rep_1', email: 'rep@example.com' };
  const { base44, state } = makeBase44(authUser, {
    users: [authUser, manager('manager_1', 'manager@example.com')],
    members: [{
      id: 'member_1',
      email: 'rep@example.com',
      manager_id: 'manager_1',
      role: 'rep',
      status: 'active',
      created_by: 'manager@example.com',
      invite_code: 'OLD123',
    }],
  });

  const milestones = [];
  const { response, data } = await invoke(loadHandler(
    base44,
    async (_service, payload) => milestones.push(structuredClone(payload)),
  ), {
    action: 'claim_existing',
    manager_id: 'attacker_manager',
    team_member_id: 'attacker_member',
  });

  assert.equal(response.status, 200);
  assert.equal(data.claimed_existing, true);
  assert.equal(data.manager_id, 'manager_1');
  assert.deepEqual(state.memberUpdates, [{ id: 'member_1', updates: { user_id: 'rep_1' } }]);
  assert.deepEqual(state.userUpdates, [{
    id: 'rep_1',
    updates: { app_role: 'rep', team_manager_id: 'manager_1', team_invite_code: 'OLD123' },
  }]);
  assert.equal(state.authUpdates.length, 0);
  assert.deepEqual(
    milestones.map((milestone) => milestone.eventName),
    ['role_selected'],
  );
});

test('already-linked returning rep remains claimable without mutable creator metadata', async () => {
  const authUser = { id: 'rep_1', email: 'rep@example.com' };
  const { base44, state } = makeBase44(authUser, {
    users: [authUser, manager('manager_1', 'manager@example.com')],
    members: [{
      id: 'member_1',
      email: 'rep@example.com',
      user_id: 'rep_1',
      manager_id: 'manager_1',
      role: 'rep',
      status: 'active',
    }],
  });

  const milestones = [];
  const { response, data } = await invoke(loadHandler(
    base44,
    async (_service, payload) => milestones.push(structuredClone(payload)),
  ), { action: 'claim_existing' });

  assert.equal(response.status, 200);
  assert.equal(data.manager_id, 'manager_1');
  assert.equal(state.memberUpdates.length, 0);
  assert.equal(state.userUpdates[0].updates.team_manager_id, 'manager_1');
  assert.deepEqual(
    milestones.map((milestone) => milestone.eventName),
    ['role_selected'],
  );
});

test('claim-existing rejects an untrusted email-only roster record', async () => {
  const authUser = { id: 'rep_1', email: 'rep@example.com' };
  const { base44, state } = makeBase44(authUser, {
    users: [authUser, manager('manager_1', 'manager@example.com')],
    members: [{
      id: 'spoofed_member',
      email: 'rep@example.com',
      manager_id: 'manager_1',
      role: 'rep',
      status: 'active',
      created_by: 'attacker@example.com',
    }],
  });

  const { response, data } = await invoke(loadHandler(base44), { action: 'claim_existing' });

  assert.equal(response.status, 404);
  assert.match(data.error, /No active team membership could be verified/);
  assert.equal(state.memberUpdates.length, 0);
  assert.equal(state.userUpdates.length, 0);
});

test('claim-existing fails closed when multiple verified teams match', async () => {
  const authUser = { id: 'rep_1', email: 'rep@example.com' };
  const { base44, state } = makeBase44(authUser, {
    users: [
      authUser,
      manager('manager_1', 'manager1@example.com'),
      manager('manager_2', 'manager2@example.com'),
    ],
    members: [
      { id: 'member_1', email: 'rep@example.com', manager_id: 'manager_1', role: 'rep', status: 'active', created_by: 'manager1@example.com' },
      { id: 'member_2', email: 'rep@example.com', manager_id: 'manager_2', role: 'rep', status: 'active', created_by: 'manager2@example.com' },
    ],
  });

  const { response, data } = await invoke(loadHandler(base44), { action: 'claim_existing' });

  assert.equal(response.status, 409);
  assert.match(data.error, /More than one team membership/);
  assert.equal(state.memberUpdates.length, 0);
  assert.equal(state.userUpdates.length, 0);
});

test('invite redemption rejects legacy manager or admin role codes', async () => {
  for (const role of ['manager', 'admin']) {
    const authUser = { id: `rep_${role}`, email: `${role}@example.com` };
    const { base44, state } = makeBase44(authUser, {
      users: [authUser, manager('manager_1', 'manager@example.com')],
      codes: [{ id: `code_${role}`, code: `ROLE_${role.toUpperCase()}`, role, is_active: true, linked_user_id: 'manager_1' }],
    });

    const { response, data } = await invoke(loadHandler(base44), { code: `ROLE_${role}` });

    assert.equal(response.status, 403);
    assert.match(data.error, /Only rep invite codes/);
    assert.equal(state.createdMembers.length, 0);
    assert.equal(state.memberUpdates.length, 0);
    assert.equal(state.userUpdates.length, 0);
  }
});

test('manager role selection emits one milestone only when the role is first assigned', async () => {
  const user = { id: 'manager_new', email: 'new.manager@example.com' };
  const updates = [];
  const milestones = [];
  const base44 = {
    auth: { me: async () => structuredClone(user) },
    asServiceRole: {
      entities: {
        User: {
          get: async () => structuredClone(user),
          update: async (_id, value) => {
            updates.push(structuredClone(value));
            Object.assign(user, structuredClone(value));
            return structuredClone(user);
          },
        },
        TeamMember: { filter: async () => [] },
      },
    },
  };
  const handler = loadHandler(
    base44,
    async (_service, payload) => milestones.push(structuredClone(payload)),
    'base44/functions/createManagerWorkspace/entry.ts',
  );

  const first = await handler(new Request('https://firstknock.online/api/create-manager', {
    method: 'POST',
  }));
  const reused = await handler(new Request('https://firstknock.online/api/create-manager', {
    method: 'POST',
  }));

  assert.equal(first.status, 200);
  assert.equal(reused.status, 200);
  assert.deepEqual(updates, [{ app_role: 'manager' }]);
  assert.equal(milestones.length, 1);
  assert.equal(milestones[0].eventName, 'role_selected');
  assert.equal(milestones[0].workspaceManagerId, user.id);
});

test('RoleSelect delegates both rep claims and manager workspace role writes to trusted functions', () => {
  const source = readSource('src/pages/RoleSelect.jsx');
  const backend = readSource('base44/functions/redeemInviteCode/entry.ts');
  const managerBackend = readSource('base44/functions/createManagerWorkspace/entry.ts');
  const userSchema = JSON.parse(readSource('base44/entities/User.jsonc'));

  assert.match(source, /functions\.invoke\(['"]redeemInviteCode['"], \{ action: ['"]claim_existing['"] \}\)/);
  assert.match(source, /functions\.invoke\(['"]createManagerWorkspace['"], \{\}\)/);
  assert.doesNotMatch(source, /team_manager_id/);
  assert.doesNotMatch(source, /auth\.updateMe\(\{\s*app_role/);
  assert.match(backend, /service\.entities\.User\.update\(user\.id/);
  assert.doesNotMatch(backend, /auth\.updateMe/);
  assert.match(managerBackend, /asServiceRole\.entities\.User\.update\(user\.id/);
  assert.deepEqual(userSchema.properties.app_role.rls.write, { user_condition: { role: 'admin' } });
});

test('invite-code identity fields are manager-owned and role escalation is service-only', () => {
  const schema = JSON.parse(readSource('base44/entities/InviteCode.jsonc'));
  const ownerOrAdmin = {
    $or: [
      { 'data.linked_user_id': '{{user.id}}' },
      { user_condition: { role: 'admin' } },
    ],
  };
  for (const field of ['linked_user_id', 'code', 'is_active', 'max_uses']) {
    assert.deepEqual(schema.properties[field].rls.write, ownerOrAdmin, `${field} must stay tenant-owned`);
  }
  assert.deepEqual(schema.properties.role.rls.write, {
    $or: [
      { $and: [
        { 'data.linked_user_id': '{{user.id}}' },
        { 'data.role': 'rep' },
      ] },
      { user_condition: { role: 'admin' } },
    ],
  });
  assert.deepEqual(schema.properties.used_count.rls.write, { user_condition: { role: 'admin' } });
});
