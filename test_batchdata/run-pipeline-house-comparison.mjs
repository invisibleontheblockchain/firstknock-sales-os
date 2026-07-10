import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

import {
    hasAddressUnitMarker,
    isBlockedListingStatus,
    isSaleDateWithinWindow,
    selectRecentSaleEvidence,
    unwrapBatchDataProperty
} from '../base44/functions/processFetchChunk/recentSaleLogic.js';

loadEnv({ path: '.env', quiet: true });

const SEARCH_URL = 'https://api.batchdata.com/api/v1/property/search';
const API_KEY = process.env.BATCH_DATA_API_KEY || process.env.BATCHDATA_API_KEY;
const LIVE_CONFIRMED = process.argv.includes('--confirm-live');
const SENSITIVE_OUTPUT = process.argv.includes('--sensitive-output');
const REQUEST_TIMEOUT_MS = 25000;
const MIN_VALUE = 100000;
const PAGE_SIZE_MAX = 100;
const LEGACY_MAX_REVIEWED = 1000;
const UPDATED_MAX_REVIEWED_PER_SOURCE = 5000;
const LEGACY_COMMIT = '3ff84240';
const UPDATED_COMMIT = '5748ed50';
const VALIDATION_CENTERS = {
    seattle: { label: 'Seattle', latitude: 47.6062, longitude: -122.3321 },
    phoenix: { label: 'Phoenix', latitude: 33.4484, longitude: -112.0740 }
};

let NOMINAL_AREA_SQ_MI = 25;
let RUN_CENTER = VALIDATION_CENTERS.seattle;
let POLYGON = squarePolygon(RUN_CENTER, NOMINAL_AREA_SQ_MI);
let ACTUAL_AREA_SQ_MI = polygonAreaSqMiles(POLYGON);

function cliValue(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.find(value => value.startsWith(prefix));
    return match ? match.slice(prefix.length) : fallback;
}

function phoenixDate() {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Phoenix',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function daysBefore(dateOnly, days) {
    const time = Date.parse(`${dateOnly}T12:00:00.000Z`) - days * 86400000;
    return new Date(time).toISOString().slice(0, 10);
}

function squarePolygon(center, areaSqMiles) {
    const halfSideMiles = Math.sqrt(areaSqMiles) / 2;
    const latDelta = halfSideMiles / 69;
    const lngDelta = halfSideMiles / (69 * Math.cos(center.latitude * Math.PI / 180));
    const north = Number((center.latitude + latDelta).toFixed(6));
    const south = Number((center.latitude - latDelta).toFixed(6));
    const west = Number((center.longitude - lngDelta).toFixed(6));
    const east = Number((center.longitude + lngDelta).toFixed(6));
    return [
        { latitude: north, longitude: west },
        { latitude: north, longitude: east },
        { latitude: south, longitude: east },
        { latitude: south, longitude: west },
        { latitude: north, longitude: west }
    ];
}

function polygonAreaSqMiles(polygon) {
    const points = polygon.slice(0, -1);
    if (points.length < 3) return 0;
    const meanLatitude = points.reduce((sum, point) => sum + point.latitude, 0) / points.length;
    const milesPerLongitudeDegree = 69 * Math.cos(meanLatitude * Math.PI / 180);
    const projected = points.map(point => ({
        x: point.longitude * milesPerLongitudeDegree,
        y: point.latitude * 69
    }));
    let twiceArea = 0;
    for (let index = 0; index < projected.length; index++) {
        const current = projected[index];
        const next = projected[(index + 1) % projected.length];
        twiceArea += current.x * next.y - next.x * current.y;
    }
    return Math.abs(twiceArea) / 2;
}

