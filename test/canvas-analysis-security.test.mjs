import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

test('Canvas analysis endpoints require manager access and object ownership', () => {
  const getAnalysis = readSource('base44/functions/canvasGetAnalysis/entry.ts');
  const feedback = readSource('base44/functions/canvasFeedback/entry.ts');
  const analyze = readSource('base44/functions/canvasAnalyzeTerritory/entry.ts');

  for (const source of [getAnalysis, feedback, analyze]) {
    assert.match(source, /canManageCanvas\(user\)/);
    assert.match(source, /Manager access required/);
  }

  assert.match(getAnalysis, /WHERE id = \$\{analysisId\} AND manager_id = \$\{user\.id\}/);
  assert.match(getAnalysis, /a\.manager_id = \$\{user\.id\}/);
  assert.match(feedback, /WHERE id = \$\{analysisId\} AND manager_id = \$\{user\.id\}/);
});

test('Canvas analysis enforces polygon and feedback resource limits', () => {
  const analyze = readSource('base44/functions/canvasAnalyzeTerritory/entry.ts');
  const feedback = readSource('base44/functions/canvasFeedback/entry.ts');

  assert.match(analyze, /areaSqMi > MAX_AREA_SQ_MI/);
  assert.match(analyze, /Maximum \$\{MAX_AREA_SQ_MI\} square miles/);
  assert.match(analyze, /polygonSelfIntersects\(points\)/);
  assert.match(analyze, /boundary crosses or touches itself/);
  assert.match(feedback, /MAX_FEEDBACK_NOTES_LENGTH = 2000/);
  assert.match(feedback, /notes\.length > MAX_FEEDBACK_NOTES_LENGTH/);
});

test('Canvas manager campaign index is bounded, caller-scoped, and summary-only', () => {
  const listCampaigns = readSource('base44/functions/canvasListCampaigns/entry.ts');
  assert.match(listCampaigns, /CanvasSession\.filter\(\s*\{ manager_id: user\.id \}/);
  assert.match(listCampaigns, /MAX_CAMPAIGNS = 500/);
  assert.match(listCampaigns, /verifyCanvasLifecycleSession\(signingSecret, session, requiredState\)/);
  assert.equal(
    readSource('base44/functions/canvasListCampaigns/canvasLifecycleSignature.js'),
    readSource('base44/functions/canvasDeployCampaign/canvasLifecycleSignature.js')
  );
  assert.match(listCampaigns, /session\?\.manager_id[\s\S]*user\.id/);
  assert.doesNotMatch(listCampaigns, /asServiceRole/);
  assert.doesNotMatch(listCampaigns, /doors:\s*session\.doors|zones:\s*session\.zones/);
});
