export const BASE_PRECISION_PROPERTIES = 1000;
export const MAX_PRECISION_PROPERTIES = 50000;
export const CREDIT_BLOCK_PROPERTIES = 1000;
export const CREDIT_BLOCK_PRICE_CENTS = 4900;
export const MAX_EXTRA_CREDIT_BLOCKS = 49;
export const PRECISION_CREDIT_COMPONENT = 'precision_extra_credits';

// A credit pack is a one-off purchase, not a line on the subscription. It
// funds the same rollover ledger the monthly add-on funded, so the balance,
// the limit and the usage meter all behave identically once the money lands --
// only the way it is charged differs. Checkout marks the session with this
// intent so the webhook can tell a pack from a plan purchase.
export const PRECISION_CREDIT_PACK_INTENT = 'precision_credit_pack';
export const MIN_CREDIT_PACK_BLOCKS = 1;

// Packs are bought, never set to a level, so zero is not a valid purchase --
// this is deliberately stricter than normalizeExtraCreditBlocks, which has to
// accept 0 to express 'remove the recurring add-on'.
export function normalizeCreditPackBlocks(value) {
    const blocks = Number(value ?? 0);
    if (!Number.isInteger(blocks) || blocks < MIN_CREDIT_PACK_BLOCKS || blocks > MAX_EXTRA_CREDIT_BLOCKS) return null;
    return blocks;
}

export function creditPackProperties(blocks) {
    return blocks * CREDIT_BLOCK_PROPERTIES;
}

export function creditPackPriceCents(blocks) {
    return blocks * CREDIT_BLOCK_PRICE_CENTS;
}

export function normalizeExtraCreditBlocks(value) {
    const blocks = Number(value ?? 0);
    if (!Number.isInteger(blocks) || blocks < 0 || blocks > MAX_EXTRA_CREDIT_BLOCKS) return null;
    return blocks;
}

export function isPrecisionCreditPrice(price) {
    return String(price?.metadata?.billing_component || '') === PRECISION_CREDIT_COMPONENT;
}

export function isPaidPrecisionCreditInvoice(invoice) {
    return invoice?.status === 'paid'
        && Number(invoice?.amount_paid || 0) > 0
        && (invoice?.lines?.data || []).some(line =>
            Number(line?.amount || 0) > 0 && isPrecisionCreditPrice(line?.price)
        );
}

export function configuredExtraCredits(subscription) {
    const item = (subscription?.items?.data || []).find(candidate => isPrecisionCreditPrice(candidate?.price));
    const blocks = Math.max(0, Math.floor(Number(item?.quantity || 0)));
    return Math.min(MAX_EXTRA_CREDIT_BLOCKS, blocks) * CREDIT_BLOCK_PROPERTIES;
}

export async function listPrecisionCreditLedger(base44, ownerUserId) {
    const records = [];
    const pageSize = 500;
    for (let skip = 0; skip < 10000; skip += pageSize) {
        const page = await base44.asServiceRole.entities.PrecisionCreditLedger.filter(
            { owner_user_id: ownerUserId }, 'created_date', pageSize, skip
        );
        const items = Array.isArray(page) ? page : (page?.items || []);
        records.push(...items);
        if (items.length < pageSize) return records;
    }
    throw new Error('Precision credit history exceeds the supported reconciliation window.');
}

function periodKey(value) {
    const timestamp = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function calculatePrecisionCreditState({ ledger = [], jobs = [], currentPeriodStart }) {
    const totalIssued = ledger.reduce((sum, entry) => sum + Math.max(0, Math.floor(Number(entry?.credits_delta || 0))), 0);
    const currentKey = periodKey(currentPeriodStart);
    const periods = new Map();
    for (const job of jobs) {
        if (job?.kind !== 'paid') continue;
        const key = periodKey(job.periodStart);
        if (!key) continue;
        const usage = periods.get(key) || { used: 0, reserved: 0 };
        usage.used += Math.max(0, Math.floor(Number(job.used || 0)));
        usage.reserved += Math.max(0, Math.floor(Number(job.reserved || 0)));
        periods.set(key, usage);
    }

    let historicalConsumed = 0;
    for (const [key, usage] of periods) {
        if (key === currentKey) continue;
        historicalConsumed += Math.max(0, usage.used - BASE_PRECISION_PROPERTIES);
    }
    const creditBalanceAtPeriodStart = Math.max(0, totalIssued - historicalConsumed);
    const current = periods.get(currentKey) || { used: 0, reserved: 0 };
    const currentCreditCommitted = Math.max(0, current.used + current.reserved - BASE_PRECISION_PROPERTIES);
    const rolloverRemaining = Math.max(0, creditBalanceAtPeriodStart - currentCreditCommitted);
    const limit = Math.min(MAX_PRECISION_PROPERTIES, BASE_PRECISION_PROPERTIES + creditBalanceAtPeriodStart);

    return {
        totalIssued,
        historicalConsumed,
        creditBalanceAtPeriodStart,
        rolloverRemaining,
        limit
    };
}