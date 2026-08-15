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
const acquisitionLanding = readFileSync(
  new URL('../src/components/marketing/InstagramLanding.jsx', import.meta.url),
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
  assert.match(growthDashboard, /static profile-link traffic stays platform-level/);
  assert.match(growthDashboard, /Assist L \/ S \/ A/);
  assert.match(growthDashboard, /Excluded from winner decisions/);
  assert.doesNotMatch(growthDashboard, /Compare the exact stage/);
  assert.match(acquisitionLanding, /Which demo brought you here\?/);
  assert.match(acquisitionLanding, /getRecentGrowthContentChoices/);
  assert.match(acquisitionLanding, /content_assist_reported/);
  assert.match(
    acquisitionLanding,
    /const landingJourneyCapturedAt = React\.useMemo\(/,
  );
  assert.match(
    acquisitionLanding,
    /expectedCapturedAt: landingJourneyCapturedAt/,
  );
  assert.doesNotMatch(
    acquisitionLanding,
    /expectedCapturedAt: stored\?\.last_touch\?\.captured_at/,
  );
  assert.match(
    acquisitionLanding,
    /touchOverride: landingTouch[\s\S]*?useStoredTouch: false/,
  );
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
  assert.match(contentEngine, /content_profile: draft\.content_profile/);
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

test('measured batch builder recommends and locks the two-video feature explainer profile', () => {
  assert.match(
    contentEngine,
    /content_profile: FEATURE_EXPLAINER_VIDEO_PROFILE[\s\S]*?concept_count: '2'/,
  );
  assert.match(contentEngine, /Video feature explainer · Recommended/);
  assert.match(
    contentEngine,
    /value=\{draft\.concept_count\}[\s\S]*?disabled=\{featureExplainerSelected\}/,
  );
  assert.match(contentEngine, /Locked to two concepts/);
  assert.match(contentEngine, /publish-candidate video or image donors/);
  assert.match(contentEngine, /14 for a seven-day rotation/);
  assert.match(contentEngine, /Every platform rendition still exports as video/);
  assert.match(contentEngine, /Build two video explainers/);
});

test('owner UI can start the bounded audited week before measured evidence exists', () => {
  assert.match(contentEngine, /Start audited week/);
  assert.match(contentEngine, /Start the audited first week/);
  assert.match(contentEngine, /No LLM is called and no fake performance evidence is created/);
  assert.match(contentEngine, /action: 'build_audited_bootstrap_batch'/);
  assert.match(contentEngine, /bootstrap_acknowledged: true/);
  assert.match(contentEngine, /authorization_note: normalizedBootstrapNote/);
  assert.match(contentEngine, /content_profile: FEATURE_EXPLAINER_VIDEO_PROFILE/);
  assert.match(contentEngine, /concept_count: 2/);
  assert.match(contentEngine, /bootstrapBatchCount >= 7/);
  assert.match(contentEngine, /Audited bootstrap: \$\{bootstrapBatchCount\}\/7/);
  assert.match(contentEngine, /seven-day cap/);
  assert.match(contentEngine, /does not host media/);
  assert.match(contentEngine, /batch\.batch_input_mode === 'audited_seed_bootstrap'/);
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

test('strict video batches use one explicit, resumable, sequential activation flow', () => {
  assert.match(
    contentEngine,
    /import\s*\{[\s\S]*?growthBatchScheduleRequest[\s\S]*?inspectGrowthBatchActivation[\s\S]*?\}\s*from '@\/lib\/growthBatchActivation'/,
  );
  assert.match(contentEngine, /Activate two daily videos/);
  assert.match(contentEngine, /Activate 4 posts/);
  assert.match(contentEngine, /Resume \$\{4 - activation\.protected_count\} posts/);
  assert.match(contentEngine, /I reviewed and approved all four exact renditions/);
  assert.match(contentEngine, /including any silent audio[\s\S]*?without a native-app finishing step/);
  assert.match(
    contentEngine,
    /const refreshed = await query\.refetch\(\)[\s\S]*?inspectGrowthBatchActivation\([\s\S]*?schedule_candidates\.map[\s\S]*?for \(let index = 0; index < requests\.length; index \+= 1\)[\s\S]*?await base44\.functions\.invoke/,
  );
  assert.match(
    contentEngine,
    /action: 'preflight_batch_activation'[\s\S]*?batch_key: batchKey[\s\S]*?preflightArtifactIds[\s\S]*?expectedArtifactIds/,
  );
  assert.match(contentEngine, /This preflight is not an\s*external-provider transaction/);
  assert.doesNotMatch(
    contentEngine,
    /Promise\.all\(\s*requests\.map/,
  );
  assert.match(contentEngine, /Activation stopped after \$\{protectedCount\} of 4 posts were protected/);
  assert.match(
    contentEngine,
    /<MeasuredBatchPanel[\s\S]*?artifacts=\{artifacts\}[\s\S]*?jobs=\{jobs\}[\s\S]*?activationBusy=\{batchActivation\.isPending\}/,
  );
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
  assert.match(contentEngine, /needs 2 distinct safe, publish-candidate video or image donors now/);
  assert.match(contentEngine, /14 for a seven-day rotation/);
  assert.match(
    contentEngine,
    /FEATURE_EXPLAINER_SOURCE_KINDS = new Set\(\['video', 'image'\]\)/,
  );
  assert.match(
    contentEngine,
    /growthToken\(current\?\.media_kind\) !== requirement\.media_kind/,
  );
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
    /function seedDonorRequirements\(pack, contentProfile[\s\S]*?rights_status\) !== 'firstknock_owned'/,
  );
  assert.match(
    contentEngine,
    /function seedDonorRequirements\(pack, contentProfile[\s\S]*?distribution_state\) !== 'publish_candidate'/,
  );
  assert.match(
    contentEngine,
    /function seedSourceReadiness\([\s\S]*?registeredSources,[\s\S]*?conceptCount,[\s\S]*?privacy_status\) !== 'safe'[\s\S]*?source_reference[\s\S]*?source_sha256/,
  );
  assert.match(contentEngine, /if \(!selectedParent \|\| !draft\.seed_pack \|\| !seedSources\.ready\) return/);
  assert.match(
    contentEngine,
    /disabled=\{[\s\S]*?!generationReady[\s\S]*?!eligibleParents\.length[\s\S]*?busy/,
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
