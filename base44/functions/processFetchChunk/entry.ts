import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import { findPolygonSelfIntersection } from '../../shared/precisionOrderSafety.js';

const BATCHDATA_API_KEY = Deno.env.get('BATCH_DATA_API_KEY');
const DATABASE_URL = Deno.env.get('DATABASE_URL');
const BATCHDATA_BASE = 'https://api.batchdata.com/api/v1/property/search';
const BATCHDATA_MAX_TAKE = 100;
const BATCHDATA_REQUEST_TIMEOUT_MS = 20 * 1000;
const BATCHDATA_PROGRESS_UPDATE_MS = 1500;
// Per-invocation provider scan budget. When it runs out, the chunk persists its
// offset and chains the next invocation, so a 24k-record area completes across
// many chunks instead of stopping at an arbitrary scan ceiling.
const CHUNK_SCAN_BUDGET_MS = 30 * 1000;
// Selection ceiling per invocation. Writes are per-record, so this bounds how
// long the Neon write phase of one chunk can take.
const CHUNK_MAX_SELECTED = 750;
const PIPELINE_LOCK_TTL_MS = 8 * 60 * 1000;
const DEFAULT_ROUTE_TYPE_FILTERS = {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
};
const ALLOWED_ROUTE_PROPERTY_TYPES = new Set(['Single Family']);
const PROPERTY_TYPE_ALIASES = {
    'Single Family': ['single family', 'single family residential', 'single-family', 'sfr', 'sfh', 'detached', 'one family', '1 family']
};
const COMMERCIAL_TYPE_KEYWORDS = ['commercial', 'industrial', 'retail', 'office', 'warehouse', 'business', 'shopping', 'hotel', 'motel', 'restaurant', 'medical', 'hospital'];
const CONDO_MULTI_TYPE_KEYWORDS = ['condo', 'condominium', 'apartment', 'co op', 'coop', 'cooperative', 'multifamily', 'multi family', 'multi-family', 'duplex', 'triplex', 'fourplex', 'townhouse', 'townhome', 'row house', 'rowhouse'];
const LAND_TYPE_KEYWORDS = ['land', 'lot', 'vacant', 'acreage', 'farm', 'agricultural'];
const INVALID_SUBDIVISION_NAMES = new Set([
    '-', '0', 'n/a', 'na', 'none', 'null', 'unknown',
    'not available', 'not provided', 'no subdivision', 'unnamed'
]);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function isDiagnosticRequest(req) {
    const expected = Deno.env.get('PRECISION_DIAGNOSTIC_SECRET');
    const received = req.headers.get('x-precision-diagnostic-secret');
    return Boolean(expected) && received === expected;
}

async function countPersistedPrecisionProperties(jobId) {
    if (!DATABASE_URL || !jobId) throw new Error('Cannot settle Precision usage without DATABASE_URL and a job id.');
    const sql = neon(DATABASE_URL);
    const rows = await sql`
        SELECT COUNT(*)::int AS count
        FROM workspace_properties
        WHERE fetch_job_id = ${jobId}
          AND route_active = TRUE
    `;
    return Math.max(0, Number(rows[0]?.count || 0));
}

function cancellationRequested(job) {
    return job?.status === 'cancelled' || Boolean(job?.precision_cancel_requested_at);
}

async function settleCancelledPrecisionUsage(base44, job, completedAt, message) {
    const settledUsageCount = await countPersistedPrecisionProperties(job.id);
    await base44.asServiceRole.entities.FetchJob.update(job.id, {
        status: 'cancelled',
        precision_usage_reserved: 0,
        precision_usage_count: settledUsageCount,
        precision_usage_recorded_at: completedAt,
        completed_at: completedAt,
        error_message: 'Cancelled by user',
        error_log: [
            ...(job.error_log || []),
            `[${completedAt}] ${message} Settled ${settledUsageCount} persisted Precision properties.`
        ]
    });
    return settledUsageCount;
}

function normalizePropertyTypeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[\/_-]+/g, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function includesAnyPropertyType(text, keywords) {
    return keywords.some(keyword => text.includes(normalizePropertyTypeText(keyword)));
}

function isVagueResidentialType(text) {
    if (!text) return true;
    if (/^r\d+[a-z]?$/.test(text)) return true;
    return ['residential', 'residential property', 'residence', 'improved residential', 'residential improved'].includes(text);
}

function matchesSelectedPropertyType(propertyType, selectedType) {
    const text = normalizePropertyTypeText(propertyType);
    if (!text) return true;

    const aliases = PROPERTY_TYPE_ALIASES[selectedType] || [selectedType];
    if (aliases.some(alias => text.includes(normalizePropertyTypeText(alias)))) return true;

    if (
        selectedType === 'Single Family' &&
        isVagueResidentialType(text) &&
        !includesAnyPropertyType(text, [...CONDO_MULTI_TYPE_KEYWORDS, ...LAND_TYPE_KEYWORDS, ...COMMERCIAL_TYPE_KEYWORDS, 'townhouse', 'townhome'])
    ) {
        return true;
    }

    return false;
}

function normalizeRouteTypeFilters(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const requestedTypes = Array.isArray(source.propertyTypes) ? source.propertyTypes.map(String).filter(Boolean) : [];
    const propertyTypes = requestedTypes.filter(type => ALLOWED_ROUTE_PROPERTY_TYPES.has(type));
    return {
        propertyTypes: propertyTypes.length > 0 ? propertyTypes : DEFAULT_ROUTE_TYPE_FILTERS.propertyTypes,
        excludeCommercial: true,
        excludeCondos: true,
        excludeLand: true
    };
}

function getRouteTypeFilters(job) {
    return normalizeRouteTypeFilters(job?.dry_run_metadata?.route_filters || DEFAULT_ROUTE_TYPE_FILTERS);
}

