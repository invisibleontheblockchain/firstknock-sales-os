// MODEL 2 / PR A — PR A -> PR #66 handoff proof.
//
// Runs PR #66's ACTUAL validators (vendored byte-exact from head
// 35396b50457e93fc3c5a1d838a23fae787c75fa6) over the FetchJobs that the PR A
// candidate produces, INCLUDING the handler preprocessing that runs before each
// validator. Model 1 was caught out once by calling a validator without its
// caller; that mistake is guarded here by pinning each preprocessing step to
// PR #66's own source text.
//
// PR #66 is never modified, merged or checked out.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { AUDIT_USER } from './helpers/precisionOrderHarness.mjs';
import {
  loadCandidateValidators,
  loadSharedCriteriaModule,
  verifyVendoredIntegrity
} from './helpers/pr66Validators.mjs';

const shared = loadSharedCriteriaModule();
const candidates = loadCandidateValidators(shared);

const FETCHJOB_DIR = resolve(process.cwd(), 'test/fixtures/precision/order-to-fetchjob/fetchjobs');
const PR66_SOURCE = readFileSync(
  resolve(process.cwd(), 'test/fixtures/precision/pr66-reference/getRouteCandidatesFromNeon.entry.ts'),
  'utf8'
);

const DEFAULT_ROUTE_TYPE_FILTERS = {
  propertyTypes: ['Single Family'],
  excludeCommercial: true,
  excludeCondos: true,
  excludeLand: true
};

function candidateJobs() {
  return readdirSync(FETCHJOB_DIR).sort().map((file) => ({
    scenario: file.replace(/\.fetchjob\.json$/, ''),
    job: JSON.parse(readFileSync(resolve(FETCHJOB_DIR, file), 'utf8'))
  }));
}

/**
 * Reproduces PR #66's handler sequence for one job: classify the source, build
 * the criteria, apply the legacy workspace derivation, then validate with the
 * matching validator. Each step is pinned to PR #66's source below.
 */
function runPr66HandlerChain(job, actor = AUDIT_USER) {
  const source = shared.precisionCriteriaSource(job);
  const raw = shared.buildExistingPrecisionCriteria(job, {
    polygonHash: job.polygon_hash,
    defaultRouteFilters: DEFAULT_ROUTE_TYPE_FILTERS
  });

  const authenticatedWorkspaceId = candidates.getAuthenticatedWorkspaceId(actor);
  const authenticatedSubject = String(actor?.id || '').trim();
  const derives = source === 'legacy'
    && !raw.workspace_id
    && authenticatedWorkspaceId
    && raw.immutable_user_id
    && raw.immutable_user_id === authenticatedSubject;
  const criteria = derives ? { ...raw, workspace_id: authenticatedWorkspaceId } : raw;

  const invalidFields = source === 'schema_v1'
    ? candidates.invalidPersistedCriteriaFields(criteria)
    : candidates.invalidLegacyCriteriaFields(criteria);

  const ownerMismatch = criteria.immutable_user_id !== authenticatedSubject;
  const workspaceMismatch = criteria.workspace_id !== authenticatedWorkspaceId;

  return {
    criteria_verification: source === 'schema_v1' ? 'schema_v1' : 'legacy_reconstructed',
    workspace_verification: derives ? 'derived_from_immutable_subject' : null,
    invalid_fields: invalidFields,
    accepted: invalidFields.length === 0 && !ownerMismatch && !workspaceMismatch,
    rejection: invalidFields.length > 0
      ? (source === 'schema_v1' ? 'fetch_job_criteria_unverifiable' : 'legacy_precision_criteria_unverifiable')
      : ownerMismatch ? 'fetch_job_owner_mismatch'
        : workspaceMismatch ? 'fetch_job_workspace_mismatch' : null,
    criteria
  };
}

/* ───────────────────────────── provenance ───────────────────────────── */

test('PR66-H-01 the vendored PR #66 source matches the audited head', () => {
  const manifest = verifyVendoredIntegrity();
  assert.equal(manifest.pr_head_sha, '35396b50457e93fc3c5a1d838a23fae787c75fa6');
  assert.equal(manifest.hand_edited, false);
});

