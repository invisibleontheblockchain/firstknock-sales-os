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
 */

export const UNLIMITED_PROPERTY_CAP = 1000000;

export function normalizeAccountEmail(value) {
    return String(value ?? '').trim().toLowerCase();
}

/**
 * Uncapped Precision pulls. The cap is a large finite number rather than
 * Infinity because the reservation, expected-count and progress math all
 * persist it on the FetchJob.
 */
export const UNLIMITED_PRECISION_EMAILS = new Set([
    'invisibleontheblockchain@gmail.com',
    'christian@nativapest.com'
]);

/**
 * Exempt from the 25-outcome card gate and the 50-outcome free ceiling.
 * Deliberately a superset of the unlimited-Precision list: an account that can
 * pull without limit must also be able to knock the doors it pulled.
 */
export const KNOCK_GATE_EXEMPT_EMAILS = new Set([
    ...UNLIMITED_PRECISION_EMAILS,
    'christian@nativepest.com',
    'christian@nativepestmanagement.com',
    'kevin@reefenvironmental.com',
    'kevin@reifenvironmental.com',
    'keven@reefenvironmental.com',
    'justinhoskins44@gmail.com'
]);

export function hasUnlimitedPrecision(user) {
    return UNLIMITED_PRECISION_EMAILS.has(normalizeAccountEmail(user?.email));
}

export function isKnockGateExempt(user) {
    return KNOCK_GATE_EXEMPT_EMAILS.has(normalizeAccountEmail(user?.email));
}
