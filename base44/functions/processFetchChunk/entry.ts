import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import {
    BATCHDATA_PAGE_LIMIT,
    BATCHDATA_SEARCH_DATASETS,
    DEFAULT_PRECISION_MIN_HOME_VALUE,
    applyBatchDataQualificationFilters,
    applyRecentSaleSearchFilter,
    clampBatchDataTake,
    closedDayWindow,
    hasAddressUnitMarker,
    hasExplicitSingleFamilyMetadata,
    isBlockedListingStatus,
    isSaleDateWithinWindow,
    qualifiesEstimatedValueRange,
    resolveProviderRecentSaleProof,
    resolveSingleFamilyMetadata,
    selectRecentSaleEvidence,
    unwrapBatchDataProperty
} from './recentSaleLogic.js';
import {
    allowsAssignedRouteForCurrentJob,
    planPropertyMerge,
    protectsAssignedRouteFetchJob
} from './propertyMergeLogic.js';
import {
    electCanonicalPipelineLock,
    isActivePipelineLock,
    resolveCreatedPipelineLockElection,
    resolveProcessingFetchJobElection
} from './pipelineLockElectionLogic.js';

const BATCHDATA_API_KEY = Deno.env.get('BATCH_DATA_API_KEY');
const DATABASE_URL = Deno.env.get('DATABASE_URL');
const BATCHDATA_BASE = 'https://api.batchdata.com/api/v1/property/search';
const BATCHDATA_LOOKUP_BASE = 'https://api.batchdata.com/api/v1/property/lookup/all-attributes';
const BATCHDATA_MAX_TAKE = BATCHDATA_PAGE_LIMIT;
const MAX_AVAILABLE_TAKE = BATCHDATA_PAGE_LIMIT;
const MAX_PROVIDER_RECORDS_PER_DATE_SOURCE = 5000;
const PROVIDER_MARKET_TIME_ZONE = 'America/Phoenix';
// July 9 live probe: cursor page 1 succeeded, but verbatim page 2 returned 500.
// Keep offset paging as the current-token default; enable cursor explicitly
// after the provider contract is revalidated.
const BATCHDATA_CURSOR_PAGINATION_ENABLED = Deno.env.get('BATCHDATA_CURSOR_PAGINATION_ENABLED') === 'true';
const BATCHDATA_REQUEST_TIMEOUT_MS = 20 * 1000;
const JOB_MEMBERSHIP_CONTRACT = 'property_sources_v1';
const PRECISION_PIPELINE_CONTRACT = 'precision_generate_v2';
const BATCHDATA_PROGRESS_UPDATE_MS = 1500;
const PIPELINE_LOCK_TTL_MS = 8 * 60 * 1000;
const PIPELINE_LOCK_ELECTION_SETTLE_MS = 50;
const FETCH_JOB_PROCESSOR_ELECTION_SETTLE_MS = 50;
const DIAGNOSTIC_FLAGS = [
    'self_test',
    'window_coverage',
    'endpoint_comparison',
    'penetration_audit',
    'lookup_enrichment',
    'raw_discovery',
    'polygon_intel_verify',
    'r2_coverage_audit',
    'market_health_check',
    'request_preview',
    'map_preview',
    'fetch_preview',
    'raw_probe'
];
const DEFAULT_ROUTE_TYPE_FILTERS = {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true,
    excludeAssigned: true
};
const ALLOWED_ROUTE_PROPERTY_TYPES = new Set(['Single Family']);
const PROPERTY_TYPE_ALIASES = {
    'Single Family': ['single family', 'single family residential', 'single-family', 'sfr', 'sfh', 'detached', 'one family', '1 family']
};
const COMMERCIAL_TYPE_KEYWORDS = ['commercial', 'industrial', 'retail', 'office', 'warehouse', 'business', 'shopping', 'hotel', 'motel', 'restaurant', 'medical', 'hospital', 'mixed use'];
const CONDO_MULTI_TYPE_KEYWORDS = ['condo', 'condominium', 'apartment', 'co op', 'coop', 'cooperative', 'multifamily', 'multi family', 'multi-family', 'duplex', 'triplex', 'fourplex', 'townhouse', 'townhome', 'row house', 'rowhouse', 'mobile home', 'manufactured home', 'manufactured housing'];
const LAND_TYPE_KEYWORDS = ['land', 'lot', 'vacant', 'acreage', 'farm', 'agricultural'];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function normalizePropertyTypeText(value) {
    return String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\bsinglefamily\b/gi, 'single family')
        .replace(/\bonefamily\b/gi, 'one family')
        .replace(/\bdetachedresidential\b/gi, 'detached residential')
        .replace(/\bresidentialdetached\b/gi, 'residential detached')
        .toLowerCase()
        .replace(/[\/_-]+/g, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function includesAnyPropertyType(text, keywords) {
    return keywords.some(keyword => text.includes(normalizePropertyTypeText(keyword)));
}

function isExplicitSingleFamilyType(value) {
    return hasExplicitSingleFamilyMetadata(null, value);
}

function matchesSelectedPropertyType(propertyType, selectedType) {
    const text = normalizePropertyTypeText(propertyType);
    if (!text || /unverified|unknown/.test(text)) return false;

    const aliases = PROPERTY_TYPE_ALIASES[selectedType] || [selectedType];
    if (selectedType === 'Single Family') return hasExplicitSingleFamilyMetadata(null, propertyType);
    if (aliases.some(alias => text.includes(normalizePropertyTypeText(alias)))) return true;

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
        excludeLand: true,
        excludeAssigned: source.excludeAssigned !== false
    };
}

function getRouteTypeFilters(job) {
    return normalizeRouteTypeFilters(job?.dry_run_metadata?.route_filters || DEFAULT_ROUTE_TYPE_FILTERS);
}

function routeTypeEligibility(property, filters = DEFAULT_ROUTE_TYPE_FILTERS) {
    const normalizedFilters = normalizeRouteTypeFilters(filters);
    const rawPropertyType = property?.property_type;
    const text = normalizePropertyTypeText(rawPropertyType);
    const selectedTypes = normalizedFilters.propertyTypes;

    if (selectedTypes.length > 0 && !selectedTypes.some(type => matchesSelectedPropertyType(rawPropertyType, type))) {
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
    const existing = await base44.asServiceRole.entities.PipelineLock.filter({ job_id: jobId }, '-created_date', 100).catch(() => []);
    const locks = Array.isArray(existing) ? existing : (existing?.items || []);

    for (const lock of locks) {
        if (!isActivePipelineLock(lock, now, PIPELINE_LOCK_TTL_MS)) {
            await base44.asServiceRole.entities.PipelineLock.delete(lock.id).catch(() => {});
        }
    }

    const activeLock = electCanonicalPipelineLock(locks, { nowMs: now, ttlMs: PIPELINE_LOCK_TTL_MS });
    if (activeLock) return { claimed: false, reason: 'active_lock', lockedBy: activeLock.locked_by };

    const lockedAt = new Date().toISOString();
    const created = await base44.asServiceRole.entities.PipelineLock.create({
        job_id: jobId,
        locked_at: lockedAt,
        expires_at: new Date(Date.now() + PIPELINE_LOCK_TTL_MS).toISOString(),
        locked_by: lockedBy
    });
    const createdLock = { ...created, job_id: jobId, locked_at: created.locked_at || lockedAt, locked_by: created.locked_by || lockedBy };

    // Creation is not a compare-and-set in the entity API. Let concurrent
    // creators become visible, then all invocations choose the same lock.
    await sleep(PIPELINE_LOCK_ELECTION_SETTLE_MS);
    let postCreateLocks;
    try {
        postCreateLocks = await base44.asServiceRole.entities.PipelineLock.filter({ job_id: jobId }, '-created_date', 100);
    } catch (error) {
        const released = await releasePipelineLock(base44, createdLock.id);
        return {
            claimed: false,
            reason: released ? 'lock_election_unverified' : 'lock_election_unverified_cleanup_failed',
            error: error.message
        };
    }

    const contenders = Array.isArray(postCreateLocks) ? postCreateLocks : (postCreateLocks?.items || []);
    return resolveCreatedPipelineLockElection({
        createdLock,
        contenders,
        nowMs: Date.now(),
        ttlMs: PIPELINE_LOCK_TTL_MS,
        releaseOwnLock: lockId => releasePipelineLock(base44, lockId)
    });
}

async function releasePipelineLock(base44, lockId) {
    if (!lockId) return true;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await base44.asServiceRole.entities.PipelineLock.delete(lockId);
            return true;
        } catch (error) {
            lastError = error;
            if (attempt === 0) await sleep(10);
        }
    }
    console.warn(`[processFetchChunk] Pipeline lock release failed for ${lockId}: ${lastError?.message || 'unknown error'}`);
    return false;
}

async function cancelProcessingFetchJob(base44, job, canonicalJob, reason, detail = null) {
    const cancelledAt = new Date().toISOString();
    const message = reason === 'duplicate'
        ? `Duplicate pull coalesced into FetchJob ${canonicalJob.id} before provider work.`
        : reason === 'conflict'
            ? `Processor stopped because a different FetchJob ${canonicalJob.id} is already active.`
            : `Processor stopped because active-job election could not be verified${detail ? `: ${detail}` : '.'}`;
    try {
        await base44.asServiceRole.entities.FetchJob.update(job.id, {
            status: 'cancelled',
            error_message: message,
            completed_at: cancelledAt,
            dry_run_metadata: {
                ...(job.dry_run_metadata || {}),
                processor_election_stopped_at: cancelledAt,
                ...(canonicalJob?.id && reason === 'duplicate' ? { coalesced_into_job_id: canonicalJob.id } : {}),
                ...(canonicalJob?.id && reason === 'conflict' ? { conflicting_active_job_id: canonicalJob.id } : {}),
                processor_election_reason: reason
            },
            error_log: [...(job.error_log || []), `[${cancelledAt}] ${message}`]
        });
        return true;
    } catch (error) {
        console.warn(`[processFetchChunk] FetchJob election cleanup failed for ${job.id}: ${error.message}`);
        return false;
    }
}

async function verifyCanonicalProcessingFetchJob(base44, job) {
    const electionKey = job?.dry_run_metadata?.pull_election_key;
    if (!job?.user_email) {
        const cancelledOwnJob = await cancelProcessingFetchJob(base44, job, null, 'unverified', 'job owner is missing');
        return {
            isWinner: false,
            canonicalJob: null,
            cancelledOwnJob,
            reason: cancelledOwnJob ? 'fetch_job_election_unverified' : 'fetch_job_election_unverified_cleanup_failed'
        };
    }

    // This is deliberately later than startBatchDataPull's post-create check.
    // It closes the normal visibility gap before any BatchData request is sent.
    await sleep(FETCH_JOB_PROCESSOR_ELECTION_SETTLE_MS);
    let running;
    let pending;
    let refreshedJob;
    try {
        [running, pending, refreshedJob] = await Promise.all([
            base44.asServiceRole.entities.FetchJob.filter({ user_email: job.user_email, status: 'running' }, 'created_date', 100),
            base44.asServiceRole.entities.FetchJob.filter({ user_email: job.user_email, status: 'pending' }, 'created_date', 100),
            base44.asServiceRole.entities.FetchJob.get(job.id)
        ]);
    } catch (error) {
        const cancelledOwnJob = await cancelProcessingFetchJob(base44, job, null, 'unverified', error.message);
        return {
            isWinner: false,
            canonicalJob: null,
            cancelledOwnJob,
            reason: cancelledOwnJob ? 'fetch_job_election_unverified' : 'fetch_job_election_unverified_cleanup_failed'
        };
    }

    if (!refreshedJob || !['pending', 'running'].includes(refreshedJob.status)) {
        const canonicalJobId = refreshedJob?.dry_run_metadata?.coalesced_into_job_id || null;
        return {
            isWinner: false,
            canonicalJob: canonicalJobId ? { id: canonicalJobId } : null,
            cancelledOwnJob: refreshedJob?.status === 'cancelled',
            reason: `job_${refreshedJob?.status || 'inactive'}`
        };
    }

    const runningList = Array.isArray(running) ? running : (running?.items || []);
    const pendingList = Array.isArray(pending) ? pending : (pending?.items || []);
    return resolveProcessingFetchJobElection({
        processingJob: refreshedJob,
        contenders: [...runningList, ...pendingList],
        electionKey,
        cancelOwnJob: (loser, canonicalJob, reason) => cancelProcessingFetchJob(base44, loser, canonicalJob, reason)
    });
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
    const boundaryToleranceDegrees = 5e-6;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = Number(polygon[i].lng), yi = Number(polygon[i].lat);
        const xj = Number(polygon[j].lng), yj = Number(polygon[j].lat);
        const dx = xj - xi;
        const dy = yj - yi;
        const lengthSquared = (dx * dx) + (dy * dy);
        if (lengthSquared > 0) {
            const projection = Math.max(0, Math.min(1, (((point.lng - xi) * dx) + ((point.lat - yi) * dy)) / lengthSquared));
            const projectedLng = xi + (projection * dx);
            const projectedLat = yi + (projection * dy);
            if (Math.hypot(point.lng - projectedLng, point.lat - projectedLat) <= boundaryToleranceDegrees) return true;
        }
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

function marketDateOnly(referenceMs = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: PROVIDER_MARKET_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date(referenceMs));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function requestedClosedSaleWindow(job) {
    return closedDayWindow(
        marketDateOnly(jobReferenceTimeMs(job)),
        soldWindowDays(job?.sold_months || 12)
    );
}

function clampInteger(value, fallback, min, max) {
    const parsed = Number(value);
    const safe = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
    return Math.min(Math.max(safe, min), max);
}

function hasUsablePolygon(points) {
    if (!Array.isArray(points)) return false;
    const distinct = new Set();
    for (const point of points) {
        const lat = Number(point?.lat ?? point?.latitude);
        const lng = Number(point?.lng ?? point?.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            distinct.add(`${lat.toFixed(7)},${lng.toFixed(7)}`);
        }
    }
    return distinct.size >= 3;
}

function closePolygonLatLng(points) {
    return closePolygon(points).map(point => ({ lat: point.latitude, lng: point.longitude }));
}

function batchDataRecordProperty(record) {
    return unwrapBatchDataProperty(record);
}

function batchDataTypeFields(record) {
    const p = batchDataRecordProperty(record);
    const general = p.general || p.property || p.propertyInfo || {};
    const building = p.building || p.structure || p.propertyInfo || p.assessment?.building || p.assessor?.building || {};
    const address = normalizeBatchDataAddress(p);
    const quickLists = p.quickLists || {};
    const addressHasUnit = hasAddressUnitMarker(address.street);
    const inferredDisallowedType = quickLists.vacantLot
        ? 'Vacant Land'
        : addressHasUnit
            ? 'Condo/Multi-Family'
            : null;
    const landUse = firstValue(general.standardizedLandUseCode, p.standardizedLandUseCode, general.landUseCode, p.landUseCode);
    const propertyTypeCandidates = [
        general.propertyTypeDetail,
        general.propertyType,
        p.propertyType,
        p.landUse,
        building.propertyType,
        inferredDisallowedType
    ];
    const propertyType = resolveSingleFamilyMetadata(landUse, propertyTypeCandidates).propertyType;
    return {
        land_use: landUse || 'missing',
        property_type: propertyType || 'missing',
        combined: `${landUse || 'missing'} | ${propertyType || 'missing'}`
    };
}

function addFrequency(map, value) {
    const key = String(value || 'missing');
    map[key] = (map[key] || 0) + 1;
}

function frequencyTable(map, total, fieldName) {
    return Object.entries(map)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({
            [fieldName]: value,
            count,
            pct: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0
        }));
}

function summarizeTypeFrequencies(records) {
    const landUse = {};
    const propertyType = {};
    const combined = {};
    for (const record of records) {
        const fields = batchDataTypeFields(record);
        addFrequency(landUse, fields.land_use);
        addFrequency(propertyType, fields.property_type);
        addFrequency(combined, fields.combined);
    }
    return {
        land_use_frequency: frequencyTable(landUse, records.length, 'land_use'),
        property_type_frequency: frequencyTable(propertyType, records.length, 'property_type'),
        combined_frequency: frequencyTable(combined, records.length, 'combined')
    };
}

function intelLastSoldDate(record) {
    return isoDateOnly(batchDataRecordProperty(record).intel?.lastSoldDate);
}

function batchDataLatestSaleDateDetailFromProperty(p, options = {}) {
    return selectRecentSaleEvidence(p || {}, options);
}

function batchDataLatestSaleDateFromProperty(p) {
    return batchDataLatestSaleDateDetailFromProperty(p).saleDate;
}

function batchDataProviderSaleDate(record) {
    return batchDataLatestSaleDateFromProperty(batchDataRecordProperty(record));
}

function summarizeIntelLastSoldDates(records, soldMinDate) {
    const dates = [];
    let intelDatesPresent = 0;
    let intelDatesAbsent = 0;
    let providerDatesPresent = 0;
    let providerDatesAbsent = 0;
    let inWindow = 0;
    let outsideWindow = 0;

    for (const record of records) {
        const intelDate = intelLastSoldDate(record);
        const providerDate = batchDataProviderSaleDate(record);
        const date = providerDate || intelDate;
        if (intelDate) intelDatesPresent++;
        else intelDatesAbsent++;
        if (providerDate) providerDatesPresent++;
        else providerDatesAbsent++;
        if (!date) {
            continue;
        }
        dates.push(date);
        if (soldMinDate && date < soldMinDate) outsideWindow++;
        else inWindow++;
    }

    const sortedDates = dates.slice().sort();
    return {
        intel_last_sold_date_present: intelDatesPresent,
        intel_last_sold_date_absent: intelDatesAbsent,
        provider_sale_date_present: providerDatesPresent,
        provider_sale_date_absent: providerDatesAbsent,
        in_window: inWindow,
        outside_window: outsideWindow,
        date_range_observed: {
            earliest: sortedDates[0] || null,
            newest: sortedDates[sortedDates.length - 1] || null
        },
        silent_ignore_indicator: outsideWindow > 0
            ? 'WARNING: BatchData returned sale evidence outside the requested minDate window.'
            : null,
        date_source_note: intelDatesPresent > 0
            ? 'intel.lastSoldDate present in sampled records.'
            : providerDatesPresent > 0
                ? 'intel.lastSoldDate absent; using returned sale/open-lien recording fields to validate date window.'
                : 'No returned sale date field was present in sampled records.'
    };
}

