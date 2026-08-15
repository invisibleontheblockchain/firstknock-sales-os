/**
 * Server-owned Precision control-plane primitives.
 *
 * This module deliberately has no npm imports so the same rules can be used by
 * Base44/Deno functions and deterministic Node tests. External clients (Stripe,
 * Neon and Base44 entities) are injected at the boundary.
 */
export const PRECISION_CRITERIA_SCHEMA_VERSION = 1;
export const DEFAULT_PRECISION_MIN_PRICE = 100000;
export const FREE_PRECISION_PROPERTY_LIMIT = 50;
export const PAID_PRECISION_PROPERTY_LIMIT = 1000;
export const PRECISION_PRICE_FLOOR_CENTS = 9900;
export const DEFAULT_PRECISION_ROUTE_FILTERS = Object.freeze({
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
});

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
const ACTIVE_STATUSES = new Set(['pending', 'running']);
const RETRYABLE_STATUSES = new Set(['failed']);
const COUNT_MODES = new Set(['fixed', 'max_available']);
const OWNERSHIP_MODES = new Set(['quick', 'custom']);
const REPULL_MODES = new Set(['new_area', 'fill_gaps', 'max_since_last']);
const ROUTE_BOUND_MODES = new Set(['home_round_trip', 'current_to_home']);
const QUICK_SOLD_MONTH_OPTIONS = [1 / 30, 2 / 30, 0.25, 0.5, 1, 3, 6, 12];
const MAX_DISCOVERY_RECORDS = 20000;
const DISCOVERY_PAGE_SIZE = 500;

export class PrecisionControlError extends Error {
    constructor(code, message, status = 400, details = {}) {
        super(message);
        this.name = 'PrecisionControlError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function controlError(code, message, status = 400, details = {}) {
    throw new PrecisionControlError(code, message, status, details);
}

export function precisionErrorPayload(error) {
    if (error instanceof PrecisionControlError) {
        return {
            status: Number(error.status) || 400,
            body: {
                error: error.code,
                message: error.message,
                ...(error.details || {})
            }
        };
    }
    return {
        status: 500,
        body: {
            error: 'precision_start_failed',
            message: 'Precision operation could not be completed. No job was authorized.'
        }
    };
}

function hasOwn(value, key) {
    return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function isMissing(value) {
    return value === undefined
        || value === null
        || (typeof value === 'string' && value.trim() === '');
}

function positiveNumberOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function positiveIntegerOrNull(value) {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric >= 1 ? numeric : null;
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

export function asPrecisionTimestamp(value) {
    const timestamp = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
}

export function precisionCriteriaReferenceMs(job) {
    const metadata = job?.dry_run_metadata && typeof job.dry_run_metadata === 'object'
        ? job.dry_run_metadata
        : {};
    return hasOwn(metadata, 'criteria_reference_at')
        ? asPrecisionTimestamp(metadata.criteria_reference_at)
        : null;
}

function normalizeOwnershipRange(mode, range) {
    if (mode !== 'custom') return null;
    const min = Number(range?.min);
    const max = Number(range?.max);
    return Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max <= 365 && min < max
        ? { min, max }
        : null;
}

export function normalizePrecisionRouteFilters(filters, defaults = null) {
    const source = filters && typeof filters === 'object' ? filters : defaults;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const requested = Array.isArray(source.propertyTypes)
        ? source.propertyTypes.map(value => String(value).trim()).filter(Boolean)
        : [];
    const propertyTypes = [...new Set(requested.filter(value => value === 'Single Family'))].sort();
    return {
        propertyTypes: propertyTypes.length ? propertyTypes : ['Single Family'],
        excludeCommercial: true,
        excludeCondos: true,
        excludeLand: true
    };
}

function normalizeRoutePoint(point) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) return null;
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
}

export function normalizePrecisionRouteBounds(bounds) {
    if (!bounds || bounds.enabled !== true) return { enabled: false };
    if (!ROUTE_BOUND_MODES.has(bounds.mode)) return null;
    const startLocation = normalizeRoutePoint(bounds.start_location || bounds.startLocation);
    const endLocation = normalizeRoutePoint(bounds.end_location || bounds.endLocation);
    if (!startLocation || !endLocation) return null;
    return {
        enabled: true,
        mode: bounds.mode,
        start_location: startLocation,
        end_location: endLocation
    };
}

function normalizeCriteriaShape(input, defaultRouteFilters = null) {
    const ownershipMode = OWNERSHIP_MODES.has(input?.ownership_range_mode)
        ? input.ownership_range_mode
        : null;
    const countMode = COUNT_MODES.has(input?.count_mode) ? input.count_mode : null;
    return {
        criteria_schema_version: Number(input?.criteria_schema_version || PRECISION_CRITERIA_SCHEMA_VERSION),
        polygon_hash: stringOrNull(input?.polygon_hash),
        count_mode: countMode,
        entered_count: positiveIntegerOrNull(input?.entered_count),
        effective_count: positiveIntegerOrNull(input?.effective_count),
        min_price: positiveNumberOrNull(input?.min_price),
        max_price: positiveNumberOrNull(input?.max_price),
        sold_months: positiveNumberOrNull(input?.sold_months),
        ownership_range_mode: ownershipMode,
        ownership_range_days: normalizeOwnershipRange(ownershipMode, input?.ownership_range_days),
        route_filters: normalizePrecisionRouteFilters(input?.route_filters, defaultRouteFilters),
        repull_mode: stringOrNull(input?.repull_mode),
        previous_pull_date: timestampOrNull(input?.previous_pull_date),
        force_full_refresh: input?.force_full_refresh === true,
        include_unresolved_followups: input?.include_unresolved_followups === true,
        route_bounds: normalizePrecisionRouteBounds(input?.route_bounds),
        immutable_user_id: stringOrNull(input?.immutable_user_id),
        workspace_id: stringOrNull(input?.workspace_id)
    };
}

export function normalizePrecisionMinPrice(value) {
    if (isMissing(value)) return { ok: true, value: DEFAULT_PRECISION_MIN_PRICE, defaulted: true };
    if (typeof value !== 'number' && typeof value !== 'string') {
        return { ok: false, code: 'invalid_min_price', message: 'Minimum property value must be a positive number.' };
    }
    const normalized = positiveNumberOrNull(value);
    return normalized === null
        ? { ok: false, code: 'invalid_min_price', message: 'Minimum property value must be a positive number.' }
        : { ok: true, value: normalized, defaulted: false };
}

export function normalizePrecisionMaxPrice(value) {
    if (isMissing(value)) return { ok: true, value: null };
    if (typeof value !== 'number' && typeof value !== 'string') {
        return { ok: false, code: 'invalid_max_price', message: 'Maximum property value must be a positive number when provided.' };
    }
    const normalized = positiveNumberOrNull(value);
    return normalized === null
        ? { ok: false, code: 'invalid_max_price', message: 'Maximum property value must be a positive number when provided.' }
        : { ok: true, value: normalized };
}

export function precisionWorkspaceIdentity(user) {
    return stringOrNull(user?.team_manager_id || user?.data?.team_manager_id || user?.id);
}

export function normalizePrecisionPolygon(input) {
    if (!Array.isArray(input) || input.length < 3) return null;
    const normalized = [];
    for (const point of input) {
        const parsed = normalizeRoutePoint(point);
        if (!parsed) return null;
        normalized.push(parsed);
    }
    const unique = new Set(normalized.map(point => `${point.lat.toFixed(8)}:${point.lng.toFixed(8)}`));
    if (unique.size < 3) return null;
    return normalized;
}

export function precisionPolygonAreaSqMi(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    const avgLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
    const milesPerLat = 69;
    const milesPerLng = 69 * Math.cos(avgLat * Math.PI / 180);
    let sum = 0;
    for (let index = 0; index < points.length; index++) {
        const left = points[index];
        const right = points[(index + 1) % points.length];
        sum += (left.lng * milesPerLng * right.lat * milesPerLat)
            - (right.lng * milesPerLng * left.lat * milesPerLat);
    }
    return Math.abs(sum) / 2;
}

export function precisionPolygonCentroid(points) {
    return {
        lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
        lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length
    };
}

export async function precisionPolygonHash(points) {
    const normalized = points.map(point => [
        Number(Number(point.lat).toFixed(6)),
        Number(Number(point.lng).toFixed(6))
    ]);
    const bytes = new TextEncoder().encode(JSON.stringify(normalized));
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
}

export async function precisionProcessorTokenHash(token) {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized) {
        controlError(
            'precision_processor_token_invalid',
            'The processor handoff credential is invalid.',
            500
        );
    }
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(normalized)
    );
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

export async function verifyPrecisionProcessorToken(token, expectedHash) {
    const normalizedHash = typeof expectedHash === 'string'
        ? expectedHash.trim().toLowerCase()
        : '';
    if (!/^[a-f0-9]{64}$/.test(normalizedHash)) return false;
    let actualHash;
    try {
        actualHash = await precisionProcessorTokenHash(token);
    } catch {
        return false;
    }
    let difference = actualHash.length ^ normalizedHash.length;
    for (let index = 0; index < Math.max(actualHash.length, normalizedHash.length); index++) {
        difference |= (actualHash.charCodeAt(index) || 0)
            ^ (normalizedHash.charCodeAt(index) || 0);
    }
    return difference === 0;
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
    const ownershipMode = OWNERSHIP_MODES.has(metadata.ownership_range_mode)
        ? metadata.ownership_range_mode
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
    return { matches: mismatchedFields.length === 0, mismatched_fields: mismatchedFields };
}

export function precisionCriteriaDiagnostic(criteria) {
    return Object.fromEntries(MATERIAL_CRITERIA_FIELDS.map(field => [field, criteria?.[field] ?? null]));
}

function strictNumber(value, { integer = false } = {}) {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value > 0
        && (!integer || Number.isSafeInteger(value));
}

function isAllowedQuickSoldMonths(value) {
    return typeof value === 'number'
        && Number.isFinite(value)
        && QUICK_SOLD_MONTH_OPTIONS.some(option => Math.abs(option - value) < 0.000001);
}

function maxSinceLastSoldMonths(previousPullDate, referenceMs = Date.now()) {
    const previousMs = asPrecisionTimestamp(previousPullDate);
    if (previousMs === null || previousMs > referenceMs) return null;
    const elapsedDays = Math.max(
        1,
        Math.min(365, Math.ceil((referenceMs - previousMs) / (24 * 60 * 60 * 1000)))
    );
    return Math.max(1 / 30, Math.min(12, elapsedDays / 30));
}

function numbersNearlyEqual(left, right) {
    return Number.isFinite(left)
        && Number.isFinite(right)
        && Math.abs(left - right) < 0.000001;
}

function strictPositiveNumberReason(value, { integer = false, nullable = false } = {}) {
    if (value === undefined) return 'missing';
    if (value === null) return nullable ? null : 'null_not_allowed';
    if (typeof value !== 'number') return 'wrong_type';
    if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) return 'malformed';
    return value > 0 ? null : 'out_of_range';
}

function strictEnumReason(value, allowedValues) {
    if (value === undefined) return 'missing';
    if (value === null) return 'null_not_allowed';
    if (typeof value !== 'string') return 'wrong_type';
    return allowedValues.has(value) ? null : 'unsupported_value';
}

function strictBooleanReason(value) {
    if (value === undefined) return 'missing';
    if (value === null) return 'null_not_allowed';
    return typeof value === 'boolean' ? null : 'wrong_type';
}

function strictNonemptyStringReason(value) {
    if (value === undefined) return 'missing';
    if (value === null) return 'null_not_allowed';
    if (typeof value !== 'string') return 'wrong_type';
    return value.trim() ? null : 'malformed';
}

function strictRouteFiltersReason(value) {
    if (value === undefined) return 'missing';
    if (value === null) return 'null_not_allowed';
    if (typeof value !== 'object' || Array.isArray(value)) return 'wrong_type';
    if (
        !hasOwn(value, 'propertyTypes')
        || !hasOwn(value, 'excludeCommercial')
        || !hasOwn(value, 'excludeCondos')
        || !hasOwn(value, 'excludeLand')
    ) return 'malformed';
    if (
        !Array.isArray(value.propertyTypes)
        || typeof value.excludeCommercial !== 'boolean'
        || typeof value.excludeCondos !== 'boolean'
        || typeof value.excludeLand !== 'boolean'
    ) return 'wrong_type';
    return value.propertyTypes.length === 1
        && value.propertyTypes[0] === 'Single Family'
        && value.excludeCommercial === true
        && value.excludeCondos === true
        && value.excludeLand === true
        ? null
        : 'unsupported_value';
}

function strictRoutePointReason(value) {
    if (value === undefined) return 'missing';
    if (value === null) return 'null_not_allowed';
    if (typeof value !== 'object' || Array.isArray(value)) return 'wrong_type';
    if (!hasOwn(value, 'lat') || !hasOwn(value, 'lng')) return 'malformed';
    if (value.lat === null || value.lng === null) return 'null_not_allowed';
    if (typeof value.lat !== 'number' || typeof value.lng !== 'number') return 'wrong_type';
    if (!Number.isFinite(value.lat) || !Number.isFinite(value.lng)) return 'malformed';
    return value.lat >= -90
        && value.lat <= 90
        && value.lng >= -180
        && value.lng <= 180
        ? null
        : 'out_of_range';
}

function strictRouteBoundsReason(value) {
    if (value === undefined) return 'missing';
    if (value === null) return 'null_not_allowed';
    if (typeof value !== 'object' || Array.isArray(value)) return 'wrong_type';
    if (!hasOwn(value, 'enabled')) return 'malformed';
    if (typeof value.enabled !== 'boolean') return 'wrong_type';
    if (value.enabled === false) return null;
    if (!hasOwn(value, 'mode') || !hasOwn(value, 'start_location') || !hasOwn(value, 'end_location')) {
        return 'malformed';
    }
    if (value.mode === null) return 'null_not_allowed';
    if (typeof value.mode !== 'string') return 'wrong_type';
    if (!ROUTE_BOUND_MODES.has(value.mode)) return 'unsupported_value';
    const startReason = strictRoutePointReason(value.start_location);
    const endReason = strictRoutePointReason(value.end_location);
    if (startReason === 'missing' || endReason === 'missing') return 'malformed';
    return startReason || endReason;
}

function strictOwnershipRangeReason(mode, value) {
    if (mode === 'quick') {
        if (value === undefined) return 'missing';
        return value === null ? null : 'relational_conflict';
    }
    if (mode !== 'custom') return null;
    if (value === undefined) return 'missing';
    if (value === null) return 'null_not_allowed';
    if (typeof value !== 'object' || Array.isArray(value)) return 'wrong_type';
    if (!hasOwn(value, 'min') || !hasOwn(value, 'max')) return 'malformed';
    const minReason = strictPositiveNumberReason(value.min, { integer: true });
    const maxReason = strictPositiveNumberReason(value.max, { integer: true });
    if (minReason || maxReason) return minReason || maxReason;
    if (value.min > 365 || value.max > 365) return 'out_of_range';
    return value.min < value.max ? null : 'relational_conflict';
}

function strictSchemaVersionReason(value) {
    if (value === undefined) return 'missing';
    if (value === null) return 'null_not_allowed';
    if (typeof value !== 'number') return 'wrong_type';
    if (!Number.isSafeInteger(value)) return 'malformed';
    return value === PRECISION_CRITERIA_SCHEMA_VERSION ? null : 'unsupported_schema_version';
}

function strictPolygonHashReason(value) {
    if (value === undefined) return 'missing';
    if (value === null) return 'null_not_allowed';
    if (typeof value !== 'string') return 'wrong_type';
    return /^[a-f0-9]{16}$/i.test(value) ? null : 'malformed';
}

function strictPreviousPullDateReason(repullMode, value) {
    if (repullMode === 'new_area') {
        return value === null ? null : 'relational_conflict';
    }
    if (value === undefined) return 'missing';
    if (value === null) return 'null_not_allowed';
    if (typeof value !== 'string') return 'wrong_type';
    return asPrecisionTimestamp(value) === null ? 'malformed' : null;
}

function uniqueInvalidReasons(invalidReasons) {
    const seenFields = new Set();
    const uniqueReasons = [];
    for (const diagnostic of invalidReasons) {
        if (!diagnostic?.field || !diagnostic.reason || seenFields.has(diagnostic.field)) continue;
        seenFields.add(diagnostic.field);
        uniqueReasons.push({
            field: diagnostic.field,
            reason: diagnostic.reason
        });
    }
    return uniqueReasons;
}

function strictCriteriaFailure(invalidReasons) {
    const uniqueReasons = uniqueInvalidReasons(invalidReasons);
    return {
        ok: false,
        code: 'legacy_precision_criteria_unverifiable',
        invalid_fields: uniqueReasons.map(diagnostic => diagnostic.field),
        invalid_reasons: uniqueReasons
    };
}

