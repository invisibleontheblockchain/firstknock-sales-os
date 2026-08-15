import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const helperSource = fs.readFileSync('base44/functions/_shared/precisionActiveJobCriteria.js', 'utf8')
  .replace(/^export\s+/gm, '');
const candidateSource = fs.readFileSync('base44/functions/getRouteCandidatesFromNeon/entry.ts', 'utf8')
  .replace(/^import[\s\S]*?;\r?\n/gm, '');
const source = `${helperSource}\n${candidateSource}`;

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

function completedJob(overrides = {}) {
  const metadataOverrides = overrides.dry_run_metadata || {};
  const metadata = {
    workspace_id: 'manager_1',
    criteria_reference_at: '2026-07-25T12:00:00.000Z',
    requested_properties: 50,
    requested_properties_before_cap: 50,
    count_mode: 'fixed',
    filters: { min_price: 100000, max_price: null },
    route_filters: routeFilters,
    repull_mode: 'new_area',
    previous_pull_date: null,
    force_full_refresh: false,
    include_unresolved_followups: false,
    route_bounds: { enabled: false },
    ownership_range_mode: 'quick',
    ownership_range_days: null,
    ...metadataOverrides,
  };
  metadata.precision_criteria = {
    criteria_schema_version: 1,
    polygon_hash: '930e3a75b8a063c0',
    count_mode: metadata.count_mode,
    entered_count: metadata.requested_properties_before_cap,
    effective_count: metadata.requested_properties,
    min_price: metadata.filters?.min_price ?? null,
    max_price: metadata.filters?.max_price ?? null,
    sold_months: 12,
    ownership_range_mode: metadata.ownership_range_mode,
    ownership_range_days: metadata.ownership_range_days,
    route_filters: metadata.route_filters,
    repull_mode: metadata.repull_mode,
    previous_pull_date: metadata.previous_pull_date,
    force_full_refresh: metadata.force_full_refresh,
    include_unresolved_followups: metadata.include_unresolved_followups,
    route_bounds: metadata.route_bounds,
    immutable_user_id: 'manager_1',
    workspace_id: metadata.workspace_id,
    ...(metadataOverrides.precision_criteria || {}),
  };
  return {
    id: 'job_1',
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    include_mls: false,
    user_email: 'owner@example.com',
    precision_usage_user_id: 'manager_1',
    created_date: '2026-07-25T12:00:00.000Z',
    polygon,
    polygon_hash: '930e3a75b8a063c0',
    sold_months: 12,
    total_expected: 50,
    precision_usage_reserved: 0,
    precision_usage_count: 1,
    precision_usage_recorded_at: '2026-07-25T12:02:00.000Z',
    ...overrides,
    dry_run_metadata: metadata,
  };
}

function exactRequest(overrides = {}) {
  return {
    fetch_job_id: 'job_1',
    polygon,
    sold_months: 12,
    ownership_range_mode: 'quick',
    count_mode: 'fixed',
    requested_properties_before_cap: 50,
    requested_properties: 50,
    min_price: 100000,
    max_price: null,
    route_filters: routeFilters,
    repull_mode: 'new_area',
    previous_pull_date: null,
    force_full_refresh: false,
    include_unresolved_followups: false,
    route_bounds: { enabled: false },
    workspace_id: 'manager_1',
    ...overrides,
  };
}

function propertyRow(overrides = {}) {
  return {
    id: 1,
    address_hash: 'hash_1',
    legacy_hash: null,
    full_address: '100 Test Ave, Phoenix, AZ 85001',
    house_number: 100,
    street_name: 'Test Ave',
    city: 'Phoenix',
    state: 'AZ',
    zip_code: '85001',
    lat: 33.4484,
    lng: -112.074,
    owner_full_name: 'Owner One',
    year_built: 2001,
    price: 250000,
    sold_date: '2026-07-20T00:00:00.000Z',
    property_type: 'Single Family',
    data_source: 'batchdata',
    sale_confidence: 'verified',
    original_status: 'BATCHDATA_CONFIRMED',
    route_active: true,
    status: 'BATCHDATA_CONFIRMED',
    fetch_job_id: 'job_1',
    created_at: '2026-07-25T12:01:00.000Z',
    updated_at: '2026-07-25T12:01:00.000Z',
    ...overrides,
  };
}

