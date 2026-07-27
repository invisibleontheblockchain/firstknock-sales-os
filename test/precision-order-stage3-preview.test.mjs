// MODEL 1 / PR A — Stage 3 characterization: Preview and provider interaction.
//
// NO LIVE PROVIDER CALL IS MADE. Every outbound request is intercepted by the
// harness's recording stub. What this suite proves is *which* requests the
// production code issues, to which host, with which body — not what BatchData
// would answer or bill. See docs/precision/pr-a-model-1/audit/STAGE_3_AUDIT.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_USER,
  PATHS,
  SQUARE_MILE_POLYGON,
  Trace,
  callHandler,
  loadPrecisionHandler,
  makeBase44,
  makeStripe,
  plain
} from './helpers/precisionOrderHarness.mjs';

const USAGE_SNAPSHOT = {
  success: true,
  complete: true,
  version: 2,
  kind: 'trial',
  paid_access: false,
  pro_access: false,
  limit: 50,
  used: 10,
  reserved: 0,
  meter_used: 10,
  remaining: 40,
  lifetime_used: 10,
  trial_used: 10,
  trial_remaining: 40,
  period_start: null
};

function buildPreview({
  usage = USAGE_SNAPSHOT,
  env = {},
  fetchResponder = null,
  usageThrows = false
} = {}) {
  const trace = new Trace();
  let usageInvocations = 0;
  const base44 = makeBase44({
    trace,
    user: AUDIT_USER,
    invokeHandlers: {
      getPrecisionUsage: async () => {
        usageInvocations += 1;
        if (usageThrows) throw new Error('Precision usage is unavailable.');
        return { data: usage };
      }
    }
  });
  const { handler } = loadPrecisionHandler(PATHS.previewBatchDataArea, {
    trace, base44, stripeApi: makeStripe(trace, {}), env, fetchResponder
  });
  return { handler, trace, usageInvocations: () => usageInvocations };
}

/** The exact body the production UI sends (TerritoryPrompt.handleFetchData). */
function uiPreviewBody(overrides = {}) {
  return {
    polygon: SQUARE_MILE_POLYGON.map((p) => ({ ...p })),
    requested_properties: 40,
    sandbox: true,
    sandbox_probe: true,
    ...overrides
  };
}

/* ------------------------------------------ AR-S3-01 what Preview receives */

test('AR-S3-01 the UI sends Preview NO criteria beyond polygon and count', async () => {
  const body = uiPreviewBody();
  assert.deepEqual(Object.keys(body).sort(),
    ['polygon', 'requested_properties', 'sandbox', 'sandbox_probe'],
    'no price, sold window, ownership range, route filter or route bound reaches Preview');

  const { handler } = buildPreview();
  const result = await callHandler(handler, body);
  assert.equal(result.status, 200);
  // Consequently Preview cannot be an estimate OF THE ORDER — only of the area.
  assert.equal(result.body.min_price, undefined);
  assert.equal(result.body.sold_months, undefined);
  assert.equal(result.body.route_bounds, undefined);
});

/* --------------------------------------- AR-S3-02 provider interaction */

