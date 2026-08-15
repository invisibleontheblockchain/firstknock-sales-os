import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProspect } from '../scripts/prospecting/lib/pipeline.mjs';
import {
  createVerificationPlan,
  isEligibleForVerification,
  mergeVerifiedRecords,
  suppressionMatch,
} from '../scripts/prospecting/lib/run-safety.mjs';

const emptySuppression = { emails: new Map(), domains: new Map() };

function contact(overrides = {}) {
  return normalizeProspect({
    id: 'person-1',
    first_name: 'Jordan',
    last_name: 'Example',
    title: 'Owner',
    email: 'jordan@desertpest.example',
    email_status: 'verified',
    residential_evidence: 'Residential pest-control services page',
    residential_evidence_url: 'https://desertpest.example/residential',
    d2d_evidence: 'Canvassing representative job listing',
    d2d_evidence_url: 'https://desertpest.example/careers/canvassing',
    target_company_id: 'org-1',
    person_organization_id: 'org-1',
    organization: {
      name: 'Desert Pest Example',
      primary_domain: 'desertpest.example',
      estimated_num_employees: 18,
    },
    ...overrides,
  });
}

test('suppressed records are blocked before any verifier plan', () => {
  const record = contact();
  const suppression = {
    emails: new Map([[record.email, { reason: 'recipient opted out' }]]),
    domains: new Map(),
  };
  assert.equal(suppressionMatch(record, suppression).source, 'email');
  assert.equal(isEligibleForVerification(record, suppression), false);
  assert.deepEqual(createVerificationPlan([record], suppression, { provider: 'hunter' }).selectedIndexes, []);
});

test('email subdomain and parent-company domain suppressions both block provider calls', () => {
  const record = contact({ email: 'jordan@mail.desertpest.example' });
  const emailSubdomainSuppression = {
    emails: new Map(),
    domains: new Map([['mail.desertpest.example', { reason: 'mail subdomain suppressed' }]]),
  };
  assert.equal(suppressionMatch(record, emailSubdomainSuppression).source, 'email_domain');
  assert.equal(isEligibleForVerification(record, emailSubdomainSuppression), false);

  const parentSuppression = {
    emails: new Map(),
    domains: new Map([['desertpest.example', { reason: 'company suppressed' }]]),
  };
  assert.equal(suppressionMatch(record, parentSuppression).source, 'company_domain');
  assert.equal(isEligibleForVerification(record, parentSuppression), false);
});

test('imported opt-outs are never disclosed to a verifier', () => {
  const record = contact({ opted_out_at: '2026-08-01T00:00:00Z' });
  assert.equal(suppressionMatch(record, emptySuppression).source, 'imported');
  assert.equal(isEligibleForVerification(record, emptySuppression), false);
});

test('verification requires an exact spend confirmation and respects the cap', () => {
  const records = [contact(), contact({ id: 'person-2', email: 'alex@desertpest.example' })];
  assert.throws(
    () => createVerificationPlan(records, emptySuppression, { provider: 'hunter', maxCalls: 1 }),
    /confirm-verification-spend/,
  );
  const plan = createVerificationPlan(records, emptySuppression, {
    provider: 'hunter',
    maxCalls: 1,
    confirmedCalls: 1,
  });
  assert.deepEqual(plan.selectedIndexes, [0]);
  assert.equal(plan.eligibleCount, 2);
  assert.equal(plan.deferredCount, 1);
});

test('only named, aligned, current-employer business emails reach verification', () => {
  assert.equal(isEligibleForVerification(contact(), emptySuppression), true);
  assert.equal(isEligibleForVerification(contact({ email: 'info@desertpest.example' }), emptySuppression), false);
  assert.equal(isEligibleForVerification(contact({ email: 'jordan@gmail.com' }), emptySuppression), false);
  assert.equal(isEligibleForVerification(contact({ target_company_id: 'org-1', person_organization_id: 'org-2' }), emptySuppression), false);
  assert.equal(isEligibleForVerification(contact({ email_status: 'unverified' }), emptySuppression), false);
});

test('verified results merge only into their approved positions', () => {
  const first = contact();
  const second = contact({ id: 'person-2', email: 'alex@desertpest.example' });
  const verified = { ...second, verification_status: 'deliverable' };
  const merged = mergeVerifiedRecords([first, second], [1], [verified]);
  assert.equal(merged[0], first);
  assert.equal(merged[1].verification_status, 'deliverable');
  assert.throws(() => mergeVerifiedRecords([first], [0], []), /different number/);
});
