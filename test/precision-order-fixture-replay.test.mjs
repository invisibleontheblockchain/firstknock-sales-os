// MODEL 1 / PR A — fixture replay and existing-job compatibility.
//
// 1. Regenerates the whole workflow corpus from the real production handlers
//    and proves it is byte-identical to what is committed. A production change
//    to Stages 0-4 fails this test.
// 2. Classifies every category of pre-existing FetchJob against PR #66's real
//    validators.
//
// See docs/precision/pr-a-model-1/PR66_RESUMPTION_PLAN.md.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { AUDIT_USER, FIXED_NOW_MS } from './helpers/precisionOrderHarness.mjs';
import { CORPUS_DIR, buildCorpus } from '../scripts/precision-order-audit/generate-fixtures.mjs';
import { loadCandidateValidators, loadSharedCriteriaModule } from './helpers/pr66Validators.mjs';

const shared = loadSharedCriteriaModule();
const candidates = loadCandidateValidators(shared);

const DEFAULT_ROUTE_TYPE_FILTERS = {
  propertyTypes: ['Single Family'],
  excludeCommercial: true,
  excludeCondos: true,
  excludeLand: true
};

/* --------------------------------------------------------------- replay */

test('AR-RP-01 the committed corpus is byte-identical to a fresh run of production Stage 0-4 code', async () => {
  const files = await buildCorpus();
  const drift = [];
  for (const [relative, value] of files) {
    const target = join(CORPUS_DIR, relative);
    if (!existsSync(target)) {
      drift.push(`missing: ${relative}`);
      continue;
    }
    const committed = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    const regenerated = `${JSON.stringify(value, null, 2)}\n`;
    if (committed !== regenerated) drift.push(`drifted: ${relative}`);
  }
  assert.deepEqual(drift, [],
    'regenerate with: node scripts/precision-order-audit/generate-fixtures.mjs');
});

test('AR-RP-02 the manifest describes every committed fixture and nothing else', () => {
  const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, 'manifest.json'), 'utf8'));
  const workflowIds = readdirSync(join(CORPUS_DIR, 'workflows')).map((f) => f.replace(/\.json$/, '')).sort();
  const manifestIds = manifest.fixtures.map((entry) => entry.scenario_id).sort();
  assert.deepEqual(manifestIds, workflowIds);
  assert.equal(manifest.hand_edited, false);
  assert.equal(manifest.evidence_type, 'production_code_characterization');

  for (const required of [
    'fixed-below-allowance', 'fixed-equal-allowance', 'fixed-above-allowance',
    'max-available-partial', 'max-available-concurrent-change',
    'fixed-quick-range', 'fixed-custom-range', 'max-custom-range',
    'home-round-trip', 'current-to-home',
    'exact-active-job', 'active-job-conflict', 'multiple-active-jobs',
    'preview-single', 'preview-identical-repeat', 'concurrent-max-available'
  ]) {
    assert.ok(manifestIds.includes(required), `required scenario missing: ${required}`);
  }
});

test('AR-RP-03 every workflow fixture carries full provenance', () => {
  for (const file of readdirSync(join(CORPUS_DIR, 'workflows'))) {
    const record = JSON.parse(readFileSync(join(CORPUS_DIR, 'workflows', file), 'utf8'));
    for (const field of [
      'fixture_id', 'scenario_id', 'evidence_type', 'audited_source_blobs', 'generation_command',
      'source_files', 'source_functions', 'frozen_clock', 'timezone', 'c0_user_intent',
      'browser_state', 'what_it_proves', 'what_it_does_not_prove', 'hand_edited', 'trace'
    ]) {
      assert.ok(record[field] !== undefined, `${file} is missing ${field}`);
    }
    assert.equal(record.hand_edited, false, file);
  }
});

