import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enrichApolloPeople,
  searchApolloOrganizations,
  searchApolloPeople,
  verifyRecords,
  verifyWithHunter,
} from '../scripts/prospecting/lib/providers.mjs';

const noDelay = async () => {};

test('paid Apollo organization search never retries and exposes reserved credit metadata', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ error: 'temporary' }, { status: 503 });
  };
  await assert.rejects(searchApolloOrganizations({
    apiKey: 'test-key',
    markets: ['Phoenix, Arizona'],
    employeeRanges: ['5,30'],
    keywords: ['pest control'],
    maxCompanies: 10,
    fetchImpl,
  }), /HTTP 503/);
  assert.equal(calls, 1);

  const success = await searchApolloOrganizations({
    apiKey: 'test-key',
    markets: ['Phoenix, Arizona'],
    employeeRanges: ['5,30'],
    keywords: ['pest control'],
    maxCompanies: 10,
    fetchImpl: async () => Response.json({ organizations: [{ id: 'org-1', primary_domain: 'example.com' }] }),
  });
  assert.equal(success.organizations.length, 1);
  assert.equal(success.usage.reservedCredits, 1);
  assert.equal(success.usage.creditsConsumed, null);
  assert.equal(success.usage.requestCount, 1);
});

test('paid Apollo enrichment never retries and uses authoritative credits_consumed', async () => {
  const candidates = [
    { person: { id: 'person-1' } },
    { person: { id: 'person-2' } },
  ];
  let failedCalls = 0;
  await assert.rejects(enrichApolloPeople({
    apiKey: 'test-key',
    candidates,
    maxCredits: 2,
    fetchImpl: async () => {
      failedCalls += 1;
      return Response.json({ error: 'temporary' }, { status: 500 });
    },
  }), /HTTP 500/);
  assert.equal(failedCalls, 1);

  const result = await enrichApolloPeople({
    apiKey: 'test-key',
    candidates,
    maxCredits: 2,
    fetchImpl: async () => Response.json({
      credits_consumed: 2,
      matches: [{ id: 'person-1' }, { id: 'person-2' }],
    }),
  });
  assert.equal(result.people.length, 2);
  assert.deepEqual(result.usage, {
    reservedCredits: 2,
    creditsConsumed: 2,
    reportedCreditsConsumed: 2,
    requestCount: 1,
    batchCount: 1,
  });
});

test('Apollo People Search paginates until every organization has a ranked candidate', async () => {
  const organizations = [
    { id: 'org-1', estimated_num_employees: 10 },
    { id: 'org-2', estimated_num_employees: 60 },
  ];
  const requestedPages = [];
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    requestedPages.push(page);
    if (page === 1) {
      return Response.json({
        total_entries: 4,
        people: [
          { id: 'p-1', organization_id: 'org-1', title: 'Owner' },
          { id: 'p-irrelevant', organization_id: 'org-1', title: 'Technician' },
        ],
      });
    }
    return Response.json({
      total_entries: 4,
      people: [
        { id: 'p-2', organization_id: 'org-2', title: 'VP of Sales' },
        { id: 'p-other', organization_id: 'org-2', title: 'Technician' },
      ],
    });
  };
  const result = await searchApolloPeople({
    apiKey: 'test-key',
    organizations,
    titles: ['Owner', 'VP of Sales'],
    seniorities: ['owner', 'vp'],
    perPage: 2,
    maxPagesPerBatch: 3,
    fetchImpl,
  });
  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.search.organizationsWithCandidates, 2);
  assert.equal(result.search.pageCapReached, false);
  assert.equal(result.usage.pageCount, 2);
});

