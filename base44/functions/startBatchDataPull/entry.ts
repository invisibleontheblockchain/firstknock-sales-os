import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { Client } from 'npm:@neondatabase/serverless@0.9.0';
import Stripe from 'npm:stripe@14.14.0';
import { UNLIMITED_PROPERTY_CAP, currentGrantPeriod, precisionGrantLabel, precisionGrantLimit } from '../../shared/privilegedAccounts.js';
import {
    ACTIVE_PRECISION_STATUSES,
    classifyActivePrecisionJobs,
    isPrecisionJob,
    normalizePrecisionPolygon,
    normalizeRequestedCount,
    requestedOrder,
    resolveEffectiveCount,
    selectOwnedPrecisionJobs
} from '../../shared/precisionOrderSafety.js';
import { loadAuthoritativeUser } from '../../shared/accountIdentity.js';
import {
    calculatePrecisionCreditState,
    isPaidPrecisionCreditInvoice,
    listPrecisionCreditLedger
} from '../../shared/precisionCredits.js';

const FREE_PROPERTY_CAP = 50;
const PAID_PROPERTY_CAP = 1000;
// Granted accounts have no practical property cap. The ceiling is a large
// finite number rather than Infinity/MAX_SAFE_INTEGER because the reservation,
// expected-count and progress math all persist this value on the FetchJob.
// Empty UNLIMITED_PRECISION_EMAILS in shared/privilegedAccounts.js to restore
// the normal 1,000-properties-per-period paid cap for everyone.
const PROCESSOR_START_WAIT_MS = 900;
const PRECISION_PRICE_FLOOR_CENTS = 9900;
const DEFAULT_ROUTE_TYPE_FILTERS = {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
};
const ALLOWED_ROUTE_PROPERTY_TYPES = new Set(['Single Family']);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Starting a pull issues many platform reads at once, so a short burst can trip
// the app-wide request limit and surface as a failed import. Transient rate
// limits are retried with backoff; every other error still fails immediately.
function isRateLimitError(error) {
    const status = Number(error?.status ?? error?.response?.status);
    if (status === 429) return true;
    return /rate limit/i.test(String(error?.message || ''));
}

async function withRateLimitRetry(action, attempts = 4) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await action();
        } catch (error) {
            if (attempt >= attempts || !isRateLimitError(error)) throw error;
            await sleep(250 * 2 ** (attempt - 1));
        }
    }
}

async function withPrecisionUsageLock(userId, action) {
    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) throw new Error('Precision usage locking is unavailable.');
    const client = new Client(databaseUrl);
    await client.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`precision-usage:${userId}`]);
        const result = await action();
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
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

async function startProcessor(base44, jobId, expectedChunk = 0, processorToken = null) {
    const invokePromise = base44.asServiceRole.functions.invoke('processFetchChunk', {
        job_id: jobId,
        expected_chunk: expectedChunk,
        processor_token: processorToken
    }).catch(error => {
        console.warn(`[startBatchDataPull] Background processor invoke failed: ${error.message}`);
    });
    await Promise.race([invokePromise, sleep(PROCESSOR_START_WAIT_MS)]);
}

function normalizeRoutePoint(input) {
    if (!input || input.lat === null || input.lat === undefined || input.lat === '' || input.lng === null || input.lng === undefined || input.lng === '') {
        return null;
    }
    const lat = Number(input?.lat);
    const lng = Number(input?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return null;
    }
    return { lat, lng };
}

