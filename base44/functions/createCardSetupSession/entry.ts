import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Stripe from 'npm:stripe@14.14.0';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '');
const FIRSTKNOCK_ORIGIN = 'https://firstknock.online';

class HttpError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function safeReturnUrl(value: any, fallbackPath: string) {
    try {
        const url = new URL(String(value || ''));
        if (['https://firstknock.online', 'https://www.firstknock.online'].includes(url.origin)) {
            return `${FIRSTKNOCK_ORIGIN}${url.pathname}${url.search}${url.hash}`;
        }
    } catch {}
    return `${FIRSTKNOCK_ORIGIN}${fallbackPath}`;
}

function customerBelongsToUser(customer: any, user: any) {
    return !!customer
        && customer.deleted !== true
        && String(customer?.metadata?.base44_user_id || '') === String(user?.id || '');
}

async function retrieveOwnedCustomer(customerId: any, user: any) {
    if (!customerId) return null;
    try {
        const customer = await stripe.customers.retrieve(String(customerId));
        return customerBelongsToUser(customer, user) ? customer : null;
    } catch (error: any) {
        if (error?.raw?.code === 'resource_missing') return null;
        throw error;
    }
}

async function discoverOwnedCustomer(user: any) {
    const cached = await retrieveOwnedCustomer(user.stripe_customer_id, user);
    if (cached) return cached;

    const customerIds = new Set();
    if (typeof stripe.subscriptions.search === 'function') {
        const escapedUserId = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const subscriptions = await stripe.subscriptions.search({
            query: `metadata['base44_user_id']:'${escapedUserId}'`,
            limit: 100
        });
        for (const subscription of subscriptions.data || []) {
            const id = typeof subscription.customer === 'string'
                ? subscription.customer
                : subscription.customer?.id;
            if (
                id
                && String(subscription.metadata?.base44_user_id || '') === String(user.id)
            ) customerIds.add(id);
        }
    }
    if (customerIds.size > 1) {
        throw new HttpError(
            409,
            'billing_identity_ambiguous',
            'More than one Stripe customer is attached to this account. Contact support before adding a card.'
        );
    }
    if (customerIds.size === 1) {
        const customer = await retrieveOwnedCustomer([...customerIds][0], user);
        if (customer) return customer;
    }

    if (typeof stripe.customers.search !== 'function') return null;
    const escapedUserId = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await stripe.customers.search({
        query: `metadata['base44_user_id']:'${escapedUserId}'`,
        limit: 10
    });
    const owned = (result.data || []).filter((customer: any) => customerBelongsToUser(customer, user));
    if (owned.length > 1) {
        throw new HttpError(
            409,
            'billing_identity_ambiguous',
            'More than one Stripe customer matches this account. Contact support before adding a card.'
        );
    }
    return owned[0] || null;
}

Deno.serve(async (req: Request) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') {
            return Response.json({ error: 'Method not allowed' }, { status: 405 });
        }
        if (!Deno.env.get('STRIPE_SECRET_KEY')) {
            throw new HttpError(503, 'billing_unavailable', 'Card setup is temporarily unavailable.');
        }

        const base44 = createClientFromRequest(req);
        const authenticatedUser = await base44.auth.me();
        if (!authenticatedUser) throw new HttpError(401, 'unauthorized', 'Unauthorized');
        const user = await base44.asServiceRole.entities.User.get(authenticatedUser.id);
        if (!user || String(user.email || '').toLowerCase() !== String(authenticatedUser.email || '').toLowerCase()) {
            throw new HttpError(401, 'invalid_authenticated_user', 'The authenticated account could not be verified.');
        }
        if (user.team_manager_id) {
            throw new HttpError(
                403,
                'manager_billing_required',
                'Your workspace manager must add the team billing card.'
            );
        }

        const body = await req.json().catch(() => ({}));
        const successUrl = safeReturnUrl(body.successUrl, '/Home?card_setup=success');
        const cancelUrl = safeReturnUrl(body.cancelUrl, '/Home?card_setup=canceled');
        let customer = await discoverOwnedCustomer(user);
        if (!customer) {
            customer = await stripe.customers.create({
                email: user.email,
                name: user.full_name,
                metadata: { base44_user_id: user.id }
            }, {
                idempotencyKey: `firstknock-card-customer-${user.id}`
            });
        }
        await base44.asServiceRole.entities.User.update(user.id, {
            stripe_customer_id: customer.id
        });

        const listed = await stripe.checkout.sessions.list({
            customer: customer.id,
            limit: 100
        });
        const managedSetupSessions = (listed.data || []).filter((session: any) =>
            session.mode === 'setup'
            && (
                session.metadata?.base44_user_id === user.id
                || session.client_reference_id === user.id
            )
        );
        const latest = managedSetupSessions[0] || null;
        const open = managedSetupSessions.filter((session: any) => session.status === 'open');
        const reusable = open.find((session: any) =>
            session.metadata?.checkout_intent === 'knock_card_gate'
        );
        await Promise.all(
            open
                .filter((session: any) => session.id !== reusable?.id)
                .map((session: any) => stripe.checkout.sessions.expire(session.id))
        );
        if (reusable?.url) {
            return Response.json({ success: true, url: reusable.url, reused: true });
        }

        const metadata = {
            base44_user_id: user.id,
            checkout_intent: 'knock_card_gate',
            base44_app_id: Deno.env.get('BASE44_APP_ID') || ''
        };
        const generation = latest?.id || 'initial';
        const session = await stripe.checkout.sessions.create({
            mode: 'setup',
            customer: customer.id,
            payment_method_types: ['card'],
            success_url: successUrl,
            cancel_url: cancelUrl,
            client_reference_id: user.id,
            metadata
        }, {
            idempotencyKey: `firstknock-card-setup-${user.id}-${customer.id}-${generation}`
        });

        return Response.json({ success: true, url: session.url, reused: false });
    } catch (error: any) {
        if (!(error instanceof HttpError)) {
            console.error('Card setup error:', error?.message || error);
        }
        return Response.json({
            error: error?.message || 'Unable to start card setup.',
            code: error?.code || 'card_setup_failed'
        }, { status: Number(error?.status || error?.statusCode || 500) });
    }
});
