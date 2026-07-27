// Precision order-control safety helpers (Stages 0-4).
//
// Deliberately narrow. This module holds ONLY the rules that decide:
//   - whose usage a FetchJob counts against
//   - whether a FetchJob belongs to the Precision pipeline at all
//   - whether the submitted polygon and count are usable
//   - what the server-authorized target is
//   - whether an existing active job is provably the same order
//
// It does NOT contain provider-contract interpretation, candidate validation,
// or any Stage 5-11 policy. Those belong to the downstream criteria contract
// (PR #66) and must not be duplicated here.

/** A FetchJob is "active" for Precision purposes in exactly these states. */
export const ACTIVE_PRECISION_STATUSES = ['running', 'pending'];

/* ───────────────────────────── job identity ───────────────────────────── */

/**
 * Whether a FetchJob belongs to the Precision pipeline.
 *
 * Mirrors the filter Precision usage accounting has always applied, so the
 * same rows count for allowance and for active-job discovery. Before this,
 * active-job discovery applied no such filter at all, so an unrelated ZIP or
 * MLS job could block a Precision pull and be offered for resume.
 */
export function isPrecisionJob(job) {
    if (!job || !job.id) return false;
    if (job.mode_tag) return job.mode_tag === 'PRECISION_TARGET';
    return !job.provider || job.provider === 'batchdata';
}

/* ───────────────────────────── ownership ───────────────────────────── */

export function normalizeUsageEmail(value) {
    return String(value || '').trim().toLowerCase();
}

/**
 * Whether a FetchJob's usage belongs to this actor.
 *
 * The immutable subject is authoritative. Email is a compatibility fallback
 * ONLY for rows written before `precision_usage_user_id` existed — otherwise a
 * second account sharing an email would have its usage charged here and could
 * block this user's pulls with its active jobs.
 *
 * A matching email never overrides a different immutable subject.
 */
export function precisionJobBelongsToSubject(job, user) {
    const jobSubject = String(job?.precision_usage_user_id || '').trim();
    if (jobSubject) return jobSubject === String(user?.id || '').trim();
    const jobEmail = normalizeUsageEmail(job?.user_email);
    return Boolean(jobEmail) && jobEmail === normalizeUsageEmail(user?.email);
}

/** Precision jobs this actor actually owns. */
export function selectOwnedPrecisionJobs(jobs, user) {
    return (jobs || []).filter(job => isPrecisionJob(job) && precisionJobBelongsToSubject(job, user));
}

/* ───────────────────────────── polygon ───────────────────────────── */

const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;

/**
 * Validates and normalizes a drawn ring.
 *
 * Geometry is conserved exactly: no reordering, no rewinding, no dedupe, no
 * automatic closure, and no change to centroid, area or hash behaviour. The
 * only change is that an unusable vertex now REJECTS the polygon instead of
 * being dropped, which used to turn an N-point ring into a different
 * (N-1)-point ring with a different identity, silently.
 */
export function normalizePrecisionPolygon(input) {
    if (!Array.isArray(input) || input.length === 0) {
        return { ok: false, code: 'invalid_polygon', message: 'At least 3 polygon points are required.' };
    }

    const points = [];
    for (let index = 0; index < input.length; index += 1) {
        const raw = input[index];
        const lat = Number(raw?.lat);
        const lng = Number(raw?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return {
                ok: false,
                code: 'invalid_polygon_point',
                message: `Polygon point ${index + 1} is missing a usable latitude or longitude.`
            };
        }
        if (lat < -MAX_LATITUDE || lat > MAX_LATITUDE || lng < -MAX_LONGITUDE || lng > MAX_LONGITUDE) {
            return {
                ok: false,
                code: 'invalid_polygon_point',
                message: `Polygon point ${index + 1} is outside the valid coordinate range.`
            };
        }
        points.push({ lat, lng });
    }

    if (points.length < 3) {
        return { ok: false, code: 'invalid_polygon', message: 'At least 3 polygon points are required.' };
    }
    return { ok: true, points };
}

/* ───────────────────────────── count ───────────────────────────── */

/**
 * Normalizes `requested_properties`.
 *
 * An ABSENT count keeps its established meaning — the plan maximum — because
 * `undefined`, `null` and an empty form value are all real client shapes today.
 * Anything present but unusable (0, negative, fractional, non-numeric, boolean,
 * object) is rejected rather than silently reinterpreted as "max available",
 * which is what previously happened and which also produced fractional
 * reservations.
 */
