// Route Generation Filter Pipeline
// Separates filter logic from Home.jsx for clarity and testability.
// Returns { workingSet, stageCounts, error } so the UI can show exactly where properties are dropping out.

import { subDays } from 'date-fns';
import { isPointInPolygon } from './territoryLogic';

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
        workingSet = workingSet.filter(p => !assignedHashes.has(p.address_hash || p.id));
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
        const cutoff = subDays(new Date(), requestedSoldWindowDays(soldDateFilter));
        cutoff.setHours(0, 0, 0, 0);

        workingSet = workingSet.filter(p => {
            if (p.original_status === 'PENDING') return true;
            if (p.original_status === 'RECENT_OFF_MARKET' && p.sale_confidence !== 'low') return true;
            const hasInteraction = ['CALLBACK', 'NO_ANSWER', 'QUALIFIED'].includes(p.effective_status);
            const isBatchDataCandidate = String(p.data_source || '').toLowerCase() === 'batchdata' || p.original_status === 'BATCHDATA_CONFIRMED';
            if (isBatchDataCandidate) return true;
            const isImportedCandidate = ['csv_import', 'manual'].includes(String(p.data_source || '').toLowerCase()) || p.original_status === 'UNVERIFIED';
            if (!p.sold_date) return hasInteraction || isImportedCandidate;
            try {
                const date = new Date(p.sold_date);
                if (isNaN(date.getTime())) return hasInteraction;
                return date >= cutoff;
            } catch { return hasInteraction; }
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
    if (routeConfig.propertyTypes && routeConfig.propertyTypes.length > 0) {
        workingSet = workingSet.filter(p => {
            if (!p.property_type) return true;
            const pt = p.property_type.toLowerCase();
            return routeConfig.propertyTypes.some(t => pt.includes(t.toLowerCase()));
        });
    }
    if (routeConfig.excludeCommercial) {
        const kw = ['commercial', 'industrial', 'retail', 'office', 'warehouse', 'business', 'shopping'];
        workingSet = workingSet.filter(p => !p.property_type || !kw.some(k => p.property_type.toLowerCase().includes(k)));
    }
    if (routeConfig.excludeCondos) {
        const kw = ['condo', 'apartment', 'co-op', 'coop', 'multifamily', 'multi family', 'multi-family'];
        workingSet = workingSet.filter(p => !p.property_type || !kw.some(k => p.property_type.toLowerCase().includes(k)));
    }
    if (routeConfig.excludeLand) {
        const kw = ['land', 'lot', 'vacant', 'acreage', 'farm'];
        workingSet = workingSet.filter(p => !p.property_type || !kw.some(k => p.property_type.toLowerCase().includes(k)));
    }
    // Keep only user-configured property-type exclusions here. BatchData pulls already
    // target owner-change properties; a hard single-family-only gate can hide valid homes.
    track('propertyType');

    // --- Confidence / Rejection Filters ---
    const isBatchDataCandidate = (p) => String(p.data_source || '').toLowerCase() === 'batchdata' || p.original_status === 'BATCHDATA_CONFIRMED';
    workingSet = workingSet.filter(p => isBatchDataCandidate(p) || p.original_status !== 'REJECTED');

    // Exclude records explicitly deactivated by cleanup or delta sync, but do not let
    // older strict BatchData parsing hide exact-job rows during this verification pass.
    workingSet = workingSet.filter(p => isBatchDataCandidate(p) || p.route_active !== false);

    // Match MLS_CLERK_GAP_DAYS in processFetchChunk.
    const MLS_WINDOW_DAYS = 30;

    // Block stale MLS records from route generation even if they exist in the DB.
    workingSet = workingSet.filter(p => {
        const saleType = String(p.sale_type || '').toUpperCase();
        if (saleType !== 'MLS') return true;

        if (!p.sold_date) return false;

        const soldDate = new Date(p.sold_date);
        if (Number.isNaN(soldDate.getTime())) return false;

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - MLS_WINDOW_DAYS);

        return soldDate >= cutoff;
    });

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

    // GLOBAL DEED CROSS-REF: If an MLS listing (HEURISTIC_SOLD) shares an address_hash
    // with a deed-confirmed record (sale_confidence='high' / 'verified' / status='SOLD'),
    // auto-promote the MLS record to 'verified'. This fixes the bug where cross-ref only
    // happened within a single chunk during fetch — deeds landing in a later sub-circle
    // never got cross-referenced to the listings from an earlier sub-circle.
    const deedHashes = new Set();
    for (const p of initialSet) {
        if (!p.address_hash) continue;
        const isDeedConfirmed =
            p.sale_confidence === 'high' ||
            p.sale_confidence === 'verified' ||
            (p.original_status === 'SOLD' && p.sale_type === 'Deed');
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

    // Skip low-confidence properties unless the user explicitly opts in.
    // (Previously 40mi and 300mi branched differently here — now unified.)
    if (!routeConfig.includeUnverifiedSales) {
        workingSet = workingSet.filter(p => isBatchDataCandidate(p) || p.sale_confidence !== 'low');
    }
    track('confidence');

    // --- Previously-Knocked Filter ---
    if (routeConfig.excludePreviouslyKnocked && logsByAddress) {
        workingSet = workingSet.filter(p => {
            const hash = p.address_hash || p.id;
            const propLogs = logsByAddress.get(hash);
            if (p.effective_status === 'CALLBACK') return true;
            return !propLogs || propLogs.length === 0;
        });
    }
    track('previouslyKnocked');

    // --- Price & Year Filters ---
    // Resolve price from every field it can live in (Neon returns `price`; imports use `sale_price`).
    // When the user sets an explicit price bound, unknown-price properties are EXCLUDED —
    // previously they passed through, making the filter appear broken.
    const effectivePrice = (p) => {
        const v = Number(p.price ?? p.sale_price ?? p.raw_metadata?.price);
        return Number.isFinite(v) && v > 0 ? v : null;
    };
    if (routeConfig.minPrice) workingSet = workingSet.filter(p => { const v = effectivePrice(p); return v !== null && v >= routeConfig.minPrice; });
    if (routeConfig.maxPrice) workingSet = workingSet.filter(p => { const v = effectivePrice(p); return v !== null && v <= routeConfig.maxPrice; });
    if (routeConfig.minYearBuilt) workingSet = workingSet.filter(p => !p.year_built || p.year_built >= routeConfig.minYearBuilt);
    if (routeConfig.maxYearBuilt) workingSet = workingSet.filter(p => !p.year_built || p.year_built <= routeConfig.maxYearBuilt);
    track('priceYear');

    // --- Callback Filter ---
    if (!routeConfig.includeCallbacks) {
        workingSet = workingSet.filter(p => p.effective_status !== 'CALLBACK');
    }
    track('callbacks');

    if (workingSet.length === 0) {
        // Build a helpful summary of what killed the funnel
        let biggestDrop = { stage: '', dropped: 0 };
        for (let i = 1; i < stages.length; i++) {
            const dropped = stages[i - 1].count - stages[i].count;
            if (dropped > biggestDrop.dropped) biggestDrop = { stage: stages[i].name, dropped };
        }
        return {
            workingSet: [], stages, frozenSet,
            error: biggestDrop.dropped > 0
                ? `All properties filtered out — biggest drop was "${biggestDrop.stage}" (removed ${biggestDrop.dropped}). Try loosening that filter.`
                : 'No properties match current filters. Try loosening filters or pulling fresh data.',
        };
    }

    return { workingSet, stages, frozenSet, error: null };
}

// Pretty-print the stage counts for logging
export function formatStageCounts(stages) {
    return stages.map(s => `${s.name}=${s.count}`).join(' → ');
}
