import assert from 'node:assert/strict';
import test from 'node:test';
import {
  growthBatchScheduleRequest,
  growthBatchPublishingReady,
  inspectGrowthBatchActivation,
  measuredBatchDueAt,
} from '../src/lib/growthBatchActivation.js';

const BATCH_HASH = 'a'.repeat(64);
const NOW = new Date('2026-07-31T00:00:00.000Z').getTime();
const READY_CAPABILITIES = {
  can_schedule: true,
  worker_healthy: true,
  planning_timezone: 'America/Phoenix',
  instagram: { delivery: 'buffer' },
  tiktok: { delivery: 'buffer' },
};

function artifact({
  id,
  concept,
  platform,
  slot,
  overrides = {},
}) {
  return {
    id,
    concept_id: concept,
    platform,
    format: 'video',
    growth_batch_key: BATCH_HASH,
    growth_batch_target_date: '2026-08-01',
    growth_batch_slot_key: slot,
    render_pack_sha256: BATCH_HASH,
    review_status: 'passed',
    approval_status: 'approved',
    approved_hash: 'b'.repeat(64),
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    audio_mode: 'silent',
    ...overrides,
  };
}

function strictBatch(overrides = {}) {
  return {
    batch_key: BATCH_HASH,
    state: 'render_authorized',
    content_profile: 'feature_explainer_video_v1',
    canonical_pack_sha256: BATCH_HASH,
    target_date: '2026-08-01',
    timezone: 'America/Phoenix',
    slot_keys: ['morning', 'midday'],
    concept_count: 2,
    ...overrides,
  };
}

const fourArtifacts = [
  artifact({ id: 'ig-1', concept: 'one', platform: 'instagram', slot: 'morning' }),
  artifact({ id: 'tt-1', concept: 'one', platform: 'tiktok', slot: 'morning' }),
  artifact({ id: 'ig-2', concept: 'two', platform: 'instagram', slot: 'midday' }),
  artifact({ id: 'tt-2', concept: 'two', platform: 'tiktok', slot: 'midday' }),
];

test('strict two-video batch activation accepts four reviewed paired renditions', () => {
  const result = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts,
    capabilities: READY_CAPABILITIES,
    isMediaReady: () => true,
    now: NOW,
  });

  assert.equal(result.can_activate, true);
  assert.equal(result.complete, false);
  assert.equal(result.schedulable.length, 4);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(
    result.schedulable.map((item) => item.id),
    ['ig-1', 'tt-1', 'ig-2', 'tt-2'],
  );
});

test('activation fails closed for legacy profiles, incomplete pairs, or unready media', () => {
  const legacy = inspectGrowthBatchActivation({
    batch: strictBatch({ content_profile: undefined }),
    artifacts: fourArtifacts,
    capabilities: READY_CAPABILITIES,
    isMediaReady: () => true,
    now: NOW,
  });
  assert.deepEqual(legacy.blockers, ['feature_video_profile_required']);

  const incomplete = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts.slice(0, 3),
    capabilities: READY_CAPABILITIES,
    isMediaReady: () => true,
    now: NOW,
  });
  assert.ok(incomplete.blockers.includes('four_batch_renditions_required'));

  const unsafe = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts,
    capabilities: READY_CAPABILITIES,
    isMediaReady: (item) => item.id !== 'ig-2',
    now: NOW,
  });
  assert.ok(unsafe.blockers.includes('rendition_not_ready:ig-2'));
  assert.equal(unsafe.can_activate, false);
});

test('activation resumes only unscheduled renditions and treats sent jobs as complete', () => {
  const jobs = [
    { artifact_id: 'ig-1', state: 'scheduled' },
    { artifact_id: 'tt-1', state: 'sent', provider_post_id: 'buffer-tt-1' },
  ];
  const result = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts,
    jobs,
    capabilities: READY_CAPABILITIES,
    isMediaReady: () => true,
    now: NOW,
  });

  assert.equal(result.can_activate, true);
  assert.deepEqual(result.schedulable.map((item) => item.id), ['ig-2', 'tt-2']);
  assert.deepEqual(result.already_queued.map((item) => item.id), ['ig-1']);
  assert.deepEqual(result.sent.map((item) => item.id), ['tt-1']);
});

test('provider evidence on a failed job blocks automated retry', () => {
  const result = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts,
    jobs: [{
      artifact_id: 'ig-1',
      state: 'failed',
      provider_post_id: 'buffer-ambiguous',
    }],
    capabilities: READY_CAPABILITIES,
    isMediaReady: () => true,
    now: NOW,
  });

  assert.ok(result.blockers.includes('provider_evidence:ig-1'));
  assert.equal(result.can_activate, false);
});

test('activation evaluates the latest delivery attempt even when jobs arrive unsorted', () => {
  const result = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts,
    jobs: [
      {
        artifact_id: 'ig-1',
        state: 'failed',
        created_date: '2026-07-30T12:00:00.000Z',
      },
      {
        artifact_id: 'ig-1',
        state: 'scheduled',
        created_date: '2026-07-31T12:00:00.000Z',
      },
    ],
    capabilities: READY_CAPABILITIES,
    isMediaReady: () => true,
    now: NOW,
  });

  assert.deepEqual(result.already_queued.map((item) => item.id), ['ig-1']);
  assert.deepEqual(result.schedulable.map((item) => item.id), ['tt-1', 'ig-2', 'tt-2']);
});

