import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRequestedPrecisionCriteria,
  buildVerifiedPrecisionProcessingJob,
  calculatePrecisionUsage,
  classifyActivePrecisionJobs,
  executePrecisionStart,
  FREE_PRECISION_PROPERTY_LIMIT,
  hasPrecisionJobMarkers,
  isActualPrecisionJob,
  isPrecisionReservationUnsettled,
  listAllPrecisionRecords,
  loadAndValidatePrecisionRetry,
  PAID_PRECISION_PROPERTY_LIMIT,
  precisionErrorPayload,
  precisionJobUsage,
  precisionPolygonHash,
  precisionReservationAmount,
  resolvePrecisionEntitlement,
  validateStrictPrecisionCriteriaV1,
  verifyPrecisionJobCriteriaEvidence,
} from '../base44/functions/_shared/precisionActiveJobCriteria.js';

const polygon = [
  { lat: 33.4, lng: -112.2 },
  { lat: 33.6, lng: -112.2 },
  { lat: 33.6, lng: -112.0 },
  { lat: 33.4, lng: -112.0 },
];
const routeFilters = {
  propertyTypes: ['Single Family'],
  excludeCommercial: true,
  excludeCondos: true,
  excludeLand: true,
};

test('schema-default zero ledger fields do not claim Precision identity', () => {
  const unrelated = {
    id: 'ordinary_fetch',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    phase: 'batchdata_precision',
    status: 'completed',
    precision_usage_reserved: 0,
    precision_usage_count: 0,
    precision_usage_user_id: null,
    precision_usage_kind: null,
    precision_usage_recorded_at: null,
    processor_claim_id: null,
    precision_watchdog_recovery_at: null,
  };

  assert.equal(hasPrecisionJobMarkers(unrelated), false);
  assert.equal(isActualPrecisionJob(unrelated), false);
  assert.equal(hasPrecisionJobMarkers({
    ...unrelated,
    precision_usage_count: 1,
  }), true);
  assert.equal(hasPrecisionJobMarkers({
    ...unrelated,
    precision_usage_reserved: '0',
  }), true);
  const criteriaOnly = {
    ...unrelated,
    dry_run_metadata: { precision_criteria: { criteria_schema_version: 1 } },
  };
  assert.equal(hasPrecisionJobMarkers(criteriaOnly), true);
  assert.equal(isActualPrecisionJob(criteriaOnly), false);
});

test('precision discovery fails closed on cross-page record overlap', async () => {
  const entity = {
    filter: async (_filter, _sort, _limit, skip) => (
      skip === 0
        ? [{ id: 'row_1' }, { id: 'row_2' }]
        : [{ id: 'row_2' }, { id: 'row_3' }]
    ),
  };

  await assert.rejects(
    () => listAllPrecisionRecords(entity, {}, '-created_date', 2),
    error => (
      error.code === 'precision_job_discovery_incomplete'
      && error.details.repeated_record_id === 'row_2'
    )
  );
});

async function canonicalCriteria(overrides = {}) {
  return {
    criteria_schema_version: 1,
    polygon_hash: await precisionPolygonHash(polygon),
    count_mode: 'fixed',
    entered_count: 1000,
    effective_count: 839,
    min_price: 100000,
    max_price: null,
    sold_months: 12,
    ownership_range_mode: 'custom',
    ownership_range_days: { min: 59, max: 365 },
    route_filters: routeFilters,
    repull_mode: 'new_area',
    previous_pull_date: null,
    force_full_refresh: false,
    include_unresolved_followups: false,
    route_bounds: { enabled: false },
    immutable_user_id: 'user_1',
    workspace_id: 'manager_1',
    ...overrides,
  };
}

async function failedSource(overrides = {}) {
  const criteriaOverrides = overrides.criteria || {};
  const criteria = await canonicalCriteria(criteriaOverrides);
  return {
    id: 'failed_1',
    status: 'failed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    include_mls: false,
    precision_usage_user_id: 'user_1',
    user_email: 'owner@example.com',
    precision_usage_reserved: 0,
    precision_usage_count: 0,
    precision_usage_recorded_at: '2026-07-25T12:05:00.000Z',
    completed_at: '2026-07-25T12:05:00.000Z',
    created_date: '2026-07-25T12:00:00.000Z',
    updated_date: '2026-07-25T12:05:00.000Z',
    total_inserted: 0,
    total_existed: 0,
    polygon,
    polygon_hash: criteria.polygon_hash,
    dry_run_metadata: {
      workspace_id: criteria.workspace_id,
      criteria_reference_at: '2026-07-25T12:00:00.000Z',
      precision_criteria: criteria,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'criteria')),
  };
}

async function verifiedRetryAttempt(predecessor, {
  id = 'attempt_2',
  criteria = {},
  rootFetchJobId = predecessor.root_fetch_job_id || predecessor.id,
  ...overrides
} = {}) {
  const predecessorCriteria = predecessor.dry_run_metadata.precision_criteria;
  const predecessorTerminalAt = (
    predecessor.completed_at
    ?? predecessor.precision_usage_recorded_at
    ?? predecessor.updated_date
  );
  const attempt = await failedSource({
    id,
    source_fetch_job_id: predecessor.id,
    root_fetch_job_id: rootFetchJobId,
    attempt_number: Number(predecessor.attempt_number || 1) + 1,
    attempt_reason: 'verified_retry',
    attempt_created_at: new Date(
      new Date(predecessorTerminalAt).getTime() + 1000
    ).toISOString(),
    attempt_actor_user_id: 'user_1',
    attempt_subject_user_id: 'user_1',
    attempt_workspace_id: 'manager_1',
    source_criteria_schema_version: predecessorCriteria.criteria_schema_version,
    source_polygon_hash: predecessorCriteria.polygon_hash,
    source_effective_count: predecessorCriteria.effective_count,
    source_status: predecessor.status,
    source_terminal_at: predecessorTerminalAt,
    criteria,
    ...overrides,
  });
  attempt.dry_run_metadata.criteria_reference_at =
    predecessor.dry_run_metadata.criteria_reference_at;
  return attempt;
}

