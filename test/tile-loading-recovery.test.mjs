import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTileLoadingRecovery } from '../src/components/map/tileLoadingRecovery.js';

function harness({ online = true, ...options } = {}) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const listeners = new Map();
  const statuses = [];
  const recovery = createTileLoadingRecovery({
    onStatus: status => statuses.push(status),
    isOnline: () => online,
    eventTarget: {
      addEventListener: (event, listener) => listeners.set(event, listener),
      removeEventListener: event => listeners.delete(event),
    },
    setTimer: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimer: id => timers.delete(id),
    random: () => 0,
    ...options,
  });
  recovery.start();
  return {
    recovery, timers, listeners, statuses,
    event: (name, tile) => recovery.handlers[name]({ tile }),
    network(value) { online = value; listeners.get(value ? 'online' : 'offline')?.(); },
    advance(ms) {
      const end = now + ms;
      let runs = 0;
      while (timers.size) {
        const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (timer.at > end) break;
        assert.ok(++runs < 1000, 'tile recovery must not spin through unbounded timers');
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = end;
    },
  };
}

function image(name = 'imagery') {
  let src = `https://tiles.example.test/19/123/456.png?signature=${name}`;
  const requests = [];
  const tile = {
    isConnected: true,
    complete: false,
    naturalWidth: 0,
    getAttribute: name => name === 'src' ? src : null,
    removeAttribute: name => { if (name === 'src') src = ''; },
    get src() { return src; },
    set src(value) { src = value; requests.push(value); },
  };
  return { tile, requests, original: src };
}

test('successful tiles cancel their deadline and never reload while neighboring failures recover', () => {
  const h = harness();
  const loaded = image('loaded');
  const failed = image('failed');
  h.event('tileloadstart', loaded.tile);
  h.event('tileloadstart', failed.tile);
  h.event('tileload', loaded.tile);
  h.event('tileerror', failed.tile);
  h.advance(800);
  assert.deepEqual(loaded.requests, []);
  assert.deepEqual(failed.requests, [failed.original]);
  h.event('tileload', failed.tile);
  assert.equal(h.timers.size, 0);
  h.advance(120_000);
  assert.equal(failed.requests.length, 1);
  assert.equal(h.statuses.at(-1).failedCount, 0);
});

test('repeated errors get two retries, then wait for an explicit Retry tiles action', () => {
  const h = harness();
  const { tile, requests, original } = image();
  h.event('tileloadstart', tile);
  h.event('tileerror', tile);
  // Duplicate events from the same failed image cannot add requests/timers.
  h.event('tileerror', tile);
  assert.equal(h.timers.size, 1);
  h.advance(800);
  h.event('tileerror', tile);
  h.advance(1600);
  h.event('tileerror', tile);
  assert.deepEqual(requests, [original, original]);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.statuses.at(-1), { failedCount: 1, online: true });
  h.advance(300_000);
  assert.equal(requests.length, 2);
  h.recovery.retryFailed();
  h.recovery.retryFailed();
  assert.equal(h.timers.size, 1);
  h.advance(800);
  assert.equal(requests.length, 3);
  h.event('tileload', tile);
  assert.equal(h.timers.size, 0);
  assert.equal(h.statuses.at(-1).failedCount, 0);
});

test('stalled images recover within a bounded number of attempts, including initial pre-append events', () => {
  const h = harness();
  const { tile, requests } = image();
  tile.isConnected = false;
  h.event('tileloadstart', tile);
  tile.isConnected = true;
  h.advance(12_800);
  assert.equal(requests.length, 1);
  h.advance(13_600);
  assert.equal(requests.length, 2);
  h.advance(12_000);
  assert.equal(h.statuses.at(-1).failedCount, 1);
  assert.equal(h.timers.size, 0);
  h.advance(300_000);
  assert.equal(requests.length, 2);
});

test('the watchdog preserves decoded pixels while a busy main thread delays the load event', () => {
  const h = harness();
  const { tile, requests } = image();
  h.event('tileloadstart', tile);
  tile.complete = true;
  tile.naturalWidth = 256;
  h.advance(300_000);
  assert.deepEqual(requests, []);
  assert.equal(h.timers.size, 0);
  assert.equal(h.statuses.at(-1).failedCount, 0);
  // The delayed native event is harmless after the watchdog recognizes success.
  h.event('tileload', tile);
  assert.equal(h.timers.size, 0);
});

test('a decoded image awaiting its event is not restarted by an already scheduled retry', () => {
  const h = harness();
  const { tile, requests } = image();
  h.event('tileloadstart', tile);
  h.event('tileerror', tile);
  tile.complete = true;
  tile.naturalWidth = 256;
  h.advance(300_000);
  assert.deepEqual(requests, []);
  assert.equal(h.timers.size, 0);
  assert.equal(h.statuses.at(-1).failedCount, 0);
});

