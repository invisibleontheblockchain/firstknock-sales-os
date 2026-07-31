// Pure helpers extracted from pages/Home.jsx (polygon normalization, precision
// job context persistence, route-bounds intent, small utilities).
import { isValidRoutePoint } from '@/lib/routeBounds';
import { normalizeOwnershipRangeDays as normalizeStrictOwnershipRangeDays } from '@/components/logic/soldDateRange';

export const PRECISION_JOB_CONTEXT_STORAGE_KEY = 'fk_precisionCustomJobContext';

// The log cache is an array in some responses and { items } in others.
export function mergeLogCache(old, mutate) {
    if (Array.isArray(old)) return mutate(old);
    if (old && Array.isArray(old.items)) return { ...old, items: mutate(old.items) };
    return mutate([]);
}

export function normalizeHistoryPolygon(value) {
    if (!Array.isArray(value)) return [];
    let points = value;
    if (Array.isArray(points[0]) && Array.isArray(points[0][0])) {
        points = points[0];
    }

    return points.map((point) => {
        if (Array.isArray(point)) {
            const lng = Number(point[0]);
            const lat = Number(point[1]);
            return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
        }
        const lat = Number(point?.lat ?? point?.latitude);
        const lng = Number(point?.lng ?? point?.lon ?? point?.longitude);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }).filter(Boolean);
}

export function polygonHistoryKey(polygon = []) {
    const first = polygon[0] || {};
    return `${Number(first.lat || 0).toFixed(5)}:${Number(first.lng || 0).toFixed(5)}:${polygon.length}`;
}

export function exactPolygonKey(polygon = []) {
    const normalized = normalizeHistoryPolygon(polygon);
    if (normalized.length < 3) return null;
    const points = [...normalized];
    const first = points[0];
    const last = points[points.length - 1];
    if (points.length > 3 && first.lat === last.lat && first.lng === last.lng) points.pop();
    return points.map(point => `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`).join(';');
}

export function getRouteHistoryPolygon(route) {
    return normalizeHistoryPolygon(
        route?.metadata?.precision_area?.polygon ||
        route?.metadata?.drawn_polygon ||
        route?.metadata?.polygon ||
        route?.precision_area?.polygon ||
        route?.polygon
    );
}

export function getFetchJobHistoryPolygon(job) {
    return normalizeHistoryPolygon(
        job?.polygon ||
        job?.metadata?.polygon ||
        job?.request?.polygon ||
        job?.request_payload?.polygon ||
        job?.input?.polygon ||
        job?.searchCriteria?.address?.geoLocationPolygon?.geoPoints ||
        job?.request?.searchCriteria?.address?.geoLocationPolygon?.geoPoints ||
        job?.request_payload?.searchCriteria?.address?.geoLocationPolygon?.geoPoints
    );
}

export function getPrecisionJobId(jobStatus = {}) {
    return jobStatus?.job_id || jobStatus?.fetch_job_id || jobStatus?.id || jobStatus?.jobId || null;
}

export function getRequestedPrecisionCount(jobStatus = {}) {
    const diagnostics = jobStatus?.diagnostics || {};
    const value =
        diagnostics.requested_properties_before_cap ||
        diagnostics.requested_properties ||
        jobStatus?.requested_properties ||
        jobStatus?.total_expected ||
        jobStatus?.active_count;
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.round(count) : null;
}

export function normalizeOwnershipRangeDays(value) {
    const min = Number(Array.isArray(value) ? value[0] : value?.min);
    const max = Number(Array.isArray(value) ? value[1] : value?.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const normalizedMin = Math.max(1, Math.min(365, Math.round(min)));
    const normalizedMax = Math.max(1, Math.min(365, Math.round(max)));
    return normalizedMin < normalizedMax ? [normalizedMin, normalizedMax] : null;
}

export function normalizeRouteBoundsIntent(value) {
    if (!value || value.enabled !== true) return { enabled: false };
    const startLocation = value.startLocation || value.start_location;
    const endLocation = value.endLocation || value.end_location;
    if (!isValidRoutePoint(startLocation) || !isValidRoutePoint(endLocation)) return { enabled: false };
    const mode = value.mode === 'current_to_home' ? 'current_to_home' : 'home_round_trip';
    return {
        enabled: true,
        mode,
        // Route-generation context can be resumed from local storage, so keep
        // only coordinates here. Exact home addresses stay on the private User.
        startLocation: { lat: Number(startLocation.lat), lng: Number(startLocation.lng) },
        endLocation: { lat: Number(endLocation.lat), lng: Number(endLocation.lng) }
    };
}

export function readPersistedPrecisionJobContext(expectedUserEmail) {
    try {
        const parsed = JSON.parse(localStorage.getItem(PRECISION_JOB_CONTEXT_STORAGE_KEY) || 'null');
        const userEmail = String(parsed?.userEmail || '').trim().toLowerCase();
        if (!userEmail || userEmail !== String(expectedUserEmail || '').trim().toLowerCase()) return null;
        const jobId = parsed?.jobId ? String(parsed.jobId) : null;
        const ownershipRangeDays = normalizeStrictOwnershipRangeDays(parsed?.ownershipRangeDays);
        const polygon = normalizeHistoryPolygon(parsed?.polygon);
        if (!jobId || !ownershipRangeDays || polygon.length < 3) return null;
        const soldMonths = Number(parsed?.soldMonths);
        const requestedCount = Number(parsed?.requestedCount);
        const ownershipReferenceDate = parsed?.ownershipReferenceDate && Number.isFinite(new Date(parsed.ownershipReferenceDate).getTime())
            ? new Date(parsed.ownershipReferenceDate).toISOString()
            : null;
        return {
            jobId,
            userEmail,
            ownershipRangeDays,
            ownershipReferenceDate,
            polygon,
            soldMonths: Number.isFinite(soldMonths) && soldMonths > 0 ? soldMonths : ownershipRangeDays[1] / 30,
            requestedCount: Number.isFinite(requestedCount) && requestedCount > 0 ? Math.round(requestedCount) : null
        };
    } catch {
        return null;
    }
}

export function persistPrecisionJobContext(context) {
    try {
        if (!context) localStorage.removeItem(PRECISION_JOB_CONTEXT_STORAGE_KEY);
        else localStorage.setItem(PRECISION_JOB_CONTEXT_STORAGE_KEY, JSON.stringify(context));
    } catch { }
}

export function precisionCandidateRank(property) {
    const score = Number(property?.score ?? property?.competitivenessScore ?? 0) || 0;
    const price = Number(property?.price ?? property?.sale_price ?? 0) || 0;
    const soldTime = property?.sold_date ? new Date(property.sold_date).getTime() : 0;
    return (score * 1000000000000) + (Number.isFinite(soldTime) ? soldTime : 0) + Math.min(price, 10000000);
}

export function buildPrecisionRouteShortfallMessage({ requested, routed, filtered }) {
    if (!requested || routed >= requested) return '';
    const missing = requested - routed;
    const filterText = filtered > 0 ? ` ${filtered.toLocaleString()} were removed by saved-route or route filters.` : '';
    return `Built ${routed.toLocaleString()} of ${requested.toLocaleString()} requested homes from this exact area. FirstKnock only routes unique single-family homes that survive the current filters.${filterText} Draw a wider nearby area or loosen value/date filters to fill the remaining ${missing.toLocaleString()}.`;
}

export async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(
        items.length,
        Math.max(1, Math.floor(Number(concurrency)) || 1)
    );
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await mapper(items[index], index);
        }
    }));
    return results;
}