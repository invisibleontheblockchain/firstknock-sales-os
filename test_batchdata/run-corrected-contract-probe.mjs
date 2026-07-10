import { config as loadEnv } from 'dotenv';
import { selectRecentSaleEvidence } from '../base44/functions/processFetchChunk/recentSaleLogic.js';

loadEnv({ path: '.env', quiet: true });

const API_KEY = process.env.BATCH_DATA_API_KEY;
const SEARCH_URL = 'https://api.batchdata.com/api/v1/property/search';
const LOOKUP_URL = 'https://api.batchdata.com/api/v1/property/lookup/all-attributes';
const AS_OF_DATE = '2026-07-09';
const YESTERDAY = '2026-07-08';
const FOURTEEN_DAY_MIN = '2026-06-25';
const REQUEST_TIMEOUT_MS = 25_000;
const DELAY_MS = 200;
const DEFAULT_LIVE_HTTP_BUDGET = 40;
const MIN_HOME_VALUE = 100_000;
const HALF_SIZE_MILES = 2.5;

function cliValue(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.find(value => value.startsWith(prefix));
    return match ? match.slice(prefix.length) : fallback;
}

const LIVE_CONFIRMED = process.argv.includes('--confirm-live');
const LIVE_HTTP_BUDGET = Number(cliValue('budget', DEFAULT_LIVE_HTTP_BUDGET));

const CITIES = [
    { city: 'Phoenix', state: 'AZ', lat: 33.4484, lng: -112.0740, region: 'Southwest' },
    { city: 'Charlotte', state: 'NC', lat: 35.2271, lng: -80.8431, region: 'Southeast' },
    { city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.7970, region: 'Texas' },
    { city: 'Seattle', state: 'WA', lat: 47.6062, lng: -122.3321, region: 'West' }
];

const telemetry = {
    http_attempts: 0,
    search_take_0_attempts: 0,
    search_take_1_attempts: 0,
    lookup_attempts: 0,
    status_counts: {}
};

function squarePolygon({ lat, lng }) {
    const latDelta = HALF_SIZE_MILES / 69;
    const lngDelta = HALF_SIZE_MILES / (69 * Math.cos(lat * Math.PI / 180));
    return [
        { latitude: Number((lat + latDelta).toFixed(6)), longitude: Number((lng - lngDelta).toFixed(6)) },
        { latitude: Number((lat + latDelta).toFixed(6)), longitude: Number((lng + lngDelta).toFixed(6)) },
        { latitude: Number((lat - latDelta).toFixed(6)), longitude: Number((lng + lngDelta).toFixed(6)) },
        { latitude: Number((lat - latDelta).toFixed(6)), longitude: Number((lng - lngDelta).toFixed(6)) },
        { latitude: Number((lat + latDelta).toFixed(6)), longitude: Number((lng - lngDelta).toFixed(6)) }
    ];
}

function scrub(value) {
    return String(value || '')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
        .replace(/\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:st(?:reet)?|ave(?:nue)?|rd|road|dr(?:ive)?|ln|lane|blvd|boulevard|ct|court|way|pkwy|parkway)\b/gi, '[street_address]')
        .replace(/\b\d{5}(?:-\d{4})?\b/g, '[zip]')
        .slice(0, 300);
}

function safeKeys(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value).sort()
        : [];
}

function safeProviderCode(value, fallback = '') {
    return String(value || fallback)
        .replace(/[^A-Za-z0-9_.-]/g, '_')
        .slice(0, 80);
}

function warningSummary(payload) {
    const candidates = [
        payload?.warnings,
        payload?.results?.warnings,
        payload?.meta?.warnings,
        payload?.results?.meta?.warnings
    ];
    const warnings = candidates.find(Array.isArray) || [];
    // Persist only a constrained machine code. Provider warning text can echo
    // a submitted lookup address and is intentionally discarded.
    return warnings.slice(0, 10).map(warning => ({
        code: safeProviderCode(warning?.code || warning?.type, 'provider_warning')
    }));
}

