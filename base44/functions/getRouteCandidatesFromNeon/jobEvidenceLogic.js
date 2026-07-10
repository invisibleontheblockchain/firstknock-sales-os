function parsePayload(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try { return JSON.parse(value); } catch { return {}; }
}

export function exactFetchJobBelongsToTarget(fetchJob, targetEmail) {
    const jobEmail = String(fetchJob?.user_email || '').trim().toLowerCase();
    const requestedEmail = String(targetEmail || '').trim().toLowerCase();
    return !!fetchJob?.id && !!jobEmail && !!requestedEmail && jobEmail === requestedEmail;
}

/**
 * Resolve the owner value observed by the specific BatchData job. A false
 * observation is meaningful: it prevents a canonical prior owner's name from
 * leaking into a new-owner route when the current lean payload omits owner.
 */
export function jobScopedOwnerObservation(rawPayload) {
    const payload = parsePayload(rawPayload);
    const mappedEvidence = payload?._firstknock?.mapped_evidence || {};
    const mappedValues = payload?._firstknock?.mapped_values || {};
    if (typeof mappedEvidence.owner_name_observed !== 'boolean') {
        return {
            available: false,
            owner_name_observed: null,
            owner_full_name: null,
            source: 'canonical'
        };
    }

    const ownerName = typeof mappedValues.owner_full_name === 'string'
        ? mappedValues.owner_full_name.trim()
        : '';
    return {
        available: true,
        owner_name_observed: mappedEvidence.owner_name_observed,
        owner_full_name: mappedEvidence.owner_name_observed && ownerName ? ownerName : null,
        source: 'batchdata_job_observation'
    };
}

export function applyJobScopedOwnerObservation(canonicalOwner, rawPayload) {
    const observation = jobScopedOwnerObservation(rawPayload);
    return {
        owner_full_name: observation.available ? observation.owner_full_name : (canonicalOwner || null),
        provider_owner_name_observed: observation.available ? observation.owner_name_observed : null,
        owner_full_name_source: observation.source
    };
}
