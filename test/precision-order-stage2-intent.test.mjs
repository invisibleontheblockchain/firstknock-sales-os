// MODEL 1 / PR A — Stage 2 characterization: exact user order and criteria.
//
// Separates the four planes the audit must keep visible:
//   raw user input -> browser-displayed state -> submitted request ->
//   server-normalized request -> canonical FetchJob
//
// See docs/precision/pr-a-model-1/audit/STAGE_2_AUDIT.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_USER,
  PATHS,
  START_PATHS,
  orderBody,
  paidSubscription,
  runStartPath,
  settledFetchJob,
  trialingSubscription
} from './helpers/precisionOrderHarness.mjs';
import {
  moneyInputToNumber,
  normalizeOwnershipRangeDays,
  submittedCount,
  submittedCountMode,
  submittedPrices,
  typedCountAfterPanelBlur,
  typedCountAfterPanelCap
} from './helpers/precisionBrowserExpressions.mjs';

const FREE_CAP = 50;

const paidUser = { ...AUDIT_USER, stripe_customer_id: 'cus_1' };
const paidWorld = { user: paidUser, subscriptions: [paidSubscription({})] };

/* ================================================================= C0 loss */

test('AR-S2-01 C0 BREAK: the browser destroys the typed Fixed Count before the request is built', () => {
  // Plane 1 — raw user input.
  const rawTypedCount = 839;
  // Plane 2 — browser-displayed state, capped at the displayed allowance.
  const displayed = typedCountAfterPanelCap({ typedValue: '839', maxProperties: 50 });
  assert.equal(displayed, 50, 'the number input clamps the typed value on every keystroke');

  // Plane 3 — submitted request, capped a SECOND time against a fresh allowance.
  const submitted = submittedCount({
    usingMaxAvailable: false,
    requestedPropertyCount: displayed,
    freshMaxProperties: 20
  });
  assert.equal(submitted, 20);

  // The originally typed 839 is now unrecoverable from anything sent to the
  // server. `requested_properties_before_cap` can only ever mean "before the
  // SERVER cap", never "before any cap".
  assert.notEqual(submitted, rawTypedCount);
  assert.notEqual(displayed, rawTypedCount);
});

test('AR-S2-02 the server faithfully preserves whatever entered count it is given', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 45 }),
      fetchJobs: [settledFetchJob({ id: 'job_prior', count: 30 })]
    });
    assert.equal(result.status, 200);
    assert.equal(result.createdJob.dry_run_metadata.requested_properties_before_cap, 45,
      `${name}: the submitted count is persisted verbatim as the entered count`);
    assert.equal(result.createdJob.precision_usage_reserved, 20,
      `${name}: the effective count is min(entered, remaining)`);
    assert.equal(result.createdJob.dry_run_metadata.limited_by_free_home_cap, true,
      `${name}: the server discloses that it capped the order`);
  }
});

/* ============================================================ count values */

const COUNT_CASES = [
  { id: 'below-allowance', submitted: 25, expectedEntered: 25, expectedEffective: 25 },
  { id: 'equal-allowance', submitted: 50, expectedEntered: 50, expectedEffective: 50 },
  { id: 'one', submitted: 1, expectedEntered: 1, expectedEffective: 1 },
  // UPDATED BY PR A (ADJ-M2-003, Model 1 F-PRA-016/F-PRA-017). An ABSENT count
  // still means "the plan maximum"; anything present but unusable is now
  // rejected instead of silently becoming max-available or a fractional
  // reservation PR #66 cannot route.
  // An empty string is "not provided" in form semantics, and was already
  // treated that way before PR A. Kept unchanged deliberately.
  { id: 'blank-string-falls-back-to-max', submitted: '', expectedEntered: FREE_CAP, expectedEffective: FREE_CAP },
  { id: 'null-falls-back-to-max', submitted: null, expectedEntered: FREE_CAP, expectedEffective: FREE_CAP },
  { id: 'omitted-falls-back-to-max', submitted: undefined, expectedEntered: FREE_CAP, expectedEffective: FREE_CAP },
  { id: 'zero-rejected', submitted: 0, rejected: true },
  { id: 'negative-rejected', submitted: -5, rejected: true },
  { id: 'decimal-rejected', submitted: 25.7, rejected: true },
  { id: 'non-numeric-rejected', submitted: 'twenty', rejected: true }
];

