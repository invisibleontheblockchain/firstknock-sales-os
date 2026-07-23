import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildRepRouteScope,
  collectKnockRoutes,
  fetchAllSavedRoutePages,
  getKnockRouteCacheKey,
  routeIsVisibleInKnock,
  selectKnockRoute,
} from '../src/components/rep/repRouteCollection.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

test('team identities are restricted to the signed-in account', () => {
  const scope = buildRepRouteScope({
    id: 'user-1',
    email: 'rep@example.com',
    app_role: 'rep',
    team_manager_id: 'manager-1',
  }, [
    { id: 'member-other', email: 'rep@example.com', manager_id: 'manager-2' },
    { id: 'member-current', email: 'REP@example.com', manager_id: 'manager-1', user_id: 'user-1' },
    { id: 'member-current-old', email: 'rep@example.com', manager_id: 'manager-1' },
  ]);

  assert.equal(scope.managerId, 'manager-1');
  assert.equal(scope.primaryTeamMember.id, 'member-current');
  assert.deepEqual(scope.teamMemberIds, ['member-current', 'member-current-old']);
  assert.deepEqual(scope.assigneeIds, ['user-1', 'member-current', 'member-current-old']);
  assert.equal(scope.assigneeIds.includes('member-other'), false);
});

test('manager roles include nested/admin/owner access instead of a flat app_role check', () => {
  const nestedAdmin = buildRepRouteScope({
    id: 'manager-1',
    data: { app_role: 'admin', email: 'owner@example.com' },
  });
  const owner = buildRepRouteScope({ id: 'owner-1', email: 'owner@example.com', is_owner: true });

  assert.equal(nestedAdmin.managerAccount, true);
  assert.equal(nestedAdmin.managerId, 'manager-1');
  assert.equal(owner.managerAccount, true);
  assert.equal(owner.managerId, 'owner-1');
});

test('manager collection keeps every tenant status and empty route shell while rejecting other tenants', () => {
  const scope = buildRepRouteScope({
    id: 'manager-1',
    email: 'manager@example.com',
    role: 'manager',
  });
  const tenantRoutes = [
    { id: 'active', manager_id: 'manager-1', status: 'ACTIVE', created_date: '2026-07-01' },
    { id: 'completed', manager_id: 'manager-1', status: 'COMPLETED', created_date: '2026-07-02' },
    { id: 'archived', manager_id: 'manager-1', status: 'ARCHIVED', created_date: '2026-07-03' },
    { id: 'shell', manager_id: 'manager-1', status: 'PENDING', property_hashes: [], created_date: '2026-07-04' },
    { id: 'foreign', manager_id: 'manager-2', status: 'ACTIVE', created_date: '2026-07-05' },
  ];
  const legacyRoutes = [
    { id: 'legacy-mine', created_by: 'MANAGER@example.com', status: 'COMPLETED' },
    { id: 'legacy-foreign', created_by: 'other@example.com', status: 'ACTIVE' },
  ];

  const routes = collectKnockRoutes([tenantRoutes, legacyRoutes, [tenantRoutes[0]]], scope);

  assert.deepEqual(new Set(routes.map((route) => route.id)), new Set([
    'active',
    'completed',
    'archived',
    'shell',
    'legacy-mine',
  ]));
  assert.equal(routes.filter((route) => route.id === 'active').length, 1);
  assert.equal(routeIsVisibleInKnock(tenantRoutes[4], scope), false);
});

test('rep collection permits only own assignments inside the account plus safe legacy assignments', () => {
  const scope = buildRepRouteScope({
    id: 'user-1',
    email: 'rep@example.com',
    app_role: 'rep',
    team_manager_id: 'manager-1',
  }, [{ id: 'member-1', email: 'rep@example.com', manager_id: 'manager-1' }]);
  const routes = collectKnockRoutes([[
    { id: 'mine', manager_id: 'manager-1', assigned_to: 'member-1', status: 'COMPLETED' },
    { id: 'shell', manager_id: 'manager-1', assigned_to: 'user-1', property_hashes: [] },
    { id: 'other-rep', manager_id: 'manager-1', assigned_to: 'member-2' },
    { id: 'other-tenant', manager_id: 'manager-2', assigned_to: 'member-1' },
    { id: 'legacy-mine', assigned_to: 'member-1' },
    { id: 'unassigned', manager_id: 'manager-1' },
  ]], scope);

  assert.deepEqual(new Set(routes.map((route) => route.id)), new Set(['mine', 'shell', 'legacy-mine']));
});

