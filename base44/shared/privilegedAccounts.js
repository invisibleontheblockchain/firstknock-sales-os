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
export const UNLIMITED_PROPERTY_CAP = 1000000;

export function normalizeAccountEmail(value) {
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
export const PRECISION_GRANTS = new Map([
    ['invisibleontheblockchain@gmail.com', UNLIMITED_PROPERTY_CAP],
    ['christian@nativapest.com', 1000]
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
export const PRECISION_GRANTS_BY_USER_ID = new Map([
    // christian@nativapest.com
    ['6978c7229935cf40cde25086', 1000]
]);

/**
 * Exempt from the 25-outcome card gate and the 50-outcome free ceiling.
 * Every granted account is included by construction: somebody who can pull
 * properties must be able to knock the doors they pulled.
 */
export const KNOCK_GATE_EXEMPT_EMAILS = new Set([
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
export const PRECISION_GRANTS_BY_EMAIL_DOMAIN = new Map([
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

export function precisionGrantLimit(user) {
    const byId = usableLimit(PRECISION_GRANTS_BY_USER_ID.get(String(user?.id ?? '').trim()));
    if (byId !== null) return byId;
    const byEmail = usableLimit(PRECISION_GRANTS.get(normalizeAccountEmail(user?.email)));
    if (byEmail !== null) return byEmail;
    return usableLimit(PRECISION_GRANTS_BY_EMAIL_DOMAIN.get(emailDomain(user?.email)));
}

export function hasPrecisionGrant(user) {
    return precisionGrantLimit(user) !== null;
}

/**
 * Written to the entitlement's subscriptionId so a granted allowance is
 * traceable in logs and diagnostics. Nothing branches on these strings.
 */
export function precisionGrantLabel(limit) {
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
export function currentGrantPeriod(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
        periodStart: new Date(Date.UTC(year, month, 1)).toISOString(),
        periodEnd: new Date(Date.UTC(year, month + 1, 1)).toISOString()
    };
}

export function isKnockGateExempt(user) {
    return KNOCK_GATE_EXEMPT_EMAILS.has(normalizeAccountEmail(user?.email));
}
