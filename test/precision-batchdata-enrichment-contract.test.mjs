// BatchData enrichment contract — Stage 6–9.
//
// PROVEN DEFECT
// -------------
// `buildBatchDataRequest` scoped the provider response with
//
//     options.datasets = ['basic', 'deed', 'owner']
//
// while the SAME request filters on `searchCriteria.intel.lastSoldDate`, and the
// mapper treats `intel` as the authoritative source for recorded sale date,
// estimated value, year built and square footage.
//
// `intel` is not a member of `basic | listing | deed | owner`. A request can
// therefore never receive, through a scoped dataset list, the object it filters
// on and maps from. That contradiction is visible in the source itself and does
// not depend on any provider capture to establish.
//
// The observable production consequence is an owner/address shell: address,
// coordinates and owner present; value, beds, baths, sqft, lot size, year built
// and sold date all null. The local gates do not reject such a row — they were
// deliberately loosened — so the shell is persisted and reaches a route.
//
// FIXTURES ARE SYNTHETIC
// ----------------------
// The two records below are hand-built to exercise the mapper's field
// selection. They are NOT captured provider payloads and must never be cited as
// evidence of what BatchData returns. They prove how the mapper behaves for a
// response shaped that way, which is the part this repository controls.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const PROCESSOR = 'base44/functions/processFetchChunk/entry.ts';

/** The enrichment fields that depend on `intel` / `building` / `sale` / `valuation`. */
const ENRICHMENT_FIELDS = ['price', 'beds', 'baths', 'sqft', 'lot_size', 'year_built', 'sold_date'];

/**
 * Executes the REAL processor module and captures the functions under test.
 *
 * Nothing about request building or record mapping is stubbed. Only the
 * module-level imports are stripped, none of which participate in either.
 */
