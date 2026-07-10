const ACTIVE_FETCH_JOB_STATUSES = new Set(['pending', 'running']);

function finiteTimestamp(value) {
    const timestamp = new Date(value || '').getTime();
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function lockActivityTimestamp(lock) {
    const timestamp = new Date(lock?.locked_at || lock?.created_date || '').getTime();
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function lockCreationTimestamp(lock) {
    const createdDate = finiteTimestamp(lock?.created_date);
    return createdDate !== Number.MAX_SAFE_INTEGER ? createdDate : finiteTimestamp(lock?.created_at);
}

export function isActivePipelineLock(lock, nowMs, ttlMs) {
    const timestamp = lockActivityTimestamp(lock);
    return timestamp !== Number.MAX_SAFE_INTEGER && nowMs - timestamp <= ttlMs;
}

function comparePipelineLocks(left, right) {
    const timeDifference = lockCreationTimestamp(left) - lockCreationTimestamp(right);
    if (timeDifference !== 0) return timeDifference;

    const leftId = String(left?.id || '');
    const rightId = String(right?.id || '');
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
}

export function electCanonicalPipelineLock(locks, { nowMs = Date.now(), ttlMs }) {
    const byId = new Map();
    for (const lock of Array.isArray(locks) ? locks : []) {
        const id = String(lock?.id || '');
        if (!id || !isActivePipelineLock(lock, nowMs, ttlMs)) continue;
        const existing = byId.get(id);
        if (!existing || lockCreationTimestamp(lock) < lockCreationTimestamp(existing)) byId.set(id, lock);
    }
    return [...byId.values()].sort(comparePipelineLocks)[0] || null;
}

function fetchJobCreationTimestamp(job) {
    const createdDate = finiteTimestamp(job?.created_date);
    return createdDate !== Number.MAX_SAFE_INTEGER ? createdDate : finiteTimestamp(job?.created_at);
}

function fetchJobStatusRank(job) {
    if (job?.status === 'running') return 0;
    if (job?.status === 'pending') return 1;
    return 2;
}

function compareProcessingFetchJobs(left, right) {
    const statusDifference = fetchJobStatusRank(left) - fetchJobStatusRank(right);
    if (statusDifference !== 0) return statusDifference;

    const timeDifference = fetchJobCreationTimestamp(left) - fetchJobCreationTimestamp(right);
    if (timeDifference !== 0) return timeDifference;

    const leftId = String(left?.id || '');
    const rightId = String(right?.id || '');
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
}

export function electCanonicalProcessingFetchJob(jobs) {
    const byId = new Map();
    for (const job of Array.isArray(jobs) ? jobs : []) {
        const id = String(job?.id || '');
        if (!id || !ACTIVE_FETCH_JOB_STATUSES.has(job?.status)) continue;

        const existing = byId.get(id);
        if (!existing || fetchJobCreationTimestamp(job) < fetchJobCreationTimestamp(existing)) byId.set(id, job);
    }
    return [...byId.values()].sort(compareProcessingFetchJobs)[0] || null;
}

export async function resolveProcessingFetchJobElection({
    processingJob,
    contenders,
    electionKey,
    cancelOwnJob
}) {
    const canonicalJob = electCanonicalProcessingFetchJob([
        processingJob,
        ...(Array.isArray(contenders) ? contenders : [])
    ]);
    if (!canonicalJob) {
        const cancelledOwnJob = await Promise.resolve(cancelOwnJob(processingJob, null, 'unverified')).catch(() => false);
        return {
            isWinner: false,
            reason: cancelledOwnJob === false ? 'fetch_job_election_unverified_cleanup_failed' : 'fetch_job_election_unverified',
            cancelledOwnJob: cancelledOwnJob !== false,
            canonicalJob: null
        };
    }

    if (String(canonicalJob.id) === String(processingJob?.id)) {
        return { isWinner: true, canonicalJob, cancelledOwnJob: false };
    }

    const canonicalElectionKey = canonicalJob?.dry_run_metadata?.pull_election_key || null;
    const sameCriteria = !!electionKey && canonicalElectionKey === electionKey;
    const cancellationReason = sameCriteria ? 'duplicate' : 'conflict';
    const cancelledOwnJob = await Promise.resolve(cancelOwnJob(processingJob, canonicalJob, cancellationReason)).catch(() => false);
    return {
        isWinner: false,
        reason: cancelledOwnJob === false
            ? (sameCriteria ? 'duplicate_fetch_job_cleanup_failed' : 'different_fetch_job_cleanup_failed')
            : (sameCriteria ? 'duplicate_fetch_job' : 'different_fetch_job_already_active'),
        cancelledOwnJob: cancelledOwnJob !== false,
        canonicalJob,
        relationship: sameCriteria ? 'exact_duplicate' : 'different_criteria'
    };
}

export async function resolveCreatedPipelineLockElection({
    createdLock,
    contenders,
    nowMs = Date.now(),
    ttlMs,
    releaseOwnLock
}) {
    const canonicalLock = electCanonicalPipelineLock(
        [createdLock, ...(Array.isArray(contenders) ? contenders : [])],
        { nowMs, ttlMs }
    );
    if (!canonicalLock) {
        const releasedOwnLock = await Promise.resolve(releaseOwnLock(createdLock?.id)).catch(() => false);
        return {
            claimed: false,
            reason: releasedOwnLock === false ? 'lock_election_unverified_cleanup_failed' : 'lock_election_unverified',
            releasedOwnLock: releasedOwnLock !== false
        };
    }

    if (String(canonicalLock.id) === String(createdLock?.id)) {
        return { claimed: true, lockId: createdLock.id, canonicalLock, releasedOwnLock: false };
    }

    const releasedOwnLock = await Promise.resolve(releaseOwnLock(createdLock.id)).catch(() => false);
    return {
        claimed: false,
        reason: releasedOwnLock === false ? 'lost_lock_election_cleanup_failed' : 'lost_lock_election',
        lockedBy: canonicalLock.locked_by,
        canonicalLockId: canonicalLock.id,
        releasedOwnLock: releasedOwnLock !== false
    };
}
