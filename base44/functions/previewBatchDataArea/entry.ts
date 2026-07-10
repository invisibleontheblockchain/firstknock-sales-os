import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.14.0';
import { summarizeDualPredicateCounts } from './countProbeLogic.js';

const FREE_PROPERTY_CAP = 50;
const PAID_PROPERTY_CAP = 1000;
const MAX_COUNTIES_PER_PULL = 1;
const PRECISION_PRICE_PER_USER = 99;
const BATCHDATA_PLAN_COST = 1000;
const BATCHDATA_PLAN_RECORDS = 100000;
const BATCHDATA_API_KEY = Deno.env.get('BATCH_DATA_API_KEY');
const BATCHDATA_SEARCH_URL = 'https://api.batchdata.com/api/v1/property/search';
const BATCHDATA_TIMEOUT_MS = 20 * 1000;
const COUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const COUNT_RATE_WINDOW_MS = 60 * 1000;
const COUNT_RATE_LIMIT = 10;
const DEFAULT_PRECISION_MIN_HOME_VALUE = 100000;
const liveCountCache = new Map();
const liveCountRequestsByUser = new Map();
const liveCountInflight = new Map();

function normalizePolygon(input) {
    if (!Array.isArray(input)) return [];
    return input
        .map(point => ({ lat: Number(point.lat), lng: Number(point.lng) }))
        .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function polygonAreaSqMi(points) {
    if (points.length < 3) return 0;
    const avgLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
    const milesPerLat = 69.0;
    const milesPerLng = 69.0 * Math.cos(avgLat * Math.PI / 180);
    const projected = points.map(p => ({ x: p.lng * milesPerLng, y: p.lat * milesPerLat }));
    let sum = 0;
    for (let i = 0; i < projected.length; i++) {
        const a = projected[i];
        const b = projected[(i + 1) % projected.length];
        sum += (a.x * b.y) - (b.x * a.y);
    }
    return Math.abs(sum) / 2;
}

function centroid(points) {
    if (points.length === 0) return null;
    return {
        lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
        lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length
    };
}

function polygonValidationError(points) {
    if (points.length < 3) return 'At least 3 polygon points are required for a freehand area preview.';
    if (points.some(point => Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180)) {
        return 'Polygon coordinates are outside valid latitude/longitude bounds.';
    }
    const distinct = new Set(points.map(point => `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`));
    if (distinct.size < 3) return 'At least 3 distinct polygon points are required.';
    if (polygonAreaSqMi(points) <= 0.000001) return 'The drawn polygon has no usable area. Please redraw it.';
    return null;
}

function soldWindowDays(value) {
    const months = Number(value || 12);
    if (Math.abs(months - (1 / 30)) < 0.0001) return 1;
    if (Math.abs(months - (2 / 30)) < 0.0001) return 2;
    if (months === 0.25) return 7;
    if (months === 0.5) return 14;
    if (months === 1) return 30;
    if (months === 2) return 60;
    if (months === 3) return 90;
    if (months === 6) return 180;
    if (months === 9) return 270;
    if (months === 12) return 365;
    return Math.max(1, Math.round(months * 30));
}

function phoenixDateOnly(referenceMs = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Phoenix',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date(referenceMs));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function addIsoCalendarDays(value, days) {
    const date = new Date(`${value}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function closedSaleWindow(days) {
    const maximum = addIsoCalendarDays(phoenixDateOnly(), -1);
    return {
        minDate: addIsoCalendarDays(maximum, -(Math.max(1, days) - 1)),
        maxDate: maximum
    };
}

function closePolygon(points) {
    const result = points.map(point => ({ latitude: point.lat, longitude: point.lng }));
    const first = result[0];
    const last = result[result.length - 1];
    if (first && last && (first.latitude !== last.latitude || first.longitude !== last.longitude)) {
        result.push({ ...first });
    }
    return result;
}

async function runLiveCountProbe(polygon, soldMonths, minPrice, maxPrice, cacheKey, userKey) {
    if (!BATCHDATA_API_KEY) {
        return { ok: false, status: 503, error: 'BATCH_DATA_API_KEY is not configured', api_requests: 0, billing_credits: null, billing_status: 'unverified' };
    }
    const cached = liveCountCache.get(cacheKey);
    if (cached && Date.now() - cached.cached_at_ms <= COUNT_CACHE_TTL_MS) {
        return { ...cached.value, cache_hit: true, api_requests: 0 };
    }
    const inflight = liveCountInflight.get(cacheKey);
    if (inflight) {
        const shared = await inflight;
        return { ...shared, api_requests: 0, coalesced_request: true };
    }
    const recentRequests = (liveCountRequestsByUser.get(userKey) || [])
        .filter(timestamp => Date.now() - timestamp <= COUNT_RATE_WINDOW_MS);
    if (recentRequests.length >= COUNT_RATE_LIMIT) {
        return {
            ok: false,
            status: 429,
            error: 'Too many uncached BatchData count checks. Wait one minute and try again.',
            api_requests: 0,
            billing_credits: null,
            billing_status: 'unverified',
            rate_limited: true
        };
    }
    recentRequests.push(Date.now());
    liveCountRequestsByUser.set(userKey, recentRequests);
    if (liveCountRequestsByUser.size > 1000) {
        const oldestUserKey = liveCountRequestsByUser.keys().next().value;
        liveCountRequestsByUser.delete(oldestUserKey);
    }
    const requestPromise = executeLiveCountRequest(polygon, soldMonths, minPrice, maxPrice, cacheKey);
    liveCountInflight.set(cacheKey, requestPromise);
    try {
        return await requestPromise;
    } finally {
        if (liveCountInflight.get(cacheKey) === requestPromise) liveCountInflight.delete(cacheKey);
    }
}

async function executeLiveCountRequest(polygon, soldMonths, minPrice, maxPrice, cacheKey) {
    const dateWindow = closedSaleWindow(soldWindowDays(soldMonths));
    const cutoff = dateWindow.minDate;
    const maximumDate = dateWindow.maxDate;
    const parsedMin = Number(minPrice);
    const parsedMax = Number(maxPrice);
    const effectiveMinimum = Number.isFinite(parsedMin) && parsedMin > 0
        ? Math.max(DEFAULT_PRECISION_MIN_HOME_VALUE, parsedMin)
        : DEFAULT_PRECISION_MIN_HOME_VALUE;
    const effectiveMaximum = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BATCHDATA_TIMEOUT_MS);
    try {
        const countPredicate = async (source) => {
            const dateRange = { minDate: cutoff, maxDate: maximumDate };
            const searchCriteria = {
                address: { geoLocationPolygon: { geoPoints: closePolygon(polygon) } },
                general: { standardizedLandUseCode: { equals: 'R2' } },
                valuation: {
                    estimatedValue: {
                        min: effectiveMinimum,
                        ...(effectiveMaximum !== null ? { max: effectiveMaximum } : {})
                    }
                },
                listing: { statusCategory: { notInList: ['Active', 'Pending'] } },
                ...(source === 'intel'
                    ? { intel: { lastSoldDate: dateRange } }
                    : { sale: { lastSaleDate: dateRange } })
            };
            const response = await fetch(BATCHDATA_SEARCH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BATCHDATA_API_KEY}` },
                body: JSON.stringify({
                    searchCriteria,
                    options: { take: 0, skip: 0, datasets: ['basic'] }
                }),
                signal: controller.signal
            });
            const text = await response.text();
            let payload = {};
            try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
            const rawCount = payload?.results?.meta?.results?.resultsFound ?? payload?.results?.totalRecordCount ?? payload?.totalRecordCount;
            const count = rawCount !== null && rawCount !== undefined && rawCount !== '' ? Number(rawCount) : null;
            return {
                source,
                ok: response.ok && Number.isFinite(count),
                status: response.status,
                count: Number.isFinite(count) ? count : null,
                error: response.ok
                    ? (Number.isFinite(count) ? null : 'BatchData count response omitted the candidate-count field')
                    : (payload?.status?.message || text.slice(0, 300) || 'BatchData count probe failed')
            };
        };
        const settledPredicate = (source, result) => {
            if (result.status === 'fulfilled') return result.value;
            const reason = result.reason;
            return {
                source,
                ok: false,
                status: reason?.name === 'AbortError' ? 408 : 500,
                count: null,
                error: reason?.name === 'AbortError'
                    ? 'BatchData count probe timed out'
                    : (reason?.message || String(reason || 'BatchData count probe failed'))
            };
        };
        const [intelResult, saleResult] = await Promise.allSettled([
            countPredicate('intel'),
            countPredicate('sale')
        ]);
        const intel = settledPredicate('intel', intelResult);
        const sale = settledPredicate('sale', saleResult);
        const countSummary = summarizeDualPredicateCounts(intel, sale);
        const partialError = countSummary.partial
            ? `BatchData returned only one of the two independent predicate counts. ${intel.ok ? 'Sale' : 'Intel'} inventory is still unknown, so zero is not treated as an empty union.`
            : null;
        const result = {
            ok: countSummary.ok,
            status: countSummary.complete ? 200 : (intel.ok ? sale.status : intel.status),
            candidate_count: countSummary.candidateCount,
            candidate_count_lower_bound: countSummary.candidateCount,
            candidate_count_upper_bound: countSummary.upperBound,
            predicate_counts_complete: countSummary.complete,
            partial_predicate_counts: countSummary.partial,
            definitive_zero: countSummary.definitiveZero,
            exact_union_requires_record_pull: true,
            predicate_counts: { intel: intel.count, sale: sale.count },
            predicate_results: { intel, sale },
            sold_min_date: cutoff,
            sold_max_date: maximumDate,
            filters: {
                standardized_land_use_code: 'R2',
                estimated_value_min: effectiveMinimum,
                estimated_value_max: effectiveMaximum,
                listing_status_categories_excluded: ['Active', 'Pending']
            },
            api_requests: 2,
            billing_credits: null,
            billing_status: 'unverified',
            cache_hit: false,
            error: partialError || (countSummary.ok ? null : (intel.error || sale.error || 'BatchData count probes failed'))
        };
        // Partial responses are deliberately not cached. A transient failure in
        // either stream must never become a five-minute authoritative zero.
        if (countSummary.complete) liveCountCache.set(cacheKey, { cached_at_ms: Date.now(), value: result });
        if (liveCountCache.size > 200) {
            const oldestKey = liveCountCache.keys().next().value;
            liveCountCache.delete(oldestKey);
        }
        return result;
    } catch (error) {
        return {
            ok: false,
            status: error?.name === 'AbortError' ? 408 : 500,
            candidate_count: null,
            sold_min_date: cutoff,
            api_requests: 2,
            billing_credits: null,
            billing_status: 'unverified',
            cache_hit: false,
            error: error?.name === 'AbortError' ? 'BatchData count probe timed out' : String(error)
        };
    } finally {
        clearTimeout(timeout);
    }
}

