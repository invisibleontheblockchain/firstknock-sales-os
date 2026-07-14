import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.14.0';

const FREE_PROPERTY_LIMIT = 50;
const PAID_PROPERTY_LIMIT = 1000;
const RECONCILIATION_VERSION = 2;

function asArray(value: any) {
    return Array.isArray(value) ? value : (value?.items || []);
}

function asTimestamp(value: any) {
    const timestamp = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
}

function stripeTimestampIso(value: any) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
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

async function loadTargetUser(caller: any, targetEmail: string | null) {
    const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
    if (!normalizedTarget || normalizedTarget === String(caller.email || '').trim().toLowerCase()) return caller;
    throw Object.assign(new Error('Cross-account reconciliation is not available through a user-authenticated request.'), { status: 403 });
}

function invoiceCoversCurrentPeriod(subscription: any, invoice: any) {
    const currentStart = Number(subscription?.current_period_start);
    if (!Number.isFinite(currentStart) || currentStart <= 0) return false;
    if ((invoice?.lines?.data || []).some((line: any) => {
        const lineSubscription = typeof line?.subscription === 'string' ? line.subscription : line?.subscription?.id;
        const start = Number(line?.period?.start);
        const end = Number(line?.period?.end);
        return (!lineSubscription || lineSubscription === subscription.id)
            && Number.isFinite(start) && Number.isFinite(end)
            && start <= currentStart && currentStart < end;
    })) return true;
    const start = Number(invoice?.period_start);
    const end = Number(invoice?.period_end);
    return Number.isFinite(start) && Number.isFinite(end) && start <= currentStart && currentStart < end;
}

function assertPaidPrecisionSubscription(subscription: any, userId: string) {
    if (String(subscription?.metadata?.base44_user_id || '') !== String(userId)) {
        throw Object.assign(new Error('The Stripe subscription does not affirmatively belong to this account.'), { status: 409 });
    }
    const amountCents = Math.max(0, ...(subscription?.items?.data || []).map((item: any) => Number(item?.price?.unit_amount || 0)));
    const invoice = subscription.latest_invoice;
    const invoiceSubscriptionId = typeof invoice?.subscription === 'string' ? invoice.subscription : invoice?.subscription?.id;
    const trialEnded = !subscription?.trial_end || Number(subscription.trial_end) * 1000 <= Date.now();
    if (subscription?.status !== 'active' || !trialEnded || amountCents < 9900) {
        throw Object.assign(new Error('An active paid Precision subscription is required.'), { status: 409 });
    }
    if (!invoice || typeof invoice === 'string' || invoice.status !== 'paid' || Number(invoice.amount_paid || 0) <= 0) {
        throw Object.assign(new Error('A completed positive Precision payment is required before usage can be reconciled.'), { status: 409 });
    }
    if (invoiceSubscriptionId && invoiceSubscriptionId !== subscription.id) {
        throw Object.assign(new Error('The paid invoice is linked to a different subscription.'), { status: 409 });
    }
    if (!invoiceCoversCurrentPeriod(subscription, invoice)) {
        throw Object.assign(new Error('The paid invoice does not cover the current Stripe billing period.'), { status: 409 });
    }
    return invoice;
}

function legacyCompletedCount(job: any) {
    const active = Number(job?.dry_run_metadata?.batchdata_summary?.active);
    if (Number.isFinite(active) && active >= 0) return Math.floor(active);
    const expected = Math.max(0, Math.floor(Number(job?.total_expected || job?.estimated_record_count || 0)));
    const delivered = Math.max(0, Math.floor(Number(job?.total_inserted || 0))) + Math.max(0, Math.floor(Number(job?.total_existed || 0)));
    return expected > 0 ? Math.min(expected, delivered) : delivered;
}

async function loadJobs(base44: any, user: any) {
    const byId = new Map<string, any>();
    const queries = [listAll(base44.asServiceRole.entities.FetchJob, { precision_usage_user_id: user.id })];
    if (user?.email) queries.push(listAll(base44.asServiceRole.entities.FetchJob, { user_email: user.email }));
    for (const result of await Promise.all(queries)) {
        for (const job of result) {
            if (!job?.id) continue;
            if (job.mode_tag && job.mode_tag !== 'PRECISION_TARGET') continue;
            if (!job.mode_tag && job.provider && job.provider !== 'batchdata') continue;
            byId.set(job.id, job);
        }
    }
    return [...byId.values()];
}

