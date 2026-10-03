// Resume the existing app entry after the same-origin sign-in flow.
export function getLandingDestinations({ search = '' } = {}) {
  const appEntry = `/RoleSelect${search}`;
  const signInUrl = `/login?returnTo=${encodeURIComponent(appEntry)}`;
  return { appEntry, signInUrl };
}
