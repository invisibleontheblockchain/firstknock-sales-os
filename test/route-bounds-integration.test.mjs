import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

import { calculateRouteDistanceMiles } from '../src/lib/routeBounds.js';
import { geocodeAddress } from '../src/lib/geocoding.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

function loadBackendHandler(path, base44) {
  const transpiled = ts.transpileModule(readSource(path), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript syntax errors`);

  let handler;
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    Deno: { serve: (registeredHandler) => { handler = registeredHandler; } },
    Request,
    Response,
  }, { filename: path });
  assert.equal(typeof handler, 'function');
  return handler;
}

test('large-route backend applies the same fixed start and finish to every route chunk', async () => {
  const handler = loadBackendHandler('base44/functions/generateRoutesBackend/entry.ts', {
    auth: { me: async () => ({ id: 'user_1' }) },
  });
  const home = { lat: 34, lng: -82, address: 'Home Base' };
  const properties = [
    { id: 'a', address_hash: 'a', lat: 34.002, lng: -81.998 },
    { id: 'b', address_hash: 'b', lat: 34.004, lng: -81.994 },
    { id: 'c', address_hash: 'c', lat: 34.006, lng: -81.99 },
    { id: 'd', address_hash: 'd', lat: 34.008, lng: -81.986 },
  ];

  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      properties,
      houses_per_route: 2,
      start_location: home,
      end_location: home,
      route_origin_mode: 'home_round_trip',
    }),
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.routes.length, 2);
  for (const route of result.routes) {
    assert.equal(route.routeOriginMode, 'home_round_trip');
    assert.deepEqual(route.startLocation, home);
    assert.deepEqual(route.endLocation, home);
    assert.equal(route.properties.length, 2);
    const expectedDistance = Math.round(calculateRouteDistanceMiles(route.properties, {
      startLocation: home,
      endLocation: home,
    }) * 100) / 100;
    assert.equal(route.totalDistance, expectedDistance);
  }
});

test('backend ignores an incomplete or non-opted-in fixed endpoint request', async () => {
  const handler = loadBackendHandler('base44/functions/generateRoutesBackend/entry.ts', {
    auth: { me: async () => ({ id: 'user_1' }) },
  });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      properties: [
        { id: 'a', address_hash: 'a', lat: 34.002, lng: -81.998 },
        { id: 'b', address_hash: 'b', lat: 34.004, lng: -81.994 },
      ],
      houses_per_route: 2,
      end_location: { lat: 34, lng: -82 },
      route_origin_mode: 'home_round_trip',
    }),
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0].routeOriginMode, undefined);
  assert.equal(result.routes[0].endLocation, undefined);
});

test('manager Home Base lookup returns only a rounded point for a verified assigned rep', async () => {
  const handler = loadBackendHandler('base44/functions/getRouteHomeBase/entry.ts', {
    auth: { me: async () => ({ id: 'manager_1', email: 'manager@example.com', app_role: 'manager' }) },
    asServiceRole: {
      entities: {
        SavedRoute: { get: async () => ({ id: 'route_1', manager_id: 'manager_1', assigned_to: 'member_1' }) },
        TeamMember: {
          get: async () => ({ id: 'member_1', manager_id: 'manager_1', user_id: 'rep_1', email: 'rep@example.com' }),
          filter: async () => [],
        },
        User: {
          get: async () => ({
            id: 'rep_1',
            email: 'rep@example.com',
            team_manager_id: 'manager_1',
            home_base: { lat: 33.448376, lng: -112.074036, address: '123 Private St' },
          }),
        },
      },
    },
  });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ route_id: 'route_1' }),
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(result.home_base, { lat: 33.448, lng: -112.074, address: 'Private home base' });
  assert.equal(JSON.stringify(result).includes('123 Private St'), false);
});

test('manager Home Base lookup rejects an unverified roster-to-user link', async () => {
  const handler = loadBackendHandler('base44/functions/getRouteHomeBase/entry.ts', {
    auth: { me: async () => ({ id: 'attacker_manager', email: 'attacker@example.com', app_role: 'manager' }) },
    asServiceRole: {
      entities: {
        SavedRoute: { get: async () => ({ id: 'route_1', manager_id: 'attacker_manager', assigned_to: 'fake_member' }) },
        TeamMember: {
          get: async () => ({ id: 'fake_member', manager_id: 'attacker_manager', user_id: 'victim_1', email: 'victim@example.com' }),
          filter: async () => [],
        },
        User: {
          get: async () => ({
            id: 'victim_1',
            email: 'victim@example.com',
            team_manager_id: 'real_manager',
            home_base: { lat: 40.7128, lng: -74.006, address: 'Victim home' },
          }),
        },
      },
    },
  });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ route_id: 'route_1' }),
  }));

  assert.equal(response.status, 403);
  assert.equal(JSON.stringify(await response.json()).includes('Victim home'), false);
});

test('address lookup returns reusable coordinates without a live network request', async () => {
  let requestedUrl = '';
  const location = await geocodeAddress('123 Main St, Phoenix, AZ', {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => [{ lat: '33.4484', lon: '-112.0740', display_name: '123 Main St, Phoenix, AZ' }],
      };
    },
  });

  assert.equal(new URL(requestedUrl).searchParams.get('q'), '123 Main St, Phoenix, AZ');
  assert.deepEqual(location, { address: '123 Main St, Phoenix, AZ', lat: 33.4484, lng: -112.074 });
});

test('Precision route bounds are explicit, off by default, and wired through persistence', () => {
  const panel = readSource('src/components/map/PrecisionPullPanel.jsx');
  const territory = readSource('src/components/map/TerritoryPrompt.jsx');
  const home = readSource('src/pages/Home.jsx');
  const optimizer = readSource('src/components/logic/routeOptimizer.jsx');
  const savedRouteSchema = JSON.parse(readSource('base44/entities/SavedRoute.jsonc'));
  const userSchema = JSON.parse(readSource('base44/entities/User.jsonc'));
  const teamMemberSchema = JSON.parse(readSource('base44/entities/TeamMember.jsonc'));

  assert.match(panel, /useState\(false\).*routeFromHomeEnabled|routeFromHomeEnabled, setRouteFromHomeEnabled\] = useState\(false\)/s);
  assert.match(panel, /Route from home and back/);
  assert.match(panel, /onGenerate\?\.\(\{ enabled: false \}\)/);
  assert.match(panel, /mode: startPointMode === 'current' \? 'current_to_home' : 'home_round_trip'/);
  assert.match(panel, /startLocation: \{ lat: startLocation\.lat, lng: startLocation\.lng \}/);
  assert.match(panel, /endLocation: \{ lat: savedHome\.lat, lng: savedHome\.lng \}/);
  assert.doesNotMatch(panel, /homeBase: savedHome/);
  assert.match(territory, /route_bounds: routeBounds/);
  assert.match(territory, /onRouteBoundsPrepared/);
  assert.match(territory, /base44\.functions\.invoke\('resolveActivePrecisionJobs', \{\}\)/);
  assert.match(territory, /resolution\.state === 'multiple'/);
  assert.doesNotMatch(territory, /fk_activePrecisionJob_/);
  assert.doesNotMatch(home, /fk_precisionRouteBoundsContext/);
  assert.match(home, /endLocation: end/);
  assert.match(home, /routeOriginMode/);
  assert.match(optimizer, /optimizeRouteWithBounds/);
  assert.ok(savedRouteSchema.properties.end_location);
  assert.ok(savedRouteSchema.properties.route_origin_mode);
  assert.ok(userSchema.properties.home_base);
  assert.equal(teamMemberSchema.properties.home_base, undefined);
  assert.match(home, /getRouteHomeBase/);
  assert.match(home, /start_location: savedBoundStart/);
  assert.match(home, /precisionAreaMetadata\.precision_area\?\.job_id/);
  assert.match(home, /Skipping duplicate recovered route/);
  assert.match(readSource('src/pages/RepHome.jsx'), /start_location: null[\s\S]*end_location: null/);
});

test('MERGE ALL preserves route bounds only for identical bounds and assignee', () => {
  const routeCommandPanel = readSource('src/components/routes/RouteCommandPanel.jsx');

  assert.match(routeCommandPanel, /const sameAssignee = baseRoutes\.every/);
  assert.match(routeCommandPanel, /const sharedRouteBounds = sameAssignee && firstOriginMode !== 'none'/);
  assert.match(routeCommandPanel, /endLocation: mergeEnd/);
  assert.match(routeCommandPanel, /routeOriginMode: sharedRouteBounds \? firstOriginMode : 'none'/);
  assert.match(routeCommandPanel, /assigned_to: sameAssignee \? firstRoute\?\.assigned_to \|\| null : null/);
});