export function validateStrictPrecisionCriteriaV1(input) {
    const invalidReasons = [];
    const addInvalid = (field, reason) => {
        if (reason) invalidReasons.push({ field, reason });
    };
    if (input === undefined) {
        return strictCriteriaFailure([{ field: 'precision_criteria', reason: 'missing' }]);
    }
    if (input === null) {
        return strictCriteriaFailure([{ field: 'precision_criteria', reason: 'null_not_allowed' }]);
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
        return strictCriteriaFailure([{ field: 'precision_criteria', reason: 'wrong_type' }]);
    }
    for (const field of MATERIAL_CRITERIA_FIELDS) {
        if (!hasOwn(input, field) || input[field] === undefined) {
            addInvalid(field, 'missing');
        }
    }
    addInvalid('criteria_schema_version', strictSchemaVersionReason(input.criteria_schema_version));
    addInvalid('polygon_hash', strictPolygonHashReason(input.polygon_hash));
    addInvalid('count_mode', strictEnumReason(input.count_mode, COUNT_MODES));
    addInvalid('entered_count', strictPositiveNumberReason(input.entered_count, { integer: true }));
    addInvalid('effective_count', strictPositiveNumberReason(input.effective_count, { integer: true }));
    addInvalid('min_price', strictPositiveNumberReason(input.min_price));
    addInvalid('max_price', strictPositiveNumberReason(input.max_price, { nullable: true }));
    if (
        strictNumber(input.min_price)
        && strictNumber(input.max_price)
        && input.max_price < input.min_price
    ) addInvalid('max_price', 'relational_conflict');
    const soldMonthsReason = strictPositiveNumberReason(input.sold_months);
    if (soldMonthsReason) {
        addInvalid('sold_months', soldMonthsReason);
    } else if (
        input.ownership_range_mode === 'quick'
        && input.repull_mode !== 'max_since_last'
        && !isAllowedQuickSoldMonths(input.sold_months)
    ) {
        addInvalid('sold_months', 'unsupported_value');
    } else if (
        input.ownership_range_mode === 'quick'
        && input.repull_mode === 'max_since_last'
        && (input.sold_months < 1 / 30 || input.sold_months > 12)
    ) {
        addInvalid('sold_months', 'out_of_range');
    }
    addInvalid(
        'ownership_range_mode',
        strictEnumReason(input.ownership_range_mode, OWNERSHIP_MODES)
    );
    addInvalid(
        'ownership_range_days',
        strictOwnershipRangeReason(input.ownership_range_mode, input.ownership_range_days)
    );
    if (
        input.ownership_range_mode === 'custom'
        && input.ownership_range_days
        && typeof input.ownership_range_days.max === 'number'
    ) {
        const expectedCustomMonths = input.ownership_range_days.max === 365
            ? 12
            : input.ownership_range_days.max / 30;
        if (!numbersNearlyEqual(input.sold_months, expectedCustomMonths)) {
            addInvalid('sold_months', 'relational_conflict');
        }
    }
    addInvalid('route_filters', strictRouteFiltersReason(input.route_filters));
    addInvalid('repull_mode', strictEnumReason(input.repull_mode, REPULL_MODES));
    if (
        input.repull_mode === 'max_since_last'
        && input.ownership_range_mode !== 'quick'
    ) {
        addInvalid('repull_mode', 'relational_conflict');
        addInvalid('ownership_range_mode', 'relational_conflict');
    }
    addInvalid(
        'previous_pull_date',
        strictPreviousPullDateReason(input.repull_mode, input.previous_pull_date)
    );
    addInvalid('force_full_refresh', strictBooleanReason(input.force_full_refresh));
    addInvalid(
        'include_unresolved_followups',
        strictBooleanReason(input.include_unresolved_followups)
    );
    addInvalid('route_bounds', strictRouteBoundsReason(input.route_bounds));
    addInvalid('immutable_user_id', strictNonemptyStringReason(input.immutable_user_id));
    addInvalid('workspace_id', strictNonemptyStringReason(input.workspace_id));
    if (
        input.count_mode === 'fixed'
        && strictNumber(input.entered_count, { integer: true })
        && strictNumber(input.effective_count, { integer: true })
        && input.effective_count > input.entered_count
    ) addInvalid('effective_count', 'relational_conflict');
    if (
        input.count_mode === 'max_available'
        && strictNumber(input.entered_count, { integer: true })
        && strictNumber(input.effective_count, { integer: true })
        && input.entered_count !== input.effective_count
    ) {
        addInvalid('entered_count', 'relational_conflict');
        addInvalid('effective_count', 'relational_conflict');
    }

    if (invalidReasons.length) {
        return strictCriteriaFailure(invalidReasons);
    }
    return {
        ok: true,
        value: {
            criteria_schema_version: PRECISION_CRITERIA_SCHEMA_VERSION,
            polygon_hash: input.polygon_hash.toLowerCase(),
            count_mode: input.count_mode,
            entered_count: input.entered_count,
            effective_count: input.effective_count,
            min_price: input.min_price,
            max_price: input.max_price,
            sold_months: input.sold_months,
            ownership_range_mode: input.ownership_range_mode,
            ownership_range_days: input.ownership_range_mode === 'custom'
                ? { min: input.ownership_range_days.min, max: input.ownership_range_days.max }
                : null,
            route_filters: {
                propertyTypes: ['Single Family'],
                excludeCommercial: true,
                excludeCondos: true,
                excludeLand: true
            },
            repull_mode: input.repull_mode,
            previous_pull_date: input.previous_pull_date === null
                ? null
                : new Date(input.previous_pull_date).toISOString(),
            force_full_refresh: input.force_full_refresh,
            include_unresolved_followups: input.include_unresolved_followups,
            route_bounds: input.route_bounds.enabled
                ? {
                    enabled: true,
                    mode: input.route_bounds.mode,
                    start_location: normalizeRoutePoint(input.route_bounds.start_location),
                    end_location: normalizeRoutePoint(input.route_bounds.end_location)
                }
                : { enabled: false },
            immutable_user_id: String(input.immutable_user_id),
            workspace_id: String(input.workspace_id)
        }
    };
}

function asArray(value) {
    return Array.isArray(value) ? value : (value?.items || []);
}

export async function listAllPrecisionRecords(entity, filter, sort = '-created_date', pageSize = DISCOVERY_PAGE_SIZE) {
    const records = [];
    const seenPageFingerprints = new Set();
    const seenRecordIds = new Set();
    let skip = 0;
    while (skip < MAX_DISCOVERY_RECORDS) {
        const result = await entity.filter(filter, sort, pageSize, skip);
        const items = Array.isArray(result)
            ? result
            : (
                result
                && typeof result === 'object'
                && hasOwn(result, 'items')
                && Array.isArray(result.items)
                    ? result.items
                    : null
            );
        const explicitHasMore = (
            result
            && !Array.isArray(result)
            && hasOwn(result, 'has_more')
        ) ? result.has_more : undefined;
        if (
            explicitHasMore !== undefined
            && typeof explicitHasMore !== 'boolean'
        ) {
            controlError(
                'precision_job_discovery_incomplete',
                'Precision job discovery returned an invalid completeness marker.',
                503
            );
        }
        if (items === null) {
            controlError(
                'precision_job_discovery_incomplete',
                'Precision job discovery returned an invalid page.',
                503
            );
        }
        if (items.length === 0) {
            if (explicitHasMore === true) {
                controlError(
                    'precision_job_discovery_incomplete',
                    'Precision job discovery claimed another page but made no progress.',
                    503
                );
            }
            return records;
        }
        const pageFingerprint = JSON.stringify(items.map((item, index) =>
            stringOrNull(item?.id) || `${skip + index}:${JSON.stringify(item)}`
        ));
        if (seenPageFingerprints.has(pageFingerprint)) {
            controlError(
                'precision_job_discovery_incomplete',
                'Precision job discovery repeated a page and cannot prove completeness.',
                503
            );
        }
        seenPageFingerprints.add(pageFingerprint);
        for (const item of items) {
            const recordId = stringOrNull(item?.id);
            if (!recordId) continue;
            if (seenRecordIds.has(recordId)) {
                controlError(
                    'precision_job_discovery_incomplete',
                    'Precision job discovery repeated a record across pages and cannot prove completeness.',
                    503,
                    { repeated_record_id: recordId }
                );
            }
            seenRecordIds.add(recordId);
        }
        records.push(...items);
        if (records.length > MAX_DISCOVERY_RECORDS) {
            controlError(
                'precision_job_discovery_incomplete',
                'Precision job discovery reached its safety limit and cannot prove completeness.',
                503
            );
        }
        skip += items.length;
        if (explicitHasMore === false) return records;
        if (explicitHasMore !== true && items.length < pageSize) return records;
    }
    controlError(
        'precision_job_discovery_incomplete',
        'Precision job discovery reached its safety limit and cannot prove completeness.',
        503
    );
}

export function isActualPrecisionJob(job) {
    if (!job || typeof job !== 'object') return false;
    const hasImmutableSubject = typeof job.precision_usage_user_id === 'string'
        && Boolean(job.precision_usage_user_id.trim());
    if (
        !hasImmutableSubject
        || job.provider !== 'batchdata'
    ) return false;
    if (job.mode_tag) return job.mode_tag === 'PRECISION_TARGET';
    // A nested criteria object by itself is not an authoritative legacy
    // identity: ordinary metadata is mutable and supplies no immutable
    // subject. hasPrecisionJobMarkers still treats it as a
    // conflict when a user-scoped or ledger-targeted query encounters the row.
    return true;
}

/**
 * Conservative discovery predicate for records that claim any Precision
 * identity or ledger field. A marker-bearing row that fails
 * isActualPrecisionJob is a conflict, not an unrelated job that may be ignored.
 */
export function hasPrecisionJobMarkers(job) {
    if (!job || typeof job !== 'object') return false;
    const hasMaterialValue = (object, key) => {
        if (!hasOwn(object, key)) return false;
        const value = object[key];
        if (value === undefined || value === null) return false;
        if (typeof value === 'string') return Boolean(value.trim());
        if (Array.isArray(value)) return value.length > 0;
        return true;
    };
    const hasLedgerNumberMarker = key => (
        hasOwn(job, key)
        // FetchJob schema defaults serialize zero onto unrelated jobs. Only a
        // positive reservation/count or malformed non-zero evidence claims
        // Precision identity.
        && job[key] !== 0
    );
    const dryRunMetadata = job.dry_run_metadata
        && typeof job.dry_run_metadata === 'object'
        && !Array.isArray(job.dry_run_metadata)
        ? job.dry_run_metadata
        : {};
    const serviceIdentityFields = [
        'precision_usage_user_id',
        'precision_usage_kind',
        'precision_subscription_id',
        'precision_invoice_id',
        'precision_usage_period_start',
        'precision_usage_period_end',
        'precision_usage_recorded_at'
    ];
    const recoveryFields = [
        'precision_cancel_requested_at',
        'precision_watchdog_recovery_at',
        'processor_claim_id',
        'processor_claimed_at',
        'processor_heartbeat_at'
    ];
    const retryProvenanceFields = [
        'source_fetch_job_id',
        'root_fetch_job_id',
        'attempt_number',
        'attempt_reason',
        'attempt_created_at',
        'attempt_actor_user_id',
        'attempt_subject_user_id',
        'attempt_workspace_id',
        'source_criteria_schema_version',
        'source_polygon_hash',
        'source_effective_count',
        'source_status',
        'source_terminal_at'
    ];
    const providerEvidenceFields = [
        'provider_attempt_id',
        'provider_attempt_started_at',
        'provider_outcome_unverifiable_at'
    ];
    const legacyAliasesCompatible = (
        (!hasMaterialValue(job, 'provider') || job.provider === 'batchdata')
        && (!hasMaterialValue(job, 'mode_tag') || job.mode_tag === 'PRECISION_TARGET')
    );
    const legacyBatchSummary = dryRunMetadata.batchdata_summary;
    const hasLegacyBatchSummaryMarker = legacyAliasesCompatible
        && legacyBatchSummary
        && typeof legacyBatchSummary === 'object'
        && !Array.isArray(legacyBatchSummary)
        && hasOwn(legacyBatchSummary, 'active');
    const hasLegacyStartMarker = legacyAliasesCompatible
        && [
            'batchdata_only_started_at',
            'precision_started_at',
            'paid_pull_started_at'
        ].some(key => hasMaterialValue(dryRunMetadata, key));
    return hasLegacyBatchSummaryMarker
        || hasLegacyStartMarker
        || hasMaterialValue(dryRunMetadata, 'precision_criteria')
        || serviceIdentityFields.some(key => hasMaterialValue(job, key))
        || hasLedgerNumberMarker('precision_usage_reserved')
        || hasLedgerNumberMarker('precision_usage_count')
        || recoveryFields.some(key => hasMaterialValue(job, key))
        || retryProvenanceFields.some(key => hasMaterialValue(job, key))
        || providerEvidenceFields.some(key => hasMaterialValue(dryRunMetadata, key));
}

export function precisionJobBelongsToUser(job, user, { requireImmutable = false } = {}) {
    const expectedId = stringOrNull(user?.id);
    const jobId = stringOrNull(job?.precision_usage_user_id);
    if (jobId) return Boolean(expectedId) && jobId === expectedId;
    if (requireImmutable) return false;
    const expectedEmail = stringOrNull(user?.email)?.toLowerCase();
    return Boolean(expectedEmail)
        && stringOrNull(job?.user_email)?.toLowerCase() === expectedEmail;
}

/**
 * Verify the complete service-owned criteria provenance for one Precision
 * FetchJob. This is intentionally broader than schema validation: a canonical
 * object is not trustworthy unless its immutable identity, workspace, polygon,
 * top-level hash, and BatchData-only invariant all agree with the same row and
 * the authenticated subject.
 *
 * The function returns diagnostics instead of throwing so read paths can
 * expose a display-only, explicitly unverified record without ever returning
 * its criteria as authoritative restoration evidence.
 */
export async function verifyPrecisionJobCriteriaEvidence(job, user) {
    const invalidFields = [];
    const invalidReasons = [];
    const mismatchedFields = [];
    const addInvalid = (field, reason) => {
        invalidFields.push(field);
        invalidReasons.push({ field, reason });
    };
    const metadata = job?.dry_run_metadata && typeof job.dry_run_metadata === 'object'
        ? job.dry_run_metadata
        : {};
    const strict = validateStrictPrecisionCriteriaV1(metadata.precision_criteria);
    const criteria = strict.ok ? strict.value : null;
    const polygon = normalizePrecisionPolygon(job?.polygon);
    const areaSqMi = polygon ? precisionPolygonAreaSqMi(polygon) : 0;
    const polygonHash = polygon && Number.isFinite(areaSqMi) && areaSqMi > 0
        ? await precisionPolygonHash(polygon)
        : null;

    if (!isActualPrecisionJob(job)) addInvalid('precision_job_identity', 'malformed');
    if (job?.include_mls !== false) {
        const reason = !hasOwn(job, 'include_mls') || job.include_mls === undefined
            ? 'missing'
            : job.include_mls === null
                ? 'null_not_allowed'
                : typeof job.include_mls !== 'boolean'
                    ? 'wrong_type'
                    : 'unsupported_value';
        addInvalid('include_mls', reason);
    }
    if (
        !hasOwn(job, 'precision_usage_user_id')
        || typeof job.precision_usage_user_id !== 'string'
        || !job.precision_usage_user_id.trim()
    ) {
        const reason = !hasOwn(job, 'precision_usage_user_id')
            || job.precision_usage_user_id === undefined
            ? 'missing'
            : job.precision_usage_user_id === null
                ? 'null_not_allowed'
                : typeof job.precision_usage_user_id !== 'string'
                    ? 'wrong_type'
                    : 'malformed';
        addInvalid('precision_usage_user_id', reason);
    } else if (job.precision_usage_user_id.trim() !== String(user?.id || '')) {
        mismatchedFields.push('precision_usage_user_id');
    }

    if (!strict.ok) {
        for (const diagnostic of strict.invalid_reasons || []) {
            addInvalid(`precision_criteria.${diagnostic.field}`, diagnostic.reason);
        }
    } else {
        const expectedWorkspace = precisionWorkspaceIdentity(user);
        if (criteria.immutable_user_id !== String(user?.id || '')) {
            mismatchedFields.push('precision_criteria.immutable_user_id');
        }
        if (!expectedWorkspace || criteria.workspace_id !== expectedWorkspace) {
            mismatchedFields.push('precision_criteria.workspace_id');
        }

        if (
            !hasOwn(metadata, 'workspace_id')
            || typeof metadata.workspace_id !== 'string'
            || !metadata.workspace_id.trim()
        ) {
            const reason = !hasOwn(metadata, 'workspace_id') || metadata.workspace_id === undefined
                ? 'missing'
                : metadata.workspace_id === null
                    ? 'null_not_allowed'
                    : typeof metadata.workspace_id !== 'string'
                        ? 'wrong_type'
                        : 'malformed';
            addInvalid('dry_run_metadata.workspace_id', reason);
        } else if (
            metadata.workspace_id.trim() !== criteria.workspace_id
            || metadata.workspace_id.trim() !== expectedWorkspace
        ) {
            mismatchedFields.push('dry_run_metadata.workspace_id');
        }

        if (hasOwn(metadata, 'workspace_identity')) {
            const metadataWorkspaceIdentity = typeof metadata.workspace_identity === 'object'
                ? stringOrNull(metadata.workspace_identity?.id)
                : stringOrNull(metadata.workspace_identity);
            if (
                !metadataWorkspaceIdentity
                || metadataWorkspaceIdentity !== criteria.workspace_id
                || metadataWorkspaceIdentity !== expectedWorkspace
            ) {
                mismatchedFields.push('dry_run_metadata.workspace_identity');
            }
        }
        if (hasOwn(job, 'workspace_id')) {
            const topLevelWorkspace = stringOrNull(job.workspace_id);
            if (
                !topLevelWorkspace
                || topLevelWorkspace !== criteria.workspace_id
                || topLevelWorkspace !== expectedWorkspace
            ) {
                mismatchedFields.push('workspace_id');
            }
        }
        if (precisionCriteriaReferenceMs(job) === null) {
            const referenceValue = metadata.criteria_reference_at;
            const reason = !hasOwn(metadata, 'criteria_reference_at')
                || referenceValue === undefined
                ? 'missing'
                : referenceValue === null
                    ? 'null_not_allowed'
                    : typeof referenceValue !== 'string'
                        ? 'wrong_type'
                        : 'malformed';
            addInvalid('dry_run_metadata.criteria_reference_at', reason);
        }
        if (criteria.repull_mode === 'max_since_last') {
            const referenceMs = precisionCriteriaReferenceMs(job);
            const expectedSoldMonths = referenceMs === null
                ? null
                : maxSinceLastSoldMonths(criteria.previous_pull_date, referenceMs);
            if (expectedSoldMonths === null) {
                addInvalid('dry_run_metadata.criteria_reference_at', 'relational_conflict');
            } else if (!numbersNearlyEqual(criteria.sold_months, expectedSoldMonths)) {
                mismatchedFields.push('precision_criteria.sold_months');
            }
        }
    }

    if (!polygon || !Number.isFinite(areaSqMi) || areaSqMi <= 0 || !polygonHash) {
        const polygonValue = job?.polygon;
        const reason = !hasOwn(job, 'polygon') || polygonValue === undefined
            ? 'missing'
            : polygonValue === null
                ? 'null_not_allowed'
                : !Array.isArray(polygonValue)
                    ? 'wrong_type'
                    : polygon && (!Number.isFinite(areaSqMi) || areaSqMi <= 0)
                        ? 'out_of_range'
                        : 'malformed';
        addInvalid('polygon', reason);
    } else {
        if (!criteria || criteria.polygon_hash !== polygonHash) {
            mismatchedFields.push('precision_criteria.polygon_hash');
        }
        if (
            typeof job?.polygon_hash !== 'string'
            || !/^[a-f0-9]{16}$/i.test(job.polygon_hash)
        ) {
            addInvalid('polygon_hash', strictPolygonHashReason(job?.polygon_hash));
        } else if (job.polygon_hash.toLowerCase() !== polygonHash) {
            mismatchedFields.push('polygon_hash');
        }
    }

    const uniqueInvalidReasonDiagnostics = uniqueInvalidReasons(invalidReasons);
    const uniqueInvalidFields = uniqueInvalidReasonDiagnostics.map(diagnostic => diagnostic.field);
    const uniqueMismatchedFields = [...new Set(mismatchedFields)];
    const ok = uniqueInvalidFields.length === 0 && uniqueMismatchedFields.length === 0;
    let code = null;
    let status = 200;
    if (!ok) {
        status = uniqueMismatchedFields.some(field => (
            field.includes('user_id') || field.includes('workspace')
        )) ? 403 : 409;
        code = uniqueInvalidFields.includes('precision_job_identity')
            ? 'fetch_job_not_precision'
            : uniqueInvalidFields.includes('include_mls')
                ? 'precision_include_mls_invariant_violation'
                : uniqueInvalidFields.some(field => field.startsWith('precision_criteria.'))
                    ? 'legacy_precision_criteria_unverifiable'
                    : uniqueInvalidFields.includes('polygon')
                        || uniqueInvalidFields.includes('polygon_hash')
                        || uniqueMismatchedFields.some(field => field.includes('polygon_hash'))
                        ? 'precision_job_polygon_unverifiable'
                        : uniqueMismatchedFields.some(field => field.includes('user_id'))
                            ? 'precision_job_owner_mismatch'
                            : uniqueMismatchedFields.some(field => field.includes('workspace'))
                                ? 'precision_job_workspace_mismatch'
                                : 'precision_job_evidence_unverifiable';
    }

    return {
        ok,
        code,
        status,
        invalid_fields: uniqueInvalidFields,
        invalid_reasons: uniqueInvalidReasonDiagnostics,
        mismatched_fields: uniqueMismatchedFields,
        criteria,
        polygon,
        polygon_hash: polygonHash,
        area_sq_mi: polygonHash ? areaSqMi : null
    };
}