for (const countCase of COUNT_CASES) {
  test(`AR-S2-03 [${countCase.id}] count normalization is identical on both start paths`, async () => {
    const observations = {};
    for (const [name, path] of START_PATHS) {
      const body = orderBody();
      if (countCase.submitted === undefined) delete body.requested_properties;
      else body.requested_properties = countCase.submitted;

      const result = await runStartPath(path, { body });
      if (countCase.rejected) {
        assert.equal(result.status, 400, `${name} ${countCase.id}`);
        assert.equal(result.body.error, 'invalid_requested_properties');
        assert.equal(result.createdJob, null);
        observations[name] = 'rejected';
        continue;
      }
      assert.equal(result.status, 200, `${name} ${countCase.id}`);
      observations[name] = {
        entered: result.createdJob.dry_run_metadata.requested_properties_before_cap,
        effective: result.createdJob.precision_usage_reserved,
        total_expected: result.createdJob.total_expected
      };
    }
    assert.deepEqual(observations.startBatchDataPull, observations.fetchAreaProperties,
      `${countCase.id}: ${countCase.note || 'paths must agree'}`);
    if (countCase.rejected) return;
    assert.equal(observations.startBatchDataPull.entered, countCase.expectedEntered);
    assert.equal(observations.startBatchDataPull.effective, countCase.expectedEffective);
  });
}

test('AR-S2-04 a Fixed Count above the free plan maximum is rejected before any reservation', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ requested_properties: 200 }) });
    assert.equal(result.status, 403, name);
    assert.equal(result.body.error, 'paid_precision_required');
    assert.equal(result.createdJob, null);
  }
});

/* ------------------------------------------------------------- count_mode */

// UPDATED BY PR A (ADJ-M2-004, Model 1 F-PRA-018). count_mode was inert; it is
// now the instruction that decides the target.
test('AR-S2-05 count_mode is authoritative: max_available ignores the submitted number', async () => {
  for (const [name, path] of START_PATHS) {
    const fixed = await runStartPath(path, {
      ...paidWorld,
      body: orderBody({ requested_properties: 300, count_mode: 'fixed' })
    });
    const maxAvailable = await runStartPath(path, {
      ...paidWorld,
      body: orderBody({ requested_properties: 300, count_mode: 'max_available' })
    });

    assert.equal(fixed.createdJob.dry_run_metadata.count_mode, 'fixed');
    assert.equal(maxAvailable.createdJob.dry_run_metadata.count_mode, 'max_available');
    assert.equal(fixed.createdJob.precision_usage_reserved, 300,
      `${name}: fixed still honours the submitted count`);
    assert.equal(maxAvailable.createdJob.precision_usage_reserved, 1000,
      `${name}: max_available resolves to the locked allowance, not the submitted 300`);
  }
});

// UPDATED BY PR A (ADJ-M2-004). The browser still computes a number, but the
// server no longer treats it as the ceiling.
test('AR-S2-06 the browser still sends a snapshot, but the server recomputes Max Available under the lock', async () => {
  const browserSnapshotRemaining = 400;
  const submitted = submittedCount({
    usingMaxAvailable: true,
    requestedPropertyCount: 25,
    freshMaxProperties: browserSnapshotRemaining
  });
  assert.equal(submitted, browserSnapshotRemaining,
    'the browser-side expression is unchanged');

  const result = await runStartPath(PATHS.startBatchDataPull, {
    ...paidWorld,
    body: orderBody({ requested_properties: browserSnapshotRemaining, count_mode: 'max_available' })
  });
  assert.equal(result.status, 200);
  assert.equal(result.createdJob.precision_usage_reserved, 1000,
    'the stale browser number no longer caps the order');
  assert.equal(result.body.paid_properties_remaining, 0);
});

