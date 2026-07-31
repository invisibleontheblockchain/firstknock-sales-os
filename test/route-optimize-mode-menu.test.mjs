// Optimize control — three explicit route-optimization choices.
//
// Clicking Optimize no longer reorders the route. It expands three choices in
// place, and the route changes only once a mode is chosen. The anchor is part
// of the resulting order, so choosing it implicitly is what made the old single
// button unpredictable.
//
// The choices render in normal flow inside the banner, like the RERUN panel
// beside them. MENU-03 guards that specifically: an earlier attempt used a
// position:fixed bottom sheet, which the banner's backdrop-filter turned into a
// containing block, sizing the sheet against the banner instead of the viewport.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createServer } from 'vite';

let vite;
let modes;
let carLocation;
let generateOptimizedRoutes;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  modes = await vite.ssrLoadModule('/src/lib/routeOriginModes.js');
  carLocation = await vite.ssrLoadModule('/src/lib/parkedCarLocation.js');
  ({ generateOptimizedRoutes } = await vite.ssrLoadModule('/src/components/logic/routeOptimizer.jsx'));
});

after(async () => { await vite?.close(); });

/* ══════════════ 1. The mode contract ══════════════ */

test('MODE-01 exactly three optimize choices exist', () => {
  assert.deepEqual(modes.OPTIMIZE_MODE_VALUES, ['route_only', 'home_round_trip', 'car_round_trip']);
});

test('MODE-02 each choice maps to its persisted route_origin_mode', () => {
  const { routeOriginModeForOptimizeMode: map, OPTIMIZE_MODES } = modes;

  assert.equal(map(OPTIMIZE_MODES.ROUTE_ONLY), 'none', 'route_only must clear the anchor, not inherit one');
  assert.equal(map(OPTIMIZE_MODES.HOME_ROUND_TRIP), 'home_round_trip');
  assert.equal(map(OPTIMIZE_MODES.CAR_ROUND_TRIP), 'car_round_trip');
});

test('MODE-03 car mode is never confused with current_to_home', () => {
  const { routeOriginModeForOptimizeMode: map, OPTIMIZE_MODES } = modes;
  assert.notEqual(map(OPTIMIZE_MODES.CAR_ROUND_TRIP), 'current_to_home');
  assert.ok(modes.isRoundTripRouteOriginMode('car_round_trip'), 'car mode starts and finishes at one point');
  assert.equal(modes.isRoundTripRouteOriginMode('current_to_home'), false, 'current_to_home is an open route');
});

test('MODE-04 the legacy { fromHome: true } shape still resolves', () => {
  const { resolveOptimizeMode } = modes;

  assert.equal(resolveOptimizeMode({ fromHome: true }), 'home_round_trip');
  assert.equal(resolveOptimizeMode({ mode: 'car_round_trip' }), 'car_round_trip');
  // An explicit mode wins over the legacy flag.
  assert.equal(resolveOptimizeMode({ mode: 'route_only', fromHome: true }), 'route_only');
  // No options at all is the safest default: doors only, no anchor.
  assert.equal(resolveOptimizeMode({}), 'route_only');
  assert.equal(resolveOptimizeMode(), 'route_only');
});

test('MODE-05 an unrecognized route_origin_mode still degrades to none', () => {
  assert.equal(modes.normalizeRouteOriginMode('nonsense'), 'none');
  assert.equal(modes.normalizeRouteOriginMode(undefined), 'none');
  // But the three real anchored modes survive.
  for (const mode of ['home_round_trip', 'current_to_home', 'car_round_trip']) {
    assert.equal(modes.normalizeRouteOriginMode(mode), mode);
  }
});

/* ══════════════ 2. The optimizer honours car_round_trip ══════════════ */

function grid() {
  const props = [];
  let i = 0;
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      i += 1;
      props.push({
        id: `p${i}`, address_hash: `p${i}`,
        street_name: `${row + 1}th St`, house_number: 100 + col * 2,
        city: 'Ames', zip_code: '50010',
        lat: Number((42.028 + row * 0.0025).toFixed(7)),
        lng: Number((-93.606 + col * 0.0025).toFixed(7)),
        effective_status: 'ELIGIBLE'
      });
    }
  }
  return props;
}

