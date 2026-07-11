// Route Generation Filter Pipeline
// Separates filter logic from Home.jsx for clarity and testability.
// Returns { workingSet, stageCounts, error } so the UI can show exactly where properties are dropping out.

import { interactionPredatesCurrentSaleEvidence, isPointInPolygon } from './territoryLogic';

const PROPERTY_TYPE_ALIASES = {
    'Single Family': ['single family', 'single family residential', 'single-family', 'sfr', 'sfh', 'one family', '1 family']
};
const ALLOWED_ROUTE_PROPERTY_TYPES = new Set(['Single Family']);
export const DEFAULT_PRECISION_MIN_HOME_VALUE = 100000;

const COMMERCIAL_TYPE_KEYWORDS = ['commercial', 'industrial', 'retail', 'office', 'warehouse', 'business', 'shopping', 'hotel', 'motel', 'restaurant', 'medical', 'hospital', 'mixed use'];
const CONDO_MULTI_TYPE_KEYWORDS = ['condo', 'condominium', 'apartment', 'co op', 'coop', 'cooperative', 'multifamily', 'multi family', 'multi-family', 'duplex', 'triplex', 'fourplex', 'townhouse', 'townhome', 'row house', 'rowhouse', 'mobile home', 'manufactured home', 'manufactured housing'];
const LAND_TYPE_KEYWORDS = ['land', 'lot', 'vacant', 'acreage', 'farm', 'agricultural'];

