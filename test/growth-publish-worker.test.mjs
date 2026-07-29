import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGrowthBase44,
  growthHelpers,
  invokeJson,
  loadGrowthHandler,
} from './helpers/growthContentTestHarness.mjs';

const workerPath = 'base44/functions/processGrowthPublishQueue/entry.ts';
const managePath = 'base44/functions/manageGrowthContentEngine/entry.ts';
const workerSecret = 'worker-secret-that-is-at-least-32-characters';
const apiKey = 'buffer-api-token-sentinel-never-persist';
const env = {
  GROWTH_PUBLISH_WORKER_SECRET: workerSecret,
  GROWTH_PUBLISH_ENABLED: 'true',
  BUFFER_API_KEY: apiKey,
  BUFFER_ORGANIZATION_ID: 'org_firstknock',
  BUFFER_INSTAGRAM_CHANNEL_ID: 'channel_instagram',
  BUFFER_TIKTOK_CHANNEL_ID: 'channel_tiktok',
  GROWTH_MEDIA_ORIGIN: 'https://media.firstknock.online',
};
const mediaBytes = new TextEncoder().encode('firstknock-approved-media-fixture-v1');
const mediaSha256 = await growthHelpers.sha256BytesHex(mediaBytes);

const source = {
  id: 'source_1',
  asset_key: 'safe-product-proof',
  title: 'Safe source',
  media_kind: 'video',
  privacy_status: 'safe',
  safe_summary: 'Sanitized route workflow.',
  active: true,
};

async function fixture(overrides = {}) {
  const artifact = {
    id: 'artifact_1',
    artifact_key: 'ig-route-proof-01',
    concept_id: 'route-proof-01',
    revision: 1,
    campaign: '1000-users',
    platform: 'instagram',
    platform_content_id: 'ig-route-proof-01',
    title: 'Build a route from one area',
    pillar: 'Product proof',
    format: 'video',
    source_asset_keys: ['safe-product-proof'],
    generation_status: 'draft_ready',
    hook: 'One area. One clean route.',
    caption: 'Draw an area, pull the right homes, and build the route. Demo data shown.',
    overlay_text: ['Draw the area', 'Build the route'],
    shot_list: ['Show the custom area', 'Show the finished route'],
    cta_label: 'Try FirstKnock',
    cta_url: 'https://firstknock.online',
    disclosure: 'Demo data shown.',
    ai_generated: true,
    media_url: `https://media.firstknock.online/sha256/${mediaSha256}-route-proof.mp4`,
    media_sha256: mediaSha256,
    mime_type: 'video/mp4',
    width: 1080,
    height: 1920,
    duration_ms: 15000,
    thumbnail_offset_ms: 2000,
    review_status: 'passed',
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    approval_status: 'approved',
  };
  artifact.provider_text = growthHelpers.socialPostText(artifact);
  artifact.approved_hash = await growthHelpers.artifactApprovalHash(artifact);
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const configRevision = await growthHelpers.sha256Hex([
    'buffer',
    env.BUFFER_ORGANIZATION_ID,
    env.BUFFER_INSTAGRAM_CHANNEL_ID,
    'instagram',
    env.GROWTH_MEDIA_ORIGIN,
  ].join('|'));
  const request = {
    provider: 'buffer',
    provider_organization_id: env.BUFFER_ORGANIZATION_ID,
    provider_channel_id: env.BUFFER_INSTAGRAM_CHANNEL_ID,
    provider_service: 'instagram',
    config_revision: configRevision,
    media_origin: env.GROWTH_MEDIA_ORIGIN,
    artifact_id: artifact.id,
    artifact_hash: artifact.approved_hash,
    platform: 'instagram',
    platform_content_id: artifact.platform_content_id,
    due_at: dueAt,
    scheduling_type: 'automatic',
    timezone: 'America/Phoenix',
  };
  const job = {
    id: 'job_1',
    job_key: await growthHelpers.publishJobKey(request),
    request_hash: await growthHelpers.publishJobRequestHash(request),
    ...request,
    artifact_key: artifact.artifact_key,
    concept_id: artifact.concept_id,
    campaign: artifact.campaign,
    state: 'queued',
    attempt_count: 0,
    reconciliation_count: 0,
    schedule_cutoff_at: new Date(new Date(dueAt).getTime() - 10 * 60 * 1000).toISOString(),
    lease_generation: 0,
  };
  return {
    artifact: { ...artifact, ...(overrides.artifact || {}) },
    job: { ...job, ...(overrides.job || {}) },
    dueAt,
  };
}

function bufferPost(fx, overrides = {}) {
  return {
    id: 'buffer_post_1',
    channelId: env.BUFFER_INSTAGRAM_CHANNEL_ID,
    channelService: 'instagram',
    status: 'scheduled',
    dueAt: fx.dueAt,
    sentAt: null,
    externalLink: null,
    text: fx.artifact.provider_text,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assets: [{
      source: fx.artifact.media_url,
      mimeType: fx.artifact.mime_type,
      type: 'video',
    }],
    error: null,
    ...overrides,
  };
}

function measurementPlan(fx, overrides = {}) {
  return {
    id: `growth_plan_${fx.job.id}`,
    campaign: fx.artifact.campaign,
    content: fx.artifact.platform_content_id,
    sprint: 'content-engine',
    planned_publish_at: fx.dueAt,
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withApprovedMedia(bufferFetch, bytes = mediaBytes, channelOverrides = {}) {
  return async (url, options) => {
    if (String(url).startsWith(`${env.GROWTH_MEDIA_ORIGIN}/`)) {
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(bytes.byteLength),
        },
      });
    }
    const query = JSON.parse(String(options?.body || '{}'))?.query || '';
    if (String(url) === 'https://api.buffer.com' && query.includes('channel(input:')) {
      return Response.json({
        data: {
          channel: {
            id: env.BUFFER_INSTAGRAM_CHANNEL_ID,
            organizationId: env.BUFFER_ORGANIZATION_ID,
            service: 'instagram',
            isDisconnected: false,
            isLocked: false,
            isQueuePaused: false,
            ...channelOverrides,
          },
        },
      });
    }
    return bufferFetch(url, options);
  };
}

