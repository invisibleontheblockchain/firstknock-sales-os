import { isManagerAccount } from '../../lib/roles.js';

const DEFAULT_ROUTE_PAGE_SIZE = 200;
const DEFAULT_ROUTE_MAX_PAGES = 50;

function entityRows(response) {
  return Array.isArray(response) ? response : (Array.isArray(response?.items) ? response.items : []);
}

function normalizeId(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function routeKey(route = {}, index = 0) {
  const id = normalizeId(route.id);
  if (id) return `id:${id}`;

  return [
    'missing-id',
    route.manager_id,
    route.created_by,
    route.name,
    route.created_date,
    index,
  ].map((value) => normalizeId(value)).join('\u0000');
}

export function buildRepRouteScope(user, teamMemberMatches = []) {
  const userId = normalizeId(user?.id);
  const userEmail = normalizeEmail(user?.email || user?.data?.email);
  const managerAccount = isManagerAccount(user);
  let managerId = managerAccount
    ? userId
    : normalizeId(user?.team_manager_id || user?.data?.team_manager_id);

  const linkedMatches = entityRows(teamMemberMatches).filter((member) => (
    !userEmail || normalizeEmail(member?.email) === userEmail
  ));

  // Older rep profiles may predate team_manager_id. Pick one deterministic
  // account from the newest email match, then exclude same-email records from
  // every other account. Never union TeamMember IDs across tenants.
  if (!managerId) {
    managerId = normalizeId(linkedMatches.find((member) => member?.manager_id)?.manager_id);
  }

  const scopedMatches = managerId
    ? linkedMatches.filter((member) => normalizeId(member?.manager_id) === managerId)
    : [];
  const primaryTeamMember = scopedMatches.find((member) => normalizeId(member?.user_id) === userId)
    || scopedMatches[0]
    || null;
  const teamMemberIds = [...new Set(scopedMatches.map((member) => normalizeId(member?.id)).filter(Boolean))];
  const assigneeIds = [...new Set([userId, ...teamMemberIds].filter(Boolean))];

  return {
    userId,
    userEmail,
    managerId: managerId || null,
    managerAccount,
    primaryTeamMember,
    teamMemberIds,
    assigneeIds,
  };
}

export async function fetchAllSavedRoutePages(
  fetchPage,
  { pageSize = DEFAULT_ROUTE_PAGE_SIZE, maxPages = DEFAULT_ROUTE_MAX_PAGES } = {},
) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');

  const safePageSize = Math.max(1, Math.min(
    DEFAULT_ROUTE_PAGE_SIZE,
    Math.floor(Number(pageSize) || DEFAULT_ROUTE_PAGE_SIZE),
  ));
  const safeMaxPages = Math.max(1, Math.floor(Number(maxPages) || DEFAULT_ROUTE_MAX_PAGES));
  const routes = [];
  const seenPageFingerprints = new Set();

  for (let pageIndex = 0; pageIndex < safeMaxPages; pageIndex += 1) {
    const skip = pageIndex * safePageSize;
    const page = entityRows(await fetchPage(safePageSize, skip));
    if (!page.length) return routes;

    const fingerprint = page.map((route, index) => routeKey(route, index)).join('|');
    if (seenPageFingerprints.has(fingerprint)) {
      throw new Error('Saved route pagination repeated a page before reaching the end.');
    }
    seenPageFingerprints.add(fingerprint);
    routes.push(...page);

    if (page.length < safePageSize) return routes;
  }

  throw new Error(`Saved route query exceeded ${safeMaxPages.toLocaleString()} pages.`);
}

export function routeIsVisibleInKnock(route, scope) {
  if (!route || !scope) return false;

  const routeManagerId = normalizeId(route.manager_id);
  const assignedTo = normalizeId(route.assigned_to);
  const belongsToKnownTenant = Boolean(scope.managerId && routeManagerId === scope.managerId);
  const belongsToOtherTenant = Boolean(routeManagerId && routeManagerId !== scope.managerId);
  const assignedToCurrentUser = Boolean(assignedTo && scope.assigneeIds.includes(assignedTo));

  if (belongsToOtherTenant) return false;
  if (scope.managerAccount) {
    if (belongsToKnownTenant) return true;
    return !routeManagerId && (
      normalizeEmail(route.created_by) === scope.userEmail
      || assignedToCurrentUser
    );
  }

  return assignedToCurrentUser && (belongsToKnownTenant || !routeManagerId);
}

export function collectKnockRoutes(routeGroups = [], scope) {
  const routesByKey = new Map();

  routeGroups.flatMap(entityRows).forEach((route, index) => {
    if (!routeIsVisibleInKnock(route, scope)) return;
    const key = routeKey(route, index);
    if (!routesByKey.has(key)) routesByKey.set(key, route);
  });

  return [...routesByKey.values()].sort((left, right) => {
    const leftTime = new Date(left?.created_date || left?.updated_date || 0).getTime();
    const rightTime = new Date(right?.created_date || right?.updated_date || 0).getTime();
    const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
    const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
    return safeRight - safeLeft;
  });
}

export function selectKnockRoute(routes = [], preferredRouteId = null) {
  if (!Array.isArray(routes) || !routes.length) return null;

  const preferredId = normalizeId(preferredRouteId);
  if (preferredId) {
    const preferred = routes.find((route) => normalizeId(route?.id) === preferredId);
    if (preferred) return preferred;
  }

  for (const status of ['IN_PROGRESS', 'ACTIVE', 'PENDING']) {
    const match = routes.find((route) => String(route?.status || 'PENDING').toUpperCase() === status);
    if (match) return match;
  }

  // When an account contains only past routes, keep them reviewable instead
  // of presenting a false empty state.
  return routes[0];
}

export function getKnockRouteCacheKey(scope) {
  const tenant = normalizeId(scope?.managerId) || 'no-tenant';
  const viewer = normalizeId(scope?.userId) || 'anonymous';
  const view = scope?.managerAccount ? 'manager' : 'rep';
  return `cached_routes_${tenant}_${viewer}_${view}`;
}
