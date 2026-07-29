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
const growthDashboard = readFileSync(
  new URL('../src/pages/GrowthDashboard.jsx', import.meta.url),
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
  assert.match(
    contentEngine,
    /local: measuredBatchScheduleLocal\(artifact\)[\s\S]*?\|\| nextScheduleSlot\(jobs, Date\.now\(\), artifact\.platform\)/,
  );
  assert.match(contentEngine, /morning: '09:30'[\s\S]*?midday: '13:30'[\s\S]*?evening: '18:30'/);
  assert.match(contentEngine, /disabled=\{Boolean\(measuredBatchScheduleLocal\(artifact\)\)\}/);
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
  assert.match(contentEngine, /neutral \/start URL/);
  assert.match(contentEngine, /controlled TikTok profile-link or comment\/DM handoff/);
  assert.match(contentEngine, /Verify a clickable profile-link or comment\/DM handoff/);
  assert.match(growthQueue, /summary\.canceled/);
  assert.match(growthQueue, /No publish action/);
  assert.match(growthQueue, /before treating the sprint as published/);
});

test('measured batch builder only offers current repeat or iterate evidence', () => {
  assert.match(
    contentEngine,
    /item\?\.state === 'reviewed'[\s\S]*?item\?\.decision_stale !== true[\s\S]*?\['repeat', 'iterate'\]\.includes\(item\?\.decision\)/,
  );
  assert.match(contentEngine, /action: 'build_next_batch'/);
  assert.match(
    contentEngine,
    /parent:\s*\{[\s\S]*?platform: selectedParent\.platform[\s\S]*?campaign: selectedParent\.campaign[\s\S]*?content: selectedParent\.content/,
  );
  assert.match(contentEngine, /target_date: draft\.target_date/);
  assert.match(contentEngine, /concept_count: Number\(draft\.concept_count\)/);
  assert.match(growthDashboard, /contentQueue=\{report\?\.content_queue\}/);
  assert.match(
    contentEngine,
    /<MeasuredBatchPanel[\s\S]*?contentQueue=\{contentQueue\}[\s\S]*?sources=\{sources\}[\s\S]*?batches=\{batches\}/,
  );
});

test('measured batch builder defaults to the next Phoenix day and accepts either trusted seed schema', () => {
  assert.match(contentEngine, /function nextPhoenixTargetDate\(now = Date\.now\(\)\)/);
  assert.match(contentEngine, /return phoenixDayKey\(now \+ DAY_MS\)/);
  assert.match(
    contentEngine,
    /value\?\.schema_version === 'growth-render-result\.v1'[\s\S]*?\? value\?\.pack[\s\S]*?: value/,
  );
  assert.match(contentEngine, /pack\?\.schema_version !== 'growth-render-pack\.v1'/);
  assert.match(contentEngine, /seed_pack: draft\.seed_pack/);
  assert.match(contentEngine, /2 per platform · 4 artifacts/);
  assert.match(contentEngine, /3 per platform · 6 artifacts/);
});

test('measured batches can be downloaded, owner-authorized, and revoked without publishing', () => {
  assert.match(contentEngine, /action: 'get_batch'/);
  assert.match(contentEngine, /result\?\.pack_sha256 !== batch\.canonical_pack_sha256/);
  assert.match(contentEngine, /Download JSON/);
  assert.match(contentEngine, /action: isAuthorization \? 'authorize_batch' : 'revoke_batch'/);
  assert.match(contentEngine, /expected_pack_sha256: batchDecision\.batch\.canonical_pack_sha256/);
  assert.match(contentEngine, /inspection_acknowledged: true/);
  assert.match(contentEngine, /batchDecision\.acknowledged/);
  assert.match(contentEngine, /Authorization and import do not publish/);
  assert.match(contentEngine, /normal four-gate review/);
  assert.match(contentEngine, /exact-revision owner approval/);
});

test('render import opens for static trust or authorized measured-batch trust', () => {
  assert.match(
    contentEngine,
    /const staticRenderImportReady = capabilities\.render_result_import_ready === true/,
  );
  assert.match(
    contentEngine,
    /capabilities\.authorized_batch_import_ready === true[\s\S]*?Number\(summary\.batches_authorized \|\| 0\) > 0/,
  );
  assert.match(
    contentEngine,
    /const locallyAuthorizedBatchImportAvailable = \([\s\S]*?capabilities\.authorized_batch_import_ready === true[\s\S]*?batches_authorized/,
  );
  assert.match(
    contentEngine,
    /const renderImportAvailable = \([\s\S]*?staticRenderImportReady \|\| locallyAuthorizedBatchImportAvailable/,
  );
  assert.match(contentEngine, /disabled=\{!sources\.length \|\| !renderImportAvailable/);
  assert.match(contentEngine, /Locally authorized batch; server revalidates on import/);
  assert.doesNotMatch(contentEngine, /Authorized batch import ready/);
  assert.match(contentEngine, /Batches ready/);
  assert.match(contentEngine, /Batches authorized/);
});

test('measured batch UI makes the starter donor-capacity boundary explicit', () => {
  assert.match(contentEngine, /current 5 safe donors cover about 2 days at 2 concepts per day/);
  assert.match(contentEngine, /needs 14 safe donors at 2\/day or 21 at 3\/day/);
  assert.match(contentEngine, /Hold and stale decisions cannot seed a batch/);
});

test('measured batch states participate in bounded content-engine polling', () => {
  assert.match(
    contentEngine,
    /function contentEngineRefetchInterval\(data\)[\s\S]*?const batches = data\?\.batches \|\| \[\][\s\S]*?batch\?\.state === 'generating'[\s\S]*?return 10_000/,
  );
  assert.match(
    contentEngine,
    /refetchInterval: \(currentQuery\) => contentEngineRefetchInterval\(currentQuery\.state\.data\)/,
  );
});

test('seed manifests stay within the whole-request budget and require exact safe donor registrations', () => {
  assert.match(contentEngine, /const MAX_SEED_MANIFEST_BYTES = 150_000/);
  assert.match(contentEngine, /file\.size > MAX_SEED_MANIFEST_BYTES/);
  assert.match(contentEngine, /Seed manifest must be 150 KB or smaller/);
  assert.match(
    contentEngine,
    /function seedDonorRequirements\(pack\)[\s\S]*?rights_status\) !== 'firstknock_owned'/,
  );
  assert.match(
    contentEngine,
    /function seedDonorRequirements\(pack\)[\s\S]*?distribution_state\) !== 'publish_candidate'/,
  );
  assert.match(
    contentEngine,
    /function seedSourceReadiness\(pack, registeredSources, conceptCount\)[\s\S]*?privacy_status\) !== 'safe'[\s\S]*?source_reference[\s\S]*?source_sha256/,
  );
  assert.match(contentEngine, /if \(!selectedParent \|\| !draft\.seed_pack \|\| !seedSources\.ready\) return/);
  assert.match(
    contentEngine,
    /disabled=\{[\s\S]*?!generationReady[\s\S]*?!hasRegisteredSafeSource[\s\S]*?busy/,
  );
  assert.match(contentEngine, /\|\| !seedSources\.ready/);
  assert.match(contentEngine, /Load the audited source inventory before building/);
});

test('batch authorization and revocation notes use the backend 500-character compact-text contract', () => {
  assert.match(contentEngine, /const MAX_BATCH_NOTE_LENGTH = 500/);
  assert.match(
    contentEngine,
    /function compactBatchNote\(value\)[\s\S]*?\.trim\(\)[\s\S]*?\.replace\(\/\\s\+\/g, ' '\)[\s\S]*?\.slice\(0, MAX_BATCH_NOTE_LENGTH\)/,
  );
  assert.match(contentEngine, /const note = compactBatchNote\(batchDecision\.note\)/);
  assert.match(contentEngine, /maxLength=\{MAX_BATCH_NOTE_LENGTH\}/);
  assert.match(contentEngine, /note: normalizeBatchNoteInput\(event\.target\.value\)/);
  assert.match(contentEngine, /\{normalizedDecisionNote\.length\}\/\{MAX_BATCH_NOTE_LENGTH\} normalized characters/);
  assert.match(contentEngine, /note,\s*\n\s*\}, \{/);
});