function normalizePropertyType(value) {
    return String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\bsinglefamily\b/gi, 'single family')
        .replace(/\bdetachedresidential\b/gi, 'detached residential')
        .toLowerCase()
        .replace(/[\/_-]+/g, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function includesAnyType(text, keywords) {
    return keywords.some(keyword => text.includes(normalizePropertyType(keyword)));
}

function matchesSelectedPropertyType(propertyType, selectedType) {
    const text = normalizePropertyType(propertyType);
    if (!text || /\bunverified\b|\bunknown\b/.test(text)) return false;

    if (includesAnyType(text, [...COMMERCIAL_TYPE_KEYWORDS, ...CONDO_MULTI_TYPE_KEYWORDS, ...LAND_TYPE_KEYWORDS, 'semi detached']) || /\battached\b/.test(text)) {
        return false;
    }

    const aliases = PROPERTY_TYPE_ALIASES[selectedType] || [selectedType];
    if (aliases.some(alias => text.includes(normalizePropertyType(alias)))) return true;

    if (selectedType === 'Single Family' && (text === 'detached' || (/\bdetached\b/.test(text) && /\bresidential\b|\bresidence\b|\bdwelling\b|\bhome\b|\bhouse\b/.test(text)))) return true;

    return false;
}

function propertyTypeEligibility(property, routeConfig = {}) {
    const text = normalizePropertyType(property?.property_type);
    const requestedTypes = Array.isArray(routeConfig.propertyTypes) ? routeConfig.propertyTypes.filter(Boolean) : [];
    const selectedTypes = requestedTypes.filter(type => ALLOWED_ROUTE_PROPERTY_TYPES.has(type));
    const effectiveSelectedTypes = selectedTypes.length > 0 ? selectedTypes : ['Single Family'];

    if (!effectiveSelectedTypes.some(type => matchesSelectedPropertyType(text, type))) {
        return { eligible: false, reason: 'includePropertyTypes' };
    }
    if (includesAnyType(text, COMMERCIAL_TYPE_KEYWORDS)) {
        return { eligible: false, reason: 'excludeCommercial' };
    }
    if (includesAnyType(text, CONDO_MULTI_TYPE_KEYWORDS)) {
        return { eligible: false, reason: 'excludeCondosMultiFamily' };
    }
    if (includesAnyType(text, LAND_TYPE_KEYWORDS)) {
        return { eligible: false, reason: 'excludeLand' };
    }

    return { eligible: true, reason: null };
}

function summarizePropertyTypes(properties = []) {
    const counts = new Map();
    for (const property of properties) {
        const label = String(property?.property_type || 'Unknown').trim() || 'Unknown';
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([label, count]) => `${label} (${count})`);
}

function requestedSoldWindowDays(soldMonths) {
    const months = Number(soldMonths || 1);
    if (Math.abs(months - (1 / 30)) < 0.0001) return 1;
    if (Math.abs(months - (2 / 30)) < 0.0001) return 2;
    if (months === 0.25) return 7;
    if (months === 0.5) return 14;
    if (months === 1) return 30;
    if (months === 3) return 90;
    if (months === 6) return 180;
    if (months === 9) return 270;
    if (months === 12) return 365;
    return Math.max(1, Math.round(months * 30));
}

function positiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function estimatedHomeValueEvidence(property) {
    const batchDataStatus = ['BATCHDATA_CONFIRMED', 'BATCHDATA_CANDIDATE'].includes(
        String(property?.workspace_status || property?.original_status || '').toUpperCase()
    );
    const isBatchDataRow = String(property?.data_source || '').toLowerCase() === 'batchdata' || batchDataStatus;
    const providerEstimateNotCanonical = property?.provider_estimated_value_observed === false
        || (isBatchDataRow && property?.provider_estimated_value_observed == null);
    const candidates = [
        property?.estimated_home_value,
        property?.estimated_value,
        property?.estimatedValue,
        property?.valuation?.estimatedValue,
        property?.valuation?.value,
        // `price` is the canonical Neon estimated-home-value column. Provider
        // sale consideration and listing price must not be stored here. When a
        // newly mapped Basic response explicitly says no estimate was observed,
        // ignore a legacy `price` value that may predate this semantic split.
        providerEstimateNotCanonical ? null : property?.price
    ];
    const estimatedHomeValue = candidates
        .map(positiveNumber)
        .find(value => value !== null) ?? null;

    return {
        estimatedHomeValue,
        providerMinimum: positiveNumber(property?.provider_estimated_value_min),
        providerMaximum: positiveNumber(property?.provider_estimated_value_max)
    };
}

export function routeCalendarDate(value) {
    if (!value) return null;
    if (typeof value === 'string') {
        const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) return match[1];
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function calendarDateDaysAgo(days, referenceDate = new Date()) {
    const date = new Date(referenceDate);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - days);
    return routeCalendarDate(date);
}

function providerRecentSaleWindowProves(property, cutoffDate) {
    const sources = Array.isArray(property?.provider_recent_sale_sources)
        ? property.provider_recent_sale_sources.filter(source => source === 'intel' || source === 'sale')
        : [];
    const minimum = routeCalendarDate(property?.provider_recent_sale_min_date);
    const maximum = routeCalendarDate(property?.provider_recent_sale_max_date);
    const today = routeCalendarDate(new Date());
    return sources.length > 0
        && !!minimum
        && !!maximum
        && minimum >= cutoffDate
        && maximum >= minimum
        && maximum <= today;
}

function isBlockedListingStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    if (/\bnot(?:\s+currently)?(?:\s+listed)?\s+for\s+sale\b/.test(status)) return false;
    return /(^|[^a-z])(active|for\s+sale|coming\s+soon|contingent|pending|under\s+contract|on\s+market|fsbo)($|[^a-z])/.test(status);
}

function providerListingExclusionProves(property) {
    const excluded = Array.isArray(property?.provider_listing_status_categories_excluded)
        ? property.provider_listing_status_categories_excluded.map(value => String(value).trim().toLowerCase())
        : [];
    return excluded.includes('active') && excluded.includes('pending');
}

function soldDateFilterLabel(soldMonths) {
    const days = requestedSoldWindowDays(soldMonths);
    if (days === 1) return 'last 1 day';
    if (days === 2) return 'last 2 days';
    if (days === 7) return 'last 7 days';
    if (days === 14) return 'last 14 days';
    if (days < 30) return `last ${days} days`;
    const months = Number(soldMonths || 1);
    return `last ${months} month${months === 1 ? '' : 's'}`;
}

/**
 * Apply all route-generation filters in sequence, tracking counts at each stage.
 * If a stage drops to 0, we bail early with a user-facing error + diagnostic info.
 */
