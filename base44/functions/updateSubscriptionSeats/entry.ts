import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import Stripe from 'npm:stripe@^14.0.0';

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY"), {
  apiVersion: '2023-10-16',
});
const FIRSTKNOCK_ORIGIN = 'https://firstknock.online';

function firstKnockReturnUrl(value) {
    try {
        const url = new URL(String(value || ''));
        if (['https://firstknock.online', 'https://www.firstknock.online'].includes(url.origin)) {
            return `${FIRSTKNOCK_ORIGIN}${url.pathname}${url.search}${url.hash}`;
        }
    } catch {}
    return `${FIRSTKNOCK_ORIGIN}/AdminTeam`;
}

function stripeResourceId(resource) {
    if (!resource) return null;
    return typeof resource === 'string' ? resource : resource.id || null;
}

function belongsToUser(subscription, userId) {
    return String(subscription?.metadata?.base44_user_id || '') === String(userId);
}

function isMissingStripeResource(error, param) {
    return error?.raw?.code === 'resource_missing' && (!param || error?.raw?.param === param);
}

async function resolveVerifiedActiveSubscription(user) {
    const candidates = new Map();

    if (user.subscription_id) {
        try {
            const subscription = await stripe.subscriptions.retrieve(String(user.subscription_id));
            candidates.set(subscription.id, subscription);
        } catch (error) {
            if (!isMissingStripeResource(error)) throw error;
        }
    }

    if (user.stripe_customer_id) {
        try {
            const subscriptions = await stripe.subscriptions.list({
                customer: String(user.stripe_customer_id),
                status: 'active',
                limit: 100,
                expand: ['data.items']
            });
            for (const subscription of subscriptions.data || []) {
                candidates.set(subscription.id, subscription);
            }
        } catch (error) {
            if (!isMissingStripeResource(error, 'customer')) throw error;
        }
    }

    const verified = [...candidates.values()].filter(subscription =>
        subscription.status === 'active' && belongsToUser(subscription, user.id)
    );
    const direct = verified.find(subscription => subscription.id === user.subscription_id);
    if (direct) return direct;
    if (verified.length > 1) {
        throw Object.assign(
            new Error('Multiple active Stripe subscriptions are linked to this account. Contact support before changing seats.'),
            { status: 409 }
        );
    }
    return verified[0] || null;
}

// Helper to manage invite codes (inlined)
async function syncInviteCode(base44, userId, totalSeats) {
    try {
        const existingCodes = await base44.entities.InviteCode.filter({ linked_user_id: userId });
        const items = Array.isArray(existingCodes) ? existingCodes : (existingCodes?.items || []);
        
        if (items.length > 0) {
            await base44.entities.InviteCode.update(items[0].id, {
                max_uses: totalSeats,
                is_active: true
            });
        } else {
            const randomCode = Math.floor(100000 + Math.random() * 900000).toString();
            await base44.entities.InviteCode.create({
                code: randomCode,
                role: 'rep',
                label: 'Team Invite Code',
                max_uses: totalSeats,
                linked_user_id: userId,
                is_active: true
            });
        }
    } catch (e) {
        console.error("Error syncing invite code:", e);
    }
}

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                }
            });
        }

        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized or no subscription' }, { status: 401 });
        }

        const { quantity, returnUrl } = await req.json();
        const newSeatCount = parseInt(quantity);
        const stripeReturnUrl = firstKnockReturnUrl(returnUrl);

        // User billing IDs are discovery hints only. Exact Stripe metadata is
        // required before this endpoint can mutate a subscription or expose a
        // billing portal for its customer.
        const subscription = await resolveVerifiedActiveSubscription(user);
        const customerId = stripeResourceId(subscription?.customer);
        if (!subscription || !customerId) {
             return Response.json({ error: 'No verified active subscription found' }, { status: 404 });
        }
        const itemId = subscription.items.data[0].id;
        const repSeatPrice = await stripe.prices.create({
            currency: 'usd',
            unit_amount: 9900,
            recurring: { interval: 'month' },
            product_data: { name: 'FirstKnock Rep Seat' }
        });

        // 2. Update quantity in Stripe and invoice immediately.
        // Do not update Base44 seats here — webhook payment confirmation activates the seats.
        const updatedSubscription = await stripe.subscriptions.update(
            subscription.id,
            {
                items: [{
                    id: itemId,
                    price: repSeatPrice.id,
                    quantity: newSeatCount
                }],
                proration_behavior: 'always_invoice',
                payment_behavior: 'pending_if_incomplete',
                expand: ['latest_invoice.payment_intent']
            }
        );

        let invoice = updatedSubscription.latest_invoice;
        if (invoice && typeof invoice === 'string') {
            invoice = await stripe.invoices.retrieve(invoice);
        }
        if (invoice && invoice.status === 'draft') {
            invoice = await stripe.invoices.finalizeInvoice(invoice.id);
        }
        if (invoice && invoice.id && !invoice.hosted_invoice_url) {
            invoice = await stripe.invoices.retrieve(invoice.id);
        }

        let stripeUrl = invoice?.hosted_invoice_url || null;
        if (!stripeUrl) {
            const portalSession = await stripe.billingPortal.sessions.create({
                customer: customerId,
                return_url: stripeReturnUrl
            });
            stripeUrl = portalSession.url;
        }

        return Response.json({ 
            success: true, 
            status: updatedSubscription.status,
            new_quantity: newSeatCount,
            invoice_status: invoice?.status || null,
            invoice_url: stripeUrl,
            url: stripeUrl
        });

    } catch (error) {
        console.error('Update seats error:', error);
        return Response.json({ error: error.message }, { status: error.status || 500 });
    }
});