test('verified processor view overwrites every material alias from one canonical snapshot', async () => {
  const source = await failedSource({
    status: 'running',
    precision_usage_reserved: 839,
    precision_usage_recorded_at: undefined,
    sold_months: 1,
    total_expected: 999,
    estimated_record_count: 999,
    user_email: 'stale@example.com',
    dry_run_metadata: {
      workspace_id: 'manager_1',
      criteria_reference_at: '2026-07-25T12:00:00.000Z',
      requested_properties: 999,
      requested_properties_before_cap: 999,
      count_mode: 'max_available',
      filters: { min_price: 1, max_price: 2 },
      route_filters: { propertyTypes: ['Townhouse'] },
      ownership_range_mode: 'custom',
      ownership_range_days: { min: 1, max: 2 },
      precision_criteria: await canonicalCriteria(),
    },
  });
  const subject = {
    id: 'user_1',
    email: 'owner-current@example.com',
    team_manager_id: 'manager_1',
  };
  const evidence = await verifyPrecisionJobCriteriaEvidence(source, subject);
  assert.equal(evidence.ok, true);

  const processingJob = buildVerifiedPrecisionProcessingJob(source, evidence, subject);
  assert.equal(processingJob.user_email, 'stale@example.com');
  assert.equal(processingJob.sold_months, 12);
  assert.equal(processingJob.total_expected, 839);
  assert.equal(processingJob.estimated_record_count, 839);
  assert.equal(processingJob.include_mls, false);
  assert.deepEqual(processingJob.polygon, polygon);
  assert.deepEqual(processingJob.dry_run_metadata.filters, {
    min_price: 100000,
    max_price: null,
  });
  assert.deepEqual(processingJob.dry_run_metadata.route_filters, routeFilters);
  assert.equal(processingJob.dry_run_metadata.ownership_range_mode, 'custom');
  assert.deepEqual(processingJob.dry_run_metadata.ownership_range_days, {
    min: 59,
    max: 365,
  });
  assert.equal(processingJob.dry_run_metadata.count_mode, 'fixed');
});

function retryBase44(job) {
  return {
    asServiceRole: {
      entities: {
        FetchJob: {
          get: async id => id === job.id ? job : null,
          filter: async filter => Object.entries(filter).every(([key, value]) => job[key] === value) ? [job] : [],
        },
      },
    },
  };
}

function retryChainBase44(jobs) {
  return {
    asServiceRole: {
      entities: {
        FetchJob: {
          get: async id => jobs.find(job => job.id === id) || null,
          filter: async (filter, _sort, limit = 500, skip = 0) =>
            jobs
              .filter(job => Object.entries(filter).every(([key, value]) => job[key] === value))
              .slice(skip, skip + limit),
        },
      },
    },
  };
}

