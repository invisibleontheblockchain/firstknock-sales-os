import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.14.0';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '');
const PLAN_CONFIG = {
    canvas: {
        amountCents: 1900,
        productName: 'FirstKnock Canvas Mode'
    },
    precision: {
        amountCents: 9900,
        productName: 'FirstKnock Precision Mode'
    }
};
const BLOCKING_SUBSCRIPTION_STATUSES = new Set([
    'active',
    'trialing',
    'past_due',
    'unpaid',
    'paused',
    'incomplete'
]);
const FIRSTKNOCK_ORIGIN = 'https://firstknock.online';

function firstKnockReturnUrl(value: any, fallbackPath: string) {
    try {
        const url = new URL(String(value || ''));
        if (['https://firstknock.online', 'https://www.firstknock.online'].includes(url.origin)) {
            return `${FIRSTKNOCK_ORIGIN}${url.pathname}${url.search}${url.hash}`;
        }
    } catch {}
    return `${FIRSTKNOCK_ORIGIN}${fallbackPath}`;
}

function isBlockingSubscription(subscription: any) {
    return BLOCKING_SUBSCRIPTION_STATUSES.has(String(subscription?.status || '').toLowerCase());
}

function subscriptionBelongsToUser(subscription: any, user: any) {
    if (!subscription || !user) return false;
    return String(subscription.metadata?.base44_user_id || '') === String(user.id);
}

async function searchOwnedSubscriptions(user: any, expand: string[] = []) {
    if (typeof stripe.subscriptions.search !== 'function') return [];
    const escapedUserId = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await stripe.subscriptions.search({
        query: `metadata['base44_user_id']:'${escapedUserId}'`,
        limit: 100,
        ...(expand.length > 0 ? { expand } : {})
    });
    return (result.data || []).filter((subscription: any) => subscriptionBelongsToUser(subscription, user));
}

async function resolveOwnedCustomerId(user: any, subscriptions: any[] = []) {
    const ownedSubscription = subscriptions.find((subscription: any) => subscriptionBelongsToUser(subscription, user));
    const subscriptionCustomerId = stripeResourceId(ownedSubscription?.customer);
    if (subscriptionCustomerId) return subscriptionCustomerId;

    if (!user?.stripe_customer_id || typeof stripe.customers?.retrieve !== 'function') return null;
    try {
        const customer = await stripe.customers.retrieve(String(user.stripe_customer_id));
        if (!customer?.deleted && String(customer?.metadata?.base44_user_id || '') === String(user.id)) {
            return customer.id;
        }
    } catch (error: any) {
        if (!isMissingStripeResource(error)) throw error;
    }
    return null;
}

function selectBlockingSubscription(storedSubscription: any, customerSubscriptions: any[], user: any) {
    const candidates = [];
    const seen = new Set();

    for (const subscription of [storedSubscription, ...(customerSubscriptions || [])]) {
        if (!subscription || seen.has(subscription.id)) continue;
        seen.add(subscription.id);
        if (!isBlockingSubscription(subscription)) continue;
        if (!subscriptionBelongsToUser(subscription, user)) continue;
        candidates.push(subscription);
    }

    return {
        subscription: candidates.length === 1 ? candidates[0] : null,
        ambiguous: candidates.length > 1
    };
}

function stripeResourceId(resource: any) {
    if (!resource) return null;
    return typeof resource === 'string' ? resource : resource.id || null;
}

function invoiceHasPositivePayment(invoice: any) {
    return invoice?.status === 'paid' && Number(invoice?.amount_paid || 0) > 0;
}

function subscriptionHasPaidInvoice(subscription: any, invoice: any) {
    const trialEnded = !subscription?.trial_end || subscription.trial_end * 1000 <= Date.now();
    return subscription?.status === 'active' && trialEnded && invoiceHasPositivePayment(invoice);
}

function existingSubscriptionResponse(subscription: any) {
    const isTrial = subscription?.status === 'trialing';
    return Response.json({
        error: isTrial
            ? 'You already have an active free trial. Use Upgrade Now to start billing without creating a second subscription.'
            : 'You already have a Stripe subscription. Open the billing portal to manage or finish its payment.'
    }, { status: 409 });
}