/**
 * Build the only job view the live provider/mapping path is allowed to
 * consume. Every material request alias is overwritten from the one verified
 * canonical snapshot so a stale or corrupted duplicate field cannot silently
 * change paid-provider semantics after provenance validation.
 */
export function buildVerifiedPrecisionProcessingJob(job, evidence, user) {
    if (!evidence?.ok || !evidence.criteria || !evidence.polygon) {
        controlError(
            'precision_job_evidence_unverifiable',
            'A canonical processing view requires fully verified Precision evidence.',
            409,
            { job_id: job?.id || null }
        );
    }
    const criteria = evidence.criteria;
    const center = precisionPolygonCentroid(evidence.polygon);
    return {
        ...job,
        // workspace_properties is keyed by the FetchJob's persisted email.
        // Preserve that stable row locator across account-email changes; the
        // immutable user id/workspace above remains the authorization source.
        user_email: job.user_email,
        workspace_id: criteria.workspace_id,
        polygon: evidence.polygon,
        polygon_hash: evidence.polygon_hash,
        area_sq_mi: evidence.area_sq_mi,
        latitude: center.lat,
        longitude: center.lng,
        sold_months: criteria.sold_months,
        include_mls: false,
        force_full_refresh: criteria.force_full_refresh,
        pull_mode: criteria.force_full_refresh ? 'full_refresh' : 'new_area',
        estimated_record_count: criteria.effective_count,
        total_expected: criteria.effective_count,
        dry_run_metadata: {
            ...(job.dry_run_metadata || {}),
            requested_properties: criteria.effective_count,
            requested_properties_before_cap: criteria.entered_count,
            entered_count: criteria.entered_count,
            effective_count: criteria.effective_count,
            count_mode: criteria.count_mode,
            filters: {
                min_price: criteria.min_price,
                max_price: criteria.max_price
            },
            route_filters: criteria.route_filters,
            route_bounds: criteria.route_bounds,
            repull_mode: criteria.repull_mode,
            previous_pull_date: criteria.previous_pull_date,
            force_full_refresh: criteria.force_full_refresh,
            include_unresolved_followups: criteria.include_unresolved_followups,
            ownership_range_mode: criteria.ownership_range_mode,
            ownership_range_days: criteria.ownership_range_days,
            workspace_id: criteria.workspace_id,
            precision_criteria: criteria
        }
    };
}

export async function loadUserPrecisionJobs(base44, user) {
    const entity = base44?.asServiceRole?.entities?.FetchJob;
    if (!entity || typeof entity.filter !== 'function') {
        controlError('precision_job_lookup_unavailable', 'Service-owned FetchJob lookup is unavailable.', 503);
    }
    const queries = [];
    if (stringOrNull(user?.id)) {
        queries.push({
            authority: 'immutable',
            promise: listAllPrecisionRecords(entity, { precision_usage_user_id: user.id })
        });
    }
    if (stringOrNull(user?.email)) {
        queries.push({
            authority: 'email',
            promise: listAllPrecisionRecords(entity, { user_email: user.email })
        });
    }
    const jobsById = new Map();
    const authorityById = new Map();
    const stableMaterialValue = value => {
        if (Array.isArray(value)) return value.map(stableMaterialValue);
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map(key => [key, stableMaterialValue(value[key])])
            );
        }
        return value;
    };
    const evidenceField = (object, key) => ({
        present: hasOwn(object, key),
        value: hasOwn(object, key) ? object[key] : null
    });
    const materialSnapshot = value => JSON.stringify(stableMaterialValue({
        status: evidenceField(value, 'status'),
        provider: evidenceField(value, 'provider'),
        mode_tag: evidenceField(value, 'mode_tag'),
        phase: evidenceField(value, 'phase'),
        precision_usage_user_id: evidenceField(value, 'precision_usage_user_id'),
        precision_usage_kind: evidenceField(value, 'precision_usage_kind'),
        precision_usage_reserved: evidenceField(value, 'precision_usage_reserved'),
        precision_usage_count: evidenceField(value, 'precision_usage_count'),
        precision_usage_recorded_at: evidenceField(value, 'precision_usage_recorded_at'),
        precision_usage_period_start: evidenceField(value, 'precision_usage_period_start'),
        precision_usage_period_end: evidenceField(value, 'precision_usage_period_end'),
        precision_cancel_requested_at: evidenceField(value, 'precision_cancel_requested_at'),
        precision_watchdog_recovery_at: evidenceField(value, 'precision_watchdog_recovery_at'),
        processor_claim_id: evidenceField(value, 'processor_claim_id'),
        processor_claimed_at: evidenceField(value, 'processor_claimed_at'),
        processor_heartbeat_at: evidenceField(value, 'processor_heartbeat_at'),
        include_mls: evidenceField(value, 'include_mls'),
        polygon: evidenceField(value, 'polygon'),
        polygon_hash: evidenceField(value, 'polygon_hash'),
        completed_at: evidenceField(value, 'completed_at'),
        source_fetch_job_id: evidenceField(value, 'source_fetch_job_id'),
        root_fetch_job_id: evidenceField(value, 'root_fetch_job_id'),
        attempt_number: evidenceField(value, 'attempt_number'),
        attempt_reason: evidenceField(value, 'attempt_reason'),
        attempt_created_at: evidenceField(value, 'attempt_created_at'),
        attempt_actor_user_id: evidenceField(value, 'attempt_actor_user_id'),
        attempt_subject_user_id: evidenceField(value, 'attempt_subject_user_id'),
        attempt_workspace_id: evidenceField(value, 'attempt_workspace_id'),
        source_criteria_schema_version: evidenceField(value, 'source_criteria_schema_version'),
        source_polygon_hash: evidenceField(value, 'source_polygon_hash'),
        source_effective_count: evidenceField(value, 'source_effective_count'),
        source_status: evidenceField(value, 'source_status'),
        source_terminal_at: evidenceField(value, 'source_terminal_at'),
        dry_run_metadata: {
            workspace_id: evidenceField(value.dry_run_metadata, 'workspace_id'),
            workspace_identity: evidenceField(value.dry_run_metadata, 'workspace_identity'),
            precision_criteria: evidenceField(value.dry_run_metadata, 'precision_criteria'),
            criteria_reference_at: evidenceField(value.dry_run_metadata, 'criteria_reference_at'),
            provider_attempt_id: evidenceField(value.dry_run_metadata, 'provider_attempt_id'),
            provider_attempt_started_at: evidenceField(value.dry_run_metadata, 'provider_attempt_started_at'),
            provider_outcome_unverifiable_at: evidenceField(value.dry_run_metadata, 'provider_outcome_unverifiable_at'),
            processor_token_hash: evidenceField(value.dry_run_metadata, 'processor_token_hash')
        }
    }));
    const results = await Promise.all(queries.map(query => query.promise));
    for (let index = 0; index < results.length; index++) {
        const authority = queries[index].authority;
        const result = results[index];
        for (const job of result) {
            if (!job?.id || !precisionJobBelongsToUser(job, user)) continue;
            if (hasPrecisionJobMarkers(job) && !isActualPrecisionJob(job)) {
                const aliasesCompatible = (
                    (!stringOrNull(job.provider) || job.provider === 'batchdata')
                    && (!stringOrNull(job.mode_tag) || job.mode_tag === 'PRECISION_TARGET')
                );
                if (!stringOrNull(job.precision_usage_user_id) && aliasesCompatible) {
                    controlError(
                        'legacy_precision_ownership_unverifiable',
                        'A legacy Precision job lacks immutable ownership evidence. Contact support to run the authorized ledger backfill before starting another pull.',
                        409,
                        { unverifiable_job_ids: [String(job.id)] }
                    );
                }
                controlError(
                    'precision_job_identity_conflict',
                    'A marker-bearing Precision ledger row has conflicting job identity and requires operator review.',
                    409,
                    { conflicting_job_id: job.id }
                );
            }
            if (!isActualPrecisionJob(job)) continue;
            const id = String(job.id);
            const existing = jobsById.get(id);
            if (existing) {
                if (materialSnapshot(existing) !== materialSnapshot(job)) {
                    controlError(
                        'precision_job_discovery_conflict',
                        'Precision job discovery returned conflicting authoritative snapshots. No allowance was authorized.',
                        503,
                        {
                            conflicting_job_id: id,
                            first_authority: authorityById.get(id),
                            second_authority: authority
                        }
                    );
                }
                // The immutable-ID result is authoritative. An identical email
                // result is only a deduplicated compatibility read.
                if (authorityById.get(id) === 'immutable') continue;
            }
            jobsById.set(id, job);
            authorityById.set(id, authority);
        }
    }
    return [...jobsById.values()];
}

export function assertImmutablePrecisionJobOwnership(jobs, user) {
    const expectedUserId = stringOrNull(user?.id);
    const unverifiable = (Array.isArray(jobs) ? jobs : [])
        .filter(isActualPrecisionJob)
        .filter(job => (
            !expectedUserId
            || stringOrNull(job.precision_usage_user_id) !== expectedUserId
        ));
    if (unverifiable.length) {
        controlError(
            'legacy_precision_ownership_unverifiable',
            'A legacy Precision job lacks immutable ownership evidence. Contact support to run the authorized ledger backfill before starting another pull.',
            409,
            { unverifiable_job_ids: unverifiable.map(job => String(job.id)) }
        );
    }
    return true;
}

function precisionHistoryTimestamp(value) {
    const timestamp = asPrecisionTimestamp(value);
    return timestamp === null ? null : new Date(timestamp).toISOString();
}

function exactCompletedHistoryDelivery(job, effectiveCount) {
    const invalidFields = [];
    if (
        !hasOwn(job, 'precision_usage_reserved')
        || typeof job.precision_usage_reserved !== 'number'
        || !Number.isSafeInteger(job.precision_usage_reserved)
        || job.precision_usage_reserved !== 0
    ) {
        invalidFields.push('precision_usage_reserved');
    }
    if (
        !hasOwn(job, 'precision_usage_count')
        || typeof job.precision_usage_count !== 'number'
        || !Number.isSafeInteger(job.precision_usage_count)
        || job.precision_usage_count < 0
        || job.precision_usage_count > effectiveCount
    ) {
        invalidFields.push('precision_usage_count');
    }
    if (precisionHistoryTimestamp(job.precision_usage_recorded_at) === null) {
        invalidFields.push('precision_usage_recorded_at');
    }
    return invalidFields.length
        ? { ok: false, invalid_fields: invalidFields }
        : { ok: true, delivered_count: job.precision_usage_count };
}

function precisionHistorySortMs(entry) {
    return asPrecisionTimestamp(entry?.last_pull_date || entry?.date) || 0;
}

async function buildPrecisionHistoryEntry(job, user) {
    const evidence = await verifyPrecisionJobCriteriaEvidence(job, user);
    const criteriaTimestamp = precisionHistoryTimestamp(
        job?.attempt_created_at
        || job?.dry_run_metadata?.precision_started_at
        || job?.created_date
        || job?.started_at
    );
    const date = precisionHistoryTimestamp(
        job?.completed_at
        || job?.updated_date
        || job?.created_date
        || job?.started_at
    );
    const invalidFields = [...evidence.invalid_fields];
    const invalidReasons = [...(evidence.invalid_reasons || [])];
    let verificationError = evidence.code;
    let deliveredCount = null;

    if (job?.status !== 'completed') {
        invalidFields.push('status');
        verificationError ||= 'precision_history_job_not_completed';
    } else if (evidence.criteria) {
        const delivery = exactCompletedHistoryDelivery(job, evidence.criteria.effective_count);
        if (!delivery.ok) {
            invalidFields.push(...delivery.invalid_fields);
            verificationError ||= 'precision_history_settlement_unverifiable';
        } else {
            deliveredCount = delivery.delivered_count;
        }
    }
    if (!criteriaTimestamp || !date) {
        invalidFields.push('criteria_timestamp');
        verificationError ||= 'precision_history_timestamp_unverifiable';
    }

    const uniqueInvalidFields = [...new Set(invalidFields)];
    const verified = evidence.ok
        && job?.status === 'completed'
        && deliveredCount !== null
        && Boolean(criteriaTimestamp)
        && Boolean(date);
    if (verified) {
        return {
            id: String(job.id),
            job_id: String(job.id),
            source_fetch_job_id: stringOrNull(job.source_fetch_job_id) || String(job.id),
            criteria_source_fetch_job_id: String(job.id),
            criteria_schema_version: evidence.criteria.criteria_schema_version,
            criteria_timestamp: criteriaTimestamp,
            criteria_status: 'server_verified',
            criteria_verified: true,
            polygon: evidence.polygon,
            polygon_hash: evidence.polygon_hash,
            criteria: precisionCriteriaDiagnostic(evidence.criteria),
            status: job.status,
            date,
            last_pull_date: date,
            entered_count: evidence.criteria.entered_count,
            effective_count: evidence.criteria.effective_count,
            delivered_count: deliveredCount
        };
    }

    return {
        id: String(job?.id || ''),
        job_id: String(job?.id || ''),
        source_fetch_job_id: stringOrNull(job?.source_fetch_job_id) || String(job?.id || ''),
        criteria_source_fetch_job_id: null,
        criteria_schema_version: null,
        criteria_timestamp: null,
        criteria_status: 'criteria_unverified',
        criteria_verified: false,
        // A server-normalized polygon is display-only unless the complete
        // evidence above verified. Never return a strict-looking criteria
        // object on this path.
        polygon: evidence.polygon || [],
        polygon_hash: evidence.polygon_hash,
        criteria: null,
        status: job?.status || null,
        date,
        last_pull_date: date,
        entered_count: null,
        effective_count: null,
        delivered_count: null,
        verification_error: verificationError || 'precision_history_evidence_unverifiable',
        invalid_fields: uniqueInvalidFields,
        invalid_reasons: uniqueInvalidReasons(invalidReasons),
        mismatched_fields: evidence.mismatched_fields
    };
}

/**
 * Resolve authenticated Precision history without trusting browser-owned
 * FetchJob reads. For each recomputed polygon, the newest complete verified
 * snapshot wins atomically; fields are never merged across jobs.
 */
