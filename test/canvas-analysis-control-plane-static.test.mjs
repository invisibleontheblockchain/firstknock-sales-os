import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(testDirectory, '..');
const names = [
  'canvasStartAnalysis',
  'canvasGetAnalysisStatus',
  'canvasCancelAnalysis',
  'canvasGetAnalysis',
];
const source = (name) => readFileSync(resolve(rootDirectory, `base44/functions/${name}/entry.ts`), 'utf8');

test('Canvas analysis adapters use one server-owned HTTPS service and never public Overpass or Precision storage', () => {
  for (const name of names) {
    const code = source(name);
    assert.match(code, /CANVAS_ANALYSIS_SERVICE_URL/);
    assert.match(code, /CANVAS_ANALYSIS_SERVICE_TOKEN/);
    assert.match(code, /url\.protocol !== ["']https:["']/);
    assert.match(code, /authorization["']?: `Bearer \$\{config\.token\}`/);
    assert.match(code, /redirect: ["']error["']/);
    assert.match(code, /AbortController/);
    assert.match(code, /MAX_RESPONSE|MAX_SERVICE_RESPONSE/);
    assert.match(code, /manager_id: user\.id/);
    assert.doesNotMatch(code, /OVERPASS|CANVAS_OVERPASS|overpass-api|@neondatabase|DATABASE_URL/);
    assert.doesNotMatch(code, /entities\.User|Precision|MasterProperty|FetchJob/);
    assert.doesNotMatch(code, /from ["']\.\.?\//, `${name} must remain a self-contained Base44 isolate`);
  }
});

test('browser-controlled fields cannot choose evidence providers, releases, manifests, or worker locations', () => {
  const start = source('canvasStartAnalysis');
  assert.match(start, /new Set\(\[["']polygon["'], ["']area_count["'], ["']retry_failed_job["']\]\)/);
  assert.match(start, /purpose: ["']firstknock-canvas-analysis-v1["']/);
  assert.match(start, /const jobId = `canvas_analysis_job_\$\{requestHash\}`/);
  assert.match(start, /MAX_AREA_SQ_MI = 1_000/);
  assert.match(start, /idempotency-key["']?: jobId/);
  assert.doesNotMatch(start, /body\??\.(?:provider|provider_url|service_url|manifest_url|manifest_hash|release_id|tile_ids|worker_job_id)/);
  for (const name of ['canvasGetAnalysisStatus', 'canvasCancelAnalysis']) {
    assert.match(source(name), /Object\.keys\(body\).*key !== ["']job_id["']/s);
  }
  const get = source('canvasGetAnalysis');
  assert.match(get, /new Set\(\[["']job_id["'], ["']evidence_id["'], ["']revision_id["'], ["']use_revision_head["']\]\)/);
  assert.doesNotMatch(get, /body\??\.(?:provider|provider_url|service_url|manifest_url|manifest_hash|release_id|tile_ids|worker_job_id)/);
});

test('analysis jobs and immutable snapshots are always tenant-filtered and integrity checked', () => {
  const start = source('canvasStartAnalysis');
  const status = source('canvasGetAnalysisStatus');
  const cancel = source('canvasCancelAnalysis');
  const get = source('canvasGetAnalysis');
  for (const code of [start, status, cancel, get]) {
    assert.match(code, /CanvasAnalysisJob\.filter\([\s\S]*?manager_id: user\.id/);
  }
  assert.match(get, /CanvasAnalysisSnapshot\.filter\([\s\S]*?manager_id: user\.id/);
  assert.match(get, /canvas_analysis_service_digest_mismatch/);
  assert.match(get, /MAX_INLINE_RESULT_BYTES = 5_500_000/);
  assert.match(get, /CanvasAnalysisSnapshot\.create\(snapshot\)/);
  assert.doesNotMatch(get, /CanvasAnalysisSnapshot\.(?:update|updateMany|delete)/);
  assert.match(status, /canvas_analysis_service_invalid_transition/);
  assert.match(cancel, /cancelled_by_user_id: String\(user\.id\)/);
});
