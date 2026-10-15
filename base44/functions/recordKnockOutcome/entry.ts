import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Stripe from 'npm:stripe@14.14.0';
const { isKnockGateExempt } = (() => {
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
return { isKnockGateExempt };
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
const CARD_REQUIRED_AFTER = 25;
const FREE_OUTCOME_LIMIT = 50;
const OUTCOME_LEASE_MS = 30_000;
const OUTCOME_LEASE_WAIT_MS = 5_000;
const DUPLICATE_TAP_WINDOW_MS = 10_000;
const OUTCOMES = new Set([
    'SOLD',
    'QUALIFIED',
    'HARD_NO',
    'NOT_QUALIFIED',
    'CALLBACK',
    'NO_ANSWER',
    'ELIGIBLE',
    'NOT_MOVED_IN',
    'DM_NOT_HOME'
]);
const WORKFLOW_TRANSITIONS: Record<string, {
    parsedStatus: string;
    workflowBucket: string;
    rawInputText: string;
}> = {
    BULK_MOVE_TO_TODO: {
        parsedStatus: 'ELIGIBLE',
        workflowBucket: 'TODO',
        rawInputText: 'Workflow update - moved to Todo'
    },
    BULK_MOVE_TO_CALLBACK: {
        parsedStatus: 'CALLBACK',
        workflowBucket: 'CALLBACK',
        rawInputText: 'Workflow update - moved to Callback'
    },
    BULK_MOVE_TO_RE_KNOCK: {
        parsedStatus: 'ELIGIBLE',
        workflowBucket: 'RE_KNOCK',
        rawInputText: 'Workflow update - moved to Re-Knock'
    }
};

class HttpError extends Error {
    status: number;
    code: string;
    details: any;

    constructor(status: number, code: string, message: string, details: any = undefined) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function asArray(value: any) {
    return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function normalized(value: any) {
    return String(value || '').trim().toLowerCase();
}

function requiredString(value: any, field: string, maxLength = 256) {
    const result = String(value || '').trim();
    if (!result || result.length > maxLength) {
        throw new HttpError(400, 'invalid_outcome', `${field} is required or invalid.`);
    }
    return result;
}

function optionalString(value: any, field: string, maxLength: number) {
    if (value === undefined || value === null || value === '') return null;
    const result = String(value).trim();
    if (result.length > maxLength) {
        throw new HttpError(400, 'invalid_outcome', `${field} is too long.`);
    }
    return result || null;
}

function optionalNumber(value: any, field: string, minimum: number, maximum: number) {
    if (value === undefined || value === null || value === '') return null;
    const result = Number(value);
    if (!Number.isFinite(result) || result < minimum || result > maximum) {
        throw new HttpError(400, 'invalid_outcome', `${field} is invalid.`);
    }
    return result;
}

function optionalDateTime(value: any, field: string) {
    const result = optionalString(value, field, 64);
    if (!result) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/i.exec(result);
    const year = Number(match?.[1]);
    const month = Number(match?.[2]);
    const day = Number(match?.[3]);
    const hour = Number(match?.[4]);
    const minute = Number(match?.[5]);
    const second = Number(match?.[6]);
    const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
    const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [
        31,
        leapYear ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31
    ];
    const timestamp = new Date(result);
    if (
        !match
        || month < 1
        || month > 12
        || day < 1
        || day > daysInMonth[month - 1]
        || hour > 23
        || minute > 59
        || second > 59
        || offsetHour > 23
        || offsetMinute > 59
        || !Number.isFinite(timestamp.getTime())
    ) {
        throw new HttpError(400, 'invalid_outcome', `${field} is invalid.`);
    }
    return timestamp.toISOString();
}

function boundedServerString(value: any, maxLength: number) {
    const result = String(value || '').trim();
    return result ? result.slice(0, maxLength) : null;
}

function isAdminActor(user: any) {
    return normalized(user?.role || user?.data?.role) === 'admin';
}

function idempotencyKey(value: any, maxLength = 128) {
    const result = requiredString(value, 'idempotency_key', maxLength);
    if (!/^[A-Za-z0-9._:-]+$/.test(result)) {
        throw new HttpError(400, 'invalid_idempotency_key', 'idempotency_key contains unsupported characters.');
    }
    return result;
}

function canonicalize(value: any): any {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: any) {
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mutationCommitted(mutation: any) {
    return mutation?.success === true && Number(mutation?.updated) === 1 && mutation?.has_more !== true;
}

function randomToken() {
    return `knock_${crypto.randomUUID().replaceAll('-', '')}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function sleep(milliseconds: number) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireOutcomeLease(base44: any, actorId: string) {
    const deadline = Date.now() + OUTCOME_LEASE_WAIT_MS;
    do {
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const token = randomToken();
        const expiresAt = new Date(now + OUTCOME_LEASE_MS).toISOString();

        const currentUser = await base44.asServiceRole.entities.User.get(actorId).catch(() => null);
        if (currentUser) {
            const existingToken = String(currentUser.knock_outcome_lock_token || '');
            const existingExpiresAt = String(currentUser.knock_outcome_lock_expires_at || '');
            const isExpired = !existingExpiresAt || new Date(existingExpiresAt).getTime() <= now;

            if (!existingToken || isExpired) {
                await base44.asServiceRole.entities.User.update(actorId, {
                    knock_outcome_lock_token: token,
                    knock_outcome_lock_acquired_at: nowIso,
                    knock_outcome_lock_expires_at: expiresAt
                }).catch(() => null);

                const lockedUser = await base44.asServiceRole.entities.User.get(actorId).catch(() => null);
                if (
                    lockedUser
                    && String(lockedUser.knock_outcome_lock_token || '') === token
                    && String(lockedUser.knock_outcome_lock_expires_at || '') === expiresAt
                ) {
                    return { token };
                }
            }
        }

        if (Date.now() >= deadline) break;
        await sleep(50);
    } while (Date.now() <= deadline);

    throw new HttpError(
        409,
        'outcome_write_in_progress',
        'Another outcome is being saved for this account. Retry in a moment.'
    );
}

async function releaseOutcomeLease(base44: any, actorId: string, lease: any) {
    if (!lease) return;
    const currentUser = await base44.asServiceRole.entities.User.get(actorId).catch(() => null);
    if (currentUser && String(currentUser.knock_outcome_lock_token || '') === lease.token) {
        await base44.asServiceRole.entities.User.update(actorId, {
            knock_outcome_lock_token: null,
            knock_outcome_lock_acquired_at: null,
            knock_outcome_lock_expires_at: null
        }).catch(() => null);
    }
}

async function resolveActorAndBillingUser(base44: any, authenticatedUser: any) {
    return await resolveOutcomeBillingContext(base44, authenticatedUser);
}

function isPrivilegedBillingAccount(user: any) {
    const role = normalized(user?.role || user?.data?.role);
    return user?.is_owner === true
        || role === 'admin'
        || isKnockGateExempt(user);
}

function stripeResourceId(resource: any) {
    if (!resource) return null;
    return typeof resource === 'string' ? resource : resource.id || null;
}

function subscriptionBelongsToUser(subscription: any, user: any) {
    return String(subscription?.metadata?.base44_user_id || '') === String(user?.id || '');
}

function customerBelongsToUser(customer: any, user: any) {
    return !!customer
        && customer.deleted !== true
        && String(customer?.metadata?.base44_user_id || '') === String(user?.id || '');
}

async function loadOwnedSubscriptions(user: any) {
    const subscriptions = [];
    const seen = new Set();

    if (user?.subscription_id) {
        try {
            const stored = await stripe.subscriptions.retrieve(String(user.subscription_id), {
                expand: ['latest_invoice']
            });
            if (subscriptionBelongsToUser(stored, user)) {
                subscriptions.push(stored);
                seen.add(stored.id);
            }
        } catch (error: any) {
            if (error?.raw?.code !== 'resource_missing') throw error;
        }
    }

    if (typeof stripe.subscriptions.search === 'function') {
        const escapedUserId = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const result = await stripe.subscriptions.search({
            query: `metadata['base44_user_id']:'${escapedUserId}'`,
            limit: 100,
            expand: ['data.latest_invoice']
        });
        for (const subscription of result.data || []) {
            if (!seen.has(subscription.id) && subscriptionBelongsToUser(subscription, user)) {
                subscriptions.push(subscription);
                seen.add(subscription.id);
            }
        }
    }

    return subscriptions;
}

async function invoiceForSubscription(subscription: any) {
    if (!subscription?.latest_invoice) return null;
    if (typeof subscription.latest_invoice !== 'string') return subscription.latest_invoice;
    return await stripe.invoices.retrieve(subscription.latest_invoice);
}

async function hasCurrentPaidSubscription(subscriptions: any[]) {
    const nowSeconds = Date.now() / 1000;
    for (const subscription of subscriptions) {
        if (normalized(subscription?.status) !== 'active') continue;
        if (Number(subscription?.trial_end || 0) > nowSeconds) continue;
        if (Number(subscription?.current_period_end || 0) <= nowSeconds) continue;

        const invoice = await invoiceForSubscription(subscription);
        const invoiceSubscriptionId = stripeResourceId(invoice?.subscription);
        if (
            invoice?.status === 'paid'
            && Number(invoice?.amount_paid || 0) > 0
            && (!invoiceSubscriptionId || invoiceSubscriptionId === subscription.id)
        ) {
            return { paid: true, subscription };
        }
    }
    return { paid: false, subscription: null };
}

async function resolveCanonicalCustomer(user: any, subscriptions: any[], paidSubscription: any) {
    const subscriptionCustomerIds = [...new Set(
        [paidSubscription, ...subscriptions]
            .map((subscription) => stripeResourceId(subscription?.customer))
            .filter(Boolean)
    )];
    if (subscriptionCustomerIds.length > 1) {
        throw new HttpError(
            409,
            'billing_identity_ambiguous',
            'More than one Stripe customer is attached to this account. Contact support before logging more outcomes.'
        );
    }

    const preferredId = subscriptionCustomerIds[0] || (user?.stripe_customer_id ? String(user.stripe_customer_id) : null);
    if (preferredId) {
        try {
            const customer = await stripe.customers.retrieve(preferredId);
            if (customerBelongsToUser(customer, user)) return customer;
            if (subscriptionCustomerIds[0]) {
                throw new HttpError(409, 'billing_identity_mismatch', 'The subscription customer does not belong to this account.');
            }
        } catch (error: any) {
            if (error instanceof HttpError) throw error;
            if (error?.raw?.code !== 'resource_missing') throw error;
        }
    }

    if (typeof stripe.customers.search !== 'function') return null;
    const escapedUserId = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await stripe.customers.search({
        query: `metadata['base44_user_id']:'${escapedUserId}'`,
        limit: 10
    });
    const owned = (result.data || []).filter((customer: any) => customerBelongsToUser(customer, user));
    if (owned.length > 1) {
        throw new HttpError(
            409,
            'billing_identity_ambiguous',
            'More than one Stripe customer matches this account. Contact support before logging more outcomes.'
        );
    }
    return owned[0] || null;
}

async function liveBillingEvidence(base44: any, billingUser: any) {
    if (!Deno.env.get('STRIPE_SECRET_KEY')) {
        throw new HttpError(
            503,
            'billing_verification_unavailable',
            'Billing verification is temporarily unavailable. No outcome was logged.'
        );
    }

    try {
        const subscriptions = await loadOwnedSubscriptions(billingUser);
        const paidEvidence = await hasCurrentPaidSubscription(subscriptions);
        const customer = await resolveCanonicalCustomer(
            billingUser,
            subscriptions,
            paidEvidence.subscription
        );
        let hasCard = false;
        if (customer) {
            const methods = await stripe.paymentMethods.list({
                customer: customer.id,
                type: 'card',
                limit: 1
            });
            hasCard = (methods.data || []).length > 0;
        }

        await base44.asServiceRole.entities.User.update(billingUser.id, {
            ...(customer ? { stripe_customer_id: customer.id } : {}),
            stripe_card_on_file_confirmed: hasCard,
            ...(hasCard
                ? { stripe_card_confirmed_at: new Date().toISOString() }
                : { stripe_card_confirmed_at: null })
        });

        return {
            paid: paidEvidence.paid,
            hasCard,
            customerId: customer?.id || null
        };
    } catch (error: any) {
        if (error instanceof HttpError) throw error;
        console.error('Live Knock billing verification failed:', error?.message || error);
        throw new HttpError(
            503,
            'billing_verification_unavailable',
            'Billing verification is temporarily unavailable. No outcome was logged.'
        );
    }
}

function sanitizeInteraction(value: any, forcedStatus: string | null = null) {
    const source = value || {};
    const parsedStatus = forcedStatus || requiredString(source.parsed_status, 'parsed_status', 32).toUpperCase();
    if (!OUTCOMES.has(parsedStatus)) {
        throw new HttpError(400, 'invalid_outcome', 'parsed_status is not supported.');
    }
    if (!forcedStatus && parsedStatus === 'ELIGIBLE') {
        throw new HttpError(400, 'invalid_outcome', 'Use clear_decision to move a property back to Todo.');
    }

    const nextEligibleDate = optionalString(source.next_eligible_date, 'next_eligible_date', 64);
    if (nextEligibleDate && !Number.isFinite(new Date(nextEligibleDate).getTime())) {
        throw new HttpError(400, 'invalid_outcome', 'next_eligible_date is invalid.');
    }
    const sold = parsedStatus === 'SOLD';

    return {
        address_hash: requiredString(source.address_hash, 'address_hash', 256),
        raw_input_text: requiredString(source.raw_input_text, 'raw_input_text', 1000),
        parsed_status: parsedStatus,
        sale_amount: optionalNumber(source.sale_amount, 'sale_amount', 0, 100_000_000),
        sale_date: sold ? optionalDateTime(source.sale_date, 'sale_date') : null,
        property_address: sold ? optionalString(source.property_address, 'property_address', 500) : null,
        homeowner_name: sold ? optionalString(source.homeowner_name, 'homeowner_name', 250) : null,
        route_id: optionalString(source.route_id, 'route_id', 128),
        gps_proof_lat: optionalNumber(source.gps_proof_lat, 'gps_proof_lat', -90, 90),
        gps_proof_lng: optionalNumber(source.gps_proof_lng, 'gps_proof_lng', -180, 180),
        gps_accuracy: optionalNumber(source.gps_accuracy, 'gps_accuracy', 0, 100_000),
        image_url: optionalString(source.image_url, 'image_url', 2048),
        next_eligible_date: nextEligibleDate,
        description: optionalString(source.description, 'description', 1000)
    };
}

function compactInteraction(interaction: any) {
    return Object.fromEntries(Object.entries(interaction).filter(([, value]) => value !== null));
}

async function loadVisibleRoute(base44: any, actor: any, managerId: string, routeId: string) {
    const route = await base44.entities.SavedRoute.get(routeId).catch(() => null);
    if (!route) {
        throw new HttpError(403, 'route_access_denied', 'This route is not available to the authenticated account.');
    }
    const routeManagerId = String(route.manager_id || '').trim();
    const belongsToActor = normalized(route.created_by) === normalized(actor.email);
    if (routeManagerId && routeManagerId !== String(managerId) && !belongsToActor && !isAdminActor(actor)) {
        throw new HttpError(403, 'route_tenant_mismatch', 'This route belongs to a different workspace.');
    }
    return route;
}

function routeAliases(route: any) {
    return new Set(
        (Array.isArray(route?.property_hashes) ? route.property_hashes : [])
            .map((hash: any) => String(hash || '').trim())
            .filter(Boolean)
    );
}

function propertyAliases(property: any) {
    return [
        property?.address_hash,
        property?.legacy_hash,
        property?.id
    ].map((hash) => String(hash || '').trim()).filter(Boolean);
}

async function verifyHashesOnRoute(base44: any, route: any, requestedHashes: string[]) {
    const allowedRouteHashes = routeAliases(route);
    const missing = requestedHashes.filter((hash) => !allowedRouteHashes.has(hash));
    if (missing.length === 0) return;

    const propertiesByRequestedHash = new Map<string, any>();
    const remember = (properties: any[]) => {
        for (const property of properties) {
            for (const alias of propertyAliases(property)) {
                if (missing.includes(alias)) propertiesByRequestedHash.set(alias, property);
            }
        }
    };
    remember(asArray(await base44.asServiceRole.entities.MasterProperty.filter({
        address_hash: missing
    }, '-updated_date', Math.min(500, missing.length))));
    remember(asArray(await base44.asServiceRole.entities.MasterProperty.filter({
        legacy_hash: missing
    }, '-updated_date', Math.min(500, missing.length))));
    remember(asArray(await base44.asServiceRole.entities.MasterProperty.filter({
        id: missing
    }, '-updated_date', Math.min(500, missing.length))));

    const unauthorized = missing.filter((hash) => {
        const property = propertiesByRequestedHash.get(hash);
        return !property || !propertyAliases(property).some((alias) => allowedRouteHashes.has(alias));
    });
    if (unauthorized.length > 0) {
        throw new HttpError(
            403,
            'property_not_on_route',
            'Every selected property must be part of the selected route.',
            { rejected_address_hashes: unauthorized.slice(0, 10) }
        );
    }
}

async function verifyRouteAccess(base44: any, actor: any, managerId: string, interaction: any) {
    if (!interaction.route_id) return null;
    const route = await loadVisibleRoute(base44, actor, managerId, interaction.route_id);
    await verifyHashesOnRoute(base44, route, [interaction.address_hash]);
    return route;
}

function saleIdentitySnapshot(actor: any, teamMember: any, route: any) {
    return {
        rep_id: String(teamMember?.id || actor.id),
        rep_name: boundedServerString(
            teamMember?.name || actor?.full_name || actor?.name || actor?.email,
            250
        ),
        route_name: boundedServerString(route?.name, 250)
    };
}

async function currentProtectedCount(base44: any, actor: any) {
    let count = Math.max(0, Math.floor(Number(actor.outcomes_logged || 0)));
    const latest = asArray(await base44.asServiceRole.entities.InteractionLog.filter({
        logged_by_user_id: actor.id,
        counts_toward_free_limit: true
    }, '-outcome_sequence', 1));
    if (latest[0]) count = Math.max(count, Math.floor(Number(latest[0].outcome_sequence || 0)));

    let reconciledAt = actor.outcomes_reconciled_at || null;
    if (!reconciledAt) {
        let legacyCount = 0;
        const pageSize = 500;
        for (let skip = 0; skip < 10_000 && legacyCount < FREE_OUTCOME_LIMIT; skip += pageSize) {
            const page = asArray(await base44.asServiceRole.entities.InteractionLog.filter({
                created_by: actor.email
            }, '-created_date', pageSize, skip));
            legacyCount += page.filter((log: any) =>
                log.counts_as_knock !== false
                && log.parsed_status !== 'ELIGIBLE'
                && log.source !== 'csv_history_import'
                && log.source !== 'workflow_transition'
            ).length;
            if (page.length < pageSize) break;
        }
        count = Math.max(count, legacyCount);
        reconciledAt = new Date().toISOString();
    }

    return { count, reconciledAt };
}

async function syncProtectedCount(base44: any, actorId: string, lease: any, count: number, reconciledAt: string) {
    const currentUser = await base44.asServiceRole.entities.User.get(actorId).catch(() => null);
    if (!currentUser || String(currentUser.knock_outcome_lock_token || '') !== lease.token) {
        throw new HttpError(
            503,
            'outcome_counter_write_failed',
            'The outcome counter could not be committed. Retry with the same action.'
        );
    }
    await base44.asServiceRole.entities.User.update(actorId, {
        outcomes_logged: count,
        outcomes_reconciled_at: reconciledAt
    });
}

async function existingIdempotentLog(base44: any, actorId: string, key: string) {
    const rows = asArray(await base44.asServiceRole.entities.InteractionLog.filter({
        logged_by_user_id: actorId,
        idempotency_key: key
    }, '-created_date', 2));
    if (rows.length > 1) {
        throw new HttpError(409, 'idempotency_integrity_failed', 'Duplicate outcome retry keys require support review.');
    }
    return rows[0] || null;
}

async function enforceGate(base44: any, billingUser: any, count: number, teamMember: any = null) {
    if (isPrivilegedBillingAccount(billingUser)) {
        return { privileged: true, paid: true, hasCard: true };
    }
    if (count < CARD_REQUIRED_AFTER) {
        return { privileged: false, paid: false, hasCard: false };
    }

    const companySeats = await companySeatAccess(base44, billingUser, teamMember);
    if (companySeats) {
        return { privileged: false, paid: false, hasCard: false, companySeats };
    }

    const evidence = await liveBillingEvidence(base44, billingUser);
    if (teamMember && !evidence.paid) {
        throw new HttpError(
            402,
            'team_seat_access_required',
            'Your team needs active seat access. Ask your manager to review the company subscription.'
        );
    }
    if (count >= FREE_OUTCOME_LIMIT && !evidence.paid) {
        throw new HttpError(
            402,
            'free_outcome_limit_reached',
            'The 50-outcome free limit has been reached. Upgrade to keep logging outcomes.',
            { gate: 'limit', outcomes_logged: count }
        );
    }
    if (!evidence.paid && !evidence.hasCard) {
        throw new HttpError(
            402,
            'card_required',
            'A live attached card is required after 25 logged outcomes.',
            { gate: 'card', outcomes_logged: count }
        );
    }
    return { privileged: false, ...evidence };
}

async function recordOne(base44: any, authenticatedUser: any, body: any, clearDecision = false) {
    const key = idempotencyKey(body.idempotency_key);
    const interaction = sanitizeInteraction(
        body.interaction || body,
        clearDecision ? 'ELIGIBLE' : null
    );
    const source = clearDecision ? 'decision_clear' : 'knock_mode';
    const countsTowardLimit = !clearDecision;
    const requestHash = await sha256({ interaction: compactInteraction(interaction), source });
    const { actor: initialActor, billingUser, managerId, teamMember } = await resolveActorAndBillingUser(
        base44,
        authenticatedUser
    );
    const verifiedRoute = await verifyRouteAccess(base44, initialActor, managerId, interaction);
    const interactionForWrite = interaction.parsed_status === 'SOLD'
        ? { ...interaction, ...saleIdentitySnapshot(initialActor, teamMember, verifiedRoute) }
        : interaction;

    let lease = null;
    try {
        lease = await acquireOutcomeLease(base44, initialActor.id);
        const actor = await base44.asServiceRole.entities.User.get(initialActor.id);
        const protectedState = await currentProtectedCount(base44, actor);
        const existing = await existingIdempotentLog(base44, actor.id, key);
        if (existing) {
            if (String(existing.request_hash || '') !== requestHash) {
                throw new HttpError(
                    409,
                    'idempotency_key_reused',
                    'This retry key was already used for a different outcome.'
                );
            }
            const recoveredCount = countsTowardLimit
                ? Math.max(protectedState.count, Math.floor(Number(existing.outcome_sequence || 0)))
                : protectedState.count;
            await syncProtectedCount(
                base44,
                actor.id,
                lease,
                recoveredCount,
                protectedState.reconciledAt
            );
            return {
                success: true,
                reused: true,
                interaction: existing,
                outcomes_logged: recoveredCount
            };
        }

        if (countsTowardLimit) {
            const recent = asArray(await base44.asServiceRole.entities.InteractionLog.filter({
                logged_by_user_id: actor.id,
                address_hash: interaction.address_hash,
                source: 'knock_mode'
            }, '-created_date', 1))[0];
            const recentTime = recent?.created_date ? new Date(recent.created_date).getTime() : NaN;
            if (
                recent
                && recent.request_hash === requestHash
                && Number.isFinite(recentTime)
                && Date.now() - recentTime <= DUPLICATE_TAP_WINDOW_MS
            ) {
                const recoveredCount = Math.max(
                    protectedState.count,
                    Math.floor(Number(recent.outcome_sequence || 0))
                );
                await syncProtectedCount(
                    base44,
                    actor.id,
                    lease,
                    recoveredCount,
                    protectedState.reconciledAt
                );
                return {
                    success: true,
                    reused: true,
                    duplicate_tap_suppressed: true,
                    interaction: recent,
                    outcomes_logged: recoveredCount
                };
            }
        }

        if (countsTowardLimit) {
            await enforceGate(base44, billingUser, protectedState.count, teamMember);
        }
        const nextCount = countsTowardLimit ? protectedState.count + 1 : protectedState.count;
        const created = await base44.asServiceRole.entities.InteractionLog.create({
            ...compactInteraction(interactionForWrite),
            created_by: actor.email,
            manager_id: managerId,
            logged_by_user_id: actor.id,
            idempotency_key: key,
            request_hash: requestHash,
            ...(countsTowardLimit ? { outcome_sequence: nextCount } : {}),
            counts_toward_free_limit: countsTowardLimit,
            counts_as_knock: countsTowardLimit,
            ...(clearDecision ? {
                workflow_action: 'CLEAR_TO_TODO',
                workflow_bucket: 'TODO'
            } : {}),
            source
        });
        await syncProtectedCount(
            base44,
            actor.id,
            lease,
            nextCount,
            protectedState.reconciledAt
        );
        const verifiedUser = await base44.asServiceRole.entities.User.get(actor.id);
        if (Math.floor(Number(verifiedUser?.outcomes_logged || 0)) < nextCount) {
            throw new HttpError(
                503,
                'outcome_counter_verification_failed',
                'The outcome was saved but its counter is still reconciling. Retry with the same action.'
            );
        }
        return {
            success: true,
            reused: false,
            interaction: created,
            outcomes_logged: nextCount,
            card_required_after: CARD_REQUIRED_AFTER,
            free_outcome_limit: FREE_OUTCOME_LIMIT
        };
    } finally {
        await releaseOutcomeLease(base44, initialActor.id, lease);
    }
}

async function importHistory(base44: any, authenticatedUser: any, body: any) {
    const requestKey = idempotencyKey(body.idempotency_key, 100);
    const interactions = Array.isArray(body.interactions) ? body.interactions : [];
    if (interactions.length < 1 || interactions.length > 500) {
        throw new HttpError(400, 'invalid_import', 'History imports require 1 to 500 interactions per request.');
    }

    const { actor, billingUser, managerId, teamMember } = await resolveActorAndBillingUser(base44, authenticatedUser);
    if (!isPrivilegedBillingAccount(billingUser)
        && !await companySeatAccess(base44, billingUser, teamMember)) {
        const evidence = await liveBillingEvidence(base44, billingUser);
        if (!evidence.paid) {
            throw new HttpError(
                402,
                'paid_plan_required',
                'CSV history import requires a current paid subscription.',
                { gate: 'limit' }
            );
        }
    }

    const prepared = [];
    const routeCache = new Map<string, any>();
    for (let index = 0; index < interactions.length; index += 1) {
        const interaction = sanitizeInteraction(interactions[index]);
        let verifiedRoute = null;
        if (interaction.route_id) {
            if (!routeCache.has(interaction.route_id)) {
                routeCache.set(
                    interaction.route_id,
                    await loadVisibleRoute(base44, actor, managerId, interaction.route_id)
                );
            }
            verifiedRoute = routeCache.get(interaction.route_id);
            await verifyHashesOnRoute(base44, verifiedRoute, [interaction.address_hash]);
        }
        const interactionForWrite = interaction.parsed_status === 'SOLD'
            ? { ...interaction, ...saleIdentitySnapshot(actor, teamMember, verifiedRoute) }
            : interaction;
        const key = `${requestKey}:${index}`;
        const requestHash = await sha256({
            interaction: compactInteraction(interaction),
            source: 'csv_history_import'
        });
        prepared.push({
            ...compactInteraction(interactionForWrite),
            created_by: actor.email,
            manager_id: managerId,
            logged_by_user_id: actor.id,
            idempotency_key: key,
            request_hash: requestHash,
            counts_toward_free_limit: false,
            counts_as_knock: true,
            source: 'csv_history_import'
        });
    }

    const keys = prepared.map((item) => item.idempotency_key);
    const existing = asArray(await base44.asServiceRole.entities.InteractionLog.filter({
        logged_by_user_id: actor.id,
        idempotency_key: keys
    }, '-created_date', prepared.length));
    const existingByKey = new Map(existing.map((item: any) => [item.idempotency_key, item]));
    for (const item of prepared) {
        const prior = existingByKey.get(item.idempotency_key);
        if (prior && prior.request_hash !== item.request_hash) {
            throw new HttpError(
                409,
                'idempotency_key_reused',
                'This import retry key was already used with different history.'
            );
        }
    }
    const missing = prepared.filter((item) => !existingByKey.has(item.idempotency_key));
    if (missing.length > 0) {
        await base44.asServiceRole.entities.InteractionLog.bulkCreate(missing);
    }
    return {
        success: true,
        imported: missing.length,
        reused: prepared.length - missing.length
    };
}

function workflowRequest(body: any) {
    const routeId = requiredString(body.route_id, 'route_id', 128);
    const workflowAction = requiredString(body.workflow_action, 'workflow_action', 64).toUpperCase();
    const transition = WORKFLOW_TRANSITIONS[workflowAction];
    if (!transition) {
        throw new HttpError(400, 'invalid_workflow_transition', 'workflow_action is not supported.');
    }

    if (!Array.isArray(body.address_hashes) || body.address_hashes.length < 1 || body.address_hashes.length > 500) {
        throw new HttpError(
            400,
            'invalid_workflow_transition',
            'Workflow transitions require 1 to 500 address_hashes.'
        );
    }
    const addressHashes = body.address_hashes
        .map((hash: any) => requiredString(hash, 'address_hashes', 256))
        .sort();
    if (new Set(addressHashes).size !== addressHashes.length) {
        throw new HttpError(
            400,
            'invalid_workflow_transition',
            'address_hashes must not contain duplicates.'
        );
    }

    return {
        routeId,
        addressHashes,
        workflowAction,
        transition,
        key: idempotencyKey(body.idempotency_key)
    };
}

function verifyWorkflowRouteOwner(actor: any, managerId: string, teamMember: any, route: any) {
    const assignedTo = String(route?.assigned_to || '').trim();
    const actorOwnsRoute = normalized(route?.created_by) === normalized(actor.email)
        || String(route?.manager_id || '') === String(actor.id);
    const assignedToActor = [actor.id, teamMember?.id]
        .filter(Boolean)
        .map(String)
        .includes(assignedTo);
    if (!actorOwnsRoute && !assignedToActor && !isAdminActor(actor)) {
        throw new HttpError(
            403,
            'route_not_assigned',
            'This route is not owned by or assigned to the authenticated account.'
        );
    }
    if (
        String(route?.manager_id || '').trim()
        && String(route.manager_id) !== String(managerId)
        && !isAdminActor(actor)
    ) {
        throw new HttpError(403, 'route_tenant_mismatch', 'This route belongs to a different workspace.');
    }
    if (normalized(route?.status) === 'archived') {
        throw new HttpError(409, 'route_archived', 'Archived routes are read-only.');
    }
}

async function workflowTransition(base44: any, authenticatedUser: any, body: any) {
    const request = workflowRequest(body);
    const { actor, managerId, teamMember } = await resolveActorAndBillingUser(base44, authenticatedUser);
    const route = await loadVisibleRoute(base44, actor, managerId, request.routeId);
    verifyWorkflowRouteOwner(actor, managerId, teamMember, route);
    await verifyHashesOnRoute(base44, route, request.addressHashes);

    const requestHash = await sha256({
        source: 'workflow_transition',
        route_id: request.routeId,
        address_hashes: request.addressHashes,
        workflow_action: request.workflowAction
    });
    let lease = null;
    try {
        lease = await acquireOutcomeLease(base44, actor.id);
        const existing = asArray(await base44.asServiceRole.entities.InteractionLog.filter({
            logged_by_user_id: actor.id,
            idempotency_key: request.key
        }, '-created_date', 501));
        if (existing.some((row: any) =>
            row.source !== 'workflow_transition'
            || String(row.request_hash || '') !== requestHash
            || String(row.route_id || '') !== request.routeId
            || String(row.workflow_action || '') !== request.workflowAction
        )) {
            throw new HttpError(
                409,
                'idempotency_key_reused',
                'This retry key was already used for a different workflow transition.'
            );
        }

        const existingByHash = new Map<string, any>();
        for (const row of existing) {
            const hash = String(row.address_hash || '');
            if (
                !request.addressHashes.includes(hash)
                || existingByHash.has(hash)
            ) {
                throw new HttpError(
                    409,
                    'idempotency_integrity_failed',
                    'Workflow retry records require support review.'
                );
            }
            existingByHash.set(hash, row);
        }

        const missingHashes = request.addressHashes.filter((hash) => !existingByHash.has(hash));
        const missingRows = missingHashes.map((addressHash) => ({
            address_hash: addressHash,
            raw_input_text: request.transition.rawInputText,
            parsed_status: request.transition.parsedStatus,
            route_id: request.routeId,
            created_by: actor.email,
            manager_id: managerId,
            logged_by_user_id: actor.id,
            idempotency_key: request.key,
            request_hash: requestHash,
            counts_toward_free_limit: false,
            counts_as_knock: false,
            workflow_action: request.workflowAction,
            workflow_bucket: request.transition.workflowBucket,
            source: 'workflow_transition'
        }));
        const bulkResult = missingRows.length > 0
            ? await base44.asServiceRole.entities.InteractionLog.bulkCreate(missingRows)
            : [];
        const created = asArray(bulkResult);

        return {
            success: true,
            reused: missingRows.length === 0,
            workflow_action: request.workflowAction,
            workflow_bucket: request.transition.workflowBucket,
            updated_count: request.addressHashes.length,
            interactions: [
                ...existing,
                ...(created.length === missingRows.length ? created : missingRows)
            ]
        };
    } finally {
        await releaseOutcomeLease(base44, actor.id, lease);
    }
}

// A house note is durable field knowledge — "gate code 4412", "husband decides,
// evenings only" — that a rep may read back months later. It is deliberately NOT
// an outcome:
//   - it carries no parsed_status, so it can never change a door's decision;
//   - counts_as_knock and counts_toward_free_limit are false and enforceGate is
//     never called, so autosaving a note can never consume billed outcomes.
// One row per house per tenant, updated in place, so autosave cannot flood the
// interaction history. The outcome ledger above remains append-only; this is a
// separate, non-metered record that happens to share the entity.
async function saveHouseNote(base44: any, authenticatedUser: any, body: any) {
    const addressHash = requiredString(body.address_hash, 'address_hash', 256);
    const note = optionalString(body.note, 'note', 1000) || '';
    const routeId = optionalString(body.route_id, 'route_id', 128);

    const { actor, managerId } = await resolveActorAndBillingUser(base44, authenticatedUser);
    if (routeId) {
        await verifyRouteAccess(base44, actor, managerId, {
            route_id: routeId,
            address_hash: addressHash
        });
    }

    const existing = asArray(await base44.asServiceRole.entities.InteractionLog.filter({
        address_hash: addressHash,
        manager_id: managerId,
        source: 'house_note'
    }, '-created_date', 1))[0] || null;

    const fields = {
        description: note,
        // address_hash, parsed_status and raw_input_text are required by the
        // InteractionLog schema, so they are written on updates too, not only on
        // create. ELIGIBLE is the "no decision was made" value — every status
        // derivation filters house notes out before reading it, so it is never
        // what the house displays.
        address_hash: addressHash,
        parsed_status: 'ELIGIBLE',
        raw_input_text: note ? 'House note updated' : 'House note cleared',
        route_id: routeId || existing?.route_id || null,
        logged_by_user_id: actor.id,
        counts_toward_free_limit: false,
        counts_as_knock: false,
        // No workflow action is set — that enum describes administrative
        // transitions between route buckets, and a note is not one. No decision
        // field is set either, so this row can never read as an outcome.
        source: 'house_note'
    };

    const saved = existing
        ? await base44.asServiceRole.entities.InteractionLog.update(existing.id, fields)
        : await base44.asServiceRole.entities.InteractionLog.create({
            ...fields,
            created_by: actor.email,
            manager_id: managerId
        });

    return { success: true, note: saved, address_hash: addressHash };
}

async function editSale(base44: any, authenticatedUser: any, body: any) {
    const allowedFields = new Set([
        'action',
        'interaction_id',
        'parsed_status',
        'raw_input_text',
        'sale_amount'
    ]);
    const unexpectedFields = Object.keys(body || {}).filter((field) => !allowedFields.has(field));
    if (unexpectedFields.length > 0) {
        throw new HttpError(
            400,
            'invalid_sale_edit',
            'Sale edits may only change parsed_status, raw_input_text, and sale_amount.'
        );
    }

    const interactionId = requiredString(body.interaction_id, 'interaction_id', 128);
    const { actor, managerId } = await resolveActorAndBillingUser(base44, authenticatedUser);
    const existing = await base44.asServiceRole.entities.InteractionLog.get(interactionId).catch(() => null);
    if (!existing) {
        throw new HttpError(404, 'interaction_not_found', 'The sale interaction was not found.');
    }

    const isCreator = String(existing.logged_by_user_id || '') === String(actor.id)
        || normalized(existing.created_by) === normalized(actor.email);
    const isExactTenantManager = String(managerId) === String(actor.id)
        && String(existing.manager_id || '') === String(actor.id);
    if (!isCreator && !isExactTenantManager && !isAdminActor(actor)) {
        throw new HttpError(403, 'sale_edit_denied', 'This sale is outside the authenticated account scope.');
    }

    const updates: Record<string, any> = {};
    if (Object.prototype.hasOwnProperty.call(body, 'parsed_status')) {
        const parsedStatus = requiredString(body.parsed_status, 'parsed_status', 32).toUpperCase();
        if (!OUTCOMES.has(parsedStatus)) {
            throw new HttpError(400, 'invalid_sale_edit', 'parsed_status is not supported.');
        }
        updates.parsed_status = parsedStatus;
        if (parsedStatus !== 'SOLD' && !Object.prototype.hasOwnProperty.call(body, 'sale_amount')) {
            updates.sale_amount = null;
        }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'raw_input_text')) {
        updates.raw_input_text = requiredString(body.raw_input_text, 'raw_input_text', 1000);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'sale_amount')) {
        updates.sale_amount = optionalNumber(body.sale_amount, 'sale_amount', 0, 100_000_000);
    }
    if (Object.keys(updates).length === 0) {
        throw new HttpError(
            400,
            'invalid_sale_edit',
            'Provide at least one supported sale field to update.'
        );
    }
    const resultingStatus = String(updates.parsed_status || existing.parsed_status || '').toUpperCase();
    if (resultingStatus !== 'SOLD' && updates.sale_amount !== null && updates.sale_amount !== undefined) {
        throw new HttpError(400, 'invalid_sale_edit', 'sale_amount is only valid for SOLD interactions.');
    }

    const updated = await base44.asServiceRole.entities.InteractionLog.update(interactionId, updates);
    return {
        success: true,
        interaction: updated || { ...existing, ...updates }
    };
}

Deno.serve(async (req: Request) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') {
            return Response.json({ error: 'Method not allowed' }, { status: 405 });
        }

        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) throw new HttpError(401, 'unauthorized', 'Unauthorized');
        const body = await req.json().catch(() => ({}));
        const action = String(body.action || 'record').trim().toLowerCase();

        let result;
        if (action === 'record') {
            result = await recordOne(base44, user, body, false);
        } else if (action === 'clear_decision') {
            result = await recordOne(base44, user, body, true);
        } else if (action === 'import_history') {
            result = await importHistory(base44, user, body);
        } else if (action === 'workflow_transition') {
            result = await workflowTransition(base44, user, body);
        } else if (action === 'save_house_note') {
            result = await saveHouseNote(base44, user, body);
        } else if (action === 'edit_sale') {
            result = await editSale(base44, user, body);
        } else {
            throw new HttpError(400, 'unsupported_action', 'Unsupported outcome action.');
        }
        return Response.json(result);
    } catch (error: any) {
        if (!(error instanceof HttpError)) {
            console.error('recordKnockOutcome failed:', error?.message || error);
        }
        return Response.json({
            error: error?.message || 'Unable to log outcome.',
            code: error?.code || 'outcome_write_failed',
            ...(error?.details ? error.details : {})
        }, { status: Number(error?.status || 500) });
    }
});