test('worker rejects missing configuration and bad secrets before storage or provider access', async () => {
  const { base44, entities } = createGrowthBase44();
  let clientCreates = 0;
  let fetches = 0;
  let handler = loadGrowthHandler(workerPath, {
    base44,
    env: {},
    onClientCreate: () => { clientCreates += 1; },
    fetchImpl: async () => { fetches += 1; },
  });
  let result = await invokeJson(handler, {}, { secret: 'wrong' });
  assert.equal(result.status, 503);
  assert.equal(clientCreates, 0);

  handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    onClientCreate: () => { clientCreates += 1; },
    fetchImpl: async () => { fetches += 1; },
  });
  result = await invokeJson(handler, {}, { secret: 'wrong-secret-value' });
  assert.equal(result.status, 401);
  assert.equal(clientCreates, 0);
  assert.equal(fetches, 0);
  assert.equal(entities.GrowthPublishJob.counters.filter, 0);
});

test('disabled kill switch performs no entity or provider work', async () => {
  const { base44, entities } = createGrowthBase44();
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env: { ...env, GROWTH_PUBLISH_ENABLED: 'false' },
    fetchImpl: async () => { fetches += 1; },
  });
  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'growth_publishing_disabled');
  assert.equal(entities.GrowthPublishJob.counters.filter, 0);
  assert.equal(fetches, 0);
});

test('a due queued job is leased once, created in Buffer once, and never blindly replayed', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const outbound = [];
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async (url, options) => {
      outbound.push({ url, options });
      return Response.json({
        data: {
          createPost: {
            __typename: 'PostActionSuccess',
            post: bufferPost(fx),
          },
        },
      });
    }),
  });
  const [first, concurrent] = await Promise.all([
    invokeJson(handler, { limit: 5 }, { secret: workerSecret }),
    invokeJson(handler, { limit: 5 }, { secret: workerSecret }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(concurrent.status, 200);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, 'https://api.buffer.com');
  assert.equal(outbound[0].options.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(outbound[0].options.body.includes(workerSecret), false);
  assert.match(outbound[0].options.body, /createPost/);
  assert.match(outbound[0].options.body, new RegExp(fx.dueAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const createQuery = JSON.parse(outbound[0].options.body).query;
  assert.match(createQuery, /schedulingType:automatic/);
  assert.match(createQuery, /mode:customScheduled/);
  assert.match(createQuery, /instagram:\{type:reel,/);
  assert.doesNotMatch(createQuery, /schedulingType:"automatic"/);
  assert.doesNotMatch(createQuery, /mode:"customScheduled"/);
  assert.equal(createQuery.includes(JSON.stringify(fx.artifact.provider_text)), true);

  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'scheduled');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
  assert.equal(saved.attempt_count, 1);
  assert.equal(JSON.stringify(saved).includes(apiKey), false);
  assert.equal(JSON.stringify(saved).includes(workerSecret), false);

  const replay = await invokeJson(handler, { limit: 5 }, { secret: workerSecret });
  assert.equal(replay.status, 200);
  assert.equal(outbound.length, 1);
});

test('artifact tampering after approval blocks provider access', async () => {
  const fx = await fixture({
    artifact: { caption: 'A changed, unapproved caption.' },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('must not call provider');
    },
  });
  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(fetches, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(entities.GrowthPublishJob.records[0].last_error_code, 'artifact_approval_changed');
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
});

test('approval revoked after the earlier worker check is fenced before createPost', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalArtifactGet = entities.GrowthCreativeArtifact.get;
  let artifactReads = 0;
  entities.GrowthCreativeArtifact.get = async (...args) => {
    artifactReads += 1;
    if (artifactReads === 3) {
      Object.assign(entities.GrowthCreativeArtifact.records[0], {
        approval_status: 'revoked',
        revoked_at: new Date().toISOString(),
        revocation_note: 'Approval was revoked during worker verification.',
      });
    }
    return originalArtifactGet(...args);
  };
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      throw new Error('createPost must not run after the final approval fence');
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(artifactReads, 3);
  assert.equal(createCalls, 0);
  assert.equal(
    entities.GrowthCreativeArtifact.records[0].approval_status,
    'revoked',
  );
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'artifact_approval_changed',
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'canceled',
  );
});

test('a lost final lease renewal prevents provider submission', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  let renewalAttempts = 0;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (
      query?.state === 'processing'
      && operations?.$set?.lease_expires_at
      && Object.keys(operations.$set).length === 1
    ) {
      renewalAttempts += 1;
      Object.assign(entities.GrowthPublishJob.records[0], {
        lease_token: 'replacement-worker-lease',
        lease_expires_at: new Date(Date.now() + 90 * 1000).toISOString(),
        updated_date: new Date().toISOString(),
      });
    }
    return originalJobUpdateMany(query, operations);
  };
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      throw new Error('createPost must not run after lease ownership is lost');
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(renewalAttempts, 1);
  assert.equal(createCalls, 0);
  assert.equal(result.body.states.lease_lost, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'processing');
  assert.equal(
    entities.GrowthPublishJob.records[0].lease_token,
    'replacement-worker-lease',
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'planned',
  );
});

