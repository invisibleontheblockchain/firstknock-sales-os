// Knock Mode freemium gate logic — single source of truth.
//
// Free plan: logged outcomes require a card after the threshold below, then
// stop at the lifetime outcome limit unless the account upgrades.
// Pro / upgraded / owner / exempt users bypass the gate entirely.
//
// outcomes_logged is the persisted lifetime counter on the User record. It is
// null-safe (treated as 0) and never decrements.

export const FREE_OUTCOME_LIMIT = 50;
export const CARD_ON_FILE_THRESHOLD = 25;

const EXEMPT_EMAILS = [
  'christian@nativepest.com',
  'kevin@reefenvironmental.com',
  'kevin@reifenvironmental.com',
  'christian@nativepestmanagement.com',
  'keven@reefenvironmental.com',
  'justinhoskins44@gmail.com',
];

// Client-side display hint only. The outcome service re-verifies paid access
// and attached cards directly with Stripe before every gated write.
export function isProUser(user) {
  if (!user) return false;
  if (user.is_owner) return true;
  const status = user.subscription_status;
  if (status === 'active' && user.subscription_paid_confirmed === true) return true;
  const email = String(user.email || '').trim().toLowerCase();
  if (EXEMPT_EMAILS.includes(email)) return true;
  return false;
}

// Null-safe read of the lifetime counter.
export function getOutcomesLogged(user) {
  const value = user?.outcomes_logged;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function hasCardOnFile(user) {
  if (!user) return false;
  if (isProUser(user)) return true;
  return user.stripe_card_on_file_confirmed === true;
}

export function needsCardOnFile(user) {
  if (isProUser(user)) return false;
  if (getOutcomesLogged(user) >= FREE_OUTCOME_LIMIT) return false;
  if (hasCardOnFile(user)) return false;
  return getOutcomesLogged(user) >= CARD_ON_FILE_THRESHOLD;
}

// Returns true when a free user attempting another outcome must be blocked.
// Gate fires when the persisted counter has reached the free outcome limit.
export function isOutcomeBlocked(user) {
  if (isProUser(user)) return false;
  return getOutcomesLogged(user) >= FREE_OUTCOME_LIMIT;
}

export function createOutcomeIdempotencyKey(prefix = 'knock') {
  const randomPart = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${randomPart}`;
}

export function getOutcomeGateFromError(error) {
  const candidates = [
    error?.response?.data,
    error?.data,
    error?.body,
    error
  ].filter(Boolean);
  for (const candidate of candidates) {
    const code = String(candidate?.code || '');
    const gate = String(candidate?.gate || '');
    if (code === 'card_required' || gate === 'card') return 'card';
    if (
      code === 'free_outcome_limit_reached'
      || code === 'paid_plan_required'
      || gate === 'limit'
    ) return 'limit';
  }
  const message = String(error?.message || '');
  if (/card_required|attached card|required after 25/i.test(message)) return 'card';
  if (/free_outcome_limit|50-outcome|paid_plan_required/i.test(message)) return 'limit';
  return null;
}