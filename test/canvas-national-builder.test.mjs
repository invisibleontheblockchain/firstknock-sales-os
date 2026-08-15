import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const builder = fs.readFileSync('src/components/map/CanvasBuilderSettings.jsx', 'utf8');
const workspace = fs.readFileSync('src/components/map/CanvasPlannerWorkspace.jsx', 'utf8');
const plannerUtils = fs.readFileSync('src/components/canvas/canvasPlannerUtils.js', 'utf8');
const residentialLayers = fs.readFileSync('src/components/map/CanvasResidentialAnalysisLayers.jsx', 'utf8');
const saveDraft = fs.readFileSync('base44/functions/canvasSaveDraft/entry.ts', 'utf8');
const precisionPlanner = fs.readFileSync('src/components/map/RouteBuilderSettings.jsx', 'utf8');

test('Canvas builder uses the signed analysis control plane and never browser Overpass', () => {
  assert.match(builder, /analyzeCanvasBoundary\(/);
  assert.match(builder, /getCanvasAnalysis\(/);
  assert.doesNotMatch(builder, /fetchOverpassRoadNetwork|overpassRoadNetwork|CANVAS_OVERPASS/);
  assert.match(builder, /production_trusted/);
  assert.match(builder, /clearPersistedCanvasAnalysisJob/);
});

test('area count changes reuse evidence and only rerun the connected residential partitioner', () => {
  assert.match(builder, /await partitionCanvasResidentialTerritoriesAsync\(\{/);
  assert.match(builder, /street_units: planResidentialStreetUnits\(requestSnapshot\.residentialAnalysis\)/);
  assert.match(builder, /setLivePreviewRevision\(\(current\) => current \+ 1\)/);
  assert.doesNotMatch(builder, /\[polygonKey, roadFetchNonce, requestedZoneCount/);
  assert.match(workspace, /without downloading the evidence again/);
});

test('manager workflow is count-only, assignment-later, and explains residential workload', () => {
  assert.match(workspace, /Choose the number of areas/);
  assert.match(workspace, /Assign reps later in Areas & Assignments/);
  assert.match(workspace, /Likely homes/);
  assert.match(workspace, /fields or commercial land zero knocking workload/);
  assert.match(workspace, /Residential streets/);
  assert.doesNotMatch(workspace, /Equal land reference/);
});

test('amber evidence is reviewed from the map without blocking previews or draft saves', () => {
  assert.match(workspace, /Tap an amber street on the map to review it/);
  assert.match(workspace, /You can preview and save now\. Before sending/);
  assert.match(workspace, /Residential homes/);
  assert.match(workspace, /Travel only/);
  assert.match(workspace, /Likely knockable homes/);
  assert.match(builder, /applyCanvasClassificationOverride\(\{/);
  assert.match(builder, /getCanvasAnalysis\(\{ evidenceId, revisionId, useRevisionHead: false \}\)/);
  assert.match(builder, /partitionCanvasResidentialTerritoriesAsync\(\{/);
  assert.match(residentialLayers, /detail: \{ unitId: selectedUnitIdRef\.current \}/);
  assert.match(residentialLayers, /event\.detail\?\.unitId/);
});

test('residential drafts preserve pinned evidence and zero-workload context units', () => {
  assert.match(plannerUtils, /residential_street_territory_v2/);
  assert.match(plannerUtils, /evidence_release_id/);
  assert.match(plannerUtils, /snapshot_hash/);
  assert.match(plannerUtils, /ownershipUnits = residentialV2 \? workUnits\.filter/);
  assert.match(saveDraft, /CanvasAnalysisSnapshot\.filter/);
  assert.match(saveDraft, /productionEvidenceTrusted/);
  assert.match(saveDraft, /saved_unassigned/);
  assert.match(saveDraft, /residential_opportunity/);
});

test('Canvas work remains isolated from Precision planning', () => {
  assert.doesNotMatch(builder, /SavedRoute|FetchJob|precision_usage|RouteBuilderSettings/);
  assert.doesNotMatch(saveDraft, /SavedRoute|FetchJob|NEON_DATABASE_URL|DATABASE_URL/);
  assert.doesNotMatch(precisionPlanner, /canvas_analysis|residential_street_territory_v2|CanvasAnalysisSnapshot/);
});
