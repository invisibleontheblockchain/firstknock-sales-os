import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const releaseSource = readFileSync(new URL('../src/lib/pwaRelease.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function browser() {
  const navigations = [];
  const workerListeners = new Map();
  const cache = { keys: async () => ['old-assets'], delete: async () => true };
  const registration = { update: async () => {}, addEventListener() {} };
  const context = {
    URL, AbortController, setTimeout, clearTimeout, Promise,
    console: { warn() {} },
    window: {
      location: { hostname: 'firstknock.online', origin: 'https://firstknock.online',
        href: 'https://firstknock.online/RepHome?route=r1#house-1010',
        replace: url => navigations.push(url), reload: () => navigations.push('reload') },
      caches: cache, addEventListener() {},
    },
    document: { visibilityState: 'visible', querySelector: () => null, addEventListener() {} },
    navigator: { onLine: true, serviceWorker: { controller: {},
      register: async () => registration, getRegistration: async () => registration,
      addEventListener: (event, listener) => workerListeners.set(event, listener) } },
    caches: cache,
    // Model storage that accepts writes but cannot retain a release marker.
    localStorage: { getItem: () => null, setItem() {} },
  };
  return { context, navigations, workerListeners };
}

function releaseModule(context) {
  vm.runInNewContext(releaseSource.replaceAll('import.meta.env.DEV', 'false').replace(/^export /gm, '')
    + '\nglobalThis.api = { checkForPublishedRelease, refreshToPublishedRelease };', context);
  return context.api;
}

test('startup cache cleanup does not repeatedly navigate when storage loses its release marker', async () => {
  const { context, navigations } = browser();
  for (let launch = 0; launch < 3; launch++) {
    vm.runInNewContext(inline, { ...context });
    await flush();
  }
  assert.deepEqual(navigations, []);
});

test('service worker adoption never forces a second page load', async () => {
  const { context, navigations, workerListeners } = browser();
  vm.runInNewContext(inline, context);
  await flush();
  workerListeners.get('controllerchange')?.();
  assert.deepEqual(navigations, []);
});

test('a different published release is offered without clearing caches or reloading the current route', async () => {
  const { context, navigations } = browser();
  let requests = 0;
  let now = 1000;
  context.Date = { now: () => now };
  context.caches.delete = async () => assert.fail('checking a release must not delete cached assets');
  context.fetch = async () => { requests++; return { ok: true, text: async () => "const FK_PWA_RELEASE = 'new-release';" }; };
  const api = releaseModule(context);
  assert.equal(await api.checkForPublishedRelease('old-release'), 'new-release');
  assert.equal(await api.checkForPublishedRelease('old-release'), null);
  assert.equal(requests, 1);
  now += 61_000;
  assert.equal(await api.checkForPublishedRelease('old-release'), 'new-release');
  assert.deepEqual(navigations, []);
});

test('an explicit refresh preserves the selected route and house while selecting the new release', () => {
  const { context, navigations } = browser();
  const api = releaseModule(context);
  api.refreshToPublishedRelease('new-release');
  assert.equal(navigations.length, 1);
  const url = new URL(navigations[0]);
  assert.equal(url.pathname, '/RepHome');
  assert.equal(url.searchParams.get('route'), 'r1');
  assert.equal(url.searchParams.get('fk_release'), 'new-release');
  assert.equal(url.hash, '#house-1010');
});

test('a stalled release check aborts without restarting the app', async () => {
  const { context, navigations } = browser();
  let aborted = false;
  context.setTimeout = callback => setTimeout(callback, 5);
  context.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  });
  const api = releaseModule(context);
  assert.equal(await api.checkForPublishedRelease('old-release'), false);
  assert.equal(aborted, true);
  assert.deepEqual(navigations, []);
});

test('foreground events offer one update prompt and refresh only when its action is clicked', async () => {
  const { context, navigations } = browser();
  const prompts = [];
  const invalidations = [];
  const events = new Map();
  let cleanup;
  context.fetch = async () => ({ ok: true, text: async () => "const FK_PWA_RELEASE = 'new-release';" });
  const api = releaseModule(context);
  context.window.__FK_PWA_RELEASE__ = 'old-release';
  context.window.addEventListener = (event, callback) => events.set(event, callback);
  context.window.removeEventListener = event => events.delete(event);
  context.document.addEventListener = (event, callback) => events.set(event, callback);
  context.document.removeEventListener = event => events.delete(event);
  context.React = { useEffect: callback => { cleanup = callback(); } };
  context.useQueryClient = () => ({ invalidateQueries: value => invalidations.push(value.queryKey[0]) });
  context.toast = (_message, options) => prompts.push(options);
  Object.assign(context, api);
  const manager = readFileSync(new URL('../src/components/AppRefreshManager.jsx', import.meta.url), 'utf8');
  vm.runInNewContext(manager.replace(/^import .*;$/gm, '').replace('export default ', '') + '\nAppRefreshManager();', context);
  await flush();
  events.get('pageshow')();
  events.get('visibilitychange')();
  await flush();
  assert.equal(prompts.length, 1);
  assert.deepEqual(invalidations, ['user', 'precisionUsage']);
  assert.deepEqual(navigations, []);
  prompts[0].action.onClick();
  assert.equal(navigations.length, 1);
  cleanup();
});
