#!/usr/bin/env node

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_GROWTH_TARGET,
  DEFAULT_HOSTING_REVIEW_PATH,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_REPOSITORY_ROOT,
  READINESS_SCHEMA,
  evaluateGrowthProductionReadiness,
} from './check-growth-production-readiness.mjs';
import { canonicalStringify } from './host-growth-media-base44.mjs';

export const ACTIVATION_HANDOFF_SCHEMA =
  'growth-production-activation-handoff.v1';
export const FIRSTKNOCK_MEDIA_ORIGIN = 'https://media.base44.com';
export const FIRSTKNOCK_MEDIA_PATH_PREFIX =
  '/files/public/695eb764b077190880be21de/';
export const FIRSTKNOCK_WORKER_URL =
  'https://firstknock.online/api/functions/processGrowthPublishQueue';
export const FIRSTKNOCK_GENERATOR_URL =
  'https://firstknock.online/api/functions/manageGrowthContentEngine';

export const DEFAULT_HANDOFF_REPOSITORY_ROOT = DEFAULT_REPOSITORY_ROOT;
const ALLOWED_REPOSITORY_HANDOFF_BLOCKERS = new Set([
  'growth_generator_workflow_not_tracked',
  'growth_publisher_workflow_not_tracked',
]);
const EXPECTED_EXTERNAL_BLOCKERS = new Set([
  'activatable_batch_not_proven',
  'hosted_media_remote_verification_required',
  'hosted_result_missing',
  'hosting_authorization_pending',
  'production_runtime_not_proven',
  'growth_generator_default_branch_not_proven',
  'scheduled_generation_enablement_not_proven',
  'scheduled_generation_runtime_not_proven',
  'scheduler_default_branch_not_proven',
]);
const MAX_OUTPUT_BYTES = 1024 * 1024;

class HandoffError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GrowthActivationHandoffError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gate(report, id) {
  return report?.gates?.find((item) => item?.id === id) || null;
}

function nonPassingCodes(selectedGate) {
  return (selectedGate?.checks || [])
    .filter((check) => check?.status !== 'pass')
    .map((check) => String(check?.code || ''))
    .filter(Boolean)
    .sort();
}

function localVerifiedCount(report) {
  const localGate = gate(report, 'local_immutable_media');
  const mediaCheck = localGate?.checks?.find(
    (check) => check?.id === 'local_media_bytes',
  );
  return Number(mediaCheck?.evidence?.verified_count || 0);
}