test('AR-S2-07 an allowance that SHRINKS between browser and lock is caught by the server', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 50, count_mode: 'max_available' }),
    fetchJobs: [settledFetchJob({ id: 'job_consumed', count: 35 })]
  });
  assert.equal(result.status, 200);
  assert.equal(result.createdJob.precision_usage_reserved, 15);
  assert.equal(result.createdJob.dry_run_metadata.count_mode, 'max_available',
    'count_mode survives independently of the number');
  // UPDATED BY PR A (ADJ-M2-004): for max_available the entered count IS the
  // locked allowance, so entered and effective agree by construction.
  assert.equal(result.createdJob.dry_run_metadata.requested_properties_before_cap, 15);
});

test('AR-S2-08 PARITY BREAK: only fetchAreaProperties accepts the record_cap alias', async () => {
  const body = orderBody();
  delete body.requested_properties;
  body.record_cap = 7;

  const viaStart = await runStartPath(PATHS.startBatchDataPull, { body });
  const viaFetchArea = await runStartPath(PATHS.fetchAreaProperties, { body });

  assert.equal(viaStart.createdJob.precision_usage_reserved, FREE_CAP,
    'startBatchDataPull ignores record_cap and falls back to max available');
  assert.equal(viaFetchArea.createdJob.precision_usage_reserved, 7,
    'fetchAreaProperties honours record_cap');
});

/* =============================================================== prices */

const PRICE_CASES = [
  { id: 'blank-minimum', min: null, max: null },
  { id: 'explicit-75k', min: 75000, max: null },
  { id: 'explicit-100k', min: 100000, max: null },
  { id: 'minimum-only', min: 250000, max: null },
  { id: 'maximum-only', min: null, max: 400000 },
  { id: 'both-bounds', min: 150000, max: 450000 },
  { id: 'equal-bounds', min: 300000, max: 300000 },
  { id: 'maximum-below-minimum', min: 500000, max: 100000 },
  { id: 'zero-minimum', min: 0, max: null },
  { id: 'negative-minimum', min: -1, max: null },
  { id: 'malformed-minimum', min: 'cheap', max: null }
];

for (const priceCase of PRICE_CASES) {
  test(`AR-S2-09 [${priceCase.id}] price normalization`, async () => {
    const observed = {};
    for (const [name, path] of START_PATHS) {
      const result = await runStartPath(path, {
        body: orderBody({ min_price: priceCase.min, max_price: priceCase.max })
      });
      assert.equal(result.status, 200, `${name} accepts ${priceCase.id} without validation`);
      observed[name] = result.createdJob.dry_run_metadata.filters;
    }

    // Every case is ACCEPTED by both paths: no range validation exists on main.
    const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);

    assert.equal(observed.startBatchDataPull.min_price, positive(priceCase.min),
      'startBatchDataPull: a non-positive or malformed minimum becomes null (NO price floor)');
    assert.equal(observed.fetchAreaProperties.min_price, positive(priceCase.min) ?? 100000,
      'fetchAreaProperties: the same input becomes the $100,000 default floor');
    assert.equal(observed.startBatchDataPull.max_price, positive(priceCase.max));
    assert.equal(observed.fetchAreaProperties.max_price, positive(priceCase.max));
  });
}

test('AR-S2-10 PARITY BREAK: the two start paths disagree on the default minimum value', async () => {
  const body = orderBody({ min_price: null });
  const viaStart = await runStartPath(PATHS.startBatchDataPull, { body });
  const viaFetchArea = await runStartPath(PATHS.fetchAreaProperties, { body });

  assert.equal(viaStart.createdJob.dry_run_metadata.filters.min_price, null,
    'startBatchDataPull: legacy no-floor semantics');
  assert.equal(viaFetchArea.createdJob.dry_run_metadata.filters.min_price, 100000,
    'fetchAreaProperties: silent $100,000 floor');
  assert.notEqual(
    viaStart.createdJob.dry_run_metadata.filters.min_price,
    viaFetchArea.createdJob.dry_run_metadata.filters.min_price
  );
});

