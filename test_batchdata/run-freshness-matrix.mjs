import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

import { selectRecentSaleEvidence } from '../base44/functions/processFetchChunk/recentSaleLogic.js';

loadEnv({ path: '.env', quiet: true });

const API_KEY = process.env.BATCH_DATA_API_KEY;
const SEARCH_URL = 'https://api.batchdata.com/api/v1/property/search';
const LOOKUP_URL = 'https://api.batchdata.com/api/v1/property/lookup/all-attributes';
const LEGACY_LOOKUP_URL = 'https://api.batchdata.com/api/v1/property/lookup';
const REQUEST_TIMEOUT_MS = 25000;
const PAIR_DELAY_MS = 250;
const SAMPLE_TAKE = 5;
const LOOKUPS_PER_CITY = 2;
const HALF_SIZE_MILES = 2.5;
const DEFAULT_LIVE_HTTP_BUDGET = 400;
const LIVE_CONFIRMED = process.argv.includes('--confirm-live');
const LIVE_HTTP_BUDGET = Number(cliValue('budget', DEFAULT_LIVE_HTTP_BUDGET));

const CITIES = [
    { city: 'Anderson', state: 'SC', lat: 34.5034, lng: -82.6501, region: 'Southeast' },
    { city: 'Austin', state: 'TX', lat: 30.2672, lng: -97.7431, region: 'Texas' },
    { city: 'Phoenix', state: 'AZ', lat: 33.4484, lng: -112.0740, region: 'Southwest' },
    { city: 'Charlotte', state: 'NC', lat: 35.2271, lng: -80.8431, region: 'Southeast' },
    { city: 'Indianapolis', state: 'IN', lat: 39.7684, lng: -86.1581, region: 'Midwest' },
    { city: 'Atlanta', state: 'GA', lat: 33.7490, lng: -84.3880, region: 'Southeast' },
    { city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.7970, region: 'Texas' },
    { city: 'Houston', state: 'TX', lat: 29.7604, lng: -95.3698, region: 'Texas' },
    { city: 'San Antonio', state: 'TX', lat: 29.4241, lng: -98.4936, region: 'Texas' },
    { city: 'Tampa', state: 'FL', lat: 27.9506, lng: -82.4572, region: 'Florida' },
    { city: 'Orlando', state: 'FL', lat: 28.5383, lng: -81.3792, region: 'Florida' },
    { city: 'Jacksonville', state: 'FL', lat: 30.3322, lng: -81.6557, region: 'Florida' },
    { city: 'Nashville', state: 'TN', lat: 36.1627, lng: -86.7816, region: 'Southeast' },
    { city: 'Raleigh', state: 'NC', lat: 35.7796, lng: -78.6382, region: 'Southeast' },
    { city: 'Charleston', state: 'SC', lat: 32.7765, lng: -79.9311, region: 'Southeast' },
    { city: 'Denver', state: 'CO', lat: 39.7392, lng: -104.9903, region: 'Mountain' },
    { city: 'Las Vegas', state: 'NV', lat: 36.1699, lng: -115.1398, region: 'Southwest' },
    { city: 'Albuquerque', state: 'NM', lat: 35.0844, lng: -106.6504, region: 'Southwest' },
    { city: 'Los Angeles', state: 'CA', lat: 34.0522, lng: -118.2437, region: 'West' },
    { city: 'Sacramento', state: 'CA', lat: 38.5816, lng: -121.4944, region: 'West' },
    { city: 'Seattle', state: 'WA', lat: 47.6062, lng: -122.3321, region: 'West' },
    { city: 'Columbus', state: 'OH', lat: 39.9612, lng: -82.9988, region: 'Midwest' },
    { city: 'Kansas City', state: 'MO', lat: 39.0997, lng: -94.5786, region: 'Midwest' },
    { city: 'Philadelphia', state: 'PA', lat: 39.9526, lng: -75.1652, region: 'Northeast' },
    { city: 'Pittsburgh', state: 'PA', lat: 40.4406, lng: -79.9959, region: 'Northeast' }
];