function loadHandler({
  user = { id: 'manager_1', email: 'owner@example.com', role: 'user' },
  job = completedJob(),
  rows = [propertyRow()],
} = {}) {
  let handler;
  const sqlCalls = [];
  const sql = async (strings, ...values) => {
    const query = strings.join(' ');
    sqlCalls.push({ query, values });
    if (query.includes('FROM workspace_properties')) {
      return typeof rows === 'function' ? rows({ query, values }) : rows;
    }
    throw new Error(`Unexpected SQL in route-candidate test: ${query}`);
  };
  const base44 = {
    auth: { me: async () => user },
    asServiceRole: {
      entities: {
        FetchJob: {
          get: async (id) => id === job?.id ? job : null,
        },
      },
    },
  };
  vm.runInNewContext(source, {
    createClientFromRequest: () => base44,
    neon: () => sql,
    Deno: {
      env: { get: (key) => key === 'DATABASE_URL' ? 'postgres://test' : null },
      serve: (candidate) => { handler = candidate; },
    },
    Response,
    TextEncoder,
    crypto: globalThis.crypto,
    console,
  }, { filename: 'getRouteCandidatesFromNeon/entry.ts' });
  return { handler, sqlCalls };
}

async function invoke(handler, body) {
  const response = await handler({ json: async () => body });
  return { response, result: await response.json() };
}

test('ordinary owners cannot enable production job debug mode', async () => {
  const { handler, sqlCalls } = loadHandler();
  const { response, result } = await invoke(handler, exactRequest({ debug_job: true }));

  assert.equal(response.status, 403);
  assert.equal(result.error, 'precision_debug_mode_forbidden');
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates require the top-level immutable owner id', async () => {
  const job = completedJob();
  delete job.precision_usage_user_id;
  const { handler, sqlCalls } = loadHandler({ job });
  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 409);
  assert.equal(result.error, 'fetch_job_not_precision');
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates reject a running FetchJob before querying properties', async () => {
  const { handler, sqlCalls } = loadHandler({
    job: completedJob({ status: 'running' }),
  });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 409);
  assert.equal(result.error, 'fetch_job_not_completed');
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates require the supplied FetchJob to exist', async () => {
  const { handler, sqlCalls } = loadHandler({ job: null });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 404);
  assert.equal(result.error, 'fetch_job_not_found');
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates reject a FetchJob owned by another immutable user', async () => {
  const { handler, sqlCalls } = loadHandler({
    job: completedJob({
      precision_usage_user_id: 'other_user',
      user_email: 'owner@example.com',
    }),
  });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 403);
  assert.equal(result.error, 'precision_job_owner_mismatch');
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates reject missing or enabled MLS provenance before querying properties', async () => {
  for (const includeMls of [undefined, null, true]) {
    const job = completedJob();
    if (includeMls === undefined) delete job.include_mls;
    else job.include_mls = includeMls;
    const { handler, sqlCalls } = loadHandler({ job });

    const { response, result } = await invoke(handler, exactRequest());

    assert.equal(response.status, 409, String(includeMls));
    assert.equal(result.error, 'precision_include_mls_invariant_violation');
    assert.equal(sqlCalls.length, 0);
  }
});

test('an email hint cannot authorize an exact Precision FetchJob', async () => {
  const { handler, sqlCalls } = loadHandler();
  const { response, result } = await invoke(handler, exactRequest({
    user_email: 'different@example.com',
  }));

  assert.equal(response.status, 403);
  assert.equal(result.error, 'fetch_job_owner_mismatch');
  assert.equal(sqlCalls.length, 0);
});

