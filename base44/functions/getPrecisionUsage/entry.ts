import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Stripe from 'npm:stripe@14.14.0';

const FREE_PROPERTY_LIMIT = 50;
const PAID_PROPERTY_LIMIT = 1000;
const RECONCILIATION_VERSION = 2;
const PRECISION_PRICE_FLOOR_CENTS = 9900;

function asArray(value: any) {
    return Array.isArray(value) ? value : (value?.items || []);
}

function asTimestamp(value: any) {
    const timestamp = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
}

function stripeTimestampIso(value: any) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0
        ? new Date(seconds * 1000).toISOString()
        : null;
}

function betaTimestampIso(value: any) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function betaPrecisionEvidence(user: any) {
    if (user?.email?.toLowerCase() === 'baysecurity@gmail.com') {
        return {
            kind: 'beta',
            paidAccess: true,
            proAccess: true,
            subscriptionId: 'system_admin_grant',
            invoiceId: null,
            periodStart: new Date(2026, 0, 1).toISOString(),
            periodEnd: new Date(2030, 0, 1).toISOString(),
            precisionLimit: 1000
        };
    }
    const rawGrants = Deno.env.get('BETA_ACCESS_GRANTS');
    if (!rawGrants || !user?.id) return null;

    let document: any;
    try {
        document = JSON.parse(rawGrants);
    } catch {
        return null;
    }

    if (
        !document
        || Array.isArray(document)
        || document.version !== 1
        || !document.grants
        || typeof document.grants !== 'object'
        || Array.isArray(document.grants)
    ) return null;

    const immutableUserId = String(user.id);
    if (!Object.prototype.hasOwnProperty.call(document.grants, immutableUserId)) return null;
    const grant = document.grants[immutableUserId];
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return null;

    const grantId = typeof grant.grant_id === 'string' ? grant.grant_id.trim() : '';
    const requestedLimit = grant.precision_limit;
    const periodStart = betaTimestampIso(grant.starts_at);
    const periodEnd = betaTimestampIso(grant.ends_at);
    if (
        !grantId
        || grant.status !== 'active'
        || !Number.isSafeInteger(requestedLimit)
        || requestedLimit < 1
        || requestedLimit > PAID_PROPERTY_LIMIT
        || !periodStart
        || !periodEnd
        || !Number.isSafeInteger(grant.canvas_seats)
        || grant.canvas_seats < 1
        || grant.canvas_seats > 100
    ) return null;

    const periodStartMs = asTimestamp(periodStart);
    const periodEndMs = asTimestamp(periodEnd);
    const now = Date.now();
    if (
        periodStartMs === null
        || periodEndMs === null
        || periodStartMs >= periodEndMs
        || now < periodStartMs
        || now >= periodEndMs
    ) return null;

    return {
        kind: 'beta',
        paidAccess: true,
        proAccess: true,
        limit: requestedLimit,
        subscriptionId: grantId,
        invoiceId: null,
        periodStart,
        periodEnd
    };
}

function subscriptionPriceCents(subscription: any) {
    return Math.max(0, ...(subscription?.items?.data || []).map((item: any) => Number(item?.price?.unit_amount || 0)));
}

function invoiceSubscriptionId(invoice: any) {
    if (!invoice?.subscription) return null;
    return typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id;
}

function invoiceCoversCurrentPeriod(subscription: any, invoice: any) {
    const currentStart = Number(subscription?.current_period_start);
    if (!Number.isFinite(currentStart) || currentStart <= 0) return false;

    const subscriptionLines = (invoice?.lines?.data || []).filter((line: any) => {
        const lineSubscription = typeof line?.subscription === 'string'
            ? line.subscription
            : line?.subscription?.id;
        return !lineSubscription || lineSubscription === subscription.id;
    });
    if (subscriptionLines.some((line: any) => {
        const start = Number(line?.period?.start);
        const end = Number(line?.period?.end);
        return Number.isFinite(start) && Number.isFinite(end) && start <= currentStart && currentStart < end;
    })) return true;

    const invoiceStart = Number(invoice?.period_start);
    const invoiceEnd = Number(invoice?.period_end);
    return Number.isFinite(invoiceStart)
        && Number.isFinite(invoiceEnd)
        && invoiceStart <= currentStart
        && currentStart < invoiceEnd;
}