function rawDiscoverySample(record) {
    const p = batchDataRecordProperty(record);
    return {
        address: firstValue(p.formattedAddress, p.address?.street, p.address?.streetAddress, p.addressLine1),
        field_paths: {
            'property.general.standardizedLandUseCode': p.general?.standardizedLandUseCode ?? null,
            'property.general.propertyTypeDetail': p.general?.propertyTypeDetail ?? null,
            'property.general.propertyType': p.general?.propertyType ?? null,
            'property.propertyType': p.propertyType ?? null,
            'property.landUse': p.landUse ?? null,
            'property.intel.lastSoldDate': p.intel?.lastSoldDate ?? null,
            'property.intel.lastSoldPrice': p.intel?.lastSoldPrice ?? null,
            'property.quickLists.recentlySold': p.quickLists?.recentlySold ?? null,
            'property.quickLists.vacantLot': p.quickLists?.vacantLot ?? null,
            'property.openLien.firstLoanRecordingDate': p.openLien?.firstLoanRecordingDate ?? null,
            'property.openLien.lastLoanRecordingDate': p.openLien?.lastLoanRecordingDate ?? null,
            'property.sale.lastSaleDate': firstValue(p.sale?.lastSaleDate, p.sale?.saleDate, p.lastSaleDate) ?? null,
            'property.sale.lastSale.mortgages[0].recordingDate': p.sale?.lastSale?.mortgages?.[0]?.recordingDate ?? null,
            'property.mortgageHistory[0].saleDate': p.mortgageHistory?.[0]?.saleDate ?? null,
            'property.mortgageHistory[0].recordingDate': p.mortgageHistory?.[0]?.recordingDate ?? null
        },
        full_raw_payload: record
    };
}

function buildBatchDataAreaPayload({
    polygon,
    city,
    state,
    soldMinDate = null,
    take = 25,
    skip = 0,
    includeR2 = false,
    coordinateFormat = 'latitude_longitude'
}) {
    const searchCriteria = {};
    if (hasUsablePolygon(polygon)) {
        searchCriteria.address = {
            geoLocationPolygon: {
                geoPoints: coordinateFormat === 'lat_lng' ? closePolygonLatLng(polygon) : closePolygon(polygon)
            }
        };
    } else {
        const place = String(city || '').trim();
        const stateCode = String(state || '').trim().toUpperCase();
        if (!place || !stateCode) {
            throw new Error('A polygon or city/state is required for BatchData diagnostics.');
        }
        searchCriteria.address = {
            city: { equals: place },
            state: { equals: stateCode }
        };
    }

    applyRecentSaleSearchFilter(searchCriteria, soldMinDate);
    if (includeR2) searchCriteria.general = { standardizedLandUseCode: { equals: 'R2' } };

    return {
        searchCriteria,
        options: {
            skip: clampInteger(skip, 0, 0, 1000000),
            take: clampBatchDataTake(take, 25),
            datasets: BATCHDATA_SEARCH_DATASETS
        }
    };
}

function pctString(count, total) {
    return total > 0 ? `${((count / total) * 100).toFixed(1)}%` : 'N/A';
}

function incrementCount(map, key) {
    const safeKey = String(key ?? 'missing');
    map[safeKey] = (map[safeKey] || 0) + 1;
}

function buildBatchDataAreaSearchCriteria({ polygon, city, state, query }) {
    if (hasUsablePolygon(polygon)) {
        return {
            address: {
                geoLocationPolygon: {
                    geoPoints: closePolygon(polygon)
                }
            }
        };
    }

    const safeQuery = String(query || '').trim();
    if (safeQuery) return { query: safeQuery };

    const place = String(city || '').trim();
    const stateCode = String(state || '').trim().toUpperCase();
    if (!place || !stateCode) {
        throw new Error('Provide polygon, query, or city/state for BatchData diagnostics.');
    }

    return {
        address: {
            city: { equals: place },
            state: { equals: stateCode }
        }
    };
}

function applyBatchDataDateFilter(searchCriteria, dateFilter, soldMinDate) {
    if (!dateFilter || !soldMinDate) return searchCriteria;
    if (dateFilter === 'intel.lastSoldDate') {
        searchCriteria.intel = { lastSoldDate: { minDate: soldMinDate } };
    } else if (dateFilter === 'sale.lastSaleDate') {
        searchCriteria.sale = { lastSaleDate: { minDate: soldMinDate } };
    } else {
        throw new Error(`Unsupported BatchData date filter: ${dateFilter}`);
    }
    return searchCriteria;
}

function buildBatchDataSearchPayload({
    polygon,
    city,
    state,
    query,
    dateFilters = [],
    soldMinDate = null,
    quickListsRecentlySold = false,
    datasets = BATCHDATA_SEARCH_DATASETS,
    take = BATCHDATA_MAX_TAKE,
    skip = 0
}) {
    const searchCriteria = buildBatchDataAreaSearchCriteria({ polygon, city, state, query });
    for (const dateFilter of Array.isArray(dateFilters) ? dateFilters : [dateFilters]) {
        applyBatchDataDateFilter(searchCriteria, dateFilter, soldMinDate);
    }
    if (quickListsRecentlySold) {
        searchCriteria.quickLists = [
            ...(Array.isArray(searchCriteria.quickLists) ? searchCriteria.quickLists : []),
            'recently-sold'
        ];
    }

    return {
        searchCriteria,
        options: {
            skip: clampInteger(skip, 0, 0, 1000000),
            take: clampInteger(take, BATCHDATA_MAX_TAKE, 0, MAX_AVAILABLE_TAKE),
            datasets
        }
    };
}

function endpointComparisonVariantPayloads({ polygon, city, state, query, soldMinDate, take }) {
    const base = { polygon, city, state, query, soldMinDate, take, skip: 0 };
    return {
        A: {
            description: 'search_intel_lastSoldDate_valid_dataset_contract',
            payload: buildBatchDataSearchPayload({
                ...base,
                dateFilters: ['intel.lastSoldDate'],
                datasets: BATCHDATA_SEARCH_DATASETS
            })
        },
        B: {
            description: 'search_intel_lastSoldDate_core_only',
            payload: buildBatchDataSearchPayload({
                ...base,
                dateFilters: ['intel.lastSoldDate'],
                datasets: ['core']
            })
        },
        C: {
            description: 'search_quickLists_recentlySold_only',
            payload: buildBatchDataSearchPayload({
                ...base,
                dateFilters: [],
                quickListsRecentlySold: true,
                datasets: BATCHDATA_SEARCH_DATASETS
            })
        },
        D: {
            description: 'search_sale_lastSaleDate_documented_filter',
            payload: buildBatchDataSearchPayload({
                ...base,
                dateFilters: ['sale.lastSaleDate'],
                datasets: BATCHDATA_SEARCH_DATASETS
            })
        },
        E: {
            description: 'search_intel_lastSoldDate_and_sale_lastSaleDate',
            payload: buildBatchDataSearchPayload({
                ...base,
                dateFilters: ['intel.lastSoldDate', 'sale.lastSaleDate'],
                datasets: BATCHDATA_SEARCH_DATASETS
            })
        },
        F: {
            description: 'search_quickLists_recentlySold_plus_sale_lastSaleDate',
            payload: buildBatchDataSearchPayload({
                ...base,
                dateFilters: ['sale.lastSaleDate'],
                quickListsRecentlySold: true,
                datasets: BATCHDATA_SEARCH_DATASETS
            })
        },
        H: {
            description: 'count_only_sale_lastSaleDate_preflight',
            payload: buildBatchDataSearchPayload({
                ...base,
                dateFilters: ['sale.lastSaleDate'],
                datasets: ['core'],
                take: 0
            })
        }
    };
}

function diagnosticJobFromBody(body, soldMonths) {
    return {
        polygon: body.polygon || [],
        sold_months: soldMonths,
        dry_run_metadata: previewDryRunMetadata(body)
    };
}

function diagnosticSample(record, mapped = null) {
    const p = batchDataRecordProperty(record);
    const address = normalizeBatchDataAddress(p);
    return {
        address: [address.street, address.city, address.state, address.zip].filter(Boolean).join(', '),
        field_paths: rawDiscoverySample(record).field_paths,
        property_type_fields: batchDataTypeFields(record),
        mapped: mapped ? {
            route_active: mapped.route_active,
            property_type: mapped.property_type,
            sold_date: mapped.sold_date,
            sale_date_source: mapped.sale_date_source,
            rejection_reason: mapped.rejection_reason,
            metadata_completeness: mapped.metadata_completeness
        } : null
    };
}

function collectBatchDataDiagnosticMetrics(records, {
    variant,
    description = null,
    creditsUsed = null,
    providerTotal = null,
    job,
    soldMinDate = null
}) {
    const excludedRouteHashes = getExcludedRouteHashes(job);
    const total = records.length;
    const nullCounts = {
        intel_lastSoldDate: 0,
        general_standardizedLandUseCode: 0,
        propertyType: 0,
        landUse: 0
    };
    const fieldPresence = {
        quickLists_recentlySold_true: 0,
        openLien_firstLoanRecordingDate: 0,
        openLien_lastLoanRecordingDate: 0,
        sale_lastSale_mortgages_recordingDate: 0,
        intel_lastSoldDate: 0,
        sale_lastSaleDate: 0,
        date_evidence_present: 0,
        address_unit_indicator: 0
    };
    const quickListsDistribution = { true: 0, false: 0, null: 0 };
    const dateDistribution = {};
    const dateSourceDistribution = {};
    const rejectionReasons = {};
    const leadQuality = {
        confirmed: 0,
        ambiguous: 0,
        rejected: 0,
        already_routed: 0,
        production_passed: 0,
        date_outside_window: 0,
        missing_structured_classification: 0
    };
    const samples = {
        confirmed: [],
        ambiguous: [],
        rejected: []
    };

    for (const record of records) {
        const p = batchDataRecordProperty(record);
        const intel = p.intel || {};
        const general = p.general || {};
        const address = normalizeBatchDataAddress(p);
        const typeFields = batchDataTypeFields(record);
        const quickListsValue = p.quickLists?.recentlySold;
        const dateDetail = batchDataLatestSaleDateDetailFromProperty(p);
        const mapped = mapBatchDataProperty(record, job);
        const rawType = firstValue(general.propertyTypeDetail, general.propertyType, p.propertyType, p.landUse, p.building?.propertyType);
        const landUse = firstValue(general.standardizedLandUseCode, p.standardizedLandUseCode, general.landUseCode, p.landUseCode);
        const hasStructuredClassification = !!rawType || !!landUse;
        const explicitSfr = isExplicitSingleFamilyType(typeFields.property_type) || String(typeFields.land_use || '').toUpperCase() === 'R2';
        const addressHasUnit = hasAddressUnitMarker(address.street);

        if (intel.lastSoldDate === null || intel.lastSoldDate === undefined) nullCounts.intel_lastSoldDate++;
        if (general.standardizedLandUseCode === null || general.standardizedLandUseCode === undefined) nullCounts.general_standardizedLandUseCode++;
        if (!p.propertyType && !general.propertyType && !general.propertyTypeDetail) nullCounts.propertyType++;
        if (!p.landUse && !general.standardizedLandUseCode) nullCounts.landUse++;
        if (quickListsValue === true) {
            quickListsDistribution.true++;
            fieldPresence.quickLists_recentlySold_true++;
        } else if (quickListsValue === false) {
            quickListsDistribution.false++;
        } else {
            quickListsDistribution.null++;
        }
        if (p.openLien?.firstLoanRecordingDate) fieldPresence.openLien_firstLoanRecordingDate++;
        if (p.openLien?.lastLoanRecordingDate) fieldPresence.openLien_lastLoanRecordingDate++;
        if (p.sale?.lastSale?.mortgages?.[0]?.recordingDate) fieldPresence.sale_lastSale_mortgages_recordingDate++;
        if (intel.lastSoldDate) fieldPresence.intel_lastSoldDate++;
        if (firstValue(p.sale?.lastSaleDate, p.sale?.lastSale?.saleDate, p.sale?.saleDate, p.lastSaleDate)) fieldPresence.sale_lastSaleDate++;
        if (addressHasUnit) fieldPresence.address_unit_indicator++;

        if (dateDetail.saleDate) {
            fieldPresence.date_evidence_present++;
            incrementCount(dateSourceDistribution, dateDetail.saleDateSource);
            incrementCount(dateDistribution, String(dateDetail.saleDate).slice(0, 7));
            if (soldMinDate && dateDetail.saleDate < soldMinDate) leadQuality.date_outside_window++;
        }

        let bucket = 'rejected';
        let reason = null;
        if (!mapped) {
            reason = batchDataPreMapDropReason(record, job);
            incrementCount(rejectionReasons, reason);
            leadQuality.rejected++;
        } else if (excludedRouteHashes.has(mapped.address_hash)) {
            reason = 'already_routed';
            incrementCount(rejectionReasons, reason);
            leadQuality.already_routed++;
            leadQuality.rejected++;
        } else if (mapped.route_active === false) {
            reason = mapped.rejection_reason || 'local_filter_rejected';
            incrementCount(rejectionReasons, reason);
            leadQuality.rejected++;
        } else {
            leadQuality.production_passed++;
            if (!hasStructuredClassification) leadQuality.missing_structured_classification++;
            if (explicitSfr && mapped.sale_confidence === 'verified') {
                bucket = 'confirmed';
                leadQuality.confirmed++;
            } else {
                bucket = 'ambiguous';
                reason = !hasStructuredClassification ? 'missing_structured_classification' : 'weak_sfr_evidence';
                incrementCount(rejectionReasons, reason);
                leadQuality.ambiguous++;
            }
        }

        if (samples[bucket].length < 3) {
            samples[bucket].push({
                ...diagnosticSample(record, mapped),
                classification_reason: reason
            });
        }
    }

    return {
        variant,
        description,
        estimated_record_units: creditsUsed ?? total,
        billing_status: 'unverified_confirm_in_batchdata_dashboard',
        records_returned: total,
        provider_total: providerTotal,
        null_rates: {
            intel_lastSoldDate: pctString(nullCounts.intel_lastSoldDate, total),
            general_standardizedLandUseCode: pctString(nullCounts.general_standardizedLandUseCode, total),
            propertyType: pctString(nullCounts.propertyType, total),
            landUse: pctString(nullCounts.landUse, total)
        },
        field_presence: {
            ...fieldPresence,
            date_evidence_present_rate: pctString(fieldPresence.date_evidence_present, total),
            address_unit_indicator_rate: pctString(fieldPresence.address_unit_indicator, total)
        },
        quickLists_distribution: quickListsDistribution,
        date_distribution: Object.entries(dateDistribution)
            .sort((a, b) => b[0].localeCompare(a[0]))
            .map(([year_month, count]) => ({ year_month, count })),
        date_source_distribution: Object.entries(dateSourceDistribution)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([source, count]) => ({ source, count })),
        local_filter: {
            passed: leadQuality.production_passed,
            rejected: Math.max(0, total - leadQuality.production_passed),
            pass_rate: pctString(leadQuality.production_passed, total),
            rejection_reasons: rejectionReasons
        },
        lead_quality: {
            ...leadQuality,
            confirmed_rate: pctString(leadQuality.confirmed, total),
            ambiguous_rate: pctString(leadQuality.ambiguous, total),
            rejected_rate: pctString(leadQuality.rejected, total)
        },
        samples
    };
}

function batchDataLookupAddressFromRecord(record) {
    const p = batchDataRecordProperty(record);
    const address = normalizeBatchDataAddress(p);
    return {
        street: address.street,
        city: address.city,
        state: address.state,
        zip: address.zip
    };
}

function buildBatchDataLookupPayload(address, datasets = BATCHDATA_SEARCH_DATASETS, requestId = null) {
    return {
        requests: [{
            address: {
                street: address.street,
                city: address.city,
                state: address.state,
                zip: address.zip
            },
            ...(requestId ? { requestId } : {})
        }],
        options: { datasets }
    };
}

function compareLookupFieldPopulation(searchRecord, lookupRecord) {
    const s = batchDataRecordProperty(searchRecord || {});
    const l = batchDataRecordProperty(lookupRecord || {});
    const searchLatestSale = batchDataLatestSaleDateDetailFromProperty(s);
    const lookupLatestSale = batchDataLatestSaleDateDetailFromProperty(l);
    const fields = {
        'intel.lastSoldDate': [s.intel?.lastSoldDate, l.intel?.lastSoldDate],
        'intel.lastSoldPrice': [s.intel?.lastSoldPrice, l.intel?.lastSoldPrice],
        'general.standardizedLandUseCode': [s.general?.standardizedLandUseCode, l.general?.standardizedLandUseCode],
        'general.propertyTypeDetail': [s.general?.propertyTypeDetail, l.general?.propertyTypeDetail],
        'propertyType': [s.propertyType, l.propertyType],
        'landUse': [s.landUse, l.landUse],
        'quickLists.recentlySold': [s.quickLists?.recentlySold, l.quickLists?.recentlySold],
        'openLien.firstLoanRecordingDate': [s.openLien?.firstLoanRecordingDate, l.openLien?.firstLoanRecordingDate],
        'sale.lastSale.mortgages[0].recordingDate': [s.sale?.lastSale?.mortgages?.[0]?.recordingDate, l.sale?.lastSale?.mortgages?.[0]?.recordingDate],
        'building.bedroomCount': [s.building?.bedroomCount, l.building?.bedroomCount],
        'building.bathroomCount': [s.building?.bathroomCount, l.building?.bathroomCount],
        'building.livingAreaSquareFeet': [s.building?.livingAreaSquareFeet, l.building?.livingAreaSquareFeet],
        'owner.ownerOccupied': [s.owner?.ownerOccupied, l.owner?.ownerOccupied],
        'best_available_sale_date': [searchLatestSale.saleDate, lookupLatestSale.saleDate],
        'best_available_sale_date_source': [searchLatestSale.saleDateSource, lookupLatestSale.saleDateSource]
    };

    const comparison = {};
    let searchNonNull = 0;
    let lookupNonNull = 0;
    for (const [path, [searchValue, lookupValue]] of Object.entries(fields)) {
        if (searchValue !== undefined && searchValue !== null && searchValue !== '') searchNonNull++;
        if (lookupValue !== undefined && lookupValue !== null && lookupValue !== '') lookupNonNull++;
        comparison[path] = {
            search_value: searchValue ?? null,
            lookup_value: lookupValue ?? null,
            populated_in_search: searchValue !== undefined && searchValue !== null && searchValue !== '',
            populated_in_lookup: lookupValue !== undefined && lookupValue !== null && lookupValue !== ''
        };
    }
    return { comparison, searchNonNull, lookupNonNull };
}