test('schedule requests use exact Phoenix batch slots and explicit silent confirmation', () => {
  assert.equal(growthBatchScheduleRequest({
    artifact: fourArtifacts[0],
    retry_terminal: false,
  }), null);
  const request = growthBatchScheduleRequest({
    artifact: fourArtifacts[0],
    retry_terminal: false,
  }, {
    silentAutomaticConfirmed: true,
  });
  assert.deepEqual(request, {
    action: 'schedule',
    artifact_id: 'ig-1',
    due_at: '2026-08-01T16:30:00.000Z',
    scheduling_type: 'automatic',
    timezone: 'America/Phoenix',
    confirm_silent_automatic: true,
  });
  assert.equal(measuredBatchDueAt({}), '');
});

test('failed and owner-verified canceled jobs produce explicit terminal retry requests', () => {
  for (const job of [
    { artifact_id: 'ig-1', state: 'failed' },
    {
      artifact_id: 'ig-1',
      state: 'canceled',
      provider_post_id: 'buffer-canceled',
      last_error_code: 'owner_verified_provider_canceled',
    },
  ]) {
    const inspected = inspectGrowthBatchActivation({
      batch: strictBatch(),
      artifacts: fourArtifacts,
      jobs: [job],
      capabilities: READY_CAPABILITIES,
      isMediaReady: () => true,
      now: NOW,
    });
    const candidate = inspected.schedule_candidates.find(
      (item) => item.artifact.id === 'ig-1',
    );
    assert.equal(candidate.retry_terminal, true);
    assert.equal(growthBatchScheduleRequest(candidate, {
      silentAutomaticConfirmed: true,
    }).retry_terminal, true);
  }
});

test('ambiguous or intervention states block activation and cannot report completion', () => {
  for (const state of [
    'reservation_pending',
    'create_reconcile',
    'delivery_reconcile',
    'review_required',
    'unknown_new_state',
  ]) {
    const result = inspectGrowthBatchActivation({
      batch: strictBatch(),
      artifacts: fourArtifacts,
      jobs: [{ artifact_id: 'ig-1', state }],
      capabilities: READY_CAPABILITIES,
      isMediaReady: () => true,
      now: NOW,
    });
    assert.equal(result.can_activate, false, state);
    assert.equal(result.complete, false, state);
    assert.ok(
      result.blockers.includes('delivery_needs_attention:ig-1'),
      state,
    );
  }
});

test('provider sent status or timestamp is durable completion evidence', () => {
  for (const job of [
    { artifact_id: 'ig-1', state: 'failed', provider_status: 'sent' },
    {
      artifact_id: 'ig-1',
      state: 'failed',
      provider_sent_at: '2026-08-01T16:31:00.000Z',
    },
  ]) {
    const result = inspectGrowthBatchActivation({
      batch: strictBatch(),
      artifacts: fourArtifacts,
      jobs: [job],
      capabilities: READY_CAPABILITIES,
      isMediaReady: () => true,
      now: NOW,
    });
    assert.deepEqual(result.sent.map((item) => item.id), ['ig-1']);
    assert.equal(result.can_activate, true);
  }

  const malformedTimestamp = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts,
    jobs: [{
      artifact_id: 'ig-1',
      state: 'failed',
      provider_sent_at: 'not-a-timestamp',
    }],
    capabilities: READY_CAPABILITIES,
    isMediaReady: () => true,
    now: NOW,
  });
  assert.deepEqual(malformedTimestamp.sent, []);
  assert.equal(
    malformedTimestamp.schedule_candidates.some(
      (item) => item.artifact.id === 'ig-1' && item.retry_terminal === true,
    ),
    true,
  );
});

test('batch lineage, distinct slots, and future scheduling window are fail closed', () => {
  const duplicateSlotArtifacts = fourArtifacts.map((item) => (
    item.concept_id === 'two'
      ? { ...item, growth_batch_slot_key: 'morning' }
      : item
  ));
  const duplicateSlots = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: duplicateSlotArtifacts,
    capabilities: READY_CAPABILITIES,
    isMediaReady: () => true,
    now: NOW,
  });
  assert.ok(duplicateSlots.blockers.includes('paired_platform_renditions_required'));

  const changedPack = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts.map((item, index) => (
      index === 0 ? { ...item, render_pack_sha256: 'c'.repeat(64) } : item
    )),
    capabilities: READY_CAPABILITIES,
    isMediaReady: () => true,
    now: NOW,
  });
  assert.ok(changedPack.blockers.includes('rendition_not_ready:ig-1'));

  const expired = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts,
    capabilities: READY_CAPABILITIES,
    isMediaReady: () => true,
    now: new Date('2026-08-02T00:00:00.000Z').getTime(),
  });
  assert.equal(expired.can_activate, false);
  assert.ok(expired.blockers.includes('rendition_not_ready:ig-1'));
});

test('both Buffer channels, owner scheduling, and media preflight are required', () => {
  assert.equal(growthBatchPublishingReady(READY_CAPABILITIES), true);
  assert.equal(growthBatchPublishingReady({
    ...READY_CAPABILITIES,
    tiktok: { delivery: 'not_configured' },
  }), false);

  const noTikTok = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts,
    capabilities: {
      ...READY_CAPABILITIES,
      tiktok: { delivery: 'not_configured' },
    },
    isMediaReady: () => true,
    now: NOW,
  });
  assert.ok(noTikTok.blockers.includes('both_platforms_not_ready'));

  const noMediaPredicate = inspectGrowthBatchActivation({
    batch: strictBatch(),
    artifacts: fourArtifacts,
    capabilities: READY_CAPABILITIES,
    now: NOW,
  });
  assert.ok(noMediaPredicate.blockers.includes('media_readiness_check_required'));
  assert.equal(noMediaPredicate.can_activate, false);
});