test('strict schema-v1 validation emits exact ordered and value-free per-field reasons', async () => {
  const valid = await canonicalCriteria();
  assert.equal(validateStrictPrecisionCriteriaV1(valid).ok, true);

  const cases = [
    [
      { ...valid, criteria_schema_version: 2 },
      [{ field: 'criteria_schema_version', reason: 'unsupported_schema_version' }],
    ],
    [
      { ...valid, sold_months: 2 },
      [{ field: 'sold_months', reason: 'relational_conflict' }],
    ],
    [
      { ...valid, max_price: undefined },
      [{ field: 'max_price', reason: 'missing' }],
    ],
    [
      { ...valid, force_full_refresh: undefined },
      [{ field: 'force_full_refresh', reason: 'missing' }],
    ],
    [
      { ...valid, include_unresolved_followups: null },
      [{ field: 'include_unresolved_followups', reason: 'null_not_allowed' }],
    ],
    [
      { ...valid, min_price: false },
      [{ field: 'min_price', reason: 'wrong_type' }],
    ],
    [
      { ...valid, entered_count: 1.5 },
      [{ field: 'entered_count', reason: 'malformed' }],
    ],
    [
      { ...valid, entered_count: 0 },
      [{ field: 'entered_count', reason: 'out_of_range' }],
    ],
    [
      { ...valid, count_mode: 'unbounded' },
      [{ field: 'count_mode', reason: 'unsupported_value' }],
    ],
    [
      { ...valid, ownership_range_days: { min: '59', max: 365 } },
      [{ field: 'ownership_range_days', reason: 'wrong_type' }],
    ],
    [{
      ...valid,
      route_bounds: {
        enabled: true,
        mode: 'home_round_trip',
        start_location: { lat: '33.4', lng: -112.2 },
        end_location: { lat: 33.4, lng: -112.2 },
      },
    }, [{ field: 'route_bounds', reason: 'wrong_type' }]],
    [
      { ...valid, immutable_user_id: 123 },
      [{ field: 'immutable_user_id', reason: 'wrong_type' }],
    ],
    [
      { ...valid, workspace_id: 123 },
      [{ field: 'workspace_id', reason: 'wrong_type' }],
    ],
    [
      { ...valid, effective_count: 1001 },
      [{ field: 'effective_count', reason: 'relational_conflict' }],
    ],
    [
      { ...valid, max_price: 50000 },
      [{ field: 'max_price', reason: 'relational_conflict' }],
    ],
    [
      { ...valid, repull_mode: 'fill_gaps', previous_pull_date: null },
      [{ field: 'previous_pull_date', reason: 'null_not_allowed' }],
    ],
    [
      { ...valid, repull_mode: 'new_area', previous_pull_date: '2026-07-01T00:00:00.000Z' },
      [{ field: 'previous_pull_date', reason: 'relational_conflict' }],
    ],
    [{
      ...valid,
      repull_mode: 'max_since_last',
      previous_pull_date: '2026-07-24T00:00:00.000Z',
    }, [
      { field: 'repull_mode', reason: 'relational_conflict' },
      { field: 'ownership_range_mode', reason: 'relational_conflict' },
    ]],
  ];

  for (const [candidate, expectedReasons] of cases) {
    const result = validateStrictPrecisionCriteriaV1(candidate);
    assert.equal(result.ok, false, JSON.stringify(expectedReasons));
    assert.deepEqual(
      result.invalid_fields,
      expectedReasons.map(diagnostic => diagnostic.field)
    );
    assert.deepEqual(result.invalid_reasons, expectedReasons);
    assert.doesNotMatch(JSON.stringify(result.invalid_reasons), /unbounded|50000|1001|2026-07-01/);
  }

  const mixed = { ...valid, polygon_hash: 'not-a-hash' };
  delete mixed.force_full_refresh;
  assert.deepEqual(
    validateStrictPrecisionCriteriaV1(mixed).invalid_reasons,
    [
      { field: 'force_full_refresh', reason: 'missing' },
      { field: 'polygon_hash', reason: 'malformed' },
    ]
  );

  assert.deepEqual(
    validateStrictPrecisionCriteriaV1(undefined).invalid_reasons,
    [{ field: 'precision_criteria', reason: 'missing' }]
  );
  assert.deepEqual(
    validateStrictPrecisionCriteriaV1(null).invalid_reasons,
    [{ field: 'precision_criteria', reason: 'null_not_allowed' }]
  );
  assert.deepEqual(
    validateStrictPrecisionCriteriaV1(false).invalid_reasons,
    [{ field: 'precision_criteria', reason: 'wrong_type' }]
  );

  const explicitFalseAndNull = {
    ...valid,
    max_price: null,
    previous_pull_date: null,
    force_full_refresh: false,
    include_unresolved_followups: false,
  };
  assert.equal(validateStrictPrecisionCriteriaV1(explicitFalseAndNull).ok, true);
});

test('explicit reservations never age out and malformed evidence fails closed', () => {
  const old = {
    id: 'old_reserved',
    status: 'failed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    created_date: '2020-01-01T00:00:00.000Z',
    precision_usage_reserved: 25,
  };
  assert.equal(precisionReservationAmount(old), 25);
  assert.equal(isPrecisionReservationUnsettled(old), true);

  for (const malformed of [undefined, null, false, Number.NaN, '25', 'not-a-number', -1, 1.5]) {
    assert.throws(
      () => precisionReservationAmount({ ...old, precision_usage_reserved: malformed }),
      error => error.code === 'precision_reservation_unverifiable'
    );
  }
});

test('settled delivered-count evidence is explicit, integral and fail-closed', () => {
  const settled = {
    id: 'settled_1',
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_reserved: 0,
    precision_usage_count: 12,
    precision_usage_recorded_at: '2026-07-25T12:00:00.000Z',
  };
  assert.deepEqual(precisionJobUsage(settled), { used: 12, reserved: 0 });

  for (const malformed of [undefined, null, false, '12', Number.NaN, -1, 1.5]) {
    assert.throws(
      () => precisionJobUsage({ ...settled, precision_usage_count: malformed }),
      error => error.code === 'precision_usage_unverifiable'
    );
  }
  assert.throws(
    () => precisionJobUsage({ ...settled, precision_usage_recorded_at: 'not-a-date' }),
    error => error.code === 'precision_usage_unverifiable'
  );
  assert.throws(
    () => precisionJobUsage({
      ...settled,
      precision_usage_count: 51,
      dry_run_metadata: { precision_criteria: { effective_count: 50 } },
    }),
    error => error.code === 'precision_usage_unverifiable'
  );

  const legacy = {
    id: 'legacy_completed',
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    total_expected: 20,
    total_inserted: 8,
    total_existed: 2,
    dry_run_metadata: {
      batchdata_summary: { active: 10 },
    },
  };
  assert.deepEqual(precisionJobUsage(legacy), { used: 10, reserved: 0 });
  const ambiguousLegacy = structuredClone(legacy);
  delete ambiguousLegacy.dry_run_metadata;
  assert.throws(
    () => precisionJobUsage(ambiguousLegacy),
    error => error.code === 'legacy_precision_usage_unverifiable'
  );
  assert.throws(
    () => precisionJobUsage({ ...legacy, precision_usage_count: 0 }),
    error => error.code === 'precision_usage_unverifiable'
  );
});