function firstValue(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function numberValue(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        const parsed = Number(typeof value === 'object' ? firstValue(value.value, value.amount, value.price) : value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function cleanText(value) {
    return String(value || '').trim();
}

function normalizedAddress(record) {
    const property = unwrapBatchDataProperty(record);
    const address = property.address || property.propertyAddress || property.situsAddress || {};
    const formatted = cleanText(property.formattedAddress);
    const formattedParts = formatted.split(',').map(part => part.trim());
    const street = cleanText(firstValue(
        address.street,
        address.streetAddress,
        address.addressLine1,
        property.addressLine1,
        formattedParts[0]
    ));
    const city = cleanText(firstValue(address.city, property.city, formattedParts[1]));
    const stateZip = cleanText(formattedParts[2]);
    const state = cleanText(firstValue(address.state, property.state, stateZip.split(/\s+/)[0])).toUpperCase();
    const zip = cleanText(firstValue(address.zip, address.zipCode, property.zipCode, stateZip.match(/\b\d{5}\b/)?.[0])).slice(0, 5);
    const location = address.location || property.location || {};
    const latitude = numberValue(location.latitude, address.latitude, address.lat, property.latitude, property.lat);
    const longitude = numberValue(location.longitude, address.longitude, address.lng, address.lon, property.longitude, property.lng, property.lon);
    return {
        street,
        city,
        state,
        zip,
        latitude,
        longitude,
        full: [street, city, state, zip].filter(Boolean).join(', ')
    };
}

function normalizeAddressForIdentity(address) {
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

function productionAddressHash(street, zip) {
    return `${normalizeAddressForIdentity(street)}|${String(zip || '00000').slice(0, 5)}`;
}

function batchDataIdentityKeys(record) {
    const property = unwrapBatchDataProperty(record);
    const ids = property.ids || property.identifiers || {};
    const address = normalizedAddress(property);
    const providerIdValue = firstValue(property._id, property.id, property.propertyId, ids.propertyId, ids.id);
    const providerAddressHash = firstValue(property.address?.hash, property.addressHash);
    const apn = firstValue(ids.apn, ids.assessorParcelNumber, property.apn);
    const normalizedAddressKey = address.street && address.zip
        ? productionAddressHash(address.street, address.zip)
        : null;
    return [...new Set([
        providerIdValue ? `id:${providerIdValue}` : null,
        providerAddressHash ? `address_hash:${providerAddressHash}` : null,
        apn && normalizedAddressKey
            ? `apn_address:${firstValue(ids.fipsCode, ids.countyFips, property.fipsCode, '')}|${apn}|${normalizedAddressKey}`
            : null,
        normalizedAddressKey ? `address:${normalizedAddressKey}` : null
    ].filter(Boolean).map(value => String(value).trim()).filter(Boolean))];
}

function recordIdentity(record) {
    const keys = batchDataIdentityKeys(record);
    if (keys.length > 0) return keys[0];
    return `record:${createHash('sha256').update(JSON.stringify(record)).digest('hex')}`;
}

function providerId(record) {
    const property = unwrapBatchDataProperty(record);
    const ids = property.ids || property.identifiers || {};
    return cleanText(firstValue(property._id, property.id, property.propertyId, ids.propertyId, ids.id));
}

function extractRecords(payload) {
    const candidates = [
        payload?.results?.properties,
        payload?.results?.items,
        payload?.properties,
        payload?.items,
        payload?.data?.properties,
        payload?.results
    ];
    const value = candidates.find(candidate => Array.isArray(candidate));
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
}

function extractTotal(payload) {
    const raw = firstValue(
        payload?.results?.meta?.results?.resultsFound,
        payload?.results?.totalRecordCount,
        payload?.totalRecordCount,
        payload?.meta?.totalRecordCount,
        payload?.meta?.resultsFound
    );
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

function buildCriteria(source, minDate, maxDate, { listingSafety = false, closedWindow = true } = {}) {
    const range = { minDate, ...(closedWindow ? { maxDate } : {}) };
    return {
        address: { geoLocationPolygon: { geoPoints: POLYGON } },
        ...(source === 'intel'
            ? { intel: { lastSoldDate: range } }
            : { sale: { lastSaleDate: range } }),
        general: { standardizedLandUseCode: { equals: 'R2' } },
        valuation: { estimatedValue: { min: MIN_VALUE } },
        ...(listingSafety ? { listing: { statusCategory: { notInList: ['Active', 'Pending'] } } } : {})
    };
}

function buildArmDefinitions(minDate, maxDate, take, safetyOrder = 'pre-first') {
    const arms = [
        {
            key: 'legacy_exact_intel',
            method: 'legacy',
            engine: 'legacy',
            description: 'Commit 3ff8424 exact Intel request (minDate only, no datasets, no listing exclusion)',
            request: {
                searchCriteria: buildCriteria('intel', minDate, maxDate, { closedWindow: false }),
                options: { skip: 0, take }
            }
        },
        {
            key: 'legacy_closed_intel',
            method: 'control',
            engine: 'legacy',
            description: 'Legacy Intel request with maxDate added only for equal-window comparison',
            request: {
                searchCriteria: buildCriteria('intel', minDate, maxDate),
                options: { skip: 0, take }
            }
        },
        {
            key: 'updated_pre_safety_intel',
            method: 'control',
            engine: 'updated',
            description: 'Updated Intel contract before listing-safety predicate',
            request: {
                searchCriteria: buildCriteria('intel', minDate, maxDate),
                options: { skip: 0, take, datasets: ['basic'] }
            }
        },
        {
            key: 'updated_pre_safety_sale',
            method: 'control',
            engine: 'updated',
            description: 'Updated Sale contract before listing-safety predicate',
            request: {
                searchCriteria: buildCriteria('sale', minDate, maxDate),
                options: { skip: 0, take, datasets: ['basic'] }
            }
        },
        {
            key: 'updated_intel',
            method: 'updated',
            engine: 'updated',
            description: 'Updated qualified Intel request',
            request: {
                searchCriteria: buildCriteria('intel', minDate, maxDate, { listingSafety: true }),
                options: { skip: 0, take, datasets: ['basic'] }
            }
        },
        {
            key: 'updated_sale',
            method: 'updated',
            engine: 'updated',
            description: 'Updated qualified Sale request',
            request: {
                searchCriteria: buildCriteria('sale', minDate, maxDate, { listingSafety: true }),
                options: { skip: 0, take, datasets: ['basic'] }
            }
        }
    ];
    const byKey = Object.fromEntries(arms.map(arm => [arm.key, arm]));
    const orderedKeys = safetyOrder === 'post-first'
        ? [
            'legacy_exact_intel',
            'legacy_closed_intel',
            'updated_intel',
            'updated_pre_safety_intel',
            'updated_sale',
            'updated_pre_safety_sale'
        ]
        : [
            'legacy_exact_intel',
            'legacy_closed_intel',
            'updated_pre_safety_intel',
            'updated_intel',
            'updated_pre_safety_sale',
            'updated_sale'
        ];
    return orderedKeys.map(key => byKey[key]);
}

function isPointInPolygon(point, polygon) {
    const x = Number(point.longitude);
    const y = Number(point.latitude);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = Number(polygon[i].longitude);
        const yi = Number(polygon[i].latitude);
        const xj = Number(polygon[j].longitude);
        const yj = Number(polygon[j].latitude);
        const intersects = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / ((yj - yi) || Number.EPSILON) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function observedFields(record, maxDate) {
    if (!record) return {
        address: normalizedAddress({}), provider_id: '', listing_status: '', sale_date: null,
        sale_date_source: null, estimated_value: null, property_type: '', land_use_code: ''
    };
    const property = unwrapBatchDataProperty(record);
    const listing = property.listing || {};
    const intel = property.intel || {};
    const sale = property.sale || property.lastSale || property.deed?.sale || {};
    const valuation = property.valuation || property.avm || property.assessment?.valuation || property.assessor?.valuation || {};
    const general = property.general || property.propertyInfo || {};
    const building = property.building || property.structure || property.propertyInfo || property.assessment?.building || {};
    const detail = selectRecentSaleEvidence(property, { maxDate });
    return {
        address: normalizedAddress(record),
        provider_id: providerId(record),
        listing_status: cleanText(firstValue(listing.status, listing.statusCategory)),
        sale_date: detail.saleDate || null,
        sale_date_source: detail.saleDateSource || null,
        estimated_value: numberValue(
            intel.estimatedValue,
            intel.estimatedMarketValue,
            valuation.estimatedValue,
            valuation.value,
            valuation.avmValue,
            property.estimatedValue,
            property.avmValue
        ),
        legacy_price: numberValue(
            intel.estimatedValue,
            intel.estimatedMarketValue,
            valuation.estimatedValue,
            valuation.value,
            valuation.avm,
            property.estimatedValue,
            property.avmValue,
            listing.price,
            listing.listPrice,
            intel.lastSoldPrice,
            sale.amount,
            sale.price,
            sale.salePrice
        ),
        property_type: cleanText(firstValue(
            general.propertyTypeDetail,
            general.propertyType,
            property.propertyType,
            property.landUse,
            building.propertyType
        )),
        land_use_code: cleanText(firstValue(
            general.standardizedLandUseCode,
            property.standardizedLandUseCode,
            general.landUseCode,
            property.landUseCode
        ))
    };
}

const LEGACY_NON_SFR_RE = /commercial|industrial|vacant|agricultural|\bland\b|day ?care|child ?care|church|school|office|retail|store|warehouse|hotel|motel|restaurant|medical|hospital|parking|exempt|government|condo|minium|apartment|multi[- ]?family|multifamily|duplex|triplex|fourplex|townhouse|townhome|row ?house/i;
const UPDATED_NON_SFR_RE = /commercial|industrial|vacant|agricultural|\bland\b|day ?care|child ?care|church|school|office|retail|store|warehouse|hotel|motel|restaurant|medical|hospital|parking|exempt|government|condo|minium|apartment|multi[- ]?family|multifamily|duplex|triplex|fourplex|townhouse|townhome|row ?house|manufactured|mobile home/i;

function legacyDecision(record, minDate, maxDate) {
    if (!record) return { routeable: false, reasons: ['Not pulled by legacy Intel'], warnings: [] };
    const fields = observedFields(record, maxDate);
    const reasons = [];
    const warnings = [];
    if (!fields.address.street) reasons.push('Missing street address');
    if (!fields.address.zip) reasons.push('Missing ZIP code');
    if (!Number.isFinite(fields.address.latitude) || !Number.isFinite(fields.address.longitude)) reasons.push('Missing coordinates');
    else if (!isPointInPolygon(fields.address, POLYGON)) reasons.push('Coordinates outside polygon');
    if (fields.property_type && LEGACY_NON_SFR_RE.test(fields.property_type)) reasons.push(`Explicit non-SFR type: ${fields.property_type}`);
    if (fields.land_use_code && fields.land_use_code.toUpperCase() !== 'R2') reasons.push(`Non-R2 land use: ${fields.land_use_code}`);
    if (fields.legacy_price !== null && fields.legacy_price < MIN_VALUE) reasons.push('Known legacy price below $100,000');

    if (isBlockedListingStatus(fields.listing_status)) warnings.push(`Legacy would keep on-market status: ${fields.listing_status}`);
    if (!fields.listing_status) warnings.push('Legacy has no listing-safety proof');
    if (!fields.sale_date) warnings.push('Legacy has no returned exact sale date');
    else if (!isSaleDateWithinWindow(fields.sale_date, minDate, maxDate)) warnings.push(`Legacy returned date outside closed window: ${fields.sale_date}`);
    if (hasAddressUnitMarker(fields.address.street)) warnings.push('Address contains a unit marker');
    return { routeable: reasons.length === 0, reasons, warnings };
}

function updatedDecision(record, minDate, maxDate) {
    if (!record) return { routeable: false, reasons: ['Not pulled by updated Intel/Sale union'], warnings: [] };
    const fields = observedFields(record, maxDate);
    const reasons = [];
    const warnings = [];
    if (!fields.address.street) reasons.push('Missing street address');
    if (!fields.address.zip) reasons.push('Missing ZIP code');
    if (!Number.isFinite(fields.address.latitude) || !Number.isFinite(fields.address.longitude)) reasons.push('Missing coordinates');
    else if (!isPointInPolygon(fields.address, POLYGON)) reasons.push('Coordinates outside polygon');
    if (fields.property_type && UPDATED_NON_SFR_RE.test(fields.property_type)) reasons.push(`Explicit non-SFR contradiction: ${fields.property_type}`);
    if (fields.land_use_code && fields.land_use_code.toUpperCase() !== 'R2') reasons.push(`Explicit non-R2 contradiction: ${fields.land_use_code}`);
    if (hasAddressUnitMarker(fields.address.street)) reasons.push('Address contains a unit marker');
    if (isBlockedListingStatus(fields.listing_status)) reasons.push(`Explicit blocked listing status: ${fields.listing_status}`);
    if (fields.estimated_value !== null && fields.estimated_value < MIN_VALUE) reasons.push('Known estimated value below $100,000');
    if (fields.sale_date && !isSaleDateWithinWindow(fields.sale_date, minDate, maxDate)) reasons.push(`Returned sale date outside closed window: ${fields.sale_date}`);

    if (!fields.sale_date) warnings.push('Accepted by exact provider date-predicate proof; Basic omitted exact date');
    if (!fields.property_type && !fields.land_use_code) warnings.push('Accepted by provider R2 predicate proof; Basic omitted type fields');
    if (fields.estimated_value === null) warnings.push('Accepted by provider $100k predicate proof; Basic omitted estimate');
    if (!fields.listing_status) warnings.push('Accepted by provider Active/Pending exclusion proof; Basic omitted status');
    return { routeable: reasons.length === 0, reasons, warnings };
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
    if (typeof existing === 'object' && typeof incoming === 'object'
        && !Array.isArray(existing) && !Array.isArray(incoming)) {
        const merged = { ...existing };
        for (const [key, value] of Object.entries(incoming)) {
            merged[key] = mergeBatchDataValues(merged[key], value);
        }
        return merged;
    }
    return existing;
}

function unionRecordMaps(...sources) {
    const records = [];
    const identityIndex = new Map();
    const sourceMembership = sources.map(() => new Set());
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const values = sources[sourceIndex] instanceof Map
            ? [...sources[sourceIndex].values()]
            : (sources[sourceIndex] || []);
        for (const incoming of values) {
            const keys = batchDataIdentityKeys(incoming);
            let index = keys.map(key => identityIndex.get(key)).find(value => value !== undefined);
            if (index === undefined) {
                index = records.length;
                records.push(unwrapBatchDataProperty(incoming));
            } else {
                records[index] = mergeBatchDataValues(records[index], unwrapBatchDataProperty(incoming));
            }
            const mergedKeys = batchDataIdentityKeys(records[index]);
            for (const key of [...keys, ...mergedKeys]) identityIndex.set(key, index);
            sourceMembership[sourceIndex].add(index);
        }
    }
    const map = new Map();
    const canonicalByIndex = new Map();
    records.forEach((record, index) => {
        const canonical = batchDataIdentityKeys(record)[0] || recordIdentity(record);
        canonicalByIndex.set(index, canonical);
        map.set(canonical, record);
    });
    return {
        map,
        memberships: sourceMembership.map(indices => new Set([...indices].map(index => canonicalByIndex.get(index))))
    };
}

function dedupe(records) {
    return unionRecordMaps(records).map;
}

function unionMaps(...maps) {
    return unionRecordMaps(...maps).map;
}

function identityIndexForMap(map) {
    const index = new Map();
    for (const [canonical, record] of map) {
        index.set(canonical, canonical);
        for (const key of batchDataIdentityKeys(record)) index.set(key, canonical);
    }
    return index;
}

function recordFromAliases(map, index, referenceRecord) {
    for (const key of batchDataIdentityKeys(referenceRecord)) {
        const canonical = index.get(key);
        if (canonical && map.has(canonical)) return map.get(canonical);
    }
    return null;
}

function pct(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function decisionForArm(arm, record, minDate, maxDate) {
    return arm.engine === 'legacy'
        ? legacyDecision(record, minDate, maxDate)
        : updatedDecision(record, minDate, maxDate);
}

async function executeSearchPage(arm, budgetState, { skip, take }, { fetchImpl = fetch } = {}) {
    if (budgetState.httpUsed >= budgetState.httpLimit) throw new Error('Local HTTP budget exhausted before request');
    budgetState.httpUsed++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const started = Date.now();
    const request = {
        ...arm.request,
        options: { ...(arm.request.options || {}), skip, take }
    };
    try {
        const response = await fetchImpl(SEARCH_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify(request),
            signal: controller.signal
        });
        const body = await response.text();
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
        return {
            ok: response.ok,
            status: response.status,
            elapsed_ms: Date.now() - started,
            provider_total: response.ok ? extractTotal(payload) : null,
            records: response.ok ? extractRecords(payload) : [],
            error: response.ok ? null : `http_${response.status}`,
            request
        };
    } catch (error) {
        return {
            ok: false,
            status: error?.name === 'AbortError' ? 408 : 0,
            elapsed_ms: Date.now() - started,
            provider_total: null,
            error: error?.name === 'AbortError' ? 'request_timeout' : 'network_error',
            request,
            records: []
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function countArm(arm, budgetState) {
    const response = await executeSearchPage(arm, budgetState, { skip: 0, take: 0 });
    return {
        key: arm.key,
        method: arm.method,
        engine: arm.engine,
        description: arm.description,
        ok: response.ok,
        status: response.status,
        elapsed_ms: response.elapsed_ms,
        provider_total: response.provider_total,
        error: response.error,
        request: response.request
    };
}

async function paginateArm(arm, countResult, budgetState, {
    requested,
    pageSize,
    maxPages,
    minDate,
    maxDate,
    fetchImpl = fetch,
    wait = sleep
}) {
    const countProviderTotal = countResult.provider_total;
    let providerTotal = countProviderTotal;
    const nativeMaxReviewed = arm.engine === 'legacy'
        ? LEGACY_MAX_REVIEWED
        : UPDATED_MAX_REVIEWED_PER_SOURCE;
    // Count totals are budgeting hints only. Selection must continue toward the
    // requested native target until the provider stream is actually exhausted,
    // so an upward count drift cannot silently under-pull.
    const sourceTarget = requested;
    const records = [];
    const processedRecords = [];
    const selected = new Set();
    const discovered = new Set();
    const pageFingerprints = new Set();
    const providerTotalsObserved = new Set(providerTotal === null ? [] : [providerTotal]);
    const pageTimings = [];
    let reviewed = 0;
    let processed = 0;
    let notEvaluatedAfterTarget = 0;
    let skip = 0;
    let exhausted = providerTotal === 0;
    let error = countResult.ok ? null : countResult.error;
    let lastStatus = countResult.status;
    let completionReason = exhausted ? 'provider_zero' : null;

    while (!error
        && !exhausted
        && selected.size < sourceTarget
        && reviewed < nativeMaxReviewed
        && pageTimings.length < maxPages) {
        const remainingRecordBudget = budgetState.recordLimit - budgetState.recordUnits;
        if (remainingRecordBudget <= 0) {
            completionReason = 'record_budget_exhausted';
            break;
        }
        const take = Math.min(
            pageSize,
            nativeMaxReviewed - reviewed,
            remainingRecordBudget
        );
        if (take <= 0) break;
        const page = await executeSearchPage(arm, budgetState, { skip, take }, { fetchImpl });
        lastStatus = page.status;
        pageTimings.push({
            page: pageTimings.length + 1,
            skip,
            take,
            returned: page.records.length,
            status: page.status,
            elapsed_ms: page.elapsed_ms
        });
        if (!page.ok) {
            error = page.error;
            completionReason = page.error || 'request_failed';
            break;
        }
        if (page.provider_total !== null) {
            providerTotalsObserved.add(page.provider_total);
            providerTotal = page.provider_total;
        }
        budgetState.recordUnits += page.records.length;
        records.push(...page.records);
        reviewed += page.records.length;
        const pageKeys = page.records.map(recordIdentity);
        const fingerprint = createHash('sha256').update(pageKeys.join('\n')).digest('hex');
        if (page.records.length > 0 && pageFingerprints.has(fingerprint)) {
            error = 'pagination_repeat_detected';
            completionReason = error;
            break;
        }
        if (page.records.length > 0) pageFingerprints.add(fingerprint);
        const newIdentities = pageKeys.filter(key => !discovered.has(key));
        if (page.records.length > 0 && newIdentities.length === 0) {
            error = 'pagination_no_new_identities';
            completionReason = error;
            break;
        }
        for (const key of pageKeys) discovered.add(key);
        for (const record of page.records) {
            if (selected.size >= sourceTarget) {
                notEvaluatedAfterTarget++;
                continue;
            }
            processedRecords.push(record);
            processed++;
            if (decisionForArm(arm, record, minDate, maxDate).routeable) {
                selected.add(recordIdentity(record));
            }
        }
        skip += page.records.length;
        if (page.records.length === 0 || page.records.length < take) {
            exhausted = true;
            completionReason = page.records.length === 0 ? 'empty_final_page' : 'short_final_page';
            break;
        }
        if (providerTotal !== null && skip >= providerTotal) {
            exhausted = true;
            completionReason = 'provider_total_exhausted';
            break;
        }
        if (selected.size >= sourceTarget) completionReason = 'native_target_reached';
        await wait(150);
    }

    if (!completionReason) {
        if (selected.size >= sourceTarget) completionReason = 'native_target_reached';
        else if (reviewed >= nativeMaxReviewed) completionReason = 'native_review_cap_reached';
        else if (pageTimings.length >= maxPages) completionReason = 'page_cap_reached';
        else completionReason = error || 'stopped';
    }
    const coverageComplete = exhausted
        && (providerTotal === null || reviewed >= providerTotal);
    const nativeComplete = !error && (
        coverageComplete
        || selected.size >= sourceTarget
        || reviewed >= nativeMaxReviewed
    );
    return {
        key: arm.key,
        method: arm.method,
        engine: arm.engine,
        description: arm.description,
        ok: !error,
        status: lastStatus,
        provider_total: providerTotal,
        count_provider_total: countProviderTotal,
        provider_totals_observed: [...providerTotalsObserved],
        provider_total_drift: providerTotalsObserved.size > 1,
        returned_count: records.length,
        raw_reviewed: reviewed,
        records_evaluated: processed,
        records_not_evaluated_after_target: notEvaluatedAfterTarget,
        unique_count: dedupe(records).size,
        duplicate_rows: Math.max(0, records.length - dedupe(records).size),
        selected_routeable_count: selected.size,
        requested_target: requested,
        source_target_after_count: sourceTarget,
        native_max_reviewed: nativeMaxReviewed,
        pages: pageTimings.length,
        page_timings: pageTimings,
        complete: coverageComplete,
        native_complete: nativeComplete,
        truncated: !coverageComplete,
        completion_reason: completionReason,
        error,
        request: arm.request,
        records,
        processed_records: processedRecords,
        selected_identity_keys: [...selected]
    };
}

function publicArm(result) {
    const { records, processed_records, selected_identity_keys, ...safe } = result;
    return safe;
}

function outcomeBucket({ legacyPulled, legacyRouteable, updatedPulled, updatedRouteable, providerListingDelta }) {
    if (providerListingDelta) return 'Absent after listing-safety predicate (status unverified)';
    if (legacyRouteable && updatedRouteable) return 'Routed by both';
    if (updatedRouteable && !legacyRouteable) return legacyPulled ? 'Updated rescued legacy rejection' : 'Updated-only routeable';
    if (legacyRouteable && !updatedPulled) return 'Legacy-only routeable';
    if (legacyPulled && !legacyRouteable && updatedPulled && !updatedRouteable) return 'Rejected by both';
    if (legacyPulled && !legacyRouteable) return 'Legacy rejected';
    if (updatedPulled && !updatedRouteable) return 'Updated rejected';
    return 'Discovered by control only';
}

function buildComparison(results, minDate, maxDate) {
    const byKey = Object.fromEntries(results.map(result => [result.key, result]));
    const maps = Object.fromEntries(results.map(result => [
        result.key,
        dedupe(result.processed_records || result.records)
    ]));
    const legacyExact = maps.legacy_exact_intel;
    const legacyNativeKeys = new Set(byKey.legacy_exact_intel.selected_identity_keys || []);
    const legacyClosed = maps.legacy_closed_intel;
    const preSafety = unionMaps(maps.updated_pre_safety_intel, maps.updated_pre_safety_sale);
    const updated = unionMaps(maps.updated_intel, maps.updated_sale);
    const all = unionMaps(legacyExact, legacyClosed, preSafety, updated);
    const indexes = Object.fromEntries(Object.entries({
        legacyExact,
        legacyClosed,
        preSafety,
        updated,
        updatedIntel: maps.updated_intel,
        updatedSale: maps.updated_sale
    }).map(([name, map]) => [name, identityIndexForMap(map)]));
    const getRecord = (name, referenceRecord) => recordFromAliases(
        ({ legacyExact, legacyClosed, preSafety, updated, updatedIntel: maps.updated_intel, updatedSale: maps.updated_sale })[name],
        indexes[name],
        referenceRecord
    );
    const updatedPlanCap = Math.min(1000, Number(byKey.updated_intel.requested_target || 1000));
    const updatedSourceRank = key => {
        const referenceRecord = updated.get(key);
        const inIntel = !!getRecord('updatedIntel', referenceRecord);
        const inSale = !!getRecord('updatedSale', referenceRecord);
        return inIntel && inSale ? 3 : (inSale ? 2 : (inIntel ? 1 : 0));
    };
    const updatedNativeKeys = new Set([...updated.keys()]
        .filter(key => updatedDecision(updated.get(key), minDate, maxDate).routeable)
        .sort((left, right) => updatedSourceRank(right) - updatedSourceRank(left))
        .slice(0, updatedPlanCap));
    const allComplete = results.every(result => result.ok && result.complete);
    const listingSafetyComparisonComplete = [
        'updated_pre_safety_intel',
        'updated_pre_safety_sale',
        'updated_intel',
        'updated_sale'
    ].every(key => byKey[key]?.ok && byKey[key]?.complete);
    const houses = [];

    for (const key of [...all.keys()].sort()) {
        const allRecord = all.get(key);
        const legacyExactRecord = getRecord('legacyExact', allRecord);
        const legacyClosedRecord = getRecord('legacyClosed', allRecord);
        const updatedIntelRecord = getRecord('updatedIntel', allRecord);
        const updatedSaleRecord = getRecord('updatedSale', allRecord);
        const preSafetyRecord = getRecord('preSafety', allRecord);
        const updatedQualifiedRecord = getRecord('updated', allRecord);
        const legacyRecord = legacyExactRecord || legacyClosedRecord || null;
        const updatedRecord = updatedSaleRecord || updatedIntelRecord || preSafetyRecord || null;
        const bestRecord = updatedRecord || legacyRecord;
        const bestFields = observedFields(bestRecord, maxDate);
        const legacyFields = observedFields(legacyRecord, maxDate);
        const updatedFields = observedFields(updatedRecord, maxDate);
        const legacyPulled = !!legacyExactRecord;
        const legacyComparable = !!legacyClosedRecord;
        const updatedIntelPulled = !!updatedIntelRecord;
        const updatedSalePulled = !!updatedSaleRecord;
        const updatedPulled = !!updatedQualifiedRecord;
        const preSafetyPulled = !!preSafetyRecord;
        const providerListingDelta = listingSafetyComparisonComplete && preSafetyPulled && !updatedPulled;
        const legacyResult = legacyDecision(legacyExactRecord, minDate, maxDate);
        const selectedLegacyIdentity = legacyExactRecord ? recordIdentity(legacyExactRecord) : null;
        if (legacyPulled && legacyResult.routeable && !legacyNativeKeys.has(selectedLegacyIdentity)) {
            legacyResult.routeable = false;
            legacyResult.reasons = ['Not selected after the legacy native target/review cap'];
        }
        let updatedResult = updatedDecision(updatedRecord && updatedPulled ? updatedRecord : null, minDate, maxDate);
        if (providerListingDelta) {
            updatedResult = {
                routeable: false,
                reasons: ['Absent after adding the provider Active/Pending exclusion; returned status unavailable'],
                warnings: ['Difference is consistent with listing safety but is not field-verified because Basic omitted listing status']
            };
        }
        if (!updatedPulled && !providerListingDelta && legacyPulled) {
            const legacyTodayLeak = legacyFields.sale_date && !isSaleDateWithinWindow(legacyFields.sale_date, minDate, maxDate);
            updatedResult = {
                routeable: false,
                reasons: [legacyTodayLeak
                    ? 'Legacy result is outside the updated closed-through-yesterday window'
                    : 'Not returned by updated qualified Intel/Sale queries; Basic response does not expose an exact field-level cause'],
                warnings: []
            };
        }
        if (updatedPulled && updatedResult.routeable && !updatedNativeKeys.has(key)) {
            updatedResult = {
                routeable: false,
                reasons: ['Excluded by the updated 1,000-stop plan cap after Intel/Sale source ranking'],
                warnings: updatedResult.warnings
            };
        }
        const comparison = outcomeBucket({
            legacyPulled,
            legacyRouteable: legacyResult.routeable,
            updatedPulled,
            updatedRouteable: updatedResult.routeable,
            providerListingDelta
        });
        houses.push({
            identity_key: SENSITIVE_OUTPUT ? key : createHash('sha256').update(key).digest('hex'),
            provider_property_id: SENSITIVE_OUTPUT ? (updatedFields.provider_id || legacyFields.provider_id || bestFields.provider_id) : '',
            full_address: SENSITIVE_OUTPUT ? bestFields.address.full : '',
            street: SENSITIVE_OUTPUT ? bestFields.address.street : '',
            city: SENSITIVE_OUTPUT ? bestFields.address.city : '',
            state: SENSITIVE_OUTPUT ? bestFields.address.state : '',
            zip: SENSITIVE_OUTPUT ? bestFields.address.zip : '',
            latitude: SENSITIVE_OUTPUT ? bestFields.address.latitude : null,
            longitude: SENSITIVE_OUTPUT ? bestFields.address.longitude : null,
            legacy_exact_pulled: legacyPulled,
            legacy_closed_window_pulled: legacyComparable,
            legacy_native_routeable: legacyResult.routeable,
            legacy_rejection_reasons: legacyResult.reasons.join('; '),
            legacy_safety_warnings: legacyResult.warnings.join('; '),
            legacy_observed_sale_date: legacyFields.sale_date,
            legacy_observed_sale_date_source: legacyFields.sale_date_source,
            legacy_observed_listing_status: legacyFields.listing_status,
            legacy_observed_property_type: legacyFields.property_type,
            legacy_observed_land_use_code: legacyFields.land_use_code,
            legacy_observed_price: legacyFields.legacy_price,
            updated_pre_listing_candidate: preSafetyPulled,
            updated_provider_listing_safety_delta: providerListingDelta,
            updated_provider_listing_rejected_verified: false,
            updated_intel_pulled: updatedIntelPulled,
            updated_sale_pulled: updatedSalePulled,
            updated_union_pulled: updatedPulled,
            updated_native_routeable: updatedResult.routeable,
            updated_rejection_reasons: updatedResult.reasons.join('; '),
            updated_evidence_notes: updatedResult.warnings.join('; '),
            updated_observed_sale_date: updatedFields.sale_date,
            updated_observed_sale_date_source: updatedFields.sale_date_source,
            updated_observed_listing_status: updatedFields.listing_status,
            updated_observed_property_type: updatedFields.property_type,
            updated_observed_land_use_code: updatedFields.land_use_code,
            updated_observed_estimated_value: updatedFields.estimated_value,
            outcome_bucket: comparison
        });
    }

    const legacyRouteable = houses.filter(row => row.legacy_native_routeable).length;
    const updatedRouteable = houses.filter(row => row.updated_native_routeable).length;
    const providerListingDelta = houses.filter(row => row.updated_provider_listing_safety_delta).length;
    const updatedLocalRejected = houses.filter(row =>
        row.updated_union_pulled
        && !row.updated_native_routeable
        && !row.updated_rejection_reasons.includes('1,000-stop plan cap')
    ).length;
    const updatedPlanCapExcluded = houses.filter(row => row.updated_rejection_reasons.includes('1,000-stop plan cap')).length;
    const legacyLocalRejected = houses.filter(row =>
        row.legacy_exact_pulled
        && !row.legacy_native_routeable
        && !row.legacy_rejection_reasons.includes('native target/review cap')
    ).length;
    const legacyCapExcluded = houses.filter(row => row.legacy_rejection_reasons.includes('native target/review cap')).length;
    const updatedEstimatedUnits = byKey.updated_intel.returned_count + byKey.updated_sale.returned_count;
    const legacyEstimatedUnits = byKey.legacy_exact_intel.returned_count;
    const comparison = {
        complete: allComplete,
        native_complete: results.every(result => result.ok && result.native_complete),
        all_provider_streams_exhausted: allComplete,
        listing_safety_comparison_complete: listingSafetyComparisonComplete,
        legacy_exact_unique_pulled: legacyExact.size,
        legacy_exact_provider_total: byKey.legacy_exact_intel.provider_total,
        legacy_exact_pages: byKey.legacy_exact_intel.pages,
        legacy_closed_window_unique_pulled: legacyClosed.size,
        updated_pre_listing_unique_candidates: preSafety.size,
        updated_intel_unique_pulled: maps.updated_intel.size,
        updated_intel_provider_total: byKey.updated_intel.provider_total,
        updated_intel_pages: byKey.updated_intel.pages,
        updated_sale_unique_pulled: maps.updated_sale.size,
        updated_sale_provider_total: byKey.updated_sale.provider_total,
        updated_sale_pages: byKey.updated_sale.pages,
        updated_union_unique_pulled: updated.size,
        updated_intel_sale_overlap: houses.filter(row => row.updated_intel_pulled && row.updated_sale_pulled).length,
        updated_intel_only: houses.filter(row => row.updated_intel_pulled && !row.updated_sale_pulled).length,
        updated_sale_only: houses.filter(row => row.updated_sale_pulled && !row.updated_intel_pulled).length,
        legacy_updated_overlap: houses.filter(row => row.legacy_exact_pulled && row.updated_union_pulled).length,
        legacy_only: houses.filter(row => row.legacy_exact_pulled && !row.updated_union_pulled).length,
        updated_only: houses.filter(row => row.updated_union_pulled && !row.legacy_exact_pulled).length,
        legacy_native_rejected: legacyLocalRejected,
        legacy_native_cap_excluded: legacyCapExcluded,
        legacy_native_routeable: legacyRouteable,
        updated_provider_listing_safety_delta: providerListingDelta,
        updated_provider_listing_rejected_verified: 0,
        updated_local_rejected_after_pull: updatedLocalRejected,
        updated_plan_cap_excluded: updatedPlanCapExcluded,
        updated_native_routeable: updatedRouteable,
        legacy_routeable_per_sq_mile: legacyRouteable / ACTUAL_AREA_SQ_MI,
        updated_routeable_per_sq_mile: updatedRouteable / ACTUAL_AREA_SQ_MI,
        routeable_uplift_count: updatedRouteable - legacyRouteable,
        routeable_uplift_rate: legacyRouteable > 0 ? (updatedRouteable - legacyRouteable) / legacyRouteable : null,
        legacy_estimated_returned_record_units: legacyEstimatedUnits,
        updated_estimated_returned_record_units: updatedEstimatedUnits,
        scientific_control_returned_record_units: results
            .filter(result => result.method === 'control')
            .reduce((sum, result) => sum + result.returned_count, 0),
        core_pipeline_returned_record_units: legacyEstimatedUnits + updatedEstimatedUnits,
        updated_duplicate_source_record_units: Math.max(0, updatedEstimatedUnits - updated.size),
        legacy_estimated_units_per_routeable_door: legacyRouteable > 0 ? legacyEstimatedUnits / legacyRouteable : null,
        updated_estimated_units_per_routeable_door: updatedRouteable > 0 ? updatedEstimatedUnits / updatedRouteable : null,
        updated_to_legacy_estimated_unit_ratio: legacyEstimatedUnits > 0 ? updatedEstimatedUnits / legacyEstimatedUnits : null,
        incremental_routeable_doors_per_incremental_unit: updatedEstimatedUnits > legacyEstimatedUnits
            ? (updatedRouteable - legacyRouteable) / (updatedEstimatedUnits - legacyEstimatedUnits)
            : null,
        actual_provider_credits: 'unverified_reconcile_in_BatchData_dashboard'
    };

    const rejectionCounts = new Map();
    const addReason = (method, reason) => {
        const key = `${method}|${reason || 'No reason'}`;
        rejectionCounts.set(key, (rejectionCounts.get(key) || 0) + 1);
    };
    for (const row of houses) {
        if (row.legacy_exact_pulled && !row.legacy_native_routeable) {
            const method = row.legacy_rejection_reasons.includes('native target/review cap')
                ? 'Legacy native cap'
                : 'Legacy native';
            for (const reason of row.legacy_rejection_reasons.split('; ').filter(Boolean)) addReason(method, reason);
        }
        if (row.updated_provider_listing_safety_delta) {
            addReason('Updated provider comparison', 'Absent after Active/Pending exclusion; returned status unavailable');
        }
        if (row.updated_union_pulled && !row.updated_native_routeable) {
            const method = row.updated_rejection_reasons.includes('1,000-stop plan cap')
                ? 'Updated plan cap'
                : 'Updated local';
            for (const reason of row.updated_rejection_reasons.split('; ').filter(Boolean)) addReason(method, reason);
        }
    }
    const rejections = [...rejectionCounts.entries()].map(([key, count]) => {
        const [method, reason] = key.split('|');
        return { method, reason, count };
    }).sort((a, b) => b.count - a.count || a.method.localeCompare(b.method) || a.reason.localeCompare(b.reason));

    return { comparison, houses, rejections };
}

async function main() {
    const asOf = cliValue('as-of', phoenixDate());
    const days = Number(cliValue('days', 14));
    const centerKey = String(cliValue('center', 'seattle')).trim().toLowerCase();
    const areaSqMi = Number(cliValue('area-sq-mi', 25));
    const requested = Number(cliValue('requested', 1000));
    const pageSize = Number(cliValue('page-size', cliValue('take', 100)));
    const httpBudget = Number(cliValue('http-budget', cliValue('budget', 80)));
    const recordBudget = Number(cliValue('record-budget', 5000));
    const maxPages = Number(cliValue('max-pages-per-arm', 50));
    const safetyOrder = String(cliValue('safety-order', 'pre-first')).trim().toLowerCase();
    const preflightOnly = process.argv.includes('--preflight-only');
    const outputPath = cliValue('output');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('--as-of must be YYYY-MM-DD');
    if (!VALIDATION_CENTERS[centerKey]) throw new Error('--center must be seattle or phoenix');
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be 1..365');
    if (!Number.isFinite(areaSqMi) || areaSqMi < 1 || areaSqMi > 1000) throw new Error('--area-sq-mi must be 1..1000');
    if (!Number.isInteger(requested) || requested < 1 || requested > 1000) throw new Error('--requested must be 1..1000');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) throw new Error('--page-size must be 1..100');
    if (!Number.isInteger(httpBudget) || httpBudget < 6 || httpBudget > 500) throw new Error('--http-budget must be 6..500');
    if (!Number.isInteger(recordBudget) || recordBudget < 1 || recordBudget > 30000) throw new Error('--record-budget must be 1..30000');
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) throw new Error('--max-pages-per-arm must be 1..50');
    if (!['pre-first', 'post-first'].includes(safetyOrder)) throw new Error('--safety-order must be pre-first or post-first');
    NOMINAL_AREA_SQ_MI = areaSqMi;
    RUN_CENTER = VALIDATION_CENTERS[centerKey];
    POLYGON = squarePolygon(RUN_CENTER, areaSqMi);
    ACTUAL_AREA_SQ_MI = polygonAreaSqMiles(POLYGON);
    const maxDate = daysBefore(asOf, 1);
    const minDate = daysBefore(asOf, days);
    const arms = buildArmDefinitions(minDate, maxDate, pageSize, safetyOrder);
    const polygonLabel = `${RUN_CENTER.label} public ${areaSqMi.toLocaleString()} sq mi validation polygon`;

    if (!LIVE_CONFIRMED) {
        process.stdout.write(`${JSON.stringify({
            mode: 'plan_only_no_network',
            network_requests_made: 0,
            planned_count_requests: arms.length,
            maximum_paged_requests: arms.length * maxPages,
            http_budget: httpBudget,
            record_budget: recordBudget,
            as_of_date: asOf,
            window_days: days,
            min_date: minDate,
            max_date: maxDate,
            safety_order: safetyOrder,
            requested_route_stops: requested,
            nominal_area_sq_mi: areaSqMi,
            computed_area_sq_mi: ACTUAL_AREA_SQ_MI,
            center: RUN_CENTER,
            polygon_label: polygonLabel,
            polygon: POLYGON,
            arms: arms.map(arm => ({ key: arm.key, engine: arm.engine, description: arm.description, request: arm.request })),
            privacy: {
                sensitive_output_requested: SENSITIVE_OUTPUT,
                addresses_persisted_only_when_sensitive_output_is_explicit: true,
                provider_payloads_persisted: false,
                provider_error_bodies_persisted: false
            },
            execute_preflight: 'Re-run with --confirm-live --preflight-only and an explicit --output path.',
            execute_full: 'After reviewing preflight totals, re-run with --confirm-live --sensitive-output and the same hard budgets.'
        }, null, 2)}\n`);
        console.error('PLAN ONLY: no BatchData request was made.');
        return;
    }

    if (!outputPath) throw new Error('--output is required for live comparison');
    if (!preflightOnly && !SENSITIVE_OUTPUT) throw new Error('--sensitive-output is required for the requested exact-house comparison');
    if (!API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
    const budgetState = {
        httpUsed: 0,
        httpLimit: httpBudget,
        recordUnits: 0,
        recordLimit: recordBudget
    };
    const countResults = [];
    for (const arm of arms) {
        console.error(`[count ${countResults.length + 1}/${arms.length}] ${arm.key}`);
        countResults.push(await countArm(arm, budgetState));
    }
    const preflightArms = countResults.map(result => {
        const arm = arms.find(candidate => candidate.key === result.key);
        const nativeMaxReviewed = arm.engine === 'legacy'
            ? LEGACY_MAX_REVIEWED
            : UPDATED_MAX_REVIEWED_PER_SOURCE;
        const estimatedRecords = result.provider_total === null
            ? nativeMaxReviewed
            : Math.min(result.provider_total, nativeMaxReviewed);
        return {
            ...result,
            native_max_reviewed: nativeMaxReviewed,
            estimated_max_records: estimatedRecords,
            estimated_max_pages: Math.ceil(estimatedRecords / pageSize)
        };
    });
    const preflight = {
        all_counts_succeeded: preflightArms.every(result => result.ok && result.provider_total !== null),
        estimated_max_returned_record_units: preflightArms.reduce((sum, result) => sum + result.estimated_max_records, 0),
        estimated_max_http_attempts: arms.length + preflightArms.reduce((sum, result) => sum + result.estimated_max_pages, 0),
        http_budget: httpBudget,
        record_budget: recordBudget,
        arms: preflightArms
    };
    const resolvedOutput = path.resolve(outputPath);
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    if (preflightOnly) {
        const preflightReport = {
            schema_version: 3,
            mode: 'live_count_preflight_only',
            metadata: {
                generated_at: new Date().toISOString(),
                as_of_date: asOf,
                timezone: 'America/Phoenix',
                window_days: days,
                min_date: minDate,
                max_date: maxDate,
                safety_order: safetyOrder,
                polygon_label: polygonLabel,
                nominal_area_sq_mi: areaSqMi,
                computed_area_sq_mi: ACTUAL_AREA_SQ_MI,
                center: RUN_CENTER,
                polygon: POLYGON,
                requested_route_stops: requested,
                direct_provider_read_only: true,
                base44_writes: 0,
                neon_writes: 0,
                count_http_attempts: budgetState.httpUsed,
                returned_record_units: 0
            },
            preflight
        };
        await writeFile(resolvedOutput, JSON.stringify(preflightReport, null, 2), 'utf8');
        process.stdout.write(`${JSON.stringify({ output: resolvedOutput, ...preflight }, null, 2)}\n`);
        return;
    }
    if (!preflight.all_counts_succeeded) {
        await writeFile(resolvedOutput, JSON.stringify({ mode: 'aborted_after_preflight', preflight }, null, 2), 'utf8');
        throw new Error('Count preflight was incomplete; no record pages were requested.');
    }
    if (preflight.estimated_max_returned_record_units > recordBudget) {
        await writeFile(resolvedOutput, JSON.stringify({ mode: 'aborted_after_preflight', preflight }, null, 2), 'utf8');
        throw new Error(`Preflight estimate ${preflight.estimated_max_returned_record_units} exceeds record budget ${recordBudget}; no record pages were requested.`);
    }
    if (preflight.estimated_max_http_attempts > httpBudget) {
        await writeFile(resolvedOutput, JSON.stringify({ mode: 'aborted_after_preflight', preflight }, null, 2), 'utf8');
        throw new Error(`Preflight estimate ${preflight.estimated_max_http_attempts} HTTP attempts exceeds budget ${httpBudget}; no record pages were requested.`);
    }

    const results = [];
    for (let index = 0; index < arms.length; index++) {
        const arm = arms[index];
        console.error(`[pages ${results.length + 1}/${arms.length}] ${arm.key}`);
        results.push(await paginateArm(arm, countResults[index], budgetState, {
            requested,
            pageSize,
            maxPages,
            minDate,
            maxDate
        }));
    }

    const { comparison, houses, rejections } = buildComparison(results, minDate, maxDate);
    const report = {
        schema_version: 3,
        metadata: {
            generated_at: new Date().toISOString(),
            as_of_date: asOf,
            timezone: 'America/Phoenix',
            window_days: days,
            min_date: minDate,
            max_date: maxDate,
            safety_order: safetyOrder,
            polygon_label: polygonLabel,
            nominal_area_sq_mi: areaSqMi,
            computed_area_sq_mi: ACTUAL_AREA_SQ_MI,
            center: RUN_CENTER,
            polygon: POLYGON,
            requested_route_stops: requested,
            page_size: pageSize,
            max_pages_per_arm: maxPages,
            http_budget: httpBudget,
            record_budget: recordBudget,
            minimum_estimated_value: MIN_VALUE,
            legacy_commit: LEGACY_COMMIT,
            updated_commit: UPDATED_COMMIT,
            identity_contract: 'production_multi_key_provider_id_address_hash_apn_address_merge',
            sensitive_output: true,
            direct_provider_read_only: true,
            base44_writes: 0,
            neon_writes: 0,
            http_attempts: budgetState.httpUsed,
            count_probe_attempts: countResults.length,
            estimated_returned_record_units: budgetState.recordUnits,
            retry_attempts: 0
        },
        preflight,
        comparison,
        arms: results.map(publicArm),
        rejections,
        houses,
        limitations: [
            'This measures internal BatchData coverage, not recall against an independent recorder or MLS ground-truth universe.',
            'Actual provider credits require reconciliation in the BatchData dashboard; returned-record units are only a local estimate.',
            'The legacy closed-window arm is a scientific control, not code that existed in commit 3ff8424.',
            'Basic responses can omit the exact date, type, value, and listing fields; updated acceptance may rely on auditable request-predicate proof.',
            'A pre-safety-only identity is a listing-predicate delta, not a field-verified Active/Pending rejection, unless the returned payload explicitly supplies a blocked listing status.',
            'The run excludes account-specific assigned-route and knock-history state so neither method mutates or benefits from production state.',
            'If any arm is not provider-exhausted, property-level differences beyond its native 1,000-stop/review cap are lower bounds.',
            'The updated production flow can review up to 5,000 records per date source but returns at most 1,000 route stops; legacy reviews at most 1,000 records.'
        ]
    };
    await writeFile(resolvedOutput, JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`${JSON.stringify({
        output: resolvedOutput,
        complete: comparison.complete,
        http_attempts: budgetState.httpUsed,
        estimated_returned_record_units: budgetState.recordUnits,
        houses: houses.length,
        comparison
    }, null, 2)}\n`);
}

const isDirectExecution = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) await main();

export { executeSearchPage, paginateArm };
