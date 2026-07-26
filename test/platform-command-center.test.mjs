import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const functionPath = 'base44/functions/adminDiagnostics/entry.ts';
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadFunction({ base44, env = {}, expose = '' } = {}) {
  const source = `${readSource(functionPath)}\n${expose}`;
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: functionPath,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${functionPath} contains TypeScript errors`);

  let handler;
  class StripeStub {
    constructor() {
      throw new Error('Stripe must not be instantiated without a configured server secret.');
    }
  }
  const sandbox = {
    console,
    createClientFromRequest: () => base44,
    Stripe: StripeStub,
    Date,
    Intl,
    Math,
    Map,
    Set,
    Request,
    Response,
    URL,
    Deno: {
      env: { get: (key) => env[key] ?? null },
      serve: (registered) => { handler = registered; },
    },
  };
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, sandbox, { filename: functionPath });
  return { handler, sandbox };
}

function emptyService() {
  const emptyEntity = { list: async () => [] };
  return {
    entities: {
      User: emptyEntity,
      InteractionLog: emptyEntity,
      CanvasHouseEvent: emptyEntity,
      CanvasHousePin: emptyEntity,
      TeamMember: emptyEntity,
      SavedRoute: emptyEntity,
    },
  };
}

async function invoke(handler, body = { view: 'platform_command_center' }) {
  const response = await handler(new Request('https://firstknock.test/api/functions/getPlatformCommandCenter', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { response, body: await response.json() };
}

test('global command center rejects accounts outside the private HQ audience', async () => {
  for (const caller of [
    null,
    { id: 'manager_1', role: 'user', app_role: 'manager', is_owner: true },
    { id: 'custom_admin', role: 'user', app_role: 'admin' },
    { id: 'other_platform_admin', role: 'admin', email: 'other-admin@example.com' },
    { id: 'wrong_id', role: 'admin', email: 'baysecurity@gmail.com' },
  ]) {
    let serviceRead = false;
    const base44 = {
      auth: { me: async () => caller },
      asServiceRole: {
        entities: new Proxy({}, { get: () => ({ list: async () => { serviceRead = true; return []; } }) }),
      },
    };
    const { handler } = loadFunction({ base44 });
    const result = await invoke(handler);
    assert.equal(result.response.status, caller ? 403 : 401);
    assert.equal(serviceRead, false);
  }
});

test('Cory receives complete empty app metrics while Stripe is unconfigured', async () => {
  const base44 = {
    auth: { me: async () => ({ id: '695eb764b077190880be21df', role: 'admin', email: 'BaySecurity@gmail.com' }) },
    asServiceRole: emptyService(),
  };
  const { handler } = loadFunction({ base44 });
  const result = await invoke(handler);

  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.rep.periods.all.knocks, 0);
  assert.equal(result.body.rep.periods.all.close_rate, 0);
  assert.equal(result.body.rep.periods.all.door_close_rate, 0);
  assert.equal(result.body.rep.periods.all.decision_maker_conversations, 0);
  assert.equal(result.body.rep.periods.all.talk_rate, 0);
  assert.equal(result.body.rep.periods.all.decision_maker_close_rate, 0);
  assert.equal(result.body.source_health.stripe.status, 'unavailable');
  assert.equal(result.body.business.metrics, null);
  assert.equal(result.body.business.customer_count, 0);
  assert.equal(result.body.business.customers_truncated, false);
  assert.equal(result.body.rep.adoption.time_zone, 'UTC');
});

test('Christian is an explicit private HQ viewer without a platform-admin role', async () => {
  const base44 = {
    auth: { me: async () => ({ id: '6978c7229935cf40cde25086', role: 'owner', email: 'Christian@nativapest.com' }) },
    asServiceRole: emptyService(),
  };
  const { handler } = loadFunction({ base44 });
  const result = await invoke(handler);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, true);
});

test('client and server HQ gates name only the same two immutable operator IDs', () => {
  const backend = readSource(functionPath);
  const frontend = readSource('src/lib/platformDashboardAccess.js');
  for (const id of ['695eb764b077190880be21df', '6978c7229935cf40cde25086']) {
    assert.match(backend, new RegExp(id));
    assert.match(frontend, new RegExp(id));
  }
  assert.doesNotMatch(backend, /user\.role === 'admin'/);
  assert.doesNotMatch(frontend, /getAccountRole|VITE_PLATFORM_DASHBOARD_ALLOWED_EMAILS|baysecurity|nativapest/);
});

test('platform adoption keeps inactive users and counts only real, timezone-correct activity', () => {
  const base44 = { auth: { me: async () => null } };
  const { sandbox } = loadFunction({
    base44,
    expose: 'globalThis.__buildIdentityMaps = buildIdentityMaps; globalThis.__buildAdoptionActivity = buildAdoptionActivity;',
  });
  const users = [
    { id: 'rep_1', email: 'active@example.com', full_name: 'Active Rep' },
    { id: 'rep_2', email: 'inactive@example.com', full_name: 'Inactive Rep' },
    { id: 'user_3', email: 'independent@example.com', full_name: 'Independent User' },
  ];
  const members = [
    { id: 'member_1', manager_id: 'manager_1', email: 'active@example.com', name: 'Active Rep' },
    { id: 'member_2', user_id: 'rep_2', manager_id: 'manager_1', email: 'inactive@example.com', name: 'Inactive Rep' },
  ];
  const maps = sandbox.__buildIdentityMaps(users, members);
  const interactionLogs = [
    {
      manager_id: 'manager_1',
      created_by: 'old-active-email@example.com',
      logged_by_user_id: 'rep_1',
      parsed_status: 'SOLD',
      source: 'voice',
      created_date: '2026-07-20T06:30:00.000Z',
    },
    {
      manager_id: 'manager_1',
      created_by: 'active@example.com',
      logged_by_user_id: 'rep_1',
      parsed_status: 'CALLBACK',
      counts_as_knock: false,
      source: 'voice',
      created_date: '2026-07-20T06:45:00.000Z',
    },
    {
      manager_id: 'manager_1',
      created_by: 'active@example.com',
      parsed_status: 'CALLBACK',
      source: 'csv_history_import',
      created_date: '2026-07-20T07:30:00.000Z',
    },
  ];
  const canvasEvents = [
    {
      manager_id: 'manager_1',
      actor_user_id: 'rep_1',
      actor_team_member_id: 'member_1',
      write_status: 'committed',
      outcome: 'callback',
      client_recorded_at: '2026-07-20T18:00:00.000Z',
    },
    {
      manager_id: 'manager_1',
      actor_user_id: 'rep_1',
      actor_team_member_id: 'member_1',
      write_status: 'pending',
      outcome: 'sale',
      client_recorded_at: '2026-07-21T18:00:00.000Z',
    },
  ];

  const result = plain(sandbox.__buildAdoptionActivity(
    interactionLogs,
    canvasEvents,
    maps,
    members,
    users,
    Date.parse('2026-07-25T12:00:00-07:00'),
    'America/Phoenix',
    14
  ));
  const active = result.reps.find((rep) => rep.key === 'user:rep_1');
  const inactive = result.reps.find((rep) => rep.key === 'user:rep_2');
  const independent = result.reps.find((rep) => rep.key === 'user:user_3');

  assert.equal(result.time_zone, 'America/Phoenix');
  assert.equal(result.reps.length, 3);
  assert.equal(result.reps.some((rep) => rep.key.startsWith('member:')), false);
  assert.equal(active.days['2026-07-19'].logs, 2);
  assert.equal(active.days['2026-07-19'].doors, 1);
  assert.equal(active.days['2026-07-19'].sales, 1);
  assert.equal(active.days['2026-07-19'].callbacks, 1);
  assert.equal(active.days['2026-07-20'].logs, 1);
  assert.equal(active.days['2026-07-20'].callbacks, 1);
  assert.equal(active.days['2026-07-20'].canvas_logs, 1);
  assert.equal(active.days['2026-07-21'], undefined);
  assert.deepEqual(inactive.days, {});
  assert.deepEqual(independent.days, {});
});

test('close rate combines Precision and committed Canvas outcomes and excludes clear-to-Todo rows', () => {
  const now = Date.now();
  const base44 = { auth: { me: async () => null } };
  const { sandbox } = loadFunction({
    base44,
    expose: 'globalThis.__buildIdentityMaps = buildIdentityMaps; globalThis.__buildRepPeriod = buildRepPeriod;',
  });
  const users = [{ id: 'rep_user', email: 'rep@example.com', full_name: 'Winning Rep' }];
  const members = [{ id: 'member_1', user_id: 'rep_user', manager_id: 'manager_1', email: 'rep@example.com', name: 'Winning Rep' }];
  const maps = sandbox.__buildIdentityMaps(users, members);
  const interactionLogs = [
    { id: 'sold', manager_id: 'manager_1', created_by: 'REP@example.com', address_hash: 'door_1', parsed_status: 'SOLD', sale_amount: 120, created_date: new Date(now - 1000).toISOString() },
    { id: 'no-answer', manager_id: 'manager_1', created_by: 'rep@example.com', address_hash: 'door_2', parsed_status: 'NO_ANSWER', created_date: new Date(now - 2000).toISOString() },
    { id: 'cleared', manager_id: 'manager_1', created_by: 'rep@example.com', address_hash: 'door_2', parsed_status: 'ELIGIBLE', created_date: new Date(now - 500).toISOString() },
  ];
  const canvasEvents = [
    { id: 'canvas-sale', manager_id: 'manager_1', actor_user_id: 'rep_user', actor_team_member_id: 'member_1', pin_id: 'pin_1', write_status: 'committed', outcome: 'sale', client_recorded_at: new Date(now - 3000).toISOString() },
    { id: 'canvas-callback', manager_id: 'manager_1', actor_user_id: 'rep_user', actor_team_member_id: 'member_1', pin_id: 'pin_2', write_status: 'committed', outcome: 'callback', client_recorded_at: new Date(now - 4000).toISOString() },
    { id: 'pending-sale', manager_id: 'manager_1', actor_user_id: 'rep_user', actor_team_member_id: 'member_1', pin_id: 'pin_3', write_status: 'pending', outcome: 'sale', client_recorded_at: new Date(now - 5000).toISOString() },
  ];

  const result = plain(sandbox.__buildRepPeriod(interactionLogs, canvasEvents, maps, null, now));
  assert.equal(result.knocks, 4);
  assert.equal(result.confirmed_sales, 2);
  assert.equal(result.close_rate, 50);
  assert.equal(result.door_close_rate, 50);
  assert.equal(result.decision_maker_conversations, 3);
  assert.equal(result.talk_rate, 75);
  assert.equal(result.decision_maker_close_rate, 66.7);
  assert.equal(result.recorded_sales_volume, 120);
  assert.equal(result.valued_sales, 1);
  assert.equal(result.unvalued_sales, 1);
  assert.equal(result.leaderboard.length, 1);
  assert.equal(result.leaderboard[0].email, 'rep@example.com');
  assert.equal(result.leaderboard[0].decision_maker_conversations, 3);
  assert.equal(result.leaderboard[0].talk_rate, 75);
  assert.equal(result.leaderboard[0].door_close_rate, 50);
  assert.equal(result.leaderboard[0].decision_maker_close_rate, 66.7);
});

test('decision-maker metrics use conservative real-conversation outcomes and ignore audit rows', () => {
  const now = Date.now();
  const base44 = { auth: { me: async () => null } };
  const { sandbox } = loadFunction({
    base44,
    expose: 'globalThis.__buildIdentityMaps = buildIdentityMaps; globalThis.__buildRepPeriod = buildRepPeriod; globalThis.__buildRepTrend = buildRepTrend;',
  });
  const users = [{ id: 'rep_user', email: 'rep@example.com', full_name: 'Measured Rep' }];
  const maps = sandbox.__buildIdentityMaps(users, []);
  const precision = [
    ['sold', 'SOLD', 'Signed today'],
    ['hard-no', 'HARD_NO', 'Not interested'],
    ['callback', 'CALLBACK', 'Come back Friday'],
    ['qualified', 'QUALIFIED', 'Interested homeowner'],
    ['no-answer', 'NO_ANSWER', 'No answer'],
    ['dm-away', 'DM_NOT_HOME', 'Decision maker not home'],
    ['not-moved', 'NOT_MOVED_IN', 'Not moved in'],
    ['legacy-misread', 'HARD_NO', 'Imported from CSV: No Answer'],
    ['unknown', 'OTHER', 'Left a flyer'],
    ['cleared', 'ELIGIBLE', 'Decision cleared'],
  ].map(([id, parsed_status, raw_input_text], index) => ({
    id,
    manager_id: 'manager_1',
    created_by: 'rep@example.com',
    address_hash: `door-${index}`,
    parsed_status,
    raw_input_text,
    sale_amount: parsed_status === 'SOLD' ? 100 : 0,
    created_date: new Date(now - (index + 1) * 1000).toISOString(),
  }));
  precision.push({
    id: 'photo-audit',
    manager_id: 'manager_1',
    created_by: 'rep@example.com',
    address_hash: 'door-photo',
    parsed_status: 'CALLBACK',
    raw_input_text: 'Photo proof uploaded',
    image_url: 'https://files.example/proof.jpg',
    created_date: new Date(now - 12_000).toISOString(),
  });
  const canvas = ['sale', 'appointment', 'callback', 'not_interested', 'no_answer', 'do_not_knock'].map((outcome, index) => ({
    id: `canvas-${outcome}`,
    manager_id: 'manager_1',
    actor_user_id: 'rep_user',
    pin_id: `pin-${index}`,
    write_status: 'committed',
    outcome,
    client_recorded_at: new Date(now - (20 + index) * 1000).toISOString(),
  }));
  canvas.push({
    id: 'canvas-pending-sale',
    manager_id: 'manager_1',
    actor_user_id: 'rep_user',
    pin_id: 'pin-pending',
    write_status: 'pending',
    outcome: 'sale',
    client_recorded_at: new Date(now - 30_000).toISOString(),
  });

  const period = plain(sandbox.__buildRepPeriod(precision, canvas, maps, null, now));
  const trend = plain(sandbox.__buildRepTrend(precision, canvas, now, 30));
  assert.equal(period.knocks, 14);
  assert.equal(period.confirmed_sales, 2);
  assert.equal(period.decision_maker_conversations, 8);
  assert.equal(period.door_close_rate, 14.3);
  assert.equal(period.talk_rate, 57.1);
  assert.equal(period.decision_maker_close_rate, 25);
  assert.equal(period.callbacks, 2);
  assert.equal(period.leaderboard[0].decision_maker_contacts, 8);
  assert.equal(period.leaderboard[0].contact_rate, 57.1);
  assert.equal(trend.reduce((sum, day) => sum + day.knocks, 0), 14);
  assert.equal(trend.reduce((sum, day) => sum + day.decision_maker_conversations, 0), 8);
  assert.equal(trend.reduce((sum, day) => sum + day.sales, 0), 2);
});

test('Nick Cohen and Cory Larson stay in global totals and live sales but not the leaderboard', () => {
  const now = Date.now();
  const base44 = { auth: { me: async () => null } };
  const { sandbox } = loadFunction({
    base44,
    expose: 'globalThis.__buildIdentityMaps = buildIdentityMaps; globalThis.__buildRepPeriod = buildRepPeriod; globalThis.__buildRecentRepSales = buildRecentRepSales;',
  });
  const users = [
    { id: 'nick', email: 'nick@example.com', full_name: '  NICK   COHEN ' },
    { id: 'nicholas', email: 'nicholas@example.com', full_name: 'Nicholas Cohen' },
    { id: 'cory', email: 'cory@example.com', full_name: 'Cory Larson' },
    { id: 'visible', email: 'visible@example.com', full_name: 'Visible Rep' },
  ];
  const maps = sandbox.__buildIdentityMaps(users, []);
  const logs = users.map((user, index) => ({
    id: `sale-${index}`,
    manager_id: 'manager_1',
    created_by: user.email,
    address_hash: `door-${index}`,
    parsed_status: 'SOLD',
    sale_amount: 99,
    created_date: new Date(now - index * 1000).toISOString(),
  }));

  const period = plain(sandbox.__buildRepPeriod(logs, [], maps, null, now));
  const feed = plain(sandbox.__buildRecentRepSales(logs, [], maps));
  assert.equal(period.knocks, 4);
  assert.equal(period.confirmed_sales, 4);
  assert.equal(period.active_reps, 4);
  assert.equal(period.decision_maker_conversations, 4);
  assert.equal(period.talk_rate, 100);
  assert.equal(period.decision_maker_close_rate, 100);
  assert.deepEqual(period.leaderboard.map((rep) => rep.email), ['visible@example.com']);
  assert.deepEqual(new Set(feed.map((item) => item.email)), new Set(users.map((user) => user.email)));
});

test('current sold doors use latest Precision state and current Canvas pin state', () => {
  const base44 = { auth: { me: async () => null } };
  const { sandbox } = loadFunction({
    base44,
    expose: 'globalThis.__countCurrentSoldDoors = countCurrentSoldDoors;',
  });
  const logs = [
    { manager_id: 'm1', address_hash: 'a', parsed_status: 'SOLD', created_date: '2026-07-01T00:00:00Z' },
    { manager_id: 'm1', address_hash: 'a', parsed_status: 'ELIGIBLE', created_date: '2026-07-02T00:00:00Z' },
    { manager_id: 'm1', address_hash: 'b', parsed_status: 'SOLD', created_date: '2026-07-03T00:00:00Z' },
  ];
  const pins = [{ latest_outcome: 'sale' }, { latest_outcome: 'callback' }];
  assert.deepEqual(plain(sandbox.__countCurrentSoldDoors(logs, pins)), { total: 2, precision: 1, canvas: 1 });
});

test('MRR normalizes monthly and annual recurring items', () => {
  const base44 = { auth: { me: async () => null } };
  const { sandbox } = loadFunction({
    base44,
    expose: 'globalThis.__monthlyRecurringCents = monthlyRecurringCents;',
  });
  const cents = sandbox.__monthlyRecurringCents({
    items: {
      data: [
        { quantity: 3, price: { unit_amount: 1900, recurring: { interval: 'month', interval_count: 1 } } },
        { quantity: 1, price: { unit_amount: 120000, recurring: { interval: 'year', interval_count: 1 } } },
      ],
    },
  });
  assert.equal(cents, 15700);
});

test('Stripe metrics retain established subscribers during renewal processing and exclude never-paid accounts', () => {
  const base44 = { auth: { me: async () => null } };
  const { sandbox } = loadFunction({
    base44,
    expose: 'globalThis.__buildStripeAnalytics = buildStripeAnalytics;',
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const monthlyItem = (amount) => ({ quantity: 1, price: { unit_amount: amount, recurring: { interval: 'month', interval_count: 1 } } });
  const stripeData = {
    status: 'live',
    livemode: true,
    subscriptions: [
      { id: 'sub_paid', status: 'active', current_period_start: nowSeconds - 100, current_period_end: nowSeconds + 2500000, created: nowSeconds - 5000, customer: { id: 'cus_paid', email: 'paid@example.com', name: 'Paid Account' }, items: { data: [monthlyItem(9900)] }, metadata: { subscription_tier: 'precision' } },
      { id: 'sub_trial', status: 'trialing', current_period_start: nowSeconds - 100, current_period_end: nowSeconds + 2500000, trial_end: nowSeconds + 500000, created: nowSeconds - 4000, customer: { id: 'cus_trial', email: 'trial@example.com', name: 'Trial Account' }, items: { data: [monthlyItem(1900)] }, metadata: { subscription_tier: 'canvas' } },
      { id: 'sub_unpaid', status: 'active', current_period_start: nowSeconds - 100, current_period_end: nowSeconds + 2500000, created: nowSeconds - 3000, customer: { id: 'cus_unpaid', email: 'unpaid@example.com' }, items: { data: [monthlyItem(9900)] }, metadata: { subscription_tier: 'precision' } },
      { id: 'sub_renewing', status: 'active', current_period_start: nowSeconds - 50, current_period_end: nowSeconds + 2500000, created: nowSeconds - 900000, customer: { id: 'cus_renewing', email: 'renewing@example.com' }, items: { data: [monthlyItem(9900)] }, metadata: { subscription_tier: 'precision' } },
      { id: 'sub_past_due', status: 'past_due', current_period_start: nowSeconds - 100, current_period_end: nowSeconds + 2500000, created: nowSeconds - 3000000, customer: { id: 'cus_past_due', email: 'risk@example.com' }, items: { data: [monthlyItem(9900)] }, metadata: { subscription_tier: 'precision' } },
    ],
    invoices: [
      { id: 'in_paid', status: 'paid', amount_paid: 9900, currency: 'usd', customer: 'cus_paid', subscription: 'sub_paid', period_start: nowSeconds - 200, period_end: nowSeconds + 2500000, created: nowSeconds - 60, status_transitions: { paid_at: nowSeconds - 60 }, lines: { data: [] } },
      { id: 'in_prior_period', status: 'paid', amount_paid: 9900, currency: 'usd', customer: 'cus_renewing', parent: { subscription_details: { subscription: 'sub_renewing' } }, period_start: nowSeconds - 2500100, period_end: nowSeconds - 50, created: nowSeconds - 2500000, status_transitions: { paid_at: nowSeconds - 2499900 }, lines: { data: [{ period: { start: nowSeconds - 2500100, end: nowSeconds - 50 }, parent: { subscription_item_details: { subscription: 'sub_renewing' } } }] } },
      { id: 'in_past_due_history', status: 'paid', amount_paid: 9900, currency: 'usd', customer: 'cus_past_due', subscription: 'sub_past_due', period_start: nowSeconds - 3000000, period_end: nowSeconds - 100, created: nowSeconds - 2999900, status_transitions: { paid_at: nowSeconds - 2999800 }, lines: { data: [] } },
    ],
    customers: [
      { id: 'cus_paid' },
      { id: 'cus_trial' },
      { id: 'cus_unpaid' },
      { id: 'cus_renewing' },
      { id: 'cus_past_due' },
    ],
    events: [],
  };
  const trend = [{ date: new Date().toISOString().slice(0, 10), stripe_revenue: 0 }];
  const result = plain(sandbox.__buildStripeAnalytics(stripeData, [], trend));

  assert.equal(result.metrics.paying_customers, 2);
  assert.equal(result.metrics.current_period_paid_customers, 1);
  assert.equal(result.metrics.active_trials, 1);
  assert.equal(result.metrics.active_beta_accounts, 0);
  assert.equal(result.metrics.active_trials_and_beta, 1);
  assert.equal(result.metrics.total_stripe_customers, 5);
  assert.equal(result.metrics.mrr, 297);
  assert.equal(result.metrics.trial_mrr_pipeline, 19);
  assert.equal(result.metrics.gross_collected, 297);
  assert.equal(result.metrics.paid_seats, 2);
  assert.equal(result.metrics.trial_seats, 1);
  assert.equal(result.metrics.past_due_customers, 1);
  assert.equal(result.customer_count, 5);
  assert.equal(result.customers_truncated, false);
  assert.equal(result.trend[0].stripe_revenue, 99);
});

test('active immutable beta grants appear separately from Stripe trials and expire closed', () => {
  const now = Date.now();
  const base44 = { auth: { me: async () => null } };
  const users = [{ id: 'beta_user', email: 'beta@example.com', full_name: 'Beta Operator', subscription_tier: 'canvas' }];
  const grant = {
    grant_id: 'beta-live-1',
    status: 'active',
    precision_limit: 1000,
    canvas_seats: 1,
    starts_at: new Date(now - 60_000).toISOString(),
    ends_at: new Date(now + 60_000).toISOString(),
  };
  const { sandbox } = loadFunction({
    base44,
    env: { BETA_ACCESS_GRANTS: JSON.stringify({ version: 1, grants: { beta_user: grant } }) },
    expose: 'globalThis.__activeBetaGrants = activeBetaGrants; globalThis.__buildStripeAnalytics = buildStripeAnalytics;',
  });
  const grants = sandbox.__activeBetaGrants(users, now);
  const stripeData = { status: 'live', livemode: true, customers: [], subscriptions: [], invoices: [], events: [] };
  const result = plain(sandbox.__buildStripeAnalytics(stripeData, users, [], grants));

  assert.equal(result.metrics.active_trials, 0);
  assert.equal(result.metrics.active_beta_accounts, 1);
  assert.equal(result.metrics.active_trials_and_beta, 1);
  assert.equal(result.metrics.beta_seats, 1);
  assert.equal(result.customers[0].status, 'beta');
  assert.equal(result.customers[0].billing_source, 'firstknock_beta');
  assert.equal(sandbox.__activeBetaGrants(users, now + 60_001).length, 0);

  const monthlyItem = { quantity: 1, price: { unit_amount: 9900, recurring: { interval: 'month', interval_count: 1 } } };
  const paidStripeData = {
    ...stripeData,
    customers: [{ id: 'cus_beta', email: 'beta@example.com' }],
    subscriptions: [{ id: 'sub_beta', status: 'active', current_period_start: Math.floor(now / 1000) - 10, current_period_end: Math.floor(now / 1000) + 2_500_000, customer: 'cus_beta', items: { data: [monthlyItem] }, metadata: { base44_user_id: 'beta_user' } }],
    invoices: [{ id: 'in_beta', amount_paid: 9900, currency: 'usd', subscription: 'sub_beta', customer: 'cus_beta', period_start: Math.floor(now / 1000) - 20, period_end: Math.floor(now / 1000) + 2_500_000, created: Math.floor(now / 1000) - 5, lines: { data: [] } }],
  };
  const deduplicated = plain(sandbox.__buildStripeAnalytics(paidStripeData, users, [], grants));
  assert.equal(deduplicated.metrics.paying_customers, 1);
  assert.equal(deduplicated.metrics.active_beta_accounts, 0);
});

test('dashboard polls on a bounded cadence, validates complete data, and independently guards the page', () => {
  const page = readSource('src/admin/AdminDashboard.jsx');
  const styles = readSource('src/admin/admin.css');
  const layout = readSource('src/Layout.jsx');
  const app = readSource('src/App.jsx');
  const vite = readSource('vite.config.js');
  assert.match(page, /canViewPlatformDashboard\(user\)/);
  assert.match(page, /refetchInterval: 60_000/);
  assert.match(page, /isCompletePlatformPayload\(payload\)/);
  assert.match(page, /Array\.isArray\(payload\?\.rep\?\.adoption\?\.reps\)/);
  assert.match(page, /adminDiagnostics', \{[\s\S]*view: 'platform_command_center'[\s\S]*time_zone: timeZone/);
  assert.match(page, /\/hq\/index\.html/);
  assert.match(page, /scopeLabel="Platform"/);
  assert.match(page, /data\?\.rep\?\.adoption/);
  assert.doesNotMatch(page, /continuityHealth/);
  assert.match(page, /Trials & beta/);
  assert.match(page, /active_trials_and_beta/);
  assert.match(page, /confirmed sales \/ \$\{formatNumber\(rep\?\.knocks\)\} logged knocks/);
  assert.match(page, /Decision-maker runway/);
  assert.match(page, /Cash vault/);
  assert.match(page, /decision_maker_conversations/);
  assert.match(page, /decision_maker_close_rate/);
  assert.match(page, /Talk %/);
  assert.match(page, /Door close %/);
  assert.match(page, /DM close %/);
  assert.match(page, /aria-current=\{active \? 'date'/);
  assert.doesNotMatch(page, /from 'recharts'/);
  assert.match(styles, /\.dimensional-prism::before/);
  assert.match(styles, /\.dimensional-prism::after/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.doesNotMatch(layout, /AdminDashboard|Mission Control/);
  assert.doesNotMatch(app, /AdminDashboard/);
  assert.match(app, /import\.meta\.glob\('\.\/pages\/\*\.\{jsx,js\}'\)/);
  assert.match(vite, /hq: resolve\(process\.cwd\(\), 'hq\/index\.html'\)/);
});

test('HQ uses card-native mobile leaderboard and customer book views', () => {
  const page = readSource('src/admin/AdminDashboard.jsx');
  const styles = readSource('src/admin/admin.css');
  const leaderboardMobileStart = page.indexOf('data-hq-view="leaderboard-mobile"');
  const leaderboardDesktopStart = page.indexOf('data-hq-view="leaderboard-desktop"');
  const customersMobileStart = page.indexOf('data-hq-view="customers-mobile"');
  const customersDesktopStart = page.indexOf('data-hq-view="customers-desktop"');
  assert.ok(leaderboardMobileStart > -1 && leaderboardDesktopStart > leaderboardMobileStart);
  assert.ok(customersMobileStart > -1 && customersDesktopStart > customersMobileStart);

  const leaderboardMobile = page.slice(leaderboardMobileStart, leaderboardDesktopStart);
  const customersMobile = page.slice(customersMobileStart, customersDesktopStart);
  assert.match(leaderboardMobile, /className="mobile-record-list lg:hidden"/);
  assert.match(leaderboardMobile, /data-hq-card="rep"/);
  assert.match(leaderboardMobile, /DM close/);
  assert.match(leaderboardMobile, /Door close/);
  assert.match(leaderboardMobile, /Talk rate/);
  assert.match(leaderboardMobile, /decision_maker_conversations/);
  assert.match(leaderboardMobile, /recorded_sales_volume/);
  assert.doesNotMatch(leaderboardMobile, /<table|min-w-\[/);

  assert.match(customersMobile, /className="mobile-record-list lg:hidden"/);
  assert.match(customersMobile, /data-hq-card="customer"/);
  assert.match(customersMobile, /customer\.plan/);
  assert.match(customersMobile, /customer\.status/);
  assert.match(customersMobile, /customer\.seats/);
  assert.match(customersMobile, /customer\.mrr/);
  assert.match(customersMobile, /customerMilestone\(customer\)/);
  assert.doesNotMatch(customersMobile, /<table|min-w-\[/);

  assert.match(page, /data-hq-view="leaderboard-desktop" className="hidden max-h-\[540px\] overflow-auto lg:block"/);
  assert.match(page, /data-hq-view="customers-desktop" className="hidden max-h-\[560px\] overflow-auto lg:block"/);
  assert.equal((page.match(/\{leaderboard\.map\(/g) || []).length, 2);
  assert.equal((page.match(/\{customers\.map\(/g) || []).length, 2);
  assert.match(page, /aria-label="Search rep leaderboard"/);
  assert.match(page, /aria-label="Search customer book"/);
  assert.match(page, /aria-pressed=\{customerFilter === option\.id\}/);
  assert.match(page, /rank: index \+ 1/);
  assert.match(styles, /\.mobile-record-card/);
  assert.match(styles, /@media \(min-width: 768px\) and \(max-width: 1023px\)/);
});

test('HQ navigation exposes every section as one responsive accessible tab', () => {
  const page = readSource('src/admin/AdminDashboard.jsx');
  const styles = readSource('src/admin/admin.css');
  const expectedSections = ['field', 'adoption', 'revenue', 'pulse', 'cash', 'leaderboard', 'live', 'customers', 'operations'];
  assert.match(page, /role="tablist" aria-label="FirstKnock HQ sections"/);
  assert.match(page, /role="tab"/);
  assert.match(page, /aria-selected=\{selected\}/);
  assert.match(page, /aria-controls=\{`hq-panel-\$\{tab\.id\}`\}/);
  assert.match(page, /tabIndex=\{selected \? 0 : -1\}/);
  assert.match(page, /window\.addEventListener\('hashchange'/);
  assert.match(page, /window\.addEventListener\('popstate'/);
  assert.match(page, /window\.history\.pushState/);
  assert.match(page, /window\.history\.replaceState/);
  assert.match(page, /nextSectionForKey\(activeTab, event\.key\)/);
  assert.equal((page.match(/<PeriodSwitcher period=\{period\} onChange=\{setPeriod\} \/>/g) || []).length, 2);

  const panelIds = [...page.matchAll(/id="hq-panel-([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(panelIds, expectedSections);
  for (const sectionId of expectedSections) {
    assert.match(page, new RegExp(`id="hq-panel-${sectionId}" role="tabpanel" aria-labelledby="hq-tab-${sectionId}"`));
    assert.match(page, new RegExp(`hidden=\\{activeTab !== '${sectionId}'\\}`));
  }

  assert.match(styles, /\.hq-tab-shell\s*\{[^}]*position: sticky/s);
  assert.match(styles, /\.hq-tab-strip\s*\{[^}]*overflow-x: auto/s);
  assert.match(styles, /\.hq-tab-strip\s*\{[^}]*overscroll-behavior-inline: contain/s);
  assert.match(styles, /\.hq-tab-strip\s*\{[^}]*scroll-snap-type: x proximity/s);
  assert.match(styles, /grid-template-columns: repeat\(9, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.hq-tab-button\s*\{[^}]*min-height: 44px/s);
  assert.match(styles, /\.hq-tab-button:focus-visible/);
  assert.match(styles, /\.hq-tab-panel\[hidden\]\s*\{[^}]*display: none/s);
});