export function applyRouteFilters({
    initialSet,
    drawnPolygon,
    zipCodeFilter,
    territoryZipCodes,
    soldDateFilter,
    routeConfig,
    lastPullMode,
    logsByAddress,
    assignedHashes,
}) {
    let workingSet = [...initialSet];
    const stages = [{ name: 'initial', count: workingSet.length }];
    const track = (name) => stages.push({ name, count: workingSet.length });
    const reincludedHashes = routeConfig?.reincludedHashes instanceof Set
        ? routeConfig.reincludedHashes
        : new Set(Array.isArray(routeConfig?.reincludedHashes) ? routeConfig.reincludedHashes : []);
    const isExplicitlyReincluded = (property) => {
        const hash = property?.address_hash || property?.id;
        return !!hash && reincludedHashes.has(hash);
    };

    // --- Geographic Filters ---
    const hasActivePolygon = drawnPolygon && drawnPolygon.length > 2;
    if (!hasActivePolygon) {
        let targetZips = [];
        if (zipCodeFilter && zipCodeFilter.trim()) {
            targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);
        } else if (territoryZipCodes && territoryZipCodes.length > 0) {
            targetZips = territoryZipCodes;
        }
        if (targetZips.length > 0) {
            workingSet = workingSet.filter(p => targetZips.includes(String(p.zip_code || '').trim().slice(0, 5)));
        }
    } else {
        workingSet = workingSet.filter(p => isPointInPolygon({ lat: p.lat, lng: p.lng }, drawnPolygon));
        if (workingSet.length === 0) {
            stages.push({ name: 'geography', count: 0 });
            return {
                workingSet: [], stages,
                error: `No properties inside drawn area. You have ${initialSet.length.toLocaleString()} properties loaded, but none are inside the polygon you drew. Try clearing the drawn area, or pulling fresh data for that area.`,
            };
        }
    }
    track('geography');

    // Freeze here — this is the geographically-constrained set (for reorder)
    const frozenSet = [...workingSet];

    // --- Assigned Route Filter ---
    // Keep this inside the pipeline so a large drop is visible in diagnostics.
    const beforeAssigned = workingSet.length;
    if (routeConfig.excludeAssigned && assignedHashes) {
        workingSet = workingSet.filter(p => isExplicitlyReincluded(p) || !assignedHashes.has(p.address_hash || p.id));
    }
    track('assigned');
    if (routeConfig.excludeAssigned && beforeAssigned > 0 && workingSet.length === 0) {
        return {
            workingSet: [],
            stages,
            frozenSet,
            error: 'Every qualifying home found in this area is already in a saved route. Draw beyond the previous route area or widen the boundary to find new homes.',
            diagnostic: { assignedBefore: beforeAssigned, assignedHashes: assignedHashes?.size || 0 }
        };
    }

    // --- Sold Date Filter (THE BIG ONE — often culls 99% of properties) ---
    const beforeSoldDate = workingSet.length;
    if (soldDateFilter !== null && soldDateFilter !== 'all') {
        // User-facing route filters stay strict to the selected range.
        // The backend may pull a wider provider-safe window, but older buffer records
        // should not appear when the user selected “last week.”
        const explicitCutoff = routeCalendarDate(routeConfig?.soldMinDateOverride);
        const cutoffDate = explicitCutoff || calendarDateDaysAgo(requestedSoldWindowDays(soldDateFilter));

        workingSet = workingSet.filter(p => {
            if (p.original_status === 'PENDING') return true;
            if (p.original_status === 'RECENT_OFF_MARKET' && p.sale_confidence !== 'low') return true;
            const hasInteraction = ['CALLBACK', 'NO_ANSWER', 'QUALIFIED'].includes(p.effective_status);
            const isImportedCandidate = ['csv_import', 'manual'].includes(String(p.data_source || '').toLowerCase()) || p.original_status === 'UNVERIFIED';
            if (!p.sold_date || p.provider_exact_sale_date_observed === false) {
                return providerRecentSaleWindowProves(p, cutoffDate) || hasInteraction || isImportedCandidate;
            }
            const saleDate = routeCalendarDate(p.sold_date);
            return saleDate ? saleDate >= cutoffDate : hasInteraction;
        });
    }
    track('soldDate');

    if (soldDateFilter !== null && beforeSoldDate > 0 && workingSet.length === 0) {
        // Deep diagnostic — what do the sold_dates actually look like?
        const sample = frozenSet.slice(0, 200);
        const withSoldDate = sample.filter(p => p.sold_date).length;
        const examples = sample.filter(p => p.sold_date).slice(0, 5).map(p => p.sold_date);
        return {
            workingSet: [], stages, frozenSet,
            error: `No homes match ${soldDateFilterLabel(soldDateFilter)}. Of ${sample.length} sampled, ${withSoldDate} have sold dates, but none are inside that selected range. Example sold dates: ${examples.join(', ') || 'none'}.`,
            diagnostic: { selectedRange: soldDateFilterLabel(soldDateFilter), withSoldDateInSample: withSoldDate, sampleSize: sample.length, exampleDates: examples }
        };
    }

    // --- Property Type Filters ---
    const beforePropertyTypeSet = [...workingSet];
    const propertyTypeDropReasons = {};
    workingSet = workingSet.filter(p => {
        const result = propertyTypeEligibility(p, routeConfig);
        if (!result.eligible) propertyTypeDropReasons[result.reason] = (propertyTypeDropReasons[result.reason] || 0) + 1;
        return result.eligible;
    });
    // Keep only user-configured property-type exclusions here. BatchData pulls already
    // target owner-change properties; a hard single-family-only gate can hide valid homes.
    track('propertyType');

    if (beforePropertyTypeSet.length > 0 && workingSet.length === 0) {
        const examples = summarizePropertyTypes(beforePropertyTypeSet);
        return {
            workingSet: [], stages, frozenSet,
            error: `All ${beforePropertyTypeSet.length.toLocaleString()} properties were excluded because Precision routes only use single-family residential homes. Found: ${examples.join(', ') || 'Unknown'}. Draw a larger residential area to find eligible homes.`,
            diagnostic: { propertyTypeExamples: examples, propertyTypeDropReasons }
        };
    }

    // --- Confidence / Rejection Filters ---
    const isBatchDataCandidate = (p) => {
        const statuses = new Set([
            String(p.original_status || '').toUpperCase(),
            String(p.workspace_status || '').toUpperCase()
        ]);
        return String(p.data_source || '').toLowerCase() === 'batchdata'
            || statuses.has('BATCHDATA_CONFIRMED')
            || statuses.has('BATCHDATA_CANDIDATE');
    };
    // Workspace activation and explicit rejection are hard boundaries for every
    // provider. BatchData records are no longer allowed to bypass them merely by
    // carrying a BatchData source label.
    workingSet = workingSet.filter(p => {
        const workspaceStatus = String(p.workspace_status || '').trim().toUpperCase();
        if (workspaceStatus) return workspaceStatus !== 'REJECTED';
        return String(p.original_status || '').trim().toUpperCase() !== 'REJECTED'
            && String(p.sale_confidence || '').trim().toUpperCase() !== 'REJECTED';
    });
    workingSet = workingSet.filter(p => p.route_active !== false);
    track('workspaceEligibility');

    // A newly sold home can already be relisted. Explicit on-market statuses
    // always lose; lean BatchData rows must carry the accepted provider
    // Active/Pending exclusion predicate so missing response fields do not
    // silently become an automatic pass.
    const listingSafetyDropReasons = { explicitlyBlocked: 0, missingProof: 0 };
    workingSet = workingSet.filter(p => {
        const exactJobListingScope = p.provider_listing_evidence_scope === 'exact_job';
        const hasJobScopedObservation = exactJobListingScope || typeof p.provider_listing_status_observed === 'boolean';
        const currentListingStatus = exactJobListingScope
            ? (p.provider_listing_status_observed === true ? (p.provider_listing_status_value || '') : '')
            : (p.provider_listing_status_observed === true
                ? (p.provider_listing_status_value || '')
                : (p.provider_listing_status_observed === false
                    ? ''
                    : (p.listing_status || p.listing?.statusCategory || p.listing?.status)));
        if (isBlockedListingStatus(currentListingStatus)) {
            listingSafetyDropReasons.explicitlyBlocked += 1;
            return false;
        }
        if (!isBatchDataCandidate(p)) return true;
        const hasExplicitStatus = !!String(currentListingStatus || '').trim();
        const predicateProven = providerListingExclusionProves(p);
        if (hasExplicitStatus || predicateProven) return true;
        // A scoped observation flag without its scoped value is not permission
        // to reuse a mutable global listing status from another provider/job.
        if (hasJobScopedObservation || !hasExplicitStatus) listingSafetyDropReasons.missingProof += 1;
        return false;
    });
    track('listingSafety');

    // Match MLS_CLERK_GAP_DAYS in processFetchChunk.
    const MLS_WINDOW_DAYS = 30;

    // Block stale MLS records from route generation even if they exist in the DB.
    workingSet = workingSet.filter(p => {
        const saleType = String(p.sale_type || '').toUpperCase();
        if (saleType !== 'MLS') return true;

        if (!p.sold_date) return false;

        const soldDate = routeCalendarDate(p.sold_date);
        const cutoffDate = calendarDateDaysAgo(MLS_WINDOW_DAYS);
        return !!soldDate && soldDate >= cutoffDate;
    });

    // Promote deed-matched MLS candidates before the hard MLS gate. Performing this
    // after the gate makes the promotion unreachable for HEURISTIC_SOLD rows.
    const deedHashes = new Set();
    for (const p of initialSet) {
        if (!p.address_hash) continue;
        const isDeedConfirmed =
            p.sale_confidence === 'high' ||
            p.sale_confidence === 'verified' ||
            (p.original_status === 'SOLD' && String(p.sale_type || '').toLowerCase() === 'deed');
        if (isDeedConfirmed) deedHashes.add(p.address_hash);
    }
    let crossRefPromoted = 0;
    workingSet = workingSet.map(p => {
        if (p.original_status === 'HEURISTIC_SOLD' && p.sale_confidence !== 'verified' && deedHashes.has(p.address_hash)) {
            crossRefPromoted++;
            return { ...p, sale_confidence: 'verified', original_status: 'DEED_CONFIRMED' };
        }
        return p;
    });
    if (crossRefPromoted > 0) console.log(`[routeFilter] Cross-ref promoted ${crossRefPromoted} MLS listings to verified (deed match found)`);

    // v15 HARD GATE: Block ALL unverified MLS data from routes.
    // Only deed-sourced properties OR MLS properties that have been verified
    // (by deed cross-ref or BatchData) are allowed through.
    //
    // CRITICAL: We check `sale_type` not `data_source` because ALL records
    // (including deeds) come from the RentCast API and have data_source='rentcast'.
    // The distinction is sale_type: 'Deed'/'Corporate' (ground truth) vs 'MLS' (needs verification).
    const beforeMlsGate = workingSet.length;
    workingSet = workingSet.filter(p => {
        // Deed or Corporate sale_type? Ground truth — always let through.
        const saleType = (p.sale_type || '').toLowerCase();
        if (saleType === 'deed' || saleType === 'corporate') return true;
        if (isBatchDataCandidate(p)) return true;
        // SOLD status from Phase 1 (county records)? Let through.
        if (p.original_status === 'SOLD' || p.original_status === 'ELIGIBLE') return true;
        // Deed-confirmed or BatchData-confirmed? Let through.
        if (p.original_status === 'DEED_CONFIRMED' || p.original_status === 'BATCHDATA_CONFIRMED') return true;
        // Verified confidence? Let through.
        if (p.sale_confidence === 'high' || p.sale_confidence === 'verified') return true;
        // Everything else is unverified MLS — block it.
        return false;
    });
    const mlsGateDropped = beforeMlsGate - workingSet.length;
    if (mlsGateDropped > 0) console.log(`[routeFilter] v15 MLS gate: blocked ${mlsGateDropped} unverified MLS properties`);

    // Skip low-confidence properties unless the user explicitly opts in.
    // (Previously 40mi and 300mi branched differently here — now unified.)
    if (!routeConfig.includeUnverifiedSales) {
        workingSet = workingSet.filter(p => isBatchDataCandidate(p) || p.sale_confidence !== 'low');
    }
    track('confidence');

    // --- Previously-Knocked Filter ---
    if (routeConfig.excludePreviouslyKnocked && logsByAddress) {
        workingSet = workingSet.filter(p => {
            if (isExplicitlyReincluded(p)) return true;
            const hash = p.address_hash || p.id;
            const propLogs = logsByAddress.get(hash);
            const currentEventLogs = (propLogs || []).filter(log => !interactionPredatesCurrentSaleEvidence(log, p));
            if (p.effective_status === 'CALLBACK' && currentEventLogs.length > 0) return true;
            return currentEventLogs.length === 0;
        });
    }
    track('previouslyKnocked');

    // --- Estimated Home Value & Year Filters ---
    // The $100k Precision floor is an invariant, not an optional UI filter. A
    // provider-side valuation predicate is acceptable evidence only when the
    // exact value was omitted and the recorded predicate proves this route's
    // effective bound. Sale consideration and listing price are not home value.
    const configuredMinimum = positiveNumber(routeConfig?.minPrice);
    const effectiveMinimum = Math.max(
        DEFAULT_PRECISION_MIN_HOME_VALUE,
        configuredMinimum ?? DEFAULT_PRECISION_MIN_HOME_VALUE
    );
    const configuredMaximum = positiveNumber(routeConfig?.maxPrice);
    workingSet = workingSet.filter(property => {
        const evidence = estimatedHomeValueEvidence(property);
        if (evidence.estimatedHomeValue !== null) {
            if (evidence.estimatedHomeValue < effectiveMinimum) return false;
            if (configuredMaximum !== null && evidence.estimatedHomeValue > configuredMaximum) return false;
            return true;
        }

        const providerProvesMinimum = evidence.providerMinimum !== null && evidence.providerMinimum >= effectiveMinimum;
        const providerProvesMaximum = configuredMaximum === null || (
            evidence.providerMaximum !== null && evidence.providerMaximum <= configuredMaximum
        );
        return providerProvesMinimum && providerProvesMaximum;
    });
    if (routeConfig.minYearBuilt) workingSet = workingSet.filter(p => !p.year_built || p.year_built >= routeConfig.minYearBuilt);
    if (routeConfig.maxYearBuilt) workingSet = workingSet.filter(p => !p.year_built || p.year_built <= routeConfig.maxYearBuilt);
    track('priceYear');

    // --- Callback Filter ---
    if (!routeConfig.includeCallbacks) {
        workingSet = workingSet.filter(p => isExplicitlyReincluded(p) || p.effective_status !== 'CALLBACK');
    }
    track('callbacks');

    if (workingSet.length === 0) {
        // Build a helpful summary of what killed the funnel
        let biggestDrop = { stage: '', dropped: 0 };
        for (let i = 1; i < stages.length; i++) {
            const dropped = stages[i - 1].count - stages[i].count;
            if (dropped > biggestDrop.dropped) biggestDrop = { stage: stages[i].name, dropped };
        }
        const listingSafetyError = biggestDrop.stage === 'listingSafety' && listingSafetyDropReasons.missingProof > 0
            ? `No routes were built because ${listingSafetyDropReasons.missingProof.toLocaleString()} BatchData candidate${listingSafetyDropReasons.missingProof === 1 ? '' : 's'} arrived without exact-job proof that Active and Pending listings were excluded. This is a pipeline release/evidence mismatch, not a filter you should loosen. Refresh after the coordinated backend deployment and retry this same completed pull.`
            : biggestDrop.stage === 'listingSafety' && listingSafetyDropReasons.explicitlyBlocked > 0
                ? `No routes were built because ${listingSafetyDropReasons.explicitlyBlocked.toLocaleString()} candidate${listingSafetyDropReasons.explicitlyBlocked === 1 ? '' : 's'} had an explicit on-market listing status. Listing safety is working; broaden the area or date window instead of loosening this protection.`
                : null;
        return {
            workingSet: [], stages, frozenSet,
            error: listingSafetyError || (biggestDrop.dropped > 0
                ? `All properties filtered out — biggest drop was "${biggestDrop.stage}" (removed ${biggestDrop.dropped}). Try loosening that filter.`
                : 'No properties match current filters. Try loosening filters or pulling fresh data.'),
            diagnostic: { listingSafetyDropReasons }
        };
    }

    return { workingSet, stages, frozenSet, error: null };
}

// Pretty-print the stage counts for logging
export function formatStageCounts(stages) {
    return stages.map(s => `${s.name}=${s.count}`).join(' → ');
}
