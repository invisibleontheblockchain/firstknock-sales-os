// Tripwire: the three provenance/display fields that are deliberately NOT part
// of active-order equality.
//
//     force_full_refresh
//     include_unresolved_followups
//     pull_mode
//
// A read-only investigation established that none of them is an input to what
// BatchData is asked for, or to which properties are processed. They are
// recorded on the FetchJob for provenance and for the status UI only. Because
// of that, two orders differing ONLY in these fields are the same material
// property order, and `COMPARED_ORDER_FIELDS` deliberately omits them.
//
// ─────────────────────────────────────────────────────────────────────────────
// IF ANY OF THESE FIELDS LATER BECOMES AN INPUT TO provider fetching,
// filtering, deduplication, persistence, or route eligibility, THIS TEST MUST
// BE CHANGED — and the field must then be added to COMPARED_ORDER_FIELDS in
// base44/shared/precisionOrderSafety.js, or a job that cannot prove
// it must be classified `one_unverifiable`.
//
// This file failing is the signal that the assumption no longer holds. Do not
// simply update the expectations to make it pass again.
// ─────────────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import {
  PATHS,
  START_PATHS,
  activeFetchJob,
  loadSharedOrderSafety,
  orderBody,
  plain,
  runStartPath
} from './helpers/precisionOrderHarness.mjs';
import { normalizePrecisionPolygon } from '../base44/shared/precisionOrderSafety.js';

const NON_MATERIAL_FIELDS = ['force_full_refresh', 'include_unresolved_followups', 'pull_mode'];

/**
 * Extracts the REAL `buildBatchDataRequest` from the production processor.
 *
 * This is the strongest deterministic path available: it executes the actual
 * function that composes the outbound BatchData request, rather than asserting
 * anything about source text. Nothing is stubbed except the module-level
 * imports the sandbox strips, none of which participate in request building.
 */
