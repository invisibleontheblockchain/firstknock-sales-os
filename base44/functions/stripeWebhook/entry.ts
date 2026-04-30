import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.14.0';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY'));
const endpointSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');

// Helper to manage invite codes
async function syncInviteCode(base44: any, userId: string, totalSeats: number) {
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
                        if (session.subscription) {
                            try {
                                const sub = await stripe.subscriptions.retrieve(session.subscription);
                                if (sub.items && sub.items.data.length > 0) {
                                    quantity = sub.items.data[0].quantity || 1;
                                }
                            } catch (subErr: any) {
                                console.error(`Error retrieving subscription ${session.subscription}:`, subErr.message);
                            }
                        }

                        await base44.asServiceRole.entities.User.update(userId, {
                            stripe_customer_id: session.customer,
                            subscription_status: 'active',
                            total_seats: quantity
                        });

                        await syncInviteCode(base44, userId, quantity);
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
                        console.log(`Successfully updated subscription for user ${userId}. Status: ${status}`);
                    } else {
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