async function runBatchDataLookupEnrichment(searchRecords, addresses, datasets, limit) {
    const selected = Array.isArray(addresses) && addresses.length > 0
        ? addresses.slice(0, limit).map(address => ({ address, searchRecord: null }))
        : searchRecords.slice(0, limit).map(record => ({ address: batchDataLookupAddressFromRecord(record), searchRecord: record }));
    const results = [];
    let apiRequests = 0;

    for (const item of selected) {
        const address = item.address || {};
        if (!address.street || !address.city || !address.state) {
            results.push({ address, error: 'missing_lookup_address_parts' });
            continue;
        }
        try {
            const payload = buildBatchDataLookupPayload(address, datasets, `lookup-${results.length + 1}`);
            apiRequests++;
            const response = await batchDataLookupWithRetry(payload);
            const records = extractBatchDataRecords(response);
            const lookupRecord = records[0]?.property || records[0] || null;
            if (!lookupRecord) {
                results.push({ address, request: payload, error: 'no_lookup_record_returned' });
                continue;
            }
            const fieldPopulation = compareLookupFieldPopulation(item.searchRecord, lookupRecord);
            results.push({
                address,
                request: payload,
                field_comparison: fieldPopulation.comparison,
                total_non_null_fields_search: fieldPopulation.searchNonNull,
                total_non_null_fields_lookup: fieldPopulation.lookupNonNull,
                lookup_delta: fieldPopulation.lookupNonNull - fieldPopulation.searchNonNull,
                lookup_samples: diagnosticSample(lookupRecord, null)
            });
        } catch (error) {
            results.push({ address, error: String(error?.message || error) });
        }
        await sleep(300);
    }

    return {
        api_requests: apiRequests,
        billing_credits: null,
        billing_status: 'unverified_confirm_in_batchdata_dashboard',
        addresses_processed: selected.length,
        results,
        summary: {
            addresses_with_lookup_data: results.filter(result => !result.error).length,
            addresses_with_intel_lastSoldDate: results.filter(result => result.field_comparison?.['intel.lastSoldDate']?.populated_in_lookup).length,
            addresses_with_landUseCode: results.filter(result => result.field_comparison?.['general.standardizedLandUseCode']?.populated_in_lookup).length,
            addresses_with_propertyTypeDetail: results.filter(result => result.field_comparison?.['general.propertyTypeDetail']?.populated_in_lookup).length,
            addresses_with_positive_field_delta: results.filter(result => Number(result.lookup_delta) > 0).length,
            enrichment_capability: results.some(result => Number(result.lookup_delta) > 0)
                ? 'LOOKUP_ADDS_FIELDS'
                : 'LOOKUP_DID_NOT_ADD_FIELDS'
        }
    };
}

function placeSearchLabel(job) {
    const parts = batchDataPlaceParts(job);
    return parts ? `${parts.place}, ${parts.state}` : null;
}

function batchDataPlaceParts(job) {
    const countyResolution = job?.dry_run_metadata?.county_resolution || {};
    const state = String(firstValue(
        job?.dry_run_metadata?.batchdata_state,
        job?.dry_run_metadata?.state_code,
        job?.state,
        countyResolution.state_code
    ) || '').trim().toUpperCase();
    const rawPlace = String(firstValue(
        job?.dry_run_metadata?.batchdata_place,
        job?.dry_run_metadata?.place_name,
        job?.dry_run_metadata?.city,
        job?.city,
        countyResolution.city,
        countyResolution.county_name
    ) || '').trim();
    const place = rawPlace
        .replace(/\s+(county|parish|borough|census area|municipality)$/i, '')
        .trim();
    if (!place || !state) return null;
    return { place, state };
}

function previewDryRunMetadata(body = {}) {
    const existing = body.dry_run_metadata && typeof body.dry_run_metadata === 'object' ? body.dry_run_metadata : {};
    const existingFilters = existing.filters && typeof existing.filters === 'object' ? existing.filters : {};
    const countyResolution = existing.county_resolution && typeof existing.county_resolution === 'object'
        ? existing.county_resolution
        : {};
    return {
        ...existing,
        county_resolution: {
            ...countyResolution,
            county_name: firstValue(countyResolution.county_name, body.county_name, body.place, body.city),
            state_code: firstValue(countyResolution.state_code, body.state_code, body.state)
        },
        batchdata_place: firstValue(existing.batchdata_place, body.batchdata_place, body.place, body.city),
        batchdata_state: firstValue(existing.batchdata_state, body.batchdata_state, body.state_code, body.state),
        filters: {
            ...existingFilters,
            min_price: Math.max(
                DEFAULT_PRECISION_MIN_HOME_VALUE,
                Number(body.min_price ?? existingFilters.min_price ?? DEFAULT_PRECISION_MIN_HOME_VALUE) || DEFAULT_PRECISION_MIN_HOME_VALUE
            ),
            max_price: body.max_price ?? existingFilters.max_price ?? null
        }
    };
}

function applyProviderNarrowingFilters(searchCriteria, job) {
    const filters = job.dry_run_metadata?.filters || {};
    return applyBatchDataQualificationFilters(searchCriteria, {
        minEstimatedValue: filters.min_price,
        maxEstimatedValue: filters.max_price,
        excludeListingStatusCategories: ['Active', 'Pending']
    });
}

function recentSaleSourceForMode(mode) {
    return String(mode || '').includes('intel') ? 'intel' : 'sale';
}

function batchDataSearchEvidence(job, mode) {
    const filters = job?.dry_run_metadata?.filters || {};
    const requestedMin = Number(filters.min_price);
    const requestedMax = Number(filters.max_price);
    const qualificationFiltersApplied = String(mode || '').includes('qualified');
    const closedWindow = requestedClosedSaleWindow(job);
    const referenceDate = closedWindow.maxDate;
    const soldMinDate = closedWindow.minDate;
    return {
        standardized_land_use_code: qualificationFiltersApplied ? 'R2' : null,
        valuation_estimated_value_min: qualificationFiltersApplied
            ? (Number.isFinite(requestedMin) && requestedMin > 0
                ? Math.max(DEFAULT_PRECISION_MIN_HOME_VALUE, requestedMin)
                : DEFAULT_PRECISION_MIN_HOME_VALUE)
            : null,
        valuation_estimated_value_max: qualificationFiltersApplied && Number.isFinite(requestedMax) && requestedMax > 0
            ? requestedMax
            : null,
        listing_status_categories_excluded: qualificationFiltersApplied ? ['Active', 'Pending'] : [],
        recent_sale_sources: [recentSaleSourceForMode(mode)],
        recent_sale_min_date: soldMinDate,
        recent_sale_max_date: referenceDate,
        request_contract: 'batchdata_property_search_v1'
    };
}

function annotateBatchDataSearchRecord(record, job, mode) {
    const property = batchDataRecordProperty(record);
    const existingInternal = property?._firstknock && typeof property._firstknock === 'object' ? property._firstknock : {};
    const existingEvidence = existingInternal.search_evidence && typeof existingInternal.search_evidence === 'object'
        ? existingInternal.search_evidence
        : {};
    const nextEvidence = batchDataSearchEvidence(job, mode);
    const recentSaleSources = [...new Set([
        ...(Array.isArray(existingEvidence.recent_sale_sources) ? existingEvidence.recent_sale_sources : []),
        ...nextEvidence.recent_sale_sources
    ])];
    return {
        ...property,
        _firstknock: {
            ...existingInternal,
            search_evidence: {
                ...existingEvidence,
                ...nextEvidence,
                recent_sale_sources: recentSaleSources
            }
        }
    };
}

function buildBatchDataRequest(job, skip = 0, take = BATCHDATA_MAX_TAKE, mode = 'broad_polygon', pageCursor = null, useCursorPagination = false) {
    // Always compute the sold window date filter for every BatchData mode.
    const closedWindow = requestedClosedSaleWindow(job);
    const soldMinDate = closedWindow.minDate;
    const soldMaxDate = closedWindow.maxDate;

    const options = {
        take: clampBatchDataTake(take, BATCHDATA_MAX_TAKE),
        datasets: BATCHDATA_SEARCH_DATASETS,
        ...(useCursorPagination
            ? { useCursorPagination: true, ...(pageCursor ? { pageCursor } : {}) }
            : { skip: clampInteger(skip, 0, 0, 1000000) })
    };

    if (mode === 'centroid_fallback') {
        const searchCriteria = { query: `${job.latitude},${job.longitude}` };
        applyRecentSaleSearchFilter(searchCriteria, soldMinDate, recentSaleSourceForMode(mode), soldMaxDate);
        if (String(mode).includes('qualified')) applyProviderNarrowingFilters(searchCriteria, job);
        return {
            searchCriteria,
            options
        };
    }

    if (mode === 'support_query_place') {
        const query = placeSearchLabel(job);
        if (!query) return null;
        const searchCriteria = { query };
        applyRecentSaleSearchFilter(searchCriteria, soldMinDate, recentSaleSourceForMode(mode), soldMaxDate);
        if (String(mode).includes('qualified')) applyProviderNarrowingFilters(searchCriteria, job);
        return {
            searchCriteria,
            options
        };
    }

    if (mode === 'support_structured_place') {
        const parts = batchDataPlaceParts(job);
        if (!parts) return null;
        const searchCriteria = {
            address: {
                city: { equals: parts.place },
                state: { equals: parts.state }
            }
        };
        applyRecentSaleSearchFilter(searchCriteria, soldMinDate, recentSaleSourceForMode(mode), soldMaxDate);
        if (String(mode).includes('qualified')) applyProviderNarrowingFilters(searchCriteria, job);
        return {
            searchCriteria,
            options
        };
    }

    const searchCriteria = {
        address: {
            geoLocationPolygon: {
                geoPoints: closePolygon(job.polygon || [])
            }
        }
    };
    applyRecentSaleSearchFilter(searchCriteria, soldMinDate, recentSaleSourceForMode(mode), soldMaxDate);
    if (String(mode).includes('qualified')) applyProviderNarrowingFilters(searchCriteria, job);

    return { searchCriteria, options };
}

function extractBatchDataRecords(payload) {
    const candidates = [
        payload?.results?.properties,
        payload?.results?.items,
        payload?.results?.requests,
        payload?.results?.data,
        payload?.properties,
        payload?.items,
        payload?.requests,
        payload?.data?.properties,
        payload?.data?.items,
        payload?.data?.results?.properties,
        payload?.data?.results,
        payload?.results
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            return candidate
                .map(item => item?.property ? item : (item?.result || item?.results || item?.data || item))
                .filter(Boolean);
        }
        if (candidate && typeof candidate === 'object') {
            const recordLike = candidate.property || candidate.result?.property || candidate.results?.property || candidate.data?.property || candidate.address;
            if (recordLike) return [candidate];
        }
    }

    if (payload?.property || payload?.address) return [payload];
    return [];
}

function extractBatchDataTotal(payload) {
    const rawTotal = payload?.results?.meta?.results?.resultsFound ??
        payload?.results?.totalRecordCount ??
        payload?.totalRecordCount ??
        payload?.meta?.totalRecordCount ??
        payload?.meta?.resultsFound;
    if (rawTotal === null || rawTotal === undefined || rawTotal === '') return null;
    const total = Number(rawTotal);
    return Number.isFinite(total) ? total : null;
}