test('AR-RP-04 no fixture contains a real provider response or any live credential', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

  for (const file of walk(CORPUS_DIR)) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/sk_live|pk_live|Bearer [A-Za-z0-9._-]{20,}/.test(text), `${file} may contain a credential`);
    // The only api.batchdata.com content permitted is the REQUEST the code
    // builds; no response body is ever recorded as evidence.
    if (text.includes('api.batchdata.com')) {
      const record = JSON.parse(text);
      const requests = record.trace?.provider_requests || [];
      assert.ok(requests.length > 0, `${file} mentions the provider without a recorded request`);
      for (const request of requests) {
        assert.ok(!('response' in request), 'no provider response is stored as evidence');
      }
    }
  }
});

/* ------------------------------------------ existing-job classification */

const CORPUS_JOBS = readdirSync(join(CORPUS_DIR, 'fetchjobs')).sort().map((file) => ({
  scenario: file.replace(/\.fetchjob\.json$/, ''),
  job: JSON.parse(readFileSync(join(CORPUS_DIR, 'fetchjobs', file), 'utf8'))
}));

/**
 * Runs PR #66's real classification over one job record, INCLUDING the handler
 * step that derives a legacy job's workspace from its immutable subject when
 * that subject is the requesting actor. Omitting that step measures one
 * validator in isolation rather than PR #66's actual outcome.
 */
function classify(job, actor = AUDIT_USER) {
  const source = shared.precisionCriteriaSource(job);
  const raw = shared.buildExistingPrecisionCriteria(job, {
    polygonHash: job.polygon_hash,
    defaultRouteFilters: DEFAULT_ROUTE_TYPE_FILTERS
  });

  const authenticatedWorkspaceId = candidates.getAuthenticatedWorkspaceId(actor);
  const derives = source === 'legacy'
    && !raw.workspace_id
    && authenticatedWorkspaceId
    && raw.immutable_user_id
    && raw.immutable_user_id === String(actor?.id || '').trim();
  const criteria = derives ? { ...raw, workspace_id: authenticatedWorkspaceId } : raw;

  const invalidLegacyRaw = candidates.invalidLegacyCriteriaFields(raw);
  const invalidLegacy = candidates.invalidLegacyCriteriaFields(criteria);
  const invalidV1 = candidates.invalidPersistedCriteriaFields(criteria);
  const workspace = candidates.getFetchJobWorkspaceId(job);
  const contract = shared.precisionProviderContractVersion(job);

  let classification;
  if (source === 'schema_v1' && invalidV1.length === 0) classification = 'schema_v1_verified';
  else if (source === 'legacy' && invalidLegacy.length === 0) classification = 'legacy_reconstructed';
  else classification = 'requires_migration';

  return {
    source,
    classification,
    workspace_verification: derives ? 'derived_from_immutable_subject' : null,
    invalidLegacyRaw,
    invalidLegacy,
    invalidV1,
    workspace,
    contract
  };
}


test('AR-EJ-02 a job created by PR #66 itself classifies as schema_v1_verified', () => {
  const base = CORPUS_JOBS.find((entry) => entry.scenario === 'fixed-below-allowance').job;
  const pr66Job = {
    ...base,
    dry_run_metadata: {
      ...base.dry_run_metadata,
      workspace_id: AUDIT_USER.id,
      precision_criteria: shared.buildRequestedPrecisionCriteria({
        polygon_hash: base.polygon_hash,
        count_mode: 'fixed',
        entered_count: 25,
        effective_count: 25,
        min_price: 100000,
        max_price: null,
        sold_months: 3,
        ownership_range_mode: 'quick',
        ownership_range_days: null,
        route_filters: DEFAULT_ROUTE_TYPE_FILTERS,
        repull_mode: 'new_area',
        previous_pull_date: null,
        force_full_refresh: false,
        include_unresolved_followups: false,
        route_bounds: { enabled: false },
        immutable_user_id: AUDIT_USER.id,
        workspace_id: AUDIT_USER.id
      })
    }
  };
  const result = classify(pr66Job);
  assert.equal(result.source, 'schema_v1');
  assert.equal(result.classification, 'schema_v1_verified');
  assert.deepEqual(result.invalidV1, []);
});


