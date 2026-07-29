import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {
  ACQUISITION_STORAGE_KEY,
  buildInstagramTrackedLink,
  captureAcquisitionTouch,
  markStoredAcquisitionSynced,
  parseAcquisitionTouch,
  readStoredAcquisition,
  shouldSyncStoredAcquisition,
} from '../src/lib/acquisitionTracking.js';
import {
  buildAcquisitionEvent,
  getAcquisitionIdentity,
} from '../src/lib/acquisitionEvents.js';
import { INSTAGRAM_FIRST_30_DAYS } from '../src/data/instagramFirst30Days.js';
import { csvCell } from '../src/lib/csvExport.js';
import {
  buildGrowthPace,
  buildGrowthPaceFromReport,
  getGrowthPaceStatus,
} from '../src/lib/growthPace.js';
import { writeAcquisitionMilestone } from '../base44/functions/_shared/acquisitionMilestones.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function recursiveKeys(value, keys = new Set()) {
  if (!value || typeof value !== 'object') return keys;
  if (Array.isArray(value)) {
    for (const item of value) recursiveKeys(item, keys);
    return keys;
  }
  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    recursiveKeys(nested, keys);
  }
  return keys;
}

function loadDenoHandler(path, base44) {
  const transpiled = ts.transpileModule(readSource(path), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript syntax errors`);

  let handler;
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    Deno: { serve: (registeredHandler) => { handler = registeredHandler; } },
    Request,
    Response,
    URL,
    Date,
    TextEncoder,
    Uint8Array,
    crypto: globalThis.crypto,
  }, { filename: path });
  assert.equal(typeof handler, 'function');
  return handler;
}

test('Instagram UTMs are normalized into a stable content touch', () => {
  const touch = parseAcquisitionTouch({
    href: 'https://firstknock.online/RoleSelect?utm_source=Instagram&utm_medium=Organic%20Social&utm_campaign=1000%20Users&utm_content=IG-20260728-01',
    referrer: 'https://l.instagram.com/',
    now: new Date('2026-07-28T18:00:00.000Z'),
  });

  assert.deepEqual(touch, {
    source: 'instagram',
    medium: 'organic-social',
    campaign: '1000-users',
    content: 'ig-20260728-01',
    term: '',
    landing_path: '/RoleSelect',
    referrer_host: 'l.instagram.com',
    captured_at: '2026-07-28T18:00:00.000Z',
  });
});

test('first touch remains immutable while the latest Instagram touch changes', () => {
  const storage = memoryStorage();
  captureAcquisitionTouch({
    href: 'https://firstknock.online/?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-first',
    now: new Date('2026-07-28T18:00:00.000Z'),
    storage,
  });
  captureAcquisitionTouch({
    href: 'https://firstknock.online/?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-second',
    now: new Date('2026-07-29T18:00:00.000Z'),
    storage,
  });

  const stored = readStoredAcquisition(storage);
  assert.equal(stored.first_touch.content, 'ig-first');
  assert.equal(stored.last_touch.content, 'ig-second');
  assert.equal(shouldSyncStoredAcquisition(stored, 'user_1'), true);
  markStoredAcquisitionSynced('user_1', storage);
  assert.equal(shouldSyncStoredAcquisition(readStoredAcquisition(storage), 'user_1'), false);
  assert.ok(storage.getItem(ACQUISITION_STORAGE_KEY));
});

test('a bound acquisition journey cannot bleed into another account', () => {
  const storage = memoryStorage();
  captureAcquisitionTouch({
    href: 'https://firstknock.online/instagram?utm_source=instagram&utm_campaign=1000-users&utm_content=ig-user-one',
    now: new Date('2026-07-28T18:00:00.000Z'),
    storage,
  });
  markStoredAcquisitionSynced('user_1', storage);
  const bound = readStoredAcquisition(storage, new Date('2026-07-29T18:00:00.000Z'));
  assert.equal(shouldSyncStoredAcquisition(bound, 'user_2'), false);

  captureAcquisitionTouch({
    href: 'https://firstknock.online/instagram?utm_source=instagram&utm_campaign=1000-users&utm_content=ig-user-two',
    now: new Date('2026-07-30T18:00:00.000Z'),
    storage,
  });
  const nextJourney = readStoredAcquisition(storage, new Date('2026-07-30T18:01:00.000Z'));
  assert.equal(nextJourney.first_touch.content, 'ig-user-two');
  assert.equal(nextJourney.synced_user_id, '');
  assert.equal(shouldSyncStoredAcquisition(nextJourney, 'user_2'), true);

  assert.equal(
    readStoredAcquisition(storage, new Date('2026-10-29T18:00:01.000Z')),
    null,
  );
});

test('tracked links use one normalized Instagram source and unique content id', () => {
  const link = new URL(buildInstagramTrackedLink({
    origin: 'https://firstknock.online',
    campaign: '1,000 Users',
    contentId: 'IG 20260728 01',
  }));
  assert.equal(link.pathname, '/instagram');
  assert.equal(link.searchParams.get('utm_source'), 'instagram');
  assert.equal(link.searchParams.get('utm_medium'), 'organic_social');
  assert.equal(link.searchParams.get('utm_campaign'), '1-000-users');
  assert.equal(link.searchParams.get('utm_content'), 'ig-20260728-01');
});

test('anonymous and session identities remain stable without storing personal data', () => {
  const persistentStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  let sequence = 0;
  const cryptoApi = { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` };
  const firstIdentity = getAcquisitionIdentity({
    persistentStorage,
    sessionStorage,
    cryptoApi,
  });
  const secondIdentity = getAcquisitionIdentity({
    persistentStorage,
    sessionStorage,
    cryptoApi,
  });

  assert.deepEqual(secondIdentity, firstIdentity);
  assert.match(firstIdentity.anonymous_id, /^anon_/);
  assert.match(firstIdentity.session_id, /^session_/);
  assert.equal(JSON.stringify(firstIdentity).includes('@'), false);

  const rotatedSession = getAcquisitionIdentity({
    persistentStorage,
    sessionStorage,
    cryptoApi,
    now: new Date(Date.now() + 31 * 60 * 1000),
  });
  assert.equal(rotatedSession.anonymous_id, firstIdentity.anonymous_id);
  assert.notEqual(rotatedSession.session_id, firstIdentity.session_id);

  captureAcquisitionTouch({
    href: 'https://firstknock.online/instagram?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-event',
    now: new Date('2026-07-28T18:00:00.000Z'),
    storage: persistentStorage,
  });
  const event = buildAcquisitionEvent('landing_viewed', {
    identity: firstIdentity,
    storage: persistentStorage,
    now: new Date('2026-07-28T18:01:00.000Z'),
    cryptoApi,
  });
  assert.equal(event.touch.content, 'ig-event');
  assert.equal(event.landing_path, '/instagram');
  assert.equal(event.event_name, 'landing_viewed');
});

test('backend preserves first touch and updates only last touch on later visits', async () => {
  const user = { id: 'user_1', email: 'owner@example.com' };
  const updates = [];
  const events = [];
  const base44 = {
    auth: { me: async () => ({ id: user.id, email: user.email }) },
    asServiceRole: {
      entities: {
        User: {
          get: async () => structuredClone(user),
          update: async (_id, value) => {
            updates.push(structuredClone(value));
            Object.assign(user, structuredClone(value));
          },
        },
        AcquisitionEvent: {
          filter: async (query) => events.filter((event) => (
            event.event_name === query.event_name && event.user_id === query.user_id
          )),
          create: async (value) => {
            events.push(structuredClone(value));
            return structuredClone(value);
          },
        },
      },
    },
  };
  const handler = loadDenoHandler(
    'base44/functions/captureAcquisitionAttribution/entry.ts',
    base44,
  );
  const invoke = async (content, capturedAt) => handler(new Request('https://firstknock.online/api/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      first_touch: {
        source: 'instagram',
        medium: 'organic_social',
        campaign: '1000-users',
        content,
        landing_path: '/RoleSelect',
        captured_at: capturedAt,
      },
      last_touch: {
        source: 'instagram',
        medium: 'organic_social',
        campaign: '1000-users',
        content,
        landing_path: '/RoleSelect',
        captured_at: capturedAt,
      },
      anonymous_id: 'anon_user_1',
      session_id: 'session_user_1',
    }),
  }));

  assert.equal((await invoke('ig-first', '2026-07-28T18:00:00.000Z')).status, 200);
  assert.equal((await invoke('ig-second', '2026-07-29T18:00:00.000Z')).status, 200);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].acquisition_first_touch.content, 'ig-first');
  assert.equal(updates[1].acquisition_first_touch, undefined);
  assert.equal(updates[1].acquisition_last_touch.content, 'ig-second');
  assert.equal(user.acquisition_first_touch.content, 'ig-first');
  assert.equal(events.length, 1);
  assert.equal(events[0].event_name, 'auth_completed');
  assert.equal(events[0].content, 'ig-first');
});