export async function resolveVerifiedPrecisionHistory(base44, user, {
    fetchJobId = null,
    limit = 20
} = {}) {
    const jobs = await loadUserPrecisionJobs(base44, user);
    const requestedId = stringOrNull(fetchJobId);
    if (fetchJobId !== null && !requestedId) {
        controlError('invalid_fetch_job_id', 'fetch_job_id must be a nonempty string.', 400);
    }
    if (requestedId) {
        const job = jobs.find(candidate => String(candidate.id) === requestedId);
        if (!job) {
            controlError(
                'precision_history_job_not_found',
                'No owned Precision FetchJob matches this identifier.',
                404
            );
        }
        const entry = await buildPrecisionHistoryEntry(job, user);
        if (!entry.criteria_verified) {
            controlError(
                'precision_history_evidence_unverifiable',
                'This Precision history record cannot be restored because its complete service-owned evidence is not trustworthy.',
                409,
                {
                    fetch_job_id: requestedId,
                    verification_error: entry.verification_error,
                    invalid_fields: entry.invalid_fields,
                    invalid_reasons: entry.invalid_reasons,
                    mismatched_fields: entry.mismatched_fields
                }
            );
        }
        return { state: 'single', job: entry, jobs_scanned: jobs.length };
    }

    const built = await Promise.all(jobs.map(job => buildPrecisionHistoryEntry(job, user)));
    const byPolygon = new Map();
    for (const entry of built) {
        const key = entry.polygon_hash || `job:${entry.job_id}`;
        const existing = byPolygon.get(key);
        const entryTime = precisionHistorySortMs(entry);
        const existingTime = precisionHistorySortMs(existing);
        if (
            !existing
            || (entry.criteria_verified && !existing.criteria_verified)
            || (
                entry.criteria_verified === existing.criteria_verified
                && (
                    entryTime > existingTime
                    || (
                        entryTime === existingTime
                        && String(entry.job_id).localeCompare(String(existing.job_id)) < 0
                    )
                )
            )
        ) {
            byPolygon.set(key, entry);
        }
    }
    const safeLimit = Number.isSafeInteger(limit) && limit >= 1
        ? Math.min(limit, 100)
        : 20;
    const entries = [...byPolygon.values()]
        .sort((left, right) =>
            precisionHistorySortMs(right) - precisionHistorySortMs(left)
            || String(left.job_id).localeCompare(String(right.job_id))
        )
        .slice(0, safeLimit);
    return {
        state: 'ok',
        entries,
        verified_entries: entries.filter(entry => entry.criteria_verified),
        unverified_entries: entries.filter(entry => !entry.criteria_verified),
        jobs_scanned: jobs.length,
        polygons_resolved: byPolygon.size,
        truncated: byPolygon.size > entries.length
    };
}

function activeJobTime(job) {
    return asPrecisionTimestamp(job?.created_date || job?.started_at || job?.updated_date) || 0;
}

export function classifyActivePrecisionJobs(jobs) {
    const active = jobs
        .filter(job => isActualPrecisionJob(job) && ACTIVE_STATUSES.has(job.status))
        .sort((left, right) =>
            activeJobTime(right) - activeJobTime(left)
            || String(left.id).localeCompare(String(right.id))
        );
    if (active.length === 0) return { state: 'none', jobs: [] };
    if (active.length === 1) return { state: 'single', job: active[0] };
    return { state: 'multiple', jobs: active };
}

export function evaluatePrecisionStartSafety(jobs) {
    const activeResolution = classifyActivePrecisionJobs(jobs);
    const providerOutcomeHeldJobs = jobs.filter(job =>
        hasOwn(job?.dry_run_metadata, 'provider_outcome_unverifiable_at')
    );
    const unsettledJobs = jobs.filter(isPrecisionReservationUnsettled);
    let blockerCode = null;
    let blockerJobIds = [];
    if (activeResolution.state === 'multiple') {
        blockerCode = 'multiple_active_precision_jobs';
        blockerJobIds = activeResolution.jobs.map(job => String(job.id));
    } else if (providerOutcomeHeldJobs.length) {
        blockerCode = 'precision_provider_outcome_unverifiable';
        blockerJobIds = providerOutcomeHeldJobs.map(job => String(job.id));
    } else if (activeResolution.state === 'single') {
        blockerCode = 'precision_job_active';
        blockerJobIds = [String(activeResolution.job.id)];
    } else if (unsettledJobs.length) {
        blockerCode = 'precision_reservation_unsettled';
        blockerJobIds = unsettledJobs.map(job => String(job.id));
    }
    return {
        activeResolution,
        providerOutcomeHeldJobs,
        unsettledJobs,
        start_available: blockerCode === null,
        start_blocker_code: blockerCode,
        start_blocker_job_ids: [...new Set(blockerJobIds)]
    };
}

export async function resolveActivePrecisionJobs(base44, user, preloadedJobs = null) {
    const jobs = preloadedJobs || await loadUserPrecisionJobs(base44, user);
    return classifyActivePrecisionJobs(jobs);
}

export async function findActivePrecisionJob(base44, user) {
    const resolution = await resolveActivePrecisionJobs(base44, user);
    if (resolution.state === 'multiple') {
        controlError(
            'multiple_active_precision_jobs',
            'Multiple active Precision jobs exist for this account. No job was selected or changed.',
            409,
            { active_job_ids: resolution.jobs.map(job => job.id) }
        );
    }
    return resolution.state === 'single' ? resolution.job : null;
}

export function legacyPrecisionCompletedCount(job) {
    const countEvidence = (value, field, { required = false } = {}) => {
        if (value === undefined || value === null) {
            if (!required) return null;
            controlError(
                'legacy_precision_usage_unverifiable',
                'A legacy completed Precision job lacks strict server-owned delivery evidence.',
                409,
                { job_id: job?.id || null, invalid_fields: [field] }
            );
        }
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
            controlError(
                'legacy_precision_usage_unverifiable',
                'A legacy completed Precision job contains malformed server-owned delivery evidence.',
                409,
                { job_id: job?.id || null, invalid_fields: [field] }
            );
        }
        return value;
    };
    const summary = job?.dry_run_metadata?.batchdata_summary;
    if (summary && hasOwn(summary, 'active')) {
        return countEvidence(summary.active, 'dry_run_metadata.batchdata_summary.active', { required: true });
    }
    // total_inserted/total_existed include rejected route rows in the legacy
    // processor and therefore cannot prove qualifying delivered usage.
    controlError(
        'legacy_precision_usage_unverifiable',
        'A legacy completed Precision job lacks a strict qualifying-property counter. Contact support for authorized exact-row reconciliation.',
        409,
        {
            job_id: job?.id || null,
            invalid_fields: ['dry_run_metadata.batchdata_summary.active']
        }
    );
}

export function precisionReservationAmount(job) {
    if (hasOwn(job, 'precision_usage_reserved')) {
        const explicit = job.precision_usage_reserved;
        if (typeof explicit !== 'number' || !Number.isSafeInteger(explicit) || explicit < 0) {
            controlError(
                'precision_reservation_unverifiable',
                'A Precision FetchJob contains malformed explicit reservation evidence.',
                409,
                { job_id: job?.id || null }
            );
        }
        return explicit;
    }
    if (ACTIVE_STATUSES.has(job?.status)) {
        const legacy = job?.total_expected ?? job?.estimated_record_count ?? 0;
        if (typeof legacy !== 'number' || !Number.isSafeInteger(legacy) || legacy < 0) {
            controlError(
                'precision_reservation_unverifiable',
                'An active legacy Precision FetchJob contains malformed reservation evidence.',
                409,
                { job_id: job?.id || null }
            );
        }
        return legacy;
    }
    return 0;
}

export function hasPrecisionServiceLedgerEvidence(job) {
    return [
        'precision_usage_reserved',
        'precision_usage_count',
        'precision_usage_recorded_at'
    ].some(field => hasOwn(job, field));
}

export function isGenuineLegacyPrecisionJob(job) {
    return isActualPrecisionJob(job) && !hasPrecisionServiceLedgerEvidence(job);
}

export function isPrecisionReservationUnsettled(job) {
    if (!isActualPrecisionJob(job)) return false;
    const hasExplicitReservation = hasOwn(job, 'precision_usage_reserved');
    const hasUsageCount = hasOwn(job, 'precision_usage_count');
    const hasRecordedAt = hasOwn(job, 'precision_usage_recorded_at');
    const hasServiceLedgerEvidence = hasPrecisionServiceLedgerEvidence(job);

    if (hasExplicitReservation) {
        let reserved;
        try {
            reserved = precisionReservationAmount(job);
        } catch {
            return true;
        }
        if (reserved > 0) return true;
        const deliveredCount = job.precision_usage_count;
        return (
            !hasUsageCount
            || typeof deliveredCount !== 'number'
            || !Number.isSafeInteger(deliveredCount)
            || deliveredCount < 0
            || asPrecisionTimestamp(job.precision_usage_recorded_at) === null
        );
    }

    // Any partial service-ledger write is not legacy evidence. In particular,
    // a missing reservation field cannot be interpreted as a released hold.
    if (hasServiceLedgerEvidence) return true;

    // Genuine legacy active, failed, and cancelled jobs never had exact
    // service-ledger settlement. They remain blocked until the processor or
    // watchdog counts persisted properties and writes the complete ledger.
    return ACTIVE_STATUSES.has(job?.status)
        || job?.status === 'failed'
        || job?.status === 'cancelled';
}

export function precisionJobUsage(job) {
    const reserved = precisionReservationAmount(job);
    if (job?.precision_usage_recorded_at) {
        const explicitCount = job.precision_usage_count;
        const canonicalEffectiveCount = job?.dry_run_metadata?.precision_criteria?.effective_count;
        if (
            asPrecisionTimestamp(job.precision_usage_recorded_at) === null
            || !hasOwn(job, 'precision_usage_count')
            || typeof explicitCount !== 'number'
            || !Number.isSafeInteger(explicitCount)
            || explicitCount < 0
            || (
                canonicalEffectiveCount !== undefined
                && (
                    typeof canonicalEffectiveCount !== 'number'
                    || !Number.isSafeInteger(canonicalEffectiveCount)
                    || canonicalEffectiveCount < 1
                    || explicitCount > canonicalEffectiveCount
                )
            )
        ) {
            controlError(
                'precision_usage_unverifiable',
                'A settled Precision FetchJob contains malformed delivered-count evidence.',
                409,
                { job_id: job?.id || null }
            );
        }
        return { used: explicitCount, reserved };
    }
    const hasServiceSettlementEvidence = hasPrecisionServiceLedgerEvidence(job);
    if (job?.status === 'completed' && !hasServiceSettlementEvidence) {
        return { used: legacyPrecisionCompletedCount(job), reserved: 0 };
    }
    if (
        ['completed', 'failed', 'cancelled'].includes(job?.status)
        && hasServiceSettlementEvidence
        && reserved === 0
    ) {
        controlError(
            'precision_usage_unverifiable',
            'A terminal Precision FetchJob contains incomplete exact-settlement evidence.',
            409,
            { job_id: job?.id || null }
        );
    }
    return { used: 0, reserved };
}

export function isMeteredPrecisionEntitlement(entitlement) {
    return entitlement?.kind === 'paid' || entitlement?.kind === 'beta';
}

function samePeriod(left, right) {
    const leftMs = asPrecisionTimestamp(left);
    const rightMs = asPrecisionTimestamp(right);
    return leftMs !== null && rightMs !== null && Math.abs(leftMs - rightMs) < 1000;
}

function jobMatchesMeteredEntitlement(job, entitlement) {
    if (!isMeteredPrecisionEntitlement(entitlement) || !samePeriod(job.precision_usage_period_start, entitlement.periodStart)) return false;
    if (entitlement.kind !== 'beta') return true;
    return job.precision_subscription_id === entitlement.subscriptionId
        && samePeriod(job.precision_usage_period_end, entitlement.periodEnd);
}

export function calculatePrecisionUsage(jobs, entitlement) {
    const periodStart = asPrecisionTimestamp(entitlement.periodStart);
    const periodEnd = asPrecisionTimestamp(entitlement.periodEnd);
    let trialUsed = 0;
    let trialReserved = 0;
    let paidUsed = 0;
    let paidReserved = 0;
    let lifetimeUsed = 0;
    const unsettledJobIds = [];

    for (const job of jobs.filter(isActualPrecisionJob)) {
        if (isPrecisionReservationUnsettled(job)) unsettledJobIds.push(String(job.id));
        const usage = precisionJobUsage(job);
        lifetimeUsed += usage.used;
        const startedAt = asPrecisionTimestamp(job.started_at || job.created_date || job.dry_run_metadata?.batchdata_only_started_at);
        if (job.precision_usage_kind === 'trial') {
            trialUsed += usage.used;
            trialReserved += usage.reserved;
        } else if (job.precision_usage_kind === 'paid') {
            if (jobMatchesMeteredEntitlement(job, entitlement)) {
                paidUsed += usage.used;
                paidReserved += usage.reserved;
            }
        } else if (job.precision_usage_kind !== 'unmetered') {
            if (
                isMeteredPrecisionEntitlement(entitlement)
                && periodStart !== null
                && startedAt !== null
                && startedAt >= periodStart
                && (periodEnd === null || startedAt < periodEnd)
            ) {
                paidUsed += usage.used;
                paidReserved += usage.reserved;
            } else {
                trialUsed += usage.used;
                trialReserved += usage.reserved;
            }
        }
    }

    trialUsed = Math.min(FREE_PRECISION_PROPERTY_LIMIT, trialUsed);
    trialReserved = Math.min(Math.max(0, FREE_PRECISION_PROPERTY_LIMIT - trialUsed), trialReserved);
    const limit = Math.max(1, Math.floor(Number(entitlement.limit || (
        isMeteredPrecisionEntitlement(entitlement)
            ? PAID_PRECISION_PROPERTY_LIMIT
            : FREE_PRECISION_PROPERTY_LIMIT
    ))));
    const bucketUsed = isMeteredPrecisionEntitlement(entitlement) ? paidUsed : trialUsed;
    const bucketReserved = isMeteredPrecisionEntitlement(entitlement) ? paidReserved : trialReserved;
    const used = Math.min(limit, bucketUsed);
    const reserved = Math.min(Math.max(0, limit - used), bucketReserved);
    const meterUsed = Math.min(limit, used + reserved);
    return {
        used,
        reserved,
        meterUsed,
        remaining: Math.max(0, limit - meterUsed),
        lifetimeUsed,
        trialUsed,
        trialRemaining: Math.max(0, FREE_PRECISION_PROPERTY_LIMIT - trialUsed),
        unsettledReservationCount: unsettledJobIds.length,
        unsettledJobIds
    };
}

export async function reconcileLegacyPrecisionJobs({
    base44,
    user,
    jobs,
    entitlement,
    nowIso = new Date().toISOString()
}) {
    assertImmutablePrecisionJobOwnership(jobs, user);
    const legacyCompleted = (Array.isArray(jobs) ? jobs : [])
        .filter(job => (
            !job.precision_usage_kind
            && job.status === 'completed'
            && isGenuineLegacyPrecisionJob(job)
        ))
        .sort((left, right) =>
            (asPrecisionTimestamp(left.started_at || left.created_date) || 0)
            - (asPrecisionTimestamp(right.started_at || right.created_date) || 0)
            || String(left.id).localeCompare(String(right.id))
        );
    if (legacyCompleted.length === 0) {
        return { jobs, reconciledCount: 0 };
    }
    const entity = base44?.asServiceRole?.entities?.FetchJob;
    if (!entity || typeof entity.update !== 'function') {
        controlError(
            'precision_job_update_unavailable',
            'Precision ledger reconciliation is temporarily unavailable.',
            503
        );
    }

    const periodStartMs = asPrecisionTimestamp(entitlement?.periodStart);
    const periodEndMs = asPrecisionTimestamp(entitlement?.periodEnd);
    let includedTrialAssigned = jobs
        .filter(job => job.precision_usage_kind === 'trial')
        .reduce((sum, job) => sum + precisionJobUsage(job).used, 0);
    const fallbackNowMs = asPrecisionTimestamp(nowIso) ?? Date.now();
    let reconciledCount = 0;

    for (const job of legacyCompleted) {
        const count = legacyPrecisionCompletedCount(job);
        const startedAt = asPrecisionTimestamp(
            job.started_at
            || job.created_date
            || job.dry_run_metadata?.batchdata_only_started_at
        );
        let kind = 'unmetered';
        if (
            isMeteredPrecisionEntitlement(entitlement)
            && periodStartMs !== null
            && startedAt !== null
            && startedAt >= periodStartMs
            && (periodEndMs === null || startedAt < periodEndMs)
        ) {
            kind = 'paid';
        } else if (includedTrialAssigned < FREE_PRECISION_PROPERTY_LIMIT) {
            kind = 'trial';
            includedTrialAssigned += count;
        }
        const completedAtMs = asPrecisionTimestamp(job.completed_at);
        const recordedAt = new Date(completedAtMs ?? fallbackNowMs).toISOString();
        const update = {
            precision_usage_user_id: String(user.id),
            precision_usage_kind: kind,
            ...(kind === 'paid' && entitlement?.subscriptionId ? {
                precision_subscription_id: entitlement.subscriptionId,
                ...(entitlement.invoiceId ? { precision_invoice_id: entitlement.invoiceId } : {}),
                ...(entitlement.periodStart ? { precision_usage_period_start: entitlement.periodStart } : {}),
                ...(entitlement.periodEnd ? { precision_usage_period_end: entitlement.periodEnd } : {})
            } : {}),
            precision_usage_reserved: 0,
            precision_usage_count: count,
            precision_usage_recorded_at: recordedAt
        };
        await entity.update(job.id, update);
        Object.assign(job, update);
        reconciledCount++;
    }
    return { jobs, reconciledCount };
}

