export function getAccountRole(user) {
  return user?.role || user?.data?.role || '';
}

export function getAppRole(user) {
  return user?.app_role || user?.data?.app_role || '';
}

export function isManagerAccount(user) {
  if (!user) return false;
  const appRole = getAppRole(user);
  const accountRole = getAccountRole(user);
  return user.is_owner === true || appRole === 'manager' || appRole === 'admin' || accountRole === 'manager' || accountRole === 'admin';
}

export function isRepAccount(user) {
  return !!user && !isManagerAccount(user) && getAppRole(user) === 'rep';
}

export function getManagerIdForAccount(user) {
  return isRepAccount(user) ? (user?.team_manager_id || user?.data?.team_manager_id) : user?.id;
}

/**
 * Where an account belongs after sign-in or role selection.
 *
 * Routing used to compare `app_role === 'manager'` directly, which sends every
 * other manager-ish account -- app_role 'admin', account role 'admin', and
 * anyone carrying is_owner -- to the rep surface instead. That is the wrong
 * app: RepHome is Knock Mode, with no route builder and no Precision
 * generation, so an owner landing there sees a product missing half its
 * features. isManagerAccount already knows every shape a manager can take;
 * routing has to ask it rather than re-deriving a narrower answer.
 */
export function landingPageForAccount(user) {
  return isManagerAccount(user) ? 'Home' : 'RepHome';
}
