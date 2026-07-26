import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import {
    buildExistingPrecisionCriteria,
    buildRequestedPrecisionCriteria,
    comparePrecisionCriteria,
    precisionCriteriaSource,
    precisionWorkspaceIdentity,
    LEGACY_UNVERIFIABLE_CRITERIA_FIELDS,
    LEGACY_VERIFIED_CRITERIA_FIELDS
} from '../_shared/precisionActiveJobCriteria.js';

function normalizeZipList(body) {
    if (Array.isArray(body.zip_codes)) return body.zip_codes.map(String).map(z => z.trim().slice(0, 5)).filter(Boolean);
    if (body.zip_code_filter) return String(body.zip_code_filter).split(',').map(z => z.trim().slice(0, 5)).filter(Boolean);
    return [];
}

function getBoundsFromPolygon(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return null;
    const lats = polygon.map(p => Number(p.lat)).filter(Number.isFinite);
    const lngs = polygon.map(p => Number(p.lng)).filter(Number.isFinite);
    if (lats.length === 0 || lngs.length === 0) return null;
    return {
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
        minLng: Math.min(...lngs),
        maxLng: Math.max(...lngs)
    };
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

function routeCandidateSoldWindowDays(soldMonths) {
    return requestedSoldWindowDays(soldMonths);
}

function isoDateDaysAgo(days, referenceMs = Date.now()) {
    const date = new Date(referenceMs - days * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
}

function parseRequestedCustomOwnershipRange(body = {}) {
    const mode = body.ownership_range_mode;
    if (mode === undefined || mode === null || mode === '' || mode === 'quick') {
        return { range: null };
    }
    if (mode !== 'custom') {
        return { error: 'ownership_range_mode must be either quick or custom.' };
    }
    const min = Number(body.ownership_min_days);
    const max = Number(body.ownership_max_days);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 365 || min >= max) {
        return { error: 'Custom ownership range requires whole-day minimum and maximum values from 1 to 365, with minimum less than maximum.' };
    }
    return { range: { min, max } };
}

function customOwnershipRangesMatch(left, right) {
    return !!left && !!right && left.min === right.min && left.max === right.max;
}

function isSoldDateInCustomOwnershipRange(value, range, referenceMs) {
    if (!range || !value) return false;
    const soldTime = new Date(value).getTime();
    if (!Number.isFinite(soldTime)) return false;
    const soldDate = new Date(soldTime).toISOString().slice(0, 10);
    const oldestDate = isoDateDaysAgo(range.max, referenceMs);
    const newestDate = isoDateDaysAgo(range.min, referenceMs);
    return soldDate >= oldestDate && soldDate <= newestDate;
}

const REQUIRED_JOB_ROUTE_CRITERIA_FIELDS = [
    'polygon',
    'sold_months',
    'ownership_range_mode',
    'count_mode',
    'requested_properties_before_cap',
    'requested_properties',
    'min_price',
    'max_price',
    'route_filters',
    'repull_mode',
    'previous_pull_date',
    'force_full_refresh',
    'include_unresolved_followups',
    'route_bounds'
];

function hasOwn(value, key) {
    return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeWorkspaceId(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function getFetchJobWorkspaceId(fetchJob) {
    const metadata = fetchJob?.dry_run_metadata || {};
    const legacyWorkspaceIdentity = metadata.workspace_identity;
    return normalizeWorkspaceId(
        metadata.workspace_id ??
        metadata.precision_criteria?.workspace_id ??
        fetchJob?.workspace_id ??
        (legacyWorkspaceIdentity && typeof legacyWorkspaceIdentity === 'object'
            ? legacyWorkspaceIdentity.id
            : legacyWorkspaceIdentity) ??
        metadata.workspace?.id
    );
}

function getAuthenticatedWorkspaceId(user) {
    return normalizeWorkspaceId(precisionWorkspaceIdentity(user));
}

function fetchJobBelongsToUser(fetchJob, user) {
    const immutableJobUserId = String(fetchJob?.precision_usage_user_id || '').trim();
    if (immutableJobUserId) {
        return immutableJobUserId === String(user?.id || '').trim();
    }
    const jobEmail = normalizeEmail(fetchJob?.user_email);
    return !!jobEmail && jobEmail === normalizeEmail(user?.email);
}

async function polygonHash(points) {
    if (!Array.isArray(points) || points.length < 3) return null;
    const normalized = [];
    for (const point of points) {
        const lat = Number(point?.lat);
        const lng = Number(point?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        normalized.push([Number(lat.toFixed(6)), Number(lng.toFixed(6))]);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(normalized));
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
}

function missingRouteCriteriaFields(body, ownershipMode, workspaceId) {
    const requiredFields = [...REQUIRED_JOB_ROUTE_CRITERIA_FIELDS];
    if (ownershipMode === 'custom') {
        requiredFields.push('ownership_min_days', 'ownership_max_days');
    }
    if (workspaceId) requiredFields.push('workspace_id');
    return requiredFields.filter(field => !hasOwn(body, field));
}

function invalidRequestedCriteriaFields(body, ownershipMode, workspaceId) {
    const invalidFields = [];
    if (!(Number.isFinite(Number(body.sold_months)) && Number(body.sold_months) > 0)) invalidFields.push('sold_months');
    if (!['quick', 'custom'].includes(body.ownership_range_mode)) invalidFields.push('ownership_range_mode');
    if (!['fixed', 'max_available'].includes(body.count_mode)) invalidFields.push('count_mode');
    for (const field of ['requested_properties_before_cap', 'requested_properties']) {
        if (!(Number.isInteger(Number(body[field])) && Number(body[field]) > 0)) invalidFields.push(field);
    }
    if (!(Number.isFinite(Number(body.min_price)) && Number(body.min_price) > 0)) invalidFields.push('min_price');
    if (
        body.max_price !== null &&
        !(Number.isFinite(Number(body.max_price)) && Number(body.max_price) > 0)
    ) {
        invalidFields.push('max_price');
    }
    for (const field of ['route_filters', 'route_bounds']) {
        if (!body[field] || typeof body[field] !== 'object' || Array.isArray(body[field])) invalidFields.push(field);
    }
    if (!(typeof body.repull_mode === 'string' && body.repull_mode.trim())) invalidFields.push('repull_mode');
    if (
        body.previous_pull_date !== null &&
        !Number.isFinite(new Date(body.previous_pull_date).getTime())
    ) {
        invalidFields.push('previous_pull_date');
    }
    for (const field of ['force_full_refresh', 'include_unresolved_followups']) {
        if (typeof body[field] !== 'boolean') invalidFields.push(field);
    }
    if (ownershipMode === 'custom') {
        const min = Number(body.ownership_min_days);
        const max = Number(body.ownership_max_days);
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 365 || min >= max) {
            invalidFields.push('ownership_range_days');
        }
    }
    if (workspaceId && !normalizeWorkspaceId(body.workspace_id)) invalidFields.push('workspace_id');
    return [...new Set(invalidFields)];
}

function invalidPersistedCriteriaFields(criteria) {
    const invalidFields = [];
    if (criteria?.criteria_schema_version !== 1) invalidFields.push('criteria_schema_version');
    if (!criteria?.polygon_hash) invalidFields.push('polygon_hash');
    if (!['fixed', 'max_available'].includes(criteria?.count_mode)) invalidFields.push('count_mode');
    if (!(Number(criteria?.entered_count) > 0)) invalidFields.push('entered_count');
    if (!(Number(criteria?.effective_count) > 0)) invalidFields.push('effective_count');
    if (!(Number(criteria?.min_price) > 0)) invalidFields.push('min_price');
    if (!(Number(criteria?.sold_months) > 0)) invalidFields.push('sold_months');
    if (!['quick', 'custom'].includes(criteria?.ownership_range_mode)) invalidFields.push('ownership_range_mode');
    if (
        criteria?.ownership_range_mode === 'custom' &&
        (!criteria.ownership_range_days || !(criteria.ownership_range_days.min < criteria.ownership_range_days.max))
    ) {
        invalidFields.push('ownership_range_days');
    }
    if (!criteria?.route_filters || typeof criteria.route_filters !== 'object') invalidFields.push('route_filters');
    if (!criteria?.repull_mode) invalidFields.push('repull_mode');
    if (
        typeof criteria?.previous_pull_date === 'string' &&
        criteria.previous_pull_date.startsWith('invalid:')
    ) {
        invalidFields.push('previous_pull_date');
    }
    if (!criteria?.route_bounds || typeof criteria.route_bounds !== 'object') invalidFields.push('route_bounds');
    if (!criteria?.immutable_user_id) invalidFields.push('immutable_user_id');
    if (!criteria?.workspace_id) invalidFields.push('workspace_id');
    return invalidFields;
}

// Identity and workspace are server-derived from the authenticated actor. The
// request body can never supply them, so the comparison against the persisted
// scope stays meaningful instead of comparing a value with itself.
function requestCriteriaFromBody(body, requestedOwnership, requestedPolygonHash, {
    immutableUserId = null,
    workspaceId = null
} = {}) {
    return buildRequestedPrecisionCriteria({
        polygon_hash: requestedPolygonHash,
        count_mode: body.count_mode,
        entered_count: body.requested_properties_before_cap,
        effective_count: body.requested_properties,
        min_price: body.min_price,
        max_price: body.max_price,
        sold_months: body.sold_months,
        ownership_range_mode: body.ownership_range_mode,
        ownership_range_days: requestedOwnership.range,
        route_filters: body.route_filters,
        repull_mode: body.repull_mode,
        previous_pull_date: body.previous_pull_date,
        force_full_refresh: body.force_full_refresh,
        include_unresolved_followups: body.include_unresolved_followups,
        route_bounds: body.route_bounds,
        immutable_user_id: immutableUserId,
        workspace_id: workspaceId
    });
}

// ── Legacy compatibility (jobs completed before schema-v1 criteria) ──────────
// A legacy job is accepted only when the server can prove, from immutable
// persisted evidence, every criterion that determines which rows the exact-job
// query returns. Nothing is inferred from modern defaults.
function invalidLegacyCriteriaFields(criteria) {
    const invalidFields = [];
    if (!criteria?.polygon_hash) invalidFields.push('polygon_hash');
    if (!(Number(criteria?.sold_months) > 0)) invalidFields.push('sold_months');
    if (!['quick', 'custom'].includes(criteria?.ownership_range_mode)) invalidFields.push('ownership_range_mode');
    if (
        criteria?.ownership_range_mode === 'custom' &&
        (!criteria.ownership_range_days || !(criteria.ownership_range_days.min < criteria.ownership_range_days.max))
    ) {
        invalidFields.push('ownership_range_days');
    }
    // A legacy null minimum price is valid: it meant "no price floor".
    if (criteria?.min_price !== null && !(Number(criteria?.min_price) > 0)) invalidFields.push('min_price');
    if (!(Number(criteria?.entered_count) > 0)) invalidFields.push('entered_count');
    if (!(Number(criteria?.effective_count) > 0)) invalidFields.push('effective_count');
    if (!criteria?.immutable_user_id) invalidFields.push('immutable_user_id');
    if (!criteria?.workspace_id) invalidFields.push('workspace_id');
    return invalidFields;
}

function missingLegacyRouteCriteriaFields(body, ownershipMode) {
    const requiredFields = [
        'polygon',
        'sold_months',
        'ownership_range_mode',
        'requested_properties_before_cap',
        'requested_properties',
        'min_price',
        'workspace_id'
    ];
    if (ownershipMode === 'custom') requiredFields.push('ownership_min_days', 'ownership_max_days');
    return requiredFields.filter(field => !hasOwn(body, field));
}

function invalidLegacyRequestedCriteriaFields(body, ownershipMode) {
    const invalidFields = [];
    if (!(Number.isFinite(Number(body.sold_months)) && Number(body.sold_months) > 0)) invalidFields.push('sold_months');
    if (!['quick', 'custom'].includes(body.ownership_range_mode)) invalidFields.push('ownership_range_mode');
    for (const field of ['requested_properties_before_cap', 'requested_properties']) {
        if (!(Number.isInteger(Number(body[field])) && Number(body[field]) > 0)) invalidFields.push(field);
    }
    if (body.min_price !== null && !(Number.isFinite(Number(body.min_price)) && Number(body.min_price) > 0)) {
        invalidFields.push('min_price');
    }
    if (ownershipMode === 'custom') {
        const min = Number(body.ownership_min_days);
        const max = Number(body.ownership_max_days);
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 365 || min >= max) {
            invalidFields.push('ownership_range_days');
        }
    }
    if (!normalizeWorkspaceId(body.workspace_id)) invalidFields.push('workspace_id');
    return [...new Set(invalidFields)];
}

function requestFieldName(criteriaField) {
    if (criteriaField === 'entered_count') return 'requested_properties_before_cap';
    if (criteriaField === 'effective_count') return 'requested_properties';
    if (criteriaField === 'ownership_range_days') return 'ownership_range_days';
    return criteriaField;
}

function isSoldDateInPersistedWindow(value, soldAtOrAfter, soldBefore = null) {
    if (!value || !soldAtOrAfter) return false;
    const soldTime = new Date(value).getTime();
    if (!Number.isFinite(soldTime)) return false;
    const soldDate = new Date(soldTime).toISOString().slice(0, 10);
    const oldestDate = String(soldAtOrAfter).slice(0, 10);
    const newestExclusive = soldBefore ? String(soldBefore).slice(0, 10) : null;
    return soldDate >= oldestDate && (!newestExclusive || soldDate < newestExclusive);
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });

        const body = await req.json().catch(() => ({}));
        const requestedOwnership = parseRequestedCustomOwnershipRange(body);
        if (requestedOwnership.error) {
            return Response.json({ error: 'invalid_ownership_range', message: requestedOwnership.error }, { status: 400 });
        }
        const sql = neon(databaseUrl);
        const zipCodes = normalizeZipList(body);
        const polygonBounds = getBoundsFromPolygon(body.polygon);
        const bounds = body.bounds || polygonBounds;
        const limit = Math.min(Math.max(Number(body.limit || 50000), 1), 100000);
        const requestedSoldMonths = body.sold_months === 'all' || body.sold_months === null
            ? null
            : Number(body.sold_months || 12);
        const fetchJobId = body.fetch_job_id ? String(body.fetch_job_id) : null;
        let referenceMs = Date.now();
        let fetchJob = null;
        let persistedCriteria = null;
        let customOwnershipRange = null;
        let criteriaSource = null;
        let authenticatedImmutableUserId = null;
        let workspaceVerification = null;
        let targetEmail = user.role === 'admin' && body.user_email ? body.user_email : user.email;
        if (fetchJobId) {
            fetchJob = await base44.asServiceRole.entities.FetchJob.get(fetchJobId).catch(() => null);
            if (!fetchJob) {
                return Response.json({
                    error: 'fetch_job_not_found',
                    message: 'The completed property import could not be verified. Route generation stopped so unrelated properties cannot be used.'
                }, { status: 404 });
            }
            if (String(fetchJob.status || '').toLowerCase() !== 'completed') {
                return Response.json({
                    error: 'fetch_job_not_completed',
                    message: 'Precision routes can only use a completed property import.'
                }, { status: 409 });
            }
            if (!fetchJobBelongsToUser(fetchJob, user)) {
                return Response.json({
                    error: 'fetch_job_owner_mismatch',
                    message: 'The completed property import does not belong to the authenticated user.'
                }, { status: 403 });
            }
            const jobEmail = normalizeEmail(fetchJob.user_email);
            if (!jobEmail) {
                return Response.json({
                    error: 'fetch_job_criteria_unverifiable',
                    message: 'The completed property import has no persisted user scope, so route generation stopped.',
                    invalid_fields: ['user_email']
                }, { status: 409 });
            }
            if (body.user_email && normalizeEmail(body.user_email) !== jobEmail) {
                return Response.json({
                    error: 'fetch_job_owner_mismatch',
                    message: 'The requested route workspace does not match the completed property import.'
                }, { status: 403 });
            }
            targetEmail = fetchJob.user_email;

            const jobWorkspaceId = getFetchJobWorkspaceId(fetchJob);
            const authenticatedWorkspaceId = getAuthenticatedWorkspaceId(user);
            if (jobWorkspaceId && authenticatedWorkspaceId && jobWorkspaceId !== authenticatedWorkspaceId) {
                return Response.json({
                    error: 'fetch_job_workspace_mismatch',
                    message: 'The completed property import does not belong to the authenticated workspace.'
                }, { status: 403 });
            }

            const persistedPolygonHash = fetchJob.polygon_hash || await polygonHash(fetchJob.polygon);
            persistedCriteria = buildExistingPrecisionCriteria(fetchJob, {
                polygonHash: persistedPolygonHash
            });
            if (jobWorkspaceId && persistedCriteria.workspace_id !== jobWorkspaceId) {
                persistedCriteria = { ...persistedCriteria, workspace_id: jobWorkspaceId };
            }
            criteriaSource = precisionCriteriaSource(fetchJob);
            authenticatedImmutableUserId = String(user.id || '').trim();
            // Older records predate requested_properties_before_cap. Deriving it
            // from the effective count is not guessing: fetchJobStatus exposes
            // the identical fallback chain, so both sides resolve the same value.
            if (criteriaSource === 'legacy' && !persistedCriteria.entered_count) {
                const legacyEnteredCount = Number(
                    fetchJob.dry_run_metadata?.requested_properties ?? fetchJob.total_expected
                );
                if (Number.isFinite(legacyEnteredCount) && legacyEnteredCount >= 1) {
                    persistedCriteria = { ...persistedCriteria, entered_count: legacyEnteredCount };
                }
            }
            // A legacy job predates persisted workspace evidence. Its workspace
            // relationship is provable only through the immutable subject, which
            // is then required to equal the authenticated actor below.
            if (
                criteriaSource === 'legacy' &&
                !persistedCriteria.workspace_id &&
                authenticatedWorkspaceId &&
                persistedCriteria.immutable_user_id &&
                persistedCriteria.immutable_user_id === authenticatedImmutableUserId
            ) {
                persistedCriteria = { ...persistedCriteria, workspace_id: authenticatedWorkspaceId };
                workspaceVerification = 'derived_from_immutable_subject';
            }
            customOwnershipRange = persistedCriteria.ownership_range_mode === 'custom'
                ? persistedCriteria.ownership_range_days
                : null;
            const invalidPersistedFields = criteriaSource === 'schema_v1'
                ? invalidPersistedCriteriaFields(persistedCriteria)
                : invalidLegacyCriteriaFields(persistedCriteria);
            if (invalidPersistedFields.length > 0) {
                return Response.json({
                    error: criteriaSource === 'schema_v1'
                        ? 'fetch_job_criteria_unverifiable'
                        : 'legacy_precision_criteria_unverifiable',
                    message: criteriaSource === 'schema_v1'
                        ? 'The completed property import is missing required persisted criteria, so route generation stopped.'
                        : 'This older property import cannot be verified without guessing its original criteria, so route generation stopped.',
                    criteria_verification: criteriaSource === 'schema_v1' ? 'schema_v1' : 'legacy_reconstructed',
                    invalid_fields: invalidPersistedFields
                }, { status: 409 });
            }
            if (persistedCriteria.immutable_user_id !== authenticatedImmutableUserId) {
                return Response.json({
                    error: 'fetch_job_owner_mismatch',
                    message: 'The persisted import criteria do not belong to the authenticated user.'
                }, { status: 403 });
            }
            if (persistedCriteria.workspace_id !== authenticatedWorkspaceId) {
                return Response.json({
                    error: 'fetch_job_workspace_mismatch',
                    message: 'The persisted import criteria do not belong to the authenticated workspace.'
                }, { status: 403 });
            }
            // The body may state its workspace, but it can never override the
            // server-derived one.
            const requestedWorkspaceId = normalizeWorkspaceId(body.workspace_id);
            if (requestedWorkspaceId && requestedWorkspaceId !== authenticatedWorkspaceId) {
                return Response.json({
                    error: 'fetch_job_workspace_mismatch',
                    message: 'The requested workspace does not match the authenticated workspace.'
                }, { status: 403 });
            }

            const fetchJobTime = fetchJob?.created_date || fetchJob?.started_at;
            const parsed = fetchJobTime ? new Date(fetchJobTime).getTime() : NaN;
            if (!Number.isFinite(parsed)) {
                return Response.json({
                    error: 'fetch_job_criteria_unverifiable',
                    message: 'The completed property import has no valid criteria reference timestamp, so route generation stopped.',
                    invalid_fields: ['ownership_reference_date']
                }, { status: 409 });
            }
            referenceMs = parsed;

            if (requestedOwnership.range && !customOwnershipRangesMatch(requestedOwnership.range, customOwnershipRange)) {
                return Response.json({
                    error: 'ownership_range_mismatch',
                    message: 'The completed import does not match the selected custom ownership range. Route generation stopped instead of using properties from another date range.',
                    requested_ownership_range_days: requestedOwnership.range,
                    job_ownership_range_days: customOwnershipRange
                }, { status: 409 });
            }

            if (body.debug_job !== true) {
                const missingFields = criteriaSource === 'schema_v1'
                    ? missingRouteCriteriaFields(
                        body,
                        persistedCriteria.ownership_range_mode,
                        persistedCriteria.workspace_id
                    )
                    : missingLegacyRouteCriteriaFields(body, persistedCriteria.ownership_range_mode);
                const requestedPolygonHash = await polygonHash(body.polygon);
                const invalidRequestFields = criteriaSource === 'schema_v1'
                    ? invalidRequestedCriteriaFields(
                        body,
                        persistedCriteria.ownership_range_mode,
                        persistedCriteria.workspace_id
                    )
                    : invalidLegacyRequestedCriteriaFields(body, persistedCriteria.ownership_range_mode);
                if (!requestedPolygonHash) invalidRequestFields.push('polygon');
                if (missingFields.length > 0 || invalidRequestFields.length > 0) {
                    const mismatchFields = [...new Set([...missingFields, ...invalidRequestFields])];
                    return Response.json({
                        error: 'fetch_job_criteria_mismatch',
                        message: 'The route-generation request is missing or has invalid criteria required by the completed property import.',
                        mismatch_fields: mismatchFields,
                        mismatches: mismatchFields.map(field => ({
                            field,
                            reason: missingFields.includes(field) ? 'missing' : 'invalid'
                        }))
                    }, { status: 409 });
                }

                const requestedCriteria = requestCriteriaFromBody(
                    body,
                    requestedOwnership,
                    requestedPolygonHash,
                    {
                        immutableUserId: authenticatedImmutableUserId,
                        workspaceId: authenticatedWorkspaceId
                    }
                );
                const comparison = criteriaSource === 'schema_v1'
                    ? comparePrecisionCriteria(requestedCriteria, persistedCriteria)
                    : comparePrecisionCriteria(requestedCriteria, persistedCriteria, LEGACY_VERIFIED_CRITERIA_FIELDS);
                if (!comparison.matches) {
                    const mismatchFields = [...new Set(comparison.mismatched_fields.map(requestFieldName))];
                    return Response.json({
                        error: 'fetch_job_criteria_mismatch',
                        message: 'The route-generation criteria do not exactly match the completed property import.',
                        mismatch_fields: mismatchFields,
                        mismatches: mismatchFields.map(field => ({ field, reason: 'different' }))
                    }, { status: 409 });
                }
            }
        } else if (requestedOwnership.range) {
            return Response.json({
                error: 'custom_range_requires_fetch_job',
                message: 'Custom ownership routes require the exact completed import job.'
            }, { status: 400 });
        }

        const soldMonths = persistedCriteria?.sold_months ?? requestedSoldMonths;
        const customSoldAtOrAfter = customOwnershipRange
            ? `${isoDateDaysAgo(customOwnershipRange.max, referenceMs)}T00:00:00.000Z`
            : null;
        const customSoldBefore = customOwnershipRange
            ? `${isoDateDaysAgo(customOwnershipRange.min - 1, referenceMs)}T00:00:00.000Z`
            : null;
        const soldAfter = soldMonths ? `${isoDateDaysAgo(routeCandidateSoldWindowDays(soldMonths), referenceMs)}T00:00:00.000Z` : null;
        const exactJobSoldAtOrAfter = fetchJobId
            ? customSoldAtOrAfter || soldAfter
            : null;
        const exactJobSoldBefore = fetchJobId
            ? customSoldBefore
            : null;

        if (body.debug_job === true && fetchJobId) {
            const debugRows = await sql`
                SELECT
                    p.full_address,
                    p.sold_date,
                    p.sale_confidence,
                    p.original_status,
                    COALESCE(
                        p.raw_payload -> 'property' ->> 'subdivision_name',
                        p.raw_payload ->> 'subdivision_name',
                        p.raw_payload ->> 'subdivisionName',
                        to_jsonb(p) ->> 'subdivision_name'
                    ) AS subdivision_name,
                    p.property_type,
                    p.data_source,
                    p.raw_payload,
                    wp.route_active,
                    wp.status,
                    wp.fetch_job_id
                FROM workspace_properties wp
                JOIN properties p ON p.id = wp.property_id
                WHERE wp.user_email = ${targetEmail}
                  AND wp.fetch_job_id = ${fetchJobId}
                ORDER BY p.updated_at DESC
                LIMIT ${limit}
            `;
            const properties = debugRows.map(row => {
                let raw = {};
                try { raw = row.raw_payload ? JSON.parse(row.raw_payload) : {}; } catch { raw = {}; }
                const listingStatus = String(raw?.listing?.status || raw?.listing?.statusCategory || '').toLowerCase();
                const landUseCode = raw?.general?.standardizedLandUseCode || raw?.standardizedLandUseCode || null;
                const reason = row.route_active === true && row.status !== 'REJECTED' && row.original_status !== 'REJECTED' && row.sale_confidence !== 'REJECTED'
                    ? 'active'
                    : !row.sold_date
                        ? 'missing_or_unmapped_sold_date'
                        : (landUseCode && landUseCode !== 'R2')
                            ? `land_use_${landUseCode}`
                            : (listingStatus === 'active' || listingStatus === 'for sale' || listingStatus === 'off market' || listingStatus === 'pending' || listingStatus === 'withdrawn')
                                ? `listing_${listingStatus}`
                                : 'rejected_by_local_eligibility';
                const rawShape = {
                    top_level: Object.keys(raw || {}).slice(0, 30),
                    intel_keys: Object.keys(raw?.intel || {}).slice(0, 30),
                    sale_keys: Object.keys(raw?.sale || {}).slice(0, 30),
                    last_sale_keys: Object.keys(raw?.lastSale || {}).slice(0, 30),
                    deed_keys: Object.keys(raw?.deed || {}).slice(0, 30),
                    listing_keys: Object.keys(raw?.listing || {}).slice(0, 30)
                };
                const { raw_payload, ...safeRow } = row;
                return { ...safeRow, rejection_reason: reason, batchdata_land_use_code: landUseCode, batchdata_listing_status: listingStatus || null, raw_shape: rawShape };
            });
            const breakdown = properties.reduce((acc, row) => {
                const key = row.rejection_reason || 'unknown';
                acc[key] = (acc[key] || 0) + 1;
                return acc;
            }, {});
            return Response.json({ success: true, user_email: targetEmail, fetch_job_id: fetchJobId, count: properties.length, breakdown, properties });
        }

        const rows = await sql`
            SELECT
                p.id,
                p.address_hash,
                p.legacy_hash,
                p.full_address,
                p.house_number,
                p.street_name,
                COALESCE(
                    p.raw_payload -> 'property' ->> 'subdivision_name',
                    p.raw_payload ->> 'subdivision_name',
                    p.raw_payload ->> 'subdivisionName',
                    to_jsonb(p) ->> 'subdivision_name'
                ) AS subdivision_name,
                p.city,
                p.state,
                p.zip_code,
                p.lat,
                p.lng,
                p.h3_index,
                p.owner_full_name,
                p.owner_occupied,
                p.corporate_owned,
                p.investor_owned,
                p.beds,
                p.baths,
                p.sqft,
                p.lot_size,
                p.year_built,
                p.price,
                p.sold_date,
                p.sale_type,
                p.property_type,
                p.mls_id,
                p.url,
                p.data_source,
                p.sale_confidence,
                p.original_status,
                wp.route_active,
                wp.status,
                wp.fetch_job_id,
                wp.assigned_route_id,
                p.created_at,
                p.updated_at
            FROM workspace_properties wp
            JOIN properties p ON p.id = wp.property_id
            WHERE wp.user_email = ${targetEmail}
              AND (${fetchJobId === null} OR wp.fetch_job_id = ${fetchJobId})
              AND wp.route_active = TRUE
              AND p.lat IS NOT NULL
              AND p.lng IS NOT NULL
              AND COALESCE(wp.status, '') <> 'REJECTED'
              AND COALESCE(p.original_status, '') <> 'REJECTED'
              AND COALESCE(p.sale_confidence, '') <> 'REJECTED'
              AND (${zipCodes.length === 0} OR p.zip_code = ANY(${zipCodes}))
              AND (${fetchJobId !== null || soldAfter === null} OR p.sold_date IS NULL OR p.sold_date >= ${soldAfter})
              AND (${fetchJobId === null || exactJobSoldAtOrAfter === null} OR (
                    p.sold_date IS NOT NULL
                    AND p.sold_date >= ${exactJobSoldAtOrAfter}
                    AND (${exactJobSoldBefore === null} OR p.sold_date < ${exactJobSoldBefore})
              ))
              AND (${!bounds?.minLat} OR p.lat >= ${bounds?.minLat || 0})
              AND (${!bounds?.maxLat} OR p.lat <= ${bounds?.maxLat || 0})
              AND (${!bounds?.minLng} OR p.lng >= ${bounds?.minLng || 0})
              AND (${!bounds?.maxLng} OR p.lng <= ${bounds?.maxLng || 0})
            ORDER BY p.sold_date DESC NULLS LAST, p.updated_at DESC
            LIMIT ${limit}
        `;

        const exactJobRows = fetchJobId
            ? rows.filter(row => (
                String(row.fetch_job_id || '') === fetchJobId &&
                isSoldDateInPersistedWindow(row.sold_date, exactJobSoldAtOrAfter, exactJobSoldBefore)
            ))
            : rows;
        const excludedOutsideExactJobWindow = rows.length - exactJobRows.length;
        const rangeCheckedRows = customOwnershipRange
            ? exactJobRows.filter(row => isSoldDateInCustomOwnershipRange(row.sold_date, customOwnershipRange, referenceMs))
            : exactJobRows;
        const excludedOutsideCustomRange = exactJobRows.length - rangeCheckedRows.length;

        let properties = rangeCheckedRows.map(row => ({
            ...row,
            id: String(row.id),
            address_hash: row.address_hash || String(row.id),
            created_date: row.created_at,
            updated_date: row.updated_at
        }));

        // Payload reduction: fields='map' returns only what the map pipeline needs
        // (pins, status colors, sold/price/phase filters, dedupe, detail sheet basics).
        // Cuts response size roughly in half vs. the full record.
        if (body.fields === 'map') {
            const MAP_FIELDS = [
                'id', 'address_hash', 'legacy_hash', 'full_address', 'house_number', 'street_name',
                'subdivision_name', 'city', 'state', 'zip_code', 'lat', 'lng', 'owner_full_name', 'owner_occupied',
                'corporate_owned', 'investor_owned', 'beds', 'baths', 'sqft',
                'lot_size', 'year_built', 'price', 'sold_date', 'sale_type', 'property_type', 'mls_id',
                'data_source', 'sale_confidence', 'original_status', 'route_active', 'status'
            ];
            properties = properties.map(p => {
                const slim = {};
                for (const f of MAP_FIELDS) {
                    if (p[f] !== undefined && p[f] !== null) slim[f] = p[f];
                }
                return slim;
            });
        }

        return Response.json({
            success: true,
            user_email: targetEmail,
            fetch_job_id: fetchJobId,
            criteria_verified: fetchJobId !== null,
            criteria_verification: fetchJobId === null
                ? null
                : criteriaSource === 'schema_v1' ? 'schema_v1' : 'legacy_reconstructed',
            workspace_verification: workspaceVerification,
            unverified_fields: criteriaSource === 'legacy' ? [...LEGACY_UNVERIFIABLE_CRITERIA_FIELDS] : [],
            count: properties.length,
            capped: properties.length >= limit,
            limit,
            sold_months: soldMonths,
            min_price: persistedCriteria ? persistedCriteria.min_price : null,
            max_price: persistedCriteria ? persistedCriteria.max_price : null,
            sold_at_or_after: exactJobSoldAtOrAfter,
            sold_before: exactJobSoldBefore,
            ownership_range_mode: customOwnershipRange ? 'custom' : 'quick',
            ownership_min_days: customOwnershipRange?.min ?? null,
            ownership_max_days: customOwnershipRange?.max ?? null,
            ownership_range_days: customOwnershipRange,
            excluded_outside_exact_job_window: excludedOutsideExactJobWindow,
            excluded_outside_custom_range: excludedOutsideCustomRange,
            properties
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