function stripeTimestampIso(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function invoiceCoversCurrentPeriod(subscription, invoice) {
    const currentStart = Number(subscription?.current_period_start);
    if (!Number.isFinite(currentStart) || currentStart <= 0) return false;
    if ((invoice?.lines?.data || []).some(line => {
        const lineSubscription = typeof line?.subscription === 'string' ? line.subscription : line?.subscription?.id;
        const start = Number(line?.period?.start);
        const end = Number(line?.period?.end);
        return (!lineSubscription || lineSubscription === subscription.id)
            && Number.isFinite(start) && Number.isFinite(end)
            && start <= currentStart && currentStart < end;
    })) return true;
    const start = Number(invoice?.period_start);
    const end = Number(invoice?.period_end);
    return Number.isFinite(start) && Number.isFinite(end) && start <= currentStart && currentStart < end;
}

function paidPrecisionEvidence(subscription, userId) {
    if (!subscription || String(subscription?.metadata?.base44_user_id || '') !== String(userId)) return null;
    const amountCents = Math.max(0, ...(subscription.items?.data || []).map(item => Number(item?.price?.unit_amount || 0)));
    const invoice = subscription.latest_invoice;
    const invoiceSubscriptionId = typeof invoice?.subscription === 'string' ? invoice.subscription : invoice?.subscription?.id;
    const trialEnded = !subscription.trial_end || Number(subscription.trial_end) * 1000 <= Date.now();
    if (subscription.status !== 'active' || !trialEnded || amountCents < PRECISION_PRICE_FLOOR_CENTS) return null;
    if (!invoice || typeof invoice === 'string' || invoice.status !== 'paid' || Number(invoice.amount_paid || 0) <= 0) return null;
    if (invoiceSubscriptionId && invoiceSubscriptionId !== subscription.id) return null;
    if (!invoiceCoversCurrentPeriod(subscription, invoice)) return null;
    const periodStart = stripeTimestampIso(subscription.current_period_start);
    const periodEnd = stripeTimestampIso(subscription.current_period_end);
    if (!periodStart || !periodEnd) return null;
    return {
        kind: 'paid',
        paidAccess: true,
        proAccess: true,
        limit: PAID_PRECISION_PROPERTY_LIMIT,
        precisionLimit: PAID_PRECISION_PROPERTY_LIMIT,
        subscriptionId: subscription.id,
        invoiceId: invoice.id || null,
        periodStart,
        periodEnd
    };
}

function trialPrecisionEvidence(subscription, userId) {
    if (!subscription || String(subscription?.metadata?.base44_user_id || '') !== String(userId)) return null;
    const amountCents = Math.max(0, ...(subscription.items?.data || []).map(item => Number(item?.price?.unit_amount || 0)));
    return subscription.status === 'trialing' && amountCents >= PRECISION_PRICE_FLOOR_CENTS
        ? {
            kind: 'trial',
            paidAccess: false,
            proAccess: true,
            limit: FREE_PRECISION_PROPERTY_LIMIT,
            precisionLimit: FREE_PRECISION_PROPERTY_LIMIT,
            subscriptionId: subscription.id,
            invoiceId: null,
            periodStart: null,
            periodEnd: null
        }
        : null;
}

function betaPrecisionEvidence(user, rawGrants) {
    if (!rawGrants || user?.id === undefined || user?.id === null) return null;
    let document;
    try {
        document = JSON.parse(rawGrants);
    } catch {
        return null;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document) || document.version !== 1 || !document.grants || typeof document.grants !== 'object' || Array.isArray(document.grants)) return null;
    const immutableUserId = String(user.id);
    if (!hasOwn(document.grants, immutableUserId)) return null;
    const grant = document.grants[immutableUserId];
    const grantId = typeof grant?.grant_id === 'string' ? grant.grant_id.trim() : '';
    const precisionLimit = grant?.precision_limit;
    const canvasSeats = grant?.canvas_seats;
    const periodStartMs = typeof grant?.starts_at === 'string' ? Date.parse(grant.starts_at) : NaN;
    const periodEndMs = typeof grant?.ends_at === 'string' ? Date.parse(grant.ends_at) : NaN;
    const now = Date.now();
    if (
        !grant || typeof grant !== 'object' || Array.isArray(grant)
        || grant.status !== 'active'
        || !grantId
        || !Number.isSafeInteger(precisionLimit) || precisionLimit <= 0 || precisionLimit > PAID_PRECISION_PROPERTY_LIMIT
        || !Number.isSafeInteger(canvasSeats) || canvasSeats <= 0 || canvasSeats > 100
        || !Number.isFinite(periodStartMs) || !Number.isFinite(periodEndMs) || periodStartMs >= periodEndMs
        || now < periodStartMs || now >= periodEndMs
    ) return null;
    return {
        kind: 'beta',
        paidAccess: true,
        proAccess: true,
        limit: precisionLimit,
        precisionLimit,
        subscriptionId: grantId,
        invoiceId: null,
        periodStart: new Date(periodStartMs).toISOString(),
        periodEnd: new Date(periodEndMs).toISOString()
    };
}

export async function resolvePrecisionEntitlement({
    user,
    StripeClass,
    stripeSecret,
    betaAccessGrants = null
}) {
    const beta = betaPrecisionEvidence(user, betaAccessGrants);
    if (beta) return beta;
    if (!stripeSecret || typeof StripeClass !== 'function') {
        controlError('precision_entitlement_unavailable', 'Stripe billing verification is unavailable.', 503);
    }
    const stripe = new StripeClass(stripeSecret);
    const candidates = new Map();
    if (user?.subscription_id) {
        try {
            const direct = await stripe.subscriptions.retrieve(String(user.subscription_id), { expand: ['latest_invoice'] });
            candidates.set(direct.id, direct);
        } catch (error) {
            if (error?.raw?.code !== 'resource_missing' && error?.code !== 'resource_missing') throw error;
        }
    }
    if (user?.stripe_customer_id && typeof stripe.subscriptions.list === 'function') {
        let startingAfter = null;
        const seenCursors = new Set();
        for (let discovered = 0; discovered < 1000;) {
            const listed = await stripe.subscriptions.list({
                customer: String(user.stripe_customer_id),
                status: 'all',
                limit: 100,
                expand: ['data.latest_invoice'],
                ...(startingAfter ? { starting_after: startingAfter } : {})
            });
            const subscriptions = Array.isArray(listed?.data) ? listed.data : null;
            if (!subscriptions) {
                controlError(
                    'precision_entitlement_unavailable',
                    'Stripe customer subscription discovery returned an invalid page.',
                    503
                );
            }
            for (const subscription of subscriptions) {
                if (subscription?.id) candidates.set(subscription.id, subscription);
            }
            discovered += subscriptions.length;
            if (listed.has_more !== true) break;
            const nextCursor = stringOrNull(subscriptions.at(-1)?.id);
            if (
                !nextCursor
                || subscriptions.length === 0
                || seenCursors.has(nextCursor)
                || discovered >= 1000
            ) {
                controlError(
                    'precision_entitlement_unavailable',
                    'Stripe customer subscription discovery could not prove completeness.',
                    503
                );
            }
            seenCursors.add(nextCursor);
            startingAfter = nextCursor;
        }
    }
    const ordered = () => [...candidates.values()].sort((left, right) =>
        Number(right.current_period_start || right.created || 0) - Number(left.current_period_start || left.created || 0)
        || String(left.id || '').localeCompare(String(right.id || ''))
    );
    let paid = ordered().map(subscription => paidPrecisionEvidence(subscription, user.id)).find(Boolean);
    if (!paid && typeof stripe.subscriptions.search === 'function') {
        const escapedUserId = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        let pageToken = null;
        const seenPageTokens = new Set();
        for (let discoveredCount = 0; discoveredCount < 1000;) {
            const discovered = await stripe.subscriptions.search({
                query: `metadata['base44_user_id']:'${escapedUserId}'`,
                limit: 100,
                expand: ['data.latest_invoice'],
                ...(pageToken ? { page: pageToken } : {})
            });
            const subscriptions = Array.isArray(discovered?.data) ? discovered.data : null;
            if (!subscriptions) {
                controlError(
                    'precision_entitlement_unavailable',
                    'Stripe metadata subscription discovery returned an invalid page.',
                    503
                );
            }
            for (const subscription of subscriptions) {
                if (subscription?.id) candidates.set(subscription.id, subscription);
            }
            discoveredCount += subscriptions.length;
            if (discovered.has_more !== true) break;
            const nextPage = stringOrNull(discovered.next_page);
            if (
                !nextPage
                || subscriptions.length === 0
                || seenPageTokens.has(nextPage)
                || discoveredCount >= 1000
            ) {
                controlError(
                    'precision_entitlement_unavailable',
                    'Stripe metadata subscription discovery could not prove completeness.',
                    503
                );
            }
            seenPageTokens.add(nextPage);
            pageToken = nextPage;
        }
        paid = ordered().map(subscription => paidPrecisionEvidence(subscription, user.id)).find(Boolean);
    }
    if (paid) return paid;
    for (const subscription of ordered()) {
        const trial = trialPrecisionEvidence(subscription, user.id);
        if (trial) return trial;
    }
    return {
        kind: 'trial',
        paidAccess: false,
        proAccess: false,
        limit: FREE_PRECISION_PROPERTY_LIMIT,
        precisionLimit: FREE_PRECISION_PROPERTY_LIMIT,
        subscriptionId: null,
        invoiceId: null,
        periodStart: null,
        periodEnd: null
    };
}

function parseOwnershipRequest(body) {
    const rawMode = body.ownership_range_mode;
    const mode = rawMode === undefined || rawMode === null || rawMode === '' ? 'quick' : String(rawMode);
    if (!OWNERSHIP_MODES.has(mode)) {
        controlError('invalid_ownership_range', 'ownership_range_mode must be either quick or custom.');
    }
    if (mode === 'quick') return { mode, range: null };
    const min = Number(body.ownership_min_days);
    const max = Number(body.ownership_max_days);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 365 || min >= max) {
        controlError(
            'invalid_ownership_range',
            'Custom ownership range requires whole-day minimum and maximum values from 1 to 365, with minimum less than maximum.'
        );
    }
    return { mode, range: { min, max } };
}

function soldMonthsForOwnership(
    ownership,
    rawSoldMonths,
    repullMode,
    previousPullDate,
    referenceMs = Date.now()
) {
    if (ownership.mode === 'custom') return ownership.range.max === 365 ? 12 : ownership.range.max / 30;
    if (repullMode === 'max_since_last') {
        const expected = maxSinceLastSoldMonths(previousPullDate, referenceMs);
        const requested = Number(rawSoldMonths);
        if (expected === null || !numbersNearlyEqual(requested, expected)) {
            controlError(
                'invalid_sold_months',
                'max_since_last sold_months must match the server-derived previous pull window.'
            );
        }
        return expected;
    }
    const soldMonths = Number(rawSoldMonths ?? 12);
    if (!isAllowedQuickSoldMonths(soldMonths)) {
        controlError('invalid_sold_months', 'sold_months must be one of the supported Precision quick ranges.');
    }
    return soldMonths;
}

function isPremiumRecentRange(soldMonths) {
    return Number.isFinite(Number(soldMonths)) && Number(soldMonths) <= 1;
}

export function parseDirectPrecisionStartRequest(body = {}) {
    const criteriaReferenceAt = new Date().toISOString();
    const criteriaReferenceMs = new Date(criteriaReferenceAt).getTime();
    if (body.include_mls === true) {
        controlError('precision_include_mls_forbidden', 'Precision is BatchData-only and cannot enable MLS ingestion.');
    }
    const polygon = normalizePrecisionPolygon(body.polygon);
    if (!polygon) controlError('invalid_precision_polygon', 'At least three valid polygon points are required.');
    const areaSqMi = precisionPolygonAreaSqMi(polygon);
    if (!Number.isFinite(areaSqMi) || areaSqMi <= 0) {
        controlError('invalid_precision_polygon', 'The Precision polygon must enclose a non-zero area.');
    }
    const routeBounds = normalizePrecisionRouteBounds(body.route_bounds);
    if (!routeBounds) {
        controlError('invalid_route_bounds', 'Route-from-home requires valid starting and ending coordinates.');
    }
    const countMode = body.count_mode === undefined ? 'fixed' : body.count_mode;
    if (!COUNT_MODES.has(countMode)) controlError('invalid_count_mode', 'count_mode must be fixed or max_available.');
    let enteredCount = null;
    if (countMode === 'fixed') {
        enteredCount = positiveIntegerOrNull(body.requested_properties);
        if (enteredCount === null) {
            controlError('invalid_requested_properties', 'Fixed Count requires a positive whole-number requested_properties value.');
        }
    }
    const minPriceResult = normalizePrecisionMinPrice(body.min_price);
    if (!minPriceResult.ok) controlError(minPriceResult.code, minPriceResult.message);
    const maxPriceResult = normalizePrecisionMaxPrice(body.max_price);
    if (!maxPriceResult.ok) controlError(maxPriceResult.code, maxPriceResult.message);
    if (maxPriceResult.value !== null && maxPriceResult.value < minPriceResult.value) {
        controlError('invalid_price_range', 'Maximum property value must be greater than or equal to the minimum property value.');
    }
    const repullMode = body.repull_mode === undefined || body.repull_mode === null || body.repull_mode === ''
        ? 'new_area'
        : String(body.repull_mode);
    if (!REPULL_MODES.has(repullMode)) controlError('invalid_repull_mode', 'repull_mode is not supported.');
    const previousPullDate = body.previous_pull_date === undefined || body.previous_pull_date === null || body.previous_pull_date === ''
        ? null
        : timestampOrNull(body.previous_pull_date);
    if (repullMode === 'new_area' && previousPullDate !== null) {
        controlError('invalid_previous_pull_date', 'new_area requests must store previous_pull_date as null.');
    }
    if (repullMode !== 'new_area' && (previousPullDate === null || previousPullDate.startsWith('invalid:'))) {
        controlError('invalid_previous_pull_date', `${repullMode} requires a valid previous_pull_date.`);
    }
    if (
        repullMode === 'max_since_last'
        && asPrecisionTimestamp(previousPullDate) > criteriaReferenceMs
    ) {
        controlError('invalid_previous_pull_date', 'max_since_last previous_pull_date cannot be in the future.');
    }
    const ownership = parseOwnershipRequest(body);
    if (repullMode === 'max_since_last' && ownership.mode !== 'quick') {
        controlError('invalid_ownership_range', 'max_since_last uses its persisted previous pull date as the ownership window.');
    }
    const soldMonths = soldMonthsForOwnership(
        ownership,
        body.sold_months,
        repullMode,
        previousPullDate,
        criteriaReferenceMs
    );
    for (const field of ['force_full_refresh', 'include_unresolved_followups']) {
        if (hasOwn(body, field) && typeof body[field] !== 'boolean') {
            controlError(`invalid_${field}`, `${field} must be a boolean.`);
        }
    }
    return {
        polygon,
        area_sq_mi: areaSqMi,
        center: precisionPolygonCentroid(polygon),
        count_mode: countMode,
        entered_count: enteredCount,
        min_price: minPriceResult.value,
        max_price: maxPriceResult.value,
        sold_months: soldMonths,
        ownership_range_mode: ownership.mode,
        ownership_range_days: ownership.range,
        route_filters: normalizePrecisionRouteFilters(body.route_filters, DEFAULT_PRECISION_ROUTE_FILTERS),
        route_bounds: routeBounds,
        repull_mode: repullMode,
        previous_pull_date: previousPullDate,
        force_full_refresh: body.force_full_refresh === true,
        include_unresolved_followups: body.include_unresolved_followups === true,
        criteria_reference_at: criteriaReferenceAt,
        retry: null
    };
}

export function mapVerifiedRetryCriteriaToStartRequest(criteria, polygon, sourceJob, sourceTerminalAt) {
    return {
        polygon,
        area_sq_mi: precisionPolygonAreaSqMi(polygon),
        center: precisionPolygonCentroid(polygon),
        count_mode: criteria.count_mode,
        entered_count: criteria.count_mode === 'fixed' ? criteria.entered_count : null,
        min_price: criteria.min_price,
        max_price: criteria.max_price,
        sold_months: criteria.sold_months,
        ownership_range_mode: criteria.ownership_range_mode,
        ownership_range_days: criteria.ownership_range_days,
        route_filters: criteria.route_filters,
        route_bounds: criteria.route_bounds,
        repull_mode: criteria.repull_mode,
        previous_pull_date: criteria.previous_pull_date,
        force_full_refresh: criteria.force_full_refresh,
        include_unresolved_followups: criteria.include_unresolved_followups,
        criteria_reference_at: sourceJob?.dry_run_metadata?.criteria_reference_at ?? null,
        retry: {
            source_job: sourceJob,
            source_criteria: criteria,
            source_terminal_at: sourceTerminalAt,
            lineage_root_fetch_job_id: null
        }
    };
}

function retryPartialDeliveryEvidence(job) {
    const signals = [
        ['precision_usage_count', job?.precision_usage_count, hasOwn(job, 'precision_usage_count')],
        ['total_inserted', job?.total_inserted, hasOwn(job, 'total_inserted')],
        ['total_existed', job?.total_existed, hasOwn(job, 'total_existed')],
        [
            'dry_run_metadata.batchdata_summary.active',
            job?.dry_run_metadata?.batchdata_summary?.active,
            hasOwn(job?.dry_run_metadata?.batchdata_summary, 'active')
        ]
    ];
    // Missing optional delivery signals may mean zero because the exact
    // service ledger above already proves precision_usage_count === 0.
    // Present signals, however, must be strict nonnegative integer numbers.
    for (const [, value, present] of signals) {
        if (!present) continue;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return true;
        if (value > 0) return true;
    }
    return false;
}

