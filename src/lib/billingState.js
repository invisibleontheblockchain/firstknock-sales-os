const BILLING_PLAN_ALIASES = new Map([
  ['precision', 'precision'],
  ['growth', 'precision'],
  ['canvas', 'canvas']
]);
const MANAGEABLE_SUBSCRIPTION_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'paused',
  'incomplete'
]);

export function normalizeBillingPlanId(value) {
  const planId = String(value || '').trim().toLowerCase();
  return BILLING_PLAN_ALIASES.get(planId) || null;
}

export function getBillingState(user) {
  const status = String(user?.subscription_status || '').trim().toLowerCase();
  const isTrialing = status === 'trialing';
  const isActive = status === 'active';
  const hasSubscription = MANAGEABLE_SUBSCRIPTION_STATUSES.has(status);

  return {
    status,
    isTrialing,
    isActive,
    needsPaymentRecovery: hasSubscription && !isTrialing && !isActive,
    hasSubscription,
    currentPlanId: normalizeBillingPlanId(user?.subscription_tier)
  };
}

export function shouldShowTrialActivation(user, planId) {
  const { isTrialing, currentPlanId } = getBillingState(user);
  if (!isTrialing) return false;

  // Precision must always remain available during a trial. A Canvas trial can
  // also activate its current $19 plan without creating another subscription.
  return planId === 'precision' || (planId === 'canvas' && currentPlanId === 'canvas');
}
