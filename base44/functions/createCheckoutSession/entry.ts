import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
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

        const { priceId, quantity = 1, successUrl, cancelUrl, trialDays = 0 } = await req.json();

        if (!priceId) {
            return Response.json({ error: 'Price ID is required' }, { status: 400 });
        }

        // Flat pricing: $49/mo
        const seats = 1; // Always 1 seat for flat plan
        console.log(`Flat pricing: $49/mo. Trial days: ${trialDays}`);

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

        const sessionConfig = {
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: quantity,
                },
            ],
            subscription_data: {
                metadata: {
                    base44_user_id: user.id
                },
                ...(trialDays > 0 ? { trial_period_days: trialDays } : {})
            },
            success_url: successUrl,
            cancel_url: cancelUrl,
            allow_promotion_codes: true,
            metadata: {
                base44_app_id: Deno.env.get("BASE44_APP_ID"),
                base44_user_id: user.id
            }
        };

        let session;
        try {
            session = await stripe.checkout.sessions.create({
                ...sessionConfig,
                customer: customerId,
            });
        } catch (error) {
             // Handle stale customer ID (e.g. from Test Mode vs Live Mode switch)
             if (error.raw?.code === 'resource_missing' && error.raw?.param === 'customer') {
                 console.log('Stripe customer invalid/missing in this env. Creating new one...');
                 
                 const newCustomer = await stripe.customers.create({
                    email: user.email,
                    name: user.full_name,
                    metadata: { base44_user_id: user.id }
                 });
                 
                 // Update DB with valid customer ID
                 await base44.auth.updateMe({ stripe_customer_id: newCustomer.id });
                 
                 // Retry with new customer
                 session = await stripe.checkout.sessions.create({
                    ...sessionConfig,
                    customer: newCustomer.id,
                 });
             } else {
                 throw error;
             }
        }

        return Response.json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});