async function loadFetchJobById(base44, jobId) {
    const entity = base44?.asServiceRole?.entities?.FetchJob;
    if (!entity) controlError('precision_job_lookup_unavailable', 'Service-owned FetchJob lookup is unavailable.', 503);
    if (typeof entity.get === 'function') {
        const byGet = await entity.get(jobId).catch(() => null);
        if (byGet) return byGet;
    }
    const result = await entity.filter({ id: jobId }, null, 1);
    const rows = Array.isArray(result)
        ? result
        : (
            result
            && typeof result === 'object'
            && hasOwn(result, 'items')
            && Array.isArray(result.items)
                ? result.items
                : null
        );
    if (rows === null) {
        controlError(
            'precision_job_discovery_incomplete',
            'Service-owned FetchJob lookup returned an invalid page.',
            503
        );
    }
    return rows[0] || null;
}

function comparePrecisionRetryLineageCriteria(left, right) {
    const fields = MATERIAL_CRITERIA_FIELDS.filter(field => {
        if (field === 'effective_count') return false;
        // Max Available has no browser-entered fixed count. entered_count is a
        // numeric diagnostic of that attempt's locked effective allowance and
        // may legitimately evolve across retries.
        if (
            field === 'entered_count'
            && left?.count_mode === 'max_available'
            && right?.count_mode === 'max_available'
        ) return false;
        return true;
    });
    const mismatchedFields = fields.filter(field =>
        JSON.stringify(left?.[field] ?? null) !== JSON.stringify(right?.[field] ?? null)
    );
    return { matches: mismatchedFields.length === 0, mismatched_fields: mismatchedFields };
}

async function deriveVerifiedPrecisionRetryRoot(base44, user, source, sourceCriteria) {
    const seen = new Set();
    const declaredRootIds = new Set();
    const sourceCriteriaReferenceMs = precisionCriteriaReferenceMs(source);
    if (sourceCriteriaReferenceMs === null) {
        controlError(
            'precision_retry_criteria_reference_unverifiable',
            'The retry source has no valid immutable criteria reference timestamp.',
            409,
            { source_fetch_job_id: source.id }
        );
    }
    let current = source;
    let depth = 0;

    while (current) {
        const currentId = stringOrNull(current.id);
        if (!currentId || seen.has(currentId) || depth >= 100) {
            controlError(
                'precision_retry_lineage_unverifiable',
                'The retry attempt chain is cyclic, too deep, or missing an immutable job id.',
                409,
                { source_fetch_job_id: source.id }
            );
        }
        seen.add(currentId);
        depth++;

        const evidence = await verifyPrecisionJobCriteriaEvidence(current, user);
        const comparison = evidence.ok
            ? comparePrecisionRetryLineageCriteria(evidence.criteria, sourceCriteria)
            : { matches: false, mismatched_fields: [] };
        const currentCriteriaReferenceMs = precisionCriteriaReferenceMs(current);
        if (
            !evidence.ok
            || !comparison.matches
            || currentCriteriaReferenceMs !== sourceCriteriaReferenceMs
        ) {
            controlError(
                'precision_retry_lineage_unverifiable',
                'A retry predecessor does not contain matching service-owned Precision provenance.',
                409,
                {
                    source_fetch_job_id: source.id,
                    invalid_lineage_job_id: currentId,
                    verification_error: evidence.code,
                    invalid_fields: evidence.invalid_fields,
                    invalid_reasons: evidence.invalid_reasons,
                    mismatched_fields: [
                        ...evidence.mismatched_fields,
                        ...comparison.mismatched_fields,
                        ...(currentCriteriaReferenceMs !== sourceCriteriaReferenceMs
                            ? ['dry_run_metadata.criteria_reference_at']
                            : [])
                    ]
                }
            );
        }

        if (hasOwn(current, 'root_fetch_job_id')) {
            const declaredRoot = stringOrNull(current.root_fetch_job_id);
            if (!declaredRoot) {
                controlError(
                    'precision_retry_lineage_unverifiable',
                    'The retry attempt contains a malformed root identifier.',
                    409,
                    { source_fetch_job_id: source.id, invalid_lineage_job_id: currentId }
                );
            }
            declaredRootIds.add(declaredRoot);
        }

        if (!hasOwn(current, 'source_fetch_job_id')) {
            const derivedRootId = currentId;
            if ([...declaredRootIds].some(rootId => rootId !== derivedRootId)) {
                controlError(
                    'precision_retry_lineage_unverifiable',
                    'Persisted retry root hints conflict with the server-derived predecessor chain.',
                    409,
                    {
                        source_fetch_job_id: source.id,
                        derived_root_fetch_job_id: derivedRootId,
                        declared_root_fetch_job_ids: [...declaredRootIds]
                    }
                );
            }
            return current;
        }

        const predecessorId = stringOrNull(current.source_fetch_job_id);
        if (!predecessorId || predecessorId === currentId) {
            controlError(
                'precision_retry_lineage_unverifiable',
                'The retry attempt contains a malformed predecessor identifier.',
                409,
                { source_fetch_job_id: source.id, invalid_lineage_job_id: currentId }
            );
        }
        const predecessor = await loadFetchJobById(base44, predecessorId);
        if (!predecessor) {
            controlError(
                'precision_retry_lineage_unverifiable',
                'A persisted retry predecessor could not be resolved.',
                409,
                {
                    source_fetch_job_id: source.id,
                    missing_predecessor_fetch_job_id: predecessorId
                }
            );
        }
        current = predecessor;
    }

    controlError(
        'precision_retry_lineage_unverifiable',
        'The retry root could not be derived from service-owned provenance.',
        409,
        { source_fetch_job_id: source.id }
    );
}

export async function loadAndValidatePrecisionRetry(base44, user, retryFetchJobId) {
    const jobId = stringOrNull(retryFetchJobId);
    if (!jobId) controlError('invalid_retry_fetch_job_id', 'retry_fetch_job_id is required.');
    const source = await loadFetchJobById(base44, jobId);
    if (!source) controlError('precision_retry_source_not_found', 'The failed Precision job could not be found.', 404);
    if (!isActualPrecisionJob(source)) {
        controlError('precision_retry_source_not_precision', 'The requested source is not a Precision FetchJob.', 409);
    }
    if (!RETRYABLE_STATUSES.has(source.status)) {
        controlError('precision_retry_status_ineligible', 'Only a failed Precision FetchJob can start a new verified attempt.', 409, {
            source_status: source.status || null
        });
    }
    if (!precisionJobBelongsToUser(source, user, { requireImmutable: true })) {
        controlError('precision_retry_owner_mismatch', 'The failed Precision job does not belong to the authenticated immutable user.', 403);
    }
    if (hasOwn(source?.dry_run_metadata, 'provider_outcome_unverifiable_at')) {
        controlError(
            'precision_retry_provider_outcome_unverifiable',
            'The provider outcome for this attempt is ambiguous and requires support review before any replacement attempt.',
            409,
            { source_fetch_job_id: source.id }
        );
    }
    if (source.include_mls !== false) {
        controlError(
            'precision_include_mls_invariant_violation',
            'The failed source is not verifiably BatchData-only, so it cannot authorize a retry.',
            409,
            { source_fetch_job_id: source.id }
        );
    }
    const workspaceId = precisionWorkspaceIdentity(user);
    const snapshot = source?.dry_run_metadata?.precision_criteria;
    const strict = validateStrictPrecisionCriteriaV1(snapshot);
    if (!strict.ok) {
        controlError(
            'legacy_precision_criteria_unverifiable',
            'The failed job does not contain a complete, trustworthy Precision criteria snapshot.',
            409,
            {
                source_fetch_job_id: source.id,
                invalid_fields: strict.invalid_fields,
                invalid_reasons: strict.invalid_reasons
            }
        );
    }
    const criteria = strict.value;
    if (precisionCriteriaReferenceMs(source) === null) {
        controlError(
            'precision_retry_criteria_reference_unverifiable',
            'The failed job has no valid immutable criteria reference timestamp.',
            409,
            {
                source_fetch_job_id: source.id,
                invalid_fields: ['dry_run_metadata.criteria_reference_at']
            }
        );
    }
    if (criteria.immutable_user_id !== String(user.id)) {
        controlError('precision_retry_owner_mismatch', 'The stored criteria belong to a different immutable user.', 403);
    }
    if (criteria.workspace_id !== workspaceId) {
        controlError('precision_retry_workspace_mismatch', 'The stored criteria belong to a different workspace.', 403);
    }
    const metadataWorkspaceEvidence = [
        source?.dry_run_metadata?.workspace_id,
        source?.dry_run_metadata?.workspace_identity
    ].filter(value => value !== undefined && value !== null);
    if (metadataWorkspaceEvidence.some(value => (
        typeof value !== 'string'
        || !value.trim()
        || value.trim() !== criteria.workspace_id
        || value.trim() !== workspaceId
    ))) {
        controlError(
            'precision_retry_workspace_mismatch',
            'The failed job contains conflicting workspace evidence.',
            403,
            { source_fetch_job_id: source.id }
        );
    }
    const explicitReservation = source.precision_usage_reserved;
    if (
        !hasOwn(source, 'precision_usage_reserved')
        || typeof explicitReservation !== 'number'
        || !Number.isSafeInteger(explicitReservation)
        || explicitReservation !== 0
    ) {
        controlError(
            'precision_retry_reservation_unsettled',
            'The failed attempt does not contain explicit proof of a zero settled reservation.',
            409,
            { source_fetch_job_id: source.id }
        );
    }
    const settlementTimestamp = asPrecisionTimestamp(source.precision_usage_recorded_at);
    if (settlementTimestamp === null) {
        controlError(
            'precision_retry_reservation_unsettled',
            'The failed attempt has not completed exact usage settlement. Its reservation remains unchanged.',
            409,
            { source_fetch_job_id: source.id }
        );
    }
    const settledDeliveredCount = source.precision_usage_count;
    if (
        !hasOwn(source, 'precision_usage_count')
        || typeof settledDeliveredCount !== 'number'
        || !Number.isSafeInteger(settledDeliveredCount)
        || settledDeliveredCount !== 0
    ) {
        controlError(
            'precision_retry_partial_delivery_unverifiable',
            'The failed attempt does not contain explicit proof of zero delivered properties.',
            409,
            {
                source_fetch_job_id: source.id,
                delivered_count: typeof settledDeliveredCount === 'number' && Number.isFinite(settledDeliveredCount)
                    ? settledDeliveredCount
                    : null
            }
        );
    }
    const terminalTimestamp = source.completed_at
        ?? source.precision_usage_recorded_at
        ?? source.updated_date;
    const terminalTimestampMs = asPrecisionTimestamp(terminalTimestamp);
    if (terminalTimestampMs === null) {
        controlError(
            'precision_retry_terminal_evidence_unverifiable',
            'The failed attempt does not contain a trustworthy terminal timestamp.',
            409,
            { source_fetch_job_id: source.id }
        );
    }
    if (retryPartialDeliveryEvidence(source)) {
        controlError(
            'precision_retry_partial_delivery_unverifiable',
            'This failed attempt delivered properties. Phase 1 cannot safely attribute a replacement attempt without immutable property provenance.',
            409,
            { source_fetch_job_id: source.id, delivered_count: Math.max(0, Number(source.precision_usage_count || 0)) }
        );
    }
    const polygon = normalizePrecisionPolygon(source.polygon);
    const areaSqMi = polygon ? precisionPolygonAreaSqMi(polygon) : 0;
    if (!polygon || !Number.isFinite(areaSqMi) || areaSqMi <= 0) {
        controlError(
            'precision_retry_polygon_unverifiable',
            'The failed job does not contain a valid persisted polygon.',
            409,
            { source_fetch_job_id: source.id }
        );
    }
    const hash = await precisionPolygonHash(polygon);
    if (
        hash !== criteria.polygon_hash
        || typeof source.polygon_hash !== 'string'
        || !/^[a-f0-9]{16}$/i.test(source.polygon_hash)
        || source.polygon_hash.toLowerCase() !== hash
    ) {
        controlError(
            'precision_retry_polygon_unverifiable',
            'The persisted polygon does not match the canonical criteria hash.',
            409,
            { source_fetch_job_id: source.id }
        );
    }
    const lineageRoot = await deriveVerifiedPrecisionRetryRoot(
        base44,
        user,
        source,
        criteria
    );
    const mapped = mapVerifiedRetryCriteriaToStartRequest(
        criteria,
        polygon,
        source,
        new Date(terminalTimestampMs).toISOString()
    );
    mapped.retry.lineage_root_fetch_job_id = String(lineageRoot.id);
    return mapped;
}

