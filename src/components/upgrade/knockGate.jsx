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

export function hasCardOnFile(user) {
  if (!user) return false;
  if (isProUser(user)) return true;
  return user.stripe_card_on_file_confirmed === true;
}

export function needsCardOnFile(user) {
  if (isProUser(user)) return false;
  if (hasCardOnFile(user)) return false;
  return getOutcomesLogged(user) >= CARD_ON_FILE_THRESHOLD;
}

// Returns true when a free user attempting another outcome must be blocked.
// Gate fires when the persisted counter has reached the free outcome limit.
export function isOutcomeBlocked(user) {
  if (isProUser(user)) return false;
  return getOutcomesLogged(user) >= FREE_OUTCOME_LIMIT;
}