function extractBatchDataNextPageCursor(payload) {
    return firstValue(
        payload?.results?.nextPageCursor,
        payload?.nextPageCursor,
        payload?.data?.results?.nextPageCursor,
        payload?.data?.nextPageCursor
    ) || null;
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
    const p = batchDataRecordProperty(record);
    const address = normalizeBatchDataAddress(p);
    if (!address.street || !address.zip || !Number.isFinite(address.lat) || !Number.isFinite(address.lng)) return null;
    if (!isPointInPolygon({ lat: address.lat, lng: address.lng }, job.polygon || [])) return null;

    const owner = p.owner || {};
    const listing = p.listing || {};
    const intel = p.intel || {};
    const building = p.building || p.structure || p.propertyInfo || p.assessment?.building || p.assessor?.building || {};
    const sale = p.sale || p.lastSale || p.deed?.sale || p.transaction || {};
    const lastSale = sale.lastSale || sale.lastTransfer || sale;
    const valuation = p.valuation || p.avm || p.estimatedValue || p.assessment?.valuation || p.assessor?.valuation || {};
    const general = p.general || p.property || p.propertyInfo || {};
    const ids = p.ids || p.identifiers || {};
    const providerSearchEvidence = p?._firstknock?.search_evidence || {};
    const listingStatus = firstValue(listing.status, listing.statusCategory);
    const listingStatusLower = String(listingStatus || '').toLowerCase();
    const closedWindow = requestedClosedSaleWindow(job);
    const referenceDate = closedWindow.maxDate;
    const saleDateDetail = batchDataLatestSaleDateDetailFromProperty(p, { maxDate: referenceDate });
    const saleDate = saleDateDetail.saleDate;
    const saleDateSource = saleDateDetail.saleDateSource;
    const saleDateConfidence = saleDateDetail.saleDateConfidence || 'none';
    const saleDateMs = saleDate ? new Date(saleDate).getTime() : 0;
    const hasValidSaleDate = saleDateMs > 0 && !Number.isNaN(saleDateMs);
    const saleDateOnly = isoDateOnly(saleDate);
    const cutoffDate = closedWindow.minDate;
    const isSoldInWindow = isSaleDateWithinWindow(saleDateOnly, cutoffDate, referenceDate);
    const ownerName = firstValue(owner.fullName, owner.name, owner.ownerName, owner.names?.[0]?.full, owner.names?.[0]?.name, owner.names?.[0]);
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
        p.lastSale?.amount,
        p.lastSale?.price,
        p.lastSale?.salePrice,
        p.deed?.sale?.amount,
        p.deed?.sale?.price,
        p.deed?.sale?.salePrice,
        p.transaction?.amount,
        p.transaction?.price,
        p.transaction?.salePrice,
        p.lastSalePrice
    );
    const estimatedValue = numberValue(
        valuation.estimatedValue, valuation.estimatedMarketValue, valuation.avm, valuation.avmValue,
        intel.estimatedValue, intel.estimatedMarketValue, intel.avm, intel.avmValue, intel.estValue,
        p.estimatedValue, p.estimated_value, p.avm, p.avmValue
    );
    // Canonical `price` means estimated home value for Precision routing. Sale
    // consideration and listing ask are different concepts and must never be
    // substituted to satisfy the $100k home-value policy.
    const price = estimatedValue;
    const returnedLandUseCode = firstValue(general.standardizedLandUseCode, p.standardizedLandUseCode, general.landUseCode, p.landUseCode);
    const providerR2Evidence = String(providerSearchEvidence.standardized_land_use_code || '').toUpperCase() === 'R2';
    const landUseCode = firstValue(returnedLandUseCode, providerR2Evidence ? 'R2' : null);
    const addressHasUnit = hasAddressUnitMarker(address.street);
    const inferredDisallowedPropertyType = p.quickLists?.vacantLot
        ? 'Vacant Land'
        : addressHasUnit
            ? 'Condo/Multi-Family'
            : null;
    const rawPropertyTypeCandidates = [
        general.propertyTypeDetail,
        general.propertyType,
        p.propertyType,
        p.landUse,
        building.propertyType
    ].filter(value => value !== undefined && value !== null && String(value).trim() !== '');
    const propertyTypeCandidates = inferredDisallowedPropertyType
        ? [...rawPropertyTypeCandidates, inferredDisallowedPropertyType]
        : rawPropertyTypeCandidates;
    const typeResolution = resolveSingleFamilyMetadata(landUseCode, propertyTypeCandidates);
    const rawPropertyType = typeResolution.explicitSingleFamilyType || rawPropertyTypeCandidates[0] || inferredDisallowedPropertyType;
    const hasExplicitSingleFamilyEvidence = typeResolution.hasExplicitSingleFamilyEvidence;
    const propertyType = typeResolution.propertyType || (landUseCode ? `BatchData ${landUseCode}` : 'Unknown Residential Type (Unverified)');
    const propertyTypeText = normalizePropertyTypeText(propertyType);
    const landUseText = normalizePropertyTypeText(landUseCode);
    const combinedTypeText = normalizePropertyTypeText(`${propertyTypeCandidates.join(' ')} ${propertyType} ${landUseCode || ''}`);
    // Keep route quality high without depending entirely on BatchData's R2 code.
    const explicitlySingleFamily = isExplicitSingleFamilyType(propertyTypeText);
    const disallowedTypeKeywords = [...COMMERCIAL_TYPE_KEYWORDS, ...CONDO_MULTI_TYPE_KEYWORDS, ...LAND_TYPE_KEYWORDS, 'daycare', 'child care', 'church', 'school', 'parking', 'exempt', 'government'];
    const nonResidential = includesAnyPropertyType(combinedTypeText, disallowedTypeKeywords);
    const nonR2WithoutSingleFamilyEvidence = !!landUseCode && String(landUseCode).toUpperCase() !== 'R2' && !explicitlySingleFamily;
    const landUseRejected = includesAnyPropertyType(landUseText, disallowedTypeKeywords) || nonR2WithoutSingleFamilyEvidence;

    // An explicit value range is a hard contract: unknown values cannot consume the
    // requested route slots ahead of later known, in-range properties.
    const jobFilters = job.dry_run_metadata?.filters || {};
    const filterMinPrice = Number(jobFilters.min_price) > 0
        ? Math.max(DEFAULT_PRECISION_MIN_HOME_VALUE, Number(jobFilters.min_price))
        : DEFAULT_PRECISION_MIN_HOME_VALUE;
    const filterMaxPrice = Number(jobFilters.max_price) > 0 ? Number(jobFilters.max_price) : null;
    const estimatedValueQualified = qualifiesEstimatedValueRange(price, {
        minEstimatedValue: filterMinPrice,
        maxEstimatedValue: filterMaxPrice,
        providerEstimatedValueMin: providerSearchEvidence.valuation_estimated_value_min,
        providerEstimatedValueMax: providerSearchEvidence.valuation_estimated_value_max
    });
    const priceRejected = !estimatedValueQualified;
    const providerRecentSaleSources = Array.isArray(providerSearchEvidence.recent_sale_sources)
        ? providerSearchEvidence.recent_sale_sources.filter(source => source === 'intel' || source === 'sale')
        : [];
    const providerRecentSaleMinDate = isoDateOnly(providerSearchEvidence.recent_sale_min_date);
    const providerRecentSaleMaxDate = isoDateOnly(providerSearchEvidence.recent_sale_max_date);
    const providerRecentSaleWindowProven = providerRecentSaleSources.length > 0
        && !!providerRecentSaleMinDate
        && !!providerRecentSaleMaxDate
        && providerRecentSaleMinDate >= cutoffDate
        && providerRecentSaleMaxDate <= referenceDate
        && providerRecentSaleMinDate <= providerRecentSaleMaxDate;
    const providerSaleProof = resolveProviderRecentSaleProof({
        matchedSources: providerRecentSaleSources,
        returnedSaleDateSource: saleDateSource,
        hasReturnedSaleDate: hasValidSaleDate,
        returnedSaleDateInWindow: isSoldInWindow,
        providerWindowProven: providerRecentSaleWindowProven
    });
    const acceptedProviderRecentSaleSources = providerSaleProof.acceptedSources;
    const conflictingPredicateSources = providerSaleProof.conflictingSources;
    const providerRecentSaleWindowAccepted = providerSaleProof.accepted;
    const missingSaleDateRejected = !hasValidSaleDate && !providerRecentSaleWindowAccepted;
    // A stale fallback deed/open-lien date is not allowed to erase the newer
    // hidden event that made the filtered Search match. Only a stale value from
    // the exact matched predicate contradicts that source's provenance.
    const staleKnownSaleDate = hasValidSaleDate && !isSoldInWindow && !providerRecentSaleWindowAccepted;
    const listingStatusRejected = isBlockedListingStatus(listingStatusLower);
    const addressUnitRejected = addressHasUnit;
    const missingSfrEvidenceRejected = !hasExplicitSingleFamilyEvidence;
    const rejected = nonResidential || landUseRejected || addressUnitRejected || listingStatusRejected || priceRejected || missingSaleDateRejected || staleKnownSaleDate || missingSfrEvidenceRejected;
    const rejectionReason = !rejected ? null : (
        nonResidential ? 'non_residential' :
            landUseRejected ? 'land_use' :
                addressUnitRejected ? 'address_unit' :
                    listingStatusRejected ? 'listing_status' :
                    priceRejected ? 'price' :
                        missingSaleDateRejected ? 'no_date_evidence' :
                            staleKnownSaleDate ? 'stale_date' :
                                missingSfrEvidenceRejected ? 'missing_sfr_evidence' :
                                'unknown'
    );
    const providerSalePredicateProven = providerRecentSaleWindowAccepted && acceptedProviderRecentSaleSources.includes('sale');
    const verifiedEvidence = hasExplicitSingleFamilyEvidence && ((saleDateConfidence === 'high' && isSoldInWindow) || providerSalePredicateProven);
    // Intel-only Basic matches are intentionally kept for recall/earliness, but
    // remain medium-confidence until the Sale stream or an exact returned event
    // corroborates them.
    const acceptedConfidence = verifiedEvidence ? 'verified' : 'medium';

    const match = address.street.match(/^(\d+)\s+(.*)$/);
    const houseNumber = match ? parseInt(match[1], 10) : 0;
    const streetName = match ? match[2] : address.street;

    return {
        address_hash: addressHash(address.street, address.zip),
        legacy_hash: firstValue(ids.propertyId, ids.id, p.id, p.propertyId) || null,
        house_number: houseNumber,
        street_name: streetName,
        full_address: [address.street, address.city, address.state, address.zip].filter(Boolean).join(', '),
        city: address.city,
        state: address.state,
        zip_code: address.zip,
        lat: address.lat,
        lng: address.lng,
        owner_full_name: ownerName || null,
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
        sold_date: isSoldInWindow ? saleDate : null,
        sale_date_source: isSoldInWindow
            ? saleDateSource
            : `provider_filter:${acceptedProviderRecentSaleSources.join('+') || 'none'}`,
        sale_type: 'BatchData',
        property_type: propertyType,
        data_source: 'batchdata',
        sale_confidence: rejected ? 'REJECTED' : acceptedConfidence,
        original_status: rejected ? 'REJECTED' : (verifiedEvidence ? 'BATCHDATA_CONFIRMED' : 'BATCHDATA_CANDIDATE'),
        route_active: !rejected,
        rejection_reason: rejectionReason,
        provider_recent_sale_window_proven: providerRecentSaleWindowAccepted,
        metadata_completeness: {
            has_property_type: !!rawPropertyType,
            has_land_use_code: !!landUseCode,
            has_sale_date: hasValidSaleDate,
            sale_date_in_window: isSoldInWindow,
            sale_date_source: saleDateSource,
            sale_date_confidence: saleDateConfidence,
            purchase_mortgage_evidence: saleDateDetail.purchaseMortgageEvidence === true,
            has_explicit_single_family_evidence: hasExplicitSingleFamilyEvidence,
            listing_status: listingStatus || null,
            estimated_home_value: price ?? null,
            sale_consideration: saleAmount ?? null,
            provider_r2_filter_evidence: providerR2Evidence,
            provider_estimated_value_min: providerSearchEvidence.valuation_estimated_value_min ?? null,
            provider_estimated_value_max: providerSearchEvidence.valuation_estimated_value_max ?? null,
            provider_listing_status_categories_excluded: providerSearchEvidence.listing_status_categories_excluded || [],
            provider_recent_sale_sources: providerRecentSaleSources,
            accepted_provider_recent_sale_sources: acceptedProviderRecentSaleSources,
            conflicting_provider_recent_sale_sources: conflictingPredicateSources,
            provider_recent_sale_min_date: providerRecentSaleMinDate,
            provider_recent_sale_max_date: providerRecentSaleMaxDate,
            provider_recent_sale_window_proven: providerRecentSaleWindowAccepted,
            observed_sale_date: saleDate || null,
            observed_sale_date_is_current_window: isSoldInWindow
        },
        raw_payload: JSON.stringify({
            ...p,
            _firstknock: {
                ...(p._firstknock || {}),
                mapped_evidence: {
                    ...(p?._firstknock?.mapped_evidence || {}),
                    estimated_home_value_observed: Number.isFinite(Number(price)) && Number(price) > 0,
                    exact_sale_date_observed: hasValidSaleDate && isSoldInWindow,
                    listing_status_observed: !!String(listingStatus || '').trim(),
                    owner_name_observed: !!String(ownerName || '').trim()
                },
                mapped_values: {
                    ...(p?._firstknock?.mapped_values || {}),
                    listing_status: listingStatus || null,
                    owner_full_name: ownerName || null
                }
            }
        })
    };
}

function toNullableDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date.toISOString();
}

function qualificationEvidencePayload(rawPayload) {
    let parsed = {};
    try { parsed = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : (rawPayload || {}); } catch { parsed = {}; }
    return JSON.stringify({ _firstknock: parsed?._firstknock || {} });
}

function jobScopedQualificationEvidenceRow(propertyId, rawPayload, job) {
    if (!job?.id) throw new Error('FetchJob id is required for job-scoped qualification evidence.');
    return {
        property_id: String(propertyId),
        job_id: String(job.id),
        raw_payload: JSON.parse(qualificationEvidencePayload(rawPayload))
    };
}

const PROPERTY_WRITE_CHUNK_SIZE = 100;