test('tile unload and zoom abort cancel retries and cannot resurrect discarded imagery', () => {
  for (const event of ['tileunload', 'tileabort']) {
    const h = harness();
    const { tile, requests } = image();
    h.event('tileloadstart', tile);
    h.event('tileerror', tile);
    h.event(event, tile);
    tile.isConnected = false;
    h.advance(300_000);
    h.network(false);
    h.network(true);
    h.advance(300_000);
    assert.deepEqual(requests, []);
    assert.equal(h.timers.size, 0);
    assert.equal(h.statuses.at(-1).failedCount, 0);
  }
});

test('detached tiles are discarded even when the unload event is missing', () => {
  const h = harness();
  const { tile, requests } = image();
  h.event('tileloadstart', tile);
  tile.isConnected = false;
  h.advance(300_000);
  assert.deepEqual(requests, []);
  assert.equal(h.timers.size, 0);
  h.recovery.retryFailed();
  assert.equal(h.timers.size, 0);
});

test('offline tiles pause without timer/request churn and recover only once per reconnect', () => {
  const h = harness({ online: false });
  const { tile, requests } = image();
  h.event('tileloadstart', tile);
  h.event('tileerror', tile);
  h.recovery.retryFailed();
  h.advance(300_000);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(requests, []);
  assert.deepEqual(h.statuses.at(-1), { failedCount: 1, online: false });
  h.network(true);
  h.network(true);
  assert.equal(h.timers.size, 1);
  h.advance(800);
  assert.equal(requests.length, 1);
  h.network(false);
  assert.equal(h.timers.size, 0);
  h.advance(300_000);
  assert.equal(requests.length, 1);
  h.network(true);
  h.advance(800);
  assert.equal(requests.length, 2);
  h.event('tileload', tile);
  assert.equal(h.timers.size, 0);
  assert.equal(h.statuses.at(-1).failedCount, 0);
});

test('simultaneous failures cap retry concurrency and a finished tile releases the next queued image', () => {
  const h = harness();
  const images = Array.from({ length: 8 }, (_, i) => image(String(i)));
  images.forEach(({ tile }) => { h.event('tileloadstart', tile); h.event('tileerror', tile); });
  h.advance(800);
  assert.deepEqual(images.map(({ requests }) => requests.length), [1, 1, 1, 1, 0, 0, 0, 0]);
  h.event('tileload', images[0].tile);
  assert.deepEqual(images.map(({ requests }) => requests.length), [1, 1, 1, 1, 1, 0, 0, 0]);
  h.event('tileunload', images[1].tile);
  assert.deepEqual(images.map(({ requests }) => requests.length), [1, 1, 1, 1, 1, 1, 0, 0]);
  // Going offline also clears queued work, so it cannot burst while disconnected.
  h.network(false);
  h.advance(300_000);
  assert.equal(images.reduce((count, { requests }) => count + requests.length, 0), 6);
});

test('unmount cancels timers/listeners and StrictMode restart can track fresh tiles', () => {
  const h = harness();
  const stale = image();
  h.event('tileloadstart', stale.tile);
  h.event('tileerror', stale.tile);
  h.recovery.dispose();
  const statusCount = h.statuses.length;
  h.advance(300_000);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(stale.requests, []);
  h.event('tileerror', stale.tile);
  assert.equal(h.statuses.length, statusCount);
  h.recovery.start();
  const fresh = image('fresh');
  h.event('tileloadstart', fresh.tile);
  h.event('tileerror', fresh.tile);
  h.advance(800);
  assert.equal(fresh.requests.length, 1);
  assert.deepEqual(stale.requests, []);
});

test('all three raster map paths retain their providers, attribution and existing zoom settings', () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const shared = read('src/components/map/BaseMapTiles.jsx');
  const canvas = read('src/components/canvas/CanvasBaseMapTiles.jsx');
  const rep = read('src/components/rep/RepMapView.jsx');
  const wrapper = read('src/components/map/RecoveringTileLayer.jsx');
  for (const source of [shared, canvas, rep]) assert.match(source, /<RecoveringTileLayer/);
  assert.match(shared, /keepBuffer: 3/);
  assert.match(shared, /updateWhenZooming: true/);
  assert.match(shared, /updateWhenIdle: false/);
  assert.match(shared, /ESRI_IMAGERY_ATTRIBUTION : CARTO_ATTRIBUTION/);
  // The URL table moved to basemapUrls.js so the startup tile warm-up shares it.
  assert.match(shared, /from '@\/components\/map\/basemapUrls'/);
  assert.match(read('src/components/map/basemapUrls.js'), /World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}/);
  assert.match(canvas, /config\.mode === 'pmtiles'.*CanvasPmtilesLayer/);
  assert.match(canvas, /url=\{config\.url\}[\s\S]*attribution=\{config\.attribution\}/);
  assert.match(rep, /maxNativeZoom=\{19\}[\s\S]*maxZoom=\{22\}[\s\S]*updateWhenZooming=\{false\}/);
  assert.match(wrapper, /Retry tiles/);
  assert.match(wrapper, /L\.control\(\{ position: 'bottomleft' \}\)/);
  assert.doesNotMatch(wrapper, /\.redraw\(|\.setView\(|\.fitBounds\(|location\.(reload|replace)|\._tiles|\._tileReady/);
});