const telemetry = {
    http_attempts: 0,
    successful_http_responses: 0,
    failed_http_responses: 0,
    search_http_attempts: 0,
    lookup_http_attempts: 0,
    retry_attempts: 0,
    status_counts: {},
    budget_exhausted: false
};

function cliValue(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.find(value => value.startsWith(prefix));
    return match ? match.slice(prefix.length) : fallback;
}

function cliBoolean(name, fallback = false) {
    const value = cliValue(name);
    if (value === null) return fallback;
    return ['1', 'true', 'yes'].includes(String(value).toLowerCase());
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
    const timestamp = Date.parse(`${dateOnly}T12:00:00.000Z`) - (days * 86400000);
    return new Date(timestamp).toISOString().slice(0, 10);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function squarePolygon({ lat, lng }, halfSizeMiles = HALF_SIZE_MILES) {
    const latDelta = halfSizeMiles / 69;
    const lngDelta = halfSizeMiles / (69 * Math.cos(lat * Math.PI / 180));
    return [
        { latitude: Number((lat + latDelta).toFixed(6)), longitude: Number((lng - lngDelta).toFixed(6)) },
        { latitude: Number((lat + latDelta).toFixed(6)), longitude: Number((lng + lngDelta).toFixed(6)) },
        { latitude: Number((lat - latDelta).toFixed(6)), longitude: Number((lng + lngDelta).toFixed(6)) },
        { latitude: Number((lat - latDelta).toFixed(6)), longitude: Number((lng - lngDelta).toFixed(6)) },
        { latitude: Number((lat + latDelta).toFixed(6)), longitude: Number((lng - lngDelta).toFixed(6)) }
    ];
}

function safeError(value) {
    const text = String(value || 'unknown_error')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
        .replace(/(?:bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{12,})?/gi, '[credential]')
        .replace(/\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:st(?:reet)?|ave(?:nue)?|rd|road|dr(?:ive)?|ln|lane|blvd|boulevard|ct|court|way|pkwy|parkway)\b/gi, '[street_address]')
        .slice(0, 300);
    return text;
}

async function postJson(url, body, endpointType) {
    let lastResult = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
        if (telemetry.http_attempts >= LIVE_HTTP_BUDGET) {
            telemetry.budget_exhausted = true;
            return {
                ok: false,
                status: 0,
                payload: {},
                error: 'local_http_budget_exhausted',
                elapsed_ms: 0,
                attempts: 0
            };
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const started = Date.now();
        telemetry.http_attempts++;
        telemetry[`${endpointType}_http_attempts`]++;
        if (attempt > 1) {
            telemetry.retry_attempts++;
            await sleep(Math.min(5000, 500 * (2 ** (attempt - 2))));
        }
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            const text = await response.text();
            let payload = {};
            try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
            telemetry.status_counts[response.status] = (telemetry.status_counts[response.status] || 0) + 1;
            if (response.ok) telemetry.successful_http_responses++;
            else telemetry.failed_http_responses++;
            lastResult = {
                ok: response.ok,
                status: response.status,
                payload,
                // Persist only the HTTP code. Provider error bodies can echo lookup addresses.
                error: response.ok ? null : `http_${response.status}`,
                elapsed_ms: Date.now() - started,
                attempts: attempt
            };
            if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 4) return lastResult;
        } catch (error) {
            lastResult = {
                ok: false,
                status: error?.name === 'AbortError' ? 408 : 0,
                payload: {},
                error: error?.name === 'AbortError' ? 'request_timeout' : safeError(error?.message || error),
                elapsed_ms: Date.now() - started,
                attempts: attempt
            };
            if (attempt === 4) return lastResult;
        } finally {
            clearTimeout(timeout);
        }
    }
    return lastResult;
}

function dateFilterObject(predicate, minDate, maxDate = null) {
    const range = { minDate };
    if (maxDate) range.maxDate = maxDate;
    return predicate === 'intel'
        ? { intel: { lastSoldDate: range } }
        : { sale: { lastSaleDate: range } };
}

