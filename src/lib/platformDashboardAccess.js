import { getAccountRole } from '@/lib/roles';

const DEFAULT_ADDITIONAL_VIEWERS = ['christian@nativapest.com', 'baysecurity@gmail.com'];

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function configuredAdditionalViewers() {
  const configured = String(import.meta.env.VITE_PLATFORM_DASHBOARD_ALLOWED_EMAILS || '')
    .split(',')
    .map(normalizedEmail)
    .filter(Boolean);
  return new Set([...DEFAULT_ADDITIONAL_VIEWERS, ...configured]);
}

export function canViewPlatformDashboard(user) {
  if (!user) return false;
  if (getAccountRole(user) === 'admin') return true;
  const email = normalizedEmail(user.email || user?.data?.email);
  return configuredAdditionalViewers().has(email);
}

