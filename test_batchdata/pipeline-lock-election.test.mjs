import test from 'node:test';
import assert from 'node:assert/strict';

import {
    electCanonicalProcessingFetchJob,
    electCanonicalPipelineLock,
    isActivePipelineLock,
    resolveCreatedPipelineLockElection,
    resolveProcessingFetchJobElection
} from '../base44/functions/processFetchChunk/pipelineLockElectionLogic.js';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');
const TTL = 8 * 60 * 1000;

function lock(id, lockedAt, overrides = {}) {
    return { id, job_id: 'job-1', locked_at: lockedAt, created_date: lockedAt, locked_by: `worker-${id}`, ...overrides };
}

test('expired pipeline locks are excluded from deterministic election', () => {
    const expired = lock('expired', '2026-07-10T11:51:59.999Z');
    const active = lock('active', '2026-07-10T11:59:00.000Z');
    assert.equal(isActivePipelineLock(expired, NOW, TTL), false);
    assert.equal(isActivePipelineLock(active, NOW, TTL), true);
    assert.equal(electCanonicalPipelineLock([expired, active], { nowMs: NOW, ttlMs: TTL })?.id, active.id);
});

test('simultaneous lock creators elect the earliest lock independently of input order', () => {
    const earlier = lock('lock-b', '2026-07-10T11:59:59.000Z');
    const later = lock('lock-a', '2026-07-10T11:59:59.001Z');
    assert.equal(electCanonicalPipelineLock([later, earlier], { nowMs: NOW, ttlMs: TTL })?.id, earlier.id);
    assert.equal(electCanonicalPipelineLock([earlier, later], { nowMs: NOW, ttlMs: TTL })?.id, earlier.id);
});

test('same-time pipeline locks use entity id as a deterministic tie-breaker', () => {
    const timestamp = '2026-07-10T11:59:59.000Z';
    assert.equal(electCanonicalPipelineLock([
        lock('lock-b', timestamp),
        lock('lock-a', timestamp)
    ], { nowMs: NOW, ttlMs: TTL })?.id, 'lock-a');
});

test('pipeline election follows entity creation order rather than pre-create lock timestamps', () => {
    const createdFirst = lock('lock-z', '2026-07-10T11:59:59.500Z', { created_date: '2026-07-10T11:59:59.600Z' });
    const requestedFirstButCreatedLater = lock('lock-a', '2026-07-10T11:59:59.000Z', { created_date: '2026-07-10T11:59:59.700Z' });
    assert.equal(
        electCanonicalPipelineLock([requestedFirstButCreatedLater, createdFirst], { nowMs: NOW, ttlMs: TTL })?.id,
        createdFirst.id
    );
});

test('post-create lock loser releases only its own lock', async () => {
    const canonical = lock('lock-a', '2026-07-10T11:59:59.000Z');
    const created = lock('lock-b', '2026-07-10T11:59:59.001Z');
    const released = [];
    const result = await resolveCreatedPipelineLockElection({
        createdLock: created,
        contenders: [created, canonical],
        nowMs: NOW,
        ttlMs: TTL,
        releaseOwnLock: async id => { released.push(id); return true; }
    });

    assert.equal(result.claimed, false);
    assert.equal(result.reason, 'lost_lock_election');
    assert.equal(result.canonicalLockId, canonical.id);
    assert.deepEqual(released, [created.id]);
});

test('post-create lock winner proceeds without releasing a contender lock', async () => {
    const created = lock('lock-a', '2026-07-10T11:59:59.000Z');
    let releaseCalls = 0;
    const result = await resolveCreatedPipelineLockElection({
        createdLock: created,
        contenders: [lock('lock-b', '2026-07-10T11:59:59.001Z')],
        nowMs: NOW,
        ttlMs: TTL,
        releaseOwnLock: async () => { releaseCalls += 1; return true; }
    });

    assert.equal(result.claimed, true);
    assert.equal(result.lockId, created.id);
    assert.equal(releaseCalls, 0);
});

test('a lock loser fails closed when its cleanup cannot be confirmed', async () => {
    const canonical = lock('lock-a', '2026-07-10T11:59:59.000Z');
    const created = lock('lock-b', '2026-07-10T11:59:59.001Z');
    const result = await resolveCreatedPipelineLockElection({
        createdLock: created,
        contenders: [canonical],
        nowMs: NOW,
        ttlMs: TTL,
        releaseOwnLock: async () => false
    });
    assert.equal(result.claimed, false);
    assert.equal(result.reason, 'lost_lock_election_cleanup_failed');
});

