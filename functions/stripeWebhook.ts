import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import Stripe from 'npm:stripe@14.14.0';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || Deno.env.get('STRIPE_TEST_SECRET_KEY'));
const endpointSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');

// Helper to manage invite codes
async function syncInviteCode(base44, userId, totalSeats) {
    try {
        // Find existing code for this user
        // Note: Filtering logic depends on SDK capabilities. 
        // If filter returns array:
        const existingCodes = await base44.asServiceRole.entities.InviteCode.filter({ linked_user_id: userId });
        const items = Array.isArray(existingCodes) ? existingCodes : (existingCodes?.items || []);
        
        if (items.length > 0) {
            // Update existing
            const code = items[0];
            await base44.asServiceRole.entities.InviteCode.update(code.id, {
                max_uses: totalSeats,
                // Ensure it's active
                is_active: true
            });
            console.log(`Updated invite code ${code.code} max_uses to ${totalSeats}`);
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

Deno.serve(async (req) => {
    try {
        const signature = req.headers.get('stripe-signature');
        if (!signature || !endpointSecret) {
            return Response.json({ error: 'Missing signature or secret' }, { status: 400 });
        }

        const body = await req.text();
        let event;

        try {
             event = await stripe.webhooks.constructEventAsync(body, signature, endpointSecret);
        } catch (err) {
            console.error(`Webhook signature verification failed: ${err.message}`);
            return Response.json({ error: `Webhook Error: ${err.message}` }, { status: 400 });
        }

        const base44 = createClientFromRequest(req);
        
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const userId = session.metadata.base44_user_id;
                
                if (userId) {
                    // Get quantity (seats) from session if available, or fetch subscription
                    let quantity = 1;
                    // For subscription mode, session doesn't always have quantity directly in the root object easily accessible 
                    // without expanding line_items, but usually line_items are not expanded in webhook payload.
                    // However, we can fetch the subscription.
                    if (session.subscription) {
                        const sub = await stripe.subscriptions.retrieve(session.subscription);
                        if (sub.items && sub.items.data.length > 0) {
                            quantity = sub.items.data[0].quantity;
                        }
                    }

                    await base44.asServiceRole.entities.User.update(userId, {
                        stripe_customer_id: session.customer,
                        subscription_status: 'active',
                        total_seats: quantity
                    });

                    // Sync Invite Code
                    await syncInviteCode(base44, userId, quantity);
                }
                break;
            }
            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const userId = subscription.metadata?.base44_user_id;
                const status = subscription.status;
                const quantity = subscription.items.data[0].quantity;
                const planId = subscription.items.data[0].price.id;
                const periodEnd = new Date(subscription.current_period_end * 1000).toISOString();

                if (userId) {
                     await base44.asServiceRole.entities.User.update(userId, {
                        subscription_status: status,
                        subscription_plan_id: planId,
                        subscription_period_end: periodEnd,
                        total_seats: quantity
                    });

                    if (status === 'active' || status === 'trialing') {
                        await syncInviteCode(base44, userId, quantity);
                    }
                } else {
                    // Fallback: Try to find user by stripe_customer_id if needed
                    // But we relied on metadata propagation.
                    console.log(`No userId in subscription metadata for ${subscription.id}`);
                }
                break;
            }
            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const userId = subscription.metadata?.base44_user_id;
                if (userId) {
                    await base44.asServiceRole.entities.User.update(userId, {
                        subscription_status: 'canceled'
                    });
                    // Disable invite code?
                    const existingCodes = await base44.asServiceRole.entities.InviteCode.filter({ linked_user_id: userId });
                    const items = Array.isArray(existingCodes) ? existingCodes : (existingCodes?.items || []);
                    if(items.length > 0) {
                        await base44.asServiceRole.entities.InviteCode.update(items[0].id, { is_active: false });
                    }
                }
                break;
            }
        }

        return Response.json({ received: true });
    } catch (error) {
        console.error(`Webhook error: ${error.message}`);
        return Response.json({ error: error.message }, { status: 500 });
    }
});