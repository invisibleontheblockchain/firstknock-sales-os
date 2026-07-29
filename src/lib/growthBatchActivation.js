const TERMINAL_JOB_STATES = new Set(['sent', 'failed', 'canceled']);
const PROTECTED_JOB_STATES = new Set([
  'queued',
  'processing',
  'retry_wait',
  'approval_wait',
  'scheduled',
  'sending',
  'measurement_retry',
]);
const ATTENTION_JOB_STATES = new Set([
  'reservation_pending',
  'create_reconcile',
  'delivery_reconcile',
  'review_required',
]);
const ALLOWED_AUDIO_MODES = new Set(['silent', 'baked_owned_or_licensed']);
const PLANNING_TIMEZONE = 'America/Phoenix';
const MINIMUM_SCHEDULE_LEAD_MS = 15 * 60 * 1000;
const MAXIMUM_SCHEDULE_LEAD_MS = 366 * 24 * 60 * 60 * 1000;
const BATCH_SLOT_TIMES = {
  morning: '09:30',
  midday: '13:30',
  evening: '18:30',
};
const SLOT_ORDER = {
  morning: 0,
  midday: 1,
  evening: 2,
};
const PLATFORM_ORDER = {
  instagram: 0,
  tiktok: 1,
};

function cleanToken(value) {
  return String(value || '').trim().toLowerCase();
}

function latestJobByArtifact(jobs) {
  const result = new Map();
  const ordered = [...(jobs || [])].sort((left, right) => {
    const leftTime = new Date(
      left?.created_date || left?.requested_at || left?.due_at || 0,
    ).getTime();
    const rightTime = new Date(
      right?.created_date || right?.requested_at || right?.due_at || 0,
    ).getTime();
    return (Number.isFinite(rightTime) ? rightTime : 0)
      - (Number.isFinite(leftTime) ? leftTime : 0);
  });
  for (const job of ordered) {
    const artifactId = String(job?.artifact_id || '').trim();
    if (!artifactId || result.has(artifactId)) continue;
    result.set(artifactId, job);
  }
  return result;
}

function exactStringList(values) {
  return (values || []).map(cleanToken).filter(Boolean);
}

function validTimestamp(value) {
  const parsed = new Date(value || '');
  return Number.isFinite(parsed.getTime());
}

function durableSentEvidence(job) {
  return cleanToken(job?.state) === 'sent'
    || cleanToken(job?.provider_status) === 'sent'
    || validTimestamp(job?.provider_sent_at);
}

function ownerVerifiedCanceledEvidence(job) {
  return cleanToken(job?.state) === 'canceled'
    && cleanToken(job?.last_error_code) === 'owner_verified_provider_canceled';
}

function artifactOrder(left, right) {
  return (SLOT_ORDER[cleanToken(left?.growth_batch_slot_key)] ?? 99)
    - (SLOT_ORDER[cleanToken(right?.growth_batch_slot_key)] ?? 99)
    || String(left?.concept_id || '').localeCompare(String(right?.concept_id || ''))
    || (PLATFORM_ORDER[cleanToken(left?.platform)] ?? 99)
      - (PLATFORM_ORDER[cleanToken(right?.platform)] ?? 99)
    || String(left?.id || '').localeCompare(String(right?.id || ''));
}

export function measuredBatchDueAt(artifact) {
  const targetDate = String(artifact?.growth_batch_target_date || '').trim();
  const slot = cleanToken(artifact?.growth_batch_slot_key);
  const localTime = BATCH_SLOT_TIMES[slot];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || !localTime) return '';
  const parsed = new Date(`${targetDate}T${localTime}:00-07:00`);
  if (!Number.isFinite(parsed.getTime())) return '';
  const roundTrip = new Date(parsed.getTime() - 7 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16);
  return roundTrip === `${targetDate}T${localTime}` ? parsed.toISOString() : '';
}

