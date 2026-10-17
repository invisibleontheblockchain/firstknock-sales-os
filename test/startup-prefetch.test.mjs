import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { pageNameForPath, preloadPage, registerPageLoaders } from '../src/lib/pagePreload.js';
import { mapTerritoryBootstrapOptions, mapTerritoryQueryKey, MAP_BOOTSTRAP_LIMIT } from '../src/components/map/mapTerritoryLoading.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('page preloading resolves routes case-insensitively and requests each page once', async () => {
  const calls = [];
  registerPageLoaders({ Home: async () => calls.push('Home'), RepHome: async () => calls.push('RepHome') });
  assert.equal(pageNameForPath('/home'), 'Home');
  assert.equal(pageNameForPath('/RepHome/extra'), 'RepHome');
  assert.equal(pageNameForPath('/'), null);
  assert.equal(pageNameForPath('/Unknown'), null);
  preloadPage('Home');
  preloadPage('Home');
  preloadPage(null);
  await flush();
  assert.deepEqual(calls, ['Home']);
});

test('a failed page preload can be requested again', async () => {
  let attempts = 0;
  registerPageLoaders({ List: async () => { attempts += 1; if (attempts === 1) throw new Error('offline'); } });
  preloadPage('List');
  await flush(); await flush();
  preloadPage('List');
  await flush();
  assert.equal(attempts, 2);
});

test('the startup territory prefetch and the map share one request', async () => {
  const user = { email: 'manager@example.com', territory_zip_codes: ['85001'] };
  let requests = 0;
  const invoke = async (name, body) => {
    requests += 1;
    assert.equal(name, 'getRouteCandidatesFromNeon');
    assert.equal(body.limit, MAP_BOOTSTRAP_LIMIT);
    return { data: { properties: [{ id: '1' }] } };
  };
  const passthrough = (readRows) => readRows();
  const client = new QueryClient();
  const options = mapTerritoryBootstrapOptions(user, invoke, passthrough);
  assert.deepEqual(options.queryKey, mapTerritoryQueryKey(user, 'bootstrap'));
  const prefetch = client.prefetchQuery(options);
  // The map mounts while the prefetch is still in flight.
  const mapRead = await client.fetchQuery(mapTerritoryBootstrapOptions(user, invoke, passthrough));
  await prefetch;
  client.clear(); // drop the 30-minute cache timers so the test process exits
  assert.equal(requests, 1);
  assert.deepEqual(mapRead.properties, [{ id: '1' }]);
});

test('sign-in starts the account read with public settings and prefetches the landing page', () => {
  const auth = read('src/lib/AuthContext.jsx');
  const app = read('src/App.jsx');
  const prefetch = read('src/lib/startupPrefetch.js');
  const hook = read('src/components/map/useViewportMapProperties.jsx');
  const home = read('src/pages/Home.jsx');
  assert.match(auth, /const accountRequest = appParams\.token \? readCurrentUser\(\) : null;[\s\S]*public-settings[\s\S]*checkUserAuth\(accountRequest\)/);
  assert.match(auth, /setQueryData\(\['user'\], currentUser\);\s*startLandingPrefetch\(queryClientInstance, currentUser\)/);
  assert.match(app, /appParams\.token && !isHqPath[\s\S]*preloadPage\(pageNameForPath\(window\.location\.pathname\)\)/);
  assert.match(hook, /mapTerritoryBootstrapOptions\(user, \(\.\.\.args\) => base44\.functions\.invoke\(\.\.\.args\), withReadDeadline\)/);
  // Prefetched outcomes must use Home's exact key and account read.
  assert.match(home, /queryKey: \['interactionLogs', user\?\.email\][\s\S]*?fetchAccountInteractionLogs\(user\)/);
  assert.match(prefetch, /queryKey: \['interactionLogs', user\.email\][\s\S]*?fetchAccountInteractionLogs\(user\)/);
  assert.match(prefetch, /page !== 'Home' \|\| !isManagerAccount\(user\)/);
});