function routeTypeEligibility(property, filters = DEFAULT_ROUTE_TYPE_FILTERS) {
    const normalizedFilters = normalizeRouteTypeFilters(filters);
    const text = normalizePropertyTypeText(property?.property_type);
    const selectedTypes = normalizedFilters.propertyTypes;

    if (selectedTypes.length > 0 && !selectedTypes.some(type => matchesSelectedPropertyType(text, type))) {
        return { eligible: false, reason: 'includePropertyTypes' };
    }
    if (normalizedFilters.excludeCommercial && includesAnyPropertyType(text, COMMERCIAL_TYPE_KEYWORDS)) {
        return { eligible: false, reason: 'excludeCommercial' };
    }
    if (normalizedFilters.excludeCondos && includesAnyPropertyType(text, CONDO_MULTI_TYPE_KEYWORDS)) {
        return { eligible: false, reason: 'excludeCondosMultiFamily' };
    }
    if (normalizedFilters.excludeLand && includesAnyPropertyType(text, LAND_TYPE_KEYWORDS)) {
        return { eligible: false, reason: 'excludeLand' };
    }

    return { eligible: true, reason: null };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = BATCHDATA_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error(`BatchData request timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function claimPipelineLock(base44, jobId, lockedBy) {
    const now = Date.now();
    const existing = await base44.asServiceRole.entities.PipelineLock.filter({ job_id: jobId }, '-created_date', 20).catch(() => []);
    const locks = Array.isArray(existing) ? existing : (existing?.items || []);

    for (const lock of locks) {
        const lockedAtMs = new Date(lock.locked_at || lock.created_date).getTime();
        if (!lockedAtMs || now - lockedAtMs > PIPELINE_LOCK_TTL_MS) {
            await base44.asServiceRole.entities.PipelineLock.delete(lock.id).catch(() => {});
        }
    }

    const active = locks.filter(lock => {
        const lockedAtMs = new Date(lock.locked_at || lock.created_date).getTime();
        return lockedAtMs && now - lockedAtMs <= PIPELINE_LOCK_TTL_MS;
    });
    if (active.length > 0) return { claimed: false, reason: 'active_lock', lockedBy: active[0]?.locked_by };

    const created = await base44.asServiceRole.entities.PipelineLock.create({
        job_id: jobId,
        locked_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + PIPELINE_LOCK_TTL_MS).toISOString(),
        locked_by: lockedBy
    });
    return { claimed: true, lockId: created.id };
}

async function releasePipelineLock(base44, lockId) {
    if (lockId) await base44.asServiceRole.entities.PipelineLock.delete(lockId).catch(() => {});
}

function normalizeAddress(address) {
    return String(address || '')
        .toUpperCase()
        .trim()
        .replace(/[.,#]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\bSTREET\b/g, 'ST')
        .replace(/\bAVENUE\b/g, 'AVE')
        .replace(/\bBOULEVARD\b/g, 'BLVD')
        .replace(/\bDRIVE\b/g, 'DR')
        .replace(/\bLANE\b/g, 'LN')
        .replace(/\bROAD\b/g, 'RD')
        .replace(/\bCOURT\b/g, 'CT')
        .replace(/\bCIRCLE\b/g, 'CIR')
        .replace(/\bPLACE\b/g, 'PL')
        .replace(/\bTERRACE\b/g, 'TER')
        .replace(/\bPARKWAY\b/g, 'PKWY')
        .replace(/\bHIGHWAY\b/g, 'HWY');
}

function addressHash(addressLine, zipCode) {
    return `${normalizeAddress(addressLine)}|${String(zipCode || '00000').slice(0, 5)}`;
}

function firstValue(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function normalizeSubdivisionName(...values) {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const normalized = value.replace(/\s+/g, ' ').trim();
        if (!normalized || normalized.length > 160) continue;
        const comparison = normalized.toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!INVALID_SUBDIVISION_NAMES.has(comparison)) return normalized;
    }
    return null;
}

function numberValue(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object') {
            const nested = numberValue(value.amount, value.value, value.estimatedValue, value.total, value.number, value.raw);
            if (nested !== null) return nested;
            continue;
        }
        const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function booleanValue(...values) {
    for (const value of values) {
        if (value === true || value === false) return value;
        if (value === 1 || value === '1') return true;
        if (value === 0 || value === '0') return false;
        const normalized = String(value ?? '').trim().toLowerCase();
        if (['true', 'yes', 'y'].includes(normalized)) return true;
        if (['false', 'no', 'n'].includes(normalized)) return false;
    }
    return null;
}

function dateValue(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object') {
            const nested = dateValue(value.date, value.value, value.recordingDate, value.saleDate);
            if (nested) return nested;
            continue;
        }
        return value;
    }
    return null;
}

function isPointInPolygon(point, polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return true;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = Number(polygon[i].lng), yi = Number(polygon[i].lat);
        const xj = Number(polygon[j].lng), yj = Number(polygon[j].lat);
        const intersects = ((yi > point.lat) !== (yj > point.lat)) &&
            (point.lng < (xj - xi) * (point.lat - yi) / ((yj - yi) || 1e-12) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function closePolygon(points) {
    const polygon = Array.isArray(points) ? points
        .map(point => ({ latitude: Number(point.lat ?? point.latitude), longitude: Number(point.lng ?? point.longitude) }))
        .filter(point => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)) : [];
    if (polygon.length < 3) throw new Error(`Invalid polygon: minimum 3 distinct points required. Received ${polygon.length} distinct points.`);
    const first = polygon[0];
    const last = polygon[polygon.length - 1];
    if (first.latitude !== last.latitude || first.longitude !== last.longitude) {
        polygon.push({ ...first });
    }
    const distinct = new Set(polygon.slice(0, -1).map(point => `${point.latitude.toFixed(7)},${point.longitude.toFixed(7)}`));
    if (distinct.size < 3) throw new Error(`Invalid polygon: minimum 3 distinct points required. Received ${distinct.size} distinct points.`);

    // Defense in depth. The start paths already reject a crossing boundary, but
    // a job stored before that validation existed can still reach here. The
    // provider rejects such geometry with an opaque 500, so fail first — this
    // runs while the request is being built, before any network call.
    const intersection = findPolygonSelfIntersection(
        polygon.map(point => ({ lat: point.latitude, lng: point.longitude }))
    );
    if (intersection) {
        throw new Error(
            `Invalid polygon: the boundary crosses itself near ${intersection.lat}, ${intersection.lng}. `
            + 'Redraw the area without overlapping lines.'
        );
    }

    return polygon;
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

function soldWindowDays(soldMonths) {
    return requestedSoldWindowDays(soldMonths);
}

function jobReferenceTimeMs(job) {
    const value = job?.created_date || job?.started_at;
    const time = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(time) ? time : Date.now();
}

function isoDateDaysAgo(days, referenceMs = Date.now()) {
    const date = new Date(referenceMs - days * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
}

function isoDateOnly(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

function getCustomOwnershipRange(job) {
    const metadata = job?.dry_run_metadata || {};
    if (metadata.ownership_range_mode !== 'custom') return null;
    const min = Number(metadata.ownership_range_days?.min);
    const max = Number(metadata.ownership_range_days?.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 365 || min >= max) {
        throw new Error('FetchJob has invalid custom ownership range metadata.');
    }
    return { min, max };
}

function ownershipDateBounds(job) {
    const range = getCustomOwnershipRange(job);
    if (!range) return null;
    const referenceMs = jobReferenceTimeMs(job);
    return {
        ...range,
        oldestDate: isoDateDaysAgo(range.max, referenceMs),
        newestDate: isoDateDaysAgo(range.min, referenceMs)
    };
}

function ownershipLookbackDays(job) {
    return getCustomOwnershipRange(job)?.max ?? soldWindowDays(job.sold_months || 12);
}

function ownershipResponseFields(job) {
    const range = getCustomOwnershipRange(job);
    return {
        ownership_range_mode: range ? 'custom' : 'quick',
        ownership_min_days: range?.min ?? null,
        ownership_max_days: range?.max ?? null,
        ownership_range_days: range
    };
}

function preparePreviewJobOwnership(job = {}, source = {}) {
    const metadata = job.dry_run_metadata || {};
    const mode = source.ownership_range_mode ?? job.ownership_range_mode ?? metadata.ownership_range_mode ?? 'quick';
    if (!['quick', 'custom'].includes(mode)) {
        throw new Error('ownership_range_mode must be either quick or custom.');
    }
    if (mode === 'quick') {
        return {
            ...job,
            dry_run_metadata: {
                ...metadata,
                ownership_range_mode: 'quick',
                ownership_range_days: null
            }
        };
    }

    const existingRange = metadata.ownership_range_days || {};
    const min = Number(source.ownership_min_days ?? job.ownership_min_days ?? existingRange.min);
    const max = Number(source.ownership_max_days ?? job.ownership_max_days ?? existingRange.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 365 || min >= max) {
        throw new Error('Custom ownership range requires whole-day minimum and maximum values from 1 to 365, with minimum less than maximum.');
    }
    return {
        ...job,
        sold_months: max === 365 ? 12 : max / 30,
        dry_run_metadata: {
            ...metadata,
            ownership_range_mode: 'custom',
            ownership_range_days: { min, max }
        }
    };
}

function buildBatchDataRequest(job, skip = 0, take = 500, mode = 'strict_polygon') {
    const filters = job.dry_run_metadata?.filters || {};
    const minPriceRaw = Number(filters.min_price);
    const maxPriceRaw = Number(filters.max_price);
    const minPrice = Number.isFinite(minPriceRaw) && minPriceRaw > 0 ? minPriceRaw : null;
    const maxPrice = Number.isFinite(maxPriceRaw) && maxPriceRaw > 0 ? maxPriceRaw : null;
    const estimatedValue = {};
    if (minPrice) estimatedValue.min = minPrice;
    if (maxPrice) estimatedValue.max = maxPrice;

    // Always compute the oldest allowed sold date. For custom ranges, BatchData
    // receives both date bounds. Local mapping and candidate SQL enforce the
    // same bounds again so correctness does not depend on provider behavior.
    const soldMinDate = isoDateDaysAgo(ownershipLookbackDays(job), jobReferenceTimeMs(job));
    const customOwnershipBounds = ownershipDateBounds(job);
    const soldDateRange = {
        minDate: soldMinDate,
        ...(customOwnershipBounds ? { maxDate: customOwnershipBounds.newestDate } : {})
    };

    // Intentionally omit `options.datasets`.
    //
    // `intel` is not a member of the selectable `basic | listing | deed | owner`
    // dataset list, so ANY datasets array suppresses the very object this
    // request filters on (`searchCriteria.intel.lastSoldDate`) and the object
    // the mapper treats as authoritative for recorded sale date, estimated
    // value, year built and living area. Scoping therefore returns an
    // owner/address shell: address, coordinates and owner present, with value,
    // beds, baths, sqft, lot size, year built and sold date all null. The local
    // gates deliberately do not reject incomplete rows, so such shells persist
    // and reach routes.
    //
    // Guarded by test/precision-batchdata-enrichment-contract.test.mjs.
    const options = {
        skip,
        take: Math.min(Math.max(Number(take) || BATCHDATA_MAX_TAKE, 1), BATCHDATA_MAX_TAKE)
    };

    if (mode === 'centroid_fallback') {
        return {
            searchCriteria: {
                query: `${job.latitude},${job.longitude}`,
                intel: { lastSoldDate: soldDateRange }
            },
            options
        };
    }

    const searchCriteria = {
        address: {
            geoLocationPolygon: {
                geoPoints: closePolygon(job.polygon || [])
            }
        },
        intel: { lastSoldDate: soldDateRange }
    };

    // Precision routes should only contain residential single-family homes.
    // BatchData's R2 code is the single-family residential land-use bucket used
    // by the prior strict request path; apply it to the live broad request too.
    searchCriteria.general = { standardizedLandUseCode: { equals: 'R2' } };

    // Home value range applies in ALL polygon modes. Previously it was only attached in
    // strict_polygon — but the live pull uses broad_polygon, so user price filters were
    if (Object.keys(estimatedValue).length > 0) {
        searchCriteria.valuation = { estimatedValue };
    }

    return { searchCriteria, options };
}

function extractBatchDataRecords(payload) {
    const batch = payload?.results?.properties || payload?.properties || payload?.results || [];
    return Array.isArray(batch) ? batch : [batch].filter(Boolean);
}

function extractBatchDataTotal(payload) {
    return Number(payload?.results?.totalRecordCount ?? payload?.totalRecordCount ?? payload?.meta?.totalRecordCount ?? 0) || null;
}

function normalizeBatchDataAddress(record) {
    const address = record.address || record.propertyAddress || record.situsAddress || {};
    const location = address.location || {};
    const formattedStreet = typeof record.formattedAddress === 'string' ? record.formattedAddress.split(',')[0] : '';
    const street = firstValue(address.street, address.streetAddress, address.addressLine1, record.addressLine1, formattedStreet);
    return {
        street: street || '',
        city: firstValue(address.city, record.city) || '',
        state: firstValue(address.state, record.state) || '',
        zip: String(firstValue(address.zip, address.zipCode, record.zipCode, '') || '').slice(0, 5),
        lat: Number(firstValue(location.latitude, address.latitude, address.lat, record.latitude, record.lat)),
        lng: Number(firstValue(location.longitude, address.longitude, address.lng, record.longitude, record.lng))
    };
}

/**
 * Reports the dataset scope of the REAL outbound request.
 *
 * This must never be a hard-coded claim. It previously asserted
 * 'omitted_for_sale_evidence' while the builder was in fact sending
 * options.datasets, so the self-test reported the intended contract rather than
 * the actual one and the defect looked tested. Deriving it from a representative
 * request means the two cannot diverge again.
 */
function observedDatasetScope() {
    try {
        const probe = buildBatchDataRequest(
            {
                polygon: [
                    { lat: 0, lng: 0 },
                    { lat: 0, lng: 1 },
                    { lat: 1, lng: 1 }
                ],
                latitude: 0,
                longitude: 0,
                sold_months: 12,
                dry_run_metadata: { filters: {} }
            },
            0,
            BATCHDATA_MAX_TAKE,
            'strict_polygon'
        );
        const datasets = probe?.options?.datasets;
        if (datasets === undefined) return 'omitted_for_sale_evidence';
        return `scoped:${Array.isArray(datasets) ? datasets.join('+') : String(datasets)}`;
    } catch {
        return 'unknown';
    }
}

/**
 * Accumulates enrichment and route-outcome diagnostics DURING the provider
 * page loop, while every returned row is still in hand.
 *
 * This must not be computed at completion. `fetchBatchDataRecordsForMode`
 * returns only the SELECTED rows — and for a custom-range job that selected
 * nothing it deliberately returns `records: []`, while the non-custom path
 * returns at most a capped rejected sample. Summarizing either would report
 * zero provider rows for a job that in fact reviewed dozens, which is exactly
 * the case these diagnostics exist to explain.
 *
 * Counts only. No payload, address or owner content is retained.
 */
function createDiagnosticLedger() {
    const provider = {
        provider_records_reviewed: 0,
        provider_records_with_intel_last_sold_date: 0,
        provider_records_with_any_sale_date: 0,
        provider_records_with_estimated_value: 0,
        provider_records_with_year_built: 0,
        provider_records_with_beds: 0,
        provider_records_with_baths: 0,
        provider_records_with_sqft: 0,
        provider_records_with_lot_size: 0
    };
    const enrichment = {
        mapped_records_reviewed: 0,
        records_with_recorded_sale_date: 0,
        records_with_estimated_value: 0,
        records_with_year_built: 0,
        records_with_beds: 0,
        records_with_baths: 0,
        records_with_sqft: 0,
        records_with_lot_size: 0,
        records_missing_recorded_sale_date: 0,
        records_missing_estimated_value: 0
    };
    const outcomes = {
        mapped_route_active_before_selection: 0,
        custom_range_missing_sale_date: 0,
        custom_range_outside_date_window: 0,
        rejected_price: 0,
        rejected_property_type: 0,
        rejected_land_use: 0,
        outside_polygon_or_invalid: 0
    };

    const num = (value) => Number.isFinite(Number(value)) && Number(value) !== 0;
    const filled = (value) => value !== null && value !== undefined && value !== '';

    return {
        /** Called once per provider page, BEFORE any row is mapped or filtered. */
        observeProviderPage(list = []) {
            for (const record of (Array.isArray(list) ? list : [])) {
                if (!record) continue;
                const p = record.property || record;
                provider.provider_records_reviewed += 1;
                try {
                    if (p.intel?.lastSoldDate) provider.provider_records_with_intel_last_sold_date += 1;
                    if (
                        p.intel?.lastSoldDate || p.intel?.lastSaleDate || p.intel?.lastTransferDate ||
                        p.sale?.lastSaleDate || p.sale?.saleDate || p.sale?.recordingDate || p.sale?.date ||
                        p.lastSoldDate || p.sold_date
                    ) provider.provider_records_with_any_sale_date += 1;
                    if (num(p.valuation?.estimatedValue ?? p.intel?.estimatedValue ?? p.avm ?? p.estimatedValue)) {
                        provider.provider_records_with_estimated_value += 1;
                    }
                    if (num(p.intel?.yearBuilt ?? p.building?.yearBuilt ?? p.yearBuilt)) provider.provider_records_with_year_built += 1;
                    if (num(p.building?.bedroomCount ?? p.building?.bedrooms ?? p.bedrooms)) provider.provider_records_with_beds += 1;
                    if (num(p.building?.bathroomCount ?? p.building?.bathrooms ?? p.bathrooms)) provider.provider_records_with_baths += 1;
                    if (num(
                        p.intel?.livingAreaSquareFeet ?? p.building?.livingAreaSquareFeet ??
                        p.building?.squareFeet ?? p.squareFootage
                    )) provider.provider_records_with_sqft += 1;
                    if (num(p.lot?.lotSizeSquareFeet ?? p.lot?.size ?? p.lotSize)) provider.provider_records_with_lot_size += 1;
                } catch { /* a malformed row still counts as reviewed */ }
            }
        },

        /** Called once per raw row, with the mapper's result (null when unmappable). */
        observeMapped(mapped) {
            if (!mapped) {
                outcomes.outside_polygon_or_invalid += 1;
                return;
            }
            enrichment.mapped_records_reviewed += 1;
            if (filled(mapped.sold_date)) enrichment.records_with_recorded_sale_date += 1;
            else enrichment.records_missing_recorded_sale_date += 1;
            if (filled(mapped.price)) enrichment.records_with_estimated_value += 1;
            else enrichment.records_missing_estimated_value += 1;
            if (filled(mapped.year_built)) enrichment.records_with_year_built += 1;
            if (filled(mapped.beds)) enrichment.records_with_beds += 1;
            if (filled(mapped.baths)) enrichment.records_with_baths += 1;
            if (filled(mapped.sqft)) enrichment.records_with_sqft += 1;
            if (filled(mapped.lot_size)) enrichment.records_with_lot_size += 1;

            if (mapped.route_active !== false) {
                outcomes.mapped_route_active_before_selection += 1;
                return;
            }
            switch (mapped.route_reject_reason) {
                case 'price': outcomes.rejected_price += 1; break;
                case 'land_use': outcomes.rejected_land_use += 1; break;
                case 'property_type': outcomes.rejected_property_type += 1; break;
                case 'custom_range_outside_date_window': outcomes.custom_range_outside_date_window += 1; break;
                case 'custom_range_missing_sale_date': outcomes.custom_range_missing_sale_date += 1; break;
                default: break;
            }
        },

        snapshot() {
            return {
                provider_fields: { ...provider },
                enrichment: { ...enrichment },
                route_outcomes: { ...outcomes }
            };
        }
    };
}

/** Sums the per-attempt ledgers so a job reports totals across every attempt. */
function mergeDiagnosticLedgers(attempts = []) {
    const empty = createDiagnosticLedger().snapshot();
    const total = {
        provider_fields: { ...empty.provider_fields },
        enrichment: { ...empty.enrichment },
        route_outcomes: { ...empty.route_outcomes }
    };
    for (const attempt of (Array.isArray(attempts) ? attempts : [])) {
        for (const block of ['provider_fields', 'enrichment', 'route_outcomes']) {
            const source = attempt?.[block];
            if (!source) continue;
            for (const key of Object.keys(total[block])) {
                total[block][key] += Number(source[key]) || 0;
            }
        }
    }
    return total;
}

function mapBatchDataProperty(record, job) {
    const p = record.property || record;
    const address = normalizeBatchDataAddress(p);
    if (!address.street || !address.zip || !Number.isFinite(address.lat) || !Number.isFinite(address.lng)) return null;
    if (!isPointInPolygon({ lat: address.lat, lng: address.lng }, job.polygon || [])) return null;

    const owner = p.owner || {};
    const quickLists = p.quickLists || p.quick_lists || {};
    const listing = p.listing || {};
    const intel = p.intel || {};
    const building = p.building || p.structure || p.propertyInfo || p.assessment?.building || p.assessor?.building || {};
    const sale = p.sale || p.lastSale || p.deed?.sale || p.transaction || {};
    const lastSale = sale.lastSale || sale.lastTransfer || sale;
    const valuation = p.valuation || p.avm || p.estimatedValue || p.assessment?.valuation || p.assessor?.valuation || {};
    const general = p.general || p.property || p.propertyInfo || {};
    const ids = p.ids || p.identifiers || {};
    const subdivisionName = normalizeSubdivisionName(
        p.subdivisionName,
        p.subdivision_name,
        typeof p.subdivision === 'string' ? p.subdivision : null,
        p.subdivision?.name,
        general.subdivisionName,
        general.subdivision_name,
        typeof general.subdivision === 'string' ? general.subdivision : null,
        general.subdivision?.name,
        record !== p ? record.subdivisionName : null,
        record !== p ? record.subdivision_name : null,
        record !== p && typeof record.subdivision === 'string' ? record.subdivision : null,
        record !== p ? record.subdivision?.name : null
    );
    const listingStatus = firstValue(listing.status, listing.statusCategory);
    const listingStatusLower = String(listingStatus || '').toLowerCase();
    const customOwnershipRange = getCustomOwnershipRange(job);
    const providerOwnershipDate = dateValue(
        intel.lastSoldDate,
        intel.lastSaleDate,
        intel.lastTransferDate,
        sale?.lastSoldDate,
        sale?.lastSaleDate,
        sale?.saleDate,
        p.lastSoldDate,
        p.soldDate,
        p.sold_date
    );
    const defaultSaleDate = dateValue(
        p.listing?.soldDate,
        p.deedHistory?.[0]?.saleDate,
        intel.lastSoldDate,
        intel.lastSaleDate,
        intel.lastTransferDate,
        sale?.lastSaleDate,
        sale?.recordingDate,
        sale?.saleDate,
        sale?.date,
        lastSale?.recordingDate,
        lastSale?.saleDate,
        lastSale?.date,
        p.lastSaleDate,
        p.sold_date,
        p.soldDate
    );
    // BatchData applies the custom acquisition filter to intel.lastSoldDate.
    // Use that same field for inclusion, persistence, and downstream SQL so a
    // stale listing date cannot change the requested ownership-age window.
    const saleDate = providerOwnershipDate || defaultSaleDate;
    const saleDateMs = saleDate ? new Date(saleDate).getTime() : 0;
    const hasValidSaleDate = saleDateMs > 0 && !Number.isNaN(saleDateMs);
    const saleDateOnly = isoDateOnly(saleDate);
    const cutoffDate = isoDateDaysAgo(ownershipLookbackDays(job), jobReferenceTimeMs(job));
    const isSoldInWindow = !!saleDateOnly && saleDateOnly >= cutoffDate;
    const customOwnershipBounds = customOwnershipRange ? ownershipDateBounds(job) : null;
    const isInCustomOwnershipRange = !customOwnershipBounds || (
        hasValidSaleDate &&
        !!saleDateOnly &&
        saleDateOnly >= customOwnershipBounds.oldestDate &&
        saleDateOnly <= customOwnershipBounds.newestDate
    );
    const ownerName = firstValue(owner.fullName, owner.name, owner.ownerName, owner.names?.[0]?.full, owner.names?.[0]?.name, owner.names?.[0]);
    const ownerOccupied = booleanValue(quickLists.ownerOccupied, quickLists.owner_occupied, owner.ownerOccupied);
    const corporateOwned = booleanValue(quickLists.corporateOwned, quickLists.corporate_owned, owner.corporateOwned);
    const investorOwned = booleanValue(quickLists.investorOwned, quickLists.investor_owned, owner.investorOwned);
    const assessment = p.assessment || p.assessor || p.tax || {};
    const saleAmount = numberValue(
        intel.lastSoldPrice,
        intel.lastSalePrice,
        intel.lastTransferPrice,
        sale?.amount,
        sale?.price,
        sale?.salePrice,
        lastSale?.amount,
        lastSale?.price,
        lastSale?.salePrice,
        p.lastSalePrice,
        p.lastSoldPrice,
        p.salePrice,
        p.price
    );
    const estimatedValue = numberValue(
        intel.estimatedValue, intel.estimatedMarketValue, intel.totalMarketValue, intel.propertyValue, intel.estValue,
        intel.avm, intel.avmValue, intel.value, intel.amount,
        valuation.estimatedValue, valuation.value, valuation.avm, valuation.avmValue, valuation.amount,
        assessment.totalValue, assessment.marketValue, assessment.assessedValue, assessment.totalMarketValue, assessment.market,
        p.estimatedValue, p.estimated_value, p.avm, p.avmValue, p.assessedValue, p.price,
        listing.price, listing.listPrice
    );
    const price = estimatedValue ?? saleAmount;
    const landUseCode = firstValue(general.standardizedLandUseCode, p.standardizedLandUseCode);
    const propertyType = firstValue(general.propertyTypeDetail, general.propertyType, p.propertyType, p.landUse, building.propertyType) || 'Single Family';
    // Single-family-only gate. BatchData's standardized R2 code is the
    // single-family residential bucket used by Precision route pulls.
    const nonResidential = /commercial|industrial|vacant|agricultural|land|daycare|day ?care|child ?care|church|school|office|retail|store|warehouse|hotel|motel|restaurant|medical|hospital|parking|exempt|government|condo|condominium|apartment|multi[- ]?family|multifamily|duplex|triplex|fourplex|townhouse|townhome|row ?house/i.test(String(propertyType));
    const landUseRejected = !!landUseCode && String(landUseCode).toUpperCase() !== 'R2';

    // ── Loosened BatchData gate ──────────────────────────────────────────
    // The paid BatchData request already asks for owner-change / last-sold records.
    // Do not reject neutral or incomplete rows locally just because a secondary
    // listing/sale field is blank or stale. Keep only hard safety exclusions here.
    // Price gate: enforce the user's home value range on records with a known price.
    // Unknown-price records pass (provider may omit valuation on some rows).
    const jobFilters = job.dry_run_metadata?.filters || {};
    const filterMinPrice = Number(jobFilters.min_price) > 0 ? Number(jobFilters.min_price) : null;
    const filterMaxPrice = Number(jobFilters.max_price) > 0 ? Number(jobFilters.max_price) : null;
    const priceKnown = Number.isFinite(Number(price)) && Number(price) > 0;
    const priceRejected = priceKnown && ((filterMinPrice !== null && Number(price) < filterMinPrice) || (filterMaxPrice !== null && Number(price) > filterMaxPrice));
    const rejected = nonResidential || landUseRejected || priceRejected;
    const routeActive = !rejected && isInCustomOwnershipRange;

    // Diagnostic only. Never persisted (the property INSERT names its columns
    // explicitly) and never used for eligibility — it exists so a zero-result
    // pull can be explained without guessing.
    const routeRejectReason = priceRejected ? 'price'
        : landUseRejected ? 'land_use'
        : nonResidential ? 'property_type'
        : isInCustomOwnershipRange ? null
        : hasValidSaleDate ? 'custom_range_outside_date_window'
        : 'custom_range_missing_sale_date';

    const match = address.street.match(/^(\d+)\s+(.*)$/);
    const houseNumber = match ? parseInt(match[1], 10) : 0;
    const streetName = match ? match[2] : address.street;

    return {
        address_hash: addressHash(address.street, address.zip),
        legacy_hash: firstValue(ids.propertyId, ids.id, p.id, p.propertyId) || null,
        house_number: houseNumber,
        street_name: streetName,
        subdivision_name: subdivisionName,
        full_address: [address.street, address.city, address.state, address.zip].filter(Boolean).join(', '),
        city: address.city,
        state: address.state,
        zip_code: address.zip,
        lat: address.lat,
        lng: address.lng,
        owner_full_name: ownerName || null,
        owner_occupied: ownerOccupied,
        corporate_owned: corporateOwned,
        investor_owned: investorOwned,
        beds: numberValue(building.bedroomCount, building.bedrooms, building.beds, building.rooms?.beds, p.bedrooms, p.beds),
        baths: numberValue(building.bathroomCount, building.bathrooms, building.baths, building.rooms?.baths, p.bathrooms, p.baths),
        sqft: numberValue(
            intel.livingAreaSquareFeet, intel.totalBuildingAreaSquareFeet, intel.buildingSquareFeet, intel.squareFeet,
            intel.sqft, intel.livingArea, intel.buildingSqft,
            building.livingAreaSquareFeet, building.livingArea, building.squareFeet,
            building.totalBuildingAreaSquareFeet, building.totalAreaSqFt, building.area,
            p.squareFootage, p.sqft, p.livingAreaSquareFeet
        ),
        lot_size: numberValue(p.lot?.size, p.lot?.lotSizeSquareFeet, p.lotSize, p.lot_size, p.lotSizeSquareFeet),
        year_built: numberValue(intel.yearBuilt, intel.effectiveYearBuilt, intel.buildYear, intel.year_built, building.yearBuilt, building.effectiveYearBuilt, p.yearBuilt, p.year_built),
        price: price ?? null,
        sold_date: saleDate || null,
        sale_type: 'BatchData',
        property_type: propertyType,
        data_source: 'batchdata',
        sale_confidence: rejected ? 'REJECTED' : 'verified',
        original_status: rejected ? 'REJECTED' : 'BATCHDATA_CONFIRMED',
        route_active: routeActive,
        route_reject_reason: routeRejectReason,
        // Retain a deliberately minimized audit snapshot instead of the full
        // provider object, which can grow to include sensitive add-on fields.
        raw_payload: JSON.stringify({
            schema_version: 1,
            provider: 'batchdata',
            property_id: firstValue(ids.propertyId, ids.id, p.id, p.propertyId) || null,
            address: {
                street: address.street,
                city: address.city,
                state: address.state,
                zip: address.zip,
                lat: address.lat,
                lng: address.lng
            },
            owner: {
                full_name: ownerName || null,
                owner_occupied: ownerOccupied,
                corporate_owned: corporateOwned,
                investor_owned: investorOwned
            },
            property: {
                property_type: propertyType,
                subdivision_name: subdivisionName,
                standardized_land_use_code: landUseCode || null,
                beds: numberValue(building.bedroomCount, building.bedrooms, building.beds, building.rooms?.beds, p.bedrooms, p.beds),
                baths: numberValue(building.bathroomCount, building.bathrooms, building.baths, building.rooms?.baths, p.bathrooms, p.baths),
                estimated_value: price ?? null,
                year_built: numberValue(intel.yearBuilt, intel.effectiveYearBuilt, intel.buildYear, intel.year_built, building.yearBuilt, building.effectiveYearBuilt, p.yearBuilt, p.year_built)
            },
            sale: {
                date: saleDate || null,
                amount: saleAmount ?? null
            }
        })
    };
}

function toNullableDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date.toISOString();
}

function withSubdivisionInRawPayload(rawPayload, subdivisionName) {
    const normalized = normalizeSubdivisionName(subdivisionName);
    if (!normalized) return rawPayload;

    try {
        const parsed = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rawPayload;
        const property = parsed.property && typeof parsed.property === 'object' && !Array.isArray(parsed.property)
            ? parsed.property
            : {};
        return JSON.stringify({
            ...parsed,
            property: {
                ...property,
                subdivision_name: normalized
            }
        });
    } catch {
        return rawPayload;
    }
}

async function writePropertiesToNeon(sql, properties, job, excludedRouteHashes = new Set()) {
    let inserted = 0, existed = 0, updated = 0;
    const customOwnershipRange = getCustomOwnershipRange(job);

    for (const p of properties) {
        const isInSavedRoute = excludedRouteHashes.has(p.address_hash);
        const existingRows = await sql`
            SELECT
                p.id,
                p.sold_date,
                p.sale_confidence,
                p.original_status,
                COALESCE(
                    p.raw_payload -> 'property' ->> 'subdivision_name',
                    p.raw_payload ->> 'subdivision_name',
                    p.raw_payload ->> 'subdivisionName',
                    to_jsonb(p) ->> 'subdivision_name'
                ) AS existing_subdivision_name,
                p.owner_full_name,
                p.owner_occupied,
                p.corporate_owned,
                p.investor_owned,
                p.beds,
                p.baths,
                p.sqft,
                p.lot_size,
                p.year_built,
                p.price
            FROM properties p
            WHERE p.address_hash = ${p.address_hash}
            LIMIT 1
        `;
        const soldDate = toNullableDate(p.sold_date);
        const rawPayload = p.raw_payload || JSON.stringify(p);

        if (existingRows.length === 0) {
            const created = await sql`
                INSERT INTO properties (
                    address_hash, legacy_hash, full_address, house_number, street_name, city, state, zip_code,
                    lat, lng, owner_full_name, owner_occupied, corporate_owned, investor_owned, beds, baths, sqft, lot_size, year_built, price,
                    sold_date, sale_type, property_type, data_source, sale_confidence, original_status, raw_payload, updated_at
                ) VALUES (
                    ${p.address_hash}, ${p.legacy_hash}, ${p.full_address}, ${p.house_number || null}, ${p.street_name || null},
                    ${p.city || null}, ${p.state || null}, ${p.zip_code || null}, ${p.lat}, ${p.lng}, ${p.owner_full_name || null},
                    ${p.owner_occupied}, ${p.corporate_owned}, ${p.investor_owned},
                    ${p.beds || null}, ${p.baths || null}, ${p.sqft || null}, ${p.lot_size || null}, ${p.year_built || null},
                    ${p.price || null}, ${soldDate}, ${p.sale_type}, ${p.property_type}, ${p.data_source}, ${p.sale_confidence},
                    ${p.original_status}, ${rawPayload}, NOW()
                ) RETURNING id
            `;
            await sql`
                INSERT INTO workspace_properties (property_id, user_email, fetch_job_id, route_active, status, updated_at)
                VALUES (${created[0].id}, ${job.user_email || 'unknown'}, ${job.id}, ${p.route_active !== false}, ${p.original_status}, NOW())
                ON CONFLICT (property_id, user_email)
                DO UPDATE SET
                    fetch_job_id = CASE WHEN ${isInSavedRoute} THEN workspace_properties.fetch_job_id ELSE EXCLUDED.fetch_job_id END,
                    route_active = EXCLUDED.route_active,
                    status = EXCLUDED.status,
                    updated_at = NOW()
            `;
            inserted++;
            continue;
        }

        const existing = existingRows[0];
        existed++;
        const existingDate = existing.sold_date ? new Date(existing.sold_date).getTime() : 0;
        const incomingDate = soldDate ? new Date(soldDate).getTime() : 0;
        const existingSubdivisionName = normalizeSubdivisionName(existing.existing_subdivision_name);
        const updateRawPayload = withSubdivisionInRawPayload(
            rawPayload,
            p.subdivision_name || existingSubdivisionName
        );
        const mustPersistCustomSoldDate = !!customOwnershipRange && incomingDate > 0 && incomingDate !== existingDate;
        const hasNewMetadata =
            (!existingSubdivisionName && p.subdivision_name) ||
            (!existing.owner_full_name && p.owner_full_name) ||
            (p.owner_occupied !== null && p.owner_occupied !== existing.owner_occupied) ||
            (p.corporate_owned !== null && p.corporate_owned !== existing.corporate_owned) ||
            (p.investor_owned !== null && p.investor_owned !== existing.investor_owned) ||
            (!existing.beds && p.beds) ||
            (!existing.baths && p.baths) ||
            (!existing.sqft && p.sqft) ||
            (!existing.lot_size && p.lot_size) ||
            (!existing.year_built && p.year_built) ||
            (!existing.price && p.price);
        const shouldUpdate = mustPersistCustomSoldDate || incomingDate > existingDate || hasNewMetadata || p.sale_confidence !== existing.sale_confidence || p.original_status !== existing.original_status;

        if (shouldUpdate) {
            await sql`
                UPDATE properties SET
                    legacy_hash = COALESCE(${p.legacy_hash}, legacy_hash), full_address = COALESCE(${p.full_address}, full_address),
                    house_number = COALESCE(${p.house_number || null}, house_number), street_name = COALESCE(${p.street_name || null}, street_name),
                    city = COALESCE(${p.city || null}, city), state = COALESCE(${p.state || null}, state), zip_code = COALESCE(${p.zip_code || null}, zip_code),
                    lat = COALESCE(${p.lat}, lat), lng = COALESCE(${p.lng}, lng), owner_full_name = COALESCE(${p.owner_full_name || null}, owner_full_name),
                    owner_occupied = COALESCE(${p.owner_occupied}, owner_occupied), corporate_owned = COALESCE(${p.corporate_owned}, corporate_owned),
                    investor_owned = COALESCE(${p.investor_owned}, investor_owned),
                    beds = COALESCE(${p.beds || null}, beds), baths = COALESCE(${p.baths || null}, baths), sqft = COALESCE(${p.sqft || null}, sqft),
                    lot_size = COALESCE(${p.lot_size || null}, lot_size), year_built = COALESCE(${p.year_built || null}, year_built), price = COALESCE(${p.price || null}, price),
                    sold_date = COALESCE(${soldDate}, sold_date), sale_type = COALESCE(${p.sale_type}, sale_type), property_type = COALESCE(${p.property_type}, property_type),
                    data_source = ${p.data_source}, sale_confidence = ${p.sale_confidence}, original_status = ${p.original_status}, raw_payload = ${updateRawPayload}, updated_at = NOW()
                WHERE id = ${existing.id}
            `;
            updated++;
        }

        await sql`
            INSERT INTO workspace_properties (property_id, user_email, fetch_job_id, route_active, status, updated_at)
            VALUES (${existing.id}, ${job.user_email || 'unknown'}, ${job.id}, ${p.route_active !== false}, ${p.original_status}, NOW())
            ON CONFLICT (property_id, user_email)
            DO UPDATE SET
                fetch_job_id = CASE WHEN ${isInSavedRoute} THEN workspace_properties.fetch_job_id ELSE EXCLUDED.fetch_job_id END,
                route_active = EXCLUDED.route_active,
                status = EXCLUDED.status,
                updated_at = NOW()
        `;
    }

    if (properties.length > 0) {
        await sql`
            INSERT INTO ingestion_metrics (fetch_job_id, user_email, records_inserted, records_updated, records_skipped)
            VALUES (${job.id}, ${job.user_email || 'unknown'}, ${inserted}, ${updated}, ${existed})
        `.catch(() => {});
    }

    return { inserted, existed, updated };
}

function getExcludedRouteHashes(job) {
    const hashes = job?.dry_run_metadata?.excluded_route_hashes;
    return new Set((Array.isArray(hashes) ? hashes : []).map(hash => String(hash)).filter(Boolean));
}

async function batchDataFetchWithRetry(requestBody) {
    for (let attempt = 1; attempt <= 4; attempt++) {
        let response;
        try {
            response = await fetchWithTimeout(BATCHDATA_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BATCHDATA_API_KEY}` },
                body: JSON.stringify(requestBody)
            });
        } catch (error) {
            if (attempt < 2) {
                await sleep(1000);
                continue;
            }
            throw new Error(`BatchData request failed before response: ${error.message}`);
        }
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw_text: text.slice(0, 1000) }; }

        if (response.ok) return payload;
        if (response.status === 401) throw new Error('Authentication failed. Verify the BatchData API token is correct and active.');
        if (response.status === 400) throw new Error(`BatchData rejected the polygon search request: ${text.slice(0, 1000)}`);
        if (response.status === 429 && attempt < 4) {
            await sleep(2 ** attempt * 1000);
            continue;
        }
        if ((response.status === 500 || response.status === 503) && attempt < 2) {
            await sleep(5000);
            continue;
        }
        throw new Error(`BatchData request failed (${response.status}): ${text.slice(0, 1000)}`);
    }
    throw new Error('Rate limit exceeded after 3 retries.');
}

