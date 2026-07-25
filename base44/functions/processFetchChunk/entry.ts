import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

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

    // Intentionally omit options.datasets. Live BatchData responses suppress
    // the intel/sale evidence required by Knock cards when this is scoped.
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

function normalizeWorkspaceEmail(value) {
    return String(value || '').trim().toLowerCase() || 'unknown';
}

async function writePropertiesToNeon(sql, properties, job, excludedRouteHashes = new Set()) {
    let inserted = 0, existed = 0, updated = 0;
    const customOwnershipRange = getCustomOwnershipRange(job);
    const workspaceEmail = normalizeWorkspaceEmail(job.user_email);

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
                VALUES (${created[0].id}, ${workspaceEmail}, ${job.id}, ${p.route_active !== false}, ${p.original_status}, NOW())
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
            VALUES (${existing.id}, ${workspaceEmail}, ${job.id}, ${p.route_active !== false}, ${p.original_status}, NOW())
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
            VALUES (${job.id}, ${workspaceEmail}, ${inserted}, ${updated}, ${existed})
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
        if (response.status >= 500 && attempt < 2) {
            await sleep(5000);
            continue;
        }
        throw new Error(`BatchData request failed (${response.status}): ${text.slice(0, 1000)}`);
    }
    throw new Error('Rate limit exceeded after 3 retries.');
}

async function fetchBatchDataRecordsForMode(job, mode, requested, onProgress = null) {
    const selected = [];
    const selectedHashes = new Set();
    const excludedRouteHashes = getExcludedRouteHashes(job);
    const routeTypeFilters = getRouteTypeFilters(job);
    const rejectedSamples = [];
    const pageTimings = [];
    let skip = 0;
    let reviewed = 0;
    let totalRecordCount = null;
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
            }).catch(() => {});
        }
        const pageStartedAt = Date.now();
        const payload = await batchDataFetchWithRetry(requestBody);
        const list = extractBatchDataRecords(payload);
        const pageElapsedMs = Date.now() - pageStartedAt;
        pageTimings.push({ skip, take, returned: list.length, elapsed_ms: pageElapsedMs });
        if (totalRecordCount === null) totalRecordCount = extractBatchDataTotal(payload);
        reviewed += list.length;

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
            }).catch(() => {});
        }

        if (list.length < take) break;
        if (totalRecordCount !== null && reviewed >= totalRecordCount) break;
        skip += take;
    }

    const scanLimitReached = selected.length < requested
        && reviewed >= maxReviewed
        && (totalRecordCount === null || reviewed < totalRecordCount);

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
        max_reviewed: maxReviewed,
        scan_limit_reached: scanLimitReached,
        page_timings: pageTimings,
        totalRecordCount
    };
}