export function normalizeRequestedCount(value, { fallback }) {
    if (value === undefined || value === null || value === '') {
        return { ok: true, value: Math.max(1, Math.floor(Number(fallback) || 1)), absent: true };
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
        return {
            ok: false,
            code: 'invalid_requested_properties',
            message: 'Property count must be a whole number of at least 1.'
        };
    }
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 1) {
        return {
            ok: false,
            code: 'invalid_requested_properties',
            message: 'Property count must be a whole number of at least 1.'
        };
    }
    return { ok: true, value: numeric, absent: false };
}

/**
 * The server-authorized target.
 *
 * `max_available` means "everything my plan currently allows", so it resolves
 * from the allowance observed INSIDE the usage lock; the browser's number is
 * not authoritative. `fixed` keeps its existing behaviour exactly: capped by
 * the same allowance, with the cap disclosed.
 */
export function resolveEffectiveCount({ countMode, enteredCount, lockedRemaining }) {
    const remaining = Math.max(0, Math.floor(Number(lockedRemaining) || 0));
    if (countMode === 'max_available') {
        const effective = Math.max(1, remaining);
        return { entered_count: effective, effective_count: effective, capped: false };
    }
    const entered = Math.max(1, Math.floor(Number(enteredCount) || 1));
    const effective = Math.max(1, Math.min(entered, remaining || entered));
    return { entered_count: entered, effective_count: effective, capped: effective < entered };
}

/* ─────────────────────── active-job resolution ─────────────────────── */

function positiveOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizedRouteFilters(filters) {
    if (!filters || typeof filters !== 'object') return null;
    const propertyTypes = Array.isArray(filters.propertyTypes)
        ? [...new Set(filters.propertyTypes.map(value => String(value).trim()).filter(Boolean))].sort()
        : [];
    return {
        propertyTypes,
        excludeCommercial: filters.excludeCommercial === true,
        excludeCondos: filters.excludeCondos === true,
        excludeLand: filters.excludeLand === true
    };
}

function normalizedPoint(point) {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function normalizedRouteBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    if (bounds.enabled !== true) return { enabled: false };
    const start = normalizedPoint(bounds.start_location || bounds.startLocation);
    const end = normalizedPoint(bounds.end_location || bounds.endLocation);
    if (!start || !end) return { enabled: false };
    return {
        enabled: true,
        mode: bounds.mode === 'current_to_home' ? 'current_to_home' : 'home_round_trip',
        start_location: start,
        end_location: end
    };
}

/**
 * The order fields that determine which properties a pull returns, and which a
 * persisted job must be able to prove before it may be resumed.
 *
 * `entered_count` is deliberately NOT compared: what a user's typed Fixed Count
 * means is an unresolved product decision, and comparing it here would bake in
 * one reading of it. `effective_count` — the authorized target — is compared,
 * because that is what actually determines the pull.
 */
export const COMPARED_ORDER_FIELDS = [
    'polygon_hash',
    'count_mode',
    'effective_count',
    'min_price',
    'max_price',
    'sold_months',
    'ownership_range_mode',
    'ownership_range_days',
    'route_filters',
    'route_bounds',
    'repull_mode',
    'previous_pull_date'
];

/**
 * Reads the order out of a persisted job, reporting every field the record
 * cannot prove rather than guessing a default for it.
 */
