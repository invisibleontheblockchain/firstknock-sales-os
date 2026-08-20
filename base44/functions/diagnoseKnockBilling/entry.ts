// Read-only probe: explains why the Knock outcome gate considers an account
// unpaid. Mirrors recordKnockOutcome's evidence checks without writing anything.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Stripe from 'npm:stripe@14.14.0';
import { precisionGrantLabel, precisionGrantLimit } from '../../shared/privilegedAccounts.js';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '');

function resourceId(resource: any) {
    if (!resource) return null;
    return typeof resource === 'string' ? resource : resource.id || null;
}

Deno.serve(async (req: Request) => {
    try {
        const base44 = createClientFromRequest(req);
        const caller = await base44.auth.me();
        if (!caller) return Response.json({ error: 'Authentication required' }, { status: 401 });
        if (String(caller.role || '').toLowerCase() !== 'admin') {
            return Response.json({ error: 'Admin access required' }, { status: 403 });
        }

        const body = await req.json().catch(() => ({}));
        const email = String(body.email || '').trim().toLowerCase();
        if (!email) return Response.json({ error: 'email is required' }, { status: 400 });

        const users = await base44.asServiceRole.entities.User.filter({ email }, '-updated_date', 2);
        const user = (Array.isArray(users) ? users : users?.items || [])[0];
        if (!user) return Response.json({ error: 'No such account' }, { status: 404 });

        const nowSeconds = Date.now() / 1000;
        const found: any[] = [];
        const seen = new Set<string>();

        if (user.subscription_id) {
            const stored = await stripe.subscriptions.retrieve(String(user.subscription_id), {
                expand: ['latest_invoice']
            }).catch((error: any) => ({ error: error?.raw?.code || error?.message }));
            found.push({ lookup: 'stored_subscription_id', subscription: stored });
            if ((stored as any)?.id) seen.add((stored as any).id);
        }

        if (typeof stripe.subscriptions.search === 'function') {
            const escaped = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const result = await stripe.subscriptions.search({
                query: `metadata['base44_user_id']:'${escaped}'`,
                limit: 20,
                expand: ['data.latest_invoice']
            }).catch((error: any) => ({ data: [], error: error?.message }));
            for (const subscription of (result as any).data || []) {
                if (!seen.has(subscription.id)) {
                    found.push({ lookup: 'metadata_search', subscription });
                    seen.add(subscription.id);
                }
            }
        }

        const report = [];
        for (const entry of found) {
            const subscription: any = entry.subscription;
            if (!subscription?.id) {
                report.push({ lookup: entry.lookup, error: subscription?.error || 'not found' });
                continue;
            }
            const invoice = typeof subscription.latest_invoice === 'string'
                ? await stripe.invoices.retrieve(subscription.latest_invoice).catch(() => null)
                : subscription.latest_invoice;
            report.push({
                lookup: entry.lookup,
                subscription_id: subscription.id,
                status: subscription.status,
                metadata_user_id: subscription.metadata?.base44_user_id || null,
                metadata_matches_account: String(subscription.metadata?.base44_user_id || '') === String(user.id),
                current_period_end_present: subscription.current_period_end !== undefined,
                current_period_end_in_future: Number(subscription.current_period_end || 0) > nowSeconds,
                item_period_end_in_future: (subscription.items?.data || [])
                    .some((item: any) => Number(item?.current_period_end || 0) > nowSeconds),
                trial_active: Number(subscription.trial_end || 0) > nowSeconds,
                customer_id: resourceId(subscription.customer),
                invoice: invoice ? {
                    id: invoice.id,
                    status: invoice.status,
                    amount_paid: invoice.amount_paid,
                    subscription_field: resourceId((invoice as any).subscription),
                    parent_subscription: resourceId((invoice as any).parent?.subscription_details?.subscription)
                } : null
            });
        }

        const precisionLimit = precisionGrantLimit(user);
        return Response.json({
            success: true,
            account: {
                email: user.email,
                user_id: user.id,
                precision_grant_limit: precisionLimit,
                precision_grant_label: precisionLimit === null ? null : precisionGrantLabel(precisionLimit),
                outcomes_logged: user.outcomes_logged || 0,
                subscription_status: user.subscription_status || null,
                subscription_paid_confirmed: user.subscription_paid_confirmed === true,
                stripe_card_on_file_confirmed: user.stripe_card_on_file_confirmed === true,
                is_owner: user.is_owner === true,
                role: user.role || null
            },
            subscriptions: report
        });
    } catch (error: any) {
        console.error('[diagnoseKnockBilling]', error?.message || error);
        return Response.json({ error: error?.message || 'Diagnostic failed' }, { status: 500 });
    }
});