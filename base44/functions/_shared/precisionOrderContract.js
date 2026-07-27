// PR A — Precision order contract (Stages 0-4, C0 -> C1).
//
// One place for the rules that decide WHO is ordering, WHAT they ordered, and
// WHETHER an existing job already covers it. Both start paths import this so
// they cannot drift apart again.
//
// Shapes here deliberately match PR #66's `_shared/precisionActiveJobCriteria.js`
// so a job written by this module is accepted as `schema_v1` downstream without
// reconstruction. The two modules should be unified once PR #66 lands; until
// then they are kept field-for-field compatible and that compatibility is
// asserted by test/precision-order-pr66-compatibility.test.mjs.

export const PRECISION_CRITERIA_SCHEMA_VERSION = 1;
export const PRECISION_PROVIDER_CONTRACT_VERSION = 1;

/* ─────────────────────────────── identity ─────────────────────────────── */

/**
 * Workspace scope for an authenticated actor. A rep's workspace is their
 * manager; a manager's workspace is themselves.
 *
 * This records an authorization scope. It does NOT move usage attribution:
 * usage stays on `precision_usage_user_id`. Matches PR #66's
 * `precisionWorkspaceIdentity` exactly.
 */
export function precisionWorkspaceIdentity(user) {
    const raw = user?.team_manager_id || user?.data?.team_manager_id || user?.id;
    if (raw === undefined || raw === null) return null;
    const normalized = String(raw).trim();
    return normalized || null;
}

export function normalizeUsageEmail(value) {
    return String(value || '').trim().toLowerCase();
}

/**
 * Whether a FetchJob's usage belongs to this actor.
 *
 * The immutable subject is authoritative. Email is a fallback ONLY for rows
 * written before `precision_usage_user_id` existed — otherwise a second account
 * sharing an email would have its usage charged here, and could block this
 * user's pulls with its active jobs.
 */
export function precisionJobBelongsToSubject(job, user) {
    const jobSubject = String(job?.precision_usage_user_id || '').trim();
    if (jobSubject) return jobSubject === String(user?.id || '').trim();
    const jobEmail = normalizeUsageEmail(job?.user_email);
    return Boolean(jobEmail) && jobEmail === normalizeUsageEmail(user?.email);
}

/** Filters a merged job list down to the ones this actor actually owns. */
export function selectPrecisionJobsForSubject(jobs, user) {
    return (jobs || []).filter(job => precisionJobBelongsToSubject(job, user));
}

/* ─────────────────────────────── polygon ─────────────────────────────── */

const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;

/**
 * Validates and normalizes a drawn ring.
 *
 * Geometry is conserved exactly: no closure, dedupe, rewinding or reordering.
 * The only change from the previous behaviour is that an unusable vertex is
 * now REPORTED instead of being silently dropped, which used to turn an
 * N-point ring into a different (N-1)-point ring with a different hash.
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

/* ──────────────────────────────── count ──────────────────────────────── */

/**
 * Normalizes `requested_properties`.
 *
 * An ABSENT count is legitimate and means "the plan maximum". Anything present
 * but unusable — 0, '', a negative, a decimal, a non-numeric string, a boolean,
 * an object — is now rejected instead of being silently reinterpreted as
 * "max available", which is what previously happened and which also produced
 * fractional reservations that PR #66 cannot route.
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
 * The server-authoritative target.
 *
 * `max_available` means "everything my plan currently allows", so it is
 * resolved from the allowance observed INSIDE the usage lock and the browser's
 * number is ignored. `fixed` is capped by that same allowance and the cap is
 * disclosed.
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

/* ─────────────────────────────── criteria ─────────────────────────────── */

function positiveOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function countOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 1 ? numeric : null;
}

