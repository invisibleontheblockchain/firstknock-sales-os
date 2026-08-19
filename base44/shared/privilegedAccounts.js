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
 * Exempt from the 25-outcome card gate and the 50-outcome free ceiling.
 * Every granted account is included by construction: somebody who can pull
 * properties must be able to knock the doors they pulled.
 */
export const KNOCK_GATE_EXEMPT_EMAILS = new Set([
    ...PRECISION_GRANTS.keys(),
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
export function precisionGrantLimit(user) {
    const limit = PRECISION_GRANTS.get(normalizeAccountEmail(user?.email));
    return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
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

export function isKnockGateExempt(user) {
    return KNOCK_GATE_EXEMPT_EMAILS.has(normalizeAccountEmail(user?.email));
}
