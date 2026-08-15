import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACTIVATION_HANDOFF_SCHEMA,
  FIRSTKNOCK_MEDIA_ORIGIN,
  FIRSTKNOCK_MEDIA_PATH_PREFIX,
  FIRSTKNOCK_GENERATOR_URL,
  FIRSTKNOCK_WORKER_URL,
  buildGrowthActivationHandoff,
  parseActivationHandoffArguments,
  prepareGrowthActivationHandoff,
} from '../scripts/prepare-growth-activation-handoff.mjs';
import {
  CANONICAL_GROWTH_TARGET,
  READINESS_SCHEMA,
} from '../scripts/check-growth-production-readiness.mjs';

const repositoryRoot = resolve(
  fileURLToPath(new URL('..', import.meta.url)),
);
const scriptPath = join(
  repositoryRoot,
  'scripts',
  'prepare-growth-activation-handoff.mjs',
);

function check(id, status, code, evidence) {
  return {
    id,
    status,
    code,
    ...(evidence ? { evidence } : {}),
  };
}

function selectedGate(id, status, checks) {
  return { id, status, checks };
}

function readinessReport({
  repositoryStatus = 'fail',
  repositoryCode = 'growth_publisher_workflow_not_tracked',
  localStatus = 'pass',
  localCount = 28,
  hostingStatus = 'not_proven',
  hostingCode = 'hosting_authorization_pending',
} = {}) {
  const gates = [
    selectedGate('activatable_batch', 'not_proven', [
      check(
        'production_batch_preflight',
        'not_proven',
        'activatable_batch_not_proven',
      ),
    ]),
    selectedGate('hosted_media', 'not_proven', [
      check('hosted_origin_bytes', 'not_proven', 'hosted_result_missing'),
    ]),
    selectedGate('hosting_authorization', hostingStatus, [
      check(
        'hosting_authorization',
        hostingStatus,
        hostingCode,
      ),
    ]),
    selectedGate('local_immutable_media', localStatus, [
      check(
        'local_media_bytes',
        localStatus,
        localStatus === 'pass'
          ? 'local_media_bytes_verified'
          : 'local_media_bytes_invalid',
        { verified_count: localCount },
      ),
    ]),
    selectedGate('production_runtime', 'not_proven', [
      check(
        'deployed_runtime_configuration',
        'not_proven',
        'production_runtime_not_proven',
      ),
    ]),
    selectedGate('repository_contract', repositoryStatus, [
      check(
        'growth_publisher_workflow_tracked',
        repositoryStatus,
        repositoryCode,
      ),
    ]),
    selectedGate('scheduler_default_branch', 'not_proven', [
      check(
        'default_branch_scheduler_deployment',
        'not_proven',
        'scheduler_default_branch_not_proven',
      ),
    ]),
    selectedGate('scheduled_generation_runtime', 'not_proven', [
      check(
        'growth_generator_default_branch_deployment',
        'not_proven',
        'growth_generator_default_branch_not_proven',
      ),
      check(
        'growth_generator_enablement',
        'not_proven',
        'scheduled_generation_enablement_not_proven',
      ),
      check(
        'growth_generator_runtime_configuration',
        'not_proven',
        'scheduled_generation_runtime_not_proven',
      ),
    ]),
  ];
  const blockers = gates
    .flatMap((item) => item.checks)
    .filter((item) => item.status !== 'pass')
    .map((item) => item.code)
    .sort();
  return {
    schema_version: READINESS_SCHEMA,
    overall: 'blocked',
    target: {
      batch_id: CANONICAL_GROWTH_TARGET.batchId,
      pack_sha256: CANONICAL_GROWTH_TARGET.packSha256,
      render_result_sha256:
        CANONICAL_GROWTH_TARGET.renderResultSha256,
      renderer_environment_sha256:
        CANONICAL_GROWTH_TARGET.rendererEnvironmentSha256,
    },
    gates,
    blockers,
    warnings: [],
  };
}

function handoffInputs(root = 'C:\\private\\growth') {
  return {
    manifestPath: join(root, 'weekly-pack.json'),
    renderResultPath: join(root, 'weekly.render-result.json'),
    renderOutput: root,
    hostingReviewPath: join(root, 'weekly.hosting-review.json'),
  };
}