test('expired-lease recovery loses its stale snapshot after a concurrent renewal', async () => {
  const expiredAt = new Date(Date.now() - 1000).toISOString();
  const fx = await fixture({
    job: {
      state: 'processing',
      attempt_count: 1,
      lease_source_state: 'queued',
      lease_token: 'still-active-worker',
      lease_generation: 4,
      lease_acquired_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      lease_expires_at: expiredAt,
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  let recoveryAttempts = 0;
  let renewedSnapshot;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (
      query?.state === 'processing'
      && query?.lease_expires_at === expiredAt
      && operations?.$set?.state === 'create_reconcile'
    ) {
      recoveryAttempts += 1;
      Object.assign(entities.GrowthPublishJob.records[0], {
        lease_expires_at: new Date(Date.now() + 90 * 1000).toISOString(),
        updated_date: new Date().toISOString(),
      });
      renewedSnapshot = structuredClone(entities.GrowthPublishJob.records[0]);
    }
    return originalJobUpdateMany(query, operations);
  };
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('stale lease recovery must not reach Buffer');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(result.body.inspected, 1);
  assert.equal(result.body.processed, 0);
  assert.deepEqual(result.body.states, {});
  assert.equal(recoveryAttempts, 1);
  assert.equal(providerFetches, 0);
  assert.deepEqual(entities.GrowthPublishJob.records[0], renewedSnapshot);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'processing');
  assert.equal(
    entities.GrowthPublishJob.records[0].lease_token,
    'still-active-worker',
  );
  assert.ok(
    new Date(entities.GrowthPublishJob.records[0].lease_expires_at).getTime()
      > Date.now(),
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'planned',
  );
});

test('stale duplicate suppression cannot erase a renewed processing lease', async () => {
  const fx = await fixture();
  const now = Date.now();
  const canonical = {
    ...fx.job,
    id: 'job_duplicate_canonical',
    created_date: new Date(now - 5 * 60 * 1000).toISOString(),
  };
  const expiredAt = new Date(now - 1000).toISOString();
  const duplicate = {
    ...fx.job,
    id: 'job_duplicate_processing',
    state: 'processing',
    attempt_count: 1,
    lease_source_state: 'queued',
    lease_token: 'renewing-worker-lease',
    lease_generation: 4,
    lease_acquired_at: new Date(now - 2 * 60 * 1000).toISOString(),
    lease_expires_at: expiredAt,
    created_date: new Date(now - 60 * 1000).toISOString(),
  };
  const { base44, entities } = createGrowthBase44({
    jobs: [canonical, duplicate],
  });
  const canonicalBefore = structuredClone(
    entities.GrowthPublishJob.records.find((job) => job.id === canonical.id),
  );
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  let suppressionAttempts = 0;
  let renewedSnapshot;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (
      query?.id === duplicate.id
      && query?.state === 'processing'
      && operations?.$set?.last_error_code
        === 'duplicate_publish_job_suppressed'
    ) {
      suppressionAttempts += 1;
      const live = entities.GrowthPublishJob.records.find(
        (job) => job.id === duplicate.id,
      );
      const renewedAt = new Date().toISOString();
      Object.assign(live, {
        lease_acquired_at: renewedAt,
        lease_expires_at: new Date(Date.now() + 90 * 1000).toISOString(),
        last_attempt_at: renewedAt,
        last_error_code: 'active_worker_renewed',
        last_error_message: 'The active worker renewed this lease.',
        updated_date: renewedAt,
      });
      renewedSnapshot = structuredClone(live);
    }
    return originalJobUpdateMany(query, operations);
  };
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('duplicate suppression must finish before provider access');
    },
  });

  const result = await invokeJson(
    handler,
    { limit: 1 },
    { secret: workerSecret },
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.inspected, 1);
  assert.equal(result.body.processed, 1);
  assert.equal(result.body.states.lease_lost, 1);
  assert.equal(suppressionAttempts, 1);
  assert.equal(providerFetches, 0);
  assert.deepEqual(
    entities.GrowthPublishJob.records.find((job) => job.id === duplicate.id),
    renewedSnapshot,
  );
  assert.deepEqual(
    entities.GrowthPublishJob.records.find((job) => job.id === canonical.id),
    canonicalBefore,
  );
  assert.equal(renewedSnapshot.state, 'processing');
  assert.equal(renewedSnapshot.lease_token, 'renewing-worker-lease');
  assert.equal(renewedSnapshot.last_error_code, 'active_worker_renewed');
  assert.notEqual(
    renewedSnapshot.last_error_code,
    'duplicate_publish_job_suppressed',
  );
  assert.ok(new Date(renewedSnapshot.lease_expires_at).getTime() > Date.now());
});

test('mismatched fetched media bytes fail before any Buffer request', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  let mediaFetches = 0;
  let bufferFetches = 0;
  const mismatchedBytes = new TextEncoder().encode('tampered-media-bytes');
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async (url) => {
      if (String(url).startsWith(`${env.GROWTH_MEDIA_ORIGIN}/`)) {
        mediaFetches += 1;
        return new Response(mismatchedBytes, {
          status: 200,
          headers: {
            'content-type': fx.artifact.mime_type,
            'content-length': String(mismatchedBytes.byteLength),
          },
        });
      }
      bufferFetches += 1;
      throw new Error('Buffer must not be called for mismatched media bytes');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(mediaFetches, 1);
  assert.equal(bufferFetches, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'media_hash_mismatch',
  );
});

test('a mis-scoped Buffer channel fails before createPost', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      throw new Error('createPost must not run for the wrong channel service');
    }, mediaBytes, { service: 'tiktok' }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(createCalls, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'provider_channel_mismatch',
  );
});

test('a paused Buffer channel blocks createPost and cancels planned measurement', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      throw new Error('createPost must not run while the channel queue is paused');
    }, mediaBytes, { isQueuePaused: true }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(createCalls, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'provider_channel_paused',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
});

test('source privacy withdrawal on the immediate pre-create reread fails closed', async (t) => {
  const cases = [
    {
      name: 'source becomes blocked',
      changedSource: { ...source, privacy_status: 'blocked', active: true },
    },
    {
      name: 'source becomes inactive',
      changedSource: { ...source, privacy_status: 'safe', active: false },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture();
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [measurementPlan(fx)],
      });
      const originalSourceFilter = entities.GrowthSourceAsset.filter;
      let sourceReads = 0;
      entities.GrowthSourceAsset.filter = async (...args) => {
        sourceReads += 1;
        if (sourceReads === 1) return originalSourceFilter(...args);
        return [structuredClone(item.changedSource)];
      };
      let createCalls = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: withApprovedMedia(async () => {
          createCalls += 1;
          throw new Error('createPost must not run after privacy withdrawal');
        }),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(sourceReads, 2);
      assert.equal(createCalls, 0);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'source_privacy_clearance_changed',
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'canceled',
      );
    });
  }
});

