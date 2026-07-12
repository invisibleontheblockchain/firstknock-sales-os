import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Stripe from 'npm:stripe@14.14.0';

const FREE_AREA_LIMIT_SQ_MI = 40;
const PAID_AREA_LIMIT_SQ_MI = 300;
const FREE_PROPERTY_CAP = 50;
const PAID_PROPERTY_CAP = 1000;
const PROCESSOR_START_WAIT_MS = 900;
const PRECISION_TIERS = new Set(['pro', 'precision', 'growth', 'enterprise']);
const NON_PRECISION_TIERS = new Set(['canvas', 'hustler']);
const DEFAULT_ROUTE_TYPE_FILTERS = {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
};
const ALLOWED_ROUTE_PROPERTY_TYPES = new Set(['Single Family']);

function normalizedTier(user) {
    return String(user?.subscription_tier || '').trim().toLowerCase();
}

function hasPaidPrecisionLimit(user) {
    const limit = Number(user?.precision_property_limit || user?.monthly_property_limit || 0);
    return Number.isFinite(limit) && limit > FREE_PROPERTY_CAP;
}

function isPrecisionTier(user) {
    return PRECISION_TIERS.has(normalizedTier(user));
}

function isExplicitNonPrecisionTier(user) {
    return NON_PRECISION_TIERS.has(normalizedTier(user));
}

function isPrecisionTierOrUnknown(user) {
    const tier = normalizedTier(user);
    if (isPrecisionTier(user)) return true;
    if (isExplicitNonPrecisionTier(user)) return false;
    if (hasPaidPrecisionLimit(user)) return true;
    return !tier || tier === 'custom';
}

function isPrecisionProUser(user) {
    const status = String(user?.subscription_status || '').toLowerCase();
    if (user?.is_owner || user?.role === 'admin') return true;
    if (!['active', 'trialing'].includes(status)) return false;
    return isPrecisionTier(user)
        || hasPaidPrecisionLimit(user)
        || (user?.subscription_paid_confirmed === true && isPrecisionTierOrUnknown(user));
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

function isPremiumRecentRange(soldMonths) {
    const months = Number(soldMonths || 12);
    return Number.isFinite(months) && months <= 1;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function startProcessor(base44, jobId, expectedChunk = 0, processorToken = null) {
    const invokePromise = base44.asServiceRole.functions.invoke('processFetchChunk', {
        job_id: jobId,
        expected_chunk: expectedChunk,
        processor_token: processorToken
    }).catch(error => {
        console.warn(`[fetchAreaProperties] BatchData processor invoke failed: ${error.message}`);
    });
    await Promise.race([invokePromise, sleep(PROCESSOR_START_WAIT_MS)]);
}

function normalizePolygon(input) {
    if (!Array.isArray(input)) return [];
    return input.map(point => ({ lat: Number(point.lat), lng: Number(point.lng) })).filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
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
    return {
        lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
        lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length
    };
}

function boundsMiles(points) {
    const lats = points.map(p => p.lat);
    const lngs = points.map(p => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const midLat = (minLat + maxLat) / 2;
    return {
        width_miles: Math.abs(maxLng - minLng) * 69.0 * Math.cos(midLat * Math.PI / 180),
        height_miles: Math.abs(maxLat - minLat) * 69.0
    };
}

async function resolveFips(center) {
    const url = `https://geo.fcc.gov/api/census/block/find?latitude=${encodeURIComponent(center.lat)}&longitude=${encodeURIComponent(center.lng)}&format=json`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return {
        fips_code: data?.County?.FIPS || null,
        county_name: data?.County?.name || null,
        state_code: data?.State?.code || null,
        state_name: data?.State?.name || null
    };
}

async function polygonHash(points) {
    const normalized = points.map(p => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))]);
    const bytes = new TextEncoder().encode(JSON.stringify(normalized));
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function parseOwnershipRange(body = {}) {
    const rawMode = body.ownership_range_mode;
    const mode = rawMode === undefined || rawMode === null || rawMode === '' ? 'quick' : String(rawMode);
    if (!['quick', 'custom'].includes(mode)) {
        return { error: 'ownership_range_mode must be either quick or custom.' };
    }
    if (mode === 'quick') return { mode, range: null };

    const min = Number(body.ownership_min_days);
    const max = Number(body.ownership_max_days);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 365 || min >= max) {
        return { error: 'Custom ownership range requires whole-day minimum and maximum values from 1 to 365, with minimum less than maximum.' };
    }
    return { mode, range: { min, max } };
}

function legacySoldMonthsForOwnershipRange(ownership, fallbackSoldMonths) {
    if (ownership.mode === 'custom') {
        return ownership.range.max === 365 ? 12 : ownership.range.max / 30;
    }
    return Number(fallbackSoldMonths || 12);
}

function ownershipResponseFields(ownership) {
    return {
        ownership_range_mode: ownership.mode,
        ownership_min_days: ownership.range?.min ?? null,
        ownership_max_days: ownership.range?.max ?? null,
        ownership_range_days: ownership.range || null
    };
}

