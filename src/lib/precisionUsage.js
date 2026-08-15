// @ts-check

export const FREE_PRECISION_PROPERTY_LIMIT = 50;
export const PAID_PRECISION_PROPERTY_LIMIT = 1000;
const PRECISION_START_BLOCKER_CODES = new Set([
  'multiple_active_precision_jobs',
  'precision_provider_outcome_unverifiable',
  'precision_job_active',
  'precision_reservation_unsettled'
]);

// Precision usage is intentionally not calculated from SavedRoute or User
// records. Both are client-mutable. Consumers must use getPrecisionUsage via
// usePrecisionUsage(), which verifies Stripe and reads service-owned FetchJobs.

function strictWhole(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Precision usage returned an invalid ${field}.`);
  }
  return value;
}

function strictJobIds(value) {
  if (
    !Array.isArray(value)
    || value.some((id) => typeof id !== 'string' || !id.trim() || id.trim() !== id)
    || new Set(value).size !== value.length
  ) {
    throw new Error('Precision usage returned invalid unsettled_job_ids.');
  }
  return [...value];
}

export function hasUnsettledPrecisionReservation(usage) {
  return usage?.startAvailable === false
    && usage?.startBlockerCode === 'precision_reservation_unsettled'
    && Number.isSafeInteger(usage?.unsettledReservationCount)
    && usage.unsettledReservationCount > 0
    && Array.isArray(usage?.unsettledJobIds)
    && usage.unsettledJobIds.length === usage.unsettledReservationCount;
}

export function normalizePrecisionUsageResponse(response) {
  const data = response?.data || response;
  if (data?.success !== true || data?.complete !== true) {
    throw new Error(data?.message || 'Precision usage is temporarily unavailable.');
  }
  const version = strictWhole(data.version, 'version');
  if (version < 2) {
    throw new Error('Precision usage is temporarily unavailable.');
  }

  const limit = strictWhole(data.limit, 'limit');
  const used = strictWhole(data.used, 'used');
  const reserved = strictWhole(data.reserved, 'reserved');
  const meterUsed = strictWhole(data.meter_used, 'meter_used');
  const remaining = strictWhole(data.remaining, 'remaining');
  if (meterUsed !== Math.min(limit, used + reserved) || remaining !== Math.max(0, limit - meterUsed)) {
    throw new Error('Precision usage returned an inconsistent allowance snapshot.');
  }
  const lifetimeUsed = strictWhole(data.lifetime_used, 'lifetime_used');
  const trialUsed = strictWhole(data.trial_used, 'trial_used');
  const trialRemaining = strictWhole(data.trial_remaining, 'trial_remaining');
  const percent = strictWhole(data.percent, 'percent');
  const expectedPercent = limit > 0
    ? Math.min(100, Math.round((meterUsed / limit) * 100))
    : 0;
  if (percent !== expectedPercent) {
    throw new Error('Precision usage returned an inconsistent allowance percentage.');
  }
  if (typeof data.start_available !== 'boolean') {
    throw new Error('Precision usage returned an invalid start_available.');
  }
  const unsettledReservationCount = strictWhole(
    data.unsettled_reservation_count,
    'unsettled_reservation_count'
  );
  const unsettledJobIds = strictJobIds(data.unsettled_job_ids);
  if (unsettledReservationCount !== unsettledJobIds.length) {
    throw new Error('Precision usage returned an inconsistent unsettled reservation snapshot.');
  }
  const rawStartBlockerCode = data.start_blocker_code;
  const startBlockerCode = rawStartBlockerCode === null
    ? null
    : (
        typeof rawStartBlockerCode === 'string'
        && PRECISION_START_BLOCKER_CODES.has(rawStartBlockerCode)
          ? rawStartBlockerCode
          : undefined
      );
  if (startBlockerCode === undefined) {
    throw new Error('Precision usage returned an invalid start_blocker_code.');
  }
  const startBlockerJobIds = strictJobIds(data.start_blocker_job_ids);
  if (
    (startBlockerCode === null && startBlockerJobIds.length !== 0)
    || (startBlockerCode !== null && startBlockerJobIds.length === 0)
  ) {
    throw new Error('Precision usage returned inconsistent start blocker evidence.');
  }
  if (
    startBlockerCode === 'precision_job_active'
    && startBlockerJobIds.length !== 1
  ) {
    throw new Error('Precision usage returned inconsistent active-job blocker evidence.');
  }
  if (
    startBlockerCode === 'multiple_active_precision_jobs'
    && startBlockerJobIds.length < 2
  ) {
    throw new Error('Precision usage returned inconsistent multiple-active blocker evidence.');
  }
  if (startBlockerCode === 'precision_reservation_unsettled') {
    const blockerIds = [...startBlockerJobIds].sort();
    const reservationIds = [...unsettledJobIds].sort();
    if (
      blockerIds.length !== reservationIds.length
      || blockerIds.some((id, index) => id !== reservationIds[index])
    ) {
      throw new Error('Precision usage returned inconsistent reservation blocker evidence.');
    }
  }
  if (startBlockerCode === null && unsettledReservationCount !== 0) {
    throw new Error('Precision usage omitted the blocker for an unsettled reservation.');
  }
  const expectedStartAvailable = startBlockerCode === null && remaining > 0;
  if (data.start_available !== expectedStartAvailable) {
    throw new Error('Precision usage returned an inconsistent start availability snapshot.');
  }

  return {
    ...data,
    version,
    limit,
    used,
    reserved,
    meterUsed,
    remaining,
    lifetimeUsed,
    trialUsed,
    trialRemaining,
    percent: expectedPercent,
    paidAccess: data.paid_access === true,
    proAccess: data.pro_access === true,
    startAvailable: data.start_available,
    startBlockerCode,
    startBlockerJobIds,
    unsettledReservationCount,
    unsettledJobIds
  };
}
