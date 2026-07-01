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