test('a distinct undelegated admin cannot authorize another user exact Precision FetchJob', async () => {
  const { handler, sqlCalls } = loadHandler({
    user: {
      id: 'admin_1',
      email: 'admin@example.com',
      role: 'admin',
    },
  });
  const { response, result } = await invoke(handler, exactRequest({
    user_email: 'owner@example.com',
  }));

  assert.equal(response.status, 403);
  assert.equal(result.error, 'precision_job_owner_mismatch');
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates reject a FetchJob from another authenticated workspace', async () => {
  const { handler, sqlCalls } = loadHandler({
    user: {
      id: 'rep_1',
      email: 'owner@example.com',
      role: 'user',
      team_manager_id: 'manager_other',
    },
    job: completedJob({
      precision_usage_user_id: 'rep_1',
      dry_run_metadata: {
        precision_criteria: {
          immutable_user_id: 'rep_1',
        },
      },
    }),
  });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 403);
  assert.equal(result.error, 'precision_job_workspace_mismatch');
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates reject completed jobs with incomplete persisted identity scope', async () => {
  const job = completedJob({
    dry_run_metadata: {
      workspace_id: null,
      precision_criteria: {
        immutable_user_id: null,
        workspace_id: null,
      },
    },
  });
  const { handler, sqlCalls } = loadHandler({ job });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 409);
  assert.equal(result.error, 'legacy_precision_criteria_unverifiable');
  assert.deepEqual(result.invalid_fields.sort(), [
    'precision_criteria.immutable_user_id',
    'precision_criteria.workspace_id',
  ]);
  assert.deepEqual(result.invalid_reasons, [
    { field: 'precision_criteria.immutable_user_id', reason: 'null_not_allowed' },
    { field: 'precision_criteria.workspace_id', reason: 'null_not_allowed' },
  ]);
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates preserve direct strict-validator reasons in the 409 contract', async () => {
  const job = completedJob();
  const canonicalCriteria = job.dry_run_metadata.precision_criteria;
  let criteriaReads = 0;
  Object.defineProperty(job.dry_run_metadata, 'precision_criteria', {
    configurable: true,
    get: () => {
      criteriaReads += 1;
      return criteriaReads === 1
        ? canonicalCriteria
        : { ...canonicalCriteria, min_price: false };
    },
  });
  const { handler, sqlCalls } = loadHandler({ job });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 409);
  assert.equal(result.error, 'fetch_job_criteria_unverifiable');
  assert.deepEqual(result.invalid_fields, ['min_price']);
  assert.deepEqual(result.invalid_reasons, [
    { field: 'min_price', reason: 'wrong_type' },
  ]);
  assert.doesNotMatch(JSON.stringify(result.invalid_reasons), /false/);
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates require complete safe exact-settlement evidence', async () => {
  const cases = [
    ['precision_usage_reserved', undefined],
    ['precision_usage_reserved', null],
    ['precision_usage_reserved', '0'],
    ['precision_usage_reserved', 1],
    ['precision_usage_count', undefined],
    ['precision_usage_count', null],
    ['precision_usage_count', '1'],
    ['precision_usage_count', -1],
    ['precision_usage_recorded_at', undefined],
    ['precision_usage_recorded_at', null],
    ['precision_usage_recorded_at', 'not-a-date'],
  ];
  for (const [field, value] of cases) {
    const job = completedJob();
    if (value === undefined) delete job[field];
    else job[field] = value;
    const { handler, sqlCalls } = loadHandler({ job });

    const { response, result } = await invoke(handler, exactRequest());

    assert.equal(response.status, 409, `${field}:${String(value)}`);
    assert.equal(result.error, 'fetch_job_usage_unverifiable');
    assert.ok(result.invalid_fields.includes(field));
    assert.equal(sqlCalls.length, 0);
  }
});

test('exact-job candidates reject persisted criteria scoped to another immutable user', async () => {
  const job = completedJob({
    dry_run_metadata: {
      precision_criteria: {
        immutable_user_id: 'other_user',
      },
    },
  });
  const { handler, sqlCalls } = loadHandler({ job });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 403);
  assert.equal(result.error, 'precision_job_owner_mismatch');
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates fail closed when persisted polygon evidence is mismatched', async () => {
  const { handler, sqlCalls } = loadHandler({
    job: completedJob({
      polygon_hash: '0000000000000000',
    }),
  });
  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 409);
  assert.equal(result.error, 'precision_job_polygon_unverifiable');
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates reject a missing or nonpositive persisted minimum price', async () => {
  for (const minPrice of [null, 0, -1]) {
    const job = completedJob({
      dry_run_metadata: {
        precision_criteria: {
          min_price: minPrice,
        },
      },
    });
    const { handler, sqlCalls } = loadHandler({ job });

    const { response, result } = await invoke(handler, exactRequest());

    assert.equal(response.status, 409);
    assert.equal(result.error, 'legacy_precision_criteria_unverifiable');
    assert.ok(result.invalid_fields.includes('precision_criteria.min_price'));
    assert.deepEqual(result.invalid_reasons, [{
      field: 'precision_criteria.min_price',
      reason: minPrice === null ? 'null_not_allowed' : 'out_of_range',
    }]);
    assert.equal(sqlCalls.length, 0);
  }
});

