import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { QueryClient } from '@tanstack/react-query';
import { shouldRetryRead, withReadDeadline } from '../src/lib/readRequest.js';
import * as hydration from '../src/components/logic/routeHydrationCore.js';
import * as collection from '../src/components/rep/repRouteCollection.js';
import { createRouteHydrationRuntime } from './helpers/routeHydrationRuntime.mjs';

// Execute the actual page query functions so swallowing a failure in JSX
// cannot leave the reusable retry helper green while the rep remains stuck.
const source = readFileSync(new URL('../src/pages/RepHome.jsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('RepHome.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
const descriptors = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(ast) === 'useQuery') {
    for (const name of ['routesLoading', 'propsLoading']) {
      if (node.name.getText(ast).includes(name)) descriptors[name] = node.initializer.getText(ast);
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const user = { id: 'rep-1', email: 'rep@example.com', app_role: 'rep', team_manager_id: 'manager-1' };
const route = { id: 'route-1', assigned_to: 'rep-1', manager_id: 'manager-1', property_hashes: ['house-1'] };
const property = { address_hash: 'house-1', full_address: '317 Main St', lat: 33.4, lng: -112.1 };
function query(name, extra) {
  const sandbox = {
    useQuery: config => config, user, activeRoute: route, activeRouteOrderKey: 'house-1',
    myRoutesQueryKey: ['myRoutes', user.id], routeScope: collection.buildRepRouteScope(user), routeCacheKey: 'rep-route-cache',
    teamMembersLoading: false, teamMemberLookupFailed: false, routeIdentityLoading: false, routeIdentityError: false,
    ROUTE_RECOVERY_POLL_MS: 65_000,
    localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    localStorage: { getItem: () => null }, console: { log() {}, warn() {}, error() {} },
    ...hydration, ...collection, withReadDeadline,
    ...createRouteHydrationRuntime(extra.base44), ...extra,
  };
  vm.runInNewContext('globalThis.query = ' + descriptors[name], sandbox);
  return sandbox.query;
}

test('a failed route-list read without an offline snapshot retries and loads the assigned route', async () => {
  let calls = 0;
  const descriptor = query('routesLoading', { base44: { entities: { SavedRoute: { filter: async () => {
    if (++calls === 1) throw Object.assign(new Error('Busy'), { status: 503 });
    return [route];
  } } } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryRead, retryDelay: 0 } } });
  try {
    const result = await client.fetchQuery(descriptor);
    assert.equal(result[0].id, 'route-1');
    assert.equal(calls, 2);
  } finally { client.clear(); }
});

test('missing route properties are retried rather than cached as a successful empty load', async () => {
  let calls = 0;
  const descriptor = query('propsLoading', { base44: { functions: { invoke: async () => {
    calls++;
    return { data: { properties: calls <= 2 ? [] : [property] } };
  } } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryRead, retryDelay: 0 } } });
  try {
    const result = await client.fetchQuery(descriptor);
    assert.equal(result[0].full_address, '317 Main St');
    assert.equal(calls, 3);
  } finally { client.clear(); }
});

test('complete offline properties remain usable during an outage but a partial cache does not masquerade as success', async () => {
  for (const cached of [[property], []]) {
    const descriptor = query('propsLoading', {
      base44: { functions: { invoke: async () => { throw new Error('Offline'); } } },
      localforage: { getItem: async () => cached, setItem: async () => {}, removeItem: async () => {} },
    });
    if (cached.length) assert.equal((await descriptor.queryFn())[0].address_hash, 'house-1');
    else await assert.rejects(descriptor.queryFn(), /could not be loaded/);
  }
});