async function postJson(url, body, kind) {
    if (telemetry.http_attempts >= LIVE_HTTP_BUDGET) {
        throw new Error(`Probe HTTP ceiling of ${LIVE_HTTP_BUDGET} reached`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    telemetry.http_attempts++;
    telemetry[`${kind}_attempts`]++;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${API_KEY}`
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
        telemetry.status_counts[response.status] = (telemetry.status_counts[response.status] || 0) + 1;
        return {
            ok: response.ok,
            status: response.status,
            payload,
            provider_error_code: response.ok ? null : safeProviderCode(payload?.code || payload?.error?.code, `http_${response.status}`),
            // Never persist a provider error body; it can echo the request address.
            provider_error_message: response.ok ? null : `http_${response.status}`,
            warnings: warningSummary(payload),
            top_level_keys: safeKeys(payload),
            results_keys: safeKeys(payload?.results)
        };
    } catch (error) {
        return {
            ok: false,
            status: error?.name === 'AbortError' ? 408 : 0,
            payload: {},
            provider_error_code: error?.name === 'AbortError' ? 'request_timeout' : 'network_error',
            provider_error_message: scrub(error?.message || error),
            warnings: [],
            top_level_keys: [],
            results_keys: []
        };
    } finally {
        clearTimeout(timeout);
    }
}

function addPredicate(searchCriteria, predicate, minDate, maxDate) {
    const range = { minDate, maxDate };
    if (predicate === 'intel') searchCriteria.intel = { lastSoldDate: range };
    else searchCriteria.sale = { lastSaleDate: range };
}

function addFilters(searchCriteria, filters) {
    if (filters.r2) {
        searchCriteria.general = {
            ...(searchCriteria.general || {}),
            standardizedLandUseCode: { equals: 'R2' }
        };
    }
    if (filters.valuation) {
        searchCriteria.valuation = { estimatedValue: { min: MIN_HOME_VALUE } };
    }
    if (filters.listing) {
        searchCriteria.listing = { statusCategory: { notInList: ['Active', 'Pending'] } };
    }
}

function searchPayload(city, {
    predicate,
    minDate,
    maxDate = YESTERDAY,
    take = 0,
    filters = {},
    datasets = ['basic']
}) {
    const searchCriteria = {
        address: { geoLocationPolygon: { geoPoints: squarePolygon(city) } }
    };
    addPredicate(searchCriteria, predicate, minDate, maxDate);
    addFilters(searchCriteria, filters);
    return {
        searchCriteria,
        options: {
            take,
            skip: 0,
            datasets
        }
    };
}

function extractTotal(payload) {
    const value = payload?.results?.meta?.results?.resultsFound ??
        payload?.results?.totalRecordCount ??
        payload?.totalRecordCount ??
        payload?.meta?.totalRecordCount ??
        payload?.meta?.resultsFound;
    const count = Number(value);
    return Number.isFinite(count) ? count : null;
}

function extractRecords(payload) {
    const candidates = [
        payload?.results?.properties,
        payload?.results?.items,
        payload?.properties,
        payload?.items,
        payload?.data?.properties,
        payload?.data?.items,
        payload?.results
    ];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate.filter(Boolean);
    }
    return [];
}

function propertyFromRecord(record) {
    const candidates = [
        record?.property,
        record?.response?.property,
        record?.result?.property,
        record?.results?.property,
        record?.data?.property,
        record?.response,
        record?.result,
        record?.data,
        record
    ];
    return candidates.find(candidate => candidate && typeof candidate === 'object' && (
        candidate.address || candidate.general || candidate.ids || candidate.deedHistory || candidate.valuation
    )) || {};
}

function lookupRecords(payload) {
    const candidates = [
        payload?.results?.requests,
        payload?.results?.properties,
        payload?.results,
        payload?.requests,
        payload?.properties,
        payload?.data?.results,
        payload?.data
    ];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate.filter(Boolean);
    }
    const singleton = propertyFromRecord(payload);
    return Object.keys(singleton).length > 0 ? [payload] : [];
}

function addressFromProperty(property) {
    const address = property?.address || property?.propertyAddress || property?.situsAddress || {};
    return {
        street: address.street || address.streetAddress || address.addressLine1 || property?.addressLine1 || '',
        city: address.city || property?.city || '',
        state: address.state || property?.state || '',
        zip: String(address.zip || address.zipCode || property?.zipCode || '').slice(0, 5)
    };
}

function normalizeStreet(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\b(north|south|east|west)\b/g, match => ({ north: 'n', south: 's', east: 'e', west: 'w' })[match])
        .replace(/\b(street|avenue|road|drive|lane|boulevard|court|parkway)\b/g, match => ({
            street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', boulevard: 'blvd', court: 'ct', parkway: 'pkwy'
        })[match])
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function normalizeAddress(address) {
    return [
        normalizeStreet(address.street),
        String(address.city || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
        String(address.state || '').toLowerCase().trim(),
        String(address.zip || '').slice(0, 5)
    ].join('|');
}

function propertyId(property) {
    return property?.ids?.propertyId || property?.ids?.id || property?.propertyId || property?.id || null;
}

function identityCheck(searchProperty, lookupProperty) {
    const expectedId = propertyId(searchProperty);
    const actualId = propertyId(lookupProperty);
    if (expectedId && actualId) {
        return { method: 'property_id', match: String(expectedId) === String(actualId) };
    }
    const expectedAddress = normalizeAddress(addressFromProperty(searchProperty));
    const actualAddress = normalizeAddress(addressFromProperty(lookupProperty));
    const complete = expectedAddress.split('|').every(Boolean) && actualAddress.split('|').every(Boolean);
    return { method: complete ? 'normalized_address' : 'unverified', match: complete ? expectedAddress === actualAddress : null };
}

function firstPresent(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function fieldPresence(property) {
    const generalCode = firstPresent(property?.general?.standardizedLandUseCode, property?.standardizedLandUseCode);
    const estimatedValue = firstPresent(
        property?.valuation?.estimatedValue,
        property?.valuation?.estimatedValueAmount,
        property?.estimatedValue
    );
    const listingStatus = firstPresent(
        property?.listing?.statusCategory,
        property?.listing?.status,
        property?.listingStatusCategory
    );
    const deedHistory = Array.isArray(property?.deedHistory) ? property.deedHistory : [];
    const saleDate = firstPresent(
        property?.intel?.lastSoldDate,
        property?.sale?.lastSaleDate,
        deedHistory[0]?.saleDate,
        deedHistory[0]?.recordingDate
    );
    return {
        has_general_standardized_land_use_code: generalCode !== undefined,
        general_code_is_R2: generalCode === undefined ? null : String(generalCode).toUpperCase() === 'R2',
        has_property_type_detail: firstPresent(property?.general?.propertyTypeDetail, property?.propertyTypeDetail) !== undefined,
        has_estimated_value: estimatedValue !== undefined,
        estimated_value_at_least_100k: estimatedValue === undefined ? null : Number(estimatedValue) >= MIN_HOME_VALUE,
        has_listing_status: listingStatus !== undefined,
        listing_status_is_active_or_pending: listingStatus === undefined ? null : ['active', 'pending'].includes(String(listingStatus).toLowerCase()),
        deed_history_nonempty: deedHistory.length > 0,
        has_sale_date_evidence: saleDate !== undefined
    };
}

function searchResultSummary(response) {
    const records = response.ok ? extractRecords(response.payload) : [];
    const property = records.length > 0 ? propertyFromRecord(records[0]) : {};
    return {
        ok: response.ok,
        status: response.status,
        count: response.ok ? extractTotal(response.payload) : null,
        returned_records: records.length,
        field_presence: records.length > 0 ? fieldPresence(property) : null,
        warnings: response.warnings,
        provider_error_code: response.provider_error_code,
        provider_error_message: response.provider_error_message,
        shape: { top_level_keys: response.top_level_keys, results_keys: response.results_keys }
    };
}

async function count(city, predicate, minDate, filters = {}) {
    const response = await postJson(
        SEARCH_URL,
        searchPayload(city, { predicate, minDate, take: 0, filters, datasets: ['basic'] }),
        'search_take_0'
    );
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    return searchResultSummary(response);
}

async function runLookupOnlySupplement() {
    const allFilters = { r2: true, valuation: true, listing: true };
    const rows = [];

    for (let index = 0; index < CITIES.slice(0, 3).length; index++) {
        const city = CITIES[index];
        console.error(`Supplemental basic Search and Lookup for ${city.city}, ${city.state}`);
        const searchResponse = await postJson(
            SEARCH_URL,
            searchPayload(city, {
                predicate: 'intel',
                minDate: FOURTEEN_DAY_MIN,
                take: 1,
                filters: allFilters,
                datasets: ['basic']
            }),
            'search_take_1'
        );
        const searchRecords = searchResponse.ok ? extractRecords(searchResponse.payload) : [];
        const searchProperty = searchRecords.length > 0 ? propertyFromRecord(searchRecords[0]) : {};
        const address = addressFromProperty(searchProperty);
        const addressComplete = Boolean(address.street && address.city && address.state && address.zip);
        const row = {
            city: city.city,
            state: city.state,
            search: searchResultSummary(searchResponse),
            basic_lookup: null,
            rich_lookup_entitlement_check: null
        };
        if (!addressComplete) {
            row.basic_lookup = { skipped: 'search_result_missing_complete_structured_address' };
            rows.push(row);
            continue;
        }

        const requestId = `lookup-supplement-${index + 1}`;
        const basicLookupResponse = await postJson(LOOKUP_URL, {
            requests: [{ address, requestId }],
            options: { datasets: ['basic'] }
        }, 'lookup');
        const basicRows = basicLookupResponse.ok ? lookupRecords(basicLookupResponse.payload) : [];
        const basicProperty = basicRows.length > 0 ? propertyFromRecord(basicRows[0]) : {};
        row.basic_lookup = {
            ok: basicLookupResponse.ok,
            status: basicLookupResponse.status,
            extractable_rows: basicRows.length,
            identity: basicRows.length > 0
                ? identityCheck(searchProperty, basicProperty)
                : { method: 'unverified', match: null },
            request_id_echoed: basicRows.some(item => (
                item?.requestId === requestId ||
                item?.response?.requestId === requestId ||
                item?.result?.requestId === requestId
            )),
            field_presence: basicRows.length > 0 ? fieldPresence(basicProperty) : null,
            warnings: basicLookupResponse.warnings,
            provider_error_code: basicLookupResponse.provider_error_code,
            provider_error_message: basicLookupResponse.provider_error_message,
            shape: { top_level_keys: basicLookupResponse.top_level_keys, results_keys: basicLookupResponse.results_keys }
        };

        if (index === 0) {
            const richLookupResponse = await postJson(LOOKUP_URL, {
                requests: [{ address, requestId: `${requestId}-rich` }],
                options: { datasets: ['core', 'listing', 'deed', 'valuation'] }
            }, 'lookup');
            const richRows = richLookupResponse.ok ? lookupRecords(richLookupResponse.payload) : [];
            row.rich_lookup_entitlement_check = {
                ok: richLookupResponse.ok,
                status: richLookupResponse.status,
                extractable_rows: richRows.length,
                warnings: richLookupResponse.warnings,
                provider_error_code: richLookupResponse.provider_error_code,
                provider_error_message: richLookupResponse.provider_error_message,
                shape: { top_level_keys: richLookupResponse.top_level_keys, results_keys: richLookupResponse.results_keys }
            };
        }
        rows.push(row);
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }

    return {
        schema_version: 1,
        test_name: 'BatchData corrected Lookup contract supplemental probe',
        completed_at: new Date().toISOString(),
        credentials_included: false,
        property_addresses_persisted: false,
        property_ids_or_hashes_persisted: false,
        raw_provider_payloads_persisted: false,
        contract: {
            endpoint: LOOKUP_URL,
            request_address_shape: 'structured street/city/state/zip plus requestId',
            datasets_location: 'options.datasets',
            basic_dataset_tested_in_three_cities: true,
            rich_valid_dataset_enums_tested_once: ['core', 'listing', 'deed', 'valuation']
        },
        request_budget: {
            search_take_1_max: 3,
            basic_lookup_max: 3,
            rich_lookup_max: 1,
            http_attempts_max: 7,
            retries: 0,
            billing_note: 'Provider billing is not inferred; this supplement requests at most three Search records and four Lookup property responses.'
        },
        telemetry,
        rows
    };
}

async function runSeattleFilterControls() {
    const city = CITIES.find(candidate => candidate.city === 'Seattle');
    const predicates = {};
    for (const predicate of ['intel', 'sale']) {
        predicates[predicate] = {
            r2_only: await count(city, predicate, FOURTEEN_DAY_MIN, { r2: true }),
            valuation_only: await count(city, predicate, FOURTEEN_DAY_MIN, { valuation: true }),
            listing_exclusion_only: await count(city, predicate, FOURTEEN_DAY_MIN, { listing: true })
        };
    }
    return {
        schema_version: 1,
        test_name: 'BatchData Seattle individual filter controls',
        completed_at: new Date().toISOString(),
        city: city.city,
        state: city.state,
        date_window: { min_date: FOURTEEN_DAY_MIN, max_date: YESTERDAY },
        known_baseline_from_primary_probe: { intel: 31, sale: 25 },
        known_all_three_filters_from_primary_probe: { intel: 11, sale: 7 },
        property_addresses_persisted: false,
        raw_provider_payloads_persisted: false,
        request_budget: { count_only_requests: 6, retries: 0 },
        telemetry,
        predicates
    };
}

function present(value) {
    return value !== undefined && value !== null && value !== '';
}

function anyItemWith(array, key) {
    return Array.isArray(array) && array.some(item => present(item?.[key]));
}

function mapperDatePathPresence(property) {
    return {
        'intel.lastSoldDate': present(property?.intel?.lastSoldDate),
        'intel.lastSaleDate': present(property?.intel?.lastSaleDate),
        'sale.lastSaleDate': present(property?.sale?.lastSaleDate),
        'sale.saleDate': present(property?.sale?.saleDate),
        'lastSale.saleDate': present(property?.lastSale?.saleDate),
        'sale.lastSale.saleDate': present(property?.sale?.lastSale?.saleDate),
        'sale.lastTransfer.saleDate': present(property?.sale?.lastTransfer?.saleDate),
        'deed.sale.saleDate': present(property?.deed?.sale?.saleDate),
        'lastSaleDate': present(property?.lastSaleDate),
        'sale.recordingDate': present(property?.sale?.recordingDate),
        'lastSale.recordingDate': present(property?.lastSale?.recordingDate),
        'sale.lastSale.recordingDate': present(property?.sale?.lastSale?.recordingDate),
        'sale.lastTransfer.recordingDate': present(property?.sale?.lastTransfer?.recordingDate),
        'deed.sale.recordingDate': present(property?.deed?.sale?.recordingDate),
        'listing.soldDate': present(property?.listing?.soldDate),
        'transaction.saleDate': present(property?.transaction?.saleDate),
        'transaction.recordingDate': present(property?.transaction?.recordingDate),
        'deedHistory[].saleDate': anyItemWith(property?.deedHistory, 'saleDate'),
        'deedHistory[].recordingDate': anyItemWith(property?.deedHistory, 'recordingDate'),
        'sale.lastSale.mortgages[].saleDate': anyItemWith(property?.sale?.lastSale?.mortgages, 'saleDate'),
        'sale.lastSale.mortgages[].recordingDate': anyItemWith(property?.sale?.lastSale?.mortgages, 'recordingDate'),
        'sale.lastTransfer.mortgages[].saleDate': anyItemWith(property?.sale?.lastTransfer?.mortgages, 'saleDate'),
        'sale.lastTransfer.mortgages[].recordingDate': anyItemWith(property?.sale?.lastTransfer?.mortgages, 'recordingDate'),
        'sale.mortgages[].saleDate': anyItemWith(property?.sale?.mortgages, 'saleDate'),
        'sale.mortgages[].recordingDate': anyItemWith(property?.sale?.mortgages, 'recordingDate'),
        'lastSale.mortgages[].saleDate': anyItemWith(property?.lastSale?.mortgages, 'saleDate'),
        'lastSale.mortgages[].recordingDate': anyItemWith(property?.lastSale?.mortgages, 'recordingDate'),
        'deed.sale.mortgages[].saleDate': anyItemWith(property?.deed?.sale?.mortgages, 'saleDate'),
        'deed.sale.mortgages[].recordingDate': anyItemWith(property?.deed?.sale?.mortgages, 'recordingDate'),
        'transaction.mortgages[].saleDate': anyItemWith(property?.transaction?.mortgages, 'saleDate'),
        'transaction.mortgages[].recordingDate': anyItemWith(property?.transaction?.mortgages, 'recordingDate'),
        'openLien.mortgages[].saleDate': anyItemWith(property?.openLien?.mortgages, 'saleDate'),
        'openLien.mortgages[].recordingDate': anyItemWith(property?.openLien?.mortgages, 'recordingDate'),
        'mortgageHistory[].saleDate': anyItemWith(property?.mortgageHistory, 'saleDate'),
        'mortgageHistory[].recordingDate': anyItemWith(property?.mortgageHistory, 'recordingDate')
    };
}

function coordinatePresence(property) {
    const address = property?.address || property?.propertyAddress || property?.situsAddress || {};
    const location = address?.location || {};
    const latitude = firstPresent(location.latitude, address.latitude, address.lat, property?.latitude, property?.lat);
    const longitude = firstPresent(location.longitude, address.longitude, address.lng, property?.longitude, property?.lng);
    return {
        latitude_present: present(latitude) && Number.isFinite(Number(latitude)),
        longitude_present: present(longitude) && Number.isFinite(Number(longitude)),
        coordinate_pair_present: present(latitude) && present(longitude) && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
    };
}

function addKeyUnion(unions, name, value) {
    if (!unions[name]) unions[name] = new Set();
    for (const key of safeKeys(value)) unions[name].add(key);
}

function collectSafeKeyUnions(unions, property) {
    addKeyUnion(unions, 'property', property);
    addKeyUnion(unions, 'address', property?.address);
    addKeyUnion(unions, 'address.location', property?.address?.location);
    addKeyUnion(unions, 'intel', property?.intel);
    addKeyUnion(unions, 'sale', property?.sale);
    addKeyUnion(unions, 'sale.lastSale', property?.sale?.lastSale);
    addKeyUnion(unions, 'sale.lastTransfer', property?.sale?.lastTransfer);
    addKeyUnion(unions, 'lastSale', property?.lastSale);
    addKeyUnion(unions, 'deed', property?.deed);
    addKeyUnion(unions, 'deed.sale', property?.deed?.sale);
    addKeyUnion(unions, 'listing', property?.listing);
    addKeyUnion(unions, 'transaction', property?.transaction);
    addKeyUnion(unions, 'quickLists', property?.quickLists);
    addKeyUnion(unions, 'openLien', property?.openLien);
    addKeyUnion(unions, 'deedHistory[]', Array.isArray(property?.deedHistory) ? property.deedHistory[0] : null);
    addKeyUnion(unions, 'openLien.mortgages[]', Array.isArray(property?.openLien?.mortgages) ? property.openLien.mortgages[0] : null);
    addKeyUnion(unions, 'mortgageHistory[]', Array.isArray(property?.mortgageHistory) ? property.mortgageHistory[0] : null);
}

async function runMapperEvidenceSupplement() {
    const allFilters = { r2: true, valuation: true, listing: true };
    const pathCounts = Object.fromEntries(Object.keys(mapperDatePathPresence({})).map(path => [path, 0]));
    const selectedSourceCounts = {};
    const selectedConfidenceCounts = {};
    const keyUnions = {};
    const aggregate = {
        requested_samples: 3,
        successful_http: 0,
        returned_records: 0,
        complete_structured_address: 0,
        latitude_present: 0,
        longitude_present: 0,
        coordinate_pair_present: 0,
        quickLists_recentlySold_present: 0,
        quickLists_recentlySold_true: 0,
        selector_exact_date_present: 0,
        selector_exact_date_in_window: 0,
        selector_exact_date_outside_window: 0,
        selector_no_date: 0,
        selector_purchase_mortgage_evidence: 0
    };

    for (const city of CITIES.slice(0, 3)) {
        console.error(`Mapper-evidence basic Search sample for ${city.city}, ${city.state}`);
        const response = await postJson(
            SEARCH_URL,
            searchPayload(city, {
                predicate: 'intel',
                minDate: FOURTEEN_DAY_MIN,
                take: 1,
                filters: allFilters,
                datasets: ['basic']
            }),
            'search_take_1'
        );
        if (response.ok) aggregate.successful_http++;
        const records = response.ok ? extractRecords(response.payload) : [];
        if (records.length === 0) continue;
        aggregate.returned_records++;
        const property = propertyFromRecord(records[0]);
        collectSafeKeyUnions(keyUnions, property);

        const address = addressFromProperty(property);
        if (address.street && address.city && address.state && address.zip) aggregate.complete_structured_address++;
        const coordinates = coordinatePresence(property);
        if (coordinates.latitude_present) aggregate.latitude_present++;
        if (coordinates.longitude_present) aggregate.longitude_present++;
        if (coordinates.coordinate_pair_present) aggregate.coordinate_pair_present++;

        if (present(property?.quickLists?.recentlySold)) aggregate.quickLists_recentlySold_present++;
        if (property?.quickLists?.recentlySold === true) aggregate.quickLists_recentlySold_true++;
        const pathPresence = mapperDatePathPresence(property);
        for (const [path, hasValue] of Object.entries(pathPresence)) {
            if (hasValue) pathCounts[path]++;
        }

        const selected = selectRecentSaleEvidence(property, { maxDate: YESTERDAY });
        if (selected.saleDate) {
            aggregate.selector_exact_date_present++;
            if (selected.saleDate >= FOURTEEN_DAY_MIN && selected.saleDate <= YESTERDAY) {
                aggregate.selector_exact_date_in_window++;
            } else {
                aggregate.selector_exact_date_outside_window++;
            }
        } else {
            aggregate.selector_no_date++;
        }
        selectedSourceCounts[selected.saleDateSource || 'none'] = (selectedSourceCounts[selected.saleDateSource || 'none'] || 0) + 1;
        selectedConfidenceCounts[selected.saleDateConfidence || 'none'] = (selectedConfidenceCounts[selected.saleDateConfidence || 'none'] || 0) + 1;
        if (selected.purchaseMortgageEvidence === true) aggregate.selector_purchase_mortgage_evidence++;
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }

    return {
        schema_version: 1,
        test_name: 'BatchData qualified basic Search mapper-evidence supplement',
        completed_at: new Date().toISOString(),
        date_window: { min_date: FOURTEEN_DAY_MIN, max_date: YESTERDAY },
        cities: ['Phoenix, AZ', 'Charlotte, NC', 'Dallas, TX'],
        privacy: {
            credentials_included: false,
            property_addresses_persisted: false,
            property_ids_or_hashes_persisted: false,
            date_values_persisted: false,
            coordinate_values_persisted: false,
            raw_provider_payloads_persisted: false
        },
        request_budget: {
            search_take_1_attempts_max: 3,
            lookup_attempts: 0,
            retries: 0,
            maximum_returned_records_requested: 3,
            billing_status: 'unverified'
        },
        telemetry,
        aggregate,
        accepted_mapper_date_path_records_present: pathCounts,
        selector_source_counts: selectedSourceCounts,
        selector_confidence_counts: selectedConfidenceCounts,
        safe_key_name_unions: Object.fromEntries(
            Object.entries(keyUnions).map(([name, values]) => [name, [...values].sort()])
        ),
        interpretation_rule: 'selector_exact_date_in_window is the pure selectRecentSaleEvidence result with maxDate 2026-07-08, compared to the inclusive 2026-06-25..2026-07-08 window; it does not assert that independent SFR/value/listing gates passed locally.'
    };
}

function extractNextPageCursor(payload) {
    return firstPresent(
        payload?.results?.nextPageCursor,
        payload?.nextPageCursor,
        payload?.data?.results?.nextPageCursor,
        payload?.data?.nextPageCursor
    ) || null;
}

function normalizedIdentity(property) {
    const id = propertyId(property);
    if (id) return `id:${String(id)}`;
    const address = addressFromProperty(property);
    const normalized = normalizeAddress(address);
    return normalized.split('|').every(Boolean) ? `address:${normalized}` : null;
}

async function runCursorContractSupplement() {
    const city = CITIES.find(candidate => candidate.city === 'Seattle');
    const request = searchPayload(city, {
        predicate: 'intel',
        minDate: FOURTEEN_DAY_MIN,
        take: 1,
        filters: { r2: true, valuation: true, listing: true },
        datasets: ['basic']
    });
    delete request.options.skip;
    request.options.useCursorPagination = true;

    console.error('Cursor contract page 1 for qualified Seattle Intel criteria');
    const first = await postJson(SEARCH_URL, request, 'search_take_1');
    const firstRecords = first.ok ? extractRecords(first.payload) : [];
    const firstCursor = first.ok ? extractNextPageCursor(first.payload) : null;

    let second = null;
    let secondRecords = [];
    let secondCursor = null;
    if (firstCursor) {
        console.error('Cursor contract page 2 using the opaque page-1 cursor');
        second = await postJson(SEARCH_URL, {
            searchCriteria: request.searchCriteria,
            options: {
                take: 1,
                datasets: ['basic'],
                useCursorPagination: true,
                pageCursor: firstCursor
            }
        }, 'search_take_1');
        secondRecords = second.ok ? extractRecords(second.payload) : [];
        secondCursor = second.ok ? extractNextPageCursor(second.payload) : null;
    }

    const firstProperty = firstRecords.length > 0 ? propertyFromRecord(firstRecords[0]) : {};
    const secondProperty = secondRecords.length > 0 ? propertyFromRecord(secondRecords[0]) : {};
    const firstIdentity = normalizedIdentity(firstProperty);
    const secondIdentity = normalizedIdentity(secondProperty);

    return {
        schema_version: 1,
        test_name: 'BatchData qualified Seattle Intel cursor round-trip contract',
        completed_at: new Date().toISOString(),
        privacy: {
            cursor_values_persisted: false,
            property_addresses_persisted: false,
            property_ids_or_hashes_persisted: false,
            raw_provider_payloads_persisted: false,
            credentials_included: false
        },
        exposure: {
            http_attempts: telemetry.http_attempts,
            retries: 0,
            lookup_attempts: 0,
            records_returned: firstRecords.length + secondRecords.length
        },
        page_1: {
            http_status: first.status,
            cursor_present: Boolean(firstCursor),
            returned_records: firstRecords.length,
            reported_total_count: first.ok ? extractTotal(first.payload) : null
        },
        page_2: {
            attempted: Boolean(second),
            http_status: second?.status ?? null,
            cursor_present: Boolean(secondCursor),
            returned_records: secondRecords.length,
            reported_total_count: second?.ok ? extractTotal(second.payload) : null
        },
        normalized_identities_differ: firstIdentity && secondIdentity
            ? firstIdentity !== secondIdentity
            : null
    };
}

function requestedProbeMode() {
    if (process.argv.includes('--lookup-only')) return 'lookup_only';
    if (process.argv.includes('--seattle-filter-controls')) return 'seattle_filter_controls';
    if (process.argv.includes('--mapper-evidence')) return 'mapper_evidence';
    if (process.argv.includes('--cursor-contract')) return 'cursor_contract';
    return 'corrected_contract_primary';
}

function planOnlyResult() {
    const mode = requestedProbeMode();
    const plannedMaximums = {
        corrected_contract_primary: 33,
        lookup_only: 6,
        seattle_filter_controls: 7,
        mapper_evidence: 3,
        cursor_contract: 2
    };
    return {
        mode: 'plan_only_no_network',
        requested_probe: mode,
        network_requests_made: 0,
        live_http_budget: LIVE_HTTP_BUDGET,
        planned_http_attempts_max: plannedMaximums[mode],
        as_of_date: AS_OF_DATE,
        yesterday_date: YESTERDAY,
        endpoints: { search: SEARCH_URL, lookup: LOOKUP_URL },
        privacy: {
            raw_provider_payloads_persisted: false,
            property_addresses_persisted: false,
            property_ids_or_hashes_persisted: false,
            provider_error_bodies_persisted: false
        },
        billing_warning: 'The HTTP ceiling is a safety limit, not a provider billing estimate. Confirm exact charges in BatchData.',
        execute: 'Re-run with --confirm-live after reviewing this plan.'
    };
}

async function main() {
    if (!Number.isInteger(LIVE_HTTP_BUDGET) || LIVE_HTTP_BUDGET < 1 || LIVE_HTTP_BUDGET > 100) {
        throw new Error('--budget must be an integer between 1 and 100');
    }
    if (!LIVE_CONFIRMED) {
        process.stdout.write(`${JSON.stringify(planOnlyResult(), null, 2)}\n`);
        console.error('PLAN ONLY: no BatchData request was made. Re-run with --confirm-live to execute.');
        return;
    }
    if (!API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured in .env');
    if (process.argv.includes('--lookup-only')) {
        process.stdout.write(`${JSON.stringify(await runLookupOnlySupplement(), null, 2)}\n`);
        return;
    }
    if (process.argv.includes('--seattle-filter-controls')) {
        process.stdout.write(`${JSON.stringify(await runSeattleFilterControls(), null, 2)}\n`);
        return;
    }
    if (process.argv.includes('--mapper-evidence')) {
        process.stdout.write(`${JSON.stringify(await runMapperEvidenceSupplement(), null, 2)}\n`);
        return;
    }
    if (process.argv.includes('--cursor-contract')) {
        process.stdout.write(`${JSON.stringify(await runCursorContractSupplement(), null, 2)}\n`);
        return;
    }
    const startedAt = new Date().toISOString();
    const allFilters = { r2: true, valuation: true, listing: true };
    const cities = [];

    for (const city of CITIES) {
        console.error(`Counting corrected-contract probes for ${city.city}, ${city.state}`);
        const row = {
            city: city.city,
            state: city.state,
            region: city.region,
            nominal_polygon_area_sq_mi: 25,
            windows: {
                yesterday_only: {},
                fourteen_days: {}
            },
            qualified_fourteen_days: {}
        };
        for (const predicate of ['intel', 'sale']) {
            row.windows.yesterday_only[predicate] = await count(city, predicate, YESTERDAY);
            row.windows.fourteen_days[predicate] = await count(city, predicate, FOURTEEN_DAY_MIN);
            row.qualified_fourteen_days[predicate] = await count(city, predicate, FOURTEEN_DAY_MIN, allFilters);
        }
        cities.push(row);
    }

    console.error('Running single-filter controls in Phoenix, AZ');
    const phoenix = CITIES[0];
    const filterControls = {
        predicate: 'sale',
        window: 'fourteen_days',
        baseline: cities[0].windows.fourteen_days.sale,
        r2_only: await count(phoenix, 'sale', FOURTEEN_DAY_MIN, { r2: true }),
        valuation_only: await count(phoenix, 'sale', FOURTEEN_DAY_MIN, { valuation: true }),
        listing_exclusion_only: await count(phoenix, 'sale', FOURTEEN_DAY_MIN, { listing: true })
    };

    const samples = [];
    for (const cityRow of cities.slice(0, 3)) {
        const city = CITIES.find(candidate => candidate.city === cityRow.city);
        const intelCount = cityRow.qualified_fourteen_days.intel.count || 0;
        const saleCount = cityRow.qualified_fourteen_days.sale.count || 0;
        const predicate = intelCount >= saleCount && intelCount > 0 ? 'intel' : (saleCount > 0 ? 'sale' : null);
        if (!predicate) {
            samples.push({ city: city.city, state: city.state, skipped: 'no_qualified_candidates' });
            continue;
        }

        console.error(`Sampling one qualified ${predicate} row and corrected Lookup in ${city.city}, ${city.state}`);
        const sampleResponse = await postJson(
            SEARCH_URL,
            searchPayload(city, {
                predicate,
                minDate: FOURTEEN_DAY_MIN,
                take: 1,
                filters: allFilters,
                datasets: ['core', 'listing', 'deed', 'valuation']
            }),
            'search_take_1'
        );
        const sampleRecords = sampleResponse.ok ? extractRecords(sampleResponse.payload) : [];
        const searchProperty = sampleRecords.length > 0 ? propertyFromRecord(sampleRecords[0]) : {};
        const address = addressFromProperty(searchProperty);
        const addressComplete = Boolean(address.street && address.city && address.state && address.zip);
        const sampleSummary = {
            city: city.city,
            state: city.state,
            predicate,
            search: searchResultSummary(sampleResponse),
            lookup: null
        };
        if (!addressComplete) {
            sampleSummary.lookup = { skipped: 'search_result_missing_complete_structured_address' };
            samples.push(sampleSummary);
            continue;
        }

        const requestId = `corrected-probe-${samples.length + 1}`;
        const lookupResponse = await postJson(LOOKUP_URL, {
            requests: [{ address, requestId }],
            options: { datasets: ['core', 'listing', 'deed', 'valuation'] }
        }, 'lookup');
        const rows = lookupResponse.ok ? lookupRecords(lookupResponse.payload) : [];
        const lookupProperty = rows.length > 0 ? propertyFromRecord(rows[0]) : {};
        const identity = rows.length > 0 ? identityCheck(searchProperty, lookupProperty) : { method: 'unverified', match: null };
        const echoedRequestId = rows.some(row => (
            row?.requestId === requestId ||
            row?.response?.requestId === requestId ||
            row?.result?.requestId === requestId
        ));
        sampleSummary.lookup = {
            ok: lookupResponse.ok,
            status: lookupResponse.status,
            extractable_rows: rows.length,
            identity,
            request_id_echoed: echoedRequestId,
            field_presence: rows.length > 0 ? fieldPresence(lookupProperty) : null,
            warnings: lookupResponse.warnings,
            provider_error_code: lookupResponse.provider_error_code,
            provider_error_message: lookupResponse.provider_error_message,
            shape: { top_level_keys: lookupResponse.top_level_keys, results_keys: lookupResponse.results_keys }
        };
        samples.push(sampleSummary);
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }

    const output = {
        schema_version: 1,
        test_name: 'BatchData corrected Search and Lookup contract capability probe',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        as_of_date: AS_OF_DATE,
        yesterday_date: YESTERDAY,
        credentials_included: false,
        property_addresses_persisted: false,
        property_ids_or_hashes_persisted: false,
        raw_provider_payloads_persisted: false,
        contracts: {
            search_endpoint: SEARCH_URL,
            search_dataset_location: 'options.datasets',
            search_datasets: ['basic'],
            rich_sample_datasets: ['core', 'listing', 'deed', 'valuation'],
            lookup_endpoint: LOOKUP_URL,
            lookup_address_shape: 'structured street/city/state/zip plus requestId',
            lookup_dataset_location: 'options.datasets'
        },
        criteria: {
            intel: 'searchCriteria.intel.lastSoldDate',
            sale: 'searchCriteria.sale.lastSaleDate',
            sfr: 'searchCriteria.general.standardizedLandUseCode.equals = R2',
            value_floor: 'searchCriteria.valuation.estimatedValue.min = 100000',
            for_sale_exclusion: "searchCriteria.listing.statusCategory.notInList = ['Active','Pending']"
        },
        request_budget: {
            hard_http_attempt_ceiling: LIVE_HTTP_BUDGET,
            planned_search_take_0: 27,
            planned_search_take_1_max: 3,
            planned_lookup_max: 3,
            planned_http_attempts_max: Math.min(33, LIVE_HTTP_BUDGET),
            retries: 0,
            maximum_search_records_requested_for_return: 3,
            maximum_lookup_properties_requested: 3,
            billing_note: 'Provider billing is not inferred. take:0 may carry a minimum record charge, and multi-dataset charges depend on the account contract.'
        },
        telemetry,
        filter_controls: filterControls,
        cities,
        rich_samples_and_lookup_identity: samples,
        limitations: [
            'This validates BatchData contract behavior and internal predicate counts, not penetration against an independent recorder/MLS ground-truth universe.',
            'Count equality does not prove record-set equality; a full union requires paginating and de-duplicating both predicates.',
            'Only three rich Search/Lookup samples are permitted by this low-credit probe.',
            'Absence of a returned field can reflect dataset entitlement or response projection and does not invalidate a provider-side accepted filter.',
            'No raw provider responses, addresses, property identifiers, API credentials, or response hashes are persisted.'
        ]
    };

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch(error => {
    console.error(`Corrected contract probe failed: ${scrub(error?.stack || error?.message || error)}`);
    process.exitCode = 1;
});