test('auth completion uses the account immutable first touch, not a later Instagram visit', async () => {
  const user = {
    id: 'existing_user',
    email: 'existing@example.com',
    acquisition_first_touch: {
      source: 'direct',
      medium: 'none',
      campaign: 'unassigned',
      content: 'unassigned',
      landing_path: '/',
      captured_at: '2026-07-01T12:00:00.000Z',
    },
  };
  const events = [];
  const base44 = {
    auth: { me: async () => ({ id: user.id, email: user.email }) },
    asServiceRole: {
      entities: {
        User: {
          get: async () => structuredClone(user),
          update: async (_id, value) => Object.assign(user, structuredClone(value)),
        },
        AcquisitionEvent: {
          filter: async () => [],
          create: async (value) => {
            events.push(structuredClone(value));
            return structuredClone(value);
          },
        },
      },
    },
  };
  const handler = loadDenoHandler(
    'base44/functions/captureAcquisitionAttribution/entry.ts',
    base44,
  );
  const response = await handler(new Request('https://firstknock.online/api/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      first_touch: {
        source: 'instagram',
        medium: 'organic_social',
        campaign: '1000-users',
        content: 'ig-later-visit',
        landing_path: '/instagram',
        captured_at: '2026-07-28T18:00:00.000Z',
      },
      last_touch: {
        source: 'instagram',
        medium: 'organic_social',
        campaign: '1000-users',
        content: 'ig-later-visit',
        landing_path: '/instagram',
        captured_at: '2026-07-28T18:00:00.000Z',
      },
      anonymous_id: 'anon_existing_user',
      session_id: 'session_existing_user',
    }),
  }));

  assert.equal(response.status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'direct');
  assert.equal(events[0].content, 'unassigned');
  assert.equal(user.acquisition_first_touch.source, 'direct');
  assert.equal(user.acquisition_last_touch.content, 'ig-later-visit');
});

test('trusted acquisition milestones are pseudonymous and idempotent', async () => {
  const records = [];
  const entity = {
    filter: async (query) => records.filter((record) => record.event_id === query.event_id),
    create: async (value) => {
      records.push(structuredClone(value));
      return structuredClone(value);
    },
  };
  const service = { entities: { AcquisitionEvent: entity } };
  const user = {
    id: 'rep_user_123',
    acquisition_first_touch: {
      source: 'instagram',
      medium: 'organic_social',
      campaign: '1000-users',
      content: 'ig-milestone',
    },
  };
  const payload = {
    eventName: 'invited_rep_activated',
    eventKey: 'rep_activated_rep_user_123',
    user,
    workspaceManagerId: 'manager_123',
    evidenceId: 'interaction_123',
  };

  await writeAcquisitionMilestone(service, payload);
  await writeAcquisitionMilestone(service, payload);

  assert.equal(records.length, 1);
  assert.equal(records[0].content, 'ig-milestone');
  assert.equal(records[0].trust_source, 'trusted_product_function');
  assert.match(records[0].anonymous_id, /^account_[a-f0-9]{48}$/);
  assert.match(records[0].session_id, /^server_[a-f0-9]{48}$/);
  assert.equal(records[0].anonymous_id.includes(user.id), false);
  assert.equal(records[0].session_id.includes(user.id), false);
});

