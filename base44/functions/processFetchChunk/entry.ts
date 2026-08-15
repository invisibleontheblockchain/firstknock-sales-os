import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { Client, neon } from 'npm:@neondatabase/serverless@0.9.0';
import {
    buildVerifiedPrecisionProcessingJob,
    classifyActivePrecisionJobs,
    isActualPrecisionJob,
    isPrecisionReservationUnsettled,
    loadUserPrecisionJobs,
    precisionCriteriaReferenceMs,
    precisionReservationAmount,
    verifyPrecisionProcessorToken,
    verifyPrecisionJobCriteriaEvidence
} from '../_shared/precisionActiveJobCriteria.js';
import {
    abortPrecisionProcessorLease,
    claimPrecisionProcessorLease,
    releasePrecisionProcessorLease
} from '../_shared/precisionProcessorLease.js';

const BATCHDATA_API_KEY = Deno.env.get('BATCH_DATA_API_KEY');
const DATABASE_URL = Deno.env.get('DATABASE_URL');
const BATCHDATA_BASE = 'https://api.batchdata.com/api/v1/property/search';
const BATCHDATA_MAX_TAKE = 100;
const BATCHDATA_REQUEST_TIMEOUT_MS = 20 * 1000;
const BATCHDATA_PROGRESS_UPDATE_MS = 1500;
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

function processorError(code, message) {
    return Object.assign(new Error(message), { code });
}

function transactionSql(client) {
    return async (strings, ...values) => {
        let text = '';
        for (let index = 0; index < strings.length; index++) {
            text += strings[index];
            if (index < values.length) text += `$${index + 1}`;
        }
        const result = await client.query(text, values);
        return result?.rows || [];
    };
}

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

function reservationIsUnsettled(job) {
    try {
        return isPrecisionReservationUnsettled(job);
    } catch (error) {
        console.error('[processFetchChunk] Malformed reservation evidence; treating it as unsettled:', error.message);
        return true;
    }
}

async function settleCancelledPrecisionUsage(
    base44,
    job,
    completedAt,
    message,
    expectedProcessorClaimId = null,
    expectedStatus = 'running'
) {
    if (!expectedProcessorClaimId) {
        throw processorError(
            'precision_processor_fence_lost',
            'Cancellation settlement requires a durable Precision processor claim.'
        );
    }
    const settledUsageCount = await countPersistedPrecisionProperties(job.id);
    const providerAttemptUnverifiable = Boolean(
        job?.dry_run_metadata?.provider_attempt_id
    );
    const payload = {
        status: 'cancelled',
        processor_claim_id: null,
        precision_usage_reserved: 0,
        precision_usage_count: settledUsageCount,
        precision_usage_recorded_at: completedAt,
        completed_at: completedAt,
        error_message: 'Cancelled by user',
        ...(providerAttemptUnverifiable ? {
            dry_run_metadata: {
                ...(job.dry_run_metadata || {}),
                provider_outcome_unverifiable_at: completedAt
            }
        } : {}),
        error_log: [
            ...(job.error_log || []),
            `[${completedAt}] ${message} Settled ${settledUsageCount} persisted Precision properties.${
                providerAttemptUnverifiable
                    ? ' The paid-provider outcome remains unverifiable and blocks replay.'
                    : ''
            }`
        ]
    };
    const updateMany = base44.asServiceRole.entities.FetchJob.updateMany;
    const settled = typeof updateMany === 'function'
        ? await updateMany.call(
            base44.asServiceRole.entities.FetchJob,
            {
                id: job.id,
                status: expectedStatus,
                processor_claim_id: expectedProcessorClaimId
            },
            { $set: payload }
        )
        : null;
    if (
        settled?.success !== true
        || Number(settled?.updated) !== 1
        || settled?.has_more === true
    ) {
        throw processorError(
            'precision_processor_fence_lost',
            'The durable Precision processor fence was lost during cancellation settlement.'
        );
    }
    return settledUsageCount;
}

