// Knock Mode freemium gate logic — single source of truth.
//
// Free plan: up to 50 lifetime logged outcomes. The 51st attempt is blocked.
// Pro / upgraded / owner / exempt users bypass the gate entirely.
//
// outcomes_logged is the persisted lifetime counter on the User record. It is
// null-safe (treated as 0) and never decrements.

export const FREE_OUTCOME_LIMIT = 50;

const EXEMPT_EMAILS = [
  'christian@nativepest.com',
  'kevin@reefenvironmental.com',
  'christian@nativepestmanagement.com',
  'keven@reefenvironmental.com',
  'justinhoskins44@gmail.com',
];

// Pro / upgraded users bypass the gate completely. If plan tier is null/undefined,
// default to free behavior (do NOT bypass).
export function isProUser(user) {
  if (!user) return false;
  if (user.is_owner) return true;
  const status = user.subscription_status;
  if (status === 'active' || status === 'trialing') return true;
  const email = String(user.email || '').trim().toLowerCase();
  if (EXEMPT_EMAILS.includes(email)) return true;
  return false;
}

// Null-safe read of the lifetime counter.
export function getOutcomesLogged(user) {
  const value = user?.outcomes_logged;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Returns true when a free user attempting another outcome must be blocked.
// Gate fires on the 51st attempt: outcomes_logged >= 50 at tap time.
export function isOutcomeBlocked(user) {
  if (isProUser(user)) return false;
  return getOutcomesLogged(user) >= FREE_OUTCOME_LIMIT;
}