function propertyWriteChunks(properties, chunkSize = PROPERTY_WRITE_CHUNK_SIZE) {
    const chunks = [];
    let chunk = [];
    let hashes = new Set();

    for (const property of properties) {
        const hash = String(property?.address_hash || '');
        // A duplicate address must observe the preceding write to preserve the
        // former serial merge semantics. Flush before it rather than allowing
        // two source rows to contend in one PostgreSQL statement.
        if (chunk.length >= chunkSize || hashes.has(hash)) {
            chunks.push(chunk);
            chunk = [];
            hashes = new Set();
        }
        chunk.push(property);
        hashes.add(hash);
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
}

function rawPayloadForProperty(property) {
    return property.raw_payload || JSON.stringify(property);
}

function parseRawPayload(rawPayload) {
    return typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
}

function databasePropertyPayload(property, soldDate, rawPayload, extra = {}) {
    return {
        address_hash: property.address_hash,
        legacy_hash: property.legacy_hash ?? null,
        full_address: property.full_address ?? null,
        house_number: property.house_number || null,
        street_name: property.street_name || null,
        city: property.city || null,
        state: property.state || null,
        zip_code: property.zip_code || null,
        lat: property.lat ?? null,
        lng: property.lng ?? null,
        owner_full_name: property.owner_full_name || null,
        beds: property.beds || null,
        baths: property.baths || null,
        sqft: property.sqft || null,
        lot_size: property.lot_size || null,
        year_built: property.year_built || null,
        price: property.price || null,
        sold_date: soldDate,
        sale_type: property.sale_type ?? null,
        property_type: property.property_type ?? null,
        data_source: property.data_source ?? null,
        sale_confidence: property.sale_confidence ?? null,
        original_status: property.original_status ?? null,
        raw_payload: parseRawPayload(rawPayload),
        ...extra
    };
}

async function selectExistingPropertyRows(sql, properties) {
    if (properties.length === 0) return [];
    const hashes = JSON.stringify(properties.map(property => String(property.address_hash)));
    return sql`
        SELECT id, address_hash, xmin::TEXT AS row_version, sold_date, sale_type, property_type, data_source,
               sale_confidence, original_status, owner_full_name, beds, baths,
               sqft, lot_size, year_built, price
        FROM properties
        WHERE address_hash IN (
            SELECT value
            FROM jsonb_array_elements_text(${hashes}::JSONB) AS hash(value)
        )
    `;
}

async function insertPropertyRows(sql, rows) {
    if (rows.length === 0) return [];
    const payload = JSON.stringify(rows);
    return sql`
        INSERT INTO properties (
            address_hash, legacy_hash, full_address, house_number, street_name, city, state, zip_code,
            lat, lng, owner_full_name, beds, baths, sqft, lot_size, year_built, price,
            sold_date, sale_type, property_type, data_source, sale_confidence, original_status, raw_payload, updated_at
        )
        SELECT
            item->>'address_hash', item->>'legacy_hash', item->>'full_address',
            NULLIF(item->>'house_number', '')::INTEGER, item->>'street_name', item->>'city', item->>'state', item->>'zip_code',
            NULLIF(item->>'lat', '')::DOUBLE PRECISION, NULLIF(item->>'lng', '')::DOUBLE PRECISION, item->>'owner_full_name',
            NULLIF(item->>'beds', '')::DOUBLE PRECISION, NULLIF(item->>'baths', '')::DOUBLE PRECISION,
            NULLIF(item->>'sqft', '')::DOUBLE PRECISION, NULLIF(item->>'lot_size', '')::DOUBLE PRECISION,
            NULLIF(item->>'year_built', '')::INTEGER, NULLIF(item->>'price', '')::DOUBLE PRECISION,
            NULLIF(item->>'sold_date', '')::TIMESTAMPTZ, item->>'sale_type', item->>'property_type',
            item->>'data_source', item->>'sale_confidence', item->>'original_status', item->'raw_payload', NOW()
        FROM jsonb_array_elements(${payload}::JSONB) AS input(item)
        ON CONFLICT (address_hash) DO NOTHING
        RETURNING id, address_hash
    `;
}

async function updatePropertyRows(sql, rows) {
    if (rows.length === 0) return [];
    const payload = JSON.stringify(rows);
    const updatedRows = await sql`
        UPDATE properties AS property SET
            legacy_hash = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(item->>'legacy_hash', property.legacy_hash)
                ELSE COALESCE(property.legacy_hash, item->>'legacy_hash') END,
            full_address = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(item->>'full_address', property.full_address)
                ELSE COALESCE(property.full_address, item->>'full_address') END,
            house_number = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(NULLIF(item->>'house_number', '')::INTEGER, property.house_number)
                ELSE COALESCE(property.house_number, NULLIF(item->>'house_number', '')::INTEGER) END,
            street_name = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(item->>'street_name', property.street_name)
                ELSE COALESCE(property.street_name, item->>'street_name') END,
            city = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(item->>'city', property.city)
                ELSE COALESCE(property.city, item->>'city') END,
            state = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(item->>'state', property.state)
                ELSE COALESCE(property.state, item->>'state') END,
            zip_code = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(item->>'zip_code', property.zip_code)
                ELSE COALESCE(property.zip_code, item->>'zip_code') END,
            lat = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(NULLIF(item->>'lat', '')::DOUBLE PRECISION, property.lat)
                ELSE COALESCE(property.lat, NULLIF(item->>'lat', '')::DOUBLE PRECISION) END,
            lng = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(NULLIF(item->>'lng', '')::DOUBLE PRECISION, property.lng)
                ELSE COALESCE(property.lng, NULLIF(item->>'lng', '')::DOUBLE PRECISION) END,
            owner_full_name = CASE WHEN (item->>'replace_ownership_event')::BOOLEAN
                THEN item->>'owner_full_name'
                ELSE COALESCE(property.owner_full_name, item->>'owner_full_name') END,
            beds = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(NULLIF(item->>'beds', '')::DOUBLE PRECISION, property.beds)
                ELSE COALESCE(property.beds, NULLIF(item->>'beds', '')::DOUBLE PRECISION) END,
            baths = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(NULLIF(item->>'baths', '')::DOUBLE PRECISION, property.baths)
                ELSE COALESCE(property.baths, NULLIF(item->>'baths', '')::DOUBLE PRECISION) END,
            sqft = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(NULLIF(item->>'sqft', '')::DOUBLE PRECISION, property.sqft)
                ELSE COALESCE(property.sqft, NULLIF(item->>'sqft', '')::DOUBLE PRECISION) END,
            lot_size = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(NULLIF(item->>'lot_size', '')::DOUBLE PRECISION, property.lot_size)
                ELSE COALESCE(property.lot_size, NULLIF(item->>'lot_size', '')::DOUBLE PRECISION) END,
            year_built = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(NULLIF(item->>'year_built', '')::INTEGER, property.year_built)
                ELSE COALESCE(property.year_built, NULLIF(item->>'year_built', '')::INTEGER) END,
            price = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN COALESCE(NULLIF(item->>'price', '')::DOUBLE PRECISION, property.price)
                ELSE COALESCE(property.price, NULLIF(item->>'price', '')::DOUBLE PRECISION) END,
            sold_date = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN NULLIF(item->>'sold_date_for_update', '')::TIMESTAMPTZ
                ELSE property.sold_date END,
            sale_type = COALESCE(item->>'protected_sale_type', property.sale_type),
            property_type = COALESCE(item->>'protected_property_type', property.property_type),
            data_source = item->>'protected_data_source',
            sale_confidence = item->>'protected_sale_confidence',
            original_status = item->>'protected_original_status',
            raw_payload = CASE WHEN (item->>'replace_sale_event')::BOOLEAN
                THEN item->'raw_payload'
                ELSE COALESCE(property.raw_payload, item->'raw_payload') END,
            updated_at = NOW()
        FROM jsonb_array_elements(${payload}::JSONB) AS input(item)
        WHERE property.id = (item->>'id')::BIGINT
          AND property.xmin::TEXT = item->>'expected_row_version'
        RETURNING property.id
    `;
    return updatedRows.map(row => String(row.id));
}

async function publishWorkspaceQualificationRows(sql, rows, job) {
    const protectAssignedRoutes = protectsAssignedRouteFetchJob(job?.dry_run_metadata?.route_filters);
    const publishRows = async (subset) => {
        if (subset.length === 0) return [];
        const payload = JSON.stringify(subset.map(row => ({
            property_id: String(row.property_id),
            user_email: job.user_email || 'unknown',
            fetch_job_id: String(job.id),
            status: row.property.original_status ?? null,
            allow_assigned_in_current_job: row.allow_assigned_in_current_job === true,
            raw_payload: jobScopedQualificationEvidenceRow(row.property_id, row.rawPayload, job).raw_payload
        })));
        const publishedRows = await sql`
            WITH raw_input AS MATERIALIZED (
                SELECT item
                FROM jsonb_array_elements(${payload}::JSONB) AS source(item)
            ), locked_workspace AS MATERIALIZED (
                SELECT current_wp.property_id, current_wp.user_email, current_wp.assigned_route_id
                FROM workspace_properties current_wp
                JOIN raw_input
                  ON current_wp.property_id = (raw_input.item->>'property_id')::BIGINT
                 AND current_wp.user_email = raw_input.item->>'user_email'
                FOR UPDATE OF current_wp
            ), input AS MATERIALIZED (
                SELECT raw_input.item
                FROM raw_input
                LEFT JOIN locked_workspace
                  ON locked_workspace.property_id = (raw_input.item->>'property_id')::BIGINT
                 AND locked_workspace.user_email = raw_input.item->>'user_email'
                WHERE NOT ${protectAssignedRoutes}
                   OR COALESCE((raw_input.item->>'allow_assigned_in_current_job')::BOOLEAN, FALSE)
                   OR locked_workspace.assigned_route_id IS NULL
            ), evidence AS (
                INSERT INTO property_sources (property_id, provider, provider_record_id, fetched_at, raw_payload)
                SELECT (item->>'property_id')::BIGINT, 'batchdata_job', item->>'fetch_job_id', NOW(), item->'raw_payload'
                FROM input
                ON CONFLICT (property_id, provider, provider_record_id)
                DO UPDATE SET fetched_at = NOW(), raw_payload = EXCLUDED.raw_payload
                RETURNING property_id
            )
            INSERT INTO workspace_properties (property_id, user_email, fetch_job_id, route_active, status, updated_at)
            SELECT (input.item->>'property_id')::BIGINT, input.item->>'user_email', input.item->>'fetch_job_id', TRUE, input.item->>'status', NOW()
            FROM input
            JOIN evidence ON evidence.property_id = (input.item->>'property_id')::BIGINT
            ON CONFLICT (property_id, user_email)
            DO UPDATE SET
                fetch_job_id = EXCLUDED.fetch_job_id,
                route_active = EXCLUDED.route_active,
                status = EXCLUDED.status,
                updated_at = NOW()
            RETURNING property_id
        `;
        return publishedRows.map(row => String(row.property_id));
    };

    // Snapshot-preserved rows are intentionally absent from current-job
    // evidence. Immutable exact-job membership must not resurrect them.
    return publishRows(rows.filter(row => !row.preserve_fetch_job));
}

async function reconcileJobMembership(sql, job, publishedPropertyIds) {
    if (!job?.id) throw new Error('FetchJob id is required to reconcile job membership.');
    const payload = JSON.stringify(Array.from(publishedPropertyIds, String));
    await sql`
        DELETE FROM property_sources membership
        WHERE membership.provider = 'batchdata_job'
          AND membership.provider_record_id = ${String(job.id)}
          AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(${payload}::JSONB) AS published(property_id)
              WHERE published.property_id::BIGINT = membership.property_id
          )
    `;
}

function mergePayload(existing, property, soldDate, rawPayload) {
    const plan = planPropertyMerge({
        existing,
        incoming: property,
        soldDate,
        existingExplicitSfr: hasExplicitSingleFamilyMetadata(null, existing.property_type),
        incomingExplicitSfr: hasExplicitSingleFamilyMetadata(null, property.property_type)
    });
    if (!plan.shouldUpdate) return null;
    return databasePropertyPayload(property, soldDate, rawPayload, {
        id: String(existing.id),
        expected_row_version: String(existing.row_version),
        replace_sale_event: plan.replaceSaleEvent,
        replace_ownership_event: plan.replaceOwnershipEvent,
        sold_date_for_update: plan.soldDateForUpdate,
        protected_sale_type: plan.protectedSaleType ?? null,
        protected_property_type: plan.protectedPropertyType ?? null,
        protected_data_source: plan.protectedDataSource ?? null,
        protected_sale_confidence: plan.protectedSaleConfidence ?? null,
        protected_original_status: plan.protectedOriginalStatus ?? null
    });
}

async function applyPropertyUpdatesWithRetry(sql, candidates) {
    let pending = candidates;
    let updated = 0;

    for (let attempt = 1; attempt <= 3 && pending.length > 0; attempt++) {
        const planned = pending
            .map(candidate => ({ candidate, payload: mergePayload(
                candidate.existing,
                candidate.property,
                candidate.soldDate,
                candidate.rawPayload
            ) }))
            .filter(row => row.payload);
        if (planned.length === 0) return updated;

        const updatedIds = new Set(await updatePropertyRows(sql, planned.map(row => row.payload)));
        updated += updatedIds.size;
        const missed = planned
            .filter(row => !updatedIds.has(String(row.payload.id)))
            .map(row => row.candidate);
        if (missed.length === 0) return updated;

        const refreshedRows = await selectExistingPropertyRows(sql, missed.map(row => row.property));
        const refreshedByHash = new Map(refreshedRows.map(row => [String(row.address_hash), row]));
        pending = missed.map(candidate => {
            const existing = refreshedByHash.get(String(candidate.property.address_hash));
            if (!existing) throw new Error('Concurrent property update could not be resolved. Retry the fetch chunk.');
            return { ...candidate, existing };
        });
    }

    if (pending.length > 0) throw new Error('Property rows changed repeatedly during ingestion. Retry the fetch chunk.');
    return updated;
}

async function writePropertiesToNeon(sql, properties, job, excludedRouteHashes = new Set()) {
    let inserted = 0, existed = 0, updated = 0;
    const publishedPropertyIds = new Set();
    const activeProperties = properties.filter(property =>
        property?.route_active === true &&
        String(property?.original_status || '').toUpperCase() !== 'REJECTED' &&
        String(property?.sale_confidence || '').toUpperCase() !== 'REJECTED'
    );

    for (const chunk of propertyWriteChunks(activeProperties)) {
        const existingRows = await selectExistingPropertyRows(sql, chunk);
        const existingByHash = new Map(existingRows.map(row => [String(row.address_hash), row]));
        const unresolved = [];
        const assignments = [];
        const updates = [];

        for (const property of chunk) {
            const rawPayload = rawPayloadForProperty(property);
            const soldDate = toNullableDate(property.sold_date);
            const existing = existingByHash.get(String(property.address_hash));
            if (!existing) {
                unresolved.push({ property, rawPayload, soldDate });
                continue;
            }
            existed++;
            updates.push({ existing, property, soldDate, rawPayload });
            assignments.push({ property, rawPayload, property_id: existing.id });
        }

        if (unresolved.length > 0) {
            const createdRows = await insertPropertyRows(sql, unresolved.map(row =>
                databasePropertyPayload(row.property, row.soldDate, row.rawPayload)
            ));
            inserted += createdRows.length;
            const createdByHash = new Map(createdRows.map(row => [String(row.address_hash), row]));
            const conflicts = [];

            for (const row of unresolved) {
                const created = createdByHash.get(String(row.property.address_hash));
                if (created) {
                    assignments.push({ ...row, property_id: created.id });
                } else {
                    conflicts.push(row);
                }
            }

            // ON CONFLICT protects against another job inserting the same home
            // between the bulk read and insert. Re-read only those rare rows and
            // apply the same merge policy rather than overwriting blindly.
            if (conflicts.length > 0) {
                const conflictRows = await selectExistingPropertyRows(sql, conflicts.map(row => row.property));
                const conflictsByHash = new Map(conflictRows.map(row => [String(row.address_hash), row]));
                for (const row of conflicts) {
                    const existing = conflictsByHash.get(String(row.property.address_hash));
                    if (!existing) throw new Error('Concurrent property insert could not be resolved. Retry the fetch chunk.');
                    existed++;
                    updates.push({ existing, property: row.property, soldDate: row.soldDate, rawPayload: row.rawPayload });
                    assignments.push({ ...row, property_id: existing.id });
                }
            }
        }

        updated += await applyPropertyUpdatesWithRetry(sql, updates);
        // Evidence and the workspace fetch-job pointer publish in one statement.
        // The pointer can therefore never reference missing qualification proof.
        const publishedIds = await publishWorkspaceQualificationRows(sql, assignments.map(row => ({
            ...row,
            preserve_fetch_job: excludedRouteHashes.has(row.property.address_hash),
            allow_assigned_in_current_job: allowsAssignedRouteForCurrentJob(
                job?.dry_run_metadata?.route_filters,
                job?.dry_run_metadata,
                row.property.address_hash
            )
        })), job);
        for (const propertyId of publishedIds) publishedPropertyIds.add(propertyId);
    }

    // Treat property_sources as immutable exact-job membership. A successful
    // retry replaces, rather than unions with, any partial prior attempt.
    await reconcileJobMembership(sql, job, publishedPropertyIds);

    if (activeProperties.length > 0) {
        await sql`
            INSERT INTO ingestion_metrics (fetch_job_id, user_email, records_fetched, records_inserted, records_updated, records_skipped)
            VALUES (${job.id}, ${job.user_email || 'unknown'}, ${activeProperties.length}, ${inserted}, ${updated}, ${Math.max(0, existed - updated)})
        `.catch(() => {});
    }

    return { inserted, existed, updated, published: publishedPropertyIds.size };
}

function getExcludedRouteHashes(job) {
    const hashes = job?.dry_run_metadata?.excluded_route_hashes;
    return new Set((Array.isArray(hashes) ? hashes : []).map(hash => String(hash)).filter(Boolean));
}

async function batchDataPostWithRetry(url, requestBody, label = 'BatchData') {
    for (let attempt = 1; attempt <= 4; attempt++) {
        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BATCHDATA_API_KEY}` },
                body: JSON.stringify(requestBody)
            });
        } catch (error) {
            if (attempt < 2) {
                await sleep(1000);
                continue;
            }
            const requestError: Error & { batchDataHttpAttempts?: number } = new Error(`${label} request failed before response: ${error.message}`);
            requestError.batchDataHttpAttempts = attempt;
            throw requestError;
        }
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw_text: text.slice(0, 1000) }; }
        if (payload === null || (typeof payload !== 'object' && !Array.isArray(payload))) payload = { value: payload };

        if (response.ok) {
            Object.defineProperty(payload, '__batchDataHttpAttempts', { value: attempt, enumerable: false });
            return payload;
        }
        if (response.status === 401) {
            const requestError: Error & { batchDataHttpAttempts?: number } = new Error(`Authentication failed. Verify the ${label} API token is correct and active.`);
            requestError.batchDataHttpAttempts = attempt;
            throw requestError;
        }
        if (response.status === 400) {
            const requestError: Error & { batchDataHttpAttempts?: number } = new Error(`${label} rejected the request: ${text.slice(0, 1000)}`);
            requestError.batchDataHttpAttempts = attempt;
            throw requestError;
        }
        if (response.status === 429 && attempt < 4) {
            await sleep(2 ** attempt * 1000);
            continue;
        }
        if ((response.status === 500 || response.status === 503) && attempt < 2) {
            await sleep(5000);
            continue;
        }
        const requestError: Error & { batchDataHttpAttempts?: number } = new Error(`${label} request failed (${response.status}): ${text.slice(0, 1000)}`);
        requestError.batchDataHttpAttempts = attempt;
        throw requestError;
    }
    throw new Error('Rate limit exceeded after 3 retries.');
}

async function batchDataFetchWithRetry(requestBody) {
    return batchDataPostWithRetry(BATCHDATA_BASE, requestBody, 'BatchData Search');
}

async function batchDataLookupWithRetry(requestBody) {
    return batchDataPostWithRetry(BATCHDATA_LOOKUP_BASE, requestBody, 'BatchData Lookup');
}

function batchDataDiagnosticRecordKey(record, index) {
    const property = batchDataRecordProperty(record);
    const ids = property.ids || property.identifiers || {};
    const address = normalizeBatchDataAddress(property);
    return String(firstValue(
        ids.propertyId,
        ids.id,
        property.propertyId,
        property.id,
        address.street && address.zip ? `${address.street}|${address.zip}`.toLowerCase() : null,
        `page-record-${index}`
    ));
}

async function fetchAllBatchDataDiagnosticRecords(baseRequest, maxRecords = 5000) {
    const records = [];
    const seen = new Set();
    const pageSize = clampBatchDataTake(baseRequest?.options?.take, BATCHDATA_MAX_TAKE) || BATCHDATA_MAX_TAKE;
    let skip = 0;
    let rawReviewed = 0;
    let providerTotal = null;
    let pages = 0;
    let exhausted = false;

    while (rawReviewed < maxRecords) {
        const take = Math.min(pageSize, maxRecords - rawReviewed);
        const request = {
            ...baseRequest,
            options: { ...(baseRequest?.options || {}), skip, take }
        };
        const response = await batchDataFetchWithRetry(request);
        const list = extractBatchDataRecords(response);
        pages++;
        if (providerTotal === null) providerTotal = extractBatchDataTotal(response);
        list.forEach((record, index) => {
            const key = batchDataDiagnosticRecordKey(record, rawReviewed + index);
            if (!seen.has(key)) {
                seen.add(key);
                records.push(record);
            }
        });
        rawReviewed += list.length;
        skip += list.length;
        if (list.length < take || list.length === 0 || (providerTotal !== null && skip >= providerTotal)) {
            exhausted = true;
            break;
        }
        await sleep(300);
    }

    return {
        records,
        providerTotal,
        pages,
        rawReviewed,
        complete: exhausted && (providerTotal === null || rawReviewed >= providerTotal),
        truncated: !exhausted
    };
}

function batchDataPreMapDropReason(raw, job) {
    const p = batchDataRecordProperty(raw);
    const address = normalizeBatchDataAddress(p);
    if (!address.street || !address.zip || !Number.isFinite(address.lat) || !Number.isFinite(address.lng)) {
        return 'address_invalid';
    }
    if (!isPointInPolygon({ lat: address.lat, lng: address.lng }, job.polygon || [])) {
        return 'outside_polygon';
    }
    return 'unknown';
}

function incrementRejectionReason(rejectionReasons, reason) {
    const key = rejectionReasons[reason] !== undefined ? reason : 'unknown';
    rejectionReasons[key] = (rejectionReasons[key] || 0) + 1;
}

function creditEfficiencyReport({
    reviewed,
    processed,
    selectedCount,
    skippedExistingRoute,
    skippedDuplicate,
    skippedRouteType,
    rejectionReasons
}) {
    const recordsRejectedLocalFilter = Math.max(0, processed - selectedCount - skippedExistingRoute - skippedDuplicate - skippedRouteType);
    const filterPassRate = selectedCount / Math.max(1, processed);
    return {
        estimated_record_units_reviewed: reviewed,
        records_evaluated_local_filter: processed,
        records_not_evaluated_after_target: Math.max(0, reviewed - processed),
        billing_status: 'unverified_confirm_in_batchdata_dashboard',
        records_passed_local_filter: selectedCount,
        records_rejected_local_filter: recordsRejectedLocalFilter,
        filter_pass_rate: Number(filterPassRate.toFixed(4)),
        rejection_breakdown: rejectionReasons,
        recommendation: filterPassRate < 0.1
            ? 'CRITICAL: Less than 10% of credits are producing usable route homes. Escalate to BatchData.'
            : filterPassRate < 0.3
                ? 'WARNING: Less than 30% of credits are producing usable route homes. Review date window.'
                : 'OK'
    };
}

async function fetchBatchDataRecordsForMode(job, mode, requested, onProgress = null) {
    requested = Math.min(Math.max(clampInteger(requested, 1, 1, 1000), 1), 1000);
    const selected = [];
    const selectedHashes = new Set();
    const discoveredRecords = [];
    const discoveredIdentityKeys = new Set();
    const excludedRouteHashes = getExcludedRouteHashes(job);
    const routeTypeFilters = getRouteTypeFilters(job);
    const rejectedSamples = [];
    const pageTimings = [];
    let skip = 0;
    let pageCursor = null;
    let useCursorPagination = BATCHDATA_CURSOR_PAGINATION_ENABLED;
    let cursorRowsConsumed = 0;
    let offsetRowsConsumed = 0;
    let reviewed = 0;
    let processed = 0;
    let totalRecordCount = null;
    let skippedExistingRoute = 0;
    let skippedDuplicate = 0;
    let skippedRouteType = 0;
    let countProbeRequests = 0;
    let httpRequests = 0;
    const skippedRouteTypeBreakdown = {};
    const rejectionReasons = {
        no_date_evidence: 0,
        stale_date: 0,
        missing_sfr_evidence: 0,
        address_unit: 0,
        listing_status: 0,
        non_residential: 0,
        land_use: 0,
        price: 0,
        outside_polygon: 0,
        address_invalid: 0,
        unknown: 0
    };
    const fetchMode = String(job?.dry_run_metadata?.fetch_mode || job?.dry_run_metadata?.count_mode || '').toLowerCase();
    const isMaxAvailableMode = fetchMode === 'max_available';
    const originalRequested = requested;

    if (requested > BATCHDATA_MAX_TAKE) {
        const countRequest = buildBatchDataRequest(job, 0, 0, mode);
        if (countRequest) {
            const countPayload = await batchDataFetchWithRetry(countRequest);
            countProbeRequests++;
            httpRequests += Number(countPayload?.__batchDataHttpAttempts || 1);
            totalRecordCount = extractBatchDataTotal(countPayload);
            if (totalRecordCount !== null && totalRecordCount < requested) {
                requested = Math.max(0, totalRecordCount);
            }
            console.log(JSON.stringify({
                event: 'batchdata_count_first',
                mode,
                original_requested: originalRequested,
                adjusted_requested: requested,
                provider_total: totalRecordCount,
                api_requests: 1,
                estimated_credits_burned: null,
                billing_status: 'unverified_confirm_in_batchdata_dashboard'
            }));
            if (typeof onProgress === 'function') {
                await onProgress({
                    event: 'count_probe_complete',
                    mode,
                    original_requested: originalRequested,
                    requested,
                    totalRecordCount,
                    reviewed,
                    selected: selected.length
                }).catch(() => {});
            }
        }
    }

    // "Max Available" and fixed-count pulls use the same explicit raw review
    // budget. Previously the default free max-available pull reviewed only 100
    // rows while a fixed request for the same 50 homes could review 1,000.
    const maxReviewed = Math.min(
        MAX_PROVIDER_RECORDS_PER_DATE_SOURCE,
        Math.max(BATCHDATA_MAX_TAKE, requested * 50)
    );

    if (requested <= 0 || totalRecordCount === 0) {
        return {
            records: [],
            selected_records: [],
            rejected_records: [],
            discovered_records: [],
            reviewed,
            processed,
            active: 0,
            rejected_samples: 0,
            skipped_existing_route: skippedExistingRoute,
            skipped_duplicate: skippedDuplicate,
            skipped_route_type: skippedRouteType,
            skipped_route_type_breakdown: skippedRouteTypeBreakdown,
            max_reviewed: maxReviewed,
            scan_truncated: false,
            count_probe_requests: countProbeRequests,
            http_requests: httpRequests,
            page_timings: pageTimings,
            totalRecordCount,
            credit_efficiency_report: creditEfficiencyReport({
                reviewed,
                processed,
                selectedCount: selected.length,
                skippedExistingRoute,
                skippedDuplicate,
                skippedRouteType,
                rejectionReasons
            })
        };
    }

    while (selected.length < requested && reviewed < maxReviewed) {
        const remainingRequested = Math.max(1, requested - selected.length);
        const remainingReviewBudget = Math.max(1, maxReviewed - reviewed);
        const pageCap = isMaxAvailableMode ? MAX_AVAILABLE_TAKE : BATCHDATA_MAX_TAKE;
        const take = Math.min(
            pageCap,
            remainingReviewBudget,
            isMaxAvailableMode ? remainingReviewBudget : Math.ceil(remainingRequested * 4)
        );
        const requestBody = buildBatchDataRequest(job, skip, take, mode, pageCursor, useCursorPagination);
        if (!requestBody) break;
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
                skip: useCursorPagination ? null : skip,
                pagination: useCursorPagination ? 'cursor' : 'offset',
                take
            }).catch(() => {});
        }
        const pageStartedAt = Date.now();
        let payload;
        try {
            payload = await batchDataFetchWithRetry(requestBody);
        } catch (error) {
            if (useCursorPagination && (pageCursor || /cursor/i.test(String(error?.message || error)))) {
                // Compatibility fallback for older token contracts. A rejected
                // cursor request returns no records, so retrying the same page by
                // bounded offset does not duplicate billable results.
                httpRequests += Number(error?.batchDataHttpAttempts || 1);
                useCursorPagination = false;
                pageCursor = null;
                // Cursor and offset order are not guaranteed identical. Restart
                // offset paging at zero and rely on identity de-duplication; a
                // jump to `reviewed` could permanently skip unseen identities.
                skip = 0;
                const offsetRequest = buildBatchDataRequest(job, skip, take, mode, null, false);
                payload = await batchDataFetchWithRetry(offsetRequest);
            } else {
                throw error;
            }
        }
        httpRequests += Number(payload?.__batchDataHttpAttempts || 1);
        const list = extractBatchDataRecords(payload)
            .map(record => annotateBatchDataSearchRecord(record, job, mode));
        const pageElapsedMs = Date.now() - pageStartedAt;
        const nextPageCursor = extractBatchDataNextPageCursor(payload);
        pageTimings.push({
            page: pageTimings.length + 1,
            pagination: useCursorPagination ? 'cursor' : 'offset',
            skip: useCursorPagination ? null : skip,
            take,
            returned: list.length,
            elapsed_ms: pageElapsedMs
        });
        if (totalRecordCount === null) totalRecordCount = extractBatchDataTotal(payload);
        if (totalRecordCount === 0) break;
        reviewed += list.length;
        if (useCursorPagination) cursorRowsConsumed += list.length;
        else offsetRowsConsumed += list.length;
        const selectedBeforePage = selected.length;

        for (const raw of list) {
            const rawIdentityKeys = batchDataIdentityKeys(raw);
            const alreadyDiscovered = rawIdentityKeys.some(key => discoveredIdentityKeys.has(key));
            if (!alreadyDiscovered) {
                discoveredRecords.push(raw);
                for (const key of rawIdentityKeys) discoveredIdentityKeys.add(key);
            }
            processed++;
            const mapped = mapBatchDataProperty(raw, job);
            if (!mapped) {
                incrementRejectionReason(rejectionReasons, batchDataPreMapDropReason(raw, job));
                if (rejectedSamples.length < Math.min(10, Math.max(requested, 2))) {
                    rejectedSamples.push(raw);
                }
                continue;
            }
            if (mapped.route_active !== false) {
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
            } else {
                incrementRejectionReason(rejectionReasons, mapped.rejection_reason || 'unknown');
                if (rejectedSamples.length < Math.min(10, Math.max(requested, 2))) {
                    rejectedSamples.push(raw);
                }
            }
        }

        const addedToRoute = selected.length - selectedBeforePage;
        console.log(JSON.stringify({
            event: 'batchdata_page_credit_log',
            mode,
            requested_take: take,
            returned: list.length,
            added_to_route: addedToRoute,
            estimated_record_units: list.length,
            billing_status: 'unverified_confirm_in_batchdata_dashboard',
            filter_efficiency: list.length > 0 ? Number((addedToRoute / list.length).toFixed(4)) : 0,
            cumulative_selected: selected.length,
            cumulative_reviewed: reviewed
        }));

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
                skip: useCursorPagination ? null : skip,
                pagination: useCursorPagination ? 'cursor' : 'offset',
                take,
                page_elapsed_ms: pageElapsedMs
            }).catch(() => {});
        }

        if (selected.length >= requested) break;
        if (list.length < take) break;
        const providerRowsConsumed = useCursorPagination ? cursorRowsConsumed : offsetRowsConsumed;
        if (totalRecordCount !== null && providerRowsConsumed >= totalRecordCount) break;
        if (useCursorPagination && nextPageCursor) {
            pageCursor = nextPageCursor;
        } else {
            // Older account contracts may accept the cursor option but omit a
            // cursor. Preserve compatibility with bounded offset paging while
            // surfacing the method in diagnostics.
            useCursorPagination = false;
            pageCursor = null;
            // If this page was already offset-based, advance normally. If it was
            // cursor-based but omitted a next cursor, restart offset at zero.
            skip = offsetRowsConsumed > 0 ? offsetRowsConsumed : 0;
        }
    }

    const providerRowsConsumed = useCursorPagination ? cursorRowsConsumed : offsetRowsConsumed;
    const scanTruncated = (isMaxAvailableMode && totalRecordCount !== null && providerRowsConsumed < totalRecordCount)
        || (selected.length < requested
            && reviewed >= maxReviewed
            && (totalRecordCount === null || providerRowsConsumed < totalRecordCount));
    return {
        records: selected.length > 0 ? selected.slice(0, requested) : rejectedSamples,
        selected_records: selected.slice(0, requested),
        rejected_records: rejectedSamples,
        discovered_records: discoveredRecords,
        reviewed,
        processed,
        active: selected.length,
        rejected_samples: rejectedSamples.length,
        skipped_existing_route: skippedExistingRoute,
        skipped_duplicate: skippedDuplicate,
        skipped_route_type: skippedRouteType,
        skipped_route_type_breakdown: skippedRouteTypeBreakdown,
        max_reviewed: maxReviewed,
        scan_truncated: scanTruncated,
        count_probe_requests: countProbeRequests,
        http_requests: httpRequests,
        page_timings: pageTimings,
        cursor_rows_consumed: cursorRowsConsumed,
        offset_rows_consumed: offsetRowsConsumed,
        totalRecordCount,
        credit_efficiency_report: creditEfficiencyReport({
            reviewed,
            processed,
            selectedCount: selected.length,
            skippedExistingRoute,
            skippedDuplicate,
            skippedRouteType,
            rejectionReasons
        })
    };
}

function mergeBatchDataValues(existing, incoming) {
    if (existing === undefined || existing === null || existing === '') return incoming;
    if (incoming === undefined || incoming === null || incoming === '') return existing;
    if (Array.isArray(existing) && Array.isArray(incoming)) {
        const merged = [];
        const seen = new Set();
        for (const value of [...existing, ...incoming]) {
            let key;
            try { key = JSON.stringify(value); } catch { key = String(value); }
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(value);
        }
        return merged;
    }
    if (typeof existing === 'object' && typeof incoming === 'object' && !Array.isArray(existing) && !Array.isArray(incoming)) {
        const merged = { ...existing };
        for (const [key, value] of Object.entries(incoming)) {
            merged[key] = mergeBatchDataValues(merged[key], value);
        }
        return merged;
    }
    return existing;
}

function batchDataIdentityKeys(record) {
    const property = batchDataRecordProperty(record);
    const ids = property.ids || property.identifiers || {};
    const address = normalizeBatchDataAddress(property);
    const providerId = firstValue(property._id, property.id, property.propertyId, ids.propertyId, ids.id);
    const providerAddressHash = firstValue(property.address?.hash, property.addressHash);
    const apn = firstValue(ids.apn, ids.assessorParcelNumber, property.apn);
    const normalizedAddressKey = address.street && address.zip ? addressHash(address.street, address.zip) : null;
    const keys = [
        providerId ? `id:${providerId}` : null,
        providerAddressHash ? `address_hash:${providerAddressHash}` : null,
        apn && normalizedAddressKey
            ? `apn_address:${firstValue(ids.fipsCode, ids.countyFips, property.fipsCode, '')}|${apn}|${normalizedAddressKey}`
            : null,
        normalizedAddressKey ? `address:${normalizedAddressKey}` : null
    ].filter(Boolean);
    return [...new Set(keys.map(value => String(value).trim()).filter(Boolean))];
}

function unionBatchDataRecords(records, state) {
    for (const record of records || []) {
        const keys = batchDataIdentityKeys(record);
        let index = keys.map(key => state.identityIndex.get(key)).find(value => value !== undefined);
        if (index === undefined) {
            index = state.records.length;
            state.records.push(batchDataRecordProperty(record));
        } else {
            state.records[index] = mergeBatchDataValues(state.records[index], batchDataRecordProperty(record));
        }
        for (const key of batchDataIdentityKeys(state.records[index])) state.identityIndex.set(key, index);
        for (const key of keys) state.identityIndex.set(key, index);
    }
}

async function fetchBatchDataRecords(job, onProgress = null) {
    const requested = Math.min(Math.max(Number(job.estimated_record_count || job.total_expected || 1000), 1), 1000);
    // Intel and Sale are independent recent-sale predicates on Property Search.
    // Exhaust and union both streams so an Intel-only or Sale-only identity is
    // not silently discarded. The current token exposes only the lean `basic`
    // response, so documented R2/value/listing predicates are also sent and
    // retained as provider-filter provenance instead of inventing response data.
    const modes = ['qualified_intel_polygon', 'qualified_sale_polygon'];
    const attempts = [];
    const unionState = { records: [], identityIndex: new Map() };
    const rejectedState = { records: [], identityIndex: new Map() };

    for (const mode of modes) {
        const result = await fetchBatchDataRecordsForMode(job, mode, requested, onProgress);
        attempts.push({ mode, count: result.records.length, discovered: result.discovered_records.length, reviewed: result.reviewed, processed: result.processed, active: result.active, rejected_samples: result.rejected_samples, skipped_existing_route: result.skipped_existing_route, skipped_duplicate: result.skipped_duplicate, skipped_route_type: result.skipped_route_type, skipped_route_type_breakdown: result.skipped_route_type_breakdown, max_reviewed: result.max_reviewed, scan_truncated: result.scan_truncated, count_probe_requests: result.count_probe_requests, http_requests: result.http_requests, cursor_rows_consumed: result.cursor_rows_consumed, offset_rows_consumed: result.offset_rows_consumed, page_timings: result.page_timings, total: result.totalRecordCount, credit_efficiency_report: result.credit_efficiency_report });
        unionBatchDataRecords(result.discovered_records, unionState);
        unionBatchDataRecords(result.rejected_records, rejectedState);
    }

    const excludedRouteHashes = getExcludedRouteHashes(job);
    const routeTypeFilters = getRouteTypeFilters(job);
    const eligibleUnion = unionState.records.filter(record => {
        const mapped = mapBatchDataProperty(record, job);
        return mapped?.route_active === true
            && !excludedRouteHashes.has(mapped.address_hash)
            && routeTypeEligibility(mapped, routeTypeFilters).eligible;
    });
    const sourceQualityRank = (record) => {
        const sources = new Set(batchDataRecordProperty(record)?._firstknock?.search_evidence?.recent_sale_sources || []);
        if (sources.has('intel') && sources.has('sale')) return 3;
        if (sources.has('sale')) return 2;
        if (sources.has('intel')) return 1;
        return 0;
    };
    // When an explicit plan/fixed cap applies, preserve the most corroborated
    // records rather than letting Intel-first fetch order crowd out Sale matches.
    eligibleUnion.sort((left, right) => sourceQualityRank(right) - sourceQualityRank(left));
    const sourceMembership = unionState.records.reduce<Record<string, number>>((counts, record) => {
        const sources = new Set(batchDataRecordProperty(record)?._firstknock?.search_evidence?.recent_sale_sources || []);
        const bucket = sources.has('intel') && sources.has('sale')
            ? 'both'
            : (sources.has('intel') ? 'intel_only' : (sources.has('sale') ? 'sale_only' : 'unknown'));
        counts[bucket] = (counts[bucket] || 0) + 1;
        return counts;
    }, { intel_only: 0, sale_only: 0, both: 0, unknown: 0 });
    return {
        records: eligibleUnion.length > 0 ? eligibleUnion.slice(0, requested) : rejectedState.records,
        attempts,
        mode_used: eligibleUnion.length > 0 ? 'intel_sale_union' : 'none',
        union_unique_records: unionState.records.length,
        eligible_union_records: eligibleUnion.length,
        source_membership: sourceMembership,
        union_truncated_by_plan_cap: eligibleUnion.length > requested,
        discovery_sources: modes
    };
}

Deno.serve(async (req) => {
    let base44 = null;
    let lockId = null;
    let targetJobId = null;
    try {
        base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({}));
        targetJobId = body.job_id ? String(body.job_id) : null;

        if (body.contract_probe === true) {
            return Response.json({
                success: true,
                precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
                component: 'processFetchChunk',
                paid_provider_requests: 0
            });
        }

        const diagnosticRequested = DIAGNOSTIC_FLAGS.some(flag => body[flag] === true) || Array.isArray(body.synthetic_records);
        if (diagnosticRequested) {
            const diagnosticUser = await base44.auth.me().catch(() => null);
            if (!diagnosticUser) {
                return Response.json({ success: false, error: 'Authentication is required for BatchData diagnostics.' }, { status: 401 });
            }
            if (diagnosticUser.role !== 'admin' && diagnosticUser.is_owner !== true) {
                return Response.json({ success: false, error: 'Admin access is required for BatchData diagnostics.' }, { status: 403 });
            }
            if (Array.isArray(body.synthetic_records) && !targetJobId) {
                return Response.json({ success: false, error: 'synthetic_records requires an explicit job_id.' }, { status: 400 });
            }
        }

        if (body.self_test === true) {
            return Response.json({
                success: true,
                precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
                active_provider: 'batchdata',
                rentcast_active: false,
                batchdata_polygon_search: true,
                dataset_scope: 'options.datasets=basic_current_token_entitlement',
                discovery: 'intel_sale_record_union',
                qualification_filters: ['R2', 'valuation.estimatedValue', 'listing.statusCategory'],
                cursor_pagination_enabled: BATCHDATA_CURSOR_PAGINATION_ENABLED,
                has_batchdata_key: !!BATCHDATA_API_KEY,
                has_database_url: !!DATABASE_URL
            });
        }

        if (body.window_coverage === true) {
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            const hasPolygon = hasUsablePolygon(body.polygon);
            const hasCityState = !!(body.city && body.state);
            if (!hasPolygon && !hasCityState && !body.query) {
                return Response.json({ success: false, error: 'window_coverage requires polygon, query, or city/state.' }, { status: 400 });
            }

            const dateFilter = body.date_filter || 'sale.lastSaleDate';
            const windows = [
                { label: '7d', sold_months: 0.25, days: 7 },
                { label: '14d', sold_months: 0.5, days: 14 },
                { label: '30d', sold_months: 1, days: 30 },
                { label: '60d', sold_months: 2, days: 60 },
                { label: '90d', sold_months: 3, days: 90 },
                { label: '180d', sold_months: 6, days: 180 },
                { label: '365d', sold_months: 12, days: 365 }
            ];
            const windowResults = [];
            for (const win of windows) {
                const cutoff = isoDateDaysAgo(win.days);
                const request = buildBatchDataSearchPayload({
                    polygon: body.polygon || [],
                    city: body.city,
                    state: body.state,
                    query: body.query,
                    dateFilters: [dateFilter],
                    soldMinDate: cutoff,
                    datasets: ['basic'],
                    take: 0
                });
                const response = await batchDataFetchWithRetry(request);
                const count = extractBatchDataTotal(response) ?? 0;
                windowResults.push({ label: win.label, sold_months: win.sold_months, days: win.days, cutoff, count, request });
                await sleep(300);
            }

            const monotonicityViolations = [];
            for (let i = 1; i < windowResults.length; i++) {
                if (windowResults[i].count < windowResults[i - 1].count) {
                    monotonicityViolations.push(`${windowResults[i - 1].label}(${windowResults[i - 1].count}) > ${windowResults[i].label}(${windowResults[i].count})`);
                }
            }
            const firstNonZero = windowResults.find(result => result.count > 0);
            const shape = windowResults.every(result => result.count === 0)
                ? 'no_data_all_windows'
                : firstNonZero && firstNonZero.days <= 14
                    ? 'healthy_or_fast_recording_curve'
                    : firstNonZero && firstNonZero.days <= 30
                        ? 'recording_lag_curve'
                        : 'possible_data_freshness_gap';

            return Response.json({
                success: true,
                diagnostic: 'window_coverage',
                location_mode: hasPolygon ? 'polygon' : (body.query ? 'query' : 'city_state'),
                date_filter: dateFilter,
                api_requests: windows.length,
                billing_credits: null,
                billing_status: 'unverified_confirm_in_batchdata_dashboard',
                window_coverage: windowResults,
                is_monotonic: monotonicityViolations.length === 0,
                monotonicity_note: monotonicityViolations.length === 0
                    ? 'All windows are monotonically non-decreasing.'
                    : `WARNING: Non-monotonic windows detected: ${monotonicityViolations.join(', ')}`,
                recording_lag_estimate: firstNonZero ? `<= ${firstNonZero.days} days` : 'no_data_all_windows',
                curve_shape: shape
            });
        }

        if (body.endpoint_comparison === true) {
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            const hasPolygon = hasUsablePolygon(body.polygon);
            const hasCityState = !!(body.city && body.state);
            if (!hasPolygon && !hasCityState && !body.query) {
                return Response.json({ success: false, error: 'endpoint_comparison requires polygon, query, or city/state.' }, { status: 400 });
            }

            const compSoldMonths = body.sold_months ?? 3;
            const compTake = clampInteger(body.take, 25, 1, BATCHDATA_MAX_TAKE);
            const lookupTake = clampInteger(body.lookup_take, 5, 0, 20);
            const soldMinDate = isoDateDaysAgo(soldWindowDays(compSoldMonths));
            const job = diagnosticJobFromBody(body, compSoldMonths);
            const variants = endpointComparisonVariantPayloads({
                polygon: body.polygon || [],
                city: body.city,
                state: body.state,
                query: body.query,
                soldMinDate,
                take: compTake
            });
            const results = [];
            const recordsByVariant = {};
            let totalApiRequests = 0;
            let totalSearchRecordsReviewed = 0;

            for (const label of ['A', 'B', 'C', 'D', 'E', 'F']) {
                const variant = variants[label];
                if (variant.skip_reason || !variant.payload) {
                    results.push({ variant: label, description: variant.description, skipped: true, skip_reason: variant.skip_reason || 'missing_payload', api_requests: 0 });
                    continue;
                }
                try {
                    totalApiRequests++;
                    const response = await batchDataFetchWithRetry(variant.payload);
                    const records = extractBatchDataRecords(response);
                    recordsByVariant[label] = records;
                    totalSearchRecordsReviewed += records.length;
                    results.push({
                        request: variant.payload,
                        api_requests: 1,
                        ...collectBatchDataDiagnosticMetrics(records, {
                            variant: label,
                            description: variant.description,
                            creditsUsed: records.length,
                            providerTotal: extractBatchDataTotal(response),
                            job,
                            soldMinDate
                        })
                    });
                } catch (error) {
                    results.push({
                        variant: label,
                        description: variant.description,
                        request: variant.payload,
                        error: String(error?.message || error),
                        api_requests: 1
                    });
                }
                await sleep(300);
            }

            const countResponse = await batchDataFetchWithRetry(variants.H.payload);
            totalApiRequests++;
            results.push({
                variant: 'H',
                description: variants.H.description,
                request: variants.H.payload,
                api_requests: 1,
                billing_credits: null,
                billing_status: 'unverified_confirm_in_batchdata_dashboard',
                provider_total: extractBatchDataTotal(countResponse)
            });

            const lookup = lookupTake > 0
                ? await runBatchDataLookupEnrichment(recordsByVariant.A || [], body.addresses || [], body.lookup_datasets || BATCHDATA_SEARCH_DATASETS, lookupTake)
                : { api_requests: 0, billing_credits: null, billing_status: 'not_requested', addresses_processed: 0, results: [], summary: {} };
            totalApiRequests += lookup.api_requests || 0;
            results.push({
                variant: 'G',
                description: 'lookup_all_attributes_on_variant_a_addresses',
                lookup_endpoint: BATCHDATA_LOOKUP_BASE,
                datasets_requested: body.lookup_datasets || BATCHDATA_SEARCH_DATASETS,
                ...lookup
            });

            const byVariant = Object.fromEntries(results.map(result => [result.variant, result]));
            return Response.json({
                success: true,
                diagnostic: 'endpoint_comparison',
                location_mode: hasPolygon ? 'polygon' : (body.query ? 'query' : 'city_state'),
                sold_months: compSoldMonths,
                sold_min_date: soldMinDate,
                take_per_variant: compTake,
                api_requests: totalApiRequests,
                search_records_reviewed: totalSearchRecordsReviewed,
                billing_credits: null,
                billing_status: 'unverified_confirm_in_batchdata_dashboard',
                variants: results,
                summary: {
                    variant_A_records: byVariant.A?.records_returned ?? 0,
                    variant_B_vs_A_delta: (byVariant.B?.records_returned ?? 0) - (byVariant.A?.records_returned ?? 0),
                    variant_D_vs_A_delta: (byVariant.D?.records_returned ?? 0) - (byVariant.A?.records_returned ?? 0),
                    variant_F_records: byVariant.F?.records_returned ?? 0,
                    lookup_intel_populated: lookup.summary?.addresses_with_intel_lastSoldDate ?? 0,
                    lookup_land_use_populated: lookup.summary?.addresses_with_landUseCode ?? 0,
                    lookup_enrichment_capability: lookup.summary?.enrichment_capability || 'NOT_TESTED',
                    recommendation: lookup.summary?.enrichment_capability === 'LOOKUP_ADDS_FIELDS'
                        ? 'Use Search for polygon discovery and targeted Lookup only for ambiguous candidates.'
                        : 'Keep production on paginated Search and do not enable paid two-step enrichment until BatchData activates or documents a Lookup contract that adds the required fields.'
                }
            });
        }

        if (body.penetration_audit === true) {
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            if (!hasUsablePolygon(body.polygon)) {
                return Response.json({ success: false, error: 'penetration_audit requires polygon with at least 3 distinct points.' }, { status: 400 });
            }

            const auditSoldMonths = body.sold_months ?? 3;
            const auditTake = clampInteger(body.take, 100, 1, BATCHDATA_MAX_TAKE);
            const auditMaxRecords = clampInteger(body.max_records, 5000, 100, 5000);
            const soldMinDate = isoDateDaysAgo(soldWindowDays(auditSoldMonths));
            const job = diagnosticJobFromBody(body, auditSoldMonths);
            const variants = endpointComparisonVariantPayloads({
                polygon: body.polygon,
                city: body.city,
                state: body.state,
                query: body.query,
                soldMinDate,
                take: auditTake
            });
            const [auditD, auditB] = await Promise.all([
                fetchAllBatchDataDiagnosticRecords(variants.D.payload, auditMaxRecords),
                fetchAllBatchDataDiagnosticRecords(variants.B.payload, auditMaxRecords)
            ]);
            const recordsD = auditD.records;
            const recordsB = auditB.records;
            const metricsD = collectBatchDataDiagnosticMetrics(recordsD, {
                variant: 'D',
                description: variants.D.description,
                creditsUsed: recordsD.length,
                providerTotal: auditD.providerTotal,
                job,
                soldMinDate
            });
            const metricsB = collectBatchDataDiagnosticMetrics(recordsB, {
                variant: 'B',
                description: variants.B.description,
                creditsUsed: recordsB.length,
                providerTotal: auditB.providerTotal,
                job,
                soldMinDate
            });

            const redfinGroundTruth = Number(body.redfin_ground_truth_count);
            const auditComplete = auditD.complete && auditB.complete;
            const productionCandidateCount = auditD.providerTotal ?? auditD.rawReviewed;
            const candidateCountRatio = auditD.complete && Number.isFinite(redfinGroundTruth) && redfinGroundTruth > 0
                ? Number(((productionCandidateCount / redfinGroundTruth) * 100).toFixed(1))
                : null;
            const verdict = !auditComplete
                ? 'INCOMPLETE_PAGINATION_NO_PENETRATION_VERDICT'
                : 'EXTERNAL_RECORD_LEVEL_MATCH_REQUIRED';

            return Response.json({
                success: true,
                diagnostic: 'penetration_audit',
                sold_months: auditSoldMonths,
                sold_min_date: soldMinDate,
                api_requests: auditD.pages + auditB.pages,
                estimated_record_units: auditD.rawReviewed + auditB.rawReviewed,
                billing_status: 'unverified_confirm_in_batchdata_dashboard',
                pagination: {
                    max_records_per_variant: auditMaxRecords,
                    production_variant_D: { pages: auditD.pages, raw_reviewed: auditD.rawReviewed, complete: auditD.complete, truncated: auditD.truncated },
                    variant_B: { pages: auditB.pages, raw_reviewed: auditB.rawReviewed, complete: auditB.complete, truncated: auditB.truncated }
                },
                requests: {
                    production_variant_D: variants.D.payload,
                    variant_B: variants.B.payload
                },
                production_variant_D: metricsD,
                variant_B: metricsB,
                redfin_ground_truth_count: Number.isFinite(redfinGroundTruth) ? redfinGroundTruth : null,
                provider_candidate_count: productionCandidateCount,
                candidate_count_ratio_vs_external_pct: candidateCountRatio,
                penetration_rate_vs_redfin_pct: null,
                penetration_status: 'NOT_CALCULABLE_WITHOUT_RECORD_LEVEL_EXTERNAL_MATCH_AND_MATCHED_SFR_DEFINITION',
                verdict,
                recommendation: verdict === 'INCOMPLETE_PAGINATION_NO_PENETRATION_VERDICT'
                    ? 'Increase max_records or narrow the polygon. Never calculate coverage from a partial result set.'
                    : 'Use a licensed record-level sold-SFR benchmark and address/property-ID matching. The candidate-count ratio is descriptive only and must not be labeled penetration.'
            });
        }

        if (body.lookup_enrichment === true) {
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            const lookupTake = clampInteger(body.take, 5, 1, 50);
            const datasets = body.datasets || BATCHDATA_SEARCH_DATASETS;
            let searchRecords = [];
            let searchRequest = null;

            if (!Array.isArray(body.addresses) || body.addresses.length === 0) {
                const soldMonths = body.sold_months ?? 3;
                const soldMinDate = isoDateDaysAgo(soldWindowDays(soldMonths));
                searchRequest = buildBatchDataSearchPayload({
                    polygon: body.polygon || [],
                    city: body.city,
                    state: body.state,
                    query: body.query,
                    dateFilters: [body.date_filter || 'intel.lastSoldDate'],
                    soldMinDate,
                    datasets: BATCHDATA_SEARCH_DATASETS,
                    take: lookupTake
                });
                const searchResponse = await batchDataFetchWithRetry(searchRequest);
                searchRecords = extractBatchDataRecords(searchResponse);
            }

            if ((!Array.isArray(body.addresses) || body.addresses.length === 0) && searchRecords.length === 0) {
                return Response.json({ success: false, error: 'lookup_enrichment requires addresses or a search area that returns addresses.' }, { status: 400 });
            }

            const lookup = await runBatchDataLookupEnrichment(searchRecords, body.addresses || [], datasets, lookupTake);
            return Response.json({
                success: true,
                diagnostic: 'lookup_enrichment',
                lookup_endpoint: BATCHDATA_LOOKUP_BASE,
                datasets_requested: datasets,
                search_request: searchRequest,
                ...lookup
            });
        }

        if (body.raw_discovery === true) {
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            const soldMonths = Number(body.sold_months || 3);
            const soldMinDate = isoDateDaysAgo(soldWindowDays(soldMonths));
            const take = clampInteger(body.take, 25, 1, 50);
            const area = { polygon: body.polygon || [], city: body.city, state: body.state };
            const countRequest = buildBatchDataAreaPayload({ ...area, take: 0 });
            const probeRequest = buildBatchDataAreaPayload({ ...area, soldMinDate, take });
            const countPayload = await batchDataFetchWithRetry(countRequest);
            const probePayload = await batchDataFetchWithRetry(probeRequest);
            const records = extractBatchDataRecords(probePayload);

            return Response.json({
                success: true,
                diagnostic: 'raw_discovery',
                location_mode: hasUsablePolygon(area.polygon) ? 'polygon' : 'city_state',
                sold_months: soldMonths,
                sold_min_date: soldMinDate,
                estimated_credits_used: 1 + records.length,
                count_request: countRequest,
                count_total_no_date_filter: extractBatchDataTotal(countPayload),
                probe_request: probeRequest,
                probe_total_with_sold_filter: extractBatchDataTotal(probePayload),
                raw_returned: records.length,
                ...summarizeTypeFrequencies(records),
                date_distribution: summarizeIntelLastSoldDates(records, soldMinDate),
                raw_samples: records.slice(0, 5).map(rawDiscoverySample)
            });
        }

        if (body.polygon_intel_verify === true) {
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            if (!hasUsablePolygon(body.polygon)) {
                return Response.json({ success: false, error: 'polygon_intel_verify requires a polygon with at least 3 distinct points.' }, { status: 400 });
            }
            if (!body.city || !body.state) {
                return Response.json({ success: false, error: 'polygon_intel_verify requires city and state for the support comparison probe.' }, { status: 400 });
            }

            const soldMonths = Number(body.sold_months || 3);
            const soldMinDate = isoDateDaysAgo(soldWindowDays(soldMonths));
            const take = clampInteger(body.take, 25, 1, 25);
            const runProbe = async (label, request) => {
                const payload = await batchDataFetchWithRetry(request);
                const records = extractBatchDataRecords(payload);
                return {
                    label,
                    request,
                    raw: records.length,
                    total: extractBatchDataTotal(payload),
                    estimated_credits_used: records.length,
                    date_distribution: summarizeIntelLastSoldDates(records, soldMinDate),
                    samples: records.slice(0, 3).map(rawDiscoverySample)
                };
            };
            const probeA = await runProbe('A_polygon_plus_intel_lastSoldDate', buildBatchDataAreaPayload({ polygon: body.polygon, soldMinDate, take }));
            const probeB = await runProbe('B_city_state_plus_intel_lastSoldDate', buildBatchDataAreaPayload({ city: body.city, state: body.state, soldMinDate, take }));
            const probeC = await runProbe('C_polygon_no_date_filter', buildBatchDataAreaPayload({ polygon: body.polygon, take }));
            const probeCount = (probe) => Number(probe.total ?? probe.raw ?? 0);
            const probeADatePresent = Number(probeA.date_distribution.provider_sale_date_present || probeA.date_distribution.intel_last_sold_date_present || 0) > 0;

            let verdict = 'POLYGON_INVALID_OR_NO_DATA';
            let action = 'Check the polygon coordinates and whether BatchData has any property inventory in this boundary.';
            if (probeCount(probeA) > 0 && !probeADatePresent) {
                verdict = 'DATE_FIELD_ABSENT_UNVERIFIABLE';
                action = 'Records returned, but no sale date field was present to verify whether intel.lastSoldDate was applied.';
            } else if (probeCount(probeA) > 0 && probeA.date_distribution.outside_window === 0 && probeCount(probeB) > 0) {
                verdict = 'INTEL_WORKS_WITH_POLYGON';
                action = 'Proceed with PR validation after TEST-09 and TEST-11 pass against live data.';
            } else if (probeCount(probeA) > 0 && probeA.date_distribution.outside_window > 0) {
                verdict = 'SILENT_IGNORE_DETECTED';
                action = 'Do not merge. Escalate to BatchData because polygon + intel returned records outside the requested sold window.';
            } else if (probeCount(probeA) === 0 && probeCount(probeB) > 0 && probeCount(probeC) > 0) {
                verdict = 'INTEL_INCOMPATIBLE_WITH_POLYGON';
                action = 'Escalate to BatchData support. City/state + intel works while polygon + intel does not.';
            } else if (probeCount(probeA) === 0 && probeCount(probeB) === 0 && probeCount(probeC) > 0) {
                verdict = 'DATA_FRESHNESS_GAP';
                action = 'Widen the sold-date window and show market-health messaging for this area.';
            }

            return Response.json({
                success: true,
                diagnostic: 'polygon_intel_verify',
                sold_months: soldMonths,
                sold_min_date: soldMinDate,
                estimated_credits_used: probeA.estimated_credits_used + probeB.estimated_credits_used + probeC.estimated_credits_used,
                verdict,
                action,
                probes: [probeA, probeB, probeC]
            });
        }

        if (body.r2_coverage_audit === true) {
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            if (!hasUsablePolygon(body.polygon)) {
                return Response.json({ success: false, error: 'r2_coverage_audit requires a polygon with at least 3 distinct points.' }, { status: 400 });
            }

            const soldMonths = Number(body.sold_months || 3);
            const soldMinDate = isoDateDaysAgo(soldWindowDays(soldMonths));
            const auditTake = 50;
            const r2Request = buildBatchDataAreaPayload({ polygon: body.polygon, soldMinDate, take: auditTake, includeR2: true });
            const broadRequest = buildBatchDataAreaPayload({ polygon: body.polygon, soldMinDate, take: auditTake });
            const r2Payload = await batchDataFetchWithRetry(r2Request);
            const broadPayload = await batchDataFetchWithRetry(broadRequest);
            const r2Records = extractBatchDataRecords(r2Payload);
            const broadRecords = extractBatchDataRecords(broadPayload);
            let r2Count = 0;
            let nonR2ExplicitSFR = 0;
            let nonR2NoSFREvidence = 0;
            const nonR2ExplicitSFRSamples = [];
            const nonR2NoSFREvidenceSamples = [];

            for (const record of broadRecords) {
                const fields = batchDataTypeFields(record);
                const isR2 = String(fields.land_use || '').toUpperCase() === 'R2';
                const explicitSFR = isExplicitSingleFamilyType(fields.property_type);
                if (isR2) {
                    r2Count++;
                } else if (explicitSFR) {
                    nonR2ExplicitSFR++;
                    if (nonR2ExplicitSFRSamples.length < 5) nonR2ExplicitSFRSamples.push(rawDiscoverySample(record));
                } else {
                    nonR2NoSFREvidence++;
                    if (nonR2NoSFREvidenceSamples.length < 5) nonR2NoSFREvidenceSamples.push(rawDiscoverySample(record));
                }
            }

            const r2CoveragePct = broadRecords.length > 0 ? Number(((r2Count / broadRecords.length) * 100).toFixed(1)) : null;
            const missingLandUseCount = broadRecords.reduce((count, record) => {
                const fields = batchDataTypeFields(record);
                return count + (fields.land_use === 'missing' ? 1 : 0);
            }, 0);
            const missingLandUsePct = broadRecords.length > 0 ? Number(((missingLandUseCount / broadRecords.length) * 100).toFixed(1)) : null;
            let recommendation = 'INCONCLUSIVE_NO_BROAD_RECORDS';
            if (broadRecords.length > 0 && missingLandUsePct !== null && missingLandUsePct >= 80) {
                recommendation = 'BATCHDATA_R2_METADATA_UNAVAILABLE_USE_BROAD_PLUS_LOCAL_FILTERS';
            } else if (r2CoveragePct !== null && r2CoveragePct >= 95) {
                recommendation = 'R2_FILTER_SAFE_FOR_THIS_MARKET';
            } else if (r2CoveragePct !== null && r2CoveragePct >= 85) {
                recommendation = 'PR15_IMPORTANT_NON_R2_SFR_EXISTS_REVIEW_SAMPLES';
            } else if (r2CoveragePct !== null) {
                recommendation = 'PR15_CRITICAL_R2_FILTER_DROPS_TOO_MANY_RECORDS';
            }

            return Response.json({
                success: true,
                diagnostic: 'r2_coverage_audit',
                sold_months: soldMonths,
                sold_min_date: soldMinDate,
                estimated_credits_used: r2Records.length + broadRecords.length,
                recommendation,
                r2_request: r2Request,
                broad_request: broadRequest,
                r2_pull: {
                    raw: r2Records.length,
                    total: extractBatchDataTotal(r2Payload)
                },
                broad_pull: {
                    raw: broadRecords.length,
                    total: extractBatchDataTotal(broadPayload),
                    r2Count,
                    nonR2ExplicitSFR,
                    nonR2NoSFREvidence,
                    r2CoveragePct,
                    missingLandUseCount,
                    missingLandUsePct,
                    nonR2ExplicitSFRSamples,
                    nonR2NoSFREvidenceSamples
                }
            });
        }

        if (body.market_health_check === true) {
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            const soldMinDate = isoDateDaysAgo(90);
            const area = { polygon: body.polygon || [], city: body.city, state: body.state };
            const totalRequest = buildBatchDataAreaPayload({ ...area, take: 0 });
            const recentRequest = buildBatchDataAreaPayload({ ...area, soldMinDate, take: 10 });
            const totalPayload = await batchDataFetchWithRetry(totalRequest);
            const recentPayload = await batchDataFetchWithRetry(recentRequest);
            const recentRecords = extractBatchDataRecords(recentPayload);
            const dates = recentRecords.map(intelLastSoldDate).filter(Boolean).sort();
            const newestSaleDateObserved = dates[dates.length - 1] || null;
            const estimatedLagDays = newestSaleDateObserved
                ? Math.max(0, Math.round((Date.now() - new Date(`${newestSaleDateObserved}T00:00:00Z`).getTime()) / (24 * 60 * 60 * 1000)))
                : null;
            const recommendedWindowDays = estimatedLagDays === null
                ? 90
                : estimatedLagDays <= 14
                    ? 30
                    : estimatedLagDays <= 30
                        ? 60
                        : estimatedLagDays <= 60
                            ? 90
                            : 180;

            return Response.json({
                success: true,
                diagnostic: 'market_health_check',
                estimated_credits_used: 1 + recentRecords.length,
                location_mode: hasUsablePolygon(area.polygon) ? 'polygon' : 'city_state',
                total_request: totalRequest,
                recent_request: recentRequest,
                total_properties: extractBatchDataTotal(totalPayload),
                properties_sold_last_90_days: extractBatchDataTotal(recentPayload),
                recent_records_returned: recentRecords.length,
                newest_sale_date_observed: newestSaleDateObserved,
                estimated_lag_days: estimatedLagDays,
                recommended_window_days: recommendedWindowDays,
                date_distribution: summarizeIntelLastSoldDates(recentRecords, soldMinDate),
                samples: recentRecords.slice(0, 3).map(rawDiscoverySample)
            });
        }

        if (body.request_preview === true) {
            const previewJob = body.job || {
                polygon: body.polygon || [
                    { lat: 33.4622, lng: -112.1866 },
                    { lat: 33.3493, lng: -112.1915 },
                    { lat: 33.2931, lng: -112.1338 }
                ],
                latitude: body.latitude || 33.37,
                longitude: body.longitude || -112.08,
                sold_months: body.sold_months || 12,
                dry_run_metadata: previewDryRunMetadata(body)
            };
            return Response.json({
                success: true,
                requests: {
                    broad_polygon: buildBatchDataRequest(previewJob, 0, BATCHDATA_MAX_TAKE, 'broad_polygon'),
                    strict_polygon: buildBatchDataRequest(previewJob, 0, BATCHDATA_MAX_TAKE, 'strict_polygon'),
                    support_query_place: buildBatchDataRequest(previewJob, 0, BATCHDATA_MAX_TAKE, 'support_query_place'),
                    support_structured_place: buildBatchDataRequest(previewJob, 0, BATCHDATA_MAX_TAKE, 'support_structured_place')
                }
            });
        }

        if (body.map_preview === true) {
            const previewJob = body.job || {
                polygon: body.polygon || [],
                sold_months: body.sold_months || 12,
                dry_run_metadata: previewDryRunMetadata(body)
            };
            const records = Array.isArray(body.synthetic_records) ? body.synthetic_records : [];
            const mapped = records.map(record => mapBatchDataProperty(record, previewJob)).filter(Boolean);
            return Response.json({ success: true, raw: records.length, mapped: mapped.length, active: mapped.filter(p => p.route_active !== false).length, properties: mapped });
        }

        if (body.fetch_preview === true) {
            if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
            const previewJob = body.job || {
                polygon: body.polygon || [],
                latitude: body.latitude || 33.37,
                longitude: body.longitude || -112.08,
                sold_months: body.sold_months || 12,
                estimated_record_count: body.requested_properties || 2,
                total_expected: body.requested_properties || 2,
                dry_run_metadata: previewDryRunMetadata(body)
            };
            const batchFetch = await fetchBatchDataRecords(previewJob);
            const mapped = batchFetch.records.map(record => mapBatchDataProperty(record, previewJob)).filter(Boolean);
            return Response.json({ success: true, mode_used: batchFetch.mode_used, attempts: batchFetch.attempts, raw: batchFetch.records.length, mapped: mapped.length, active: mapped.filter(p => p.route_active !== false).length });
        }

        if (body.raw_probe === true) {
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
                    dry_run_metadata: previewDryRunMetadata(body)
                };
            }
            const take = Math.min(Math.max(Number(body.take) || 10, 1), 10);
            const probes = [
                { label: 'broad_exact_date', mode: 'broad_polygon', omitSoldDate: false },
                { label: 'strict_exact_date', mode: 'strict_polygon', omitSoldDate: false },
                { label: 'support_query_exact_date', mode: 'support_query_place', omitSoldDate: false },
                { label: 'support_structured_exact_date', mode: 'support_structured_place', omitSoldDate: false },
                { label: 'broad_no_sold_date', mode: 'broad_polygon', omitSoldDate: true }
            ];
            const results = [];
            for (const probe of probes) {
                const requestBody = buildBatchDataRequest(previewJob, 0, take, probe.mode);
                if (!requestBody) {
                    results.push({
                        label: probe.label,
                        skipped: true,
                        reason: 'missing_place_metadata_for_support_payload'
                    });
                    continue;
                }
                if (probe.omitSoldDate) {
                    delete requestBody.searchCriteria.intel;
                    delete requestBody.searchCriteria.sale;
                }
                const payload = await batchDataFetchWithRetry(requestBody);
                const records = extractBatchDataRecords(payload);
                const mapped = records.map(record => mapBatchDataProperty(record, previewJob)).filter(Boolean);
                const samples = records.slice(0, 3).map((record) => {
                    const p = batchDataRecordProperty(record);
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
                        property_type: firstValue(p.general?.propertyTypeDetail, p.general?.propertyType, p.propertyType, p.landUse, p.building?.propertyType),
                        mapped_active: mappedProperty?.route_active === true,
                        mapped_status: mappedProperty?.original_status || null,
                        mapped_property_type: mappedProperty?.property_type || null,
                        mapped_sold_date: mappedProperty?.sold_date || null,
                        mapped_sale_date_source: mappedProperty?.sale_date_source || null,
                        mapped_rejection_reason: mappedProperty?.rejection_reason || null,
                        mapped_metadata_completeness: mappedProperty?.metadata_completeness || null
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
            return Response.json({ success: true, job_id: previewJob.id || null, sold_months: previewJob.sold_months, results });
        }


        if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
        if (!DATABASE_URL) throw new Error('DATABASE_URL is not configured');

        let job = null;
        if (targetJobId) {
            job = await base44.asServiceRole.entities.FetchJob.get(targetJobId).catch(() => null);
            if (!job) return Response.json({ error: 'Job not found', job_id: targetJobId }, { status: 404 });
        } else {
            const running = await base44.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', 1);
            const runningArr = Array.isArray(running) ? running : (running?.items || []);
            job = runningArr[0];
            if (!job) {
                const pending = await base44.asServiceRole.entities.FetchJob.filter({ status: 'pending' }, 'created_date', 1);
                const pendingArr = Array.isArray(pending) ? pending : (pending?.items || []);
                job = pendingArr[0];
            }
        }
        if (!job) return Response.json({ idle: true, active_provider: 'batchdata' });
        if (job.status === 'cancelled') return Response.json({ status: 'cancelled', job_id: job.id });
        if (targetJobId && !['pending', 'running'].includes(job.status)) {
            return Response.json({ skipped: true, reason: `job_${job.status || 'inactive'}`, job_id: job.id, status: job.status });
        }

        const expectedChunk = body.expected_chunk ?? null;
        if (expectedChunk !== null && (job.chunk_number || 0) !== expectedChunk) {
            return Response.json({ skipped: true, reason: 'duplicate_invocation', job_id: job.id });
        }

        const claim = await claimPipelineLock(base44, job.id, crypto.randomUUID());
        if (!claim.claimed) return Response.json({ skipped: true, reason: claim.reason, job_id: job.id });
        lockId = claim.lockId;

        const processingElection = await verifyCanonicalProcessingFetchJob(base44, job);
        if (!processingElection.isWinner) {
            const lockReleased = await releasePipelineLock(base44, lockId);
            lockId = null;
            return Response.json({
                skipped: true,
                reason: processingElection.reason,
                job_id: job.id,
                canonical_job_id: processingElection.canonicalJob?.id || null,
                cancelled_own_job: processingElection.cancelledOwnJob === true,
                lock_release_confirmed: lockReleased
            });
        }

        const startedAt = job.started_at || new Date().toISOString();
        await base44.asServiceRole.entities.FetchJob.update(job.id, {
            status: 'running',
            started_at: startedAt,
            provider: 'batchdata',
            mode_tag: 'PRECISION_TARGET',
            phase: 'batchdata_precision',
            progress_pct: Math.max(job.progress_pct || 0, 5),
            dry_run_metadata: {
                ...(job.dry_run_metadata || {}),
                job_membership_contract: JOB_MEMBERSHIP_CONTRACT
            }
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
        const batchFetch = Array.isArray(body.synthetic_records)
            ? { records: body.synthetic_records, attempts: [{ mode: 'synthetic_records', count: body.synthetic_records.length }], mode_used: 'synthetic_records' }
            : await fetchBatchDataRecords(job, updateScanProgress);
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
            if (property.route_active !== true || property.original_status === 'REJECTED' || property.sale_confidence === 'REJECTED') {
                rejected++;
                continue;
            }
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
            mapped.push(property);
        }

        const result = await writePropertiesToNeon(sql, mapped, job, excludedRouteHashes);
        const completedAt = new Date().toISOString();
        const activeCount = result.published;
        const requestedCount = Number(job.total_expected || job.estimated_record_count || 0) || 0;
        const reviewedCount = (batchFetch.attempts || []).reduce((sum, attempt) => sum + (Number(attempt.reviewed) || 0), 0);
        const skippedExistingRouteFromFetch = (batchFetch.attempts || []).reduce((sum, attempt) => sum + (Number(attempt.skipped_existing_route) || 0), 0);
        const skippedDuplicateFromFetch = (batchFetch.attempts || []).reduce((sum, attempt) => sum + (Number(attempt.skipped_duplicate) || 0), 0);
        const skippedRouteTypeFromFetch = (batchFetch.attempts || []).reduce((sum, attempt) => sum + (Number(attempt.skipped_route_type) || 0), 0);
        const skippedAssignedAtPublish = Math.max(0, mapped.length - result.published);
        const totalSkippedExistingRoute = skippedExistingRouteFromFetch + skippedExistingRoute + skippedAssignedAtPublish;
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
        const providerTotalsBySource = Object.fromEntries((batchFetch.attempts || [])
            .filter(attempt => attempt.total !== null && attempt.total !== undefined && Number.isFinite(Number(attempt.total)))
            .map(attempt => [attempt.mode, Number(attempt.total)]));
        const providerTotals = Object.values(providerTotalsBySource);
        const providerTotalLowerBound = providerTotals.length > 0 ? Math.max(...providerTotals) : null;
        const providerTotalUpperBound = providerTotals.length > 0 ? providerTotals.reduce((sum, total) => sum + total, 0) : null;
        const firstAttempt = (batchFetch.attempts || [])[0] || {};
        const reviewedRejectedCount = (batchFetch.attempts || []).reduce((sum, attempt) => (
            sum + Number(attempt.credit_efficiency_report?.records_rejected_local_filter || 0)
        ), 0);
        const aggregateRejectionBreakdown = (batchFetch.attempts || []).reduce((acc, attempt) => {
            for (const [reason, count] of Object.entries(attempt.credit_efficiency_report?.rejection_breakdown || {})) {
                acc[reason] = (acc[reason] || 0) + (Number(count) || 0);
            }
            return acc;
        }, {});
        const discoveredAcrossSources = (batchFetch.attempts || []).reduce((sum, attempt) => sum + (Number(attempt.discovered) || 0), 0);
        const crossSourceDuplicates = Math.max(0, discoveredAcrossSources - Number(batchFetch.union_unique_records || 0));
        const batchDataApiCalls = (batchFetch.attempts || []).reduce((sum, attempt) => (
            sum + Number(attempt.http_requests ?? (Number(attempt.count_probe_requests || 0) + (Array.isArray(attempt.page_timings) ? attempt.page_timings.length : 0)))
        ), 0);
        const marketShortfallReason = activeCount >= requestedCount
            ? 'target_met'
            : reviewedCount > 0 && activeCount === 0 && (Number(firstAttempt.reviewed) || 0) > 0
                ? 'local_filter_rejection'
                : (Number(firstAttempt.total || providerTotalLowerBound) || 0) > 0 && activeCount < requestedCount
                    ? 'date_window_too_narrow'
                    : rawRecords.length === 0
                        ? 'market_data_gap'
                        : 'polygon_too_small';
        const completionReason = activeCount >= requestedCount
            ? 'target_met'
            : totalSkippedExistingRoute > 0
                ? 'insufficient_new_homes_after_existing_routes'
                : totalSkippedRouteType > 0
                    ? 'insufficient_homes_after_property_type_filters'
            : rawRecords.length === 0
                ? 'no_provider_matches'
                : 'insufficient_qualifying_homes';
        const batchdataSummary = {
            mode_used: batchFetch.mode_used,
            attempts: batchFetch.attempts,
            requested: requestedCount,
            reviewed: reviewedCount || rawRecords.length,
            provider_total: providerTotalLowerBound,
            provider_total_is_exact_union: false,
            provider_total_lower_bound: providerTotalLowerBound,
            provider_total_upper_bound: providerTotalUpperBound,
            provider_totals_by_source: providerTotalsBySource,
            union_unique_records: batchFetch.union_unique_records ?? rawRecords.length,
            eligible_union_records: batchFetch.eligible_union_records ?? activeCount,
            source_membership: batchFetch.source_membership || null,
            cross_source_duplicates: crossSourceDuplicates,
            union_truncated_by_plan_cap: batchFetch.union_truncated_by_plan_cap === true,
            scan_truncated: (batchFetch.attempts || []).some(attempt => attempt.scan_truncated === true),
            max_reviewed_per_source: Math.max(0, ...(batchFetch.attempts || []).map(attempt => Number(attempt.max_reviewed) || 0)),
            sold_min_date: requestedClosedSaleWindow(job).minDate,
            sold_max_date: requestedClosedSaleWindow(job).maxDate,
            market_shortfall_reason: marketShortfallReason,
            credit_efficiency_by_source: Object.fromEntries((batchFetch.attempts || []).map(attempt => [attempt.mode, attempt.credit_efficiency_report || null])),
            rejection_breakdown: aggregateRejectionBreakdown,
            filters: {
                min_price: Math.max(DEFAULT_PRECISION_MIN_HOME_VALUE, Number(job?.dry_run_metadata?.filters?.min_price) || DEFAULT_PRECISION_MIN_HOME_VALUE),
                max_price: Number(job?.dry_run_metadata?.filters?.max_price) || null,
                standardized_land_use_code: 'R2',
                listing_status_categories_excluded: ['Active', 'Pending']
            },
            // Preserve the original diagnostic keys for older clients while the
            // explicit names below distinguish selected samples from all reviewed rows.
            raw: rawRecords.length,
            rejected: reviewedRejectedCount,
            selected_raw_payloads: rawRecords.length,
            mapped: mapped.length,
            active: activeCount,
            rejected_reviewed: reviewedRejectedCount,
            rejected_selected_samples: rejected,
            outside_or_invalid: outsideOrInvalid,
            skipped_existing_route: totalSkippedExistingRoute,
            skipped_assigned_at_publish: skippedAssignedAtPublish,
            skipped_duplicate: skippedDuplicateFromFetch,
            skipped_route_type: totalSkippedRouteType,
            skipped_route_type_breakdown: skippedRouteTypeBreakdownTotal
        };
        const errorLog = [...(job.error_log || []), `[${completedAt}] BatchData-only Precision complete: mode=${batchFetch.mode_used}, reviewed=${reviewedCount}, selected_raw=${rawRecords.length}, mapped=${mapped.length}, active=${activeCount}, rejected_reviewed=${reviewedRejectedCount}, rejected_selected_samples=${rejected}, outside_or_invalid=${outsideOrInvalid}, skipped_existing_route=${totalSkippedExistingRoute}, skipped_assigned_at_publish=${skippedAssignedAtPublish}, skipped_duplicate=${skippedDuplicateFromFetch}, skipped_route_type=${totalSkippedRouteType}`];

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

        await base44.asServiceRole.entities.FetchJob.update(job.id, {
            status: 'completed',
            phase: 'complete',
            progress_pct: 100,
            completed_at: completedAt,
            ...(integrityWarning ? { error_message: integrityWarning } : {}),
            total_fetched: reviewedCount || rawRecords.length,
            total_inserted: result.inserted,
            total_existed: result.existed,
            total_updated: result.updated,
            total_api_calls: (job.total_api_calls || 0) + (Array.isArray(body.synthetic_records) ? 0 : batchDataApiCalls),
            total_batchdata_calls: (job.total_batchdata_calls || 0) + (Array.isArray(body.synthetic_records) ? 0 : batchDataApiCalls),
            completed_sub_circles: 1,
            total_sub_circles: 1,
            zip_codes_found: zipCodes,
            chunk_number: (job.chunk_number || 0) + 1,
            chunk_timings: [...(job.chunk_timings || []), Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)],
            dry_run_metadata: {
                ...(job.dry_run_metadata || {}),
                job_membership_contract: JOB_MEMBERSHIP_CONTRACT,
                precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
                completion_reason: completionReason,
                batchdata_summary: batchdataSummary
            },
            error_log: errorLog
        });

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
        return Response.json({ success: true, status: 'completed', job_id: job.id, precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT, active_provider: 'batchdata', mode_used: batchFetch.mode_used, attempts: batchFetch.attempts, raw: rawRecords.length, mapped: mapped.length, active: activeCount });
    } catch (error) {
        if (base44 && lockId) await releasePipelineLock(base44, lockId);
        console.error('[processFetchChunk batchdata-only] Fatal:', error.message);
        try {
            const recovery = base44 || createClientFromRequest(req);
            let failedJob = null;
            if (targetJobId) {
                failedJob = await recovery.asServiceRole.entities.FetchJob.get(targetJobId).catch(() => null);
            } else {
                const running = await recovery.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', 1);
                const arr = Array.isArray(running) ? running : (running?.items || []);
                failedJob = arr[0];
            }
            if (failedJob && ['pending', 'running'].includes(failedJob.status)) {
                await recovery.asServiceRole.entities.FetchJob.update(failedJob.id, {
                    status: 'failed',
                    error_message: `BatchData processing failed: ${error.message}`,
                    error_log: [...(failedJob.error_log || []), `[${new Date().toISOString()}] FATAL: ${error.message}`]
                });
            }
        } catch {}
        return Response.json({ error: error.message }, { status: 500 });
    }
});
