import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.14.0';
import { recordReferralInvoice } from '../../shared/referralLedger.js';
import { PRECISION_CREDIT_COMPONENT, isPaidPrecisionCreditInvoice } from '../../shared/precisionCredits.js';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '');
const endpointSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
const PRECISION_PRICE_CENTS = 9900;
const CANVAS_PRICE_CENTS = 1900;
const BLOCKING_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']);

function normalizeSubscriptionTier(value: any) {
    return String(value || '').trim().toLowerCase();
}

function inferTierFromSubscription(subscription: any, fallback = 'custom') {
    const price = subscription?.items?.data?.[0]?.price;
    const priceMetadataTier = normalizeSubscriptionTier(price?.metadata?.subscription_tier);
    if (priceMetadataTier === 'precision' || priceMetadataTier === 'canvas') return priceMetadataTier;

    const metadataTier = normalizeSubscriptionTier(subscription?.metadata?.subscription_tier);
    if (metadataTier && metadataTier !== 'custom') return metadataTier;

    const amountCents = Number(price?.unit_amount || price?.unit_amount_decimal || 0);
    if (amountCents >= PRECISION_PRICE_CENTS) return 'precision';
    if (amountCents >= CANVAS_PRICE_CENTS) return 'canvas';

    return normalizeSubscriptionTier(fallback) || metadataTier || 'custom';
}

function invoiceHasPositivePayment(invoice: any) {
    return invoice?.status === 'paid' && Number(invoice?.amount_paid || 0) > 0;
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

function subscriptionHasPaidInvoice(subscription: any, invoice: any) {
    const trialEnded = !subscription?.trial_end || subscription.trial_end * 1000 <= Date.now();
    const invoiceSubscriptionId = typeof invoice?.subscription === 'string' ? invoice.subscription : invoice?.subscription?.id;
    return subscription?.status === 'active'
        && trialEnded
        && invoiceHasPositivePayment(invoice)
        && (!invoiceSubscriptionId || invoiceSubscriptionId === subscription.id)
        && (invoiceCoversCurrentPeriod(subscription, invoice) || isPaidPrecisionCreditInvoice(invoice));
}

function isBlockingSubscription(subscription: any) {
    return BLOCKING_SUBSCRIPTION_STATUSES.has(String(subscription?.status || '').toLowerCase());
}

async function getCurrentUser(base44: any, userId: string) {
    return await base44.asServiceRole.entities.User.get(userId);
}

async function isCurrentSubscription(base44: any, userId: string, subscriptionId: string) {
    const currentUser = await getCurrentUser(base44, userId);
    return !currentUser?.subscription_id || currentUser.subscription_id === subscriptionId;
}

async function canReplaceCurrentSubscription(base44: any, userId: string, incomingSubscriptionId: string) {
    const currentUser = await getCurrentUser(base44, userId);
    if (!currentUser?.subscription_id || currentUser.subscription_id === incomingSubscriptionId) return true;

    try {
        const currentSubscription = await stripe.subscriptions.retrieve(currentUser.subscription_id);
        return !isBlockingSubscription(currentSubscription);
    } catch (error: any) {
        if (error?.raw?.code === 'resource_missing') return true;
        throw error;
    }
}

function stripeTimestampIso(value: any) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(seconds * 1000).toISOString();
}

function isPrecisionBillingTier(tier: string) {
    return ['precision', 'pro', 'growth', 'enterprise'].includes(normalizeSubscriptionTier(tier));
}

async function buildSubscriptionPeriodUpdates(_base44: any, _userId: string, subscription: any, tier: string, paidConfirmed: boolean) {
    const periodStart = stripeTimestampIso(subscription?.current_period_start);
    const periodEnd = stripeTimestampIso(subscription?.current_period_end);
    if (!paidConfirmed || !isPrecisionBillingTier(tier) || !periodStart || !periodEnd) return {};
    return {
        subscription_period_start: periodStart,
        subscription_period_end: periodEnd,
        precision_usage_period_start: periodStart,
        precision_usage_period_end: periodEnd
    };
}

function stripeResourceId(resource: any) {
    if (!resource) return null;
    return typeof resource === 'string' ? resource : resource.id || null;
}

