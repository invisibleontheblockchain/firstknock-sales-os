import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import Stripe from 'npm:stripe@14.14.0';
import { secrets } from 'base44:runtime';
import {
    CREDIT_BLOCK_PRICE_CENTS,
    PRECISION_CREDIT_COMPONENT,
    PRECISION_CREDIT_PACK_INTENT,
    creditPackProperties,
    isPrecisionCreditPrice,
    normalizeCreditPackBlocks
} from '../../shared/precisionCredits.js';

/**
 * Sells a one-off pack of Precision credits.
 *
 * This is deliberately separate from the $99 subscription. The plan is bought
 * and cancelled on its own terms; a pack is a single payment that tops up the
 * rollover ledger and never appears on a renewal. Nothing here touches the
 * subscription, so a pack purchase cannot change what the customer pays monthly.
 *
 * Credits are only granted by the webhook once Stripe reports the payment as
 * paid, so a completed Checkout that never settles grants nothing.
 */

function belongsToUser(subscription: any, userId: string) {
    return String(subscription?.metadata?.base44_user_id || '') === String(userId);
}

function currentInvoiceIsPaid(subscription: any) {
    const invoice = subscription?.latest_invoice;
    return invoice && typeof invoice !== 'string' && invoice.status === 'paid' && Number(invoice.amount_paid || 0) > 0;
}

function safeReturnUrl(candidate: unknown, fallbackPath: string) {
    const appUrl = String(Deno.env.get('BASE44_APP_URL') || '');
    try {
        const url = new URL(String(candidate));
        if (url.protocol !== 'https:' && url.hostname !== 'localhost') return null;
        return url.toString();
    } catch {
        return appUrl ? new URL(fallbackPath, appUrl).toString() : null;
    }
}

export default async function(req: Request) {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const blocks = normalizeCreditPackBlocks(body.blocks);
        if (blocks === null) {
            return Response.json(
                { error: 'A credit pack must be from 1 to 49 blocks of 1,000 properties.' },
                { status: 400 }
            );
        }

        const stripe = new Stripe(secrets.get('STRIPE_SECRET_KEY'));

        // Credits only mean something on a paid account: getPrecisionUsage reads
        // the ledger for paid entitlements only, so selling a pack to a free or
        // trialing account would take the money and raise no limit.
        const candidates = new Map<string, any>();
        if (user.subscription_id) {
            try {
                const direct = await stripe.subscriptions.retrieve(String(user.subscription_id), { expand: ['latest_invoice'] });
                candidates.set(direct.id, direct);
            } catch (error: any) {
                if (error?.raw?.code !== 'resource_missing') throw error;
            }
        }
        if (user.stripe_customer_id) {
            const listed = await stripe.subscriptions.list({
                customer: String(user.stripe_customer_id), status: 'all', limit: 100, expand: ['data.latest_invoice']
            });
            for (const subscription of listed.data || []) candidates.set(subscription.id, subscription);
        }

        const owned = [...candidates.values()].filter(subscription => belongsToUser(subscription, user.id));
        const subscription = owned.find(candidate => candidate.id === user.subscription_id)
            || owned.find(candidate => candidate.status === 'active');
        const baseItem = subscription?.items?.data?.find(
            (item: any) => !isPrecisionCreditPrice(item.price) && Number(item?.price?.unit_amount || 0) >= 9900
        );
        const trialEnded = !subscription?.trial_end || Number(subscription.trial_end) * 1000 <= Date.now();
        if (!subscription || subscription.status !== 'active' || !trialEnded || !baseItem || !currentInvoiceIsPaid(subscription)) {
            return Response.json(
                { error: 'A paid, active $99 Precision subscription is required before buying credit packs.' },
                { status: 403 }
            );
        }

        const customerId = String(user.stripe_customer_id || subscription.customer || '');
        if (!customerId) {
            return Response.json({ error: 'No Stripe customer is attached to this account.' }, { status: 409 });
        }

        // A one-time price, distinct from the recurring add-on price. It carries
        // the same billing_component so the ledger recognises what it funded.
        const price = await stripe.prices.create({
            currency: 'usd',
            unit_amount: CREDIT_BLOCK_PRICE_CENTS,
            product_data: { name: 'FirstKnock Precision Credit Pack' },
            metadata: {
                billing_component: PRECISION_CREDIT_COMPONENT,
                properties_per_block: '1000',
                purchase_kind: 'credit_pack'
            }
        }, { idempotencyKey: 'firstknock-precision-credit-pack-price-v1-4900' });

        const successUrl = safeReturnUrl(body.successUrl, '/Billing?credits=purchased');
        const cancelUrl = safeReturnUrl(body.cancelUrl, '/Billing?credits=canceled');
        if (!successUrl || !cancelUrl) {
            return Response.json({ error: 'Could not resolve a safe return URL for Checkout.' }, { status: 400 });
        }

        const metadata = {
            base44_user_id: String(user.id),
            checkout_intent: PRECISION_CREDIT_PACK_INTENT,
            precision_credit_blocks: String(blocks),
            precision_credit_properties: String(creditPackProperties(blocks)),
            precision_subscription_id: String(subscription.id)
        };

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            customer: customerId,
            line_items: [{ price: price.id, quantity: blocks }],
            automatic_tax: { enabled: true },
            billing_address_collection: 'required',
            customer_update: { address: 'auto', name: 'auto' },
            success_url: successUrl,
            cancel_url: cancelUrl,
            client_reference_id: String(user.id),
            metadata,
            payment_intent_data: { metadata }
        });

        return Response.json({
            success: true,
            url: session.url,
            blocks,
            properties: creditPackProperties(blocks),
            amount_cents: blocks * CREDIT_BLOCK_PRICE_CENTS
        });
    } catch (error: any) {
        console.error('[purchasePrecisionCredits] Failed:', error?.message || error);
        return Response.json(
            { error: error?.message || 'Unable to start the credit pack checkout.' },
            { status: Number(error?.statusCode || 500) }
        );
    }
}