function validateReadinessForHandoff(report) {
  if (
    report?.schema_version !== READINESS_SCHEMA
    || !['blocked', 'ready'].includes(report?.overall)
    || report?.target?.batch_id !== CANONICAL_GROWTH_TARGET.batchId
    || report?.target?.pack_sha256 !== CANONICAL_GROWTH_TARGET.packSha256
    || report?.target?.render_result_sha256
      !== CANONICAL_GROWTH_TARGET.renderResultSha256
    || report?.target?.renderer_environment_sha256
      !== CANONICAL_GROWTH_TARGET.rendererEnvironmentSha256
  ) {
    throw new HandoffError('readiness_target_invalid');
  }

  const repositoryGate = gate(report, 'repository_contract');
  const repositoryBlockers = nonPassingCodes(repositoryGate);
  if (
    !repositoryGate
    || (
      repositoryGate.status !== 'pass'
      && repositoryBlockers.some(
        (code) => !ALLOWED_REPOSITORY_HANDOFF_BLOCKERS.has(code),
      )
    )
  ) {
    throw new HandoffError('repository_preflight_failed');
  }

  const localGate = gate(report, 'local_immutable_media');
  if (
    localGate?.status !== 'pass'
    || localVerifiedCount(report) !== CANONICAL_GROWTH_TARGET.artifactCount
  ) {
    throw new HandoffError('local_immutable_media_not_verified');
  }

  const hostingGate = gate(report, 'hosting_authorization');
  const hostingCodes = nonPassingCodes(hostingGate);
  const hostingPending = hostingGate?.status === 'not_proven'
    && hostingCodes.length === 1
    && hostingCodes[0] === 'hosting_authorization_pending';
  if (hostingGate?.status !== 'pass' && !hostingPending) {
    throw new HandoffError('hosting_authorization_invalid');
  }

  const unexpectedBlockers = (report.blockers || []).filter((code) => (
    !ALLOWED_REPOSITORY_HANDOFF_BLOCKERS.has(code)
    && !EXPECTED_EXTERNAL_BLOCKERS.has(code)
  ));
  if (unexpectedBlockers.length) {
    throw new HandoffError('unexpected_readiness_blocker');
  }
  const scheduledGenerationGate = gate(report, 'scheduled_generation_runtime');
  const scheduledGenerationCodes = nonPassingCodes(scheduledGenerationGate);
  if (
    scheduledGenerationGate?.status !== 'not_proven'
    || canonicalStringify(scheduledGenerationCodes)
      !== canonicalStringify([
        'growth_generator_default_branch_not_proven',
        'scheduled_generation_enablement_not_proven',
        'scheduled_generation_runtime_not_proven',
      ])
  ) {
    throw new HandoffError('scheduled_generation_readiness_invalid');
  }

  return {
    hostingState: hostingGate.status === 'pass'
      ? 'authorized_file_verified'
      : 'pending_owner_authorization',
    repositoryState: repositoryGate.status === 'pass'
      ? 'release_source_contract_verified'
      : 'workflow_present_but_not_tracked',
    scheduledGenerationState: 'not_proven',
  };
}

function runtimeConfiguration(target) {
  return [
    {
      name: 'GROWTH_MEDIA_ORIGIN',
      classification: 'public_configuration',
      required_value: FIRSTKNOCK_MEDIA_ORIGIN,
      activation_rule: 'set_after_hosted_origin_verification',
    },
    {
      name: 'GROWTH_MEDIA_PATH_PREFIX',
      classification: 'public_configuration',
      required_value: FIRSTKNOCK_MEDIA_PATH_PREFIX,
      activation_rule: 'must_match_hosting_and_backend_exactly',
    },
    {
      name: 'GROWTH_RENDER_PACK_SHA256S',
      classification: 'public_integrity_allowlist',
      required_value: target.pack_sha256,
      activation_rule:
        'static weekly seed trust; daily bootstrap packs still require exact owner authorization',
    },
    {
      name: 'GROWTH_RENDER_ENVIRONMENT_SHA256S',
      classification: 'public_integrity_allowlist',
      required_value: target.renderer_environment_sha256,
      activation_rule: 'set_after_render_environment_review',
    },
    {
      name: 'BUFFER_API_KEY',
      classification: 'secret',
      required_value: null,
      activation_rule: 'configure_server_side; never place in this manifest',
    },
    {
      name: 'BUFFER_ORGANIZATION_ID',
      classification: 'sensitive_identifier',
      required_value: null,
      activation_rule: 'copy from the verified connected Buffer organization',
    },
    {
      name: 'BUFFER_INSTAGRAM_CHANNEL_ID',
      classification: 'sensitive_identifier',
      required_value: null,
      activation_rule: 'copy from the verified FirstKnock Instagram channel',
    },
    {
      name: 'BUFFER_TIKTOK_CHANNEL_ID',
      classification: 'sensitive_identifier',
      required_value: null,
      activation_rule: 'copy from the verified FirstKnock TikTok channel',
    },
    {
      name: 'GROWTH_PUBLISH_WORKER_SECRET',
      classification: 'secret',
      required_value: null,
      activation_rule:
        'generate independently with at least 32 characters; configure the same value in Base44 and GitHub',
    },
    {
      name: 'GROWTH_CONTENT_GENERATION_ENABLED',
      classification: 'feature_flag',
      required_value: 'true',
      activation_rule:
        'required for the audited first-week builder; it does not authorize publication',
    },
    {
      name: 'GROWTH_GENERATION_WORKER_SECRET',
      classification: 'secret',
      required_value: null,
      activation_rule:
        'generate independently with at least 32 characters; configure the same value in Base44 and GitHub; grants only the scheduled manifest action',
    },
    {
      name: 'GROWTH_SCHEDULED_GENERATION_ENABLED',
      classification: 'kill_switch',
      required_value: 'false',
      activation_rule:
        'keep false until the generator workflow and deployed runtime are proven and measured-generation enablement is separately authorized; true creates only unrendered ready manifests',
    },
    {
      name: 'GROWTH_PUBLISH_ENABLED',
      classification: 'kill_switch',
      required_value: 'false',
      activation_rule:
        'keep false through deployment and both platform smoke tests; change to true only with separate owner publication authorization',
    },
  ];
}