test('owner report groups Instagram content by signup, activation, and paid outcome', async () => {
  const now = new Date().toISOString();
  const oneSecondAgo = new Date(Date.now() - 1000).toISOString();
  const sevenAndHalfDaysAgo = new Date(
    Date.now() - 7.5 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
  const twoDaysAgo = new Date(
    new Date(now).getTime() - 2 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const oneDayAgo = new Date(
    new Date(now).getTime() - 24 * 60 * 60 * 1000,
  ).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const instagramTouch = (content) => ({
    source: 'instagram',
    medium: 'organic_social',
    campaign: '1000-users',
    content,
    captured_at: now,
  });
  const users = [
    { id: 'owner', email: 'owner@example.com', is_owner: true, app_role: 'manager', created_date: now },
    {
      id: 'manager_1',
      email: 'manager1@example.com',
      app_role: 'manager',
      created_date: now,
      acquisition_first_touch: instagramTouch('ig-a'),
      subscription_paid_confirmed: true,
      subscription_status: 'active',
    },
    {
      id: 'manager_2',
      email: 'manager2@example.com',
      app_role: 'manager',
      created_date: now,
      acquisition_first_touch: instagramTouch('ig-a'),
    },
    {
      id: 'rep_1',
      email: 'rep1@example.com',
      app_role: 'rep',
      team_manager_id: 'manager_1',
      created_date: now,
      acquisition_first_touch: instagramTouch('ig-b'),
      outcomes_logged: 1,
    },
    {
      id: 'rep_2',
      email: 'rep2@example.com',
      app_role: 'rep',
      team_manager_id: 'manager_2',
      created_date: now,
    },
    {
      id: 'rep_removed',
      email: 'removed@example.com',
      app_role: 'rep',
      team_manager_id: 'manager_1',
      created_date: now,
      outcomes_logged: 1,
    },
    {
      id: 'rep_conflict_1',
      email: 'conflict@example.com',
      app_role: 'rep',
      team_manager_id: 'manager_1',
      created_date: now,
    },
    {
      id: 'rep_conflict_2',
      email: 'conflict@example.com',
      app_role: 'rep',
      team_manager_id: 'manager_1',
      created_date: now,
    },
    { id: 'direct_1', email: 'direct@example.com', app_role: 'manager', created_date: now },
  ];
  const events = [
    {
      event_id: 'event_landing_a',
      event_name: 'landing_viewed',
      session_id: 'session_a',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-a',
      occurred_at: now,
    },
    {
      event_id: 'event_cta_a',
      event_name: 'signup_cta_clicked',
      session_id: 'session_a',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-a',
      occurred_at: now,
    },
  ];
  const metrics = [
    {
      campaign: '1000-users',
      content: 'ig-a',
      format: 'reel',
      hook: 'Early route rescue',
      snapshot_days: 1,
      snapshot_captured_at: sevenAndHalfDaysAgo,
      published_at: eightDaysAgo,
      reach: 500,
      views: 600,
    },
    {
      id: 'metric_older_duplicate',
      campaign: '1000-users',
      content: 'ig-a',
      format: 'reel',
      hook: 'Route rescue',
      snapshot_days: 7,
      snapshot_captured_at: oneSecondAgo,
      published_at: eightDaysAgo,
      reach: 900,
      views: 1000,
    },
    {
      id: 'metric_canonical',
      campaign: '1000-users',
      content: 'ig-a',
      format: 'reel',
      hook: 'Route rescue',
      snapshot_days: 7,
      snapshot_captured_at: now,
      published_at: eightDaysAgo,
      reach: 1000,
      views: 1200,
      shares: 15,
      saves: 20,
      snapshot_fingerprint: 'a'.repeat(64),
    },
    {
      id: 'metric_early_only',
      campaign: '1000-users',
      content: 'ig-snapshot-due',
      format: 'story',
      hook: 'Snapshot due',
      snapshot_days: 1,
      snapshot_captured_at: sixDaysAgo,
      published_at: sevenDaysAgo,
      reach: 700,
      views: 800,
    },
  ];
  const contentPlans = [
    {
      id: 'plan_1',
      campaign: '1000-users',
      content: 'ig-a',
      sprint: 'test-sprint',
      sequence: 1,
      format: 'reel',
      audience: 'Managers',
      hook: 'Route rescue',
      script: 'Show the route rescue.',
      cta_label: 'ROUTE',
      cta_channel: 'story_link',
      primary_metric: 'Landing sessions / reach',
      hypothesis: 'The rescue earns intent.',
      comparison_group: 'test-reels',
      major_variable: 'Pain hook',
      planned_publish_at: nineDaysAgo,
      published_at: eightDaysAgo,
      snapshot_days: 7,
      review_decision: 'repeat',
      review_note: 'Preserve the original hook.',
      reviewed_at: oneSecondAgo,
      review_snapshot_captured_at: now,
      review_evidence_hash: 'a'.repeat(64),
      created_date: nineDaysAgo,
      updated_date: eightDaysAgo,
    },
    {
      id: 'plan_2',
      campaign: '1000-users',
      content: 'ig-future',
      sprint: 'test-sprint',
      sequence: 2,
      format: 'carousel',
      audience: 'Managers',
      hook: 'Future checklist',
      script: 'Show the checklist.',
      cta_label: 'PLAN',
      cta_channel: 'dm_reply',
      primary_metric: 'Saves / reach',
      hypothesis: 'The checklist earns saves.',
      comparison_group: 'test-carousels',
      major_variable: 'Checklist framing',
      planned_publish_at: tomorrow,
      snapshot_days: 7,
      created_date: now,
      updated_date: now,
    },
    {
      id: 'plan_3',
      campaign: '1000-users',
      content: 'ig-snapshot-due',
      sprint: 'test-sprint',
      sequence: 3,
      format: 'story',
      audience: 'Managers',
      hook: 'Snapshot due',
      script: 'Capture the fixed-age snapshot.',
      cta_label: 'DUE',
      cta_channel: 'story_link',
      primary_metric: 'Link clicks / reach',
      hypothesis: 'The Story earns intent.',
      comparison_group: 'test-stories',
      major_variable: 'Due boundary',
      planned_publish_at: eightDaysAgo,
      published_at: sevenDaysAgo,
      snapshot_days: 7,
      created_date: eightDaysAgo,
      updated_date: sevenDaysAgo,
    },
  ];
  contentPlans.push({
    ...structuredClone(contentPlans[0]),
    id: 'plan_1_unexecuted_duplicate',
    published_at: undefined,
    review_decision: undefined,
    review_note: undefined,
    reviewed_at: undefined,
    review_snapshot_captured_at: undefined,
    review_evidence_hash: undefined,
    updated_date: tomorrow,
  });
  const teamMembers = [
    {
      id: 'member_1_placeholder',
      manager_id: 'manager_1',
      email: 'REP1@example.com',
      role: 'rep',
      status: 'active',
    },
    {
      id: 'member_1',
      manager_id: 'manager_1',
      user_id: 'rep_1',
      email: 'rep1@example.com',
      role: 'rep',
      status: 'active',
    },
    {
      id: 'member_2',
      manager_id: 'manager_1',
      email: 'invited-a@example.com',
      role: 'rep',
      status: 'active',
    },
    {
      id: 'member_3',
      manager_id: 'manager_1',
      email: 'shared@example.com',
      role: 'rep',
      status: 'active',
    },
    {
      id: 'member_wrong_email',
      manager_id: 'manager_1',
      user_id: 'rep_removed',
      email: 'wrong@example.com',
      role: 'rep',
      status: 'active',
    },
    {
      id: 'member_4',
      manager_id: 'manager_2',
      user_id: 'rep_2',
      email: 'rep2@example.com',
      role: 'rep',
      status: 'active',
    },
    {
      id: 'member_5',
      manager_id: 'manager_2',
      email: 'SHARED@example.com',
      role: 'rep',
      status: 'active',
    },
    {
      id: 'member_inactive',
      manager_id: 'manager_1',
      email: 'inactive@example.com',
      role: 'rep',
      status: 'inactive',
    },
    {
      id: 'member_conflict_1',
      manager_id: 'manager_1',
      user_id: 'rep_conflict_1',
      email: 'conflict@example.com',
      role: 'rep',
      status: 'active',
    },
    {
      id: 'member_conflict_2',
      manager_id: 'manager_1',
      user_id: 'rep_conflict_2',
      email: 'conflict@example.com',
      role: 'rep',
      status: 'active',
    },
    {
      id: 'member_invalid_status',
      manager_id: 'manager_1',
      email: 'invalid@example.com',
      role: 'rep',
      status: 'invited',
    },
  ];
  const base44 = {
    auth: { me: async () => structuredClone(users[0]) },
    asServiceRole: {
      entities: {
        User: {
          list: async (_sort, limit, skip = 0) => structuredClone(users.slice(skip, skip + limit)),
        },
        SavedRoute: {
          list: async () => [{
            id: 'route_1',
            manager_id: 'manager_1',
            created_by: 'manager1@example.com',
            property_hashes: ['property_1'],
            updated_date: now,
          }],
        },
        CanvasSession: {
          list: async () => [],
        },
        InteractionLog: {
          list: async () => [{
            id: 'interaction_1',
            logged_by_user_id: 'rep_1',
            manager_id: 'manager_1',
            counts_as_knock: true,
            created_date: now,
          }],
        },
        TeamMember: {
          list: async (_sort, limit, skip = 0) => (
            structuredClone(teamMembers.slice(skip, skip + limit))
          ),
        },
        AcquisitionEvent: {
          list: async (_sort, limit, skip = 0) => structuredClone(events.slice(skip, skip + limit)),
        },
        GrowthContentMetric: {
          list: async (_sort, limit, skip = 0) => structuredClone(metrics.slice(skip, skip + limit)),
        },
        GrowthContentPlan: {
          list: async (_sort, limit, skip = 0) => (
            structuredClone(contentPlans.slice(skip, skip + limit))
          ),
        },
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/getAcquisitionReport/entry.ts', base44);
  const reviewedResponse = await handler(
    new Request('https://firstknock.online/api/report', { method: 'POST' }),
  );
  const reviewedReport = await reviewedResponse.json();
  assert.equal(reviewedResponse.status, 200);
  const reviewedItem = reviewedReport.content_queue.items.find(
    (item) => item.content === 'ig-a',
  );
  assert.equal(reviewedItem.state, 'reviewed');
  assert.equal(reviewedItem.decision, 'repeat');
  assert.equal(reviewedItem.decision_stale, false);
  assert.equal(reviewedReport.content_queue.next_decision, null);

  const newerCapture = new Date(new Date(now).getTime() + 1).toISOString();
  metrics.push({
    ...structuredClone(metrics.find((metric) => metric.id === 'metric_canonical')),
    id: 'metric_newer_canonical',
    snapshot_captured_at: newerCapture,
    snapshot_fingerprint: 'c'.repeat(64),
  });
  const response = await handler(new Request('https://firstknock.online/api/report', { method: 'POST' }));
  const report = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(report.all_time.users, 9);
  assert.equal(report.all_time.activated_users, 3);
  assert.equal(report.all_time.instagram_acquired_users, 4);
  assert.equal(report.all_time.instagram_signups, 2);
  assert.equal(report.all_time.instagram_activated_workspaces, 1);
  assert.equal(report.all_time.instagram_activated_users, 2);
  assert.equal(report.all_time.instagram_retained_active_users_30d, 2);
  assert.equal(report.last_28_days.instagram_retained_active_users_30d, 2);
  assert.equal(report.all_time.instagram_paid_users, 1);
  assert.equal(report.all_time.instagram_active_rep_roster, 7);
  assert.equal(report.all_time.instagram_joined_reps, 2);
  assert.equal(report.all_time.instagram_activated_reps, 1);
  assert.equal(report.all_time.instagram_rep_identity_conflicts, 1);
  assert.equal(report.all_time.instagram_reach, 1000);
  assert.equal(report.all_time.instagram_content_assets, 1);
  assert.equal(report.all_time.instagram_landing_sessions, 1);
  assert.equal(report.all_time.instagram_signup_cta_sessions, 1);
  assert.equal(report.all_time.retained_active_users_30d, 2);
  assert.equal(report.pace_evidence.campaign, '1000-users');
  assert.equal(report.pace_evidence.scope, 'canonical_mature_plan_backed_assets');
  assert.equal(report.pace_evidence.measured_content_assets_all_time, 1);
  assert.equal(report.pace_evidence.observation_window_complete, false);
  assert.equal(report.pace_evidence.last_28_days.instagram_reach, 1000);
  assert.equal(report.pace_evidence.last_28_days.instagram_content_assets, 1);
  assert.equal(report.pace_evidence.last_28_days.instagram_activated_workspaces, 1);
  assert.equal(report.pace_evidence.last_28_days.instagram_retained_active_users_30d, 2);
  assert.equal(report.by_content.length, 1);
  assert.deepEqual(
    report.by_content.map((row) => [row.content, row.signups, row.activated_users, row.paid_users]),
    [['ig-a', 2, 2, 1]],
  );
  assert.equal(report.by_content[0].reach, 1000);
  assert.equal(report.by_content[0].landing_sessions, 1);
  assert.equal(report.by_content[0].signup_cta_sessions, 1);
  assert.equal(report.by_content[0].active_rep_roster, 7);
  assert.equal(report.by_content[0].joined_reps, 2);
  assert.equal(report.by_content[0].activated_reps, 1);
  assert.equal(report.by_content[0].rep_identity_conflicts, 1);
  assert.equal(report.by_content[0].roster_to_join_rate, 2 / 7);
  assert.equal(report.by_content[0].joined_to_activation_rate, 0.5);
  assert.equal(report.by_content[0].active_rep_roster, report.all_time.instagram_active_rep_roster);
  assert.ok(report.by_content[0].activated_reps <= report.by_content[0].joined_reps);
  assert.ok(report.by_content[0].joined_reps <= report.by_content[0].active_rep_roster);
  assert.equal(report.by_content[0].reach_to_signup_rate, 0.002);
  assert.equal(report.by_content[0].users_per_activated_workspace, 2);
  assert.equal(report.content_queue.items.length, 3);
  assert.equal(report.content_queue.next_publish.content, 'ig-future');
  assert.equal(report.content_queue.next_snapshot.content, 'ig-snapshot-due');
  assert.equal(report.content_queue.next_snapshot.snapshot_action_days, 7);
  assert.equal(report.content_queue.next_decision.content, 'ig-a');
  assert.equal(report.content_queue.items[0].state, 'review_due');
  assert.equal(report.content_queue.items[0].decision_stale, true);
  assert.equal(report.content_queue.items[0].early_snapshot_days, 1);
  assert.equal(
    report.content_queue.items.find((item) => item.content === 'ig-snapshot-due').state,
    'snapshot_due',
  );
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('rep1@example.com'), false);
  assert.equal(serialized.includes('member_1'), false);
  assert.equal(serialized.includes('manager_1'), false);
  const keys = recursiveKeys(report);
  for (const forbidden of [
    'email',
    'phone',
    'user_id',
    'manager_id',
    'member_id',
    'invite_code',
    'ip_address',
    'anonymous_id',
    'session_id',
    'workspace_manager_id',
    'evidence_id',
    'created_by',
    'referrer_host',
  ]) {
    assert.equal(keys.has(forbidden), false, `report leaked forbidden key ${forbidden}`);
  }

  const managerTouch = users.find((user) => user.id === 'manager_1').acquisition_first_touch;
  const originalCapturedAt = managerTouch.captured_at;
  managerTouch.captured_at = nineDaysAgo;
  const prepublicationResponse = await handler(
    new Request('https://firstknock.online/api/report', { method: 'POST' }),
  );
  const prepublicationReport = await prepublicationResponse.json();
  assert.equal(prepublicationResponse.status, 200);
  assert.equal(prepublicationReport.all_time.instagram_retained_active_users_30d, 2);
  assert.equal(
    prepublicationReport.pace_evidence.last_28_days.instagram_retained_active_users_30d,
    0,
  );
  assert.equal(
    prepublicationReport.pace_evidence.last_28_days.instagram_activated_workspaces,
    0,
  );
  managerTouch.captured_at = originalCapturedAt;

  const recentCreatedAt = users.find((user) => user.id === 'manager_1').created_date;
  users.find((user) => user.id === 'manager_1').created_date = new Date(
    Date.now() - 40 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const cohortResponse = await handler(
    new Request('https://firstknock.online/api/report', { method: 'POST' }),
  );
  const cohortReport = await cohortResponse.json();
  assert.equal(cohortResponse.status, 200);
  assert.equal(cohortReport.all_time.instagram_retained_active_users_30d, 2);
  assert.equal(cohortReport.last_28_days.instagram_retained_active_users_30d, 1);
  assert.equal(
    cohortReport.pace_evidence.last_28_days.instagram_retained_active_users_30d,
    1,
  );
  users.find((user) => user.id === 'manager_1').created_date = recentCreatedAt;

  const earlyOnlyMetric = metrics.find((metric) => metric.id === 'metric_early_only');
  earlyOnlyMetric.published_at = twoDaysAgo;
  earlyOnlyMetric.snapshot_captured_at = oneDayAgo;
  const snapshotDuePlan = contentPlans.find((plan) => plan.content === 'ig-snapshot-due');
  snapshotDuePlan.published_at = twoDaysAgo;
  const laterPublishedPlan = contentPlans.find((plan) => plan.content === 'ig-future');
  laterPublishedPlan.published_at = oneDayAgo;
  const advancedQueueResponse = await handler(
    new Request('https://firstknock.online/api/report', { method: 'POST' }),
  );
  const advancedQueueReport = await advancedQueueResponse.json();
  assert.equal(advancedQueueResponse.status, 200);
  assert.equal(advancedQueueReport.content_queue.next_snapshot.content, 'ig-future');
  assert.equal(advancedQueueReport.content_queue.next_snapshot.snapshot_action_days, 1);

  metrics.push(
    {
      id: 'metric_release_smoke',
      campaign: '1000-users',
      content: 'ig-release-smoke',
      format: 'reel',
      hook: 'Release smoke',
      snapshot_days: 7,
      snapshot_captured_at: now,
      published_at: eightDaysAgo,
      reach: 5000,
      views: 6000,
    },
    {
      id: 'metric_other_campaign',
      campaign: 'other-campaign',
      content: 'ig-other',
      format: 'reel',
      hook: 'Other campaign',
      snapshot_days: 7,
      snapshot_captured_at: now,
      published_at: eightDaysAgo,
      reach: 7000,
      views: 8000,
    },
  );
  contentPlans.push({
    ...structuredClone(contentPlans[0]),
    id: 'plan_other_campaign',
    campaign: 'other-campaign',
    content: 'ig-other',
    published_at: eightDaysAgo,
    review_decision: undefined,
    review_note: undefined,
    reviewed_at: undefined,
    review_snapshot_captured_at: undefined,
    review_evidence_hash: undefined,
  });
  const thirtyTwoDaysAgo = new Date(
    Date.now() - 32 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const fortyFiveDaysAgo = new Date(
    Date.now() - 45 * 24 * 60 * 60 * 1000,
  ).toISOString();
  contentPlans.push(
    {
      ...structuredClone(contentPlans[0]),
      id: 'plan_due_in_window',
      content: 'ig-due-in-window',
      sequence: 4,
      published_at: thirtyTwoDaysAgo,
      review_decision: undefined,
      review_note: undefined,
      reviewed_at: undefined,
      review_snapshot_captured_at: undefined,
      review_evidence_hash: undefined,
    },
    {
      ...structuredClone(contentPlans[0]),
      id: 'plan_old_correction',
      content: 'ig-old-correction',
      sequence: 5,
      published_at: fortyFiveDaysAgo,
      review_decision: undefined,
      review_note: undefined,
      reviewed_at: undefined,
      review_snapshot_captured_at: undefined,
      review_evidence_hash: undefined,
    },
  );
  metrics.push(
    {
      id: 'metric_due_in_window',
      campaign: '1000-users',
      content: 'ig-due-in-window',
      format: 'reel',
      hook: 'Due in current evidence window',
      snapshot_days: 7,
      snapshot_captured_at: now,
      published_at: now,
      reach: 3000,
      views: 3500,
    },
    {
      id: 'metric_old_correction',
      campaign: '1000-users',
      content: 'ig-old-correction',
      format: 'reel',
      hook: 'Corrected after its evidence window',
      snapshot_days: 7,
      snapshot_captured_at: now,
      published_at: now,
      reach: 4000,
      views: 4500,
    },
  );
  const scopedPaceResponse = await handler(
    new Request('https://firstknock.online/api/report', { method: 'POST' }),
  );
  const scopedPaceReport = await scopedPaceResponse.json();
  assert.equal(scopedPaceResponse.status, 200);
  assert.equal(scopedPaceReport.all_time.instagram_reach, 20000);
  assert.equal(scopedPaceReport.pace_evidence.measured_content_assets_all_time, 3);
  assert.equal(scopedPaceReport.pace_evidence.observation_window_complete, true);
  assert.equal(scopedPaceReport.pace_evidence.last_28_days.instagram_content_assets, 2);
  assert.equal(scopedPaceReport.pace_evidence.last_28_days.instagram_reach, 4000);

  metrics.push({
    ...structuredClone(metrics.find((metric) => metric.id === 'metric_newer_canonical')),
    id: 'metric_conflicting_duplicate',
    reach: 999,
  });
  const conflictingResponse = await handler(
    new Request('https://firstknock.online/api/report', { method: 'POST' }),
  );
  assert.equal(
    conflictingResponse.status,
    409,
    'same-capture conflicting duplicates must fail closed instead of selecting by ID',
  );
  assert.deepEqual(await conflictingResponse.json(), {
    error: 'growth_content_conflict',
  });
});

test('acquisition report rejects ordinary managers before service-role reads', async () => {
  let serviceReads = 0;
  const unreadableEntity = {
    list: async () => {
      serviceReads += 1;
      return [];
    },
  };
  const base44 = {
    auth: {
      me: async () => ({
        id: 'manager_non_owner',
        email: 'manager@example.com',
        app_role: 'manager',
      }),
    },
    asServiceRole: {
      entities: {
        User: unreadableEntity,
        SavedRoute: unreadableEntity,
        CanvasSession: unreadableEntity,
        InteractionLog: unreadableEntity,
        TeamMember: unreadableEntity,
        AcquisitionEvent: unreadableEntity,
        GrowthContentMetric: unreadableEntity,
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/getAcquisitionReport/entry.ts', base44);
  const response = await handler(new Request('https://firstknock.online/api/report', {
    method: 'POST',
  }));

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'growth_admin_required' });
  assert.equal(serviceReads, 0);
});

test('public acquisition events are allowlisted and deduplicated by session stage', async () => {
  const records = [];
  const eventEntity = {
    filter: async (query) => records.filter((record) => (
      Object.entries(query).every(([key, value]) => record[key] === value)
    )),
    create: async (value) => {
      records.push(structuredClone(value));
      return structuredClone(value);
    },
  };
  const base44 = {
    asServiceRole: { entities: { AcquisitionEvent: eventEntity } },
  };
  const handler = loadDenoHandler('base44/functions/trackAcquisitionEvent/entry.ts', base44);
  const payload = {
    event_id: 'event_public_001',
    event_name: 'landing_viewed',
    anonymous_id: 'anon_public_001',
    session_id: 'session_public_001',
    occurred_at: new Date().toISOString(),
    landing_path: '/instagram',
    touch: {
      source: 'instagram',
      medium: 'organic_social',
      campaign: '1000-users',
      content: 'ig-public',
    },
  };
  const invoke = (body) => handler(new Request('https://firstknock.online/api/track', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://firstknock.online',
    },
    body: JSON.stringify(body),
  }));

  assert.equal((await invoke(payload)).status, 200);
  assert.equal(records.length, 1);
  assert.equal(records[0].content, 'ig-public');

  assert.equal((await invoke({ ...payload, event_id: 'event_public_002' })).status, 200);
  assert.equal(records.length, 1, 'same session and stage should be deduplicated');

  const rejected = await invoke({ ...payload, event_id: 'event_public_003', event_name: 'purchase' });
  assert.equal(rejected.status, 400);
  assert.equal(records.length, 1);
});

test('owner can upsert a cumulative Instagram content snapshot', async () => {
  const records = [];
  const metricEntity = {
    filter: async (query) => records.filter((record) => (
      record.campaign === query.campaign
      && record.content === query.content
      && record.snapshot_days === query.snapshot_days
    )),
    create: async (value) => {
      const created = { id: `metric_${records.length + 1}`, ...structuredClone(value) };
      records.push(created);
      return structuredClone(created);
    },
    update: async (id, value) => {
      const index = records.findIndex((record) => record.id === id);
      records[index] = { ...records[index], ...structuredClone(value) };
      return structuredClone(records[index]);
    },
  };
  const base44 = {
    auth: { me: async () => ({ id: 'owner', is_owner: true }) },
    asServiceRole: { entities: { GrowthContentMetric: metricEntity } },
  };
  const handler = loadDenoHandler('base44/functions/upsertGrowthContentMetric/entry.ts', base44);
  const invoke = ({ reach, capturedAt, snapshotDays = 7 }) => handler(new Request('https://firstknock.online/api/metric', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      campaign: '1000 Users',
      content: 'IG Snapshot 01',
      format: 'reel',
      snapshot_days: snapshotDays,
      snapshot_captured_at: capturedAt,
      published_at: '2026-07-01T12:00:00.000Z',
      reach,
      views: reach + 100,
    }),
  }));

  const firstCapturedAt = '2026-07-08T12:00:00.000Z';
  const secondCapturedAt = '2026-07-08T13:00:00.000Z';
  const created = await invoke({ reach: 1000, capturedAt: firstCapturedAt });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).created, true);
  assert.equal(records[0].campaign, '1000-users');
  assert.equal(records[0].content, 'ig-snapshot-01');
  assert.equal(records[0].reach, 1000);
  assert.match(records[0].snapshot_fingerprint, /^[a-f0-9]{64}$/);

  const updated = await invoke({ reach: 1500, capturedAt: secondCapturedAt });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).created, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].reach, 1500);

  const idempotent = await invoke({ reach: 1500, capturedAt: secondCapturedAt });
  assert.equal(idempotent.status, 200);
  assert.equal((await idempotent.json()).idempotent, true);

  const conflict = await invoke({ reach: 1600, capturedAt: secondCapturedAt });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'content_snapshot_conflict' });
  assert.equal(records[0].reach, 1500);

  const stale = await invoke({ reach: 900, capturedAt: firstCapturedAt });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'stale_content_snapshot');
  assert.equal(records[0].reach, 1500);

  const earlyRead = await invoke({
    reach: 700,
    capturedAt: '2026-07-02T12:00:00.000Z',
    snapshotDays: 1,
  });
  assert.equal(earlyRead.status, 200);
  assert.equal(records.length, 2, 'one-day and seven-day checkpoints must coexist');

  records.push({
    ...structuredClone(records[0]),
    id: 'metric_conflicting_duplicate',
    reach: 1499,
  });
  const blockedByDuplicateConflict = await invoke({
    reach: 1700,
    capturedAt: '2026-07-08T14:00:00.000Z',
  });
  assert.equal(blockedByDuplicateConflict.status, 409);
  assert.equal(
    (await blockedByDuplicateConflict.json()).error,
    'content_snapshot_conflict',
  );
  assert.equal(
    records.some((record) => record.reach === 1700),
    false,
    'conflicting duplicate evidence must be resolved before a later update',
  );
});

