import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.14.0';
import {
    maxRecallSearchRecordCeiling,
    normalizePrecisionHomeValueRange,
    optionalPositiveNumber,
    priorRouteMayShareCurrentSaleEvent
} from './valuePolicy.js';
import {
    buildPullElectionKey,
    coalescedFetchJobCancellationUpdate,
    conflictingFetchJobCancellationUpdate,
    resolveCreatedFetchJobElection,
    unverifiedFetchJobElectionCancellationUpdate
} from './jobElectionLogic.js';

const FREE_PROPERTY_CAP = 50;
const PAID_PROPERTY_CAP = 1000;
const PROCESSOR_START_WAIT_MS = 900;
const FETCH_JOB_ELECTION_SETTLE_MS = 50;
const JOB_MEMBERSHIP_CONTRACT = 'property_sources_v1';
const PRECISION_PIPELINE_CONTRACT = 'precision_generate_v2';
const DEFAULT_ROUTE_TYPE_FILTERS = {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true,
    excludeAssigned: true
};
const ALLOWED_ROUTE_PROPERTY_TYPES = new Set(['Single Family']);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

async function startProcessor(base44, jobId, expectedChunk = 0) {
    const invokePromise = base44.asServiceRole.functions.invoke('processFetchChunk', {
        job_id: jobId,
        expected_chunk: expectedChunk
    }).catch(error => {
        console.warn(`[startBatchDataPull] Background processor invoke failed: ${error.message}`);
    });
    await Promise.race([invokePromise, sleep(PROCESSOR_START_WAIT_MS)]);
}

async function updateFetchJobWithFallback(base44, jobId, update) {
    try {
        return await base44.asServiceRole.entities.FetchJob.update(jobId, update);
    } catch (serviceError) {
        try {
            return await base44.entities.FetchJob.update(jobId, update);
        } catch (userError) {
            throw new Error(`FetchJob ${jobId} update failed during election cleanup: ${serviceError.message}; ${userError.message}`);
        }
    }
}