export function persistedOrderFromJob(job, { polygonHash = null } = {}) {
    const metadata = job?.dry_run_metadata || {};
    const unprovable = [];
    const order = {};

    order.polygon_hash = job?.polygon_hash || polygonHash || null;
    if (!order.polygon_hash) unprovable.push('polygon_hash');

    order.count_mode = metadata.count_mode === 'max_available' || metadata.count_mode === 'fixed'
        ? metadata.count_mode
        : null;
    if (!order.count_mode) unprovable.push('count_mode');

    order.effective_count = positiveOrNull(metadata.requested_properties ?? job?.total_expected);
    if (order.effective_count === null) unprovable.push('effective_count');

    // `metadata.filters` present with a null min_price is meaningful: it is the
    // historic "no price floor". Only a MISSING filters object is unprovable.
    if (metadata.filters && typeof metadata.filters === 'object') {
        order.min_price = positiveOrNull(metadata.filters.min_price);
        order.max_price = positiveOrNull(metadata.filters.max_price);
    } else {
        order.min_price = null;
        order.max_price = null;
        unprovable.push('min_price');
    }

    order.sold_months = positiveOrNull(job?.sold_months);
    if (order.sold_months === null) unprovable.push('sold_months');

    order.ownership_range_mode = metadata.ownership_range_mode === 'custom' || metadata.ownership_range_mode === 'quick'
        ? metadata.ownership_range_mode
        : null;
    if (!order.ownership_range_mode) unprovable.push('ownership_range_mode');

    if (order.ownership_range_mode === 'custom') {
        const min = Number(metadata.ownership_range_days?.min);
        const max = Number(metadata.ownership_range_days?.max);
        const valid = Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max <= 365 && min < max;
        order.ownership_range_days = valid ? { min, max } : null;
        if (!valid) unprovable.push('ownership_range_days');
    } else {
        order.ownership_range_days = null;
    }

    order.route_filters = normalizedRouteFilters(metadata.route_filters);
    if (order.route_filters === null) unprovable.push('route_filters');

    order.route_bounds = normalizedRouteBounds(metadata.route_bounds);
    if (order.route_bounds === null) unprovable.push('route_bounds');

    // Repull intent is only persisted by the primary start path. A record that
    // never stored it cannot prove whether it was a new-area pull or a refresh.
    order.repull_mode = typeof metadata.repull_mode === 'string' && metadata.repull_mode.trim()
        ? metadata.repull_mode.trim()
        : null;
    if (!order.repull_mode) unprovable.push('repull_mode');

    order.previous_pull_date = metadata.previous_pull_date ?? null;

    return { order, unprovable };
}

/** Builds the same shape from the submitted request, for comparison. */
export function requestedOrder(input) {
    return {
        polygon_hash: input.polygon_hash ?? null,
        count_mode: input.count_mode === 'max_available' ? 'max_available' : 'fixed',
        effective_count: positiveOrNull(input.effective_count),
        min_price: positiveOrNull(input.min_price),
        max_price: positiveOrNull(input.max_price),
        sold_months: positiveOrNull(input.sold_months),
        ownership_range_mode: input.ownership_range_mode === 'custom' ? 'custom' : 'quick',
        ownership_range_days: input.ownership_range_mode === 'custom' && input.ownership_range_days
            ? { min: Number(input.ownership_range_days.min), max: Number(input.ownership_range_days.max) }
            : null,
        route_filters: normalizedRouteFilters(input.route_filters),
        route_bounds: normalizedRouteBounds(input.route_bounds) || { enabled: false },
        repull_mode: typeof input.repull_mode === 'string' && input.repull_mode.trim()
            ? input.repull_mode.trim()
            : 'new_area',
        previous_pull_date: input.previous_pull_date ?? null
    };
}

export function compareOrders(requested, persisted, fields = COMPARED_ORDER_FIELDS) {
    const mismatched = fields.filter(field =>
        JSON.stringify(requested?.[field] ?? null) !== JSON.stringify(persisted?.[field] ?? null)
    );
    return { matches: mismatched.length === 0, mismatched_fields: mismatched };
}

/**
 * The explicit active-job outcome.
 *
 * Outcomes: zero | one_exact_match | one_conflict | one_unverifiable |
 * multiple_active. Only `one_exact_match` may be resumed. Nothing here
 * cancels, mutates or selects among several jobs.
 */
export function classifyActivePrecisionJobs(activeJobs, requested, { polygonHash = null } = {}) {
    const jobs = [...(activeJobs || [])];
    if (jobs.length === 0) {
        return { outcome: 'zero', count: 0, job: null, mismatched_fields: [], unprovable_fields: [] };
    }
    if (jobs.length > 1) {
        return {
            outcome: 'multiple_active',
            count: jobs.length,
            job: null,
            job_ids: jobs.map(job => String(job.id)),
            mismatched_fields: [],
            unprovable_fields: []
        };
    }

    const job = jobs[0];
    const { order, unprovable } = persistedOrderFromJob(job, { polygonHash });
    if (unprovable.length > 0) {
        return {
            outcome: 'one_unverifiable',
            count: 1,
            job,
            mismatched_fields: [],
            unprovable_fields: unprovable
        };
    }

    const comparison = compareOrders(requested, order);
    return {
        outcome: comparison.matches ? 'one_exact_match' : 'one_conflict',
        count: 1,
        job,
        persisted_order: order,
        mismatched_fields: comparison.mismatched_fields,
        unprovable_fields: []
    };
}
