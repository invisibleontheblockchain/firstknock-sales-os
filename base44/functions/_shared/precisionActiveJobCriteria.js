export const PRECISION_CRITERIA_SCHEMA_VERSION = 1;
export const DEFAULT_PRECISION_MIN_PRICE = 100000;

const MATERIAL_CRITERIA_FIELDS = [
    'criteria_schema_version',
    'polygon_hash',
    'count_mode',
    'entered_count',
    'effective_count',
    'min_price',
    'max_price',
    'sold_months',
    'ownership_range_mode',
    'ownership_range_days',
    'route_filters',
    'repull_mode',
    'previous_pull_date',
    'force_full_refresh',
    'include_unresolved_followups',
    'route_bounds',
    'immutable_user_id',
    'workspace_id'
];

function isMissing(value) {
    return value === undefined
        || value === null
        || (typeof value === 'string' && value.trim() === '');
}

function positiveNumberOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function countOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 1 ? numeric : null;
}

function stringOrNull(value) {
    if (isMissing(value)) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function timestampOrNull(value) {
    if (isMissing(value)) return null;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : `invalid:${String(value)}`;
}

function normalizeOwnershipRange(mode, range) {
    if (mode !== 'custom') return null;
    const min = Number(range?.min);
    const max = Number(range?.max);
    return Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max <= 365 && min < max
        ? { min, max }
        : null;
}

function normalizeRouteFilters(filters, defaults = null) {
    const source = filters && typeof filters === 'object' ? filters : defaults;
    if (!source || typeof source !== 'object') return null;
    const propertyTypes = Array.isArray(source.propertyTypes)
        ? [...new Set(source.propertyTypes.map(value => String(value).trim()).filter(Boolean))].sort()
        : [];
    return {
        propertyTypes,
        excludeCommercial: source.excludeCommercial === true,
        excludeCondos: source.excludeCondos === true,
        excludeLand: source.excludeLand === true
    };
}

function normalizePoint(point) {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function normalizeRouteBounds(bounds) {
    if (!bounds || bounds.enabled !== true) return { enabled: false };
    const startLocation = normalizePoint(bounds.start_location || bounds.startLocation);
    const endLocation = normalizePoint(bounds.end_location || bounds.endLocation);
    if (!startLocation || !endLocation) return null;
    return {
        enabled: true,
        mode: bounds.mode === 'current_to_home' ? 'current_to_home' : 'home_round_trip',
        start_location: startLocation,
        end_location: endLocation
    };
}

function normalizeCriteriaShape(input, defaultRouteFilters = null) {
    const ownershipMode = input?.ownership_range_mode === 'custom'
        ? 'custom'
        : input?.ownership_range_mode === 'quick'
            ? 'quick'
            : null;
    const countMode = input?.count_mode === 'max_available'
        ? 'max_available'
        : input?.count_mode === 'fixed'
            ? 'fixed'
            : null;
    return {
        criteria_schema_version: Number(input?.criteria_schema_version || PRECISION_CRITERIA_SCHEMA_VERSION),
        polygon_hash: stringOrNull(input?.polygon_hash),
        count_mode: countMode,
        entered_count: countOrNull(input?.entered_count),
        effective_count: countOrNull(input?.effective_count),
        min_price: positiveNumberOrNull(input?.min_price),
        max_price: positiveNumberOrNull(input?.max_price),
        sold_months: positiveNumberOrNull(input?.sold_months),
        ownership_range_mode: ownershipMode,
        ownership_range_days: normalizeOwnershipRange(ownershipMode, input?.ownership_range_days),
        route_filters: normalizeRouteFilters(input?.route_filters, defaultRouteFilters),
        repull_mode: stringOrNull(input?.repull_mode),
        previous_pull_date: timestampOrNull(input?.previous_pull_date),
        force_full_refresh: input?.force_full_refresh === true,
        include_unresolved_followups: input?.include_unresolved_followups === true,
        route_bounds: normalizeRouteBounds(input?.route_bounds),
        immutable_user_id: stringOrNull(input?.immutable_user_id),
        workspace_id: stringOrNull(input?.workspace_id)
    };
}

export function normalizePrecisionMinPrice(value) {
    if (isMissing(value)) {
        return { ok: true, value: DEFAULT_PRECISION_MIN_PRICE, defaulted: true };
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
        return {
            ok: false,
            code: 'invalid_min_price',
            message: 'Minimum property value must be a positive number.'
        };
    }
    const normalized = positiveNumberOrNull(value);
    if (normalized === null) {
        return {
            ok: false,
            code: 'invalid_min_price',
            message: 'Minimum property value must be a positive number.'
        };
    }
    return { ok: true, value: normalized, defaulted: false };
}

export function normalizePrecisionMaxPrice(value) {
    if (isMissing(value)) return { ok: true, value: null };
    if (typeof value !== 'number' && typeof value !== 'string') {
        return {
            ok: false,
            code: 'invalid_max_price',
            message: 'Maximum property value must be a positive number when provided.'
        };
    }
    const normalized = positiveNumberOrNull(value);
    if (normalized === null) {
        return {
            ok: false,
            code: 'invalid_max_price',
            message: 'Maximum property value must be a positive number when provided.'
        };
    }
    return { ok: true, value: normalized };
}

export function precisionWorkspaceIdentity(user) {
    return stringOrNull(user?.team_manager_id || user?.data?.team_manager_id || user?.id);
}

function asArray(value) {
    return Array.isArray(value) ? value : (value?.items || []);
}

function activeJobTime(job) {
    const timestamp = new Date(job?.created_date || job?.started_at || job?.updated_date || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function findActivePrecisionJob(base44, user) {
    const entity = base44?.asServiceRole?.entities?.FetchJob;
    if (!entity || typeof entity.filter !== 'function') {
        throw new Error('Service-owned FetchJob lookup is unavailable.');
    }

    const immutableUserId = stringOrNull(user?.id);
    const email = stringOrNull(user?.email)?.toLowerCase() || null;
    const filters = [];
    for (const status of ['running', 'pending']) {
        if (immutableUserId) filters.push({ precision_usage_user_id: immutableUserId, status });
        if (email) filters.push({ user_email: user.email, status });
    }

    const jobsById = new Map();
    for (const result of await Promise.all(filters.map(filter => entity.filter(filter, '-created_date', 20)))) {
        for (const job of asArray(result)) {
            if (!job?.id || !['running', 'pending'].includes(job.status)) continue;
            const jobImmutableUserId = stringOrNull(job.precision_usage_user_id);
            const belongsToUser = jobImmutableUserId
                ? jobImmutableUserId === immutableUserId
                : stringOrNull(job.user_email)?.toLowerCase() === email;
            if (belongsToUser) jobsById.set(String(job.id), job);
        }
    }

    return [...jobsById.values()].sort((left, right) =>
        activeJobTime(right) - activeJobTime(left)
        || String(left.id).localeCompare(String(right.id))
    )[0] || null;
}

export function buildRequestedPrecisionCriteria(input) {
    return normalizeCriteriaShape({
        criteria_schema_version: PRECISION_CRITERIA_SCHEMA_VERSION,
        ...input
    });
}

export function buildExistingPrecisionCriteria(job, {
    polygonHash = null,
    defaultRouteFilters = null
} = {}) {
    const metadata = job?.dry_run_metadata || {};
    if (metadata.precision_criteria && typeof metadata.precision_criteria === 'object') {
        return normalizeCriteriaShape(metadata.precision_criteria, defaultRouteFilters);
    }

    const ownershipMode = metadata.ownership_range_mode === 'custom'
        ? 'custom'
        : metadata.ownership_range_mode === 'quick'
            ? 'quick'
            : null;
    const inferredRepullMode = metadata.repull_mode
        || (job?.pull_mode === 'new_area' || job?.pull_mode === 'full_refresh' ? 'new_area' : null);

    return normalizeCriteriaShape({
        criteria_schema_version: PRECISION_CRITERIA_SCHEMA_VERSION,
        polygon_hash: job?.polygon_hash || polygonHash,
        count_mode: metadata.count_mode,
        entered_count: metadata.requested_properties_before_cap,
        effective_count: metadata.requested_properties ?? job?.total_expected,
        min_price: metadata.filters?.min_price,
        max_price: metadata.filters?.max_price,
        sold_months: job?.sold_months,
        ownership_range_mode: ownershipMode,
        ownership_range_days: metadata.ownership_range_days,
        route_filters: metadata.route_filters,
        repull_mode: inferredRepullMode,
        previous_pull_date: metadata.previous_pull_date,
        force_full_refresh: metadata.force_full_refresh === true || job?.force_full_refresh === true,
        include_unresolved_followups: metadata.include_unresolved_followups === true,
        route_bounds: metadata.route_bounds || { enabled: false },
        immutable_user_id: job?.precision_usage_user_id,
        workspace_id: metadata.workspace_id || metadata.workspace_identity
    }, defaultRouteFilters);
}

export function comparePrecisionCriteria(requested, active) {
    const mismatchedFields = MATERIAL_CRITERIA_FIELDS.filter(field =>
        JSON.stringify(requested?.[field] ?? null) !== JSON.stringify(active?.[field] ?? null)
    );
    return {
        matches: mismatchedFields.length === 0,
        mismatched_fields: mismatchedFields
    };
}

export function precisionCriteriaDiagnostic(criteria) {
    return Object.fromEntries(MATERIAL_CRITERIA_FIELDS.map(field => [field, criteria?.[field] ?? null]));
}