function boundsMiles(points) {
    const lats = points.map(p => p.lat);
    const lngs = points.map(p => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const midLat = (minLat + maxLat) / 2;
    return {
        width_miles: Math.abs(maxLng - minLng) * 69.0 * Math.cos(midLat * Math.PI / 180),
        height_miles: Math.abs(maxLat - minLat) * 69.0
    };
}

async function runSandboxProbe(center) {
    const apiKey = Deno.env.get('BATCH_DATA_SANDBOX_KEY');
    if (!apiKey || !center) return null;

    const response = await fetch('https://api.batchdata.com/api/v1/property/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            searchCriteria: { query: `${center.lat},${center.lng}` },
            options: { datasets: ['basic'], take: 5 }
        })
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw_text: text.slice(0, 300) }; }
    const records = payload?.results?.properties || payload?.properties || payload?.results || [];
    const list = Array.isArray(records) ? records : [records].filter(Boolean);
    return { ok: response.ok, status: response.status, record_count: list.length };
}

async function resolveFips(center) {
    if (!center) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
        const url = `https://geo.fcc.gov/api/census/block/find?latitude=${encodeURIComponent(center.lat)}&longitude=${encodeURIComponent(center.lng)}&format=json`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return null;
        const data = await response.json();
        return {
            fips_code: data?.County?.FIPS || null,
            county_name: data?.County?.name || null,
            state_code: data?.State?.code || null,
            state_name: data?.State?.name || null
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function canonicalPolygonCoordinates(points) {
    const coordinates = [];
    for (const point of points || []) {
        const coordinate = `${Number(point.lat).toFixed(7)},${Number(point.lng).toFixed(7)}`;
        if (coordinate !== coordinates[coordinates.length - 1]) coordinates.push(coordinate);
    }
    if (coordinates.length > 1 && coordinates[0] === coordinates[coordinates.length - 1]) coordinates.pop();
    const minimumRotation = (values) => {
        const length = values.length;
        if (length < 2) return values.slice();
        let left = 0, right = 1, offset = 0;
        while (left < length && right < length && offset < length) {
            const leftValue = values[(left + offset) % length];
            const rightValue = values[(right + offset) % length];
            if (leftValue === rightValue) {
                offset++;
                continue;
            }
            if (leftValue > rightValue) {
                left += offset + 1;
                if (left === right) left++;
            } else {
                right += offset + 1;
                if (left === right) right++;
            }
            offset = 0;
        }
        const start = Math.min(left, right);
        return Array.from({ length }, (_, index) => values[(start + index) % length]);
    };
    const forward = minimumRotation(coordinates);
    const reverse = minimumRotation([...coordinates].reverse());
    const forwardKey = forward.join(';');
    const reverseKey = reverse.join(';');
    return forwardKey <= reverseKey ? forwardKey : reverseKey;
}

async function polygonHash(points) {
    const bytes = new TextEncoder().encode(canonicalPolygonCoordinates(points));
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function isPrecisionTier(user) {
    const tier = String(user?.subscription_tier || '').toLowerCase();
    return ['pro', 'precision', 'growth', 'enterprise'].includes(tier);
}

function isExplicitNonPrecisionTier(user) {
    const tier = String(user?.subscription_tier || '').toLowerCase();
    return ['canvas', 'hustler'].includes(tier);
}

function isPrecisionTierOrUnknown(user) {
    const tier = String(user?.subscription_tier || '').toLowerCase();
    if (isPrecisionTier(user)) return true;
    if (isExplicitNonPrecisionTier(user)) return false;
    if (hasPaidPrecisionLimit(user)) return true;
    return !tier || tier === 'custom';
}

function hasPaidPrecisionLimit(user) {
    return Number(user?.precision_property_limit || user?.monthly_property_limit || 0) > FREE_PROPERTY_CAP;
}

function stripeSubscriptionIsPaidPrecision(subscription) {
    const amountCents = subscription.items?.data?.[0]?.price?.unit_amount || 0;
    const latestInvoice = subscription.latest_invoice;
    const invoicePaid = latestInvoice && typeof latestInvoice !== 'string' && latestInvoice.status === 'paid';
    const trialEnded = !subscription.trial_end || subscription.trial_end * 1000 <= Date.now();
    return subscription.status === 'active' && trialEnded && invoicePaid && amountCents >= 9900;
}

async function verifyStripePaidPrecisionAccess(user) {
    const secret = Deno.env.get('STRIPE_SECRET_KEY');
    if (!secret) return null;

    const stripe = new Stripe(secret);
    if (user?.subscription_id) {
        const subscription = await stripe.subscriptions.retrieve(user.subscription_id, { expand: ['latest_invoice'] }).catch(() => null);
        if (subscription && stripeSubscriptionIsPaidPrecision(subscription)) return true;
        if (subscription) return false;
    }

    if (!user?.stripe_customer_id) return null;
    const subscriptions = await stripe.subscriptions.list({
        customer: user.stripe_customer_id,
        status: 'all',
        limit: 10,
        expand: ['data.latest_invoice']
    }).catch(() => null);

    if (!subscriptions) return null;
    return subscriptions.data.some(stripeSubscriptionIsPaidPrecision);
}

async function hasConfirmedPaidPrecisionAccess(user) {
    const status = String(user?.subscription_status || '').toLowerCase();
    if (user?.is_owner || user?.role === 'admin') return true;
    if (status !== 'active') return false;
    if (isExplicitNonPrecisionTier(user)) return false;
    const hasLocalPrecisionPlan = isPrecisionTier(user) || hasPaidPrecisionLimit(user);
    if (hasLocalPrecisionPlan && user?.subscription_paid_confirmed === true) return true;
    if (!hasLocalPrecisionPlan && !isPrecisionTierOrUnknown(user)) return false;

    const verified = await verifyStripePaidPrecisionAccess(user);
    if (verified !== null) return verified;
    return hasLocalPrecisionPlan || (user?.subscription_paid_confirmed === true && isPrecisionTierOrUnknown(user));
}

function asArray(value) {
    return Array.isArray(value) ? value : (value?.items || []);
}

function uniquePrecisionRouteHashes(routes) {
    const hashes = new Set();
    for (const route of routes) {
        if (!route || route.route_mode === 'canvas' || route.status === 'ARCHIVED') continue;
        for (const hash of route.property_hashes || []) {
            if (hash) hashes.add(hash);
        }
    }
    return [...hashes];
}

async function getPrecisionRouteHomeStats(base44, user) {
    const routesById = new Map();
    const routeQueries = [];
    if (user?.id) routeQueries.push(base44.asServiceRole.entities.SavedRoute.filter({ manager_id: user.id }, '-updated_date', 1000));
    if (user?.email) routeQueries.push(base44.asServiceRole.entities.SavedRoute.filter({ created_by: user.email }, '-updated_date', 1000));

    const results = await Promise.all(routeQueries.map(query => query.catch(() => [])));
    for (const result of results) {
        for (const route of asArray(result)) {
            routesById.set(route.id || `${route.created_by || ''}:${route.name || ''}:${route.created_date || ''}`, route);
        }
    }
    const hashes = uniquePrecisionRouteHashes([...routesById.values()]);
    return { count: hashes.length, hashes };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const polygon = normalizePolygon(body.polygon);
        const polygonError = polygonValidationError(polygon);
        if (polygonError) {
            return Response.json({ error: polygonError }, { status: 400 });
        }

        const areaSqMi = polygonAreaSqMi(polygon);
        const center = centroid(polygon);
        const polygonDigest = await polygonHash(polygon);
        const fips = await resolveFips(center);
        const isAdminTestOverride = user.role === 'admin' && body.test_account_type;
        const isPaid = isAdminTestOverride
            ? body.test_account_type === 'paid'
            : await hasConfirmedPaidPrecisionAccess(user);
        const routeHomeStats = await getPrecisionRouteHomeStats(base44, user);
        const existingRouteHomes = routeHomeStats.count;
        const existingFreeHomes = isPaid ? 0 : existingRouteHomes;
        const freeHomesRemaining = isPaid ? null : Math.max(0, FREE_PROPERTY_CAP - existingFreeHomes);
        const maxProperties = isPaid ? PAID_PROPERTY_CAP : freeHomesRemaining;
        const requestedRaw = Number(body.requested_properties || body.record_cap || maxProperties);
        const requestedProperties = maxProperties <= 0
            ? 0
            : Math.max(1, Math.min(Number.isFinite(requestedRaw) ? requestedRaw : maxProperties, maxProperties));
        const box = boundsMiles(polygon);
        const hardRejected = false; // Square mileage limits removed entirely for all accounts
        const rejectionReason = null;
        const costPerRecord = BATCHDATA_PLAN_COST / BATCHDATA_PLAN_RECORDS;
        // Maximum-recall discovery reads Intel and Sale separately before
        // de-duplication. This is a conservative provider-record ceiling, not a
        // promise of exact billing (the dashboard remains authoritative).
        const maxReviewedPerDateSource = Math.min(5000, Math.max(100, requestedProperties * 50));
        const paidPullCountProbeRecords = requestedProperties > 100 ? 2 : 0;
        const estimatedSearchRecordCeiling = (maxReviewedPerDateSource * 2) + paidPullCountProbeRecords;
        const estimatedMaxCost = estimatedSearchRecordCeiling * costPerRecord;
        const soldMonths = Number(body.sold_months || 12);
        const requestedMinPrice = Number(body.min_price);
        const requestedMaxPrice = Number(body.max_price);
        const effectiveMinPrice = Number.isFinite(requestedMinPrice) && requestedMinPrice > 0
            ? Math.max(DEFAULT_PRECISION_MIN_HOME_VALUE, requestedMinPrice)
            : DEFAULT_PRECISION_MIN_HOME_VALUE;
        const effectiveMaxPrice = Number.isFinite(requestedMaxPrice) && requestedMaxPrice > 0 ? requestedMaxPrice : null;
        if (effectiveMaxPrice !== null && effectiveMaxPrice < effectiveMinPrice) {
            return Response.json({
                error: 'invalid_price_range',
                message: `Maximum home value cannot be below the required $${effectiveMinPrice.toLocaleString()} minimum.`
            }, { status: 400 });
        }
        const liveCountProbe = body.live_count === true && !hardRejected
            ? await runLiveCountProbe(
                polygon,
                soldMonths,
                effectiveMinPrice,
                effectiveMaxPrice,
                `${polygonDigest}:${closedSaleWindow(soldWindowDays(soldMonths)).maxDate}:${soldWindowDays(soldMonths)}:${effectiveMinPrice}:${effectiveMaxPrice || 'none'}`,
                String(user.id || user.email || 'authenticated-user')
            )
            : null;
        const sandboxProbe = body.sandbox_probe === true && body.live_count !== true && !hardRejected ? await runSandboxProbe(center) : null;
        const providerCandidateCount = liveCountProbe?.ok ? liveCountProbe.candidate_count : null;
        const providerCountComplete = liveCountProbe?.predicate_counts_complete === true;
        const availableWithinPlan = providerCandidateCount === null
            ? requestedProperties
            : Math.min(providerCandidateCount, requestedProperties);

        return Response.json({
            success: true,
            mode: liveCountProbe ? 'live_count_preview' : 'sandbox_preview_no_paid_batchdata_charge',
            provider: 'batchdata',
            sandbox: !liveCountProbe,
            paid_pull_enabled: true,
            phase: 'phase_1_precision_preview',
            polygon_hash: polygonDigest,
            centroid: center,
            area_sq_mi: Number(areaSqMi.toFixed(2)),
            bounds_miles: {
                width: Number(box.width_miles.toFixed(2)),
                height: Number(box.height_miles.toFixed(2)),
                max_allowed_span: null
            },
            account_type: isPaid ? 'paid_or_admin' : 'free',
            max_area_sq_mi: null,
            max_allowed_properties: maxProperties,
            requested_properties: requestedProperties,
            existing_active_properties: existingRouteHomes,
            existing_route_homes: existingRouteHomes,
            excluded_route_home_count: existingRouteHomes,
            free_properties_remaining: freeHomesRemaining,
            sold_months: soldMonths,
            sold_min_date: liveCountProbe?.sold_min_date || null,
            provider_candidate_count: providerCandidateCount,
            provider_candidate_count_lower_bound: liveCountProbe?.candidate_count_lower_bound ?? providerCandidateCount,
            provider_candidate_count_upper_bound: liveCountProbe?.candidate_count_upper_bound ?? null,
            provider_count_is_exact_union: false,
            provider_count_is_complete: providerCountComplete,
            provider_predicate_counts: liveCountProbe?.predicate_counts || null,
            filters: {
                min_price: effectiveMinPrice,
                max_price: effectiveMaxPrice,
                standardized_land_use_code: 'R2',
                listing_status_categories_excluded: ['Active', 'Pending']
            },
            availability_status: providerCandidateCount === null
                ? 'unknown'
                : !providerCountComplete
                    ? 'count_incomplete'
                : providerCandidateCount === 0
                    ? 'no_candidates'
                    : soldWindowDays(soldMonths) < 14
                        ? 'limited_short_window'
                        : 'candidates_available',
            recommended_default_window_days: 30,
            returned_property_count: hardRejected ? 0 : availableWithinPlan,
            count_probe: liveCountProbe,
            count_probe_requests: liveCountProbe?.api_requests || 0,
            count_probe_credits: liveCountProbe?.billing_credits ?? null,
            count_probe_billing_status: liveCountProbe?.billing_status || 'not_requested',
            count_probe_cache_scope: 'best_effort_warm_serverless_instance',
            hard_rejected: hardRejected,
            rejection_reason: rejectionReason,
            county_resolution: fips,
            county_count_cap: MAX_COUNTIES_PER_PULL,
            sandbox_probe: sandboxProbe,
            estimated_batchdata_cost_per_record: costPerRecord,
            estimated_search_record_ceiling: estimatedSearchRecordCeiling,
            max_reviewed_per_date_source: maxReviewedPerDateSource,
            estimated_max_batchdata_cost: Number(estimatedMaxCost.toFixed(2)),
            pricing_context: {
                precision_price_per_user: PRECISION_PRICE_PER_USER,
                break_even_records_per_user: Math.floor(PRECISION_PRICE_PER_USER / costPerRecord),
                batchdata_plan_cost: BATCHDATA_PLAN_COST,
                batchdata_plan_records: BATCHDATA_PLAN_RECORDS
            },
            message: hardRejected
                ? 'Sandbox preview only. Redraw a smaller area before any live BatchData pull.'
                : liveCountProbe && !liveCountProbe.ok
                    ? `The area is valid, but BatchData availability could not be counted: ${liveCountProbe.error}`
                : requestedProperties <= 0
                    ? 'This account has already received its included 50 single-family Precision route homes. Upgrade to Precision for larger routes.'
                    : providerCandidateCount !== null && providerCountComplete
                        ? `BatchData reports at least ${providerCandidateCount.toLocaleString()} qualifying recent-sale candidates in this drawn area. The exact Intel/Sale union is de-duplicated during the paid record pull.`
                        : providerCandidateCount !== null
                            ? `BatchData returned a partial predicate count of ${providerCandidateCount.toLocaleString()}. The missing predicate remains unknown, so the paid Intel/Sale union is still available to run.`
                        : `This area is eligible to pull up to ${requestedProperties} BatchData properties from your drawn Precision territory.`
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
