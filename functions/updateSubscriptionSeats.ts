import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import Stripe from 'npm:stripe@^14.0.0';

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("STRIPE_TEST_SECRET_KEY"), {
  apiVersion: '2023-10-16',
});

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

        if (!user || !user.stripe_customer_id) {
            return Response.json({ error: 'Unauthorized or no subscription' }, { status: 401 });
        }

        const { quantity } = await req.json();

        // 1. Find active subscription
        const subscriptions = await stripe.subscriptions.list({
            customer: user.stripe_customer_id,
            status: 'active',
            limit: 1,
            expand: ['data.items']
        });

        if (subscriptions.data.length === 0) {
             return Response.json({ error: 'No active subscription found' }, { status: 404 });
        }

        const subscription = subscriptions.data[0];
        const itemId = subscription.items.data[0].id; // Assuming single price subscription

        // 2. Update quantity
        const updatedSubscription = await stripe.subscriptions.update(
            subscription.id,
            {
                items: [{
                    id: itemId,
                    quantity: parseInt(quantity)
                }],
                proration_behavior: 'always_invoice', // Charge immediately for upgrades
            }
        );

        return Response.json({ 
            success: true, 
            status: updatedSubscription.status,
            new_quantity: quantity
        });

    } catch (error) {
        console.error('Update seats error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});