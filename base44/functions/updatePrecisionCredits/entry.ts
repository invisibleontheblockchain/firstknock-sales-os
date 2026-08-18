import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import Stripe from 'npm:stripe@14.14.0';
import { secrets } from 'base44:runtime';
import {
    BASE_PRECISION_PROPERTIES,
    CREDIT_BLOCK_PRICE_CENTS,
    PRECISION_CREDIT_COMPONENT,
    configuredExtraCredits,
    isPrecisionCreditPrice,
    normalizeExtraCreditBlocks
} from '../../shared/precisionCredits.js';

function belongsToUser(subscription, userId) {
    return String(subscription?.metadata?.base44_user_id || '') === String(userId);
}

function currentInvoiceIsPaid(subscription) {
    const invoice = subscription?.latest_invoice;
    return invoice && typeof invoice !== 'string' && invoice.status === 'paid' && Number(invoice.amount_paid || 0) > 0;
}

export default async function(req) {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const extraBlocks = normalizeExtraCreditBlocks(body.extra_blocks);
        if (extraBlocks === null) {
            return Response.json({ error: 'Extra usage must be from 0 to 49 blocks of 1,000 properties.' }, { status: 400 });
        }

        const stripe = new Stripe(secrets.get('STRIPE_SECRET_KEY'));
        const candidates = new Map();
        if (user.subscription_id) {
            try {
                const direct = await stripe.subscriptions.retrieve(String(user.subscription_id), { expand: ['latest_invoice'] });
                candidates.set(direct.id, direct);
            } catch (error) {
                if (error?.raw?.code !== 'resource_missing') throw error;
            }
        }
        if (user.stripe_customer_id) {
            const listed = await stripe.subscriptions.list({
                customer: String(user.stripe_customer_id), status: 'all', limit: 100, expand: ['data.latest_invoice']
            });
            for (const subscription of listed.data || []) candidates.set(subscription.id, subscription);
        }

        const subscriptions = [...candidates.values()].filter(subscription => belongsToUser(subscription, user.id));
        const subscription = subscriptions.find(candidate => candidate.id === user.subscription_id)
            || subscriptions.find(candidate => candidate.status === 'active');
        const baseItem = subscription?.items?.data?.find(item => !isPrecisionCreditPrice(item.price) && Number(item?.price?.unit_amount || 0) >= 9900);
        const trialEnded = !subscription?.trial_end || Number(subscription.trial_end) * 1000 <= Date.now();
        if (!subscription || subscription.status !== 'active' || !trialEnded || !baseItem || !currentInvoiceIsPaid(subscription)) {
            return Response.json({ error: 'A paid, active $99 Precision subscription is required before adding rollover credits.' }, { status: 403 });
        }
        if (subscription.pending_update) {
            return Response.json({ error: 'A billing change is already awaiting payment.' }, { status: 409 });
        }

        const creditItem = subscription.items.data.find(item => isPrecisionCreditPrice(item.price));
        const creditPriceMatches = Number(creditItem?.price?.unit_amount || 0) === CREDIT_BLOCK_PRICE_CENTS
            && creditItem?.price?.currency === 'usd'
            && creditItem?.price?.recurring?.interval === 'month';
        const currentExtraBlocks = configuredExtraCredits(subscription) / 1000;
        if (currentExtraBlocks === extraBlocks && (extraBlocks === 0 || creditPriceMatches)) {
            return Response.json({ success: true, unchanged: true, extra_blocks: extraBlocks, configured_extra_credits: extraBlocks * 1000 });
        }
        const isIncrease = extraBlocks > currentExtraBlocks;

        const items = [];
        if (extraBlocks === 0 && creditItem) {
            items.push({ id: creditItem.id, deleted: true });
        } else if (extraBlocks > 0 && creditItem && creditPriceMatches) {
            items.push({ id: creditItem.id, quantity: extraBlocks });
        } else if (extraBlocks > 0) {
            const price = await stripe.prices.create({
                currency: 'usd',
                unit_amount: CREDIT_BLOCK_PRICE_CENTS,
                recurring: { interval: 'month' },
                product_data: { name: 'FirstKnock Precision Rollover Credits' },
                metadata: { billing_component: PRECISION_CREDIT_COMPONENT, properties_per_block: '1000' }
            }, { idempotencyKey: 'firstknock-precision-rollover-price-v2-4900' });
            items.push(creditItem
                ? { id: creditItem.id, price: price.id, quantity: extraBlocks }
                : { price: price.id, quantity: extraBlocks });
        }

        const updated = await stripe.subscriptions.update(subscription.id, {
            items,
            metadata: { ...subscription.metadata, precision_extra_blocks: String(extraBlocks) },
            proration_behavior: isIncrease ? 'always_invoice' : 'none',
            payment_behavior: isIncrease ? 'pending_if_incomplete' : 'allow_incomplete',
            expand: ['latest_invoice.payment_intent']
        }, { idempotencyKey: `firstknock-precision-credits-v2-4900-${subscription.id}-${extraBlocks}-${subscription.items.data.map(item => `${item.id}:${item.quantity || 1}`).join('_')}` });
        const invoice = typeof updated.latest_invoice === 'string'
            ? await stripe.invoices.retrieve(updated.latest_invoice)
            : updated.latest_invoice;

        return Response.json({
            success: true,
            extra_blocks: extraBlocks,
            configured_extra_credits: extraBlocks * 1000,
            total_monthly_properties: BASE_PRECISION_PROPERTIES + extraBlocks * 1000,
            monthly_total_cents: 9900 + extraBlocks * CREDIT_BLOCK_PRICE_CENTS,
            payment_pending: invoice?.status === 'open',
            url: invoice?.status === 'open' ? invoice.hosted_invoice_url || null : null
        });
    } catch (error) {
        console.error('[updatePrecisionCredits] Failed:', error?.message || error);
        return Response.json({ error: error?.message || 'Unable to update Precision credits.' }, { status: Number(error?.statusCode || 500) });
    }
}