function stringOrNull(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function timestampOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
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

function normalizeCriteriaRouteFilters(filters, defaults = null) {
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

function normalizeCriteriaPoint(point) {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function normalizeCriteriaRouteBounds(bounds) {
    if (!bounds || bounds.enabled !== true) return { enabled: false };
    const startLocation = normalizeCriteriaPoint(bounds.start_location || bounds.startLocation);
    const endLocation = normalizeCriteriaPoint(bounds.end_location || bounds.endLocation);
    if (!startLocation || !endLocation) return { enabled: false };
    return {
        enabled: true,
        mode: bounds.mode === 'current_to_home' ? 'current_to_home' : 'home_round_trip',
        start_location: startLocation,
        end_location: endLocation
    };
}

/** Every field that makes two orders materially different. */
export const MATERIAL_CRITERIA_FIELDS = [
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

export function buildPrecisionCriteria(input, defaultRouteFilters = null) {
    const ownershipMode = input?.ownership_range_mode === 'custom'
        ? 'custom'
        : input?.ownership_range_mode === 'quick' ? 'quick' : null;
    const countMode = input?.count_mode === 'max_available'
        ? 'max_available'
        : input?.count_mode === 'fixed' ? 'fixed' : null;
    return {
        criteria_schema_version: Number(input?.criteria_schema_version || PRECISION_CRITERIA_SCHEMA_VERSION),
        polygon_hash: stringOrNull(input?.polygon_hash),
        count_mode: countMode,
        entered_count: countOrNull(input?.entered_count),
        effective_count: countOrNull(input?.effective_count),
        min_price: positiveOrNull(input?.min_price),
        max_price: positiveOrNull(input?.max_price),
        sold_months: positiveOrNull(input?.sold_months),
        ownership_range_mode: ownershipMode,
        ownership_range_days: normalizeOwnershipRange(ownershipMode, input?.ownership_range_days),
        route_filters: normalizeCriteriaRouteFilters(input?.route_filters, defaultRouteFilters),
        repull_mode: stringOrNull(input?.repull_mode),
        previous_pull_date: timestampOrNull(input?.previous_pull_date),
        force_full_refresh: input?.force_full_refresh === true,
        include_unresolved_followups: input?.include_unresolved_followups === true,
        route_bounds: normalizeCriteriaRouteBounds(input?.route_bounds),
        immutable_user_id: stringOrNull(input?.immutable_user_id),
        workspace_id: stringOrNull(input?.workspace_id)
    };
}

/**
 * Reconstructs the criteria of a job that may predate the snapshot. Prefers the
 * persisted snapshot; falls back to the loose metadata older jobs carry.
 */
export function existingPrecisionCriteria(job, { polygonHash = null, defaultRouteFilters = null } = {}) {
    const metadata = job?.dry_run_metadata || {};
    if (metadata.precision_criteria && typeof metadata.precision_criteria === 'object' && !Array.isArray(metadata.precision_criteria)) {
        return buildPrecisionCriteria(metadata.precision_criteria, defaultRouteFilters);
    }
    const ownershipMode = metadata.ownership_range_mode === 'custom'
        ? 'custom'
        : metadata.ownership_range_mode === 'quick' ? 'quick' : null;
    return buildPrecisionCriteria({
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
        repull_mode: metadata.repull_mode || (job?.pull_mode === 'new_area' || job?.pull_mode === 'full_refresh' ? 'new_area' : null),
        previous_pull_date: metadata.previous_pull_date,
        force_full_refresh: metadata.force_full_refresh === true || job?.force_full_refresh === true,
        include_unresolved_followups: metadata.include_unresolved_followups === true,
        route_bounds: metadata.route_bounds || { enabled: false },
        immutable_user_id: job?.precision_usage_user_id,
        workspace_id: metadata.workspace_id || metadata.workspace_identity
    }, defaultRouteFilters);
}

/**
 * The subset a job written BEFORE the criteria snapshot existed can actually
 * prove, and which also determines which properties the pull will return.
 *
 * Comparing a legacy job against the full material set would make every
 * in-flight job at deploy time look like a conflict, purely because it predates
 * `workspace_id` and `repull_mode`. That would be reinterpreting an old job
 * under new semantics, which is exactly what must not happen. Identity is not
 * in this list because ownership is verified separately and earlier.
 */
export const LEGACY_COMPARABLE_CRITERIA_FIELDS = [
    'polygon_hash',
    'count_mode',
    'entered_count',
    'effective_count',
    'min_price',
    'max_price',
    'sold_months',
    'ownership_range_mode',
    'ownership_range_days'
];

/**
 * Whether a criteria snapshot actually satisfies the downstream schema-v1
 * contract, and may therefore be published as one.
 *
 * This matters because the downstream validator is STRICTER for schema-v1 than
 * for legacy records: schema-v1 requires a positive `min_price`, whereas the
 * legacy path deliberately accepts `min_price: null` as "no price floor".
 * Publishing a snapshot that cannot satisfy the v1 rules would convert a job
 * the consumer accepts today into one it rejects — a regression dressed up as
 * an upgrade. When the criteria cannot satisfy v1, PR A persists the workspace
 * and the versions but withholds the snapshot, so the record stays on the
 * legacy path with strictly MORE evidence than before.
 */
export function precisionCriteriaSatisfiesSchemaV1(criteria) {
    const missing = [];
    if (criteria?.criteria_schema_version !== PRECISION_CRITERIA_SCHEMA_VERSION) missing.push('criteria_schema_version');
    if (!criteria?.polygon_hash) missing.push('polygon_hash');
    if (!['fixed', 'max_available'].includes(criteria?.count_mode)) missing.push('count_mode');
    if (!(Number(criteria?.entered_count) > 0)) missing.push('entered_count');
    if (!(Number(criteria?.effective_count) > 0)) missing.push('effective_count');
    if (!(Number(criteria?.min_price) > 0)) missing.push('min_price');
    if (!(Number(criteria?.sold_months) > 0)) missing.push('sold_months');
    if (!['quick', 'custom'].includes(criteria?.ownership_range_mode)) missing.push('ownership_range_mode');
    if (criteria?.ownership_range_mode === 'custom'
        && !(criteria?.ownership_range_days && criteria.ownership_range_days.min < criteria.ownership_range_days.max)) {
        missing.push('ownership_range_days');
    }
    if (!criteria?.route_filters || typeof criteria.route_filters !== 'object') missing.push('route_filters');
    if (!criteria?.repull_mode) missing.push('repull_mode');
    if (!criteria?.route_bounds || typeof criteria.route_bounds !== 'object') missing.push('route_bounds');
    if (!criteria?.immutable_user_id) missing.push('immutable_user_id');
    if (!criteria?.workspace_id) missing.push('workspace_id');
    return { ok: missing.length === 0, missing };
}

/** True when a job carries a first-class criteria snapshot written by PR A. */
export function hasPrecisionCriteriaSnapshot(job) {
    const criteria = job?.dry_run_metadata?.precision_criteria;
    return Boolean(criteria && typeof criteria === 'object' && !Array.isArray(criteria));
}

export function comparePrecisionCriteria(requested, active, fields = MATERIAL_CRITERIA_FIELDS) {
    const mismatched = fields.filter(field =>
        JSON.stringify(requested?.[field] ?? null) !== JSON.stringify(active?.[field] ?? null)
    );
    return { matches: mismatched.length === 0, mismatched_fields: mismatched };
}

export function precisionCriteriaDiagnostic(criteria) {
    return Object.fromEntries(MATERIAL_CRITERIA_FIELDS.map(field => [field, criteria?.[field] ?? null]));
}

/* ────────────────────────────── active jobs ────────────────────────────── */

function activeJobTime(job) {
    const timestamp = new Date(job?.created_date || job?.started_at || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * The explicit active-job outcome. Previously the code took index 0 of an
 * unsorted, email-keyed page of 5 and resumed it without comparing anything,
 * so a completely different order silently became a resume of the old one.
 *
 * Outcome is one of: zero | one_exact_match | one_conflict | multiple_active.
 */
export function classifyActivePrecisionJobs(jobs, requestedCriteria, options = {}) {
    const owned = [...(jobs || [])].sort((left, right) =>
        activeJobTime(right) - activeJobTime(left) || String(left.id).localeCompare(String(right.id))
    );

    if (owned.length === 0) return { outcome: 'zero', count: 0, job: null, criteria: null, mismatched_fields: [] };
    if (owned.length > 1) {
        return {
            outcome: 'multiple_active',
            count: owned.length,
            job: owned[0],
            criteria: null,
            mismatched_fields: [],
            job_ids: owned.map(job => String(job.id))
        };
    }

    const job = owned[0];
    const criteria = existingPrecisionCriteria(job, options);
    const snapshotted = hasPrecisionCriteriaSnapshot(job);
    const comparison = comparePrecisionCriteria(
        requestedCriteria,
        criteria,
        snapshotted ? MATERIAL_CRITERIA_FIELDS : LEGACY_COMPARABLE_CRITERIA_FIELDS
    );
    return {
        outcome: comparison.matches ? 'one_exact_match' : 'one_conflict',
        count: 1,
        job,
        criteria,
        criteria_verification: snapshotted ? 'schema_v1' : 'legacy_reconstructed',
        compared_fields: snapshotted ? MATERIAL_CRITERIA_FIELDS : LEGACY_COMPARABLE_CRITERIA_FIELDS,
        mismatched_fields: comparison.mismatched_fields
    };
}