test('AR-S2-11 max_price below min_price is accepted and persisted by both paths', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ min_price: 500000, max_price: 100000 }) });
    assert.equal(result.status, 200, `${name} does not validate the price range`);
    assert.equal(result.createdJob.dry_run_metadata.filters.min_price, 500000);
    assert.equal(result.createdJob.dry_run_metadata.filters.max_price, 100000);
  }
});

test('AR-S2-12 the browser money input strips every non-digit before submission', () => {
  assert.equal(moneyInputToNumber('$150,000'), 150000);
  assert.equal(moneyInputToNumber('150000.99'), 15000099, 'a decimal point is stripped, not parsed');
  assert.equal(moneyInputToNumber('abc'), '');
  assert.equal(moneyInputToNumber('-250000'), 250000, 'a minus sign is stripped, not honoured');
  assert.deepEqual(submittedPrices({ minHomeValue: '', maxHomeValue: '' }), { min_price: null, max_price: null });
  assert.deepEqual(submittedPrices({ minHomeValue: 0, maxHomeValue: 0 }), { min_price: null, max_price: null });
});

/* ============================================================ sold window */

const QUICK_RANGES = [
  { id: '1-day', soldMonths: 1 / 30, proOnly: true },
  { id: '2-day', soldMonths: 2 / 30, proOnly: true },
  { id: '1-week', soldMonths: 0.25, proOnly: true },
  { id: '2-week', soldMonths: 0.5, proOnly: true },
  { id: '1-month', soldMonths: 1, proOnly: true },
  { id: '3-month', soldMonths: 3, proOnly: false },
  { id: '6-month', soldMonths: 6, proOnly: false },
  { id: '12-month', soldMonths: 12, proOnly: false }
];

for (const range of QUICK_RANGES) {
  test(`AR-S2-13 [quick ${range.id}] pro gating and persistence`, async () => {
    for (const [name, path] of START_PATHS) {
      const free = await runStartPath(path, { body: orderBody({ sold_months: range.soldMonths }) });
      if (range.proOnly) {
        assert.equal(free.status, 403, `${name}: ${range.id} requires Pro`);
        assert.equal(free.body.error, 'upgrade_required');
      } else {
        assert.equal(free.status, 200, `${name}: ${range.id} is available on the free plan`);
        assert.equal(free.createdJob.sold_months, range.soldMonths);
        assert.equal(free.createdJob.dry_run_metadata.ownership_range_mode, 'quick');
        assert.equal(free.createdJob.dry_run_metadata.ownership_range_days, null);
      }

      const pro = await runStartPath(path, {
        user: paidUser,
        subscriptions: [trialingSubscription({})],
        body: orderBody({ sold_months: range.soldMonths })
      });
      assert.equal(pro.status, 200, `${name}: ${range.id} is available with Pro access`);
      assert.equal(pro.createdJob.sold_months, range.soldMonths);
    }
  });
}

const CUSTOM_RANGES = [
  { id: '1-2-days', min: 1, max: 2, valid: true, soldMonths: 2 / 30 },
  { id: '1-365-days', min: 1, max: 365, valid: true, soldMonths: 12 },
  { id: '30-180-days', min: 30, max: 180, valid: true, soldMonths: 6 },
  { id: '364-365-days', min: 364, max: 365, valid: true, soldMonths: 12 },
  { id: '59-365-days', min: 59, max: 365, valid: true, soldMonths: 12 },
  { id: 'equal-bounds', min: 90, max: 90, valid: false },
  { id: 'reversed-bounds', min: 200, max: 100, valid: false },
  { id: 'zero-minimum', min: 0, max: 90, valid: false },
  { id: 'above-365', min: 30, max: 400, valid: false },
  { id: 'non-integer', min: 1.5, max: 90, valid: false }
];