const CAR_NORTH = { lat: 42.0385, lng: -93.601 };
const CAR_SOUTH = { lat: 42.0265, lng: -93.601 };

const order = (props, anchor, mode) => generateOptimizedRoutes(props, 50, anchor, [], {
  routeOriginMode: mode, endLocation: anchor, preserveInputMembership: true
})[0].properties.map((p) => p.address_hash);

test('MODE-06 car_round_trip is now anchored, not silently downgraded', () => {
  const props = grid();

  const car = order(props, CAR_NORTH, 'car_round_trip');
  const home = order(props, CAR_NORTH, 'home_round_trip');
  const none = order(props, CAR_NORTH, 'none');

  // Before this change car_round_trip fell through the allowlist and produced
  // the unanchored order. It must now match an equal-anchor round trip.
  assert.deepEqual(car, home, 'car mode must honour its anchor');
  assert.notDeepEqual(car, none, 'and must differ from no anchor at all');
});

test('MODE-07 moving the car changes the order', () => {
  const props = grid();
  assert.notDeepEqual(
    order(props, CAR_NORTH, 'car_round_trip'),
    order(props, CAR_SOUTH, 'car_round_trip')
  );
});

test('MODE-08 membership is preserved by every mode', () => {
  const props = grid();
  const expected = props.map((p) => p.address_hash).sort().join(',');

  for (const mode of ['none', 'home_round_trip', 'current_to_home', 'car_round_trip']) {
    const result = order(props, CAR_NORTH, mode);
    assert.equal(result.slice().sort().join(','), expected, `${mode}: membership`);
    assert.equal(new Set(result).size, props.length, `${mode}: no duplicates`);
  }
});

test('MODE-09 car ordering is deterministic', () => {
  const props = grid();
  assert.deepEqual(order(props, CAR_NORTH, 'car_round_trip'), order(props, CAR_NORTH, 'car_round_trip'));
});

/* ══════════════ 3. The GPS contract ══════════════ */

const position = (latitude, longitude, accuracy) => ({ coords: { latitude, longitude, accuracy } });

function fakeGeolocation(behaviour) {
  const calls = { count: 0, options: [] };
  return {
    calls,
    geolocation: {
      getCurrentPosition(onSuccess, onError, options) {
        calls.count += 1;
        calls.options.push(options);
        behaviour(onSuccess, onError);
      }
    }
  };
}

test('GPS-01 a good fix returns a frozen point with accuracy and capture time', async () => {
  const { geolocation, calls } = fakeGeolocation((ok) => ok(position(42.03, -93.6, 12)));

  const result = await carLocation.captureParkedCarLocation({ geolocation });

  assert.equal(result.ok, true);
  assert.equal(result.point.lat, 42.03);
  assert.equal(result.point.lng, -93.6);
  assert.equal(result.point.accuracy_m, 12);
  assert.match(result.point.captured_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.count, 1, 'exactly one fix is requested');
});

test('GPS-02 the request never accepts a cached fix', async () => {
  const { geolocation, calls } = fakeGeolocation((ok) => ok(position(42.03, -93.6, 8)));
  await carLocation.captureParkedCarLocation({ geolocation });

  const [options] = calls.options;
  assert.equal(options.enableHighAccuracy, true);
  assert.equal(options.maximumAge, 0, 'a stale fix is worse than no fix — the rep may have driven');
  assert.equal(options.timeout, carLocation.CAR_LOCATION_TIMEOUT_MS);
});

test('GPS-03 permission denial fails cleanly and returns no point', async () => {
  const { geolocation } = fakeGeolocation((_ok, fail) => fail({ code: 1 }));

  const result = await carLocation.captureParkedCarLocation({ geolocation });

  assert.equal(result.ok, false);
  assert.equal(result.code, carLocation.CAR_LOCATION_ERRORS.PERMISSION_DENIED);
  assert.match(result.message, /permission was denied/i);
  assert.equal(result.point, undefined, 'no substituted location, ever');
});

test('GPS-04 timeout fails cleanly', async () => {
  const { geolocation } = fakeGeolocation((_ok, fail) => fail({ code: 3 }));

  const result = await carLocation.captureParkedCarLocation({ geolocation });

  assert.equal(result.ok, false);
  assert.equal(result.code, carLocation.CAR_LOCATION_ERRORS.TIMEOUT);
  assert.equal(result.point, undefined);
});