test('exact-job candidates return 409 when route-generation criteria differ', async () => {
  const { handler, sqlCalls } = loadHandler();

  const { response, result } = await invoke(handler, exactRequest({
    sold_months: 3,
    min_price: 75000,
  }));

  assert.equal(response.status, 409);
  assert.equal(result.error, 'fetch_job_criteria_mismatch');
  assert.deepEqual(result.mismatch_fields.sort(), ['min_price', 'sold_months']);
  assert.equal(sqlCalls.length, 0);
});

test('exact-job candidates exclude rows outside the persisted sold-date window', async () => {
  const oldRow = propertyRow({
    id: 2,
    address_hash: 'hash_old',
    sold_date: '2025-01-01T00:00:00.000Z',
  });
  const { handler } = loadHandler({ rows: [propertyRow(), oldRow] });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(result.properties[0].address_hash, 'hash_1');
  assert.equal(result.excluded_outside_exact_job_window, 1);
  assert.equal(result.sold_at_or_after, '2025-07-25T00:00:00.000Z');
});

test('quick and max-since exact jobs exclude sold dates after their immutable reference day', async () => {
  const futureRow = propertyRow({
    sold_date: '2026-07-26T00:00:00.000Z',
  });
  const quick = loadHandler({
    job: completedJob({ precision_usage_count: 0 }),
    rows: [futureRow],
  });
  const quickResult = await invoke(quick.handler, exactRequest());
  assert.equal(quickResult.response.status, 200);
  assert.equal(quickResult.result.count, 0);
  assert.equal(quickResult.result.delivered_count, 0);

  const previousPullDate = '2026-07-24T12:00:00.000Z';
  const maxSinceJob = completedJob({
    precision_usage_count: 0,
    sold_months: 1 / 30,
    dry_run_metadata: {
      repull_mode: 'max_since_last',
      previous_pull_date: previousPullDate,
      precision_criteria: {
        sold_months: 1 / 30,
      },
    },
  });
  const maxSince = loadHandler({
    job: maxSinceJob,
    rows: [futureRow],
  });
  const maxSinceResult = await invoke(maxSince.handler, exactRequest({
    sold_months: 1 / 30,
    repull_mode: 'max_since_last',
    previous_pull_date: previousPullDate,
  }));
  assert.equal(maxSinceResult.response.status, 200);
  assert.equal(maxSinceResult.result.count, 0);
  assert.equal(maxSinceResult.result.delivered_count, 0);
});

test('valid exact-job candidates return only rows associated with that FetchJob', async () => {
  const otherJobRow = propertyRow({
    id: 2,
    address_hash: 'hash_other_job',
    fetch_job_id: 'job_other',
  });
  const { handler, sqlCalls } = loadHandler({
    rows: [propertyRow(), otherJobRow],
  });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 200);
  assert.equal(result.criteria_verified, true);
  assert.equal(result.fetch_job_id, 'job_1');
  assert.equal(result.delivered_count, 1);
  assert.equal(result.count, 1);
  assert.deepEqual(result.properties.map(property => property.address_hash), ['hash_1']);
  assert.match(sqlCalls[0].query, /wp\.fetch_job_id/);
  assert.match(sqlCalls[0].query, /p\.sold_date IS NOT NULL/);
  assert.ok(sqlCalls[0].values.includes('job_1'));
});

test('exact-job candidates remain keyed by immutable job id after the owner email changes', async () => {
  const { handler, sqlCalls } = loadHandler({
    user: {
      id: 'manager_1',
      email: 'new-owner@example.com',
      role: 'user',
    },
    job: completedJob({ user_email: 'old-owner@example.com' }),
  });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 200);
  assert.equal(result.fetch_job_id, 'job_1');
  assert.equal(result.count, 1);
  assert.equal(result.properties[0].address_hash, 'hash_1');
  assert.match(sqlCalls[0].query, /wp\.fetch_job_id/);
});

