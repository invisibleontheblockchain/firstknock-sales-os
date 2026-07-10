const ACTIVE_FETCH_JOB_STATUSES = new Set(['pending', 'running']);

function finiteTimestamp(value) {
    const timestamp = new Date(value || '').getTime();
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function creationTimestamp(job) {
    const createdDate = finiteTimestamp(job?.created_date);
    return createdDate !== Number.MAX_SAFE_INTEGER ? createdDate : finiteTimestamp(job?.created_at);
}

function statusRank(job) {
    if (job?.status === 'running') return 0;
    if (job?.status === 'pending') return 1;
    return 2;
}

function compareFetchJobs(left, right) {
    const statusDifference = statusRank(left) - statusRank(right);
    if (statusDifference !== 0) return statusDifference;

    const timeDifference = creationTimestamp(left) - creationTimestamp(right);
    if (timeDifference !== 0) return timeDifference;

    const leftId = String(left?.id || '');
    const rightId = String(right?.id || '');
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
}

export function buildPullElectionKey({
    polygonHash,
    soldMonths,
    minPrice,
    maxPrice,
    requestedProperties,
    countMode,
    routeFilters,
    includeUnresolvedFollowups,
    forceFullRefresh,
    repullMode,
    previousPullDate
}) {
    return JSON.stringify([
        'precision-pull-v1',
        String(polygonHash || ''),
        Number(soldMonths),
        Number(minPrice),
        maxPrice == null ? null : Number(maxPrice),
        Number(requestedProperties),
        countMode === 'max_available' ? 'max_available' : 'fixed',
        Array.isArray(routeFilters?.propertyTypes) ? routeFilters.propertyTypes.map(String) : [],
        routeFilters?.excludeAssigned !== false,
        includeUnresolvedFollowups === true,
        forceFullRefresh === true,
        String(repullMode || 'new_area'),
        previousPullDate || null
    ]);
}

export function electCanonicalFetchJob(jobs, electionKey) {
    return electCanonicalActiveFetchJob((Array.isArray(jobs) ? jobs : []).filter(
        job => job?.dry_run_metadata?.pull_election_key === electionKey
    ));
}

export function electCanonicalActiveFetchJob(jobs) {
    const byId = new Map();
    for (const job of Array.isArray(jobs) ? jobs : []) {
        const id = String(job?.id || '');
        if (!id || !ACTIVE_FETCH_JOB_STATUSES.has(job?.status)) continue;

        const existing = byId.get(id);
        if (!existing || creationTimestamp(job) < creationTimestamp(existing)) byId.set(id, job);
    }
    return [...byId.values()].sort(compareFetchJobs)[0] || null;
}

export function coalescedFetchJobCancellationUpdate(createdJob, canonicalJob, nowMs = Date.now()) {
    const cancelledAt = new Date(nowMs).toISOString();
    const message = `Duplicate pull coalesced into FetchJob ${canonicalJob.id}.`;
    return {
        status: 'cancelled',
        error_message: message,
        completed_at: cancelledAt,
        error_log: [...(createdJob?.error_log || []), `[${cancelledAt}] ${message}`]
    };
}

export function conflictingFetchJobCancellationUpdate(createdJob, canonicalJob, nowMs = Date.now()) {
    const cancelledAt = new Date(nowMs).toISOString();
    const message = `Pull cancelled because a different FetchJob ${canonicalJob.id} is already active.`;
    return {
        status: 'cancelled',
        error_message: message,
        completed_at: cancelledAt,
        error_log: [...(createdJob?.error_log || []), `[${cancelledAt}] ${message}`]
    };
}

export function unverifiedFetchJobElectionCancellationUpdate(createdJob, errorMessage, nowMs = Date.now()) {
    const cancelledAt = new Date(nowMs).toISOString();
    const message = `Pull cancelled because its post-create election could not be verified: ${errorMessage}`;
    return {
        status: 'cancelled',
        error_message: message,
        completed_at: cancelledAt,
        error_log: [...(createdJob?.error_log || []), `[${cancelledAt}] ${message}`]
    };
}

export async function resolveCreatedFetchJobElection({
    createdJob,
    contenders,
    electionKey,
    cancelOwnJob
}) {
    const canonicalJob = electCanonicalActiveFetchJob([createdJob, ...(Array.isArray(contenders) ? contenders : [])]);
    if (!canonicalJob) throw new Error('Created FetchJob was not visible in its post-create election.');

    const isWinner = String(canonicalJob.id) === String(createdJob?.id);
    if (isWinner) return { isWinner: true, canonicalJob, cancelledOwnJob: false };

    const createdKey = createdJob?.dry_run_metadata?.pull_election_key || electionKey || null;
    const canonicalKey = canonicalJob?.dry_run_metadata?.pull_election_key || null;
    const sameCriteria = !!createdKey && canonicalKey === createdKey;
    const relationship = sameCriteria ? 'exact_duplicate' : 'different_criteria';
    await cancelOwnJob(createdJob, canonicalJob, relationship);
    return {
        isWinner: false,
        canonicalJob,
        cancelledOwnJob: true,
        relationship,
        reason: sameCriteria ? 'duplicate_fetch_job' : 'different_fetch_job_already_active'
    };
}
