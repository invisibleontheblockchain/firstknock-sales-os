const FREE_PRECISION_HOME_LIMIT = 50;
const PRECISION_TIERS = new Set(['pro', 'precision', 'growth', 'enterprise']);
const NON_PRECISION_TIERS = new Set(['canvas', 'hustler']);

function normalizedTier(user) {
  return String(user?.subscription_tier || '').trim().toLowerCase();
}

function hasPaidPrecisionLimit(user) {
  const limit = Number(user?.precision_property_limit || user?.monthly_property_limit || 0);
  return Number.isFinite(limit) && limit > FREE_PRECISION_HOME_LIMIT;
}

export function isPrecisionTier(user) {
  return PRECISION_TIERS.has(normalizedTier(user));
}

export function isExplicitNonPrecisionTier(user) {
  return NON_PRECISION_TIERS.has(normalizedTier(user));
}

export function isPrecisionTierOrUnknown(user) {
  const tier = normalizedTier(user);
  if (isPrecisionTier(user)) return true;
  if (isExplicitNonPrecisionTier(user)) return false;
  if (hasPaidPrecisionLimit(user)) return true;
  return !tier || tier === 'custom';
}

export function isPrecisionProUser(user) {
  const status = String(user?.subscription_status || '').toLowerCase();
  if (user?.is_owner || user?.role === 'admin') return true;
  if (!['active', 'trialing'].includes(status)) return false;
  return isPrecisionTier(user) || hasPaidPrecisionLimit(user) || (user?.subscription_paid_confirmed === true && isPrecisionTierOrUnknown(user));
}

export function hasConfirmedPaidPrecisionAccess(user) {
  const status = String(user?.subscription_status || '').toLowerCase();
  if (user?.is_owner || user?.role === 'admin') return true;
  if (status !== 'active' || user?.subscription_paid_confirmed !== true) return false;
  return isPrecisionTierOrUnknown(user);
}