function githubConfiguration() {
  return [
    {
      name: 'GROWTH_PUBLISH_WORKER_URL',
      classification: 'repository_secret',
      required_value: FIRSTKNOCK_WORKER_URL,
      activation_rule: 'configure only after the deployed endpoint is verified',
    },
    {
      name: 'GROWTH_PUBLISH_WORKER_SECRET',
      classification: 'repository_secret',
      required_value: null,
      activation_rule:
        'must exactly match the Base44 worker secret; never place in this manifest',
    },
    {
      name: 'GROWTH_GENERATION_WORKER_URL',
      classification: 'repository_secret',
      required_value: FIRSTKNOCK_GENERATOR_URL,
      activation_rule: 'configure only after the deployed endpoint is verified',
    },
    {
      name: 'GROWTH_GENERATION_WORKER_SECRET',
      classification: 'repository_secret',
      required_value: null,
      activation_rule:
        'must exactly match the Base44 generation worker secret; never place in this manifest',
    },
    {
      name: 'GROWTH_SCHEDULED_GENERATION_ENABLED',
      classification: 'repository_secret',
      required_value: 'false',
      activation_rule:
        'keep false until measured-generation enablement is explicitly authorized; it is independent of the Base44 kill switch',
    },
  ];
}

function authorizationBoundaries(hostingState) {
  return [
    {
      id: 'release_deployment',
      state: 'not_granted_by_handoff',
      grants: 'merge and deploy the acquisition release',
      does_not_grant: [
        'hosting',
        'account_connection',
        'social_smoke_post',
        'batch_activation',
        'publication',
      ],
    },
    {
      id: 'weekly_media_hosting',
      state: hostingState,
      grants: 'upload only the exact 28 reviewed MP4 files to FirstKnock Base44 storage',
      does_not_grant: [
        'rendition_approval',
        'scheduling',
        'publication',
      ],
    },
    {
      id: 'buffer_account_connection',
      state: 'not_granted_by_handoff',
      grants: 'connect the exact FirstKnock Instagram and TikTok channels',
      does_not_grant: [
        'smoke_post',
        'batch_activation',
        'publication',
      ],
    },
    {
      id: 'credentialed_smoke_posts',
      state: 'not_granted_by_handoff',
      grants: 'send one explicitly reviewed test post to each exact platform channel',
      does_not_grant: [
        'production_delivery_enablement',
        'weekly_batch_activation',
        'unattended_publication',
      ],
    },
    {
      id: 'production_delivery_enablement',
      state: 'not_granted_by_handoff',
      grants:
        'set the production delivery kill switch true and start the bounded scheduler after both platform smokes pass',
      does_not_grant: [
        'daily_batch_activation',
        'future_daily_batches',
      ],
    },
    {
      id: 'scheduled_generation_enablement',
      state: 'not_granted_by_handoff',
      grants:
        'enable the bounded daily worker to create one unrendered two-concept manifest for the next Phoenix day',
      does_not_grant: [
        'rendering',
        'hosting',
        'render_result_import',
        'rendition_approval',
        'scheduling',
        'publication',
      ],
    },
    {
      id: 'daily_batch_activation',
      state: 'not_granted_by_handoff',
      grants: 'queue the four exact reviewed daily renditions for their displayed schedule',
      does_not_grant: [
        'future_daily_batches',
        'changed_renditions',
        'changed_channels',
      ],
    },
  ];
}