test('a transient pre-create source reread outage retries without creating in Buffer', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalSourceFilter = entities.GrowthSourceAsset.filter;
  let sourceReads = 0;
  entities.GrowthSourceAsset.filter = async (...args) => {
    sourceReads += 1;
    if (sourceReads === 1) return originalSourceFilter(...args);
    throw new Error('temporary source read outage');
  };
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      throw new Error('createPost must not run during privacy-read outage');
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(sourceReads, 2);
  assert.equal(createCalls, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'retry_wait');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'source_privacy_clearance_unavailable',
  );
  assert.ok(
    new Date(entities.GrowthPublishJob.records[0].next_retry_at).getTime()
      > Date.now(),
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
});

test('a failed plan-cancel CAS enters delivery reconciliation and completes without createPost', async () => {
  const fx = await fixture({
    artifact: { caption: 'A changed, unapproved caption.' },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalPlanUpdateMany = entities.GrowthContentPlan.updateMany;
  let failCancellationOnce = true;
  entities.GrowthContentPlan.updateMany = async (...args) => {
    if (failCancellationOnce) {
      failCancellationOnce = false;
      return { success: true, updated: 0, has_more: false };
    }
    return originalPlanUpdateMany(...args);
  };
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('delivery reconciliation must not call Buffer');
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'delivery_reconcile');
  assert.equal(
    entities.GrowthPublishJob.records[0].delivery_reconcile_target,
    'failed',
  );
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'artifact_approval_changed',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
  assert.equal(providerFetches, 0);

  entities.GrowthPublishJob.records[0].next_retry_at = new Date(
    Date.now() - 1000,
  ).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.notEqual(entities.GrowthPublishJob.records[0].state, 'canceled');
  assert.equal(entities.GrowthPublishJob.records[0].attempt_count, 1);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
  assert.equal(providerFetches, 0);
});

test('owner cancel and provider resolution repair plan-CAS failures to canceled without Buffer', async (t) => {
  const cases = [
    {
      name: 'cancel_job',
      job: {
        id: 'job_owner_cancel_repair',
        artifact_id: 'artifact_owner_cancel_repair',
        campaign: '1000-users',
        platform: 'instagram',
        platform_content_id: 'ig-owner-cancel-repair',
        state: 'queued',
        lease_generation: 0,
      },
      request: {
        action: 'cancel_job',
        job_id: 'job_owner_cancel_repair',
      },
      errorCode: 'owner_canceled',
    },
    {
      name: 'resolve_job',
      job: {
        id: 'job_owner_resolve_repair',
        artifact_id: 'artifact_owner_resolve_repair',
        campaign: '1000-users',
        platform: 'instagram',
        platform_content_id: 'ig-owner-resolve-repair',
        state: 'review_required',
        provider_post_id: 'buffer_post_owner_verified_canceled',
        provider_status: 'scheduled',
        lease_generation: 2,
      },
      request: {
        action: 'resolve_job',
        job_id: 'job_owner_resolve_repair',
        provider_cancellation_verified: true,
        resolution_evidence_note: 'Verified canceled in Buffer before local repair.',
      },
      errorCode: 'owner_verified_provider_canceled',
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const plan = {
        id: `plan_${item.job.id}`,
        campaign: item.job.campaign,
        content: item.job.platform_content_id,
        sprint: 'content-engine',
        delivery_managed_by: 'buffer',
        delivery_status: 'planned',
      };
      const { base44, entities } = createGrowthBase44({
        jobs: [item.job],
        plans: [plan],
      });
      const originalPlanUpdateMany = entities.GrowthContentPlan.updateMany;
      let failCancellationOnce = true;
      entities.GrowthContentPlan.updateMany = async (...args) => {
        if (failCancellationOnce) {
          failCancellationOnce = false;
          return { success: true, updated: 0, has_more: false };
        }
        return originalPlanUpdateMany(...args);
      };
      const manager = loadGrowthHandler(managePath, { base44, env });

      const managerResult = await invokeJson(manager, item.request);

      assert.equal(managerResult.status, 202);
      assert.equal(managerResult.body.success, true);
      assert.equal(managerResult.body.measurement_repair_pending, true);
      assert.equal(managerResult.body.job.state, 'delivery_reconcile');
      assert.equal(
        managerResult.body.job.delivery_reconcile_target,
        'canceled',
      );
      assert.equal(entities.GrowthPublishJob.records[0].state, 'delivery_reconcile');
      assert.equal(
        entities.GrowthPublishJob.records[0].delivery_reconcile_target,
        'canceled',
      );
      assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');

      let providerFetches = 0;
      const worker = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => {
          providerFetches += 1;
          throw new Error('canceled delivery repair must not call Buffer');
        },
      });
      const workerResult = await invokeJson(
        worker,
        {},
        { secret: workerSecret },
      );

      assert.equal(workerResult.status, 200);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'canceled');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        item.errorCode,
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'canceled',
      );
      assert.equal(providerFetches, 0);
    });
  }
});

