// Precision delivery helpers live outside the route optimizer: fetching,
// filtering, generation, and saving are distinct steps in the delivery funnel.
export function limitPrecisionCandidates(properties, { countMode, requestedCount }, rank) {
    if (countMode === 'max_available') return properties;
    const count = Math.floor(Number(requestedCount));
    if (!(count > 0) || properties.length <= count) return properties;
    return [...properties].sort((a, b) => rank(b) - rank(a)).slice(0, count);
}

export function precisionAreaForJob(job, generatedAt = new Date().toISOString()) {
    const metadata = job.dry_run_metadata || {};
    const range = metadata.ownership_range_days;
    return {
        job_id: job.id,
        polygon: (job.polygon || []).map(point => ({ lat: point.lat, lng: point.lng })),
        last_pull_date: job.completed_at || generatedAt,
        date: generatedAt,
        criteria: {
            requested_properties: job.total_expected || null,
            count_mode: metadata.count_mode || 'fixed',
            sold_months: job.sold_months || null,
            ownership_range_mode: metadata.ownership_range_mode || 'quick',
            ownership_range_days: range ? { min: range.min, max: range.max } : null,
            min_price: metadata.filters?.min_price ?? null,
            max_price: metadata.filters?.max_price ?? null,
            route_mode: 'precision', pull_mode: job.pull_mode || null
        }
    };
}

export function precisionReferenceDateForJob(job) {
    const value = job?.created_date || job?.started_at;
    if (!value) return null;
    // Base44 can serialize UTC created_date without a zone suffix. Browsers
    // otherwise interpret it in the customer's zone and shift date boundaries.
    const normalized = typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
        ? `${value}Z` : value;
    const date = new Date(normalized);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function savePrecisionRoutes(routes, saveRoute, concurrency = 4) {
    const results = new Array(routes.length);
    let nextIndex = 0;
    const workers = Math.min(Math.max(1, Math.floor(Number(concurrency) || 4)), 16, routes.length);
    await Promise.all(Array.from({ length: workers }, async () => {
        while (nextIndex < routes.length) {
            const index = nextIndex++;
            try {
                results[index] = { status: 'fulfilled', route: routes[index], value: await saveRoute(routes[index]) };
            } catch (error) {
                results[index] = { status: 'rejected', route: routes[index], error };
            }
        }
    }));
    return results;
}