function stages(paths, target, readiness, states) {
  const hostedResultPath = join(
    paths.renderOutput,
    `${target.batch_id}.hosted-render-result.json`,
  );
  const hostingReceiptPath = join(
    paths.renderOutput,
    `${target.batch_id}.base44-hosting-receipt.json`,
  );
  return [
    {
      order: 1,
      id: 'release_acquisition_system',
      effect: 'external_repository_and_production_write',
      authorization_required: 'release_deployment',
      current_evidence: states.repositoryState,
      operator_actions: [
        'Commit only the reviewed acquisition release changes.',
        'Open, review, and merge the release through the default branch.',
        'Verify Base44 deployed that exact default-branch commit and its new entities and functions.',
      ],
      completion_evidence: [
        'default_branch_commit_sha',
        'base44_deployed_commit_sha',
        'production_function_and_entity_inventory',
      ],
    },
    {
      order: 2,
      id: 'authorize_exact_weekly_hosting',
      effect: 'local_authorization_record',
      authorization_required: 'weekly_media_hosting',
      current_evidence: states.hostingState,
      operator_actions: [
        'Copy the pending hosting review to a separate external file without changing its bound hashes or artifact inventory.',
        'After the owner reviews the exact 28 local renditions, set review_status to authorized, hosting_authorized to true, reviewed_by to the owner identity, reviewed_at to the real UTC time, and unresolved_blockers to an empty array.',
        'Keep the checked-in pending review unchanged; the authorized review is a separate external record.',
      ],
      completion_evidence: [
        'authorized_external_hosting_review',
        'hosting_preflight_pass_for_exact_render_result',
      ],
    },
    {
      order: 3,
      id: 'host_and_verify_weekly_media',
      effect: 'external_base44_storage_write_then_network_verification',
      authorization_required: 'weekly_media_hosting',
      current_evidence: gate(readiness, 'hosted_media')?.status || 'not_proven',
      commands: [
        {
          id: 'host_exact_weekly_media',
          command: ['npm.cmd', 'run', 'host:growth-media:base44'],
          environment: [
            {
              name: 'FIRSTKNOCK_RENDER_RESULT',
              value: paths.renderResult,
            },
            {
              name: 'FIRSTKNOCK_RENDER_OUTPUT',
              value: paths.renderOutput,
            },
            {
              name: 'FIRSTKNOCK_HOSTING_REVIEW_FILE',
              value: '<authorized_external_review_path>',
            },
            {
              name: 'GROWTH_MEDIA_PATH_PREFIX',
              value: FIRSTKNOCK_MEDIA_PATH_PREFIX,
            },
          ],
        },
        {
          id: 'verify_exact_remote_bytes',
          command: [
            'npm.cmd',
            'run',
            'verify:growth-media-origin',
            '--',
            '--result',
            hostedResultPath,
          ],
          environment: [{
            name: 'GROWTH_MEDIA_PATH_PREFIX',
            value: FIRSTKNOCK_MEDIA_PATH_PREFIX,
          }],
        },
      ],
      completion_evidence: [
        hostedResultPath,
        hostingReceiptPath,
        '28 direct HTTP 200 video/mp4 responses with exact byte lengths and SHA-256 hashes',
      ],
    },
    {
      order: 4,
      id: 'configure_production_with_publish_disabled',
      effect: 'external_production_configuration_write',
      authorization_required: 'release_deployment',
      current_evidence: gate(readiness, 'production_runtime')?.status
        || 'not_proven',
      operator_actions: [
        'Configure the reviewed media origin, path prefix, pack and renderer allowlists, independent publish and generation worker secrets, content-generation flag, GROWTH_PUBLISH_ENABLED=false, and GROWTH_SCHEDULED_GENERATION_ENABLED=false. Leave Buffer identifiers unset until their exact connected identities are verified.',
        'Keep both publishing and scheduled-generation kill switches false.',
        'Verify signed-out /start attribution and the owner Growth Dashboard before connecting delivery.',
      ],
      completion_evidence: [
        'production_configuration_inventory_without_secret_values',
        'signed_out_start_landing_smoke',
        'owner_growth_dashboard_smoke',
      ],
    },
    {
      order: 5,
      id: 'connect_and_verify_buffer_channels',
      effect: 'external_account_connection',
      authorization_required: 'buffer_account_connection',
      current_evidence: 'not_proven',
      operator_actions: [
        'Connect the exact FirstKnock Instagram and TikTok channels in one Buffer organization.',
        'Verify each channel service, automatic-delivery support, connection state, queue state, and organization identity.',
        'Configure the API key, organization ID, and both exact channel IDs server-side.',
      ],
      completion_evidence: [
        'buffer_organization_identity',
        'instagram_channel_identity_and_connected_state',
        'tiktok_channel_identity_and_connected_state',
      ],
    },
    {
      order: 6,
      id: 'run_separate_platform_smokes',
      effect: 'external_social_publication',
      authorization_required: 'credentialed_smoke_posts',
      current_evidence: 'not_proven',
      operator_actions: [
        'In an isolated credentialed staging configuration, run one separately reviewed automatic Instagram smoke post through the real connected channel while production GROWTH_PUBLISH_ENABLED remains false.',
        'In that staging configuration, run one separately reviewed automatic TikTok smoke post through the real connected channel while production GROWTH_PUBLISH_ENABLED remains false.',
        'Verify returned provider identity, schedulingType=automatic, scheduled and sent state, exact media, text, channel, and downstream metric checkpoint behavior.',
      ],
      completion_evidence: [
        'instagram_smoke_provider_post_id_automatic_mode_and_sent_state',
        'tiktok_smoke_provider_post_id_automatic_mode_and_sent_state',
        'worker_remote_media_hash_recheck',
        'buffer_metric_sync_checkpoint',
      ],
    },
    {
      order: 7,
      id: 'activate_bounded_scheduler',
      effect:
        'external_production_configuration_write_and_recurring_worker_invocation',
      authorization_required: 'production_delivery_enablement',
      current_evidence: gate(readiness, 'scheduler_default_branch')?.status
        || 'not_proven',
      operator_actions: [
        'After both separate platform smokes pass, obtain explicit owner authorization to enable production delivery.',
        'Set production GROWTH_PUBLISH_ENABLED to true without changing the reviewed media, Buffer channel, or integrity configuration.',
        'Confirm growth-publisher.yml is on the default branch.',
        'Configure the two GROWTH_PUBLISH_* GitHub values listed in github_configuration.',
        'Run workflow_dispatch once with an empty queue and confirm inspected and processed are both zero.',
        'Verify the configuration-bound heartbeat stays newer than fifteen minutes.',
      ],
      completion_evidence: [
        'owner_production_delivery_enablement',
        'production_publish_flag_true',
        'default_branch_workflow_commit_sha',
        'github_secret_names_configured_without_values',
        'successful_empty_queue_workflow_run_url',
        'fresh_worker_heartbeat',
      ],
    },
    {
      order: 8,
      id: 'prepare_first_daily_bootstrap_batch',
      effect: 'production_growth_record_write_without_publication',
      authorization_required: 'release_deployment',
      current_evidence: gate(readiness, 'activatable_batch')?.status
        || 'not_proven',
      operator_actions: [
        'Load and verify the exact audited source inventory in Growth Dashboard.',
        'In Growth Dashboard, use Start audited week for one Phoenix date and download its exact two-concept/four-artifact pack.',
        'Slice the verified weekly hosted result with that downloaded daily pack.',
        'Run the immutable-origin verifier on the sliced daily hosted result before import.',
        'Authorize the displayed daily pack SHA-256, import the sliced hosted result, and complete all four review gates for every rendition.',
        'Approve each exact rendition as the owner.',
      ],
      local_command_templates: [
        {
          command: [
            'npm.cmd',
            'run',
            'slice:growth-render-result',
            '--',
            '--source-result',
            hostedResultPath,
            '--batch-pack',
            '<downloaded_daily_bootstrap_pack>',
            '--output',
            '<daily_hosted_result_output>',
          ],
          external_effects: false,
        },
        {
          command: [
            'npm.cmd',
            'run',
            'verify:growth-media-origin',
            '--',
            '--result',
            '<daily_hosted_result_output>',
          ],
          environment: [{
            name: 'GROWTH_MEDIA_PATH_PREFIX',
            value: FIRSTKNOCK_MEDIA_PATH_PREFIX,
          }],
          external_effects: 'network_read_only',
        },
      ],
      completion_evidence: [
        'daily_batch_pack_sha256',
        'four_exact_imported_media_sha256_values',
        'four_complete_review_gate_records',
        'four_owner_approval_hashes',
        'preflight_batch_activation_can_activate_true',
      ],
    },
    {
      order: 9,
      id: 'activate_exact_daily_batch',
      effect: 'external_scheduled_social_publication',
      authorization_required: 'daily_batch_activation',
      current_evidence: 'not_authorized',
      operator_actions: [
        'Review the displayed four exact renditions, Instagram and TikTok channels, 09:30 and 13:30 America/Phoenix schedule, and canonical pack SHA-256.',
        'Give the dashboard activation acknowledgement only for that displayed daily batch.',
        'Submit automatic activation and verify all four jobs are protected; resume only unfinished jobs if a partial response occurs.',
      ],
      completion_evidence: [
        'daily_activation_owner_acknowledgement',
        'four_protected_publish_job_ids',
        'four_exact_schedule_times_and_channel_ids',
      ],
    },
    {
      order: 10,
      id: 'measure_and_decide',
      effect: 'production_measurement_and_weekly_decision',
      authorization_required: 'none_for_read_only_review',
      current_evidence: 'starts_after_real_publication',
      operator_actions: [
        'Verify Buffer sent state and the FirstKnock publication clock for each post.',
        'Review D1, D3, D7, and D30 checkpoints without treating missing reach as zero.',
        'At D7, choose Repeat, one-variable Iterate, or Hold from measured downstream activation evidence.',
      ],
      completion_evidence: [
        'provider_sent_identity',
        'fixed_age_metric_coverage',
        'content_id_attributed_signups_and_activations',
        'evidence_bound_d7_decision',
      ],
    },
    {
      order: 11,
      id: 'enable_measured_manifest_scheduler',
      effect:
        'external_production_configuration_write_and_recurring_unrendered_manifest_generation',
      authorization_required: 'scheduled_generation_enablement',
      current_evidence: states.scheduledGenerationState,
      input_state:
        'growth_review_v3_repeat_or_iterate_supported_by_growth_decision_sufficiency_v1',
      output_state: 'unrendered_ready',
      output_schema: 'growth-generation-handoff.v1',
      automatic_actions_completed: [
        'select_latest_unambiguous_reviewed_parent',
        'recompute_and_bind_supported_decision_policy',
        'select_exactly_two_eligible_donors',
        'generate_two_concepts_and_four_platform_recipes',
        'store_canonical_ready_render_pack',
      ],
      automatic_actions_not_performed: [
        'owner_pack_authorization',
        'render_media',
        'host_and_verify_media',
        'import_render_result',
        'rendition_review',
        'owner_rendition_approval',
        'schedule_activation',
        'publication',
      ],
      operator_actions: [
        'Confirm growth-generator.yml is tracked on and deployed from the default branch.',
        'Configure the exact generator URL and independent generation worker secret in GitHub and Base44 while both scheduled-generation flags remain false.',
        'After a measured Repeat or Iterate review exists, obtain explicit scheduled-generation enablement and set both independent GROWTH_SCHEDULED_GENERATION_ENABLED values to true.',
        'Run workflow_dispatch once and require growth-review.v3, growth-decision-sufficiency.v1, decision_policy_supported=true, an exact policy evidence hash, generation_handoff.state=unrendered_ready, rendered_media_created_by_invocation=0, exactly two concepts, four planned recipes, and no creative artifact or publish-job writes.',
        'Continue through owner pack authorization, rendering, hosting verification, import, rendition review, owner approval, and daily activation as separate gates.',
      ],
      completion_evidence: [
        'default_branch_generator_workflow_commit_sha',
        'deployed_generation_action_revision',
        'generator_secret_names_configured_without_values',
        'owner_scheduled_generation_enablement',
        'successful_generator_workflow_run_url',
        'growth_generation_handoff_v1_unrendered_ready_response',
        'growth_decision_sufficiency_v1_supported_policy_proof',
      ],
    },
  ];
}