async function attachedCardUpdates(userId: string, customerResource: any) {
    const customerId = stripeResourceId(customerResource);
    if (
        !customerId
        || typeof stripe.customers?.retrieve !== 'function'
        || typeof stripe.paymentMethods?.list !== 'function'
    ) {
        return {
            stripe_card_on_file_confirmed: false,
            stripe_card_confirmed_at: null
        };
    }

    const customer = await stripe.customers.retrieve(customerId);
    if (
        customer?.deleted
        || String(customer?.metadata?.base44_user_id || '') !== String(userId)
    ) {
        throw new Error(`Stripe customer ${customerId} ownership metadata does not match user ${userId}`);
    }
    const methods = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
        limit: 1
    });
    const hasCard = (methods.data || []).length > 0;
    return {
        stripe_customer_id: customerId,
        stripe_card_on_file_confirmed: hasCard,
        ...(hasCard
            ? { stripe_card_confirmed_at: new Date().toISOString() }
            : { stripe_card_confirmed_at: null })
    };
}

async function refreshAttachedCard(base44: any, userId: string, customerResource: any) {
    const updates = await attachedCardUpdates(userId, customerResource);
    await base44.asServiceRole.entities.User.update(userId, updates);
    return updates;
}

async function recordPrecisionCreditInvoice(base44: any, userId: string, subscription: any, invoice: any) {
    if (!invoiceHasPositivePayment(invoice) || subscription?.status !== 'active') return 0;
    let recorded = 0;
    for (const line of invoice?.lines?.data || []) {
        if (String(line?.price?.metadata?.billing_component || '') !== PRECISION_CREDIT_COMPONENT) continue;
        const amountCents = Math.max(0, Math.floor(Number(line?.amount || 0)));
        const credits = amountCents * 2;
        if (!line?.id || credits <= 0) continue;
        const existing = await base44.asServiceRole.entities.PrecisionCreditLedger.filter({
            invoice_id: invoice.id,
            stripe_line_id: line.id
        }, 'created_date', 1);
        const matches = Array.isArray(existing) ? existing : (existing?.items || []);
        if (matches.length > 0) continue;
        await base44.asServiceRole.entities.PrecisionCreditLedger.create({
            owner_user_id: userId,
            subscription_id: subscription.id,
            invoice_id: invoice.id,
            stripe_line_id: line.id,
            credits_delta: credits,
            amount_paid_cents: amountCents,
            ...(stripeTimestampIso(line?.period?.start) ? { billing_period_start: stripeTimestampIso(line.period.start) } : {}),
            ...(stripeTimestampIso(line?.period?.end) ? { billing_period_end: stripeTimestampIso(line.period.end) } : {})
        });
        recorded += credits;
    }
    return recorded;
}

// Helper to manage invite codes
async function syncInviteCode(base44: any, userId: string, totalSeats: number) {
    try {
        const existingCodes = await base44.asServiceRole.entities.InviteCode.filter({ linked_user_id: userId });
        const items = Array.isArray(existingCodes) ? existingCodes : (existingCodes?.items || []);
        
        if (items.length > 0) {
            await Promise.all(items.map((code: any) => base44.asServiceRole.entities.InviteCode.update(code.id, {
                max_uses: totalSeats,
                is_active: true
            })));
            console.log(`Updated ${items.length} invite code(s) max_uses to ${totalSeats}`);
        } else {
            // Create new
            const randomCode = Math.floor(100000 + Math.random() * 900000).toString();
            await base44.asServiceRole.entities.InviteCode.create({
                code: randomCode,
                role: 'rep',
                label: 'Team Invite Code',
                max_uses: totalSeats,
                linked_user_id: userId,
                is_active: true
            });
            console.log(`Created new invite code ${randomCode} for user ${userId} with ${totalSeats} seats`);
        }
    } catch (e) {
        console.error("Error syncing invite code:", e);
    }
}