export async function withPrecisionUsageLock({
    userId,
    ClientClass,
    databaseUrl,
    action
}) {
    if (!databaseUrl || typeof ClientClass !== 'function') {
        controlError('precision_usage_lock_unavailable', 'Precision usage locking is unavailable.', 503);
    }
    const client = new ClientClass(databaseUrl);
    await client.connect();
    try {
        await client.query('BEGIN');
        // Start orchestration can legitimately wait on Stripe, Base44 paging,
        // FCC, and SavedRoute reads while holding this pooled transaction.
        // Prevent Neon's idle-transaction timeout from silently releasing the
        // per-user exclusion before the critical section finishes.
        await client.query('SET LOCAL idle_in_transaction_session_timeout = 0');
        const lockResult = await client.query(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS claimed',
            [`precision-usage:${userId}`]
        );
        if (lockResult?.rows?.[0]?.claimed !== true) {
            controlError(
                'precision_start_in_progress',
                'Another Precision start decision is already in progress for this account.',
                409
            );
        }
        const assertHealthy = async () => {
            await client.query('SELECT 1 AS precision_usage_lock_alive');
        };
        const result = await action({ assertHealthy });
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

export function precisionRouteHashStats(routes) {
    const hashes = new Set();
    for (const route of routes) {
        if (!route || route.route_mode === 'canvas') continue;
        for (const hash of route.property_hashes || []) if (hash) hashes.add(hash);
    }
    return { count: hashes.size, hashes: [...hashes] };
}

export async function getPrecisionRouteHomeStats(base44, user) {
    const routesById = new Map();
    const queries = [];
    const managerIds = new Set([
        stringOrNull(precisionWorkspaceIdentity(user)),
        stringOrNull(user?.id)
    ].filter(Boolean));
    for (const managerId of managerIds) {
        queries.push(listAllPrecisionRecords(
            base44.asServiceRole.entities.SavedRoute,
            { manager_id: managerId }
        ));
    }
    if (user?.email) queries.push(listAllPrecisionRecords(base44.asServiceRole.entities.SavedRoute, { created_by: user.email }));
    for (const result of await Promise.all(queries)) {
        for (const route of result) {
            routesById.set(route.id || `${route.created_by || ''}:${route.name || ''}:${route.created_date || ''}`, route);
        }
    }
    return precisionRouteHashStats([...routesById.values()]);
}

function ownershipResponseFields(request) {
    return {
        ownership_range_mode: request.ownership_range_mode,
        ownership_min_days: request.ownership_range_days?.min ?? null,
        ownership_max_days: request.ownership_range_days?.max ?? null,
        ownership_range_days: request.ownership_range_days || null
    };
}

function planCriterionError(request, entitlement) {
    if (request.ownership_range_mode === 'custom' && !entitlement.proAccess) {
        return new PrecisionControlError('upgrade_required', 'Custom ownership ranges require a Precision Pro plan.', 403);
    }
    if (request.ownership_range_mode === 'quick' && isPremiumRecentRange(request.sold_months) && !entitlement.proAccess) {
        return new PrecisionControlError(
            'upgrade_required',
            '1 day, 2 day, 1 week, 2 week, and 1 month Precision pulls require a Pro plan.',
            403
        );
    }
    return null;
}

function buildCriteriaForRequest(request, effectiveCount, user) {
    const enteredCount = request.count_mode === 'fixed' ? request.entered_count : effectiveCount;
    return buildRequestedPrecisionCriteria({
        polygon_hash: request.polygon_hash,
        count_mode: request.count_mode,
        entered_count: enteredCount,
        effective_count: effectiveCount,
        min_price: request.min_price,
        max_price: request.max_price,
        sold_months: request.sold_months,
        ownership_range_mode: request.ownership_range_mode,
        ownership_range_days: request.ownership_range_days,
        route_filters: request.route_filters,
        repull_mode: request.repull_mode,
        previous_pull_date: request.previous_pull_date,
        force_full_refresh: request.force_full_refresh,
        include_unresolved_followups: request.include_unresolved_followups,
        route_bounds: request.route_bounds,
        immutable_user_id: user.id,
        workspace_id: precisionWorkspaceIdentity(user)
    });
}

async function validateActiveJobEvidence(activeJob, user) {
    const evidence = await verifyPrecisionJobCriteriaEvidence(activeJob, user);
    if (!evidence.ok) {
        if (evidence.code === 'legacy_precision_criteria_unverifiable') {
            controlError(
                'legacy_precision_criteria_unverifiable',
                'The active job does not contain a complete canonical Precision snapshot and cannot be resumed automatically.',
                409,
                {
                    active_job_id: activeJob.id,
                    invalid_fields: evidence.invalid_fields
                        .filter(field => field.startsWith('precision_criteria.'))
                        .map(field => field.slice('precision_criteria.'.length)),
                    invalid_reasons: (evidence.invalid_reasons || [])
                        .filter(diagnostic => diagnostic.field.startsWith('precision_criteria.'))
                        .map(diagnostic => ({
                            field: diagnostic.field.slice('precision_criteria.'.length),
                            reason: diagnostic.reason
                        }))
                }
            );
        }
        if (evidence.code === 'precision_include_mls_invariant_violation') {
            controlError(
                'precision_include_mls_invariant_violation',
                'The active job is not verifiably BatchData-only and cannot be resumed automatically.',
                409,
                { active_job_id: activeJob.id }
            );
        }
        if (
            evidence.code === 'precision_job_owner_mismatch'
            || evidence.code === 'precision_job_workspace_mismatch'
            || evidence.mismatched_fields.some(field => (
                field.includes('user_id') || field.includes('workspace')
            ))
        ) {
            const mappedFields = evidence.mismatched_fields.map(field => {
                if (field === 'precision_criteria.immutable_user_id') return 'immutable_user_id';
                if (field === 'precision_criteria.workspace_id') return 'workspace_id';
                if (field === 'dry_run_metadata.workspace_id' || field === 'dry_run_metadata.workspace_identity') {
                    return 'metadata_workspace_id';
                }
                return field;
            });
            controlError(
                'active_job_criteria_conflict',
                'The active Precision job identity does not match the authenticated request.',
                409,
                { active_job_id: activeJob.id, mismatched_fields: [...new Set(mappedFields)] }
            );
        }
        controlError(
            'precision_retry_polygon_unverifiable',
            'The active Precision job polygon or provenance cannot be verified.',
            409,
            {
                active_job_id: activeJob.id,
                invalid_fields: evidence.invalid_fields,
                invalid_reasons: evidence.invalid_reasons,
                mismatched_fields: evidence.mismatched_fields
            }
        );
    }
    const criteria = evidence.criteria;
    let activeReservation;
    try {
        activeReservation = precisionReservationAmount(activeJob);
    } catch (error) {
        controlError(
            'precision_reservation_unsettled',
            'The active Precision job does not contain trustworthy reservation evidence and cannot be resumed automatically.',
            409,
            { active_job_id: activeJob.id, reason: error?.code || 'precision_reservation_unverifiable' }
        );
    }
    if (activeReservation <= 0 || activeReservation !== criteria.effective_count) {
        controlError(
            'precision_reservation_unsettled',
            'The active Precision job reservation does not match its canonical effective target and cannot be resumed automatically.',
            409,
            {
                active_job_id: activeJob.id,
                reserved_count: activeReservation,
                effective_count: criteria.effective_count
            }
        );
    }
    return { criteria, polygon: evidence.polygon };
}

function activeJobResponse(activeJob, criteria, polygon) {
    return {
        kind: 'active',
        status: 'already_running',
        criteria_match: 'exact',
        criteria_verified: true,
        criteria_source_fetch_job_id: activeJob.id,
        job_id: activeJob.id,
        message: 'An identical Precision pull is already running. Continuing that exact job.',
        polygon,
        polygon_hash: criteria.polygon_hash,
        requested_properties: criteria.effective_count,
        requested_properties_before_cap: criteria.entered_count,
        // Exact delivered usage is terminal settlement evidence. An active
        // reservation must not publish a provisional zero as a final count.
        delivered_count: null,
        sold_months: criteria.sold_months,
        min_price: criteria.min_price,
        max_price: criteria.max_price,
        route_filters: criteria.route_filters,
        route_bounds: criteria.route_bounds,
        count_mode: criteria.count_mode,
        repull_mode: criteria.repull_mode,
        previous_pull_date: criteria.previous_pull_date,
        force_full_refresh: criteria.force_full_refresh,
        include_unresolved_followups: criteria.include_unresolved_followups,
        workspace_id: criteria.workspace_id,
        criteria: precisionCriteriaDiagnostic(criteria),
        ...ownershipResponseFields({
            ownership_range_mode: criteria.ownership_range_mode,
            ownership_range_days: criteria.ownership_range_days
        })
    };
}

async function activeResolutionForRequest(activeResolution, request, user) {
    if (activeResolution.state === 'multiple') {
        controlError(
            'multiple_active_precision_jobs',
            'Multiple active Precision jobs exist for this account. No job was selected or changed.',
            409,
            {
                state: 'multiple',
                jobs: activeResolution.jobs.map(job => ({
                    id: job.id,
                    status: job.status,
                    created_at: job.created_date || null,
                    started_at: job.started_at || null
                }))
            }
        );
    }
    if (activeResolution.state !== 'single') return null;
    const activeJob = activeResolution.job;
    const { criteria: activeCriteria, polygon } = await validateActiveJobEvidence(activeJob, user);
    const compatibilityEffectiveCount = request.count_mode === 'fixed'
        ? Math.min(request.entered_count, activeCriteria.effective_count)
        : activeCriteria.effective_count;
    const requestedCriteria = buildCriteriaForRequest(
        request,
        compatibilityEffectiveCount,
        user
    );
    if (request.count_mode === 'max_available') {
        requestedCriteria.entered_count = activeCriteria.entered_count;
    }
    const comparison = comparePrecisionCriteria(requestedCriteria, activeCriteria);
    if (!comparison.matches) {
        controlError(
            'active_job_criteria_conflict',
            'A different Precision pull is already active. It was not resumed, replaced or cancelled.',
            409,
            {
                active_job_id: activeJob.id,
                mismatched_fields: comparison.mismatched_fields,
                active_criteria: precisionCriteriaDiagnostic(activeCriteria),
                requested_criteria: precisionCriteriaDiagnostic(requestedCriteria)
            }
        );
    }
    return activeJobResponse(activeJob, activeCriteria, polygon);
}

async function nextRetryAttemptProvenance(
    base44,
    user,
    request,
    nowIso,
    { allowLatestActiveJobId = null } = {}
) {
    if (!request.retry) {
        return {
            attempt_number: 1,
            attempt_reason: 'initial_request',
            attempt_created_at: nowIso,
            attempt_actor_user_id: String(user.id),
            attempt_subject_user_id: String(user.id),
            attempt_workspace_id: precisionWorkspaceIdentity(user)
        };
    }
    const source = request.retry.source_job;
    const sourceCriteria = request.retry.source_criteria;
    const sourceTerminalMs = asPrecisionTimestamp(request.retry.source_terminal_at);
    if (sourceTerminalMs === null) {
        controlError(
            'precision_retry_terminal_evidence_unverifiable',
            'The failed attempt does not contain a trustworthy terminal timestamp.',
            409,
            { source_fetch_job_id: source.id }
        );
    }
    const rootId = stringOrNull(request.retry.lineage_root_fetch_job_id);
    if (!rootId) {
        controlError(
            'precision_retry_lineage_unverifiable',
            'The retry root was not derived from server-owned predecessor evidence.',
            409,
            { source_fetch_job_id: source.id }
        );
    }
    const expectedWorkspace = precisionWorkspaceIdentity(user);
    const root = await loadFetchJobById(base44, rootId);
    if (!root) {
        controlError(
            'precision_retry_lineage_unverifiable',
            'The retry root could not be resolved from service-owned provenance.',
            409,
            { source_fetch_job_id: source.id, missing_root_fetch_job_id: rootId }
        );
    }
    // Discover the complete immutable-subject job set, then close forward over
    // predecessor references. A descendant with a missing/corrupt root hint
    // must not disappear from a `{root_fetch_job_id}` query and fork the chain.
    const ownedJobs = await loadUserPrecisionJobs(base44, user);
    const ownedById = new Map(
        ownedJobs
            .filter(row => stringOrNull(row?.id))
            .map(row => [String(row.id), row])
    );
    const connectedIds = new Set([rootId, String(source.id)]);
    let discoveredConnectedRow = true;
    while (discoveredConnectedRow) {
        discoveredConnectedRow = false;
        for (const [rowId, row] of ownedById) {
            if (connectedIds.has(rowId)) continue;
            const declaredRoot = stringOrNull(row.root_fetch_job_id);
            const predecessorId = stringOrNull(row.source_fetch_job_id);
            if (
                declaredRoot === rootId
                || (predecessorId && connectedIds.has(predecessorId))
            ) {
                connectedIds.add(rowId);
                discoveredConnectedRow = true;
            }
        }
    }
    const related = [...connectedIds]
        .filter(rowId => rowId !== rootId)
        .map(rowId => ownedById.get(rowId))
        .filter(Boolean);
    const rowsById = new Map();
    for (const row of [root, ...related]) {
        const rowId = stringOrNull(row?.id);
        if (!rowId) {
            controlError(
                'precision_retry_lineage_unverifiable',
                'A retry lineage row is missing an immutable job id.',
                409,
                { source_fetch_job_id: source.id }
            );
        }
        if (rowsById.has(rowId)) {
            if (JSON.stringify(rowsById.get(rowId)) !== JSON.stringify(row)) {
                controlError(
                    'precision_retry_lineage_unverifiable',
                    'Retry lineage discovery returned conflicting snapshots for one attempt.',
                    409,
                    { source_fetch_job_id: source.id, conflicting_lineage_job_id: rowId }
                );
            }
            continue;
        }
        rowsById.set(rowId, row);
    }
    if (!rowsById.has(String(source.id))) {
        controlError(
            'precision_retry_lineage_unverifiable',
            'The requested source is not present in its declared retry chain.',
            409,
            { source_fetch_job_id: source.id, root_fetch_job_id: rootId }
        );
    }

    const verifiedRows = new Map();
    const seenAttemptNumbers = new Map();
    const rootAuditFields = [
        'attempt_number',
        'attempt_reason',
        'attempt_created_at',
        'attempt_actor_user_id',
        'attempt_subject_user_id',
        'attempt_workspace_id'
    ];
    for (const [rowId, row] of rowsById) {
        const isRoot = rowId === rootId;
        // A fully verified pre-provenance root with no predecessor is
        // unambiguously the initial attempt. Descendants never receive this
        // compatibility treatment.
        const attemptNumber = isRoot && !hasOwn(row, 'attempt_number')
            ? 1
            : row.attempt_number;
        const declaredRoot = stringOrNull(row.root_fetch_job_id);
        const predecessorId = stringOrNull(row.source_fetch_job_id);
        const validShape = (
            isActualPrecisionJob(row)
            && precisionJobBelongsToUser(row, user, { requireImmutable: true })
            && typeof attemptNumber === 'number'
            && Number.isSafeInteger(attemptNumber)
            && (
                isRoot
                    ? attemptNumber === 1
                        && !predecessorId
                        && (!declaredRoot || declaredRoot === rootId)
                    : attemptNumber >= 2
                        && declaredRoot === rootId
                        && Boolean(predecessorId)
            )
        );
        const evidence = validShape
            ? await verifyPrecisionJobCriteriaEvidence(row, user)
            : { ok: false, code: 'precision_retry_lineage_shape_invalid', invalid_fields: [], mismatched_fields: [] };
        const comparison = evidence.ok
            ? comparePrecisionRetryLineageCriteria(evidence.criteria, sourceCriteria)
            : { matches: false, mismatched_fields: [] };
        const legacyCanonicalRoot = isRoot
            && rootAuditFields.every(field => !hasOwn(row, field));
        const rowWorkspace = legacyCanonicalRoot
            ? stringOrNull(evidence.criteria?.workspace_id)
            : stringOrNull(row.attempt_workspace_id);
        const createdAtMs = legacyCanonicalRoot
            ? null
            : asPrecisionTimestamp(row.attempt_created_at);
        const rootAuditValid = !isRoot || legacyCanonicalRoot || (
            row.attempt_reason === 'initial_request'
            && createdAtMs !== null
            && stringOrNull(row.attempt_actor_user_id) === String(user.id)
            && stringOrNull(row.attempt_subject_user_id) === String(user.id)
            && rowWorkspace === expectedWorkspace
        );
        if (
            !validShape
            || !evidence.ok
            || !comparison.matches
            || rowWorkspace !== expectedWorkspace
            || !rootAuditValid
        ) {
            controlError(
                'precision_retry_lineage_unverifiable',
                'A retry attempt contains malformed ownership, criteria, workspace, numbering, or audit evidence.',
                409,
                {
                    source_fetch_job_id: source.id,
                    invalid_lineage_job_id: rowId,
                    verification_error: evidence.code,
                    invalid_fields: evidence.invalid_fields,
                    invalid_reasons: evidence.invalid_reasons,
                    mismatched_fields: [
                        ...(evidence.mismatched_fields || []),
                        ...(comparison.mismatched_fields || [])
                    ]
                }
            );
        }
        const collision = seenAttemptNumbers.get(attemptNumber);
        if (collision && collision !== rowId) {
            controlError(
                'precision_retry_lineage_unverifiable',
                'Two related retry attempts claim the same durable attempt number.',
                409,
                {
                    source_fetch_job_id: source.id,
                    conflicting_attempt_number: attemptNumber,
                    conflicting_job_ids: [collision, rowId]
                }
            );
        }
        seenAttemptNumbers.set(attemptNumber, rowId);
        verifiedRows.set(rowId, {
            row,
            attemptNumber,
            predecessorId,
            criteria: evidence.criteria,
            createdAtMs,
            legacyCanonicalRoot
        });
    }

    for (const [rowId, verified] of verifiedRows) {
        if (rowId === rootId) continue;
        const predecessor = verifiedRows.get(verified.predecessorId);
        if (
            !predecessor
            || verified.attemptNumber !== predecessor.attemptNumber + 1
        ) {
            controlError(
                'precision_retry_lineage_unverifiable',
                'A retry attempt does not immediately follow a verified predecessor in the same root chain.',
                409,
                {
                    source_fetch_job_id: source.id,
                    invalid_lineage_job_id: rowId,
                    predecessor_fetch_job_id: verified.predecessorId,
                    attempt_number: verified.attemptNumber,
                    predecessor_attempt_number: predecessor?.attemptNumber ?? null
                }
            );
        }
        const predecessorTerminalValue = (
            predecessor.row.completed_at
            ?? predecessor.row.precision_usage_recorded_at
            ?? predecessor.row.updated_date
        );
        const predecessorTerminalMs = asPrecisionTimestamp(predecessorTerminalValue);
        const declaredSourceTerminalMs = asPrecisionTimestamp(verified.row.source_terminal_at);
        const predecessorCriteriaReferenceMs = precisionCriteriaReferenceMs(predecessor.row);
        const retryCriteriaReferenceMs = precisionCriteriaReferenceMs(verified.row);
        const auditValid = (
            verified.row.attempt_reason === 'verified_retry'
            && verified.createdAtMs !== null
            && stringOrNull(verified.row.attempt_actor_user_id) === String(user.id)
            && stringOrNull(verified.row.attempt_subject_user_id) === String(user.id)
            && stringOrNull(verified.row.attempt_workspace_id) === expectedWorkspace
            && verified.row.source_criteria_schema_version === predecessor.criteria.criteria_schema_version
            && verified.row.source_polygon_hash === predecessor.criteria.polygon_hash
            && verified.row.source_effective_count === predecessor.criteria.effective_count
            && verified.row.source_status === predecessor.row.status
            && predecessorTerminalMs !== null
            && declaredSourceTerminalMs === predecessorTerminalMs
            && verified.createdAtMs >= predecessorTerminalMs
            && predecessorCriteriaReferenceMs !== null
            && retryCriteriaReferenceMs === predecessorCriteriaReferenceMs
        );
        if (!auditValid) {
            controlError(
                'precision_retry_lineage_unverifiable',
                'A retry attempt contains corrupt or incomplete predecessor audit provenance.',
                409,
                {
                    source_fetch_job_id: source.id,
                    invalid_lineage_job_id: rowId,
                    predecessor_fetch_job_id: verified.predecessorId
                }
            );
        }
        const visited = new Set([rowId]);
        let cursor = predecessor;
        while (cursor && String(cursor.row.id) !== rootId) {
            const cursorId = String(cursor.row.id);
            if (visited.has(cursorId)) {
                controlError(
                    'precision_retry_lineage_unverifiable',
                    'The retry attempt chain contains a cycle.',
                    409,
                    { source_fetch_job_id: source.id, invalid_lineage_job_id: rowId }
                );
            }
            visited.add(cursorId);
            cursor = verifiedRows.get(cursor.predecessorId);
        }
        if (!cursor || String(cursor.row.id) !== rootId) {
            controlError(
                'precision_retry_lineage_unverifiable',
                'A retry attempt does not resolve to the verified root.',
                409,
                { source_fetch_job_id: source.id, invalid_lineage_job_id: rowId }
            );
        }
    }
    const latestAttemptNumber = Math.max(...seenAttemptNumbers.keys());
    const latestAttemptId = seenAttemptNumbers.get(latestAttemptNumber);
    if (String(source.id) !== latestAttemptId) {
        if (
            allowLatestActiveJobId
            && String(allowLatestActiveJobId) === latestAttemptId
        ) {
            return {
                resume_active_descendant: true,
                active_descendant_fetch_job_id: latestAttemptId,
                latest_attempt_number: latestAttemptNumber
            };
        }
        controlError(
            'precision_retry_source_superseded',
            'This failed attempt has a later durable descendant and cannot authorize another retry.',
            409,
            {
                source_fetch_job_id: source.id,
                latest_attempt_fetch_job_id: latestAttemptId,
                latest_attempt_number: latestAttemptNumber
            }
        );
    }
    const attemptNumber = latestAttemptNumber + 1;
    return {
        source_fetch_job_id: String(source.id),
        root_fetch_job_id: rootId,
        attempt_number: attemptNumber,
        attempt_reason: 'verified_retry',
        attempt_created_at: nowIso,
        attempt_actor_user_id: String(user.id),
        attempt_subject_user_id: String(user.id),
        attempt_workspace_id: precisionWorkspaceIdentity(user),
        source_criteria_schema_version: sourceCriteria.criteria_schema_version,
        source_polygon_hash: sourceCriteria.polygon_hash,
        source_effective_count: sourceCriteria.effective_count,
        source_status: source.status,
        source_terminal_at: request.retry.source_terminal_at
    };
}

function responseFields({
    request,
    criteria,
    effectiveCount,
    entitlement,
    allowance,
    routeStats,
    limitedByFree,
    limitedByPaid
}) {
    return {
        requested_properties: effectiveCount,
        requested_properties_before_cap: criteria.entered_count,
        entered_count: criteria.entered_count,
        effective_count: criteria.effective_count,
        delivered_count: null,
        limited_by_free_home_cap: limitedByFree,
        limited_by_paid_property_cap: limitedByPaid,
        existing_route_homes: routeStats.count,
        excluded_route_home_count: routeStats.count,
        free_properties_remaining: entitlement.paidAccess ? null : allowance.remaining,
        paid_properties_used: entitlement.paidAccess ? allowance.used + allowance.reserved : null,
        paid_properties_reserved: entitlement.paidAccess ? allowance.reserved : null,
        paid_properties_remaining: entitlement.paidAccess ? allowance.remaining : null,
        paid_property_limit: entitlement.paidAccess ? entitlement.limit : null,
        precision_usage_period_start: entitlement.periodStart,
        count_mode: request.count_mode,
        sold_months: request.sold_months,
        filters: { min_price: request.min_price, max_price: request.max_price },
        route_filters: request.route_filters,
        route_bounds: request.route_bounds,
        repull_mode: request.repull_mode,
        previous_pull_date: request.previous_pull_date,
        force_full_refresh: request.force_full_refresh,
        include_unresolved_followups: request.include_unresolved_followups,
        polygon: request.polygon,
        polygon_hash: request.polygon_hash,
        criteria: precisionCriteriaDiagnostic(criteria),
        ...ownershipResponseFields(request)
    };
}

async function resolveStartEntitlement(entitlementArgs) {
    try {
        return await resolvePrecisionEntitlement(entitlementArgs);
    } catch (error) {
        if (error instanceof PrecisionControlError) throw error;
        controlError(
            'precision_entitlement_unavailable',
            'Precision entitlement could not be verified. No job was created.',
            503
        );
    }
}

async function resolveStartCounty(resolveFips, center) {
    let fips;
    try {
        fips = await resolveFips(center);
    } catch (error) {
        controlError(
            'precision_county_lookup_unavailable',
            'County/FIPS verification is temporarily unavailable. No job was created.',
            503
        );
    }
    if (!fips?.fips_code) {
        controlError(
            'precision_county_unresolved',
            'Could not resolve county/FIPS for this area. Please redraw inside a supported US county.'
        );
    }
    return fips;
}

export async function executePrecisionStart({
    base44,
    user,
    body,
    adapterName,
    allowRetry,
    allowDryRunSelfTest,
    StripeClass,
    ClientClass,
    stripeSecret,
    databaseUrl,
    betaAccessGrants,
    resolveFips
}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        controlError(
            'invalid_precision_request_body',
            'Precision requests require one JSON object body.',
            400
        );
    }
    const retryFieldPresent = hasOwn(body, 'retry_fetch_job_id');
    const retryId = retryFieldPresent && typeof body.retry_fetch_job_id === 'string'
        ? body.retry_fetch_job_id.trim()
        : null;
    if (retryFieldPresent && !retryId) {
        controlError('invalid_retry_fetch_job_id', 'retry_fetch_job_id must be a nonempty string.', 400);
    }
    if (retryFieldPresent && !allowRetry) {
        controlError('precision_retry_endpoint_required', 'Verified retries must use fetchAreaProperties.', 400);
    }
    const untrustedRetryFields = retryFieldPresent
        ? Object.keys(body || {}).filter(field => field !== 'retry_fetch_job_id')
        : [];
    if (untrustedRetryFields.length) {
        controlError(
            'precision_retry_contains_untrusted_criteria',
            'A verified retry accepts only retry_fetch_job_id; browser criteria are not authorization evidence.',
            400,
            { rejected_fields: untrustedRetryFields }
        );
    }

    let request = retryId
        ? await loadAndValidatePrecisionRetry(base44, user, retryId)
        : parseDirectPrecisionStartRequest(body);
    request.polygon_hash = await precisionPolygonHash(request.polygon);
    const preflightPolygonHash = request.polygon_hash;
    const selfTestFree = allowDryRunSelfTest && body?.self_test_force_free === true && body?.dry_run === true;
    const entitlementArgs = {
        user,
        StripeClass,
        stripeSecret,
        betaAccessGrants
    };
    if (body?.dry_run === true) {
        const jobs = selfTestFree ? [] : await loadUserPrecisionJobs(base44, user);
        if (!selfTestFree) assertImmutablePrecisionJobOwnership(jobs, user);
        const safety = evaluatePrecisionStartSafety(jobs);
        if (safety.activeResolution.state === 'multiple') {
            await activeResolutionForRequest(safety.activeResolution, request, user);
        }
        if (safety.providerOutcomeHeldJobs.length) {
            controlError(
                'precision_provider_outcome_unverifiable',
                'A prior paid-provider attempt has an ambiguous outcome and requires support review before another Precision pull.',
                409,
                { held_job_ids: safety.start_blocker_job_ids }
            );
        }
        if (safety.activeResolution.state === 'single') {
            const active = await activeResolutionForRequest(
                safety.activeResolution,
                request,
                user
            );
            if (active) return active;
        }
        if (safety.unsettledJobs.length) {
            controlError(
                'precision_reservation_unsettled',
                'A prior Precision reservation has not completed exact server settlement. No new job was authorized.',
                409,
                { unsettled_job_ids: safety.start_blocker_job_ids }
            );
        }
        const fips = await resolveStartCounty(resolveFips, request.center);
        const routeStats = selfTestFree
            ? { count: 0, hashes: [] }
            : await getPrecisionRouteHomeStats(base44, user);
        const entitlement = selfTestFree
            ? {
                kind: 'trial',
                paidAccess: false,
                proAccess: false,
                limit: FREE_PRECISION_PROPERTY_LIMIT,
                precisionLimit: FREE_PRECISION_PROPERTY_LIMIT,
                subscriptionId: null,
                invoiceId: null,
                periodStart: null,
                periodEnd: null
            }
            : await resolveStartEntitlement(entitlementArgs);
        const planError = planCriterionError(request, entitlement);
        if (planError) throw planError;
        const allowance = selfTestFree
            ? { used: 0, reserved: 0, remaining: FREE_PRECISION_PROPERTY_LIMIT, lifetimeUsed: 0, trialUsed: 0 }
            : calculatePrecisionUsage(jobs, entitlement);
        if (allowance.remaining <= 0) {
            controlError(
                entitlement.paidAccess ? 'precision_allowance_exhausted' : 'paid_precision_required',
                entitlement.paidAccess
                    ? 'This account has used all paid Precision properties for the current billing cycle.'
                    : 'This account has already received its included Precision route homes.',
                403
            );
        }
        const effectiveCount = request.count_mode === 'fixed'
            ? Math.min(request.entered_count, allowance.remaining, entitlement.limit)
            : Math.min(allowance.remaining, entitlement.limit);
        const criteria = buildCriteriaForRequest(request, effectiveCount, user);
        return {
            kind: 'dry_run',
            provider: 'batchdata',
            phase: 'batchdata_precision',
            fips_code: fips.fips_code,
            area_sq_mi: Number(request.area_sq_mi.toFixed(2)),
            ...responseFields({
                request,
                criteria,
                effectiveCount,
                entitlement,
                allowance,
                routeStats,
                limitedByFree: !entitlement.paidAccess && effectiveCount < (request.entered_count || effectiveCount),
                limitedByPaid: entitlement.paidAccess && request.count_mode === 'fixed' && effectiveCount < request.entered_count
            })
        };
    }

    return withPrecisionUsageLock({
        userId: user.id,
        ClientClass,
        databaseUrl,
        action: async ({ assertHealthy }) => {
            let verifiedRetryProvenance = null;
            // Retry evidence is reloaded under the same user lock so a settlement
            // or status race cannot change the source after preflight validation.
            if (retryId) {
                request = await loadAndValidatePrecisionRetry(base44, user, retryId);
                request.polygon_hash = await precisionPolygonHash(request.polygon);
                if (request.polygon_hash !== preflightPolygonHash) {
                    controlError(
                        'precision_retry_source_changed',
                        'The persisted retry polygon changed after preflight verification. No job was created.',
                        409,
                        { source_fetch_job_id: retryId }
                    );
                }
            }
            const jobs = await loadUserPrecisionJobs(base44, user);
            assertImmutablePrecisionJobOwnership(jobs, user);
            const safety = evaluatePrecisionStartSafety(jobs);
            if (safety.activeResolution.state === 'multiple') {
                await activeResolutionForRequest(safety.activeResolution, request, user);
            }
            if (safety.providerOutcomeHeldJobs.length) {
                controlError(
                    'precision_provider_outcome_unverifiable',
                    'A prior paid-provider attempt has an ambiguous outcome and requires support review before another Precision pull.',
                    409,
                    { held_job_ids: safety.start_blocker_job_ids }
                );
            }
            const active = await activeResolutionForRequest(
                safety.activeResolution,
                request,
                user
            );
            if (active) {
                if (!retryId) return active;
                const lineage = await nextRetryAttemptProvenance(
                    base44,
                    user,
                    request,
                    new Date().toISOString(),
                    { allowLatestActiveJobId: active.job_id }
                );
                if (lineage.resume_active_descendant === true) return active;
                controlError(
                    'precision_retry_active_not_descendant',
                    'The compatible active job is not the unique latest descendant of the requested failed attempt.',
                    409,
                    {
                        source_fetch_job_id: retryId,
                        active_job_id: active.job_id
                    }
                );
            }

            if (safety.unsettledJobs.length) {
                controlError(
                    'precision_reservation_unsettled',
                    'A prior Precision reservation has not completed exact server settlement. No new job was created.',
                    409,
                    { unsettled_job_ids: safety.start_blocker_job_ids }
                );
            }
            if (retryId) {
                verifiedRetryProvenance = await nextRetryAttemptProvenance(
                    base44,
                    user,
                    request,
                    new Date().toISOString()
                );
            }

            const entitlement = await resolveStartEntitlement(entitlementArgs);
            const planError = planCriterionError(request, entitlement);
            if (planError) throw planError;
            await reconcileLegacyPrecisionJobs({
                base44,
                user,
                jobs,
                entitlement
            });
            const allowance = calculatePrecisionUsage(jobs, entitlement);
            if (allowance.remaining <= 0) {
                controlError(
                    entitlement.paidAccess ? 'precision_allowance_exhausted' : 'paid_precision_required',
                    entitlement.paidAccess
                        ? 'This account has used all paid Precision properties for the current billing cycle.'
                        : 'This account has already received its included Precision route homes.',
                    403
                );
            }
            const effectiveCount = request.count_mode === 'fixed'
                ? Math.min(request.entered_count, allowance.remaining, entitlement.limit)
                : Math.min(allowance.remaining, entitlement.limit);
            if (!Number.isSafeInteger(effectiveCount) || effectiveCount < 1) {
                controlError('precision_allowance_exhausted', 'No authoritative Precision allowance remains.', 403);
            }
            const criteria = buildCriteriaForRequest(request, effectiveCount, user);
            const strictCriteria = validateStrictPrecisionCriteriaV1(criteria);
            if (!strictCriteria.ok) {
                controlError(
                    'precision_criteria_generation_failed',
                    'The server could not create a complete canonical criteria snapshot.',
                    500,
                    {
                        invalid_fields: strictCriteria.invalid_fields,
                        invalid_reasons: strictCriteria.invalid_reasons
                    }
                );
            }
            // Defer external county resolution and route-history reads until
            // every no-start outcome has been decided inside the user lock.
            // Multiple/active/unsettled requests therefore cannot be masked by
            // FCC or entitlement-provider failures.
            const fips = await resolveStartCounty(resolveFips, request.center);
            const routeStats = await getPrecisionRouteHomeStats(base44, user);
            const nowIso = new Date().toISOString();
            const provenance = verifiedRetryProvenance
                || await nextRetryAttemptProvenance(base44, user, request, nowIso);
            const processorToken = crypto.randomUUID();
            const processorTokenHash = await precisionProcessorTokenHash(processorToken);
            const limitedByFree = !entitlement.paidAccess
                && request.count_mode === 'fixed'
                && effectiveCount < request.entered_count;
            const limitedByPaid = entitlement.paidAccess
                && request.count_mode === 'fixed'
                && effectiveCount < request.entered_count;
            const metadata = {
                county_resolution: fips,
                requested_properties: effectiveCount,
                requested_properties_before_cap: strictCriteria.value.entered_count,
                entered_count: strictCriteria.value.entered_count,
                effective_count: effectiveCount,
                limited_by_free_home_cap: limitedByFree,
                limited_by_paid_property_cap: limitedByPaid,
                existing_route_homes: routeStats.count,
                excluded_route_home_count: routeStats.count,
                excluded_route_hashes: routeStats.hashes,
                free_properties_remaining: entitlement.paidAccess ? null : allowance.remaining,
                paid_properties_used: entitlement.paidAccess ? allowance.used + allowance.reserved : null,
                paid_properties_reserved: entitlement.paidAccess ? allowance.reserved : null,
                paid_properties_remaining: entitlement.paidAccess ? allowance.remaining : null,
                paid_property_limit: entitlement.paidAccess ? entitlement.limit : null,
                precision_usage_period_start: entitlement.periodStart,
                free_property_cap: FREE_PRECISION_PROPERTY_LIMIT,
                count_mode: request.count_mode,
                repull_mode: request.repull_mode,
                previous_pull_date: request.previous_pull_date,
                force_full_refresh: request.force_full_refresh,
                include_unresolved_followups: request.include_unresolved_followups,
                filters: { min_price: request.min_price, max_price: request.max_price },
                route_filters: request.route_filters,
                route_bounds: request.route_bounds,
                ownership_range_mode: request.ownership_range_mode,
                ownership_range_days: request.ownership_range_days,
                workspace_id: precisionWorkspaceIdentity(user),
                precision_criteria: strictCriteria.value,
                attempt_provenance: provenance,
                processor_token_hash: processorTokenHash,
                criteria_reference_at: request.criteria_reference_at || nowIso,
                precision_started_at: nowIso,
                ...(adapterName === 'startBatchDataPull' ? { paid_pull_started_at: nowIso } : { batchdata_only_started_at: nowIso })
            };
            const jobPayload = {
                status: 'pending',
                provider: 'batchdata',
                mode_tag: 'PRECISION_TARGET',
                phase: 'batchdata_precision',
                latitude: request.center.lat,
                longitude: request.center.lng,
                radius: Math.sqrt(request.area_sq_mi / Math.PI),
                polygon: request.polygon,
                fips_code: fips.fips_code,
                area_sq_mi: Number(request.area_sq_mi.toFixed(2)),
                polygon_hash: request.polygon_hash,
                estimated_record_count: effectiveCount,
                estimated_cost: Number((effectiveCount * 0.01).toFixed(2)),
                dry_run_metadata: metadata,
                sold_months: request.sold_months,
                include_mls: false,
                force_full_refresh: request.force_full_refresh,
                pull_mode: request.force_full_refresh ? 'full_refresh' : 'new_area',
                user_email: user.email,
                precision_usage_user_id: String(user.id),
                precision_usage_kind: isMeteredPrecisionEntitlement(entitlement)
                    ? 'paid'
                    : entitlement.kind === 'unmetered' ? 'unmetered' : 'trial',
                ...(entitlement.subscriptionId ? { precision_subscription_id: entitlement.subscriptionId } : {}),
                ...(entitlement.invoiceId ? { precision_invoice_id: entitlement.invoiceId } : {}),
                ...(entitlement.periodStart ? { precision_usage_period_start: entitlement.periodStart } : {}),
                ...(entitlement.periodEnd ? { precision_usage_period_end: entitlement.periodEnd } : {}),
                precision_usage_reserved: effectiveCount,
                precision_usage_count: 0,
                progress_pct: 0,
                current_offset: 0,
                total_expected: effectiveCount,
                total_sub_circles: 1,
                completed_sub_circles: 0,
                total_batchdata_calls: 0,
                error_log: [],
                chunk_timings: [],
                ...provenance
            };
            await assertHealthy();
            const job = await base44.asServiceRole.entities.FetchJob.create(jobPayload);
            // Base44 and Neon cannot share one atomic transaction. This second
            // health assertion narrows silent lease-loss exposure; a created
            // reservation remains visible and blocks later starts even if the
            // cross-store postcondition fails.
            await assertHealthy();
            return {
                kind: 'started',
                status: 'started',
                criteria_verified: true,
                criteria_source_fetch_job_id: job.id,
                job,
                processorToken,
                provider: 'batchdata',
                phase: 'batchdata_precision',
                fips_code: fips.fips_code,
                area_sq_mi: Number(request.area_sq_mi.toFixed(2)),
                message: request.retry
                    ? 'Starting a new attempt using the verified original criteria.'
                    : `Precision pull started for up to ${effectiveCount} properties.`,
                ...responseFields({
                    request,
                    criteria: strictCriteria.value,
                    effectiveCount,
                    entitlement,
                    allowance,
                    routeStats,
                    limitedByFree,
                    limitedByPaid
                })
            };
        }
    });
}

export async function buildVerifiedActiveJobContext(job, user) {
    const { criteria, polygon } = await validateActiveJobEvidence(job, user);
    return {
        id: job.id,
        status: job.status,
        criteria_verified: true,
        criteria_source_fetch_job_id: job.id,
        polygon,
        polygon_hash: criteria.polygon_hash,
        criteria: precisionCriteriaDiagnostic(criteria),
        requested_properties: criteria.effective_count,
        requested_properties_before_cap: criteria.entered_count,
        delivered_count: null,
        created_at: job.created_date || null,
        started_at: job.started_at || null
    };
}