test('Apollo People Search stops at its explicit safe page cap', async () => {
  let calls = 0;
  const result = await searchApolloPeople({
    apiKey: 'test-key',
    organizations: [{ id: 'org-1', estimated_num_employees: 10 }],
    titles: ['Owner'],
    seniorities: ['owner'],
    perPage: 1,
    maxPagesPerBatch: 2,
    fetchImpl: async () => {
      calls += 1;
      return Response.json({
        total_entries: 100,
        people: [{ id: `irrelevant-${calls}`, organization_id: 'org-1', title: 'Technician' }],
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.search.pageCapReached, true);
});

test('Hunter retries transient 403 but treats quota 429 as terminal', async () => {
  let transientCalls = 0;
  const transientResult = await verifyWithHunter('owner@example.com', {
    apiKey: 'test-key',
    delayImpl: noDelay,
    fetchImpl: async () => {
      transientCalls += 1;
      if (transientCalls === 1) return Response.json({ errors: [{ id: 'rate_limit' }] }, { status: 403 });
      return Response.json({ data: { status: 'valid', score: 100 } });
    },
  });
  assert.equal(transientCalls, 2);
  assert.equal(transientResult.verification_status, 'deliverable');

  let quotaCalls = 0;
  await assert.rejects(verifyWithHunter('owner@example.com', {
    apiKey: 'test-key',
    requestRetries: 5,
    delayImpl: noDelay,
    fetchImpl: async () => {
      quotaCalls += 1;
      return Response.json({ errors: [{ id: 'usage_limit' }] }, { status: 429 });
    },
  }), /HTTP 429/);
  assert.equal(quotaCalls, 1);
});

test('Hunter polls 202 responses and leaves 202/222 unfinished results unverified', async () => {
  let pollingCalls = 0;
  const completed = await verifyWithHunter('owner@example.com', {
    apiKey: 'test-key',
    pollDelayMs: 0,
    sleepImpl: noDelay,
    fetchImpl: async () => {
      pollingCalls += 1;
      if (pollingCalls === 1) return Response.json({ data: { status: 'pending' } }, { status: 202 });
      return Response.json({ data: { status: 'valid' } });
    },
  });
  assert.equal(pollingCalls, 2);
  assert.equal(completed.verification_status, 'deliverable');
  assert.ok(completed.verified_at);

  const stillPending = await verifyWithHunter('pending@example.com', {
    apiKey: 'test-key',
    maxPolls: 0,
    fetchImpl: async () => Response.json({}, { status: 202 }),
  });
  assert.equal(stillPending.verification_status, 'unknown');
  assert.equal(stillPending.verified_at, undefined);

  const smtpFailure = await verifyWithHunter('later@example.com', {
    apiKey: 'test-key',
    fetchImpl: async () => Response.json({}, { status: 222 }),
  });
  assert.equal(smtpFailure.verification_status, 'unknown');
  assert.equal(smtpFailure.verification_reason, 'remote_smtp_unexpected_response');
  assert.equal(smtpFailure.verified_at, undefined);
});

test('Hunter claimed_email becomes a per-record suppression and verification continues', async () => {
  let calls = 0;
  const records = await verifyRecords([
    { email: 'claimed@example.com', id: 'one' },
    { email: 'valid@example.com', id: 'two' },
  ], {
    provider: 'hunter',
    maxCalls: 2,
    hunter: {
      apiKey: 'test-key',
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json({ errors: [{ id: 'claimed_email', code: 451 }] }, { status: 451 });
        }
        return Response.json({ data: { status: 'valid' } });
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(records[0].verification_status, 'suppressed');
  assert.equal(records[0].suppression_status, 'suppressed');
  assert.match(records[0].suppression_reason, /claimed_email/);
  assert.equal(records[0].ready_to_contact, false);
  assert.equal(records[1].verification_status, 'deliverable');
});

test('verifier maxCalls refuses the entire run before the first provider call', async () => {
  let calls = 0;
  await assert.rejects(verifyRecords([
    { email: 'one@example.com' },
    { email: 'two@example.com' },
  ], {
    provider: 'hunter',
    maxCalls: 1,
    hunter: {
      apiKey: 'test-key',
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ data: { status: 'valid' } });
      },
    },
  }), (error) => error?.code === 'VERIFIER_CALL_CAP_EXCEEDED' && error?.plannedCalls === 2);
  assert.equal(calls, 0);
});