function paidPrecisionEvidence(subscription: any, expectedUserId: string) {
    if (!subscription || String(subscription?.metadata?.base44_user_id || '') !== String(expectedUserId)) return null;
    if (subscription.status !== 'active') return null;
    if (subscription.trial_end && Number(subscription.trial_end) * 1000 > Date.now()) return null;
    if (subscriptionPriceCents(subscription) < PRECISION_PRICE_FLOOR_CENTS) return null;

    const invoice = subscription.latest_invoice;
    if (!invoice || typeof invoice === 'string') return null;
    if (invoice.status !== 'paid' || Number(invoice.amount_paid || 0) <= 0) return null;
    const linkedSubscriptionId = invoiceSubscriptionId(invoice);
    if (linkedSubscriptionId && linkedSubscriptionId !== subscription.id) return null;
    if (!invoiceCoversCurrentPeriod(subscription, invoice)) return null;

    const periodStart = stripeTimestampIso(subscription.current_period_start);
    const periodEnd = stripeTimestampIso(subscription.current_period_end);
    if (!periodStart || !periodEnd) return null;
    return {
        kind: 'paid',
        paidAccess: true,
        proAccess: true,
        limit: PAID_PROPERTY_LIMIT,
        subscriptionId: subscription.id,
        invoiceId: invoice.id || null,
        periodStart,
        periodEnd
    };
}

function trialPrecisionEvidence(subscription: any, expectedUserId: string) {
    if (!subscription || String(subscription?.metadata?.base44_user_id || '') !== String(expectedUserId)) return null;
    if (subscription.status !== 'trialing') return null;
    if (subscriptionPriceCents(subscription) < PRECISION_PRICE_FLOOR_CENTS) return null;
    return {
        kind: 'trial',
        paidAccess: false,
        proAccess: true,
        limit: FREE_PROPERTY_LIMIT,
        subscriptionId: subscription.id,
        invoiceId: null,
        periodStart: null,
        periodEnd: null
    };
}

async function retrieveSubscription(stripe: any, subscriptionId: string) {
    try {
        return await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
    } catch (error: any) {
        if (error?.raw?.code === 'resource_missing' || error?.code === 'resource_missing') return null;
        throw error;
    }
}

async function resolveEntitlement(user: any) {
    const beta = betaPrecisionEvidence(user);
    if (beta) return beta;

    const secret = Deno.env.get('STRIPE_SECRET_KEY');
    if (!secret) throw new Error('Stripe billing verification is unavailable.');
    const stripe = new Stripe(secret);
    const subscriptions = new Map<string, any>();

    if (user?.subscription_id) {
        const direct = await retrieveSubscription(stripe, String(user.subscription_id));
        if (direct) subscriptions.set(direct.id, direct);
    }

    if (user?.stripe_customer_id) {
        const listed = await stripe.subscriptions.list({
            customer: String(user.stripe_customer_id),
            status: 'all',
            limit: 20,
            expand: ['data.latest_invoice']
        });
        for (const subscription of listed.data || []) subscriptions.set(subscription.id, subscription);
    }
    const orderedSubscriptions = () => [...subscriptions.values()].sort((left, right) =>
        Number(right.current_period_start || right.created || 0) - Number(left.current_period_start || left.created || 0)
        || String(left.id || '').localeCompare(String(right.id || ''))
    );
    let paid = orderedSubscriptions().map(subscription => paidPrecisionEvidence(subscription, user.id)).find(Boolean);
    if (!paid && typeof stripe.subscriptions.search === 'function') {
        const escapedUserId = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const discovered = await stripe.subscriptions.search({
            query: `metadata['base44_user_id']:'${escapedUserId}'`,
            limit: 20,
            expand: ['data.latest_invoice']
        });
        for (const subscription of discovered.data || []) subscriptions.set(subscription.id, subscription);
        paid = orderedSubscriptions().map(subscription => paidPrecisionEvidence(subscription, user.id)).find(Boolean);
    }
    if (paid) return paid;
    for (const subscription of orderedSubscriptions()) {
        const trial = trialPrecisionEvidence(subscription, user.id);
        if (trial) return trial;
    }

    return {
        kind: 'trial',
        paidAccess: false,
        proAccess: false,
        limit: FREE_PROPERTY_LIMIT,
        subscriptionId: null,
        invoiceId: null,
        periodStart: null,
        periodEnd: null
    };
}