test('an expired delivery-reconcile lease recovers locally and never enters provider reconciliation', async () => {
  const fx = await fixture({
    job: {
      state: 'processing',
      attempt_count: 1,
      reconciliation_count: 0,
      lease_token: 'expired-delivery-lease',
      lease_source_state: 'delivery_reconcile',
      lease_generation: 3,
      lease_acquired_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
      last_error_code: 'artifact_approval_changed',
      last_error_message:
        'Approval changed. Measurement-plan cancellation will retry.',
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('expired delivery cleanup must not query Buffer');
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'delivery_reconcile');
  assert.equal(
    entities.GrowthPublishJob.records[0].lease_source_state,
    undefined,
  );
  assert.equal(entities.GrowthPublishJob.records[0].reconciliation_count, 0);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
  assert.equal(providerFetches, 0);

  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(entities.GrowthPublishJob.records[0].attempt_count, 1);
  assert.equal(entities.GrowthPublishJob.records[0].reconciliation_count, 0);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
  assert.equal(providerFetches, 0);
});

test('a missed scheduling cutoff cancels its Instagram measurement plan', async () => {
  const fx = await fixture({
    job: {
      schedule_cutoff_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('a missed cutoff must fail before Buffer');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(providerFetches, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'missed_schedule_window',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
});

test('every failed review gate blocks provider access after approval', async (t) => {
  const cases = [
    ['review_status', 'changes_requested'],
    ['privacy_cleared', false],
    ['demo_labeled', false],
    ['claims_supported', false],
    ['media_rights_confirmed', false],
  ];
  for (const [field, value] of cases) {
    await t.test(field, async () => {
      const fx = await fixture({
        artifact: { [field]: value },
      });
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
      });
      let fetches = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => {
          fetches += 1;
          return Response.json({
            data: {
              createPost: {
                __typename: 'PostActionSuccess',
                post: bufferPost(fx),
              },
            },
          });
        },
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });
      assert.equal(result.status, 200);
      assert.equal(fetches, 0);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'artifact_approval_changed',
      );
    });
  }
});

test('mismatched create successes fail closed while retaining the provider id', async (t) => {
  const cases = [
    ['channel', (fx) => ({ channelId: 'wrong_channel' })],
    ['channel service', () => ({ channelService: 'tiktok' })],
    ['time', (fx) => ({
      dueAt: new Date(new Date(fx.dueAt).getTime() + 60 * 1000).toISOString(),
    })],
    ['text', () => ({ text: 'Different provider text.' })],
    ['media', (fx) => ({
      assets: [{
        source: 'https://media.firstknock.online/sha256/unapproved-media.mp4',
        mimeType: fx.artifact.mime_type,
        type: 'video',
      }],
    })],
  ];
  for (const [name, mismatch] of cases) {
    await t.test(name, async () => {
      const fx = await fixture();
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
      });
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
      fetchImpl: withApprovedMedia(async () => Response.json({
        data: {
            createPost: {
              __typename: 'PostActionSuccess',
              post: bufferPost(fx, mismatch(fx)),
          },
        },
      })),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });
      assert.equal(result.status, 200);
      const saved = entities.GrowthPublishJob.records[0];
      assert.equal(saved.state, 'review_required');
      assert.equal(saved.provider_post_id, 'buffer_post_1');
      assert.notEqual(saved.last_error_code, '');
    });
  }
});

test('a mismatched known provider post fails closed without losing its id', async () => {
  const fx = await fixture({
    job: {
      state: 'scheduled',
      provider_status: 'scheduled',
      provider_post_id: 'buffer_post_1',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: {
        post: bufferPost(fx, {
          channelId: 'wrong_channel',
          text: 'Wrong post returned for the durable provider id.',
        }),
      },
    })),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'review_required');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
  assert.notEqual(saved.last_error_code, '');
});

test('worker persists only public HTTPS provider external links', async (t) => {
  const cases = [
    {
      name: 'HTTP link',
      externalLink: 'http://www.instagram.com/p/insecure/',
      expected: undefined,
    },
    {
      name: 'credentialed HTTPS link',
      externalLink:
        'https://username:password@www.instagram.com/p/credentialed/',
      expected: undefined,
    },
    {
      name: 'public Instagram HTTPS link',
      externalLink: 'https://www.instagram.com/p/public-firstknock/',
      expected: 'https://www.instagram.com/p/public-firstknock/',
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture({
        job: {
          state: 'scheduled',
          provider_status: 'scheduled',
          provider_post_id: 'buffer_post_1',
          next_retry_at: new Date(Date.now() - 1000).toISOString(),
        },
      });
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
      });
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => Response.json({
          data: {
            post: bufferPost(fx, {
              status: 'scheduled',
              externalLink: item.externalLink,
            }),
          },
        }),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'scheduled');
      assert.equal(
        entities.GrowthPublishJob.records[0].provider_external_link,
        item.expected,
      );
    });
  }
});

test('a typed Buffer mutation rejection becomes a repairable terminal failure', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: {
        createPost: {
          __typename: 'InvalidInputError',
          message: 'The provider rejected the exact publish request.',
        },
      },
    })),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'failed');
  assert.notEqual(saved.state, 'create_reconcile');
  assert.equal(saved.reconciliation_count, 0);
  assert.equal(saved.provider_post_id, undefined);
});

test('a typed terminal rejection can be re-reviewed and retried through the manager', async () => {
  const fx = await fixture({
    artifact: {
      schedule_lock_generation: 0,
      schedule_lock_token: '',
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const workerHandler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: {
        createPost: {
          __typename: 'InvalidInputError',
          message: 'The provider rejected the exact publish request.',
        },
      },
    })),
  });
  let result = await invokeJson(workerHandler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(entities.GrowthPublishJob.records[0].attempt_count, 1);

  const manageHandler = loadGrowthHandler(managePath, { base44, env });
  result = await invokeJson(manageHandler, {
    action: 'revoke',
    artifact_id: fx.artifact.id,
    note: 'Repair the provider-rejected request before retrying.',
  });
  assert.equal(result.status, 200);
  result = await invokeJson(manageHandler, {
    action: 'review',
    artifact_id: fx.artifact.id,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    note: 'The provider rejection was repaired and the exact rendition rechecked.',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.passed, true);
  result = await invokeJson(manageHandler, {
    action: 'approve',
    artifact_id: fx.artifact.id,
  });
  assert.equal(result.status, 200);

  result = await invokeJson(manageHandler, {
    action: 'schedule',
    artifact_id: fx.artifact.id,
    due_at: fx.dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
    retry_terminal: true,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.retried, true);
  assert.equal(result.body.job.id, fx.job.id);
  assert.equal(entities.GrowthPublishJob.records.length, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'queued');
  assert.equal(entities.GrowthPublishJob.records[0].attempt_count, 0);
  assert.equal(entities.GrowthPublishJob.records[0].last_error_code, undefined);
});

test('future polls cannot starve a due queued job beyond the first 100 active rows', async () => {
  const fx = await fixture();
  const now = Date.now();
  const futureJobs = Array.from({ length: 100 }, (_, index) => ({
    ...fx.job,
    id: `future_job_${index}`,
    job_key: index.toString(16).padStart(64, '0'),
    state: 'scheduled',
    provider_status: 'scheduled',
    provider_post_id: `future_buffer_post_${index}`,
    next_retry_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    created_date: new Date(now - (200 - index) * 60 * 1000).toISOString(),
  }));
  const dueJob = {
    ...fx.job,
    created_date: new Date(now).toISOString(),
  };
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [...futureJobs, dueJob],
  });
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      fetches += 1;
      return Response.json({
        data: {
          createPost: {
            __typename: 'PostActionSuccess',
            post: bufferPost(fx),
          },
        },
      });
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(fetches, 1);
  const saved = entities.GrowthPublishJob.records.find((job) => job.id === dueJob.id);
  assert.equal(saved.state, 'scheduled');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
});