export function buildGrowthActivationHandoff({
  readiness,
  manifestPath,
  renderResultPath,
  renderOutput,
  hostingReviewPath,
} = {}) {
  const states = validateReadinessForHandoff(readiness);
  const paths = {
    canonicalManifest: resolve(manifestPath),
    renderResult: resolve(renderResultPath),
    renderOutput: resolve(renderOutput),
    hostingReview: resolve(hostingReviewPath),
  };
  const body = {
    schema_version: ACTIVATION_HANDOFF_SCHEMA,
    state: 'awaiting_explicit_external_authorizations',
    execution_policy: {
      generated_locally: true,
      external_side_effects_performed: false,
      secrets_read_or_stored: false,
      activation_authorized: false,
      executable: false,
      note:
        'This manifest is an operator handoff, not permission to host, deploy, enable scheduled generation, connect accounts, send smoke posts, schedule, or publish.',
      evidence_snapshot_rule:
        'After any repository, authorization, hosting, deployment, channel, scheduler, review, or activation evidence changes, rerun the command to a new output filename; never edit or overwrite this snapshot.',
    },
    target: readiness.target,
    local_evidence: {
      readiness_schema_version: readiness.schema_version,
      readiness_overall: readiness.overall,
      readiness_blockers: [...readiness.blockers].sort(),
      verified_publish_candidate_count: localVerifiedCount(readiness),
      repository_contract: states.repositoryState,
      hosting_authorization: states.hostingState,
      readiness_gates: readiness.gates,
    },
    scheduled_generation_pipeline: {
      readiness_state: states.scheduledGenerationState,
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
    },
    files: {
      canonical_manifest: {
        path: paths.canonicalManifest,
        pack_sha256: readiness.target.pack_sha256,
      },
      unhosted_render_result: {
        path: paths.renderResult,
        sha256: readiness.target.render_result_sha256,
      },
      render_output_directory: {
        path: paths.renderOutput,
      },
      hosting_review: {
        path: paths.hostingReview,
        state: states.hostingState,
        note:
          'The checked-in pending review is evidence only. An authorized review must remain a separate external file.',
      },
    },
    runtime_configuration: runtimeConfiguration(readiness.target),
    github_configuration: githubConfiguration(),
    authorization_boundaries: authorizationBoundaries(states.hostingState),
    stages: stages(paths, readiness.target, readiness, states),
  };
  return {
    ...body,
    handoff_body_sha256: sha256(canonicalStringify(body)),
  };
}