test('current-period meter and all-period unsettled start gate remain distinct', () => {
  const entitlement = {
    kind: 'paid',
    paidAccess: true,
    proAccess: true,
    limit: 1000,
    subscriptionId: 'sub_current',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
  };
  const usage = calculatePrecisionUsage([
    {
      id: 'current_used',
      status: 'completed',
      provider: 'batchdata',
      mode_tag: 'PRECISION_TARGET',
      precision_usage_user_id: 'user_1',
      precision_usage_kind: 'paid',
      precision_usage_period_start: entitlement.periodStart,
      precision_usage_reserved: 0,
      precision_usage_count: 100,
      precision_usage_recorded_at: '2026-07-10T00:00:00.000Z',
    },
    {
      id: 'old_unsettled',
      status: 'failed',
      provider: 'batchdata',
      mode_tag: 'PRECISION_TARGET',
      precision_usage_user_id: 'user_1',
      precision_usage_kind: 'paid',
      precision_usage_period_start: '2026-06-01T00:00:00.000Z',
      precision_usage_reserved: 50,
      precision_usage_count: 0,
    },
  ], entitlement);

  assert.equal(usage.used, 100);
  assert.equal(usage.reserved, 0);
  assert.equal(usage.remaining, 900);
  assert.equal(usage.unsettledReservationCount, 1);
  assert.deepEqual(usage.unsettledJobIds, ['old_unsettled']);
});

test('the actual Precision predicate excludes unrelated BatchData jobs and active conflicts are never collapsed', () => {
  const precision = {
    id: 'precision_1',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
  };
  const second = { ...precision, id: 'precision_2', status: 'pending' };
  const unrelated = {
    id: 'unrelated',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'CANVAS_DOOR',
  };
  assert.equal(isActualPrecisionJob(precision), true);
  assert.equal(isActualPrecisionJob(unrelated), false);
  assert.deepEqual(classifyActivePrecisionJobs([unrelated]), { state: 'none', jobs: [] });
  const conflict = classifyActivePrecisionJobs([precision, second, unrelated]);
  assert.equal(conflict.state, 'multiple');
  assert.deepEqual(conflict.jobs.map(job => job.id).sort(), ['precision_1', 'precision_2']);
});

test('server-authoritative retry maps verified fixed intent and rejects identity hints or mismatches', async () => {
  const source = await failedSource();
  const owner = {
    id: 'user_1',
    email: 'changed@example.com',
    team_manager_id: 'manager_1',
    role: 'user',
  };
  const request = await loadAndValidatePrecisionRetry(retryBase44(source), owner, source.id);
  assert.equal(request.count_mode, 'fixed');
  assert.equal(request.entered_count, 1000);
  assert.equal(request.retry.source_job.id, source.id);
  assert.equal(request.polygon.length, polygon.length);

  const wrongUser = { ...owner, id: 'other_user', email: source.user_email };
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(retryBase44(source), wrongUser, source.id),
    error => error.code === 'precision_retry_owner_mismatch' && error.status === 403
  );

  const undelegatedAdmin = {
    id: 'admin_1',
    email: source.user_email,
    team_manager_id: 'manager_1',
    role: 'admin',
  };
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(retryBase44(source), undelegatedAdmin, source.id),
    error => error.code === 'precision_retry_owner_mismatch' && error.status === 403
  );

  await assert.rejects(
    () => loadAndValidatePrecisionRetry(
      retryBase44(source),
      { ...owner, team_manager_id: 'manager_other' },
      source.id
    ),
    error => error.code === 'precision_retry_workspace_mismatch' && error.status === 403
  );

  const conflictingWorkspace = await failedSource();
  conflictingWorkspace.dry_run_metadata.workspace_id = 'manager_other';
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(retryBase44(conflictingWorkspace), owner, conflictingWorkspace.id),
    error => error.code === 'precision_retry_workspace_mismatch' && error.status === 403
  );
});

test('retry requires one explicit immutable criteria reference across the full chain', async () => {
  const owner = {
    id: 'user_1',
    email: 'owner@example.com',
    team_manager_id: 'manager_1',
  };
  const missingReference = await failedSource({ id: 'missing_reference' });
  delete missingReference.dry_run_metadata.criteria_reference_at;
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(
      retryBase44(missingReference),
      owner,
      missingReference.id
    ),
    error => error.code === 'precision_retry_criteria_reference_unverifiable'
  );

  const root = await failedSource({ id: 'reference_root' });
  const tamperedAttempt = await verifiedRetryAttempt(root, {
    id: 'reference_attempt_2',
  });
  tamperedAttempt.dry_run_metadata.criteria_reference_at =
    '2026-07-25T12:01:00.000Z';
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(
      retryChainBase44([root, tamperedAttempt]),
      owner,
      tamperedAttempt.id
    ),
    error => (
      error.code === 'precision_retry_lineage_unverifiable'
      && error.details.mismatched_fields.includes(
        'dry_run_metadata.criteria_reference_at'
      )
    )
  );
});

