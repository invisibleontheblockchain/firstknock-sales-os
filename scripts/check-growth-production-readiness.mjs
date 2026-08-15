#!/usr/bin/env node

import { createHash, webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalStringify as canonicalizePack,
  validatePack,
} from './render-growth-pack.mjs';
import {
  createNodeIo,
  preflightHostingAuthorization,
  sha256Bytes,
  validateUnhostedRenderResult,
  verifyLocalArtifact,
} from './host-growth-media-base44.mjs';

export const READINESS_SCHEMA = 'growth-production-readiness.v1';
export const CANONICAL_GROWTH_TARGET = Object.freeze({
  batchId: 'firstknock-weekly-rights-safe-v2-2026-07',
  packSha256:
    '00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0',
  renderResultSha256:
    'e3a37de4c9654e0b088021773506775cc0419fdc6e52c029c0b3cc302fbd6fff',
  rendererEnvironmentSha256:
    '89e25ffdd2631e75d84dd9bbd70be8ecdfdc4c398e3f6a3fcc96b75bb1547c2f',
  sourceCount: 14,
  conceptCount: 14,
  artifactCount: 28,
  instagramCount: 14,
  tiktokCount: 14,
});

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..');
export const DEFAULT_MANIFEST_PATH = resolve(
  DEFAULT_REPOSITORY_ROOT,
  'config',
  'growth-media',
  'firstknock-weekly-rights-safe-seed.json',
);
export const DEFAULT_HOSTING_REVIEW_PATH = resolve(
  DEFAULT_REPOSITORY_ROOT,
  'config',
  'growth-media',
  'firstknock-weekly-hosting-review.json',
);

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const cryptoImplementation = globalThis.crypto || webcrypto;
const CHECK_STATUSES = new Set(['pass', 'fail', 'not_proven']);