test('PR66-H-02 the handler chain modelled here matches PR #66 source', () => {
  // Guards against the exact class of error Model 1 hit: validating without the
  // caller's preprocessing. If PR #66 changes any of these, this test fails and
  // the handoff claim must be re-derived rather than silently trusted.
  assert.match(PR66_SOURCE, /criteriaSource === 'schema_v1'\s*\?\s*invalidPersistedCriteriaFields\(persistedCriteria\)\s*:\s*invalidLegacyCriteriaFields\(persistedCriteria\)/,
    'validator selection is driven by criteriaSource');
  assert.match(PR66_SOURCE, /criteriaSource === 'legacy' &&\s*!persistedCriteria\.workspace_id &&\s*authenticatedWorkspaceId &&\s*persistedCriteria\.immutable_user_id &&\s*persistedCriteria\.immutable_user_id === authenticatedImmutableUserId/,
    'the legacy workspace derivation precedes validation');
  assert.match(PR66_SOURCE, /persistedCriteria\.immutable_user_id !== authenticatedImmutableUserId/,
    'ownership is compared against the authenticated subject');
  assert.match(PR66_SOURCE, /persistedCriteria\.workspace_id !== authenticatedWorkspaceId/,
    'workspace is compared against the authenticated workspace');
});

/* ──────────────────────────── the handoff ──────────────────────────── */

test('PR66-H-03 EVERY PR A FetchJob is accepted by PR #66 for its owner', () => {
  const jobs = candidateJobs();
  assert.ok(jobs.length >= 10, 'the candidate corpus must be populated');

  for (const { scenario, job } of jobs) {
    const outcome = runPr66HandlerChain(job);
    assert.equal(outcome.accepted, true,
      `${scenario}: rejected with ${outcome.rejection} on ${JSON.stringify(outcome.invalid_fields)}`);
    assert.equal(outcome.rejection, null, scenario);
  }
});

test('PR66-H-04 no PR A FetchJob relies on the legacy workspace derivation any more', () => {
  // Before PR A every job needed PR #66 to derive the workspace from the
  // immutable subject. PR A persists it, so the derivation never fires — which
  // is also what makes delegated access decidable later instead of impossible.
  for (const { scenario, job } of candidateJobs()) {
    const outcome = runPr66HandlerChain(job);
    assert.equal(outcome.workspace_verification, null, scenario);
    assert.equal(candidates.getFetchJobWorkspaceId(job), AUDIT_USER.id, scenario);
  }
});

test('PR66-H-05 the provider contract version is persisted and supported', () => {
  for (const { scenario, job } of candidateJobs()) {
    const version = shared.precisionProviderContractVersion(job);
    assert.equal(version, 1, scenario);
    assert.equal(shared.isSupportedPrecisionProviderContract(version), true, scenario);
  }
});

test('PR66-H-06 a criteria snapshot is published ONLY when it satisfies PR #66 schema-v1 rules', () => {
  // The snapshot is withheld when the order carries no price floor, because
  // PR #66's schema-v1 validator requires min_price > 0 while its legacy path
  // accepts null as "no floor". Publishing an unsatisfiable snapshot would turn
  // an accepted job into a rejected one.
  let schemaV1 = 0;
  let legacy = 0;
  for (const { scenario, job } of candidateJobs()) {
    const outcome = runPr66HandlerChain(job);
    const minPrice = job.dry_run_metadata.precision_criteria?.min_price
      ?? job.dry_run_metadata.filters.min_price;

    if (outcome.criteria_verification === 'schema_v1') {
      schemaV1 += 1;
      assert.ok(Number(minPrice) > 0, `${scenario}: schema_v1 implies a positive minimum value`);
      assert.deepEqual(outcome.invalid_fields, [], scenario);
    } else {
      legacy += 1;
      assert.equal(job.dry_run_metadata.filters.min_price, null,
        `${scenario}: the only reason to withhold the snapshot is a null minimum value`);
      assert.deepEqual(job.dry_run_metadata.precision_criteria_withheld, ['min_price'],
        `${scenario}: and the reason is disclosed on the record`);
      assert.deepEqual(outcome.invalid_fields, [], scenario);
    }
  }
  assert.ok(schemaV1 > 0, 'at least one scenario reaches schema_v1');
  assert.ok(legacy > 0, 'and the null-minimum path is exercised');
});

