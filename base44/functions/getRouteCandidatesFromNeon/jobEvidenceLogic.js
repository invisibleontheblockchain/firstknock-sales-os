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

/**
 * Exact-job qualification may only read the immutable property_sources row.
 * The canonical property payload is shared and can contain another job's later
 * observation, so it is usable only for non-exact account views.
 */
export function candidateQualificationEvidence(propertyRawPayload, jobEvidencePayload, exactJobRequested = false) {
    const propertyPayload = parsePayload(propertyRawPayload);
    const jobPayload = parsePayload(jobEvidencePayload);
    if (exactJobRequested) return jobPayload;
    return jobPayload?._firstknock ? jobPayload : propertyPayload;
}

function normalizedListingExclusions(value) {
    return Array.isArray(value)
        ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))]
        : [];
}

function provesActivePendingExclusion(value) {
    const normalized = normalizedListingExclusions(value).map(item => item.toLowerCase());
    return normalized.includes('active') && normalized.includes('pending');
}

/**
 * Resolve listing evidence from the exact property-source row. A completed
 * property_sources_v1 job summary is a bounded compatibility fallback when a
 * row lost its copied predicate evidence. Never pair a job-scoped observation
 * flag with the mutable global property listing status.
 */
export function jobScopedListingEvidence(rawPayload, fetchJob = null) {
    const payload = parsePayload(rawPayload);
    const searchEvidence = payload?._firstknock?.search_evidence || {};
    const mappedEvidence = payload?._firstknock?.mapped_evidence || {};
    const mappedValues = payload?._firstknock?.mapped_values || {};
    const rowExclusions = normalizedListingExclusions(searchEvidence.listing_status_categories_excluded);
    const summaryExclusions = normalizedListingExclusions(
        fetchJob?.dry_run_metadata?.batchdata_summary?.filters?.listing_status_categories_excluded
    );
    const summaryFallbackAllowed = fetchJob?.status === 'completed'
        && fetchJob?.provider === 'batchdata'
        && fetchJob?.dry_run_metadata?.job_membership_contract === 'property_sources_v1'
        && provesActivePendingExclusion(summaryExclusions);
    const exclusions = provesActivePendingExclusion(rowExclusions)
        ? rowExclusions
        : (summaryFallbackAllowed ? summaryExclusions : rowExclusions);
    const observed = typeof mappedEvidence.listing_status_observed === 'boolean'
        ? mappedEvidence.listing_status_observed
        : null;
    const observedValue = observed === true && typeof mappedValues.listing_status === 'string'
        ? mappedValues.listing_status.trim()
        : '';

    return {
        provider_listing_status_observed: observed,
        provider_listing_status_value: observedValue || null,
        provider_listing_status_categories_excluded: exclusions,
        provider_listing_safety_source: observedValue
            ? 'job_scoped_observation'
            : (provesActivePendingExclusion(rowExclusions)
                ? 'job_scoped_predicate'
                : (summaryFallbackAllowed ? 'completed_job_predicate' : 'missing'))
    };
}