test('AR-S3-02 Preview issues a real BatchData request on every call when the sandbox key is set', async () => {
  const { handler, trace } = buildPreview({
    env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' },
    fetchResponder: async (url) => new Response(
      JSON.stringify(url.includes('geo.fcc.gov')
        ? { County: { FIPS: '13221', name: 'Oconee' }, State: { code: 'GA', name: 'Georgia' } }
        : { results: { properties: [{}, {}] } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  });

  const result = await callHandler(handler, uiPreviewBody());
  assert.equal(result.status, 200);

  const providerCalls = trace.externalFetches.filter((event) => event.detail.host === 'api.batchdata.com');
  assert.equal(providerCalls.length, 1, 'exactly one provider request per Preview');

  const call = providerCalls[0];
  assert.equal(call.detail.method, 'POST');
  assert.equal(call.detail.url, 'https://api.batchdata.com/api/v1/property/search');

  const sentBody = JSON.parse(call.detail.body);
  assert.deepEqual(sentBody, {
    searchCriteria: { query: '33.86725,-83.39125' },
    options: { datasets: ['basic'], limit: 5 }
  });

  // The probe uses the CENTROID as a text query. The drawn polygon is never
  // sent, so the probe cannot validate the geometry the pull will actually use.
  assert.equal(sentBody.searchCriteria.polygon, undefined);
  assert.equal(sentBody.searchCriteria.boundary, undefined);
  assert.equal(result.body.sandbox_probe.record_count, 2);
});

test('AR-S3-03 identical repeated Previews produce identical repeated provider requests — no cache, no dedupe', async () => {
  const { handler, trace } = buildPreview({
    env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' },
    fetchResponder: async (url) => new Response(
      JSON.stringify(url.includes('geo.fcc.gov')
        ? { County: { FIPS: '13221' }, State: { code: 'GA' } }
        : { results: { properties: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  });

  for (let i = 0; i < 3; i += 1) {
    const result = await callHandler(handler, uiPreviewBody());
    assert.equal(result.status, 200);
  }

  const providerCalls = trace.externalFetches.filter((event) => event.detail.host === 'api.batchdata.com');
  assert.equal(providerCalls.length, 3, 'three identical Previews issue three provider requests');
  const fingerprints = new Set(providerCalls.map((event) => event.detail.body));
  assert.equal(fingerprints.size, 1, 'all three request bodies are byte-identical');

  const countyCalls = trace.externalFetches.filter((event) => event.detail.host === 'geo.fcc.gov');
  assert.equal(countyCalls.length, 3, 'the county resolver is likewise re-queried every time');
});

test('AR-S3-04 without BATCH_DATA_SANDBOX_KEY no provider request is issued at all', async () => {
  const { handler, trace } = buildPreview({ env: { BATCH_DATA_SANDBOX_KEY: undefined } });
  const result = await callHandler(handler, uiPreviewBody());
  assert.equal(result.status, 200);
  assert.equal(result.body.sandbox_probe, null);
  assert.equal(trace.externalFetches.filter((event) => event.detail.host === 'api.batchdata.com').length, 0);
});

// UPDATED BY PR A (ADJ-M2-008, Model 1 F-PRA-031). A provider transport
// failure used to fail the whole Preview with a 500; it now degrades.
test('AR-S3-05 a provider transport failure degrades the probe and preserves the Preview', async () => {
  const { handler } = buildPreview({
    env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' },
    fetchResponder: async (url) => {
      if (url.includes('geo.fcc.gov')) {
        return new Response(JSON.stringify({ County: { FIPS: '13221' }, State: { code: 'GA' } }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error('ECONNRESET');
    }
  });

  const result = await callHandler(handler, uiPreviewBody());
  assert.equal(result.status, 200,
    'the county resolution, area and allowance estimate are still valid');
  assert.equal(result.body.sandbox_probe, null);
  assert.equal(result.body.sandbox_probe_error, 'provider_unreachable');
});

test('AR-S3-06 a non-2xx provider response is surfaced as ok:false rather than raising', async () => {
  const { handler, trace } = buildPreview({
    env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' },
    fetchResponder: async (url) => (url.includes('geo.fcc.gov')
      ? new Response(JSON.stringify({ County: { FIPS: '13221' }, State: { code: 'GA' } }), { status: 200 })
      : new Response('rate limited', { status: 429 }))
  });

  const result = await callHandler(handler, uiPreviewBody());
  assert.equal(result.status, 200);
  assert.deepEqual(plain(result.body.sandbox_probe), { ok: false, status: 429, record_count: 0 });
  assert.equal(trace.externalFetches.filter((event) => event.detail.host === 'api.batchdata.com').length, 1,
    'no retry is attempted');
});

/* ------------------------------------- AR-S3-07 Preview creates no state */

test('AR-S3-07 Preview creates no FetchJob and no reservation, and takes no usage lock', async () => {
  const { handler, trace } = buildPreview({ env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' } });
  const result = await callHandler(handler, uiPreviewBody());
  assert.equal(result.status, 200);
  assert.deepEqual(trace.writes, [], 'Preview writes no entity directly');
  assert.deepEqual(trace.locks, [], 'Preview acquires no advisory usage lock');
});

/* ------------------- AR-S3-08 Preview delegates allowance and inherits writes */

test('AR-S3-08 Preview delegates allowance to getPrecisionUsage, which is itself a MUTATING function', async () => {
  const { handler, trace, usageInvocations } = buildPreview();
  const result = await callHandler(handler, uiPreviewBody());
  assert.equal(result.status, 200);
  assert.equal(usageInvocations(), 1, 'the allowance authority is invoked once per Preview');
  assert.deepEqual(trace.invocations.map((event) => event.name), ['getPrecisionUsage']);

  // getPrecisionUsage is not read-only: its reconcileLegacyJobs step updates
  // FetchJob rows and always writes User.precision_usage_reconciled_at. Preview
  // therefore inherits a production write on every invocation.
  const usageSource = (await import('node:fs')).readFileSync(
    (await import('node:path')).resolve(process.cwd(), PATHS.getPrecisionUsage), 'utf8');
  assert.match(usageSource, /entities\.User\.update\(user\.id, \{[\s\S]*precision_usage_reconciled_at/,
    'getPrecisionUsage unconditionally updates the User record');
  assert.match(usageSource, /entities\.FetchJob\.update\(/,
    'getPrecisionUsage can also rewrite FetchJob usage fields');
});

test('AR-S3-09 an unavailable allowance fails Preview closed with no provider request', async () => {
  const { handler, trace } = buildPreview({
    usageThrows: true,
    env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' }
  });
  const result = await callHandler(handler, uiPreviewBody());
  assert.equal(result.status, 500);
  assert.equal(trace.externalFetches.filter((event) => event.detail.host === 'api.batchdata.com').length, 0);
});

test('AR-S3-10 an incomplete or stale-version allowance snapshot is rejected', async () => {
  for (const badUsage of [
    { ...USAGE_SNAPSHOT, complete: false },
    { ...USAGE_SNAPSHOT, version: 1 },
    { ...USAGE_SNAPSHOT, success: false },
    { ...USAGE_SNAPSHOT, remaining: -1 }
  ]) {
    const { handler } = buildPreview({ usage: badUsage });
    const result = await callHandler(handler, uiPreviewBody());
    assert.equal(result.status, 500, `usage ${JSON.stringify(Object.keys(badUsage))} must fail closed`);
  }
});

/* ------------------------------------ AR-S3-11 Preview count semantics */

const PREVIEW_COUNT_CASES = [
  { id: 'below-remaining', requested: 25, remaining: 40, expected: 25 },
  { id: 'above-remaining', requested: 100, remaining: 40, expected: 40 },
  { id: 'zero-falls-back-to-remaining', requested: 0, remaining: 40, expected: 40 },
  { id: 'non-numeric-falls-back-to-remaining', requested: 'many', remaining: 40, expected: 40 },
  { id: 'no-allowance', requested: 25, remaining: 0, expected: 0 },
  { id: 'record_cap-alias', requested: undefined, recordCap: 12, remaining: 40, expected: 12 }
];

for (const countCase of PREVIEW_COUNT_CASES) {
  test(`AR-S3-11 [${countCase.id}] Preview count normalization`, async () => {
    const usage = {
      ...USAGE_SNAPSHOT,
      remaining: countCase.remaining,
      used: 50 - countCase.remaining,
      meter_used: 50 - countCase.remaining
    };
    const { handler } = buildPreview({ usage });
    const body = uiPreviewBody();
    delete body.requested_properties;
    if (countCase.requested !== undefined) body.requested_properties = countCase.requested;
    if (countCase.recordCap !== undefined) body.record_cap = countCase.recordCap;

    const result = await callHandler(handler, body);
    assert.equal(result.status, 200);
    assert.equal(result.body.requested_properties, countCase.expected);
    assert.equal(result.body.returned_property_count, countCase.expected,
      'returned_property_count is the requested count, NOT a provider-derived availability');
  });
}

test('AR-S3-12 Preview reports availability it never measured', async () => {
  const { handler } = buildPreview({
    env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' },
    fetchResponder: async (url) => new Response(
      JSON.stringify(url.includes('geo.fcc.gov')
        ? { County: { FIPS: '13221' }, State: { code: 'GA' } }
        : { results: { properties: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  });

  const result = await callHandler(handler, uiPreviewBody({ requested_properties: 40 }));
  assert.equal(result.status, 200);
  // The provider returned zero records for the probe, yet Preview still tells
  // the user 40 homes "can be requested" — the number is an allowance echo.
  assert.equal(result.body.sandbox_probe.record_count, 0);
  assert.equal(result.body.returned_property_count, 40);
  assert.match(result.body.message, /eligible to pull up to 40 BatchData properties/);
  // ADDED BY PR A (ADJ-M2-008): the response now states plainly that nothing
  // measured availability, so a consumer cannot read this as a market count.
  assert.equal(result.body.availability_measured, false);
  assert.equal(result.body.sandbox_probe_meaning, 'provider_reachability_at_centroid');
});

test('AR-S3-13 every area limit and span rejection is disabled — Preview never hard-rejects', async () => {
  const hugePolygon = [
    { lat: 25, lng: -125 },
    { lat: 49, lng: -125 },
    { lat: 49, lng: -66 },
    { lat: 25, lng: -66 }
  ];
  const { handler } = buildPreview();
  const result = await callHandler(handler, uiPreviewBody({ polygon: hugePolygon }));
  assert.equal(result.status, 200);
  assert.equal(result.body.hard_rejected, false);
  assert.equal(result.body.rejection_reason, null);
  assert.equal(result.body.max_area_sq_mi, null);
  assert.equal(result.body.bounds_miles.max_allowed_span, null);
  assert.ok(result.body.area_sq_mi > 1_000_000, 'a continental polygon is accepted');
});
