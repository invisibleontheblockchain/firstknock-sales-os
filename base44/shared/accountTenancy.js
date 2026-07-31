// Shared tenant resolution for account-scoped backend functions.

export function isRepAccount(user) {
  const appRole = user?.app_role || user?.data?.app_role || '';
  const accountRole = user?.role || user?.data?.role || '';
  const managerLike = user?.is_owner === true
    || ['manager', 'admin'].includes(appRole)
    || ['manager', 'admin'].includes(accountRole);
  return !managerLike && appRole === 'rep';
}

export function tenantManagerId(user) {
  return isRepAccount(user)
    ? (user?.team_manager_id || user?.data?.team_manager_id || null)
    : (user?.id || null);
}

export function toEntityArray(result) {
  return Array.isArray(result) ? result : (result?.items || []);
}