test('saved routes paginate without dropping completed, archived, or empty pages of work', async () => {
  const rows = [
    { id: 'one', status: 'COMPLETED' },
    { id: 'two', status: 'ARCHIVED' },
    { id: 'shell', status: 'PENDING', property_hashes: [] },
  ];
  const calls = [];
  const routes = await fetchAllSavedRoutePages((limit, skip) => {
    calls.push({ limit, skip });
    return rows.slice(skip, skip + limit);
  }, { pageSize: 2, maxPages: 3 });

  assert.deepEqual(routes, rows);
  assert.deepEqual(calls, [{ limit: 2, skip: 0 }, { limit: 2, skip: 2 }]);
});

test('active route choice prefers work-ready statuses but honors an explicit past-route selection', () => {
  const routes = [
    { id: 'completed-newest', status: 'COMPLETED' },
    { id: 'pending', status: 'PENDING' },
    { id: 'active', status: 'ACTIVE' },
    { id: 'progress', status: 'IN_PROGRESS' },
  ];

  assert.equal(selectKnockRoute(routes).id, 'progress');
  assert.equal(selectKnockRoute(routes.filter((route) => route.id !== 'progress')).id, 'active');
  assert.equal(selectKnockRoute(routes.filter((route) => !['progress', 'active'].includes(route.id))).id, 'pending');
  assert.equal(selectKnockRoute(routes, 'completed-newest').id, 'completed-newest');
  assert.equal(selectKnockRoute([{ id: 'archived', status: 'ARCHIVED' }]).id, 'archived');
});

test('offline cache keys are account/viewer specific', () => {
  const manager = buildRepRouteScope({ id: 'manager-1', email: 'm@example.com', app_role: 'manager' });
  const rep = buildRepRouteScope({
    id: 'user-1',
    email: 'rep@example.com',
    app_role: 'rep',
    team_manager_id: 'manager-1',
  });

  assert.equal(getKnockRouteCacheKey(manager), 'cached_routes_manager-1_manager-1_manager');
  assert.equal(getKnockRouteCacheKey(rep), 'cached_routes_manager-1_user-1_rep');
  assert.notEqual(getKnockRouteCacheKey(manager), getKnockRouteCacheKey(rep));
});

