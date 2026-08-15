import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {
  ACQUISITION_STORAGE_KEY,
  buildInstagramTrackedLink,
  buildPlatformTrackedLink,
  captureAcquisitionTouch,
  isGenericAcquisitionContent,
  markStoredAcquisitionSynced,
  parseAcquisitionTouch,
  readStoredAcquisition,
  reportStoredAcquisitionContent,
  shouldSyncStoredAcquisition,
} from '../src/lib/acquisitionTracking.js';
import {
  buildAcquisitionEvent,
  getAcquisitionIdentity,
} from '../src/lib/acquisitionEvents.js';
import { syncAcquisitionAttribution } from '../src/lib/acquisitionSync.js';
import { INSTAGRAM_FIRST_30_DAYS } from '../src/data/instagramFirst30Days.js';
import { csvCell } from '../src/lib/csvExport.js';
import {
  buildGrowthPace,
  buildGrowthPaceFromReport,
  getGrowthPaceStatus,
} from '../src/lib/growthPace.js';
import { writeAcquisitionMilestone } from '../base44/functions/_shared/acquisitionMilestones.js';
import * as decisionPolicyHelpers from '../base44/functions/_shared/growthDecisionSufficiency.js';

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
    ...decisionPolicyHelpers,
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

function attributionUserEntity(user, updates = []) {
  let revision = 0;
  if (!user.updated_date) {
    user.updated_date = '2026-07-28T17:00:00.000Z';
  }
  return {
    get: async () => structuredClone(user),
    updateMany: async (query, operations) => {
      if (
        query.id !== user.id
        || query.updated_date !== user.updated_date
      ) {
        return { updated: 0 };
      }
      const patch = structuredClone(operations?.$set || {});
      updates.push(patch);
      Object.assign(user, patch);
      revision += 1;
      user.updated_date = new Date(
        Date.parse('2026-07-28T17:00:00.000Z') + revision * 1000,
      ).toISOString();
      return { updated: 1 };
    },
  };
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

test('TikTok referrers infer an organic social touch on the neutral landing path', () => {
  const touch = parseAcquisitionTouch({
    href: 'https://firstknock.online/start',
    referrer: 'https://vm.tiktok.com/ZM123456/',
    now: new Date('2026-07-28T18:00:00.000Z'),
  });

  assert.deepEqual(touch, {
    source: 'tiktok',
    medium: 'organic_social',
    campaign: 'unassigned',
    content: 'unassigned',
    term: '',
    landing_path: '/start',
    referrer_host: 'vm.tiktok.com',
    captured_at: '2026-07-28T18:00:00.000Z',
  });
});

test('explicit tracking parameters override a social referrer inference', () => {
  const touch = parseAcquisitionTouch({
    href: 'https://firstknock.online/start?utm_source=instagram&utm_medium=organic_social&utm_content=ig-explicit',
    referrer: 'https://www.tiktok.com/',
    now: new Date('2026-07-28T18:00:00.000Z'),
  });

  assert.equal(touch.source, 'instagram');
  assert.equal(touch.medium, 'organic_social');
  assert.equal(touch.content, 'ig-explicit');
  assert.equal(touch.referrer_host, 'www.tiktok.com');
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

test('platform tracked links share /start while preserving platform identity', () => {
  for (const [platform, contentId, fallback] of [
    ['instagram', 'IG Neutral 01', 'ig-neutral-01'],
    ['tiktok', 'TT Neutral 01', 'tt-neutral-01'],
  ]) {
    const link = new URL(buildPlatformTrackedLink({
      platform,
      campaign: '1,000 Users',
      contentId,
    }));
    assert.equal(link.pathname, '/start');
    assert.equal(link.searchParams.get('utm_source'), platform);
    assert.equal(link.searchParams.get('utm_medium'), 'organic_social');
    assert.equal(link.searchParams.get('utm_campaign'), '1-000-users');
    assert.equal(link.searchParams.get('utm_content'), fallback);
  }

  assert.throws(
    () => buildPlatformTrackedLink({ platform: 'youtube' }),
    /supported acquisition platform/,
  );
});

test('visitor-reported content preserves a generic bio touch and only refines the current unsynced journey', () => {
  const storage = memoryStorage();
  captureAcquisitionTouch({
    href: 'https://firstknock.online/start?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-bio',
    now: new Date('2026-07-28T18:00:00.000Z'),
    storage,
  });
  const capturedAt = readStoredAcquisition(storage).last_touch.captured_at;
  const reported = reportStoredAcquisitionContent({
    platform: 'instagram',
    campaign: '1000-users',
    contentId: 'ig-rs-route-command-01',
    expectedCapturedAt: capturedAt,
    now: new Date('2026-07-28T18:01:00.000Z'),
    storage,
  });

  assert.equal(reported.status, 'reported');
  const stored = readStoredAcquisition(storage);
  assert.equal(stored.first_touch.content, 'ig-bio');
  assert.equal(stored.last_touch.content, 'ig-bio');
  assert.equal(stored.first_touch.reported_content_id, 'ig-rs-route-command-01');
  assert.equal(stored.last_touch.reported_content_method, 'visitor_self_report');
  assert.equal(
    stored.last_touch.reported_content_at,
    '2026-07-28T18:01:00.000Z',
  );
  assert.equal(isGenericAcquisitionContent('instagram', 'ig-bio'), true);
  assert.equal(isGenericAcquisitionContent('instagram', 'ig-rs-route-command-01'), false);

  markStoredAcquisitionSynced('user_assist_1', storage);
  assert.equal(
    reportStoredAcquisitionContent({
      platform: 'instagram',
      campaign: '1000-users',
      contentId: 'ig-rs-outcome-controls-01',
      expectedCapturedAt: capturedAt,
      storage,
    }).status,
    'stale',
  );
});

test('a landing cannot report content onto a newer same-platform journey created in another tab', () => {
  const storage = memoryStorage();
  const href = 'https://firstknock.online/start?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-bio';
  captureAcquisitionTouch({
    href,
    now: new Date('2026-07-28T18:00:00.000Z'),
    storage,
  });
  const boundLandingCapturedAt = readStoredAcquisition(storage).last_touch.captured_at;

  captureAcquisitionTouch({
    href,
    now: new Date('2026-07-28T18:02:00.000Z'),
    storage,
  });
  const newerJourney = readStoredAcquisition(storage);
  assert.notEqual(newerJourney.last_touch.captured_at, boundLandingCapturedAt);

  const reported = reportStoredAcquisitionContent({
    platform: 'instagram',
    campaign: '1000-users',
    contentId: 'ig-rs-route-command-01',
    expectedCapturedAt: boundLandingCapturedAt,
    now: new Date('2026-07-28T18:03:00.000Z'),
    storage,
  });

  assert.equal(reported.status, 'stale');
  const stored = readStoredAcquisition(storage);
  assert.equal(stored.last_touch.captured_at, '2026-07-28T18:02:00.000Z');
  assert.equal(stored.last_touch.content, 'ig-bio');
  assert.equal(stored.last_touch.reported_content_id, undefined);
});

test('visitor-reported content cannot overwrite an exact link or cross platforms', () => {
  const storage = memoryStorage();
  captureAcquisitionTouch({
    href: 'https://firstknock.online/start?utm_source=tiktok&utm_medium=organic_social&utm_campaign=1000-users&utm_content=tt-exact',
    now: new Date('2026-07-28T18:00:00.000Z'),
    storage,
  });
  const capturedAt = readStoredAcquisition(storage).last_touch.captured_at;
  assert.equal(
    reportStoredAcquisitionContent({
      platform: 'tiktok',
      campaign: '1000-users',
      contentId: 'tt-rs-route-command-01',
      expectedCapturedAt: capturedAt,
      storage,
    }).status,
    'stale',
  );
  assert.equal(
    reportStoredAcquisitionContent({
      platform: 'tiktok',
      campaign: '1000-users',
      contentId: 'ig-rs-route-command-01',
      expectedCapturedAt: capturedAt,
      storage,
    }).status,
    'invalid',
  );
  assert.equal(readStoredAcquisition(storage).last_touch.content, 'tt-exact');
});

test('a bare landing event can explicitly ignore an unrelated stored touch', () => {
  const storage = memoryStorage();
  captureAcquisitionTouch({
    href: 'https://firstknock.online/start?utm_source=instagram&utm_campaign=1000-users&utm_content=ig-old',
    now: new Date('2026-07-01T18:00:00.000Z'),
    storage,
  });
  const event = buildAcquisitionEvent('landing_viewed', {
    identity: {
      anonymous_id: 'anon_bare_landing',
      session_id: 'session_bare_landing',
    },
    landingPath: '/start',
    storage,
    touchOverride: null,
    useStoredTouch: false,
    now: new Date('2026-07-28T18:00:00.000Z'),
  });
  assert.equal(event.touch, null);
  assert.equal(readStoredAcquisition(storage).last_touch.content, 'ig-old');
});

test('/start and /instagram reuse the same public acquisition landing UI', () => {
  const app = readSource('src/App.jsx');
  assert.equal(
    app.includes('<Route path="/start" element={<InstagramLanding />} />'),
    true,
  );
  assert.equal(
    app.includes('<Route path="/instagram" element={<InstagramLanding />} />'),
    true,
  );
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

test('authenticated attribution retries transient failures and marks the exact local journey only after success', async () => {
  const storage = memoryStorage();
  captureAcquisitionTouch({
    href: 'https://firstknock.online/start?utm_source=tiktok&utm_medium=organic_social&utm_campaign=1000-users&utm_content=tt-retry',
    now: new Date('2026-07-28T18:00:00.000Z'),
    storage,
  });
  const stored = readStoredAcquisition(storage);
  const calls = [];
  const waits = [];
  const result = await syncAcquisitionAttribution({
    invoke: async (functionName, payload) => {
      calls.push({ functionName, payload: structuredClone(payload) });
      if (calls.length === 1) throw new Error('temporary network outage');
      return { success: true };
    },
    userId: 'user_retry_1',
    stored,
    identity: {
      anonymous_id: 'anon_retry_1',
      session_id: 'session_retry_1',
    },
    storage,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  assert.deepEqual(result, { status: 'synced', attempts: 2 });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [500]);
  assert.equal(calls[0].functionName, 'captureAcquisitionAttribution');
  assert.equal(calls[0].payload.first_touch.content, 'tt-retry');
  assert.equal(
    shouldSyncStoredAcquisition(readStoredAcquisition(storage), 'user_retry_1'),
    false,
  );
});

test('authenticated attribution cancellation stops retries and never marks the local journey synced', async () => {
  const storage = memoryStorage();
  captureAcquisitionTouch({
    href: 'https://firstknock.online/start?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-cancel',
    now: new Date('2026-07-28T18:00:00.000Z'),
    storage,
  });
  const stored = readStoredAcquisition(storage);
  let cancelled = false;
  let calls = 0;
  const result = await syncAcquisitionAttribution({
    invoke: async () => {
      calls += 1;
      throw new Error('temporary network outage');
    },
    userId: 'user_cancel_1',
    stored,
    identity: {
      anonymous_id: 'anon_cancel_1',
      session_id: 'session_cancel_1',
    },
    storage,
    shouldCancel: () => cancelled,
    sleep: async () => {
      cancelled = true;
    },
  });

  assert.deepEqual(result, { status: 'canceled', attempts: 1 });
  assert.equal(calls, 1);
  assert.equal(
    shouldSyncStoredAcquisition(readStoredAcquisition(storage), 'user_cancel_1'),
    true,
  );
});

test('backend preserves first touch and updates only last touch on later visits', async () => {
  const user = { id: 'user_1', email: 'owner@example.com' };
  const updates = [];
  const events = [];
  const base44 = {
    auth: { me: async () => ({ id: user.id, email: user.email }) },
    asServiceRole: {
      entities: {
        User: attributionUserEntity(user, updates),
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

test('authenticated attribution preserves a visitor-reported assist without replacing generic bio content', async () => {
  const user = { id: 'assist_user', email: 'assist@example.com' };
  const events = [];
  const base44 = {
    auth: { me: async () => ({ id: user.id, email: user.email }) },
    asServiceRole: {
      entities: {
        User: attributionUserEntity(user),
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
  const response = await handler(new Request(
    'https://firstknock.online/api/capture',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        first_touch: {
          source: 'instagram',
          medium: 'organic_social',
          campaign: '1000-users',
          content: 'ig-bio',
          reported_content_id: 'ig-rs-route-command-01',
          reported_content_method: 'visitor_self_report',
          reported_content_at: '2026-07-28T18:01:00.000Z',
          landing_path: '/start',
          captured_at: '2026-07-28T18:00:00.000Z',
        },
        last_touch: {
          source: 'instagram',
          medium: 'organic_social',
          campaign: '1000-users',
          content: 'ig-bio',
          reported_content_id: 'ig-rs-route-command-01',
          reported_content_method: 'visitor_self_report',
          reported_content_at: '2026-07-28T18:01:00.000Z',
          landing_path: '/start',
          captured_at: '2026-07-28T18:00:00.000Z',
        },
        anonymous_id: 'anon_assist_user',
        session_id: 'session_assist_user',
      }),
    },
  ));
  assert.equal(response.status, 200);
  assert.equal(user.acquisition_first_touch.content, 'ig-bio');
  assert.equal(
    user.acquisition_first_touch.reported_content_id,
    'ig-rs-route-command-01',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].content, 'ig-bio');
  assert.equal(events[0].reported_content_id, 'ig-rs-route-command-01');
});

test('concurrent attribution capture allows exactly one immutable first touch and preserves the newest last touch', async () => {
  const user = {
    id: 'concurrent_user',
    email: 'concurrent@example.com',
    updated_date: '2026-07-28T17:00:00.000Z',
  };
  const successfulWrites = [];
  let revision = 0;
  let initialReads = 0;
  let releaseInitialReads;
  const initialReadBarrier = new Promise((resolveBarrier) => {
    releaseInitialReads = resolveBarrier;
  });
  const userEntity = {
    get: async () => {
      const snapshot = structuredClone(user);
      if (snapshot.updated_date === '2026-07-28T17:00:00.000Z') {
        initialReads += 1;
        if (initialReads === 2) releaseInitialReads();
        await initialReadBarrier;
      }
      return snapshot;
    },
    updateMany: async (query, operations) => {
      if (
        query.id !== user.id
        || query.updated_date !== user.updated_date
      ) {
        return { updated: 0 };
      }
      const patch = structuredClone(operations?.$set || {});
      successfulWrites.push(patch);
      Object.assign(user, patch);
      revision += 1;
      user.updated_date = new Date(
        Date.parse('2026-07-28T17:00:00.000Z') + revision * 1000,
      ).toISOString();
      return { updated: 1 };
    },
  };
  const base44 = {
    auth: {
      me: async () => ({ id: user.id, email: user.email }),
    },
    asServiceRole: {
      entities: {
        User: userEntity,
        AcquisitionEvent: {
          filter: async () => [{ id: 'existing_auth_event' }],
          create: async () => {
            throw new Error('auth event should already exist');
          },
        },
      },
    },
  };
  const handler = loadDenoHandler(
    'base44/functions/captureAcquisitionAttribution/entry.ts',
    base44,
  );
  const invoke = (content, capturedAt) => handler(new Request(
    'https://firstknock.online/api/capture',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        first_touch: {
          source: 'instagram',
          medium: 'organic_social',
          campaign: '1000-users',
          content,
          landing_path: '/start',
          captured_at: capturedAt,
        },
        last_touch: {
          source: 'instagram',
          medium: 'organic_social',
          campaign: '1000-users',
          content,
          landing_path: '/start',
          captured_at: capturedAt,
        },
        anonymous_id: `anon_${content}`,
        session_id: `session_${content}`,
      }),
    },
  ));

  const [firstResponse, secondResponse] = await Promise.all([
    invoke('ig-concurrent-first', '2026-07-28T18:00:00.000Z'),
    invoke('ig-concurrent-second', '2026-07-28T18:05:00.000Z'),
  ]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  const firstBody = await firstResponse.json();
  const secondBody = await secondResponse.json();

  assert.equal(initialReads, 2);
  assert.equal(
    successfulWrites.filter((write) => write.acquisition_first_touch).length,
    1,
  );
  assert.equal(
    firstBody.first_touch.content,
    secondBody.first_touch.content,
  );
  assert.equal(
    user.acquisition_first_touch.content,
    firstBody.first_touch.content,
  );
  assert.equal(user.acquisition_last_touch.content, 'ig-concurrent-second');
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
        User: attributionUserEntity(user),
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
      first_paid_at: now,
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
      snapshot_captured_at: sixDaysAgo,
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
      published_at: sevenAndHalfDaysAgo,
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
      published_at: sevenAndHalfDaysAgo,
      reach: 1000,
      views: 1200,
      shares: 15,
      saves: 20,
      link_clicks: 12,
      dm_intents: 3,
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
      published_at: sevenAndHalfDaysAgo,
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
        GrowthPublishJob: {
          list: async () => [],
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
  assert.equal(report.all_time.instagram_cumulative_post_reach, 1000);
  assert.match(report.definitions.cumulative_post_reach, /not unique campaign reach/);
  assert.match(report.definitions.pace_reach_basis, /TikTok views.*never added/);
  assert.equal(report.all_time.instagram_content_assets, 1);
  assert.equal(report.all_time.instagram_link_clicks, 12);
  assert.equal(report.all_time.instagram_dm_intents, 3);
  assert.equal(report.all_time.instagram_owned_intents, 15);
  assert.equal(report.all_time.instagram_owned_intents_observed_assets, 1);
  assert.equal(report.all_time.instagram_owned_intents_complete_assets, 1);
  assert.equal(report.all_time.social_owned_intents, 15);
  assert.equal(report.all_time.social_paid_users, 1);
  assert.equal(report.all_time.instagram_landing_sessions, 1);
  assert.equal(report.all_time.instagram_signup_cta_sessions, 1);
  assert.equal(report.all_time.retained_active_users_30d, 2);
  assert.equal(report.pace_evidence.campaign, '1000-users');
  assert.equal(report.pace_evidence.scope, 'canonical_mature_plan_backed_assets');
  assert.equal(report.pace_evidence.measured_content_assets_all_time, 1);
  assert.equal(report.pace_evidence.observation_window_complete, false);
  assert.equal(report.pace_evidence.last_28_days.instagram_reach, 1000);
  assert.equal(
    report.pace_evidence.last_28_days.instagram_cumulative_post_reach,
    1000,
  );
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
  assert.equal(report.by_content[0].active_rep_roster, null);
  assert.equal(report.by_content[0].joined_reps, null);
  assert.equal(report.by_content[0].activated_reps, 1);
  assert.equal(report.by_content[0].rep_identity_conflicts, null);
  assert.equal(report.by_content[0].roster_to_join_rate, null);
  assert.equal(report.by_content[0].joined_to_activation_rate, null);
  assert.equal(report.by_content[0].reach_to_signup_rate, 0.002);
  assert.equal(report.by_content[0].users_per_activated_workspace, 2);
  assert.equal(report.content_queue.items.length, 3);
  assert.equal(report.content_queue.next_publish.content, 'ig-future');
  assert.equal(report.content_queue.next_snapshot.content, 'ig-snapshot-due');
  assert.equal(report.content_queue.next_snapshot.snapshot_action_days, 7);
  assert.equal(report.content_queue.next_decision.content, 'ig-a');
  assert.equal(
    report.content_queue.next_decision.decision_policy_id,
    'growth-decision-sufficiency.v1',
  );
  assert.equal(report.content_queue.next_decision.social_evidence_hash, 'c'.repeat(64));
  assert.equal(report.content_queue.next_decision.decision_policy_base_supported, true);
  assert.equal(
    report.content_queue.next_decision
      .observed_platform_native_exposure_fields.includes('reach'),
    true,
  );
  assert.equal(
    Number.isSafeInteger(
      report.content_queue.next_decision.comparable_fixed_age_snapshots,
    ),
    true,
  );
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
  assert.equal(
    scopedPaceReport.all_time.instagram_reach,
    13000,
    'late cumulative checkpoints must not enter comparable operating reach',
  );
  assert.equal(scopedPaceReport.pace_evidence.measured_content_assets_all_time, 1);
  assert.equal(scopedPaceReport.pace_evidence.observation_window_complete, true);
  assert.equal(scopedPaceReport.pace_evidence.last_28_days.instagram_content_assets, 1);
  assert.equal(scopedPaceReport.pace_evidence.last_28_days.instagram_reach, 1000);
  for (const content of ['ig-due-in-window', 'ig-old-correction']) {
    const item = scopedPaceReport.content_queue.items.find(
      (candidate) => candidate.content === content,
    );
    assert.equal(item.state, 'snapshot_missed');
    assert.equal(item.snapshot_status, 'missed');
    assert.equal(item.snapshot_window_missed, true);
  }

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

test('scoped content report freezes publication-to-cutoff conversion evidence', async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - 40 * dayMs;
  const publishedMs = cutoffMs - 7 * dayMs;
  const iso = (value) => new Date(value).toISOString();
  const publishedAt = iso(publishedMs);
  const cutoffAt = iso(cutoffMs);
  const insideTouchAt = iso(publishedMs + 60 * 60 * 1000);
  const insideCreatedAt = iso(publishedMs + 2 * 60 * 60 * 1000);
  const insideActivationAt = iso(publishedMs + 3 * 60 * 60 * 1000);
  const insidePaidAt = iso(publishedMs + 4 * 60 * 60 * 1000);
  const beforeAt = iso(publishedMs - 60 * 60 * 1000);
  const afterAt = iso(cutoffMs + 60 * 60 * 1000);
  const touch = (capturedAt) => ({
    source: 'instagram',
    medium: 'organic_social',
    campaign: '1000-users',
    content: 'ig-bounded-cohort',
    captured_at: capturedAt,
  });
  const users = [
    {
      id: 'inside_manager',
      email: 'inside@example.com',
      app_role: 'manager',
      created_date: insideCreatedAt,
      acquisition_first_touch: touch(insideTouchAt),
      first_paid_at: insidePaidAt,
    },
    {
      id: 'before_manager',
      email: 'before@example.com',
      app_role: 'manager',
      created_date: beforeAt,
      acquisition_first_touch: touch(beforeAt),
    },
    {
      id: 'after_manager',
      email: 'after@example.com',
      app_role: 'manager',
      created_date: afterAt,
      acquisition_first_touch: touch(afterAt),
    },
    {
      id: 'synthetic_manager',
      email: 'synthetic@example.com',
      app_role: 'manager',
      created_date: insideCreatedAt,
      acquisition_first_touch: touch(insideTouchAt),
      is_test: true,
    },
  ];
  const routes = [
    {
      id: 'inside_route',
      created_by: 'inside@example.com',
      created_date: insideActivationAt,
      property_hashes: ['property_1'],
    },
    {
      id: 'before_route',
      created_by: 'before@example.com',
      created_date: beforeAt,
      property_hashes: ['property_2'],
    },
    {
      id: 'after_route',
      created_by: 'after@example.com',
      created_date: afterAt,
      property_hashes: ['property_3'],
    },
  ];
  const events = [
    {
      event_id: 'inside_landing',
      event_name: 'landing_viewed',
      session_id: 'inside_session',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-bounded-cohort',
      occurred_at: insideTouchAt,
    },
    {
      event_id: 'inside_cta',
      event_name: 'signup_cta_clicked',
      session_id: 'inside_session',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-bounded-cohort',
      occurred_at: insideCreatedAt,
    },
    {
      event_id: 'inside_auth',
      event_name: 'auth_completed',
      session_id: 'inside_session',
      user_id: 'inside_manager',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-bounded-cohort',
      occurred_at: insideCreatedAt,
    },
    {
      event_id: 'before_landing',
      event_name: 'landing_viewed',
      session_id: 'before_session',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-bounded-cohort',
      occurred_at: beforeAt,
    },
    {
      event_id: 'after_landing',
      event_name: 'landing_viewed',
      session_id: 'after_session',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-bounded-cohort',
      occurred_at: afterAt,
    },
    {
      event_id: 'synthetic_landing',
      event_name: 'landing_viewed',
      session_id: 'synthetic_session',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-bounded-cohort',
      occurred_at: insideTouchAt,
      is_test: true,
    },
  ];
  const metric = {
    id: 'bounded_metric',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-bounded-cohort',
    format: 'reel',
    snapshot_days: 7,
    published_at: publishedAt,
    snapshot_captured_at: cutoffAt,
    reach: 1000,
    views: 1200,
    link_clicks: 12,
    dm_intents: 3,
  };
  const plan = {
    id: 'bounded_plan',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-bounded-cohort',
    sprint: 'bounded-test',
    sequence: 1,
    format: 'reel',
    audience: 'Managers',
    hook: 'Bounded evidence',
    script: 'Bound every milestone.',
    cta_label: 'Open FirstKnock',
    cta_channel: 'story_link',
    primary_metric: 'Activated users',
    hypothesis: 'A declared handoff converts.',
    comparison_group: 'bounded',
    major_variable: 'handoff',
    planned_publish_at: publishedAt,
    published_at: publishedAt,
    snapshot_days: 7,
  };
  const list = (records) => async (_sort, limit, skip = 0) => (
    structuredClone(records.slice(skip, skip + limit))
  );
  const base44 = {
    auth: { me: async () => ({ id: 'owner', is_owner: true }) },
    asServiceRole: {
      entities: {
        User: { list: list(users) },
        SavedRoute: { list: list(routes) },
        CanvasSession: { list: list([]) },
        InteractionLog: { list: list([]) },
        TeamMember: { list: list([]) },
        AcquisitionEvent: { list: list(events) },
        GrowthContentMetric: { list: list([metric]) },
        GrowthContentPlan: { list: list([plan]) },
        GrowthPublishJob: { list: list([]) },
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/getAcquisitionReport/entry.ts', base44);
  const request = () => new Request('https://firstknock.online/api/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'instagram',
      campaign: '1000-users',
      content: 'ig-bounded-cohort',
      snapshot_captured_at: cutoffAt,
      conversion_cutoff_at: cutoffAt,
    }),
  });
  const firstResponse = await handler(request());
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200, JSON.stringify(first));
  assert.deepEqual(first.request_scope, {
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-bounded-cohort',
    cohort_start_at: publishedAt,
    conversion_cutoff_at: cutoffAt,
  });
  assert.equal(first.by_content.length, 1);
  const firstRow = first.by_content[0];
  assert.equal(firstRow.conversion_conclusion, 'exact_declared_link');
  assert.equal(firstRow.landing_sessions, 1);
  assert.equal(firstRow.signup_cta_sessions, 1);
  assert.equal(firstRow.auth_completed, 1);
  assert.equal(firstRow.decision_signups, 1);
  assert.equal(firstRow.decision_activated_workspaces, 1);
  assert.equal(firstRow.activated_users, 1);
  assert.equal(firstRow.paid_users, 1);
  assert.equal(firstRow.excluded_prepublication_events, 1);
  assert.equal(firstRow.excluded_post_cutoff_events, 1);
  assert.equal(firstRow.excluded_synthetic_events, 1);
  assert.equal(firstRow.excluded_prepublication_users, 1);
  assert.equal(firstRow.excluded_post_cutoff_users, 1);
  assert.equal(firstRow.excluded_synthetic_users, 1);

  events.push({
    event_id: 'later_post_cutoff_landing',
    event_name: 'landing_viewed',
    session_id: 'later_post_cutoff_session',
    source: 'instagram',
    campaign: '1000-users',
    content: 'ig-bounded-cohort',
    occurred_at: iso(cutoffMs + 2 * 60 * 60 * 1000),
  });
  users.push({
    id: 'later_post_cutoff_manager',
    email: 'later@example.com',
    app_role: 'manager',
    created_date: iso(cutoffMs + 2 * 60 * 60 * 1000),
    acquisition_first_touch: touch(iso(cutoffMs + 2 * 60 * 60 * 1000)),
  });
  const secondResponse = await handler(request());
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 200, JSON.stringify(second));
  const evidenceFields = [
    'landing_sessions',
    'signup_cta_sessions',
    'auth_completed',
    'decision_signups',
    'decision_activated_workspaces',
    'activated_users',
    'activated_reps',
    'paid_users',
    'retention_mature',
    'retention_eligible_users',
    'retained_users',
    'retention_rate',
    'first_activation_at',
    'last_activation_at',
  ];
  assert.deepEqual(
    Object.fromEntries(evidenceFields.map((field) => [field, second.by_content[0][field]])),
    Object.fromEntries(evidenceFields.map((field) => [field, firstRow[field]])),
    'records after the explicit cutoff must not drift frozen evidence',
  );

  const invalidResponse = await handler(new Request(
    'https://firstknock.online/api/report',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'instagram',
        campaign: '1000-users',
        content: 'ig-bounded-cohort',
      }),
    },
  ));
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { error: 'invalid_conversion_scope' });
});

test('content retention reports maturity, eligibility, and later verified activity', async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - dayMs;
  const publishedMs = cutoffMs - 30 * dayMs;
  const iso = (value) => new Date(value).toISOString();
  const publishedAt = iso(publishedMs);
  const cutoffAt = iso(cutoffMs);
  const touch = {
    source: 'instagram',
    medium: 'organic_social',
    campaign: '1000-users',
    content: 'ig-retention-cohort',
    captured_at: publishedAt,
  };
  const users = [
    {
      id: 'retained_manager',
      email: 'retained@example.com',
      app_role: 'manager',
      created_date: publishedAt,
      acquisition_first_touch: touch,
    },
    {
      id: 'not_retained_manager',
      email: 'not-retained@example.com',
      app_role: 'manager',
      created_date: publishedAt,
      acquisition_first_touch: touch,
    },
  ];
  const routes = [
    {
      id: 'retained_activation',
      created_by: 'retained@example.com',
      created_date: publishedAt,
      property_hashes: ['one'],
    },
    {
      id: 'retained_later_activity',
      created_by: 'retained@example.com',
      created_date: iso(cutoffMs - dayMs),
      property_hashes: ['two'],
    },
    {
      id: 'not_retained_activation',
      created_by: 'not-retained@example.com',
      created_date: publishedAt,
      property_hashes: ['three'],
    },
  ];
  const metric = {
    id: 'retention_metric',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-retention-cohort',
    snapshot_days: 30,
    published_at: publishedAt,
    snapshot_captured_at: cutoffAt,
    reach: 500,
    views: 600,
    link_clicks: 2,
    dm_intents: 0,
  };
  const plan = {
    id: 'retention_plan',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-retention-cohort',
    sprint: 'retention-test',
    sequence: 1,
    format: 'reel',
    audience: 'Managers',
    hook: 'Retention',
    script: 'Measure later product activity.',
    cta_label: 'Open FirstKnock',
    cta_channel: 'story_link',
    primary_metric: 'Retained users',
    hypothesis: 'Product proof retains.',
    comparison_group: 'retention',
    major_variable: 'activity',
    planned_publish_at: publishedAt,
    published_at: publishedAt,
    snapshot_days: 30,
  };
  const list = (records) => async (_sort, limit, skip = 0) => (
    structuredClone(records.slice(skip, skip + limit))
  );
  const base44 = {
    auth: { me: async () => ({ id: 'owner', is_owner: true }) },
    asServiceRole: {
      entities: {
        User: { list: list(users) },
        SavedRoute: { list: list(routes) },
        CanvasSession: { list: list([]) },
        InteractionLog: { list: list([]) },
        TeamMember: { list: list([]) },
        AcquisitionEvent: { list: list([]) },
        GrowthContentMetric: { list: list([metric]) },
        GrowthContentPlan: { list: list([plan]) },
        GrowthPublishJob: { list: list([]) },
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/getAcquisitionReport/entry.ts', base44);
  const response = await handler(new Request('https://firstknock.online/api/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'instagram',
      campaign: '1000-users',
      content: 'ig-retention-cohort',
      snapshot_captured_at: cutoffAt,
      conversion_cutoff_at: cutoffAt,
    }),
  }));
  const report = await response.json();
  assert.equal(response.status, 200, JSON.stringify(report));
  const row = report.by_content[0];
  assert.equal(row.retention_mature, true);
  assert.equal(row.activation_timing_complete, true);
  assert.equal(row.retention_eligible_users, 2);
  assert.equal(row.retained_users, 1);
  assert.equal(row.retention_rate, 0.5);
  assert.equal(row.first_activation_at, publishedAt);
  assert.equal(row.last_activation_at, publishedAt);
});

test('report locks Buffer repair while collecting and reports partial reach coverage against every due asset', async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const nowMs = Date.now();
  const iso = (value) => new Date(value).toISOString();
  const bufferPublishedAt = iso(nowMs - 7 * dayMs - 3 * hourMs);
  const instagramPublishedAt = iso(nowMs - 7 * dayMs - 2 * hourMs);
  const tiktokPublishedAt = iso(nowMs - 7 * dayMs - hourMs);
  const plan = ({
    id,
    platform,
    content,
    publishedAt,
    deliveryManagedBy = 'manual',
  }) => ({
    id,
    platform,
    campaign: '1000-users',
    content,
    sprint: deliveryManagedBy === 'buffer' ? 'content-engine' : 'coverage-test',
    sequence: 1,
    format: 'reel',
    hook: `Hook for ${content}`,
    planned_publish_at: publishedAt,
    published_at: publishedAt,
    delivery_managed_by: deliveryManagedBy,
    delivery_status: 'published',
    snapshot_days: 7,
  });
  const plans = [
    plan({
      id: 'plan_buffer_collecting',
      platform: 'instagram',
      content: 'ig-buffer-collecting',
      publishedAt: bufferPublishedAt,
      deliveryManagedBy: 'buffer',
    }),
    plan({
      id: 'plan_instagram_reach',
      platform: 'instagram',
      content: 'ig-observed-reach',
      publishedAt: instagramPublishedAt,
    }),
    plan({
      id: 'plan_tiktok_views',
      platform: 'tiktok',
      content: 'tt-views-only',
      publishedAt: tiktokPublishedAt,
    }),
  ];
  const metrics = [
    {
      id: 'metric_instagram_reach',
      platform: 'instagram',
      campaign: '1000-users',
      content: 'ig-observed-reach',
      format: 'reel',
      snapshot_days: 7,
      published_at: instagramPublishedAt,
      snapshot_captured_at: iso(
        Date.parse(instagramPublishedAt) + 7 * dayMs + 30 * 60 * 1000,
      ),
      reach: 100,
      observed_metric_fields: ['reach'],
    },
    {
      id: 'metric_tiktok_views',
      platform: 'tiktok',
      campaign: '1000-users',
      content: 'tt-views-only',
      format: 'reel',
      snapshot_days: 7,
      published_at: tiktokPublishedAt,
      snapshot_captured_at: iso(
        Date.parse(tiktokPublishedAt) + 7 * dayMs + 30 * 60 * 1000,
      ),
      views: 200,
      metric_source: 'buffer',
      provider_observed_metric_types: ['views'],
    },
  ];
  const jobs = [{
    id: 'job_buffer_collecting',
    provider: 'buffer',
    platform: 'instagram',
    campaign: '1000-users',
    platform_content_id: 'ig-buffer-collecting',
    metrics_published_at: bufferPublishedAt,
    metrics_next_checkpoint_at: iso(nowMs + 30 * 60 * 1000),
    metrics_checkpoints: [],
    provider_post_id: 'must-not-leak',
    provider_channel_id: 'must-not-leak',
    provider_metrics_hash: 'a'.repeat(64),
  }];
  const owner = {
    id: 'owner_buffer_queue',
    is_owner: true,
    app_role: 'admin',
    created_date: iso(nowMs),
  };
  const listEntity = (records) => ({
    list: async (_sort, limit, skip = 0) => (
      structuredClone(records.slice(skip, skip + limit))
    ),
  });
  const base44 = {
    auth: { me: async () => structuredClone(owner) },
    asServiceRole: {
      entities: {
        User: listEntity([owner]),
        SavedRoute: listEntity([]),
        CanvasSession: listEntity([]),
        InteractionLog: listEntity([]),
        TeamMember: listEntity([]),
        AcquisitionEvent: listEntity([]),
        GrowthContentMetric: listEntity(metrics),
        GrowthContentPlan: listEntity(plans),
        GrowthPublishJob: listEntity(jobs),
      },
    },
  };
  const handler = loadDenoHandler(
    'base44/functions/getAcquisitionReport/entry.ts',
    base44,
  );
  const invoke = async () => {
    const response = await handler(new Request(
      'https://firstknock.online/api/report',
      { method: 'POST' },
    ));
    assert.equal(response.status, 200);
    return response.json();
  };

  const collecting = await invoke();
  assert.equal(collecting.content_queue.next_snapshot.content, 'ig-buffer-collecting');
  assert.equal(
    collecting.content_queue.next_snapshot.snapshot_provider_checkpoint_status,
    'collecting',
  );
  assert.equal(
    collecting.content_queue.next_snapshot.snapshot_manual_entry_allowed,
    false,
  );
  assert.deepEqual(
    Object.keys(collecting.content_queue.next_snapshot.metric_collection).sort(),
    ['checkpoints', 'next_attempt_at', 'provider', 'status', 'sync_completed_at'],
  );
  const serializedQueue = JSON.stringify(collecting.content_queue);
  for (const forbidden of [
    'provider_post_id',
    'provider_channel_id',
    'provider_metrics_hash',
    'must-not-leak',
  ]) {
    assert.equal(serializedQueue.includes(forbidden), false);
  }
  const pace = collecting.pace_evidence.last_28_days;
  assert.equal(pace.instagram_expected_due_assets, 2);
  assert.equal(pace.instagram_captured_assets, 1);
  assert.equal(pace.instagram_reach_observed_assets, 1);
  assert.equal(pace.tiktok_expected_due_assets, 1);
  assert.equal(pace.tiktok_captured_assets, 1);
  assert.equal(pace.tiktok_reach_observed_assets, 0);
  assert.equal(pace.social_expected_due_assets, 3);
  assert.equal(pace.social_captured_assets, 2);
  assert.equal(pace.social_reach_observed_assets, 1);
  assert.equal(pace.social_reach, 100);

  jobs[0].metrics_checkpoints = [{
    snapshot_days: 7,
    due_at: iso(Date.parse(bufferPublishedAt) + 7 * dayMs),
    window_closes_at: iso(Date.parse(bufferPublishedAt) + 8 * dayMs),
    status: 'review_needed',
    recorded_at: iso(nowMs),
    error_code: 'buffer_metrics_unavailable',
  }];
  const reviewNeeded = await invoke();
  assert.equal(
    reviewNeeded.content_queue.next_snapshot.snapshot_provider_checkpoint_status,
    'review_needed',
  );
  assert.equal(
    reviewNeeded.content_queue.next_snapshot.snapshot_manual_entry_allowed,
    true,
  );
  assert.deepEqual(
    reviewNeeded.content_queue.next_snapshot.metric_collection.checkpoints[0],
    {
      snapshot_days: 7,
      status: 'review_needed',
      due_at: iso(Date.parse(bufferPublishedAt) + 7 * dayMs),
      window_closes_at: iso(Date.parse(bufferPublishedAt) + 8 * dayMs),
      recorded_at: iso(nowMs),
      error_code: 'buffer_metrics_unavailable',
    },
  );
});

test('owner report separates Instagram and TikTok reach and conversions by source', async () => {
  const now = new Date().toISOString();
  const publishedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const touch = (source) => ({
    source,
    medium: 'organic_social',
    campaign: '1000-users',
    content: 'shared-content-id',
    captured_at: now,
  });
  const users = [
    { id: 'owner', is_owner: true, app_role: 'manager', created_date: now },
    {
      id: 'ig_manager',
      email: 'ig@example.com',
      app_role: 'manager',
      created_date: now,
      acquisition_first_touch: touch('instagram'),
    },
    {
      id: 'tt_manager',
      email: 'tt@example.com',
      app_role: 'manager',
      created_date: now,
      acquisition_first_touch: touch('tiktok'),
    },
  ];
  const metrics = [
    {
      id: 'legacy_ig_metric',
      campaign: '1000-users',
      content: 'shared-content-id',
      format: 'reel',
      snapshot_days: 7,
      snapshot_captured_at: now,
      published_at: publishedAt,
      reach: 100,
      link_clicks: 4,
      dm_intents: 1,
      metric_source: 'buffer',
      provider_observed_metric_types: ['reach', 'link_clicks', 'dm_intents'],
    },
    {
      id: 'tt_metric',
      platform: 'tiktok',
      campaign: '1000-users',
      content: 'shared-content-id',
      format: 'reel',
      snapshot_days: 7,
      snapshot_captured_at: now,
      published_at: publishedAt,
      reach: 250,
      views: 300,
      comments: 4,
      follows: 2,
      link_clicks: 7,
      dm_intents: 3,
    },
    {
      id: 'ig_views_only_metric',
      platform: 'instagram',
      campaign: '1000-users',
      content: 'views-only-content',
      format: 'reel',
      snapshot_days: 7,
      snapshot_captured_at: now,
      published_at: publishedAt,
      views: 50,
      link_clicks: 2,
      metric_source: 'buffer',
      provider_observed_metric_types: ['views', 'link_clicks'],
    },
  ];
  const events = [
    {
      event_name: 'landing_viewed',
      source: 'instagram',
      campaign: '1000-users',
      content: 'shared-content-id',
      session_id: 'ig_session',
      occurred_at: now,
    },
    {
      event_name: 'landing_viewed',
      source: 'tiktok',
      campaign: '1000-users',
      content: 'shared-content-id',
      session_id: 'tt_session',
      occurred_at: now,
    },
    {
      event_name: 'signup_cta_clicked',
      source: 'tiktok',
      campaign: '1000-users',
      content: 'shared-content-id',
      session_id: 'tt_session',
      occurred_at: now,
    },
  ];
  const base44 = {
    auth: { me: async () => structuredClone(users[0]) },
    asServiceRole: {
      entities: {
        User: {
          list: async (_sort, limit, skip = 0) => structuredClone(
            users.slice(skip, skip + limit),
          ),
        },
        SavedRoute: {
          list: async () => [
            {
              created_by: 'ig@example.com',
              property_hashes: ['ig-property'],
              updated_date: now,
            },
            {
              created_by: 'tt@example.com',
              property_hashes: ['tt-property'],
              updated_date: now,
            },
          ],
        },
        CanvasSession: { list: async () => [] },
        InteractionLog: { list: async () => [] },
        TeamMember: { list: async () => [] },
        AcquisitionEvent: {
          list: async (_sort, limit, skip = 0) => structuredClone(
            events.slice(skip, skip + limit),
          ),
        },
        GrowthContentMetric: {
          list: async (_sort, limit, skip = 0) => structuredClone(
            metrics.slice(skip, skip + limit),
          ),
        },
        GrowthContentPlan: { list: async () => [] },
        GrowthPublishJob: { list: async () => [] },
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/getAcquisitionReport/entry.ts', base44);
  const response = await handler(
    new Request('https://firstknock.online/api/report', { method: 'POST' }),
  );
  const report = await response.json();

  assert.equal(response.status, 200);
  assert.equal(report.all_time.instagram_reach, 100);
  assert.equal(report.all_time.tiktok_reach, 250);
  assert.equal(report.all_time.social_reach, 350);
  assert.equal(report.all_time.instagram_views, 50);
  assert.equal(report.all_time.tiktok_views, 300);
  assert.equal(report.all_time.social_views, 350);
  assert.equal(report.all_time.instagram_link_clicks, 6);
  assert.equal(report.all_time.instagram_dm_intents, 1);
  assert.equal(report.all_time.instagram_owned_intents, 7);
  assert.equal(report.all_time.instagram_owned_intents_observed_assets, 2);
  assert.equal(report.all_time.instagram_owned_intents_complete_assets, 1);
  assert.equal(report.all_time.tiktok_link_clicks, 7);
  assert.equal(report.all_time.tiktok_dm_intents, 3);
  assert.equal(report.all_time.tiktok_owned_intents, 10);
  assert.equal(report.all_time.tiktok_owned_intents_observed_assets, 1);
  assert.equal(report.all_time.tiktok_owned_intents_complete_assets, 1);
  assert.equal(report.all_time.social_link_clicks, 13);
  assert.equal(report.all_time.social_dm_intents, 4);
  assert.equal(report.all_time.social_owned_intents, 17);
  assert.equal(report.all_time.social_owned_intents_observed_assets, 3);
  assert.equal(report.all_time.social_owned_intents_complete_assets, 2);
  assert.equal(report.last_28_days.social_owned_intents, 17);
  assert.equal(report.all_time.instagram_reach_observed_assets, 1);
  assert.equal(report.all_time.instagram_views_observed_assets, 1);
  assert.equal(report.all_time.tiktok_views_observed_assets, 1);
  assert.equal(report.last_28_days.instagram_views, 50);
  assert.equal(report.last_28_days.tiktok_views, 300);
  assert.equal(report.last_28_days.social_views, 350);
  assert.equal(report.last_28_days.social_views_observed_assets, 2);
  assert.equal(report.all_time.instagram_signups, 1);
  assert.equal(report.all_time.tiktok_signups, 1);
  assert.equal(report.all_time.instagram_activated_workspaces, 1);
  assert.equal(report.all_time.tiktok_activated_workspaces, 1);
  assert.equal(report.all_time.instagram_landing_sessions, 1);
  assert.equal(report.all_time.tiktok_landing_sessions, 1);
  assert.equal(report.all_time.tiktok_signup_cta_sessions, 1);
  assert.equal(report.by_content.length, 3);
  const instagram = report.by_content.find((row) => row.source === 'instagram');
  const tiktok = report.by_content.find((row) => row.source === 'tiktok');
  const viewsOnly = report.by_content.find(
    (row) => row.content === 'views-only-content',
  );
  assert.equal(instagram.content, 'shared-content-id');
  assert.equal(instagram.reach, 100);
  assert.equal(instagram.views, 0);
  assert.equal(instagram.reach_observed, true);
  assert.equal(instagram.views_observed, false);
  assert.equal(instagram.signups, null);
  assert.equal(instagram.conversion_conclusion, 'inconclusive_no_declared_link');
  assert.equal(tiktok.content, 'shared-content-id');
  assert.equal(tiktok.reach, 250);
  assert.equal(tiktok.views, 300);
  assert.equal(tiktok.comments, 4);
  assert.equal(tiktok.follows, 2);
  assert.equal(tiktok.views_observed, true);
  assert.equal(tiktok.signups, null);
  assert.equal(tiktok.activated_users, null);
  assert.equal(tiktok.conversion_conclusion, 'inconclusive_no_declared_link');
  assert.equal(viewsOnly.reach_observed, false);
  assert.equal(viewsOnly.views_observed, true);
  assert.equal(viewsOnly.reach_to_landing_rate, null);
  assert.equal(viewsOnly.reach_to_signup_rate, null);
  assert.equal(viewsOnly.reach_to_activation_rate, null);

  metrics.push({
    ...structuredClone(metrics[0]),
    id: 'ig_reported_zero_views_same_capture',
    views: 0,
    provider_observed_metric_types: ['reach', 'views'],
  });
  const conflictingResponse = await handler(
    new Request('https://firstknock.online/api/report', { method: 'POST' }),
  );
  assert.equal(
    conflictingResponse.status,
    409,
    'an unavailable view count and a provider-reported zero are distinct evidence',
  );
});

test('static bio conversions remain platform-level while visitor-reported post assists stay out of decision counts', async () => {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const publishedAt = new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString();
  const capturedAt = new Date(
    new Date(publishedAt).getTime() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const owner = {
    id: 'owner_assist_report',
    email: 'owner-assist@example.com',
    app_role: 'admin',
    is_owner: true,
    created_date: '2025-01-01T00:00:00.000Z',
  };
  const manager = {
    id: 'manager_assist_report',
    email: 'manager-assist@example.com',
    app_role: 'manager',
    created_date: now,
    acquisition_first_touch: {
      source: 'instagram',
      medium: 'organic_social',
      campaign: '1000-users',
      content: 'ig-bio',
      reported_content_id: 'ig-rs-route-command-01',
      reported_content_method: 'visitor_self_report',
      reported_content_at: now,
      captured_at: now,
    },
    acquisition_last_touch: {
      source: 'instagram',
      medium: 'organic_social',
      campaign: '1000-users',
      content: 'ig-bio',
      reported_content_id: 'ig-rs-route-command-01',
      reported_content_method: 'visitor_self_report',
      reported_content_at: now,
      captured_at: now,
    },
  };
  const existingManager = {
    id: 'existing_manager_late_assist',
    email: 'existing-manager-assist@example.com',
    app_role: 'manager',
    created_date: '2026-01-01T00:00:00.000Z',
    acquisition_first_touch: {
      source: 'direct',
      medium: 'none',
      campaign: 'unassigned',
      content: 'unassigned',
      captured_at: '2026-01-01T00:00:00.000Z',
    },
    acquisition_last_touch: {
      source: 'instagram',
      medium: 'organic_social',
      campaign: '1000-users',
      content: 'ig-bio',
      reported_content_id: 'ig-rs-route-command-01',
      reported_content_method: 'visitor_self_report',
      reported_content_at: now,
      captured_at: now,
    },
  };
  const events = [
    {
      event_name: 'landing_viewed',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-bio',
      session_id: 'session_assist_report',
      occurred_at: now,
    },
    {
      event_name: 'content_assist_reported',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-bio',
      reported_content_id: 'ig-rs-route-command-01',
      reported_content_method: 'visitor_self_report',
      session_id: 'session_assist_report',
      occurred_at: now,
    },
    {
      event_name: 'signup_cta_clicked',
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-bio',
      reported_content_id: 'ig-rs-route-command-01',
      reported_content_method: 'visitor_self_report',
      session_id: 'session_assist_report',
      occurred_at: now,
    },
  ];
  const metrics = [{
    id: 'metric_assist_report',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-rs-route-command-01',
    format: 'reel',
    hook: 'Route command demo',
    snapshot_days: 7,
    published_at: publishedAt,
    snapshot_captured_at: capturedAt,
    observed_metric_fields: ['reach', 'views'],
    reach: 1000,
    views: 1200,
  }];
  const plans = [{
    id: 'plan_assist_report',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-rs-route-command-01',
    sprint: 'assist-test',
    sequence: 1,
    format: 'reel',
    audience: 'managers',
    hook: 'Route command demo',
    script: 'Show the route command.',
    cta_label: 'See the demo',
    cta_channel: 'profile_link',
    primary_metric: 'activated workspaces',
    hypothesis: 'A clear route command demo increases qualified interest.',
    comparison_group: 'route-command',
    major_variable: 'hook',
    planned_publish_at: publishedAt,
    published_at: publishedAt,
    delivery_managed_by: 'buffer',
    delivery_status: 'published',
    snapshot_days: 7,
  }];
  const listEntity = (records) => ({
    list: async (_sort, limit, skip = 0) => (
      structuredClone(records.slice(skip, skip + limit))
    ),
  });
  const base44 = {
    auth: { me: async () => structuredClone(owner) },
    asServiceRole: {
      entities: {
        User: listEntity([owner, manager, existingManager]),
        SavedRoute: listEntity([{
          id: 'route_assist_report',
          created_by: manager.email,
          property_hashes: ['property_1'],
          created_date: now,
          updated_date: now,
        }]),
        CanvasSession: listEntity([]),
        InteractionLog: listEntity([]),
        TeamMember: listEntity([]),
        AcquisitionEvent: listEntity(events),
        GrowthContentMetric: listEntity(metrics),
        GrowthContentPlan: listEntity(plans),
        GrowthPublishJob: listEntity([]),
      },
    },
  };
  const handler = loadDenoHandler(
    'base44/functions/getAcquisitionReport/entry.ts',
    base44,
  );
  const response = await handler(new Request(
    'https://firstknock.online/api/report',
    { method: 'POST' },
  ));
  const report = await response.json();
  assert.equal(response.status, 200);

  const bio = report.by_content.find((row) => row.content === 'ig-bio');
  const post = report.by_content.find(
    (row) => row.content === 'ig-rs-route-command-01',
  );
  assert.equal(bio.attribution_granularity, 'platform');
  assert.equal(bio.attribution_method, 'static_bio');
  assert.equal(bio.signups, null);
  assert.equal(bio.activated_workspaces, null);
  assert.equal(post.attribution_granularity, 'content');
  assert.equal(post.attribution_method, 'social_evidence_only');
  assert.equal(post.post_conversion_eligible, false);
  assert.equal(post.conversion_conclusion, 'inconclusive_no_declared_link');
  assert.equal(post.signups, null);
  assert.equal(post.activated_workspaces, null);
  assert.equal(post.self_reported_landing_assists, 0);
  assert.equal(post.self_reported_signup_cta_assists, 0);
  assert.equal(post.self_reported_signup_assists, 0);
  assert.equal(post.self_reported_activated_workspace_assists, 0);
  assert.equal(post.decision_signups, null);
  assert.equal(post.decision_activated_workspaces, null);

  const queueItem = report.content_queue.items.find(
    (item) => item.content === 'ig-rs-route-command-01',
  );
  assert.equal(queueItem.signups, null);
  assert.equal(queueItem.activated_workspaces, null);
  assert.equal(queueItem.self_reported_signup_assists, 0);
  assert.equal(queueItem.self_reported_activated_workspace_assists, 0);
  assert.match(
    report.definitions.visitor_reported_assist,
    /excluded from Repeat, Iterate, and Hold/,
  );
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

test('public content choices expose only recent, strongly evidenced posts for the requested platform', async () => {
  const now = Date.now();
  const sentAt = (minutesAgo) => new Date(now - minutesAgo * 60 * 1000).toISOString();
  const validJob = ({
    content,
    platform = 'instagram',
    minutesAgo = 30,
    overrides = {},
  }) => {
    const publishedAt = sentAt(minutesAgo);
    return {
      job_key: 'a'.repeat(64),
      request_hash: 'b'.repeat(64),
      config_revision: 'c'.repeat(64),
      provider: 'buffer',
      provider_channel_id: `${platform}_channel`,
      provider_service: platform,
      provider_post_id: `${platform}_${content}`,
      platform,
      campaign: '1000-users',
      platform_content_id: content,
      hook_snapshot: `Hook for ${content}`,
      state: 'sent',
      provider_status: 'sent',
      provider_sent_at: publishedAt,
      metrics_published_at: publishedAt,
      ...overrides,
    };
  };
  const jobs = [
    validJob({ content: 'ig-rs-route-command-01', minutesAgo: 20 }),
    validJob({ content: 'ig-rs-outcome-controls-01', minutesAgo: 80 }),
    validJob({
      content: 'ig-missing-provider-clock',
      minutesAgo: 10,
      overrides: { provider_sent_at: undefined },
    }),
    validJob({
      content: 'ig-mismatched-clock',
      minutesAgo: 15,
      overrides: { metrics_published_at: sentAt(14) },
    }),
    validJob({
      content: 'ig-not-sent',
      minutesAgo: 5,
      overrides: { state: 'scheduled', provider_status: 'scheduled' },
    }),
    validJob({
      content: 'ig-too-old',
      minutesAgo: 8 * 24 * 60,
    }),
    validJob({
      content: 'tt-rs-route-command-01',
      platform: 'tiktok',
      minutesAgo: 25,
    }),
  ];
  const base44 = {
    asServiceRole: {
      entities: {
        GrowthPublishJob: {
          filter: async (query) => jobs.filter(
            (job) => job.platform === query.platform,
          ),
        },
      },
    },
  };
  const handler = loadDenoHandler(
    'base44/functions/getRecentGrowthContentChoices/entry.ts',
    base44,
  );
  const invoke = (body, origin = 'https://firstknock.online') => handler(
    new Request('https://firstknock.online/api/choices', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify(body),
    }),
  );
  const response = await invoke({
    source: 'instagram',
    campaign: '1000-users',
    content: 'ig-bio',
    landing_path: '/start',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    body.choices.map((choice) => choice.content),
    ['ig-rs-route-command-01', 'ig-rs-outcome-controls-01'],
  );
  assert.deepEqual(
    Object.keys(body.choices[0]).sort(),
    ['content', 'hook', 'published_at'],
  );
  assert.equal(JSON.stringify(body).includes('provider_post_id'), false);
  assert.equal(
    (await invoke({
      source: 'tiktok',
      campaign: '1000-users',
      content: 'tt-bio',
      landing_path: '/start',
    })).status,
    200,
  );
  assert.equal(
    (await invoke({
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-exact',
      landing_path: '/start',
    })).status,
    400,
  );
  assert.equal(
    (await invoke({
      source: 'instagram',
      campaign: '1000-users',
      content: 'ig-bio',
      landing_path: '/start',
    }, 'https://evil.example')).status,
    403,
  );
});

test('duplicate publish evidence is omitted from public content choices', async () => {
  const publishedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const job = {
    job_key: 'a'.repeat(64),
    request_hash: 'b'.repeat(64),
    config_revision: 'c'.repeat(64),
    provider: 'buffer',
    provider_channel_id: 'instagram_channel',
    provider_service: 'instagram',
    provider_post_id: 'duplicate_post',
    platform: 'instagram',
    campaign: '1000-users',
    platform_content_id: 'ig-duplicate',
    hook_snapshot: 'Duplicate',
    state: 'sent',
    provider_status: 'sent',
    provider_sent_at: publishedAt,
    metrics_published_at: publishedAt,
  };
  const handler = loadDenoHandler(
    'base44/functions/getRecentGrowthContentChoices/entry.ts',
    {
      asServiceRole: {
        entities: {
          GrowthPublishJob: {
            filter: async () => [
              job,
              { ...job, job_key: 'd'.repeat(64) },
            ],
          },
        },
      },
    },
  );
  const response = await handler(new Request(
    'https://firstknock.online/api/choices',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://firstknock.online',
      },
      body: JSON.stringify({
        source: 'instagram',
        campaign: '1000-users',
        content: 'ig-bio',
        landing_path: '/start',
      }),
    },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).choices, []);
});

test('public acquisition events accept /start and legacy /instagram, then deduplicate each session stage', async () => {
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
    landing_path: '/start',
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
  assert.equal(records[0].landing_path, '/start');

  assert.equal((await invoke({ ...payload, event_id: 'event_public_002' })).status, 200);
  assert.equal(records.length, 1, 'same session and stage should be deduplicated');

  const secondContent = await invoke({
    ...payload,
    event_id: 'event_public_second_content',
    touch: {
      ...payload.touch,
      content: 'ig-public-second',
    },
  });
  assert.equal(secondContent.status, 200);
  assert.equal(
    records.length,
    2,
    'a different tracked content touch in the same session must be preserved',
  );
  assert.equal(records[1].content, 'ig-public-second');

  const legacy = await invoke({
    ...payload,
    event_id: 'event_public_003',
    session_id: 'session_public_legacy',
    landing_path: '/Instagram/',
    touch: {
      ...payload.touch,
      content: 'ig-legacy',
    },
  });
  assert.equal(legacy.status, 200);
  assert.equal(records.length, 3);
  assert.equal(records[2].landing_path, '/instagram');
  assert.equal(records[2].content, 'ig-legacy');

  const tiktokEvent = buildAcquisitionEvent('signup_cta_clicked', {
    ctaVariant: 'hero-primary',
    landingPath: '/start',
    identity: {
      anonymous_id: 'anon_public_tiktok',
      session_id: 'session_public_tiktok',
    },
    storage: memoryStorage(),
    now: new Date(),
    cryptoApi: {
      randomUUID: () => 'event-public-tiktok',
    },
  });
  const tiktok = await invoke({
    ...tiktokEvent,
    touch: {
      source: 'tiktok',
      medium: 'organic_social',
      campaign: '1000-users',
      content: 'tt-public',
    },
  });
  assert.equal(tiktok.status, 200);
  assert.equal(records.length, 4);
  assert.equal(records[3].landing_path, '/start');
  assert.equal(records[3].source, 'tiktok');
  assert.equal(records[3].content, 'tt-public');

  const assist = await invoke({
    ...payload,
    event_id: 'event_public_assist',
    event_name: 'content_assist_reported',
    session_id: 'session_public_assist',
    touch: {
      source: 'instagram',
      medium: 'organic_social',
      campaign: '1000-users',
      content: 'ig-bio',
      reported_content_id: 'ig-rs-route-command-01',
      reported_content_method: 'visitor_self_report',
      reported_content_at: new Date().toISOString(),
    },
  });
  assert.equal(assist.status, 200);
  assert.equal(records.length, 5);
  assert.equal(records[4].content, 'ig-bio');
  assert.equal(records[4].reported_content_id, 'ig-rs-route-command-01');
  assert.equal(records[4].reported_content_method, 'visitor_self_report');

  const explicitSpoof = await invoke({
    ...payload,
    event_id: 'event_public_explicit_assist_spoof',
    session_id: 'session_public_explicit_assist_spoof',
    touch: {
      source: 'instagram',
      medium: 'organic_social',
      campaign: '1000-users',
      content: 'ig-exact-content',
      reported_content_id: 'ig-rs-route-command-01',
      reported_content_method: 'visitor_self_report',
      reported_content_at: new Date().toISOString(),
    },
  });
  assert.equal(explicitSpoof.status, 200);
  assert.equal(records.length, 6);
  assert.equal(records[5].content, 'ig-exact-content');
  assert.equal(records[5].reported_content_id, undefined);

  const invalidCases = [
    { event_id: 'event_public_004', event_name: 'purchase' },
    { event_id: 'event_public_005', landing_path: '/' },
    { event_id: 'event_public_006', landing_path: '/start/extra' },
    { event_id: 'event_public_007', landing_path: 'start' },
    { event_id: 'event_public_008', landing_path: undefined },
    {
      event_id: 'event_public_009',
      event_name: 'content_assist_reported',
      touch: {
        ...payload.touch,
        content: 'ig-bio',
      },
    },
  ];
  for (const invalid of invalidCases) {
    const rejected = await invoke({
      ...payload,
      session_id: `session_${invalid.event_id}`,
      ...invalid,
    });
    assert.equal(rejected.status, 400);
  }
  assert.equal(records.length, 6);
});

test('owner can upsert cumulative platform checkpoints without colliding', async () => {
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
    asServiceRole: {
      entities: {
        GrowthContentMetric: metricEntity,
        GrowthContentPlan: { filter: async () => [] },
        GrowthPublishJob: { filter: async () => [] },
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/upsertGrowthContentMetric/entry.ts', base44);
  const invoke = ({
    reach,
    capturedAt,
    snapshotDays = 7,
    platform,
    content = 'IG Snapshot 01',
  }) => handler(new Request('https://firstknock.online/api/metric', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      campaign: '1000 Users',
      content,
      platform,
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
  assert.equal(records[0].platform, 'instagram');
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

  const tiktok = await invoke({
    platform: 'tiktok',
    content: 'IG Snapshot 01',
    reach: 2200,
    capturedAt: secondCapturedAt,
  });
  assert.equal(tiktok.status, 200);
  assert.equal((await tiktok.json()).created, true);
  assert.equal(records.length, 3, 'the same content token may exist on both platforms');
  assert.equal(
    records.find((record) => record.platform === 'tiktok')?.reach,
    2200,
  );

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

test('manual repair creates a newer provider-free row without mutating Buffer evidence', async () => {
  const automated = {
    id: 'metric_buffer_d1',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-repair',
    format: 'reel',
    snapshot_days: 1,
    snapshot_captured_at: '2026-07-02T12:00:00.000Z',
    published_at: '2026-07-01T12:00:00.000Z',
    reach: 100,
    views: 150,
    snapshot_fingerprint: 'a'.repeat(64),
    metric_source: 'buffer',
    provider_post_id: 'buffer_post_original',
    provider_channel_id: 'buffer_channel_original',
    provider_metrics_updated_at: '2026-07-02T12:00:00.000Z',
    provider_metrics_hash: 'b'.repeat(64),
    provider_observed_metric_types: ['reach', 'views'],
  };
  const original = structuredClone(automated);
  const records = [automated];
  let creates = 0;
  let updates = 0;
  const bufferPlan = {
    id: 'plan_buffer_repair',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-repair',
    sprint: 'content-engine',
    delivery_managed_by: 'buffer',
    published_at: '2026-07-01T12:00:00.000Z',
    snapshot_days: 7,
  };
  const bufferJob = {
    id: 'job_buffer_repair',
    provider: 'buffer',
    platform: 'instagram',
    campaign: '1000-users',
    platform_content_id: 'ig-repair',
    metrics_published_at: '2026-07-01T12:00:00.000Z',
    metrics_checkpoints: [],
  };
  const metricEntity = {
    filter: async (query) => records.filter((record) => (
      record.campaign === query.campaign
      && record.content === query.content
      && record.snapshot_days === query.snapshot_days
    )).map((record) => structuredClone(record)),
    create: async (value) => {
      creates += 1;
      const created = { id: `metric_manual_${creates}`, ...structuredClone(value) };
      records.push(created);
      return structuredClone(created);
    },
    update: async () => {
      updates += 1;
      throw new Error('automated evidence must never be updated by a manual repair');
    },
  };
  const base44 = {
    auth: { me: async () => ({ id: 'owner', is_owner: true }) },
    asServiceRole: {
      entities: {
        GrowthContentMetric: metricEntity,
        GrowthContentPlan: {
          filter: async () => [structuredClone(bufferPlan)],
        },
        GrowthPublishJob: {
          filter: async () => [structuredClone(bufferJob)],
        },
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/upsertGrowthContentMetric/entry.ts', base44);
  const request = (overrides = {}) => new Request('https://firstknock.online/api/metric', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'instagram',
      campaign: '1000-users',
      content: 'ig-repair',
      format: 'reel',
      snapshot_days: 1,
      snapshot_captured_at: '2026-07-02T13:00:00.000Z',
      published_at: '2026-07-01T12:00:00.000Z',
      reach: 125,
      ...overrides,
    }),
  });

  const stillCollecting = await handler(request());
  assert.equal(stillCollecting.status, 409);
  assert.equal(
    (await stillCollecting.json()).error,
    'buffer_checkpoint_still_collecting',
  );
  assert.equal(creates, 0);
  assert.equal(records.length, 1);

  bufferJob.metrics_checkpoints = [{
    snapshot_days: 3,
    status: 'review_needed',
  }];
  const wrongCheckpoint = await handler(request());
  assert.equal(wrongCheckpoint.status, 409);
  assert.equal(
    (await wrongCheckpoint.json()).error,
    'buffer_checkpoint_still_collecting',
  );
  assert.equal(creates, 0);

  bufferJob.metrics_checkpoints = [{
    snapshot_days: 1,
    status: 'review_needed',
    due_at: '2026-07-02T12:00:00.000Z',
    window_closes_at: '2026-07-03T12:00:00.000Z',
    recorded_at: '2026-07-03T12:05:00.000Z',
    error_code: 'buffer_metrics_unavailable',
  }];
  const wrongPublicationClock = await handler(request({
    published_at: '2026-07-01T13:00:00.000Z',
  }));
  assert.equal(wrongPublicationClock.status, 409);
  assert.equal(
    (await wrongPublicationClock.json()).error,
    'buffer_checkpoint_identity_mismatch',
  );
  assert.equal(creates, 0);

  const repaired = await handler(request());
  const repairedBody = await repaired.json();

  assert.equal(repaired.status, 200);
  assert.equal(repairedBody.created, true);
  assert.equal(creates, 1);
  assert.equal(updates, 0);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], original);
  const manual = records[1];
  assert.equal(manual.reach, 125);
  assert.equal(manual.views, undefined);
  assert.deepEqual(manual.observed_metric_fields, ['reach']);
  for (const field of [
    'metric_source',
    'provider_post_id',
    'provider_channel_id',
    'provider_metrics_updated_at',
    'provider_metrics_hash',
    'provider_observed_metric_types',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(manual, field),
      false,
      `${field} must not leak onto the manual repair`,
    );
  }

  const replay = await handler(request());
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).idempotent, true);
  assert.equal(records.length, 2);
  assert.equal(creates, 1);
  assert.equal(updates, 0);

  const reportedZeroViews = await handler(new Request(
    'https://firstknock.online/api/metric',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'instagram',
        campaign: '1000-users',
        content: 'ig-repair',
        format: 'reel',
        snapshot_days: 1,
        snapshot_captured_at: '2026-07-02T13:00:00.000Z',
        published_at: '2026-07-01T12:00:00.000Z',
        reach: 125,
        views: 0,
      }),
    },
  ));
  assert.equal(
    reportedZeroViews.status,
    409,
    'an omitted manual field and an explicitly reported zero must not be idempotent',
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
        GrowthContentPlan: { filter: async () => [] },
        GrowthPublishJob: { filter: async () => [] },
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
        GrowthContentPlan: { filter: async () => [] },
        GrowthPublishJob: { filter: async () => [] },
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
  const blankExposure = await invoke({ reach: undefined });
  assert.equal(blankExposure.status, 400);
  assert.equal((await blankExposure.json()).field, 'reach_or_views');
  assert.equal((await invoke({ platform: 'youtube' })).status, 400);
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

test('growth plans use platform as part of their lifecycle identity', async () => {
  const plans = [];
  const planEntity = {
    list: async (_sort, limit, skip = 0) => structuredClone(
      plans.slice(skip, skip + limit),
    ),
    filter: async (query) => structuredClone(plans.filter((plan) => (
      plan.campaign === query.campaign && plan.content === query.content
    ))),
    create: async (value) => {
      const created = {
        id: `plan_${plans.length + 1}`,
        created_date: '2026-07-01T00:00:00.000Z',
        updated_date: '2026-07-01T00:00:00.000Z',
        ...structuredClone(value),
      };
      plans.push(created);
      return structuredClone(created);
    },
    updateMany: async (query, operations) => {
      const plan = plans.find((candidate) => (
        candidate.id === query.id
        && (
          query.updated_date === undefined
          || candidate.updated_date === query.updated_date
        )
      ));
      if (!plan) return { updated: 0 };
      Object.assign(plan, structuredClone(operations?.$set || {}), {
        updated_date: '2026-07-02T00:00:00.000Z',
      });
      return { updated: 1 };
    },
  };
  const base44 = {
    auth: { me: async () => ({ id: 'owner', is_owner: true }) },
    asServiceRole: {
      entities: {
        GrowthContentPlan: planEntity,
        GrowthCreativeArtifact: { filter: async () => [] },
      },
    },
  };
  const handler = loadDenoHandler('base44/functions/manageGrowthContentPlan/entry.ts', base44);
  const invoke = (body) => handler(new Request(
    'https://firstknock.online/api/content-plan',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ));
  const basePlan = {
    ...INSTAGRAM_FIRST_30_DAYS[0],
    content: 'shared-plan-id',
  };
  const seeded = await invoke({
    action: 'seed',
    plans: [
      { ...basePlan, platform: 'instagram' },
      { ...basePlan, platform: 'tiktok', sequence: basePlan.sequence + 1 },
    ],
  });
  assert.equal(seeded.status, 200);
  assert.equal((await seeded.json()).created, 2);
  assert.equal(plans.length, 2);

  const published = await invoke({
    action: 'publish',
    platform: 'tiktok',
    campaign: basePlan.campaign,
    content: basePlan.content,
    published_at: '2026-07-01T12:00:00.000Z',
  });
  assert.equal(published.status, 200);
  assert.equal(
    plans.find((plan) => plan.platform === 'tiktok')?.published_at,
    '2026-07-01T12:00:00.000Z',
  );
  assert.equal(
    plans.find((plan) => plan.platform === 'instagram')?.published_at,
    undefined,
  );
});

test('owner can seed, publish, and review the fixed-age growth queue', async () => {
  const plans = [];
  const metrics = [];
  const batches = [];
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
    functions: {
      invoke: async (functionName, data) => {
        assert.equal(functionName, 'getAcquisitionReport');
        const exactMetric = metrics
          .filter((metric) => (
            metric.campaign === data.campaign
            && metric.content === data.content
            && metric.snapshot_captured_at === data.snapshot_captured_at
          ))
          .at(-1);
        const exactPlan = plans.find((plan) => (
          plan.campaign === data.campaign && plan.content === data.content
        ));
        assert.equal(data.conversion_cutoff_at, data.snapshot_captured_at);
        const linkClicks = Number(exactMetric?.link_clicks || 0);
        const dmIntents = Number(exactMetric?.dm_intents || 0);
        return {
          data: {
            success: true,
            generated_at: '2026-07-08T12:30:00.000Z',
            request_scope: {
              platform: data.platform,
              campaign: data.campaign,
              content: data.content,
              cohort_start_at: exactPlan?.published_at,
              conversion_cutoff_at: data.conversion_cutoff_at,
            },
            by_content: [{
              source: data.platform,
              campaign: data.campaign,
              content: data.content,
              snapshot_days: Number(exactMetric?.snapshot_days || 7),
              cohort_start_at: exactPlan?.published_at,
              conversion_cutoff_at: data.conversion_cutoff_at,
              attribution_granularity: 'content',
              attribution_method: 'declared_content_link',
              conversion_evidence: 'client_declared_content_first_touch',
              post_conversion_eligible: true,
              conversion_conclusion: 'exact_declared_link',
              conversion_counters_available: true,
              link_clicks: linkClicks,
              dm_intents: dmIntents,
              owned_intents: linkClicks + dmIntents,
              landing_sessions: 4,
              signup_cta_sessions: 3,
              auth_completed: 2,
              decision_signups: 2,
              decision_activated_workspaces: 1,
              activated_users: 3,
              activated_reps: 2,
              paid_users: 1,
              activation_timing_complete: true,
              paid_timing_complete: true,
              first_activation_at: '2026-07-02T12:00:00.000Z',
              last_activation_at: '2026-07-07T12:00:00.000Z',
              retention_window_days: 30,
              retention_mature: false,
              retention_eligible_users: 0,
              retained_users: 0,
              retention_rate: null,
              missing_event_timestamps: 0,
              missing_user_timestamps: 0,
              activation_timing_missing_users: 0,
              paid_timing_missing_users: 0,
              excluded_prepublication_events: 0,
              excluded_post_cutoff_events: 0,
              excluded_synthetic_events: 0,
              excluded_prepublication_users: 0,
              excluded_post_cutoff_users: 0,
              excluded_invalid_timing_users: 0,
              excluded_synthetic_users: 0,
            }],
          },
        };
      },
    },
    asServiceRole: {
      entities: {
        GrowthContentPlan: planEntity,
        GrowthContentMetric: metricEntity,
        GrowthContentBatch: {
          filter: async (query) => structuredClone(batches.filter((batch) => (
            batch.parent_campaign === query.parent_campaign
            && batch.parent_content === query.parent_content
          ))),
        },
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
    metric_source: 'buffer',
    provider_observed_metric_types: [
      'reach',
      'views',
      'shares',
      'saves',
      'comments',
      'follows',
    ],
  });
  const reviewedMetric = metrics[1];
  const expectedEvidencePayload = {
    campaign: reviewedMetric.campaign,
    content: reviewedMetric.content,
    snapshot_days: reviewedMetric.snapshot_days,
    snapshot_captured_at: reviewedMetric.snapshot_captured_at,
    published_at: reviewedMetric.published_at,
  };
  for (const field of [
    'reach',
    'views',
    'shares',
    'saves',
    'comments',
    'follows',
    'profile_visits',
    'link_clicks',
    'dm_intents',
  ]) {
    expectedEvidencePayload[field] = Number(reviewedMetric[field] || 0);
  }
  expectedEvidencePayload.observed_fields = [
    'reach',
    'views',
    'shares',
    'saves',
    'comments',
    'follows',
  ];
  const expectedEvidenceHash = createHash('sha256')
    .update(JSON.stringify(expectedEvidencePayload))
    .digest('hex');
  reviewedMetric.snapshot_fingerprint = 'f'.repeat(64);
  const mismatchedFingerprintReview = await invoke({
    action: 'review',
    campaign: first.campaign,
    content: first.content,
    decision: 'repeat',
    note: 'This fingerprint does not match the observed provider fields.',
  });
  assert.equal(mismatchedFingerprintReview.status, 409);
  assert.equal(
    (await mismatchedFingerprintReview.json()).error,
    'content_snapshot_conflict',
  );
  assert.equal(plans[0].review_evidence_hash, undefined);
  reviewedMetric.snapshot_fingerprint = expectedEvidenceHash;

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
  assert.equal(plans[0].review_evidence_hash, expectedEvidenceHash);
  const reviewedBody = await reviewed.json();
  assert.equal(
    plans[0].review_conversion_cutoff_at,
    '2026-07-08T12:00:00.000Z',
  );
  assert.match(plans[0].review_conversion_evidence_hash, /^[a-f0-9]{64}$/);
  assert.equal(
    plans[0].review_conversion_evidence_hash,
    reviewedBody.conversion_evidence_hash,
  );
  assert.deepEqual(
    plans[0].review_conversion_evidence,
    reviewedBody.conversion_evidence,
  );
  assert.equal(plans[0].review_conversion_evidence.post_conversion_eligible, true);
  assert.equal(plans[0].review_conversion_evidence.activated_workspaces, 1);
  assert.equal(plans[0].review_conversion_evidence.paid_users, 1);
  assert.equal(
    metrics[0].snapshot_fingerprint,
    undefined,
    'newer writes with older capture times must not replace the fixed-age evidence',
  );
  batches.push({
    id: 'batch_review_lock',
    batch_key: 'a'.repeat(64),
    parent_platform: 'instagram',
    parent_campaign: first.campaign,
    parent_content: first.content,
    state: 'ready',
  });
  const lockedReview = await invoke({
    action: 'review',
    campaign: first.campaign,
    content: first.content,
    decision: 'iterate',
    note: 'This review cannot change after it has an active downstream batch.',
  });
  assert.equal(lockedReview.status, 409);
  assert.equal((await lockedReview.json()).error, 'growth_review_lineage_locked');
  assert.equal(plans[0].review_decision, 'repeat');
  batches.pop();

  metrics.push({
    ...structuredClone(metrics.find((metric) => metric.id === 'metric_7d')),
    id: 'metric_7d_after_window',
    snapshot_captured_at: '2026-07-09T12:00:00.001Z',
    updated_date: '2026-07-09T12:00:00.001Z',
  });
  const lateReview = await invoke({
    action: 'review',
    campaign: first.campaign,
    content: first.content,
    decision: 'iterate',
    note: 'Late cumulative totals must remain descriptive only.',
  });
  assert.equal(lateReview.status, 409);
  assert.deepEqual(await lateReview.json(), {
    error: 'fixed_age_snapshot_window_missed',
    due_at: '2026-07-08T12:00:00.000Z',
    window_closes_at: '2026-07-09T12:00:00.000Z',
    captured_at: '2026-07-09T12:00:00.001Z',
  });
  assert.equal(plans[0].review_decision, 'repeat');
  metrics.pop();

  const immutablePlanEvidence = {
    hook: plans[0].hook,
    hypothesis: plans[0].hypothesis,
    planned_publish_at: plans[0].planned_publish_at,
    snapshot_days: plans[0].snapshot_days,
    published_at: plans[0].published_at,
    review_evidence_hash: plans[0].review_evidence_hash,
    review_conversion_cutoff_at: plans[0].review_conversion_cutoff_at,
    review_conversion_evidence_hash: plans[0].review_conversion_evidence_hash,
    review_conversion_evidence: plans[0].review_conversion_evidence,
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
    review_conversion_cutoff_at: plans[0].review_conversion_cutoff_at,
    review_conversion_evidence_hash: plans[0].review_conversion_evidence_hash,
    review_conversion_evidence: plans[0].review_conversion_evidence,
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
    review_conversion_cutoff_at: undefined,
    review_conversion_evidence_hash: undefined,
    review_conversion_evidence: undefined,
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
      review_conversion_cutoff_at: undefined,
      review_conversion_evidence_hash: undefined,
      review_conversion_evidence: undefined,
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
      review_conversion_cutoff_at: undefined,
      review_conversion_evidence_hash: undefined,
      review_conversion_evidence: undefined,
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
  assert.deepEqual(planSchema.properties.platform.enum, ['instagram', 'tiktok']);
  assert.deepEqual(metricSchema.properties.platform.enum, ['instagram', 'tiktok']);
  assert.equal(planSchema.properties.platform.default, 'instagram');
  assert.equal(metricSchema.properties.platform.default, 'instagram');
  assert.equal(metricSchema.required.includes('reach'), false);
  assert.deepEqual(
    metricSchema.properties.observed_metric_fields.items.enum,
    [
      'reach',
      'views',
      'shares',
      'saves',
      'comments',
      'follows',
      'profile_visits',
      'link_clicks',
      'dm_intents',
    ],
  );
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
  assert.match(dashboard, /queueSnapshotLock\?\.platform/);
  assert.match(dashboard, /queueSnapshotLock\?\.format/);
  assert.match(dashboard, /queueSnapshotLock\?\.hook/);
  assert.match(dashboard, /cta_variant:\s*queueSnapshotLock\?\.ctaVariant/);
  assert.match(dashboard, /buildGrowthPaceFromReport\(report\)/);
  assert.match(dashboard, /Path to 1,000/);
  assert.match(dashboard, /Gross retained cohort/);
  assert.match(dashboard, /FirstKnock keeps\s+ETA off/);
  assert.match(dashboard, /weekly_proxy_available/);
  assert.match(dashboard, /buildPlatformTrackedLink/);
  assert.match(dashboard, /Log \{platformLabel\} snapshot/);
  assert.match(dashboard, /Manual entry unlocks for a Buffer-managed asset/);
  assert.match(dashboard, /Buffer captures fresh fixed-age reach and view checkpoints automatically/);
  assert.match(dashboard, />Views</);
  assert.match(dashboard, /row\.reach_observed[\s\S]*?'—'/);
  assert.match(dashboard, /Number\(row\.views \|\| 0\)\.toLocaleString/);
  assert.match(dashboard, /row\.views_observed[\s\S]*?'—'/);
  assert.match(dashboard, /available=\{reachObservedAssets28 > 0\}/);
  assert.match(dashboard, /observedAvailable=\{pace\.reach_proxy_available\}/);
  assert.match(dashboard, /Instagram cumulative post reach lower bound/);
  assert.match(dashboard, /not unique campaign reach/);
  assert.match(dashboard, /TikTok views.*never converted into reach/);
  assert.match(dashboard, /28d checkpoints/);
  assert.match(dashboard, /Manual repair unlocks only after the worker marks it for review/);
  assert.match(dashboard, /row\.reach_to_signup_rate === null[\s\S]*?'—'/);
  assert.match(dashboard, /label="Owned intent"/);
  assert.match(dashboard, /ownedIntentObservedAssets28 > 0/);
  assert.match(dashboard, /intentCoverageState/);
  assert.match(dashboard, /label="Paid"/);
  assert.match(dashboard, /paidUsers28 \/ activatedWorkspaces28/);
  assert.match(dashboard, /optionalMetricValue\(snapshot\.views\)/);
  assert.match(dashboard, /snapshot\.reach === '' && snapshot\.views === ''/);
  assert.match(dashboard, /platform:\s*queueSnapshotLock\?\.platform \|\| platform/);
  assert.doesNotMatch(dashboard, /origin:\s*window\.location\.origin/);
  assert.match(queue, /Sync 30-day sprint/);
  assert.match(queue, /buildPlatformTrackedLink/);
  assert.match(queue, /snapshot_action_days/);
  assert.match(queue, /snapshot_manual_entry_allowed/);
  assert.match(queue, /providerCheckpointStatus === 'review_needed'/);
  assert.match(queue, /Buffer collecting/);
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
  assert.equal(empty.reach_proxy_available, false);
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
    expected_due_assets: 5,
    captured_assets: 5,
    reach_expected_due_assets: 5,
    reach_captured_assets: 5,
    reach_observed_assets: 5,
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
  assert.equal(recordedZeroReach.reach_proxy_available, true);
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

test('growth pace uses conservative Instagram reach while cadence and outcomes remain combined', () => {
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

  const combined = buildGrowthPaceFromReport({
    all_time: { retained_active_users_30d: 100 },
    pace_evidence: {
      measured_content_assets_all_time: 35,
      observation_window_complete: true,
      last_28_days: {
        instagram_reach: 100,
        instagram_expected_due_assets: 1,
        instagram_captured_assets: 1,
        instagram_reach_observed_assets: 1,
        tiktok_views: 60000,
        tiktok_views_observed_assets: 1,
        tiktok_expected_due_assets: 1,
        tiktok_captured_assets: 1,
        social_expected_due_assets: 2,
        social_captured_assets: 2,
        social_content_assets: 24,
        social_activated_workspaces: 12,
        social_retained_active_users_30d: 16,
      },
    },
  });
  assert.equal(combined.observed_weekly_proxy_28d.reach, 25);
  assert.equal(combined.observed_weekly_proxy_28d.content_assets, 0.5);
  assert.equal(combined.observed_weekly_proxy_28d.activated_workspaces, 3);
  assert.equal(combined.observed_weekly_proxy_28d.retained_users, 4);
  assert.deepEqual(combined.exposure_diagnostics_28d, {
    instagram_cumulative_post_reach: 100,
    tiktok_views: 60000,
    tiktok_views_observed_assets: 1,
  });

  const unavailableReach = buildGrowthPaceFromReport({
    all_time: { retained_active_users_30d: 10 },
    pace_evidence: {
      measured_content_assets_all_time: 35,
      observation_window_complete: true,
      last_28_days: {
        instagram_reach: 0,
        instagram_reach_observed_assets: 0,
        instagram_expected_due_assets: 4,
        instagram_captured_assets: 4,
        social_expected_due_assets: 8,
        social_captured_assets: 8,
        social_content_assets: 8,
        social_activated_workspaces: 2,
        social_retained_active_users_30d: 2,
      },
    },
  });
  assert.equal(unavailableReach.weekly_proxy_available, true);
  assert.equal(unavailableReach.reach_proxy_available, false);
  assert.equal(unavailableReach.observed_weekly_proxy_28d.reach, null);
  assert.equal(unavailableReach.pace_ratio.reach, null);
  assert.equal(
    getGrowthPaceStatus(unavailableReach).title,
    'Reach measurement is incomplete',
  );

  const partialReachCoverage = buildGrowthPaceFromReport({
    all_time: { retained_active_users_30d: 10 },
    pace_evidence: {
      measured_content_assets_all_time: 35,
      observation_window_complete: true,
      last_28_days: {
        instagram_reach: 1200,
        instagram_expected_due_assets: 2,
        instagram_captured_assets: 2,
        instagram_reach_observed_assets: 1,
        social_expected_due_assets: 4,
        social_captured_assets: 4,
        social_activated_workspaces: 2,
        social_retained_active_users_30d: 2,
      },
    },
  });
  assert.deepEqual(partialReachCoverage.measurement_coverage, {
    expected_due_assets: 4,
    captured_assets: 4,
    reach_expected_due_assets: 2,
    reach_captured_assets: 2,
    reach_observed_assets: 1,
    capture_complete: true,
    reach_capture_complete: true,
    reach_complete: false,
  });
  assert.equal(partialReachCoverage.observed_totals_28d.reach, 1200);
  assert.equal(partialReachCoverage.reach_proxy_available, false);
  assert.equal(partialReachCoverage.observed_weekly_proxy_28d.reach, null);
  assert.equal(partialReachCoverage.pace_ratio.reach, null);
  assert.equal(
    getGrowthPaceStatus(partialReachCoverage).title,
    'Reach measurement is incomplete',
  );

  const missingCheckpoint = buildGrowthPace({
    measuredContentAssets: 35,
    measuredContentAssets28: 3,
    expectedContentAssets28: 4,
    capturedContentAssets28: 3,
    reachObservedAssets28: 3,
    instagramReach28: 1200,
    observationWindowComplete: true,
  });
  assert.equal(missingCheckpoint.observed_weekly_proxy_28d.content_assets, 1);
  assert.equal(missingCheckpoint.reach_proxy_available, false);
  assert.equal(
    getGrowthPaceStatus(missingCheckpoint).title,
    'Checkpoint capture is incomplete',
  );
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
    }, 'Instagram reach is the constraint'],
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
