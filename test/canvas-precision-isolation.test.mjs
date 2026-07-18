import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('Canvas uses a separate planner and production API lane', async () => {
  const [builder, planner, client] = await Promise.all([
    source('src/components/map/CanvasBuilderSettings.jsx'),
    source('src/components/logic/canvasStreetTerritoryPlanner.js'),
    source('src/components/canvas/canvasProductionClient.js'),
  ]);

  assert.match(builder, /generateStreetPlan = planCanvasTerritories/);
  assert.doesNotMatch(builder, /generateCanvasZones|BatchData|FetchJob/);
  assert.doesNotMatch(planner, /generateCanvasZones|h3-js|BatchData|FetchJob|precision/i);
  assert.match(client, /canvasSaveDraft/);
  assert.match(client, /canvasDeployCampaign/);
  assert.match(client, /canvasGetMyAssignments/);
  assert.match(client, /canvasLogHouseDecision/);
  assert.match(client, /canvasGetCampaignMap/);
  assert.doesNotMatch(client, /localStorage|SavedRoute|Property/);
});

test('Canvas branches before the existing Precision builder without replacing it', async () => {
  const routeBuilder = await source('src/components/map/RouteBuilderSettings.jsx');
  const canvasBranch = routeBuilder.indexOf("if (routeMode === 'canvas' && hasCanvasAccess(user))");
  const precisionBuilder = routeBuilder.indexOf('const resetFilters = () =>');

  assert.ok(canvasBranch >= 0, 'Canvas must have an explicit entitled branch');
  assert.ok(precisionBuilder > canvasBranch, 'The existing Precision builder must remain after the Canvas branch');
  assert.match(routeBuilder, /localStorage\.setItem\('fk_routeMode', 'precision'\)/);
  assert.match(routeBuilder, /Start Paid Pull/);
});

test('Canvas territory and outcome overlays render once and legacy map layers remain Precision-only', async () => {
  const [managerLayers, drawTool, overlay] = await Promise.all([
    source('src/components/map/ManagerMapLayers.jsx'),
    source('src/components/map/MapDrawTool.jsx'),
    source('src/components/map/CanvasZoneOverlay.jsx'),
  ]);

  assert.equal((managerLayers.match(/<CanvasZoneOverlay\b[^>]*\/>/g) || []).length, 1);
  assert.match(managerLayers, /routeMode !== 'canvas'/);
  assert.doesNotMatch(drawTool, /CanvasZoneOverlay/);
  assert.doesNotMatch(overlay, /localStorage|sessionStorage/);
  assert.match(overlay, /CanvasCampaignMapLayers/);
  assert.doesNotMatch(overlay, /CanvasOpportunityLayers/);
});

test('rep Canvas handoff is server-authorized and has no name or local deployment fallback', async () => {
  const [repHome, fieldView] = await Promise.all([
    source('src/pages/RepHome.jsx'),
    source('src/components/rep/CanvasFieldView.jsx'),
  ]);

  assert.match(repHome, /getMyCanvasAssignments\(\)/);
  assert.doesNotMatch(repHome, /fk_canvasCampaignSprint1|fk_canvasRosterSprint1/);
  assert.doesNotMatch(fieldView, /localStorage|assigned_to_name|\.filter\([^)]*email/i);
  assert.doesNotMatch(fieldView, /stable_door_id|server-assigned homes|preloaded/i);
  assert.match(fieldView, /logCanvasHouseDecision/);
  assert.match(fieldView, /useMapEvents/);
  assert.match(fieldView, /queueCanvasDecision/);
  assert.match(fieldView, /pending on this device and is not shared yet/);
  assert.match(repHome, /enabled: !!user/);
  assert.match(repHome, /canvasFieldOpen/);
  assert.match(repHome, /refetchInterval: canvasFieldOpen \|\| \(!activeRoute && !canvasFieldDismissed\) \? CANVAS_ASSIGNMENT_POLL_MS : false/);
  assert.match(repHome, /completed, recalled, or replaced/);
  assert.match(fieldView, /normalizedAssignments\.some\(\(item\) => item\.__key === selectedAssignmentKey\)/);
  assert.match(repHome, /return activeRoutes;/);
});

test('Canvas has no house-analysis UI gate and Home owns the authorized mode', async () => {
  const [builder, home, managerLayers, territoryPrompt] = await Promise.all([
    source('src/components/map/CanvasBuilderSettings.jsx'),
    source('src/pages/Home.jsx'),
    source('src/components/map/ManagerMapLayers.jsx'),
    source('src/components/map/TerritoryPrompt.jsx'),
  ]);

  assert.doesNotMatch(builder, /canvasAnalyzeTerritory|CanvasOpportunityReview|canvasAnalysisStore|stable home|homes per area/i);
  assert.match(builder, /workload_basis: 'street_length'/);
  assert.match(builder, /How many people are working this area/);
  assert.match(home, /routeMode=\{routeMode\}/);
  assert.match(home, /routeMode !== 'canvas' \|\| hasCanvasAccess\(user\)/);
  assert.doesNotMatch(managerLayers, /localStorage\.getItem\('fk_routeMode'\)/);
  assert.doesNotMatch(territoryPrompt, /Analyze homes/);
  assert.match(territoryPrompt, /routeMode === 'precision' && !pulling && recoverableJob/);
  assert.match(territoryPrompt, /routeMode === 'precision' && pulling/);
});

test('Canvas and Precision retain independent freehand boundaries', async () => {
  const home = await source('src/pages/Home.jsx');
  assert.match(home, /const \[canvasDrawnPolygon, setCanvasDrawnPolygon\] = useState\(null\)/);
  assert.match(home, /routeMode === 'canvas' \? canvasDrawnPolygon : drawnPolygon/);
  assert.match(home, /if \(routeMode === 'canvas'\) setCanvasDrawnPolygon\(value\)/);
  assert.match(home, /drawnPolygon=\{activeDrawnPolygon\}/);
  assert.match(home, /setDrawnPolygon=\{setActiveDrawnPolygon\}/);
  assert.match(home, /routeMode === 'precision' && !drawingMode/);
  assert.match(home, /onResumeBoundary=\{\(savedBoundary\) => \{/);
  assert.match(home, /setCanvasDrawnPolygon\(validation\.points\)/);
});