test('Knock UI uses the complete scoped collection and compact accessible Home Base controls', () => {
  const repHome = readSource('src/pages/RepHome.jsx');
  const header = readSource('src/components/rep/RepHeader.jsx');

  assert.match(repHome, /collectKnockRoutes\(routeGroups, routeScope\)/);
  assert.doesNotMatch(repHome, /\['completed', 'archived'\].*filter/i);
  assert.match(repHome, /await localforage\.setItem\(routeCacheKey, accountRoutes\)/);
  assert.match(repHome, /if \(teamMembersLoading \|\| routesLoading/);
  assert.match(repHome, /aria-expanded=\{homeBasePanelOpen\}/);
  assert.match(repHome, /aria-controls="rep-home-base-controls"/);
  assert.match(repHome, /role="region" aria-labelledby="rep-home-base-toggle"/);
  assert.match(repHome, /\['COMPLETED', 'ARCHIVED'\]/);
  assert.match(header, /\{routes\.length\} route/);
  assert.match(header, /aria-controls="rep-route-switcher"/);
});

test('route completion is optimistic, advances selection, and keeps only archived routes read-only', () => {
  const repHome = readSource('src/pages/RepHome.jsx');

  assert.match(repHome, /mutationFn: \(routeId\) => base44\.entities\.SavedRoute\.update\(routeId/);
  assert.match(repHome, /onMutate: async \(routeId\)/);
  assert.match(repHome, /route\.id === routeId \? \{ \.\.\.route, status: 'COMPLETED' \} : route/);
  assert.match(repHome, /setManualRouteId\(null\)/);
  assert.match(repHome, /localStorage\.removeItem\('fk_selectedKnockRouteId'\)/);
  assert.match(repHome, /nextUrl\.searchParams\.delete\('route'\)/);
  assert.match(repHome, /onSuccess: async \(\) => \{\s*try \{\s*const completedRoutes = queryClient\.getQueryData\(myRoutesQueryKey\)/);
  assert.match(repHome, /await localforage\.setItem\(routeCacheKey, completedRoutes\)/);
  assert.match(repHome, /stats\.percent >= 100 && activeRouteCanComplete/);
  assert.match(repHome, /completeRouteMutation\.mutate\(activeRoute\.id\)/);
  assert.match(repHome, /const activeRouteCanComplete = !activeRouteArchived && !activeRouteCompleted/);
  assert.match(repHome, /const outcomeLoggingDisabled = activeRouteArchived/);
  assert.match(repHome, /navigationDisabled=\{activeRouteArchived \|\|/);
  assert.match(repHome, /selectable=\{filterStatus === 'done' && !activeRouteArchived\}/);
  assert.match(repHome, /disabled=\{activeRouteArchived \|\| !activeRouteBelongsToCurrentUser/);
  assert.match(repHome, /onClearDecision=\{activeRouteArchived \? undefined : handleClearDecision\}/);
  assert.match(repHome, /if \(activeRouteArchived\) \{\s*toast\.error\('Archived routes are read-only\.'/);
  assert.match(repHome, />Active and past routes</);
});

test('identity failures preserve scoped cached routes and never become a successful empty lookup', () => {
  const repHome = readSource('src/pages/RepHome.jsx');

  assert.match(repHome, /console\.error\("Error fetching team member profile", e\);\s*throw e;/);
  assert.match(repHome, /retry: 2/);
  assert.match(repHome, /teamMemberLookupFailed && !routeScope\.managerAccount/);

  const fallbackStart = repHome.indexOf('if (teamMemberLookupFailed && !routeScope.managerAccount)');
  const normalFetchStart = repHome.indexOf('const fetchRouteGroup', fallbackStart);
  assert.ok(fallbackStart >= 0 && normalFetchStart > fallbackStart);
  const fallbackBlock = repHome.slice(fallbackStart, normalFetchStart);
  assert.match(fallbackBlock, /localforage\.getItem\(routeCacheKey\)/);
  assert.match(fallbackBlock, /return Array\.isArray\(cached\) \? cached : \[\]/);
  assert.doesNotMatch(fallbackBlock, /localforage\.setItem/);
});

test('route switcher traps keyboard focus, restores its trigger, and clears the iOS home indicator', () => {
  const repHome = readSource('src/pages/RepHome.jsx');

  assert.match(repHome, /routeSwitcherReturnFocusRef\.current = event\?\.currentTarget \|\| document\.activeElement/);
  assert.match(repHome, /event\.key === 'Escape'/);
  assert.match(repHome, /event\.key !== 'Tab'/);
  assert.match(repHome, /dialog\.querySelectorAll/);
  assert.match(repHome, /lastElement\.focus\(\)/);
  assert.match(repHome, /firstElement\.focus\(\)/);
  assert.match(repHome, /routeSwitcherCloseButtonRef\.current\?\.focus\(\)/);
  assert.match(repHome, /returnFocusTarget\.focus\(\)/);
  assert.match(repHome, /onKeyDown=\{handleRouteSwitcherKeyDown\}/);
  assert.match(repHome, /pb-\[calc\(1rem\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(repHome, /aria-label="Close route switcher"[^>]*className="[^"]*h-10 w-10/);

  const header = readSource('src/components/rep/RepHeader.jsx');
  assert.match(header, /className="flex min-h-10 shrink-0/);
});

test('identity outages are not presented as an empty assignment list', () => {
  const repHome = readSource('src/pages/RepHome.jsx');

  assert.match(repHome, /const routeIdentityUnavailable = teamMemberLookupFailed && !routeScope\.managerAccount/);
  assert.match(repHome, /Routes Temporarily Unavailable/);
  assert.match(repHome, /Your saved route cache was preserved/);
  assert.match(repHome, /queryKey: \['myTeamMember'\]/);
  assert.match(repHome, /routeIdentityUnavailable \? 'Try Again' : 'Check Again'/);
});
