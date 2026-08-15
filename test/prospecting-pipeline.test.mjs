import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dedupeProspects,
  evaluateProspect,
  extractRecords,
  isCompanyDomainEmail,
  normalizeDomain,
  normalizeProspect,
  rankDecisionMaker,
  selectOneContactPerCompany,
  splitProspects,
} from '../scripts/prospecting/lib/pipeline.mjs';
import { requestJson } from '../scripts/prospecting/lib/http.mjs';

const emptySuppression = { emails: new Map(), domains: new Map() };

function readyProspect(overrides = {}) {
  return normalizeProspect({
    id: 'person-1',
    first_name: 'Jordan',
    last_name: 'Example',
    title: 'Owner',
    email: 'jordan@desertpest.example',
    email_status: 'verified',
    verification_status: 'deliverable',
    verifier_provider: 'fixture',
    residential_evidence: 'Residential pest-control services page',
    residential_evidence_url: 'https://desertpest.example/residential',
    d2d_evidence: 'Canvassing representative job listing',
    d2d_evidence_url: 'https://desertpest.example/careers/canvassing',
    current_employer_confirmed: true,
    target_company_id: 'org-1',
    person_organization_id: 'org-1',
    organization_id: 'org-1',
    organization: {
      id: 'org-1',
      name: 'Desert Pest Example',
      primary_domain: 'desertpest.example',
      estimated_num_employees: 18,
      country: 'United States',
    },
    ...overrides,
  });
}

test('normalizes domains and requires company-domain email alignment', () => {
  assert.equal(normalizeDomain('https://www.Example.com/path'), 'example.com');
  assert.equal(isCompanyDomainEmail('person@mail.example.com', 'example.com'), true);
  assert.equal(isCompanyDomainEmail('person@gmail.com', 'example.com'), false);
});

test('ranks decision makers differently for small and larger companies', () => {
  assert.ok(rankDecisionMaker('Owner / Operator', 12).score > rankDecisionMaker('Sales Manager', 12).score);
  assert.ok(rankDecisionMaker('VP of Sales', 60).score > rankDecisionMaker('Owner', 60).score);
  assert.equal(rankDecisionMaker('Former Sales Consultant', 20).score, 0);
});

test('extracts records from Apollo and connector response envelopes', () => {
  assert.equal(extractRecords({ matches: [{ id: 1 }] }).length, 1);
  assert.equal(extractRecords({ data: { people: [{ id: 2 }] } }).length, 1);
  assert.equal(extractRecords({ structuredContent: { matches: [{ id: 4 }] } }).length, 1);
  assert.equal(extractRecords({ content: [{ type: 'text', text: '{"contacts":[{"id":3}]}' }] }).length, 1);
});

test('does not infer current employment from an uncorroborated organization id', () => {
  const prospect = normalizeProspect({
    organization_id: 'person-org',
    company_name: 'Uncorroborated Example',
    company_domain: 'uncorroborated.example',
    title: 'Owner',
    email: 'owner@uncorroborated.example',
    email_status: 'verified',
    verification_status: 'deliverable',
  });
  const evaluated = evaluateProspect(prospect, emptySuppression);
  assert.equal(prospect.current_employer_confirmed, false);
  assert.equal(evaluated.status, 'review');
  assert.match(evaluated.review_notes, /current employer not confirmed/);
});

test('ready status requires independent delivery verification and no review flags', () => {
  const prospect = evaluateProspect(readyProspect(), emptySuppression);
  assert.equal(prospect.status, 'ready');
  assert.equal(prospect.ready_to_contact, true);

  const noIndependentVerification = evaluateProspect(readyProspect({ verification_status: 'not_checked' }), emptySuppression);
  assert.equal(noIndependentVerification.status, 'review');
  assert.match(noIndependentVerification.review_notes, /independent verification required/);
});

