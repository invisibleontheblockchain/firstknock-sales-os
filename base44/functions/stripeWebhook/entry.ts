import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.14.0';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY'));
const endpointSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
const PRECISION_PRICE_CENTS = 9900;
const CANVAS_PRICE_CENTS = 1900;

function normalizeSubscriptionTier(value: any) {
    return String(value || '').trim().toLowerCase();
}

function inferTierFromSubscription(subscription: any, fallback = 'custom') {
    const metadataTier = normalizeSubscriptionTier(subscription?.metadata?.subscription_tier);
    if (metadataTier && metadataTier !== 'custom') return metadataTier;

    const price = subscription?.items?.data?.[0]?.price;
    const amountCents = Number(price?.unit_amount || price?.unit_amount_decimal || 0);
    if (amountCents >= PRECISION_PRICE_CENTS) return 'precision';
    if (amountCents >= CANVAS_PRICE_CENTS) return 'canvas';

    return normalizeSubscriptionTier(fallback) || metadataTier || 'custom';
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
                        let quantity = 1;
                        let subscriptionStatus = 'active';
                        let subscriptionId = session.subscription ? (typeof session.subscription === 'string' ? session.subscription : session.subscription.id) : null;
                        let subscriptionTier = session.metadata?.subscription_tier || 'custom';
                        let paidConfirmed = session.payment_status === 'paid';
                        if (subscriptionId) {
                            try {
                                const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
                                subscriptionStatus = sub.status;
                                subscriptionId = sub.id;
                                subscriptionTier = inferTierFromSubscription(sub, subscriptionTier);
                                if (sub.items && sub.items.data.length > 0) {
                                    quantity = sub.items.data[0].quantity || 1;
                                }
                                const latestInvoice = sub.latest_invoice;
                                paidConfirmed = paidConfirmed || (sub.status === 'active' && latestInvoice && typeof latestInvoice !== 'string' && latestInvoice.status === 'paid');
                            } catch (subErr: any) {
                                console.error(`Error retrieving subscription ${session.subscription}:`, subErr.message);
                            }
                        }

                        await base44.asServiceRole.entities.User.update(userId, {
                            stripe_customer_id: session.customer,
                            stripe_card_on_file_confirmed: true,
                            stripe_card_confirmed_at: new Date().toISOString(),
                            subscription_id: subscriptionId,
                            subscription_status: subscriptionStatus,
                            subscription_tier: subscriptionTier,
                            subscription_paid_confirmed: paidConfirmed,
                            ...(paidConfirmed ? { subscription_paid_confirmed_at: new Date().toISOString() } : {}),
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
                    const subscription = event.data.object;
                    const userId = subscription.metadata?.base44_user_id;
                    const status = subscription.status;
                    
                    // Safely get quantity and planId
                    const firstItem = subscription.items?.data?.[0];
                    const quantity = firstItem?.quantity || 1;
                    const planId = firstItem?.price?.id;
                    const periodEnd = new Date(subscription.current_period_end * 1000).toISOString();
                    let latestInvoicePaid = false;
                    if (subscription.latest_invoice) {
                        try {
                            const invoice = typeof subscription.latest_invoice === 'string'
                                ? await stripe.invoices.retrieve(subscription.latest_invoice)
                                : subscription.latest_invoice;
                            latestInvoicePaid = invoice?.status === 'paid';
                        } catch (invoiceErr: any) {
                            console.error(`Error retrieving latest invoice for ${subscription.id}:`, invoiceErr.message);
                        }
                    }
                    const paidConfirmed = status === 'active' && latestInvoicePaid;

                    if (userId) {
                         await base44.asServiceRole.entities.User.update(userId, {
                           subscription_id: subscription.id,
                           subscription_status: status,
                           stripe_card_on_file_confirmed: status === 'active' || status === 'trialing',
                           ...(status === 'active' || status === 'trialing' ? { stripe_card_confirmed_at: new Date().toISOString() } : {}),
                           subscription_paid_confirmed: paidConfirmed,
                           ...(paidConfirmed ? { subscription_paid_confirmed_at: new Date().toISOString() } : {}),
                           subscription_plan_id: planId,
                           subscription_tier: inferTierFromSubscription(subscription, 'custom'),
                           subscription_period_end: periodEnd,
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
                    const invoice = event.data.object;
                    const subscriptionId = invoice.subscription ? (typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id) : null;
                    if (!subscriptionId) break;
                    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                    const userId = subscription.metadata?.base44_user_id;
                    const quantity = subscription.items?.data?.[0]?.quantity || 1;
                    if (userId) {
                        await base44.asServiceRole.entities.User.update(userId, {
                            subscription_id: subscription.id,
                            subscription_status: subscription.status,
                            subscription_tier: inferTierFromSubscription(subscription, 'custom'),
                            subscription_paid_confirmed: true,
                            subscription_paid_confirmed_at: new Date().toISOString(),
                            stripe_card_on_file_confirmed: true,
                            stripe_card_confirmed_at: new Date().toISOString(),
                            total_seats: quantity
                        });
                        await syncInviteCode(base44, userId, quantity);
                        console.log(`Confirmed paid subscription invoice for user ${userId} with ${quantity} seats`);
                    }
                    break;
                }
                case 'invoice.payment_failed': {
                    const invoice = event.data.object;
                    const subscriptionId = invoice.subscription ? (typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id) : null;
                    if (!subscriptionId) break;
                    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                    const userId = subscription.metadata?.base44_user_id;
                    if (userId) {
                        await base44.asServiceRole.entities.User.update(userId, {
                            subscription_id: subscription.id,
                            subscription_status: subscription.status,
                            subscription_paid_confirmed: false
                        });
                        console.log(`Marked subscription payment failed for user ${userId}`);
                    }
                    break;
                }
                case 'customer.subscription.deleted': {
                    const subscription = event.data.object;
                    const userId = subscription.metadata?.base44_user_id;
                    if (userId) {
                        await base44.asServiceRole.entities.User.update(userId, {
                            subscription_status: 'canceled',
                            subscription_paid_confirmed: false
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
                default: {
                    console.log(`Unhandled event type: ${event.type}`);
                    break;
                }
            }
        } catch (processError) {
            // Catch errors during processing to avoid 500 for valid (verified) events
            console.error(`Error processing event ${event.type}: ${processError.message}`);
            // We still return 200 because the event was technically "received" and verified
            // This prevents Stripe from retrying infinitely if it's a logic bug
        }

        return Response.json({ received: true });
    } catch (error) {
        console.error(`Global Webhook Handler Error: ${error.message}`);
        return Response.json({ error: error.message }, { status: 500 });
    }
});
