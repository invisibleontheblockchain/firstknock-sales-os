export const BATCHDATA_PAGE_LIMIT = 100;
export const DEFAULT_PRECISION_MIN_HOME_VALUE = 100000;
export const BATCHDATA_RICH_SEARCH_DATASETS = ['core', 'deed', 'listing', 'owner', 'valuation'];
// The July 9 corrected capability probe proved the current token accepts only
// `basic`; rich requests return `dataset_not_allowed`. Keep production
// entitlement-safe while retaining the rich contract for explicit diagnostics.
export const BATCHDATA_SEARCH_DATASETS = ['basic'];

const PURCHASE_TRANSACTION_CODES = new Set(['B']);
const REFI_TRANSACTION_CODES = new Set(['G']);
const BLOCKED_LISTING_STATUSES = [
    'active',
    'for sale',
    'coming soon',
    'contingent',
    'pending',
    'under contract'
];

function firstValue(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

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

function isExplicitNonSingleFamilyType(value) {
    const type = normalizePropertyTypeText(value);
    return /\bmulti family\b|\bmultifamily\b|\bcondo(?:minium)?\b|\bapartment\b|\btownhome\b|\btownhouse\b|\bduplex\b|\btriplex\b|\bfourplex\b|\bsemi detached\b|\battached\b|\bmobile home\b|\bmanufactured home\b|\bmanufactured housing\b|\bmixed use\b|\bcommercial\b|\bindustrial\b|\bretail\b|\boffice\b|\bwarehouse\b|\bvacant\b|\bland\b|\blot\b|\bagricultural\b|\bfarm\b/.test(type);
}

export function unwrapBatchDataProperty(record) {
    return record?.property ||
        record?.result?.property ||
        record?.results?.property ||
        record?.data?.property ||
        record?.response?.property ||
        record || {};
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

function isoDateOnly(value) {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
}

function addIsoCalendarDays(value, days) {
    const normalized = isoDateOnly(value);
    if (!normalized) return null;
    const date = new Date(`${normalized}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return date.toISOString().slice(0, 10);
}

export function closedDayWindow(asOfDate, days) {
    const dayCount = Math.max(1, Math.trunc(Number(days) || 1));
    const maxDate = addIsoCalendarDays(asOfDate, -1);
    if (!maxDate) return { minDate: null, maxDate: null };
    return {
        minDate: addIsoCalendarDays(maxDate, -(dayCount - 1)),
        maxDate
    };
}

function transactionText(mortgage = {}) {
    return [
        mortgage.transactionType,
        mortgage.transactionTypeDescription,
        mortgage.purposeOfLoan,
        mortgage.loanPurpose
    ].filter(Boolean).join(' ').toLowerCase();
}

function eventText(event = {}) {
    return [
        event.transactionType,
        event.transactionTypeDescription,
        event.documentType,
        event.deedType,
        event.transferType,
        event.saleType,
        event.armsLengthIndicator
    ].filter(Boolean).join(' ').toLowerCase();
}

function eventAmount(event = {}) {
    for (const value of [event.salePrice, event.amount, event.consideration, event.transferAmount, event.price]) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function isDisqualifiedTransferEvent(event = {}) {
    return /quit\s*claim|gift|inherit|probate|trustee|foreclos|tax deed|refi|second trust|2nd trust|heloc/.test(eventText(event));
}

function hasQualifiedSaleEvent(event = {}) {
    const text = eventText(event);
    if (isDisqualifiedTransferEvent(event)) return false;
    return eventAmount(event) !== null || /\bsale\b|purchase|resale|arms[- ]length/.test(text);
}

export function isPurchaseMortgage(mortgage = {}) {
    const code = String(mortgage.transactionTypeCode || '').trim().toUpperCase();
    const text = transactionText(mortgage);
    if (REFI_TRANSACTION_CODES.has(code) || /\brefi(?:nance)?\b|2nd trust|second trust|equity line|heloc/.test(text)) {
        return false;
    }
    return PURCHASE_TRANSACTION_CODES.has(code) || /purchase|resale|arms[- ]length residential/.test(text);
}

function sameIsoDate(left, right) {
    const leftDate = isoDateOnly(left);
    const rightDate = isoDateOnly(right);
    return !!leftDate && leftDate === rightDate;
}

function purchaseMortgageForDate(property, value) {
    const mortgages = [
        ...(Array.isArray(property?.openLien?.mortgages) ? property.openLien.mortgages : []),
        ...(Array.isArray(property?.mortgageHistory) ? property.mortgageHistory : [])
    ];
    return mortgages.find(mortgage => isPurchaseMortgage(mortgage) && (
        sameIsoDate(mortgage.recordingDate, value) ||
        sameIsoDate(mortgage.saleDate, value) ||
        sameIsoDate(mortgage.documentDate, value)
    ));
}

function directSaleCandidates(property) {
    // Evaluate independent shapes instead of letting an empty/generic `sale: {}`
    // shadow a populated top-level `lastSale` or deed sale object.
    const sale = property?.sale || {};
    const lastSale = property?.lastSale || sale.lastSale || sale.lastTransfer || {};
    const deedSale = property?.deed?.sale || {};
    const transaction = property?.transaction || {};
    const listingStatus = String(firstValue(property?.listing?.status, property?.listing?.statusCategory) || '').toLowerCase();
    const listingIsSold = listingStatus.includes('sold') || listingStatus.includes('closed');
    const saleQualified = hasQualifiedSaleEvent(sale);
    const lastSaleQualified = hasQualifiedSaleEvent(lastSale);
    const deedSaleQualified = hasQualifiedSaleEvent(deedSale);
    const saleDisqualified = isDisqualifiedTransferEvent(sale);
    const lastSaleDisqualified = isDisqualifiedTransferEvent(lastSale);
    const deedSaleDisqualified = isDisqualifiedTransferEvent(deedSale);
    const transactionQualified = hasQualifiedSaleEvent(transaction);
    const candidates = [
        { source: 'intel.lastSoldDate', value: property?.intel?.lastSoldDate, confidence: 'high', rank: 100 },
        { source: 'intel.lastSaleDate', value: property?.intel?.lastSaleDate, confidence: 'high', rank: 95 },
        { source: 'sale.lastSaleDate', value: saleDisqualified ? null : sale.lastSaleDate, confidence: 'high', rank: 90 },
        { source: 'sale.saleDate', value: saleDisqualified ? null : sale.saleDate, confidence: 'high', rank: 85 },
        { source: 'lastSale.saleDate', value: lastSaleDisqualified ? null : lastSale?.saleDate, confidence: 'high', rank: 80 },
        { source: 'deed.sale.saleDate', value: deedSaleDisqualified ? null : deedSale?.saleDate, confidence: 'high', rank: 78 },
        { source: 'lastSaleDate', value: property?.lastSaleDate, confidence: 'high', rank: 75 },
        {
            source: 'sale.recordingDate',
            value: saleQualified && !isoDateOnly(firstValue(sale.lastSaleDate, sale.saleDate)) ? sale.recordingDate : null,
            confidence: 'high',
            rank: 60
        },
        {
            source: 'lastSale.recordingDate',
            value: lastSaleQualified && !isoDateOnly(lastSale?.saleDate) ? lastSale?.recordingDate : null,
            confidence: 'high',
            rank: 55
        },
        {
            source: 'deed.sale.recordingDate',
            value: deedSaleQualified && !isoDateOnly(deedSale?.saleDate) ? deedSale?.recordingDate : null,
            confidence: 'high',
            rank: 53
        },
        { source: 'listing.soldDate', value: listingIsSold ? property?.listing?.soldDate : null, confidence: 'medium', rank: 50 },
        { source: 'transaction.saleDate', value: transactionQualified ? transaction.saleDate : null, confidence: 'high', rank: 45 },
        {
            source: 'transaction.recordingDate',
            value: transactionQualified && !transaction.saleDate ? transaction.recordingDate : null,
            confidence: 'high',
            rank: 40
        }
    ];

    const deeds = Array.isArray(property?.deedHistory) ? property.deedHistory : [];
    deeds.forEach((deed, index) => {
        const qualified = hasQualifiedSaleEvent(deed);
        if (!qualified) return;
        candidates.push({
            source: `deedHistory[${index}].saleDate`,
            value: deed?.saleDate,
            confidence: 'high',
            rank: 70
        });
        if (!isoDateOnly(deed?.saleDate)) {
            candidates.push({
                source: `deedHistory[${index}].recordingDate`,
                value: deed?.recordingDate,
                confidence: 'high',
                rank: 65
            });
        }
    });
    return candidates;
}

function purchaseMortgageCandidates(property) {
    if (property?.quickLists?.recentlySold !== true) return [];
    const saleRoots = [
        property?.sale?.lastSale,
        property?.sale?.lastTransfer,
        property?.sale,
        property?.lastSale,
        property?.deed?.sale,
        property?.transaction
    ].filter(Boolean);
    const saleMortgages = saleRoots.flatMap(root => Array.isArray(root?.mortgages) ? root.mortgages : []);
    const openLienMortgages = Array.isArray(property?.openLien?.mortgages) ? property.openLien.mortgages : [];
    const history = Array.isArray(property?.mortgageHistory) ? property.mortgageHistory : [];
    const candidates = [];

    for (const mortgage of saleMortgages) {
        const value = firstValue(mortgage?.saleDate, mortgage?.recordingDate);
        if (value && (isPurchaseMortgage(mortgage) || purchaseMortgageForDate(property, value))) {
            candidates.push({ source: 'sale.lastSale.mortgages[].recordingDate', value, confidence: 'medium' });
        }
    }
    for (const mortgage of openLienMortgages) {
        const value = firstValue(mortgage?.saleDate, mortgage?.recordingDate);
        if (value && isPurchaseMortgage(mortgage)) {
            candidates.push({ source: 'openLien.mortgages[].recordingDate', value, confidence: 'medium' });
        }
    }
    for (const mortgage of history) {
        const value = firstValue(mortgage?.saleDate, mortgage?.recordingDate);
        if (value && isPurchaseMortgage(mortgage)) {
            candidates.push({ source: 'mortgageHistory[].saleDate', value, confidence: 'medium' });
        }
    }
    return candidates;
}

export function selectRecentSaleEvidence(property = {}, { maxDate = null } = {}) {
    const normalizedMaxDate = isoDateOnly(maxDate);
    const directCandidates = directSaleCandidates(property)
        .map(candidate => ({ ...candidate, saleDate: isoDateOnly(dateValue(candidate.value)), purchaseMortgageEvidence: false }));
    const purchaseCandidates = purchaseMortgageCandidates(property)
        .map(candidate => ({ ...candidate, saleDate: isoDateOnly(dateValue(candidate.value)), purchaseMortgageEvidence: true }));
    const bestEvidence = [...directCandidates, ...purchaseCandidates]
        .filter(candidate => candidate.saleDate && (!normalizedMaxDate || candidate.saleDate <= normalizedMaxDate))
        .sort((a, b) => (
            b.saleDate.localeCompare(a.saleDate) ||
            Number(b.confidence === 'high') - Number(a.confidence === 'high') ||
            (b.rank || 0) - (a.rank || 0)
        ))[0];
    if (bestEvidence) {
        return {
            saleDate: bestEvidence.saleDate,
            saleDateSource: bestEvidence.source,
            saleDateConfidence: bestEvidence.confidence,
            purchaseMortgageEvidence: bestEvidence.purchaseMortgageEvidence
        };
    }

    return {
        saleDate: null,
        saleDateSource: 'none',
        saleDateConfidence: 'none',
        purchaseMortgageEvidence: false
    };
}

export function applyRecentSaleSearchFilter(searchCriteria, soldMinDate, source = 'sale', soldMaxDate = null) {
    if (!soldMinDate) return searchCriteria;
    const range = {
        minDate: soldMinDate,
        ...(soldMaxDate ? { maxDate: soldMaxDate } : {})
    };
    if (source === 'sale') {
        searchCriteria.sale = { lastSaleDate: range };
    } else if (source === 'intel') {
        searchCriteria.intel = { lastSoldDate: range };
    } else {
        throw new Error(`Unsupported BatchData recent-sale source: ${source}`);
    }
    return searchCriteria;
}

/**
 * Apply the three independent lead-quality predicates documented by BatchData.
 * These are deliberately separate from the recent-sale predicate: neither
 * `intel.lastSoldDate` nor `sale.lastSaleDate` proves property type, value, or
 * current listing disposition.
 */
export function applyBatchDataQualificationFilters(searchCriteria, {
    minEstimatedValue = DEFAULT_PRECISION_MIN_HOME_VALUE,
    maxEstimatedValue = null,
    excludeListingStatusCategories = ['Active', 'Pending']
} = {}) {
    const parsedMin = Number(minEstimatedValue);
    const parsedMax = Number(maxEstimatedValue);
    const minimum = Number.isFinite(parsedMin) && parsedMin > 0
        ? Math.max(DEFAULT_PRECISION_MIN_HOME_VALUE, parsedMin)
        : DEFAULT_PRECISION_MIN_HOME_VALUE;
    const maximum = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null;

    searchCriteria.general = {
        ...(searchCriteria.general || {}),
        standardizedLandUseCode: { equals: 'R2' }
    };
    searchCriteria.valuation = {
        ...(searchCriteria.valuation || {}),
        estimatedValue: {
            min: minimum,
            ...(maximum !== null ? { max: maximum } : {})
        }
    };
    if (Array.isArray(excludeListingStatusCategories) && excludeListingStatusCategories.length > 0) {
        searchCriteria.listing = {
            ...(searchCriteria.listing || {}),
            statusCategory: { notInList: excludeListingStatusCategories }
        };
    }
    return searchCriteria;
}

export function qualifiesEstimatedValueRange(value, {
    minEstimatedValue = DEFAULT_PRECISION_MIN_HOME_VALUE,
    maxEstimatedValue = null,
    providerEstimatedValueMin = null,
    providerEstimatedValueMax = null
} = {}) {
    const parsedValue = Number(value);
    const parsedMin = Number(minEstimatedValue);
    const parsedMax = Number(maxEstimatedValue);
    const parsedProviderMin = Number(providerEstimatedValueMin);
    const parsedProviderMax = Number(providerEstimatedValueMax);
    const minimum = Number.isFinite(parsedMin) && parsedMin > 0
        ? Math.max(DEFAULT_PRECISION_MIN_HOME_VALUE, parsedMin)
        : DEFAULT_PRECISION_MIN_HOME_VALUE;
    const maximum = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null;

    if (Number.isFinite(parsedValue) && parsedValue > 0) {
        return parsedValue >= minimum && (maximum === null || parsedValue <= maximum);
    }

    const minimumProven = Number.isFinite(parsedProviderMin) && parsedProviderMin >= minimum;
    const maximumProven = maximum === null || (
        Number.isFinite(parsedProviderMax) && parsedProviderMax > 0 && parsedProviderMax <= maximum
    );
    return minimumProven && maximumProven;
}

export function resolveProviderRecentSaleProof({
    matchedSources = [],
    returnedSaleDateSource = 'none',
    hasReturnedSaleDate = false,
    returnedSaleDateInWindow = false,
    providerWindowProven = false
} = {}) {
    const sources = [...new Set((Array.isArray(matchedSources) ? matchedSources : [])
        .filter(source => source === 'intel' || source === 'sale'))];
    const conflicts = new Set();
    if (hasReturnedSaleDate && !returnedSaleDateInWindow) {
        if (returnedSaleDateSource === 'intel.lastSoldDate') conflicts.add('intel');
        if (returnedSaleDateSource === 'sale.lastSaleDate') conflicts.add('sale');
    }
    const acceptedSources = sources.filter(source => !conflicts.has(source));
    return {
        accepted: providerWindowProven && acceptedSources.length > 0,
        acceptedSources,
        conflictingSources: [...conflicts]
    };
}

export function clampBatchDataTake(value, fallback = BATCHDATA_PAGE_LIMIT) {
    const parsed = Number(value);
    const safe = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
    return Math.min(Math.max(safe, 0), BATCHDATA_PAGE_LIMIT);
}

export function isSaleDateWithinWindow(value, minDate, maxDate) {
    const saleDate = isoDateOnly(value);
    const minimum = isoDateOnly(minDate);
    const maximum = isoDateOnly(maxDate);
    if (!saleDate || !minimum || !maximum) return false;
    return saleDate >= minimum && saleDate <= maximum;
}

export function hasExplicitSingleFamilyMetadata(landUseCode, propertyType) {
    const landUse = String(landUseCode || '').trim().toUpperCase();
    const type = normalizePropertyTypeText(propertyType);
    if (isExplicitNonSingleFamilyType(type)) return false;
    if (landUse === 'R2') return true;
    if (!type || /\bunverified\b|\bunknown\b/.test(type)) {
        return false;
    }
    if (/\bsingle family\b|\bsfr\b|\bsfh\b|\bone family\b|\b1 family\b/.test(type) || type === 'detached') {
        return true;
    }
    return /\bdetached\b/.test(type) && /\bresidential\b|\bresidence\b|\bdwelling\b|\bhome\b|\bhouse\b/.test(type);
}

export function resolveSingleFamilyMetadata(landUseCode, propertyTypeCandidates = []) {
    const candidates = (Array.isArray(propertyTypeCandidates) ? propertyTypeCandidates : [propertyTypeCandidates])
        .flat(Infinity)
        .filter(value => value !== undefined && value !== null && String(value).trim() !== '');
    const explicitNonSingleFamilyType = candidates.find(isExplicitNonSingleFamilyType) || null;
    const explicitSingleFamilyType = candidates.find(value => hasExplicitSingleFamilyMetadata(null, value)) || null;
    const landUseIsR2 = String(landUseCode || '').trim().toUpperCase() === 'R2';
    return {
        candidates,
        explicitNonSingleFamilyType,
        explicitSingleFamilyType,
        landUseIsR2,
        hasExplicitSingleFamilyEvidence: explicitNonSingleFamilyType === null && (landUseIsR2 || explicitSingleFamilyType !== null),
        propertyType: explicitNonSingleFamilyType || explicitSingleFamilyType || (landUseIsR2 ? 'Single Family' : (candidates[0] || null))
    };
}

export function hasAddressUnitMarker(value) {
    const address = String(value || '').trim();
    // Unit designators are address suffix components. Requiring end/comma after
    // the unit token avoids treating street names such as "Unit Circle Rd" as units.
    if (/(?:^|[\s,])(?:apt|apartment|unit|suite|#)\s*[a-z0-9-]+(?=$|,)/i.test(address)) {
        return true;
    }
    // `Ste` is also a street-name abbreviation for Sainte (for example,
    // `123 Ste Genevieve Dr`). Treat it as Suite only with a unit-like token.
    return /(?:^|[\s,])ste\s*(?:#?\d[a-z0-9-]*|[a-z])(?=$|,)/i.test(address);
}

export function isBlockedListingStatus(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (/\bnot(?:\s+currently)?(?:\s+listed)?\s+for\s+sale\b/.test(normalized)) return false;
    return !!normalized && BLOCKED_LISTING_STATUSES.some(value => {
        const pattern = value.replace(/\s+/g, '\\s+');
        return new RegExp(`(^|[^a-z])${pattern}($|[^a-z])`).test(normalized);
    });
}
