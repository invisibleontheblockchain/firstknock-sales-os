// ANCHORS — a manager-set fixed start/finish for one soloed route.
//
// Unlike the three Optimize anchors (none / Home Base / this device's car), a
// custom anchor is a typed address for the whole crew, so its coordinates ARE
// persisted on the route. These tests pin that asymmetry down, because writing a
// personal coordinate to a shared route is exactly what SavedRoute forbids.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createServer } from 'vite';

let vite;
let anchors;
let modes;
let optimizeUpdate;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  anchors = await vite.ssrLoadModule('/src/lib/routeAnchors.js');
  modes = await vite.ssrLoadModule('/src/lib/routeOriginModes.js');
  optimizeUpdate = await vite.ssrLoadModule('/src/lib/routeOptimizeUpdate.js');
});

after(async () => { await vite?.close(); });

const OFFICE = { lat: 34.5034, lng: -82.6501, address: '100 Office Way, Anderson, SC' };
const YARD = { lat: 34.5122, lng: -82.6402, address: '200 Yard Rd, Anderson, SC' };

test('ANCHOR-01 custom_bounds is a real anchored, non-round-trip mode', () => {
  assert.equal(modes.ROUTE_ORIGIN_MODES.CUSTOM_BOUNDS, 'custom_bounds');
  assert.equal(modes.normalizeRouteOriginMode('custom_bounds'), 'custom_bounds');
  assert.ok(modes.isAnchoredRouteOriginMode('custom_bounds'));
  assert.equal(modes.isRoundTripRouteOriginMode('custom_bounds'), false);
  assert.deepEqual(modes.routeAnchorMarkerLabels('custom_bounds'), { start: 'Start', end: 'Finish' });
});

test('ANCHOR-02 it is NOT an Optimize choice — that menu still offers three', () => {
  assert.deepEqual(modes.OPTIMIZE_MODE_VALUES, ['route_only', 'home_round_trip', 'car_round_trip']);
  assert.equal(modes.routeOriginModeForOptimizeMode('custom_bounds'), 'none');
});

test('ANCHOR-03 only place-shaped fields survive normalization', () => {
  assert.deepEqual(anchors.normalizeRouteAnchor({ ...OFFICE, accuracy_m: 12, captured_at: 'now' }), OFFICE);
  assert.deepEqual(anchors.normalizeRouteAnchor({ latitude: 34.5, longitude: -82.6 }), { lat: 34.5, lng: -82.6 });
  for (const bad of [null, undefined, {}, { lat: 91, lng: 0 }, { lat: 0, lng: 200 }, { lat: 'x', lng: 'y' }]) {
    assert.equal(anchors.normalizeRouteAnchor(bad), null, `${JSON.stringify(bad)} must not become an anchor`);
  }
});

test('ANCHOR-04 setting anchors persists the coordinates and the mode', () => {
  const payload = anchors.buildRouteAnchorsUpdate({
    start: OFFICE,
    end: YARD,
    order: ['a', 'b', 'c'],
    distanceMiles: 4.25,
    existingMetrics: { score: 88 },
    existingMetadata: { road_geometry: [1, 2], keep: true }
  });

  assert.equal(payload.route_origin_mode, 'custom_bounds');
  assert.deepEqual(payload.start_location, OFFICE);
  assert.deepEqual(payload.end_location, YARD);
  assert.deepEqual(payload.property_hashes, ['a', 'b', 'c']);
  assert.deepEqual(payload.metrics, { score: 88, distance: 4.25, house_count: 3 });
  assert.deepEqual(payload.metadata.route_bounds, {
    enabled: true, mode: 'custom_bounds', start_source: 'manual_address'
  });
  assert.equal(payload.metadata.keep, true, 'unrelated metadata survives');
  assert.equal(payload.metadata.road_geometry, undefined, 'a stale geometry never survives a reorder');
});

test('ANCHOR-05 a start-only anchor is still anchored', () => {
  const payload = anchors.buildRouteAnchorsUpdate({ start: OFFICE, end: null, order: ['a'], distanceMiles: 1 });
  assert.equal(payload.route_origin_mode, 'custom_bounds');
  assert.deepEqual(payload.start_location, OFFICE);
  assert.equal(payload.end_location, null);
});

test('ANCHOR-06 clearing returns the route to none and wipes both points', () => {
  const payload = anchors.buildRouteAnchorsUpdate({
    start: null,
    end: null,
    order: ['a', 'b'],
    distanceMiles: 2,
    existingMetadata: { route_bounds: { enabled: true, mode: 'custom_bounds' } }
  });

  assert.equal(payload.route_origin_mode, 'none');
  assert.equal(payload.start_location, null);
  assert.equal(payload.end_location, null);
  assert.deepEqual(payload.metadata.route_bounds, { enabled: false, cleared_reason: 'anchors_cleared' });
});

test('ANCHOR-07 unusable input clears rather than half-anchoring the route', () => {
  const payload = anchors.buildRouteAnchorsUpdate({ start: { lat: 999, lng: 0 }, order: ['a'], distanceMiles: 1 });
  assert.equal(payload.route_origin_mode, 'none');
  assert.equal(payload.start_location, null);
});

// The Optimize modes must keep clearing coordinates: a Home Base or parked car is
// personal, and SavedRoute states those must not be stored on a shared route.
test('ANCHOR-08 the Optimize payload still stores no coordinates at all', () => {
  for (const optimizeMode of ['route_only', 'home_round_trip', 'car_round_trip']) {
    const payload = optimizeUpdate.buildRouteOptimizeUpdate({
      optimizeMode, order: ['a'], distanceMiles: 1
    });
    assert.equal(payload.start_location, null, `${optimizeMode}: start must stay unwritten`);
    assert.equal(payload.end_location, null, `${optimizeMode}: end must stay unwritten`);
  }
});

/* ── The control surface ── */

test('ANCHOR-09 ANCHORS sits beside Split Route, Optimize and Export', async () => {
  const toolbar = await readFile(new URL('../src/components/map/MapToolbar.jsx', import.meta.url), 'utf8');

  assert.match(toolbar, /<span>ANCHORS<\/span>/, 'the desktop button exists');
  assert.match(toolbar, /Flag className="mr-2 h-4 w-4" \/> Anchors/, 'and a mobile menu item exists');
  assert.match(toolbar, /<RouteAnchorsDialog/, 'the dialog is rendered');
  assert.match(toolbar, /onReoptimizeRoute\(activeRoute, \{ anchors \}\)/,
    'and it reuses the single-route action so the doors are reordered too');

  // The Optimize triggers keep their positions around EXPORT (see MENU-05).
  const mobileTrigger = toolbar.indexOf('variant="mobile"');
  const exportButton = toolbar.indexOf('onClick={handleExportActiveRouteCsv}');
  const desktopTrigger = toolbar.indexOf('variant="desktop"');
  assert.ok(mobileTrigger < exportButton && exportButton < desktopTrigger, 'ANCHORS did not reorder Optimize/Export');
});

test('ANCHOR-10 the dialog geocodes typed addresses and can clear them', async () => {
  const dialog = await readFile(new URL('../src/components/routes/RouteAnchorsDialog.jsx', import.meta.url), 'utf8');

  assert.match(dialog, /geocodeAddress/, 'an address becomes a real coordinate before it is saved');
  assert.match(dialog, /onApply\(null\)/, 'clearing is offered');
  assert.match(dialog, /assigned rep sees this address/i, 'the shared-visibility warning is shown');
});