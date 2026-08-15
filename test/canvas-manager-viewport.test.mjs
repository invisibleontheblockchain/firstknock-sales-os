import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viewportPath = 'base44/functions/canvasGetViewportPins/entry.ts';
const viewportSource = readFileSync(resolve(root, viewportPath), 'utf8');
const campaignMapSource = readFileSync(resolve(root, 'base44/functions/canvasGetCampaignMap/entry.ts'), 'utf8');
const clientSource = readFileSync(resolve(root, 'src/components/canvas/canvasProductionClient.js'), 'utf8');
const builderSource = readFileSync(resolve(root, 'src/components/map/CanvasBuilderSettings.jsx'), 'utf8');
const layersSource = readFileSync(resolve(root, 'src/components/map/CanvasCampaignMapLayers.jsx'), 'utf8');

function executable(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${fileName} contains TypeScript syntax errors`);
  return result.outputText.replace(/^import .*;\s*$/gm, '').replace(/^export\s+/gm, '');
}

function loadViewport({ user, query }) {
  let handler;
  const base44 = { auth: { me: async () => user } };
  const context = {
    console,
    createClientFromRequest: () => base44,
    neon: () => query,
    Request,
    Response,
    Deno: {
      env: { get: (key) => key === 'CANVAS_DATABASE_URL' ? 'postgresql://canvas.invalid/db?sslmode=require' : '' },
      serve: (value) => { handler = value; },
    },
  };
  vm.runInNewContext(executable(viewportSource, viewportPath), context, { filename: viewportPath });
  return handler;
}

function request(body) {
  return new Request('https://firstknock.invalid/functions/canvasGetViewportPins', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('manager viewport API is tenant-bound, spatially bounded, and cursor paged', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM canvas_deployments')) {
      return [{ campaign_id: 'campaign-1', manager_id: 'manager-1', status: 'active', assignment_index_version: 7 }];
    }
    assert.match(sql, /p\.manager_id = \$2 AND p\.campaign_id = \$1/);
    assert.match(sql, /d\.manager_id = \$2 AND d\.active/);
    assert.match(sql, /ST_MakeEnvelope\(\$3, \$4, \$5, \$6, 4326\)/);
    assert.match(sql, /ORDER BY change_cursor DESC, record_id DESC/);
    assert.match(sql, /LIMIT \$9/);
    return [
      { record_kind: 'pin', change_cursor: 11, record_id: 'pin-1', payload: { pin_id: 'pin-1', house_key: 'house-1', point: { lat: 33.4, lng: -112.1 }, latest_outcome: 'sale', version: 2, dnc_active: false } },
      { record_kind: 'dnc', change_cursor: 12, record_id: 'dnc-1', payload: { suppression_id: 'dnc-1', house_key: 'house-2', point: { lat: 33.41, lng: -112.11 }, version: 1, set_at: '2026-08-14T00:00:00.000Z' } },
      { record_kind: 'pin', change_cursor: 13, record_id: 'sentinel', payload: {} },
    ];
  };
  const handler = loadViewport({ user: { id: 'manager-1', app_role: 'manager' }, query });
  const response = await handler(request({
    campaign_id: 'campaign-1',
    bounds: { west: -112.2, south: 33.3, east: -112.0, north: 33.5 },
    after_cursor: 99,
    after_id: 'previous',
    limit: 2,
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.has_more, true);
  assert.equal(body.next_cursor, 12);
  assert.equal(body.next_id, 'dnc-1');
  assert.equal(body.pins.length, 1);
  assert.equal(body.dnc.length, 1);
  assert.deepEqual(Array.from(calls[0].params), ['campaign-1', 'manager-1']);
  assert.deepEqual(Array.from(calls[1].params), ['campaign-1', 'manager-1', -112.2, 33.3, -112, 33.5, 99, 'previous', 3]);
});

test('viewport decisions reject reps and unsafe continental-scale bounds before SQL', async () => {
  let sqlCalls = 0;
  const query = async () => { sqlCalls += 1; return []; };
  const repHandler = loadViewport({ user: { id: 'rep-1', app_role: 'rep' }, query });
  const repResponse = await repHandler(request({ campaign_id: 'campaign-1', bounds: { west: -112.2, south: 33.3, east: -112, north: 33.5 } }));
  assert.equal(repResponse.status, 403);
  const managerHandler = loadViewport({ user: { id: 'manager-1', app_role: 'manager' }, query });
  const largeResponse = await managerHandler(request({ campaign_id: 'campaign-1', bounds: { west: -125, south: 24, east: -66, north: 50 } }));
  assert.equal(largeResponse.status, 400);
  assert.equal(sqlCalls, 0);
});

test('residential manager maps separate immutable geometry, summary totals, and viewport decisions', () => {
  assert.match(campaignMapSource, /session\.territory_model === "residential_street_territory_v2"[\s\S]*?body\?\.include_pins === false/);
  assert.match(campaignMapSource, /operationalViewport[\s\S]*?\{ rows: \[\], truncated: false \}/);
  assert.match(campaignMapSource, /decision_delivery: operationalViewport \? "operational_viewport" : "embedded"/);
  assert.match(clientSource, /getCanvasCampaignMap\(\{ campaignId, includeEvents = false, includePins = true \}/);
  assert.match(clientSource, /include_pins: includePins !== false/);
  assert.match(builderSource, /getCanvasCampaignMap\(\{ campaignId: id, includePins: !residentialV2 \}\)/);
  assert.match(builderSource, /getCanvasCampaignSummary\(\{ campaignId: id \}\)/);
  assert.match(builderSource, /progressOnly: true/);
  assert.match(builderSource, /CAMPAIGN_REFRESH_MS = 5 \* 60_000/);
  assert.match(layersSource, /getCanvasViewportPins/);
  assert.match(layersSource, /for \(let page = 0; page < 10; page \+= 1\)/);
  assert.match(layersSource, /map\.on\('moveend zoomend', schedule\)/);
  assert.match(layersSource, /5 \* 60_000/);
  assert.doesNotMatch(builderSource, /CAMPAIGN_REFRESH_MS = 15_000/);
});