function ownershipFromJob(job) {
    const metadata = job?.dry_run_metadata || {};
    if (metadata.ownership_range_mode !== 'custom') return { mode: 'quick', range: null };
    const min = Number(metadata.ownership_range_days?.min);
    const max = Number(metadata.ownership_range_days?.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 365 || min >= max) {
        throw new Error('The active FetchJob has invalid custom ownership range metadata.');
    }
    return { mode: 'custom', range: { min, max } };
}

function sameCustomOwnershipRange(left, right) {
    return left?.mode === 'custom' && right?.mode === 'custom' &&
        left.range?.min === right.range?.min && left.range?.max === right.range?.max;
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
        if (polygon.length < 3) {
            return Response.json({ error: 'Precision pulls now require a freehand drawn polygon.' }, { status: 400 });
        }

        const areaSqMi = polygonAreaSqMi(polygon);
        const center = centroid(polygon);
        const hasPaidPrecisionCapacity = await hasConfirmedPaidPrecisionAccess(user);
        const ownership = parseOwnershipRange(body);
        if (ownership.error) {
            return Response.json({ error: 'invalid_ownership_range', message: ownership.error }, { status: 400 });
        }
        if (ownership.mode === 'custom' && !isPrecisionProUser(user)) {
            return Response.json({ error: 'upgrade_required', message: 'Custom ownership ranges require a Precision Pro plan.' }, { status: 403 });
        }
        const requestedSoldMonths = legacySoldMonthsForOwnershipRange(ownership, body.sold_months);
        if (ownership.mode === 'quick' && isPremiumRecentRange(requestedSoldMonths) && !isPrecisionProUser(user)) {
            return Response.json({
                error: 'upgrade_required',
                message: '1 day, 2 day, 1 week, 2 week, and 1 month Precision pulls require a Pro plan.'
            }, { status: 403 });
        }
        const maxArea = hasPaidPrecisionCapacity ? PAID_AREA_LIMIT_SQ_MI : FREE_AREA_LIMIT_SQ_MI;
        const maxProperties = hasPaidPrecisionCapacity ? PAID_PROPERTY_CAP : FREE_PROPERTY_CAP;
        const requestedRaw = Number(body.requested_properties || body.record_cap || maxProperties);
        const requestedValue = Math.max(1, Number.isFinite(requestedRaw) ? requestedRaw : maxProperties);
        if (!hasPaidPrecisionCapacity && requestedValue > FREE_PROPERTY_CAP) {
            return Response.json({
                error: 'paid_precision_required',
                message: 'That route size is above what your current plan includes. Start or upgrade to Precision to generate larger routes.'
            }, { status: 403 });
        }
        const routeHomeStats = await getPrecisionRouteHomeStats(base44, user);
        const existingRouteHomes = routeHomeStats.count;
        const freeHomesRemaining = hasPaidPrecisionCapacity
            ? null
            : Math.max(0, FREE_PROPERTY_CAP - existingRouteHomes);
        if (!hasPaidPrecisionCapacity && freeHomesRemaining <= 0) {
            return Response.json({
                error: 'paid_precision_required',
                message: 'This account has already received its included 50 single-family Precision route homes. Upgrade to Precision for larger routes.'
            }, { status: 403 });
        }
        const effectiveMaxProperties = hasPaidPrecisionCapacity
            ? maxProperties
            : Math.min(maxProperties, freeHomesRemaining);
        const requestedProperties = Math.max(1, Math.min(requestedValue, effectiveMaxProperties));
        const limitedByFreeHomeCap = !hasPaidPrecisionCapacity && requestedProperties < requestedValue;
        const minPriceRaw = Number(body.min_price);
        const maxPriceRaw = Number(body.max_price);
        const minPrice = Number.isFinite(minPriceRaw) && minPriceRaw > 0 ? minPriceRaw : 100000;
        const maxPrice = Number.isFinite(maxPriceRaw) && maxPriceRaw > 0 ? maxPriceRaw : null;
        const routeFilters = normalizeRouteTypeFilters(body.route_filters || DEFAULT_ROUTE_TYPE_FILTERS);
        const box = boundsMiles(polygon);
        const maxSpanMiles = hasPaidPrecisionCapacity ? 35 : 15;

        const fips = await resolveFips(center);
        if (!fips?.fips_code) {
            return Response.json({ error: 'Could not resolve county/FIPS for this area. Please redraw inside a supported US county.' }, { status: 400 });
        }

        if (body.dry_run === true) {
            return Response.json({
                status: 'dry_run',
                provider: 'batchdata',
                phase: 'batchdata_precision',
                fips_code: fips.fips_code,
                area_sq_mi: Number(areaSqMi.toFixed(2)),
                requested_properties: requestedProperties,
                requested_properties_before_cap: requestedValue,
                limited_by_free_home_cap: limitedByFreeHomeCap,
                existing_route_homes: existingRouteHomes,
                excluded_route_home_count: existingRouteHomes,
                free_properties_remaining: freeHomesRemaining,
                sold_months: requestedSoldMonths,
                ...ownershipResponseFields(ownership),
                filters: { min_price: minPrice, max_price: maxPrice },
                route_filters: routeFilters,
                message: 'Dry run only — BatchData-only Precision path validated without creating a FetchJob.'
            });
        }

        const runningJobs = await base44.entities.FetchJob.filter({ user_email: user.email, status: 'running' }, null, 5);
        const pendingJobs = await base44.entities.FetchJob.filter({ user_email: user.email, status: 'pending' }, null, 5);
        const activeJob = (Array.isArray(runningJobs) ? runningJobs : runningJobs?.items || [])[0] || (Array.isArray(pendingJobs) ? pendingJobs : pendingJobs?.items || [])[0];
        const requestedCustomPolygonHash = ownership.mode === 'custom' ? await polygonHash(polygon) : null;
        if (activeJob) {
            const activeMetadata = activeJob.dry_run_metadata || {};
            const activeOwnership = ownershipFromJob(activeJob);
            const activePolygonHash = activeJob.polygon_hash || (
                Array.isArray(activeJob.polygon) && activeJob.polygon.length >= 3
                    ? await polygonHash(activeJob.polygon)
                    : null
            );
            if (ownership.mode === 'custom' && (
                !sameCustomOwnershipRange(ownership, activeOwnership) ||
                !requestedCustomPolygonHash ||
                requestedCustomPolygonHash !== activePolygonHash
            )) {
                return Response.json({
                    error: 'active_job_criteria_conflict',
                    message: 'A different property import is already running. Your custom ownership-range request was not started or replaced. Wait for the current import to finish or cancel it, then submit this custom range again.',
                    requested_ownership_range_days: ownership.range,
                    active_ownership_range_days: activeOwnership.range,
                    active_job_id: activeJob.id
                }, { status: 409 });
            }
            return Response.json({
                status: 'already_running',
                job_id: activeJob.id,
                message: 'A data pull is already running. Resuming that pull with its original criteria.',
                polygon: activeJob.polygon || [],
                requested_properties: activeMetadata.requested_properties ?? activeJob.total_expected ?? null,
                sold_months: Number(activeJob.sold_months || 12),
                min_price: activeMetadata.filters?.min_price ?? null,
                max_price: activeMetadata.filters?.max_price ?? null,
                route_filters: activeMetadata.route_filters || null,
                count_mode: activeMetadata.count_mode || null,
                ...ownershipResponseFields(activeOwnership)
            });
        }

        const hash = requestedCustomPolygonHash || await polygonHash(polygon);
        const processorToken = crypto.randomUUID();
        const job = await base44.asServiceRole.entities.FetchJob.create({
            status: 'pending',
            provider: 'batchdata',
            mode_tag: 'PRECISION_TARGET',
            phase: 'batchdata_precision',
            latitude: center.lat,
            longitude: center.lng,
            radius: Math.sqrt(areaSqMi / Math.PI),
            polygon,
            fips_code: fips.fips_code,
            area_sq_mi: Number(areaSqMi.toFixed(2)),
            polygon_hash: hash,
            estimated_record_count: requestedProperties,
            estimated_cost: Number((requestedProperties * 0.01).toFixed(2)),
            dry_run_metadata: {
                county_resolution: fips,
                requested_properties: requestedProperties,
                requested_properties_before_cap: requestedValue,
                limited_by_free_home_cap: limitedByFreeHomeCap,
                existing_route_homes: existingRouteHomes,
                excluded_route_home_count: existingRouteHomes,
                excluded_route_hashes: routeHomeStats.hashes,
                free_properties_remaining: freeHomesRemaining,
                free_property_cap: FREE_PROPERTY_CAP,
                count_mode: body.count_mode === 'max_available' ? 'max_available' : 'fixed',
                filters: {
                    min_price: minPrice,
                    max_price: maxPrice
                },
                route_filters: routeFilters,
                ownership_range_mode: ownership.mode,
                ownership_range_days: ownership.range,
                processor_token: processorToken,
                batchdata_only_started_at: new Date().toISOString()
            },
            sold_months: requestedSoldMonths,
            include_mls: false,
            pull_mode: 'new_area',
            user_email: user.email,
            progress_pct: 0,
            current_offset: 0,
            total_expected: requestedProperties,
            total_sub_circles: 1,
            completed_sub_circles: 0,
            total_batchdata_calls: 0,
            error_log: [],
            chunk_timings: []
        });

        await startProcessor(base44, job.id, 0, processorToken);

        return Response.json({
            status: 'started',
            job_id: job.id,
            provider: 'batchdata',
            phase: 'batchdata_precision',
            requested_properties: requestedProperties,
            requested_properties_before_cap: requestedValue,
            limited_by_free_home_cap: limitedByFreeHomeCap,
            existing_route_homes: existingRouteHomes,
            excluded_route_home_count: existingRouteHomes,
            free_properties_remaining: freeHomesRemaining,
            sold_months: requestedSoldMonths,
            filters: { min_price: minPrice, max_price: maxPrice },
            route_filters: routeFilters,
            ...ownershipResponseFields(ownership),
            message: `BatchData Precision pull started for up to ${requestedProperties} properties.`
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
