import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import Stripe from 'npm:stripe@14.14.0';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY'));

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204 });
        }

        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { priceId, successUrl, cancelUrl } = await req.json();

        if (!priceId) {
            return Response.json({ error: 'Price ID is required' }, { status: 400 });
        }

        let customerId = user.stripe_customer_id;

        // Create Stripe Customer if not exists
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: user.full_name,
                metadata: {
                    base44_user_id: user.id
                }
            });
            customerId = customer.id;
            // Update user with customer ID
            await base44.auth.updateMe({ stripe_customer_id: customerId });
        }

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: {
                base44_app_id: Deno.env.get("BASE44_APP_ID"),
                base44_user_id: user.id
            }
        });

        return Response.json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});