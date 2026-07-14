import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.14.0';

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
    return `${FIRSTKNOCK_ORIGIN}/Billing`;
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

async function resolveVerifiedSubscription(user) {
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
                status: 'all',
                limit: 100
            });
            for (const subscription of subscriptions.data || []) {
                candidates.set(subscription.id, subscription);
            }
        } catch (error) {
            if (!isMissingStripeResource(error, 'customer')) throw error;
        }
    }

    const verified = [...candidates.values()].filter(subscription => belongsToUser(subscription, user.id));
    if (verified.length === 0) return null;

    const customerIds = new Set(verified.map(subscription => stripeResourceId(subscription.customer)).filter(Boolean));
    if (customerIds.size !== 1) {
        const error = new Error('Multiple verified Stripe customers are linked to this account. Contact support.');
        error.status = 409;
        throw error;
    }

    return verified.find(subscription => subscription.id === user.subscription_id)
        || verified.find(subscription => ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'].includes(subscription.status))
        || verified[0];
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
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { returnUrl } = await req.json();

        // User billing IDs are writable profile caches. They may help discover
        // Stripe objects, but only exact server-side ownership metadata proves
        // that this account may manage the resulting customer.
        const subscription = await resolveVerifiedSubscription(user);
        const customerId = stripeResourceId(subscription?.customer);
        if (!subscription || !customerId) {
            return Response.json({ error: 'No verified Stripe subscription found' }, { status: 404 });
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: firstKnockReturnUrl(returnUrl),
        });

        return Response.json({ url: session.url });

    } catch (error) {
        console.error('Portal error:', error);
        return Response.json({ error: error.message }, { status: error.status || 500 });
    }
});