function searchPayload(city, predicate = null, minDate = null, take = 0, maxDate = null, expandedDatasets = false, geographyMode = 'polygon') {
    const searchCriteria = geographyMode === 'city_state'
        ? { address: { city: { equals: city.city }, state: { equals: city.state } } }
        : { address: { geoLocationPolygon: { geoPoints: squarePolygon(city) } } };
    if (predicate && minDate) Object.assign(searchCriteria, dateFilterObject(predicate, minDate, maxDate));
    return {
        searchCriteria,
        options: {
            take,
            skip: 0,
            datasets: expandedDatasets ? ['core', 'listing', 'owner', 'deed', 'valuation'] : ['basic']
        }
    };
}

function lookupPayload(address) {
    return {
        requests: [{ address, requestId: 'freshness-matrix-lookup' }],
        options: { datasets: ['core', 'listing', 'owner', 'deed', 'valuation'] }
    };
}

function extractTotal(payload) {
    const raw = payload?.results?.meta?.results?.resultsFound ??
        payload?.results?.totalRecordCount ??
        payload?.totalRecordCount ??
        payload?.meta?.totalRecordCount ??
        payload?.meta?.resultsFound;
    if (raw === null || raw === undefined || raw === '') return null;
    const count = Number(raw);
    return Number.isFinite(count) ? count : null;
}