for (const range of CUSTOM_RANGES) {
  test(`AR-S2-14 [custom ${range.id}] validation and sold_months derivation`, async () => {
    for (const [name, path] of START_PATHS) {
      const result = await runStartPath(path, {
        user: paidUser,
        subscriptions: [trialingSubscription({})],
        body: orderBody({
          ownership_range_mode: 'custom',
          ownership_min_days: range.min,
          ownership_max_days: range.max
        })
      });

      if (!range.valid) {
        assert.equal(result.status, 400, `${name}: ${range.id} must be rejected`);
        assert.equal(result.body.error, 'invalid_ownership_range');
        continue;
      }

      assert.equal(result.status, 200, `${name}: ${range.id}`);
      assert.equal(result.createdJob.sold_months, range.soldMonths,
        `${name}: sold_months is derived from the MAXIMUM only`);
      assert.deepEqual(result.createdJob.dry_run_metadata.ownership_range_days, { min: range.min, max: range.max },
        `${name}: the minimum boundary survives ONLY inside dry_run_metadata`);
      assert.equal(result.createdJob.dry_run_metadata.ownership_range_mode, 'custom');
    }
  });
}

test('AR-S2-15 sold_months alone cannot distinguish two different custom windows', async () => {
  const observations = [];
  for (const [min, max] of [[1, 365], [364, 365], [59, 365]]) {
    const result = await runStartPath(PATHS.startBatchDataPull, {
      user: paidUser,
      subscriptions: [trialingSubscription({})],
      body: orderBody({ ownership_range_mode: 'custom', ownership_min_days: min, ownership_max_days: max })
    });
    observations.push({
      window: [min, max],
      sold_months: result.createdJob.sold_months,
      persisted: result.createdJob.dry_run_metadata.ownership_range_days
    });
  }
  const distinctSoldMonths = new Set(observations.map((entry) => entry.sold_months));
  assert.equal(distinctSoldMonths.size, 1,
    'three materially different windows collapse to the same sold_months value');
  assert.equal(distinctSoldMonths.has(12), true);
  const distinctPersisted = new Set(observations.map((entry) => JSON.stringify(entry.persisted)));
  assert.equal(distinctPersisted.size, 3,
    'they remain distinguishable ONLY through ownership_range_days');
});

test('AR-S2-16 a custom range without Pro access is rejected on both paths', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ ownership_range_mode: 'custom', ownership_min_days: 30, ownership_max_days: 180 })
    });
    assert.equal(result.status, 403, name);
    assert.equal(result.body.error, 'upgrade_required');
  }
});

test('AR-S2-17 the browser clamps a custom range before submission', () => {
  assert.deepEqual(normalizeOwnershipRangeDays([30, 180]), [30, 180]);
  assert.deepEqual(normalizeOwnershipRangeDays([0, 400]), [1, 365], 'out-of-range bounds are clamped, not rejected');
  assert.deepEqual(normalizeOwnershipRangeDays([200, 100]), [200, 201], 'reversed bounds are silently rewritten');
  assert.deepEqual(normalizeOwnershipRangeDays([90, 90]), [90, 91], 'equal bounds are silently widened');
  assert.deepEqual(normalizeOwnershipRangeDays([1.4, 90.6]), [1, 91], 'fractional days are rounded');
});

/* ========================================================== route bounds */