function normalizePolygon(input) {
    if (!Array.isArray(input)) return [];
    return input
        .map(point => ({ lat: Number(point.lat), lng: Number(point.lng) }))
        .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function polygonValidationError(points) {
    if (points.length < 3) return 'At least 3 polygon points are required.';
    if (points.some(point => Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180)) {
        return 'Polygon coordinates are outside valid latitude/longitude bounds.';
    }
    const distinct = new Set(points.map(point => `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`));
    if (distinct.size < 3) return 'At least 3 distinct polygon points are required.';
    if (polygonAreaSqMi(points) <= 0.000001) return 'The drawn polygon has no usable area. Please redraw it.';
    return null;
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

function isPrecisionProUser(user) {
    const status = String(user?.subscription_status || '').toLowerCase();
    if (user?.is_owner || user?.role === 'admin') return true;
    if (!['active', 'trialing'].includes(status)) return false;
    return isPrecisionTier(user)
        || Number(user?.precision_property_limit || user?.monthly_property_limit || 0) > FREE_PROPERTY_CAP
        || (user?.subscription_paid_confirmed === true && isPrecisionTierOrUnknown(user));
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

function isPremiumRecentRange(soldMonths) {
    const months = Number(soldMonths || 12);
    return Number.isFinite(months) && months <= 1;
}

async function resolveFips(center) {
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
        // County metadata is useful for labels but is not part of the polygon search contract.
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

function asArray(value) {
    return Array.isArray(value) ? value : (value?.items || []);
}

function sameOptionalNumber(left, right) {
    const a = optionalPositiveNumber(left);
    const b = optionalPositiveNumber(right);
    return a === b;
}

function precisionSoldWindowDays(value) {
    const months = Number(value || 12);
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

function currentPhoenixDateOnly() {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function addIsoCalendarDays(value, days) {
    const date = new Date(`${value}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function precisionSaleWindowMinDate(soldMonths) {
    const yesterday = addIsoCalendarDays(currentPhoenixDateOnly(), -1);
    return addIsoCalendarDays(yesterday, -(precisionSoldWindowDays(soldMonths) - 1));
}

function precisionRouteHashState(routes, currentSaleWindowMinDate = null) {
    const allHashes = new Set();
    const latestRoutedAtByHash = new Map();
    for (const route of routes) {
        if (!route || route.route_mode === 'canvas' || route.status === 'ARCHIVED') continue;
        const routedAt = route?.metadata?.precision_area?.generated_at
            || route?.metadata?.precision_area?.last_pull_date
            || route?.metadata?.generated_at
            || route.created_date
            || route.updated_date
            || null;
        const routedDate = routedAt ? String(routedAt).slice(0, 10) : null;
        for (const hash of route.property_hashes || []) {
            if (!hash) continue;
            allHashes.add(hash);
            const existing = latestRoutedAtByHash.get(hash);
            if (!existing || (routedDate && routedDate > existing)) latestRoutedAtByHash.set(hash, routedDate);
        }
    }
    const excludedHashes = [...allHashes].filter(hash => {
        const routedDate = latestRoutedAtByHash.get(hash);
        return priorRouteMayShareCurrentSaleEvent(routedDate, currentSaleWindowMinDate);
    });
    return { allHashes: [...allHashes], excludedHashes };
}

async function getPrecisionRouteHomeStats(base44, user, { includeUnresolvedFollowups = false, currentSaleWindowMinDate = null } = {}) {
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
    const routeHashState = precisionRouteHashState([...routesById.values()], currentSaleWindowMinDate);
    const allHashes = routeHashState.allHashes;
    const excludedHashes = routeHashState.excludedHashes;
    const excludedSet = new Set(excludedHashes);
    const releasedHashes = allHashes.filter(hash => !excludedSet.has(hash));
    if (!includeUnresolvedFollowups || excludedHashes.length === 0) {
        return { count: allHashes.length, hashes: excludedHashes, event_released_hashes: releasedHashes, unresolved_hashes_included: [] };
    }

    const logQueries = [];
    if (user?.id) logQueries.push(base44.asServiceRole.entities.InteractionLog.filter({ manager_id: user.id }, '-created_date', 5000));
    if (user?.team_manager_id) logQueries.push(base44.asServiceRole.entities.InteractionLog.filter({ manager_id: user.team_manager_id }, '-created_date', 5000));
    if (user?.email) logQueries.push(base44.asServiceRole.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 5000));
    const logResults = await Promise.all(logQueries.map(query => query.catch(() => [])));
    const latestByHash = new Map();
    for (const result of logResults) {
        for (const log of asArray(result)) {
            const hash = String(log?.address_hash || '');
            if (!hash) continue;
            const timestamp = new Date(log.created_date || 0).getTime();
            const existing = latestByHash.get(hash);
            if (!existing || timestamp > existing.timestamp) {
                latestByHash.set(hash, { status: String(log.parsed_status || '').toUpperCase(), timestamp });
            }
        }
    }
    const unresolvedStatuses = new Set(['ELIGIBLE', 'NO_ANSWER', 'CALLBACK', 'DM_NOT_HOME', 'NOT_MOVED_IN']);
    const unresolvedHashes = new Set(
        excludedHashes.filter(hash => unresolvedStatuses.has(latestByHash.get(hash)?.status))
    );
    return {
        count: allHashes.length,
        hashes: excludedHashes.filter(hash => !unresolvedHashes.has(hash)),
        event_released_hashes: releasedHashes,
        unresolved_hashes_included: [...unresolvedHashes]
    };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({}));
        if (body.contract_probe === true) {
            return Response.json({
                success: true,
                precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
                component: 'startBatchDataPull',
                paid_provider_requests: 0
            });
        }
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const polygon = normalizePolygon(body.polygon);
        const polygonError = polygonValidationError(polygon);
        if (polygonError) {
            return Response.json({ error: polygonError }, { status: 400 });
        }

        const areaSqMi = polygonAreaSqMi(polygon);
        const center = centroid(polygon);
        const forceFreeForSelfTest = body.self_test_force_free === true && body.dry_run === true;
        const hasPaidPrecisionCapacity = !forceFreeForSelfTest && await hasConfirmedPaidPrecisionAccess(user);
        const hasPrecisionPro = !forceFreeForSelfTest && isPrecisionProUser(user);
        const requestedSoldMonths = Number(body.sold_months || 12);
        if (isPremiumRecentRange(requestedSoldMonths) && !hasPrecisionPro) {
            return Response.json({
                error: 'upgrade_required',
                message: '1 day, 2 day, 1 week, 2 week, and 1 month Precision pulls require a Pro plan.'
            }, { status: 403 });
        }
        const maxProperties = hasPaidPrecisionCapacity ? PAID_PROPERTY_CAP : FREE_PROPERTY_CAP;
        const requestedRaw = Number(body.requested_properties || maxProperties);
        const requestedValue = Math.max(1, Number.isFinite(requestedRaw) ? requestedRaw : maxProperties);
        if (!hasPaidPrecisionCapacity && requestedValue > FREE_PROPERTY_CAP) {
            return Response.json({
                error: 'paid_precision_required',
                message: 'That route size is above what your current plan includes. Start or upgrade to Precision to generate larger routes.'
            }, { status: 403 });
        }
        const includeUnresolvedFollowups = body.include_unresolved_followups === true;
        const routeFilters = normalizeRouteTypeFilters(body.route_filters || DEFAULT_ROUTE_TYPE_FILTERS);
        const currentSaleWindowMinDate = precisionSaleWindowMinDate(requestedSoldMonths);
        const routeHomeStats = forceFreeForSelfTest
            ? { count: 0, hashes: [], event_released_hashes: [], unresolved_hashes_included: [] }
            : await getPrecisionRouteHomeStats(base44, user, { includeUnresolvedFollowups, currentSaleWindowMinDate });
        const excludedRouteHashes = routeFilters.excludeAssigned ? routeHomeStats.hashes : [];
        const unresolvedFollowupHashes = routeHomeStats.unresolved_hashes_included;
        const eventReleasedPriorRouteHashes = routeHomeStats.event_released_hashes || [];
        const existingRouteHomes = routeHomeStats.count;
        const existingFreeHomes = hasPaidPrecisionCapacity ? 0 : existingRouteHomes;
        const freeHomesRemaining = hasPaidPrecisionCapacity
            ? null
            : Math.max(0, FREE_PROPERTY_CAP - existingFreeHomes);

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
        const searchExposure = maxRecallSearchRecordCeiling(requestedProperties);
        const limitedByFreeHomeCap = !hasPaidPrecisionCapacity && requestedProperties < requestedValue;
        const normalizedValueRange = normalizePrecisionHomeValueRange(body.min_price, body.max_price);
        const minPrice = normalizedValueRange.minimum;
        const maxPrice = normalizedValueRange.maximum;
        if (!normalizedValueRange.valid) {
            return Response.json({
                error: 'invalid_price_range',
                message: `Maximum home value cannot be below the required $${minPrice.toLocaleString()} minimum.`
            }, { status: 400 });
        }
        const fips = await resolveFips(center);
        const hash = await polygonHash(polygon);

        if (body.dry_run === true) {
            return Response.json({
                success: true,
                dry_run: true,
                precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
                provider: 'batchdata',
                fips_code: fips?.fips_code || null,
                county_resolution: fips || { status: 'unavailable_non_blocking' },
                requested_properties: requestedProperties,
                requested_properties_before_cap: requestedValue,
                limited_by_free_home_cap: limitedByFreeHomeCap,
                existing_active_properties: existingRouteHomes,
                existing_route_homes: existingRouteHomes,
                excluded_route_home_count: excludedRouteHashes.length,
                prior_route_event_window_min_date: currentSaleWindowMinDate,
                prior_route_hashes_released_for_possible_new_sale: eventReleasedPriorRouteHashes.length,
                event_released_prior_route_hashes: eventReleasedPriorRouteHashes,
                unresolved_followup_home_count: unresolvedFollowupHashes.length,
                free_properties_remaining: freeHomesRemaining,
                sold_months: requestedSoldMonths,
                previous_pull_date: body.previous_pull_date || null,
                include_unresolved_followups: includeUnresolvedFollowups,
                area_sq_mi: Number(areaSqMi.toFixed(2)),
                route_filters: routeFilters,
                estimated_search_record_ceiling: searchExposure.totalRecordCeiling,
                max_reviewed_per_date_source: searchExposure.maxReviewedPerSource,
                filters: {
                    min_price: minPrice,
                    max_price: maxPrice
                }
            });
        }

        const requestedCountMode = body.count_mode === 'max_available' ? 'max_available' : 'fixed';
        const pullElectionKey = buildPullElectionKey({
            polygonHash: hash,
            soldMonths: requestedSoldMonths,
            minPrice,
            maxPrice,
            requestedProperties,
            countMode: requestedCountMode,
            routeFilters,
            includeUnresolvedFollowups,
            forceFullRefresh: body.force_full_refresh === true,
            repullMode: body.repull_mode || 'new_area',
            previousPullDate: body.previous_pull_date || null
        });
        const runningJobs = await base44.entities.FetchJob.filter({ user_email: user.email, status: 'running' }, 'created_date', 100);
        const pendingJobs = await base44.entities.FetchJob.filter({ user_email: user.email, status: 'pending' }, 'created_date', 100);
        const runningList = Array.isArray(runningJobs) ? runningJobs : (runningJobs?.items || []);
        const pendingList = Array.isArray(pendingJobs) ? pendingJobs : (pendingJobs?.items || []);
        const existingJob = runningList[0] || pendingList[0];
        if (existingJob) {
            const existingPolygon = normalizePolygon(existingJob.polygon);
            // Recompute when vertices exist so jobs created with the previous
            // order-sensitive hash can still reattach during rollout.
            const existingHash = existingPolygon.length >= 3
                ? await polygonHash(existingPolygon)
                : (existingJob.polygon_hash || null);
            const existingFilters = existingJob.dry_run_metadata?.filters || {};
            const existingRouteFilters = normalizeRouteTypeFilters(existingJob.dry_run_metadata?.route_filters || DEFAULT_ROUTE_TYPE_FILTERS);
            const existingCountMode = existingJob.dry_run_metadata?.count_mode || 'fixed';
            const legacySameCriteria = existingHash === hash
                && Number(existingJob.sold_months || 12) === requestedSoldMonths
                && sameOptionalNumber(existingFilters.min_price, minPrice)
                && sameOptionalNumber(existingFilters.max_price, maxPrice)
                && Number(existingJob.total_expected || existingJob.estimated_record_count || 0) === requestedProperties
                && existingCountMode === requestedCountMode
                && existingRouteFilters.excludeAssigned === routeFilters.excludeAssigned
                && (existingJob.dry_run_metadata?.include_unresolved_followups === true) === includeUnresolvedFollowups
                && (existingJob.dry_run_metadata?.force_full_refresh === true) === (body.force_full_refresh === true)
                && String(existingJob.dry_run_metadata?.repull_mode || 'new_area') === String(body.repull_mode || 'new_area')
                && (existingJob.dry_run_metadata?.previous_pull_date || null) === (body.previous_pull_date || null);
            const existingElectionKey = existingJob.dry_run_metadata?.pull_election_key || null;
            const sameCriteria = existingElectionKey
                ? existingElectionKey === pullElectionKey
                : legacySameCriteria;
            if (!sameCriteria) {
                return Response.json({
                    error: 'different_pull_already_running',
                    active_job_id: existingJob.id,
                    active_polygon_hash: existingHash,
                    requested_polygon_hash: hash,
                    message: 'A different property pull is already running. Let it finish or cancel it before starting this area.'
                }, { status: 409 });
            }
            return Response.json({
                status: 'already_running',
                job_id: existingJob.id,
                precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
                polygon: existingPolygon,
                polygon_hash: existingHash,
                requested_properties: existingJob.total_expected || existingJob.estimated_record_count || requestedProperties,
                message: 'This exact property pull is already running; reattached to its progress.'
            });
        }

        const pullElectionRequestedAt = new Date().toISOString();
        const job = await base44.entities.FetchJob.create({
            status: 'pending',
            provider: 'batchdata',
            mode_tag: 'PRECISION_TARGET',
            phase: 'batchdata_precision',
            latitude: center.lat,
            longitude: center.lng,
            radius: Math.sqrt(areaSqMi / Math.PI),
            polygon,
            ...(fips?.fips_code ? { fips_code: fips.fips_code } : {}),
            area_sq_mi: Number(areaSqMi.toFixed(2)),
            polygon_hash: hash,
            estimated_record_count: requestedProperties,
            estimated_cost: Number((searchExposure.totalRecordCeiling * 0.01).toFixed(2)),
            dry_run_metadata: {
                job_membership_contract: JOB_MEMBERSHIP_CONTRACT,
                precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
                submitted_polygon: polygon,
                pull_election_key: pullElectionKey,
                pull_election_requested_at: pullElectionRequestedAt,
                county_resolution: fips || { status: 'unavailable_non_blocking' },
                requested_properties: requestedProperties,
                requested_properties_before_cap: requestedValue,
                limited_by_free_home_cap: limitedByFreeHomeCap,
                existing_active_properties: existingRouteHomes,
                existing_route_homes: existingRouteHomes,
                excluded_route_home_count: excludedRouteHashes.length,
                prior_route_event_window_min_date: currentSaleWindowMinDate,
                prior_route_hashes_released_for_possible_new_sale: eventReleasedPriorRouteHashes.length,
                event_released_prior_route_hashes: eventReleasedPriorRouteHashes,
                excluded_route_hashes: excludedRouteHashes,
                unresolved_followup_hashes_included: unresolvedFollowupHashes,
                free_properties_remaining: freeHomesRemaining,
                free_property_cap: FREE_PROPERTY_CAP,
                count_mode: requestedCountMode,
                repull_mode: body.repull_mode || 'new_area',
                previous_pull_date: body.previous_pull_date || null,
                force_full_refresh: body.force_full_refresh === true,
                include_unresolved_followups: includeUnresolvedFollowups,
                filters: {
                    min_price: minPrice,
                    max_price: maxPrice
                },
                route_filters: routeFilters,
                estimated_search_record_ceiling: searchExposure.totalRecordCeiling,
                max_reviewed_per_date_source: searchExposure.maxReviewedPerSource,
                paid_pull_started_at: new Date().toISOString()
            },
            sold_months: requestedSoldMonths,
            force_full_refresh: body.force_full_refresh === true,
            pull_mode: body.force_full_refresh === true ? 'full_refresh' : 'new_area',
            include_mls: false,
            user_email: user.email,
            progress_pct: 0,
            current_offset: 0,
            total_expected: requestedProperties,
            total_sub_circles: 1,
            completed_sub_circles: 0,
            total_batchdata_calls: 0
        });

        // The pre-create lookup is advisory: two requests can both observe no
        // active job. Re-read after creation and deterministically elect one
        // exact-criteria job before either request is allowed to start work.
        const createdJobForElection = {
            ...job,
            status: job.status || 'pending',
            dry_run_metadata: {
                ...(job.dry_run_metadata || {}),
                pull_election_key: pullElectionKey,
                pull_election_requested_at: pullElectionRequestedAt
            }
        };
        await sleep(FETCH_JOB_ELECTION_SETTLE_MS);
        let postCreateRunning;
        let postCreatePending;
        try {
            [postCreateRunning, postCreatePending] = await Promise.all([
                base44.asServiceRole.entities.FetchJob.filter({ user_email: user.email, status: 'running' }, 'created_date', 100),
                base44.asServiceRole.entities.FetchJob.filter({ user_email: user.email, status: 'pending' }, 'created_date', 100)
            ]);
        } catch (error) {
            await updateFetchJobWithFallback(
                base44,
                job.id,
                unverifiedFetchJobElectionCancellationUpdate(createdJobForElection, error.message)
            );
            return Response.json({
                error: 'pull_election_unverified',
                cancelled_job_id: job.id,
                message: 'The pull was not started because its duplicate-job election could not be verified. Please retry.'
            }, { status: 503 });
        }
        const election = await resolveCreatedFetchJobElection({
            createdJob: createdJobForElection,
            contenders: [...asArray(postCreateRunning), ...asArray(postCreatePending)],
            electionKey: pullElectionKey,
            cancelOwnJob: async (createdJob, canonicalJob, relationship) => {
                await updateFetchJobWithFallback(
                    base44,
                    createdJob.id,
                    relationship === 'exact_duplicate'
                        ? coalescedFetchJobCancellationUpdate(createdJob, canonicalJob)
                        : conflictingFetchJobCancellationUpdate(createdJob, canonicalJob)
                );
            }
        });

        if (!election.isWinner) {
            const canonicalJob = election.canonicalJob;
            if (election.relationship === 'different_criteria') {
                return Response.json({
                    error: 'different_pull_already_running',
                    active_job_id: canonicalJob.id,
                    active_polygon_hash: canonicalJob.polygon_hash || null,
                    requested_polygon_hash: hash,
                    cancelled_job_id: job.id,
                    message: 'A different property pull won the active-job election. Let it finish or cancel it before starting this area.'
                }, { status: 409 });
            }
            return Response.json({
                status: 'already_running',
                job_id: canonicalJob.id,
                precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
                polygon: normalizePolygon(canonicalJob.polygon),
                polygon_hash: canonicalJob.polygon_hash || hash,
                requested_properties: canonicalJob.total_expected || canonicalJob.estimated_record_count || requestedProperties,
                coalesced_from_job_id: job.id,
                message: 'This exact property pull was coalesced into the canonical active job.'
            });
        }

        await startProcessor(base44, job.id, 0);

        return Response.json({
            success: true,
            status: 'started',
            job_id: job.id,
            precision_pipeline_contract: PRECISION_PIPELINE_CONTRACT,
            polygon,
            polygon_hash: hash,
            provider: 'batchdata',
            requested_properties: requestedProperties,
            requested_properties_before_cap: requestedValue,
            limited_by_free_home_cap: limitedByFreeHomeCap,
            existing_route_homes: existingRouteHomes,
            excluded_route_home_count: excludedRouteHashes.length,
            unresolved_followup_home_count: unresolvedFollowupHashes.length,
            free_properties_remaining: freeHomesRemaining,
            route_filters: routeFilters,
            message: `Precision pull started for up to ${requestedProperties} properties.`
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