test('retry root is derived from a verified predecessor chain and forged roots or cycles fail closed', async () => {
  const owner = {
    id: 'user_1',
    email: 'owner@example.com',
    team_manager_id: 'manager_1',
  };
  const root = await failedSource({ id: 'root_1' });
  const attempt = await verifiedRetryAttempt(root, {
    id: 'attempt_2',
  });
  const request = await loadAndValidatePrecisionRetry(
    retryChainBase44([root, attempt]),
    owner,
    attempt.id
  );
  assert.equal(request.retry.lineage_root_fetch_job_id, root.id);

  const fixedRoot = await failedSource({
    id: 'fixed_root',
    criteria: {
      count_mode: 'fixed',
      entered_count: 1000,
      effective_count: 839,
    },
  });
  const fixedAttempt = await verifiedRetryAttempt(fixedRoot, {
    id: 'fixed_attempt_2',
    criteria: {
      count_mode: 'fixed',
      entered_count: 1000,
      effective_count: 600,
    },
  });
  const fixedAttemptThree = await loadAndValidatePrecisionRetry(
    retryChainBase44([fixedRoot, fixedAttempt]),
    owner,
    fixedAttempt.id
  );
  assert.equal(fixedAttemptThree.retry.lineage_root_fetch_job_id, fixedRoot.id);
  assert.equal(fixedAttemptThree.effective_count, undefined);
  assert.equal(fixedAttemptThree.retry.source_criteria.effective_count, 600);

  const maxRoot = await failedSource({
    id: 'max_root',
    criteria: {
      count_mode: 'max_available',
      entered_count: 839,
      effective_count: 839,
    },
  });
  const maxAttempt = await verifiedRetryAttempt(maxRoot, {
    id: 'max_attempt_2',
    criteria: {
      count_mode: 'max_available',
      entered_count: 600,
      effective_count: 600,
    },
  });
  const maxAttemptThree = await loadAndValidatePrecisionRetry(
    retryChainBase44([maxRoot, maxAttempt]),
    owner,
    maxAttempt.id
  );
  assert.equal(maxAttemptThree.retry.lineage_root_fetch_job_id, maxRoot.id);
  assert.equal(maxAttemptThree.retry.source_criteria.entered_count, 600);
  assert.equal(maxAttemptThree.retry.source_criteria.effective_count, 600);

  const forged = await failedSource({
    id: 'forged',
    root_fetch_job_id: 'unrelated_root',
  });
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(
      retryChainBase44([forged]),
      owner,
      forged.id
    ),
    error => error.code === 'precision_retry_lineage_unverifiable'
  );

  const cycleA = await failedSource({
    id: 'cycle_a',
    source_fetch_job_id: 'cycle_b',
    root_fetch_job_id: 'cycle_a',
  });
  const cycleB = await failedSource({
    id: 'cycle_b',
    source_fetch_job_id: 'cycle_a',
    root_fetch_job_id: 'cycle_a',
  });
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(
      retryChainBase44([cycleA, cycleB]),
      owner,
      cycleA.id
    ),
    error => error.code === 'precision_retry_lineage_unverifiable'
  );
});

