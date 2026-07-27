// The assigned rep's Optimize surface.
//
// PR #77 shipped the mode menu on the manager/self map. The rep this feature
// was designed for — park near a compact route, walk it, finish back at the car
// — reaches routes through Knock, which had no Optimize control at all and a
// Home-only optimizer behind the Home Base panel.
//
// These tests EXECUTE the rep orchestration with the real helper modules. The
// defect that survived build, typecheck, CI and 659 tests in this PR was a
// helper called but never imported: only running the real path catches that.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createServer } from 'vite';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

let vite;
let rep;          // src/lib/repRouteOptimize.js — the real orchestration
let modes;        // src/lib/routeOriginModes.js
let menu;         // src/components/map/OptimizeRouteMenu.jsx
let OptimizeRouteMenu;

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/** Exactly the body of RepHome's rep optimization handler, nothing after it. */
function repOptimizeHandlerSource(source) {
  const start = source.indexOf('const handleOptimizeSelectedRoute');
  assert.ok(start > 0, 'the rep optimization handler must exist');
  const end = source.indexOf('\n  };', start);
  assert.ok(end > start, 'the handler must be delimited');
  return source.slice(start, end);
}

before(async () => {
  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  rep = await vite.ssrLoadModule('/src/lib/repRouteOptimize.js');
  modes = await vite.ssrLoadModule('/src/lib/routeOriginModes.js');
  menu = await vite.ssrLoadModule('/src/components/map/OptimizeRouteMenu.jsx');
  OptimizeRouteMenu = menu.default;
});

after(async () => { await vite?.close(); });

/* ══════════════ fixtures ══════════════ */

function doors(count = 20) {
  const props = [];
  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / 5);
    const col = i % 5;
    props.push({
      id: `p${i + 1}`,
      address_hash: `p${i + 1}`,
      street_name: `${row + 1}th St`,
      house_number: 100 + col * 2,
      city: 'Ames',
      zip_code: '50010',
      lat: Number((42.028 + row * 0.0025).toFixed(7)),
      lng: Number((-93.606 + col * 0.0025).toFixed(7)),
      effective_status: 'ELIGIBLE',
    });
  }
  return props;
}

const HOME_BASE = { address: '1 Private Ln, Ames IA', lat: 42.0405, lng: -93.5975 };
const CAR_POINT = { lat: 42.0272, lng: -93.6011 };

function makeRoute(properties, overrides = {}) {
  return {
    id: 'route-1',
    status: 'ACTIVE',
    assigned_to: 'member-1',
    property_hashes: properties.map((p) => p.address_hash),
    metrics: { distance: 4.2, house_count: properties.length },
    metadata: { road_geometry: [{ lat: 1, lng: 1 }], existing_key: 'kept' },
    route_origin_mode: 'none',
    ...overrides,
  };
}

/** A geolocation capture in the shape captureParkedCarLocation resolves. */
function capture(point = CAR_POINT, accuracy_m = 9) {
  return {
    ok: true,
    point: { lat: point.lat, lng: point.lng, accuracy_m, captured_at: '2026-07-27T18:00:00.000Z' },
  };
}

/**
 * Runs the REAL orchestration. Only the I/O is injected: the device, the
 * dialog, and persistence. Every routing decision executes for real.
 */
async function runOptimize(overrides = {}) {
  const properties = overrides.routeProperties || doors();
  const saves = [];
  const gps = { calls: 0 };
  const confirms = [];

  const result = await rep.optimizeRepRoute({
    mode: 'route_only',
    route: makeRoute(properties),
    routeProperties: properties,
    homeBase: HOME_BASE,
    routeBelongsToRep: true,
    routeArchived: false,
    hydrationComplete: true,
    captureLocation: async () => { gps.calls += 1; return capture(); },
    confirmLowAccuracy: (message) => { confirms.push(message); return true; },
    saveRoute: async (routeId, update) => { saves.push({ routeId, update }); },
    ...overrides,
  });

  return { result, saves, gps, confirms, properties };
}

const payloadOf = (saves) => saves[0]?.update;

/* ══════════════ 1. The rep menu (checks 1–5) ══════════════ */

test('REPMENU-01 the rep map renders the shared Optimize control beside Locate', async () => {
  const source = await read('src/components/rep/RepMapView.jsx');

  assert.match(source, /import OptimizeRouteMenu from '@\/components\/map\/OptimizeRouteMenu'/,
    'the rep map reuses the existing menu rather than defining a second list');
  assert.match(source, /<OptimizeRouteMenu/);
  // Beside Locate in the map header, not inside the route switcher, the Home
  // Base panel, an overflow menu, the property list or settings.
  const actions = source.slice(source.indexOf('data-testid="rep-map-actions"'));
  const optimizeAt = actions.indexOf('<OptimizeRouteMenu');
  const locateAt = actions.indexOf('<Locate');
  assert.ok(optimizeAt > 0 && locateAt > optimizeAt,
    'Optimize must sit in the same header group as Locate');
});