function loadProductionRequestBuilder() {
  const path = 'base44/functions/processFetchChunk/entry.ts';
  const source = readFileSync(resolve(process.cwd(), path), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
  assert.deepEqual(errors, [], `${path} has TypeScript errors`);

  assert.match(source, /function buildBatchDataRequest\(job/,
    'processFetchChunk no longer exposes buildBatchDataRequest — this guard must be re-derived');

  const executable = `${transpiled.outputText.replace(/^import .*;\s*$/gm, '')}
;__collect({ buildBatchDataRequest });`;

  let collected = null;
  vm.runInNewContext(executable, {
    __collect: (value) => { collected = value; },
    Deno: { env: { get: () => undefined }, serve: () => {} },
    createClientFromRequest: () => ({}),
    normalizePrecisionPolygon,
    neon: () => (() => {}),
    Request, Response, TextEncoder, TextDecoder, URL,
    crypto: globalThis.crypto,
    fetch: async () => { throw new Error('no provider call is permitted in this test'); },
    setTimeout, clearTimeout, AbortController,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    JSON, Number, String, Boolean, Array, Object, Set, Map, Math, Date, Error,
    Promise, Uint8Array, isNaN, isFinite, parseInt, parseFloat
  }, { filename: path });

  assert.ok(collected?.buildBatchDataRequest, 'buildBatchDataRequest was not captured');
  return collected.buildBatchDataRequest;
}

/** Two real FetchJobs from the production start path, differing only in the flags. */
async function jobsDifferingOnlyInNonMaterialFlags(path) {
  const base = { requested_properties: 25, sold_months: 3, min_price: 150000, max_price: 400000 };

  const plainOrder = await runStartPath(path, {
    body: orderBody({ ...base, force_full_refresh: false, include_unresolved_followups: false })
  });
  const flaggedOrder = await runStartPath(path, {
    body: orderBody({ ...base, force_full_refresh: true, include_unresolved_followups: true })
  });

  assert.equal(plainOrder.status, 200);
  assert.equal(flaggedOrder.status, 200);
  return { plain: plainOrder.createdJob, flagged: flaggedOrder.createdJob };
}

/* ══════════ 1. The outbound provider request is byte-identical ══════════ */

test('FLAG-01 the REAL provider request builder produces an identical request when only these flags differ', async () => {
  const buildBatchDataRequest = loadProductionRequestBuilder();

  for (const [name, path] of START_PATHS) {
    const { plain: withoutFlags, flagged: withFlags } = await jobsDifferingOnlyInNonMaterialFlags(path);

    const fingerprint = (job) => [
      job.force_full_refresh,
      job.pull_mode,
      job.dry_run_metadata.force_full_refresh,
      job.dry_run_metadata.include_unresolved_followups
    ];

    if (name === 'startBatchDataPull') {
      // This path records the flags, so the fixture must genuinely differ —
      // otherwise the comparison below would be vacuously true.
      assert.notDeepEqual(fingerprint(withFlags), fingerprint(withoutFlags),
        `${name}: the fixture must actually differ in the flags under test`);
    } else {
      // `fetchAreaProperties` never persisted these flags and hardcodes
      // pull_mode: 'new_area'. That is pre-existing behaviour on main which
      // this PR deliberately did not change. They therefore cannot be material
      // here for the strongest possible reason: they do not exist on the job.
      assert.deepEqual(fingerprint(withFlags), fingerprint(withoutFlags),
        `${name}: this path records none of these flags`);
      assert.deepEqual(fingerprint(withFlags), [undefined, 'new_area', undefined, undefined],
        `${name}: if this path starts persisting them, re-derive whether they are material`);
    }

    for (const mode of ['strict_polygon', 'centroid_fallback']) {
      for (const [skip, take] of [[0, 100], [100, 50]]) {
        assert.deepEqual(
          plain(buildBatchDataRequest(withFlags, skip, take, mode)),
          plain(buildBatchDataRequest(withoutFlags, skip, take, mode)),
          `${name}: ${mode} skip=${skip} take=${take} — the outbound request must not depend on these flags`
        );
      }
    }
  }
});

/* ══════════ 2. Nothing the processor consumes differs ══════════ */

test('FLAG-02 every job field the processor consumes is identical when only these flags differ', async () => {
  // The fields processFetchChunk actually reads off the job. Verified by
  // inspection of base44/functions/processFetchChunk/entry.ts; FLAG-04 pins
  // that the file does not reference the flags at all.
  const CONSUMED_TOP_LEVEL = [
    'polygon', 'latitude', 'longitude', 'sold_months',
    'ownership_range_mode', 'ownership_min_days', 'ownership_max_days',
    'total_expected', 'estimated_record_count', 'zip_codes_found'
  ];
  const CONSUMED_METADATA = [
    'filters', 'route_filters', 'excluded_route_hashes',
    'ownership_range_mode', 'ownership_range_days'
  ];

  for (const [name, path] of START_PATHS) {
    const { plain: withoutFlags, flagged: withFlags } = await jobsDifferingOnlyInNonMaterialFlags(path);

    for (const field of CONSUMED_TOP_LEVEL) {
      assert.deepEqual(withFlags[field], withoutFlags[field], `${name}: job.${field}`);
    }
    for (const field of CONSUMED_METADATA) {
      assert.deepEqual(
        withFlags.dry_run_metadata[field],
        withoutFlags.dry_run_metadata[field],
        `${name}: dry_run_metadata.${field}`
      );
    }
  }
});

test('FLAG-03 the ONLY persisted differences are the provenance fields themselves', async () => {
  // Guards the inverse direction: if a future change makes one of these flags
  // leak into some other persisted field, this fails even though FLAG-01 and
  // FLAG-02 might still pass.
  const EXPECTED_TO_DIFFER = new Set([
    'force_full_refresh',
    'pull_mode',
    'dry_run_metadata.force_full_refresh',
    'dry_run_metadata.include_unresolved_followups'
  ]);
  // Non-deterministic or per-attempt values that legitimately differ.
  const IGNORED = new Set([
    'id',
    'dry_run_metadata.processor_token',
    'dry_run_metadata.paid_pull_started_at',
    'dry_run_metadata.batchdata_only_started_at'
  ]);

  for (const [name, path] of START_PATHS) {
    const { plain: withoutFlags, flagged: withFlags } = await jobsDifferingOnlyInNonMaterialFlags(path);

    const differing = [];
    const walk = (left, right, prefix) => {
      const names = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
      for (const key of names) {
        const at = prefix ? `${prefix}.${key}` : key;
        if (IGNORED.has(at)) continue;
        const a = left?.[key];
        const b = right?.[key];
        if (at === 'dry_run_metadata') { walk(a, b, at); continue; }
        if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) differing.push(at);
      }
    };
    walk(withoutFlags, withFlags, '');

    for (const field of differing) {
      assert.ok(EXPECTED_TO_DIFFER.has(field),
        `${name}: ${field} changed because of a non-material flag — it must not`);
    }
  }
});

/* ══════════ 3. Narrow source assertion, with its limits stated ══════════ */

test('FLAG-04 processFetchChunk does not reference these fields at all', () => {
  // Scope note, stated plainly: this proves only that THIS FILE contains no
  // reference to these identifiers at this commit. It does not prove anything
  // about other consumers, about future changes, or about behaviour at run
  // time. FLAG-01 and FLAG-02 carry the behavioural proof; this is a cheap,
  // narrowly scoped early-warning on top of them.
  const source = readFileSync(
    resolve(process.cwd(), 'base44/functions/processFetchChunk/entry.ts'), 'utf8');

  for (const field of NON_MATERIAL_FIELDS) {
    assert.equal(source.includes(field), false,
      `processFetchChunk now references ${field} — re-derive whether it is material to the order`);
  }
});

/* ══════════ 4. Active-job equality is unaffected ══════════ */

test('FLAG-05 an active job differing only in these flags is still one_exact_match', async () => {
  const pathMinPrice = { startBatchDataPull: null, fetchAreaProperties: 100000 };

  for (const [name, path] of START_PATHS) {
    const active = activeFetchJob({ id: 'job_flags_differ', precision_usage_reserved: 1, total_expected: 1 });
    active.dry_run_metadata = {
      requested_properties: 25,
      requested_properties_before_cap: 25,
      count_mode: 'fixed',
      filters: { min_price: pathMinPrice[name], max_price: null },
      route_filters: {
        propertyTypes: ['Single Family'],
        excludeCommercial: true,
        excludeCondos: true,
        excludeLand: true
      },
      route_bounds: { enabled: false },
      ownership_range_mode: 'quick',
      ownership_range_days: null,
      repull_mode: 'new_area',
      previous_pull_date: null,
      // The active job recorded the opposite of what is now submitted.
      force_full_refresh: false,
      include_unresolved_followups: false
    };
    active.force_full_refresh = false;
    active.pull_mode = 'new_area';

    const result = await runStartPath(path, {
      body: orderBody({
        requested_properties: 25,
        force_full_refresh: true,
        include_unresolved_followups: true
      }),
      fetchJobs: [active]
    });

    assert.equal(result.status, 200, name);
    assert.equal(result.body.active_job_outcome, 'one_exact_match',
      `${name}: a non-material flag difference must not become a criteria conflict`);
    assert.equal(result.createdJob, null, name);
    assert.deepEqual(result.trace.writes, [], `${name}: and nothing is cancelled or replaced`);
  }
});

test('FLAG-06 the compared-order field set deliberately excludes these fields', () => {
  const { COMPARED_ORDER_FIELDS } = loadSharedOrderSafety();
  for (const field of NON_MATERIAL_FIELDS) {
    assert.equal(COMPARED_ORDER_FIELDS.includes(field), false,
      `${field} is compared for order equality — if that is intended, this guard is obsolete`);
  }
  // A material field regressing out of the set would be far worse than a
  // non-material one regressing in, so pin the set that must stay.
  for (const field of [
    'polygon_hash', 'count_mode', 'effective_count', 'min_price', 'max_price',
    'sold_months', 'ownership_range_mode', 'ownership_range_days',
    'route_filters', 'route_bounds', 'repull_mode', 'previous_pull_date'
  ]) {
    assert.ok(COMPARED_ORDER_FIELDS.includes(field), `${field} must remain part of order equality`);
  }
});