test('locked retry recomputes effective count and persists durable server-derived attempt provenance', async () => {
  const source = await failedSource({
    criteria: {
      count_mode: 'fixed',
      entered_count: 1000,
      effective_count: 1000,
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const subscription = {
    id: 'sub_paid',
    status: 'active',
    trial_end: null,
    current_period_start: now - 60,
    current_period_end: now + 86400,
    metadata: { base44_user_id: 'user_1' },
    items: { data: [{ price: { unit_amount: 9900 } }] },
    latest_invoice: {
      id: 'in_paid',
      subscription: 'sub_paid',
      status: 'paid',
      amount_paid: 9900,
      period_start: now - 60,
      period_end: now + 86400,
      lines: {
        data: [{
          subscription: 'sub_paid',
          period: { start: now - 60, end: now + 86400 },
        }],
      },
    },
  };
  const periodStart = new Date(subscription.current_period_start * 1000).toISOString();
  const priorUsage = {
    id: 'current_usage',
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    user_email: 'owner@example.com',
    precision_usage_kind: 'paid',
    precision_usage_period_start: periodStart,
    precision_usage_reserved: 0,
    precision_usage_count: 161,
    precision_usage_recorded_at: '2026-07-25T10:00:00.000Z',
  };
  const jobs = [source, priorUsage];
  const created = [];
  const matches = (job, filter) =>
    Object.entries(filter).every(([key, value]) => job[key] === value);
  const fetchJobs = {
    get: async id => jobs.find(job => job.id === id) || null,
    filter: async (filter, _sort, limit = 500, skip = 0) =>
      jobs.filter(job => matches(job, filter)).slice(skip, skip + limit),
    create: async payload => {
      const job = { id: 'retry_2', ...payload };
      jobs.push(job);
      created.push(job);
      return job;
    },
  };
  const base44 = {
    asServiceRole: {
      entities: {
        FetchJob: fetchJobs,
        SavedRoute: { filter: async () => [] },
      },
    },
  };
  class FakeStripe {
    constructor() {
      return {
        subscriptions: {
          retrieve: async () => subscription,
        },
      };
    }
  }
  const lockEvents = [];
  class FakeClient {
    async connect() { lockEvents.push('connect'); }
    async query(sql) {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        lockEvents.push('locked');
        return { rows: [{ claimed: true }] };
      }
      return { rows: [] };
    }
    async end() { lockEvents.push('end'); }
  }
  const user = {
    id: 'user_1',
    email: 'owner@example.com',
    team_manager_id: 'manager_1',
    subscription_id: subscription.id,
  };
  const corruptForwardDescendant = await verifiedRetryAttempt(source, {
    id: 'corrupt_forward_descendant',
    rootFetchJobId: 'wrong_root_hint',
  });
  jobs.push(corruptForwardDescendant);
  await assert.rejects(
    () => executePrecisionStart({
      base44,
      user,
      body: { retry_fetch_job_id: source.id },
      adapterName: 'fetchAreaProperties',
      allowRetry: true,
      allowDryRunSelfTest: false,
      StripeClass: FakeStripe,
      ClientClass: FakeClient,
      stripeSecret: 'sk_test',
      databaseUrl: 'postgres://test',
      betaAccessGrants: null,
      resolveFips: async () => ({ fips_code: '04013' }),
    }),
    error => (
      error.code === 'precision_retry_lineage_unverifiable'
      && error.details.invalid_lineage_job_id === corruptForwardDescendant.id
    )
  );
  jobs.splice(jobs.indexOf(corruptForwardDescendant), 1);
  lockEvents.length = 0;

  const result = await executePrecisionStart({
    base44,
    user,
    body: { retry_fetch_job_id: source.id },
    adapterName: 'fetchAreaProperties',
    allowRetry: true,
    allowDryRunSelfTest: false,
    StripeClass: FakeStripe,
    ClientClass: FakeClient,
    stripeSecret: 'sk_test',
    databaseUrl: 'postgres://test',
    betaAccessGrants: null,
    resolveFips: async () => ({ fips_code: '04013' }),
  });

  assert.equal(result.kind, 'started');
  assert.equal(result.requested_properties_before_cap, 1000);
  assert.equal(result.requested_properties, 839);
  assert.equal(result.criteria.entered_count, 1000);
  assert.equal(result.criteria.effective_count, 839);
  assert.equal(result.message, 'Starting a new attempt using the verified original criteria.');
  assert.equal(created.length, 1);
  assert.equal(created[0].source_fetch_job_id, source.id);
  assert.equal(created[0].root_fetch_job_id, source.id);
  assert.equal(created[0].attempt_number, 2);
  assert.equal(created[0].attempt_actor_user_id, user.id);
  assert.equal(created[0].attempt_subject_user_id, user.id);
  assert.equal(created[0].attempt_workspace_id, 'manager_1');
  assert.equal(created[0].source_criteria_schema_version, 1);
  assert.equal(created[0].source_polygon_hash, source.polygon_hash);
  assert.equal(source.dry_run_metadata.precision_criteria.effective_count, 1000);
  assert.equal(created[0].source_effective_count, 1000);
  assert.equal(created[0].precision_usage_reserved, 839);
  assert.equal(created[0].dry_run_metadata.precision_criteria.entered_count, 1000);
  assert.equal(created[0].dry_run_metadata.precision_criteria.effective_count, 839);
  assert.deepEqual(lockEvents, ['connect', 'locked', 'end']);

  const maxSource = await failedSource({
    id: 'failed_max',
    criteria: {
      count_mode: 'max_available',
      entered_count: 1000,
      effective_count: 1000,
    },
  });
  jobs.splice(0, jobs.length, maxSource, priorUsage);
  created.length = 0;
  lockEvents.length = 0;
  const maxResult = await executePrecisionStart({
    base44,
    user,
    body: { retry_fetch_job_id: maxSource.id },
    adapterName: 'fetchAreaProperties',
    allowRetry: true,
    allowDryRunSelfTest: false,
    StripeClass: FakeStripe,
    ClientClass: FakeClient,
    stripeSecret: 'sk_test',
    databaseUrl: 'postgres://test',
    betaAccessGrants: null,
    resolveFips: async () => ({ fips_code: '04013' }),
  });

  assert.equal(maxResult.criteria.count_mode, 'max_available');
  assert.equal(maxResult.requested_properties, 839);
  assert.equal(maxSource.dry_run_metadata.precision_criteria.effective_count, 1000);
  assert.equal(created[0].source_effective_count, 1000);
  assert.equal(created[0].precision_usage_reserved, 839);
  assert.equal(created[0].dry_run_metadata.precision_criteria.entered_count, 839);
  assert.equal(created[0].dry_run_metadata.precision_criteria.effective_count, 839);
  assert.deepEqual(lockEvents, ['connect', 'locked', 'end']);
});

test('retry request rejects browser identity or criteria fields before lookup or mutation', async () => {
  let reads = 0;
  const base44 = {
    asServiceRole: {
      entities: {
        FetchJob: {
          get: async () => { reads++; return null; },
        },
      },
    },
  };
  await assert.rejects(
    () => executePrecisionStart({
      base44,
      user: { id: 'user_1', email: 'owner@example.com' },
      body: {
        retry_fetch_job_id: 'failed_1',
        allowance_estimate: 839,
      },
      adapterName: 'fetchAreaProperties',
      allowRetry: true,
      allowDryRunSelfTest: false,
      StripeClass: class {},
      ClientClass: class {},
      stripeSecret: 'sk_test',
      databaseUrl: 'postgres://test',
      resolveFips: async () => ({ fips_code: '04013' }),
    }),
    error => error.code === 'precision_retry_contains_untrusted_criteria'
      && error.details.rejected_fields.includes('allowance_estimate')
  );
  assert.equal(reads, 0);
});

test('an explicit malformed retry id can never fall through to a fresh direct start', async () => {
  let reads = 0;
  let creates = 0;
  let fipsLookups = 0;
  let stripeReads = 0;
  const base44 = {
    asServiceRole: {
      entities: {
        FetchJob: {
          get: async () => { reads++; return null; },
          create: async () => { creates++; return { id: 'should_not_exist' }; },
        },
      },
    },
  };
  class FakeStripe {
    constructor() {
      stripeReads++;
      return {};
    }
  }
  for (const retry_fetch_job_id of [null, '', '   ', 0]) {
    await assert.rejects(
      () => executePrecisionStart({
        base44,
        user: { id: 'user_1', email: 'owner@example.com' },
        body: {
          retry_fetch_job_id,
          polygon,
          count_mode: 'fixed',
          requested_properties: 50,
        },
        adapterName: 'fetchAreaProperties',
        allowRetry: true,
        allowDryRunSelfTest: false,
        StripeClass: FakeStripe,
        ClientClass: class {},
        stripeSecret: 'sk_test',
        databaseUrl: 'postgres://test',
        resolveFips: async () => {
          fipsLookups++;
          return { fips_code: '04013' };
        },
      }),
      error => error.code === 'invalid_retry_fetch_job_id'
    );
  }
  assert.equal(reads, 0);
  assert.equal(creates, 0);
  assert.equal(fipsLookups, 0);
  assert.equal(stripeReads, 0);
});

test('unverifiable retry terminal evidence fails before entitlement or county lookup', async () => {
  const source = await failedSource({ completed_at: 'not-a-date' });
  let fipsLookups = 0;
  let stripeReads = 0;
  class FakeStripe {
    constructor() {
      stripeReads++;
      return {};
    }
  }
  await assert.rejects(
    () => executePrecisionStart({
      base44: retryBase44(source),
      user: {
        id: 'user_1',
        email: 'owner@example.com',
        team_manager_id: 'manager_1',
      },
      body: { retry_fetch_job_id: source.id },
      adapterName: 'fetchAreaProperties',
      allowRetry: true,
      allowDryRunSelfTest: false,
      StripeClass: FakeStripe,
      ClientClass: class {},
      stripeSecret: 'sk_test',
      databaseUrl: 'postgres://test',
      resolveFips: async () => {
        fipsLookups++;
        return { fips_code: '04013' };
      },
    }),
    error => error.code === 'precision_retry_terminal_evidence_unverifiable'
  );
  assert.equal(fipsLookups, 0);
  assert.equal(stripeReads, 0);
});

test('retry fails closed on legacy criteria, polygon mismatch, unsettled reservation and partial delivery', async () => {
  const user = {
    id: 'user_1',
    email: 'owner@example.com',
    team_manager_id: 'manager_1',
  };
  const legacy = await failedSource();
  delete legacy.dry_run_metadata.precision_criteria.force_full_refresh;
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(retryBase44(legacy), user, legacy.id),
    error => {
      assert.equal(error.code, 'legacy_precision_criteria_unverifiable');
      assert.deepEqual(error.details.invalid_fields, ['force_full_refresh']);
      assert.deepEqual(error.details.invalid_reasons, [
        { field: 'force_full_refresh', reason: 'missing' },
      ]);
      const payload = precisionErrorPayload(error);
      assert.equal(payload.status, 409);
      assert.deepEqual(payload.body.invalid_fields, ['force_full_refresh']);
      assert.deepEqual(payload.body.invalid_reasons, [
        { field: 'force_full_refresh', reason: 'missing' },
      ]);
      return true;
    }
  );

  for (const includeMls of [undefined, null, true]) {
    const unverifiableProviderScope = await failedSource();
    if (includeMls === undefined) delete unverifiableProviderScope.include_mls;
    else unverifiableProviderScope.include_mls = includeMls;
    await assert.rejects(
      () => loadAndValidatePrecisionRetry(
        retryBase44(unverifiableProviderScope),
        user,
        unverifiableProviderScope.id
      ),
      error => error.code === 'precision_include_mls_invariant_violation',
      `include_mls=${String(includeMls)}`
    );
  }

  const mismatchedPolygon = await failedSource({ polygon_hash: '0000000000000000' });
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(retryBase44(mismatchedPolygon), user, mismatchedPolygon.id),
    error => error.code === 'precision_retry_polygon_unverifiable'
  );

  const missingTopLevelHash = await failedSource();
  delete missingTopLevelHash.polygon_hash;
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(retryBase44(missingTopLevelHash), user, missingTopLevelHash.id),
    error => error.code === 'precision_retry_polygon_unverifiable'
  );

  const collinearPolygon = [
    { lat: 33.4, lng: -112.2 },
    { lat: 33.5, lng: -112.1 },
    { lat: 33.6, lng: -112.0 },
  ];
  const collinearHash = await precisionPolygonHash(collinearPolygon);
  const collinear = await failedSource({
    polygon: collinearPolygon,
    polygon_hash: collinearHash,
    criteria: { polygon_hash: collinearHash },
  });
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(retryBase44(collinear), user, collinear.id),
    error => error.code === 'precision_retry_polygon_unverifiable'
  );

  const unsettled = await failedSource({
    precision_usage_reserved: 50,
    precision_usage_recorded_at: null,
  });
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(retryBase44(unsettled), user, unsettled.id),
    error => error.code === 'precision_retry_reservation_unsettled'
  );

  for (const malformedReservation of [null, false, '0']) {
    const malformed = await failedSource({ precision_usage_reserved: malformedReservation });
    await assert.rejects(
      () => loadAndValidatePrecisionRetry(retryBase44(malformed), user, malformed.id),
      error => error.code === 'precision_retry_reservation_unsettled'
    );
  }
  const missingReservation = await failedSource();
  delete missingReservation.precision_usage_reserved;
  await assert.rejects(
    () => loadAndValidatePrecisionRetry(retryBase44(missingReservation), user, missingReservation.id),
    error => error.code === 'precision_retry_reservation_unsettled'
  );

  for (const malformedCount of [undefined, null, false, '0', 1]) {
    const malformed = await failedSource();
    if (malformedCount === undefined) delete malformed.precision_usage_count;
    else malformed.precision_usage_count = malformedCount;
    await assert.rejects(
      () => loadAndValidatePrecisionRetry(retryBase44(malformed), user, malformed.id),
      error => error.code === 'precision_retry_partial_delivery_unverifiable'
    );
  }

  for (const partialValue of [1, 'malformed']) {
    const partial = await failedSource({ total_inserted: partialValue });
    await assert.rejects(
      () => loadAndValidatePrecisionRetry(retryBase44(partial), user, partial.id),
      error => error.code === 'precision_retry_partial_delivery_unverifiable'
    );
  }
});