function pairedConceptsAreValid(artifacts, expectedSlots) {
  const byConcept = new Map();
  for (const artifact of artifacts) {
    const conceptId = cleanToken(artifact?.concept_id);
    if (!conceptId) return false;
    if (!byConcept.has(conceptId)) byConcept.set(conceptId, []);
    byConcept.get(conceptId).push(artifact);
  }
  if (byConcept.size !== 2) return false;
  const pairs = [...byConcept.values()];
  if (!pairs.every((pair) => (
    pair.length === 2
    && new Set(pair.map((artifact) => cleanToken(artifact?.platform))).size === 2
    && pair.some((artifact) => cleanToken(artifact?.platform) === 'instagram')
    && pair.some((artifact) => cleanToken(artifact?.platform) === 'tiktok')
    && new Set(pair.map((artifact) => cleanToken(artifact?.growth_batch_slot_key))).size === 1
  ))) {
    return false;
  }
  const conceptSlots = pairs.map(
    (pair) => cleanToken(pair[0]?.growth_batch_slot_key),
  );
  return new Set(conceptSlots).size === 2
    && conceptSlots.every((slot) => expectedSlots.includes(slot))
    && expectedSlots.every((slot) => conceptSlots.includes(slot));
}

export function growthBatchPublishingReady(capabilities) {
  return capabilities?.can_schedule === true
    && capabilities?.worker_healthy === true
    && capabilities?.planning_timezone === PLANNING_TIMEZONE
    && capabilities?.instagram?.delivery === 'buffer'
    && capabilities?.tiktok?.delivery === 'buffer';
}

