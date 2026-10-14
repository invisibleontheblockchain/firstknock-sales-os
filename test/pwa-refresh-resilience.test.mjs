import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

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

function refreshManager(context) {
  const invalidations = [];
  const events = new Map();
  const intervals = new Map();
  const states = [];
  let hookIndex = 0;
  let started = false;
  let cleanup;
  context.window.__FK_PWA_RELEASE__ = 'old-release';
  context.window.addEventListener = (event, callback) => events.set(event, callback);
  context.window.removeEventListener = event => events.delete(event);
  context.document.addEventListener = (event, callback) => events.set(event, callback);
  context.document.removeEventListener = event => events.delete(event);
  context.window.setInterval = (callback, delay) => {
    const id = intervals.size + 1;
    intervals.set(id, { callback, delay });
    return id;
  };
  context.window.clearInterval = id => intervals.delete(id);
  context.React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => {
      const index = hookIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = value; }];
    },
    useEffect: callback => { if (!started) cleanup = callback(); },
  };
  context.useQueryClient = () => ({ invalidateQueries: value => invalidations.push(value.queryKey[0]) });
  context.toast = () => assert.fail('update adoption must not depend on routine toast visibility');
  Object.assign(context, releaseModule(context));
  const manager = readFileSync(new URL('../src/components/AppRefreshManager.jsx', import.meta.url), 'utf8');
  const code = transformSync(manager.replace(/^import .*;$/gm, '').replace('export default ', ''), { loader: 'jsx', jsx: 'transform' }).code;
  vm.runInNewContext(code, context);
  const render = () => {
    hookIndex = 0;
    const result = context.AppRefreshManager();
    started = true;
    return result;
  };
  render();
  return { render, events, intervals, invalidations, cleanup: () => cleanup() };
}