test('AR-EJ-04 a historical Ghost Mode job with no mode_tag is unprovable even for its owner', () => {
  const base = CORPUS_JOBS[0].job;
  const ghost = { ...base };
  delete ghost.mode_tag;
  delete ghost.polygon_hash;
  delete ghost.dry_run_metadata;
  ghost.dry_run_metadata = {};

  const result = classify(ghost);
  assert.equal(result.source, 'legacy');
  assert.equal(result.classification, 'requires_migration');

  // The workspace IS supplied by the derivation, because the record still
  // carries its immutable subject. What cannot be proven is the geometry
  // identity and the entered count.
  assert.equal(result.workspace_verification, 'derived_from_immutable_subject');
  assert.deepEqual(result.invalidLegacy.sort(), ['entered_count', 'ownership_range_mode', 'polygon_hash'],
    'a Ghost Mode record fails on evidence no derivation can supply');

  // `effective_count` stays provable because PR #66 falls back to the
  // first-class `total_expected` column when the metadata is empty. That
  // fallback is the ONLY count evidence such a record has.
  assert.ok(!result.invalidLegacy.includes('effective_count'));
  assert.equal(
    shared.buildExistingPrecisionCriteria(ghost, {}).effective_count,
    ghost.total_expected
  );
});

test('AR-EJ-05 an active job crossing a deployment boundary keeps its pre-deploy semantics', () => {
  // A job created by main and still running when PR #66 deploys is reconstructed
  // from the SAME persisted evidence, so nothing is silently reinterpreted —
  // except the fields PR #66 explicitly discloses as unverifiable.
  const inFlight = {
    ...CORPUS_JOBS.find((entry) => entry.scenario === 'fixed-below-allowance').job,
    id: 'job_in_flight',
    status: 'running',
    created_date: new Date(FIXED_NOW_MS - 60 * 1000).toISOString()
  };
  const criteria = shared.buildExistingPrecisionCriteria(inFlight, { defaultRouteFilters: DEFAULT_ROUTE_TYPE_FILTERS });
  assert.equal(criteria.min_price, null, 'a main-created no-floor job is NOT rewritten to $100,000');
  assert.deepEqual(shared.LEGACY_UNVERIFIABLE_CRITERIA_FIELDS.sort(), [
    'count_mode', 'force_full_refresh', 'include_unresolved_followups', 'max_price',
    'previous_pull_date', 'repull_mode', 'route_bounds', 'route_filters'
  ]);
});

test('AR-EJ-06 a failed job retried through the existing browser retry path loses repull semantics', () => {
  // TerritoryPrompt.retryRecoverableJob rebuilds the request by hand and sends
  // it to fetchAreaProperties, which persists no repull field at all.
  const source = readFileSync(resolve(process.cwd(), 'src/components/map/TerritoryPrompt.jsx'), 'utf8');
  const retryBlock = source.slice(
    source.indexOf('const retryRecoverableJob'),
    source.indexOf('const handleFetchData')
  );
  assert.ok(retryBlock.includes("invoke('fetchAreaProperties'"),
    'the retry path targets fetchAreaProperties');
  for (const droppedField of ['repull_mode', 'previous_pull_date', 'include_unresolved_followups']) {
    assert.ok(!retryBlock.includes(`${droppedField}:`),
      `the retry request does not restate ${droppedField}`);
  }
  assert.ok(retryBlock.includes('requested_properties: recoveryMetadata.requested_properties'),
    'and it restates the CAPPED effective count, not the originally entered count');
});

/* ═══════════ SUPERSEDED BY PR A ═══════════
 * These pinned the PRE-PR-A handoff, where every job was legacy and needed
 * PR #66 to derive its workspace. PR A persists workspace, versions and a
 * criteria snapshot, so the handoff contract now lives in
 * test/precision-order-pr66-handoff.test.mjs. Originals are preserved on
 * audit/precision-order-control-model-1 @ 0c3fd666.
 *
 *   AR-EJ-01 -> PR66-H-03
 *   AR-EJ-01b -> PR66-H-10
 *   AR-EJ-03 -> PR66-H-04
 *   AR-EJ-07 -> PR66-H-03
 * ══════════════════════════════════════════ */