function isMeteredEntitlement(entitlement: any) {
    return entitlement.kind === 'paid' || entitlement.kind === 'beta';
}

function jobMatchesMeteredEntitlement(job: any, entitlement: any) {
    if (!isMeteredEntitlement(entitlement) || !samePeriod(job.precision_usage_period_start, entitlement.periodStart)) {
        return false;
    }
    if (entitlement.kind !== 'beta') return true;
    return job.precision_subscription_id === entitlement.subscriptionId
        && samePeriod(job.precision_usage_period_end, entitlement.periodEnd);
}

async function listAll(entity: any, filter: any, sort = 'created_date', pageSize = 500) {
    const records: any[] = [];
    for (let skip = 0; skip < 20000; skip += pageSize) {
        const page = await entity.filter(filter, sort, pageSize, skip);
        const items = asArray(page);
        records.push(...items);
        if (items.length < pageSize) return records;
    }
    throw new Error('Precision usage history exceeds the supported reconciliation window.');
}

async function getUserPrecisionJobs(base44: any, user: any) {
    const jobsById = new Map<string, any>();
    const queries = [
        listAll(base44.asServiceRole.entities.FetchJob, { precision_usage_user_id: user.id })
    ];
    if (user?.email) queries.push(listAll(base44.asServiceRole.entities.FetchJob, { user_email: user.email }));

    const results = await Promise.all(queries);
    for (const result of results) {
        for (const job of result) {
            if (!job?.id) continue;
            if (job.mode_tag && job.mode_tag !== 'PRECISION_TARGET') continue;
            if (!job.mode_tag && job.provider && job.provider !== 'batchdata') continue;
            jobsById.set(job.id, job);
        }
    }
    return [...jobsById.values()];
}

function jobStartedAtMs(job: any) {
    return asTimestamp(job?.started_at || job?.created_date || job?.dry_run_metadata?.batchdata_only_started_at);
}

function legacyCompletedCount(job: any) {
    const summaryActive = Number(job?.dry_run_metadata?.batchdata_summary?.active);
    if (Number.isFinite(summaryActive) && summaryActive >= 0) return Math.floor(summaryActive);
    const expected = Math.max(0, Math.floor(Number(job?.total_expected || job?.estimated_record_count || 0)));
    const inserted = Math.max(0, Math.floor(Number(job?.total_inserted || 0)));
    const existed = Math.max(0, Math.floor(Number(job?.total_existed || 0)));
    return expected > 0 ? Math.min(expected, inserted + existed) : inserted + existed;
}

function jobUsage(job: any) {
    const explicitCount = Math.max(0, Math.floor(Number(job?.precision_usage_count || 0)));
    const hasExplicitReservation = job?.precision_usage_reserved !== undefined && job?.precision_usage_reserved !== null;
    const legacyReservationAllowed = ['pending', 'running'].includes(job?.status);
    const reservation = Math.max(0, Math.floor(Number(
        hasExplicitReservation
            ? job.precision_usage_reserved
            : legacyReservationAllowed
                ? (job?.total_expected ?? job?.estimated_record_count ?? 0)
                : 0
    )));
    if (job?.precision_usage_recorded_at) return { used: explicitCount, reserved: 0 };
    if (job?.status === 'completed') return { used: legacyCompletedCount(job), reserved: 0 };
    if (reservation > 0) return { used: 0, reserved: reservation };
    return { used: 0, reserved: 0 };
}

