export const PRIVATE_HQ_VIEWER_IDS = Object.freeze([
  '695eb764b077190880be21df',
  '6978c7229935cf40cde25086',
]);

export function canViewPlatformDashboard(user) {
  if (!user) return false;
  const id = String(user.id || user?.data?.id || '').trim();
  return PRIVATE_HQ_VIEWER_IDS.includes(id);
}