test('exact-job qualifying candidates can never exceed the delivered-count authority', async () => {
  const second = propertyRow({
    id: 2,
    address_hash: 'hash_2',
    full_address: '200 Test Ave, Phoenix, AZ 85001',
  });
  const { handler } = loadHandler({
    job: completedJob({ precision_usage_count: 1 }),
    rows: [propertyRow(), second],
  });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 409);
  assert.equal(result.error, 'fetch_job_delivery_count_mismatch');
  assert.equal(result.candidate_count, 2);
  assert.equal(result.delivered_count, 1);
});

test('exact-job candidate loss cannot silently undercut delivered-count authority', async () => {
  const { handler } = loadHandler({
    job: completedJob({ precision_usage_count: 2 }),
    rows: [propertyRow()],
  });

  const { response, result } = await invoke(handler, exactRequest());

  assert.equal(response.status, 409);
  assert.equal(result.error, 'fetch_job_delivery_count_mismatch');
  assert.equal(result.candidate_count, 1);
  assert.equal(result.delivered_count, 2);
});

test('a low response limit cannot hide candidates beyond delivered-count authority', async () => {
  const rows = [
    propertyRow(),
    propertyRow({
      id: 2,
      address_hash: 'hash_2',
      full_address: '200 Test Ave, Phoenix, AZ 85001',
    }),
    propertyRow({
      id: 3,
      address_hash: 'hash_3',
      full_address: '300 Test Ave, Phoenix, AZ 85001',
    }),
  ];
  const { handler, sqlCalls } = loadHandler({
    job: completedJob({ precision_usage_count: 2 }),
    rows,
  });

  const { response, result } = await invoke(
    handler,
    exactRequest({ limit: 1 })
  );

  assert.equal(response.status, 409);
  assert.equal(result.error, 'fetch_job_delivery_count_mismatch');
  assert.equal(result.candidate_count, 3);
  assert.equal(result.delivered_count, 2);
  assert.equal(sqlCalls[0].values.at(-1), 3);
});

test('disjoint caller filters cannot partition rows around delivered-count authority', async () => {
  const rows = [
    propertyRow({ zip_code: '85001' }),
    propertyRow({
      id: 2,
      address_hash: 'hash_2',
      full_address: '200 Test Ave, Phoenix, AZ 85002',
      zip_code: '85002',
    }),
    propertyRow({
      id: 3,
      address_hash: 'hash_3',
      full_address: '300 Test Ave, Phoenix, AZ 85003',
      zip_code: '85003',
    }),
  ];
  const { handler } = loadHandler({
    job: completedJob({ precision_usage_count: 2 }),
    rows,
  });

  for (const zipCode of ['85001', '85002']) {
    const { response, result } = await invoke(
      handler,
      exactRequest({ zip_codes: [zipCode], limit: 1 })
    );
    assert.equal(response.status, 409, zipCode);
    assert.equal(result.error, 'fetch_job_delivery_count_mismatch', zipCode);
    assert.equal(result.candidate_count, 3, zipCode);
  }
});

test('valid custom-range candidates preserve both persisted sold-date bounds', async () => {
  const customRange = { min: 59, max: 365 };
  const customJob = completedJob({
    dry_run_metadata: {
      ownership_range_mode: 'custom',
      ownership_range_days: customRange,
    },
  });
  const customBody = exactRequest({
    ownership_range_mode: 'custom',
    ownership_min_days: 59,
    ownership_max_days: 365,
  });
  const { handler } = loadHandler({
    job: customJob,
    rows: [propertyRow({ sold_date: '2026-04-01T00:00:00.000Z' })],
  });

  const { response, result } = await invoke(handler, customBody);

  assert.equal(response.status, 200);
  assert.equal(result.ownership_range_mode, 'custom');
  assert.deepEqual(result.ownership_range_days, customRange);
  assert.equal(result.sold_at_or_after, '2025-07-25T00:00:00.000Z');
  assert.equal(result.sold_before, '2026-05-28T00:00:00.000Z');
  assert.equal(result.count, 1);
});
