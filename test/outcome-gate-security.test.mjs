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

function makeStripeClass(api) {
  return class FakeStripe {
    constructor() {
      return api;
    }
  };
}

function loadHandler({ base44, stripeApi, stripeConfigured = true }) {
  const path = 'base44/functions/recordKnockOutcome/entry.ts';
  const transpiled = ts.transpileModule(readSource(path), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript syntax errors`);

  let handler;
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    Stripe: makeStripeClass(stripeApi),
    Deno: {
      env: {
        get: (name) => name === 'STRIPE_SECRET_KEY' && stripeConfigured ? 'sk_test' : undefined
      },
      serve: (registeredHandler) => { handler = registeredHandler; }
    },
    Request,
    Response,
    TextEncoder,
    crypto: globalThis.crypto,
    setTimeout
  }, { filename: path });
  assert.equal(typeof handler, 'function');
  return handler;
}

function filterMatches(record, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key.startsWith('$')) return true;
    const actual = record[key];
    if (Array.isArray(expected)) return expected.map(String).includes(String(actual));
    return actual === expected;
  });
}

function makeBase44({
  actor = {
    id: 'user_1',
    email: 'user@example.com',
    outcomes_logged: 0,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z'
  },
  users = [],
  memberships = [],
  logs = [],
  routes = [],
  properties = []
} = {}) {
  const usersById = new Map([actor, ...users].map((user) => [String(user.id), { ...user }]));
  const storedLogs = logs.map((log, index) => ({
    id: log.id || `log_existing_${index}`,
    created_date: log.created_date || new Date(Date.now() - 60_000).toISOString(),
    ...log
  }));
  const storedRoutes = new Map(routes.map((route) => [String(route.id), route]));
  let nextLog = storedLogs.length + 1;

  const entityFilter = (records) => async (filter, sort, limit = 500, skip = 0) => {
    let result = records.filter((record) => filterMatches(record, filter));
    if (sort === '-outcome_sequence') {
      result.sort((left, right) => Number(right.outcome_sequence || 0) - Number(left.outcome_sequence || 0));
    } else if (sort === '-created_date') {
      result.sort((left, right) => String(right.created_date || '').localeCompare(String(left.created_date || '')));
    }
    return result.slice(skip, skip + limit);
  };

  const service = {
    User: {
      get: async (id) => usersById.get(String(id)) || null,
      update: async (id, updates) => {
        const user = usersById.get(String(id));
        if (!user) throw new Error('user missing');
        Object.assign(user, updates);
        return user;
      },
      updateMany: async (filter, operation) => {
        const user = usersById.get(String(filter.id));
        if (!user) return { success: true, updated: 0, has_more: false };
        if (
          filter.knock_outcome_lock_token
          && user.knock_outcome_lock_token !== filter.knock_outcome_lock_token
        ) return { success: true, updated: 0, has_more: false };
        if (filter.$or) {
          const expired = !user.knock_outcome_lock_token
            || !user.knock_outcome_lock_expires_at
            || user.knock_outcome_lock_expires_at <= new Date().toISOString();
          if (!expired) return { success: true, updated: 0, has_more: false };
        }
        Object.assign(user, operation.$set || {});
        for (const key of Object.keys(operation.$unset || {})) delete user[key];
        return { success: true, updated: 1, has_more: false };
      }
    },
    TeamMember: {
      filter: entityFilter(memberships)
    },
    InteractionLog: {
      filter: entityFilter(storedLogs),
      get: async (id) => storedLogs.find((log) => String(log.id) === String(id)) || null,
      create: async (value) => {
        const created = {
          id: `log_${nextLog++}`,
          created_date: new Date().toISOString(),
          ...value
        };
        storedLogs.push(created);
        return created;
      },
      update: async (id, updates) => {
        const log = storedLogs.find((item) => String(item.id) === String(id));
        if (!log) throw new Error('interaction missing');
        Object.assign(log, updates);
        return log;
      },
      bulkCreate: async (values) => {
        const created = [];
        for (const value of values) {
          const log = {
            id: `log_${nextLog++}`,
            created_date: new Date().toISOString(),
            ...value
          };
          storedLogs.push(log);
          created.push(log);
        }
        return created;
      }
    },
    MasterProperty: { filter: entityFilter(properties) }
  };

  return {
    base44: {
      auth: { me: async () => actor },
      entities: {
        SavedRoute: {
          get: async (id) => storedRoutes.get(String(id)) || null
        }
      },
      asServiceRole: { entities: service }
    },
    state: { usersById, logs: storedLogs, routes: storedRoutes }
  };
}

function makeStripeApi({
  billingUserId = 'user_1',
  customerId = 'cus_1',
  hasCard = false,
  subscription = null
} = {}) {
  return {
    subscriptions: {
      retrieve: async (id) => {
        if (!subscription || subscription.id !== id) {
          const error = new Error('missing');
          error.raw = { code: 'resource_missing' };
          throw error;
        }
        return subscription;
      },
      search: async () => ({ data: subscription ? [subscription] : [] })
    },
    invoices: {
      retrieve: async () => subscription?.latest_invoice || null
    },
    customers: {
      retrieve: async (id) => ({
        id,
        metadata: { base44_user_id: billingUserId }
      }),
      search: async () => ({
        data: customerId
          ? [{ id: customerId, metadata: { base44_user_id: billingUserId } }]
          : []
      })
    },
    paymentMethods: {
      list: async () => ({ data: hasCard ? [{ id: 'pm_card' }] : [] })
    }
  };
}

function paidSubscription(userId = 'user_1', customer = 'cus_1') {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'sub_paid',
    status: 'active',
    customer,
    trial_end: null,
    current_period_start: now - 3600,
    current_period_end: now + 2_592_000,
    metadata: { base44_user_id: userId },
    latest_invoice: {
      id: 'in_paid',
      subscription: 'sub_paid',
      status: 'paid',
      amount_paid: 9900
    }
  };
}

function requestBody(overrides = {}) {
  return {
    action: 'record',
    idempotency_key: overrides.idempotency_key || 'knock:test-action-0001',
    interaction: {
      address_hash: '123-main|85001',
      raw_input_text: 'No answer',
      parsed_status: 'NO_ANSWER',
      gps_proof_lat: 33.45,
      gps_proof_lng: -112.07,
      ...(overrides.interaction || {})
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => !['interaction', 'idempotency_key'].includes(key))
    )
  };
}

async function invoke(handler, body = requestBody()) {
  const response = await handler(new Request('https://firstknock.online/api/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }));
  return { response, result: await response.json() };
}

test('outcomes 1 through 25 do not require Stripe and commit one protected sequence', async () => {
  const actor = {
    id: 'user_1',
    email: 'user@example.com',
    outcomes_logged: 24,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z'
  };
  const { base44, state } = makeBase44({ actor });
  const stripeApi = {};
  const { response, result } = await invoke(loadHandler({ base44, stripeApi }));

  assert.equal(response.status, 200);
  assert.equal(result.outcomes_logged, 25);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].outcome_sequence, 25);
  assert.equal(state.logs[0].manager_id, actor.id);
  assert.equal(state.logs[0].created_by, actor.email);
  assert.equal(state.usersById.get(actor.id).outcomes_logged, 25);
});

test('attempt 26 ignores a forged cached card flag and blocks when Stripe has no attached card', async () => {
  const actor = {
    id: 'user_1',
    email: 'user@example.com',
    outcomes_logged: 25,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z',
    stripe_customer_id: 'cus_1',
    stripe_card_on_file_confirmed: true
  };
  const { base44, state } = makeBase44({ actor });
  const stripeApi = makeStripeApi({ hasCard: false });
  const { response, result } = await invoke(loadHandler({ base44, stripeApi }));

  assert.equal(response.status, 402);
  assert.equal(result.code, 'card_required');
  assert.equal(result.gate, 'card');
  assert.equal(state.logs.length, 0);
  assert.equal(state.usersById.get(actor.id).stripe_card_on_file_confirmed, false);
});

test('an attached card permits outcomes 26 through 50', async () => {
  const actor = {
    id: 'user_1',
    email: 'user@example.com',
    outcomes_logged: 25,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z',
    stripe_customer_id: 'cus_1'
  };
  const { base44, state } = makeBase44({ actor });
  const { response, result } = await invoke(loadHandler({
    base44,
    stripeApi: makeStripeApi({ hasCard: true })
  }));

  assert.equal(response.status, 200);
  assert.equal(result.outcomes_logged, 26);
  assert.equal(state.logs.length, 1);
});

test('attempt 51 requires a live paid subscription even when a card remains attached', async () => {
  const actor = {
    id: 'user_1',
    email: 'user@example.com',
    outcomes_logged: 50,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z',
    stripe_customer_id: 'cus_1'
  };
  const { base44, state } = makeBase44({ actor });
  const { response, result } = await invoke(loadHandler({
    base44,
    stripeApi: makeStripeApi({ hasCard: true })
  }));

  assert.equal(response.status, 402);
  assert.equal(result.code, 'free_outcome_limit_reached');
  assert.equal(result.gate, 'limit');
  assert.equal(state.logs.length, 0);
});

test('a current positive paid period permits outcomes after 50 without a renewal card', async () => {
  const subscription = paidSubscription();
  const actor = {
    id: 'user_1',
    email: 'user@example.com',
    outcomes_logged: 50,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z',
    subscription_id: subscription.id,
    stripe_customer_id: 'cus_1'
  };
  const { base44, state } = makeBase44({ actor });
  const { response, result } = await invoke(loadHandler({
    base44,
    stripeApi: makeStripeApi({ hasCard: false, subscription })
  }));

  assert.equal(response.status, 200);
  assert.equal(result.outcomes_logged, 51);
  assert.equal(state.logs.length, 1);
});

test('same-key retries are idempotent and changed payloads are rejected', async () => {
  const { base44, state } = makeBase44();
  const handler = loadHandler({ base44, stripeApi: {} });
  const first = await invoke(handler);
  const retry = await invoke(handler);
  const changed = await invoke(handler, requestBody({
    interaction: { parsed_status: 'HARD_NO', raw_input_text: 'Not interested' }
  }));

  assert.equal(first.response.status, 200);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.result.reused, true);
  assert.equal(changed.response.status, 409);
  assert.equal(changed.result.code, 'idempotency_key_reused');
  assert.equal(state.logs.length, 1);
  assert.equal(state.usersById.get('user_1').outcomes_logged, 1);
});

test('qualified voice and CSV outcomes remain valid through the protected service', async () => {
  const { base44, state } = makeBase44();
  const { response, result } = await invoke(loadHandler({ base44, stripeApi: {} }), requestBody({
    idempotency_key: 'knock:qualified-action-0001',
    interaction: { parsed_status: 'QUALIFIED', raw_input_text: 'Interested' }
  }));

  assert.equal(response.status, 200);
  assert.equal(result.outcomes_logged, 1);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].parsed_status, 'QUALIFIED');
});

test('team reps inherit only an exactly verified manager billing account', async () => {
  const actor = {
    id: 'rep_1',
    email: 'rep@example.com',
    team_manager_id: 'manager_1',
    outcomes_logged: 25,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z'
  };
  const manager = {
    id: 'manager_1',
    email: 'manager@example.com',
    stripe_customer_id: 'cus_manager'
  };
  const membership = {
    id: 'member_1',
    user_id: actor.id,
    manager_id: manager.id,
    email: actor.email,
    role: 'rep',
    status: 'active'
  };
  const { base44, state } = makeBase44({ actor, users: [manager], memberships: [membership] });
  const { response } = await invoke(loadHandler({
    base44,
    stripeApi: makeStripeApi({
      billingUserId: manager.id,
      customerId: 'cus_manager',
      hasCard: true
    })
  }));

  assert.equal(response.status, 200);
  assert.equal(state.logs[0].manager_id, manager.id);
  assert.equal(state.logs[0].logged_by_user_id, actor.id);
});

test('SOLD snapshots persist while rep, tenant, and route identity are server-derived', async () => {
  const actor = {
    id: 'user_1',
    email: 'user@example.com',
    full_name: 'Verified Rep',
    outcomes_logged: 0,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z'
  };
  const route = {
    id: 'route_1',
    name: 'Verified Route',
    manager_id: actor.id,
    created_by: actor.email,
    property_hashes: ['123-main|85001']
  };
  const { base44, state } = makeBase44({ actor, routes: [route] });
  const { response } = await invoke(loadHandler({ base44, stripeApi: {} }), requestBody({
    interaction: {
      parsed_status: 'SOLD',
      raw_input_text: 'Sold annual service',
      sale_amount: 749.5,
      sale_date: '2026-07-23T15:30:00-07:00',
      property_address: '123 Main St, Phoenix, AZ 85001',
      homeowner_name: 'Ryan Customer',
      route_id: route.id,
      rep_id: 'spoofed_rep',
      rep_name: 'Spoofed Name',
      route_name: 'Spoofed Route',
      manager_id: 'other_tenant',
      created_by: 'attacker@example.com'
    }
  }));

  assert.equal(response.status, 200);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].sale_date, '2026-07-23T22:30:00.000Z');
  assert.equal(state.logs[0].property_address, '123 Main St, Phoenix, AZ 85001');
  assert.equal(state.logs[0].homeowner_name, 'Ryan Customer');
  assert.equal(state.logs[0].rep_id, actor.id);
  assert.equal(state.logs[0].rep_name, actor.full_name);
  assert.equal(state.logs[0].route_name, route.name);
  assert.equal(state.logs[0].manager_id, actor.id);
  assert.equal(state.logs[0].created_by, actor.email);
});

test('invalid SOLD snapshot timestamps fail validation before persistence', async () => {
  const { base44, state } = makeBase44();
  const handler = loadHandler({ base44, stripeApi: {} });
  const { response, result } = await invoke(handler, requestBody({
    interaction: {
      parsed_status: 'SOLD',
      raw_input_text: 'Sold',
      sale_date: 'tomorrow afternoon'
    }
  }));
  const impossibleDate = await invoke(handler, requestBody({
    idempotency_key: 'knock:invalid-date-0002',
    interaction: {
      parsed_status: 'SOLD',
      raw_input_text: 'Sold',
      sale_date: '2026-02-30T12:00:00Z'
    }
  }));

  assert.equal(response.status, 400);
  assert.equal(result.code, 'invalid_outcome');
  assert.equal(impossibleDate.response.status, 400);
  assert.equal(impossibleDate.result.code, 'invalid_outcome');
  assert.equal(state.logs.length, 0);
});

test('clear_decision creates an explicit non-metered Todo workflow transition', async () => {
  const { base44, state } = makeBase44();
  const { response, result } = await invoke(loadHandler({ base44, stripeApi: {} }), {
    action: 'clear_decision',
    idempotency_key: 'clear:test-action-0001',
    interaction: {
      address_hash: '123-main|85001',
      raw_input_text: 'Decision cleared',
      parsed_status: 'HARD_NO'
    }
  });

  assert.equal(response.status, 200);
  assert.equal(result.outcomes_logged, 0);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].parsed_status, 'ELIGIBLE');
  assert.equal(state.logs[0].source, 'decision_clear');
  assert.equal(state.logs[0].counts_as_knock, false);
  assert.equal(state.logs[0].counts_toward_free_limit, false);
  assert.equal(state.logs[0].workflow_action, 'CLEAR_TO_TODO');
  assert.equal(state.logs[0].workflow_bucket, 'TODO');
  assert.equal(state.logs[0].outcome_sequence, undefined);
  assert.equal(state.usersById.get('user_1').outcomes_logged, 0);
});

test('workflow_transition validates route aliases, maps status server-side, and retries idempotently', async () => {
  const actor = {
    id: 'user_1',
    email: 'user@example.com',
    outcomes_logged: 7,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z'
  };
  const route = {
    id: 'route_1',
    name: 'Assigned Route',
    manager_id: actor.id,
    created_by: actor.email,
    property_hashes: ['legacy-123', '456-oak|85002']
  };
  const properties = [{
    id: 'property_1',
    address_hash: '123-main|85001',
    legacy_hash: 'legacy-123'
  }];
  const body = {
    action: 'workflow_transition',
    route_id: route.id,
    address_hashes: ['456-oak|85002', '123-main|85001'],
    workflow_action: 'BULK_MOVE_TO_RE_KNOCK',
    idempotency_key: 'workflow:test-action-0001'
  };
  const { base44, state } = makeBase44({ actor, routes: [route], properties });
  const handler = loadHandler({ base44, stripeApi: {} });
  const first = await invoke(handler, body);
  const retry = await invoke(handler, {
    ...body,
    address_hashes: [...body.address_hashes].reverse()
  });
  const changed = await invoke(handler, {
    ...body,
    workflow_action: 'BULK_MOVE_TO_CALLBACK'
  });

  assert.equal(first.response.status, 200);
  assert.equal(first.result.updated_count, 2);
  assert.equal(first.result.reused, false);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.result.updated_count, 2);
  assert.equal(retry.result.reused, true);
  assert.equal(changed.response.status, 409);
  assert.equal(changed.result.code, 'idempotency_key_reused');
  assert.equal(state.logs.length, 2);
  for (const log of state.logs) {
    assert.equal(log.parsed_status, 'ELIGIBLE');
    assert.equal(log.raw_input_text, 'Workflow update - moved to Re-Knock');
    assert.equal(log.workflow_action, 'BULK_MOVE_TO_RE_KNOCK');
    assert.equal(log.workflow_bucket, 'RE_KNOCK');
    assert.equal(log.source, 'workflow_transition');
    assert.equal(log.counts_as_knock, false);
    assert.equal(log.counts_toward_free_limit, false);
    assert.equal(log.outcome_sequence, undefined);
    assert.equal(log.manager_id, actor.id);
    assert.equal(log.logged_by_user_id, actor.id);
  }
  assert.equal(state.usersById.get(actor.id).outcomes_logged, 7);
});

test('workflow_transition rejects unassigned team routes and off-route hashes', async () => {
  const actor = {
    id: 'rep_1',
    email: 'rep@example.com',
    team_manager_id: 'manager_1',
    outcomes_logged: 0,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z'
  };
  const manager = { id: 'manager_1', email: 'manager@example.com' };
  const membership = {
    id: 'member_1',
    user_id: actor.id,
    manager_id: manager.id,
    email: actor.email,
    role: 'rep',
    status: 'active'
  };
  const route = {
    id: 'route_1',
    manager_id: manager.id,
    assigned_to: 'member_2',
    property_hashes: ['123-main|85001']
  };
  const { base44, state } = makeBase44({
    actor,
    users: [manager],
    memberships: [membership],
    routes: [route]
  });
  const handler = loadHandler({ base44, stripeApi: {} });
  const denied = await invoke(handler, {
    action: 'workflow_transition',
    route_id: route.id,
    address_hashes: ['123-main|85001'],
    workflow_action: 'BULK_MOVE_TO_TODO',
    idempotency_key: 'workflow:denied-0001'
  });

  assert.equal(denied.response.status, 403);
  assert.equal(denied.result.code, 'route_not_assigned');
  assert.equal(state.logs.length, 0);

  route.assigned_to = membership.id;
  const offRoute = await invoke(handler, {
    action: 'workflow_transition',
    route_id: route.id,
    address_hashes: ['999-other|85009'],
    workflow_action: 'BULK_MOVE_TO_TODO',
    idempotency_key: 'workflow:off-route-0001'
  });
  assert.equal(offRoute.response.status, 403);
  assert.equal(offRoute.result.code, 'property_not_on_route');
  assert.equal(state.logs.length, 0);
});

test('edit_sale changes only validated sale fields for the creator', async () => {
  const original = {
    id: 'sale_1',
    address_hash: '123-main|85001',
    raw_input_text: 'Sold',
    parsed_status: 'SOLD',
    sale_amount: 500,
    manager_id: 'user_1',
    logged_by_user_id: 'user_1',
    created_by: 'user@example.com',
    outcome_sequence: 12,
    counts_toward_free_limit: true,
    counts_as_knock: true,
    idempotency_key: 'original-key',
    request_hash: 'original-hash',
    route_id: 'route_1'
  };
  const { base44, state } = makeBase44({ logs: [original] });
  const handler = loadHandler({ base44, stripeApi: {} });
  const edited = await invoke(handler, {
    action: 'edit_sale',
    interaction_id: original.id,
    parsed_status: 'CALLBACK',
    raw_input_text: 'Outcome corrected to CALLBACK | Note: Call Friday',
    sale_amount: null
  });

  assert.equal(edited.response.status, 200);
  assert.equal(state.logs[0].parsed_status, 'CALLBACK');
  assert.equal(state.logs[0].raw_input_text, 'Outcome corrected to CALLBACK | Note: Call Friday');
  assert.equal(state.logs[0].sale_amount, null);
  for (const field of [
    'address_hash',
    'manager_id',
    'logged_by_user_id',
    'created_by',
    'outcome_sequence',
    'counts_toward_free_limit',
    'counts_as_knock',
    'idempotency_key',
    'request_hash',
    'route_id'
  ]) {
    assert.equal(state.logs[0][field], original[field], field);
  }

  const prohibited = await invoke(handler, {
    action: 'edit_sale',
    interaction_id: original.id,
    raw_input_text: 'Changed',
    description: 'Attempted extra mutation'
  });
  assert.equal(prohibited.response.status, 400);
  assert.equal(prohibited.result.code, 'invalid_sale_edit');
});

test('edit_sale permits the exact tenant manager but denies a different rep in that tenant', async () => {
  const sale = {
    id: 'sale_1',
    address_hash: '123-main|85001',
    raw_input_text: 'Sold',
    parsed_status: 'SOLD',
    manager_id: 'manager_1',
    logged_by_user_id: 'rep_2',
    created_by: 'rep2@example.com'
  };
  const managerActor = {
    id: 'manager_1',
    email: 'manager@example.com',
    outcomes_logged: 0,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z'
  };
  const managerBase44 = makeBase44({ actor: managerActor, logs: [sale] });
  const managerEdit = await invoke(loadHandler({
    base44: managerBase44.base44,
    stripeApi: {}
  }), {
    action: 'edit_sale',
    interaction_id: sale.id,
    sale_amount: 900
  });
  assert.equal(managerEdit.response.status, 200);
  assert.equal(managerBase44.state.logs[0].sale_amount, 900);

  const repActor = {
    id: 'rep_1',
    email: 'rep1@example.com',
    team_manager_id: managerActor.id,
    outcomes_logged: 0,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z'
  };
  const membership = {
    id: 'member_1',
    user_id: repActor.id,
    manager_id: managerActor.id,
    email: repActor.email,
    role: 'rep',
    status: 'active'
  };
  const repBase44 = makeBase44({
    actor: repActor,
    users: [managerActor],
    memberships: [membership],
    logs: [sale]
  });
  const repEdit = await invoke(loadHandler({
    base44: repBase44.base44,
    stripeApi: {}
  }), {
    action: 'edit_sale',
    interaction_id: sale.id,
    sale_amount: 1
  });
  assert.equal(repEdit.response.status, 403);
  assert.equal(repEdit.result.code, 'sale_edit_denied');
  assert.equal(repBase44.state.logs[0].sale_amount, undefined);
});

test('Stripe outages fail closed at the gated boundary without creating a log', async () => {
  const actor = {
    id: 'user_1',
    email: 'user@example.com',
    outcomes_logged: 25,
    outcomes_reconciled_at: '2026-07-23T00:00:00.000Z'
  };
  const { base44, state } = makeBase44({ actor });
  const { response, result } = await invoke(loadHandler({
    base44,
    stripeApi: {},
    stripeConfigured: false
  }));

  assert.equal(response.status, 503);
  assert.equal(result.code, 'billing_verification_unavailable');
  assert.equal(state.logs.length, 0);
});

test('outcome and identity fields are service-owned and legacy bypass endpoints are retired', () => {
  const interaction = JSON.parse(readSource('base44/entities/InteractionLog.jsonc'));
  const user = JSON.parse(readSource('base44/entities/User.jsonc'));
  const home = readSource('src/pages/Home.jsx');
  const rep = readSource('src/pages/RepHome.jsx');
  const csv = readSource('src/components/dashboard/CsvUploader.jsx');
  const elevated = readSource('base44/functions/elevateAccount/entry.ts');
  const offline = readSource('base44/functions/syncOfflineQueue/entry.ts');
  const lookup = readSource('base44/functions/getRoutePropertiesByHashes/entry.ts');

  assert.equal(interaction.rls.create.user_condition.id, '__service_role_only__');
  assert.equal(interaction.rls.update.user_condition.id, '__service_role_only__');
  assert.ok(interaction.properties.parsed_status.enum.includes('QUALIFIED'));
  for (const field of [
    'app_role',
    'is_owner',
    'subscription_status',
    'subscription_paid_confirmed',
    'stripe_customer_id',
    'stripe_card_on_file_confirmed',
    'outcomes_logged'
  ]) {
    assert.equal(user.properties[field].rls.write.user_condition.role, 'admin', field);
  }
  assert.doesNotMatch(`${home}\n${rep}\n${csv}`, /InteractionLog\.(?:create|bulkCreate|update)\(/);
  assert.match(`${home}\n${rep}\n${csv}`, /functions\.invoke\(['"]recordKnockOutcome['"]/);
  assert.match(elevated, /status:\s*410/);
  assert.doesNotMatch(elevated, /asServiceRole/);
  assert.match(offline, /status:\s*410/);
  assert.match(lookup, /const canonicalAuthorizedHashes = missingWorkspaceHashes\.filter[\s\S]*FROM properties p/);
});

test('assigned-route hydration uses the verified tenant manager and guards canonical fallback by route membership', () => {
  const lookup = readSource('base44/functions/getRoutePropertiesByHashes/entry.ts');

  assert.match(lookup, /authorizedRoute\s*=\s*await base44\.entities\.SavedRoute\.get\(routeId\)/);
  assert.match(lookup, /manager_id is the SavedRoute tenant key/);
  assert.match(lookup, /resolveRouteTenantEmail\(/);
  assert.match(lookup, /findLegacyVisibleRoute\(/);
  assert.match(lookup, /WHERE wp\.user_email = \$\{workspaceEmail\}/);
  assert.match(
    lookup,
    /const canonicalAuthorizedHashes = missingWorkspaceHashes\.filter[\s\S]*FROM properties p/
  );
  assert.doesNotMatch(
    lookup,
    /const targetEmail\s*=\s*user\.role\s*===\s*'admin'\s*&&\s*body\.user_email\s*\?\s*body\.user_email\s*:\s*user\.email/
  );
});
