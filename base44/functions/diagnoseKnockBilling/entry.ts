// Read-only probe: explains why the Knock outcome gate considers an account
// unpaid. Mirrors recordKnockOutcome's evidence checks without writing anything.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Stripe from 'npm:stripe@14.14.0';
const { precisionGrantLabel, precisionGrantLimit } = (() => {
/**
 * Accounts that are exempt from the product's usage gates.
 *
 * These lists used to be copy-pasted per function: the unlimited-Precision
 * email was declared three separate times and the knock-gate exemptions once
 * more, so granting somebody access meant remembering four files and spelling
 * their address identically in each. The near-miss pairs still visible below
 * (reef/reif, and two spellings of Christian's domain) are what that cost.
 * One list, imported everywhere, is the fix.
 *
 * A grant here bypasses metering only. It is not a permission system: entity
 * access still runs through RLS and the is_owner / role checks, so adding an
 * address cannot hand anyone data they were not already entitled to read.
 *
 * Note that none of this reads is_owner, role or subscription_status. Those
 * fields govern permissions and are checked elsewhere; the Precision ceiling
 * is decided here or by live Stripe state, and nowhere else. Making somebody
 * an owner does not raise their property cap.
 */

/**
 * The ceiling for an uncapped account. A large finite number rather than
 * Infinity because the reservation, expected-count and progress math all
 * persist this value on the FetchJob.
 */
const UNLIMITED_PROPERTY_CAP = 1000000;

function normalizeAccountEmail(value) {
    return String(value ?? '').trim().toLowerCase();
}

/**
 * Per-account Precision ceilings, in properties per period.
 *
 * Each entry is a number rather than a membership flag so raising or lowering
 * somebody is a one-line edit here, with no need to move them between lists.
 * BatchData bills per property, so these are spend limits: prefer a real
 * number and raise it on request over handing out UNLIMITED_PROPERTY_CAP.
 */
const PRECISION_GRANTS = new Map([
    ['invisibleontheblockchain@gmail.com', UNLIMITED_PROPERTY_CAP],
    ['christian@nativapest.com', 1000],
    ['devinfgalligan@gmail.com', 1000]
]);

/**
 * The same ceilings keyed on the immutable Base44 user ID.
 *
 * Checked before the email map because an address is the weak link: the list
 * already carries two spellings of one domain, and the address a person signs
 * in with need not match the one on their record. An ID cannot be mistyped
 * into somebody else's account and cannot drift when an address changes.
 *
 * This is server-side configuration, not a field on the user, so it is not
 * subject to the rule that client-visible flags must never grant entitlement.
 */
const PRECISION_GRANTS_BY_USER_ID = new Map([
    // christian@nativapest.com
    ['6978c7229935cf40cde25086', 1000],
    // devinfgalligan@gmail.com
    ['69fb8c76e8bf4b0b31e8d4f9', 1000]
]);

/**
 * Additional addresses exempt from the 25-outcome card gate and the 50-outcome
 * free ceiling, beyond those a Precision grant already exempts.
 *
 * This set is no longer the whole answer: isKnockGateExempt also honours any
 * Precision grant, including the ID and domain routes. Spelling an address here
 * is only needed for somebody who should keep logging outcomes *without* being
 * granted Precision spend -- justinhoskins44@gmail.com is the case that
 * distinguishes the two.
 */
const KNOCK_GATE_EXEMPT_EMAILS = new Set([
    ...PRECISION_GRANTS.keys(),
    'christian@nativapest.com',
    'christian@nativepest.com',
    'christian@nativepestmanagement.com',
    'kevin@reefenvironmental.com',
    'kevin@reifenvironmental.com',
    'keven@reefenvironmental.com',
    'justinhoskins44@gmail.com'
]);

/**
 * The granted ceiling for this account, or null when it has no grant and must
 * fall through to live Stripe verification. Null rather than 0 so a caller
 * cannot accidentally treat "no grant" as "granted nothing".
 */
/**
 * Whole-domain ceilings, the last resort when an identity will not match.
 *
 * An account can exist more than once -- diagnoseKnockBilling reads two User
 * records per email and takes the newest, so duplicates are expected -- and a
 * person can sign in under an address that is not the one on the record we
 * were given. Both failures look identical from outside: a silent fall through
 * to the free tier.
 *
 * Granting the domain removes identity from the question entirely. It is
 * deliberately a bounded monthly number rather than an uncapped one, because
 * it covers everyone who can receive mail there.
 */
const PRECISION_GRANTS_BY_EMAIL_DOMAIN = new Map([
    // Every spelling of Christian's company seen on an account so far. The
    // knock-gate list already carries all three, so all three are in use.
    ['nativapest.com', 1000],
    ['nativepest.com', 1000],
    ['nativepestmanagement.com', 1000]
]);

function emailDomain(email) {
    const normalized = normalizeAccountEmail(email);
    const at = normalized.lastIndexOf('@');
    return at > 0 && at < normalized.length - 1 ? normalized.slice(at + 1) : '';
}

function usableLimit(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function precisionGrantLimit(user) {
    const byId = usableLimit(PRECISION_GRANTS_BY_USER_ID.get(String(user?.id ?? '').trim()));
    if (byId !== null) return byId;
    const byEmail = usableLimit(PRECISION_GRANTS.get(normalizeAccountEmail(user?.email)));
    if (byEmail !== null) return byEmail;
    return usableLimit(PRECISION_GRANTS_BY_EMAIL_DOMAIN.get(emailDomain(user?.email)));
}

function hasPrecisionGrant(user) {
    return precisionGrantLimit(user) !== null;
}

/**
 * Written to the entitlement's subscriptionId so a granted allowance is
 * traceable in logs and diagnostics. Nothing branches on these strings.
 */
function precisionGrantLabel(limit) {
    return limit >= UNLIMITED_PROPERTY_CAP ? 'owner_unlimited_grant' : 'account_precision_grant';
}

/**
 * The billing window a granted account is metered against.
 *
 * Calendar month, matching how a paying customer is metered by their Stripe
 * period. Grants used to carry a single fixed 2026-2030 window, which made a
 * granted allowance a lifetime total rather than a monthly one: usage never
 * reset, and reconcileLegacyJobs classified every historical pull inside that
 * window as billable, so an account with real history arrived at zero
 * remaining on the day its grant went live. The builder derives what it can
 * request from `remaining`, so zero remaining reads as "drawing is broken".
 *
 * UTC so the window does not shift with the caller's timezone; job matching
 * compares these strings exactly.
 */
function currentGrantPeriod(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
        periodStart: new Date(Date.UTC(year, month, 1)).toISOString(),
        periodEnd: new Date(Date.UTC(year, month + 1, 1)).toISOString()
    };
}

/**
 * The knock gate follows the Precision grant, then the address list.
 *
 * Reading the address list alone re-opened the exact hole the ID and domain
 * maps were added to close. An account granted by ID -- the route that exists
 * precisely because the address on the record need not match the one signed in
 * with -- cleared the Precision cap and was then stopped by the card gate at 25
 * outcomes. That reads as random failure: the pull works, the knocking does
 * not. Somebody who can pull properties must be able to knock the doors they
 * pulled, so the grant is consulted first, by every route it has.
 *
 * The converse still does not hold: an address in the set above grants no
 * Precision spend, which is what keeps justinhoskins44@gmail.com at a knock
 * exemption and nothing more.
 */
function isKnockGateExempt(user) {
    return hasPrecisionGrant(user) || KNOCK_GATE_EXEMPT_EMAILS.has(normalizeAccountEmail(user?.email));
}
return { precisionGrantLabel, precisionGrantLimit };
})();
const { companySeatAccess, resolveOutcomeBillingContext } = (() => {
// Company seats provisioned outside Stripe. These are server configuration,
// separate from client-visible subscription/payment caches and Precision spend.
const COMPANY_SEAT_GRANTS_BY_MANAGER_ID = new Map([
    // Kevin Kussmaul / Flotilla: 13 company-paid rep seats, billed outside Stripe.
    ['6abaa09e961945efded82229', 13]
]);

const normalized = (value) => String(value || '').trim().toLowerCase();
const asArray = (value) => Array.isArray(value) ? value : value?.items || [];
const isActiveRep = (member) => normalized(member?.role || 'rep') === 'rep'
    && normalized(member?.status || 'active') === 'active';

async function resolveOutcomeBillingContext(base44, authenticatedUser) {
    const actor = await base44.asServiceRole.entities.User.get(authenticatedUser.id).catch(() => null);
    if (!actor || normalized(actor.email) !== normalized(authenticatedUser.email)) {
        throw Object.assign(new Error('The authenticated account could not be verified.'), {
            status: 401, code: 'invalid_authenticated_user'
        });
    }

    const personalContext = { actor, billingUser: actor, managerId: actor.id, teamMember: null };
    const managerId = String(actor.team_manager_id || actor.data?.team_manager_id || '').trim();
    if (!managerId || managerId === String(actor.id)) return personalContext;

    const memberId = String(actor.team_member_id || actor.data?.team_member_id || '').trim();
    const memberships = asArray(await base44.asServiceRole.entities.TeamMember.filter({
        user_id: actor.id, manager_id: managerId
    }, '-updated_date', 50));
    const teamMember = memberships.find((member) =>
        String(member?.user_id || '') === String(actor.id)
        && String(member?.manager_id || '') === managerId
        && (!memberId || String(member?.id || '') === memberId)
        && normalized(member?.email) === normalized(actor.email)
        && isActiveRep(member)
    );
    // A tenant pointer alone cannot inherit another account's billing or grants.
    if (!teamMember) return personalContext;

    const billingUser = await base44.asServiceRole.entities.User.get(managerId).catch(() => null);
    if (!billingUser) return personalContext;
    return { actor, billingUser, managerId, teamMember };
}

async function companySeatAccess(base44, billingUser, teamMember) {
    const grantedSeats = COMPANY_SEAT_GRANTS_BY_MANAGER_ID.get(String(billingUser?.id || ''));
    const appRole = normalized(billingUser?.app_role || billingUser?.data?.app_role);
    const role = normalized(billingUser?.role || billingUser?.data?.role);
    const allocatedSeats = billingUser?.total_seats;
    if (!Number.isSafeInteger(grantedSeats) || grantedSeats < 1
        || !Number.isSafeInteger(allocatedSeats) || allocatedSeats < 1
        || normalized(billingUser?.subscription_status) !== 'active'
        || !(billingUser?.is_owner === true || ['manager', 'admin'].includes(appRole)
            || ['manager', 'admin'].includes(role))) return null;

    const seatLimit = Math.min(grantedSeats, allocatedSeats);
    let activeRepCount = 0;
    let memberFound = !teamMember;
    const pageSize = 100;
    for (let skip = 0; ; skip += pageSize) {
        const page = asArray(await base44.asServiceRole.entities.TeamMember.filter({
            manager_id: billingUser.id
        }, '-created_date', pageSize, skip));
        for (const member of page) {
            if (String(member?.manager_id || '') !== String(billingUser.id) || !isActiveRep(member)) continue;
            activeRepCount += 1;
            if (teamMember && String(member.id) === String(teamMember.id)
                && String(member.user_id || '') === String(teamMember.user_id || '')
                && normalized(member.email) === normalized(teamMember.email)) memberFound = true;
        }
        if (activeRepCount > seatLimit) return null;
        if (page.length < pageSize) break;
    }
    return memberFound ? {
        source: 'company_seat_grant', manager_id: billingUser.id,
        seat_limit: seatLimit, active_rep_count: activeRepCount
    } : null;
}

return { companySeatAccess, resolveOutcomeBillingContext };
})();

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

        const context = await resolveOutcomeBillingContext(base44, user);
        const billingUser = context.billingUser;
        const companySeats = await companySeatAccess(base44, billingUser, context.teamMember);
        const nowSeconds = Date.now() / 1000;
        const found: any[] = [];
        const seen = new Set<string>();

        if (billingUser.subscription_id) {
            const stored = await stripe.subscriptions.retrieve(String(billingUser.subscription_id), {
                expand: ['latest_invoice']
            }).catch((error: any) => ({ error: error?.raw?.code || error?.message }));
            found.push({ lookup: 'stored_subscription_id', subscription: stored });
            if ((stored as any)?.id) seen.add((stored as any).id);
        }

        if (typeof stripe.subscriptions.search === 'function') {
            const escaped = String(billingUser.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
                metadata_matches_account: String(subscription.metadata?.base44_user_id || '') === String(billingUser.id),
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
            billing_account: {
                user_id: billingUser.id,
                email: billingUser.email,
                verified_team_member_id: context.teamMember?.id || null
            },
            company_seat_access: companySeats,
            ...(companySeats ? { outcome_gate: { card_required: false, free_outcome_limit_applies: false } } : {}),
            subscriptions: report
        });
    } catch (error: any) {
        console.error('[diagnoseKnockBilling]', error?.message || error);
        return Response.json({ error: error?.message || 'Diagnostic failed' }, { status: 500 });
    }
});