function samePeriod(left: any, right: any) {
    const leftMs = asTimestamp(left);
    const rightMs = asTimestamp(right);
    return leftMs !== null && rightMs !== null && Math.abs(leftMs - rightMs) < 1000;
}

function calculateUsage(jobs: any[], entitlement: any) {
    const paidPeriodStartMs = asTimestamp(entitlement.periodStart);
    const paidPeriodEndMs = asTimestamp(entitlement.periodEnd);
    let trialUsed = 0;
    let trialReserved = 0;
    let paidUsed = 0;
    let paidReserved = 0;
    let lifetimeUsed = 0;

    for (const job of jobs) {
        const usage = jobUsage(job);
        lifetimeUsed += usage.used;
        const kind = job.precision_usage_kind;
        const startedAt = jobStartedAtMs(job);

        if (kind === 'trial') {
            trialUsed += usage.used;
            trialReserved += usage.reserved;
            continue;
        }
        if (kind === 'paid') {
            if (jobMatchesMeteredEntitlement(job, entitlement)) {
                paidUsed += usage.used;
                paidReserved += usage.reserved;
            }
            continue;
        }
        if (kind === 'unmetered') continue;

        // Legacy service-owned jobs are classified by their fetch start, never by
        // mutable route-save timestamps. Before the first known paid boundary,
        // the first 50 remain the included trial; current-period jobs are paid.
        if (
            isMeteredEntitlement(entitlement)
            && paidPeriodStartMs !== null
            && startedAt !== null
            && startedAt >= paidPeriodStartMs
            && (paidPeriodEndMs === null || startedAt < paidPeriodEndMs)
        ) {
            paidUsed += usage.used;
            paidReserved += usage.reserved;
        } else {
            trialUsed += usage.used;
            trialReserved += usage.reserved;
        }
    }

    trialUsed = Math.min(FREE_PROPERTY_LIMIT, trialUsed);
    trialReserved = Math.min(Math.max(0, FREE_PROPERTY_LIMIT - trialUsed), trialReserved);
    const bucketUsed = isMeteredEntitlement(entitlement) ? paidUsed : trialUsed;
    const bucketReserved = isMeteredEntitlement(entitlement) ? paidReserved : trialReserved;
    const used = Math.min(entitlement.limit, bucketUsed);
    const reserved = Math.min(Math.max(0, entitlement.limit - used), bucketReserved);
    const meterUsed = Math.min(entitlement.limit, used + reserved);

    return {
        used,
        reserved,
        meterUsed,
        remaining: Math.max(0, entitlement.limit - meterUsed),
        lifetimeUsed,
        trialUsed,
        trialRemaining: Math.max(0, FREE_PROPERTY_LIMIT - trialUsed)
    };
}