Deno.serve(async (req: Request) => {
    try {
        const base44 = createClientFromRequest(req);
        const caller = await base44.auth.me();
        if (!caller) return Response.json({ error: 'Unauthorized' }, { status: 401 });
        const body = await req.json().catch(() => ({}));
        const targetEmail = typeof body.target_email === 'string' ? body.target_email : null;
        const user = await loadTargetUser(caller, targetEmail);

        const secret = Deno.env.get('STRIPE_SECRET_KEY');
        if (!secret) throw new Error('Stripe billing verification is unavailable.');
        const stripe = new Stripe(secret);
        const candidates = new Map<string, any>();
        if (user?.subscription_id) {
            try {
                const direct = await stripe.subscriptions.retrieve(String(user.subscription_id), { expand: ['latest_invoice'] });
                candidates.set(direct.id, direct);
            } catch (error: any) {
                if (error?.raw?.code !== 'resource_missing' && error?.code !== 'resource_missing') throw error;
            }
        }
        if (user?.stripe_customer_id && typeof stripe.subscriptions.list === 'function') {
            const listed = await stripe.subscriptions.list({
                customer: String(user.stripe_customer_id),
                status: 'all',
                limit: 20,
                expand: ['data.latest_invoice']
            });
            for (const candidate of listed.data || []) candidates.set(candidate.id, candidate);
        }
        let selected: { subscription: any; invoice: any } | null = null;
        const orderedCandidates = () => [...candidates.values()].sort((left, right) =>
            Number(right.current_period_start || right.created || 0) - Number(left.current_period_start || left.created || 0)
            || String(left.id || '').localeCompare(String(right.id || ''))
        );
        for (const candidate of orderedCandidates()) {
            try {
                selected = { subscription: candidate, invoice: assertPaidPrecisionSubscription(candidate, user.id) };
                break;
            } catch {}
        }
        if (!selected && typeof stripe.subscriptions.search === 'function') {
            const escapedUserId = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const discovered = await stripe.subscriptions.search({
                query: `metadata['base44_user_id']:'${escapedUserId}'`,
                limit: 20,
                expand: ['data.latest_invoice']
            });
            for (const candidate of discovered.data || []) candidates.set(candidate.id, candidate);
            for (const candidate of orderedCandidates()) {
                try {
                    selected = { subscription: candidate, invoice: assertPaidPrecisionSubscription(candidate, user.id) };
                    break;
                } catch {}
            }
        }
        if (!selected) {
            throw Object.assign(new Error('An active paid Precision subscription with a current positive payment is required.'), { status: 409 });
        }
        const { subscription, invoice } = selected;
        const periodStart = stripeTimestampIso(subscription.current_period_start);
        const periodEnd = stripeTimestampIso(subscription.current_period_end);
        if (!periodStart || !periodEnd) {
            return Response.json({ error: 'Stripe did not return a valid current billing period.' }, { status: 409 });
        }
        const periodStartMs = asTimestamp(periodStart);
        const periodEndMs = asTimestamp(periodEnd);

        const jobs = await loadJobs(base44, user);
        const legacyJobs = jobs
            .filter(job => !job.precision_usage_kind && job.status === 'completed')
            .sort((left, right) => (asTimestamp(left.started_at || left.created_date) || 0) - (asTimestamp(right.started_at || right.created_date) || 0));
        let trialAssigned = jobs
            .filter(job => job.precision_usage_kind === 'trial')
            .reduce((sum, job) => sum + Math.max(0, Number(job.precision_usage_count || 0)), 0);
        let reconciledJobs = 0;

        for (const job of legacyJobs) {
            const count = legacyCompletedCount(job);
            const startedAt = asTimestamp(job.started_at || job.created_date || job.dry_run_metadata?.batchdata_only_started_at);
            let kind = 'unmetered';
            if (startedAt !== null && periodStartMs !== null && startedAt >= periodStartMs && (periodEndMs === null || startedAt < periodEndMs)) {
                kind = 'paid';
            } else if (trialAssigned < FREE_PROPERTY_LIMIT) {
                kind = 'trial';
                trialAssigned += count;
            }

            await base44.asServiceRole.entities.FetchJob.update(job.id, {
                precision_usage_user_id: user.id,
                precision_usage_kind: kind,
                ...(kind === 'paid' ? {
                    precision_subscription_id: subscription.id,
                    precision_invoice_id: invoice.id,
                    precision_usage_period_start: periodStart,
                    precision_usage_period_end: periodEnd
                } : {}),
                precision_usage_reserved: 0,
                precision_usage_count: count,
                precision_usage_recorded_at: job.completed_at || new Date().toISOString()
            });
            Object.assign(job, {
                precision_usage_kind: kind,
                precision_usage_period_start: kind === 'paid' ? periodStart : null,
                precision_usage_count: count,
                precision_usage_reserved: 0,
                precision_usage_recorded_at: job.completed_at || new Date().toISOString()
            });
            reconciledJobs++;
        }

        const trialProperties = Math.min(FREE_PROPERTY_LIMIT, jobs
            .filter(job => job.precision_usage_kind === 'trial')
            .reduce((sum, job) => sum + Math.max(0, Number(job.precision_usage_count || 0)), 0));
        const paidProperties = Math.min(PAID_PROPERTY_LIMIT, jobs
            .filter(job => job.precision_usage_kind === 'paid' && Math.abs((asTimestamp(job.precision_usage_period_start) || 0) - (periodStartMs || 0)) < 1000)
            .reduce((sum, job) => sum + Math.max(0, Number(job.precision_usage_count || 0)), 0));

        await base44.asServiceRole.entities.User.update(user.id, {
            subscription_period_start: periodStart,
            subscription_period_end: periodEnd,
            precision_usage_period_start: periodStart,
            precision_usage_period_end: periodEnd,
            precision_usage_reconciled_at: new Date().toISOString(),
            precision_usage_reconciliation_version: RECONCILIATION_VERSION,
            precision_trial_properties_credited: trialProperties
        });

        return Response.json({
            success: true,
            reconciled: reconciledJobs > 0,
            reconciled_jobs: reconciledJobs,
            precision_usage_period_start: periodStart,
            precision_usage_period_end: periodEnd,
            trial_properties_credited: trialProperties,
            paid_properties_used: paidProperties,
            paid_properties_remaining: Math.max(0, PAID_PROPERTY_LIMIT - paidProperties),
            paid_property_limit: PAID_PROPERTY_LIMIT
        });
    } catch (error: any) {
        console.error('[reconcilePrecisionUsage] Failed:', error?.message || error);
        return Response.json({ error: error.message }, { status: error.status || 500 });
    }
});