const ROUTE_BOUNDS_CASES = [
  {
    id: 'disabled',
    submitted: { enabled: false },
    expected: { enabled: false }
  },
  {
    id: 'omitted',
    submitted: undefined,
    expected: { enabled: false }
  },
  {
    id: 'home-round-trip',
    submitted: {
      enabled: true, mode: 'home_round_trip',
      startLocation: { lat: 33.9, lng: -83.4 }, endLocation: { lat: 33.9, lng: -83.4 }
    },
    expected: {
      enabled: true, mode: 'home_round_trip',
      start_location: { lat: 33.9, lng: -83.4 }, end_location: { lat: 33.9, lng: -83.4 }
    }
  },
  {
    id: 'current-to-home',
    submitted: {
      enabled: true, mode: 'current_to_home',
      startLocation: { lat: 33.95, lng: -83.35 }, endLocation: { lat: 33.9, lng: -83.4 }
    },
    expected: {
      enabled: true, mode: 'current_to_home',
      start_location: { lat: 33.95, lng: -83.35 }, end_location: { lat: 33.9, lng: -83.4 }
    }
  },
  {
    id: 'snake_case-aliases',
    submitted: {
      enabled: true, mode: 'current_to_home',
      start_location: { lat: 33.95, lng: -83.35 }, end_location: { lat: 33.9, lng: -83.4 }
    },
    expected: {
      enabled: true, mode: 'current_to_home',
      start_location: { lat: 33.95, lng: -83.35 }, end_location: { lat: 33.9, lng: -83.4 }
    }
  },
  {
    id: 'unknown-mode-falls-back-to-round-trip',
    submitted: {
      enabled: true, mode: 'teleport',
      startLocation: { lat: 33.9, lng: -83.4 }, endLocation: { lat: 33.9, lng: -83.4 }
    },
    expected: {
      enabled: true, mode: 'home_round_trip',
      start_location: { lat: 33.9, lng: -83.4 }, end_location: { lat: 33.9, lng: -83.4 }
    }
  },
  {
    id: 'enabled-string-not-boolean-disables',
    submitted: { enabled: 'true', startLocation: { lat: 33.9, lng: -83.4 }, endLocation: { lat: 33.9, lng: -83.4 } },
    expected: { enabled: false }
  },
  { id: 'missing-start', submitted: { enabled: true, endLocation: { lat: 33.9, lng: -83.4 } }, rejected: true },
  {
    id: 'out-of-range-start-latitude',
    submitted: { enabled: true, startLocation: { lat: 91, lng: -83.4 }, endLocation: { lat: 33.9, lng: -83.4 } },
    rejected: true
  },
  {
    id: 'blank-start-coordinate',
    submitted: { enabled: true, startLocation: { lat: '', lng: '' }, endLocation: { lat: 33.9, lng: -83.4 } },
    rejected: true
  }
];

for (const boundsCase of ROUTE_BOUNDS_CASES) {
  test(`AR-S2-18 [route bounds ${boundsCase.id}] normalization is identical on both paths`, async () => {
    const observed = {};
    for (const [name, path] of START_PATHS) {
      const body = orderBody();
      if (boundsCase.submitted === undefined) delete body.route_bounds;
      else body.route_bounds = boundsCase.submitted;

      const result = await runStartPath(path, { body });
      if (boundsCase.rejected) {
        assert.equal(result.status, 400, `${name}: ${boundsCase.id}`);
        assert.equal(result.body.error, 'invalid_route_bounds');
        observed[name] = 'rejected';
        continue;
      }
      assert.equal(result.status, 200, `${name}: ${boundsCase.id}`);
      observed[name] = result.createdJob.dry_run_metadata.route_bounds;
      assert.deepEqual(observed[name], boundsCase.expected, `${name}: ${boundsCase.id}`);
    }
    assert.deepEqual(observed.startBatchDataPull, observed.fetchAreaProperties);
  });
}

test('AR-S2-19 route bounds carry only coordinates — never the Home Base address', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({
      route_bounds: {
        enabled: true,
        mode: 'home_round_trip',
        startLocation: { lat: 33.9, lng: -83.4, address: '123 Private Street, Athens GA' },
        endLocation: { lat: 33.9, lng: -83.4, address: '123 Private Street, Athens GA' }
      }
    })
  });
  assert.equal(result.status, 200);
  assert.ok(!JSON.stringify(result.createdJob).includes('Private Street'),
    'the private address is stripped by normalizeRoutePoint');
});

/* ====================================================== repull semantics */

