import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getInstalledAppDestination } from '../src/lib/installedAppLaunch.js';

function browserWindow({ standalone, mode, userAgent = '' } = {}) {
  return {
    navigator: { standalone, userAgent },
    matchMedia: (query) => ({ matches: query === `(display-mode: ${mode})` }),
  };
}

for (const [label, userAgent] of [
  ['desktop browser', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'],
  ['Android browser', 'Mozilla/5.0 (Linux; Android 15) Mobile'],
  ['iPhone browser', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'],
  ['iPad browser', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'],
]) {
  test(`${label} keeps the public landing page`, () => {
    assert.equal(getInstalledAppDestination({ browserWindow: browserWindow({ userAgent }) }), null);
  });
}

for (const mode of ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']) {
  test(`installed ${mode} display launches directly into the app`, () => {
    assert.equal(getInstalledAppDestination({ browserWindow: browserWindow({ mode }) }), '/RoleSelect');
  });
}

test('iOS and iPadOS home-screen launch uses the standalone flag even without matchMedia', () => {
  assert.equal(getInstalledAppDestination({ browserWindow: { navigator: { standalone: true } } }), '/RoleSelect');
  assert.equal(getInstalledAppDestination({ browserWindow: { navigator: { standalone: false } } }), null);
});

test('native Capacitor apps launch into the app without browser installation signals', () => {
  assert.equal(getInstalledAppDestination({ isNative: true, browserWindow: browserWindow() }), '/RoleSelect');
});

test('installed app redirect preserves referral parameters and the URL fragment', () => {
  assert.equal(getInstalledAppDestination({
    browserWindow: browserWindow({ mode: 'standalone' }),
    search: '?ref=TEAM42&utm_source=home-screen',
    hash: '#welcome',
  }), '/RoleSelect?ref=TEAM42&utm_source=home-screen#welcome');
});

test('missing installation APIs default to the public browser experience', () => {
  assert.equal(getInstalledAppDestination({ browserWindow: {} }), null);
  assert.equal(getInstalledAppDestination(), null);
});

test('new PWA installs start in the app and keep the existing install identity', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, '/RoleSelect');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
});