test('REPMENU-02 the menu renders exactly Route, From Home and From My Car', () => {
  // Rendered output, not the source: this is what the rep actually sees.
  const html = renderToStaticMarkup(
    React.createElement(OptimizeRouteMenu, { defaultOpen: true, onSelectMode: () => {} })
  );

  const rendered = [...html.matchAll(/data-optimize-mode="([a-z_]+)"[\s\S]*?<span class="block font-bold[^"]*">([^<]+)</g)]
    .map((match) => ({ mode: match[1], label: match[2] }));

  // Desktop dropdown and mobile sheet each render all three.
  assert.equal(rendered.length, 6, 'three choices in each of the two layouts');
  assert.deepEqual([...new Set(rendered.map((choice) => choice.label))], ['Route', 'From Home', 'From My Car']);
  assert.deepEqual([...new Set(rendered.map((choice) => choice.mode))],
    ['route_only', 'home_round_trip', 'car_round_trip']);
});

test('REPMENU-03 each label is bound to the mode the orchestration understands', () => {
  // The label the rep taps and the mode the handler receives are one mapping.
  assert.deepEqual(
    menu.OPTIMIZE_CHOICES.map((choice) => [choice.label, choice.mode]),
    [['Route', 'route_only'], ['From Home', 'home_round_trip'], ['From My Car', 'car_round_trip']]
  );
  for (const choice of menu.OPTIMIZE_CHOICES) {
    assert.ok(modes.OPTIMIZE_MODE_VALUES.includes(choice.mode), `${choice.label} is a real mode`);
  }
});

test('REPMENU-04 selecting each choice drives the matching route_origin_mode', async () => {
  const expected = {
    route_only: 'none',
    home_round_trip: 'home_round_trip',
    car_round_trip: 'car_round_trip',
  };

  for (const choice of menu.OPTIMIZE_CHOICES) {
    const { result, saves } = await runOptimize({ mode: choice.mode });
    assert.equal(result.ok, true, `${choice.label} must succeed`);
    assert.equal(result.routeOriginMode, expected[choice.mode], `${choice.label} route_origin_mode`);
    assert.equal(payloadOf(saves).route_origin_mode, expected[choice.mode]);
  }
});

test('REPMENU-05 RepHome wires the map menu to the one mode-aware handler', async () => {
  const source = await read('src/pages/RepHome.jsx');

  assert.match(source, /onOptimizeMode=\{\(mode\) => handleOptimizeSelectedRoute\(\{ mode \}\)\}/);
  // And there is no surviving second, car-specific optimizer beside it.
  assert.equal(source.includes('handleOptimizeSelectedRouteFromHome'), false,
    'the Home-only handler must be replaced, not duplicated');
  assert.equal((source.match(/const handleOptimizeSelectedRoute\b/g) || []).length, 1,
    'exactly one rep optimization handler');
});

/* ══════════════ 2. Rep identity (checks 6–9) ══════════════ */

test('IDENT-01 a route assigned by direct User id optimizes', async () => {
  const { result } = await runOptimize({ mode: 'car_round_trip', routeBelongsToRep: true });
  assert.equal(result.ok, true);
});

test('IDENT-02 a tenant-scoped TeamMember assignment optimizes', async () => {
  // RepHome resolves this through routeScope/activeRouteBelongsToCurrentUser,
  // which already accepts TeamMember ids; the orchestration consumes the answer.
  const source = await read('src/pages/RepHome.jsx');
  assert.match(source, /routeBelongsToRep: activeRouteBelongsToCurrentUser/);
  assert.match(source,
    /activeRoute\.assigned_to === user\?\.id \|\| allTeamMemberIds\.includes\(activeRoute\.assigned_to\)/,
    'TeamMember ids resolved from routeScope, not an unscoped email query');

  const { result } = await runOptimize({ mode: 'home_round_trip', routeBelongsToRep: true });
  assert.equal(result.ok, true);
});

test('IDENT-03 another rep’s route is refused', async () => {
  const { result, saves } = await runOptimize({ mode: 'car_round_trip', routeBelongsToRep: false });

  assert.equal(result.ok, false);
  assert.equal(result.code, rep.REP_OPTIMIZE_ERRORS.NOT_ASSIGNED);
  assert.equal(saves.length, 0, 'nothing is written');
});

test('IDENT-04 GPS is never requested when identity fails', async () => {
  const { gps, saves } = await runOptimize({ mode: 'car_round_trip', routeBelongsToRep: false });

  assert.equal(gps.calls, 0,
    'refusing after collecting a precise location would gather it for nothing');
  assert.equal(saves.length, 0);
});

test('IDENT-05 an archived route is refused before GPS', async () => {
  const { result, gps } = await runOptimize({ mode: 'car_round_trip', routeArchived: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, rep.REP_OPTIMIZE_ERRORS.ARCHIVED);
  assert.equal(gps.calls, 0);
});

test('IDENT-06 an unidentified route is refused before GPS', async () => {
  const { result, gps } = await runOptimize({ mode: 'car_round_trip', route: null });
  assert.equal(result.ok, false);
  assert.equal(result.code, rep.REP_OPTIMIZE_ERRORS.NO_ROUTE);
  assert.equal(gps.calls, 0);
});

/* ══════════════ 3. Route mode (checks 10–14) ══════════════ */

test('ROUTE-01 route_only requests no GPS', async () => {
  const { result, gps } = await runOptimize({ mode: 'route_only' });
  assert.equal(result.ok, true);
  assert.equal(gps.calls, 0);
});

test('ROUTE-02 route_only ignores the Home Base entirely', async () => {
  // Same doors, same everything — only the Home Base differs. If route_only
  // looked it up, the resulting order would change.
  const properties = doors();
  const withHome = await runOptimize({ mode: 'route_only', routeProperties: properties, homeBase: HOME_BASE });
  const without = await runOptimize({ mode: 'route_only', routeProperties: properties, homeBase: null });

  assert.equal(without.result.ok, true, 'no Home Base is not an error for route_only');
  assert.deepEqual(withHome.result.order, without.result.order);
});

test('ROUTE-03 route_only clears the session anchor', async () => {
  const { result } = await runOptimize({ mode: 'route_only' });
  assert.equal(result.sessionAnchor, null, 'choosing Route drops any previous Home or car anchor');
});

test('ROUTE-04 route_only writes no coordinates and disables route bounds', async () => {
  const { saves } = await runOptimize({ mode: 'route_only' });
  const payload = payloadOf(saves);

  assert.equal(payload.start_location, null);
  assert.equal(payload.end_location, null);
  assert.equal(payload.route_origin_mode, 'none');
  assert.equal(payload.metadata.route_bounds.enabled, false);
  assert.equal(payload.metadata.route_bounds.cleared_reason, 'optimized_route_only');
});

test('ROUTE-05 a previous car anchor is cleared, not inherited', async () => {
  const properties = doors();
  const stale = makeRoute(properties, {
    route_origin_mode: 'car_round_trip',
    start_location: { lat: 42.02, lng: -93.61 },
    end_location: { lat: 42.02, lng: -93.61 },
    metadata: { route_bounds: { enabled: true, mode: 'car_round_trip' } },
  });

  const { saves } = await runOptimize({ mode: 'route_only', route: stale, routeProperties: properties });
  const payload = payloadOf(saves);

  assert.equal(payload.start_location, null);
  assert.equal(payload.end_location, null);
  assert.equal(payload.metadata.route_bounds.enabled, false);
});

/* ══════════════ 4. Home mode (checks 15–19) ══════════════ */

test('HOME-01 home_round_trip requests no GPS', async () => {
  const { result, gps } = await runOptimize({ mode: 'home_round_trip' });
  assert.equal(result.ok, true);
  assert.equal(gps.calls, 0, 'the private Home Base is already known');
});

test('HOME-02 the private Home Base is both endpoints', async () => {
  const { result } = await runOptimize({ mode: 'home_round_trip' });

  assert.deepEqual(result.sessionAnchor.startLocation, HOME_BASE);
  assert.deepEqual(result.sessionAnchor.endLocation, HOME_BASE);
  assert.equal(result.sessionAnchor.mode, 'home_round_trip');
});

test('HOME-03 a missing Home Base refuses rather than guessing', async () => {
  const { result, saves } = await runOptimize({ mode: 'home_round_trip', homeBase: null });

  assert.equal(result.ok, false);
  assert.equal(result.code, rep.REP_OPTIMIZE_ERRORS.MISSING_HOME_BASE);
  assert.equal(saves.length, 0);
});

test('HOME-04 the exact Home Base never reaches SavedRoute', async () => {
  const { saves } = await runOptimize({ mode: 'home_round_trip' });
  const payload = payloadOf(saves);

  assert.equal(payload.start_location, null);
  assert.equal(payload.end_location, null);

  const serialized = JSON.stringify(payload);
  for (const secret of [HOME_BASE.lat, HOME_BASE.lng, HOME_BASE.address]) {
    assert.equal(serialized.includes(String(secret)), false,
      `SavedRoute is shared — it must not carry ${secret}`);
  }
  assert.deepEqual(payload.metadata.route_bounds, { enabled: true, mode: 'home_round_trip' });
});

test('HOME-05 the map receives Home bounds from the session', async () => {
  const { result } = await runOptimize({ mode: 'home_round_trip' });
  const route = makeRoute(doors(), { route_origin_mode: 'home_round_trip' });

  const anchor = rep.resolveRepMapAnchor({ route, sessionAnchor: result.sessionAnchor, homeBase: HOME_BASE });
  assert.equal(anchor.mode, 'home_round_trip');
  assert.deepEqual(anchor.startLocation, HOME_BASE);
  assert.deepEqual(anchor.endLocation, HOME_BASE);
});

test('HOME-06 the Home Base panel button calls the same mode-aware handler', async () => {
  const source = await read('src/pages/RepHome.jsx');

  assert.match(
    source,
    /onClick=\{\(\) => handleOptimizeSelectedRoute\(\{ mode: OPTIMIZE_MODES\.HOME_ROUND_TRIP \}\)\}/,
    'the existing shortcut remains, routed through the shared handler'
  );
});

/* ══════════════ 5. Car mode (checks 20–27) ══════════════ */

test('CAR-01 GPS is requested exactly once per selection', async () => {
  const { result, gps } = await runOptimize({ mode: 'car_round_trip' });

  assert.equal(result.ok, true);
  assert.equal(gps.calls, 1, 'one frozen fix — not a watcher, not a second read');
});

test('CAR-02 start and finish are the same frozen point', async () => {
  const { result } = await runOptimize({ mode: 'car_round_trip' });

  assert.deepEqual(result.sessionAnchor.startLocation, CAR_POINT);
  assert.deepEqual(result.sessionAnchor.endLocation, CAR_POINT);
  assert.equal(result.sessionAnchor.mode, 'car_round_trip');
  assert.equal(result.sessionAnchor.accuracy_m, 9);
  assert.equal(result.sessionAnchor.captured_at, '2026-07-27T18:00:00.000Z');
});

test('CAR-03 poor accuracy asks for explicit consent, quoting the radius', async () => {
  const { result, confirms } = await runOptimize({
    mode: 'car_round_trip',
    captureLocation: async () => capture(CAR_POINT, 140),
  });

  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /Location accuracy is approximately ±140 m\./);
  assert.match(confirms[0], /Use this location anyway\? Cancel to retry\./);
  assert.equal(result.ok, true, 'accepting proceeds');
});

test('CAR-04 a good fix is not interrupted by a dialog', async () => {
  const { confirms } = await runOptimize({
    mode: 'car_round_trip',
    captureLocation: async () => capture(CAR_POINT, 12),
  });
  assert.deepEqual(confirms, []);
});

test('CAR-05 unknown accuracy proceeds without claiming precision', async () => {
  const { result, confirms } = await runOptimize({
    mode: 'car_round_trip',
    captureLocation: async () => capture(CAR_POINT, null),
  });

  assert.deepEqual(confirms, [], 'unknown is not the same as poor');
  assert.equal(result.ok, true);
  assert.equal(result.sessionAnchor.accuracy_m, null, 'and no accuracy is invented');
});

test('CAR-06 declining consent changes nothing at all', async () => {
  const { result, saves } = await runOptimize({
    mode: 'car_round_trip',
    captureLocation: async () => capture(CAR_POINT, 140),
    confirmLowAccuracy: () => false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, rep.REP_OPTIMIZE_ERRORS.LOCATION_DECLINED);
  assert.equal(saves.length, 0, 'no SavedRoute update');
  assert.equal(result.sessionAnchor, undefined, 'no session anchor');
});

test('CAR-07 permission denial changes nothing and substitutes no point', async () => {
  const { result, saves } = await runOptimize({
    mode: 'car_round_trip',
    captureLocation: async () => ({ ok: false, code: 'permission_denied', message: 'Location permission was denied.' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, rep.REP_OPTIMIZE_ERRORS.LOCATION_FAILED);
  assert.match(result.message, /permission was denied/i);
  assert.equal(saves.length, 0);
});

test('CAR-08 a failed fix never falls back to the Home Base', async () => {
  const { result, saves } = await runOptimize({
    mode: 'car_round_trip',
    homeBase: HOME_BASE,
    captureLocation: async () => ({ ok: false, code: 'timeout', message: 'Your location could not be determined.' }),
  });

  assert.equal(result.ok, false);
  assert.equal(saves.length, 0, 'anchoring the route at the rep’s house instead would be silently wrong');
});

test('CAR-09 exact car coordinates never reach SavedRoute', async () => {
  const { saves } = await runOptimize({ mode: 'car_round_trip' });
  const payload = payloadOf(saves);

  assert.equal(payload.start_location, null);
  assert.equal(payload.end_location, null);

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(String(CAR_POINT.lat)), false);
  assert.equal(serialized.includes(String(CAR_POINT.lng)), false);

  // Non-coordinate provenance is persisted, and nothing more.
  assert.deepEqual(payload.metadata.route_bounds, {
    enabled: true,
    mode: 'car_round_trip',
    start_source: 'gps_snapshot',
    accuracy_m: 9,
    captured_at: '2026-07-27T18:00:00.000Z',
  });
});

test('CAR-10 the map receives the car point for the active session only', async () => {
  const { result } = await runOptimize({ mode: 'car_round_trip' });
  const route = makeRoute(doors(), { route_origin_mode: 'car_round_trip' });

  const live = rep.resolveRepMapAnchor({ route, sessionAnchor: result.sessionAnchor, homeBase: HOME_BASE });
  assert.equal(live.mode, 'car_round_trip');
  assert.deepEqual(live.startLocation, CAR_POINT);
  assert.deepEqual(live.endLocation, CAR_POINT);
});

test('CAR-11 selecting the car again replaces the previous point', async () => {
  const first = await runOptimize({ mode: 'car_round_trip' });
  const moved = { lat: 42.0301, lng: -93.6042 };
  const second = await runOptimize({
    mode: 'car_round_trip',
    captureLocation: async () => capture(moved, 7),
  });

  assert.deepEqual(first.result.sessionAnchor.startLocation, CAR_POINT);
  assert.deepEqual(second.result.sessionAnchor.startLocation, moved);
  assert.notDeepEqual(second.result.sessionAnchor.startLocation, first.result.sessionAnchor.startLocation);
});

test('CAR-12 the one-shot capture is the default, so no watcher is ever started', async () => {
  const source = await read('src/lib/repRouteOptimize.js');
  const carLocation = await read('src/lib/parkedCarLocation.js');

  assert.match(source, /captureLocation = captureParkedCarLocation/,
    'the rep path defaults to the shared one-shot capture');
  assert.equal(carLocation.includes('watchPosition'), false, 'which contains no watcher at all');
  // And RepHome does not reach for the warmed outcome-logging fix.
  const repHome = await read('src/pages/RepHome.jsx');
  assert.equal(repOptimizeHandlerSource(repHome).includes('gpsFixRef'), false,
    'the outcome-logging GPS cache is a different, staler point');
});

/* ══════════════ 6. Session lifecycle (checks 28–32) ══════════════ */

test('SESSION-01 switching routes drops the previous route’s anchor', async () => {
  const { result } = await runOptimize({ mode: 'car_round_trip' });
  const otherRoute = makeRoute(doors(), { id: 'route-2', route_origin_mode: 'car_round_trip' });

  const anchor = rep.resolveRepMapAnchor({
    route: otherRoute,
    sessionAnchor: result.sessionAnchor,   // still keyed to route-1
    homeBase: HOME_BASE,
  });

  assert.equal(anchor.startLocation, null, 'yesterday’s parking spot is not today’s start');
  assert.equal(anchor.mode, 'none');

  const source = await read('src/pages/RepHome.jsx');
  assert.match(source, /current\.routeId === activeRoute\?\.id \? current : null/,
    'and RepHome clears it when the active route changes');
});

test('SESSION-02 car → route clears the anchor', async () => {
  const car = await runOptimize({ mode: 'car_round_trip' });
  assert.notEqual(car.result.sessionAnchor, null);

  const route = await runOptimize({ mode: 'route_only' });
  assert.equal(route.result.sessionAnchor, null);
});

test('SESSION-03 car → home replaces the car point with the Home Base', async () => {
  const car = await runOptimize({ mode: 'car_round_trip' });
  const home = await runOptimize({ mode: 'home_round_trip' });

  assert.deepEqual(car.result.sessionAnchor.startLocation, CAR_POINT);
  assert.deepEqual(home.result.sessionAnchor.startLocation, HOME_BASE);
  assert.equal(home.result.sessionAnchor.mode, 'home_round_trip');
});

test('SESSION-04 after a refresh no car coordinate is invented', () => {
  const route = makeRoute(doors(), { route_origin_mode: 'car_round_trip' });

  // No session anchor survives a reload — nothing persisted the car.
  const anchor = rep.resolveRepMapAnchor({ route, sessionAnchor: null, homeBase: HOME_BASE });

  assert.equal(anchor.startLocation, null, 'not the Home Base');
  assert.equal(anchor.endLocation, null, 'and not live GPS');
  assert.equal(anchor.mode, 'none', 'so the map draws no anchor until the rep recaptures it');
});

test('SESSION-05 after a refresh Home mode re-resolves from the authenticated user', () => {
  const route = makeRoute(doors(), { route_origin_mode: 'home_round_trip' });
  const anchor = rep.resolveRepMapAnchor({ route, sessionAnchor: null, homeBase: HOME_BASE });

  assert.deepEqual(anchor.startLocation, HOME_BASE, 'the Home Base is still known to the rep');
  assert.equal(anchor.mode, 'home_round_trip');
});

test('SESSION-06 the optimized order survives without the coordinate', async () => {
  const { result, saves } = await runOptimize({ mode: 'car_round_trip' });
  const payload = payloadOf(saves);

  assert.deepEqual(payload.property_hashes, result.order, 'the door order is what persists');
  assert.equal(payload.start_location, null);
  assert.equal(payload.end_location, null);
});

test('SESSION-07 the anchor is React state only — never a storage API', async () => {
  const source = await read('src/pages/RepHome.jsx');
  const handler = repOptimizeHandlerSource(source);

  assert.match(source, /const \[routeAnchorSession, setRouteAnchorSession\] = useState\(null\)/);
  for (const api of ['localStorage', 'sessionStorage', 'localforage']) {
    assert.equal(handler.includes(api), false, `the anchor must not be written to ${api}`);
  }
});

/* ══════════════ 7. Map labelling (checks 33–36) ══════════════ */

test('MAP-01 a Home anchor is labelled Home', () => {
  assert.equal(modes.routeAnchorMarkerLabels('home_round_trip').start, 'Home • Start / Finish');
});

test('MAP-02 a car anchor is labelled Car, not Home', () => {
  const labels = modes.routeAnchorMarkerLabels('car_round_trip');

  assert.equal(labels.start, 'Car • Start / Finish');
  assert.equal(labels.start.includes('Home'), false,
    'the endpoints matching means "round trip", not "house"');
});

test('MAP-03 current_to_home keeps a distinct Start and Finish', () => {
  assert.deepEqual(modes.routeAnchorMarkerLabels('current_to_home'), { start: 'Start', end: 'Finish' });
});

test('MAP-04 route-only draws no external anchor marker', () => {
  assert.deepEqual(modes.routeAnchorMarkerLabels('none'), { start: null, end: null });
  assert.deepEqual(modes.routeAnchorMarkerLabels(undefined), { start: null, end: null });
});

test('MAP-05 the label comes from the mode, never from matching geometry', async () => {
  const source = await read('src/components/rep/RepMapView.jsx');

  assert.equal(source.includes("endpointsMatch ? 'Home • Start / Finish'"), false,
    'the geometry-inferred label is gone');
  assert.match(source, /routeAnchorMarkerLabels\(routeOriginMode\)/);
  assert.match(source, /\{anchorLabels\.start\}/);
});

test('MAP-06 the live YOU marker stays separate from the frozen anchor', async () => {
  const source = await read('src/components/rep/RepMapView.jsx');

  // YOU is driven by the live watcher's `position`; the anchor by startLocation.
  assert.match(source, /<GpsLayer position=\{position\} accuracy=\{accuracy\}/);
  assert.match(source, /YOU<\/span>/);
  assert.match(source, /center=\{\[Number\(startLocation\.lat\), Number\(startLocation\.lng\)\]\}/);
  assert.equal(source.includes('center={[position.lat, position.lng]}\n                            radius={8}'), false);
});

/* ══════════════ 8. Integrity and objective (checks 37–42) ══════════════ */

test('INTEGRITY-01 membership is identical before and after, in every mode', async () => {
  for (const mode of ['route_only', 'home_round_trip', 'car_round_trip']) {
    const { result, properties } = await runOptimize({ mode });
    const before = properties.map((p) => p.address_hash).sort();
    const after = [...result.order].sort();

    assert.deepEqual(after, before, `${mode}: same set`);
    assert.equal(result.order.length, properties.length, `${mode}: nothing added or missing`);
    assert.equal(new Set(result.order).size, result.order.length, `${mode}: no duplicates`);
  }
});

test('INTEGRITY-02 only order, metrics, mode and provenance change', async () => {
  const { saves } = await runOptimize({ mode: 'car_round_trip' });
  const payload = payloadOf(saves);

  assert.deepEqual(Object.keys(payload).sort(),
    ['end_location', 'metadata', 'metrics', 'property_hashes', 'route_origin_mode', 'start_location'].sort());
  assert.equal(payload.metadata.existing_key, 'kept', 'unrelated metadata survives');
  assert.equal('status' in payload, false, 'route status is not touched');
  assert.equal('assigned_to' in payload, false, 'assignment is not touched');
});

test('INTEGRITY-03 partial hydration refuses to optimize', async () => {
  const properties = doors();
  const route = makeRoute(properties);

  const { result, saves } = await runOptimize({
    mode: 'car_round_trip',
    route,
    routeProperties: properties.slice(0, 12),   // only 12 of 20 loaded
    hydrationComplete: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, rep.REP_OPTIMIZE_ERRORS.INCOMPLETE);
  assert.match(result.message, /Only 12 of 20/);
  assert.equal(saves.length, 0, 'optimizing the loaded subset would write it back as the whole route');
});

test('INTEGRITY-04 a property missing coordinates refuses to optimize', async () => {
  const properties = doors();
  properties[4] = { ...properties[4], lat: null, lng: null };

  const { result, saves } = await runOptimize({ mode: 'route_only', routeProperties: properties });

  assert.equal(result.ok, false);
  assert.equal(result.code, rep.REP_OPTIMIZE_ERRORS.MISSING_COORDINATES);
  assert.equal(saves.length, 0);
});

test('INTEGRITY-05 the membership check itself rejects loss, duplication and addition', () => {
  const properties = doors(5);

  assert.equal(rep.verifyRouteMembership(properties, properties).ok, true);
  assert.equal(rep.verifyRouteMembership(properties, properties.slice(0, 4)).ok, false, 'dropped');
  assert.equal(
    rep.verifyRouteMembership(properties, [...properties.slice(0, 4), properties[0]]).ok, false,
    'duplicated'
  );
  assert.equal(
    rep.verifyRouteMembership(properties, [...properties.slice(1), { address_hash: 'intruder' }]).ok, false,
    'added'
  );
});

test('OBJECTIVE-01 a worse candidate is never applied', async () => {
  // The applied order is measured under the same anchor as the order it
  // replaced, and must never be longer than it.
  const bounded = (order, anchor) => {
    let total = 0;
    const miles = (a, b) => {
      const dLat = (b.lat - a.lat) * 69;
      const dLng = (b.lng - a.lng) * 53;
      return Math.sqrt(dLat * dLat + dLng * dLng);
    };
    if (anchor) total += miles(anchor, order[0]);
    for (let i = 0; i < order.length - 1; i += 1) total += miles(order[i], order[i + 1]);
    if (anchor) total += miles(order[order.length - 1], anchor);
    return total;
  };

  for (const [mode, anchor] of [['route_only', null], ['home_round_trip', HOME_BASE], ['car_round_trip', CAR_POINT]]) {
    const { result, properties } = await runOptimize({ mode });
    const byHash = new Map(properties.map((p) => [p.address_hash, p]));
    const applied = result.order.map((hash) => byHash.get(hash));

    assert.ok(bounded(applied, anchor) <= bounded(properties, anchor) + 1e-6,
      `${mode}: the applied order is never worse than the one it replaced`);
  }
});

test('OBJECTIVE-02 savings come from the chosen anchor, never a stored metric', async () => {
  const properties = doors();

  // An absurd stored distance from some previous mode must not become savings.
  const inflated = await runOptimize({
    mode: 'car_round_trip',
    routeProperties: properties,
    route: makeRoute(properties, { metrics: { distance: 999, house_count: properties.length } }),
  });
  const plain = await runOptimize({
    mode: 'car_round_trip',
    routeProperties: properties,
    route: makeRoute(properties, { metrics: { distance: 0.1, house_count: properties.length } }),
  });

  assert.equal(inflated.result.savedMiles, plain.result.savedMiles,
    'the stored metric cannot influence reported savings');
  assert.ok(inflated.result.savedMiles < 50,
    'a Home-to-car commute difference is not optimizer savings');
});

test('OBJECTIVE-03 an unchanged order reports no savings and says so', async () => {
  const properties = doors();
  const first = await runOptimize({ mode: 'home_round_trip', routeProperties: properties });

  const byHash = new Map(properties.map((p) => [p.address_hash, p]));
  const optimizedOrder = first.result.order.map((hash) => byHash.get(hash));

  // Re-run against the already-optimized order under the same anchor.
  const second = await runOptimize({ mode: 'home_round_trip', routeProperties: optimizedOrder });

  assert.equal(second.result.savedMiles, 0);
  assert.match(second.result.message, /\(\d+(\.\d+)? mi street-continuity estimate\)/);
});

test('OBJECTIVE-04 the session anchor is set only after the save succeeds', async () => {
  const { result, saves } = await runOptimize({
    mode: 'car_round_trip',
    saveRoute: async () => { throw new Error('network down'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, rep.REP_OPTIMIZE_ERRORS.SAVE_FAILED);
  assert.equal(result.sessionAnchor, undefined, 'no anchor for a route that was never saved');
  assert.equal(saves.length, 0);
});

test('NAV-01 a successful optimization resets the navigation session', async () => {
  const source = await read('src/pages/RepHome.jsx');
  const handler = repOptimizeHandlerSource(source);
  const success = handler.slice(handler.indexOf('setRouteAnchorSession(result.sessionAnchor)'));

  assert.match(success.slice(0, 400), /setNavigationSession\(null\)/,
    'the open batch was built from the old order');
  assert.match(success.slice(0, 400), /setNavigationError\(''\)/);
});

test('NAV-02 external navigation construction is untouched by this change', async () => {
  const navigation = await read('src/components/logic/navigation.jsx');

  // The in-app route is ordered around the anchor; external Home/Car origin and
  // destination support is a separate navigation-boundary PR.
  assert.match(navigation, /export function getRouteNavigationPlan/);
  assert.equal(navigation.includes('car_round_trip'), false,
    'no external car anchor is introduced here');
  assert.equal(navigation.includes('home_round_trip'), false);
});

/* ══════════════ 9. Runtime integration (checks 43–45) ══════════════ */

test('RUNTIME-01 the rep path executes with the real helper modules', async () => {
  // Not a mock in sight for the routing helpers: this call runs the real
  // optimizer, the real continuity context, the real objective comparison and
  // the real payload builder. A helper called but not imported throws here.
  const { result, saves } = await runOptimize({ mode: 'car_round_trip' });

  assert.equal(result.ok, true);
  assert.equal(saves.length, 1);
  assert.equal(typeof payloadOf(saves).metadata.routing, 'object', 'real road-routing metadata');
  assert.equal(typeof result.distanceMiles, 'number');
  assert.ok(Number.isFinite(result.distanceMiles));
});

const KEYWORDS = ['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function'];

/** Comments and string literals removed, so only real code is scanned. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Imports, declarations and destructured parameters — everything in scope. */
function resolvableNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const name of match[1].split(',')) {
      const local = name.trim().split(/\s+as\s+/).pop();
      if (local) names.add(local);
    }
  }
  for (const match of source.matchAll(/(?:function|const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  // Destructured parameters, including defaulted ones: `{ saveRoute, mode = x }`.
  // Lookaround, not consumption: `{ a, b, c }` shares its delimiters, and a
  // consuming match would silently skip every second name.
  for (const match of source.matchAll(/(?<=[{,])\s*([A-Za-z0-9_$]+)\s*(?=[,}=])/g)) names.add(match[1]);
  return names;
}

test('RUNTIME-02 every identifier the orchestration calls actually resolves', async () => {
  const source = codeOnly(await read('src/lib/repRouteOptimize.js'));

  // Anything called by name must be imported, declared or a parameter — the
  // exact class of defect that reached this branch as a ReferenceError.
  const inScope = resolvableNames(source);
  const called = [...new Set(
    [...source.matchAll(/(?<![.\w])([a-z][A-Za-z0-9_$]*)\s*\(/g)].map((match) => match[1])
  )].filter((name) => !KEYWORDS.includes(name));

  const missing = called.filter((name) => !inScope.has(name));
  assert.deepEqual(missing, [], `unresolved identifiers: ${missing.join(', ')}`);
  assert.ok(called.length > 10, 'the scan must actually be reaching the call sites');
});

test('RUNTIME-04 the guard is non-vacuous — a dropped import is detected', async () => {
  const source = codeOnly(await read('src/lib/repRouteOptimize.js'));

  // Simulate the defect: remove compareRouteObjective from its import.
  const broken = source.replace(/\n\s*compareRouteObjective,/, '\n');
  assert.notEqual(broken, source, 'the simulation must change the source');

  const inScope = resolvableNames(broken);
  assert.equal(inScope.has('compareRouteObjective'), false, 'simulated removal');
  assert.match(broken, /(?<![.\w])compareRouteObjective\s*\(/, 'while it is still called');
});

test('RUNTIME-03 all three modes complete end to end without throwing', async () => {
  for (const mode of ['route_only', 'home_round_trip', 'car_round_trip']) {
    const { result, saves } = await runOptimize({ mode });
    assert.equal(result.ok, true, `${mode} must complete`);
    assert.equal(saves.length, 1, `${mode} saves exactly once`);
    assert.ok(result.message.length > 0, `${mode} reports a result`);
  }
});