/* ─────────────────── field-by-field preservation ─────────────────── */

test('PR66-H-07 every material field survives the handoff unchanged', () => {
  for (const { scenario, job } of candidateJobs()) {
    const { criteria } = runPr66HandlerChain(job);
    const metadata = job.dry_run_metadata;

    assert.equal(criteria.polygon_hash, job.polygon_hash, `${scenario} polygon_hash`);
    assert.equal(criteria.count_mode, metadata.count_mode, `${scenario} count_mode`);
    assert.equal(criteria.entered_count, metadata.requested_properties_before_cap, `${scenario} entered_count`);
    assert.equal(criteria.effective_count, metadata.requested_properties, `${scenario} effective_count`);
    assert.equal(criteria.min_price, metadata.filters.min_price, `${scenario} min_price`);
    assert.equal(criteria.max_price, metadata.filters.max_price, `${scenario} max_price`);
    assert.equal(criteria.sold_months, job.sold_months, `${scenario} sold_months`);
    assert.equal(criteria.ownership_range_mode, metadata.ownership_range_mode, `${scenario} ownership mode`);
    assert.deepEqual(criteria.ownership_range_days, metadata.ownership_range_days ?? null, `${scenario} window`);
    assert.deepEqual(criteria.route_bounds, metadata.route_bounds, `${scenario} route_bounds`);
    assert.equal(criteria.repull_mode, metadata.repull_mode, `${scenario} repull_mode`);
    assert.equal(criteria.immutable_user_id, job.precision_usage_user_id, `${scenario} subject`);
    assert.equal(criteria.workspace_id, AUDIT_USER.id, `${scenario} workspace`);
    assert.equal(Number.isInteger(criteria.effective_count), true, `${scenario}: counts are whole numbers`);
  }
});

test('PR66-H-08 repull semantics are PERSISTED on both start paths, never inferred', () => {
  const byScenario = Object.fromEntries(candidateJobs().map(({ scenario, job }) => [scenario, job]));

  // Model 1 proved fetchAreaProperties discarded these entirely, so PR #66 had
  // to infer `new_area`. PR A persists them on both paths.
  const areaJob = byScenario['fixed-below-allowance-fetchareaproperties'];
  assert.equal(areaJob.dry_run_metadata.repull_mode, 'new_area');

  const repullJob = byScenario['repull-max-since-last'];
  const criteria = runPr66HandlerChain(repullJob).criteria;
  assert.equal(criteria.repull_mode, 'max_since_last');
  assert.equal(criteria.previous_pull_date, '2026-05-01T00:00:00.000Z');
  assert.equal(criteria.include_unresolved_followups, true);
});

test('PR66-H-09 no job requires browser reconstruction or email-derived authority', () => {
  for (const { scenario, job } of candidateJobs()) {
    assert.ok(job.precision_usage_user_id, `${scenario}: an immutable subject is always present`);
    assert.equal(candidates.fetchJobBelongsToUser(job, AUDIT_USER), true, scenario);
    assert.equal(
      candidates.fetchJobBelongsToUser(job, { id: 'user_immutable_other', email: AUDIT_USER.email }),
      false,
      `${scenario}: a matching email cannot claim the job`
    );
  }
});

test('PR66-H-10 a job is still refused for any subject other than its owner', () => {
  const stranger = { id: 'user_immutable_stranger', email: 'stranger@example.com' };
  for (const { scenario, job } of candidateJobs()) {
    const outcome = runPr66HandlerChain(job, stranger);
    assert.equal(outcome.accepted, false, `${scenario}: delegated access remains denied by design`);
    assert.ok(['fetch_job_owner_mismatch', 'fetch_job_workspace_mismatch'].includes(outcome.rejection), scenario);
  }
});