function isMissingStripeResource(error: any, param?: string) {
    return error?.raw?.code === 'resource_missing' && (!param || error?.raw?.param === param);
}

async function retrieveSubscription(subscriptionId: string | null | undefined, expandInvoice = false) {
    if (!subscriptionId) return null;

    try {
        return await stripe.subscriptions.retrieve(
            subscriptionId,
            expandInvoice ? { expand: ['latest_invoice.payment_intent'] } : undefined
        );
    } catch (error: any) {
        if (isMissingStripeResource(error)) return null;
        throw error;
    }
}

async function createStripeCustomer(base44: any, user: any) {
    const customer = await stripe.customers.create({
        email: user.email,
        name: user.full_name,
        metadata: { base44_user_id: user.id }
    });
    await base44.asServiceRole.entities.User.update(user.id, { stripe_customer_id: customer.id });
    return customer.id;
}

async function resolvePlanQuantity(base44: any, user: any, planId: string, requestedQuantity: number) {
    // Precision supports the established Admin Team flow that intentionally
    // purchases multiple $99 seats. Canvas is tied to the live rep roster and
    // therefore must be counted on the server.
    if (planId !== 'canvas') return requestedQuantity;

    const members: any[] = [];
    const pageSize = 500;
    for (let skip = 0; skip < 5000; skip += pageSize) {
        const result = await base44.asServiceRole.entities.TeamMember.filter(
            { manager_id: user.id, role: 'rep' },
            '-created_date',
            pageSize,
            skip
        );
        const page = Array.isArray(result) ? result : (result?.items || []);
        members.push(...page);
        if (page.length < pageSize) {
            return Math.max(1, members.filter((member: any) => member.status !== 'inactive').length);
        }
    }

    throw new Error('Unable to verify the full Canvas team size. Please contact support before checkout.');
}

async function createRecoveryUrl(customerId: string, invoice: any, returnUrl: string | undefined, origin: string | null) {
    if (invoice?.hosted_invoice_url) return invoice.hosted_invoice_url;

    const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: firstKnockReturnUrl(returnUrl || origin, '/Billing')
    });
    return portalSession.url;
}