test('handoff deterministically binds exact evidence without granting an external action', () => {
  const inputs = handoffInputs();
  const first = buildGrowthActivationHandoff({
    readiness: readinessReport(),
    ...inputs,
  });
  const second = buildGrowthActivationHandoff({
    readiness: readinessReport(),
    ...inputs,
  });

  assert.deepEqual(second, first);
  assert.equal(first.schema_version, ACTIVATION_HANDOFF_SCHEMA);
  assert.equal(first.execution_policy.external_side_effects_performed, false);
  assert.equal(first.execution_policy.secrets_read_or_stored, false);
  assert.equal(first.execution_policy.activation_authorized, false);
  assert.equal(first.execution_policy.executable, false);
  assert.equal(first.local_evidence.verified_publish_candidate_count, 28);
  assert.equal(
    first.local_evidence.hosting_authorization,
    'pending_owner_authorization',
  );
  assert.equal(first.stages.length, 11);
  assert.deepEqual(
    first.stages.map((stage) => stage.order),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.equal(
    first.authorization_boundaries.find(
      (item) => item.id === 'daily_batch_activation',
    ).state,
    'not_granted_by_handoff',
  );
  assert.equal(
    first.authorization_boundaries.find(
      (item) => item.id === 'scheduled_generation_enablement',
    ).state,
    'not_granted_by_handoff',
  );
  const generationStage = first.stages.find(
    (stage) => stage.id === 'enable_measured_manifest_scheduler',
  );
  assert.equal(generationStage.output_state, 'unrendered_ready');
  assert.equal(
    generationStage.input_state,
    'growth_review_v3_repeat_or_iterate_supported_by_growth_decision_sufficiency_v1',
  );
  assert.equal(
    generationStage.automatic_actions_completed.includes(
      'recompute_and_bind_supported_decision_policy',
    ),
    true,
  );
  assert.equal(
    generationStage.automatic_actions_not_performed.includes('render_media'),
    true,
  );
  assert.equal(
    generationStage.automatic_actions_not_performed.includes('publication'),
    true,
  );

  const runtimeByName = new Map(
    first.runtime_configuration.map((item) => [item.name, item]),
  );
  assert.equal(
    runtimeByName.get('GROWTH_MEDIA_ORIGIN').required_value,
    FIRSTKNOCK_MEDIA_ORIGIN,
  );
  assert.equal(
    runtimeByName.get('GROWTH_MEDIA_PATH_PREFIX').required_value,
    FIRSTKNOCK_MEDIA_PATH_PREFIX,
  );
  assert.equal(runtimeByName.get('BUFFER_API_KEY').required_value, null);
  assert.equal(
    runtimeByName.get('GROWTH_PUBLISH_WORKER_SECRET').required_value,
    null,
  );
  assert.equal(
    runtimeByName.get('GROWTH_GENERATION_WORKER_SECRET').required_value,
    null,
  );
  assert.equal(
    runtimeByName.get('GROWTH_SCHEDULED_GENERATION_ENABLED').required_value,
    'false',
  );
  assert.equal(
    first.github_configuration.find(
      (item) => item.name === 'GROWTH_PUBLISH_WORKER_URL',
    ).required_value,
    FIRSTKNOCK_WORKER_URL,
  );
  assert.equal(
    first.github_configuration.find(
      (item) => item.name === 'GROWTH_GENERATION_WORKER_URL',
    ).required_value,
    FIRSTKNOCK_GENERATOR_URL,
  );
  assert.deepEqual(first.scheduled_generation_pipeline, {
    readiness_state: 'not_proven',
    automation_scope: 'unrendered_manifest_only',
    response_schema: 'growth-generation-handoff.v1',
    response_state: 'unrendered_ready',
    response_state_scope: 'scheduled_generation_output',
    required_review_schema_version: 'growth-review.v3',
    required_decision_policy_id: 'growth-decision-sufficiency.v1',
    decision_policy_supported_required: true,
    decision_policy_evidence_hash_required: true,
    canonical_concept_count: 2,
    planned_rendition_count: 4,
    rendered_media_created_by_scheduler: 0,
    creative_artifacts_created_by_scheduler: 0,
    publish_jobs_created_by_scheduler: 0,
    external_pipeline_gates: [
      'owner_pack_authorization',
      'render_media',
      'host_and_verify_media',
      'import_render_result',
      'rendition_review',
      'owner_rendition_approval',
      'schedule_activation',
    ],
  });
  assert.match(first.handoff_body_sha256, /^[a-f0-9]{64}$/);
});

test('handoff refuses unsafe local evidence and unexpected repository failures', () => {
  assert.throws(
    () => buildGrowthActivationHandoff({
      readiness: readinessReport({
        localStatus: 'fail',
        localCount: 0,
      }),
      ...handoffInputs(),
    }),
    /local_immutable_media_not_verified/,
  );
  assert.throws(
    () => buildGrowthActivationHandoff({
      readiness: readinessReport({
        repositoryCode: 'canonical_pack_sha256_mismatch',
      }),
      ...handoffInputs(),
    }),
    /repository_preflight_failed/,
  );
  assert.throws(
    () => buildGrowthActivationHandoff({
      readiness: readinessReport({
        hostingStatus: 'fail',
        hostingCode: 'hosting_authorization_invalid',
      }),
      ...handoffInputs(),
    }),
    /hosting_authorization_invalid/,
  );
});

test('one local command creates an idempotent manifest and refuses conflicting overwrite', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'growth-handoff-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, 'activation-handoff.json');
  const argv = [
    '--render-result',
    join(root, 'weekly.render-result.json'),
    '--render-output',
    root,
    '--hosting-review',
    join(root, 'weekly.hosting-review.json'),
    '--manifest',
    join(root, 'weekly-pack.json'),
    '--output',
    outputPath,
  ];
  let evaluations = 0;
  const evaluateReadiness = async () => {
    evaluations += 1;
    return readinessReport();
  };

  const created = await prepareGrowthActivationHandoff({
    argv,
    cwd: root,
    evaluateReadiness,
  });
  assert.equal(created.status, 'created');
  assert.equal(created.state, 'awaiting_explicit_external_authorizations');
  assert.deepEqual(created.next_authorizations, [
    'release_deployment',
    'weekly_media_hosting',
    'buffer_account_connection',
    'credentialed_smoke_posts',
    'production_delivery_enablement',
    'scheduled_generation_enablement',
    'daily_batch_activation',
  ]);
  const manifest = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(
    manifest.handoff_body_sha256,
    created.handoff_body_sha256,
  );

  const unchanged = await prepareGrowthActivationHandoff({
    argv,
    cwd: root,
    evaluateReadiness,
  });
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(evaluations, 2);

  await writeFile(outputPath, '{}\n', 'utf8');
  await assert.rejects(
    prepareGrowthActivationHandoff({
      argv,
      cwd: root,
      evaluateReadiness,
    }),
    /output_conflict/,
  );
});