async function reconcileLegacyJobs(base44: any, user: any, jobs: any[], entitlement: any) {
    const legacyCompleted = jobs
        .filter(job => !job.precision_usage_kind && job.status === 'completed')
        .sort((left, right) => (jobStartedAtMs(left) || 0) - (jobStartedAtMs(right) || 0));
    if (legacyCompleted.length === 0) return { jobs, reconciledCount: 0 };

    const periodStartMs = asTimestamp(entitlement.periodStart);
    const periodEndMs = asTimestamp(entitlement.periodEnd);
    let includedTrialAssigned = jobs
        .filter(job => job.precision_usage_kind === 'trial')
        .reduce((sum, job) => sum + jobUsage(job).used, 0);
    let reconciledCount = 0;

    for (const job of legacyCompleted) {
        const count = legacyCompletedCount(job);
        const startedAt = jobStartedAtMs(job);
        let kind = 'unmetered';
        if (
            isMeteredEntitlement(entitlement)
            && periodStartMs !== null
            && startedAt !== null
            && startedAt >= periodStartMs
            && (periodEndMs === null || startedAt < periodEndMs)
        ) {
            kind = 'paid';
        } else if (includedTrialAssigned < FREE_PROPERTY_LIMIT) {
            kind = 'trial';
            includedTrialAssigned += count;
        }

        await base44.asServiceRole.entities.FetchJob.update(job.id, {
            precision_usage_user_id: user.id,
            precision_usage_kind: kind,
            ...(kind === 'paid' ? {
                precision_subscription_id: entitlement.subscriptionId,
                precision_invoice_id: entitlement.invoiceId,
                precision_usage_period_start: entitlement.periodStart,
                precision_usage_period_end: entitlement.periodEnd
            } : {}),
            precision_usage_reserved: 0,
            precision_usage_count: count,
            precision_usage_recorded_at: job.completed_at || new Date().toISOString()
        });
        Object.assign(job, {
            precision_usage_user_id: user.id,
            precision_usage_kind: kind,
            precision_subscription_id: kind === 'paid' ? entitlement.subscriptionId : undefined,
            precision_invoice_id: kind === 'paid' ? entitlement.invoiceId : undefined,
            precision_usage_period_start: kind === 'paid' ? entitlement.periodStart : undefined,
            precision_usage_period_end: kind === 'paid' ? entitlement.periodEnd : undefined,
            precision_usage_reserved: 0,
            precision_usage_count: count,
            precision_usage_recorded_at: job.completed_at || new Date().toISOString()
        });
        reconciledCount++;
    }

    const reconciledUsage = calculateUsage(jobs, entitlement);
    await base44.asServiceRole.entities.User.update(user.id, {
        precision_usage_reconciled_at: new Date().toISOString(),
        precision_usage_reconciliation_version: RECONCILIATION_VERSION,
        precision_trial_properties_credited: Math.min(FREE_PROPERTY_LIMIT, reconciledUsage.trialUsed),
        ...(isMeteredEntitlement(entitlement) ? {
            subscription_period_start: entitlement.periodStart,
            subscription_period_end: entitlement.periodEnd,
            precision_usage_period_start: entitlement.periodStart,
            precision_usage_period_end: entitlement.periodEnd
        } : {})
    });
    return { jobs, reconciledCount };
}

Deno.serve(async (req: Request) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const entitlement = await resolveEntitlement(user);
        let jobs = await getUserPrecisionJobs(base44, user);
        const reconciliation = await reconcileLegacyJobs(base44, user, jobs, entitlement);
        jobs = reconciliation.jobs;
        const usage = calculateUsage(jobs, entitlement);
        const asOf = new Date().toISOString();

        return Response.json({
            success: true,
            complete: true,
            version: 2,
            as_of: asOf,
            kind: entitlement.kind,
            paid_access: entitlement.paidAccess,
            pro_access: entitlement.proAccess,
            limit: entitlement.limit,
            used: usage.used,
            reserved: usage.reserved,
            meter_used: usage.meterUsed,
            remaining: usage.remaining,
            percent: entitlement.limit > 0 ? Math.min(100, Math.round((usage.meterUsed / entitlement.limit) * 100)) : 0,
            period_start: entitlement.periodStart,
            period_end: entitlement.periodEnd,
            subscription_id: entitlement.subscriptionId,
            invoice_id: entitlement.invoiceId,
            lifetime_used: usage.lifetimeUsed,
            trial_used: usage.trialUsed,
            trial_remaining: usage.trialRemaining,
            reconciliation_applied: reconciliation.reconciledCount > 0,
            reconciled_jobs: reconciliation.reconciledCount
        });
    } catch (error: any) {
        console.error('[getPrecisionUsage] Failed:', error?.message || error);
        return Response.json({
            success: false,
            complete: false,
            error: 'precision_usage_unavailable',
            message: 'Precision usage could not be verified. No property allowance was granted or consumed.'
        }, { status: 503 });
    }
});
