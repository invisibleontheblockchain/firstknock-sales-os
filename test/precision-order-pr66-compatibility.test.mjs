// MODEL 1 / PR A — PR A -> PR #66 compatibility characterization.
//
// Runs PR #66's ACTUAL validators (vendored byte-exact from its head SHA) over
// the golden FetchJobs that main's Stage 0-4 code produces. PR #66 itself is
// never modified, merged or checked out.
//
// See docs/precision/pr-a-model-1/PR_A_TO_PR66_COMPATIBILITY.md.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { AUDIT_USER } from './helpers/precisionOrderHarness.mjs';
import {
  PR66_MANIFEST,
  loadCandidateValidators,
  loadSharedCriteriaModule,
  verifyVendoredIntegrity
} from './helpers/pr66Validators.mjs';

const FETCHJOB_DIR = resolve(process.cwd(), 'test/fixtures/precision/order-to-fetchjob/fetchjobs');

function goldenFetchJobs() {
  return readdirSync(FETCHJOB_DIR).sort().map((file) => ({
    scenario: file.replace(/\.fetchjob\.json$/, ''),
    job: JSON.parse(readFileSync(resolve(FETCHJOB_DIR, file), 'utf8'))
  }));
}

const shared = loadSharedCriteriaModule();
const candidates = loadCandidateValidators(shared);

const DEFAULT_ROUTE_TYPE_FILTERS = {
  propertyTypes: ['Single Family'],
  excludeCommercial: true,
  excludeCondos: true,
  excludeLand: true
};

/* ------------------------------------------------------------ provenance */

test('AR-C66-01 the vendored PR #66 source still matches the SHA it was extracted from', () => {
  const manifest = verifyVendoredIntegrity();
  assert.equal(manifest.pr_number, 66);
  assert.equal(manifest.pr_head_sha, '35396b50457e93fc3c5a1d838a23fae787c75fa6');
  assert.equal(manifest.hand_edited, false);
});

test('AR-C66-02 the vendored module exposes the real validator surface', () => {
  for (const name of [
    'PRECISION_CRITERIA_SCHEMA_VERSION',
    'PRECISION_PROVIDER_CONTRACT_VERSION',
    'buildExistingPrecisionCriteria',
    'buildRequestedPrecisionCriteria',
    'comparePrecisionCriteria',
    'precisionCriteriaSource',
    'precisionProviderContractVersion',
    'precisionWorkspaceIdentity'
  ]) {
    assert.ok(shared[name] !== undefined, `${name} is missing from the vendored shared module`);
  }
  assert.equal(shared.PRECISION_CRITERIA_SCHEMA_VERSION, 1);
  assert.equal(shared.PRECISION_PROVIDER_CONTRACT_VERSION, 1);
});

/* ------------------------------------------- classification of main's jobs */


/* --------------------------------------- the decisive workspace_id break */

/**
 * PR #66's handler does NOT feed the raw reconstruction straight into the
 * validator. For a legacy job with no persisted workspace, it first derives the
 * workspace from the immutable subject when that subject equals the
 * authenticated actor, and reports `workspace_verification:
 * 'derived_from_immutable_subject'`.
 *
 * This helper applies that same step so the audit measures PR #66's real
 * end-to-end outcome instead of one validator in isolation. The condition below
 * is asserted against PR #66's own source in AR-C66-05a, so it cannot drift
 * away from the code it models.
 */
function applyPr66LegacyWorkspaceDerivation(criteria, user) {
  const authenticatedWorkspaceId = candidates.getAuthenticatedWorkspaceId(user);
  const authenticatedImmutableUserId = String(user?.id || '').trim();
  if (
    !criteria.workspace_id &&
    authenticatedWorkspaceId &&
    criteria.immutable_user_id &&
    criteria.immutable_user_id === authenticatedImmutableUserId
  ) {
    return {
      criteria: { ...criteria, workspace_id: authenticatedWorkspaceId },
      workspace_verification: 'derived_from_immutable_subject'
    };
  }
  return { criteria, workspace_verification: null };
}


/* --------------------------------------- per-field reconstruction fidelity */


test('AR-C66-09 a max_since_last order started on the OTHER endpoint is silently reconstructed as new_area', () => {
  // The same C0 intent, submitted to fetchAreaProperties, persists nothing.
  // PR #66 then infers `new_area`, converting a previous-area refresh into an
  // ordinary pull without any field being reported as unverified.
  const areaJob = goldenFetchJobs().find((entry) => entry.scenario === 'fixed-below-allowance-fetchareaproperties').job;
  const spoofed = {
    ...areaJob,
    dry_run_metadata: { ...areaJob.dry_run_metadata }
  };
  const criteria = shared.buildExistingPrecisionCriteria(spoofed, { defaultRouteFilters: DEFAULT_ROUTE_TYPE_FILTERS });
  assert.equal(criteria.repull_mode, 'new_area');
  assert.equal(criteria.previous_pull_date, null);
  assert.equal(criteria.include_unresolved_followups, false);
  assert.ok(shared.LEGACY_UNVERIFIABLE_CRITERIA_FIELDS.includes('repull_mode'),
    'PR #66 does at least disclose repull_mode as unverifiable on the legacy path');
});

/* --------------------------------------- the two start paths disagree */