Deno.serve(async (req: Request) => {
    try {
        const signature = req.headers.get('stripe-signature');
        if (!signature || !endpointSecret) {
            console.error('Missing signature or secret. endpointSecret present?', !!endpointSecret);
            return Response.json({ error: 'Missing signature or secret' }, { status: 400 });
        }

        const body = await req.text();
        let event;

        try {
             event = await stripe.webhooks.constructEventAsync(body, signature, endpointSecret);
        } catch (err: any) {
            const secretHint = endpointSecret ? `...${endpointSecret.slice(-4)}` : 'MISSING';
            console.error(`Webhook signature verification failed (Using secret ${secretHint}): ${err.message}`);
            return Response.json({ 
                error: `Webhook Error: ${err.message || 'Verification failed'}`,
                hint: `Your app is using a secret ending in ${secretHint}. Check this against your Stripe Webhook Signing Secret.`
            }, { status: 400 });
        }

        console.log(`Received Webhook Event: ${event.type} [${event.id}]`);
        const base44 = createClientFromRequest(req);
        
        try {
            switch (event.type) {
                case 'checkout.session.completed': {
                    const session = event.data.object;
                    const userId = session.metadata?.base44_user_id;

                    if (userId) {
                        if (session.mode === 'setup') {
                            if (session.metadata?.checkout_intent !== 'knock_card_gate') {
                                throw new Error(`Checkout Setup Session ${session.id} has an unsupported intent`);
                            }
                            const cardUpdates = await refreshAttachedCard(base44, userId, session.customer);
                            if (cardUpdates.stripe_card_on_file_confirmed !== true) {
                                throw new Error(`Checkout Setup Session ${session.id} completed without an attached card`);
                            }
                            console.log(`Confirmed card-only Checkout for user ${userId}`);
                            break;
                        }

                        let quantity = 1;
                        const subscriptionId = session.subscription ? (typeof session.subscription === 'string' ? session.subscription : session.subscription.id) : null;
                        if (!subscriptionId) {
                            throw new Error(`Checkout Session ${session.id} completed without a subscription`);
                        }

                        const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
                        if (String(sub.metadata?.base44_user_id || '') !== String(userId)) {
                            throw new Error(`Checkout Session ${session.id} subscription ownership metadata does not match the session user`);
                        }
                        if (!await canReplaceCurrentSubscription(base44, userId, sub.id)) {
                            console.warn(`Ignoring stale Checkout Session ${session.id} for subscription ${sub.id}`);
                            break;
                        }

                        const subscriptionStatus = sub.status;
                        const subscriptionTier = inferTierFromSubscription(sub, session.metadata?.subscription_tier || 'custom');
                        if (sub.items && sub.items.data.length > 0) {
                            quantity = sub.items.data[0].quantity || 1;
                        }
                        const latestInvoice = sub.latest_invoice;
                        const paidConfirmed = latestInvoice && typeof latestInvoice !== 'string'
                            ? subscriptionHasPaidInvoice(sub, latestInvoice)
                            : false;
                        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
                        const cardUpdates = await attachedCardUpdates(userId, customerId);
                        const periodUpdates = await buildSubscriptionPeriodUpdates(
                            base44,
                            userId,
                            sub,
                            subscriptionTier,
                            paidConfirmed
                        );

                        await base44.asServiceRole.entities.User.update(userId, {
                            ...cardUpdates,
                            subscription_id: subscriptionId,
                            subscription_status: subscriptionStatus,
                            subscription_tier: subscriptionTier,
                            subscription_paid_confirmed: paidConfirmed,
                            ...(paidConfirmed ? { subscription_paid_confirmed_at: new Date().toISOString() } : {}),
                            ...periodUpdates,
                            total_seats: quantity
                        });

                        if (paidConfirmed) {
                            await syncInviteCode(base44, userId, quantity);
                        }
                        console.log(`Successfully processed checkout.session.completed for user ${userId}`);
                    } else {
                        console.warn(`No userId in session metadata for ${session.id}`);
                    }
                    break;
                }
                case 'customer.subscription.updated': {
                    const eventSubscription = event.data.object;
                    const subscription = await stripe.subscriptions.retrieve(eventSubscription.id, {
                        expand: ['latest_invoice']
                    });
                    const userId = subscription.metadata?.base44_user_id;
                    const status = subscription.status;
                    
                    // Safely get quantity and planId
                    const firstItem = subscription.items?.data?.[0];
                    const quantity = firstItem?.quantity || 1;
                    const planId = firstItem?.price?.id;
                    const latestInvoice = typeof subscription.latest_invoice === 'string'
                        ? await stripe.invoices.retrieve(subscription.latest_invoice)
                        : subscription.latest_invoice;
                    const paidConfirmed = subscriptionHasPaidInvoice(subscription, latestInvoice);

                    if (userId) {
                        if (!await isCurrentSubscription(base44, userId, subscription.id)) {
                            console.warn(`Ignoring update for stale subscription ${subscription.id}`);
                            break;
                        }
                        const cardUpdates = await attachedCardUpdates(userId, subscription.customer);
                        const subscriptionTier = inferTierFromSubscription(subscription, 'custom');
                        const periodUpdates = await buildSubscriptionPeriodUpdates(
                            base44,
                            userId,
                            subscription,
                            subscriptionTier,
                            paidConfirmed
                        );
                         await base44.asServiceRole.entities.User.update(userId, {
                           subscription_id: subscription.id,
                           subscription_status: status,
                           ...cardUpdates,
                           ...(paidConfirmed
                               ? { subscription_paid_confirmed: true, subscription_paid_confirmed_at: new Date().toISOString() }
                               : { subscription_paid_confirmed: false }),
                           subscription_plan_id: planId,
                           subscription_tier: subscriptionTier,
                           ...periodUpdates,
                           total_seats: quantity
                         });

                        if (paidConfirmed) {
                            await syncInviteCode(base44, userId, quantity);
                        }
                        console.log(`Successfully updated subscription for user ${userId}. Status: ${status}`);
                    } else {
                        console.log(`No userId in subscription metadata for ${subscription.id}`);
                    }
                    break;
                }
                case 'invoice.paid': {
                    const eventInvoice = event.data.object;
                    const subscriptionId = eventInvoice.subscription ? (typeof eventInvoice.subscription === 'string' ? eventInvoice.subscription : eventInvoice.subscription.id) : null;
                    if (!subscriptionId) break;
                    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
                        expand: ['latest_invoice']
                    });
                    const userId = subscription.metadata?.base44_user_id;
                    const quantity = subscription.items?.data?.[0]?.quantity || 1;
                    if (userId) {
                        if (!await isCurrentSubscription(base44, userId, subscription.id)) {
                            console.warn(`Ignoring paid invoice for stale subscription ${subscription.id}`);
                            break;
                        }
                        const currentInvoice = subscription.latest_invoice;
                        if (!currentInvoice || typeof currentInvoice === 'string' || currentInvoice.id !== eventInvoice.id) {
                            console.warn(`Ignoring stale paid invoice ${eventInvoice.id}; it is not the current invoice for ${subscription.id}`);
                            break;
                        }
                        const paidConfirmed = subscriptionHasPaidInvoice(subscription, currentInvoice);
                        const cardUpdates = await attachedCardUpdates(userId, subscription.customer);
                        const subscriptionTier = inferTierFromSubscription(subscription, 'custom');
                        const periodUpdates = await buildSubscriptionPeriodUpdates(
                            base44,
                            userId,
                            subscription,
                            subscriptionTier,
                            paidConfirmed
                        );
                        await base44.asServiceRole.entities.User.update(userId, {
                            subscription_id: subscription.id,
                            subscription_status: subscription.status,
                            subscription_tier: subscriptionTier,
                            ...(paidConfirmed
                                ? { subscription_paid_confirmed: true, subscription_paid_confirmed_at: new Date().toISOString() }
                                : { subscription_paid_confirmed: false }),
                            ...cardUpdates,
                            ...periodUpdates,
                            total_seats: quantity
                        });
                        if (paidConfirmed) {
                            await syncInviteCode(base44, userId, quantity);
                            const creditedProperties = await recordPrecisionCreditInvoice(base44, userId, subscription, currentInvoice);
                            const paidUser = await getCurrentUser(base44, userId);
                            await recordReferralInvoice(base44, paidUser, subscription, currentInvoice);
                            console.log(`Confirmed paid subscription invoice for user ${userId} with ${quantity} seats and ${creditedProperties} rollover credits`);
                        } else {
                            console.log(`Ignored zero-dollar or trial invoice for user ${userId}`);
                        }
                    }
                    break;
                }
                case 'invoice.payment_failed': {
                    const eventInvoice = event.data.object;
                    const subscriptionId = eventInvoice.subscription ? (typeof eventInvoice.subscription === 'string' ? eventInvoice.subscription : eventInvoice.subscription.id) : null;
                    if (!subscriptionId) break;
                    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
                        expand: ['latest_invoice']
                    });
                    const userId = subscription.metadata?.base44_user_id;
                    if (userId) {
                        if (!await isCurrentSubscription(base44, userId, subscription.id)) {
                            console.warn(`Ignoring payment failure for stale subscription ${subscription.id}`);
                            break;
                        }

                        const currentInvoice = typeof subscription.latest_invoice === 'string'
                            ? await stripe.invoices.retrieve(subscription.latest_invoice)
                            : subscription.latest_invoice;
                        const currentInvoiceIsUnpaid = currentInvoice
                            && ['open', 'uncollectible'].includes(String(currentInvoice.status || '').toLowerCase());
                        if (!currentInvoice || currentInvoice.id !== eventInvoice.id || !currentInvoiceIsUnpaid) {
                            console.warn(`Ignoring stale payment failure ${eventInvoice.id}; it is not the current unpaid invoice for ${subscription.id}`);
                            break;
                        }

                        await base44.asServiceRole.entities.User.update(userId, {
                            subscription_id: subscription.id,
                            subscription_status: subscription.status,
                            subscription_paid_confirmed: false
                        });
                        console.log(`Marked the current subscription payment failed for user ${userId}`);
                    }
                    break;
                }
                case 'customer.subscription.deleted': {
                    const subscription = event.data.object;
                    const userId = subscription.metadata?.base44_user_id;
                    if (userId) {
                        if (!await isCurrentSubscription(base44, userId, subscription.id)) {
                            console.warn(`Ignoring deletion for stale subscription ${subscription.id}`);
                            break;
                        }
                        await base44.asServiceRole.entities.User.update(userId, {
                            subscription_status: 'canceled',
                            subscription_paid_confirmed: false,
                            ...await attachedCardUpdates(userId, subscription.customer)
                        });
                        
                        try {
                            const existingCodes = await base44.asServiceRole.entities.InviteCode.filter({ linked_user_id: userId });
                            const items = Array.isArray(existingCodes) ? existingCodes : (existingCodes?.items || []);
                            if(items.length > 0) {
                                await base44.asServiceRole.entities.InviteCode.update(items[0].id, { is_active: false });
                            }
                        } catch (codeErr: any) {
                            console.error(`Error deactivating invite code for ${userId}:`, codeErr.message);
                        }
                        console.log(`Successfully canceled subscription for user ${userId}`);
                    }
                    break;
                }
                case 'payment_method.attached':
                case 'payment_method.detached': {
                    const paymentMethod = event.data.object;
                    const customerId = stripeResourceId(paymentMethod.customer)
                        || stripeResourceId(event.data.previous_attributes?.customer);
                    if (!customerId) break;
                    const customer = await stripe.customers.retrieve(customerId);
                    const userId = !customer?.deleted ? customer?.metadata?.base44_user_id : null;
                    if (userId) {
                        await refreshAttachedCard(base44, userId, customerId);
                        console.log(`Reconciled attached cards for user ${userId} after ${event.type}`);
                    }
                    break;
                }
                case 'customer.updated': {
                    const eventCustomer = event.data.object;
                    const customer = await stripe.customers.retrieve(eventCustomer.id);
                    const userId = !customer?.deleted ? customer?.metadata?.base44_user_id : null;
                    if (userId) {
                        await refreshAttachedCard(base44, userId, customer.id);
                    }
                    break;
                }
                case 'setup_intent.succeeded': {
                    const setupIntent = event.data.object;
                    const customerId = stripeResourceId(setupIntent.customer);
                    if (!customerId) break;
                    const customer = await stripe.customers.retrieve(customerId);
                    const userId = !customer?.deleted ? customer?.metadata?.base44_user_id : null;
                    if (userId) {
                        await refreshAttachedCard(base44, userId, customer.id);
                    }
                    break;
                }
                default: {
                    console.log(`Unhandled event type: ${event.type}`);
                    break;
                }
            }
        } catch (processError) {
            console.error(`Error processing event ${event.type}: ${processError.message}`);
            // Stripe must retry transient Base44/Stripe failures; acknowledging a
            // failed billing write would permanently lose the event.
            return Response.json({ error: 'Webhook processing failed' }, { status: 500 });
        }

        return Response.json({ received: true });
    } catch (error) {
        console.error(`Global Webhook Handler Error: ${error.message}`);
        return Response.json({ error: error.message }, { status: 500 });
    }
});