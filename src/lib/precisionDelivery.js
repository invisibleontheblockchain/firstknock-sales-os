// Precision delivery helpers live outside the route optimizer: fetching,
// filtering, generation, and saving are distinct steps in the delivery funnel.
export async function loadPrecisionJob(client, jobId) {
    // Jobs created by the service can be hidden by browser entity-read rules.
    // The status endpoint reads with service privileges, then checks ownership
    // before returning this allowlisted generation context.
    const response = await client.functions.invoke('fetchJobStatus', { job_id: jobId });
    const status = response?.data;
    if (!jobId || status?.job_id !== jobId) {
        throw new Error('The property pull status did not match the selected import.');
    }
    if (status.provider !== 'batchdata' || status.mode_tag !== 'PRECISION_TARGET') {
        throw new Error('The selected import is not a Precision property pull.');
    }
    const diagnostics = status.diagnostics || {};
    const range = diagnostics.ownership_range_days ?? status.ownership_range_days;
    return {
        id: status.job_id, status: status.status, provider: status.provider,
        mode_tag: status.mode_tag, total_expected: status.total_expected,
        progress_pct: status.progress_pct,
        sold_months: diagnostics.sold_months,
        created_date: status.ownership_reference_date ?? diagnostics.ownership_reference_date,
        completed_at: status.completed_at,
        pull_mode: status.pull_mode,
        polygon: (status.polygon || []).map(point => ({ lat: point.lat, lng: point.lng })),
        dry_run_metadata: {
            count_mode: diagnostics.count_mode,
            requested_properties: diagnostics.requested_properties,
            route_bounds: diagnostics.route_bounds,
            ownership_range_mode: diagnostics.ownership_range_mode ?? status.ownership_range_mode,
            ownership_range_days: range ? { min: range.min, max: range.max } : null,
            filters: diagnostics.filters ? { ...diagnostics.filters } : null
        }
    };
}

export async function loadPrecisionGenerationJob(client, jobId) {
    const job = await loadPrecisionJob(client, jobId);
    if (job.status !== 'completed') {
        throw new Error('The property pull must finish before routes can be built.');
    }
    return job;
}

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