test('GPS-05 unusable coordinates are rejected rather than anchored', async () => {
  for (const [lat, lng] of [[NaN, -93.6], [42.03, NaN], [200, -93.6], [42.03, -400]]) {
    const { geolocation } = fakeGeolocation((ok) => ok(position(lat, lng, 5)));
    const result = await carLocation.captureParkedCarLocation({ geolocation });
    assert.equal(result.ok, false, `${lat},${lng} must be rejected`);
    assert.equal(result.code, carLocation.CAR_LOCATION_ERRORS.INVALID);
  }
});

test('GPS-06 missing geolocation support fails without throwing', async () => {
  const result = await carLocation.captureParkedCarLocation({ geolocation: null });
  assert.equal(result.ok, false);
  assert.equal(result.code, carLocation.CAR_LOCATION_ERRORS.UNSUPPORTED);
});

test('GPS-07 poor accuracy is flagged, not silently presented as precise', () => {
  const { isLowAccuracyCapture, CAR_LOCATION_ACCURACY_WARNING_M } = carLocation;

  assert.equal(isLowAccuracyCapture({ accuracy_m: 18 }), false);
  assert.equal(isLowAccuracyCapture({ accuracy_m: 140 }), true);
  assert.equal(isLowAccuracyCapture({ accuracy_m: CAR_LOCATION_ACCURACY_WARNING_M }), false, 'boundary is inclusive-good');
  // Unknown accuracy is not treated as poor — it is simply unknown.
  assert.equal(isLowAccuracyCapture({ accuracy_m: null }), false);
});

test('GPS-08 no continuous watcher is ever started', async () => {
  let watchCalls = 0;
  const geolocation = {
    getCurrentPosition: (ok) => ok(position(42.03, -93.6, 10)),
    watchPosition: () => { watchCalls += 1; return 1; }
  };

  await carLocation.captureParkedCarLocation({ geolocation });
  assert.equal(watchCalls, 0, 'the car does not move while the rep walks');
});

test('GPS-09 persisted car metadata carries no address or device identity', () => {
  const meta = carLocation.carRouteBoundsMetadata({
    lat: 42.03, lng: -93.6, accuracy_m: 14, captured_at: '2026-07-27T18:00:00.000Z'
  });

  assert.deepEqual(Object.keys(meta).sort(),
    ['accuracy_m', 'captured_at', 'enabled', 'mode', 'start_source'].sort());
  assert.equal(meta.mode, 'car_round_trip');
  assert.equal(meta.start_source, 'gps_snapshot');

  const serialized = JSON.stringify(meta);
  for (const leak of ['address', 'street', 'device', 'user_agent', 'history']) {
    assert.equal(serialized.includes(leak), false, `must not carry "${leak}"`);
  }
});

/* ══════════════ 4. The control surface ══════════════ */

const readInline = () => readFile(
  new URL('../src/components/map/OptimizeRouteInline.jsx', import.meta.url), 'utf8'
);

