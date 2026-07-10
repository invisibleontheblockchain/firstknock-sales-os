import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildPullElectionKey,
    coalescedFetchJobCancellationUpdate,
    conflictingFetchJobCancellationUpdate,
    electCanonicalActiveFetchJob,
    electCanonicalFetchJob,
    resolveCreatedFetchJobElection,
    unverifiedFetchJobElectionCancellationUpdate
} from '../base44/functions/startBatchDataPull/jobElectionLogic.js';

function electionKey(overrides = {}) {
    return buildPullElectionKey({
        polygonHash: 'polygon-1',
        soldMonths: 0.5,
        minPrice: 100000,
        maxPrice: null,
        requestedProperties: 25,
        countMode: 'fixed',
        routeFilters: { propertyTypes: ['Single Family'], excludeAssigned: true },
        includeUnresolvedFollowups: false,
        forceFullRefresh: false,
        repullMode: 'new_area',
        previousPullDate: null,
        ...overrides
    });
}

function job(id, createdDate, key, overrides = {}) {
    return {
        id,
        status: 'pending',
        created_date: createdDate,
        dry_run_metadata: { pull_election_key: key },
        ...overrides
    };
}

test('pull election key is stable for identical criteria and changes for a material criterion', () => {
    assert.equal(electionKey(), electionKey());
    assert.notEqual(electionKey(), electionKey({ previousPullDate: '2026-07-01' }));
    assert.notEqual(electionKey(), electionKey({ routeFilters: { propertyTypes: ['Single Family'], excludeAssigned: false } }));
});

test('simultaneous pending pulls elect the earliest job independently of input order', () => {
    const key = electionKey();
    const earlier = job('job-b', '2026-07-10T12:00:00.000Z', key);
    const later = job('job-a', '2026-07-10T12:00:00.001Z', key);
    assert.equal(electCanonicalFetchJob([later, earlier], key)?.id, earlier.id);
    assert.equal(electCanonicalFetchJob([earlier, later], key)?.id, earlier.id);
});

test('same-time pending pulls use the entity id as a deterministic tie-breaker', () => {
    const key = electionKey();
    const timestamp = '2026-07-10T12:00:00.000Z';
    assert.equal(electCanonicalFetchJob([
        job('job-b', timestamp, key),
        job('job-a', timestamp, key)
    ], key)?.id, 'job-a');
});

test('a contender with confirmed entity creation time beats a missing-time creator', () => {
    const key = electionKey();
    const missingCreationTime = job('job-a', null, key);
    const visibleCreationTime = job('job-z', '2026-07-10T12:00:00.000Z', key);
    assert.equal(electCanonicalFetchJob([missingCreationTime, visibleCreationTime], key)?.id, visibleCreationTime.id);
});

test('an already-running exact pull remains canonical over a pending contender', () => {
    const key = electionKey();
    const pending = job('pending', '2026-07-10T11:59:00.000Z', key);
    const running = job('running', '2026-07-10T12:00:00.000Z', key, { status: 'running' });
    assert.equal(electCanonicalFetchJob([pending, running], key)?.id, running.id);
});

test('post-create loser cancels only itself and returns the canonical job', async () => {
    const key = electionKey();
    const canonical = job('job-a', '2026-07-10T12:00:00.000Z', key);
    const created = job('job-b', '2026-07-10T12:00:00.001Z', key);
    const cancelled = [];

    const result = await resolveCreatedFetchJobElection({
        createdJob: created,
        contenders: [created, canonical, job('different', '2026-07-10T12:00:01.000Z', electionKey({ polygonHash: 'other' }))],
        electionKey: key,
        cancelOwnJob: async (loser, winner, relationship) => cancelled.push([loser.id, winner.id, relationship])
    });

    assert.equal(result.isWinner, false);
    assert.equal(result.canonicalJob.id, canonical.id);
    assert.deepEqual(cancelled, [[created.id, canonical.id, 'exact_duplicate']]);
    assert.equal(result.reason, 'duplicate_fetch_job');

    const update = coalescedFetchJobCancellationUpdate(created, canonical, Date.parse('2026-07-10T12:00:01.000Z'));
    assert.equal(update.status, 'cancelled');
    assert.equal(update.completed_at, '2026-07-10T12:00:01.000Z');
    assert.match(update.error_message, /job-a/);
});

test('different-criteria simultaneous pulls elect one global active job and return a conflict', async () => {
    const key = electionKey();
    const otherKey = electionKey({ polygonHash: 'other' });
    const canonical = job('job-a', '2026-07-10T12:00:00.000Z', key);
    const created = job('job-b', '2026-07-10T12:00:00.001Z', otherKey);
    const cancelled = [];

    assert.equal(electCanonicalActiveFetchJob([created, canonical])?.id, canonical.id);
    const result = await resolveCreatedFetchJobElection({
        createdJob: created,
        contenders: [canonical],
        electionKey: otherKey,
        cancelOwnJob: async (loser, winner, relationship) => cancelled.push([loser.id, winner.id, relationship])
    });

    assert.equal(result.isWinner, false);
    assert.equal(result.reason, 'different_fetch_job_already_active');
    assert.equal(result.relationship, 'different_criteria');
    assert.deepEqual(cancelled, [[created.id, canonical.id, 'different_criteria']]);

    const update = conflictingFetchJobCancellationUpdate(created, canonical, Date.parse('2026-07-10T12:00:01.000Z'));
    assert.equal(update.status, 'cancelled');
    assert.match(update.error_message, /different FetchJob job-a/);
});

test('an already-running different-criteria job wins the global election', () => {
    const pending = job('pending', '2026-07-10T11:59:00.000Z', electionKey());
    const running = job('running', '2026-07-10T12:00:00.000Z', electionKey({ polygonHash: 'other' }), { status: 'running' });
    assert.equal(electCanonicalActiveFetchJob([pending, running])?.id, running.id);
});

test('post-create winner proceeds without invoking cancellation', async () => {
    const key = electionKey();
    const created = job('job-a', '2026-07-10T12:00:00.000Z', key);
    let cancellationCalls = 0;
    const result = await resolveCreatedFetchJobElection({
        createdJob: created,
        contenders: [job('job-b', '2026-07-10T12:00:00.001Z', key)],
        electionKey: key,
        cancelOwnJob: async () => { cancellationCalls += 1; }
    });
    assert.equal(result.isWinner, true);
    assert.equal(result.canonicalJob.id, created.id);
    assert.equal(cancellationCalls, 0);
});

test('an unverified post-create election produces a terminal cancellation update', () => {
    const key = electionKey();
    const created = job('job-a', '2026-07-10T12:00:00.000Z', key);
    const update = unverifiedFetchJobElectionCancellationUpdate(
        created,
        'temporary read failure',
        Date.parse('2026-07-10T12:00:01.000Z')
    );
    assert.equal(update.status, 'cancelled');
    assert.equal(update.completed_at, '2026-07-10T12:00:01.000Z');
    assert.match(update.error_message, /temporary read failure/);
});