test('personal, disposable, invalid, and suppressed addresses cannot become ready', () => {
  const free = evaluateProspect(readyProspect({ email: 'owner@gmail.com' }), emptySuppression);
  assert.equal(free.status, 'rejected');

  const invalid = evaluateProspect(readyProspect({ verification_status: 'invalid' }), emptySuppression);
  assert.equal(invalid.status, 'rejected');

  const suppression = {
    emails: new Map([['jordan@desertpest.example', { reason: 'opted out', optedOutAt: '2026-08-01' }]]),
    domains: new Map(),
  };
  const suppressed = evaluateProspect(readyProspect(), suppression);
  assert.equal(suppressed.status, 'rejected');
  assert.equal(suppressed.suppression_reason, 'opted out');
});

test('contradictory employer evidence overrides an imported positive flag', () => {
  const contradictory = evaluateProspect(readyProspect({
    current_employer_confirmed: true,
    target_company_id: 'target-org',
    person_organization_id: 'different-org',
    target_company_domain: 'desertpest.example',
    person_organization_domain: 'other.example',
  }), emptySuppression);
  assert.equal(contradictory.current_employer_confirmed, false);
  assert.equal(contradictory.status, 'review');
  assert.match(contradictory.review_notes, /current employer not confirmed/);
});

test('generic and catch-all mailboxes are held for review', () => {
  const generic = evaluateProspect(readyProspect({ email: 'info@desertpest.example' }), emptySuppression);
  assert.equal(generic.status, 'review');
  assert.match(generic.review_notes, /generic role mailbox/);

  const catchAll = evaluateProspect(readyProspect({ verification_status: 'catch_all' }), emptySuppression);
  assert.equal(catchAll.status, 'review');
  assert.match(catchAll.review_notes, /catch-all/);
});

test('deduplication keeps the better-ranked person record', () => {
  const rows = dedupeProspects([
    readyProspect({ title: 'Sales Manager' }),
    readyProspect({ title: 'Owner' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contact_title, 'Owner');
});

test('selects only the highest-ranked initial contact for each company', () => {
  const contacts = selectOneContactPerCompany([
    readyProspect({ id: 'person-sales', email: 'sales.manager@desertpest.example', title: 'Sales Manager' }),
    readyProspect({ id: 'person-owner', email: 'owner@desertpest.example', title: 'Owner' }),
    readyProspect({
      id: 'person-other-company',
      email: 'owner@metrobug.example',
      title: 'Owner',
      organization_id: 'org-2',
      target_company_id: 'org-2',
      person_organization_id: 'org-2',
      organization: {
        id: 'org-2',
        name: 'Metro Bug Example',
        primary_domain: 'metrobug.example',
        estimated_num_employees: 12,
      },
    }),
  ]);
  assert.equal(contacts.length, 2);
  assert.equal(contacts.find((record) => record.company_domain === 'desertpest.example').contact_title, 'Owner');
});

test('company-domain aliases still select only one initial contact', () => {
  const contacts = selectOneContactPerCompany([
    readyProspect({ id: 'person-id-keyed', email: 'owner@desertpest.example' }),
    readyProspect({
      id: 'person-domain-keyed',
      email: 'sales.manager@desertpest.example',
      title: 'Sales Manager',
      target_company_id: '',
      source_company_id: '',
      person_organization_id: '',
      organization_id: '',
    }),
  ]);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].contact_title, 'Owner');
});

test('splitProspects separates ready, review, and rejected outputs', () => {
  const split = splitProspects([
    readyProspect(),
    readyProspect({ id: 'person-2', email: 'info@desertpest.example' }),
    readyProspect({ id: 'person-3', email: 'someone@gmail.com' }),
  ], emptySuppression);
  assert.equal(split.ready.length, 1);
  assert.equal(split.review.length, 1);
  assert.equal(split.rejected.length, 1);
});

test('HTTP helper retries rate limits without leaking request credentials', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '0' } });
    return Response.json({ ok: true });
  };
  const result = await requestJson('https://provider.example/test', {
    headers: { 'x-api-key': 'not-logged' },
  }, { fetchImpl, retries: 1, timeoutMs: 1_000 });
  assert.equal(calls, 2);
  assert.equal(result.body.ok, true);
});