test('AR-S2-20 PARITY RESTORED: both start paths persist the same repull fields', async () => {
  const body = orderBody({
    repull_mode: 'max_since_last',
    previous_pull_date: '2026-05-01T00:00:00.000Z',
    include_unresolved_followups: true,
    force_full_refresh: true
  });

  const viaStart = await runStartPath(PATHS.startBatchDataPull, { body });
  const viaFetchArea = await runStartPath(PATHS.fetchAreaProperties, { body });

  const startMeta = viaStart.createdJob.dry_run_metadata;
  assert.equal(startMeta.repull_mode, 'max_since_last');
  assert.equal(startMeta.previous_pull_date, '2026-05-01T00:00:00.000Z');
  assert.equal(startMeta.include_unresolved_followups, true);
  assert.equal(startMeta.force_full_refresh, true);
  assert.equal(viaStart.createdJob.force_full_refresh, true);
  assert.equal(viaStart.createdJob.pull_mode, 'full_refresh');

  // UPDATED BY PR A (ADJ-M2-007). fetchAreaProperties previously discarded
  // every repull field; both paths now persist the identical criteria set.
  const areaMeta = viaFetchArea.createdJob.dry_run_metadata;
  assert.equal(areaMeta.repull_mode, 'max_since_last');
  assert.equal(areaMeta.previous_pull_date, '2026-05-01T00:00:00.000Z');
  assert.equal(areaMeta.include_unresolved_followups, true);
  assert.equal(areaMeta.force_full_refresh, true);
  assert.equal(viaFetchArea.createdJob.force_full_refresh, true);
  assert.equal(viaFetchArea.createdJob.pull_mode, 'full_refresh');
});

test('AR-S2-21 the Max Since Last browser flow forces max_available regardless of the count toggle', () => {
  assert.deepEqual(
    submittedCountMode({ isPreviousAreaPull: true, repullMode: 'max_since_last', propertyCountMode: 'fixed' }),
    { usingMaxAvailable: true, count_mode: 'max_available' }
  );
  assert.deepEqual(
    submittedCountMode({ isPreviousAreaPull: true, repullMode: 'fill_gaps', propertyCountMode: 'fixed' }),
    { usingMaxAvailable: false, count_mode: 'fixed' }
  );
  assert.deepEqual(
    submittedCountMode({ isPreviousAreaPull: false, repullMode: 'max_since_last', propertyCountMode: 'fixed' }),
    { usingMaxAvailable: false, count_mode: 'fixed' }
  );
});

/* ========================================================= route filters */

test('AR-S2-22 route filters are forced to the Single Family contract on both paths', async () => {
  const expected = {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
  };
  for (const [name, path] of START_PATHS) {
    for (const submitted of [
      undefined,
      { propertyTypes: ['Condo', 'Land'], excludeCommercial: false, excludeCondos: false, excludeLand: false },
      { propertyTypes: [] },
      'nonsense'
    ]) {
      const body = orderBody();
      if (submitted === undefined) delete body.route_filters;
      else body.route_filters = submitted;
      const result = await runStartPath(path, { body });
      assert.equal(result.status, 200);
      assert.deepEqual(result.createdJob.dry_run_metadata.route_filters, expected,
        `${name}: client-supplied filters cannot widen the contract`);
    }
  }
});

/* ================================================== panel blur behaviour */

test('AR-S2-23 the panel blur handler turns a cleared count input into 1, not into max available', () => {
  assert.equal(typedCountAfterPanelBlur({ requestedPropertyCount: '', maxProperties: 50 }), 1);
  assert.equal(typedCountAfterPanelBlur({ requestedPropertyCount: 0, maxProperties: 50 }), 1);
  assert.equal(typedCountAfterPanelBlur({ requestedPropertyCount: 999, maxProperties: 50 }), 50);
  assert.equal(typedCountAfterPanelBlur({ requestedPropertyCount: 25, maxProperties: 50 }), 25);
  assert.equal(typedCountAfterPanelBlur({ requestedPropertyCount: 25, maxProperties: 0 }), 1,
    'with a zero allowance the panel still displays 1 rather than 0');
});