function normalizeRouteBounds(input) {
    if (!input || input.enabled !== true) return { enabled: false };
    const mode = input.mode === 'current_to_home' ? 'current_to_home' : 'home_round_trip';
    const startLocation = normalizeRoutePoint(input.startLocation || input.start_location);
    const endLocation = normalizeRoutePoint(input.endLocation || input.end_location);
    if (!startLocation || !endLocation) return null;
    return {
        enabled: true,
        mode,
        start_location: startLocation,
        end_location: endLocation
    };
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

function stripeTimestampIso(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function betaPrecisionEvidence(user) {
    const grantEmail = user?.email?.toLowerCase();
    // Server grants bypass Stripe and card-on-file requirements by design.
    const grantedLimit = precisionGrantLimit(user);
    if (grantedLimit !== null) {
        return {
            kind: 'beta',
            paidAccess: true,
            proAccess: true,
            limit: grantedLimit,
            precisionLimit: grantedLimit,
            subscriptionId: precisionGrantLabel(grantedLimit),
            invoiceId: null,
            ...currentGrantPeriod()
        };
    }
    if (grantEmail === 'baysecurity@gmail.com' || grantEmail === 'kevin@reifenvironmental.com') {
        return {
            kind: 'beta',
            paidAccess: true,
            proAccess: true,
            limit: 1000,
            precisionLimit: 1000,
            subscriptionId: 'system_admin_grant',
            invoiceId: null,
            ...currentGrantPeriod()
        };
    }
    const rawGrants = Deno.env.get('BETA_ACCESS_GRANTS');
    if (!rawGrants || user?.id === undefined || user?.id === null) return null;

    let document;
    try {
        document = JSON.parse(rawGrants);
    } catch {
        return null;
    }

    if (!document || typeof document !== 'object' || Array.isArray(document) || document.version !== 1 || !document.grants || typeof document.grants !== 'object' || Array.isArray(document.grants)) {
        return null;
    }

    const immutableUserId = String(user.id);
    if (!Object.prototype.hasOwnProperty.call(document.grants, immutableUserId)) return null;
    const grant = document.grants[immutableUserId];
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return null;
    const grantId = typeof grant?.grant_id === 'string' ? grant.grant_id.trim() : '';
    const precisionLimit = grant?.precision_limit;
    const canvasSeats = grant?.canvas_seats;
    const periodStartMs = typeof grant?.starts_at === 'string' ? Date.parse(grant.starts_at) : NaN;
    const periodEndMs = typeof grant?.ends_at === 'string' ? Date.parse(grant.ends_at) : NaN;
    const now = Date.now();

    if (
        grant?.status !== 'active' ||
        !grantId ||
        !Number.isSafeInteger(precisionLimit) || precisionLimit <= 0 || precisionLimit > PAID_PROPERTY_CAP ||
        !Number.isSafeInteger(canvasSeats) || canvasSeats <= 0 || canvasSeats > 100 ||
        !Number.isFinite(periodStartMs) || !Number.isFinite(periodEndMs) || periodStartMs >= periodEndMs ||
        now < periodStartMs || now >= periodEndMs
    ) {
        return null;
    }

    return {
        kind: 'beta',
        paidAccess: true,
        proAccess: true,
        subscriptionId: grantId,
        invoiceId: null,
        periodStart: new Date(periodStartMs).toISOString(),
        periodEnd: new Date(periodEndMs).toISOString(),
        precisionLimit
    };
}

function invoiceCoversCurrentPeriod(subscription, invoice) {
    const currentStart = Number(subscription?.current_period_start);
    if (!Number.isFinite(currentStart) || currentStart <= 0) return false;
    const lineMatches = (invoice?.lines?.data || []).some(line => {
        const lineSubscription = typeof line?.subscription === 'string' ? line.subscription : line?.subscription?.id;
        const start = Number(line?.period?.start);
        const end = Number(line?.period?.end);
        return (!lineSubscription || lineSubscription === subscription.id)
            && Number.isFinite(start) && Number.isFinite(end)
            && start <= currentStart && currentStart < end;
    });
    if (lineMatches) return true;
    const start = Number(invoice?.period_start);
    const end = Number(invoice?.period_end);
    return Number.isFinite(start) && Number.isFinite(end) && start <= currentStart && currentStart < end;
}

function paidPrecisionEvidence(subscription, userId) {
    if (!subscription || String(subscription?.metadata?.base44_user_id || '') !== String(userId)) return null;
    const amountCents = Math.max(0, ...(subscription.items?.data || []).map(item => Number(item?.price?.unit_amount || 0)));
    const invoice = subscription.latest_invoice;
    const invoiceSubscriptionId = typeof invoice?.subscription === 'string' ? invoice.subscription : invoice?.subscription?.id;
    const trialEnded = !subscription.trial_end || Number(subscription.trial_end) * 1000 <= Date.now();
    if (subscription.status !== 'active' || !trialEnded || amountCents < PRECISION_PRICE_FLOOR_CENTS) return null;
    if (!invoice || typeof invoice === 'string' || invoice.status !== 'paid' || Number(invoice.amount_paid || 0) <= 0) return null;
    if (invoiceSubscriptionId && invoiceSubscriptionId !== subscription.id) return null;
    if (!invoiceCoversCurrentPeriod(subscription, invoice) && !isPaidPrecisionCreditInvoice(invoice)) return null;
    const periodStart = stripeTimestampIso(subscription.current_period_start);
    const periodEnd = stripeTimestampIso(subscription.current_period_end);
    if (!periodStart || !periodEnd) return null;
    return { kind: 'paid', paidAccess: true, proAccess: true, subscriptionId: subscription.id, invoiceId: invoice.id || null, periodStart, periodEnd };
}

function trialPrecisionEvidence(subscription, userId) {
    if (!subscription || String(subscription?.metadata?.base44_user_id || '') !== String(userId)) return null;
    const amountCents = Math.max(0, ...(subscription.items?.data || []).map(item => Number(item?.price?.unit_amount || 0)));
    return subscription.status === 'trialing' && amountCents >= PRECISION_PRICE_FLOOR_CENTS
        ? { kind: 'trial', paidAccess: false, proAccess: true, subscriptionId: subscription.id, invoiceId: null, periodStart: null, periodEnd: null }
        : null;
}

async function resolvePrecisionEntitlement(user) {
    const beta = betaPrecisionEvidence(user);
    if (beta) return beta;

    const secret = Deno.env.get('STRIPE_SECRET_KEY');
    if (!secret) throw new Error('Stripe billing verification is unavailable.');
    const stripe = new Stripe(secret);
    const candidates = new Map();
    if (user?.subscription_id) {
        try {
            const subscription = await stripe.subscriptions.retrieve(String(user.subscription_id), { expand: ['latest_invoice'] });
            candidates.set(subscription.id, subscription);
        } catch (error) {
            if (error?.raw?.code !== 'resource_missing' && error?.code !== 'resource_missing') throw error;
        }
    }
    if (user?.stripe_customer_id) {
        const listed = await stripe.subscriptions.list({ customer: String(user.stripe_customer_id), status: 'all', limit: 20, expand: ['data.latest_invoice'] });
        for (const subscription of listed.data || []) candidates.set(subscription.id, subscription);
    }
    const orderedCandidates = () => [...candidates.values()].sort((left, right) =>
        Number(right.current_period_start || right.created || 0) - Number(left.current_period_start || left.created || 0)
        || String(left.id || '').localeCompare(String(right.id || ''))
    );
    let paid = orderedCandidates().map(subscription => paidPrecisionEvidence(subscription, user.id)).find(Boolean);
    if (!paid && typeof stripe.subscriptions.search === 'function') {
        const escapedUserId = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const discovered = await stripe.subscriptions.search({
            query: `metadata['base44_user_id']:'${escapedUserId}'`,
            limit: 20,
            expand: ['data.latest_invoice']
        });
        for (const subscription of discovered.data || []) candidates.set(subscription.id, subscription);
        paid = orderedCandidates().map(subscription => paidPrecisionEvidence(subscription, user.id)).find(Boolean);
    }
    if (paid) return paid;
    for (const subscription of orderedCandidates()) {
        const trial = trialPrecisionEvidence(subscription, user.id);
        if (trial) return trial;
    }
    return { kind: 'trial', paidAccess: false, proAccess: false, subscriptionId: null, invoiceId: null, periodStart: null, periodEnd: null };
}

function isPremiumRecentRange(soldMonths) {
    const months = Number(soldMonths || 12);
    return Number.isFinite(months) && months <= 1;
}

function parseOwnershipRange(body = {}) {
    const rawMode = body.ownership_range_mode;
    const mode = rawMode === undefined || rawMode === null || rawMode === '' ? 'quick' : String(rawMode);
    if (!['quick', 'custom'].includes(mode)) {
        return { error: 'ownership_range_mode must be either quick or custom.' };
    }
    if (mode === 'quick') {
        return { mode, range: null };
    }

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

function asArray(value) {
    return Array.isArray(value) ? value : (value?.items || []);
}

async function listAll(entity, filter, sort = '-created_date', pageSize = 500) {
    const records = [];
    for (let skip = 0; skip < 20000; skip += pageSize) {
        const page = await withRateLimitRetry(() => entity.filter(filter, sort, pageSize, skip));
        const items = asArray(page);
        records.push(...items);
        if (items.length < pageSize) return records;
    }
    throw new Error('Precision history exceeds the supported usage window.');
}

function precisionRouteHashStats(routes) {
    const lifetime = new Set();
    for (const route of routes) {
        if (!route || route.route_mode === 'canvas') continue;
        for (const hash of route.property_hashes || []) {
            if (!hash) continue;
            lifetime.add(hash);
        }
    }
    return { count: lifetime.size, hashes: [...lifetime] };
}

async function getPrecisionRouteHomeStats(base44, user) {
    const routesById = new Map();
    const routeQueries = [];
    if (user?.id) routeQueries.push(listAll(base44.asServiceRole.entities.SavedRoute, { manager_id: user.id }));
    if (user?.email) routeQueries.push(listAll(base44.asServiceRole.entities.SavedRoute, { created_by: user.email }));

    const results = await Promise.all(routeQueries);
    for (const result of results) {
        for (const route of asArray(result)) {
            routesById.set(route.id || `${route.created_by || ''}:${route.name || ''}:${route.created_date || ''}`, route);
        }
    }
    return precisionRouteHashStats([...routesById.values()]);
}

function asTimestamp(value) {
    const timestamp = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
}

function legacyCompletedCount(job) {
    const active = Number(job?.dry_run_metadata?.batchdata_summary?.active);
    if (Number.isFinite(active) && active >= 0) return Math.floor(active);
    const expected = Math.max(0, Math.floor(Number(job?.total_expected || job?.estimated_record_count || 0)));
    const delivered = Math.max(0, Math.floor(Number(job?.total_inserted || 0))) + Math.max(0, Math.floor(Number(job?.total_existed || 0)));
    return expected > 0 ? Math.min(expected, delivered) : delivered;
}

function jobUsage(job) {
    if (job?.precision_usage_recorded_at) return { used: Math.max(0, Math.floor(Number(job.precision_usage_count || 0))), reserved: 0 };
    if (job?.status === 'completed') return { used: legacyCompletedCount(job), reserved: 0 };
    const hasExplicitReservation = job?.precision_usage_reserved !== undefined && job?.precision_usage_reserved !== null;
    const createdAtMs = asTimestamp(job?.started_at || job?.created_date || job?.dry_run_metadata?.batchdata_only_started_at) || 0;
    const isStale = createdAtMs > 0 && (Date.now() - createdAtMs > 10 * 60 * 1000);
    const legacyReservationAllowed = ['pending', 'running'].includes(job?.status) && !isStale;
    const reserved = Math.max(0, Math.floor(Number(
        hasExplicitReservation
            ? (isStale ? 0 : job.precision_usage_reserved)
            : legacyReservationAllowed
                ? (job?.total_expected ?? job?.estimated_record_count ?? 0)
                : 0
    )));
    return { used: 0, reserved };
}

async function getPrecisionJobs(base44, user) {
    const jobsById = new Map();
    const queries = [listAll(base44.asServiceRole.entities.FetchJob, { precision_usage_user_id: user.id })];
    if (user?.email) queries.push(listAll(base44.asServiceRole.entities.FetchJob, { user_email: user.email }));
    for (const result of await Promise.all(queries)) {
        for (const job of result) {
            if (!job?.id) continue;
            if (job.mode_tag && job.mode_tag !== 'PRECISION_TARGET') continue;
            if (!job.mode_tag && job.provider && job.provider !== 'batchdata') continue;
            jobsById.set(job.id, job);
        }
    }
    // 5.1 The email query still runs, because rows written before
    // precision_usage_user_id existed can only be found that way, but its
    // results are ownership-filtered so a foreign immutable subject sharing an
    // email cannot consume this user's allowance.
    return selectOwnedPrecisionJobs([...jobsById.values()], user);
}

async function getPrecisionAllowance(base44, user, entitlement) {
    if (entitlement.kind === 'unmetered') return { used: 0, reserved: 0, remaining: PAID_PROPERTY_CAP, trialUsed: 0, lifetimeUsed: 0 };
    const jobs = await getPrecisionJobs(base44, user);
    const periodStart = asTimestamp(entitlement.periodStart);
    const periodEnd = asTimestamp(entitlement.periodEnd);
    let used = 0;
    let reserved = 0;
    let trialUsed = 0;
    let lifetimeUsed = 0;
    for (const job of jobs) {
        const usage = jobUsage(job);
        lifetimeUsed += usage.used;
        const startedAt = asTimestamp(job.started_at || job.created_date || job.dry_run_metadata?.batchdata_only_started_at);
        const jobPeriodStart = asTimestamp(job.precision_usage_period_start);
        const jobPeriodEnd = asTimestamp(job.precision_usage_period_end);
        const matchesPaid = entitlement.kind === 'beta'
            ? job.precision_usage_kind === 'paid'
                && job.precision_subscription_id === entitlement.subscriptionId
                && jobPeriodStart === periodStart
                && jobPeriodEnd === periodEnd
            : entitlement.kind === 'paid' && (
                job.precision_usage_kind === 'paid'
                    ? jobPeriodStart !== null && periodStart !== null && Math.abs(jobPeriodStart - periodStart) < 1000
                    : !job.precision_usage_kind && startedAt !== null && periodStart !== null && startedAt >= periodStart && (periodEnd === null || startedAt < periodEnd)
            );
        if (matchesPaid) {
            used += usage.used;
            reserved += usage.reserved;
        } else if (job.precision_usage_kind === 'trial' || !job.precision_usage_kind) {
            trialUsed += usage.used + usage.reserved;
        }
    }
    if (entitlement.kind !== 'paid' && entitlement.kind !== 'beta') {
        used = Math.min(FREE_PROPERTY_CAP, trialUsed);
        reserved = 0;
    }
    let limit = entitlement.kind === 'beta'
        ? entitlement.precisionLimit
        : entitlement.kind === 'paid' ? PAID_PROPERTY_CAP : FREE_PROPERTY_CAP;
    let rolloverRemaining = 0;
    if (entitlement.kind === 'paid') {
        const ledger = await listPrecisionCreditLedger(base44, user.id);
        const creditState = calculatePrecisionCreditState({
            ledger,
            currentPeriodStart: entitlement.periodStart,
            jobs: jobs.map(job => ({
                kind: job.precision_usage_kind,
                periodStart: job.precision_usage_period_start,
                ...jobUsage(job)
            }))
        });
        limit = creditState.limit;
        rolloverRemaining = creditState.rolloverRemaining;
    }
    used = Math.min(limit, used);
    reserved = Math.min(Math.max(0, limit - used), reserved);
    return { used, reserved, remaining: Math.max(0, limit - used - reserved), trialUsed: Math.min(FREE_PROPERTY_CAP, trialUsed), lifetimeUsed, limit, rolloverRemaining };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const authenticatedUser = await base44.auth.me();
        if (!authenticatedUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });
        const body = await req.json().catch(() => ({}));
        let user = await loadAuthoritativeUser(base44, authenticatedUser);
        if (body.diagnostic_user_id) {
            if (body.dry_run !== true || String(authenticatedUser.role || '').toLowerCase() !== 'admin') {
                return Response.json({ error: 'Admin dry-run access required' }, { status: 403 });
            }
            const targetUser = await base44.asServiceRole.entities.User.get(String(body.diagnostic_user_id));
            if (!targetUser) return Response.json({ error: 'Diagnostic account not found' }, { status: 404 });
            user = targetUser;
        }
        // 5.3 Polygon input integrity. Valid geometry remains untouched;
        // crossed freehand traces are untangled before identity is computed.
        const polygonResult = normalizePrecisionPolygon(body.polygon);
        if (!polygonResult.ok) {
            return Response.json({ error: polygonResult.code, message: polygonResult.message }, { status: 400 });
        }
        const polygon = polygonResult.points;
        const routeBounds = normalizeRouteBounds(body.route_bounds);
        if (routeBounds === null) {
            return Response.json({
                error: 'invalid_route_bounds',
                message: 'Route-from-home requires valid starting and ending coordinates.'
            }, { status: 400 });
        }

        const areaSqMi = polygonAreaSqMi(polygon);
        const center = centroid(polygon);
        const forceFreeForSelfTest = body.self_test_force_free === true && body.dry_run === true;
        const entitlement = forceFreeForSelfTest
            ? { kind: 'trial', paidAccess: false, proAccess: false, subscriptionId: null, invoiceId: null, periodStart: null, periodEnd: null }
            : await resolvePrecisionEntitlement(user);
        const hasPaidPrecisionCapacity = entitlement.paidAccess;
        const hasPrecisionPro = entitlement.proAccess;
        const ownership = parseOwnershipRange(body);
        if (ownership.error) {
            return Response.json({ error: 'invalid_ownership_range', message: ownership.error }, { status: 400 });
        }
        const requestedSoldMonths = legacySoldMonthsForOwnershipRange(ownership, body.sold_months);
        if (ownership.mode === 'custom' && !hasPrecisionPro) {
            return Response.json({
                error: 'upgrade_required',
                message: 'Custom ownership ranges require a Pro plan.'
            }, { status: 403 });
        }
        if (ownership.mode === 'quick' && isPremiumRecentRange(requestedSoldMonths) && !hasPrecisionPro) {
            return Response.json({
                error: 'upgrade_required',
                message: '1 day, 2 day, 1 week, 2 week, and 1 month Precision pulls require a Pro plan.'
            }, { status: 403 });
        }
        const routeHomeStats = forceFreeForSelfTest
            ? { count: 0, hashes: [] }
            : await getPrecisionRouteHomeStats(base44, user);
        const existingRouteHomes = routeHomeStats.count;
        const allowance = forceFreeForSelfTest
            ? { used: 0, reserved: 0, remaining: FREE_PROPERTY_CAP, trialUsed: 0, lifetimeUsed: 0 }
            : await getPrecisionAllowance(base44, user, entitlement);
        const paidPropertyLimit = hasPaidPrecisionCapacity ? allowance.limit : PAID_PROPERTY_CAP;
        const paidPropertiesUsed = hasPaidPrecisionCapacity ? allowance.used + allowance.reserved : null;
        const paidPropertiesRemaining = hasPaidPrecisionCapacity
            ? allowance.remaining
            : null;
        const maxProperties = hasPaidPrecisionCapacity ? paidPropertiesRemaining : FREE_PROPERTY_CAP;
        const countMode = body.count_mode === 'max_available' ? 'max_available' : 'fixed';
        // 5.4 An absent count keeps its established meaning (the plan maximum);
        // anything present but unusable is rejected rather than silently
        // becoming max-available or a fractional reservation.
        const countResult = normalizeRequestedCount(body.requested_properties, { fallback: maxProperties });
        if (!countResult.ok) {
            return Response.json({ error: countResult.code, message: countResult.message }, { status: 400 });
        }
        const requestedValue = countResult.value;
        if (!hasPaidPrecisionCapacity && countMode !== 'max_available' && requestedValue > FREE_PROPERTY_CAP) {
            return Response.json({
                error: 'paid_precision_required',
                message: 'That route size is above what your current plan includes. Start or upgrade to Precision to generate larger routes.'
            }, { status: 403 });
        }
        const freeHomesRemaining = hasPaidPrecisionCapacity ? null : allowance.remaining;

        if (!hasPaidPrecisionCapacity && freeHomesRemaining <= 0) {
            return Response.json({
                error: 'paid_precision_required',
                message: 'This account has already received its included 50 single-family Precision route homes. Upgrade to Precision for larger routes.'
            }, { status: 403 });
        }
        if (hasPaidPrecisionCapacity && paidPropertiesRemaining <= 0) {
            return Response.json({
                error: 'precision_allowance_exhausted',
                message: 'This account has used all paid Precision properties for the current billing cycle.'
            }, { status: 403 });
        }

        const effectiveMaxProperties = hasPaidPrecisionCapacity
            ? maxProperties
            : Math.min(maxProperties, freeHomesRemaining);
        const dryRunTarget = resolveEffectiveCount({
            countMode,
            enteredCount: requestedValue,
            lockedRemaining: effectiveMaxProperties
        });
        const requestedProperties = dryRunTarget.effective_count;
        const limitedByFreeHomeCap = !hasPaidPrecisionCapacity && dryRunTarget.capped;
        const limitedByPaidPropertyCap = hasPaidPrecisionCapacity && dryRunTarget.capped;
        const minPriceRaw = Number(body.min_price);
        const maxPriceRaw = Number(body.max_price);
        const minPrice = Number.isFinite(minPriceRaw) && minPriceRaw > 0 ? minPriceRaw : null;
        const maxPrice = Number.isFinite(maxPriceRaw) && maxPriceRaw > 0 ? maxPriceRaw : null;
        const routeFilters = normalizeRouteTypeFilters(body.route_filters || DEFAULT_ROUTE_TYPE_FILTERS);
        const fips = await resolveFips(center);
        if (!fips?.fips_code) {
            return Response.json({ error: 'Could not resolve county/FIPS for this area. Please redraw inside a supported US county.' }, { status: 400 });
        }

        const requestedPolygonHash = await polygonHash(polygon);

        if (body.dry_run === true) {
            return Response.json({
                success: true,
                dry_run: true,
                provider: 'batchdata',
                polygon,
                polygon_hash: requestedPolygonHash,
                polygon_repaired: polygonResult.repaired === true,
                fips_code: fips.fips_code,
                count_mode: countMode,
                requested_properties: requestedProperties,
                requested_properties_before_cap: dryRunTarget.entered_count,
                limited_by_free_home_cap: limitedByFreeHomeCap,
                limited_by_paid_property_cap: limitedByPaidPropertyCap,
                existing_active_properties: existingRouteHomes,
                existing_route_homes: existingRouteHomes,
                excluded_route_home_count: existingRouteHomes,
                free_properties_remaining: freeHomesRemaining,
                paid_properties_used: paidPropertiesUsed,
                paid_properties_reserved: hasPaidPrecisionCapacity ? allowance.reserved : null,
                paid_properties_remaining: paidPropertiesRemaining,
                paid_property_limit: hasPaidPrecisionCapacity ? paidPropertyLimit : null,
                entitlement_kind: entitlement.kind,
                unlimited: entitlement.subscriptionId === 'owner_unlimited_grant',
                diagnostic_user_id: body.diagnostic_user_id ? user.id : null,
                precision_usage_period_start: entitlement.periodStart,
                sold_months: requestedSoldMonths,
                ...ownershipResponseFields(ownership),
                previous_pull_date: body.previous_pull_date || null,
                include_unresolved_followups: body.include_unresolved_followups === true,
                area_sq_mi: Number(areaSqMi.toFixed(2)),
                route_filters: routeFilters,
                route_bounds: routeBounds
            });
        }

        const startResult = await withPrecisionUsageLock(user.id, async () => {
        // 5.2 / 5.6 Active-job resolution.
        // Queries BOTH the immutable subject and the legacy email index, then
        // keeps only Precision jobs this subject actually owns. Previously this
        // filtered on user_email alone with no Precision filter, so a foreign
        // account sharing an email — or an unrelated ZIP/MLS job — could block
        // the pull and be offered for resume.
        const activeQueries = [];
        for (const activeStatus of ACTIVE_PRECISION_STATUSES) {
            activeQueries.push(withRateLimitRetry(() => base44.asServiceRole.entities.FetchJob.filter(
                { precision_usage_user_id: user.id, status: activeStatus }, '-created_date', 20)));
            if (user?.email) {
                activeQueries.push(withRateLimitRetry(() => base44.asServiceRole.entities.FetchJob.filter(
                    { user_email: user.email, status: activeStatus }, '-created_date', 20)));
            }
        }
        const activeById = new Map();
        for (const page of await Promise.all(activeQueries)) {
            for (const candidate of asArray(page)) {
                if (!candidate?.id || !ACTIVE_PRECISION_STATUSES.includes(candidate.status)) continue;
                activeById.set(String(candidate.id), candidate);
            }
        }
        const activeJobs = selectOwnedPrecisionJobs([...activeById.values()], user);

        let activeDecision = { outcome: 'zero', count: 0, job: null, mismatched_fields: [], unprovable_fields: [] };
        let activeCanonicalPolygon = null;
        let activePolygonHash = null;
        let activePolygonRepaired = false;
        if (activeJobs.length > 0) {
            // The target an identical order would resolve to, treating the active
            // job's own reservation as available - otherwise a job would always
            // conflict with itself on effective_count.
            const activeReservation = activeJobs.reduce((sum, activeJob) => sum + jobUsage(activeJob).reserved, 0);
            const compatibilityRemaining = Math.min(
                hasPaidPrecisionCapacity ? paidPropertyLimit : FREE_PROPERTY_CAP,
                Math.max(0, Number(allowance.remaining || 0)) + activeReservation
            );
            const compatibilityTarget = resolveEffectiveCount({
                countMode,
                enteredCount: requestedValue,
                lockedRemaining: compatibilityRemaining
            });
            if (activeJobs.length === 1 && Array.isArray(activeJobs[0].polygon) && activeJobs[0].polygon.length >= 3) {
                const activePolygonResult = normalizePrecisionPolygon(activeJobs[0].polygon);
                if (activePolygonResult.ok) {
                    activeCanonicalPolygon = activePolygonResult.points;
                    activePolygonHash = await polygonHash(activeCanonicalPolygon);
                    activePolygonRepaired = activePolygonResult.repaired === true;
                }
            }
            activeDecision = classifyActivePrecisionJobs(activeJobs, requestedOrder({
                polygon_hash: requestedPolygonHash,
                count_mode: countMode,
                effective_count: compatibilityTarget.effective_count,
                min_price: minPrice,
                max_price: maxPrice,
                sold_months: requestedSoldMonths,
                ownership_range_mode: ownership.mode,
                ownership_range_days: ownership.range,
                route_filters: routeFilters,
                route_bounds: routeBounds,
                repull_mode: body.repull_mode || 'new_area',
                previous_pull_date: body.previous_pull_date || null
            }), {
                polygonHash: activePolygonHash,
                preferPolygonHash: activePolygonRepaired
            });
        }

        if (activeDecision.outcome === 'one_exact_match') {
            const resumed = activeDecision.job;
            const resumedOrder = activeDecision.persisted_order;
            return Response.json({
                status: 'already_running',
                active_job_outcome: 'one_exact_match',
                criteria_match: 'exact',
                job_id: resumed.id,
                message: 'An identical data pull is already running. Resuming that exact request.',
                polygon: activeCanonicalPolygon || resumed.polygon || [],
                polygon_hash: activePolygonHash || resumed.polygon_hash || null,
                polygon_repaired: activePolygonRepaired || resumed.dry_run_metadata?.polygon_repaired === true,
                requested_properties: resumedOrder.effective_count,
                sold_months: resumedOrder.sold_months,
                min_price: resumedOrder.min_price,
                max_price: resumedOrder.max_price,
                count_mode: resumedOrder.count_mode,
                route_filters: resumedOrder.route_filters,
                route_bounds: resumedOrder.route_bounds,
                repull_mode: resumedOrder.repull_mode,
                ...ownershipResponseFields({
                    mode: resumedOrder.ownership_range_mode,
                    range: resumedOrder.ownership_range_days
                })
            });
        }

        // Every non-exact outcome fails closed. Nothing is cancelled, mutated,
        // selected among, or replaced. Cancellation and reservation lifecycle
        // are deliberately out of scope - see docs/precision/PR_A_DEFERRED_DECISIONS.md.
        if (activeDecision.outcome === 'one_unverifiable') {
            return Response.json({
                error: 'legacy_active_job_unverifiable',
                active_job_outcome: 'one_unverifiable',
                active_job_id: activeDecision.job.id,
                active_job_count: 1,
                unprovable_fields: activeDecision.unprovable_fields,
                message: 'A property import is already running, but its original criteria cannot be verified from what was saved. It was not resumed or replaced. Wait for it to finish or cancel it before starting this request.'
            }, { status: 409 });
        }

        if (activeDecision.outcome === 'one_conflict') {
            return Response.json({
                error: 'active_job_criteria_conflict',
                active_job_outcome: 'one_conflict',
                active_job_id: activeDecision.job.id,
                active_job_count: 1,
                mismatched_fields: activeDecision.mismatched_fields,
                message: 'A different property import is already running. It was not resumed or replaced. Wait for it to finish or cancel it before starting this request.'
            }, { status: 409 });
        }

        if (activeDecision.outcome === 'multiple_active') {
            return Response.json({
                error: 'active_job_criteria_conflict',
                active_job_outcome: 'multiple_active',
                active_job_count: activeDecision.count,
                active_job_ids: activeDecision.job_ids,
                message: 'More than one property import is already running for this account. Wait for them to finish or cancel them before starting a new pull.'
            }, { status: 409 });
        }

        const lockedEntitlement = await resolvePrecisionEntitlement(user);
        const lockedHasPaidPrecisionCapacity = lockedEntitlement.paidAccess;
        const lockedHasPrecisionPro = lockedEntitlement.proAccess;
        if (ownership.mode === 'custom' && !lockedHasPrecisionPro) {
            return Response.json({
                error: 'upgrade_required',
                message: 'Custom ownership ranges require a Pro plan.'
            }, { status: 403 });
        }
        if (ownership.mode === 'quick' && isPremiumRecentRange(requestedSoldMonths) && !lockedHasPrecisionPro) {
            return Response.json({
                error: 'upgrade_required',
                message: '1 day, 2 day, 1 week, 2 week, and 1 month Precision pulls require a Pro plan.'
            }, { status: 403 });
        }
        if (!lockedHasPaidPrecisionCapacity && countMode !== 'max_available' && requestedValue > FREE_PROPERTY_CAP) {
            return Response.json({
                error: 'paid_precision_required',
                message: 'That route size is above what your current plan includes. Start or upgrade to Precision to generate larger routes.'
            }, { status: 403 });
        }
        const lockedAllowance = await getPrecisionAllowance(base44, user, lockedEntitlement);
        const lockedPaidPropertyLimit = lockedHasPaidPrecisionCapacity ? lockedAllowance.limit : PAID_PROPERTY_CAP;
        if (lockedAllowance.remaining <= 0) {
            return Response.json({
                error: lockedHasPaidPrecisionCapacity ? 'precision_allowance_exhausted' : 'paid_precision_required',
                message: lockedHasPaidPrecisionCapacity
                    ? 'This account has used all paid Precision properties for the current billing cycle.'
                    : 'This account has already received its included 50 single-family Precision route homes. Upgrade to Precision for larger routes.'
            }, { status: 403 });
        }
        // 5.5 max_available resolves from the allowance observed INSIDE the
        // lock. The browser's number is not the authoritative maximum.
        const effectiveTarget = resolveEffectiveCount({
            countMode,
            enteredCount: requestedValue,
            lockedRemaining: lockedAllowance.remaining
        });
        const reservedProperties = effectiveTarget.effective_count;
        const lockedLimitedByFreeHomeCap = !lockedHasPaidPrecisionCapacity && effectiveTarget.capped;
        const lockedLimitedByPaidPropertyCap = lockedHasPaidPrecisionCapacity && effectiveTarget.capped;
        const lockedFreeHomesRemaining = lockedHasPaidPrecisionCapacity ? null : lockedAllowance.remaining;
        const hash = requestedPolygonHash;
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
            estimated_record_count: reservedProperties,
            estimated_cost: Number((reservedProperties * 0.01).toFixed(2)),
            dry_run_metadata: {
                county_resolution: fips,
                ...(polygonResult.repaired ? { polygon_repaired: true } : {}),
                requested_properties: reservedProperties,
                requested_properties_before_cap: effectiveTarget.entered_count,
                limited_by_free_home_cap: lockedLimitedByFreeHomeCap,
                limited_by_paid_property_cap: lockedLimitedByPaidPropertyCap,
                existing_active_properties: existingRouteHomes,
                existing_route_homes: existingRouteHomes,
                excluded_route_home_count: existingRouteHomes,
                excluded_route_hashes: routeHomeStats.hashes,
                free_properties_remaining: lockedFreeHomesRemaining,
                paid_properties_used: lockedHasPaidPrecisionCapacity ? lockedAllowance.used + lockedAllowance.reserved : null,
                paid_properties_reserved: lockedHasPaidPrecisionCapacity ? lockedAllowance.reserved : null,
                paid_properties_remaining: lockedHasPaidPrecisionCapacity ? lockedAllowance.remaining : null,
                paid_property_limit: lockedHasPaidPrecisionCapacity ? lockedPaidPropertyLimit : null,
                precision_usage_period_start: lockedEntitlement.periodStart,
                free_property_cap: FREE_PROPERTY_CAP,
                count_mode: countMode,
                // "Max available" is a drain, not a quantity: the processor must
                // keep paging until BatchData has nothing left inside the drawn
                // area. The numeric target stays only as the billing reservation.
                // Metered accounts never drain — they stop at their allowance.
                drain_until_exhausted: countMode === 'max_available'
                    && lockedPaidPropertyLimit >= UNLIMITED_PROPERTY_CAP,
                repull_mode: body.repull_mode || 'new_area',
                previous_pull_date: body.previous_pull_date || null,
                force_full_refresh: body.force_full_refresh === true,
                include_unresolved_followups: body.include_unresolved_followups === true,
                filters: {
                    min_price: minPrice,
                    max_price: maxPrice
                },
                route_filters: routeFilters,
                route_bounds: routeBounds,
                ownership_range_mode: ownership.mode,
                ownership_range_days: ownership.range,
                processor_token: processorToken,
                paid_pull_started_at: new Date().toISOString()
            },
            sold_months: requestedSoldMonths,
            force_full_refresh: body.force_full_refresh === true,
            pull_mode: body.force_full_refresh === true ? 'full_refresh' : 'new_area',
            include_mls: false,
            user_email: user.email,
            precision_usage_user_id: user.id,
            precision_usage_kind: lockedEntitlement.kind === 'paid' || lockedEntitlement.kind === 'beta' ? 'paid' : lockedEntitlement.kind === 'unmetered' ? 'unmetered' : 'trial',
            ...(lockedEntitlement.subscriptionId ? { precision_subscription_id: lockedEntitlement.subscriptionId } : {}),
            ...(lockedEntitlement.invoiceId ? { precision_invoice_id: lockedEntitlement.invoiceId } : {}),
            ...(lockedEntitlement.periodStart ? { precision_usage_period_start: lockedEntitlement.periodStart } : {}),
            ...(lockedEntitlement.periodEnd ? { precision_usage_period_end: lockedEntitlement.periodEnd } : {}),
            precision_usage_reserved: reservedProperties,
            precision_usage_count: 0,
            progress_pct: 0,
            current_offset: 0,
            total_expected: reservedProperties,
            total_sub_circles: 1,
            completed_sub_circles: 0,
            total_batchdata_calls: 0
        });

        return {
            job,
            processorToken,
            reservedProperties,
            enteredCount: effectiveTarget.entered_count,
            lockedAllowance,
            lockedEntitlement,
            lockedPaidPropertyLimit,
            lockedHasPaidPrecisionCapacity,
            lockedLimitedByFreeHomeCap,
            lockedLimitedByPaidPropertyCap,
            lockedFreeHomesRemaining
        };
        });

        if (startResult instanceof Response) return startResult;
        const {
            job,
            processorToken,
            reservedProperties,
            enteredCount,
            lockedAllowance,
            lockedEntitlement,
            lockedPaidPropertyLimit,
            lockedHasPaidPrecisionCapacity,
            lockedLimitedByFreeHomeCap,
            lockedLimitedByPaidPropertyCap,
            lockedFreeHomesRemaining
        } = startResult;

        await startProcessor(base44, job.id, 0, processorToken);

        return Response.json({
            success: true,
            status: 'started',
            job_id: job.id,
            provider: 'batchdata',
            polygon,
            polygon_hash: requestedPolygonHash,
            polygon_repaired: polygonResult.repaired === true,
            active_job_outcome: 'zero',
            count_mode: countMode,
            requested_properties: reservedProperties,
            requested_properties_before_cap: enteredCount,
            limited_by_free_home_cap: lockedLimitedByFreeHomeCap,
            limited_by_paid_property_cap: lockedLimitedByPaidPropertyCap,
            existing_route_homes: existingRouteHomes,
            excluded_route_home_count: existingRouteHomes,
            free_properties_remaining: lockedHasPaidPrecisionCapacity ? null : Math.max(0, lockedFreeHomesRemaining - reservedProperties),
            paid_properties_used: lockedHasPaidPrecisionCapacity ? lockedAllowance.used + lockedAllowance.reserved : null,
            paid_properties_reserved: lockedHasPaidPrecisionCapacity ? lockedAllowance.reserved + reservedProperties : null,
            paid_properties_remaining: lockedHasPaidPrecisionCapacity ? Math.max(0, lockedAllowance.remaining - reservedProperties) : null,
            paid_property_limit: lockedHasPaidPrecisionCapacity ? lockedPaidPropertyLimit : null,
            precision_usage_period_start: lockedEntitlement.periodStart,
            route_filters: routeFilters,
            route_bounds: routeBounds,
            sold_months: requestedSoldMonths,
            ...ownershipResponseFields(ownership),
            message: `Precision pull started for up to ${reservedProperties} properties.`
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