export function parseActivationHandoffArguments(argv, {
  environment = process.env,
  cwd = process.cwd(),
  repositoryRoot = DEFAULT_HANDOFF_REPOSITORY_ROOT,
} = {}) {
  const values = new Map();
  const known = new Set([
    '--manifest',
    '--render-result',
    '--hosting-review',
    '--render-output',
    '--output',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!known.has(argument)) throw new HandoffError('unknown_argument');
    if (values.has(argument)) throw new HandoffError('duplicate_argument');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      throw new HandoffError('missing_argument_value');
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
  const outputPath = absolute(values.get('--output') || '');
  if (!renderResultPath) {
    throw new HandoffError('render_result_required');
  }
  if (!renderOutput) {
    throw new HandoffError('render_output_required');
  }
  if (!outputPath) {
    throw new HandoffError('output_required');
  }
  if (extname(outputPath).toLowerCase() !== '.json') {
    throw new HandoffError('output_must_be_json');
  }
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
    outputPath,
  };
}

async function writeExactOutput(outputPath, text, fs = nodeFs) {
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
    throw new HandoffError('handoff_output_too_large');
  }
  let parentInfo;
  try {
    parentInfo = await fs.lstat(dirname(outputPath));
  } catch {
    throw new HandoffError('output_directory_missing');
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new HandoffError('output_directory_invalid');
  }
  try {
    const existingInfo = await fs.lstat(outputPath);
    if (
      !existingInfo.isFile()
      || existingInfo.isSymbolicLink()
      || existingInfo.size > MAX_OUTPUT_BYTES
    ) {
      throw new HandoffError('output_conflict');
    }
    const existing = await fs.readFile(outputPath, 'utf8');
    if (existing !== text) throw new HandoffError('output_conflict');
    return 'unchanged';
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    if (error?.code !== 'ENOENT') {
      throw new HandoffError('output_inspection_failed');
    }
  }
  try {
    await fs.writeFile(outputPath, text, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch {
    throw new HandoffError('output_write_failed');
  }
  return 'created';
}

export async function prepareGrowthActivationHandoff({
  argv = process.argv.slice(2),
  environment = process.env,
  cwd = process.cwd(),
  fs = nodeFs,
  evaluateReadiness = evaluateGrowthProductionReadiness,
} = {}) {
  const options = parseActivationHandoffArguments(
    argv,
    { environment, cwd },
  );
  const readiness = await evaluateReadiness({
    repositoryRoot: options.repositoryRoot,
    manifestPath: options.manifestPath,
    renderResultPath: options.renderResultPath,
    hostingReviewPath: options.hostingReviewPath,
    renderOutput: options.renderOutput,
  });
  const handoff = buildGrowthActivationHandoff({
    readiness,
    manifestPath: options.manifestPath,
    renderResultPath: options.renderResultPath,
    renderOutput: options.renderOutput,
    hostingReviewPath: options.hostingReviewPath,
  });
  const serialized = `${JSON.stringify(handoff, null, 2)}\n`;
  const writeStatus = await writeExactOutput(
    options.outputPath,
    serialized,
    fs,
  );
  return {
    status: writeStatus,
    output_path: options.outputPath,
    handoff_body_sha256: handoff.handoff_body_sha256,
    state: handoff.state,
    next_authorizations: handoff.authorization_boundaries
      .filter((boundary) => boundary.state !== 'authorized_file_verified')
      .map((boundary) => boundary.id),
  };
}

function safeErrorCode(error) {
  return error instanceof HandoffError
    ? error.code
    : 'activation_handoff_internal_error';
}

export async function runActivationHandoffCli({
  argv = process.argv.slice(2),
  environment = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const result = await prepareGrowthActivationHandoff({
      argv,
      environment,
      cwd,
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    stderr.write(
      'Growth activation handoff prepared locally; no external action was performed.\n',
    );
    return 0;
  } catch (error) {
    const code = safeErrorCode(error);
    stdout.write(`${JSON.stringify({
      schema_version: ACTIVATION_HANDOFF_SCHEMA,
      status: 'not_created',
      error: code,
    }, null, 2)}\n`);
    stderr.write('Growth activation handoff was not created.\n');
    return code.endsWith('_required')
        || code === 'unknown_argument'
        || code === 'duplicate_argument'
        || code === 'missing_argument_value'
        || code === 'output_must_be_json'
      ? 2
      : 1;
  }
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runActivationHandoffCli();
}