function loadProcessor(required = ['buildBatchDataRequest', 'mapBatchDataProperty']) {
  const source = readFileSync(resolve(process.cwd(), PROCESSOR), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: PROCESSOR,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
  assert.deepEqual(errors, [], `${PROCESSOR} has TypeScript errors`);

  for (const fn of required) {
    assert.ok(
      new RegExp(`function ${fn}\\(`).test(source),
      `processFetchChunk no longer exposes ${fn} — this guard must be re-derived`
    );
  }

  const collectExpr = required.map((fn) => `${fn}`).join(', ');
  const executable = `${transpiled.outputText.replace(/^import .*;\s*$/gm, '')}
;__collect({ ${collectExpr} });`;

  let collected = null;
  vm.runInNewContext(executable, {
    __collect: (value) => { collected = value; },
    Deno: { env: { get: () => undefined }, serve: () => {} },
    createClientFromRequest: () => ({}),
    neon: () => (() => {}),
    Request, Response, TextEncoder, TextDecoder, URL,
    crypto: globalThis.crypto,
    fetch: async () => { throw new Error('no provider call is permitted in this test'); },
    setTimeout, clearTimeout, AbortController,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    JSON, Number, String, Boolean, Array, Object, Set, Map, Math, Date, Error,
    Promise, Uint8Array, isNaN, isFinite, parseInt, parseFloat
  }, { filename: PROCESSOR });

  for (const fn of required) {
    assert.equal(typeof collected?.[fn], 'function', `${fn} was not captured from the module`);
  }
  return collected;
}

/** Re-hydrates cross-realm objects so deepEqual compares structure, not prototypes. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const POLYGON = [
  { lat: 34.83, lng: -82.37 },
  { lat: 34.83, lng: -82.35 },
  { lat: 34.81, lng: -82.35 },
  { lat: 34.81, lng: -82.37 }
];

function job(overrides = {}) {
  return {
    polygon: POLYGON,
    latitude: 34.82,
    longitude: -82.36,
    sold_months: 12,
    dry_run_metadata: { filters: { min_price: 150000, max_price: 900000 } },
    ...overrides
  };
}

/**
 * SYNTHETIC. An owner/address shell: exactly the objects a dataset-scoped
 * response is expected to carry, and none of the enrichment objects.
 */
function shellRecord(n = 1) {
  return {
    _id: `synthetic-shell-${n}`,
    address: {
      street: `${100 + n} Synthetic Shell Way`,
      city: 'Greenville',
      state: 'SC',
      zip: '29607',
      location: { latitude: 34.82, longitude: -82.36 }
    },
    owner: { fullName: `SYNTHETIC OWNER ${n}` }
    // deliberately absent: intel, sale, building, valuation, lot, general
  };
}

/** SYNTHETIC. The same address with every enrichment object present. */
function enrichedRecord(n = 1) {
  return {
    ...shellRecord(n),
    general: { propertyTypeDetail: 'Single Family Residential', standardizedLandUseCode: 'R2' },
    intel: { lastSoldDate: '2025-04-15T00:00:00Z', yearBuilt: 1978, livingAreaSquareFeet: 2140 },
    sale: { salePrice: 415000 },
    valuation: { estimatedValue: 468000 },
    building: { bedroomCount: 4, bathroomCount: 3 },
    lot: { lotSizeSquareFeet: 13500 }
  };
}

/* ══════════════ 1. The outbound request contract ══════════════ */

test('ENRICH-01 the REAL request builder sends no options.datasets in any mode', () => {
  const { buildBatchDataRequest } = loadProcessor(['buildBatchDataRequest']);

  for (const mode of ['strict_polygon', 'centroid_fallback']) {
    const request = plain(buildBatchDataRequest(job(), 0, 100, mode));

    assert.equal(
      Object.prototype.hasOwnProperty.call(request.options, 'datasets'),
      false,
      `mode ${mode}: options.datasets must never be sent — it suppresses the intel object ` +
      'that this same request filters on (searchCriteria.intel.lastSoldDate)'
    );
  }
});

test('ENRICH-02 no datasets array survives anywhere in the serialized request', () => {
  const { buildBatchDataRequest } = loadProcessor(['buildBatchDataRequest']);

  for (const mode of ['strict_polygon', 'centroid_fallback']) {
    const serialized = JSON.stringify(plain(buildBatchDataRequest(job(), 0, 100, mode)));
    assert.equal(
      serialized.includes('datasets'), false,
      `mode ${mode}: the substring "datasets" must not appear in the request body`
    );
  }
});

/* ══════════ 2. Everything else about the request is preserved ══════════ */

test('ENRICH-03 pagination is preserved and take stays capped at 100', () => {
  const { buildBatchDataRequest } = loadProcessor(['buildBatchDataRequest']);

  assert.deepEqual(plain(buildBatchDataRequest(job(), 0, 100).options), { skip: 0, take: 100 });
  assert.deepEqual(plain(buildBatchDataRequest(job(), 250, 50).options), { skip: 250, take: 50 });

  // The provider rejects pages larger than 100.
  assert.equal(plain(buildBatchDataRequest(job(), 0, 500).options).take, 100);
  assert.equal(plain(buildBatchDataRequest(job(), 0, 0).options).take, 100);
  assert.equal(plain(buildBatchDataRequest(job(), 0, -5).options).take, 1);
});

test('ENRICH-04 polygon, sold-window, value bounds and the R2 filter are preserved', () => {
  const { buildBatchDataRequest } = loadProcessor(['buildBatchDataRequest']);
  const request = plain(buildBatchDataRequest(job(), 0, 100, 'strict_polygon'));
  const criteria = request.searchCriteria;

  // Polygon: closed ring, original vertices intact.
  const points = criteria.address.geoLocationPolygon.geoPoints;
  assert.ok(points.length >= POLYGON.length, 'polygon vertices must survive');
  assert.deepEqual(points[0], points[points.length - 1], 'polygon must be closed');

  // The sold window is still expressed on intel.lastSoldDate.
  assert.match(criteria.intel.lastSoldDate.minDate, /^\d{4}-\d{2}-\d{2}$/);

  // Single-family land-use gate.
  assert.deepEqual(criteria.general, { standardizedLandUseCode: { equals: 'R2' } });

  // User home-value range.
  assert.deepEqual(criteria.valuation, { estimatedValue: { min: 150000, max: 900000 } });
});

test('ENRICH-05 the custom ownership window still sends both date bounds', () => {
  const { buildBatchDataRequest } = loadProcessor(['buildBatchDataRequest']);
  const custom = job({
    dry_run_metadata: {
      filters: { min_price: 150000, max_price: 900000 },
      ownership_range_mode: 'custom',
      ownership_range_days: { min: 30, max: 180 }
    }
  });
  const criteria = plain(buildBatchDataRequest(custom, 0, 100, 'strict_polygon')).searchCriteria;

  assert.match(criteria.intel.lastSoldDate.minDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(criteria.intel.lastSoldDate.maxDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(
    criteria.intel.lastSoldDate.minDate < criteria.intel.lastSoldDate.maxDate,
    'oldest bound must precede newest bound'
  );
});

/* ══════════ 3. How a shell record maps — the observed failure ══════════ */

test('ENRICH-06 a record without intel/sale/building/valuation maps every enrichment field to null', () => {
  const { mapBatchDataProperty } = loadProcessor(['mapBatchDataProperty']);
  const mapped = plain(mapBatchDataProperty(shellRecord(1), job()));

  assert.ok(mapped, 'the shell record must still map — the local gates do not reject it');

  // Present, which is why the export looked superficially healthy.
  assert.equal(mapped.full_address, '101 Synthetic Shell Way, Greenville, SC, 29607');
  assert.equal(mapped.owner_full_name, 'SYNTHETIC OWNER 1');
  assert.equal(mapped.lat, 34.82);
  assert.equal(mapped.lng, -82.36);

  // Absent — every one of these depends on an object a scoped request omits.
  for (const field of ENRICHMENT_FIELDS) {
    assert.equal(mapped[field], null, `${field} must be null for an unenriched record`);
  }
});

test('ENRICH-07 the shell record is NOT rejected, so it reaches a route', () => {
  const { mapBatchDataProperty } = loadProcessor(['mapBatchDataProperty']);
  const mapped = plain(mapBatchDataProperty(shellRecord(2), job()));

  // This is the reason the defect was invisible until the CSV was inspected.
  assert.notEqual(mapped.route_active, false, 'an unenriched record is still route-active');
});

test('ENRICH-08 "Single Family" and "BatchData" are defaults, not evidence of enrichment', () => {
  const { mapBatchDataProperty } = loadProcessor(['mapBatchDataProperty']);
  const mapped = plain(mapBatchDataProperty(shellRecord(3), job()));

  // A record carrying NO property-type information still reports Single Family.
  assert.equal(mapped.property_type, 'Single Family');
  // A record carrying NO sale record still reports sale_type BatchData.
  assert.equal(mapped.sale_type, 'BatchData');
  assert.equal(mapped.sold_date, null, 'the label above coexists with a null sale date');
});

test('ENRICH-09 the same address WITH enrichment objects maps every field', () => {
  const { mapBatchDataProperty } = loadProcessor(['mapBatchDataProperty']);
  const mapped = plain(mapBatchDataProperty(enrichedRecord(1), job()));

  assert.equal(mapped.beds, 4);
  assert.equal(mapped.baths, 3);
  assert.equal(mapped.sqft, 2140);
  assert.equal(mapped.lot_size, 13500);
  assert.equal(mapped.year_built, 1978);
  assert.equal(mapped.price, 468000);
  assert.equal(mapped.sold_date?.slice(0, 10), '2025-04-15');

  for (const field of ENRICHMENT_FIELDS) {
    assert.notEqual(mapped[field], null, `${field} must be populated for an enriched record`);
  }
});

test('ENRICH-10 shell and enriched records share an address hash', () => {
  const { mapBatchDataProperty } = loadProcessor(['mapBatchDataProperty']);
  const shell = plain(mapBatchDataProperty(shellRecord(1), job()));
  const rich = plain(mapBatchDataProperty(enrichedRecord(1), job()));

  // A backfill must be able to match a repaired record to the persisted row.
  assert.equal(shell.address_hash, rich.address_hash);
});

/* ══════ 3b. The same root cause produces a SECOND, louder symptom ══════ */
//
// With a QUICK sold-date range there are no custom bounds, so
// `isInCustomOwnershipRange` is vacuously true and an unenriched shell stays
// route-active — it silently fills a route with null enrichment.
//
// With a CUSTOM range the same expression REQUIRES a valid recorded sale date.
// A shell has none, so every record is rejected and the pull reports zero
// qualifying homes despite the provider returning records.
//
// One defect, two presentations. A pull that returns "0 of N provider records
// qualified" under a custom range is the loud form of the same failure.

/** A sale date safely inside a 30–365 day window, relative to the run date. */
function recentSaleDateIso(daysAgo = 90) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString();
}

test('ENRICH-14 under a CUSTOM sold-date range an unenriched record is rejected outright', () => {
  const { mapBatchDataProperty } = loadProcessor(['mapBatchDataProperty']);
  const customRange = job({
    dry_run_metadata: {
      filters: { min_price: 100000 },
      ownership_range_mode: 'custom',
      ownership_range_days: { min: 30, max: 365 }
    }
  });

  const shell = plain(mapBatchDataProperty(shellRecord(1), customRange));
  assert.ok(shell, 'the record still maps');
  assert.equal(shell.sold_date, null);
  assert.equal(
    shell.route_active, false,
    'a record with no recorded sale date cannot satisfy a custom ownership window — ' +
    'this is why a pull can review N provider records and produce zero active homes'
  );
});

test('ENRICH-15 the custom range itself is sound — an enriched record in-window is accepted', () => {
  const { mapBatchDataProperty } = loadProcessor(['mapBatchDataProperty']);
  const customRange = job({
    dry_run_metadata: {
      filters: { min_price: 100000 },
      ownership_range_mode: 'custom',
      ownership_range_days: { min: 30, max: 365 }
    }
  });

  const record = enrichedRecord(1);
  record.intel.lastSoldDate = recentSaleDateIso(90);

  const mapped = plain(mapBatchDataProperty(record, customRange));
  assert.equal(mapped.route_active, true, 'an in-window enriched record must be accepted');
  assert.notEqual(mapped.sold_date, null);
});

test('ENRICH-16 quick vs custom: the shell is accepted under one and rejected under the other', () => {
  const { mapBatchDataProperty } = loadProcessor(['mapBatchDataProperty']);

  const quick = job({ dry_run_metadata: { filters: { min_price: 100000 } } });
  const custom = job({
    dry_run_metadata: {
      filters: { min_price: 100000 },
      ownership_range_mode: 'custom',
      ownership_range_days: { min: 30, max: 365 }
    }
  });

  // Same record, same absent enrichment, opposite outcomes. Pinning both
  // halves keeps the two production symptoms tied to one cause.
  assert.notEqual(plain(mapBatchDataProperty(shellRecord(1), quick)).route_active, false);
  assert.equal(plain(mapBatchDataProperty(shellRecord(1), custom)).route_active, false);
});

/* ══════════════ 4. Enrichment observability ══════════════ */

test('ENRICH-11 summarizeEnrichment counts exactly the mapped records', () => {
  const { mapBatchDataProperty, summarizeEnrichment } =
    loadProcessor(['mapBatchDataProperty', 'summarizeEnrichment']);

  const mapped = [
    mapBatchDataProperty(shellRecord(1), job()),
    mapBatchDataProperty(shellRecord(2), job()),
    mapBatchDataProperty(shellRecord(3), job()),
    mapBatchDataProperty(enrichedRecord(4), job())
  ].filter(Boolean);

  assert.equal(mapped.length, 4, 'all four fixtures must map');
  const summary = plain(summarizeEnrichment(mapped));

  assert.equal(summary.provider_records_returned, 4);

  assert.equal(summary.records_with_recorded_sale_date, 1);
  assert.equal(summary.records_with_estimated_value, 1);
  assert.equal(summary.records_with_year_built, 1);
  assert.equal(summary.records_with_beds, 1);
  assert.equal(summary.records_with_baths, 1);
  assert.equal(summary.records_with_sqft, 1);
  assert.equal(summary.records_with_lot_size, 1);

  assert.equal(summary.records_missing_recorded_sale_date, 3);
  assert.equal(summary.records_missing_estimated_value, 3);
});

test('ENRICH-12 present + missing always equals the record total', () => {
  const { mapBatchDataProperty, summarizeEnrichment } =
    loadProcessor(['mapBatchDataProperty', 'summarizeEnrichment']);

  for (const [shells, rich] of [[0, 0], [5, 0], [0, 5], [3, 2]]) {
    const mapped = [
      ...Array.from({ length: shells }, (_, i) => mapBatchDataProperty(shellRecord(i + 1), job())),
      ...Array.from({ length: rich }, (_, i) => mapBatchDataProperty(enrichedRecord(i + 50), job()))
    ].filter(Boolean);

    const summary = plain(summarizeEnrichment(mapped));
    const total = shells + rich;

    assert.equal(summary.provider_records_returned, total);
    assert.equal(
      summary.records_with_recorded_sale_date + summary.records_missing_recorded_sale_date, total,
      `sale-date counts must total ${total}`
    );
    assert.equal(
      summary.records_with_estimated_value + summary.records_missing_estimated_value, total,
      `value counts must total ${total}`
    );
    assert.equal(summary.records_with_recorded_sale_date, rich);
    assert.equal(summary.records_with_estimated_value, rich);
  }
});

test('ENRICH-13 the summary carries counts only — never provider payloads or PII', () => {
  const { mapBatchDataProperty, summarizeEnrichment } =
    loadProcessor(['mapBatchDataProperty', 'summarizeEnrichment']);
  const mapped = [
    mapBatchDataProperty(shellRecord(1), job()),
    mapBatchDataProperty(enrichedRecord(2), job())
  ].filter(Boolean);

  const summary = plain(summarizeEnrichment(mapped));

  for (const [key, value] of Object.entries(summary)) {
    assert.equal(typeof value, 'number', `${key} must be a plain count`);
    assert.ok(Number.isInteger(value) && value >= 0, `${key} must be a non-negative integer`);
  }

  // No address, owner name or any other record content may leak into diagnostics.
  const serialized = JSON.stringify(summary);
  for (const leak of ['Synthetic', 'OWNER', 'Greenville', '29607', 'address', 'owner']) {
    assert.equal(serialized.includes(leak), false, `summary must not contain "${leak}"`);
  }
});

/* ══════ 5. The self-test must report the REAL request, not an intention ══════ */
//
// `dataset_scope` was previously the hard-coded literal
// 'omitted_for_sale_evidence' while the builder was in fact sending
// options.datasets. The self-test therefore reported the desired contract and
// the defect looked tested. It is now derived from a real request.

test('ENRICH-17 dataset_scope reports omitted IFF the real request omits datasets', () => {
  const { buildBatchDataRequest, observedDatasetScope } =
    loadProcessor(['buildBatchDataRequest', 'observedDatasetScope']);

  const requestOmitsDatasets = ['strict_polygon', 'centroid_fallback'].every(
    (mode) => plain(buildBatchDataRequest(job(), 0, 100, mode)).options.datasets === undefined
  );
  const selfTestSaysOmitted = observedDatasetScope() === 'omitted_for_sale_evidence';

  assert.equal(
    selfTestSaysOmitted, requestOmitsDatasets,
    'the self-test claim and the real request must agree — this is the biconditional ' +
    'that the previous hard-coded string could not satisfy'
  );
  assert.equal(selfTestSaysOmitted, true, 'and both must currently be true');
});

test('ENRICH-18 dataset_scope is derived, so it would report scoping if scoping returned', () => {
  const { observedDatasetScope } = loadProcessor(['observedDatasetScope']);
  const scope = observedDatasetScope();

  // A derived value takes one of these shapes; a hard-coded claim could not.
  assert.ok(
    scope === 'omitted_for_sale_evidence' || scope.startsWith('scoped:') || scope === 'unknown',
    `unexpected dataset_scope shape: ${scope}`
  );
});

/* ══════════ 6. Provider-level and route-outcome diagnostics ══════════ */

test('ENRICH-19 provider field presence is measured on the RAW payload', () => {
  const { summarizeProviderRecords } = loadProcessor(['summarizeProviderRecords']);

  // synthetic_failure_safety — constructed, not a provider capture.
  const summary = plain(summarizeProviderRecords([
    shellRecord(1), shellRecord(2), shellRecord(3), enrichedRecord(4)
  ]));

  assert.equal(summary.provider_records_reviewed, 4);
  assert.equal(summary.provider_records_with_intel_last_sold_date, 1);
  assert.equal(summary.provider_records_with_any_sale_date, 1);
  assert.equal(summary.provider_records_with_estimated_value, 1);
  assert.equal(summary.provider_records_with_year_built, 1);
  assert.equal(summary.provider_records_with_beds, 1);
  assert.equal(summary.provider_records_with_baths, 1);
  assert.equal(summary.provider_records_with_sqft, 1);
  assert.equal(summary.provider_records_with_lot_size, 1);
});

test('ENRICH-20 a shell-only response is distinguishable from a parse failure', () => {
  const { summarizeProviderRecords } = loadProcessor(['summarizeProviderRecords']);

  // This is the measurement that proves the provider sent no evidence, rather
  // than that we failed to read evidence which was present.
  const shellsOnly = plain(summarizeProviderRecords(
    Array.from({ length: 37 }, (_, i) => shellRecord(i + 1))
  ));

  assert.equal(shellsOnly.provider_records_reviewed, 37);
  assert.equal(shellsOnly.provider_records_with_intel_last_sold_date, 0);
  assert.equal(shellsOnly.provider_records_with_any_sale_date, 0);
});

test('ENRICH-21 route outcomes explain a zero-active custom-range pull', () => {
  const { mapBatchDataProperty, summarizeRouteOutcomes } =
    loadProcessor(['mapBatchDataProperty', 'summarizeRouteOutcomes']);

  const custom = job({
    dry_run_metadata: {
      filters: { min_price: 100000 },
      ownership_range_mode: 'custom',
      ownership_range_days: { min: 30, max: 365 }
    }
  });

  const raw = Array.from({ length: 37 }, (_, i) => shellRecord(i + 1));
  const mapped = raw.map((record) => mapBatchDataProperty(record, custom)).filter(Boolean);
  const outcomes = plain(summarizeRouteOutcomes(mapped, raw.length));

  // Exactly the production symptom: records reviewed, none routeable, and the
  // reason is now recorded rather than inferred.
  assert.equal(outcomes.route_active_records, 0);
  assert.equal(outcomes.custom_range_missing_sale_date, mapped.length);
  assert.equal(outcomes.custom_range_outside_date_window, 0);
  assert.equal(outcomes.rejected_price, 0);
});

test('ENRICH-22 missing sale date is counted separately from out-of-window', () => {
  const { mapBatchDataProperty, summarizeRouteOutcomes } =
    loadProcessor(['mapBatchDataProperty', 'summarizeRouteOutcomes']);

  const custom = job({
    dry_run_metadata: {
      filters: { min_price: 100000 },
      ownership_range_mode: 'custom',
      ownership_range_days: { min: 30, max: 365 }
    }
  });

  const stale = enrichedRecord(2);
  stale.intel.lastSoldDate = new Date(Date.now() - 3000 * 86400000).toISOString();

  const mapped = [
    mapBatchDataProperty(shellRecord(1), custom),
    mapBatchDataProperty(stale, custom)
  ].filter(Boolean);
  const outcomes = plain(summarizeRouteOutcomes(mapped, 2));

  // These look identical from outside but have entirely different causes.
  assert.equal(outcomes.custom_range_missing_sale_date, 1);
  assert.equal(outcomes.custom_range_outside_date_window, 1);
});

test('ENRICH-23 quick-range behaviour is unchanged by this hotfix', () => {
  const { mapBatchDataProperty, summarizeRouteOutcomes } =
    loadProcessor(['mapBatchDataProperty', 'summarizeRouteOutcomes']);

  const quick = job({ dry_run_metadata: { filters: { min_price: 100000 } } });
  const raw = [shellRecord(1), shellRecord(2), enrichedRecord(3)];
  const mapped = raw.map((record) => mapBatchDataProperty(record, quick)).filter(Boolean);
  const outcomes = plain(summarizeRouteOutcomes(mapped, raw.length));

  // Quick range still accepts every record; the hotfix changed the request, not
  // eligibility. Diagnostics must not become a back-door eligibility change.
  assert.equal(outcomes.mapped_records, 3);
  assert.equal(outcomes.route_active_records, 3);
  assert.equal(outcomes.custom_range_missing_sale_date, 0);
});

test('ENRICH-24 diagnostics carry counts only, never payloads or PII', () => {
  const { mapBatchDataProperty, summarizeProviderRecords, summarizeRouteOutcomes } =
    loadProcessor(['mapBatchDataProperty', 'summarizeProviderRecords', 'summarizeRouteOutcomes']);

  const raw = [shellRecord(1), enrichedRecord(2)];
  const mapped = raw.map((record) => mapBatchDataProperty(record, job())).filter(Boolean);

  for (const summary of [plain(summarizeProviderRecords(raw)), plain(summarizeRouteOutcomes(mapped, raw.length))]) {
    for (const [key, value] of Object.entries(summary)) {
      assert.ok(Number.isInteger(value) && value >= 0, `${key} must be a non-negative integer`);
    }
    const serialized = JSON.stringify(summary);
    for (const leak of ['Synthetic', 'OWNER', 'Greenville', '29607']) {
      assert.equal(serialized.includes(leak), false, `must not contain "${leak}"`);
    }
  }
});

test('ENRICH-25 Fixed Count and Max Available build an identical provider request', () => {
  const { buildBatchDataRequest } = loadProcessor(['buildBatchDataRequest']);

  // Requested quantity is an order-control concern (PR #74). It must not reach
  // the provider request, so it cannot be the cause of a zero-result pull.
  const fixed = job({ count_mode: 'fixed', entered_count: 10, effective_count: 10, requested_properties: 10 });
  const max = job({ count_mode: 'max_available', entered_count: 784, effective_count: 784, requested_properties: 784 });

  for (const mode of ['strict_polygon', 'centroid_fallback']) {
    assert.deepEqual(
      plain(buildBatchDataRequest(fixed, 0, 100, mode)),
      plain(buildBatchDataRequest(max, 0, 100, mode)),
      `mode ${mode}: count mode must not change the outbound request`
    );
  }
});