function extractRecords(payload) {
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

function recordProperty(record) {
    return record?.property || record?.result?.property || record?.results?.property || record?.data?.property || record || {};
}

function normalizedAddress(record) {
    const property = recordProperty(record);
    const address = property.address || property.propertyAddress || property.situsAddress || {};
    const street = address.street || address.streetAddress || address.addressLine1 || property.addressLine1 || '';
    const city = address.city || property.city || '';
    const state = address.state || property.state || '';
    const zip = String(address.zip || address.zipCode || property.zipCode || '').slice(0, 5);
    return { street, city, state, zip };
}

function recordKey(record) {
    const property = recordProperty(record);
    const ids = property.ids || property.identifiers || {};
    const id = ids.propertyId || ids.id || property.propertyId || property.id;
    if (id) return `id:${String(id)}`;
    const address = normalizedAddress(record);
    const normalized = `${address.street}|${address.city}|${address.state}|${address.zip}`.toLowerCase().replace(/\s+/g, ' ').trim();
    return `address:${createHash('sha256').update(normalized).digest('hex')}`;
}

function hasValue(value) {
    return value !== undefined && value !== null && value !== '';
}

function fieldVector(record) {
    const property = recordProperty(record);
    const evidence = selectRecentSaleEvidence(property);
    return {
        intel_last_sold_date: property.intel?.lastSoldDate ?? null,
        intel_last_sold_price: property.intel?.lastSoldPrice ?? null,
        standardized_land_use: property.general?.standardizedLandUseCode ?? property.standardizedLandUseCode ?? null,
        property_type_detail: property.general?.propertyTypeDetail ?? property.general?.propertyType ?? property.propertyType ?? property.landUse ?? null,
        building_bedrooms: property.building?.bedroomCount ?? property.structure?.bedroomCount ?? null,
        building_bathrooms: property.building?.bathroomCount ?? property.structure?.bathroomCount ?? null,
        owner_occupied: property.owner?.ownerOccupied ?? null,
        deed_history: Array.isArray(property.deedHistory) && property.deedHistory.length > 0 ? property.deedHistory.length : null,
        best_sale_date: evidence.saleDate,
        best_sale_date_confidence: evidence.saleDateConfidence,
        quick_list_recently_sold: property.quickLists?.recentlySold ?? null
    };
}

function fieldPopulationCount(record) {
    return Object.values(fieldVector(record)).filter(hasValue).length;
}

function dateHistogram(records) {
    const result = {};
    for (const record of records) {
        const date = selectRecentSaleEvidence(recordProperty(record)).saleDate;
        if (date) result[date] = (result[date] || 0) + 1;
    }
    return result;
}

function sampleFieldSummary(records, yesterday, minDate, maxDate) {
    const summary = {
        records: records.length,
        intel_lastSoldDate_present: 0,
        explicit_type_present: 0,
        deed_history_present: 0,
        best_sale_date_present: 0,
        best_sale_date_within_requested_window: 0,
        best_sale_date_outside_requested_window: 0,
        exact_yesterday_evidence: 0,
        quickLists_recentlySold_true: 0,
        best_date_histogram: dateHistogram(records)
    };
    for (const record of records) {
        const fields = fieldVector(record);
        if (hasValue(fields.intel_last_sold_date)) summary.intel_lastSoldDate_present++;
        if (hasValue(fields.standardized_land_use) || hasValue(fields.property_type_detail)) summary.explicit_type_present++;
        if (hasValue(fields.deed_history)) summary.deed_history_present++;
        if (hasValue(fields.best_sale_date)) summary.best_sale_date_present++;
        if (hasValue(fields.best_sale_date)) {
            if (fields.best_sale_date >= minDate && fields.best_sale_date <= maxDate) {
                summary.best_sale_date_within_requested_window++;
            } else {
                summary.best_sale_date_outside_requested_window++;
            }
        }
        if (fields.best_sale_date === yesterday) summary.exact_yesterday_evidence++;
        if (fields.quick_list_recently_sold === true) summary.quickLists_recentlySold_true++;
    }
    return summary;
}

function monotonic(values) {
    return values.every((value, index) => index === 0 || value >= values[index - 1]);
}

function chooseLookupCandidates(intelRecords, saleRecords) {
    const union = new Map();
    for (const [source, records] of [['intel', intelRecords], ['sale', saleRecords]]) {
        for (const record of records) {
            const key = recordKey(record);
            const current = union.get(key) || { key, record, sources: new Set() };
            current.sources.add(source);
            union.set(key, current);
        }
    }
    const entries = [...union.values()];
    const ranked = [
        ...entries.filter(entry => entry.sources.size === 2),
        ...entries.filter(entry => entry.sources.size === 1 && entry.sources.has('sale')),
        ...entries.filter(entry => entry.sources.size === 1 && entry.sources.has('intel'))
    ];
    return ranked.slice(0, LOOKUPS_PER_CITY);
}

function overlapSummary(intelRecords, saleRecords) {
    const intelKeys = new Set(intelRecords.map(recordKey));
    const saleKeys = new Set(saleRecords.map(recordKey));
    const overlap = [...intelKeys].filter(key => saleKeys.has(key)).length;
    return {
        intel_sample_records: intelKeys.size,
        sale_sample_records: saleKeys.size,
        overlap,
        intel_only: intelKeys.size - overlap,
        sale_only: saleKeys.size - overlap
    };
}

async function main() {
    if (!Number.isInteger(LIVE_HTTP_BUDGET) || LIVE_HTTP_BUDGET < 1 || LIVE_HTTP_BUDGET > 2000) {
        throw new Error('--budget must be an integer between 1 and 2000');
    }
    const asOfDate = cliValue('as-of', phoenixDate());
    const yesterday = daysBefore(asOfDate, 1);
    const outputPath = cliValue('output');
    const geographyMode = cliValue('geography', 'polygon');
    const countsOnly = cliBoolean('counts-only', false);
    const cityFilter = String(cliValue('city-filter', '') || '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
    const selectedCities = cityFilter.length > 0
        ? CITIES.filter(city => cityFilter.includes(city.city.toLowerCase()))
        : CITIES;
    if (!['polygon', 'city_state'].includes(geographyMode)) throw new Error(`Unsupported geography mode: ${geographyMode}`);
    if (selectedCities.length === 0) throw new Error('city-filter did not match any configured city');
    const windows = [1, 2, 7, 14].map(days => ({
        label: `${days}d`,
        days,
        min_date: daysBefore(asOfDate, days)
    }));
    if (!LIVE_CONFIRMED) {
        const noRetryCountAttempts = 2 + (selectedCities.length * 9);
        const noRetrySampleAndLookupAttempts = countsOnly ? 0 : (selectedCities.length * 4) + 1;
        process.stdout.write(`${JSON.stringify({
            mode: 'plan_only_no_network',
            network_requests_made: 0,
            as_of_date: asOfDate,
            yesterday_date: yesterday,
            geography_mode: geographyMode,
            city_count: selectedCities.length,
            cities: selectedCities.map(city => `${city.city}, ${city.state}`),
            windows_days: windows.map(window => window.days),
            predicates: ['searchCriteria.intel.lastSoldDate', 'searchCriteria.sale.lastSaleDate'],
            counts_only: countsOnly,
            live_http_budget: LIVE_HTTP_BUDGET,
            planned_no_retry_attempt_ceiling: noRetryCountAttempts + noRetrySampleAndLookupAttempts,
            retry_policy: 'up to four attempts for transient 429/5xx responses, always bounded by live_http_budget',
            privacy: {
                property_addresses_persisted: false,
                property_ids_or_hashes_persisted: false,
                raw_provider_payloads_persisted: false,
                provider_error_bodies_persisted: false
            },
            billing_warning: 'The HTTP ceiling is a safety bound, not a provider credit estimate. Confirm exact charges in BatchData.',
            execute: 'Re-run with --confirm-live after reviewing this plan.'
        }, null, 2)}\n`);
        console.error('PLAN ONLY: no BatchData request was made. Re-run with --confirm-live to execute.');
        return;
    }
    if (!API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured in .env');
    const startedAt = new Date().toISOString();

    console.error(`Preflighting exact-through-yesterday range support for ${yesterday}...`);
    const preflightCity = selectedCities.find(city => city.city === 'Phoenix') || selectedCities[0];
    const [intelRangeProbe, saleRangeProbe] = await Promise.all([
        postJson(SEARCH_URL, searchPayload(preflightCity, 'intel', yesterday, 0, yesterday, false, geographyMode), 'search'),
        postJson(SEARCH_URL, searchPayload(preflightCity, 'sale', yesterday, 0, yesterday, false, geographyMode), 'search')
    ]);
    const maxDateSupported = intelRangeProbe.ok && saleRangeProbe.ok;
    const rangeMaxDate = maxDateSupported ? yesterday : null;

    const cityResults = [];
    for (let cityIndex = 0; cityIndex < selectedCities.length; cityIndex++) {
        const city = selectedCities[cityIndex];
        console.error(`[${cityIndex + 1}/${selectedCities.length}] Counting ${city.city}, ${city.state}`);
        const noDateResponse = await postJson(SEARCH_URL, searchPayload(city, null, null, 0, null, false, geographyMode), 'search');
        const result = {
            city: city.city,
            state: city.state,
            region: city.region,
            center: { lat: city.lat, lng: city.lng },
            polygon: geographyMode === 'polygon' ? squarePolygon(city) : null,
            nominal_area_sq_mi: geographyMode === 'polygon' ? (HALF_SIZE_MILES * 2) ** 2 : null,
            no_date_candidate_count: noDateResponse.ok ? extractTotal(noDateResponse.payload) : null,
            no_date_status: noDateResponse.status,
            windows: {},
            freshest_nonzero_window: null,
            sample_cross_reference: null,
            lookup_cross_reference: null
        };

        for (const window of windows) {
            const [intelResponse, saleResponse] = await Promise.all([
                postJson(SEARCH_URL, searchPayload(city, 'intel', window.min_date, 0, rangeMaxDate, false, geographyMode), 'search'),
                postJson(SEARCH_URL, searchPayload(city, 'sale', window.min_date, 0, rangeMaxDate, false, geographyMode), 'search')
            ]);
            const intelCount = intelResponse.ok ? extractTotal(intelResponse.payload) : null;
            const saleCount = saleResponse.ok ? extractTotal(saleResponse.payload) : null;
            result.windows[window.label] = {
                min_date: window.min_date,
                max_date: rangeMaxDate,
                intel_count: intelCount,
                sale_count: saleCount,
                sale_minus_intel: Number.isFinite(intelCount) && Number.isFinite(saleCount) ? saleCount - intelCount : null,
                intel_status: intelResponse.status,
                sale_status: saleResponse.status,
                intel_elapsed_ms: intelResponse.elapsed_ms,
                sale_elapsed_ms: saleResponse.elapsed_ms,
                intel_error: intelResponse.ok ? null : intelResponse.error,
                sale_error: saleResponse.ok ? null : saleResponse.error
            };
            await sleep(PAIR_DELAY_MS);
        }

        const freshest = windows.find(window => {
            const counts = result.windows[window.label];
            return Number(counts?.intel_count) > 0 || Number(counts?.sale_count) > 0;
        });
        result.freshest_nonzero_window = freshest?.label || null;
        cityResults.push(result);
    }

    let legacyLookupContract = { tested: false, status: null, ok: false, error: null };
    for (let cityIndex = 0; !countsOnly && cityIndex < cityResults.length; cityIndex++) {
        const cityResult = cityResults[cityIndex];
        const city = selectedCities[cityIndex];
        const window = windows.find(item => item.label === cityResult.freshest_nonzero_window);
        if (!window) continue;
        console.error(`[${cityIndex + 1}/${cityResults.length}] Sampling and looking up ${city.city}, ${city.state} (${window.label})`);

        const intelCount = cityResult.windows[window.label].intel_count || 0;
        const saleCount = cityResult.windows[window.label].sale_count || 0;
        const intelResponse = intelCount > 0
            ? await postJson(SEARCH_URL, searchPayload(city, 'intel', window.min_date, SAMPLE_TAKE, rangeMaxDate, true, geographyMode), 'search')
            : null;
        const saleResponse = saleCount > 0
            ? await postJson(SEARCH_URL, searchPayload(city, 'sale', window.min_date, SAMPLE_TAKE, rangeMaxDate, true, geographyMode), 'search')
            : null;
        const intelRecords = intelResponse?.ok ? extractRecords(intelResponse.payload) : [];
        const saleRecords = saleResponse?.ok ? extractRecords(saleResponse.payload) : [];

        cityResult.sample_cross_reference = {
            window: window.label,
            ...overlapSummary(intelRecords, saleRecords),
            intel_fields: sampleFieldSummary(intelRecords, yesterday, window.min_date, rangeMaxDate),
            sale_fields: sampleFieldSummary(saleRecords, yesterday, window.min_date, rangeMaxDate),
            intel_status: intelResponse?.status ?? null,
            sale_status: saleResponse?.status ?? null
        };

        const candidates = chooseLookupCandidates(intelRecords, saleRecords);
        const lookupSummary = {
            requested: 0,
            successful_http: 0,
            extractable_rows: 0,
            increased_monitored_population: 0,
            intel_lastSoldDate_present: 0,
            explicit_type_present: 0,
            deed_history_present: 0,
            best_sale_date_present: 0,
            best_sale_date_within_requested_window: 0,
            best_sale_date_outside_requested_window: 0,
            exact_yesterday_evidence: 0,
            best_date_histogram: {},
            source_categories: {}
        };

        for (const candidate of candidates) {
            const address = normalizedAddress(candidate.record);
            if (!address.street || !address.city || !address.state) continue;
            const category = candidate.sources.size === 2 ? 'both' : [...candidate.sources][0];
            lookupSummary.source_categories[category] = (lookupSummary.source_categories[category] || 0) + 1;
            const payload = lookupPayload(address);
            if (!legacyLookupContract.tested) {
                const legacy = await postJson(LEGACY_LOOKUP_URL, payload, 'lookup');
                legacyLookupContract = {
                    tested: true,
                    status: legacy.status,
                    ok: legacy.ok,
                    error: legacy.ok ? null : legacy.error
                };
            }
            lookupSummary.requested++;
            const lookupResponse = await postJson(LOOKUP_URL, payload, 'lookup');
            if (lookupResponse.ok) lookupSummary.successful_http++;
            const records = lookupResponse.ok ? extractRecords(lookupResponse.payload) : [];
            const lookupRecord = records[0] || null;
            if (!lookupRecord) continue;
            lookupSummary.extractable_rows++;
            const searchPopulation = fieldPopulationCount(candidate.record);
            const lookupPopulation = fieldPopulationCount(lookupRecord);
            if (lookupPopulation > searchPopulation) lookupSummary.increased_monitored_population++;
            const fields = fieldVector(lookupRecord);
            if (hasValue(fields.intel_last_sold_date)) lookupSummary.intel_lastSoldDate_present++;
            if (hasValue(fields.standardized_land_use) || hasValue(fields.property_type_detail)) lookupSummary.explicit_type_present++;
            if (hasValue(fields.deed_history)) lookupSummary.deed_history_present++;
            if (hasValue(fields.best_sale_date)) {
                lookupSummary.best_sale_date_present++;
                lookupSummary.best_date_histogram[fields.best_sale_date] = (lookupSummary.best_date_histogram[fields.best_sale_date] || 0) + 1;
                if (fields.best_sale_date >= window.min_date && fields.best_sale_date <= rangeMaxDate) {
                    lookupSummary.best_sale_date_within_requested_window++;
                } else {
                    lookupSummary.best_sale_date_outside_requested_window++;
                }
            }
            if (fields.best_sale_date === yesterday) lookupSummary.exact_yesterday_evidence++;
            await sleep(PAIR_DELAY_MS);
        }
        cityResult.lookup_cross_reference = lookupSummary;
    }

    const aggregateWindows = {};
    for (const window of windows) {
        const rows = cityResults.map(result => result.windows[window.label]);
        const intelCounts = rows.map(row => row.intel_count);
        const saleCounts = rows.map(row => row.sale_count);
        const allIntelCountsValid = intelCounts.every(Number.isFinite);
        const allSaleCountsValid = saleCounts.every(Number.isFinite);
        aggregateWindows[window.label] = {
            min_date: window.min_date,
            max_date: rangeMaxDate,
            intel_total: allIntelCountsValid ? intelCounts.reduce((sum, count) => sum + count, 0) : null,
            sale_total: allSaleCountsValid ? saleCounts.reduce((sum, count) => sum + count, 0) : null,
            intel_cities_nonzero: rows.filter(row => Number(row.intel_count) > 0).length,
            sale_cities_nonzero: rows.filter(row => Number(row.sale_count) > 0).length,
            equal_count_cities: rows.filter(row => row.intel_count !== null && row.intel_count === row.sale_count).length,
            intel_higher_cities: rows.filter(row => Number.isFinite(row.intel_count) && Number.isFinite(row.sale_count) && row.intel_count > row.sale_count).length,
            sale_higher_cities: rows.filter(row => Number.isFinite(row.intel_count) && Number.isFinite(row.sale_count) && row.sale_count > row.intel_count).length,
            failed_intel_calls: rows.filter(row => row.intel_status !== 200).length,
            failed_sale_calls: rows.filter(row => row.sale_status !== 200).length
        };
    }

    const monotonicityViolations = [];
    for (const city of cityResults) {
        const intelValues = windows.map(window => city.windows[window.label].intel_count);
        const saleValues = windows.map(window => city.windows[window.label].sale_count);
        if (intelValues.every(Number.isFinite) && !monotonic(intelValues)) monotonicityViolations.push(`${city.city}, ${city.state}:intel`);
        if (saleValues.every(Number.isFinite) && !monotonic(saleValues)) monotonicityViolations.push(`${city.city}, ${city.state}:sale`);
    }

    const lookupTotals = cityResults.reduce((totals, city) => {
        const lookup = city.lookup_cross_reference;
        if (!lookup) return totals;
        for (const key of ['requested', 'successful_http', 'extractable_rows', 'increased_monitored_population', 'intel_lastSoldDate_present', 'explicit_type_present', 'deed_history_present', 'best_sale_date_present', 'best_sale_date_within_requested_window', 'best_sale_date_outside_requested_window', 'exact_yesterday_evidence']) {
            totals[key] += Number(lookup[key]) || 0;
        }
        return totals;
    }, {
        requested: 0,
        successful_http: 0,
        extractable_rows: 0,
        increased_monitored_population: 0,
        intel_lastSoldDate_present: 0,
        explicit_type_present: 0,
        deed_history_present: 0,
        best_sale_date_present: 0,
        best_sale_date_within_requested_window: 0,
        best_sale_date_outside_requested_window: 0,
        exact_yesterday_evidence: 0
    });

    const output = {
        schema_version: 2,
        test_name: 'BatchData 25-city recent-sale freshness matrix',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        as_of_date: asOfDate,
        yesterday_date: yesterday,
        timezone: 'America/Phoenix',
        credentials_included: false,
        property_addresses_persisted: false,
        property_ids_or_hashes_persisted: false,
        raw_provider_payloads_persisted: false,
        provider_error_bodies_persisted: false,
        city_count: selectedCities.length,
        city_filter: cityFilter,
        geography_mode: geographyMode,
        counts_only: countsOnly,
        polygon_method: geographyMode === 'polygon'
            ? `Equal nominal ${(HALF_SIZE_MILES * 2).toFixed(0)}mi x ${(HALF_SIZE_MILES * 2).toFixed(0)}mi center square (${(HALF_SIZE_MILES * 2) ** 2} sq mi)`
            : null,
        predicates: {
            intel: 'searchCriteria.intel.lastSoldDate',
            sale: 'searchCriteria.sale.lastSaleDate'
        },
        predicate_relationship: 'intel and sale are alternative filters on the same property/search endpoint',
        date_range_contract: {
            exact_through_yesterday_requested: true,
            maxDate_accepted_http_200_by_both_predicates: maxDateSupported,
            maxDate_enforcement_verified_from_returned_fields: false,
            applied_max_date: rangeMaxDate,
            intel_preflight_status: intelRangeProbe.status,
            sale_preflight_status: saleRangeProbe.status
        },
        endpoints: {
            search: SEARCH_URL,
            lookup_all_attributes: LOOKUP_URL,
            lookup_legacy_contract: legacyLookupContract
        },
        lookup_metric_definitions: {
            extractable_rows: 'HTTP-successful lookup responses from which the runner extracted a first row; record identity is not independently verified.',
            increased_monitored_population: 'Lookup rows whose populated-value count exceeded Search in an 11-field monitored vector; this is not a full field-by-field payload diff.'
        },
        billing: {
            status: 'unverified_confirm_in_batchdata_dashboard',
            note: 'HTTP request and returned-record counts are reported; provider credit charges are not inferred.'
        },
        telemetry,
        summary: {
            windows: aggregateWindows,
            cities_with_either_predicate_nonzero_yesterday: cityResults.filter(city => (
                Number(city.windows['1d'].intel_count) > 0 || Number(city.windows['1d'].sale_count) > 0
            )).map(city => `${city.city}, ${city.state}`),
            cities_with_both_predicates_zero_through_14d: cityResults.filter(city => (
                Number(city.windows['14d'].intel_count) === 0 && Number(city.windows['14d'].sale_count) === 0
            )).map(city => `${city.city}, ${city.state}`),
            monotonicity_violations: monotonicityViolations,
            lookup: lookupTotals
        },
        cities: cityResults,
        limitations: [
            geographyMode === 'polygon'
                ? 'Counts measure provider-side candidates inside equal center-city polygons, not external MLS/deed penetration.'
                : 'Counts use BatchData city/state matching; municipal normalization and boundary semantics are provider-defined.',
            'Search sample overlap is capped at five records per predicate per city and is not a full-universe address join.',
            'Count requests use options.datasets=[basic]; field-audit samples request valid rich datasets under options and may return dataset_not_allowed when the token lacks entitlement.',
            'Lookup sampling is capped at two union records per city.',
            'Both predicates accepted maxDate with HTTP 200, but sparse returned date fields prevent independent proof that the upper bound was enforced for every hidden provider date.',
            'Persisted request failures contain status codes only; provider error bodies are intentionally discarded.',
            'No property addresses or raw provider payloads are persisted in this artifact.'
        ]
    };

    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    if (outputPath) {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, serialized, 'utf8');
        console.error(`Wrote sanitized results to ${outputPath}`);
    } else {
        process.stdout.write(serialized);
    }
}

main().catch(error => {
    console.error(`Freshness matrix failed: ${safeError(error?.stack || error?.message || error)}`);
    process.exitCode = 1;
});
