import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createServer } from 'vite';

let vite;
let createRouteContinuityContext;
let generateOptimizedRoutes;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  ({ createRouteContinuityContext } = await vite.ssrLoadModule(
    '/src/components/logic/routeRoadContext.js',
  ));
  ({ generateOptimizedRoutes } = await vite.ssrLoadModule(
    '/src/components/logic/routeOptimizer.jsx',
  ));
});

after(async () => {
  await vite?.close();
});

function property(id, street, houseNumber, lng, subdivisionName) {
  return {
    id,
    address_hash: id,
    street_name: street,
    house_number: houseNumber,
    city: 'Testville',
    state: 'AZ',
    zip_code: '85001',
    lat: 33.45,
    lng,
    subdivision_name: subdivisionName,
    effective_status: 'ELIGIBLE',
    price: 350000,
  };
}

function contiguousRuns(values) {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

test('synchronous continuity keeps 43 doors grouped by subdivision and street segment', () => {
  const doors = [
    ...Array.from({ length: 11 }, (_, index) => property(
      `a-shared-${index}`,
      'Shared Drive',
      101 + index,
      -112.02 + index * 0.0001,
      'Neighborhood A',
    )),
    ...Array.from({ length: 10 }, (_, index) => property(
      `a-loop-${index}`,
      'Interior Loop',
      201 + index,
      -112.01 + index * 0.0001,
      'Neighborhood A',
    )),
    ...Array.from({ length: 11 }, (_, index) => property(
      `b-shared-${index}`,
      'Shared Drive',
      301 + index,
      -112.015 + index * 0.0001,
      'Neighborhood B',
    )),
    ...Array.from({ length: 10 }, (_, index) => property(
      `b-court-${index}`,
      'Separate Court',
      401 + index,
      -112.005 + index * 0.0001,
      'Neighborhood B',
    )),
    property('c-one', 'Connector Road', 501, -112, 'Neighborhood C'),
  ].reverse();

  const routingContext = createRouteContinuityContext(doors);
  assert.equal(typeof routingContext?.then, 'undefined');
  assert.equal(routingContext.mode, 'fallback');
  assert.equal(routingContext.roadAware, false);
  assert.equal(routingContext.diagnostics.reason, 'SYNCHRONOUS_CONTINUITY');
  assert.notEqual(
    routingContext.streetSegmentKey(doors.find(({ id }) => id === 'a-shared-0')),
    routingContext.streetSegmentKey(doors.find(({ id }) => id === 'b-shared-0')),
    'the same street name in different subdivisions must be treated as separate local segments',
  );

  const routes = generateOptimizedRoutes(
    doors,
    100,
    null,
    [],
    { routingContext },
  );
  assert.equal(routes.length, 1);
  const optimized = routes[0].properties;
  assert.equal(optimized.length, 43);
  assert.deepEqual(
    optimized.map(({ id }) => id).sort(),
    doors.map(({ id }) => id).sort(),
  );

  const subdivisionRuns = contiguousRuns(
    optimized.map(({ subdivision_name: subdivision }) => subdivision),
  );
  assert.equal(
    new Set(subdivisionRuns).size,
    subdivisionRuns.length,
    `a subdivision was exited and re-entered: ${subdivisionRuns.join(' -> ')}`,
  );

  const streetSegmentRuns = contiguousRuns(
    optimized.map((door) => `${door.subdivision_name}|${door.street_name}`),
  );
  assert.equal(
    new Set(streetSegmentRuns).size,
    streetSegmentRuns.length,
    `a street segment was exited and re-entered: ${streetSegmentRuns.join(' -> ')}`,
  );
});

test('synchronous continuity context has no route-size cutoff', () => {
  const doors = Array.from({ length: 10_001 }, (_, index) => property(
    `large-${index}`,
    `Street ${index % 25}`,
    index + 1,
    -112 + (index % 25) * 0.0001,
    `Neighborhood ${index % 5}`,
  ));
  const routingContext = createRouteContinuityContext(doors);

  assert.equal(routingContext.diagnostics.suppliedPointCount, doors.length);
  assert.ok(routingContext.accessGroupKey(doors[0]));
  assert.ok(routingContext.streetSegmentKey(doors.at(-1)));
});

test('merge and split optimization preserves terminal route members', () => {
  const doors = [
    { ...property('eligible', 'Main Street', 101, -112.01, 'Neighborhood A'), effective_status: 'ELIGIBLE' },
    { ...property('hard-no', 'Main Street', 103, -112.009, 'Neighborhood A'), effective_status: 'HARD_NO' },
    { ...property('dnc', 'Second Street', 201, -112.008, 'Neighborhood A'), effective_status: 'DO_NOT_KNOCK' },
    { ...property('cooldown', 'Second Street', 203, -112.007, 'Neighborhood A'), effective_status: 'COOLDOWN' },
    { ...property('duplicate-address-member', 'Main Street', 101, -112.006, 'Neighborhood A'), effective_status: 'ELIGIBLE' },
  ];
  const routingContext = createRouteContinuityContext(doors);
  const routes = generateOptimizedRoutes(
    doors,
    doors.length,
    null,
    [],
    { routingContext, excludeTerminal: false, preserveInputMembership: true },
  );

  assert.deepEqual(
    routes.flatMap((route) => route.properties).map(({ id }) => id).sort(),
    doors.map(({ id }) => id).sort(),
  );
});

test('every non-Home route generator supplies synchronous continuity context', async () => {
  const auditedCallSites = [
    ['../src/components/manager/TerritorySetupWizard.jsx', 1],
    ['../src/pages/ZipCodeExplorer.jsx', 1],
    ['../src/components/team/CampaignWizard.jsx', 1],
    ['../src/components/routes/ActiveRoutesTab.jsx', 1],
    ['../src/components/routes/RouteCommandPanel.jsx', 2],
  ];

  for (const [relativePath, expectedCalls] of auditedCallSites) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(
      source,
      /import\s+\{\s*createRouteContinuityContext\s*\}\s+from/,
      `${relativePath} must import the synchronous continuity context`,
    );
    assert.equal(
      (source.match(/generateOptimizedRoutes\(/g) || []).length,
      expectedCalls,
      `${relativePath} optimizer call count changed; audit its context wiring`,
    );
    assert.equal(
      (source.match(/const routingContext = createRouteContinuityContext\(/g) || []).length,
      expectedCalls,
      `${relativePath} must construct context for every optimizer call`,
    );
    assert.ok(
      (source.match(/(?:\{|,)\s*routingContext\s*(?:,|\})/g) || []).length >= expectedCalls,
      `${relativePath} must pass each context through optimizer options`,
    );
  }

  const activeRoutes = await readFile(
    new URL('../src/components/routes/ActiveRoutesTab.jsx', import.meta.url),
    'utf8',
  );
  const routeCommand = await readFile(
    new URL('../src/components/routes/RouteCommandPanel.jsx', import.meta.url),
    'utf8',
  );
  assert.match(
    activeRoutes,
    /generateOptimizedRoutes\([\s\S]*?excludeTerminal:\s*false[\s\S]*?preserveInputMembership:\s*true[\s\S]*?routingContext/,
    'saved-route merge must preserve terminal members',
  );
  assert.equal(
    (routeCommand.match(/excludeTerminal:\s*false/g) || []).length,
    2,
    'MERGE ALL and split must both preserve every saved route member',
  );
  assert.equal(
    (routeCommand.match(/preserveInputMembership:\s*true/g) || []).length,
    2,
    'MERGE ALL and split must fail closed instead of deduplicating saved members',
  );
});

test('Home and RepHome interactive optimizers never depend on live road loading', async () => {
  const auditedPages = [
    ['../src/pages/Home.jsx', 2],
    ['../src/pages/RepHome.jsx', 1],
  ];

  for (const [relativePath, expectedCalls] of auditedPages) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');

    assert.doesNotMatch(
      source,
      /\bcreateRouteRoadContext\b/,
      `${relativePath} must not call the live-road/Overpass context from an interactive optimizer`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:fetchOverpassRoadNetwork|loadRouteRoadNetwork)\b/,
      `${relativePath} must not call a live street-network loader directly`,
    );
    assert.match(
      source,
      /import\s*\{[\s\S]*?\bcreateRouteContinuityContext\b[\s\S]*?\}\s*from\s*['"][^'"]*routeRoadContext['"]/,
      `${relativePath} must import the local synchronous continuity context`,
    );
    assert.equal(
      (source.match(/\bcreateRouteContinuityContext\(/g) || []).length,
      expectedCalls,
      `${relativePath} interactive optimizer call sites must all construct local continuity context`,
    );
    assert.doesNotMatch(
      source,
      /await\s+createRouteContinuityContext\(/,
      `${relativePath} local continuity construction must stay synchronous`,
    );
  }

  const homeSource = await readFile(
    new URL('../src/pages/Home.jsx', import.meta.url),
    'utf8',
  );
  const optimizeActionSource = await readFile(
    new URL('../src/lib/reoptimizeRouteAction.js', import.meta.url),
    'utf8',
  );
  assert.match(
    homeSource,
    /const routingContext = finalCount <= 5000\s*\?\s*createRouteContinuityContext\(workingSet\)/,
    'initial generation must construct local continuity before routing',
  );
  assert.match(
    homeSource,
    /const routingContext = workingSet\.length <= 5000\s*\?\s*createRouteContinuityContext\(workingSet\)/,
    'manager reorder must construct local continuity before routing',
  );
  assert.match(
    optimizeActionSource,
    /routingContext = await createRouteRoadContext\(routeProperties,[\s\S]*?optimizeRouteByStreetSweep\(routeProperties, start, end, routingContext\)/,
    'the extracted manager Optimize action must pass its route context to the street sweep',
  );

  const largeRouteSource = await readFile(
    new URL('../src/components/logic/largeRouteOptimizer.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    largeRouteSource,
    /\b(?:createRouteRoadContext|fetchOverpassRoadNetwork|loadRouteRoadNetwork)\b/,
    'the large-route worker path must also remain independent from live street loading',
  );
  assert.match(
    largeRouteSource,
    /const continuityContext = createRouteContinuityContext\(indexedProperties\);[\s\S]*?routingContext:\s*continuityContext/,
    'the large-route worker must pass local continuity into route generation',
  );
});

test('intentional synchronous continuity is silent instead of reporting unavailable live streets', async () => {
  const homeSource = await readFile(
    new URL('../src/pages/Home.jsx', import.meta.url),
    'utf8',
  );
  const repSource = await readFile(
    new URL('../src/pages/RepHome.jsx', import.meta.url),
    'utf8',
  );

  for (const [pageName, source] of [['Home', homeSource], ['RepHome', repSource]]) {
    assert.doesNotMatch(
      source,
      /discloseRouteContinuityFallback|Live (?:street|road) data was unavailable|Every eligible home was preserved/,
      `${pageName} must not emit an unavailable-live-street warning for its intentional continuity path`,
    );
  }

  assert.doesNotMatch(
    homeSource,
    /discloseLargeRouteContinuityFallback|Live road-network ordering is unavailable at this size|Large-route continuity fallback used; no live road network was used/,
    'the intentional large-route continuity path must not claim that live streets are unavailable',
  );
});

test('initial generation and reorder use Optimize route-only semantics and the same road backend', async () => {
  const [homeSource, generationSource, optimizeSource] = await Promise.all([
    readFile(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/roadMatrixRouteGeneration.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/reoptimizeRouteAction.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(
    homeSource,
    /getCenter\(\)[\s\S]{0,180}(?:const|let)\s+start\s*=/,
    'the visible map center must never become an implicit generation or reorder anchor',
  );
  assert.equal(
    (homeSource.match(/buildRoadAwareGeneratedRoutes\(\{/g) || []).length,
    2,
    'initial generation and reorder must both run the shared road-aware tail',
  );
  assert.match(
    generationSource,
    /tryRoadMatrixOptimize\(properties,\s*\{[\s\S]*?start:\s*isValidRoutePoint\(route\.startLocation\)\s*\?\s*route\.startLocation\s*:\s*null,[\s\S]*?end:\s*isValidRoutePoint\(route\.endLocation\)\s*\?\s*route\.endLocation\s*:\s*null/,
    'generated routes must call the shared optimizer without inferred anchors',
  );
  assert.match(
    optimizeSource,
    /const start = optimizeFromCar[\s\S]*?: null;[\s\S]*?const end = optimizeFromCar[\s\S]*?: null;[\s\S]*?tryRoadMatrixOptimize\(routeProperties/,
    'Optimize route-only must stay unanchored and use the same shared optimizer',
  );
});