test('entitlement normalization requires immutable-ID evidence for beta grants', async () => {
  const now = Math.floor(Date.now() / 1000);
  const paid = {
    id: 'sub_paid',
    status: 'active',
    trial_end: null,
    current_period_start: now - 60,
    current_period_end: now + 86400,
    metadata: { base44_user_id: 'user_1' },
    items: { data: [{ price: { unit_amount: 9900 } }] },
    latest_invoice: {
      id: 'in_paid',
      subscription: 'sub_paid',
      status: 'paid',
      amount_paid: 9900,
      period_start: now - 60,
      period_end: now + 86400,
      lines: {
        data: [{
          subscription: 'sub_paid',
          period: { start: now - 60, end: now + 86400 },
        }],
      },
    },
  };
  const trial = {
    ...paid,
    id: 'sub_trial',
    status: 'trialing',
    metadata: { base44_user_id: 'user_1' },
    latest_invoice: null,
  };
  class FakeStripe {
    static subscription = null;
    constructor() {
      return {
        subscriptions: {
          retrieve: async () => FakeStripe.subscription,
        },
      };
    }
  }

  FakeStripe.subscription = paid;
  const paidResult = await resolvePrecisionEntitlement({
    user: { id: 'user_1', email: 'owner@example.com', subscription_id: paid.id },
    StripeClass: FakeStripe,
    stripeSecret: 'sk_test',
  });
  assert.equal(paidResult.kind, 'paid');
  assert.equal(paidResult.limit, PAID_PRECISION_PROPERTY_LIMIT);

  FakeStripe.subscription = trial;
  const trialResult = await resolvePrecisionEntitlement({
    user: { id: 'user_1', email: 'owner@example.com', subscription_id: trial.id },
    StripeClass: FakeStripe,
    stripeSecret: 'sk_test',
  });
  assert.equal(trialResult.kind, 'trial');
  assert.equal(trialResult.proAccess, true);
  assert.equal(trialResult.limit, FREE_PRECISION_PROPERTY_LIMIT);

  const freeResult = await resolvePrecisionEntitlement({
    user: { id: 'user_1', email: 'owner@example.com' },
    StripeClass: FakeStripe,
    stripeSecret: 'sk_test',
  });
  assert.equal(freeResult.kind, 'trial');
  assert.equal(freeResult.proAccess, false);

  const emailOnly = await resolvePrecisionEntitlement({
    user: { id: 'legacy_beta', email: 'baysecurity@gmail.com' },
    StripeClass: FakeStripe,
    stripeSecret: 'sk_test',
  });
  assert.notEqual(emailOnly.kind, 'beta');

  const betaAccessGrants = JSON.stringify({
    version: 1,
    grants: {
      legacy_beta: {
        status: 'active',
        grant_id: 'immutable_beta_grant',
        precision_limit: 1000,
        canvas_seats: 1,
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  });
  const beta = await resolvePrecisionEntitlement({
    user: { id: 'legacy_beta', email: 'baysecurity@gmail.com' },
    StripeClass: FakeStripe,
    stripeSecret: 'sk_test',
    betaAccessGrants,
  });
  assert.equal(beta.kind, 'beta');
  assert.equal(beta.subscriptionId, 'immutable_beta_grant');

  const nonBeta = await resolvePrecisionEntitlement({
    user: { id: 'other_user', email: 'baysecurity@gmail.com' },
    StripeClass: FakeStripe,
    stripeSecret: 'sk_test',
    betaAccessGrants,
  });
  assert.notEqual(nonBeta.kind, 'beta');
});

test('Max Available persists a numeric schema-v1 diagnostic but retry intent remains the mode', async () => {
  const criteria = await canonicalCriteria({
    count_mode: 'max_available',
    entered_count: 839,
    effective_count: 839,
  });
  assert.equal(validateStrictPrecisionCriteriaV1(criteria).ok, true);
  const normalized = buildRequestedPrecisionCriteria(criteria);
  assert.equal(normalized.entered_count, 839);
  assert.equal(normalized.count_mode, 'max_available');

  const source = await failedSource({
    criteria: {
      count_mode: 'max_available',
      entered_count: 839,
      effective_count: 839,
    },
  });
  const request = await loadAndValidatePrecisionRetry(
    retryBase44(source),
    {
      id: 'user_1',
      email: 'owner@example.com',
      team_manager_id: 'manager_1',
    },
    source.id
  );
  assert.equal(request.count_mode, 'max_available');
  assert.equal(request.entered_count, null);
});
