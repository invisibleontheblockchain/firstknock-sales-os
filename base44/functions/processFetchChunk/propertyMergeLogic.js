function saleConfidenceRank(value) {
    switch (String(value || '').trim().toLowerCase()) {
        case 'verified': return 4;
        case 'high': return 3;
        case 'medium': return 2;
        case 'low': return 1;
        default: return 0;
    }
}

function timestamp(value) {
    if (!value) return 0;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

export function protectsAssignedRouteFetchJob(routeFilters) {
    return routeFilters?.excludeAssigned !== false;
}

export function allowsAssignedRouteForCurrentJob(routeFilters, metadata, addressHash) {
    if (!protectsAssignedRouteFetchJob(routeFilters)) return true;
    const hash = String(addressHash || '');
    if (!hash) return false;
    const explicitlyReopened = [
        ...(Array.isArray(metadata?.unresolved_followup_hashes_included) ? metadata.unresolved_followup_hashes_included : []),
        ...(Array.isArray(metadata?.event_released_prior_route_hashes) ? metadata.event_released_prior_route_hashes : [])
    ];
    return explicitlyReopened.some(value => String(value) === hash);
}

/**
 * Plan the non-destructive merge of an incoming BatchData property into the
 * canonical property row. Classification evidence is supplied by the caller
 * so this module stays independent of provider-specific type parsing.
 */
export function planPropertyMerge({
    existing,
    incoming,
    soldDate,
    existingExplicitSfr,
    incomingExplicitSfr
}) {
    const current = existing || {};
    const next = incoming || {};
    const existingDate = timestamp(current.sold_date);
    const incomingDate = timestamp(soldDate);
    const existingConfidenceRank = saleConfidenceRank(current.sale_confidence);
    const incomingConfidenceRank = saleConfidenceRank(next.sale_confidence);
    const existingStatusRejected = String(current.original_status || '').toUpperCase() === 'REJECTED';
    const providerMinimumDate = timestamp(
        next.metadata_completeness?.provider_recent_sale_min_date || next.provider_recent_sale_min_date
    );
    const providerProvesNewerEvent = next.provider_recent_sale_window_proven === true &&
        providerMinimumDate > 0 &&
        existingDate > 0 &&
        existingDate < providerMinimumDate;

    // Date, confidence, source, sale type, and status describe one sale event.
    // Replace that bundle for a newer event, or when the same event gains
    // stronger evidence. Mixing metadata from two sale events would fabricate
    // provenance.
    const newerSaleEvent = incomingDate > existingDate;
    const sameSaleEventImproves = incomingDate > 0 &&
        incomingDate === existingDate &&
        incomingConfidenceRank > existingConfidenceRank;
    const replaceSaleEvent = existingStatusRejected ||
        newerSaleEvent ||
        providerProvesNewerEvent ||
        sameSaleEventImproves ||
        (existingDate === 0 && incomingDate > 0);
    const replaceOwnershipEvent = newerSaleEvent || providerProvesNewerEvent || existingStatusRejected;
    const classificationImproves = !existingExplicitSfr && incomingExplicitSfr;
    const protectedPropertyType = existingExplicitSfr && !incomingExplicitSfr
        ? current.property_type
        : next.property_type;
    const hasNewMetadata = Boolean(
        (!current.owner_full_name && next.owner_full_name) ||
        (!current.beds && next.beds) ||
        (!current.baths && next.baths) ||
        (!current.sqft && next.sqft) ||
        (!current.lot_size && next.lot_size) ||
        (!current.year_built && next.year_built) ||
        (!current.price && next.price)
    );

    return {
        replaceSaleEvent,
        replaceOwnershipEvent,
        providerProvesNewerEvent,
        classificationImproves,
        hasNewMetadata,
        shouldUpdate: replaceSaleEvent || hasNewMetadata || classificationImproves,
        soldDateForUpdate: replaceSaleEvent ? soldDate : null,
        protectedPropertyType,
        protectedSaleConfidence: replaceSaleEvent ? next.sale_confidence : current.sale_confidence,
        protectedOriginalStatus: replaceSaleEvent ? next.original_status : current.original_status,
        protectedDataSource: replaceSaleEvent ? next.data_source : current.data_source,
        protectedSaleType: replaceSaleEvent ? next.sale_type : current.sale_type
    };
}
