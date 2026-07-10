import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
const NOMINAL_AREA_SQ_MI = 25;
const LEGACY_COMMIT = '3ff84240';
const UPDATED_COMMIT = '5748ed50';

// Public, deterministic 25-square-mile validation polygon centered on Seattle.
const POLYGON = [
    { latitude: 47.642432, longitude: -122.385839 },
    { latitude: 47.642432, longitude: -122.278361 },
    { latitude: 47.569968, longitude: -122.278361 },
    { latitude: 47.569968, longitude: -122.385839 },
    { latitude: 47.642432, longitude: -122.385839 }
];

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

function recordIdentity(record) {
    const address = normalizedAddress(record);
    const addressKey = [address.street, address.city, address.state, address.zip]
        .map(value => value.toLowerCase().replace(/[^a-z0-9]/g, ''))
        .join('|');
    if (address.street && address.zip) return `address:${addressKey}`;
    const property = unwrapBatchDataProperty(record);
    const ids = property.ids || property.identifiers || {};
    const id = firstValue(ids.propertyId, ids.id, property.propertyId, property.id);
    if (id) return `provider:${id}`;
    return `record:${createHash('sha256').update(JSON.stringify(record)).digest('hex')}`;
}

function providerId(record) {
    const property = unwrapBatchDataProperty(record);
    const ids = property.ids || property.identifiers || {};
    return cleanText(firstValue(ids.propertyId, ids.id, property.propertyId, property.id));
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

function buildArmDefinitions(minDate, maxDate, take) {
    return [
        {
            key: 'legacy_exact_intel',
            method: 'legacy',
            description: 'Commit 3ff8424 exact Intel request (minDate only, no datasets, no listing exclusion)',
            request: {
                searchCriteria: buildCriteria('intel', minDate, maxDate, { closedWindow: false }),
                options: { skip: 0, take }
            }
        },
        {
            key: 'legacy_closed_intel',
            method: 'control',
            description: 'Legacy Intel request with maxDate added only for equal-window comparison',
            request: {
                searchCriteria: buildCriteria('intel', minDate, maxDate),
                options: { skip: 0, take }
            }
        },
        {
            key: 'updated_pre_safety_intel',
            method: 'control',
            description: 'Updated Intel contract before listing-safety predicate',
            request: {
                searchCriteria: buildCriteria('intel', minDate, maxDate),
                options: { skip: 0, take, datasets: ['basic'] }
            }
        },
        {
            key: 'updated_pre_safety_sale',
            method: 'control',
            description: 'Updated Sale contract before listing-safety predicate',
            request: {
                searchCriteria: buildCriteria('sale', minDate, maxDate),
                options: { skip: 0, take, datasets: ['basic'] }
            }
        },
        {
            key: 'updated_intel',
            method: 'updated',
            description: 'Updated qualified Intel request',
            request: {
                searchCriteria: buildCriteria('intel', minDate, maxDate, { listingSafety: true }),
                options: { skip: 0, take, datasets: ['basic'] }
            }
        },
        {
            key: 'updated_sale',
            method: 'updated',
            description: 'Updated qualified Sale request',
            request: {
                searchCriteria: buildCriteria('sale', minDate, maxDate, { listingSafety: true }),
                options: { skip: 0, take, datasets: ['basic'] }
            }
        }
    ];
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

const NON_SFR_RE = /commercial|industrial|vacant|agricultural|\bland\b|day ?care|child ?care|church|school|office|retail|store|warehouse|hotel|motel|restaurant|medical|hospital|parking|exempt|government|condo|minium|apartment|multi[- ]?family|multifamily|duplex|triplex|fourplex|townhouse|townhome|row ?house|manufactured|mobile home/i;

function legacyDecision(record, minDate, maxDate) {
    if (!record) return { routeable: false, reasons: ['Not pulled by legacy Intel'], warnings: [] };
    const fields = observedFields(record, maxDate);
    const reasons = [];
    const warnings = [];
    if (!fields.address.street) reasons.push('Missing street address');
    if (!fields.address.zip) reasons.push('Missing ZIP code');
    if (!Number.isFinite(fields.address.latitude) || !Number.isFinite(fields.address.longitude)) reasons.push('Missing coordinates');
    else if (!isPointInPolygon(fields.address, POLYGON)) reasons.push('Coordinates outside polygon');
    if (fields.property_type && NON_SFR_RE.test(fields.property_type)) reasons.push(`Explicit non-SFR type: ${fields.property_type}`);
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
    if (isBlockedListingStatus(fields.listing_status)) reasons.push(`Explicit blocked listing status: ${fields.listing_status}`);
    if (fields.property_type && NON_SFR_RE.test(fields.property_type)) reasons.push(`Explicit non-SFR contradiction: ${fields.property_type}`);
    if (fields.land_use_code && fields.land_use_code.toUpperCase() !== 'R2') reasons.push(`Explicit non-R2 contradiction: ${fields.land_use_code}`);
    if (fields.estimated_value !== null && fields.estimated_value < MIN_VALUE) reasons.push('Known estimated value below $100,000');
    if (fields.sale_date && !isSaleDateWithinWindow(fields.sale_date, minDate, maxDate)) reasons.push(`Returned sale date outside closed window: ${fields.sale_date}`);

    if (!fields.sale_date) warnings.push('Accepted by exact provider date-predicate proof; Basic omitted exact date');
    if (!fields.property_type && !fields.land_use_code) warnings.push('Accepted by provider R2 predicate proof; Basic omitted type fields');
    if (fields.estimated_value === null) warnings.push('Accepted by provider $100k predicate proof; Basic omitted estimate');
    if (!fields.listing_status) warnings.push('Accepted by provider Active/Pending exclusion proof; Basic omitted status');
    return { routeable: reasons.length === 0, reasons, warnings };
}

function dedupe(records) {
    const result = new Map();
    for (const record of records || []) {
        const key = recordIdentity(record);
        if (!result.has(key)) result.set(key, record);
    }
    return result;
}

function unionMaps(...maps) {
    const result = new Map();
    for (const map of maps) for (const [key, record] of map) if (!result.has(key)) result.set(key, record);
    return result;
}

function intersectionCount(a, b) {
    let count = 0;
    for (const key of a.keys()) if (b.has(key)) count++;
    return count;
}

function differenceKeys(a, b) {
    return [...a.keys()].filter(key => !b.has(key));
}

function pct(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : null;
}

async function postSearch(arm, budgetState) {
    if (budgetState.used >= budgetState.limit) throw new Error('Local HTTP budget exhausted before request');
    budgetState.used++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const started = Date.now();
    try {
        const response = await fetch(SEARCH_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify(arm.request),
            signal: controller.signal
        });
        const body = await response.text();
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
        const records = response.ok ? extractRecords(payload) : [];
        const total = response.ok ? extractTotal(payload) : null;
        const take = Number(arm.request.options.take) || 0;
        const complete = response.ok && (
            (total !== null && total <= records.length)
            || records.length < take
        );
        return {
            key: arm.key,
            method: arm.method,
            description: arm.description,
            ok: response.ok,
            status: response.status,
            elapsed_ms: Date.now() - started,
            provider_total: total,
            returned_count: records.length,
            unique_count: dedupe(records).size,
            complete,
            truncated: response.ok && !complete,
            error: response.ok ? null : `http_${response.status}`,
            request: arm.request,
            records
        };
    } catch (error) {
        return {
            key: arm.key,
            method: arm.method,
            description: arm.description,
            ok: false,
            status: error?.name === 'AbortError' ? 408 : 0,
            elapsed_ms: Date.now() - started,
            provider_total: null,
            returned_count: 0,
            unique_count: 0,
            complete: false,
            truncated: false,
            error: error?.name === 'AbortError' ? 'request_timeout' : 'network_error',
            request: arm.request,
            records: []
        };
    } finally {
        clearTimeout(timeout);
    }
}

function publicArm(result) {
    const { records, ...safe } = result;
    return safe;
}

function outcomeBucket({ legacyPulled, legacyRouteable, updatedPulled, updatedRouteable, providerListingRejected }) {
    if (providerListingRejected) return 'Updated rejected by listing-safety predicate';
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
    const maps = Object.fromEntries(results.map(result => [result.key, dedupe(result.records)]));
    const legacyExact = maps.legacy_exact_intel;
    const legacyClosed = maps.legacy_closed_intel;
    const preSafety = unionMaps(maps.updated_pre_safety_intel, maps.updated_pre_safety_sale);
    const updated = unionMaps(maps.updated_intel, maps.updated_sale);
    const all = unionMaps(legacyExact, legacyClosed, preSafety, updated);
    const allComplete = results.every(result => result.ok && result.complete);
    const houses = [];

    for (const key of [...all.keys()].sort()) {
        const legacyRecord = legacyExact.get(key) || legacyClosed.get(key) || null;
        const updatedRecord = maps.updated_sale.get(key) || maps.updated_intel.get(key) || preSafety.get(key) || null;
        const bestRecord = updatedRecord || legacyRecord;
        const bestFields = observedFields(bestRecord, maxDate);
        const legacyFields = observedFields(legacyRecord, maxDate);
        const updatedFields = observedFields(updatedRecord, maxDate);
        const legacyPulled = legacyExact.has(key);
        const legacyComparable = legacyClosed.has(key);
        const updatedIntelPulled = maps.updated_intel.has(key);
        const updatedSalePulled = maps.updated_sale.has(key);
        const updatedPulled = updated.has(key);
        const preSafetyPulled = preSafety.has(key);
        const providerListingRejected = allComplete && preSafetyPulled && !updatedPulled;
        const legacyResult = legacyDecision(legacyExact.get(key), minDate, maxDate);
        let updatedResult = updatedDecision(updatedRecord && updatedPulled ? updatedRecord : null, minDate, maxDate);
        if (providerListingRejected) {
            updatedResult = {
                routeable: false,
                reasons: ['Rejected by updated provider Active/Pending listing-safety predicate'],
                warnings: []
            };
        }
        if (!updatedPulled && !providerListingRejected && legacyPulled) {
            const legacyTodayLeak = legacyFields.sale_date && !isSaleDateWithinWindow(legacyFields.sale_date, minDate, maxDate);
            updatedResult = {
                routeable: false,
                reasons: [legacyTodayLeak
                    ? 'Legacy result is outside the updated closed-through-yesterday window'
                    : 'Not returned by updated qualified Intel/Sale queries; Basic response does not expose an exact field-level cause'],
                warnings: []
            };
        }
        const comparison = outcomeBucket({
            legacyPulled,
            legacyRouteable: legacyResult.routeable,
            updatedPulled,
            updatedRouteable: updatedResult.routeable,
            providerListingRejected
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
            updated_provider_listing_rejected: providerListingRejected,
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
    const providerListingRejected = houses.filter(row => row.updated_provider_listing_rejected).length;
    const updatedLocalRejected = houses.filter(row => row.updated_union_pulled && !row.updated_native_routeable).length;
    const legacyLocalRejected = houses.filter(row => row.legacy_exact_pulled && !row.legacy_native_routeable).length;
    const updatedEstimatedUnits = byKey.updated_intel.returned_count + byKey.updated_sale.returned_count;
    const legacyEstimatedUnits = byKey.legacy_exact_intel.returned_count;
    const comparison = {
        complete: allComplete,
        legacy_exact_unique_pulled: legacyExact.size,
        legacy_closed_window_unique_pulled: legacyClosed.size,
        updated_pre_listing_unique_candidates: preSafety.size,
        updated_intel_unique_pulled: maps.updated_intel.size,
        updated_sale_unique_pulled: maps.updated_sale.size,
        updated_union_unique_pulled: updated.size,
        updated_intel_sale_overlap: intersectionCount(maps.updated_intel, maps.updated_sale),
        updated_intel_only: differenceKeys(maps.updated_intel, maps.updated_sale).length,
        updated_sale_only: differenceKeys(maps.updated_sale, maps.updated_intel).length,
        legacy_updated_overlap: intersectionCount(legacyExact, updated),
        legacy_only: differenceKeys(legacyExact, updated).length,
        updated_only: differenceKeys(updated, legacyExact).length,
        legacy_native_rejected: legacyLocalRejected,
        legacy_native_routeable: legacyRouteable,
        updated_provider_listing_rejected: providerListingRejected,
        updated_local_rejected_after_pull: updatedLocalRejected,
        updated_native_routeable: updatedRouteable,
        legacy_routeable_per_sq_mile: legacyRouteable / NOMINAL_AREA_SQ_MI,
        updated_routeable_per_sq_mile: updatedRouteable / NOMINAL_AREA_SQ_MI,
        routeable_uplift_count: updatedRouteable - legacyRouteable,
        routeable_uplift_rate: legacyRouteable > 0 ? (updatedRouteable - legacyRouteable) / legacyRouteable : null,
        legacy_estimated_returned_record_units: legacyEstimatedUnits,
        updated_estimated_returned_record_units: updatedEstimatedUnits,
        legacy_estimated_units_per_routeable_door: legacyRouteable > 0 ? legacyEstimatedUnits / legacyRouteable : null,
        updated_estimated_units_per_routeable_door: updatedRouteable > 0 ? updatedEstimatedUnits / updatedRouteable : null,
        actual_provider_credits: 'unverified_reconcile_in_BatchData_dashboard'
    };

    const rejectionCounts = new Map();
    const addReason = (method, reason) => {
        const key = `${method}|${reason || 'No reason'}`;
        rejectionCounts.set(key, (rejectionCounts.get(key) || 0) + 1);
    };
    for (const row of houses) {
        if (row.legacy_exact_pulled && !row.legacy_native_routeable) {
            for (const reason of row.legacy_rejection_reasons.split('; ').filter(Boolean)) addReason('Legacy native', reason);
        }
        if (row.updated_provider_listing_rejected) addReason('Updated provider', 'Active/Pending listing-safety predicate');
        if (row.updated_union_pulled && !row.updated_native_routeable) {
            for (const reason of row.updated_rejection_reasons.split('; ').filter(Boolean)) addReason('Updated local', reason);
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
    const take = Number(cliValue('take', 100));
    const budget = Number(cliValue('budget', 6));
    const outputPath = cliValue('output');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('--as-of must be YYYY-MM-DD');
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be 1..365');
    if (!Number.isInteger(take) || take < 1 || take > 100) throw new Error('--take must be 1..100');
    if (!Number.isInteger(budget) || budget < 6 || budget > 50) throw new Error('--budget must be 6..50');
    const maxDate = daysBefore(asOf, 1);
    const minDate = daysBefore(asOf, days);
    const arms = buildArmDefinitions(minDate, maxDate, take);

    if (!LIVE_CONFIRMED) {
        process.stdout.write(`${JSON.stringify({
            mode: 'plan_only_no_network',
            network_requests_made: 0,
            planned_requests: arms.length,
            http_budget: budget,
            as_of_date: asOf,
            window_days: days,
            min_date: minDate,
            max_date: maxDate,
            polygon_label: 'Seattle public 25 sq mi validation polygon',
            polygon: POLYGON,
            arms: arms.map(arm => ({ key: arm.key, description: arm.description, request: arm.request })),
            privacy: {
                sensitive_output_requested: SENSITIVE_OUTPUT,
                addresses_persisted_only_when_sensitive_output_is_explicit: true,
                provider_payloads_persisted: false,
                provider_error_bodies_persisted: false
            },
            execute: 'Re-run with --confirm-live --sensitive-output and an explicit --output path.'
        }, null, 2)}\n`);
        console.error('PLAN ONLY: no BatchData request was made.');
        return;
    }

    if (!SENSITIVE_OUTPUT) throw new Error('--sensitive-output is required for the requested exact-house comparison');
    if (!outputPath) throw new Error('--output is required for live comparison');
    if (!API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
    const budgetState = { used: 0, limit: budget };
    const results = [];
    for (const arm of arms) {
        console.error(`[${results.length + 1}/${arms.length}] ${arm.key}`);
        results.push(await postSearch(arm, budgetState));
    }

    const { comparison, houses, rejections } = buildComparison(results, minDate, maxDate);
    const report = {
        schema_version: 1,
        metadata: {
            generated_at: new Date().toISOString(),
            as_of_date: asOf,
            timezone: 'America/Phoenix',
            window_days: days,
            min_date: minDate,
            max_date: maxDate,
            polygon_label: 'Seattle public 25 sq mi validation polygon',
            nominal_area_sq_mi: NOMINAL_AREA_SQ_MI,
            polygon: POLYGON,
            minimum_estimated_value: MIN_VALUE,
            legacy_commit: LEGACY_COMMIT,
            updated_commit: UPDATED_COMMIT,
            sensitive_output: true,
            direct_provider_read_only: true,
            base44_writes: 0,
            neon_writes: 0,
            http_attempts: budgetState.used,
            retry_attempts: 0
        },
        comparison,
        arms: results.map(publicArm),
        rejections,
        houses,
        limitations: [
            'This measures internal BatchData coverage, not recall against an independent recorder or MLS ground-truth universe.',
            'Actual provider credits require reconciliation in the BatchData dashboard; returned-record units are only a local estimate.',
            'The legacy closed-window arm is a scientific control, not code that existed in commit 3ff8424.',
            'Basic responses can omit the exact date, type, value, and listing fields; updated acceptance may rely on auditable request-predicate proof.',
            'The run excludes account-specific assigned-route and knock-history state so neither method mutates or benefits from production state.',
            'If any arm is incomplete or truncated, property-level differences are lower bounds and the verdict is inconclusive.'
        ]
    };
    const resolvedOutput = path.resolve(outputPath);
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    await writeFile(resolvedOutput, JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`${JSON.stringify({
        output: resolvedOutput,
        complete: comparison.complete,
        http_attempts: budgetState.used,
        houses: houses.length,
        comparison
    }, null, 2)}\n`);
}

await main();
