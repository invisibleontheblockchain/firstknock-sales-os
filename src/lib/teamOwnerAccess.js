// Account-specific team QA entitlement. Keep public rep codes and client flags
// out of this decision; the backend passes a service-loaded User record.
export function hasUnlimitedTeamAccess(user) {
  return user?.id === '6a741df85d7aac35a09a0068'
    && String(user?.email || '').trim().toLowerCase() === 'invisibleontheblockchain@gmail.com'
    && (user?.is_owner === true || user?.data?.is_owner === true);
}

