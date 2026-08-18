// @ts-check

export const FREE_PRECISION_PROPERTY_LIMIT = 50;
export const PAID_PRECISION_PROPERTY_LIMIT = 1000;

// Precision usage is intentionally not calculated from SavedRoute or User
// records. Both are client-mutable. Consumers must use getPrecisionUsage via
// usePrecisionUsage(), which verifies Stripe and reads service-owned FetchJobs.

function finiteWhole(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Precision usage returned an invalid ${field}.`);
  }
  return Math.floor(number);
}

export function normalizePrecisionUsageResponse(response) {
  const data = response?.data || response;
  if (!data?.success || data?.complete !== true || Number(data?.version) < 2) {
    throw new Error(data?.message || 'Precision usage is temporarily unavailable.');
  }

  const limit = finiteWhole(data.limit, 'limit');
  const used = finiteWhole(data.used, 'used');
  const reserved = finiteWhole(data.reserved, 'reserved');
  const meterUsed = finiteWhole(data.meter_used, 'meter_used');
  const remaining = finiteWhole(data.remaining, 'remaining');
  if (meterUsed !== Math.min(limit, used + reserved) || remaining !== Math.max(0, limit - meterUsed)) {
    throw new Error('Precision usage returned an inconsistent allowance snapshot.');
  }

  return {
    ...data,
    limit,
    used,
    reserved,
    meterUsed,
    remaining,
    lifetimeUsed: finiteWhole(data.lifetime_used, 'lifetime_used'),
    trialUsed: finiteWhole(data.trial_used, 'trial_used'),
    trialRemaining: finiteWhole(data.trial_remaining, 'trial_remaining'),
    configuredExtraCredits: finiteWhole(data.configured_extra_credits || 0, 'configured_extra_credits'),
    rolloverCreditsIssued: finiteWhole(data.rollover_credits_issued || 0, 'rollover_credits_issued'),
    rolloverCreditsConsumed: finiteWhole(data.rollover_credits_consumed || 0, 'rollover_credits_consumed'),
    rolloverCreditsRemaining: finiteWhole(data.rollover_credits_remaining || 0, 'rollover_credits_remaining'),
    percent: Math.max(0, Math.min(100, Number(data.percent) || 0)),
    paidAccess: data.paid_access === true,
    proAccess: data.pro_access === true
  };
}