test('an ambiguous create enters reconciliation and adopts the one exact provider post', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const operations = [];
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('createPost')) {
        operations.push('create');
        throw new Error(`network reset ${apiKey} ${workerSecret}`);
      }
      operations.push('reconcile');
      return Response.json({
        data: {
          posts: {
            edges: [{ node: bufferPost(fx) }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }),
  });
  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  let saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'create_reconcile');
  assert.equal(JSON.stringify(saved).includes(apiKey), false);
  assert.equal(JSON.stringify(saved).includes(workerSecret), false);

  saved.next_retry_at = new Date(Date.now() - 1000).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  saved = entities.GrowthPublishJob.records[0];
  assert.deepEqual(operations, ['create', 'reconcile']);
  assert.equal(saved.state, 'scheduled');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
  assert.equal(saved.reconciliation_count, 1);
});

test('malformed reconciliation candidates are never adopted and never trigger another create', async (t) => {
  const cases = [
    {
      name: 'missing durable post id',
      postOverrides: { id: undefined },
    },
    {
      name: 'unsupported provider status',
      postOverrides: { status: 'deleted' },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture();
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
      });
      const operations = [];
      let createCalls = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: withApprovedMedia(async (_url, options) => {
          const query = JSON.parse(options.body).query;
          if (query.includes('createPost')) {
            operations.push('create');
            createCalls += 1;
            throw new Error('ambiguous create response');
          }
          operations.push('reconcile');
          assert.match(query, /posts\(first:50/);
          return Response.json({
            data: {
              posts: {
                edges: [{
                  node: bufferPost(fx, item.postOverrides),
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }),
      });

      let result = await invokeJson(handler, {}, { secret: workerSecret });
      assert.equal(result.status, 200);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
      assert.equal(createCalls, 1);

      for (let retry = 1; retry <= 2; retry += 1) {
        entities.GrowthPublishJob.records[0].next_retry_at = new Date(
          Date.now() - 1000,
        ).toISOString();
        result = await invokeJson(handler, {}, { secret: workerSecret });

        assert.equal(result.status, 200);
        const saved = entities.GrowthPublishJob.records[0];
        assert.equal(saved.state, 'create_reconcile');
        assert.equal(saved.provider_post_id, undefined);
        assert.equal(saved.provider_response_hash, undefined);
        assert.equal(saved.last_error_code, 'provider_match_not_visible');
        assert.equal(saved.reconciliation_count, retry);
        assert.equal(createCalls, 1);
      }
      assert.deepEqual(operations, ['create', 'reconcile', 'reconcile']);
    });
  }
});

test('a privacy-read outage during create reconciliation can never reopen createPost', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalSourceFilter = entities.GrowthSourceAsset.filter;
  let sourceReads = 0;
  entities.GrowthSourceAsset.filter = async (...args) => {
    sourceReads += 1;
    if (sourceReads === 3) {
      throw new Error('temporary privacy read outage during reconciliation');
    }
    return originalSourceFilter(...args);
  };
  const operations = [];
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async (_url, options) => {
      const query = JSON.parse(options.body).query;
      if (query.includes('createPost')) {
        operations.push('create');
        createCalls += 1;
        throw new Error('ambiguous create response');
      }
      operations.push('reconcile');
      assert.match(query, /posts\(first:50/);
      return Response.json({
        data: {
          posts: {
            edges: [{ node: bufferPost(fx) }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }),
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
  assert.equal(createCalls, 1);

  entities.GrowthPublishJob.records[0].next_retry_at = new Date(
    Date.now() - 1000,
  ).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'source_privacy_clearance_unavailable',
  );
  assert.deepEqual(operations, ['create']);
  assert.equal(createCalls, 1);

  entities.GrowthPublishJob.records[0].next_retry_at = new Date(
    Date.now() - 1000,
  ).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.deepEqual(operations, ['create', 'reconcile']);
  assert.equal(createCalls, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'scheduled');
  assert.equal(
    entities.GrowthPublishJob.records[0].provider_post_id,
    'buffer_post_1',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
});

test('untyped Buffer create HTTP failures reconcile before any second create', async (t) => {
  for (const status of [408, 409]) {
    await t.test(`HTTP ${status}`, async () => {
      const fx = await fixture();
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [measurementPlan(fx)],
      });
      const operations = [];
      let createCalls = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: withApprovedMedia(async (_url, options) => {
          const query = JSON.parse(options.body).query;
          if (query.includes('createPost')) {
            operations.push('create');
            createCalls += 1;
            return Response.json(
              { message: 'No typed durable create result was returned.' },
              { status },
            );
          }
          operations.push('reconcile');
          assert.match(query, /posts\(first:50/);
          return Response.json({
            data: {
              posts: {
                edges: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }),
      });

      let result = await invokeJson(handler, {}, { secret: workerSecret });
      assert.equal(result.status, 200);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'provider_create_http_unconfirmed',
      );
      assert.equal(
        entities.GrowthPublishJob.records[0].provider_post_id,
        undefined,
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'planned',
      );

      entities.GrowthPublishJob.records[0].next_retry_at = new Date(
        Date.now() - 1000,
      ).toISOString();
      result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.deepEqual(operations, ['create', 'reconcile']);
      assert.equal(createCalls, 1);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
      assert.equal(
        entities.GrowthPublishJob.records[0].provider_post_id,
        undefined,
      );
      assert.equal(entities.GrowthPublishJob.records[0].reconciliation_count, 1);
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'planned',
      );
    });
  }
});

test('duplicate reconciliation matches fail closed for manual review', async () => {
  const fx = await fixture({
    job: {
      state: 'create_reconcile',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: {
        posts: {
          edges: [
            { node: bufferPost(fx, { id: 'buffer_a' }) },
            { node: bufferPost(fx, { id: 'buffer_b' }) },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    })),
  });
  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'review_required');
  assert.equal(entities.GrowthPublishJob.records[0].last_error_code, 'provider_duplicate_match');
});

test('cancel_job loses its stale CAS safely after a worker claim', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const staleReadCaptured = deferred();
  const releaseStaleRead = deferred();
  const providerCallStarted = deferred();
  const releaseProviderCall = deferred();
  const originalGet = entities.GrowthPublishJob.get;
  let firstJobRead = true;
  entities.GrowthPublishJob.get = async (id) => {
    const snapshot = await originalGet(id);
    if (firstJobRead) {
      firstJobRead = false;
      staleReadCaptured.resolve();
      await releaseStaleRead.promise;
    }
    return snapshot;
  };

  const manageHandler = loadGrowthHandler(managePath, { base44, env });
  const workerHandler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      providerCallStarted.resolve();
      await releaseProviderCall.promise;
      return Response.json({
        data: {
          createPost: {
            __typename: 'PostActionSuccess',
            post: bufferPost(fx),
          },
        },
      });
    }),
  });

  const cancelPromise = invokeJson(manageHandler, {
    action: 'cancel_job',
    job_id: fx.job.id,
  });
  await staleReadCaptured.promise;

  const workerPromise = invokeJson(
    workerHandler,
    {},
    { secret: workerSecret },
  );
  await providerCallStarted.promise;

  releaseStaleRead.resolve();
  const cancelResult = await cancelPromise;
  releaseProviderCall.resolve();
  const workerResult = await workerPromise;

  assert.equal(cancelResult.status, 409);
  assert.equal(workerResult.status, 200);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'scheduled');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
});