function processingJob(id, createdDate, key, overrides = {}) {
    return {
        id,
        user_email: 'manager@example.com',
        status: 'pending',
        created_date: createdDate,
        dry_run_metadata: { pull_election_key: key },
        ...overrides
    };
}

test('processor backstop elects the same exact-job winner by entity creation order', () => {
    const key = 'exact-pull';
    const canonical = processingJob('job-z', '2026-07-10T11:59:59.000Z', key);
    const duplicate = processingJob('job-a', '2026-07-10T11:59:59.001Z', key);
    assert.equal(electCanonicalProcessingFetchJob([duplicate, canonical])?.id, canonical.id);
});

test('processor backstop elects one active job across different criteria', () => {
    const canonical = processingJob('job-a', '2026-07-10T11:59:59.000Z', 'area-a');
    const different = processingJob('job-b', '2026-07-10T11:59:59.001Z', 'area-b');
    assert.equal(electCanonicalProcessingFetchJob([different, canonical])?.id, canonical.id);
});

test('processor backstop cancels a duplicate job before provider work', async () => {
    const key = 'exact-pull';
    const canonical = processingJob('job-a', '2026-07-10T11:59:59.000Z', key);
    const duplicate = processingJob('job-b', '2026-07-10T11:59:59.001Z', key);
    const cancelled = [];
    const result = await resolveProcessingFetchJobElection({
        processingJob: duplicate,
        contenders: [canonical, duplicate],
        electionKey: key,
        cancelOwnJob: async (loser, winner, reason) => {
            cancelled.push({ loser: loser.id, winner: winner.id, reason });
            return true;
        }
    });
    assert.equal(result.isWinner, false);
    assert.equal(result.reason, 'duplicate_fetch_job');
    assert.equal(result.canonicalJob.id, canonical.id);
    assert.deepEqual(cancelled, [{ loser: duplicate.id, winner: canonical.id, reason: 'duplicate' }]);
});

test('processor backstop fails closed when duplicate cancellation cannot be confirmed', async () => {
    const key = 'exact-pull';
    const canonical = processingJob('job-a', '2026-07-10T11:59:59.000Z', key);
    const duplicate = processingJob('job-b', '2026-07-10T11:59:59.001Z', key);
    const result = await resolveProcessingFetchJobElection({
        processingJob: duplicate,
        contenders: [canonical],
        electionKey: key,
        cancelOwnJob: async () => false
    });
    assert.equal(result.isWinner, false);
    assert.equal(result.reason, 'duplicate_fetch_job_cleanup_failed');
});

test('processor backstop cancels a different-criteria loser before provider work', async () => {
    const canonical = processingJob('job-a', '2026-07-10T11:59:59.000Z', 'area-a');
    const different = processingJob('job-b', '2026-07-10T11:59:59.001Z', 'area-b');
    const cancelled = [];
    const result = await resolveProcessingFetchJobElection({
        processingJob: different,
        contenders: [canonical],
        electionKey: 'area-b',
        cancelOwnJob: async (loser, winner, reason) => {
            cancelled.push({ loser: loser.id, winner: winner.id, reason });
            return true;
        }
    });
    assert.equal(result.isWinner, false);
    assert.equal(result.reason, 'different_fetch_job_already_active');
    assert.equal(result.relationship, 'different_criteria');
    assert.deepEqual(cancelled, [{ loser: different.id, winner: canonical.id, reason: 'conflict' }]);
});

test('legacy jobs without an election key still participate in global processor election', async () => {
    const legacy = processingJob('legacy', '2026-07-10T11:59:59.000Z', null, { dry_run_metadata: {} });
    const modern = processingJob('modern', '2026-07-10T11:59:59.001Z', 'modern-key');
    const result = await resolveProcessingFetchJobElection({
        processingJob: modern,
        contenders: [legacy],
        electionKey: 'modern-key',
        cancelOwnJob: async () => true
    });
    assert.equal(result.isWinner, false);
    assert.equal(result.reason, 'different_fetch_job_already_active');
    assert.equal(result.canonicalJob.id, legacy.id);
});