class CliError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GrowthReadinessCliError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeCheck(id, status, code, evidence) {
  if (!CHECK_STATUSES.has(status)) {
    throw new Error('invalid_readiness_check_status');
  }
  return {
    id,
    status,
    code,
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function makeGate(id, checks) {
  const orderedChecks = [...checks].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const status = orderedChecks.some((item) => item.status === 'fail')
    ? 'fail'
    : orderedChecks.some((item) => item.status === 'not_proven')
      ? 'not_proven'
      : 'pass';
  return { id, status, checks: orderedChecks };
}

function checkFromBoolean(id, condition, passCode, failCode, evidence) {
  return makeCheck(
    id,
    condition ? 'pass' : 'fail',
    condition ? passCode : failCode,
    evidence,
  );
}

async function readRegularBytes(path, label) {
  const info = await nodeFs.lstat(path);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || !Number.isSafeInteger(info.size)
    || info.size < 1
    || info.size > MAX_JSON_BYTES
  ) {
    throw new Error(`${label}_invalid_file`);
  }
  const bytes = await nodeFs.readFile(path);
  if (bytes.byteLength !== info.size) {
    throw new Error(`${label}_changed_while_reading`);
  }
  return bytes;
}

async function readJson(path, label) {
  const bytes = await readRegularBytes(path, label);
  let text;
  let value;
  try {
    text = textDecoder.decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label}_invalid_json`);
  }
  return { bytes, text, value };
}

function canonicalTrackedUrl(artifact) {
  let url;
  try {
    url = new URL(String(artifact?.cta_url || ''));
  } catch {
    return false;
  }
  const expectedSource = artifact?.platform === 'tiktok'
    ? 'tiktok'
    : artifact?.platform === 'instagram'
      ? 'instagram'
      : '';
  const keys = [...url.searchParams.keys()].sort();
  return url.origin === 'https://firstknock.online'
    && url.pathname === '/start'
    && !url.username
    && !url.password
    && !url.hash
    && url.searchParams.get('utm_source') === expectedSource
    && url.searchParams.get('utm_medium') === 'organic_social'
    && url.searchParams.get('utm_campaign') === '1000-users'
    && url.searchParams.get('utm_content') === artifact?.platform_content_id
    && JSON.stringify(keys) === JSON.stringify([
      'utm_campaign',
      'utm_content',
      'utm_medium',
      'utm_source',
    ]);
}

function pairedConceptContract(pack) {
  const concepts = new Map();
  for (const artifact of pack.artifacts) {
    const current = concepts.get(artifact.concept_id) || [];
    current.push(artifact);
    concepts.set(artifact.concept_id, current);
  }
  return concepts.size > 0
    && [...concepts.values()].every((artifacts) => (
      artifacts.length === 2
      && new Set(artifacts.map((artifact) => artifact.platform)).size === 2
      && artifacts.some((artifact) => artifact.platform === 'instagram')
      && artifacts.some((artifact) => artifact.platform === 'tiktok')
      && new Set(
        artifacts.map((artifact) => artifact.source_asset_key),
      ).size === 1
    ));
}

function manifestCompositionContract(pack, expected) {
  const instagram = pack.artifacts.filter(
    (artifact) => artifact.platform === 'instagram',
  );
  const tiktok = pack.artifacts.filter(
    (artifact) => artifact.platform === 'tiktok',
  );
  return pack.sources.length === expected.sourceCount
    && new Set(pack.sources.map((source) => source.asset_key)).size
      === expected.sourceCount
    && new Set(pack.sources.map((source) => source.source_sha256)).size
      === expected.sourceCount
    && pack.artifacts.length === expected.artifactCount
    && new Set(pack.artifacts.map((artifact) => artifact.artifact_key)).size
      === expected.artifactCount
    && new Set(pack.artifacts.map((artifact) => artifact.concept_id)).size
      === expected.conceptCount
    && instagram.length === expected.instagramCount
    && tiktok.length === expected.tiktokCount
    && pack.artifacts.every((artifact) => (
      artifact.campaign === '1000-users'
      && artifact.format === 'video'
      && artifact.distribution_state === 'publish_candidate'
      && canonicalTrackedUrl(artifact)
    ))
    && pairedConceptContract(pack);
}

function publisherWorkflowContract(source) {
  const requiredPatterns = [
    /schedule:\s*\n\s*-\s*cron:\s*['"]\*\/5 \* \* \* \*['"]/,
    /workflow_dispatch:/,
    /permissions:\s*\n\s*contents:\s*read/,
    /cancel-in-progress:\s*false/,
    /timeout-minutes:\s*3/,
    /secrets\.GROWTH_PUBLISH_WORKER_URL/,
    /secrets\.GROWTH_PUBLISH_WORKER_SECRET/,
    /https:\/\/firstknock\.online\/api\/functions\/processGrowthPublishQueue/,
    /--max-time 120/,
    /--max-filesize 65536/,
    /--data '\{"limit":1\}'/,
    /body\?\.success !== true/,
    /body\.inspected > 1/,
  ];
  return requiredPatterns.every((pattern) => pattern.test(source))
    && !/\bpull_request(?:_target)?:/.test(source)
    && !/actions\/checkout/.test(source)
    && !/--verbose|-v\b|set -x/.test(source);
}

function generatorWorkflowContract(source) {
  const requiredPatterns = [
    /cron:\s*['"]15 7 \* \* \*['"]/,
    /workflow_dispatch:/,
    /permissions:\s*\n\s*contents:\s*read/,
    /cancel-in-progress:\s*false/,
    /timeout-minutes:\s*10/,
    /secrets\.GROWTH_GENERATION_WORKER_URL/,
    /secrets\.GROWTH_GENERATION_WORKER_SECRET/,
    /secrets\.GROWTH_SCHEDULED_GENERATION_ENABLED/,
    /https:\/\/firstknock\.online\/api\/functions\/manageGrowthContentEngine/,
    /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/,
    /firstknock-weekly-rights-safe-seed\.json/,
    /action:\s*'run_scheduled_generation'/,
    /body\?\.scheduled_generation !== true/,
    /growth-generation-handoff\.v1/,
    /handoff\?\.state !== 'unrendered_ready'/,
    /growth-review\.v3/,
    /growth-decision-sufficiency\.v1/,
    /handoff\?\.decision_policy_supported !== true/,
    /body\?\.batch\?\.decision_policy_evidence_hash/,
    /handoff\?\.rendered_media_created_by_invocation !== 0/,
    /body\?\.batch\?\.concept_count !== 2/,
    /body\?\.batch\?\.pack_artifact_count !== 4/,
  ];
  return requiredPatterns.every((pattern) => pattern.test(source))
    && !/\bpull_request(?:_target)?:/.test(source)
    && !/processGrowthPublishQueue/.test(source)
    && !/--verbose|-v\b|set -x/.test(source);
}

function auditedBootstrapContract(serverSource, schemaSource, uiSource) {
  const actionStart = serverSource.indexOf(
    'if (action === "build_audited_bootstrap_batch")',
  );
  const actionEnd = serverSource.indexOf(
    'if (action === "build_next_batch")',
    actionStart,
  );
  const actionBlock = actionStart >= 0 && actionEnd > actionStart
    ? serverSource.slice(actionStart, actionEnd)
    : '';
  return actionBlock.length > 0
    && !actionBlock.includes('InvokeLLM')
    && /MAX_BOOTSTRAP_BATCHES\s*=\s*7/.test(serverSource)
    && /BOOTSTRAP_POLICY_VERSION\s*=\s*"audited-seed-bootstrap-v1"/
      .test(serverSource)
    && /"build_audited_bootstrap_batch"[\s\S]*?!canApproveGrowth\(user\)/
      .test(serverSource)
    && /auditedBootstrapRenderPack\(/.test(actionBlock)
    && /bootstrap_acknowledged\s*!==\s*true/.test(actionBlock)
    && /bootstrap_batch_limit_reached/.test(actionBlock)
    && /"audited_seed_bootstrap"/.test(schemaSource)
    && /"audited-seed-bootstrap-v1"/.test(schemaSource)
    && /action:\s*'build_audited_bootstrap_batch'/.test(uiSource)
    && /bootstrap_acknowledged:\s*true/.test(uiSource)
    && /bootstrapBatchCount\s*>=\s*7/.test(uiSource);
}

function reviewedGenerationPolicyContract(serverSource, schemaSource) {
  const requiredServerPatterns = [
    /GROWTH_REVIEW_SCHEMA_VERSION/,
    /GROWTH_DECISION_POLICY_ID/,
    /evaluateGrowthDecisionSufficiency/,
    /validatedStoredDecisionPolicy\(/,
    /batchDecisionPolicyMatches\(/,
    /reviewed_parent_decision_policy_stale/,
    /reviewed_parent_decision_not_supported/,
    /review_identity_hash/,
  ];
  const requiredSchemaPatterns = [
    /"growth-review\.v3"/,
    /"growth-decision-sufficiency\.v1"/,
    /"decision_policy_reason_codes"/,
    /"decision_policy_evidence_hash"/,
    /"comparable_fixed_age_snapshots"/,
  ];
  return requiredServerPatterns.every((pattern) => pattern.test(serverSource))
    && requiredSchemaPatterns.every((pattern) => pattern.test(schemaSource));
}

function defaultTrackedFileCheck(repositoryRoot, relativePath) {
  const result = spawnSync(
    'git',
    ['ls-files', '--error-unmatch', '--', relativePath],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return result.status === 0
    && String(result.stdout || '').trim().replaceAll('\\', '/')
      === relativePath.replaceAll('\\', '/');
}

export async function evaluateRepositoryContract({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  manifestPath = DEFAULT_MANIFEST_PATH,
  expected = CANONICAL_GROWTH_TARGET,
  trackedFileCheck = defaultTrackedFileCheck,
} = {}) {
  const checks = [];
  let pack = null;
  try {
    const manifest = await readJson(manifestPath, 'canonical_manifest');
    pack = validatePack(manifest.value);
    const packSha256 = sha256(canonicalizePack(pack));
    checks.push(checkFromBoolean(
      'canonical_batch_id',
      pack.batch_id === expected.batchId,
      'canonical_batch_id_verified',
      'canonical_batch_id_mismatch',
      { batch_id: pack.batch_id },
    ));
    checks.push(checkFromBoolean(
      'canonical_pack_sha256',
      packSha256 === expected.packSha256,
      'canonical_pack_sha256_verified',
      'canonical_pack_sha256_mismatch',
      { pack_sha256: packSha256 },
    ));
    checks.push(checkFromBoolean(
      'weekly_pack_composition',
      manifestCompositionContract(pack, expected),
      'weekly_pack_composition_verified',
      'weekly_pack_composition_invalid',
      {
        source_count: pack.sources.length,
        concept_count:
          new Set(pack.artifacts.map((artifact) => artifact.concept_id)).size,
        artifact_count: pack.artifacts.length,
        instagram_count: pack.artifacts.filter(
          (artifact) => artifact.platform === 'instagram',
        ).length,
        tiktok_count: pack.artifacts.filter(
          (artifact) => artifact.platform === 'tiktok',
        ).length,
      },
    ));
  } catch {
    checks.push(makeCheck(
      'canonical_manifest',
      'fail',
      'canonical_manifest_invalid',
    ));
  }

  const workflowRelativePath = '.github/workflows/growth-publisher.yml';
  try {
    const workflowPath = resolve(repositoryRoot, workflowRelativePath);
    const workflow = await readJsonLikeText(
      workflowPath,
      'growth_publisher_workflow',
    );
    checks.push(checkFromBoolean(
      'growth_publisher_workflow_contract',
      publisherWorkflowContract(workflow),
      'growth_publisher_workflow_contract_verified',
      'growth_publisher_workflow_contract_invalid',
    ));
  } catch {
    checks.push(makeCheck(
      'growth_publisher_workflow_contract',
      'fail',
      'growth_publisher_workflow_missing',
    ));
  }
  let workflowTracked = false;
  try {
    workflowTracked = trackedFileCheck(
      repositoryRoot,
      workflowRelativePath,
    ) === true;
  } catch {
    workflowTracked = false;
  }
  checks.push(checkFromBoolean(
    'growth_publisher_workflow_tracked',
    workflowTracked,
    'growth_publisher_workflow_tracked',
    'growth_publisher_workflow_not_tracked',
  ));

  const generatorWorkflowRelativePath =
    '.github/workflows/growth-generator.yml';
  try {
    const generatorWorkflowPath = resolve(
      repositoryRoot,
      generatorWorkflowRelativePath,
    );
    const generatorWorkflow = await readJsonLikeText(
      generatorWorkflowPath,
      'growth_generator_workflow',
    );
    checks.push(checkFromBoolean(
      'growth_generator_workflow_contract',
      generatorWorkflowContract(generatorWorkflow),
      'growth_generator_workflow_contract_verified',
      'growth_generator_workflow_contract_invalid',
    ));
  } catch {
    checks.push(makeCheck(
      'growth_generator_workflow_contract',
      'fail',
      'growth_generator_workflow_missing',
    ));
  }
  let generatorWorkflowTracked = false;
  try {
    generatorWorkflowTracked = trackedFileCheck(
      repositoryRoot,
      generatorWorkflowRelativePath,
    ) === true;
  } catch {
    generatorWorkflowTracked = false;
  }
  checks.push(checkFromBoolean(
    'growth_generator_workflow_tracked',
    generatorWorkflowTracked,
    'growth_generator_workflow_tracked',
    'growth_generator_workflow_not_tracked',
  ));

  try {
    const packagePath = resolve(repositoryRoot, 'package.json');
    const packageJson = (await readJson(packagePath, 'package_json')).value;
    checks.push(checkFromBoolean(
      'readiness_package_script',
      packageJson?.scripts?.['check:growth-production']
        === 'node scripts/check-growth-production-readiness.mjs',
      'readiness_package_script_verified',
      'readiness_package_script_missing',
    ));
  } catch {
    checks.push(makeCheck(
      'readiness_package_script',
      'fail',
      'readiness_package_script_missing',
    ));
  }
  try {
    const [serverSource, schemaSource, uiSource] = await Promise.all([
      readJsonLikeText(
        resolve(
          repositoryRoot,
          'base44',
          'functions',
          'manageGrowthContentEngine',
          'entry.ts',
        ),
        'growth_content_engine',
      ),
      readJsonLikeText(
        resolve(
          repositoryRoot,
          'base44',
          'entities',
          'GrowthContentBatch.jsonc',
        ),
        'growth_content_batch_schema',
      ),
      readJsonLikeText(
        resolve(
          repositoryRoot,
          'src',
          'components',
          'acquisition',
          'ContentEngineQueue.jsx',
        ),
        'growth_content_engine_ui',
      ),
    ]);
    checks.push(checkFromBoolean(
      'audited_bootstrap_contract',
      auditedBootstrapContract(serverSource, schemaSource, uiSource),
      'audited_bootstrap_contract_verified',
      'audited_bootstrap_contract_invalid',
    ));
    checks.push(checkFromBoolean(
      'reviewed_generation_policy_contract',
      reviewedGenerationPolicyContract(serverSource, schemaSource),
      'reviewed_generation_policy_contract_verified',
      'reviewed_generation_policy_contract_invalid',
    ));
  } catch {
    checks.push(makeCheck(
      'audited_bootstrap_contract',
      'fail',
      'audited_bootstrap_contract_missing',
    ));
    checks.push(makeCheck(
      'reviewed_generation_policy_contract',
      'fail',
      'reviewed_generation_policy_contract_missing',
    ));
  }
  return { gate: makeGate('repository_contract', checks), pack };
}

async function readJsonLikeText(path, label) {
  const bytes = await readRegularBytes(path, label);
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new Error(`${label}_invalid_utf8`);
  }
}

export async function evaluateLocalImmutableMedia({
  renderResultPath = '',
  renderOutput = '',
  canonicalPack = null,
  expected = CANONICAL_GROWTH_TARGET,
  io = createNodeIo(nodeFs),
} = {}) {
  if (!renderResultPath) {
    return {
      gate: makeGate('local_immutable_media', [
        makeCheck(
          'unhosted_render_result',
          'not_proven',
          'render_result_missing',
        ),
      ]),
      context: null,
    };
  }

  let parsed;
  let resultSha256;
  let context;
  try {
    parsed = await readJson(renderResultPath, 'unhosted_render_result');
    resultSha256 = await sha256Bytes(parsed.bytes, cryptoImplementation);
    context = await validateUnhostedRenderResult(
      parsed.value,
      resultSha256,
      cryptoImplementation,
    );
  } catch {
    return {
      gate: makeGate('local_immutable_media', [
        makeCheck(
          'unhosted_render_result',
          'fail',
          'render_result_invalid',
        ),
      ]),
      context: null,
    };
  }

  const checks = [
    checkFromBoolean(
      'render_result_sha256',
      resultSha256 === expected.renderResultSha256,
      'render_result_sha256_verified',
      'render_result_sha256_mismatch',
      { render_result_sha256: resultSha256 },
    ),
    checkFromBoolean(
      'render_result_batch',
      context.batchId === expected.batchId,
      'render_result_batch_verified',
      'render_result_batch_mismatch',
      { batch_id: context.batchId },
    ),
    checkFromBoolean(
      'render_result_pack',
      context.packSha256 === expected.packSha256
        && (
          !canonicalPack
          || canonicalizePack(parsed.value.pack)
            === canonicalizePack(canonicalPack)
        ),
      'render_result_pack_verified',
      'render_result_pack_mismatch',
      { pack_sha256: context.packSha256 },
    ),
    checkFromBoolean(
      'renderer_environment',
      context.rendererEnvironmentSha256
        === expected.rendererEnvironmentSha256,
      'renderer_environment_verified',
      'renderer_environment_mismatch',
      {
        renderer_environment_sha256:
          context.rendererEnvironmentSha256,
      },
    ),
    checkFromBoolean(
      'publish_candidate_inventory',
      context.descriptors.length === expected.artifactCount,
      'publish_candidate_inventory_verified',
      'publish_candidate_inventory_mismatch',
      { artifact_count: context.descriptors.length },
    ),
  ];

  const outputPath = renderOutput || dirname(resolve(renderResultPath));
  let outputRoot = '';
  try {
    const outputInfo = await nodeFs.lstat(outputPath);
    if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
      throw new Error('invalid_render_output');
    }
    outputRoot = await nodeFs.realpath(outputPath);
  } catch {
    checks.push(makeCheck(
      'render_output_directory',
      'fail',
      'render_output_missing',
    ));
  }

  if (outputRoot) {
    let verifiedCount = 0;
    try {
      for (const descriptor of context.descriptors) {
        await verifyLocalArtifact(
          descriptor,
          outputRoot,
          io,
          cryptoImplementation,
        );
        verifiedCount += 1;
      }
      checks.push(makeCheck(
        'local_media_bytes',
        'pass',
        'local_media_bytes_verified',
        { verified_count: verifiedCount },
      ));
    } catch {
      checks.push(makeCheck(
        'local_media_bytes',
        'fail',
        'local_media_bytes_invalid',
        { verified_count: verifiedCount },
      ));
    }
  }

  return {
    gate: makeGate('local_immutable_media', checks),
    context: {
      ...context,
      sourceResult: parsed.value,
      resultSha256,
    },
  };
}

function deterministicJson(text, value) {
  return text === `${JSON.stringify(value, null, 2)}\n`;
}

function pendingReviewShape(review, expected, descriptorCount) {
  return review?.schema_version === 'growth-media-hosting-authorization.v1'
    && review?.review_status === 'pending'
    && review?.authorization_scope === 'base44_hosting_only'
    && review?.batch_id === expected.batchId
    && review?.render_result_sha256 === expected.renderResultSha256
    && review?.pack_sha256 === expected.packSha256
    && review?.renderer_environment_sha256
      === expected.rendererEnvironmentSha256
    && review?.hosting_authorized === false
    && review?.reviewed_at === null
    && review?.reviewed_by === null
    && Array.isArray(review?.unresolved_blockers)
    && review.unresolved_blockers.length === 1
    && review.unresolved_blockers[0]
      === 'owner_hosting_authorization_required'
    && Array.isArray(review?.artifacts)
    && review.artifacts.length === descriptorCount;
}

export async function evaluateHostingAuthorization({
  renderResultPath = '',
  hostingReviewPath = DEFAULT_HOSTING_REVIEW_PATH,
  expected = CANONICAL_GROWTH_TARGET,
  localContext = null,
  io = createNodeIo(nodeFs),
} = {}) {
  let review;
  try {
    review = await readJson(hostingReviewPath, 'hosting_review');
  } catch {
    return makeGate('hosting_authorization', [
      makeCheck(
        'hosting_review',
        'not_proven',
        'hosting_review_missing',
      ),
    ]);
  }

  const pending = deterministicJson(review.text, review.value)
    && pendingReviewShape(
      review.value,
      expected,
      localContext?.descriptors?.length || expected.artifactCount,
    );
  if (!renderResultPath || !localContext) {
    return makeGate('hosting_authorization', [
      makeCheck(
        'hosting_authorization',
        'not_proven',
        pending
          ? 'hosting_authorization_pending'
          : 'hosting_authorization_not_evaluable',
      ),
    ]);
  }

  try {
    const authorized = await preflightHostingAuthorization({
      resultPath: renderResultPath,
      reviewPath: hostingReviewPath,
      cryptoImpl: cryptoImplementation,
      io,
    });
    return makeGate('hosting_authorization', [
      makeCheck(
        'hosting_authorization',
        'pass',
        'hosting_authorization_verified',
        {
          artifact_count: authorized.context.descriptors.length,
          render_result_sha256:
            authorized.context.sourceResultSha256,
        },
      ),
    ]);
  } catch (error) {
    if (
      pending
      && error?.message
        === 'The hosting authorization review is pending or not authorized'
    ) {
      return makeGate('hosting_authorization', [
        makeCheck(
          'hosting_authorization',
          'not_proven',
          'hosting_authorization_pending',
        ),
      ]);
    }
    return makeGate('hosting_authorization', [
      makeCheck(
        'hosting_authorization',
        'fail',
        'hosting_authorization_invalid',
      ),
    ]);
  }
}

async function evaluateHostedMedia({
  renderOutput = '',
  batchId = CANONICAL_GROWTH_TARGET.batchId,
} = {}) {
  if (!renderOutput) {
    return makeGate('hosted_media', [
      makeCheck(
        'hosted_result',
        'not_proven',
        'hosted_result_missing',
      ),
    ]);
  }
  const hostedPath = resolve(
    renderOutput,
    `${batchId}.hosted-render-result.json`,
  );
  let present = false;
  try {
    const info = await nodeFs.lstat(hostedPath);
    present = info.isFile() && !info.isSymbolicLink();
  } catch {
    present = false;
  }
  return makeGate('hosted_media', [
    makeCheck(
      'hosted_origin_bytes',
      'not_proven',
      present
        ? 'hosted_media_remote_verification_required'
        : 'hosted_result_missing',
      { hosted_result_present: present },
    ),
  ]);
}

function productionOnlyGate(id, checkId, code) {
  return makeGate(id, [
    makeCheck(checkId, 'not_proven', code),
  ]);
}

function scheduledGenerationRuntimeGate() {
  return makeGate('scheduled_generation_runtime', [
    makeCheck(
      'growth_generator_default_branch_deployment',
      'not_proven',
      'growth_generator_default_branch_not_proven',
    ),
    makeCheck(
      'growth_generator_runtime_configuration',
      'not_proven',
      'scheduled_generation_runtime_not_proven',
    ),
    makeCheck(
      'growth_generator_enablement',
      'not_proven',
      'scheduled_generation_enablement_not_proven',
    ),
  ]);
}

function reportFromGates(gates, expected) {
  const orderedGates = [...gates].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const blockers = [...new Set(orderedGates.flatMap((gate) => (
    gate.checks
      .filter((check) => check.status !== 'pass')
      .map((check) => check.code)
  )))].sort();
  return {
    schema_version: READINESS_SCHEMA,
    overall: blockers.length ? 'blocked' : 'ready',
    target: {
      batch_id: expected.batchId,
      pack_sha256: expected.packSha256,
      render_result_sha256: expected.renderResultSha256,
      renderer_environment_sha256:
        expected.rendererEnvironmentSha256,
    },
    gates: orderedGates,
    blockers,
    warnings: [],
  };
}

export async function evaluateGrowthProductionReadiness({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  manifestPath = DEFAULT_MANIFEST_PATH,
  renderResultPath = '',
  hostingReviewPath = DEFAULT_HOSTING_REVIEW_PATH,
  renderOutput = '',
  expected = CANONICAL_GROWTH_TARGET,
  trackedFileCheck = defaultTrackedFileCheck,
} = {}) {
  const repository = await evaluateRepositoryContract({
    repositoryRoot,
    manifestPath,
    expected,
    trackedFileCheck,
  });
  const localMedia = await evaluateLocalImmutableMedia({
    renderResultPath,
    renderOutput,
    canonicalPack: repository.pack,
    expected,
  });
  const hostingAuthorization = await evaluateHostingAuthorization({
    renderResultPath,
    hostingReviewPath,
    expected,
    localContext: localMedia.context,
  });
  const effectiveOutput = renderOutput
    || (renderResultPath ? dirname(resolve(renderResultPath)) : '');
  const hostedMedia = await evaluateHostedMedia({
    renderOutput: effectiveOutput,
    batchId: expected.batchId,
  });
  return reportFromGates([
    repository.gate,
    localMedia.gate,
    hostingAuthorization,
    hostedMedia,
    productionOnlyGate(
      'production_runtime',
      'deployed_runtime_configuration',
      'production_runtime_not_proven',
    ),
    productionOnlyGate(
      'scheduler_default_branch',
      'default_branch_scheduler_deployment',
      'scheduler_default_branch_not_proven',
    ),
    scheduledGenerationRuntimeGate(),
    productionOnlyGate(
      'activatable_batch',
      'production_batch_preflight',
      'activatable_batch_not_proven',
    ),
  ], expected);
}

export function parseReadinessArguments(
  argv,
  {
    environment = process.env,
    cwd = process.cwd(),
    repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  } = {},
) {
  const values = new Map();
  const known = new Set([
    '--manifest',
    '--render-result',
    '--hosting-review',
    '--render-output',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!known.has(argument)) throw new CliError('unknown_argument');
    if (values.has(argument)) throw new CliError('duplicate_argument');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      throw new CliError('missing_argument_value');
    }
    values.set(argument, next);
    index += 1;
  }
  const absolute = (value) => value ? resolve(cwd, value) : '';
  const renderResultPath = absolute(
    values.get('--render-result')
      || environment.FIRSTKNOCK_RENDER_RESULT
      || '',
  );
  const renderOutput = absolute(
    values.get('--render-output')
      || environment.FIRSTKNOCK_RENDER_OUTPUT
      || '',
  );
  return {
    repositoryRoot,
    manifestPath: absolute(
      values.get('--manifest') || DEFAULT_MANIFEST_PATH,
    ),
    renderResultPath,
    hostingReviewPath: absolute(
      values.get('--hosting-review')
        || environment.FIRSTKNOCK_HOSTING_REVIEW_FILE
        || DEFAULT_HOSTING_REVIEW_PATH,
    ),
    renderOutput,
  };
}

function humanSummary(report) {
  const lines = [
    `Growth production readiness: ${report.overall.toUpperCase()}`,
    ...report.gates.map(
      (gate) => `${gate.status.toUpperCase()} ${gate.id}`,
    ),
  ];
  if (report.blockers.length) {
    lines.push(`Blockers: ${report.blockers.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function invalidCliReport(code) {
  return {
    schema_version: READINESS_SCHEMA,
    overall: 'invalid',
    error: code,
  };
}

export async function runReadinessCli({
  argv = process.argv.slice(2),
  environment = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let options;
  try {
    options = parseReadinessArguments(argv, { environment, cwd });
  } catch (error) {
    const report = invalidCliReport(
      error instanceof CliError ? error.code : 'invalid_cli',
    );
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    stderr.write('Growth production readiness: INVALID\n');
    return 2;
  }
  try {
    const report = await evaluateGrowthProductionReadiness(options);
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    stderr.write(humanSummary(report));
    return report.overall === 'ready' ? 0 : 1;
  } catch {
    const report = invalidCliReport('readiness_checker_internal_error');
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    stderr.write('Growth production readiness: INVALID\n');
    return 2;
  }
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runReadinessCli();
}