test('AR-C66-10 the SAME order through the two start paths yields DIFFERENT PR #66 criteria', () => {
  const jobs = Object.fromEntries(goldenFetchJobs().map(({ scenario, job }) => [scenario, job]));
  const viaStart = shared.buildExistingPrecisionCriteria(jobs['fixed-below-allowance'], {
    defaultRouteFilters: DEFAULT_ROUTE_TYPE_FILTERS
  });
  const viaArea = shared.buildExistingPrecisionCriteria(jobs['fixed-below-allowance-fetchareaproperties'], {
    defaultRouteFilters: DEFAULT_ROUTE_TYPE_FILTERS
  });

  const comparison = shared.comparePrecisionCriteria(viaStart, viaArea);
  assert.equal(comparison.matches, false);
  assert.deepEqual(comparison.mismatched_fields, ['min_price'],
    'the identical user order produces two different persisted price floors');
  assert.equal(viaStart.min_price, null);
  assert.equal(viaArea.min_price, 100000);
});

/* ------------------------------- what a downstream request must supply */

test('AR-C66-11 PR #66 requires the caller to restate workspace_id, which main never disclosed', () => {
  const missing = candidates.missingLegacyRouteCriteriaFields({
    polygon: [], sold_months: 3, ownership_range_mode: 'quick',
    requested_properties_before_cap: 25, requested_properties: 25, min_price: null
  }, 'quick');
  assert.deepEqual(missing, ['workspace_id'],
    'a request reconstructed purely from a main-created job is missing exactly one field');

  const invalid = candidates.invalidLegacyRequestedCriteriaFields({
    sold_months: 3, ownership_range_mode: 'quick',
    requested_properties_before_cap: 25, requested_properties: 25,
    min_price: null, workspace_id: null
  }, 'quick');
  assert.deepEqual(invalid, ['workspace_id']);
});

test('AR-C66-12 a non-integer effective count from main is rejected by the PR #66 request validator', () => {
  // main accepts requested_properties: 25.7 and reserves 25.7 (AR-S2-03).
  const invalid = candidates.invalidLegacyRequestedCriteriaFields({
    sold_months: 3, ownership_range_mode: 'quick',
    requested_properties_before_cap: 25.7, requested_properties: 25.7,
    min_price: null, workspace_id: 'user_immutable_1'
  }, 'quick');
  assert.deepEqual(invalid, ['requested_properties_before_cap', 'requested_properties'],
    'PR #66 requires whole numbers; main never enforces that');
});

test('AR-C66-13 legacy min_price null keeps its no-floor meaning and cannot be replaced by the modern default', () => {
  const legacyNoFloor = shared.buildRequestedPrecisionCriteria({
    polygon_hash: 'abc', sold_months: 3, ownership_range_mode: 'quick',
    entered_count: 25, effective_count: 25, min_price: null,
    immutable_user_id: 'user_immutable_1', workspace_id: 'user_immutable_1'
  });
  assert.deepEqual(candidates.invalidLegacyCriteriaFields(legacyNoFloor), [],
    'a null minimum is VALID legacy evidence');

  const modernDefault = shared.buildRequestedPrecisionCriteria({
    ...legacyNoFloor, min_price: 100000
  });
  const comparison = shared.comparePrecisionCriteria(modernDefault, legacyNoFloor, ['min_price']);
  assert.equal(comparison.matches, false,
    'supplying the modern $100,000 default for a no-floor legacy job fails closed');
});

/* ------------------------------------------- ownership identity checks */

test('AR-C66-14 PR #66 re-verifies job ownership by immutable subject, closing the email path main leaves open', () => {
  const jobs = goldenFetchJobs();
  const job = jobs[0].job;

  assert.equal(candidates.fetchJobBelongsToUser(job, AUDIT_USER), true);
  assert.equal(candidates.fetchJobBelongsToUser(job, { id: 'user_immutable_other', email: AUDIT_USER.email }), false,
    'a matching email cannot claim a job whose immutable subject differs');

  const emailOnlyJob = { ...job };
  delete emailOnlyJob.precision_usage_user_id;
  assert.equal(candidates.fetchJobBelongsToUser(emailOnlyJob, { id: 'anyone', email: AUDIT_USER.email }), true,
    'but a job with NO immutable subject still falls back to email');
});

/* ------------------------------------ active-job selection determinism */

test('AR-C66-15 PR #66 selects the newest active job deterministically; main reads an unsorted index 0', async () => {
  const rows = {
    running: [
      { id: 'job_old', status: 'running', created_date: '2026-07-26T10:00:00.000Z', precision_usage_user_id: AUDIT_USER.id },
      { id: 'job_new', status: 'running', created_date: '2026-07-26T11:00:00.000Z', precision_usage_user_id: AUDIT_USER.id }
    ],
    pending: []
  };
  const base44 = {
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async (filter) => (filter.status === 'running' ? rows.running : rows.pending)
        }
      }
    }
  };
  const selected = await shared.findActivePrecisionJob(base44, AUDIT_USER);
  assert.equal(selected.id, 'job_new', 'PR #66 sorts by created_date descending with an id tiebreak');
});

/* --------------------------------------- summary artefact for Model 2 */

/* ═══════════ SUPERSEDED BY PR A ═══════════
 * These pinned the PRE-PR-A handoff, where every job was legacy and needed
 * PR #66 to derive its workspace. PR A persists workspace, versions and a
 * criteria snapshot, so the handoff contract now lives in
 * test/precision-order-pr66-handoff.test.mjs. Originals are preserved on
 * audit/precision-order-control-model-1 @ 0c3fd666.
 *
 *   AR-C66-03 -> PR66-H-06
 *   AR-C66-04 -> PR66-H-05
 *   AR-C66-05a -> PR66-H-04
 *   AR-C66-05b -> PR66-H-03
 *   AR-C66-05c -> PR66-H-10
 *   AR-C66-06 -> PR66-H-06
 *   AR-C66-07 -> PR66-H-07
 *   AR-C66-08 -> PR66-H-08
 *   AR-C66-16 -> PR66-H-03
 * ══════════════════════════════════════════ */
