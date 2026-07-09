import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const BATCHDATA_API_KEY = Deno.env.get('BATCH_DATA_API_KEY');
const DATABASE_URL = Deno.env.get('DATABASE_URL');
const BATCHDATA_BASE = 'https://api.batchdata.com/api/v1/property/search';
const BATCHDATA_MAX_TAKE = 100;
const MAX_AVAILABLE_TAKE = 500;
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function normalizePropertyTypeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[\/_-]+/g, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasAddressUnitMarker(value) {
    return /(?:^|[\s,])(?:apt|apartment|unit|ste|suite|#)\s*[a-z0-9-]+(?:$|[\s,])/i.test(String(value || ''));
}

function includesAnyPropertyType(text, keywords) {
    return keywords.some(keyword => text.includes(normalizePropertyTypeText(keyword)));
}

function isExplicitSingleFamilyType(value) {
    const text = normalizePropertyTypeText(value);
    if (!text) return false;
    return PROPERTY_TYPE_ALIASES['Single Family'].some(alias => text.includes(normalizePropertyTypeText(alias)));
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

function latestDateValue(...values) {
    let latest = null;
    let latestMs = 0;
    for (const value of values) {
        const candidate = dateValue(value);
        if (!candidate) continue;
        const time = new Date(candidate).getTime();
        if (Number.isFinite(time) && time > latestMs) {
            latestMs = time;
            latest = candidate;
        }
    }
    return latest;
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
    return record?.property || record || {};
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
    const propertyType = firstValue(general.propertyTypeDetail, general.propertyType, p.propertyType, p.landUse, building.propertyType, inferredDisallowedType);
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

function batchDataLatestSaleDateFromProperty(p) {
    const sale = p.sale || p.lastSale || p.deed?.sale || p.transaction || {};
    const lastSale = sale.lastSale || sale.lastTransfer || sale;
    const latestSaleMortgage = Array.isArray(lastSale?.mortgages) ? lastSale.mortgages[0] : null;
    const latestMortgageHistory = Array.isArray(p.mortgageHistory) ? p.mortgageHistory[0] : null;
    return isoDateOnly(latestDateValue(
        p.intel?.lastSoldDate,
        p.intel?.lastSaleDate,
        p.intel?.lastTransferDate,
        p.listing?.soldDate,
        p.deedHistory?.[0]?.saleDate,
        sale?.lastSaleDate,
        sale?.recordingDate,
        sale?.saleDate,
        sale?.date,
        lastSale?.recordingDate,
        lastSale?.saleDate,
        lastSale?.date,
        latestSaleMortgage?.recordingDate,
        latestSaleMortgage?.saleDate,
        p.openLien?.firstLoanRecordingDate,
        p.openLien?.lastLoanRecordingDate,
        latestMortgageHistory?.saleDate,
        latestMortgageHistory?.recordingDate,
        p.lastSaleDate
    ));
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
        const date = intelDate || providerDate;
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

    if (soldMinDate) searchCriteria.intel = { lastSoldDate: { minDate: soldMinDate } };
    if (includeR2) searchCriteria.general = { standardizedLandUseCode: { equals: 'R2' } };

    return {
        searchCriteria,
        options: {
            skip: clampInteger(skip, 0, 0, 1000000),
            take: clampInteger(take, 25, 0, MAX_AVAILABLE_TAKE)
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
            min_price: body.min_price ?? existingFilters.min_price ?? 100000,
            max_price: body.max_price ?? existingFilters.max_price ?? null
        }
    };
}

function applyProviderNarrowingFilters(searchCriteria, job) {
    const filters = job.dry_run_metadata?.filters || {};
    const minPriceRaw = Number(filters.min_price);
    const maxPriceRaw = Number(filters.max_price);
    const minPrice = Number.isFinite(minPriceRaw) && minPriceRaw > 0 ? minPriceRaw : 100000;
    const maxPrice = Number.isFinite(maxPriceRaw) && maxPriceRaw > 0 ? maxPriceRaw : null;
    const estimatedValue = { min: minPrice };
    if (maxPrice) estimatedValue.max = maxPrice;

    searchCriteria.general = { standardizedLandUseCode: { equals: 'R2' } };
    searchCriteria.valuation = { estimatedValue };
    return searchCriteria;
}

function buildBatchDataRequest(job, skip = 0, take = BATCHDATA_MAX_TAKE, mode = 'broad_polygon') {
    // Always compute the sold window date filter for every BatchData mode.
    const soldMinDate = isoDateDaysAgo(soldWindowDays(job.sold_months || 12), jobReferenceTimeMs(job));

    const options = {
        skip: clampInteger(skip, 0, 0, 1000000),
        take: clampInteger(take, BATCHDATA_MAX_TAKE, 0, MAX_AVAILABLE_TAKE)
    };

    if (mode === 'centroid_fallback') {
        return {
            searchCriteria: {
                query: `${job.latitude},${job.longitude}`,
                intel: { lastSoldDate: { minDate: soldMinDate } }
            },
            options
        };
    }

    if (mode === 'support_query_place') {
        const query = placeSearchLabel(job);
        if (!query) return null;
        return {
            searchCriteria: {
                query,
                intel: { lastSoldDate: { minDate: soldMinDate } }
            },
            options
        };
    }

    if (mode === 'support_structured_place') {
        const parts = batchDataPlaceParts(job);
        if (!parts) return null;
        return {
            searchCriteria: {
                address: {
                    city: { equals: parts.place },
                    state: { equals: parts.state }
                },
                intel: { lastSoldDate: { minDate: soldMinDate } }
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
        intel: { lastSoldDate: { minDate: soldMinDate } }
    };

    if (mode === 'strict_polygon') {
        applyProviderNarrowingFilters(searchCriteria, job);
    }

    return { searchCriteria, options };
}

function extractBatchDataRecords(payload) {
    const batch = payload?.results?.properties || payload?.properties || payload?.results || [];
    return Array.isArray(batch) ? batch : [batch].filter(Boolean);
}

function extractBatchDataTotal(payload) {
    const rawTotal = payload?.results?.totalRecordCount ?? payload?.totalRecordCount ?? payload?.meta?.totalRecordCount;
    const total = Number(rawTotal);
    return Number.isFinite(total) ? total : null;
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
    const listing = p.listing || {};
    const intel = p.intel || {};
    const building = p.building || p.structure || p.propertyInfo || p.assessment?.building || p.assessor?.building || {};
    const sale = p.sale || p.lastSale || p.deed?.sale || p.transaction || {};
    const lastSale = sale.lastSale || sale.lastTransfer || sale;
    const valuation = p.valuation || p.avm || p.estimatedValue || p.assessment?.valuation || p.assessor?.valuation || {};
    const general = p.general || p.property || p.propertyInfo || {};
    const ids = p.ids || p.identifiers || {};
    const listingStatus = firstValue(listing.status, listing.statusCategory);
    const listingStatusLower = String(listingStatus || '').toLowerCase();
    const saleDate = batchDataLatestSaleDateFromProperty(p);
    const saleDateMs = saleDate ? new Date(saleDate).getTime() : 0;
    const hasValidSaleDate = saleDateMs > 0 && !Number.isNaN(saleDateMs);
    const saleDateOnly = isoDateOnly(saleDate);
    const cutoffDate = isoDateDaysAgo(soldWindowDays(job.sold_months || 12), jobReferenceTimeMs(job));
    const isSoldInWindow = !!saleDateOnly && saleDateOnly >= cutoffDate;
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
        p.lastSalePrice
    );
    const estimatedValue = numberValue(
        intel.estimatedValue, intel.estimatedMarketValue, intel.totalMarketValue, intel.propertyValue, intel.estValue,
        intel.avm, intel.avmValue, intel.value, intel.amount,
        valuation.estimatedValue, valuation.value, valuation.avm, valuation.avmValue, valuation.amount,
        p.estimatedValue, p.estimated_value, p.avm, p.avmValue, p.assessedValue,
        listing.price, listing.listPrice
    );
    const price = estimatedValue ?? saleAmount;
    const landUseCode = firstValue(general.standardizedLandUseCode, p.standardizedLandUseCode);
    const addressHasUnit = hasAddressUnitMarker(address.street);
    const inferredDisallowedPropertyType = p.quickLists?.vacantLot
        ? 'Vacant Land'
        : addressHasUnit
            ? 'Condo/Multi-Family'
            : null;
    const rawPropertyType = firstValue(general.propertyTypeDetail, general.propertyType, p.propertyType, p.landUse, building.propertyType, inferredDisallowedPropertyType);
    const propertyType = rawPropertyType || (String(landUseCode || '').toUpperCase() === 'R2' ? 'Single Family' : (landUseCode ? `BatchData ${landUseCode}` : 'Single Family'));
    const propertyTypeText = normalizePropertyTypeText(propertyType);
    const landUseText = normalizePropertyTypeText(landUseCode);
    const combinedTypeText = normalizePropertyTypeText(`${propertyType} ${landUseCode || ''}`);
    // Keep route quality high without depending entirely on BatchData's R2 code.
    const explicitlySingleFamily = isExplicitSingleFamilyType(propertyTypeText);
    const disallowedTypeKeywords = [...COMMERCIAL_TYPE_KEYWORDS, ...CONDO_MULTI_TYPE_KEYWORDS, ...LAND_TYPE_KEYWORDS, 'daycare', 'child care', 'church', 'school', 'parking', 'exempt', 'government'];
    const nonResidential = includesAnyPropertyType(combinedTypeText, disallowedTypeKeywords);
    const nonR2WithoutSingleFamilyEvidence = !!landUseCode && String(landUseCode).toUpperCase() !== 'R2' && !explicitlySingleFamily;
    const landUseRejected = includesAnyPropertyType(landUseText, disallowedTypeKeywords) || nonR2WithoutSingleFamilyEvidence;

    // Price gate: enforce the user's home value range on records with a known price.
    // Unknown-price records pass (provider may omit valuation on some rows).
    const jobFilters = job.dry_run_metadata?.filters || {};
    const filterMinPrice = Number(jobFilters.min_price) > 0 ? Number(jobFilters.min_price) : null;
    const filterMaxPrice = Number(jobFilters.max_price) > 0 ? Number(jobFilters.max_price) : null;
    const priceKnown = Number.isFinite(Number(price)) && Number(price) > 0;
    const priceRejected = priceKnown && ((filterMinPrice !== null && Number(price) < filterMinPrice) || (filterMaxPrice !== null && Number(price) > filterMaxPrice));
    const missingSaleDateRejected = !hasValidSaleDate;
    const staleKnownSaleDate = hasValidSaleDate && !isSoldInWindow;
    const rejected = nonResidential || landUseRejected || priceRejected || missingSaleDateRejected || staleKnownSaleDate;

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
        sold_date: saleDate || null,
        sale_type: 'BatchData',
        property_type: propertyType,
        data_source: 'batchdata',
        sale_confidence: rejected ? 'REJECTED' : 'verified',
        original_status: rejected ? 'REJECTED' : 'BATCHDATA_CONFIRMED',
        route_active: !rejected,
        raw_payload: JSON.stringify(p)
    };
}

function toNullableDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date.toISOString();
}

async function writePropertiesToNeon(sql, properties, job, excludedRouteHashes = new Set()) {
    let inserted = 0, existed = 0, updated = 0;

    for (const p of properties) {
        const isInSavedRoute = excludedRouteHashes.has(p.address_hash);
        const existingRows = await sql`
            SELECT id, sold_date, sale_confidence, original_status, owner_full_name, beds, baths, sqft, lot_size, year_built, price
            FROM properties
            WHERE address_hash = ${p.address_hash}
            LIMIT 1
        `;
        const soldDate = toNullableDate(p.sold_date);
        const rawPayload = p.raw_payload || JSON.stringify(p);

        if (existingRows.length === 0) {
            const created = await sql`
                INSERT INTO properties (
                    address_hash, legacy_hash, full_address, house_number, street_name, city, state, zip_code,
                    lat, lng, owner_full_name, beds, baths, sqft, lot_size, year_built, price,
                    sold_date, sale_type, property_type, data_source, sale_confidence, original_status, raw_payload, updated_at
                ) VALUES (
                    ${p.address_hash}, ${p.legacy_hash}, ${p.full_address}, ${p.house_number || null}, ${p.street_name || null},
                    ${p.city || null}, ${p.state || null}, ${p.zip_code || null}, ${p.lat}, ${p.lng}, ${p.owner_full_name || null},
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
        const hasNewMetadata =
            (!existing.owner_full_name && p.owner_full_name) ||
            (!existing.beds && p.beds) ||
            (!existing.baths && p.baths) ||
            (!existing.sqft && p.sqft) ||
            (!existing.lot_size && p.lot_size) ||
            (!existing.year_built && p.year_built) ||
            (!existing.price && p.price);
        const shouldUpdate = incomingDate > existingDate || hasNewMetadata || p.sale_confidence !== existing.sale_confidence || p.original_status !== existing.original_status;

        if (shouldUpdate) {
            await sql`
                UPDATE properties SET
                    legacy_hash = COALESCE(${p.legacy_hash}, legacy_hash), full_address = COALESCE(${p.full_address}, full_address),
                    house_number = COALESCE(${p.house_number || null}, house_number), street_name = COALESCE(${p.street_name || null}, street_name),
                    city = COALESCE(${p.city || null}, city), state = COALESCE(${p.state || null}, state), zip_code = COALESCE(${p.zip_code || null}, zip_code),
                    lat = COALESCE(${p.lat}, lat), lng = COALESCE(${p.lng}, lng), owner_full_name = COALESCE(${p.owner_full_name || null}, owner_full_name),
                    beds = COALESCE(${p.beds || null}, beds), baths = COALESCE(${p.baths || null}, baths), sqft = COALESCE(${p.sqft || null}, sqft),
                    lot_size = COALESCE(${p.lot_size || null}, lot_size), year_built = COALESCE(${p.year_built || null}, year_built), price = COALESCE(${p.price || null}, price),
                    sold_date = COALESCE(${soldDate}, sold_date), sale_type = COALESCE(${p.sale_type}, sale_type), property_type = COALESCE(${p.property_type}, property_type),
                    data_source = ${p.data_source}, sale_confidence = ${p.sale_confidence}, original_status = ${p.original_status}, raw_payload = ${rawPayload}, updated_at = NOW()
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

async function fetchBatchDataRecordsForMode(job, mode, requested, onProgress = null) {
    requested = Math.min(Math.max(clampInteger(requested, 1, 1, 1000), 1), 1000);
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
    const fetchMode = String(job?.dry_run_metadata?.fetch_mode || job?.dry_run_metadata?.count_mode || '').toLowerCase();
    const isMaxAvailableMode = fetchMode === 'max_available';
    const originalRequested = requested;

    if (requested > BATCHDATA_MAX_TAKE) {
        const countRequest = buildBatchDataRequest(job, 0, 0, mode);
        if (countRequest) {
            const countPayload = await batchDataFetchWithRetry(countRequest);
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
                estimated_credits_burned: 1
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

    let maxReviewed = isMaxAvailableMode
        ? Math.min(1000, Math.max(MAX_AVAILABLE_TAKE, requested * 2))
        : Math.min(1000, Math.max(BATCHDATA_MAX_TAKE, requested * 50));

    if (requested <= 0 || totalRecordCount === 0) {
        return {
            records: [],
            reviewed,
            active: 0,
            rejected_samples: 0,
            skipped_existing_route: skippedExistingRoute,
            skipped_duplicate: skippedDuplicate,
            skipped_route_type: skippedRouteType,
            skipped_route_type_breakdown: skippedRouteTypeBreakdown,
            max_reviewed: maxReviewed,
            page_timings: pageTimings,
            totalRecordCount
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
        const requestBody = buildBatchDataRequest(job, skip, take, mode);
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
        if (totalRecordCount === 0) break;
        reviewed += list.length;
        const selectedBeforePage = selected.length;

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

        const addedToRoute = selected.length - selectedBeforePage;
        console.log(JSON.stringify({
            event: 'batchdata_page_credit_log',
            mode,
            requested_take: take,
            returned: list.length,
            added_to_route: addedToRoute,
            estimated_credits_burned: list.length,
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
                skip,
                take,
                page_elapsed_ms: pageElapsedMs
            }).catch(() => {});
        }

        if (selected.length >= requested) break;
        if (list.length < take) break;
        if (totalRecordCount !== null && reviewed >= totalRecordCount) break;
        skip += take;
    }

    return {
        records: selected.length > 0 ? selected.slice(0, requested) : rejectedSamples,
        reviewed,
        active: selected.length,
        rejected_samples: rejectedSamples.length,
        skipped_existing_route: skippedExistingRoute,
        skipped_duplicate: skippedDuplicate,
        skipped_route_type: skippedRouteType,
        skipped_route_type_breakdown: skippedRouteTypeBreakdown,
        max_reviewed: maxReviewed,
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
        attempts.push({ mode, count: result.records.length, reviewed: result.reviewed, active: result.active, rejected_samples: result.rejected_samples, skipped_existing_route: result.skipped_existing_route, skipped_duplicate: result.skipped_duplicate, skipped_route_type: result.skipped_route_type, skipped_route_type_breakdown: result.skipped_route_type_breakdown, max_reviewed: result.max_reviewed, page_timings: result.page_timings, total: result.totalRecordCount });
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
    try {
        base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({}));
        targetJobId = body.job_id ? String(body.job_id) : null;

        if (body.self_test === true) {
            return Response.json({ success: true, active_provider: 'batchdata', rentcast_active: false, batchdata_polygon_search: true, dataset_scope: 'omitted_for_sale_evidence', has_batchdata_key: !!BATCHDATA_API_KEY, has_database_url: !!DATABASE_URL });
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
                        property_type: firstValue(p.general?.propertyTypeDetail, p.general?.propertyType, p.propertyType, p.landUse, p.building?.propertyType),
                        mapped_active: mappedProperty?.route_active === true,
                        mapped_status: mappedProperty?.original_status || null,
                        mapped_property_type: mappedProperty?.property_type || null,
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
            provider_total: providerTotal !== undefined ? Number(providerTotal) : null,
            raw: rawRecords.length,
            mapped: mapped.length,
            active: activeCount,
            rejected,
            outside_or_invalid: outsideOrInvalid,
            skipped_existing_route: totalSkippedExistingRoute,
            skipped_duplicate: skippedDuplicateFromFetch,
            skipped_route_type: totalSkippedRouteType,
            skipped_route_type_breakdown: skippedRouteTypeBreakdownTotal
        };
        const errorLog = [...(job.error_log || []), `[${completedAt}] BatchData-only Precision complete: mode=${batchFetch.mode_used}, attempts=${JSON.stringify(batchFetch.attempts)}, raw=${rawRecords.length}, mapped=${mapped.length}, active=${activeCount}, rejected=${rejected}, outside_or_invalid=${outsideOrInvalid}, skipped_existing_route=${totalSkippedExistingRoute}, skipped_duplicate=${skippedDuplicateFromFetch}, skipped_route_type=${totalSkippedRouteType}`];

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
            total_api_calls: (job.total_api_calls || 0) + (Array.isArray(body.synthetic_records) ? 0 : batchFetch.attempts.length),
            total_batchdata_calls: (job.total_batchdata_calls || 0) + (Array.isArray(body.synthetic_records) ? 0 : batchFetch.attempts.length),
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