test('create adopts partial GraphQL success even when top-level errors are present', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: {
        createPost: {
          __typename: 'PostActionSuccess',
          post: bufferPost(fx),
        },
      },
      errors: [{
        message: 'A nullable response field could not be resolved.',
        extensions: { code: 'UNEXPECTED' },
      }],
    })),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'scheduled');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
});

test('create top-level errors without a post ID enter reconciliation', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: { createPost: null },
      errors: [{
        message: 'The create result could not be confirmed.',
        extensions: { code: 'FORBIDDEN' },
      }],
    })),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'create_reconcile');
  assert.equal(saved.provider_post_id, undefined);
});

test('a known Buffer post returning NOT_FOUND requires review', async () => {
  const fx = await fixture({
    job: {
      state: 'scheduled',
      provider_post_id: 'buffer_post_missing',
      provider_status: 'scheduled',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => Response.json({
      data: { post: null },
      errors: [{
        message: 'Post not found.',
        extensions: { code: 'NOT_FOUND' },
      }],
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'review_required');
});

test('a sent Instagram post starts the matching measurement-plan clock', async () => {
  const sentAt = new Date(Date.now() - 1000).toISOString();
  const fx = await fixture({
    job: {
      state: 'scheduled',
      provider_post_id: 'buffer_post_1',
      provider_status: 'scheduled',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const plan = {
    id: 'growth_plan_1',
    campaign: fx.artifact.campaign,
    content: fx.artifact.platform_content_id,
    planned_publish_at: fx.dueAt,
  };
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [plan],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => Response.json({
      data: {
        post: bufferPost(fx, {
          status: 'sent',
          sentAt,
          externalLink: 'https://www.instagram.com/p/firstknock/',
        }),
      },
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(entities.GrowthPublishJob.records[0].provider_sent_at, sentAt);
  assert.equal(entities.GrowthContentPlan.records[0].published_at, sentAt);
});

test('fallback publication clock survives a lost job fence and the next sent poll', async () => {
  const fx = await fixture({
    job: {
      state: 'scheduled',
      provider_post_id: 'buffer_post_without_sent_at',
      provider_status: 'scheduled',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  let loseSentFenceOnce = true;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (
      loseSentFenceOnce
      && query?.state === 'processing'
      && operations?.$set?.state === 'sent'
    ) {
      loseSentFenceOnce = false;
      Object.assign(entities.GrowthPublishJob.records[0], {
        state: 'scheduled',
        lease_token: '',
        lease_expires_at: new Date().toISOString(),
        next_retry_at: new Date(Date.now() - 1000).toISOString(),
        updated_date: new Date().toISOString(),
      });
    }
    return originalJobUpdateMany(query, operations);
  };
  let providerPolls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerPolls += 1;
      return Response.json({
        data: {
          post: bufferPost(fx, {
            id: fx.job.provider_post_id,
            status: 'sent',
            sentAt: null,
            externalLink: 'https://www.instagram.com/p/fallback-clock/',
          }),
        },
      });
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(result.body.states.lease_lost, 1);
  assert.equal(loseSentFenceOnce, false);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'scheduled');
  const firstPublishedAt =
    entities.GrowthContentPlan.records[0].published_at;
  assert.ok(Number.isFinite(new Date(firstPublishedAt).getTime()));
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_managed_by,
    'buffer',
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'published',
  );
  assert.equal(entities.GrowthContentPlan.counters.updateMany, 1);

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(providerPolls, 2);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(
    entities.GrowthPublishJob.records[0].provider_post_id,
    fx.job.provider_post_id,
  );
  assert.equal(
    entities.GrowthPublishJob.records[0].provider_sent_at,
    undefined,
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].published_at,
    firstPublishedAt,
  );
  assert.equal(entities.GrowthContentPlan.counters.updateMany, 1);
});

test('provider sentAt corrects a stale published clock and is idempotent once matched', async (t) => {
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const cases = [
    {
      name: 'stale clock is corrected',
      publishedAt: new Date(
        new Date(sentAt).getTime() - 24 * 60 * 60 * 1000,
      ).toISOString(),
      expectedWrites: 1,
    },
    {
      name: 'matching clock is idempotent',
      publishedAt: sentAt,
      expectedWrites: 0,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture({
        job: {
          state: 'scheduled',
          provider_post_id: 'buffer_post_1',
          provider_status: 'scheduled',
          next_retry_at: new Date(Date.now() - 1000).toISOString(),
        },
      });
      const plan = measurementPlan(fx, {
        published_at: item.publishedAt,
        delivery_managed_by: 'buffer',
        delivery_status: 'published',
      });
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [plan],
      });
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => Response.json({
          data: {
            post: bufferPost(fx, {
              status: 'sent',
              sentAt,
              externalLink: 'https://www.instagram.com/p/authoritative-clock/',
            }),
          },
        }),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
      assert.equal(entities.GrowthPublishJob.records[0].provider_sent_at, sentAt);
      assert.equal(entities.GrowthContentPlan.records[0].published_at, sentAt);
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_managed_by,
        'buffer',
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'published',
      );
      assert.equal(
        entities.GrowthContentPlan.counters.updateMany,
        item.expectedWrites,
      );
    });
  }
});

test('measurement sync failure retries the plan clock locally without another provider request', async () => {
  const sentAt = new Date(Date.now() - 1000).toISOString();
  const fx = await fixture({
    job: {
      state: 'scheduled',
      provider_post_id: 'buffer_post_1',
      provider_status: 'scheduled',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const plan = {
    id: 'growth_plan_retry',
    campaign: fx.artifact.campaign,
    content: fx.artifact.platform_content_id,
    planned_publish_at: fx.dueAt,
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  };
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [plan],
  });
  const originalPlanUpdateMany = entities.GrowthContentPlan.updateMany;
  let failMeasurementOnce = true;
  entities.GrowthContentPlan.updateMany = async (...args) => {
    if (failMeasurementOnce) {
      failMeasurementOnce = false;
      return { success: true, updated: 0, has_more: false };
    }
    return originalPlanUpdateMany(...args);
  };
  const operations = [];
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      operations.push(body.query.includes('createPost') ? 'create' : 'poll');
      return Response.json({
        data: {
          post: bufferPost(fx, {
            status: 'sent',
            sentAt,
            externalLink: 'https://www.instagram.com/p/firstknock-retry/',
          }),
        },
      });
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'measurement_retry');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'content_plan_changed_before_publish',
  );
  assert.equal(entities.GrowthContentPlan.records[0].published_at, undefined);

  entities.GrowthPublishJob.records[0].next_retry_at = new Date(
    Date.now() - 1000,
  ).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.deepEqual(operations, ['poll']);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(entities.GrowthPublishJob.records[0].provider_sent_at, sentAt);
  assert.equal(entities.GrowthContentPlan.records[0].published_at, sentAt);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'published');
});

test('measurement_retry repairs locally without depending on Buffer availability', async () => {
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const fx = await fixture({
    job: {
      state: 'measurement_retry',
      provider_post_id: 'buffer_post_measurement_retry',
      provider_status: 'sent',
      provider_sent_at: sentAt,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let reads = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async (_url, options) => {
      const query = JSON.parse(options.body).query;
      assert.doesNotMatch(query, /createPost/);
      reads += 1;
      return Response.json(
        { errors: [{ message: 'Buffer is temporarily unavailable.' }] },
        { status: 503 },
      );
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(reads, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(
    entities.GrowthPublishJob.records[0].provider_post_id,
    'buffer_post_measurement_retry',
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].published_at,
    sentAt,
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'published');
});

test('measurement_retry repairs from durable sent evidence despite source and config drift', async (t) => {
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const oldChannelId = 'channel_instagram_previous';
  const oldConfigRevision = await growthHelpers.sha256Hex([
    'buffer',
    env.BUFFER_ORGANIZATION_ID,
    oldChannelId,
    'instagram',
    env.GROWTH_MEDIA_ORIGIN,
  ].join('|'));
  const cases = [
    {
      name: 'blocked source',
      changedSource: { ...source, privacy_status: 'blocked', active: true },
    },
    {
      name: 'inactive source',
      changedSource: { ...source, privacy_status: 'safe', active: false },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture({
        job: {
          state: 'measurement_retry',
          provider_channel_id: oldChannelId,
          config_revision: oldConfigRevision,
          provider_post_id: 'buffer_post_durably_sent',
          provider_status: 'sent',
          provider_sent_at: sentAt,
          provider_external_link:
            'https://www.instagram.com/p/durable-measurement-evidence/',
          provider_response_hash: 'd'.repeat(64),
          next_retry_at: new Date(Date.now() - 1000).toISOString(),
        },
      });
      fx.job.request_hash = await growthHelpers.publishJobRequestHash(fx.job);
      fx.job.job_key = await growthHelpers.publishJobKey(fx.job);
      const { base44, entities } = createGrowthBase44({
        sources: [item.changedSource],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [measurementPlan(fx)],
      });
      let providerFetches = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => {
          providerFetches += 1;
          throw new Error('durable measurement repair must remain local');
        },
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(providerFetches, 0);
      assert.equal(entities.GrowthSourceAsset.counters.filter, 0);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
      assert.equal(
        entities.GrowthPublishJob.records[0].provider_post_id,
        'buffer_post_durably_sent',
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].published_at,
        sentAt,
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'published',
      );
    });
  }
});

test('an expired measurement-retry lease recovers to local measurement repair', async () => {
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const fx = await fixture({
    job: {
      state: 'processing',
      provider_post_id: 'buffer_post_expired_measurement',
      provider_status: 'sent',
      provider_sent_at: sentAt,
      provider_response_hash: 'e'.repeat(64),
      attempt_count: 2,
      reconciliation_count: 0,
      lease_token: 'expired-measurement-lease',
      lease_source_state: 'measurement_retry',
      lease_generation: 5,
      lease_acquired_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
      last_error_code: 'content_plan_changed_before_publish',
      last_error_message:
        'Buffer published the post, but its measurement clock needs repair.',
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('expired measurement recovery must not query Buffer');
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'measurement_retry');
  assert.notEqual(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
  assert.equal(
    entities.GrowthPublishJob.records[0].lease_source_state,
    undefined,
  );
  assert.equal(entities.GrowthPublishJob.records[0].reconciliation_count, 0);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
  assert.equal(providerFetches, 0);

  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(entities.GrowthContentPlan.records[0].published_at, sentAt);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'published');
  assert.equal(providerFetches, 0);
});
