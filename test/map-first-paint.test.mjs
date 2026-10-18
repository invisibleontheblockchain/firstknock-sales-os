import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BASEMAP_URLS, basemapTileUrlsForView, LABEL_URL, tileCoordsForView, tileUrl } from '../src/components/map/basemapUrls.js';
import { mapTileWarmupUrls, MAX_WARM_TILES, preconnectMapHosts, warmMapTiles } from '../src/lib/mapTileWarmup.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const user = { id: 'u1', email: 'manager@example.com' };
const VIEW = { center: [34.905, -82.27], zoom: 15.5 };

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)) };
}

test('warm-up tiles are the exact grid Leaflet requested for the saved view', () => {
  // Recorded from a real map open at 390x844: tile zoom 16, x 17790-17792, y 25977-25982.
  const coords = tileCoordsForView(VIEW, { width: 390, height: 844 });
  assert.equal(coords.length, 18);
  assert.ok(coords.every((c) => c.z === 16));
  assert.deepEqual([...new Set(coords.map((c) => c.x))].sort(), [17790, 17791, 17792]);
  assert.deepEqual([...new Set(coords.map((c) => c.y))].sort(), [25977, 25978, 25979, 25980, 25981, 25982]);
  // Centre first, as Leaflet queues them.
  assert.deepEqual([coords[0].x, coords[0].y], [17791, 25979]);
});

test('tile URLs follow each provider template exactly', () => {
  assert.equal(tileUrl(BASEMAP_URLS.hybrid, { x: 17791, y: 25979, z: 16 }),
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/16/25979/17791');
  // Leaflet's default subdomains are a/b/c, chosen by |x + y| % 3; {r} is @2x on retina screens.
  assert.equal(tileUrl(LABEL_URL, { x: 17791, y: 25979, z: 16 }, { retina: true }),
    'https://a.basemaps.cartocdn.com/light_only_labels/16/17791/25979@2x.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f');
  assert.ok(tileUrl(LABEL_URL, { x: 17792, y: 25979, z: 16 }).startsWith('https://b.'));
  const urls = basemapTileUrlsForView(VIEW, { width: 390, height: 844 }, { mapTheme: 'hybrid', retina: true });
  assert.equal(urls.length, 36, 'imagery and labels');
  assert.ok(urls.slice(0, 18).every((url) => url.includes('World_Imagery')), 'imagery before labels');
  assert.equal(basemapTileUrlsForView(VIEW, { width: 390, height: 844 }, { mapTheme: 'dark' }).length, 18, 'no labels layer on dark');
});

test('the warm-up reads the saved view and theme, and skips Canvas or a missing view', () => {
  const win = { innerWidth: 390, innerHeight: 844, devicePixelRatio: 3 };
  const view = JSON.stringify({ lat: VIEW.center[0], lng: VIEW.center[1], zoom: VIEW.zoom });
  const withView = (extra = {}) => memoryStorage({ fk_map_view_v2_u1: view, ...extra });
  globalThis.localStorage = withView();
  try {
    const urls = mapTileWarmupUrls(user, { win, storage: globalThis.localStorage });
    assert.equal(urls.length, 36, 'the whole first view of imagery and labels');
    assert.equal(mapTileWarmupUrls(user, { win: { ...win, innerWidth: 1280, innerHeight: 900 }, storage: globalThis.localStorage }).length, MAX_WARM_TILES, 'capped on large screens');
    assert.ok(urls[0].includes('World_Imagery/MapServer/tile/16/25979/17791'));
    assert.deepEqual(mapTileWarmupUrls(user, { win, storage: withView({ fk_routeMode: 'canvas' }) }), []);
    assert.equal(mapTileWarmupUrls(user, { win, storage: withView({ fk_mapTheme_v3: 'dark' }) })[0].includes('dark_all'), true);
    globalThis.localStorage = memoryStorage();
    assert.deepEqual(mapTileWarmupUrls(user, { win, storage: globalThis.localStorage }), []);

    globalThis.localStorage = withView();
    const started = [];
    function Image() { started.push(this); }
    const timers = [];
    const requested = warmMapTiles(user, { win: { ...win, Image, setTimeout: (fn, ms) => timers.push(ms) }, storage: globalThis.localStorage });
    assert.equal(started.length, requested.length);
    assert.deepEqual(started.map((image) => image.src), requested);
    assert.deepEqual(timers, [30_000]);
  } finally {
    delete globalThis.localStorage;
  }
});

test('tile hosts are preconnected only for pages that open on the map', () => {
  const appended = [];
  const doc = {
    head: { querySelector: (selector) => appended.find((link) => selector.includes(link.href)) || null, appendChild: (link) => appended.push(link) },
    createElement: () => ({}),
  };
  assert.equal(preconnectMapHosts('List', doc), 0);
  assert.equal(preconnectMapHosts('Home', doc), 4);
  assert.equal(preconnectMapHosts('RoleSelect', doc), 0, 'never duplicated');
  assert.deepEqual(appended.map((link) => [link.rel, link.href]), [
    ['preconnect', 'https://server.arcgisonline.com'],
    ['preconnect', 'https://a.basemaps.cartocdn.com'],
    ['preconnect', 'https://b.basemaps.cartocdn.com'],
    ['preconnect', 'https://c.basemaps.cartocdn.com'],
  ]);
});

test('the map shows a loading skeleton, not a flat panel, until imagery paints; labels follow imagery', () => {
  const tiles = read('src/components/map/BaseMapTiles.jsx');
  assert.match(tiles, /import \{ BASEMAP_URLS, LABEL_URL, basemapTileOptions, precisionThemeFor, showsLabelsFor \} from '@\/components\/map\/basemapUrls'/);
  assert.match(tiles, /<MapBackdrop mapTheme=\{mapTheme\} waiting=\{!firstTileShown\} \/>/);
  assert.match(tiles, /tileload: \(\) => setFirstTileShown\(true\)/);
  assert.match(tiles, /\{showLabels && firstTileShown && \(/);
  assert.match(tiles, /container\.style\.backgroundColor = /);
  const css = read('src/index.css');
  assert.match(css, /\.leaflet-container\.fk-map-skeleton \{[\s\S]*?!important;/);
  assert.match(css, /content: 'Loading map…';/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(read('src/lib/startupPrefetch.js'), /if \(page !== 'Home' \|\| !isManagerAccount\(user\)\) return;\s*\/\/[^\n]*\n\s*warmMapTiles\(user\);/);
});