export function inspectGrowthBatchActivation({
  batch,
  artifacts = [],
  jobs = [],
  capabilities,
  isMediaReady,
  now = Date.now(),
}) {
  const batchKey = cleanToken(batch?.batch_key);
  const targetDate = String(batch?.target_date || '').trim();
  const batchSlots = exactStringList(batch?.slot_keys);
  const batchArtifacts = artifacts
    .filter((artifact) => cleanToken(artifact?.growth_batch_key) === batchKey)
    .sort(artifactOrder);
  const latestJobs = latestJobByArtifact(jobs);
  const blockers = [];

  if (
    cleanToken(batch?.content_profile) !== 'feature_explainer_video_v1'
    || Number(batch?.concept_count || 0) !== 2
  ) {
    blockers.push('feature_video_profile_required');
  }
  if (cleanToken(batch?.state) !== 'render_authorized') {
    blockers.push('batch_render_authorization_required');
  }
  if (
    String(batch?.timezone || '') !== PLANNING_TIMEZONE
    || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)
    || batchSlots.length !== 2
    || batchSlots[0] !== 'morning'
    || batchSlots[1] !== 'midday'
  ) {
    blockers.push('batch_schedule_contract_invalid');
  }
  if (!growthBatchPublishingReady(capabilities)) {
    blockers.push('both_platforms_not_ready');
  }
  if (typeof isMediaReady !== 'function') {
    blockers.push('media_readiness_check_required');
  }
  if (batchArtifacts.length !== 4) {
    blockers.push('four_batch_renditions_required');
  }
  if (
    batchArtifacts.length === 4
    && !pairedConceptsAreValid(batchArtifacts, batchSlots)
  ) {
    blockers.push('paired_platform_renditions_required');
  }

  const scheduleCandidates = [];
  const alreadyQueued = [];
  const sent = [];
  const needsAttention = [];
  for (const artifact of batchArtifacts) {
    const artifactId = String(artifact?.id || '').trim();
    const latestJob = latestJobs.get(artifactId);
    const state = cleanToken(latestJob?.state);
    const providerEvidence = String(latestJob?.provider_post_id || '').trim();
    if (durableSentEvidence(latestJob)) {
      sent.push(artifact);
      continue;
    }
    if (latestJob && PROTECTED_JOB_STATES.has(state)) {
      alreadyQueued.push(artifact);
      continue;
    }
    if (
      latestJob
      && (
        ATTENTION_JOB_STATES.has(state)
        || (!TERMINAL_JOB_STATES.has(state) && !PROTECTED_JOB_STATES.has(state))
      )
    ) {
      needsAttention.push(artifact);
      blockers.push(`delivery_needs_attention:${artifactId || 'unknown'}`);
      continue;
    }
    if (providerEvidence && !ownerVerifiedCanceledEvidence(latestJob)) {
      needsAttention.push(artifact);
      blockers.push(`provider_evidence:${artifactId || 'unknown'}`);
      continue;
    }
    const dueAt = measuredBatchDueAt(artifact);
    const dueMs = dueAt ? new Date(dueAt).getTime() : 0;
    const approvedAndReviewed = (
      cleanToken(artifact?.format) === 'video'
      && cleanToken(artifact?.review_status) === 'passed'
      && cleanToken(artifact?.approval_status) === 'approved'
      && Boolean(String(artifact?.approved_hash || '').trim())
      && artifact?.privacy_cleared === true
      && artifact?.demo_labeled === true
      && artifact?.claims_supported === true
      && artifact?.media_rights_confirmed === true
    );
    const exactBatchLineage = (
      String(artifact?.growth_batch_target_date || '') === targetDate
      && String(artifact?.render_pack_sha256 || '').trim().toLowerCase()
        === String(batch?.canonical_pack_sha256 || '').trim().toLowerCase()
      && ALLOWED_AUDIO_MODES.has(cleanToken(artifact?.audio_mode))
    );
    const withinScheduleWindow = Number.isFinite(dueMs)
      && dueMs >= now + MINIMUM_SCHEDULE_LEAD_MS
      && dueMs <= now + MAXIMUM_SCHEDULE_LEAD_MS;
    if (
      !artifactId
      || !approvedAndReviewed
      || !exactBatchLineage
      || !withinScheduleWindow
      || typeof isMediaReady !== 'function'
      || !isMediaReady(artifact)
    ) {
      blockers.push(`rendition_not_ready:${artifactId || 'unknown'}`);
      continue;
    }
    scheduleCandidates.push({
      artifact,
      retry_terminal: Boolean(
        latestJob && ['failed', 'canceled'].includes(state),
      ),
    });
  }

  const uniqueBlockers = [...new Set(blockers)];
  const protectedCount = alreadyQueued.length + sent.length;
  return {
    artifacts: batchArtifacts,
    schedule_candidates: scheduleCandidates,
    schedulable: scheduleCandidates.map((candidate) => candidate.artifact),
    already_queued: alreadyQueued,
    sent,
    needs_attention: needsAttention,
    protected_count: protectedCount,
    blockers: uniqueBlockers,
    complete: (
      uniqueBlockers.length === 0
      && batchArtifacts.length === 4
      && protectedCount === 4
    ),
    can_activate: (
      uniqueBlockers.length === 0
      && scheduleCandidates.length > 0
    ),
  };
}

export function growthBatchScheduleRequest(
  candidate,
  { silentAutomaticConfirmed = false } = {},
) {
  const artifact = candidate?.artifact;
  const dueAt = measuredBatchDueAt(artifact);
  const audioMode = cleanToken(artifact?.audio_mode);
  if (
    !dueAt
    || !ALLOWED_AUDIO_MODES.has(audioMode)
    || (audioMode === 'silent' && silentAutomaticConfirmed !== true)
  ) {
    return null;
  }
  return {
    action: 'schedule',
    artifact_id: artifact.id,
    due_at: dueAt,
    scheduling_type: 'automatic',
    timezone: PLANNING_TIMEZONE,
    ...(audioMode === 'silent'
      ? { confirm_silent_automatic: true }
      : {}),
    ...(candidate?.retry_terminal === true
      ? { retry_terminal: true }
      : {}),
  };
}
