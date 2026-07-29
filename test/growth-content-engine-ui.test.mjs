import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const contentEngine = readFileSync(
  new URL('../src/components/acquisition/ContentEngineQueue.jsx', import.meta.url),
  'utf8',
);
const growthQueue = readFileSync(
  new URL('../src/components/acquisition/GrowthActionQueue.jsx', import.meta.url),
  'utf8',
);

test('content delivery UI prevents terminal retries when Buffer evidence exists', () => {
  assert.match(
    contentEngine,
    /terminalRetryAvailable[\s\S]*?!latestJob\.provider_post_id[\s\S]*?!activeJob/,
  );
  assert.match(contentEngine, /Create a new content ID before publishing again/);
  assert.match(contentEngine, /Buffer post ID: \{activeJob\.provider_post_id/);
  assert.match(contentEngine, /Queue for Buffer worker/);
});

test('content delivery UI uses cadence-aware Phoenix scheduling and bounded polling', () => {
  assert.match(
    contentEngine,
    /PHOENIX_CADENCE_SLOTS\s*=\s*\[\s*\[9,\s*30\],\s*\[13,\s*30\],\s*\[18,\s*30\]/,
  );
  assert.match(contentEngine, /function nextScheduleSlot\(jobs = \[\], now = Date\.now\(\), platform = ''\)/);
  assert.match(contentEngine, /local: nextScheduleSlot\(jobs, Date\.now\(\), artifact\.platform\)/);
  assert.match(contentEngine, /cadenceJobTimes\(jobs, platform\)/);
  assert.match(contentEngine, /FAST_POLLING_JOB_STATES[\s\S]*?return 10_000/);
  assert.match(contentEngine, /SLOW_POLLING_JOB_STATES[\s\S]*?return 60_000/);
  assert.match(contentEngine, /delivery_reconcile: 'Reconciling measurement plan'/);
  assert.match(
    contentEngine,
    /SLOW_POLLING_JOB_STATES\s*=\s*new Set\(\[[\s\S]*?'delivery_reconcile'/,
  );
  assert.match(contentEngine, /Buffer worker ready/);
  assert.match(contentEngine, /Worker heartbeat:/);
});

test('review and approval require a loaded, explicitly inspected rendition', () => {
  assert.match(contentEngine, /pathname\.includes\(sha256\)/);
  assert.doesNotMatch(contentEngine, /pathname\.includes\(sha256\.slice/);
  assert.match(contentEngine, /onLoadedMetadata=/);
  assert.match(contentEngine, /onLoad=/);
  assert.match(contentEngine, /Browser-loaded metadata matches the saved/);
  assert.match(
    contentEngine,
    /renditionInspected = mediaReady && mediaPreviewLoaded && renditionConfirmed/,
  );
  assert.match(contentEngine, /I inspected the loaded final rendition/);
  assert.match(contentEngine, /onClick=\{saveReview\}[\s\S]*?disabled=\{[^}]*!renditionInspected/);
  assert.match(
    contentEngine,
    /action: 'approve'[\s\S]*?disabled=\{[^}]*!renditionInspected/,
  );
});

test('attribution and canceled-plan copy do not overstate measurement', () => {
  assert.match(contentEngine, /Instagram caption URLs are not reliably clickable/);
  assert.match(contentEngine, /controlled bio, Story, comment\/DM, or \/start handoff/);
  assert.match(growthQueue, /summary\.canceled/);
  assert.match(growthQueue, /No publish action/);
  assert.match(growthQueue, /before treating the sprint as published/);
});