async function fetchBatchDataRecordsForMode(job, mode, requested, onProgress = null, startSkip = 0, budgetMs = CHUNK_SCAN_BUDGET_MS) {
    const selected = [];
    const selectedHashes = new Set();
    const excludedRouteHashes = getExcludedRouteHashes(job);
    const routeTypeFilters = getRouteTypeFilters(job);
    const rejectedSamples = [];
    const pageTimings = [];
    // Diagnostics accumulate HERE, while every provider row is still in hand.
    // Computing them at completion is wrong: a custom-range job that selects
    // nothing returns records: [], and the non-custom path returns at most a
    // capped rejected sample, so both would under-report.
    const ledger = createDiagnosticLedger();
    let skip = Math.max(0, Number(startSkip) || 0);
    let reviewed = 0;
    let totalRecordCount = null;
    let skippedExistingRoute = 0;
    let skippedDuplicate = 0;
    let skippedRouteType = 0;
    const skippedRouteTypeBreakdown = {};
    // There is no scan ceiling any more: "max available" means keep paging the
    // provider until it runs out. A single invocation cannot page 24k records
    // inside the request budget, so each invocation scans for `budgetMs`, then
    // the caller persists `next_skip` and chains another invocation.
    let providerExhausted = false;
    const deadline = Date.now() + Math.max(5000, Number(budgetMs) || CHUNK_SCAN_BUDGET_MS);

    while (selected.length < requested && !providerExhausted && Date.now() < deadline) {
        const take = BATCHDATA_MAX_TAKE;
        const maxReviewed = null;
        const requestBody = buildBatchDataRequest(job, skip, take, mode);
        if (typeof onProgress === 'function') {
            await onProgress({
                event: 'page_start',
                mode,
                requested,
                reviewed,
                selected: selected.length,
                maxReviewed,
                totalRecordCount,
                skipped_existing_route: skippedExistingRoute,
                skipped_duplicate: skippedDuplicate,
                skip,
                take
            }).catch(() => {});
        }
        const pageStartedAt = Date.now();
        const payload = await batchDataFetchWithRetry(requestBody);
        const list = extractBatchDataRecords(payload);
        const pageElapsedMs = Date.now() - pageStartedAt;
        pageTimings.push({ skip, take, returned: list.length, elapsed_ms: pageElapsedMs });
        if (totalRecordCount === null) totalRecordCount = extractBatchDataTotal(payload);
        reviewed += list.length;
        ledger.observeProviderPage(list);

        for (const raw of list) {
            const mapped = mapBatchDataProperty(raw, job);
            ledger.observeMapped(mapped);
            if (mapped && mapped.route_active !== false) {
                if (excludedRouteHashes.has(mapped.address_hash)) {
                    skippedExistingRoute++;
                    continue;
                }
                if (selectedHashes.has(mapped.address_hash)) {
                    skippedDuplicate++;
                    continue;
                }
                const typeEligibility = routeTypeEligibility(mapped, routeTypeFilters);
                if (!typeEligibility.eligible) {
                    skippedRouteType++;
                    skippedRouteTypeBreakdown[typeEligibility.reason] = (skippedRouteTypeBreakdown[typeEligibility.reason] || 0) + 1;
                    continue;
                }
                selectedHashes.add(mapped.address_hash);
                selected.push(raw);
                if (selected.length >= requested) break;
            } else if (rejectedSamples.length < Math.min(10, Math.max(requested, 2))) {
                rejectedSamples.push(raw);
            }
        }

        if (typeof onProgress === 'function') {
            await onProgress({
                event: 'page_complete',
                mode,
                requested,
                reviewed,
                selected: selected.length,
                maxReviewed,
                totalRecordCount,
                skipped_existing_route: skippedExistingRoute,
                skipped_duplicate: skippedDuplicate,
                skipped_route_type: skippedRouteType,
                skip,
                take,
                page_elapsed_ms: pageElapsedMs
            }).catch(() => {});
        }

        if (list.length < take) providerExhausted = true;
        else if (totalRecordCount !== null && skip + list.length >= totalRecordCount) providerExhausted = true;
        // Always advance past the page just reviewed, even when the target was
        // met mid-page: a resumed chunk must never re-request the same offset.
        skip += take;
    }

    const budgetExhausted = selected.length < requested && !providerExhausted;

    return {
        // Custom date mismatches are job-scoped, not a reason to deactivate an
        // otherwise valid workspace property. Keep samples for diagnostics, but
        // do not persist them when the exact custom window found no matches.
        records: selected.length > 0
            ? selected.slice(0, requested)
            : (getCustomOwnershipRange(job) ? [] : rejectedSamples),
        reviewed,
        active: selected.length,
        rejected_samples: rejectedSamples.length,
        skipped_existing_route: skippedExistingRoute,
        skipped_duplicate: skippedDuplicate,
        skipped_route_type: skippedRouteType,
        skipped_route_type_breakdown: skippedRouteTypeBreakdown,
        next_skip: skip,
        provider_exhausted: providerExhausted,
        budget_exhausted: budgetExhausted,
        scan_limit_reached: false,
        page_timings: pageTimings,
        totalRecordCount,
        ...ledger.snapshot()
    };
}

