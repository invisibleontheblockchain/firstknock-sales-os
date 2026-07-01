import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import Stripe from 'npm:stripe@^14.0.0';

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY"), {
  apiVersion: '2023-10-16',
});

// Helper to manage invite codes (inlined)
async function syncInviteCode(base44, userId, totalSeats) {
    try {
        const existingCodes = await base44.entities.InviteCode.filter({ linked_user_id: userId });
        const items = Array.isArray(existingCodes) ? existingCodes : (existingCodes?.items || []);
        
        if (items.length > 0) {
            await base44.entities.InviteCode.update(items[0].id, {
                max_uses: totalSeats,
                is_active: true
            });
        } else {
            const randomCode = Math.floor(100000 + Math.random() * 900000).toString();
            await base44.entities.InviteCode.create({
                code: randomCode,
                role: 'rep',
                label: 'Team Invite Code',
                max_uses: totalSeats,
                linked_user_id: userId,
                is_active: true
            });
        }
    } catch (e) {
        console.error("Error syncing invite code:", e);
    }
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

        if (!user || !user.stripe_customer_id) {
            return Response.json({ error: 'Unauthorized or no subscription' }, { status: 401 });
        }

        const { quantity } = await req.json();
        const newSeatCount = parseInt(quantity);

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
        const itemId = subscription.items.data[0].id;
        const repSeatPrice = await stripe.prices.create({
            currency: 'usd',
            unit_amount: 9900,
            recurring: { interval: 'month' },
            product_data: { name: 'FirstKnock Rep Seat' }
        });

        // 2. Update quantity in Stripe and invoice immediately.
        // Do not update Base44 seats here — webhook payment confirmation activates the seats.
        const updatedSubscription = await stripe.subscriptions.update(
            subscription.id,
            {
                items: [{
                    id: itemId,
                    price: repSeatPrice.id,
                    quantity: newSeatCount
                }],
                proration_behavior: 'always_invoice',
                payment_behavior: 'pending_if_incomplete',
                expand: ['latest_invoice.payment_intent']
            }
        );

        const latestInvoice = updatedSubscription.latest_invoice;
        const invoiceUrl = latestInvoice && typeof latestInvoice !== 'string' ? latestInvoice.hosted_invoice_url : null;
        const invoiceStatus = latestInvoice && typeof latestInvoice !== 'string' ? latestInvoice.status : null;

        return Response.json({ 
            success: true, 
            status: updatedSubscription.status,
            new_quantity: newSeatCount,
            invoice_status: invoiceStatus,
            invoice_url: invoiceUrl
        });

    } catch (error) {
        console.error('Update seats error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});