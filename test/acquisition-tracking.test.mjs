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
      hook: 'Route rescue',
      snapshot_days: 7,
      snapshot_captured_at: now,
      published_at: now,
      reach: 1000,
      views: 1200,
      shares: 15,
      saves: 20,
    },
  ];
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
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/getAcquisitionReport/entry.ts', base44);
  const response = await handler(new Request('https://firstknock.online/api/report', { method: 'POST' }));
  const report = await response.json();

  assert.equal(response.status, 200);
  assert.equal(report.all_time.users, 9);
  assert.equal(report.all_time.activated_users, 3);
  assert.equal(report.all_time.instagram_acquired_users, 4);
  assert.equal(report.all_time.instagram_signups, 2);
  assert.equal(report.all_time.instagram_activated_workspaces, 1);
  assert.equal(report.all_time.instagram_activated_users, 2);
  assert.equal(report.all_time.instagram_paid_users, 1);
  assert.equal(report.all_time.instagram_active_rep_roster, 7);
  assert.equal(report.all_time.instagram_joined_reps, 2);
  assert.equal(report.all_time.instagram_activated_reps, 1);
  assert.equal(report.all_time.instagram_rep_identity_conflicts, 1);
  assert.equal(report.all_time.instagram_reach, 1000);
  assert.equal(report.all_time.instagram_landing_sessions, 1);
  assert.equal(report.all_time.instagram_signup_cta_sessions, 1);
  assert.equal(report.all_time.retained_active_users_30d, 2);
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
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('rep1@example.com'), false);
  assert.equal(serialized.includes('member_1'), false);
  assert.equal(serialized.includes('manager_1'), false);
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
      record.campaign === query.campaign && record.content === query.content
    )),
    create: async (value) => {
      const created = { id: 'metric_1', ...structuredClone(value) };
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
  const invoke = (reach) => handler(new Request('https://firstknock.online/api/metric', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      campaign: '1000 Users',
      content: 'IG Snapshot 01',
      format: 'reel',
      snapshot_days: 7,
      reach,
      views: reach + 100,
    }),
  }));

  const created = await invoke(1000);
  assert.equal(created.status, 200);
  assert.equal((await created.json()).created, true);
  assert.equal(records[0].campaign, '1000-users');
  assert.equal(records[0].content, 'ig-snapshot-01');
  assert.equal(records[0].reach, 1000);

  const updated = await invoke(1500);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).created, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].reach, 1500);
});