/** Source with comments removed, so prose about a bug cannot satisfy or trip a check. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const readToolbar = () => readFile(
  new URL('../src/components/map/MapToolbar.jsx', import.meta.url), 'utf8'
);
const readRouteCommandSurfaces = () => Promise.all([
  readFile(new URL('../src/components/routes/ActiveRoutesTab.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/routes/RouteCommandPanel.jsx', import.meta.url), 'utf8'),
]);

test('MENU-01 the Optimize button no longer reoptimizes on click', async () => {
  const source = await readToolbar();

  assert.equal(
    source.includes('onReoptimizeRoute(activeRoute)'), false,
    'the direct single-argument call must be gone from both desktop and mobile'
  );
  assert.match(source, /<OptimizeRouteTrigger/, 'the banner renders the expanding trigger');
  assert.match(source, /<OptimizeRouteChoices/, 'and the three choices');
  assert.match(source, /onReoptimizeRoute\(activeRoute, \{ mode \}\)/, 'and passes an explicit mode');
});

test('MENU-02 the control offers exactly the three labelled choices', async () => {
  const source = await readInline();
  const inline = await vite.ssrLoadModule('/src/components/map/OptimizeRouteInline.jsx');

  assert.deepEqual(
    inline.OPTIMIZE_CHOICES.map((choice) => choice.label),
    ['ROUTE', 'HOME', 'MY CAR']
  );
  assert.deepEqual(
    inline.OPTIMIZE_CHOICES.map((choice) => choice.mode),
    ['route_only', 'home_round_trip', 'car_round_trip']
  );
  assert.match(source, /CANCEL/, 'the control offers Cancel');
});

// The regression that cost four follow-up PRs. The active-route banner sets
// `backdrop-blur`, and a backdrop-filter makes an element the containing block
// for its position:fixed descendants. A `fixed inset-0` sheet therefore sized
// itself against the ~380x76px banner instead of the viewport and pushed two of
// the three choices off the top of the screen. Rendering in normal flow — like
// the RERUN panel beside it already does — makes that structurally impossible.
test('MENU-03 the choices render in flow, never as a fixed or portaled overlay', async () => {
  // Comments describe the bug being prevented, so they must not be scanned for
  // the very tokens under test.
  const code = stripComments(await readInline());

  assert.equal(/\bfixed\b/.test(code), false,
    'no position:fixed — an ancestor backdrop-filter would become its containing block');
  assert.equal(code.includes('createPortal'), false, 'no portal');
  assert.equal(code.includes('document.body'), false, 'nothing mounts on the body');
  assert.equal(/document\.body\.style|style\.overflow/.test(code), false,
    'no background scroll locking');
  assert.equal(/\binset-0\b/.test(code), false, 'no full-viewport scrim');
  assert.equal(/\bz-\[\d+\]/.test(code), false, 'no stacking-order escape hatch');
});

test('MENU-03b the guard would catch a reintroduced fixed overlay', () => {
  const regressed = stripComments(`
    // a comment mentioning fixed must not trip it
    export function Sheet() { return <div className="md:hidden fixed inset-0 z-[5000]" />; }
  `);
  assert.ok(/\bfixed\b/.test(regressed) && /\binset-0\b/.test(regressed),
    'the assertions in MENU-03 are non-vacuous');
});

test('MENU-04 Optimize stays a first-class control on both breakpoints', async () => {
  const source = await readInline();
  const toolbar = await readToolbar();

  assert.match(source, /data-testid=\{`optimize-trigger-\$\{variant\}`\}/);
  assert.match(toolbar, /variant="mobile"/, 'mobile trigger rendered');
  assert.match(toolbar, /variant="desktop"/, 'desktop trigger rendered');
  assert.match(source, /data-testid="optimize-choices"/);
});

// The two triggers did not sit in the same place: mobile came before EXPORT and
// desktop came after it. Emitting both from one position would silently reorder
// the desktop row, so each is rendered where its predecessor was.
test('MENU-05 the trigger keeps its original position at each breakpoint', async () => {
  const toolbar = await readToolbar();

  const mobileTrigger = toolbar.indexOf('variant="mobile"');
  // The button, not the handler's definition further up the file.
  const exportButton = toolbar.indexOf('onClick={handleExportActiveRouteCsv}');
  const desktopTrigger = toolbar.indexOf('variant="desktop"');

  assert.ok(mobileTrigger > 0 && exportButton > 0 && desktopTrigger > 0, 'all three present');
  assert.ok(mobileTrigger < exportButton, 'mobile Optimize precedes Export, as at PR #76');
  assert.ok(desktopTrigger > exportButton, 'desktop Optimize follows Export, as at PR #76');
});

test('MENU-06 Split Route, Export and Close are untouched', async () => {
  const source = await readToolbar();

  assert.match(source, /handleExportActiveRouteCsv/, 'Export intact');
  assert.match(source, /setShowSplitRouteModal\(true\)/, 'Split Route intact');
  assert.match(source, /setActiveRoute\(null\)/, 'Close intact');
});

// The toolbar's own placement is what PRs #78-#80 kept re-litigating. This
// build deliberately changes no layout at all, so the container must still be
// byte-identical to the one at PR #76.
test('MENU-07 the toolbar container placement is unchanged from PR #76', async () => {
  const source = await readToolbar();

  assert.match(
    source,
    /className="absolute top-1 left-1 right-1 sm:top-4 sm:left-4 sm:right-4 z-\[1000\] flex flex-col gap-1\.5 sm:gap-2 pointer-events-none"/,
    'the top overlay keeps the exact classes it had at PR #76'
  );
  assert.equal(source.includes('safe-area-inset'), false,
    'this change introduces no safe-area edits — that is a separate decision');
});

test('MENU-08 switching routes collapses the choices', async () => {
  const source = await readToolbar();

  assert.match(source, /useEffect\(\(\) => \{ setShowOptimizeMenu\(false\); \}, \[activeRoute\?\.id\]\)/,
    'a stale expansion must not carry across to a different route');
});

test('MENU-09 Route Command omits the redundant Home Base shortcut', async () => {
  const routeCommandSurfaces = await readRouteCommandSurfaces();

  for (const routeCommandSource of routeCommandSurfaces.map(stripComments)) {
    assert.doesNotMatch(routeCommandSource, /OPTIMIZE FROM HOME BASE/);
    assert.doesNotMatch(routeCommandSource, /Optimize from home base/);
    assert.doesNotMatch(routeCommandSource, /onReoptimize\(route, \{ fromHome: true \}\)/);
  }

  const toolbar = await readToolbar();
  assert.match(toolbar, /<OptimizeRouteChoices/, 'the solo-route choices remain available');
  assert.match(toolbar, /onReoptimizeRoute\(activeRoute, \{ mode \}\)/,
    'the solo-route optimizer still passes the chosen mode');
});

/* ══════════════ 5. Assigned-route protection ══════════════ */