function requestedPropertyTarget(job) {
    // Uncapped on purpose: a "max available" pull passes its full allowance and
    // must keep paging until the provider has nothing left inside the area.
    return Math.max(1, Math.floor(Number(job.estimated_record_count || job.total_expected || 1000)));
}

async function fetchBatchDataRecords(job, onProgress = null, options = {}) {
    const target = Number.isFinite(Number(options.requested))
        ? Math.max(1, Math.floor(Number(options.requested)))
        : requestedPropertyTarget(job);
    const requested = Math.min(target, CHUNK_MAX_SELECTED);
    const startSkip = Math.max(0, Number(options.startSkip) || 0);
    const budgetMs = Number(options.budgetMs) || CHUNK_SCAN_BUDGET_MS;
    const modes = ['broad_polygon'];
    const attempts = [];
    let fallback = [];
    let fallbackMode = 'none';
    let fallbackActive = 0;

    for (const mode of modes) {
        const result = await fetchBatchDataRecordsForMode(job, mode, requested, onProgress, startSkip, budgetMs);
        attempts.push({ mode, count: result.records.length, reviewed: result.reviewed, active: result.active, rejected_samples: result.rejected_samples, skipped_existing_route: result.skipped_existing_route, skipped_duplicate: result.skipped_duplicate, skipped_route_type: result.skipped_route_type, skipped_route_type_breakdown: result.skipped_route_type_breakdown, next_skip: result.next_skip, provider_exhausted: result.provider_exhausted, budget_exhausted: result.budget_exhausted, scan_limit_reached: result.scan_limit_reached, page_timings: result.page_timings, total: result.totalRecordCount, provider_fields: result.provider_fields, enrichment: result.enrichment, route_outcomes: result.route_outcomes });
        if (result.active >= requested) return { records: result.records, attempts, mode_used: mode };
        if (result.active > fallbackActive || (fallback.length === 0 && result.records.length > 0)) {
            fallback = result.records;
            fallbackMode = mode;
            fallbackActive = result.active;
        }
    }

    return { records: fallback, attempts, mode_used: fallback.length > 0 ? fallbackMode : 'none' };
}