async function activateTrialSubscription({
    base44,
    user,
    planId,
    plan,
    quantity,
    returnUrl,
    origin
}: any) {
    const storedSubscription = await retrieveSubscription(user.subscription_id, true);
    const discoveredSubscriptions = await searchOwnedSubscriptions(user, ['data.latest_invoice.payment_intent']);
    const ownedStoredSubscription = subscriptionBelongsToUser(storedSubscription, user) ? storedSubscription : null;
    let customerId = await resolveOwnedCustomerId(user, [ownedStoredSubscription, ...discoveredSubscriptions].filter(Boolean));
    if (!customerId) {
        await base44.asServiceRole.entities.User.update(user.id, {
            subscription_status: 'canceled',
            subscription_paid_confirmed: false
        });
        return Response.json({
            error: 'No Stripe trial was found. Your billing status was refreshed; choose a paid plan again.',
            billing_reconciled: true
        }, { status: 409 });
    }
    if (customerId !== user.stripe_customer_id) {
        await base44.asServiceRole.entities.User.update(user.id, { stripe_customer_id: customerId });
    }
    const billingUser = { ...user, stripe_customer_id: customerId };

    const listed = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
        expand: ['data.latest_invoice.payment_intent']
    });
    const selection = selectBlockingSubscription(ownedStoredSubscription, [...discoveredSubscriptions, ...(listed.data || [])], billingUser);

    if (selection.ambiguous) {
        return Response.json({
            error: 'More than one active Stripe subscription was found. Please contact support before paying so you are not charged twice.'
        }, { status: 409 });
    }
    if (!selection.subscription) {
        const reconciledStatus = storedSubscription && subscriptionBelongsToUser(storedSubscription, billingUser)
            ? storedSubscription.status
            : 'canceled';
        await base44.asServiceRole.entities.User.update(user.id, {
            subscription_status: reconciledStatus,
            subscription_paid_confirmed: false
        });
        return Response.json({
            error: 'No active trial was found. Your billing status was refreshed; choose a paid plan again.',
            billing_reconciled: true
        }, { status: 409 });
    }

    let trialSubscription = selection.subscription;
    const selectedLatestInvoice = typeof trialSubscription.latest_invoice === 'string'
        ? await stripe.invoices.retrieve(trialSubscription.latest_invoice)
        : trialSubscription.latest_invoice;

    if (trialSubscription.status !== 'trialing') {
        await base44.asServiceRole.entities.User.update(user.id, {
            subscription_id: trialSubscription.id,
            subscription_status: trialSubscription.status,
            stripe_customer_id: customerId
        });

        if (subscriptionHasPaidInvoice(trialSubscription, selectedLatestInvoice)) {
            return Response.json({
                success: true,
                already_active: true,
                subscription_id: trialSubscription.id,
                status: trialSubscription.status
            });
        }

        return Response.json({
            success: true,
            pending_payment: true,
            subscription_id: trialSubscription.id,
            status: trialSubscription.status,
            url: await createRecoveryUrl(customerId, selectedLatestInvoice, returnUrl, origin)
        });
    }

    if (trialSubscription.pending_update) {
        return Response.json({
            success: true,
            pending_payment: true,
            subscription_id: trialSubscription.id,
            status: trialSubscription.status,
            url: await createRecoveryUrl(customerId, selectedLatestInvoice, returnUrl, origin)
        });
    }

    const activationAttemptToken = stripeResourceId(selectedLatestInvoice)
        || stripeResourceId(trialSubscription.latest_invoice)
        || String(trialSubscription.trial_end || 'initial');
    const trialItems = trialSubscription.items?.data || [];
    if (trialItems.length !== 1) {
        return Response.json({
            error: 'This trial has a custom Stripe setup. Please contact support before changing it.'
        }, { status: 409 });
    }

    // Reconcile Base44 before charging so the webhook accepts events for the
    // exact subscription that is being converted.
    if (user.subscription_id !== trialSubscription.id) {
        await base44.asServiceRole.entities.User.update(user.id, {
            subscription_id: trialSubscription.id,
            subscription_status: 'trialing',
            stripe_customer_id: customerId
        });
    }

    const currentItem = trialSubscription.items.data[0];
    const currentPrice = currentItem.price;
    const currentAmount = Number(currentPrice?.unit_amount || currentPrice?.unit_amount_decimal || 0);
    const currentSubscriptionTier = String(trialSubscription.metadata?.subscription_tier || '').toLowerCase();
    const currentPriceTier = String(currentPrice?.metadata?.subscription_tier || '').toLowerCase();
    const tierMatchesPlan = !currentSubscriptionTier
        || currentSubscriptionTier === 'custom'
        || currentSubscriptionTier === planId
        || (planId === 'precision' && ['growth', 'pro', 'enterprise'].includes(currentSubscriptionTier));
    const priceTierMatchesPlan = !currentPriceTier || currentPriceTier === planId;
    const isExpectedMonthlyPrice = currentAmount === plan.amountCents
        && currentPrice?.currency === 'usd'
        && currentPrice?.recurring?.interval === 'month'
        && Number(currentPrice?.recurring?.interval_count || 1) === 1
        && tierMatchesPlan
        && priceTierMatchesPlan;

    let targetPriceId = currentPrice?.id;
    if (!isExpectedMonthlyPrice) {
        const targetPrice = await stripe.prices.create({
            currency: 'usd',
            unit_amount: plan.amountCents,
            recurring: { interval: 'month' },
            product_data: {
                name: plan.productName,
                metadata: { subscription_tier: planId }
            },
            metadata: {
                base44_user_id: user.id,
                subscription_tier: planId
            }
        }, {
            idempotencyKey: `firstknock-trial-price-${trialSubscription.id}-${planId}-${plan.amountCents}`
        });
        targetPriceId = targetPrice.id;
    }

    const updateParams: any = {
        trial_end: 'now',
        payment_behavior: 'pending_if_incomplete',
        proration_behavior: 'always_invoice',
        expand: ['latest_invoice.payment_intent']
    };
    if (!isExpectedMonthlyPrice || Number(currentItem.quantity || 1) !== quantity) {
        updateParams.items = [{
            id: currentItem.id,
            price: targetPriceId,
            quantity
        }];
    }

    const activatedSubscription = await stripe.subscriptions.update(
        trialSubscription.id,
        updateParams,
        { idempotencyKey: `firstknock-activate-trial-${trialSubscription.id}-${activationAttemptToken}` }
    );
    const latestInvoice = typeof activatedSubscription.latest_invoice === 'string'
        ? await stripe.invoices.retrieve(activatedSubscription.latest_invoice)
        : activatedSubscription.latest_invoice;
    const paid = subscriptionHasPaidInvoice(activatedSubscription, latestInvoice);

    return Response.json({
        success: true,
        paid,
        pending_payment: !paid,
        subscription_id: activatedSubscription.id,
        status: activatedSubscription.status,
        invoice_status: latestInvoice?.status || null,
        url: paid
            ? null
            : await createRecoveryUrl(customerId, latestInvoice, returnUrl, origin)
    });
}