test('content snapshot lookup failures fail closed before create', async () => {
  let creates = 0;
  const base44 = {
    auth: { me: async () => ({ id: 'owner', is_owner: true }) },
    asServiceRole: {
      entities: {
        GrowthContentMetric: {
          filter: async () => {
            throw new Error('temporary metric lookup outage');
          },
          create: async () => {
            creates += 1;
            return {};
          },
        },
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/upsertGrowthContentMetric/entry.ts', base44);
  const response = await handler(new Request('https://firstknock.online/api/metric', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      campaign: '1000-users',
      content: 'ig-fail-closed',
      format: 'reel',
      snapshot_days: 7,
      snapshot_captured_at: '2026-07-08T12:00:00.000Z',
      published_at: '2026-07-01T12:00:00.000Z',
      reach: 10,
    }),
  }));

  assert.equal(response.status, 503);
  assert.equal(creates, 0);
});

test('content snapshot rejects invalid metrics and timestamps instead of rewriting them', async () => {
  let reads = 0;
  const base44 = {
    auth: { me: async () => ({ id: 'owner', is_owner: true }) },
    asServiceRole: {
      entities: {
        GrowthContentMetric: {
          filter: async () => {
            reads += 1;
            return [];
          },
        },
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/upsertGrowthContentMetric/entry.ts', base44);
  const invoke = (overrides) => handler(new Request('https://firstknock.online/api/metric', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      campaign: '1000-users',
      content: 'ig-invalid',
      format: 'reel',
      snapshot_days: 7,
      snapshot_captured_at: '2026-07-08T12:00:00.000Z',
      published_at: '2026-07-01T12:00:00.000Z',
      reach: 10,
      ...overrides,
    }),
  }));

  assert.equal((await invoke({ reach: -1 })).status, 400);
  assert.equal((await invoke({ reach: 1.5 })).status, 400);
  assert.equal((await invoke({ reach: 'not-a-number' })).status, 400);
  assert.equal((await invoke({ snapshot_captured_at: 'not-a-date' })).status, 400);
  assert.equal((await invoke({
    snapshot_captured_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  })).status, 400);
  assert.equal((await invoke({
    snapshot_captured_at: '2026-07-08T12:00:00.000Z',
    published_at: '2026-07-09T12:00:00.000Z',
  })).status, 400);
  assert.equal(reads, 0, 'invalid payloads must be rejected before entity reads');
});