test('argument parsing accepts only explicit local paths and never reads secret values', () => {
  const root = resolve('C:\\private\\growth');
  const canary = 'do-not-read-secret';
  const parsed = parseActivationHandoffArguments(
    [
      '--render-result',
      'weekly.render-result.json',
      '--render-output',
      '.',
      '--output',
      'handoff.json',
    ],
    {
      cwd: root,
      environment: {
        BUFFER_API_KEY: canary,
        GROWTH_PUBLISH_WORKER_SECRET: canary,
      },
      repositoryRoot,
    },
  );
  assert.equal(parsed.renderResultPath, join(root, 'weekly.render-result.json'));
  assert.equal(parsed.outputPath, join(root, 'handoff.json'));
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(canary));
  assert.throws(
    () => parseActivationHandoffArguments(
      ['--unknown', canary],
      { cwd: root, environment: {} },
    ),
    /unknown_argument/,
  );
});

test('invalid CLI emits stable JSON without echoing rejected values or environment secrets', () => {
  const canary = 'activation-handoff-secret-do-not-print';
  const result = spawnSync(
    process.execPath,
    [scriptPath, '--unknown', canary],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        BUFFER_API_KEY: canary,
        GROWTH_PUBLISH_WORKER_SECRET: canary,
      },
    },
  );
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema_version: ACTIVATION_HANDOFF_SCHEMA,
    status: 'not_created',
    error: 'unknown_argument',
  });
  assert.equal(
    result.stderr,
    'Growth activation handoff was not created.\n',
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(canary));
});

test('package exposes the local-only activation handoff command', async () => {
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['prepare:growth-activation'],
    'node scripts/prepare-growth-activation-handoff.mjs',
  );
});