test('ASSIGN-01 the car choice is disabled for a route assigned to someone else', async () => {
  const toolbar = await readFile(new URL('../src/components/map/MapToolbar.jsx', import.meta.url), 'utf8');

  assert.match(toolbar, /routeIsOptimizableFromCar/, 'the toolbar computes an assignee guard');
  assert.match(toolbar, /routeBelongsToActingUser\(activeRoute, user, teamMembers\)/,
    'and uses the SAME shared predicate as the handler — see route-optimize-update.test.mjs for its behaviour');
  assert.match(toolbar, /carDisabled=\{!routeIsOptimizableFromCar\}/, 'and passes it to the control');
});

// The visible control is a convenience, not the boundary. Disabling a button
// stops nothing on a device the actor controls, so the handler refuses on its
// own before it ever requests GPS.
// The handler moved out of Home.jsx into lib/reoptimizeRouteAction.js when custom
// ANCHORS were added; the behaviour it guards is unchanged.
test('ASSIGN-02 the handler refuses car mode itself, not just the disabled button', async () => {
  const home = await readFile(new URL('../src/lib/reoptimizeRouteAction.js', import.meta.url), 'utf8');

  const guard = home.indexOf('if (!routeBelongsToActingUser(route, user, teamMembers))');
  const capture = home.indexOf('await captureParkedCarLocation()');
  assert.ok(guard > 0, 'the handler carries its own assignee check');
  assert.ok(capture > 0 && guard < capture, 'and refuses BEFORE any location is requested');
});


test('ASSIGN-03 Home Base delegation for another rep is unchanged', async () => {
  const home = await readFile(new URL('../src/lib/reoptimizeRouteAction.js', import.meta.url), 'utf8');

  // A car has no server-side source of truth for another person, which is why
  // car mode is stricter than fromHome. fromHome itself must not regress.
  assert.match(home, /getRouteHomeBase/, 'the assignee Home Base lookup still exists');
});

/* ══════════════ 6. Route-only means exactly the doors ══════════════ */

test('ROUTEONLY-01 route_only passes no anchor at all', async () => {
  const action = await readFile(new URL('../src/lib/reoptimizeRouteAction.js', import.meta.url), 'utf8');

  // The previous implementation fell back to the map centre, silently anchoring
  // the route to wherever the user happened to be looking. Route GENERATION has
  // its own start-location behaviour that this deliberately does not touch.
  assert.equal(
    action.includes('currentCenter.lat'), false,
    'the map-centre fallback must be gone from the reoptimize action'
  );
  assert.match(action, /const start = optimizeFromCar \? carAnchor/);
  assert.match(action, /: null;/);
  const home = await readFile(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
  assert.match(home, /const handleReoptimizeRoute = useCallback\(\(route, options = \{\}\) => reoptimizeRoute\(/,
    'Home still owns the single wiring point for the action');
});