Deno.serve(async (req) => {
    let base44 = null;
    let lockId = null;
    let targetJobId = null;
    let liveJobClaimed = false;
    try {
        base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({}));
        targetJobId = body.job_id ? String(body.job_id) : null;

        if (body.self_test === true) {
            return Response.json({ success: true, active_provider: 'batchdata', rentcast_active: false, batchdata_polygon_search: true, dataset_scope: observedDatasetScope(), has_batchdata_key: !!BATCHDATA_API_KEY, has_database_url: !!DATABASE_URL });
        }

        if (body.request_preview === true) {
            const previewJob = preparePreviewJobOwnership(body.job || {
                polygon: body.polygon || [
                    { lat: 33.4622, lng: -112.1866 },
                    { lat: 33.3493, lng: -112.1915 },
                    { lat: 33.2931, lng: -112.1338 }
                ],
                latitude: body.latitude || 33.37,
                longitude: body.longitude || -112.08,
                sold_months: body.sold_months || 12,
                dry_run_metadata: { filters: { min_price: body.min_price ?? 100000, max_price: body.max_price ?? null } }
            }, body);
            return Response.json({
                success: true,
                sold_months: previewJob.sold_months,
                ...ownershipResponseFields(previewJob),
                requests: {
                    strict_polygon: buildBatchDataRequest(previewJob, 0, BATCHDATA_MAX_TAKE, 'strict_polygon'),
                    broad_polygon: buildBatchDataRequest(previewJob, 0, BATCHDATA_MAX_TAKE, 'broad_polygon')
                }
            });
        }

        if (body.map_preview === true) {
            const previewJob = preparePreviewJobOwnership(body.job || {
                polygon: body.polygon || [],
                sold_months: body.sold_months || 12,
                dry_run_metadata: { filters: { min_price: body.min_price ?? 100000, max_price: body.max_price ?? null } }
            }, body);
            const records = Array.isArray(body.synthetic_records) ? body.synthetic_records : [];
            const mapped = records.map(record => mapBatchDataProperty(record, previewJob)).filter(Boolean);
            return Response.json({ success: true, sold_months: previewJob.sold_months, ...ownershipResponseFields(previewJob), raw: records.length, mapped: mapped.length, active: mapped.filter(p => p.route_active !== false).length, properties: mapped });
        }

        if (body.fetch_preview === true) {
            if (!isDiagnosticRequest(req)) {
                return Response.json({ error: 'Admin access is required for live provider previews.' }, { status: 403 });
            }
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            const previewJob = preparePreviewJobOwnership(body.job || {
                polygon: body.polygon || [],
                latitude: body.latitude || 33.37,
                longitude: body.longitude || -112.08,
                sold_months: body.sold_months || 12,
                estimated_record_count: body.requested_properties || 2,
                total_expected: body.requested_properties || 2,
                dry_run_metadata: { filters: { min_price: body.min_price ?? 100000, max_price: body.max_price ?? null } }
            }, body);
            const batchFetch = await fetchBatchDataRecords(previewJob);
            const mapped = batchFetch.records.map(record => mapBatchDataProperty(record, previewJob)).filter(Boolean);
            return Response.json({ success: true, sold_months: previewJob.sold_months, ...ownershipResponseFields(previewJob), mode_used: batchFetch.mode_used, attempts: batchFetch.attempts, raw: batchFetch.records.length, mapped: mapped.length, active: mapped.filter(p => p.route_active !== false).length });
        }

        if (body.raw_probe === true) {
            if (!isDiagnosticRequest(req)) {
                return Response.json({ error: 'Admin access is required for raw provider probes.' }, { status: 403 });
            }
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            let previewJob = body.job || null;
            if (!previewJob && body.job_id) {
                previewJob = await base44.asServiceRole.entities.FetchJob.get(body.job_id);
            }
            if (!previewJob) {
                previewJob = {
                    polygon: body.polygon || [],
                    latitude: body.latitude || 33.37,
                    longitude: body.longitude || -112.08,
                    sold_months: body.sold_months || 12,
                    dry_run_metadata: { filters: { min_price: body.min_price ?? 100000, max_price: body.max_price ?? null } }
                };
            }
            previewJob = preparePreviewJobOwnership(previewJob, body);
            const take = Math.min(Math.max(Number(body.take) || 10, 1), 10);
            const probes = [
                { label: 'strict_exact_date', mode: 'strict_polygon', omitSoldDate: false },
                { label: 'broad_exact_date', mode: 'broad_polygon', omitSoldDate: false },
                { label: 'broad_no_sold_date', mode: 'broad_polygon', omitSoldDate: true }
            ];
            const results = [];
            for (const probe of probes) {
                const requestBody = buildBatchDataRequest(previewJob, 0, take, probe.mode);
                if (probe.omitSoldDate) delete requestBody.searchCriteria.intel;
                const payload = await batchDataFetchWithRetry(requestBody);
                const records = extractBatchDataRecords(payload);
                const mapped = records.map(record => mapBatchDataProperty(record, previewJob)).filter(Boolean);
                const samples = records.slice(0, 3).map((record) => {
                    const p = record.property || record;
                    const mappedProperty = mapBatchDataProperty(record, previewJob);
                    return {
                        address: firstValue(p.formattedAddress, p.address?.street, p.address?.streetAddress, p.addressLine1),
                        listing_status: firstValue(p.listing?.status, p.listing?.statusCategory),
                        listing_sold_date: p.listing?.soldDate,
                        intel_last_sold_date: p.intel?.lastSoldDate,
                        intel_last_sold_price: p.intel?.lastSoldPrice,
                        sale_last_sale_date: firstValue(p.sale?.lastSaleDate, p.sale?.saleDate, p.lastSaleDate),
                        sale_amount: firstValue(p.sale?.amount, p.sale?.price, p.sale?.salePrice, p.intel?.lastSoldPrice),
                        land_use: firstValue(p.general?.standardizedLandUseCode, p.standardizedLandUseCode),
                        mapped_active: mappedProperty?.route_active === true,
                        mapped_status: mappedProperty?.original_status || null,
                        mapped_sold_date: mappedProperty?.sold_date || null
                    };
                });
                results.push({
                    label: probe.label,
                    request: requestBody,
                    raw: records.length,
                    total: extractBatchDataTotal(payload),
                    mapped: mapped.length,
                    active: mapped.filter(p => p.route_active !== false).length,
                    samples
                });
            }
            return Response.json({ success: true, job_id: previewJob.id || null, sold_months: previewJob.sold_months, ...ownershipResponseFields(previewJob), results });
        }


        if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
        if (!DATABASE_URL) throw new Error('DATABASE_URL is not configured');

        if (!targetJobId) {
            return Response.json({ error: 'job_id is required for live processing.' }, { status: 400 });
        }
        let job = await base44.asServiceRole.entities.FetchJob.get(targetJobId).catch(() => null);
        if (!job) return Response.json({ error: 'Job not found', job_id: targetJobId }, { status: 404 });
        const expectedProcessorToken = String(job.dry_run_metadata?.processor_token || '');
        const receivedProcessorToken = String(body.processor_token || '');
        if (!expectedProcessorToken || receivedProcessorToken !== expectedProcessorToken) {
            return Response.json({ error: 'Not authorized to process this job.' }, { status: 403 });
        }
        if (Array.isArray(body.synthetic_records) && !isDiagnosticRequest(req)) {
            return Response.json({ error: 'Admin access is required for synthetic ingestion.' }, { status: 403 });
        }
        if (targetJobId && !cancellationRequested(job) && !['pending', 'running'].includes(job.status)) {
            return Response.json({ skipped: true, reason: `job_${job.status || 'inactive'}`, job_id: job.id, status: job.status });
        }

        const expectedChunk = body.expected_chunk ?? null;
        if (expectedChunk !== null && (job.chunk_number || 0) !== expectedChunk) {
            return Response.json({ skipped: true, reason: 'duplicate_invocation', job_id: job.id });
        }

        const claim = await claimPipelineLock(base44, job.id, crypto.randomUUID());
        if (!claim.claimed) return Response.json({ skipped: true, reason: claim.reason, job_id: job.id });
        lockId = claim.lockId;
        liveJobClaimed = true;

        // Re-read after obtaining the processor lease. A cancel can race the
        // initial request, and only the lease holder may release its reservation.
        job = await base44.asServiceRole.entities.FetchJob.get(targetJobId).catch(() => null);
        if (!job) throw new Error(`FetchJob ${targetJobId} disappeared after the processor lease was claimed.`);
        if (cancellationRequested(job)) {
            const completedAt = new Date().toISOString();
            const settledUsageCount = await settleCancelledPrecisionUsage(
                base44,
                job,
                completedAt,
                'Cancellation observed after claiming the processor lease.'
            );
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({ success: true, status: 'cancelled', job_id: job.id, active: settledUsageCount });
        }
        if (!['pending', 'running'].includes(job.status)) {
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({ skipped: true, reason: `job_${job.status || 'inactive'}`, job_id: job.id, status: job.status });
        }

        const startedAt = job.started_at || new Date().toISOString();
        await base44.asServiceRole.entities.FetchJob.update(job.id, {
            status: 'running',
            started_at: startedAt,
            provider: 'batchdata',
            mode_tag: 'PRECISION_TARGET',
            phase: 'batchdata_precision',
            progress_pct: Math.max(job.progress_pct || 0, 5)
        });

        const sql = neon(DATABASE_URL);
        let lastProgressUpdateAt = 0;
        let lastProgressPct = Math.max(job.progress_pct || 0, 5);
        const requestedProgressCount = Math.max(Number(job.total_expected || job.estimated_record_count || 0) || 1, 1);
        const updateScanProgress = async (progress) => {
            const now = Date.now();
            const isPageStart = progress.event === 'page_start';
            const reviewed = Number(progress.reviewed) || 0;
            const foundRatio = Math.min(1, (Number(progress.selected) || 0) / requestedProgressCount);
            const scanDenominator = Math.max(1, Number(progress.totalRecordCount || progress.maxReviewed || 1));
            const scanRatio = Math.min(1, reviewed / scanDenominator);
            const nextPct = isPageStart
                ? Math.min(82, Math.max(lastProgressPct, 8))
                : Math.min(82, Math.max(lastProgressPct, 8 + Math.round(Math.max(foundRatio, scanRatio) * 72)));
            if (!isPageStart && now - lastProgressUpdateAt < BATCHDATA_PROGRESS_UPDATE_MS && nextPct === lastProgressPct) return;
            lastProgressUpdateAt = now;
            lastProgressPct = nextPct;
            const update = {
                phase: isPageStart ? 'batchdata_requesting' : 'batchdata_scanning',
                progress_pct: nextPct,
                total_fetched: reviewed,
                ...(Number.isFinite(Number(progress.skip)) ? { current_offset: Number(progress.skip) } : {})
            };
            await base44.asServiceRole.entities.FetchJob.update(job.id, update).catch(() => {});
        };
        // Resume where the previous chunk stopped, and only ask for the records
        // still missing from the target so a chained pull cannot overshoot.
        const requestedTarget = requestedPropertyTarget(job);
        const deliveredBefore = await countPersistedPrecisionProperties(job.id).catch(() => 0);
        const remainingTarget = Math.max(1, requestedTarget - deliveredBefore);
        const resumeSkip = Math.max(0, Number(job.current_offset) || 0);
        const batchFetch = Array.isArray(body.synthetic_records)
            ? { records: body.synthetic_records, attempts: [{ mode: 'synthetic_records', count: body.synthetic_records.length }], mode_used: 'synthetic_records' }
            : await fetchBatchDataRecords(job, updateScanProgress, { requested: remainingTarget, startSkip: resumeSkip });
        const rawRecords = batchFetch.records;
        const seen = new Set();
        const excludedRouteHashes = getExcludedRouteHashes(job);
        const routeTypeFilters = getRouteTypeFilters(job);
        const mapped = [];
        let rejected = 0;
        let outsideOrInvalid = 0;
        let skippedExistingRoute = 0;
        let skippedRouteType = 0;
        const skippedRouteTypeBreakdown = {};
        const zipCodes = [...(job.zip_codes_found || [])];

        for (const raw of rawRecords) {
            const property = mapBatchDataProperty(raw, job);
            if (!property) { outsideOrInvalid++; continue; }
            if (seen.has(property.address_hash)) continue;
            seen.add(property.address_hash);
            if (excludedRouteHashes.has(property.address_hash)) {
                skippedExistingRoute++;
                continue;
            }
            const typeEligibility = routeTypeEligibility(property, routeTypeFilters);
            if (!typeEligibility.eligible) {
                skippedRouteType++;
                skippedRouteTypeBreakdown[typeEligibility.reason] = (skippedRouteTypeBreakdown[typeEligibility.reason] || 0) + 1;
                continue;
            }
            if (property.zip_code && !zipCodes.includes(property.zip_code)) zipCodes.push(property.zip_code);
            if (property.route_active === false) rejected++;
            mapped.push(property);
        }

        const beforeWriteJob = await base44.asServiceRole.entities.FetchJob.get(job.id);
        if (cancellationRequested(beforeWriteJob)) {
            const cancelledAt = new Date().toISOString();
            const settledUsageCount = await settleCancelledPrecisionUsage(
                base44,
                beforeWriteJob,
                cancelledAt,
                'Cancellation observed before the Neon write; no fetched properties were added.'
            );
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({ success: true, status: 'cancelled', job_id: job.id, active: settledUsageCount });
        }

        const result = await writePropertiesToNeon(sql, mapped, job, excludedRouteHashes);
        const completedAt = new Date().toISOString();
        const activeCount = mapped.filter(p => p.route_active !== false).length;
        const requestedCount = Number(job.total_expected || job.estimated_record_count || 0) || 0;
        const reviewedCount = (batchFetch.attempts || []).reduce((sum, attempt) => sum + (Number(attempt.reviewed) || 0), 0);
        const skippedExistingRouteFromFetch = (batchFetch.attempts || []).reduce((sum, attempt) => sum + (Number(attempt.skipped_existing_route) || 0), 0);
        const skippedDuplicateFromFetch = (batchFetch.attempts || []).reduce((sum, attempt) => sum + (Number(attempt.skipped_duplicate) || 0), 0);
        const skippedRouteTypeFromFetch = (batchFetch.attempts || []).reduce((sum, attempt) => sum + (Number(attempt.skipped_route_type) || 0), 0);
        const totalSkippedExistingRoute = skippedExistingRouteFromFetch + skippedExistingRoute;
        const totalSkippedRouteType = skippedRouteTypeFromFetch + skippedRouteType;
        const skippedRouteTypeBreakdownTotal = (batchFetch.attempts || []).reduce((acc, attempt) => {
            const breakdown = attempt.skipped_route_type_breakdown || {};
            for (const [reason, count] of Object.entries(breakdown)) {
                acc[reason] = (acc[reason] || 0) + (Number(count) || 0);
            }
            return acc;
        }, {});
        for (const [reason, count] of Object.entries(skippedRouteTypeBreakdown)) {
            skippedRouteTypeBreakdownTotal[reason] = (skippedRouteTypeBreakdownTotal[reason] || 0) + count;
        }
        const providerTotal = (batchFetch.attempts || [])
            .map(attempt => attempt.total)
            .find(total => total !== null && total !== undefined && Number.isFinite(Number(total)));
        const batchDataApiCalls = Array.isArray(body.synthetic_records)
            ? 0
            : (batchFetch.attempts || []).reduce(
                (sum, attempt) => sum + (Array.isArray(attempt.page_timings) ? attempt.page_timings.length : 0),
                0
            );
        const scanLimitReached = (batchFetch.attempts || []).some(attempt => attempt.scan_limit_reached === true);
        const completionReason = activeCount >= requestedCount
            ? 'target_met'
            : scanLimitReached
                ? 'custom_range_scan_limit_reached'
            : totalSkippedExistingRoute > 0
                ? 'insufficient_new_homes_after_existing_routes'
                : totalSkippedRouteType > 0
                    ? 'insufficient_homes_after_property_type_filters'
            : rawRecords.length === 0 && reviewedCount === 0
                ? 'no_provider_matches'
                : 'insufficient_qualifying_homes';
        const batchdataSummary = {
            mode_used: batchFetch.mode_used,
            attempts: batchFetch.attempts,
            requested: requestedCount,
            reviewed: reviewedCount || rawRecords.length,
            provider_total: providerTotal !== undefined ? Number(providerTotal) : null,
            raw: rawRecords.length,
            mapped: mapped.length,
            active: activeCount,
            rejected,
            outside_or_invalid: outsideOrInvalid,
            skipped_existing_route: totalSkippedExistingRoute,
            skipped_duplicate: skippedDuplicateFromFetch,
            skipped_route_type: totalSkippedRouteType,
            skipped_route_type_breakdown: skippedRouteTypeBreakdownTotal,
            api_calls: batchDataApiCalls,
            scan_limit_reached: scanLimitReached,
            // Aggregate counts only. Together these answer, for any pull:
            // N provider records returned -> how many carried sale evidence ->
            // how many mapped -> how many became route-active, and why the rest
            // did not. No payloads, addresses or owner names are retained.
            dataset_scope: observedDatasetScope(),
            // Sourced from the fetch loop, NOT from batchFetch.records. The
            // returned records are already filtered — and are empty for a
            // custom-range job that selected nothing — so recomputing here
            // would report zero rows for a job that reviewed dozens.
            ...mergeDiagnosticLedgers(batchFetch.attempts),
            final_selected_records: mapped.length,
            persisted_route_active_records: activeCount
        };
        const errorLog = [...(job.error_log || []), `[${completedAt}] BatchData-only Precision complete: mode=${batchFetch.mode_used}, attempts=${JSON.stringify(batchFetch.attempts)}, raw=${rawRecords.length}, mapped=${mapped.length}, active=${activeCount}, rejected=${rejected}, outside_or_invalid=${outsideOrInvalid}, skipped_existing_route=${totalSkippedExistingRoute}, skipped_duplicate=${skippedDuplicateFromFetch}, skipped_route_type=${totalSkippedRouteType}, scan_limit_reached=${scanLimitReached}`];

        // ── Post-write integrity verification ─────────────────────────────
        // Guarantee: every mapped property from the BatchData response must be
        // resolvable in Neon for this user. If any are missing, record it loudly
        // on the job instead of completing silently with dropped records.
        let integrityWarning = null;
        if (mapped.length > 0) {
            const mappedHashes = mapped.map(p => p.address_hash);
            const verifyRows = await sql`
                SELECT p.address_hash
                FROM workspace_properties wp
                JOIN properties p ON p.id = wp.property_id
                WHERE wp.user_email = ${job.user_email || 'unknown'}
                  AND p.address_hash = ANY(${mappedHashes})
            `;
            const persistedSet = new Set(verifyRows.map(r => r.address_hash));
            const missingHashes = mappedHashes.filter(h => !persistedSet.has(h));
            if (missingHashes.length > 0) {
                integrityWarning = `DATA INTEGRITY WARNING: ${missingHashes.length} of ${mapped.length} properties from BatchData were NOT persisted to the database. Missing samples: ${missingHashes.slice(0, 5).join('; ')}`;
                errorLog.push(`[${completedAt}] ${integrityWarning}`);
            } else {
                errorLog.push(`[${completedAt}] Integrity verified: ${mapped.length}/${mapped.length} BatchData properties persisted and resolvable.`);
            }
        }

        const settledUsageCount = await countPersistedPrecisionProperties(job.id);
        const latestJob = await base44.asServiceRole.entities.FetchJob.get(job.id);
        if (cancellationRequested(latestJob)) {
            await base44.asServiceRole.entities.FetchJob.update(job.id, {
                status: 'cancelled',
                precision_usage_reserved: 0,
                precision_usage_count: settledUsageCount,
                precision_usage_recorded_at: completedAt,
                completed_at: completedAt,
                dry_run_metadata: {
                    ...(job.dry_run_metadata || {}),
                    completion_reason: 'cancelled_after_partial_delivery',
                    batchdata_summary: batchdataSummary
                },
                error_log: [...errorLog, `[${completedAt}] Cancellation observed before completion; settled ${settledUsageCount} persisted properties without restoring the route allowance.`]
            });
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({ success: true, status: 'cancelled', job_id: job.id, active: activeCount });
        }

        // ── Chunk continuation ────────────────────────────────────────────
        // The provider still has pages inside this area and the target is not
        // met, so persist the offset and chain the next invocation instead of
        // completing (and instead of settling the usage reservation).
        const nextSkip = (batchFetch.attempts || []).reduce(
            (max, attempt) => Math.max(max, Number(attempt.next_skip) || 0),
            resumeSkip
        );
        const providerExhausted = Array.isArray(body.synthetic_records)
            || (batchFetch.attempts || []).some(attempt => attempt.provider_exhausted === true);
        const moreWorkAvailable = !providerExhausted && settledUsageCount < requestedTarget && nextSkip > resumeSkip;

        if (moreWorkAvailable) {
            const nextChunk = (job.chunk_number || 0) + 1;
            const scanDenominator = Number(providerTotal) > 0 ? Number(providerTotal) : null;
            const chunkPct = scanDenominator
                ? Math.min(95, Math.max(8, Math.round((nextSkip / scanDenominator) * 95)))
                : Math.min(95, Math.max(8, Math.round((settledUsageCount / Math.max(1, requestedTarget)) * 95)));
            await base44.asServiceRole.entities.FetchJob.update(job.id, {
                status: 'running',
                phase: 'batchdata_scanning',
                progress_pct: chunkPct,
                current_offset: nextSkip,
                chunk_number: nextChunk,
                total_fetched: (job.total_fetched || 0) + (reviewedCount || rawRecords.length),
                total_inserted: (job.total_inserted || 0) + result.inserted,
                total_existed: (job.total_existed || 0) + result.existed,
                total_updated: (job.total_updated || 0) + result.updated,
                total_api_calls: (job.total_api_calls || 0) + batchDataApiCalls,
                total_batchdata_calls: (job.total_batchdata_calls || 0) + batchDataApiCalls,
                zip_codes_found: zipCodes,
                chunk_timings: [...(job.chunk_timings || []), Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)],
                dry_run_metadata: {
                    ...(job.dry_run_metadata || {}),
                    completion_reason: 'chunk_in_progress',
                    batchdata_summary: batchdataSummary
                },
                error_log: errorLog
            });
            await releasePipelineLock(base44, lockId);
            lockId = null;
            const chain = base44.asServiceRole.functions.invoke('processFetchChunk', {
                job_id: job.id,
                expected_chunk: nextChunk,
                processor_token: job.dry_run_metadata?.processor_token
            }).catch(chainError => {
                console.warn(`[processFetchChunk] chunk chain failed for ${job.id}: ${chainError.message}`);
            });
            await Promise.race([chain, sleep(250)]);
            return Response.json({
                success: true,
                status: 'chunk_complete',
                job_id: job.id,
                next_offset: nextSkip,
                delivered: settledUsageCount,
                requested: requestedTarget,
                active: activeCount
            });
        }

        await base44.asServiceRole.entities.FetchJob.update(job.id, {
            status: 'completed',
            phase: 'complete',
            progress_pct: 100,
            completed_at: completedAt,
            precision_usage_reserved: 0,
            precision_usage_count: settledUsageCount,
            precision_usage_recorded_at: completedAt,
            ...(integrityWarning ? { error_message: integrityWarning } : {}),
            current_offset: nextSkip,
            total_fetched: (job.total_fetched || 0) + (reviewedCount || rawRecords.length),
            total_inserted: (job.total_inserted || 0) + result.inserted,
            total_existed: (job.total_existed || 0) + result.existed,
            total_updated: (job.total_updated || 0) + result.updated,
            total_api_calls: (job.total_api_calls || 0) + batchDataApiCalls,
            total_batchdata_calls: (job.total_batchdata_calls || 0) + batchDataApiCalls,
            completed_sub_circles: 1,
            total_sub_circles: 1,
            zip_codes_found: zipCodes,
            chunk_number: (job.chunk_number || 0) + 1,
            chunk_timings: [...(job.chunk_timings || []), Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)],
            dry_run_metadata: {
                ...(job.dry_run_metadata || {}),
                completion_reason: completionReason,
                batchdata_summary: batchdataSummary
            },
            error_log: errorLog
        });

        // Catch cancellation that arrived between the pre-completion read and
        // the completed update. The settled count is already exact, so only the
        // terminal state needs correcting.
        const afterCompletionJob = await base44.asServiceRole.entities.FetchJob.get(job.id);
        if (cancellationRequested(afterCompletionJob) && afterCompletionJob.status !== 'cancelled') {
            await base44.asServiceRole.entities.FetchJob.update(job.id, {
                status: 'cancelled',
                error_message: 'Cancelled by user',
                completed_at: completedAt,
                error_log: [
                    ...(afterCompletionJob.error_log || errorLog),
                    `[${completedAt}] Cancellation raced completion; retained exact settled usage of ${settledUsageCount} properties.`
                ]
            });
        }

        const users = await base44.asServiceRole.entities.User.filter({ email: job.user_email }, null, 1).catch(() => []);
        const userArr = Array.isArray(users) ? users : (users?.items || []);
        if (userArr[0]) {
            await base44.asServiceRole.entities.User.update(userArr[0].id, {
                has_pulled_data: true,
                last_data_pull: completedAt
            }).catch(() => {});
        }

        await releasePipelineLock(base44, lockId);
        lockId = null;
        await sleep(10);
        return Response.json({ success: true, status: 'completed', job_id: job.id, active_provider: 'batchdata', mode_used: batchFetch.mode_used, attempts: batchFetch.attempts, raw: rawRecords.length, mapped: mapped.length, active: activeCount });
    } catch (error) {
        if (base44 && lockId) await releasePipelineLock(base44, lockId);
        console.error('[processFetchChunk batchdata-only] Fatal:', error.message);
        try {
            const recovery = liveJobClaimed && targetJobId
                ? (base44 || createClientFromRequest(req))
                : null;
            const failedJob = recovery
                ? await recovery.asServiceRole.entities.FetchJob.get(targetJobId).catch(() => null)
                : null;
            const hasUnsettledReservation = failedJob
                && !failedJob.precision_usage_recorded_at
                && Math.max(0, Number(failedJob.precision_usage_reserved || 0)) > 0;
            if (failedJob && (
                ['pending', 'running'].includes(failedJob.status)
                || cancellationRequested(failedJob)
                || hasUnsettledReservation
            )) {
                let settlement = {};
                try {
                    const deliveredCount = await countPersistedPrecisionProperties(failedJob.id);
                    settlement = {
                        precision_usage_reserved: 0,
                        precision_usage_count: deliveredCount,
                        precision_usage_recorded_at: new Date().toISOString()
                    };
                } catch (settlementError) {
                    console.error('[processFetchChunk] Usage settlement failed; reservation remains in force:', settlementError.message);
                }
                const wasCancelled = cancellationRequested(failedJob);
                await recovery.asServiceRole.entities.FetchJob.update(failedJob.id, {
                    status: wasCancelled ? 'cancelled' : 'failed',
                    ...settlement,
                    error_message: wasCancelled ? 'Cancelled by user' : `BatchData processing failed: ${error.message}`,
                    error_log: [...(failedJob.error_log || []), `[${new Date().toISOString()}] FATAL: ${error.message}`]
                });
            }
        } catch {}
        return Response.json({ error: error.message }, { status: 500 });
    }
});