async function failAndSettleInvalidPrecisionJob(
    base44,
    job,
    evidence,
    expectedProcessorClaimId,
    expectedStatus
) {
    const completedAt = new Date().toISOString();
    const settledUsageCount = await countPersistedPrecisionProperties(job.id);
    const errorCode = evidence?.code || 'precision_job_evidence_unverifiable';
    const payload = {
        status: 'failed',
        processor_claim_id: null,
        precision_usage_reserved: 0,
        precision_usage_count: settledUsageCount,
        precision_usage_recorded_at: completedAt,
        completed_at: job.completed_at || completedAt,
        error_message: `Precision invariant violation: ${errorCode}.`,
        error_log: [
            ...(job.error_log || []),
            `[${completedAt}] Processor rejected untrustworthy Precision provenance (${errorCode}) and exactly settled ${settledUsageCount} persisted properties without calling BatchData. invalid_fields=${JSON.stringify(evidence?.invalid_fields || [])} invalid_reasons=${JSON.stringify(evidence?.invalid_reasons || [])} mismatched_fields=${JSON.stringify(evidence?.mismatched_fields || [])}`
        ]
    };
    const updateMany = base44.asServiceRole.entities.FetchJob.updateMany;
    const failed = typeof updateMany === 'function'
        ? await updateMany.call(
            base44.asServiceRole.entities.FetchJob,
            {
                id: job.id,
                status: expectedStatus,
                processor_claim_id: expectedProcessorClaimId
            },
            { $set: payload }
        )
        : null;
    if (failed?.success !== true || Number(failed?.updated) !== 1) {
        throw processorError(
            'precision_processor_fence_lost',
            'The durable Precision processor fence changed during invariant settlement.'
        );
    }
    return { completedAt, settledUsageCount, errorCode };
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
    const existing = await base44.asServiceRole.entities.PipelineLock.filter({ job_id: jobId }, '-created_date', 20).catch(() => []);
    const locks = Array.isArray(existing) ? existing : (existing?.items || []);
    // This entity is diagnostic only. The transaction-scoped PostgreSQL advisory
    // lease has already proved exclusive ownership, so any old entity rows are
    // stale observations rather than synchronization authority.
    for (const lock of locks) {
        await base44.asServiceRole.entities.PipelineLock.delete(lock.id).catch(() => {});
    }

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
    const time = precisionCriteriaReferenceMs(job);
    if (time !== null) return time;
    if (!job?.dry_run_metadata?.precision_criteria) return Date.now();
    throw new Error('FetchJob has no valid immutable Precision criteria reference timestamp.');
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

function precisionSoldDateBounds(job) {
    const custom = ownershipDateBounds(job);
    if (custom) return custom;
    const referenceMs = jobReferenceTimeMs(job);
    const criteria = job?.dry_run_metadata?.precision_criteria || {};
    const previousPullDate = criteria.repull_mode === 'max_since_last'
        ? isoDateOnly(criteria.previous_pull_date)
        : null;
    return {
        oldestDate: previousPullDate
            || isoDateDaysAgo(ownershipLookbackDays(job), referenceMs),
        newestDate: isoDateOnly(new Date(referenceMs).toISOString())
    };
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
    const soldBounds = precisionSoldDateBounds(job);
    const soldDateRange = {
        minDate: soldBounds.oldestDate,
        maxDate: soldBounds.newestDate
    };

    const options = {
        skip,
        take: Math.min(Math.max(Number(take) || BATCHDATA_MAX_TAKE, 1), BATCHDATA_MAX_TAKE),
        // Request only the property, deed, and owner datasets used by the
        // Precision route product. Do not implicitly ingest contact,
        // demographic, mortgage, lien, or financial add-ons.
        datasets: ['basic', 'deed', 'owner']
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
    const evidence = batchDataTotalEvidence(payload);
    return evidence.present && evidence.consistent
        ? evidence.value
        : null;
}

function batchDataTotalEvidence(payload) {
    const values = [
        payload?.results?.totalRecordCount,
        payload?.totalRecordCount,
        payload?.meta?.totalRecordCount
    ].filter(value => value !== undefined && value !== null);
    return {
        present: values.length > 0,
        value: values.length > 0 ? values[0] : null,
        consistent: values.every(value => value === values[0])
    };
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
    const soldBounds = precisionSoldDateBounds(job);
    const isSoldInWindow = !!saleDateOnly
        && saleDateOnly >= soldBounds.oldestDate
        && saleDateOnly <= soldBounds.newestDate;
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
    // Exact-job candidates require a non-null sale date inside this same
    // persisted window. Apply that rule before persistence/counting so
    // delivered usage can never include a home route generation must discard.
    // Price gate: enforce the user's home value range on records with a known price.
    // Unknown-price records pass (provider may omit valuation on some rows).
    const jobFilters = job.dry_run_metadata?.filters || {};
    const filterMinPrice = Number(jobFilters.min_price) > 0 ? Number(jobFilters.min_price) : null;
    const filterMaxPrice = Number(jobFilters.max_price) > 0 ? Number(jobFilters.max_price) : null;
    const priceKnown = Number.isFinite(Number(price)) && Number(price) > 0;
    const priceRejected = priceKnown && ((filterMinPrice !== null && Number(price) < filterMinPrice) || (filterMaxPrice !== null && Number(price) > filterMaxPrice));
    const rejected = nonResidential || landUseRejected || priceRejected;
    const routeActive = !rejected && isSoldInWindow && isInCustomOwnershipRange;

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

async function writePropertiesToNeon(
    sql,
    properties,
    job,
    excludedRouteHashes = new Set(),
    beforePropertyWrite = null
) {
    let inserted = 0, existed = 0, updated = 0;
    const customOwnershipRange = getCustomOwnershipRange(job);

    for (const p of properties) {
        if (typeof beforePropertyWrite === 'function') {
            await beforePropertyWrite();
        }
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

function stableProviderPageValue(value) {
    if (Array.isArray(value)) return value.map(stableProviderPageValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map(key => [key, stableProviderPageValue(value[key])])
        );
    }
    return value;
}

async function providerPageFingerprint(records) {
    // Sort per-record canonical forms so a provider that repeats the same page
    // in a different order still cannot make the paid scan look progressive.
    const canonicalRecords = records
        .map(record => JSON.stringify(stableProviderPageValue(record)))
        .sort();
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalRecords));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

async function batchDataFetchOnce(requestBody) {
    let response;
    try {
        response = await fetchWithTimeout(BATCHDATA_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BATCHDATA_API_KEY}` },
            body: JSON.stringify(requestBody)
        });
    } catch (error) {
        // A timed-out or disconnected paid POST has an ambiguous provider
        // outcome. Without a provider idempotency key, replay is forbidden.
        throw processorError(
            'precision_provider_outcome_unverifiable',
            'The paid provider request ended without a verifiable outcome.'
        );
    }
    let text;
    try {
        text = await response.text();
    } catch {
        if (response.ok || response.status === 429 || response.status >= 500) {
            throw processorError(
                'precision_provider_outcome_unverifiable',
                'The paid provider response could not be verified.'
            );
        }
        throw processorError(
            'precision_provider_request_rejected',
            `BatchData rejected the request with HTTP ${response.status}.`
        );
    }
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        if (response.ok) {
            throw processorError(
                'precision_provider_outcome_unverifiable',
                'The paid provider returned an unreadable success response.'
            );
        }
    }

    if (response.ok) {
        const recognizedRecords = (
            Array.isArray(payload?.results?.properties)
            || Array.isArray(payload?.properties)
            || Array.isArray(payload?.results)
        );
        const totalEvidence = batchDataTotalEvidence(payload);
        const declaredTotals = totalEvidence.present ? [totalEvidence.value] : [];
        const totalsValid = totalEvidence.consistent && declaredTotals.every(value => (
            typeof value === 'number'
            && Number.isSafeInteger(value)
            && value >= 0
        ));
        if (
            !recognizedRecords
            || !totalsValid
            || payload?.error
            || payload?.errors
        ) {
            throw processorError(
                'precision_provider_outcome_unverifiable',
                'The paid provider returned an unrecognized success envelope.'
            );
        }
        return payload;
    }
    if (response.status === 401 || response.status === 400) {
        throw processorError(
            'precision_provider_request_rejected',
            response.status === 401
                ? 'Authentication failed. Verify the BatchData API token is correct and active.'
                : 'BatchData rejected the polygon search request.'
        );
    }
    if (response.status === 429 || response.status >= 500) {
        throw processorError(
            'precision_provider_outcome_unverifiable',
            `The paid provider returned HTTP ${response.status} without a safely replayable outcome.`
        );
    }
    throw processorError(
        'precision_provider_outcome_unverifiable',
        `The paid provider returned HTTP ${response.status} without a contract-proven pre-execution rejection.`
    );
}

async function fetchBatchDataRecordsForMode(
    job,
    mode,
    requested,
    onProgress = null,
    beforeProviderRequest = null,
    afterProviderResponse = null
) {
    const selected = [];
    const selectedHashes = new Set();
    const excludedRouteHashes = getExcludedRouteHashes(job);
    const routeTypeFilters = getRouteTypeFilters(job);
    const rejectedSamples = [];
    const pageTimings = [];
    const seenPageFingerprints = new Set();
    let skip = 0;
    let reviewed = 0;
    let totalRecordCount = null;
    let declaredTotalPresence = null;
    let skippedExistingRoute = 0;
    let skippedDuplicate = 0;
    let skippedRouteType = 0;
    const skippedRouteTypeBreakdown = {};
    const maxReviewed = Math.min(1000, Math.max(BATCHDATA_MAX_TAKE, requested * 50));

    while (selected.length < requested && reviewed < maxReviewed) {
        const take = Math.min(BATCHDATA_MAX_TAKE, maxReviewed - reviewed);
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
            });
        }
        if (typeof beforeProviderRequest === 'function') {
            await beforeProviderRequest();
        }
        const pageStartedAt = Date.now();
        const payload = await batchDataFetchOnce(requestBody);
        const list = extractBatchDataRecords(payload);
        if (list.length > take) {
            throw processorError(
                'precision_provider_outcome_unverifiable',
                'The paid provider returned more records than the requested page size.'
            );
        }
        const pageFingerprint = await providerPageFingerprint(list);
        if (seenPageFingerprints.has(pageFingerprint)) {
            throw processorError(
                'precision_provider_outcome_unverifiable',
                'The paid provider repeated a pagination page, so scan progress could not be verified.'
            );
        }
        seenPageFingerprints.add(pageFingerprint);
        if (typeof afterProviderResponse === 'function') {
            await afterProviderResponse();
        }
        const pageElapsedMs = Date.now() - pageStartedAt;
        pageTimings.push({ skip, take, returned: list.length, elapsed_ms: pageElapsedMs });
        const pageTotalEvidence = batchDataTotalEvidence(payload);
        if (
            declaredTotalPresence !== null
            && pageTotalEvidence.present !== declaredTotalPresence
        ) {
            throw processorError(
                'precision_provider_outcome_unverifiable',
                'The paid provider changed whether pagination total evidence was present during one scan.'
            );
        }
        if (declaredTotalPresence === null) {
            declaredTotalPresence = pageTotalEvidence.present;
        }
        const pageTotalRecordCount = pageTotalEvidence.present
            ? pageTotalEvidence.value
            : null;
        if (
            totalRecordCount !== null
            && pageTotalRecordCount !== null
            && pageTotalRecordCount !== totalRecordCount
        ) {
            throw processorError(
                'precision_provider_outcome_unverifiable',
                'The paid provider changed its declared pagination total during one scan.'
            );
        }
        if (totalRecordCount === null && pageTotalRecordCount !== null) {
            totalRecordCount = pageTotalRecordCount;
        }
        reviewed += list.length;
        if (
            totalRecordCount !== null
            && (
                reviewed > totalRecordCount
                || (list.length < take && reviewed < totalRecordCount)
            )
        ) {
            throw processorError(
                'precision_provider_outcome_unverifiable',
                'The paid provider returned pagination evidence that contradicts its declared total.'
            );
        }

        for (const raw of list) {
            const mapped = mapBatchDataProperty(raw, job);
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
            });
        }

        if (list.length < take) break;
        if (totalRecordCount !== null && reviewed >= totalRecordCount) break;
        skip += take;
    }

    const scanLimitReached = selected.length < requested
        && reviewed >= maxReviewed
        && (totalRecordCount === null || reviewed < totalRecordCount);

    return {
        // Rejected rows are diagnostic evidence only. Persisting them can
        // globally downgrade a previously good property or deactivate a saved
        // route link during a later no-match pull.
        records: selected.slice(0, requested),
        reviewed,
        active: selected.length,
        rejected_samples: rejectedSamples.length,
        skipped_existing_route: skippedExistingRoute,
        skipped_duplicate: skippedDuplicate,
        skipped_route_type: skippedRouteType,
        skipped_route_type_breakdown: skippedRouteTypeBreakdown,
        max_reviewed: maxReviewed,
        scan_limit_reached: scanLimitReached,
        page_timings: pageTimings,
        totalRecordCount
    };
}

async function fetchBatchDataRecords(
    job,
    onProgress = null,
    beforeProviderRequest = null,
    afterProviderResponse = null
) {
    const requested = Math.min(Math.max(Number(job.estimated_record_count || job.total_expected || 1000), 1), 1000);
    const modes = ['broad_polygon'];
    const attempts = [];
    let fallback = [];
    let fallbackMode = 'none';
    let fallbackActive = 0;

    for (const mode of modes) {
        const result = await fetchBatchDataRecordsForMode(
            job,
            mode,
            requested,
            onProgress,
            beforeProviderRequest,
            afterProviderResponse
        );
        attempts.push({ mode, count: result.records.length, reviewed: result.reviewed, active: result.active, rejected_samples: result.rejected_samples, skipped_existing_route: result.skipped_existing_route, skipped_duplicate: result.skipped_duplicate, skipped_route_type: result.skipped_route_type, skipped_route_type_breakdown: result.skipped_route_type_breakdown, max_reviewed: result.max_reviewed, scan_limit_reached: result.scan_limit_reached, page_timings: result.page_timings, total: result.totalRecordCount });
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
    let processorLease = null;
    let processorClaimId = null;
    let providerAttemptId = null;
    let providerCallMayHaveOccurred = false;
    let acceptedProviderResponses = 0;
    try {
        base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({}));
        targetJobId = body.job_id ? String(body.job_id) : null;
        const diagnosticMode = [
            'self_test',
            'request_preview',
            'map_preview',
            'fetch_preview',
            'raw_probe'
        ].some(field => body[field] === true);
        if (diagnosticMode && !isDiagnosticRequest(req)) {
            return Response.json({
                error: 'precision_diagnostic_unauthorized',
                message: 'A valid diagnostic credential is required.'
            }, { status: 403 });
        }

        if (body.self_test === true) {
            return Response.json({
                success: true,
                active_provider: 'batchdata',
                rentcast_active: false,
                batchdata_polygon_search: true,
                dataset_scope: 'basic_deed_owner_for_sale_evidence',
                datasets: ['basic', 'deed', 'owner'],
                has_batchdata_key: !!BATCHDATA_API_KEY,
                has_database_url: !!DATABASE_URL
            });
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
                const payload = await batchDataFetchOnce(requestBody);
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


        if (!DATABASE_URL) throw new Error('DATABASE_URL is not configured');

        if (!targetJobId) {
            return Response.json({ error: 'job_id is required for live processing.' }, { status: 400 });
        }
        let job = await base44.asServiceRole.entities.FetchJob.get(targetJobId).catch(() => null);
        if (!job) return Response.json({ error: 'Job not found', job_id: targetJobId }, { status: 404 });
        if (!isActualPrecisionJob(job)) {
            return Response.json({
                error: 'fetch_job_not_precision',
                message: 'The Precision processor rejected a non-Precision FetchJob.',
                job_id: targetJobId
            }, { status: 409 });
        }
        const receivedProcessorToken = String(body.processor_token || '');
        const processorTokenAuthorized = await verifyPrecisionProcessorToken(
            receivedProcessorToken,
            job.dry_run_metadata?.processor_token_hash
        );
        if (!processorTokenAuthorized) {
            return Response.json({ error: 'Not authorized to process this job.' }, { status: 403 });
        }
        if (Array.isArray(body.synthetic_records)) {
            return Response.json({
                error: 'live_synthetic_ingestion_forbidden',
                message: 'Synthetic records are not accepted by the state-changing Precision processor.'
            }, { status: 400 });
        }
        const initialSettlementRecovery = reservationIsUnsettled(job);
        if (
            targetJobId
            && !['pending', 'running'].includes(job.status)
            && !initialSettlementRecovery
        ) {
            return Response.json({ skipped: true, reason: `job_${job.status || 'inactive'}`, job_id: job.id, status: job.status });
        }

        const expectedChunk = body.expected_chunk ?? null;
        if (expectedChunk !== null && (job.chunk_number || 0) !== expectedChunk) {
            return Response.json({ skipped: true, reason: 'duplicate_invocation', job_id: job.id });
        }

        processorLease = await claimPrecisionProcessorLease({
            ClientClass: Client,
            databaseUrl: DATABASE_URL,
            jobId: job.id
        });
        if (!processorLease.claimed) {
            return Response.json({ skipped: true, reason: 'active_processor_lease', job_id: job.id });
        }

        // Re-read after obtaining the processor lease. A cancel can race the
        // initial request, and only the lease holder may release its reservation.
        job = await base44.asServiceRole.entities.FetchJob.get(targetJobId).catch(() => null);
        if (!job) throw new Error(`FetchJob ${targetJobId} disappeared after the processor lease was claimed.`);
        const subjectId = typeof job.precision_usage_user_id === 'string'
            ? job.precision_usage_user_id.trim()
            : '';
        const subject = subjectId
            ? await base44.asServiceRole.entities.User.get(subjectId).catch(() => null)
            : null;
        if (!subject) {
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                error: 'precision_job_owner_unverifiable',
                message: 'The immutable Precision subject could not be resolved. No job state was changed.',
                job_id: job.id
            }, { status: 409 });
        }
        let subjectJobs;
        try {
            subjectJobs = await loadUserPrecisionJobs(base44, subject);
        } catch (discoveryError) {
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                error: discoveryError?.code || 'precision_job_discovery_incomplete',
                message: 'Precision job discovery was not trustworthy. No job state was changed.',
                job_id: job.id
            }, { status: Number(discoveryError?.status || 503) });
        }
        const activeResolution = classifyActivePrecisionJobs(subjectJobs);
        if (activeResolution.state === 'multiple') {
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                error: 'multiple_active_precision_jobs',
                message: 'Multiple active Precision jobs require operator review. No job was selected or changed.',
                job_id: job.id,
                active_job_ids: activeResolution.jobs.map(activeJob => activeJob.id)
            }, { status: 409 });
        }
        // PipelineLock is diagnostic state, not synchronization authority.
        // Delay all Base44 mutation until immutable-subject discovery has
        // proved this is the only active job for the subject.
        const claim = await claimPipelineLock(base44, job.id, crypto.randomUUID());
        lockId = claim.lockId;
        liveJobClaimed = true;
        const hasObservedProcessorClaim = typeof job.processor_claim_id === 'string'
            && Boolean(job.processor_claim_id.trim());
        if (
            ['pending', 'running'].includes(job.status)
            && hasObservedProcessorClaim
            && !cancellationRequested(job)
            && !job.precision_watchdog_recovery_at
        ) {
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                skipped: true,
                reason: 'durable_processor_claim_active',
                job_id: job.id
            }, { status: 409 });
        }
        if (
            (
                ['pending', 'running'].includes(job.status)
                && !hasObservedProcessorClaim
            )
            ||
            cancellationRequested(job)
            || job.precision_watchdog_recovery_at
            || (
                typeof job.processor_claim_id === 'string'
                && Boolean(job.processor_claim_id.trim())
            )
            || (
                !['pending', 'running'].includes(job.status)
                && reservationIsUnsettled(job)
            )
            || (
                job.status === 'running'
                && (
                    Boolean(job.started_at)
                    || Number(job.progress_pct || 0) > 0
                    || Number(job.total_fetched || 0) > 0
                    || ['batchdata_requesting', 'batchdata_scanning'].includes(job.phase)
                )
            )
        ) {
            processorClaimId = crypto.randomUUID();
            const takeoverFilter = {
                id: job.id,
                status: job.status
            };
            if (Object.prototype.hasOwnProperty.call(job, 'processor_claim_id')) {
                takeoverFilter.processor_claim_id = job.processor_claim_id;
            }
            const updateMany = base44.asServiceRole.entities.FetchJob.updateMany;
            const takeover = typeof updateMany === 'function'
                ? await updateMany.call(
                    base44.asServiceRole.entities.FetchJob,
                    takeoverFilter,
                    {
                        $set: {
                            processor_claim_id: processorClaimId,
                            processor_claimed_at: new Date().toISOString()
                        }
                    }
                )
                : null;
            if (takeover?.success !== true || Number(takeover?.updated) !== 1) {
                await releasePipelineLock(base44, lockId);
                lockId = null;
                return Response.json({
                    skipped: true,
                    reason: 'processor_recovery_claim_changed',
                    job_id: job.id
                }, { status: 409 });
            }
            job = await base44.asServiceRole.entities.FetchJob.get(job.id);
        }
        const settlementRecovery = reservationIsUnsettled(job);
        if (cancellationRequested(job)) {
            let settledUsageCount = job.precision_usage_count;
            if (settlementRecovery) {
                const completedAt = new Date().toISOString();
                settledUsageCount = await settleCancelledPrecisionUsage(
                    base44,
                    job,
                    completedAt,
                    'Cancellation observed after claiming the processor lease.',
                    processorClaimId,
                    job.status
                );
            } else if (job.status !== 'cancelled') {
                const completedAt = new Date().toISOString();
                const cancelled = await base44.asServiceRole.entities.FetchJob.updateMany.call(
                    base44.asServiceRole.entities.FetchJob,
                    {
                        id: job.id,
                        status: job.status,
                        processor_claim_id: processorClaimId
                    },
                    {
                        $set: {
                            status: 'cancelled',
                            processor_claim_id: null,
                            completed_at: job.completed_at || completedAt,
                            error_message: 'Cancelled by user'
                        }
                    }
                );
                if (
                    cancelled?.success !== true
                    || Number(cancelled?.updated) !== 1
                    || cancelled?.has_more === true
                ) {
                    throw processorError(
                        'precision_processor_fence_lost',
                        'The durable Precision processor fence changed during cancellation.'
                    );
                }
            }
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({ success: true, status: 'cancelled', job_id: job.id, active: settledUsageCount });
        }
        if (['pending', 'running'].includes(job.status) && !settlementRecovery) {
            const terminalAt = new Date().toISOString();
            const terminalized = await base44.asServiceRole.entities.FetchJob.updateMany.call(
                base44.asServiceRole.entities.FetchJob,
                {
                    id: job.id,
                    status: job.status,
                    processor_claim_id: processorClaimId
                },
                {
                    $set: {
                        status: 'failed',
                        processor_claim_id: null,
                        completed_at: job.completed_at || terminalAt,
                        error_message: 'Precision processing stopped because the job was already exactly settled.',
                        error_log: [
                            ...(job.error_log || []),
                            `[${terminalAt}] Active status contradicted immutable exact-settlement evidence; terminalized without provider work or recount.`
                        ]
                    }
                }
            );
            if (terminalized?.success !== true || Number(terminalized?.updated) !== 1) {
                throw processorError(
                    'precision_processor_fence_lost',
                    'The durable Precision processor fence changed during terminalization.'
                );
            }
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                success: true,
                status: 'failed',
                job_id: job.id,
                active: job.precision_usage_count,
                settlement_preserved: true
            });
        }
        if (!['pending', 'running'].includes(job.status)) {
            if (settlementRecovery) {
                const settledAt = new Date().toISOString();
                const settledUsageCount = await countPersistedPrecisionProperties(job.id);
                const providerAttemptNeedsHold = (
                    job.status !== 'completed'
                    && Boolean(job?.dry_run_metadata?.provider_attempt_id)
                );
                const repairPayload = {
                    processor_claim_id: null,
                    precision_usage_reserved: 0,
                    precision_usage_count: settledUsageCount,
                    precision_usage_recorded_at: settledAt,
                    completed_at: job.completed_at || settledAt,
                    ...(providerAttemptNeedsHold ? {
                        dry_run_metadata: {
                            ...(job.dry_run_metadata || {}),
                            provider_outcome_unverifiable_at: settledAt
                        }
                    } : {}),
                    error_log: [
                        ...(job.error_log || []),
                        `[${settledAt}] Processor repaired incomplete terminal settlement from exact persisted-property evidence (${settledUsageCount}).`
                    ]
                };
                const updateMany = base44.asServiceRole.entities.FetchJob.updateMany;
                const repaired = typeof updateMany === 'function' && processorClaimId
                    ? await updateMany.call(
                        base44.asServiceRole.entities.FetchJob,
                        {
                            id: job.id,
                            status: job.status,
                            processor_claim_id: processorClaimId
                        },
                        { $set: repairPayload }
                    )
                    : null;
                if (
                    repaired?.success !== true
                    || Number(repaired?.updated) !== 1
                    || repaired?.has_more === true
                ) {
                    await releasePipelineLock(base44, lockId);
                    lockId = null;
                    return Response.json({
                        skipped: true,
                        reason: 'processor_recovery_claim_changed',
                        job_id: job.id
                    }, { status: 409 });
                }
                await releasePipelineLock(base44, lockId);
                lockId = null;
                return Response.json({
                    success: true,
                    status: job.status,
                    job_id: job.id,
                    active: settledUsageCount,
                    settlement_repaired: true
                });
            }
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({ skipped: true, reason: `job_${job.status || 'inactive'}`, job_id: job.id, status: job.status });
        }

        const criteriaEvidence = subject
            ? await verifyPrecisionJobCriteriaEvidence(job, subject)
            : {
                ok: false,
                code: 'precision_job_owner_mismatch',
                invalid_fields: ['precision_usage_user_id'],
                mismatched_fields: []
            };
        if (!criteriaEvidence.ok) {
            const invalid = await failAndSettleInvalidPrecisionJob(
                base44,
                job,
                criteriaEvidence,
                processorClaimId,
                job.status
            );
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                error: invalid.errorCode,
                job_id: job.id,
                delivered_count: invalid.settledUsageCount
            }, { status: 409 });
        }
        let activeReservation = null;
        try {
            activeReservation = precisionReservationAmount(job);
        } catch {
            activeReservation = null;
        }
        if (
            activeReservation === null
            || activeReservation <= 0
            || activeReservation !== criteriaEvidence.criteria.effective_count
        ) {
            const invalid = await failAndSettleInvalidPrecisionJob(
                base44,
                job,
                {
                    code: 'precision_reservation_unverifiable',
                    invalid_fields: ['precision_usage_reserved'],
                    mismatched_fields: activeReservation === null
                        ? []
                        : ['precision_usage_reserved']
                },
                processorClaimId,
                job.status
            );
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                error: invalid.errorCode,
                job_id: job.id,
                delivered_count: invalid.settledUsageCount
            }, { status: 409 });
        }
        job = buildVerifiedPrecisionProcessingJob(job, criteriaEvidence, subject);

        // A prior worker may have entered provider work and crashed before
        // settlement. Without a durable provider cursor/checkpoint it is not
        // safe to call the paid provider again even when no row survived:
        // result ordering can change and produce duplicate cost or over-
        // delivery. Only a genuinely never-started pending job may proceed.
        const persistedBeforeProvider = await countPersistedPrecisionProperties(job.id);
        const providerMayHaveStarted = (
            job.status === 'running'
            || Boolean(job.started_at)
            || Number(job.progress_pct || 0) > 0
            || Number(job.total_fetched || 0) > 0
            || ['batchdata_requesting', 'batchdata_scanning'].includes(job.phase)
        );
        if (providerMayHaveStarted || persistedBeforeProvider > 0) {
            const settledAt = new Date().toISOString();
            const priorProviderAttemptId = job?.dry_run_metadata?.provider_attempt_id;
            const replayHoldPayload = {
                status: 'failed',
                processor_claim_id: null,
                precision_usage_reserved: 0,
                precision_usage_count: persistedBeforeProvider,
                precision_usage_recorded_at: settledAt,
                completed_at: job.completed_at || settledAt,
                error_message: 'Precision processing stopped safely because prior provider progress could not be resumed deterministically.',
                ...(priorProviderAttemptId ? {
                    dry_run_metadata: {
                        ...(job.dry_run_metadata || {}),
                        provider_outcome_unverifiable_at: settledAt
                    }
                } : {}),
                error_log: [
                    ...(job.error_log || []),
                    `[${settledAt}] Recovery found prior provider progress and ${persistedBeforeProvider} persisted Precision properties; exact-settled without another provider call.`
                ]
            };
            const replayHold = processorClaimId
                && typeof base44.asServiceRole.entities.FetchJob.updateMany === 'function'
                ? await base44.asServiceRole.entities.FetchJob.updateMany.call(
                    base44.asServiceRole.entities.FetchJob,
                    {
                        id: job.id,
                        status: job.status,
                        processor_claim_id: processorClaimId
                    },
                    { $set: replayHoldPayload }
                )
                : null;
            if (
                replayHold?.success !== true
                || Number(replayHold?.updated) !== 1
                || replayHold?.has_more === true
            ) {
                await releasePipelineLock(base44, lockId);
                lockId = null;
                return Response.json({
                    skipped: true,
                    reason: 'processor_recovery_claim_changed',
                    job_id: job.id
                }, { status: 409 });
            }
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                success: true,
                status: 'failed',
                job_id: job.id,
                active: persistedBeforeProvider,
                settlement_repaired: true,
                provider_replay_blocked: true
            });
        }

        const startedAt = job.started_at || new Date().toISOString();
        processorClaimId = processorClaimId || crypto.randomUUID();
        providerAttemptId = crypto.randomUUID();
        const providerAttemptStartedAt = new Date().toISOString();
        const claimedMetadata = {
            ...(job.dry_run_metadata || {}),
            provider_attempt_id: providerAttemptId,
            provider_attempt_started_at: providerAttemptStartedAt
        };
        const updateMany = base44.asServiceRole.entities.FetchJob.updateMany;
        if (typeof updateMany !== 'function') {
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                error: 'precision_processor_claim_unavailable',
                message: 'Precision processing could not acquire a durable provider claim.'
            }, { status: 503 });
        }
        const processorClaim = await updateMany.call(
            base44.asServiceRole.entities.FetchJob,
            {
                id: job.id,
                status: 'pending',
                phase: 'batchdata_precision',
                progress_pct: 0,
                processor_claim_id: processorClaimId,
                precision_usage_reserved: activeReservation,
                precision_usage_count: 0
            },
            {
                $set: {
                    status: 'running',
                    started_at: startedAt,
                    provider: 'batchdata',
                    mode_tag: 'PRECISION_TARGET',
                    phase: 'batchdata_requesting',
                    progress_pct: 5,
                    processor_claim_id: processorClaimId,
                    processor_claimed_at: providerAttemptStartedAt,
                    dry_run_metadata: claimedMetadata
                }
            }
        );
        if (
            processorClaim?.success !== true
            || Number(processorClaim?.updated) !== 1
            || processorClaim?.has_more === true
        ) {
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                skipped: true,
                reason: 'processor_claim_not_acquired',
                job_id: job.id
            }, { status: 409 });
        }
        const claimedJob = await base44.asServiceRole.entities.FetchJob.get(job.id).catch(() => null);
        if (
            !claimedJob
            || claimedJob.status !== 'running'
            || claimedJob.phase !== 'batchdata_requesting'
            || claimedJob.started_at !== startedAt
            || claimedJob.processor_claim_id !== processorClaimId
            || claimedJob?.dry_run_metadata?.provider_attempt_id !== providerAttemptId
        ) {
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                error: 'precision_processor_claim_unverified',
                message: 'Precision processing could not verify its durable provider claim.'
            }, { status: 503 });
        }
        job = {
            ...job,
            status: claimedJob.status,
            phase: claimedJob.phase,
            started_at: claimedJob.started_at,
            progress_pct: claimedJob.progress_pct,
            processor_claim_id: claimedJob.processor_claim_id,
            processor_claimed_at: claimedJob.processor_claimed_at,
            dry_run_metadata: claimedJob.dry_run_metadata,
            updated_date: claimedJob.updated_date || job.updated_date
        };
        if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');

        // All mutable Neon reads/writes run in the same transaction and on the
        // same connection that owns the advisory processor lease. Connection
        // loss therefore rolls back partial property work instead of allowing
        // a stale worker to write outside its lease.
        const sql = transactionSql(processorLease.client);
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
            const progressClaim = await updateMany.call(
                base44.asServiceRole.entities.FetchJob,
                {
                    id: job.id,
                    status: 'running',
                    processor_claim_id: processorClaimId
                },
                { $set: update }
            );
            if (progressClaim?.success !== true || Number(progressClaim?.updated) !== 1) {
                throw processorError(
                    'precision_processor_fence_lost',
                    'The durable Precision processor fence was lost.'
                );
            }
        };
        const requireProcessorFence = async () => {
            const observed = await base44.asServiceRole.entities.FetchJob.get(job.id).catch(() => null);
            if (
                observed
                && observed.processor_claim_id === processorClaimId
                && (cancellationRequested(observed) || observed.precision_watchdog_recovery_at)
            ) {
                throw processorError(
                    'precision_processor_recovery_observed',
                    'Precision processing was interrupted by durable recovery intent.'
                );
            }
            if (
                !observed
                || observed.status !== 'running'
                || observed.processor_claim_id !== processorClaimId
                || observed?.dry_run_metadata?.provider_attempt_id !== providerAttemptId
            ) {
                throw processorError(
                    'precision_processor_fence_lost',
                    'The durable Precision processor fence was lost.'
                );
            }
            const heartbeatAt = new Date().toISOString();
            const heartbeat = await updateMany.call(
                base44.asServiceRole.entities.FetchJob,
                {
                    id: job.id,
                    status: 'running',
                    processor_claim_id: processorClaimId
                },
                { $set: { processor_heartbeat_at: heartbeatAt } }
            );
            if (
                heartbeat?.success !== true
                || Number(heartbeat?.updated) !== 1
                || heartbeat?.has_more === true
            ) {
                throw processorError(
                    'precision_processor_fence_lost',
                    'The durable Precision processor fence was lost.'
                );
            }
            return heartbeatAt;
        };
        const batchFetch = await fetchBatchDataRecords(
            job,
            updateScanProgress,
            async () => {
                await requireProcessorFence();
                providerCallMayHaveOccurred = true;
            },
            async () => {
                acceptedProviderResponses++;
            }
        );
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

        await requireProcessorFence();
        const beforeWriteJob = await base44.asServiceRole.entities.FetchJob.get(job.id);
        if (cancellationRequested(beforeWriteJob)) {
            const cancelledAt = new Date().toISOString();
            const beforeWriteUnsettled = reservationIsUnsettled(beforeWriteJob);
            const settledUsageCount = beforeWriteUnsettled
                ? await settleCancelledPrecisionUsage(
                    base44,
                    beforeWriteJob,
                    cancelledAt,
                    'Cancellation observed before the Neon write; no fetched properties were added.',
                    processorClaimId
                )
                : beforeWriteJob.precision_usage_count;
            if (!beforeWriteUnsettled && beforeWriteJob.status !== 'cancelled') {
                const cancelled = await updateMany.call(
                    base44.asServiceRole.entities.FetchJob,
                    {
                        id: beforeWriteJob.id,
                        status: 'running',
                        processor_claim_id: processorClaimId
                    },
                    {
                        $set: {
                            status: 'cancelled',
                            processor_claim_id: null,
                            completed_at: beforeWriteJob.completed_at || cancelledAt,
                            error_message: 'Cancelled by user'
                        }
                    }
                );
                if (cancelled?.success !== true || Number(cancelled?.updated) !== 1) {
                    throw processorError(
                        'precision_processor_fence_lost',
                        'The durable Precision processor fence was lost during cancellation.'
                    );
                }
            }
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({ success: true, status: 'cancelled', job_id: job.id, active: settledUsageCount });
        }

        const result = await writePropertiesToNeon(
            sql,
            mapped,
            job,
            excludedRouteHashes,
            requireProcessorFence
        );
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
            scan_limit_reached: scanLimitReached
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

        const transactionalCountRows = await sql`
            SELECT COUNT(*)::int AS count
            FROM workspace_properties
            WHERE fetch_job_id = ${job.id}
              AND route_active = TRUE
        `;
        const transactionalSettledUsageCount = Math.max(
            0,
            Number(transactionalCountRows?.[0]?.count || 0)
        );
        // The transaction has passed post-write verification. Commit it before
        // taking the exact persisted count; the durable Base44 claim remains
        // the fence through conditional terminal settlement.
        await requireProcessorFence();
        await releasePrecisionProcessorLease(processorLease);
        processorLease = null;
        const settledUsageCount = await countPersistedPrecisionProperties(job.id);
        if (settledUsageCount !== transactionalSettledUsageCount) {
            throw processorError(
                'precision_post_commit_count_mismatch',
                'Committed Precision delivery count did not match the verified transaction count.'
            );
        }
        const latestJob = await base44.asServiceRole.entities.FetchJob.get(job.id);
        if (cancellationRequested(latestJob)) {
            const cancelled = await updateMany.call(
                base44.asServiceRole.entities.FetchJob,
                {
                    id: job.id,
                    status: latestJob.status,
                    processor_claim_id: processorClaimId
                },
                {
                    $set: {
                        status: 'cancelled',
                        processor_claim_id: null,
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
                    }
                }
            );
            if (cancelled?.success !== true || Number(cancelled?.updated) !== 1) {
                throw processorError(
                    'precision_processor_fence_lost',
                    'The durable Precision processor fence was lost during cancellation settlement.'
                );
            }
            await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({ success: true, status: 'cancelled', job_id: job.id, active: activeCount });
        }
        if (
            latestJob.status !== 'running'
            || latestJob.processor_claim_id !== processorClaimId
            || latestJob?.dry_run_metadata?.provider_attempt_id !== providerAttemptId
        ) {
            throw processorError(
                'precision_processor_fence_lost',
                'The durable Precision processor fence was lost before settlement.'
            );
        }

        const completionPayload = {
            status: 'completed',
            phase: 'complete',
            progress_pct: 100,
            processor_claim_id: null,
            completed_at: completedAt,
            precision_usage_reserved: 0,
            precision_usage_count: settledUsageCount,
            precision_usage_recorded_at: completedAt,
            ...(integrityWarning ? { error_message: integrityWarning } : {}),
            total_fetched: reviewedCount || rawRecords.length,
            total_inserted: result.inserted,
            total_existed: result.existed,
            total_updated: result.updated,
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
        };
        const completionClaim = await updateMany.call(
            base44.asServiceRole.entities.FetchJob,
            {
                id: job.id,
                status: 'running',
                processor_claim_id: processorClaimId
            },
            { $set: completionPayload }
        );
        if (
            completionClaim?.success !== true
            || Number(completionClaim?.updated) !== 1
            || completionClaim?.has_more === true
        ) {
            throw processorError(
                'precision_processor_fence_lost',
                'The durable Precision processor fence was lost during settlement.'
            );
        }

        // Catch cancellation that arrived between the pre-completion read and
        // the completed update. The settled count is already exact, so only the
        // terminal state needs correcting.
        const afterCompletionJob = await base44.asServiceRole.entities.FetchJob.get(job.id);
        if (cancellationRequested(afterCompletionJob) && afterCompletionJob.status !== 'cancelled') {
            const cancellationCorrectionFilter = {
                id: job.id,
                status: 'completed',
                processor_claim_id: null,
                precision_usage_reserved: 0,
                precision_usage_count: settledUsageCount,
                precision_usage_recorded_at: completedAt
            };
            if (Object.prototype.hasOwnProperty.call(afterCompletionJob, 'precision_cancel_requested_at')) {
                cancellationCorrectionFilter.precision_cancel_requested_at =
                    afterCompletionJob.precision_cancel_requested_at;
            }
            const corrected = await updateMany.call(
                base44.asServiceRole.entities.FetchJob,
                cancellationCorrectionFilter,
                {
                    $set: {
                        status: 'cancelled',
                        error_message: 'Cancelled by user',
                        completed_at: completedAt,
                        error_log: [
                            ...(afterCompletionJob.error_log || errorLog),
                            `[${completedAt}] Cancellation raced completion; retained exact settled usage of ${settledUsageCount} properties.`
                        ]
                    }
                }
            );
            if (
                corrected?.success !== true
                || Number(corrected?.updated) !== 1
                || corrected?.has_more === true
            ) {
                throw processorError(
                    'precision_processor_fence_lost',
                    'The completed Precision settlement changed during cancellation correction.'
                );
            }
        }

        // The verified immutable subject remains authoritative even when their
        // current email differs from the persisted job email. job.user_email is
        // retained only as the historical workspace_properties row locator.
        await base44.asServiceRole.entities.User.update(subject.id, {
            has_pulled_data: true,
            last_data_pull: completedAt
        }).catch(() => {});

        await releasePipelineLock(base44, lockId);
        lockId = null;
        await sleep(10);
        return Response.json({ success: true, status: 'completed', job_id: job.id, active_provider: 'batchdata', mode_used: batchFetch.mode_used, attempts: batchFetch.attempts, raw: rawRecords.length, mapped: mapped.length, active: activeCount });
    } catch (error) {
        if (processorLease) {
            await abortPrecisionProcessorLease(processorLease);
            processorLease = null;
        }
        const referenceId = crypto.randomUUID();
        const fenceLost = error?.code === 'precision_processor_fence_lost';
        let providerOutcomeUnverifiable = (
            error?.code === 'precision_provider_outcome_unverifiable'
            || (
                providerCallMayHaveOccurred
                && (
                    error?.code !== 'precision_provider_request_rejected'
                    || acceptedProviderResponses > 0
                )
                && !fenceLost
            )
        );
        console.error(
            `[processFetchChunk batchdata-only] Fatal ${referenceId}:`,
            error?.code || 'precision_processing_failed'
        );
        try {
            const recovery = !fenceLost && liveJobClaimed && targetJobId
                ? (base44 || createClientFromRequest(req))
                : null;
            const failedJob = recovery
                ? await recovery.asServiceRole.entities.FetchJob.get(targetJobId).catch(() => null)
                : null;
            if (
                failedJob?.dry_run_metadata?.provider_attempt_id
                && (
                    cancellationRequested(failedJob)
                    || failedJob.precision_watchdog_recovery_at
                )
            ) {
                providerOutcomeUnverifiable = true;
            }
            let hasUnsettledReservation = false;
            if (failedJob) {
                try {
                    hasUnsettledReservation = isPrecisionReservationUnsettled(failedJob);
                } catch (reservationError) {
                    // Malformed reservation evidence must never make a fatal
                    // path look settled. The processor still attempts exact
                    // property-count settlement below.
                    hasUnsettledReservation = true;
                    console.error('[processFetchChunk] Reservation evidence is malformed; treating it as unsettled:', reservationError.message);
                }
            }
            if (failedJob && (
                ['pending', 'running'].includes(failedJob.status)
                || cancellationRequested(failedJob)
                || hasUnsettledReservation
            )) {
                let settlement = {};
                const terminalAt = new Date().toISOString();
                if (hasUnsettledReservation) {
                    try {
                        const deliveredCount = await countPersistedPrecisionProperties(failedJob.id);
                        settlement = {
                            precision_usage_reserved: 0,
                            precision_usage_count: deliveredCount,
                            precision_usage_recorded_at: terminalAt
                        };
                    } catch (settlementError) {
                        console.error('[processFetchChunk] Usage settlement failed; reservation remains in force:', settlementError.message);
                    }
                }
                const wasCancelled = cancellationRequested(failedJob);
                const failurePayload = {
                    status: wasCancelled ? 'cancelled' : 'failed',
                    processor_claim_id: null,
                    ...settlement,
                    completed_at: terminalAt,
                    error_message: wasCancelled
                        ? 'Cancelled by user'
                        : providerOutcomeUnverifiable
                            ? 'The paid provider outcome could not be verified. Support review is required before another Precision pull.'
                            : `Precision processing failed safely. Reference ${referenceId}.`,
                    ...(providerOutcomeUnverifiable ? {
                        dry_run_metadata: {
                            ...(failedJob.dry_run_metadata || {}),
                            ...(providerAttemptId ? { provider_attempt_id: providerAttemptId } : {}),
                            provider_outcome_unverifiable_at: terminalAt
                        }
                    } : {}),
                    error_log: [
                        ...(failedJob.error_log || []),
                        `[${terminalAt}] FATAL ${referenceId}: ${
                            providerOutcomeUnverifiable
                                ? 'precision_provider_outcome_unverifiable'
                                : 'precision_processing_failed'
                        }`
                    ]
                };
                if (processorClaimId) {
                    const updateMany = recovery.asServiceRole.entities.FetchJob.updateMany;
                    if (typeof updateMany !== 'function') {
                        throw new Error('Conditional fatal settlement is unavailable.');
                    }
                    const failureClaim = await updateMany.call(
                        recovery.asServiceRole.entities.FetchJob,
                        {
                            id: failedJob.id,
                            status: failedJob.status,
                            processor_claim_id: processorClaimId
                        },
                        { $set: failurePayload }
                    );
                    if (
                        failureClaim?.success !== true
                        || Number(failureClaim?.updated) !== 1
                        || failureClaim?.has_more === true
                    ) {
                        console.warn(
                            '[processFetchChunk] Fatal settlement skipped because the durable processor fence changed.'
                        );
                    }
                } else {
                    // Without a durable claim there is no safe stale-writer
                    // predicate. Preserve the reservation/current terminal
                    // state for watchdog or operator reconciliation.
                    console.warn(
                        '[processFetchChunk] Fatal settlement skipped because no durable processor claim was acquired.'
                    );
                }
            }
        } catch (recoveryError) {
            console.error('[processFetchChunk] Fatal recovery could not terminalize the job; reservation remains in force:', recoveryError.message);
        } finally {
            // Keep the processor lease through the exact persisted-property
            // count and terminal FetchJob update. Releasing it earlier permits
            // a concurrent re-kick to write while the delivered count is taken.
            if (base44 && lockId) {
                await releasePipelineLock(base44, lockId);
                lockId = null;
            }
        }
        if (fenceLost) {
            return Response.json({
                error: 'precision_processor_fence_lost',
                message: 'This worker no longer owns the durable Precision processing claim.',
                reference_id: referenceId
            }, { status: 409 });
        }
        return Response.json({
            error: providerOutcomeUnverifiable
                ? 'precision_provider_outcome_unverifiable'
                : 'precision_processing_failed',
            message: providerOutcomeUnverifiable
                ? 'The paid provider outcome could not be verified. Support review is required.'
                : 'Precision processing failed safely.',
            reference_id: referenceId
        }, { status: providerOutcomeUnverifiable ? 502 : 500 });
    } finally {
        if (base44 && lockId) {
            await releasePipelineLock(base44, lockId);
            lockId = null;
        }
        await releasePrecisionProcessorLease(processorLease);
    }
});
