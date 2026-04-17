// Route Generation Filter Pipeline
// Separates filter logic from Home.jsx for clarity and testability.
// Returns { workingSet, stageCounts, error } so the UI can show exactly where properties are dropping out.

import { subDays, subMonths } from 'date-fns';
import { isPointInPolygon } from './territoryLogic';

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
            return { workingSet: [], stages, error: 'No property data inside your drawn area.' };
        }
    }
    track('geography');

    // Freeze here — this is the geographically-constrained set (for reorder)
    const frozenSet = [...workingSet];

    // --- Sold Date Filter (THE BIG ONE — often culls 99% of properties) ---
    const beforeSoldDate = workingSet.length;
    if (soldDateFilter !== null && soldDateFilter !== 'all') {
        let cutoff;
        const now = new Date();
        if (soldDateFilter === 0.25 || soldDateFilter === '0.25') cutoff = subDays(now, 7);
        else cutoff = subMonths(now, Number(soldDateFilter));
        cutoff.setHours(0, 0, 0, 0);

        workingSet = workingSet.filter(p => {
            if (p.original_status === 'PENDING') return true;
            if (p.original_status === 'RECENT_OFF_MARKET' && p.sale_confidence !== 'low') return true;
            const hasInteraction = ['CALLBACK', 'NO_ANSWER', 'QUALIFIED'].includes(p.effective_status);
            if (!p.sold_date) return hasInteraction;
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
            error: `No homes sold in last ${soldDateFilter} months. Of ${sample.length} sampled, only ${withSoldDate} have a sold_date. Try increasing the filter or pulling fresh data.`,
            diagnostic: { withSoldDateInSample: withSoldDate, sampleSize: sample.length, exampleDates: examples }
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
    track('propertyType');

    // --- Confidence / Rejection Filters ---
    workingSet = workingSet.filter(p => p.original_status !== 'REJECTED');
    // Skip low-confidence properties — forced for 40mi pulls (no BatchData validation)
    if (!routeConfig.includeUnverifiedSales || lastPullMode === '40mi') {
        workingSet = workingSet.filter(p => p.sale_confidence !== 'low');
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
    if (routeConfig.minPrice) workingSet = workingSet.filter(p => !p.price || p.price >= routeConfig.minPrice);
    if (routeConfig.maxPrice) workingSet = workingSet.filter(p => !p.price || p.price <= routeConfig.maxPrice);
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