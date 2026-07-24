import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

const polygon = [
  { lat: 35, lng: -82 },
  { lat: 35, lng: -81.99 },
  { lat: 35.01, lng: -81.99 },
  { lat: 35.01, lng: -82 },
];

function upstreamNetwork() {
  return {
    elements: [
      { type: 'node', id: 1, lat: 35, lon: -82 },
      { type: 'node', id: 2, lat: 35.001, lon: -82 },
      {
        type: 'way',
        id: 10,
        nodes: [1, 2],
        tags: { highway: 'residential', name: 'Test Street' },
      },
    ],
    _canvas: {
      source: 'overpass.example',
      fetched_at: '2026-07-24T00:00:00.000Z',
    },
  };
}

let vite;
let fetchRouteRoadNetwork;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  ({ fetchRouteRoadNetwork } = await vite.ssrLoadModule(
    '/src/components/logic/routeRoadNetworkSource.js',
  ));
});

after(async () => {
  await vite?.close();
});

test('route roads load directly in the browser without a generic backend proxy', async () => {
  let invocationCount = 0;
  let receivedPolygon = null;
  const result = await fetchRouteRoadNetwork(polygon, {
    invokeFunction: async () => {
      invocationCount += 1;
      throw new Error('must not invoke a backend proxy');
    },
    browserFetch: async (requestPolygon) => {
      receivedPolygon = requestPolygon;
      return upstreamNetwork();
    },
  });

  assert.equal(invocationCount, 0);
  assert.deepEqual(receivedPolygon, polygon);
  assert.equal(result._route_proxy.proxied, false);
  assert.equal(result._route_proxy.source, 'browser-overpass-route-v1');
  assert.equal(result._route_proxy.endpoint, 'overpass.example');
});

test('route browser requests reject invalid and oversized polygons before fetching', async () => {
  let browserFetchCount = 0;
  const browserFetch = async () => {
    browserFetchCount += 1;
    return upstreamNetwork();
  };

  await assert.rejects(
    fetchRouteRoadNetwork([{ lat: 35, lng: -82 }], { browserFetch }),
    (error) => error?.code === 'ROUTE_ROAD_POLYGON_INVALID',
  );
  await assert.rejects(
    fetchRouteRoadNetwork([
      { lat: 30, lng: -90 },
      { lat: 30, lng: -88 },
      { lat: 32, lng: -88 },
      { lat: 32, lng: -90 },
    ], { browserFetch }),
    (error) => error?.code === 'ROUTE_ROAD_AREA_TOO_LARGE',
  );

  assert.equal(browserFetchCount, 0);
});

test('route browser requests cap response, element, and timeout budgets', async () => {
  let receivedOptions = null;
  await fetchRouteRoadNetwork(polygon, {
    timeoutMs: 999_999,
    overallTimeoutMs: 999_999,
    maxElements: 999_999,
    maxTotalBytes: 999_999_999,
    browserFetch: async (_requestPolygon, options) => {
      receivedOptions = options;
      return upstreamNetwork();
    },
  });

  assert.equal(receivedOptions.timeoutMs, 8_000);
  assert.equal(receivedOptions.overallTimeoutMs, 20_000);
  assert.equal(receivedOptions.maxElements, 120_000);
  assert.equal(receivedOptions.maxTotalBytes, 8_000_000);
  assert.deepEqual(receivedOptions.overpassUrls, [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ]);
  assert.equal(receivedOptions.cacheEmptyResults, false);
});

test('route browser requests fail closed on malformed road data', async () => {
  await assert.rejects(
    fetchRouteRoadNetwork(polygon, {
      browserFetch: async () => ({ not_elements: [] }),
    }),
    (error) => error?.code === 'ROUTE_ROAD_NETWORK_MALFORMED',
  );
});

test('route road loading is isolated from Canvas and exposes no server proxy endpoint', () => {
  const routeContext = readSource('src/components/logic/routeRoadContext.js');
  const routeSource = readSource('src/components/logic/routeRoadNetworkSource.js');
  const canvasBuilder = readSource('src/components/map/CanvasBuilderSettings.jsx');
  const canvasDeploy = readSource('base44/functions/canvasDeployCampaign/entry.ts');

  assert.match(routeContext, /fetchRouteRoadNetwork/);
  assert.match(routeSource, /fetchOverpassRoadNetwork/);
  assert.doesNotMatch(routeSource, /base44\.functions|createClientFromRequest|invokeAuthenticated/);
  assert.equal(
    existsSync(resolve(rootDir, 'base44/functions/fetchRouteRoadNetwork/entry.ts')),
    false,
  );
  assert.match(canvasBuilder, /fetchOverpassRoadNetwork/);
  assert.match(canvasDeploy, /fetchServerRoadNetwork/);
  assert.match(canvasDeploy, /canvas_topology_source_unavailable/);
});