test('growth mutations reject anonymous and ordinary-manager callers before service-role access', async () => {
  for (const [label, user, expectedStatus] of [
    ['anonymous', null, 401],
    ['ordinary manager', { id: 'manager', app_role: 'manager' }, 403],
  ]) {
    for (const functionPath of [
      'base44/functions/upsertGrowthContentMetric/entry.ts',
      'base44/functions/manageGrowthContentPlan/entry.ts',
    ]) {
      let serviceTouches = 0;
      const guardedEntity = new Proxy({}, {
        get() {
          serviceTouches += 1;
          return async () => [];
        },
      });
      const base44 = {
        auth: { me: async () => structuredClone(user) },
        asServiceRole: {
          entities: {
            GrowthContentMetric: guardedEntity,
            GrowthContentPlan: guardedEntity,
          },
        },
      };
      const handler = loadDenoHandler(functionPath, base44);
      const response = await handler(new Request('https://firstknock.online/api/growth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }));
      assert.equal(response.status, expectedStatus, `${label} status for ${functionPath}`);
      assert.equal(
        serviceTouches,
        0,
        `${label} must not touch service-role entities for ${functionPath}`,
      );
    }
  }
});

test('owner can seed, publish, and review the fixed-age growth queue', async () => {
  const plans = [];
  const metrics = [];
  const planEntity = {
    list: async (_sort, limit, skip = 0) => structuredClone(plans.slice(skip, skip + limit)),
    filter: async (query) => structuredClone(plans.filter((plan) => (
      plan.campaign === query.campaign && plan.content === query.content
    ))),
    create: async (value) => {
      const created = {
        id: `plan_${plans.length + 1}`,
        created_date: new Date().toISOString(),
        updated_date: new Date().toISOString(),
        ...structuredClone(value),
      };
      plans.push(created);
      return structuredClone(created);
    },
    update: async (id, value) => {
      const index = plans.findIndex((plan) => plan.id === id);
      plans[index] = {
        ...plans[index],
        ...structuredClone(value),
        updated_date: new Date().toISOString(),
      };
      return structuredClone(plans[index]);
    },
    updateMany: async (query, operations) => {
      let updated = 0;
      for (let index = 0; index < plans.length; index += 1) {
        if (
          (query.id !== undefined && plans[index].id !== query.id)
          || (
            query.updated_date !== undefined
            && plans[index].updated_date !== query.updated_date
          )
        ) {
          continue;
        }
        plans[index] = {
          ...plans[index],
          ...structuredClone(operations?.$set || {}),
          updated_date: new Date().toISOString(),
        };
        updated += 1;
      }
      return { success: true, updated, has_more: false };
    },
  };
  const metricEntity = {
    list: async (_sort, limit, skip = 0) => structuredClone(metrics.slice(skip, skip + limit)),
    filter: async (query) => structuredClone(metrics.filter((metric) => (
      metric.campaign === query.campaign
      && metric.content === query.content
      && metric.snapshot_days === query.snapshot_days
    ))),
    update: async (id, value) => {
      const index = metrics.findIndex((metric) => metric.id === id);
      metrics[index] = { ...metrics[index], ...structuredClone(value) };
      return structuredClone(metrics[index]);
    },
  };
  const base44 = {
    auth: { me: async () => ({ id: 'owner', is_owner: true }) },
    asServiceRole: {
      entities: {
        GrowthContentPlan: planEntity,
        GrowthContentMetric: metricEntity,
        GrowthCreativeArtifact: {
          filter: async () => [],
        },
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/manageGrowthContentPlan/entry.ts', base44);
  const invoke = (body) => handler(new Request('https://firstknock.online/api/content-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

  assert.equal(INSTAGRAM_FIRST_30_DAYS.length, 20);
  assert.equal(new Set(INSTAGRAM_FIRST_30_DAYS.map((plan) => plan.content)).size, 20);
  const sprintDocument = readSource('docs/growth/INSTAGRAM_FIRST_30_DAYS_CONTENT.md');
  for (const plan of INSTAGRAM_FIRST_30_DAYS) {
    assert.match(sprintDocument, new RegExp(`\\b${plan.content}\\b`));
  }
  const seeded = await invoke({ action: 'seed', plans: INSTAGRAM_FIRST_30_DAYS });
  assert.equal(seeded.status, 200);
  assert.deepEqual(await seeded.json(), {
    success: true,
    created: 20,
    updated: 0,
    preserved: 0,
    total: 20,
  });
  assert.equal(plans.length, 20);
  assert.equal(plans.some((plan) => 'published_at' in plan), false);
  assert.equal(plans.some((plan) => 'reach' in plan), false);

  const reseeded = await invoke({ action: 'seed', plans: INSTAGRAM_FIRST_30_DAYS });
  assert.equal(reseeded.status, 200);
  assert.equal((await reseeded.json()).updated, 20);
  assert.equal(plans.length, 20, 'seeding retries must not duplicate queue assets');

  const first = INSTAGRAM_FIRST_30_DAYS[0];
  const invalidPublish = await invoke({
    action: 'publish',
    campaign: first.campaign,
    content: first.content,
    published_at: 'not-a-date',
  });
  assert.equal(invalidPublish.status, 400);
  assert.equal(plans[0].published_at, undefined);

  const published = await invoke({
    action: 'publish',
    campaign: first.campaign,
    content: first.content,
    published_at: '2026-07-01T12:00:00.000Z',
  });
  assert.equal(published.status, 200);
  assert.equal(plans[0].published_at, '2026-07-01T12:00:00.000Z');

  metrics.push({
    id: 'metric_early_duplicate',
    campaign: first.campaign,
    content: first.content,
    snapshot_days: 7,
    snapshot_captured_at: '2026-07-07T12:00:00.000Z',
    updated_date: '2026-07-20T12:00:00.000Z',
    published_at: '2026-07-01T12:00:00.000Z',
    reach: 80,
    views: 90,
  });
  const prematureReview = await invoke({
    action: 'review',
    campaign: first.campaign,
    content: first.content,
    decision: 'repeat',
    note: 'This evidence is still too early.',
  });
  assert.equal(prematureReview.status, 409);
  assert.equal((await prematureReview.json()).error, 'fixed_age_snapshot_required');

  metrics.push({
    id: 'metric_7d',
    campaign: first.campaign,
    content: first.content,
    snapshot_days: 7,
    snapshot_captured_at: '2026-07-08T12:00:00.000Z',
    updated_date: '2026-07-09T12:00:00.000Z',
    published_at: '2026-07-01T12:00:00.000Z',
    reach: 100,
    views: 120,
    shares: 2,
    saves: 3,
    comments: 0,
    follows: 0,
    profile_visits: 4,
    link_clicks: 1,
    dm_intents: 0,
  });
  const reviewed = await invoke({
    action: 'review',
    campaign: first.campaign,
    content: first.content,
    decision: 'repeat',
    note: 'Preserve the overlap hook and Story handoff.',
  });
  assert.equal(reviewed.status, 200);
  assert.equal(plans[0].review_decision, 'repeat');
  assert.equal(plans[0].review_snapshot_captured_at, '2026-07-08T12:00:00.000Z');
  assert.match(plans[0].review_evidence_hash, /^[a-f0-9]{64}$/);
  assert.equal(metrics[1].snapshot_fingerprint, plans[0].review_evidence_hash);
  assert.equal(
    metrics[0].snapshot_fingerprint,
    undefined,
    'newer writes with older capture times must not replace the fixed-age evidence',
  );

  const immutablePlanEvidence = {
    hook: plans[0].hook,
    hypothesis: plans[0].hypothesis,
    planned_publish_at: plans[0].planned_publish_at,
    snapshot_days: plans[0].snapshot_days,
    published_at: plans[0].published_at,
    review_evidence_hash: plans[0].review_evidence_hash,
  };
  const changedSprint = INSTAGRAM_FIRST_30_DAYS.map((plan) => (
    plan.content === first.content
      ? {
        ...plan,
        hook: 'A rewritten hook that must not replace published evidence.',
        hypothesis: 'A rewritten hypothesis that must remain only a draft.',
        planned_publish_at: '2026-09-01T16:00:00.000Z',
        snapshot_days: 30,
      }
      : plan
  ));
  const frozenSeed = await invoke({ action: 'seed', plans: changedSprint });
  assert.equal(frozenSeed.status, 200);
  assert.deepEqual(await frozenSeed.json(), {
    success: true,
    created: 0,
    updated: 19,
    preserved: 1,
    total: 20,
  });
  assert.deepEqual({
    hook: plans[0].hook,
    hypothesis: plans[0].hypothesis,
    planned_publish_at: plans[0].planned_publish_at,
    snapshot_days: plans[0].snapshot_days,
    published_at: plans[0].published_at,
    review_evidence_hash: plans[0].review_evidence_hash,
  }, immutablePlanEvidence);

  plans.push({
    ...structuredClone(plans[0]),
    id: 'unexecuted_race_duplicate',
    published_at: undefined,
    review_decision: undefined,
    review_note: undefined,
    reviewed_at: undefined,
    review_snapshot_captured_at: undefined,
    review_evidence_hash: undefined,
    updated_date: '2027-01-01T00:00:00.000Z',
  });

  for (let index = 1; index <= 2; index += 1) {
    plans.push({
      ...structuredClone(plans[0]),
      id: `other_campaign_plan_${index}`,
      campaign: 'other-campaign',
      content: `other-campaign-${index}`,
      review_decision: undefined,
      review_note: undefined,
      reviewed_at: undefined,
      review_snapshot_captured_at: undefined,
      review_evidence_hash: undefined,
    });
    metrics.push({
      id: `other_campaign_metric_${index}`,
      campaign: 'other-campaign',
      content: `other-campaign-${index}`,
      snapshot_days: 7,
      snapshot_captured_at: '2026-07-08T12:00:00.000Z',
      published_at: '2026-07-01T12:00:00.000Z',
      reach: 50,
    });
  }
  for (let index = 1; index <= 2; index += 1) {
    plans.push({
      ...structuredClone(plans[0]),
      id: `other_horizon_plan_${index}`,
      content: `other-horizon-${index}`,
      snapshot_days: 3,
      review_decision: undefined,
      review_note: undefined,
      reviewed_at: undefined,
      review_snapshot_captured_at: undefined,
      review_evidence_hash: undefined,
    });
    metrics.push({
      id: `other_horizon_metric_${index}`,
      campaign: first.campaign,
      content: `other-horizon-${index}`,
      snapshot_days: 3,
      snapshot_captured_at: '2026-07-04T12:00:00.000Z',
      published_at: '2026-07-01T12:00:00.000Z',
      reach: 50,
    });
  }

  const hold = await invoke({
    action: 'review',
    campaign: first.campaign,
    content: first.content,
    decision: 'hold',
    note: 'Hold after comparable evidence.',
  });
  assert.equal(hold.status, 409);
  assert.equal((await hold.json()).error, 'hold_requires_three_comparable_snapshots');

  const sameHorizonComparables = plans.filter((plan) => (
    plan.campaign === first.campaign
    && plan.comparison_group === plans[0].comparison_group
    && plan.snapshot_days === 7
    && plan.content !== first.content
    && String(plan.id || '').startsWith('plan_')
  )).slice(0, 2);
  assert.equal(sameHorizonComparables.length, 2);
  for (const [index, plan] of sameHorizonComparables.entries()) {
    plan.published_at = '2026-07-01T12:00:00.000Z';
    metrics.push({
      id: `same_horizon_metric_${index + 1}`,
      campaign: plan.campaign,
      content: plan.content,
      snapshot_days: 7,
      snapshot_captured_at: '2026-07-08T12:00:00.000Z',
      published_at: '2026-07-01T12:00:00.000Z',
      reach: 75,
    });
  }
  const eligibleHold = await invoke({
    action: 'review',
    campaign: first.campaign,
    content: first.content,
    decision: 'hold',
    note: 'Three same-age comparable snapshots support pausing this concept.',
  });
  assert.equal(eligibleHold.status, 200);
  assert.equal(plans[0].review_decision, 'hold');

  metrics.push({
    ...structuredClone(metrics.find((metric) => metric.id === 'metric_7d')),
    id: 'metric_7d_conflict',
    reach: 999,
  });
  const conflictingReview = await invoke({
    action: 'review',
    campaign: first.campaign,
    content: first.content,
    decision: 'repeat',
    note: 'This must not bind to arbitrarily selected duplicate evidence.',
  });
  assert.equal(conflictingReview.status, 409);
  assert.equal((await conflictingReview.json()).error, 'content_snapshot_conflict');
  assert.equal(plans[0].review_decision, 'hold');
});

test('growth queue entities remain service-only', () => {
  const planSchema = JSON.parse(readSource('base44/entities/GrowthContentPlan.jsonc'));
  const metricSchema = JSON.parse(readSource('base44/entities/GrowthContentMetric.jsonc'));
  for (const action of ['create', 'read', 'update', 'delete']) {
    assert.equal(planSchema.rls[action].user_condition.id, '__service_role_only__');
    assert.equal(metricSchema.rls[action].user_condition.id, '__service_role_only__');
  }
});

test('growth CSV export neutralizes spreadsheet formulas and preserves quoting', () => {
  assert.equal(
    csvCell('=HYPERLINK("https://evil.example")'),
    `"'=HYPERLINK(""https://evil.example"")"`,
  );
  assert.equal(csvCell('  +SUM(1,1)'), '"\'  +SUM(1,1)"');
  assert.equal(csvCell('@command'), "'@command");
  assert.equal(csvCell('safe, value'), '"safe, value"');
  assert.equal(csvCell('line\rbreak'), '"line\rbreak"');
});

test('growth dashboard keeps queue evidence locked, repairable, and production-linked', () => {
  const dashboard = readSource('src/pages/GrowthDashboard.jsx');
  const queue = readSource('src/components/acquisition/GrowthActionQueue.jsx');
  assert.match(dashboard, /queueSnapshotLock\?\.publishedAt/);
  assert.match(dashboard, /queueSnapshotLock\?\.format/);
  assert.match(dashboard, /queueSnapshotLock\?\.hook/);
  assert.match(dashboard, /cta_variant:\s*queueSnapshotLock\?\.ctaVariant/);
  assert.match(dashboard, /buildGrowthPaceFromReport\(report\)/);
  assert.match(dashboard, /Path to 1,000/);
  assert.match(dashboard, /Gross retained cohort/);
  assert.match(dashboard, /FirstKnock keeps\s+ETA off/);
  assert.match(dashboard, /weekly_proxy_available/);
  assert.doesNotMatch(dashboard, /origin:\s*window\.location\.origin/);
  assert.match(queue, /Sync 30-day sprint/);
  assert.match(queue, /snapshot_action_days/);
  assert.match(queue, /htmlFor="growth-decision-note"/);
});

test('growth pace uses the documented baseline until the sample is mature', () => {
  const empty = buildGrowthPace();
  assert.equal(empty.rate_basis, 'planning_baseline');
  assert.equal(empty.remaining_users, 1000);
  assert.equal(empty.target_weekly.retained_users, 20);
  assert.ok(Math.abs(empty.target_weekly.reach - 9533.34) < 0.01);
  assert.equal(empty.target_weekly.activated_workspaces, 5);
  assert.equal(empty.target_weekly.content_assets, 5);
  assert.equal(empty.forecast_available, false);
  assert.equal('projected_goal_at' in empty, false);
  assert.equal(empty.weekly_proxy_available, false);
  assert.equal(empty.observed_weekly_proxy_28d.reach, null);
  assert.equal(empty.pace_ratio.reach, null);

  const smallSample = buildGrowthPace({
    retainedActiveUsers: 100,
    instagramReach28: 40000,
    instagramActivatedWorkspaces28: 20,
    instagramRetainedActiveUsers28: 80,
    measuredContentAssets: 29,
    measuredContentAssets28: 20,
    observationWindowComplete: true,
  });
  assert.equal(smallSample.rate_basis, 'planning_baseline');
  assert.equal(smallSample.observed_rates_ready, false);
  assert.ok(Math.abs(smallSample.reach_per_retained_user - 476.667) < 0.001);
  assert.equal(smallSample.observed_weekly_proxy_28d.retained_users, 20);

  const partialWindow = buildGrowthPace({
    instagramReach28: 7000,
    instagramActivatedWorkspaces28: 4,
    instagramRetainedActiveUsers28: 8,
    measuredContentAssets: 5,
    measuredContentAssets28: 5,
    observationWindowComplete: false,
  });
  assert.deepEqual(partialWindow.observed_totals_28d, {
    reach: 7000,
    activated_workspaces: 4,
    retained_users: 8,
    content_assets: 5,
  });
  assert.deepEqual(partialWindow.observed_weekly_proxy_28d, {
    reach: null,
    activated_workspaces: null,
    retained_users: null,
    content_assets: null,
  });
  assert.deepEqual(partialWindow.pace_ratio, {
    reach: null,
    activated_workspaces: null,
    retained_users: null,
    content_assets: null,
  });
});

test('growth pace marks a mature observed sample without turning it into an ETA', () => {
  const mature = buildGrowthPace({
    retainedActiveUsers: 100,
    instagramReach28: 40000,
    instagramActivatedWorkspaces28: 20,
    instagramRetainedActiveUsers28: 80,
    measuredContentAssets: 30,
    measuredContentAssets28: 20,
    observationWindowComplete: true,
  });
  assert.equal(mature.rate_basis, 'planning_baseline');
  assert.equal(mature.observed_rates_ready, true);
  assert.equal(mature.remaining_users, 900);
  assert.ok(Math.abs(mature.target_weekly.reach - 8580.006) < 0.001);
  assert.equal(mature.target_weekly.activated_workspaces, 4.5);
  assert.equal(mature.target_weekly.retained_users, 18);
  assert.equal(mature.observed_weekly_proxy_28d.reach, 10000);
  assert.equal(mature.observed_weekly_proxy_28d.activated_workspaces, 5);
  assert.equal(mature.observed_weekly_proxy_28d.retained_users, 20);
  assert.equal(mature.observed_weekly_proxy_28d.content_assets, 5);
  assert.equal(mature.forecast_available, false);

  const recordedZeroReach = buildGrowthPace({
    instagramReach28: 0,
    instagramActivatedWorkspaces28: 0,
    instagramRetainedActiveUsers28: 0,
    measuredContentAssets: 30,
    measuredContentAssets28: 20,
    observationWindowComplete: true,
  });
  assert.equal(recordedZeroReach.weekly_proxy_available, true);
  assert.equal(recordedZeroReach.observed_weekly_proxy_28d.reach, 0);
  assert.equal(recordedZeroReach.pace_ratio.reach, 0);
  assert.equal(recordedZeroReach.observed_rates_ready, false);

  const stoppedPublishing = buildGrowthPace({
    measuredContentAssets: 30,
    measuredContentAssets28: 0,
    observationWindowComplete: true,
  });
  assert.equal(stoppedPublishing.observed_weekly_proxy_28d.content_assets, 0);
  assert.equal(stoppedPublishing.pace_ratio.content_assets, 0);

  const complete = buildGrowthPace({
    retainedActiveUsers: 1200,
    instagramReach28: -1,
    instagramActivatedWorkspaces28: Number.NaN,
    measuredContentAssets: Number.POSITIVE_INFINITY,
    instagramRetainedActiveUsers28: 0,
    measuredContentAssets28: 0,
  });
  assert.equal(complete.goal_reached, true);
  assert.equal(complete.retained_active_users, 1200);
  assert.equal(complete.remaining_users, 0);
  assert.equal(complete.target_weekly.retained_users, 0);
  assert.equal(complete.target_weekly.reach, 0);
  assert.equal(complete.target_weekly.activated_workspaces, 0);
  assert.equal(complete.target_weekly.content_assets, 0);
  assert.equal(complete.pace_ratio.retained_users, null);
});

test('growth pace adapter keeps all-source progress separate from Instagram throughput', () => {
  const pace = buildGrowthPaceFromReport({
    all_time: {
      retained_active_users_30d: 100,
      instagram_retained_active_users_30d: 90,
      instagram_content_assets: 30,
    },
    last_28_days: {
      retained_active_users_30d: 80,
      instagram_retained_active_users_30d: 70,
      instagram_reach: 90000,
      instagram_activated_workspaces: 40,
    },
    pace_evidence: {
      measured_content_assets_all_time: 30,
      observation_window_complete: true,
      last_28_days: {
        instagram_reach: 40000,
        instagram_content_assets: 20,
        instagram_activated_workspaces: 5,
        instagram_retained_active_users_30d: 20,
      },
    },
  });

  assert.equal(pace.retained_active_users, 100);
  assert.equal(pace.remaining_users, 900);
  assert.equal(pace.measured_content_assets, 30);
  assert.equal(pace.observed_weekly_proxy_28d.reach, 10000);
  assert.equal(pace.observed_weekly_proxy_28d.activated_workspaces, 1.25);
  assert.equal(pace.observed_weekly_proxy_28d.retained_users, 5);
  assert.equal(pace.observed_weekly_proxy_28d.content_assets, 5);
});

test('growth pace status names the earliest trustworthy operating constraint', () => {
  const cases = [
    [{}, 'No measured baseline yet'],
    [{
      measuredContentAssets: 1,
      measuredContentAssets28: 1,
      instagramReach28: 1000,
    }, '28-day observation window incomplete'],
    [{
      measuredContentAssets: 30,
      measuredContentAssets28: 0,
      observationWindowComplete: true,
    }, 'Publishing cadence is the constraint'],
    [{
      measuredContentAssets: 30,
      measuredContentAssets28: 1,
      observationWindowComplete: true,
    }, 'Reach is the constraint'],
    [{
      measuredContentAssets: 30,
      measuredContentAssets28: 1,
      instagramReach28: 10000,
      observationWindowComplete: true,
    }, 'Activation is the constraint'],
    [{
      measuredContentAssets: 30,
      measuredContentAssets28: 1,
      instagramReach28: 10000,
      instagramActivatedWorkspaces28: 4,
      observationWindowComplete: true,
    }, 'Retention is the constraint'],
    [{
      measuredContentAssets: 30,
      measuredContentAssets28: 1,
      instagramActivatedWorkspaces28: 4,
      instagramRetainedActiveUsers28: 4,
      observationWindowComplete: true,
    }, 'Attribution baseline is incomplete'],
    [{ retainedActiveUsers: 1200 }, 'Goal reached'],
  ];

  for (const [input, expectedTitle] of cases) {
    assert.equal(getGrowthPaceStatus(buildGrowthPace(input)).title, expectedTitle);
  }
});

test('growth pace sanitizes invalid inputs without NaN or Infinity', () => {
  const pace = buildGrowthPace({
    goalUsers: Number.NaN,
    retainedActiveUsers: Number.POSITIVE_INFINITY,
    instagramReach28: Number.NEGATIVE_INFINITY,
    instagramActivatedWorkspaces28: -10,
    instagramRetainedActiveUsers28: Number.NaN,
    measuredContentAssets: -30,
    measuredContentAssets28: Number.POSITIVE_INFINITY,
    horizonWeeks: 0,
  });
  const visit = (value) => {
    if (typeof value === 'number') assert.equal(Number.isFinite(value), true);
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(pace);
});