function refreshButton(banner) {
  return banner.children.find(child => child?.type === 'button');
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

test('foreground events keep a durable update banner and refresh only when its action is clicked', async () => {
  const { context, navigations } = browser();
  let requests = 0;
  context.fetch = async () => { requests++; return { ok: true, text: async () => "const FK_PWA_RELEASE = 'new-release';" }; };
  context.caches.delete = async () => assert.fail('update notice must preserve offline storage');
  const manager = refreshManager(context);
  await flush();
  manager.events.get('pageshow')();
  manager.events.get('visibilitychange')();
  manager.events.get('focus')();
  await flush();
  const banner = manager.render();
  assert.equal(banner.type, 'aside');
  assert.equal(banner.props.role, 'status');
  assert.equal(requests, 1);
  assert.deepEqual(manager.invalidations, ['user', 'precisionUsage']);
  assert.deepEqual(navigations, []);
  refreshButton(banner).props.onClick();
  assert.equal(navigations.length, 1);
  manager.cleanup();
  assert.equal(manager.events.size, 0);
  assert.equal(manager.intervals.size, 0);
});

test('open PWAs poll for releases every five minutes without refetching account data', async () => {
  const { context, navigations } = browser();
  let now = 1000;
  let requests = 0;
  let published = 'old-release';
  context.Date = { now: () => now };
  context.fetch = async () => { requests++; return { ok: true, text: async () => `const FK_PWA_RELEASE='${published}';` }; };
  const manager = refreshManager(context);
  await flush();
  assert.equal(manager.render(), null);
  assert.equal(manager.intervals.size, 1);
  const poll = manager.intervals.values().next().value;
  assert.equal(poll.delay, 300_000);
  published = 'new-release';
  now += poll.delay;
  poll.callback();
  await flush();
  assert.equal(manager.render().type, 'aside');
  assert.equal(requests, 2);
  assert.deepEqual(manager.invalidations, ['user', 'precisionUsage']);
  assert.deepEqual(navigations, []);
  context.document.visibilityState = 'hidden';
  now += poll.delay;
  poll.callback();
  await flush();
  assert.equal(requests, 2);
  context.document.visibilityState = 'visible';
  context.navigator.onLine = false;
  poll.callback();
  await flush();
  assert.equal(requests, 2);
  manager.cleanup();
});

test('foreground account recovery keeps user reads at thirty seconds and billing usage at two minutes', async () => {
  const { context } = browser();
  let now = 1000;
  context.Date = { now: () => now };
  context.fetch = async () => ({ ok: true, text: async () => "const FK_PWA_RELEASE = 'old-release';" });
  const manager = refreshManager(context);
  await flush();
  now += 30_000;
  manager.events.get('focus')();
  assert.deepEqual(manager.invalidations, ['user', 'precisionUsage', 'user']);
  now += 89_000;
  manager.events.get('pageshow')();
  assert.deepEqual(manager.invalidations, ['user', 'precisionUsage', 'user', 'user']);
  now += 1000;
  manager.events.get('visibilitychange')();
  assert.deepEqual(manager.invalidations, ['user', 'precisionUsage', 'user', 'user', 'precisionUsage']);
  manager.cleanup();
});

test('reconnection checks a recently published update immediately and blocks refresh while offline', async () => {
  const { context, navigations } = browser();
  let requests = 0;
  let published = 'old-release';
  context.Date = { now: () => 1000 };
  context.fetch = async () => { requests++; return { ok: true, text: async () => `const FK_PWA_RELEASE='${published}';` }; };
  const manager = refreshManager(context);
  await flush();
  context.navigator.onLine = false;
  manager.events.get('offline')();
  published = 'new-release';
  context.navigator.onLine = true;
  manager.events.get('online')();
  await flush();
  assert.equal(requests, 2);
  assert.equal(refreshButton(manager.render()).props.disabled, false);
  context.navigator.onLine = false;
  manager.events.get('offline')();
  const banner = manager.render();
  assert.equal(banner.type, 'aside');
  assert.equal(refreshButton(banner).props.disabled, true);
  // Guard the action itself too, in case connectivity changed before the UI.
  refreshButton(banner).props.onClick();
  assert.deepEqual(navigations, []);
  manager.cleanup();
});

test('an offline launch recovers through online without needing to relaunch the installed app', async () => {
  const { context, navigations } = browser();
  let requests = 0;
  context.navigator.onLine = false;
  context.fetch = async () => { requests++; return { ok: true, text: async () => "const FK_PWA_RELEASE = 'new-release';" }; };
  const manager = refreshManager(context);
  await flush();
  assert.equal(requests, 0);
  assert.equal(manager.render(), null);
  context.navigator.onLine = true;
  manager.events.get('online')();
  await flush();
  assert.equal(requests, 1);
  assert.equal(manager.render().type, 'aside');
  assert.deepEqual(navigations, []);
  manager.cleanup();
});

test('an update check finishing after unmount cannot show a banner', async () => {
  const { context } = browser();
  let finish;
  context.fetch = () => new Promise(resolve => { finish = resolve; });
  const manager = refreshManager(context);
  manager.cleanup();
  finish({ ok: true, text: async () => "const FK_PWA_RELEASE = 'new-release';" });
  await flush();
  assert.equal(manager.render(), null);
  assert.equal(manager.events.size, 0);
  assert.equal(manager.intervals.size, 0);
});

test('reconnection asks the service worker for updated assets without navigating', async () => {
  const { context, navigations } = browser();
  const events = new Map();
  let workerChecks = 0;
  context.window.addEventListener = (event, callback) => events.set(event, callback);
  context.navigator.serviceWorker.getRegistration = async () => ({ update: async () => { workerChecks++; } });
  vm.runInNewContext(inline, context);
  await flush();
  events.get('online')();
  await flush();
  assert.equal(workerChecks, 1);
  assert.deepEqual(navigations, []);
});

test('failed checks recover on reconnect while concurrent events share one request', async () => {
  const { context, navigations } = browser();
  let requests = 0;
  let finish;
  context.Date = { now: () => 1000 };
  context.fetch = async () => { requests++; return { ok: false }; };
  const api = releaseModule(context);
  assert.equal(await api.checkForPublishedRelease('old-release'), false);
  context.fetch = () => { requests++; return new Promise(resolve => { finish = resolve; }); };
  const reconnect = api.checkForPublishedRelease('old-release', { force: true });
  const foreground = api.checkForPublishedRelease('old-release');
  assert.equal(reconnect, foreground);
  finish({ ok: true, text: async () => "const FK_PWA_RELEASE = 'new-release';" });
  assert.equal(await reconnect, 'new-release');
  assert.equal(requests, 2);
  assert.deepEqual(navigations, []);
});

test('unchanged or unidentifiable releases never offer a refresh', async () => {
  const { context } = browser();
  context.fetch = async () => ({ ok: true, text: async () => "const FK_PWA_RELEASE = 'new-release';" });
  const api = releaseModule(context);
  assert.equal(await api.checkForPublishedRelease('new-release'), false);
  context.fetch = async () => ({ ok: true, text: async () => '<h1>Unavailable</h1>' });
  assert.equal(await api.checkForPublishedRelease('old-release', { force: true }), false);
});
