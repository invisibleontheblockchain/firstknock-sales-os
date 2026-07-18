const CANVAS_PLAN_IDS = new Set(['canvas']);
const PRIVILEGED_ACCOUNT_ROLES = new Set(['admin']);

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

export function isCanvasPlan(user) {
  return CANVAS_PLAN_IDS.has(normalized(user?.subscription_tier));
}

export function hasCanvasAccess(user) {
  if (!user) return false;

  const accountRole = normalized(user?.role || user?.data?.role);
  if (PRIVILEGED_ACCOUNT_ROLES.has(accountRole)) {
    return true;
  }

  if (!isCanvasPlan(user)) return false;
  const status = normalized(user.subscription_status);
  if (status === 'trialing') {
    return user.stripe_card_on_file_confirmed === true;
  }
  return status === 'active' && user.subscription_paid_confirmed === true;
}