Deno.serve(async (req: Request) => {
    try {
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204 });
        }

        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { action, successUrl, cancelUrl, returnUrl } = body;
        const safeSuccessUrl = firstKnockReturnUrl(successUrl, '/Billing?success=true');
        const safeCancelUrl = firstKnockReturnUrl(cancelUrl, '/Billing?canceled=true');
        const safeReturnUrl = firstKnockReturnUrl(returnUrl, '/Billing');
        const planId = typeof body.planId === 'string' ? body.planId.trim().toLowerCase() : '';
        const plan = PLAN_CONFIG[planId as keyof typeof PLAN_CONFIG];
        if (!plan) {
            return Response.json({ error: 'A valid billing plan is required.' }, { status: 400 });
        }

        const requestedQuantity = Number(body.quantity ?? 1);
        if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 100) {
            return Response.json({ error: 'Quantity must be a whole number from 1 to 100.' }, { status: 400 });
        }

        // Price is always server-controlled. Canvas quantity is also derived
        // from the live roster; Precision retains its intentional multi-seat
        // Admin Team checkout flow.
        const quantity = await resolvePlanQuantity(base44, user, planId, requestedQuantity);

        if (action === 'activate_trial') {
            return await activateTrialSubscription({
                base44,
                user,
                planId,
                plan,
                quantity,
                returnUrl: safeReturnUrl,
                origin: req.headers.get('origin')
            });
        }
        if (action) {
            return Response.json({ error: 'Unsupported billing action.' }, { status: 400 });
        }

        const trialDays = Number(body.trialDays || 0);
        if (trialDays !== 0 && trialDays !== 7) {
            return Response.json({ error: 'The free trial period must be exactly 7 days.' }, { status: 400 });
        }

        const storedSubscription = await retrieveSubscription(user.subscription_id);
        const discoveredSubscriptions = await searchOwnedSubscriptions(user);
        const ownedSubscriptions = [storedSubscription, ...discoveredSubscriptions]
            .filter((subscription, index, list) =>
                subscriptionBelongsToUser(subscription, user)
                && list.findIndex(candidate => candidate?.id === subscription?.id) === index
            );
        const ownedBlockingSubscriptions = ownedSubscriptions.filter(isBlockingSubscription);
        if (ownedBlockingSubscriptions.length > 1) {
            return Response.json({
                error: 'More than one active Stripe subscription was found. Please contact support before paying so you are not charged twice.'
            }, { status: 409 });
        }
        if (ownedBlockingSubscriptions[0]) {
            return existingSubscriptionResponse(ownedBlockingSubscriptions[0]);
        }

        let customerId = await resolveOwnedCustomerId(user, ownedSubscriptions) || await createStripeCustomer(base44, user);
        let customerSubscriptions: any[] = [];
        try {
            const existingSubscriptions = await stripe.subscriptions.list({
                customer: customerId,
                status: 'all',
                limit: 100
            });
            customerSubscriptions = existingSubscriptions.data;
        } catch (error: any) {
            if (!isMissingStripeResource(error, 'customer')) throw error;
            customerId = await createStripeCustomer(base44, user);
        }

        customerSubscriptions = customerSubscriptions.filter(subscription => subscriptionBelongsToUser(subscription, user));
        const existingSubscription = customerSubscriptions.find(isBlockingSubscription);
        if (existingSubscription) {
            return existingSubscriptionResponse(existingSubscription);
        }

        if (trialDays === 7) {
            const hasUsedTrial = customerSubscriptions.some((subscription) =>
                !!subscription.trial_start || subscription.metadata?.started_with_trial === 'true'
            );
            if (hasUsedTrial) {
                return Response.json({
                    error: 'This account has already used its free trial. Choose the pay-now option instead.'
                }, { status: 409 });
            }
        }

        const checkoutIntent = trialDays === 7 ? 'trial' : 'pay';
        const checkoutSessions = await stripe.checkout.sessions.list({
            customer: customerId,
            limit: 100
        });
        const managedSessions = checkoutSessions.data.filter((session: any) =>
            session.metadata?.base44_user_id === user.id || session.client_reference_id === user.id
        );
        const latestManagedSession = managedSessions[0] || null;
        const openManagedSessions = managedSessions.filter((session: any) =>
            session.status === 'open' && session.mode === 'subscription'
        );
        const reusableSession = openManagedSessions.find((session: any) =>
            session.mode === 'subscription'
            && session.metadata?.subscription_tier === planId
            && session.metadata?.checkout_intent === checkoutIntent
            && Number(session.metadata?.quantity || 1) === quantity
        );

        // Keep at most one Checkout capable of creating a subscription. The
        // next creation key is based on the previous session generation and is
        // intentionally independent of the newly selected plan, so concurrent
        // requests with different choices cannot both create sessions.
        const obsoleteOpenSessions = openManagedSessions.filter((session: any) => session.id !== reusableSession?.id);
        await Promise.all(obsoleteOpenSessions.map((session: any) => stripe.checkout.sessions.expire(session.id)));
        if (reusableSession?.url) {
            return Response.json({ url: reusableSession.url, reused: true });
        }

        const metadata = {
            base44_user_id: user.id,
            subscription_tier: planId,
            checkout_intent: checkoutIntent,
            quantity: String(quantity),
            started_with_trial: String(trialDays === 7)
        };
        const sessionConfig: any = {
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: plan.productName,
                        metadata: { subscription_tier: planId }
                    },
                    recurring: { interval: 'month' },
                    unit_amount: plan.amountCents
                },
                quantity
            }],
            subscription_data: {
                metadata,
                ...(trialDays === 7 ? { trial_period_days: 7 } : {})
            },
            success_url: safeSuccessUrl,
            cancel_url: safeCancelUrl,
            payment_method_collection: 'always',
            allow_promotion_codes: true,
            client_reference_id: user.id,
            metadata: {
                ...metadata,
                base44_app_id: Deno.env.get('BASE44_APP_ID') || ''
            },
            customer: customerId
        };

        const checkoutGeneration = latestManagedSession?.id || 'initial';
        const checkoutIdempotencyKey = `firstknock-checkout-${user.id}-${customerId}-${checkoutGeneration}`;
        let session;
        try {
            session = await stripe.checkout.sessions.create(sessionConfig, {
                idempotencyKey: checkoutIdempotencyKey
            });
        } catch (error: any) {
            if (!isMissingStripeResource(error, 'customer')) throw error;

            customerId = await createStripeCustomer(base44, user);
            session = await stripe.checkout.sessions.create({ ...sessionConfig, customer: customerId }, {
                idempotencyKey: `firstknock-checkout-${user.id}-${customerId}-initial`
            });
        }

        return Response.json({ url: session.url });
    } catch (error: any) {
        console.error('Checkout error:', error);
        return Response.json({ error: error.message }, { status: Number(error?.statusCode || 500) });
    }
});