async function fetchBatchDataRecords(job, onProgress = null) {
    const requested = Math.min(Math.max(Number(job.estimated_record_count || job.total_expected || 1000), 1), 1000);
    const modes = ['broad_polygon'];
    const attempts = [];
    let fallback = [];
    let fallbackMode = 'none';
    let fallbackActive = 0;

    for (const mode of modes) {
        const result = await fetchBatchDataRecordsForMode(job, mode, requested, onProgress);
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

class RepairHttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function repairEmail(value, required = false) {
    const email = String(value || '').trim().toLowerCase();
    if (!email && !required) return null;
    if (!email || email.length > 320 || /\s/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
        throw new RepairHttpError(400, 'invalid_target_email', 'target_email must be a valid email address.');
    }
    return email;
}

async function resolveRepairWorkspaceEmail(service, route, requestedEmail) {
    const creatorEmail = repairEmail(route?.created_by);
    if (requestedEmail && requestedEmail === creatorEmail) return requestedEmail;

    let managerEmail = null;
    const managerId = String(route?.manager_id || '').trim();
    if ((!creatorEmail || requestedEmail) && managerId) {
        const manager = await service.entities.User.get(managerId).catch(() => null);
        managerEmail = repairEmail(manager?.email);
    }
    if (requestedEmail) {
        if (requestedEmail === managerEmail) return requestedEmail;
        throw new RepairHttpError(403, 'route_tenant_mismatch', 'target_email does not match the saved route owner.');
    }
    if (creatorEmail) return creatorEmail;
    if (managerEmail) return managerEmail;
    throw new RepairHttpError(409, 'route_tenant_missing', 'The saved route does not have a verifiable workspace owner.');
}

function positiveRepairNumber(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object') {
            const nested = positiveRepairNumber(
                value.amount,
                value.value,
                value.estimatedValue,
                value.total,
                value.number,
                value.raw
            );
            if (nested !== null) return nested;
            continue;
        }
        const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function isMissingRepairPrice(value) {
    const price = Number(value);
    return value === null || value === undefined || value === ''
        || !Number.isFinite(price) || price <= 0;
}

function isMissingRepairDate(value) {
    return value === null || value === undefined || value === '';
}

function repairMetadataFromRecord(record, job, allowedHashes) {
    const mapped = mapBatchDataProperty(record, job);
    if (!mapped || !allowedHashes.has(String(mapped.address_hash))) return null;

    const p = record?.property || record || {};
    const intel = p.intel || {};
    const listing = p.listing || {};
    const sale = p.sale || p.lastSale || p.deed?.sale || p.transaction || {};
    const lastSale = sale.lastSale || sale.lastTransfer || sale;
    const valuation = p.valuation || p.avm || p.estimatedValue || p.assessment?.valuation || p.assessor?.valuation || {};
    const assessment = p.assessment || p.assessor || p.tax || {};
    const saleAmount = positiveRepairNumber(
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
    const estimatedValue = positiveRepairNumber(
        intel.estimatedValue,
        intel.estimatedMarketValue,
        intel.totalMarketValue,
        intel.propertyValue,
        intel.estValue,
        intel.avm,
        intel.avmValue,
        intel.value,
        intel.amount,
        valuation.estimatedValue,
        valuation.value,
        valuation.avm,
        valuation.avmValue,
        valuation.amount,
        assessment.totalValue,
        assessment.marketValue,
        assessment.assessedValue,
        assessment.totalMarketValue,
        assessment.market,
        p.estimatedValue,
        p.estimated_value,
        p.avm,
        p.avmValue,
        p.assessedValue,
        p.price,
        listing.price,
        listing.listPrice
    );
    return {
        address_hash: String(mapped.address_hash),
        price: positiveRepairNumber(mapped.price, estimatedValue, saleAmount),
        sold_date: toNullableDate(mapped.sold_date),
        sale_amount: saleAmount
    };
}

function repairMetadataSatisfies(row, metadata) {
    if (!metadata) return false;
    if (isMissingRepairPrice(row.price) && isMissingRepairPrice(metadata.price)) return false;
    if (isMissingRepairDate(row.sold_date) && isMissingRepairDate(metadata.sold_date)) return false;
    return true;
}

function selectRepairFetchJobId(linkedIds, requestedId) {
    const ids = [...new Set(linkedIds.map(id => String(id || '').trim()).filter(Boolean))];
    if (requestedId) {
        if (!ids.includes(requestedId)) {
            throw new RepairHttpError(403, 'fetch_job_lineage_mismatch', 'fetch_job_id is not linked to this saved route workspace.');
        }
        return requestedId;
    }
    if (ids.length === 0) {
        throw new RepairHttpError(409, 'fetch_job_lineage_missing', 'No FetchJob lineage is linked to this saved route.');
    }
    if (ids.length !== 1) {
        throw new RepairHttpError(409, 'fetch_job_lineage_ambiguous', 'Multiple FetchJobs are linked to this route; provide fetch_job_id.');
    }
    return ids[0];
}

async function scanRepairMetadata(job, targetRows) {
    const allowedHashes = new Set(targetRows.map(row => String(row.address_hash)));
    const matches = new Map();
    const maxReviewed = Math.min(1000, Math.max(BATCHDATA_MAX_TAKE, targetRows.length * 50));
    let reviewed = 0;
    let skip = 0;
    let pages = 0;
    let totalRecordCount = null;

    while (reviewed < maxReviewed) {
        const take = Math.min(BATCHDATA_MAX_TAKE, maxReviewed - reviewed);
        const requestBody = buildBatchDataRequest(job, skip, take, 'broad_polygon');
        const payload = await batchDataFetchWithRetry(requestBody);
        const records = extractBatchDataRecords(payload);
        if (totalRecordCount === null) totalRecordCount = extractBatchDataTotal(payload);
        pages++;
        reviewed += records.length;

        for (const record of records) {
            const metadata = repairMetadataFromRecord(record, job, allowedHashes);
            if (!metadata) continue;
            const existing = matches.get(metadata.address_hash);
            matches.set(metadata.address_hash, existing ? {
                address_hash: metadata.address_hash,
                price: existing.price ?? metadata.price,
                sold_date: existing.sold_date ?? metadata.sold_date,
                sale_amount: existing.sale_amount ?? metadata.sale_amount
            } : metadata);
        }

        if (targetRows.every(row => repairMetadataSatisfies(
            row,
            matches.get(String(row.address_hash))
        ))) break;
        if (records.length < take) break;
        if (totalRecordCount !== null && reviewed >= totalRecordCount) break;
        skip += take;
    }
    return {
        matches,
        pages,
        reviewed,
        scanLimitReached: reviewed >= maxReviewed
            && (totalRecordCount === null || reviewed < totalRecordCount)
    };
}

function buildRepairPlan(row, metadata) {
    if (!metadata) return null;
    const price = isMissingRepairPrice(row.price) && !isMissingRepairPrice(metadata.price)
        ? metadata.price
        : null;
    const soldDate = isMissingRepairDate(row.sold_date) && !isMissingRepairDate(metadata.sold_date)
        ? metadata.sold_date
        : null;
    if (price === null && soldDate === null) return null;
    return { row, price, soldDate, saleAmount: metadata.sale_amount };
}

async function applyRouteMetadataRepair(sql, plan, routeId, workspaceEmail) {
    const propertyAudit = plan.price === null ? {} : { estimated_value: plan.price };
    const saleAudit = {
        ...(plan.soldDate === null ? {} : { date: plan.soldDate }),
        ...(plan.saleAmount === null || plan.saleAmount === undefined ? {} : { amount: plan.saleAmount })
    };
    const updated = await sql`
        UPDATE properties
        SET
            price = CASE WHEN price IS NULL OR price <= 0 THEN ${plan.price} ELSE price END,
            sold_date = COALESCE(sold_date, ${plan.soldDate}),
            raw_payload = jsonb_set(
                jsonb_set(
                    COALESCE(raw_payload, '{}'::jsonb),
                    '{property}',
                    COALESCE(raw_payload -> 'property', '{}'::jsonb) || ${JSON.stringify(propertyAudit)}::jsonb,
                    TRUE
                ),
                '{sale}',
                COALESCE(raw_payload -> 'sale', '{}'::jsonb) || ${JSON.stringify(saleAudit)}::jsonb,
                TRUE
            ),
            updated_at = NOW()
        WHERE id = ${plan.row.id}
          AND address_hash = ${String(plan.row.address_hash)}
          AND (price IS NULL OR price <= 0 OR sold_date IS NULL)
        RETURNING id
    `;
    const link = await sql`
        INSERT INTO workspace_properties (
            property_id, user_email, route_active, status, assigned_route_id, updated_at
        )
        VALUES (
            ${plan.row.id},
            ${workspaceEmail},
            TRUE,
            ${plan.row.original_status || 'BATCHDATA_CONFIRMED'},
            ${routeId},
            NOW()
        )
        ON CONFLICT (property_id, user_email) DO NOTHING
        RETURNING property_id
    `;
    return { updated: updated.length > 0, linkInserted: link.length > 0 };
}

async function handleSavedRouteMetadataRepair(base44, body) {
    try {
        const actor = await base44.auth.me();
        if (!actor) return Response.json({ error: 'unauthorized' }, { status: 401 });
        if (String(actor.role || actor?.data?.role || '').trim().toLowerCase() !== 'admin') {
            return Response.json({ error: 'forbidden' }, { status: 403 });
        }
        if (!BATCHDATA_API_KEY || !DATABASE_URL) {
            throw new RepairHttpError(503, 'repair_configuration_unavailable', 'Saved-route metadata repair is not configured.');
        }

        const routeId = String(body.route_id || '').trim();
        if (!routeId || routeId.length > 256) {
            throw new RepairHttpError(400, 'invalid_route_id', 'route_id is required.');
        }
        const maxProperties = body.max_properties === undefined ? 100 : Number(body.max_properties);
        if (!Number.isSafeInteger(maxProperties) || maxProperties < 1 || maxProperties > 100) {
            throw new RepairHttpError(400, 'invalid_max_properties', 'max_properties must be a whole number from 1 through 100.');
        }
        const requestedFetchJobId = body.fetch_job_id === undefined
            ? null
            : String(body.fetch_job_id || '').trim();
        if (requestedFetchJobId !== null && (!requestedFetchJobId || requestedFetchJobId.length > 256)) {
            throw new RepairHttpError(400, 'invalid_fetch_job_id', 'fetch_job_id must be a valid identifier.');
        }
        const requestedEmail = body.target_email === undefined
            ? null
            : repairEmail(body.target_email, true);
        const apply = body.apply === true;
        const service = base44.asServiceRole;
        const route = await service.entities.SavedRoute.get(routeId).catch(() => null);
        if (!route || String(route.id || '') !== routeId) {
            throw new RepairHttpError(404, 'route_not_found', 'The saved route was not found.');
        }
        const routeHashes = [...new Set(
            (Array.isArray(route.property_hashes) ? route.property_hashes : [])
                .map(hash => String(hash || '').trim())
                .filter(Boolean)
        )];
        if (routeHashes.length === 0 || routeHashes.length > 5000 || routeHashes.some(hash => hash.length > 256)) {
            throw new RepairHttpError(409, 'invalid_route_manifest', 'The saved route property manifest is invalid.');
        }
        const workspaceEmail = await resolveRepairWorkspaceEmail(service, route, requestedEmail);
        const sql = neon(DATABASE_URL);
        const canonicalRows = await sql`
            SELECT p.id, p.address_hash, p.price, p.sold_date, p.original_status
            FROM properties p
            WHERE p.address_hash = ANY(${routeHashes})
            ORDER BY p.id
        `;
        const lineageRows = await sql`
            SELECT DISTINCT wp.fetch_job_id
            FROM workspace_properties wp
            JOIN properties p ON p.id = wp.property_id
            WHERE LOWER(wp.user_email) = LOWER(${workspaceEmail})
              AND p.address_hash = ANY(${routeHashes})
              AND wp.fetch_job_id IS NOT NULL
        `;
        const fetchJobId = selectRepairFetchJobId(
            lineageRows.map(row => row.fetch_job_id),
            requestedFetchJobId
        );
        const sourceJob = await service.entities.FetchJob.get(fetchJobId).catch(() => null);
        if (!sourceJob || String(sourceJob.id || '') !== fetchJobId) {
            throw new RepairHttpError(404, 'fetch_job_not_found', 'The linked source FetchJob was not found.');
        }
        if (sourceJob.provider && String(sourceJob.provider).toLowerCase() !== 'batchdata') {
            throw new RepairHttpError(409, 'invalid_source_job', 'The linked FetchJob is not a BatchData job.');
        }

        const allMissingRows = canonicalRows.filter(row => (
            isMissingRepairPrice(row.price) || isMissingRepairDate(row.sold_date)
        ));
        const targetRows = allMissingRows.slice(0, maxProperties);
        const scan = targetRows.length > 0
            ? await scanRepairMetadata(sourceJob, targetRows)
            : { matches: new Map(), pages: 0, reviewed: 0, scanLimitReached: false };
        const plans = targetRows
            .map(row => buildRepairPlan(row, scan.matches.get(String(row.address_hash))))
            .filter(Boolean);

        let updated = 0;
        let workspaceLinksInserted = 0;
        if (apply) {
            for (const plan of plans) {
                const result = await applyRouteMetadataRepair(
                    sql,
                    plan,
                    routeId,
                    workspaceEmail
                );
                if (result.updated) updated++;
                if (result.linkInserted) workspaceLinksInserted++;
            }
        }
        const fullyMatched = targetRows.filter(row => repairMetadataSatisfies(
            row,
            scan.matches.get(String(row.address_hash))
        )).length;
        return Response.json({
            success: true,
            apply,
            counts: {
                route_properties: routeHashes.length,
                canonical_rows: canonicalRows.length,
                missing_metadata: allMissingRows.length,
                processed: targetRows.length,
                provider_pages: scan.pages,
                provider_records_reviewed: scan.reviewed,
                exact_matches: scan.matches.size,
                fully_matched: fullyMatched,
                repairable: plans.length,
                updated,
                workspace_links_inserted: workspaceLinksInserted,
                unmatched: targetRows.length - fullyMatched,
                scan_limit_reached: scan.scanLimitReached ? 1 : 0,
                truncated: allMissingRows.length > targetRows.length ? 1 : 0
            }
        });
    } catch (error) {
        if (error instanceof RepairHttpError) {
            return Response.json({ error: error.code, message: error.message }, { status: error.status });
        }
        console.error('[processFetchChunk route repair]', error?.code || error?.name || 'unexpected_error');
        return Response.json({
            error: 'route_metadata_repair_failed',
            message: 'Saved-route metadata repair could not be completed.'
        }, { status: 502 });
    }
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

        if (body.repair_saved_route_metadata === true) {
            return await handleSavedRouteMetadataRepair(base44, body);
        }

        if (body.self_test === true) {
            return Response.json({ success: true, active_provider: 'batchdata', rentcast_active: false, batchdata_polygon_search: true, dataset_scope: 'omitted_for_sale_evidence', has_batchdata_key: !!BATCHDATA_API_KEY, has_database_url: !!DATABASE_URL });
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
            const workspaceEmail = normalizeWorkspaceEmail(job.user_email);
            const verifyRows = await sql`
                SELECT p.address_hash
                FROM workspace_properties wp
                JOIN properties p ON p.id = wp.property_id
                WHERE LOWER(wp.user_email) = LOWER(${workspaceEmail})
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

        await base44.asServiceRole.entities.FetchJob.update(job.id, {
            status: 'completed',
            phase: 'complete',
            progress_pct: 100,
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
