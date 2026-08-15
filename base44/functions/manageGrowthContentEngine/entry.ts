import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import {
  artifactApprovalHash,
  asArray,
  canonicalStringify,
  compactText,
  constantTimeEqual,
  isContentAddressedMediaUrl,
  isPublicHttpsUrl,
  isStablePublicHttpsUrl,
  mediaUrlMatchesDeliveryKey,
  mediaUrlUsesNamespace,
  normalized,
  normalizeMediaPathPrefix,
  platformTrackedUrl,
  publishJobKey,
  publishJobRequestHash,
  safeProviderError,
  sha256Hex,
  socialPostText,
  socialPostTextLimit,
  timestamp,
  token,
} from "../_shared/growthContentEngine.js";
import {
  evaluateGrowthDecisionSufficiency,
  GROWTH_DECISION_POLICY_ID,
  GROWTH_REVIEW_SCHEMA_VERSION,
  normalizeGrowthDecisionOverrideNote,
} from "../_shared/growthDecisionSufficiency.js";

const MAX_BODY_BYTES = 200_000;
const MAX_SOURCE_BATCH = 50;
const MAX_RENDER_IMPORT = 30;
const MAX_LIST = 500;
const MAX_BATCH_LIST = 100;
const DEPENDENCY_PAGE_SIZE = 1000;
const MAX_DEPENDENCY_RECORDS = 25000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_GRACE_MS = DAY_MS;
const BATCH_LEASE_MS = 5 * 60 * 1000;
const SOURCE_COOLDOWN_DAYS = 7;
const HOOK_DEDUPE_DAYS = 28;
const MAX_BATCH_TARGET_DAYS = 90;
const NEXT_BATCH_PROFILE = "measured-next-batch-v1";
const FEATURE_EXPLAINER_VIDEO_PROFILE = "feature_explainer_video_v1";
const FEATURE_EXPLAINER_SOURCE_KINDS = new Set(["video", "image"]);
const SCHEDULED_GENERATION_ACTION = "run_scheduled_generation";
const SCHEDULED_GENERATION_ACTOR_ID = "growth-generation-scheduler";
const SCHEDULED_GENERATION_HANDOFF_SCHEMA = "growth-generation-handoff.v1";
const SCHEDULED_GENERATION_LEAD_DAYS = 1;
const SCHEDULED_GENERATION_MAX_ATTEMPTS = 3;
const SCHEDULED_GENERATION_REQUEST_FIELDS = new Set([
  "action",
  "seed_pack",
]);
const NEXT_BATCH_PROFILES = new Set([
  NEXT_BATCH_PROFILE,
  FEATURE_EXPLAINER_VIDEO_PROFILE,
]);
const NEXT_BATCH_SCHEMA = "growth-next-batch.v1";
const NEXT_BATCH_TIMEZONE = "America/Phoenix";
const BATCH_INPUT_REVIEWED = "reviewed_evidence";
const BATCH_INPUT_BOOTSTRAP = "audited_seed_bootstrap";
const REVIEW_SCHEMA_VERSION = GROWTH_REVIEW_SCHEMA_VERSION;
const CONVERSION_EVIDENCE_SCHEMA = "growth-conversion-evidence.v2";
const DECLARED_CLICKABLE_HANDOFFS = new Set([
  "story_link",
  "dm_reply",
  "comment_reply",
]);
const BOOTSTRAP_POLICY_VERSION = "audited-seed-bootstrap-v1";
const MAX_BOOTSTRAP_BATCHES = 7;
const BOOTSTRAP_CONCEPT_PRIORITY = new Map([
  "fk-rs-rerun-followups-01",
  "fk-rs-generation-settings-01",
  "fk-rs-outcome-controls-01",
  "fk-rs-add-details-01",
  "fk-rs-route-command-01",
  "fk-rs-merge-routes-01",
  "fk-rs-analytics-date-01",
  "fk-rs-manager-funnel-01",
  "fk-rs-bulk-reknock-01",
  "fk-rs-manager-comparison-01",
  "fk-rs-route-start-finish-01",
  "fk-rs-refresh-area-01",
  "fk-rs-property-styling-01",
  "fk-rs-sale-correction-01",
].map((conceptId, index) => [conceptId, index]));
const NEXT_BATCH_DISCLOSURE =
  "DEMO DATA - no customer result or performance promise.";
const PRODUCTION_GROWTH_CAMPAIGN = "1000-users";
const TIKTOK_FEATURE_DISCLOSURE = "Product demo.";
const AUDITED_BOOTSTRAP_INSTAGRAM_DISCLOSURES = new Set([
  "FIRSTKNOCK PRODUCT DEMO - NO CUSTOMER RESULT.",
  "DEMO DATA - NO CUSTOMER RESULT OR PERFORMANCE PROMISE.",
  "DEMO SETTINGS - FIRSTKNOCK PRODUCT VIEW.",
]);
const TIKTOK_FEATURE_SECTION_LIMITS = Object.freeze({
  problem: 280,
  visible_feature_behavior: 400,
  practical_benefit: 280,
  cta_label: 80,
});
const NEXT_BATCH_SLOTS = ["morning", "midday", "evening"];
const PLATFORMS = new Set(["instagram", "tiktok"]);
const FORMATS = new Set(["video", "photo", "carousel"]);
const MEDIA_KINDS = new Set(["video", "image"]);
const PRIVACY_STATES = new Set(["safe", "redaction_required", "blocked"]);
const MIME_TYPES = new Set(["video/mp4", "image/jpeg", "image/png", "image/webp"]);
const SCHEDULING_TYPES = new Set(["automatic", "notification"]);
const TERMINAL_JOB_STATES = new Set(["sent", "failed", "canceled"]);
const SCHEDULE_RESERVATION_STATE = "reservation_pending";
const MIN_SCHEDULE_LEAD_MS = 15 * 60 * 1000;
const MAX_SCHEDULE_LEAD_MS = 366 * 24 * 60 * 60 * 1000;
const SCHEDULE_CUTOFF_MS = 10 * 60 * 1000;
const SCHEDULE_LOCK_MS = 5 * 60 * 1000;
const SOURCE_PRIVACY_FENCE_MS = 10 * 60 * 1000;
const WORKER_HEARTBEAT_KEY = "buffer-publisher";
// The production scheduler runs every five minutes. Three missed ticks make the
// publisher unavailable without making ordinary scheduler jitter look like an outage.
const WORKER_HEARTBEAT_MAX_AGE_MS = 15 * 60 * 1000;
const RENDER_RESULT_SCHEMA = "growth-render-result.v1";
const RENDER_PROFILE_ID = "firstknock-h264-bitexact-v3";
const MAX_MEDIA_BYTES = 250 * 1024 * 1024;
const AUDIO_MODES = new Set(["silent", "baked_owned_or_licensed"]);
const PROCEDURAL_AUDIO_RECIPE = "firstknock-procedural-ui-v1";
const ACTIVE_BATCH_STATES = new Set([
  "generating",
  "ready",
  "render_authorized",
]);
const CONTENT_METRIC_FIELDS = [
  "reach",
  "views",
  "shares",
  "saves",
  "comments",
  "follows",
  "profile_visits",
  "link_clicks",
  "dm_intents",
];
const OWNED_INTENT_FIELDS = ["link_clicks", "dm_intents"];
const CONVERSION_EVIDENCE_FIELDS = [
  "schema_version",
  "platform",
  "campaign",
  "content",
  "cohort_start_at",
  "cutoff_at",
  "snapshot_days",
  "snapshot_captured_at",
  "social_evidence_hash",
  "owned_intent_observed_fields",
  "link_clicks",
  "dm_intents",
  "owned_intents",
  "attribution_method",
  "post_conversion_eligible",
  "conversion_conclusion",
  "conversion_counters_available",
  "landing_sessions",
  "signup_cta_sessions",
  "auth_completed",
  "signups",
  "activated_workspaces",
  "activated_users",
  "activated_reps",
  "paid_users",
  "activation_timing_complete",
  "paid_timing_complete",
  "first_activation_at",
  "last_activation_at",
  "retention_window_days",
  "retention_mature",
  "retention_eligible_users",
  "retained_users",
  "retention_rate",
];
const CONVERSION_EVIDENCE_DOWNSTREAM_FIELDS = [
  "landing_sessions",
  "signup_cta_sessions",
  "auth_completed",
  "signups",
  "activated_workspaces",
  "activated_users",
  "activated_reps",
  "paid_users",
];
const CONVERSION_EVIDENCE_SOCIAL_COUNTER_FIELDS = [
  "link_clicks",
  "dm_intents",
  "owned_intents",
];

function response(data: any, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function canManageGrowth(user: any): boolean {
  return user?.is_owner === true
    || normalized(user?.role) === "admin"
    || normalized(user?.app_role) === "admin";
}

function canApproveGrowth(user: any): boolean {
  return user?.is_owner === true;
}

function scheduledGenerationSecret(
  req: Request,
): { configured: string; supplied: string } {
  const configured = String(
    Deno.env.get("GROWTH_GENERATION_WORKER_SECRET") || "",
  );
  const authorization = String(req.headers.get("authorization") || "");
  const supplied = authorization.match(/^Bearer ([^\s]+)$/i)?.[1] || "";
  return { configured, supplied };
}

function configuredMediaOrigin(): string {
  const raw = String(Deno.env.get("GROWTH_MEDIA_ORIGIN") || "").trim();
  if (!isPublicHttpsUrl(raw)) return "";
  try {
    const url = new URL(raw);
    if (
      url.pathname !== "/"
      || url.search
      || url.hash
      || url.username
      || url.password
    ) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}

function configuredMediaPathPrefix(): string {
  return normalizeMediaPathPrefix(
    Deno.env.get("GROWTH_MEDIA_PATH_PREFIX"),
  );
}

function configuredSha256Allowlist(keys: string[]): Set<string> {
  const values = keys
    .map((key) => Deno.env.get(key))
    .filter(Boolean)
    .join(",")
    .split(/[\s,]+/)
    .map((value) => normalized(value))
    .filter(Boolean);
  if (
    !values.length
    || values.length > 20
    || values.some((value) => !/^[a-f0-9]{64}$/.test(value))
  ) {
    return new Set();
  }
  return new Set(values);
}

function configuredRenderPackHashes(): Set<string> {
  return configuredSha256Allowlist([
    "GROWTH_RENDER_PACK_SHA256",
    "GROWTH_RENDER_PACK_SHA256S",
  ]);
}

function configuredRenderEnvironmentHashes(): Set<string> {
  return configuredSha256Allowlist([
    "GROWTH_RENDER_ENVIRONMENT_SHA256",
    "GROWTH_RENDER_ENVIRONMENT_SHA256S",
  ]);
}

function cleanStringList(value: any, maxItems: number, itemMax: number): string[] {
  return asArray(value)
    .map((item) => compactText(item, itemMax))
    .filter(Boolean)
    .slice(0, maxItems);
}

function cleanTokenList(value: any, maxItems = 20): string[] {
  return [...new Set(asArray(value).map((item) => token(item)).filter(Boolean))]
    .slice(0, maxItems);
}

function cleanRenderSourceLineage(value: any): any[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    return null;
  }
  const lineage = value.map((source) => ({
    asset_key: token(source?.asset_key),
    source_reference: localReference(source?.source_reference),
    source_sha256: normalized(source?.source_sha256),
  }));
  if (
    lineage.some((source) => (
      !source.asset_key
      || !source.source_reference
      || !/^[a-f0-9]{64}$/.test(source.source_sha256)
    ))
    || new Set(lineage.map((source) => source.asset_key)).size !== lineage.length
  ) {
    return null;
  }
  return lineage;
}

function localReference(value: any): string | null {
  const reference = String(value || "").trim().slice(0, 300);
  return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,299}$/.test(reference)
    ? reference
    : null;
}

function normalizeSource(value: any): any | null {
  const assetKey = token(value?.asset_key);
  const title = compactText(value?.title, 160);
  const sourceReference = value?.source_reference
    ? localReference(value.source_reference)
    : "";
  const mediaKind = token(value?.media_kind);
  const mimeType = normalized(value?.mime_type).slice(0, 120);
  const privacyStatus = token(value?.privacy_status);
  const safeSummary = compactText(value?.safe_summary, 1000);
  const privacyNote = compactText(value?.privacy_note, 1000);
  const width = Math.max(0, Math.trunc(Number(value?.width || 0)));
  const height = Math.max(0, Math.trunc(Number(value?.height || 0)));
  const durationMs = Math.max(0, Math.trunc(Number(value?.duration_ms || 0)));
  const sourceSha256 = normalized(value?.source_sha256);
  if (
    !assetKey
    || !title
    || !MEDIA_KINDS.has(mediaKind)
    || !PRIVACY_STATES.has(privacyStatus)
    || !safeSummary
    || (value?.source_reference && !sourceReference)
    || width > 20000
    || height > 20000
    || durationMs > 3600000
    || (sourceSha256 && !/^[a-f0-9]{64}$/.test(sourceSha256))
  ) {
    return null;
  }
  return {
    asset_key: assetKey,
    title,
    source_reference: sourceReference || undefined,
    media_kind: mediaKind,
    mime_type: mimeType || undefined,
    width,
    height,
    duration_ms: durationMs,
    source_sha256: sourceSha256 || undefined,
    privacy_status: privacyStatus,
    safe_summary: safeSummary,
    privacy_note: privacyNote || undefined,
    active: value?.active !== false,
  };
}

function platformPrefix(platform: string): string {
  return platform === "tiktok" ? "tt" : "ig";
}

function normalizeDraft(
  value: any,
  current: any = null,
  generationStatus = "manual",
): any | null {
  const platform = token(value?.platform ?? current?.platform);
  const conceptId = token(value?.concept_id ?? current?.concept_id);
  const platformContentId = token(
    value?.platform_content_id
      ?? current?.platform_content_id
      ?? `${platformPrefix(platform)}-${conceptId}`,
  );
  const campaign = token(value?.campaign ?? current?.campaign, "1000-users");
  const format = token(value?.format ?? current?.format, "video");
  const title = compactText(value?.title ?? current?.title, 160);
  const pillar = compactText(value?.pillar ?? current?.pillar, 120);
  const hook = compactText(value?.hook ?? current?.hook, 300);
  const caption = String(value?.caption ?? current?.caption ?? "").trim().slice(0, 5000);
  const ctaLabel = compactText(value?.cta_label ?? current?.cta_label, 160);
  const requestedCtaUrl = String(
    value?.cta_url
      ?? current?.cta_url
      ?? "",
  ).trim().slice(0, 2048);
  const ctaUrl = PLATFORMS.has(platform)
    ? platformTrackedUrl(platform, campaign, platformContentId)
    : requestedCtaUrl;
  const disclosure = compactText(value?.disclosure ?? current?.disclosure, 500);
  const sourceAssetKeys = cleanTokenList(
    value?.source_asset_keys ?? current?.source_asset_keys,
  );
  const overlayText = cleanStringList(
    value?.overlay_text ?? current?.overlay_text,
    20,
    160,
  );
  const shotList = cleanStringList(
    value?.shot_list ?? current?.shot_list,
    30,
    300,
  );
  const mediaUrl = String(value?.media_url ?? current?.media_url ?? "").trim().slice(0, 2048);
  const mediaSha256 = normalized(value?.media_sha256 ?? current?.media_sha256);
  const mimeType = normalized(value?.mime_type ?? current?.mime_type);
  const width = Math.max(0, Math.trunc(Number(value?.width ?? current?.width ?? 0)));
  const height = Math.max(0, Math.trunc(Number(value?.height ?? current?.height ?? 0)));
  const durationMs = Math.max(
    0,
    Math.trunc(Number(value?.duration_ms ?? current?.duration_ms ?? 0)),
  );
  const thumbnailOffsetMs = Math.max(
    0,
    Math.trunc(Number(
      value?.thumbnail_offset_ms ?? current?.thumbnail_offset_ms ?? 0,
    )),
  );
  const renderResultSchema = compactText(
    value?.render_result_schema ?? current?.render_result_schema,
    80,
  );
  const renderPackSha256 = normalized(
    value?.render_pack_sha256 ?? current?.render_pack_sha256,
  );
  const renderTemplateId = token(
    value?.render_template_id ?? current?.render_template_id,
  );
  const renderTemplateVersion = compactText(
    value?.render_template_version ?? current?.render_template_version,
    80,
  );
  const renderInputSha256 = normalized(
    value?.render_input_sha256 ?? current?.render_input_sha256,
  );
  const renderProfileId = token(
    value?.render_profile_id ?? current?.render_profile_id,
  );
  const renderEnvironmentSha256 = normalized(
    value?.render_environment_sha256 ?? current?.render_environment_sha256,
  );
  const renderDeliveryKey = String(
    value?.render_delivery_key ?? current?.render_delivery_key ?? "",
  ).trim().slice(0, 300);
  const renderSourceLineage = cleanRenderSourceLineage(
    value?.render_source_lineage ?? current?.render_source_lineage,
  );
  const normalizedRenderSourceLineage = renderSourceLineage || [];
  const mediaByteSizeValue =
    value?.media_byte_size ?? current?.media_byte_size;
  const mediaByteSize = mediaByteSizeValue === undefined
    ? 0
    : Number(mediaByteSizeValue);
  const audioMode = token(value?.audio_mode ?? current?.audio_mode);
  const hasRenderProvenance = Boolean(
    renderResultSchema
    || renderPackSha256
    || renderTemplateId
    || renderTemplateVersion
    || renderInputSha256
    || renderProfileId
    || renderEnvironmentSha256
    || renderDeliveryKey
    || normalizedRenderSourceLineage.length
  );
  const providerText = socialPostText({
    platform,
    caption,
    disclosure,
    cta_label: ctaLabel,
    cta_url: ctaUrl,
  });
  const revision = current ? Number(current?.revision || 1) + 1 : 1;

  if (
    !PLATFORMS.has(platform)
    || !conceptId
    || !platformContentId
    || !title
    || !pillar
    || !FORMATS.has(format)
    || !sourceAssetKeys.length
    || !hook
    || !caption
    || !ctaLabel
    || !isPublicHttpsUrl(ctaUrl)
    || !providerText
    || providerText.length > socialPostTextLimit(platform)
    || width > 20000
    || height > 20000
    || durationMs > 3600000
    || thumbnailOffsetMs > 3600000
    || (mediaUrl && !isStablePublicHttpsUrl(mediaUrl))
    || (mediaSha256 && !/^[a-f0-9]{64}$/.test(mediaSha256))
    || (mimeType && !MIME_TYPES.has(mimeType))
    || renderSourceLineage === null
    || (
      hasRenderProvenance
      && (
        renderResultSchema !== RENDER_RESULT_SCHEMA
        || !/^[a-f0-9]{64}$/.test(renderPackSha256)
        || !renderTemplateId
        || !renderTemplateVersion
        || !/^[a-f0-9]{64}$/.test(renderInputSha256)
        || !renderProfileId
        || !/^[a-f0-9]{64}$/.test(renderEnvironmentSha256)
        || renderDeliveryKey
          !== `sha256/${mediaSha256}-${platformContentId}.mp4`
        || normalizedRenderSourceLineage.length !== sourceAssetKeys.length
        || normalizedRenderSourceLineage.some(
          (source, index) => source.asset_key !== sourceAssetKeys[index],
        )
        || !Number.isSafeInteger(mediaByteSize)
        || mediaByteSize < 1
        || mediaByteSize > MAX_MEDIA_BYTES
        || !AUDIO_MODES.has(audioMode)
      )
    )
  ) {
    return null;
  }

  return {
    artifact_key: platformContentId,
    concept_id: conceptId,
    revision,
    campaign,
    platform,
    platform_content_id: platformContentId,
    title,
    pillar,
    format,
    source_asset_keys: sourceAssetKeys,
    generation_status: generationStatus,
    generation_error: undefined,
    hook,
    caption,
    provider_text: providerText,
    overlay_text: overlayText,
    shot_list: shotList,
    cta_label: ctaLabel,
    cta_url: ctaUrl || undefined,
    disclosure: disclosure || undefined,
    ai_generated: value?.ai_generated === true || generationStatus === "draft_ready",
    media_url: mediaUrl || undefined,
    media_sha256: mediaSha256 || undefined,
    mime_type: mimeType || undefined,
    width: width || undefined,
    height: height || undefined,
    duration_ms: durationMs || undefined,
    thumbnail_offset_ms: thumbnailOffsetMs || undefined,
    render_result_schema: renderResultSchema || undefined,
    render_pack_sha256: renderPackSha256 || undefined,
    render_template_id: renderTemplateId || undefined,
    render_template_version: renderTemplateVersion || undefined,
    render_input_sha256: renderInputSha256 || undefined,
    render_profile_id: renderProfileId || undefined,
    render_environment_sha256: renderEnvironmentSha256 || undefined,
    render_delivery_key: renderDeliveryKey || undefined,
    render_source_lineage: normalizedRenderSourceLineage.length
      ? normalizedRenderSourceLineage
      : undefined,
    media_byte_size: mediaByteSize || undefined,
    audio_mode: audioMode || undefined,
    review_status: "pending",
    privacy_cleared: false,
    demo_labeled: false,
    claims_supported: false,
    media_rights_confirmed: false,
    review_note: undefined,
    reviewed_by: undefined,
    reviewed_at: undefined,
    approval_status: "not_approved",
    approved_hash: undefined,
    approved_by: undefined,
    approved_at: undefined,
    revoked_at: undefined,
    revocation_note: undefined,
    schedule_lock_generation: Number(current?.schedule_lock_generation || 0),
    schedule_lock_token: "",
    schedule_lock_expires_at: current?.schedule_lock_expires_at || undefined,
  };
}

function artifactMediaReady(
  artifact: any,
  mediaOrigin = configuredMediaOrigin(),
  mediaPathPrefix = configuredMediaPathPrefix(),
): boolean {
  if (
    !isStablePublicHttpsUrl(artifact?.media_url)
    || !isContentAddressedMediaUrl(artifact?.media_url, artifact?.media_sha256)
    || !mediaUrlUsesNamespace(
      artifact?.media_url,
      mediaOrigin,
      mediaPathPrefix,
    )
    || (
      artifact?.render_delivery_key
      && !mediaUrlMatchesDeliveryKey(
        artifact?.media_url,
        artifact?.media_sha256,
        artifact?.render_delivery_key,
        mediaOrigin,
        mediaPathPrefix,
      )
    )
    || !/^[a-f0-9]{64}$/.test(normalized(artifact?.media_sha256))
    || !MIME_TYPES.has(normalized(artifact?.mime_type))
    || artifact?.provider_text !== socialPostText(artifact)
    || !artifact?.provider_text
    || artifact.provider_text.length > socialPostTextLimit(artifact?.platform)
    || Number(artifact?.width || 0) < 1
    || Number(artifact?.height || 0) < 1
  ) {
    return false;
  }
  if (artifact?.format === "video") {
    return artifact?.mime_type === "video/mp4" && Number(artifact?.duration_ms || 0) > 0;
  }
  if (artifact?.format === "photo") {
    return String(artifact?.mime_type || "").startsWith("image/");
  }
  return false;
}

function normalizeRenderImportItem(value: any, context: any): any | null {
  if (
    token(value?.distribution_state) !== "publish_candidate"
    || value?.qc?.ready_for_content_engine_import !== true
  ) {
    return null;
  }
  const artifactKey = token(value?.artifact_key);
  const mediaSha256 = normalized(value?.media_sha256);
  const renderInputSha256 = normalized(value?.render_input_sha256);
  const renderEnvironmentSha256 = normalized(
    value?.render_environment_sha256,
  );
  const deliveryKey = String(value?.delivery_key || "").trim();
  const byteSize = Number(value?.byte_size);
  const audioMode = token(value?.qc?.audio_mode);
  const audioRecipe = token(value?.qc?.audio_recipe);
  const artifactFields = value?.artifact_fields;
  const trustedArtifact = context.packArtifact;
  const sourceAssetKeys = cleanTokenList(artifactFields?.source_asset_keys);
  const envelopeSourceAssetKeys = cleanTokenList(value?.source_asset_keys);
  const lineage = cleanRenderSourceLineage(value?.source_lineage);
  const draft = normalizeDraft(
    {
      ...artifactFields,
      render_result_schema: RENDER_RESULT_SCHEMA,
      render_pack_sha256: context.packSha256,
      render_template_id: value?.template_id,
      render_template_version: value?.template_version,
      render_input_sha256: renderInputSha256,
      render_profile_id: value?.render_profile_id,
      render_environment_sha256: renderEnvironmentSha256,
      render_delivery_key: deliveryKey,
      render_source_lineage: lineage,
      media_byte_size: byteSize,
      audio_mode: audioMode,
    },
    null,
    artifactFields?.ai_generated === true ? "draft_ready" : "manual",
  );
  if (
    !draft
    || !lineage
    || draft.artifact_key !== artifactKey
    || renderInputSha256 !== context.expectedRenderInputSha256
    || draft.concept_id !== token(value?.concept_id)
    || draft.platform !== token(value?.platform)
    || draft.platform_content_id !== token(value?.platform_content_id)
    || value?.template_id !== context.templateId
    || value?.template_version !== context.templateVersion
    || token(value?.render_profile_id) !== RENDER_PROFILE_ID
    || token(value?.render_profile_id) !== context.renderProfileId
    || renderEnvironmentSha256 !== context.renderEnvironmentSha256
    || artifactFields?.artifact_key !== trustedArtifact?.artifact_key
    || artifactFields?.concept_id !== trustedArtifact?.concept_id
    || artifactFields?.campaign !== trustedArtifact?.campaign
    || artifactFields?.platform !== trustedArtifact?.platform
    || artifactFields?.platform_content_id
      !== trustedArtifact?.platform_content_id
    || artifactFields?.title !== trustedArtifact?.title
    || artifactFields?.pillar !== trustedArtifact?.pillar
    || artifactFields?.format !== trustedArtifact?.format
    || (artifactFields?.ai_generated === true)
      !== (trustedArtifact?.ai_generated === true)
    || artifactFields?.hook !== trustedArtifact?.hook
    || artifactFields?.caption !== trustedArtifact?.caption
    || artifactFields?.cta_label !== trustedArtifact?.cta_label
    || artifactFields?.cta_url !== trustedArtifact?.cta_url
    || artifactFields?.disclosure !== trustedArtifact?.disclosure
    || JSON.stringify(asArray(artifactFields?.overlay_text))
      !== JSON.stringify(asArray(trustedArtifact?.overlay_text))
    || JSON.stringify(asArray(artifactFields?.shot_list))
      !== JSON.stringify(asArray(trustedArtifact?.shot_list))
    || sourceAssetKeys.length !== 1
    || sourceAssetKeys[0] !== trustedArtifact?.source_asset_key
    || draft.media_url !== String(value?.media_url || "").trim()
    || draft.media_sha256 !== mediaSha256
    || draft.mime_type !== "video/mp4"
    || value?.mime_type !== draft.mime_type
    || Number(draft.width) !== 1080
    || Number(draft.height) !== 1920
    || value?.width !== draft.width
    || value?.height !== draft.height
    || Number(draft.duration_ms) < 5000
    || Number(draft.duration_ms) > 60000
    || value?.duration_ms !== draft.duration_ms
    || Number(draft.thumbnail_offset_ms) < 0
    || Number(draft.thumbnail_offset_ms) >= Number(draft.duration_ms)
    || value?.thumbnail_offset_ms !== draft.thumbnail_offset_ms
    || !/^[a-f0-9]{64}$/.test(renderInputSha256)
    || !/^[a-f0-9]{64}$/.test(renderEnvironmentSha256)
    || !/^[a-f0-9]{64}$/.test(mediaSha256)
    || deliveryKey !== `sha256/${mediaSha256}-${artifactKey}.mp4`
    || !mediaUrlMatchesDeliveryKey(
      draft.media_url,
      mediaSha256,
      deliveryKey,
      context.mediaOrigin,
      context.mediaPathPrefix,
    )
    || value?.video_codec !== "h264"
    || value?.pixel_format !== "yuv420p"
    || value?.frame_rate !== 30
    || value?.audio_codec !== "aac"
    || value?.audio_sample_rate !== 48000
    || value?.audio_channels !== 2
    || value?.color_space !== "bt709"
    || value?.color_transfer !== "bt709"
    || value?.color_primaries !== "bt709"
    || value?.fast_start !== true
    || !Number.isSafeInteger(byteSize)
    || byteSize < 1
    || byteSize > MAX_MEDIA_BYTES
    || value?.qc?.source_sha256_verified !== true
    || value?.qc?.privacy_status !== "safe"
    || value?.qc?.rights_status !== "firstknock_owned"
    || value?.qc?.disclosure_burned_in !== true
    || value?.qc?.hook_first_frame !== true
    || value?.qc?.third_party_watermark !== false
    || audioMode !== context.expectedAudioMode
    || (
      audioMode === "baked_owned_or_licensed"
      && (
        audioRecipe !== context.expectedAudioRecipe
        || value?.qc?.procedural_audio_generated !== true
      )
    )
    || (
      audioMode === "silent"
      && value?.qc?.procedural_audio_generated === true
    )
    || value?.qc?.ready_for_human_review !== true
    || lineage.length !== sourceAssetKeys.length
    || lineage[0]?.source_reference
      !== context.packSource?.source_reference
    || lineage[0]?.source_sha256 !== context.packSource?.source_sha256
    || envelopeSourceAssetKeys.length !== sourceAssetKeys.length
    || asArray(value?.source_asset_keys).length !== sourceAssetKeys.length
    || lineage.some((source, index) => (
      source.asset_key !== sourceAssetKeys[index]
      || envelopeSourceAssetKeys[index] !== sourceAssetKeys[index]
    ))
  ) {
    return null;
  }
  return {
    fields: {
      ...artifactFields,
      render_result_schema: RENDER_RESULT_SCHEMA,
      render_pack_sha256: context.packSha256,
      render_template_id: value?.template_id,
      render_template_version: value?.template_version,
      render_input_sha256: renderInputSha256,
      render_profile_id: value?.render_profile_id,
      render_environment_sha256: renderEnvironmentSha256,
      render_delivery_key: deliveryKey,
      render_source_lineage: lineage,
      media_byte_size: byteSize,
      audio_mode: audioMode,
    },
    draft,
    lineage,
  };
}

function renderImportMatches(current: any, next: any): boolean {
  const fields = [
    "artifact_key",
    "concept_id",
    "campaign",
    "platform",
    "platform_content_id",
    "title",
    "pillar",
    "format",
    "generation_status",
    "hook",
    "caption",
    "provider_text",
    "cta_label",
    "cta_url",
    "disclosure",
    "ai_generated",
    "media_url",
    "media_sha256",
    "mime_type",
    "width",
    "height",
    "duration_ms",
    "thumbnail_offset_ms",
    "render_result_schema",
    "render_pack_sha256",
    "render_template_id",
    "render_template_version",
    "render_input_sha256",
    "render_profile_id",
    "render_environment_sha256",
    "render_delivery_key",
    "media_byte_size",
    "audio_mode",
    "growth_batch_key",
    "growth_batch_target_date",
    "growth_batch_slot_key",
  ];
  return fields.every((field) => (
    JSON.stringify(current?.[field] ?? null) === JSON.stringify(next?.[field] ?? null)
  ))
    && JSON.stringify(asArray(current?.source_asset_keys))
      === JSON.stringify(asArray(next?.source_asset_keys))
    && JSON.stringify(asArray(current?.overlay_text))
      === JSON.stringify(asArray(next?.overlay_text))
    && JSON.stringify(asArray(current?.shot_list))
      === JSON.stringify(asArray(next?.shot_list))
    && JSON.stringify(asArray(current?.render_source_lineage))
      === JSON.stringify(asArray(next?.render_source_lineage));
}

async function reconcileNewRenderArtifact(
  artifactEntity: any,
  saved: any,
  expected: any,
): Promise<any> {
  const rows = asArray(await artifactEntity.filter(
    { artifact_key: expected.artifact_key },
    "created_date",
    50,
  )).sort((left, right) => (
    String(left?.created_date || "").localeCompare(
      String(right?.created_date || ""),
    )
    || String(left?.id || "").localeCompare(String(right?.id || ""))
  ));
  if (
    rows.length === 1
    && String(rows[0]?.id || "") === String(saved?.id || "")
  ) {
    return { status: "created", artifact: rows[0] };
  }
  const winner = rows[0];
  const savedIsWinner = String(winner?.id || "") === String(saved?.id || "");
  if (!savedIsWinner && saved?.id) {
    await artifactEntity.delete(saved.id).catch(() => null);
  }
  if (!winner || !renderImportMatches(winner, expected)) {
    return { status: "conflict" };
  }
  return {
    status: savedIsWinner ? "created" : "idempotent",
    artifact: winner,
  };
}

async function sourcesForArtifact(sourceEntity: any, keys: string[]): Promise<any[]> {
  if (!keys.length) return [];
  const rows = asArray(await sourceEntity.filter(
    { asset_key: { $in: keys } },
    "-updated_date",
    Math.min(100, keys.length * 3),
  ));
  const grouped = new Map<string, any[]>();
  for (const row of rows) {
    const key = token(row?.asset_key);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(row);
  }
  const resolved: any[] = [];
  for (const key of keys) {
    const matches = grouped.get(key) || [];
    if (matches.length !== 1) return [];
    resolved.push(matches[0]);
  }
  return resolved;
}

function sourcesAreSafe(sources: any[], expectedCount: number): boolean {
  return sources.length === expectedCount
    && sources.every((source) => (
      source?.active !== false
      && source?.privacy_change_pending !== true
      && token(source?.privacy_status) === "safe"
    ));
}

function renderLineageMatchesSources(artifact: any, sources: any[]): boolean {
  if (!artifact?.render_result_schema) return true;
  const lineage = cleanRenderSourceLineage(artifact?.render_source_lineage);
  const sourceKeys = cleanTokenList(artifact?.source_asset_keys);
  if (
    !lineage
    || lineage.length !== sourceKeys.length
    || sources.length !== sourceKeys.length
  ) {
    return false;
  }
  const sourceByKey = new Map(
    sources.map((source) => [token(source?.asset_key), source]),
  );
  return lineage.every((item, index) => {
    const source = sourceByKey.get(item.asset_key);
    return item.asset_key === sourceKeys[index]
      && item.source_reference === localReference(source?.source_reference)
      && item.source_sha256 === normalized(source?.source_sha256);
  });
}

function publisherEnvironment(): any {
  const publishingEnabled = normalized(Deno.env.get("GROWTH_PUBLISH_ENABLED")) === "true";
  const hasApiKey = Boolean(String(Deno.env.get("BUFFER_API_KEY") || "").trim());
  const hasWorkerSecret = String(
    Deno.env.get("GROWTH_PUBLISH_WORKER_SECRET") || "",
  ).length >= 32;
  const organizationId = String(
    Deno.env.get("BUFFER_ORGANIZATION_ID") || "",
  ).trim();
  const mediaOrigin = configuredMediaOrigin();
  const mediaPathPrefix = configuredMediaPathPrefix();
  const instagramChannelId = String(
    Deno.env.get("BUFFER_INSTAGRAM_CHANNEL_ID") || "",
  ).trim();
  const tiktokChannelId = String(
    Deno.env.get("BUFFER_TIKTOK_CHANNEL_ID") || "",
  ).trim();
  const publisherReady = publishingEnabled
    && hasApiKey
    && hasWorkerSecret
    && Boolean(organizationId)
    && Boolean(mediaOrigin)
    && Boolean(mediaPathPrefix);
  return {
    publishingEnabled,
    hasApiKey,
    hasWorkerSecret,
    organizationId,
    mediaOrigin,
    mediaPathPrefix,
    instagramChannelId,
    tiktokChannelId,
    publisherReady,
  };
}

async function publisherHeartbeatRevision(environment: any): Promise<string> {
  return sha256Hex([
    "buffer-publisher",
    environment?.organizationId || "",
    environment?.instagramChannelId || "",
    environment?.tiktokChannelId || "",
    environment?.mediaOrigin || "",
    environment?.mediaPathPrefix || "",
  ].join("|"));
}

async function recentWorkerHeartbeat(
  heartbeatEntity: any,
  environment: any,
  nowMs = Date.now(),
): Promise<{ ready: boolean; observedAt?: string }> {
  if (!environment?.publisherReady || !heartbeatEntity?.filter) {
    return { ready: false };
  }
  const rows = asArray(await heartbeatEntity.filter(
    { heartbeat_key: WORKER_HEARTBEAT_KEY },
    "-observed_at",
    5,
  ).catch(() => []));
  const heartbeat = rows[0];
  const observedAt = timestamp(heartbeat?.observed_at);
  const observedMs = observedAt ? new Date(observedAt).getTime() : 0;
  const expectedRevision = await publisherHeartbeatRevision(environment);
  const ready = heartbeat?.status === "ready"
    && heartbeat?.config_revision === expectedRevision
    && Number.isFinite(observedMs)
    && observedMs <= nowMs + 5 * 60 * 1000
    && observedMs >= nowMs - WORKER_HEARTBEAT_MAX_AGE_MS;
  return { ready, observedAt: observedAt || undefined };
}

async function publicCapabilities(user: any, heartbeatEntity: any): Promise<any> {
  const environment = publisherEnvironment();
  const renderPackConfigured = configuredRenderPackHashes().size > 0;
  const renderEnvironmentConfigured =
    configuredRenderEnvironmentHashes().size > 0;
  const heartbeat = await recentWorkerHeartbeat(heartbeatEntity, environment);
  const publisherReady = environment.publisherReady && heartbeat.ready;
  const instagramConfigured = Boolean(environment.instagramChannelId);
  const tiktokConfigured = Boolean(environment.tiktokChannelId);
  const generationConfigured =
    normalized(Deno.env.get("GROWTH_CONTENT_GENERATION_ENABLED")) === "true";
  return {
    can_approve: canApproveGrowth(user),
    can_schedule: canApproveGrowth(user),
    draft_generation_configured: generationConfigured,
    measured_batch_generation_ready:
      generationConfigured && renderPackConfigured,
    media_rendering: "manifest_import",
    immutable_media_origin_configured: Boolean(environment.mediaOrigin),
    immutable_media_path_prefix_configured:
      Boolean(environment.mediaPathPrefix),
    immutable_media_namespace_configured:
      Boolean(environment.mediaOrigin && environment.mediaPathPrefix),
    trusted_render_pack_configured: renderPackConfigured,
    trusted_render_environment_configured: renderEnvironmentConfigured,
    render_result_import_ready:
      Boolean(environment.mediaOrigin)
      && Boolean(environment.mediaPathPrefix)
      && renderPackConfigured
      && renderEnvironmentConfigured,
    authorized_batch_import_ready:
      Boolean(environment.mediaOrigin)
      && Boolean(environment.mediaPathPrefix)
      && renderEnvironmentConfigured,
    publishing_environment_ready: environment.publisherReady,
    worker_healthy: heartbeat.ready,
    worker_last_seen_at: heartbeat.observedAt,
    publishing_enabled: publisherReady && (instagramConfigured || tiktokConfigured),
    instagram: {
      delivery: publisherReady && instagramConfigured
        ? "buffer"
        : "not_configured",
      platform_tracking: "configured",
      post_attribution: "declared_link_or_visitor_assist",
      static_bio_attribution: "platform_only",
    },
    tiktok: {
      delivery: publisherReady && tiktokConfigured
        ? "buffer"
        : "not_configured",
      platform_tracking: "configured",
      post_attribution: "declared_link_or_visitor_assist",
      static_bio_attribution: "platform_only",
    },
    planning_timezone: "America/Phoenix",
    approval_policy: "owner_only",
  };
}

function safeJob(job: any): any {
  return {
    id: job?.id,
    job_key: job?.job_key,
    artifact_id: job?.artifact_id,
    artifact_key: job?.artifact_key,
    concept_id: job?.concept_id,
    campaign: job?.campaign,
    platform: job?.platform,
    platform_content_id: job?.platform_content_id,
    due_at: job?.due_at,
    timezone: job?.timezone,
    scheduling_type: job?.scheduling_type,
    state: job?.state,
    provider_status: job?.provider_status,
    provider_scheduling_type: job?.provider_scheduling_type,
    provider_post_id: job?.provider_post_id,
    provider_due_at: job?.provider_due_at,
    provider_sent_at: job?.provider_sent_at,
    provider_external_link: isPublicHttpsUrl(job?.provider_external_link)
      ? job.provider_external_link
      : undefined,
    attempt_count: Number(job?.attempt_count || 0),
    next_retry_at: job?.next_retry_at,
    delivery_reconcile_target: job?.delivery_reconcile_target,
    last_error_code: job?.last_error_code,
    last_error_message: safeProviderError(job?.last_error_message, ""),
    resolved_by: job?.resolved_by,
    resolved_at: job?.resolved_at,
    resolution_evidence_note: job?.resolution_evidence_note,
    created_date: job?.created_date,
    updated_date: job?.updated_date,
  };
}

function safeSource(source: any): any {
  const { privacy_change_token: _internalFenceToken, ...fields } = source || {};
  return fields;
}

async function uniqueArtifactById(entity: any, id: any): Promise<any | null> {
  const artifactId = String(id || "").trim();
  if (!artifactId) return null;
  return await entity.get(artifactId).catch(() => null);
}

async function listAllDependencies(entity: any, label: string): Promise<any[]> {
  const records: any[] = [];
  for (
    let skip = 0;
    skip < MAX_DEPENDENCY_RECORDS;
    skip += DEPENDENCY_PAGE_SIZE
  ) {
    const page = asArray(await entity.list(
      "-created_date",
      DEPENDENCY_PAGE_SIZE,
      skip,
    ));
    records.push(...page);
    if (page.length < DEPENDENCY_PAGE_SIZE) return records;
  }
  throw new Error(`${label} exceeded the safe dependency limit.`);
}

function sourceSafetyDowngraded(current: any, next: any): boolean {
  return current?.active !== false
    && token(current?.privacy_status) === "safe"
    && (
      next?.active === false
      || token(next?.privacy_status) !== "safe"
  );
}

function sourceRenderIdentityChanged(current: any, next: any): boolean {
  return localReference(current?.source_reference)
      !== localReference(next?.source_reference)
    || normalized(current?.source_sha256)
      !== normalized(next?.source_sha256);
}

function sourceRequiresDependencyFence(current: any, next: any): boolean {
  return sourceSafetyDowngraded(current, next)
    || sourceRenderIdentityChanged(current, next);
}

function sourcePrivacyFenceActive(source: any, nowMs = Date.now()): boolean {
  if (source?.privacy_change_pending !== true) return false;
  const expiresMs = new Date(source?.privacy_change_expires_at || 0).getTime();
  return !Number.isFinite(expiresMs) || expiresMs > nowMs;
}

async function acquireSourcePrivacyFence(
  sourceEntity: any,
  source: any,
): Promise<any | null> {
  if (sourcePrivacyFenceActive(source)) return null;
  const tokenValue = crypto.randomUUID();
  const generation = Number(source?.privacy_change_generation || 0) + 1;
  const expiresAt = new Date(Date.now() + SOURCE_PRIVACY_FENCE_MS).toISOString();
  const result = await sourceEntity.updateMany(
    {
      id: source.id,
      updated_date: source.updated_date,
      ...(source?.privacy_change_pending === true
        ? {
          privacy_change_pending: true,
          privacy_change_generation: Number(
            source?.privacy_change_generation || 0,
          ),
          ...(source?.privacy_change_token
            ? { privacy_change_token: String(source.privacy_change_token) }
            : {}),
        }
        : {}),
    },
    {
      $set: {
        privacy_change_pending: true,
        privacy_change_token: tokenValue,
        privacy_change_expires_at: expiresAt,
      },
      $inc: { privacy_change_generation: 1 },
    },
  );
  if (Number(result?.updated || 0) !== 1) return null;
  const locked = await sourceEntity.get(source.id).catch(() => null);
  if (
    locked?.privacy_change_pending !== true
    || Number(locked?.privacy_change_generation || 0) !== generation
    || locked?.privacy_change_token !== tokenValue
  ) {
    await sourceEntity.updateMany(
      {
        id: source.id,
        privacy_change_pending: true,
        privacy_change_generation: generation,
        privacy_change_token: tokenValue,
      },
      {
        $set: {
          privacy_change_pending: false,
          privacy_change_token: "",
        },
        $unset: { privacy_change_expires_at: true },
      },
    ).catch(() => null);
    return null;
  }
  return {
    id: source.id,
    assetKey: token(source?.asset_key),
    generation,
    token: tokenValue,
    committed: false,
  };
}

async function releaseSourcePrivacyFence(
  sourceEntity: any,
  fence: any,
): Promise<void> {
  if (!fence || fence.committed) return;
  await sourceEntity.updateMany(
    {
      id: fence.id,
      privacy_change_pending: true,
      privacy_change_generation: fence.generation,
      privacy_change_token: fence.token,
    },
    {
      $set: {
        privacy_change_pending: false,
        privacy_change_token: "",
      },
      $unset: { privacy_change_expires_at: true },
    },
  ).catch(() => null);
}

function ownerVerifiedProviderCancellation(job: any): boolean {
  return Boolean(
    job?.provider_post_id
    && (
      token(job?.state) === "canceled"
      || (
        token(job?.state) === "delivery_reconcile"
        && token(job?.delivery_reconcile_target) === "canceled"
      )
    )
    && token(job?.last_error_code) === "owner_verified_provider_canceled",
  );
}

function durableSentEvidence(job: any): boolean {
  return token(job?.state) === "sent"
    || token(job?.provider_status) === "sent"
    || Boolean(timestamp(job?.provider_sent_at));
}

function optionalDraftFields(value: any): {
  set: any;
  unset: Record<string, boolean>;
} {
  const optional = [
    "generation_error",
    "cta_url",
    "disclosure",
    "media_url",
    "media_sha256",
    "mime_type",
    "width",
    "height",
    "duration_ms",
    "thumbnail_offset_ms",
    "render_result_schema",
    "render_pack_sha256",
    "render_template_id",
    "render_template_version",
    "render_input_sha256",
    "render_profile_id",
    "render_environment_sha256",
    "render_delivery_key",
    "render_source_lineage",
    "media_byte_size",
    "audio_mode",
    "growth_batch_key",
    "growth_batch_target_date",
    "growth_batch_slot_key",
    "review_note",
    "reviewed_by",
    "reviewed_at",
    "approved_hash",
    "approved_by",
    "approved_at",
    "revoked_at",
    "revocation_note",
    "schedule_lock_expires_at",
  ];
  const set = { ...value };
  const unset: Record<string, boolean> = {};
  for (const field of optional) {
    if (set[field] !== undefined) continue;
    delete set[field];
    unset[field] = true;
  }
  return { set, unset };
}

async function acquireScheduleLock(
  artifactEntity: any,
  artifact: any,
  approvedHash: string,
): Promise<any | null> {
  const now = Date.now();
  const artifactKey = token(artifact?.artifact_key);
  const rows = asArray(await artifactEntity.filter(
    { artifact_key: artifactKey },
    "-updated_date",
    50,
  ));
  const priorGeneration = Number(artifact?.schedule_lock_generation || 0);
  const priorToken = String(artifact?.schedule_lock_token || "");
  const priorExpiresAt = String(artifact?.schedule_lock_expires_at || "");
  if (
    !artifactKey
    || !rows.length
    || rows.some((row) => {
      const activeUntil = new Date(row?.schedule_lock_expires_at || 0).getTime();
      return row?.approval_status !== "approved"
        || row?.approved_hash !== approvedHash
        || Number(row?.schedule_lock_generation || 0) !== priorGeneration
        || String(row?.schedule_lock_token || "") !== priorToken
        || String(row?.schedule_lock_expires_at || "") !== priorExpiresAt
        || (
          row?.schedule_lock_token
          && Number.isFinite(activeUntil)
          && activeUntil > now
        );
    })
  ) {
    return null;
  }
  const tokenValue = crypto.randomUUID();
  const generation = priorGeneration + 1;
  const expiresAt = new Date(now + SCHEDULE_LOCK_MS).toISOString();
  const result = await artifactEntity.updateMany(
    {
      artifact_key: artifactKey,
      approval_status: "approved",
      approved_hash: approvedHash,
      schedule_lock_generation: priorGeneration,
      ...(priorToken ? { schedule_lock_token: priorToken } : {}),
      ...(priorExpiresAt ? { schedule_lock_expires_at: priorExpiresAt } : {}),
    },
    {
      $set: {
        schedule_lock_token: tokenValue,
        schedule_lock_expires_at: expiresAt,
      },
      $inc: { schedule_lock_generation: 1 },
    },
  );
  const lock = {
    token: tokenValue,
    generation,
    artifactKey,
    approvedHash,
    expiresAt,
    rowCount: rows.length,
  };
  if (Number(result?.updated || 0) !== rows.length) {
    await releaseScheduleLock(artifactEntity, lock);
    return null;
  }
  const locked = asArray(await artifactEntity.filter(
    { artifact_key: artifactKey },
    "-updated_date",
    50,
  ));
  if (
    locked.length !== rows.length
    || locked.some((row) => (
      row?.schedule_lock_token !== tokenValue
      || Number(row?.schedule_lock_generation || 0) !== generation
      || row?.approval_status !== "approved"
      || row?.approved_hash !== approvedHash
    ))
  ) {
    await releaseScheduleLock(artifactEntity, lock);
    return null;
  }
  return lock;
}

async function releaseScheduleLock(
  artifactEntity: any,
  lock: any,
): Promise<void> {
  await artifactEntity.updateMany(
    {
      artifact_key: lock.artifactKey,
      schedule_lock_token: lock.token,
      schedule_lock_generation: lock.generation,
    },
    {
      $set: { schedule_lock_token: "" },
      $unset: { schedule_lock_expires_at: true },
    },
  ).catch(() => null);
}

async function scheduleLockStillOwned(
  artifactEntity: any,
  lock: any,
): Promise<boolean> {
  const rows = asArray(await artifactEntity.filter(
    { artifact_key: lock.artifactKey },
    "-updated_date",
    50,
  ));
  const expiresMs = new Date(lock?.expiresAt || 0).getTime();
  return rows.length === lock.rowCount
    && Number.isFinite(expiresMs)
    && expiresMs > Date.now()
    && rows.every((row) => (
      row?.schedule_lock_token === lock.token
      && Number(row?.schedule_lock_generation || 0) === lock.generation
      && row?.approval_status === "approved"
      && row?.approved_hash === lock.approvedHash
      && row?.schedule_lock_expires_at === lock.expiresAt
    ));
}

async function renewScheduleLock(
  artifactEntity: any,
  lock: any,
): Promise<boolean> {
  const priorExpiresMs = new Date(lock?.expiresAt || 0).getTime();
  if (!Number.isFinite(priorExpiresMs) || priorExpiresMs <= Date.now()) {
    return false;
  }
  const expiresAt = new Date(Date.now() + SCHEDULE_LOCK_MS).toISOString();
  const result = await artifactEntity.updateMany(
    {
      artifact_key: lock.artifactKey,
      schedule_lock_token: lock.token,
      schedule_lock_generation: lock.generation,
      schedule_lock_expires_at: lock.expiresAt,
      approval_status: "approved",
      approved_hash: lock.approvedHash,
    },
    {
      $set: { schedule_lock_expires_at: expiresAt },
    },
  );
  if (Number(result?.updated || 0) !== lock.rowCount) return false;
  lock.expiresAt = expiresAt;
  return scheduleLockStillOwned(artifactEntity, lock);
}

function measurementSequence(content: string): number {
  let value = 2166136261;
  for (const character of content) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (Math.abs(value) % 10000) + 1;
}

function normalizedMeasurementPlatform(value: any): string {
  return token(value) === "tiktok" ? "tiktok" : "instagram";
}

async function measurementPlanRows(
  planEntity: any,
  platform: any,
  campaign: any,
  content: any,
): Promise<any[]> {
  const expectedPlatform = normalizedMeasurementPlatform(platform);
  return asArray(await planEntity.filter(
    {
      campaign: token(campaign, "1000-users"),
      content: token(content),
    },
    "-updated_date",
    50,
  )).filter((plan) => (
    normalizedMeasurementPlatform(plan?.platform) === expectedPlatform
  ));
}

function socialMeasurementPlan(artifact: any, dueAt: string): any {
  const platform = normalizedMeasurementPlatform(artifact?.platform);
  const platformLabel = platform === "tiktok" ? "TikTok" : "Instagram";
  return {
    platform,
    campaign: artifact.campaign,
    content: artifact.platform_content_id,
    sprint: "content-engine",
    sequence: measurementSequence(artifact.platform_content_id),
    format: artifact.format === "video" ? "reel" : "other",
    audience: "Door-to-door sales teams evaluating FirstKnock",
    hook: artifact.hook,
    script: artifact.provider_text,
    cta_label: artifact.cta_label,
    cta_channel: platform === "tiktok" ? "bio" : "caption_url",
    primary_metric: `${platformLabel} activated users`,
    hypothesis: `${artifact.pillar} content on ${platformLabel} will convert qualified organic reach into FirstKnock activation.`,
    comparison_group: token(`${artifact.pillar}-${artifact.format}`),
    major_variable: compactText(artifact.hook, 160),
    planned_publish_at: dueAt,
    snapshot_days: 7,
    delivery_managed_by: "buffer",
    delivery_status: "planned",
  };
}

async function setSocialMeasurementDelivery(
  planEntity: any,
  job: any,
  deliveryStatus: "planned" | "published" | "canceled",
): Promise<{ ok: boolean; error?: string }> {
  if (!PLATFORMS.has(token(job?.platform))) return { ok: true };
  const rows = await measurementPlanRows(
    planEntity,
    job?.platform,
    job?.campaign,
    job?.platform_content_id,
  );
  if (!rows.length && deliveryStatus === "canceled") return { ok: true };
  if (rows.length !== 1) return { ok: false, error: "content_plan_conflict" };
  const current = rows[0];
  if (timestamp(current?.published_at) && deliveryStatus !== "published") {
    return { ok: false, error: "content_plan_already_published" };
  }
  const result = await planEntity.updateMany(
    {
      id: current.id,
      updated_date: current.updated_date,
    },
    {
      $set: {
        delivery_managed_by: "buffer",
        delivery_status: deliveryStatus,
      },
    },
  );
  return Number(result?.updated || 0) === 1
    ? { ok: true }
    : { ok: false, error: "content_plan_changed_before_delivery_update" };
}

async function queueCanceledPlanReconciliation(
  jobEntity: any,
  job: any,
): Promise<any | null> {
  if (
    !PLATFORMS.has(token(job?.platform))
    || token(job?.state) !== "canceled"
  ) {
    return null;
  }
  const result = await jobEntity.updateMany(
    {
      id: job.id,
      state: "canceled",
      lease_generation: Number(job?.lease_generation || 0),
    },
    {
      $set: {
        state: "delivery_reconcile",
        delivery_reconcile_target: "canceled",
        next_retry_at: new Date().toISOString(),
      },
    },
  );
  return Number(result?.updated || 0) === 1
    ? await jobEntity.get(job.id).catch(() => null)
    : null;
}

async function reconcileCanceledMeasurementPlan(
  planEntity: any,
  jobEntity: any,
  job: any,
): Promise<{
  ok: boolean;
  repairPending?: boolean;
  job?: any;
  error?: string;
}> {
  const delivery = await setSocialMeasurementDelivery(
    planEntity,
    job,
    "canceled",
  ).catch(() => ({ ok: false, error: "content_plan_unavailable" }));
  if (delivery.ok) return { ok: true, repairPending: false, job };
  const latest = await jobEntity.get(job?.id).catch(() => job);
  const repair = await queueCanceledPlanReconciliation(jobEntity, latest);
  return repair
    ? {
      ok: true,
      repairPending: true,
      job: repair,
      error: delivery.error,
    }
    : { ok: false, job: latest, error: delivery.error };
}

async function syncSocialMeasurementPlan(
  planEntity: any,
  artifact: any,
  dueAt: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!PLATFORMS.has(token(artifact?.platform))) return { ok: true };
  const rows = await measurementPlanRows(
    planEntity,
    artifact?.platform,
    artifact?.campaign,
    artifact?.platform_content_id,
  );
  if (rows.length > 1) return { ok: false, error: "content_plan_conflict" };
  const plan = socialMeasurementPlan(artifact, dueAt);
  if (rows[0]?.published_at) {
    return { ok: false, error: "content_plan_already_published" };
  }
  if (rows[0]?.id) {
    const updated = await planEntity.updateMany(
      {
        id: rows[0].id,
        updated_date: rows[0].updated_date,
      },
      { $set: plan },
    );
    if (Number(updated?.updated || 0) !== 1) {
      return { ok: false, error: "content_plan_changed_before_schedule" };
    }
  } else {
    await planEntity.create(plan);
    const verified = await measurementPlanRows(
      planEntity,
      artifact?.platform,
      artifact?.campaign,
      artifact?.platform_content_id,
    );
    if (verified.length !== 1) {
      return { ok: false, error: "content_plan_conflict" };
    }
  }
  return { ok: true };
}

async function exactPublishJob(
  jobEntity: any,
  jobKey: string,
  requestHash: string,
  replaceTerminal = false,
): Promise<{ job?: any; terminal?: any; error?: string }> {
  const exact = asArray(await jobEntity.filter(
    { job_key: jobKey },
    "-created_date",
    20,
  ));
  if (exact.length > 1) return { error: "publish_job_conflict" };
  const current = exact[0];
  if (token(current?.state) === SCHEDULE_RESERVATION_STATE) {
    return { job: current };
  }
  if (
    token(current?.state) === "delivery_reconcile"
    && token(current?.delivery_reconcile_target) === "canceled"
  ) {
    return { error: "content_plan_cancellation_pending" };
  }
  if (
    current
    && replaceTerminal
    && (
      token(current?.state) === "sent"
      || token(current?.provider_status) === "sent"
      || timestamp(current?.provider_sent_at)
    )
  ) {
    return { error: "platform_content_already_published" };
  }
  if (
    current
    && replaceTerminal
    && current?.provider_post_id
    && !(
      token(current?.state) === "canceled"
      && token(current?.last_error_code) === "owner_verified_provider_canceled"
    )
  ) {
    return { error: "terminal_job_has_provider_evidence" };
  }
  if (
    current
    && replaceTerminal
    && ["failed", "canceled"].includes(token(current?.state))
  ) {
    return { terminal: current };
  }
  if (current && current?.request_hash !== requestHash) {
    return { error: "publish_job_request_conflict" };
  }
  return { job: current };
}

type ScheduleReservationCancellationResult = {
  finalized: boolean;
  repairPending?: boolean;
  contended?: boolean;
  error?: string;
  job?: any;
};

async function latestScheduleCancellationResult(
  jobEntity: any,
  jobId: string,
  errorCode: string,
): Promise<ScheduleReservationCancellationResult> {
  const latest = await jobEntity.get(jobId).catch(() => null);
  if (
    token(latest?.state) === "canceled"
    && token(latest?.last_error_code) === errorCode
  ) {
    return { finalized: true, job: latest };
  }
  if (
    token(latest?.state) === "delivery_reconcile"
    && token(latest?.delivery_reconcile_target) === "canceled"
    && token(latest?.last_error_code) === errorCode
  ) {
    return {
      finalized: false,
      repairPending: true,
      error: "content_plan_cancellation_pending",
      job: latest,
    };
  }
  return { finalized: false, contended: true, job: latest };
}

async function finalizeScheduleReservationCancellation(
  jobEntity: any,
  planEntity: any,
  repairJob: any,
  errorCode: string,
  finalMessage: string,
): Promise<ScheduleReservationCancellationResult> {
  const delivery = await setSocialMeasurementDelivery(
    planEntity,
    repairJob,
    "canceled",
  ).catch(() => ({ ok: false, error: "content_plan_unavailable" }));
  if (!delivery.ok) {
    return {
      finalized: false,
      repairPending: true,
      error: delivery.error,
      job: repairJob,
    };
  }
  const canceledAt = new Date().toISOString();
  const finalized = await jobEntity.updateMany(
    {
      id: repairJob.id,
      state: "delivery_reconcile",
      delivery_reconcile_target: "canceled",
      lease_generation: Number(repairJob?.lease_generation || 0),
      last_error_code: errorCode,
    },
    {
      $set: {
        state: "canceled",
        canceled_at: canceledAt,
        last_error_message: compactText(finalMessage, 240),
      },
      $unset: {
        delivery_reconcile_target: true,
        next_retry_at: true,
      },
    },
  );
  if (Number(finalized?.updated || 0) === 1) {
    return {
      finalized: true,
      job: await jobEntity.get(repairJob.id).catch(() => ({
        ...repairJob,
        state: "canceled",
        canceled_at: canceledAt,
      })),
    };
  }
  return latestScheduleCancellationResult(
    jobEntity,
    repairJob.id,
    errorCode,
  );
}

async function beginScheduleReservationCancellation(
  jobEntity: any,
  planEntity: any,
  reservation: any,
  ownershipFilter: any,
  errorCodeValue: string,
  errorMessage: string,
): Promise<ScheduleReservationCancellationResult> {
  if (!reservation?.id) return { finalized: false, contended: true };
  const errorCode = token(
    errorCodeValue,
    "schedule_reservation_aborted",
  );
  const finalMessage = compactText(errorMessage, 240)
    || "The scheduling reservation was safely released.";
  const retryMessage = compactText(
    `${finalMessage} Measurement-plan cancellation will retry.`,
    240,
  );
  const retryAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const result = await jobEntity.updateMany(
    ownershipFilter,
    {
      $set: {
        state: "delivery_reconcile",
        delivery_reconcile_target: "canceled",
        next_retry_at: retryAt,
        last_error_code: errorCode,
        last_error_message: retryMessage,
      },
      $unset: {
        canceled_at: true,
        lease_token: true,
        lease_acquired_at: true,
        lease_expires_at: true,
        lease_source_state: true,
      },
    },
  );
  if (Number(result?.updated || 0) !== 1) {
    return latestScheduleCancellationResult(
      jobEntity,
      reservation.id,
      errorCode,
    );
  }
  const repairJob = await jobEntity.get(reservation.id).catch(() => null);
  if (!repairJob?.id) {
    return {
      finalized: false,
      repairPending: true,
      error: "publish_job_not_found",
    };
  }
  return finalizeScheduleReservationCancellation(
    jobEntity,
    planEntity,
    repairJob,
    errorCode,
    finalMessage,
  );
}

async function expireScheduleReservation(
  jobEntity: any,
  planEntity: any,
  job: any,
): Promise<ScheduleReservationCancellationResult> {
  const observedExpiry = timestamp(job?.lease_expires_at);
  const nowIso = new Date().toISOString();
  if (
    token(job?.state) !== SCHEDULE_RESERVATION_STATE
    || !observedExpiry
    || scheduleReservationActive(job)
  ) {
    return { finalized: false, contended: true };
  }
  return beginScheduleReservationCancellation(
    jobEntity,
    planEntity,
    job,
    {
      id: job.id,
      state: SCHEDULE_RESERVATION_STATE,
      lease_generation: Number(job?.lease_generation || 0),
      ...(job?.lease_token ? { lease_token: job.lease_token } : {}),
      $and: [
        { lease_expires_at: observedExpiry },
        { lease_expires_at: { $lte: nowIso } },
      ],
    },
    "schedule_reservation_expired",
    "The scheduler reservation expired before it could be queued.",
  );
}

async function cancelOwnedScheduleReservation(
  jobEntity: any,
  reservation: any,
  errorCode: string,
  errorMessage: string,
  planEntity: any = null,
): Promise<ScheduleReservationCancellationResult> {
  if (!reservation?.id) return { finalized: false, contended: true };
  const normalizedErrorCode = token(
    errorCode,
    "schedule_reservation_aborted",
  );
  if (planEntity) {
    return beginScheduleReservationCancellation(
      jobEntity,
      planEntity,
      reservation,
      {
        id: reservation.id,
        state: SCHEDULE_RESERVATION_STATE,
        lease_token: reservation.lease_token,
        lease_generation: Number(reservation?.lease_generation || 0),
      },
      normalizedErrorCode,
      errorMessage,
    );
  }
  const canceledAt = new Date().toISOString();
  const result = await jobEntity.updateMany(
    {
      id: reservation.id,
      state: SCHEDULE_RESERVATION_STATE,
      lease_token: reservation.lease_token,
      lease_generation: Number(reservation?.lease_generation || 0),
    },
    {
      $set: {
        state: "canceled",
        canceled_at: canceledAt,
        last_error_code: normalizedErrorCode,
        last_error_message: compactText(
          errorMessage,
          240,
        ) || "The scheduling reservation was safely released.",
      },
      $unset: {
        lease_token: true,
        lease_acquired_at: true,
        lease_expires_at: true,
      },
    },
  );
  if (Number(result?.updated || 0) === 1) {
    return {
      finalized: true,
      job: await jobEntity.get(reservation.id).catch(() => ({
        ...reservation,
        state: "canceled",
        canceled_at: canceledAt,
      })),
    };
  }
  return latestScheduleCancellationResult(
    jobEntity,
    reservation.id,
    normalizedErrorCode,
  );
}

function scheduleReservationActive(job: any, nowMs = Date.now()): boolean {
  if (token(job?.state) !== SCHEDULE_RESERVATION_STATE) return false;
  const expiresMs = new Date(timestamp(job?.lease_expires_at) || 0).getTime();
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

function jobBlocksContentIdReuse(job: any): boolean {
  const state = token(job?.state);
  if (state === SCHEDULE_RESERVATION_STATE) {
    return scheduleReservationActive(job);
  }
  if (!TERMINAL_JOB_STATES.has(state)) return true;
  if (
    state === "sent"
    || token(job?.provider_status) === "sent"
    || timestamp(job?.provider_sent_at)
  ) {
    return true;
  }
  if (!job?.provider_post_id) return false;
  return !(
    state === "canceled"
    && token(job?.last_error_code) === "owner_verified_provider_canceled"
  );
}

function scheduleReservationPrecedes(candidate: any, current: any): boolean {
  const candidateTime = new Date(
    timestamp(candidate?.lease_acquired_at)
      || timestamp(candidate?.created_date)
      || 0,
  ).getTime();
  const currentTime = new Date(
    timestamp(current?.lease_acquired_at)
      || timestamp(current?.created_date)
      || 0,
  ).getTime();
  if (candidateTime !== currentTime) return candidateTime < currentTime;
  const keyOrder = String(candidate?.job_key || "")
    .localeCompare(String(current?.job_key || ""));
  if (keyOrder) return keyOrder < 0;
  return String(candidate?.id || "").localeCompare(String(current?.id || "")) < 0;
}

function reservationCompetitorJobs(jobs: any[], current: any): any[] {
  return jobs.filter((job) => {
    if (String(job?.id || "") === String(current?.id || "")) return false;
    if (token(job?.state) !== SCHEDULE_RESERVATION_STATE) return true;
    return scheduleReservationActive(job)
      && scheduleReservationPrecedes(job, current);
  });
}

function contentIdReuseError(jobs: any[]): string {
  if (jobs.some((job) => (
    token(job?.state) === "sent"
    || token(job?.provider_status) === "sent"
    || timestamp(job?.provider_sent_at)
  ))) {
    return "platform_content_already_published";
  }
  if (jobs.some((job) => job?.provider_post_id)) {
    return "terminal_job_has_provider_evidence";
  }
  return "platform_content_already_scheduled";
}

async function waitForContendedPublishJob(
  jobEntity: any,
  jobKey: string,
  requestHash: string,
): Promise<{ job?: any; error?: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await exactPublishJob(jobEntity, jobKey, requestHash);
    if (result.job || result.error) return result;
  }
  return {};
}

async function readBody(req: Request): Promise<any> {
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    throw Object.assign(new Error("content_engine_request_too_large"), { status: 413 });
  }
  return JSON.parse(raw || "{}");
}

function generatorSchema(): any {
  return {
    type: "object",
    properties: {
      variants: {
        type: "array",
        items: {
          type: "object",
          properties: {
            platform: { type: "string", enum: ["instagram", "tiktok"] },
            format: { type: "string", enum: ["video", "photo"] },
            hook: { type: "string" },
            caption: { type: "string" },
            overlay_text: { type: "array", items: { type: "string" } },
            shot_list: { type: "array", items: { type: "string" } },
            cta_label: { type: "string" },
            disclosure: { type: "string" },
          },
          required: [
            "platform",
            "format",
            "hook",
            "caption",
            "overlay_text",
            "shot_list",
            "cta_label",
          ],
        },
      },
    },
    required: ["variants"],
  };
}

function exactSha256(value: any): string {
  const hash = normalized(value);
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function batchContentProfile(batch: any): string {
  if (
    !batch
    || !Object.prototype.hasOwnProperty.call(batch, "content_profile")
  ) {
    return NEXT_BATCH_PROFILE;
  }
  return token(batch.content_profile);
}

function batchInputMode(batch: any): string {
  if (
    !batch
    || !Object.prototype.hasOwnProperty.call(batch, "batch_input_mode")
  ) {
    return BATCH_INPUT_REVIEWED;
  }
  return token(batch.batch_input_mode);
}

function cloneJson(value: any): any {
  return JSON.parse(JSON.stringify(value));
}

function phoenixDateKey(nowMs = Date.now()): string {
  return new Date(nowMs - 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function phoenixDateStart(value: any): number {
  const dateKey = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return 0;
  const parsed = new Date(`${dateKey}T07:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime())
    || new Date(parsed.getTime() - 7 * 60 * 60 * 1000)
      .toISOString().slice(0, 10) !== dateKey
  ) {
    return 0;
  }
  return parsed.getTime();
}

function validBatchTargetDate(value: any, nowMs = Date.now()): string {
  const dateKey = String(value || "").trim();
  const targetMs = phoenixDateStart(dateKey);
  const todayMs = phoenixDateStart(phoenixDateKey(nowMs));
  if (
    !targetMs
    || !todayMs
    || targetMs < todayMs
    || targetMs > todayMs + MAX_BATCH_TARGET_DAYS * DAY_MS
  ) {
    return "";
  }
  return dateKey;
}

function scheduledGenerationTargetDate(nowMs = Date.now()): string {
  const todayMs = phoenixDateStart(phoenixDateKey(nowMs));
  return todayMs
    ? phoenixDateKey(todayMs + SCHEDULED_GENERATION_LEAD_DAYS * DAY_MS)
    : "";
}

function batchSlotDueAt(targetDate: any, slotValue: any): string {
  const dateKey = String(targetDate || "").trim();
  const slot = token(slotValue);
  const localTime = {
    morning: "09:30:00",
    midday: "13:30:00",
    evening: "18:30:00",
  }[slot];
  if (!phoenixDateStart(dateKey) || !localTime) return "";
  return new Date(`${dateKey}T${localTime}-07:00`).toISOString();
}

function metricObservedFields(metric: any): string[] | null {
  const manualFields = Array.isArray(metric?.observed_metric_fields)
    ? metric.observed_metric_fields
    : null;
  const providerFields = normalized(metric?.metric_source) === "buffer"
      && Array.isArray(metric?.provider_observed_metric_types)
    ? metric.provider_observed_metric_types
    : null;
  const observedFields = manualFields || providerFields;
  if (!observedFields) return null;
  const observed = new Set(
    observedFields.map((field: any) => normalized(field)),
  );
  return CONTENT_METRIC_FIELDS.filter((field) => observed.has(field));
}

function batchSnapshotPayload(metric: any): string {
  const payload: any = {
    campaign: token(metric?.campaign, "1000-users"),
    content: token(metric?.content),
    snapshot_days: Number(metric?.snapshot_days || 7),
    snapshot_captured_at: timestamp(metric?.snapshot_captured_at) || "",
    published_at: timestamp(metric?.published_at) || "",
    reach: Number(metric?.reach || 0),
    views: Number(metric?.views || 0),
    shares: Number(metric?.shares || 0),
    saves: Number(metric?.saves || 0),
    comments: Number(metric?.comments || 0),
    follows: Number(metric?.follows || 0),
    profile_visits: Number(metric?.profile_visits || 0),
    link_clicks: Number(metric?.link_clicks || 0),
    dm_intents: Number(metric?.dm_intents || 0),
  };
  const observedFields = metricObservedFields(metric);
  if (observedFields) payload.observed_fields = observedFields;
  return JSON.stringify(payload);
}

function exactNonNegativeInteger(value: any): number | null {
  return typeof value === "number"
      && Number.isSafeInteger(value)
      && value >= 0
    ? value
    : null;
}

function reviewedPlatformNativeExposure(metric: any): {
  fields: string[];
  values: { reach: number | null; views: number | null };
} {
  const observedFields = metricObservedFields(metric)
    || CONTENT_METRIC_FIELDS.filter(
      (field) => Object.prototype.hasOwnProperty.call(metric || {}, field),
    );
  const fields = ["reach", "views"].filter((field) => (
    observedFields.includes(field)
    && exactNonNegativeInteger(metric?.[field]) !== null
  ));
  return {
    fields,
    values: {
      reach: fields.includes("reach")
        ? exactNonNegativeInteger(metric?.reach)
        : null,
      views: fields.includes("views")
        ? exactNonNegativeInteger(metric?.views)
        : null,
    },
  };
}

async function validatedStoredDecisionPolicy(
  plan: any,
  metric: any,
  {
    decision,
    evidenceHash,
    snapshotDays,
    reviewedSnapshotAt,
    conversionEvidence,
    conversionEvidenceHash,
    conversionCutoffAt,
    reviewedAt,
  }: any,
): Promise<any> {
  if (
    token(plan?.review_schema_version) !== REVIEW_SCHEMA_VERSION
    || normalized(plan?.review_decision_policy_id)
      !== GROWTH_DECISION_POLICY_ID
    || exactNonNegativeInteger(
      plan?.review_comparable_fixed_age_snapshots,
    ) !== 0
    || !Array.isArray(plan?.review_decision_policy_reason_codes)
    || !exactSha256(plan?.review_decision_policy_evidence_hash)
    || !exactSha256(plan?.review_identity_hash)
  ) {
    return { error: "reviewed_parent_decision_policy_stale" };
  }

  const storedOverrideNote = plan?.review_decision_override_note;
  const overrideNote = normalizeGrowthDecisionOverrideNote(
    storedOverrideNote,
  );
  const overrideHash = exactSha256(plan?.review_decision_override_hash);
  if (
    (
      storedOverrideNote !== undefined
      && storedOverrideNote !== null
      && String(storedOverrideNote) !== overrideNote
    )
    || (
      overrideNote
        ? !overrideHash
          || await sha256Hex(overrideNote) !== overrideHash
        : Boolean(overrideHash)
    )
  ) {
    return { error: "reviewed_parent_decision_policy_stale" };
  }

  const exposure = reviewedPlatformNativeExposure(metric);
  const policy = evaluateGrowthDecisionSufficiency({
    decision,
    fixed_age_snapshot_valid: true,
    social_evidence_hash: evidenceHash,
    snapshot_days: snapshotDays,
    snapshot_captured_at: reviewedSnapshotAt,
    observed_platform_native_exposure_fields: exposure.fields,
    platform_native_exposure: exposure.values,
    conversion_evidence: conversionEvidence,
    comparable_fixed_age_snapshots: 0,
    override_note: overrideNote,
    override_hash: overrideHash,
  });
  if (!policy.supported) {
    return { error: "reviewed_parent_decision_not_supported" };
  }

  const policyEvidenceHash = await sha256Hex(
    canonicalStringify(policy.evidence),
  );
  if (
    policy.policy_id !== GROWTH_DECISION_POLICY_ID
    || canonicalStringify(plan.review_decision_policy_reason_codes)
      !== canonicalStringify(policy.reason_codes)
    || exactSha256(plan.review_decision_policy_evidence_hash)
      !== policyEvidenceHash
    || String(plan?.review_decision_override_note || "")
      !== (policy.override_note || "")
    || exactSha256(plan?.review_decision_override_hash)
      !== (policy.override_hash || "")
  ) {
    return { error: "reviewed_parent_decision_policy_stale" };
  }

  const reviewIdentityHash = await sha256Hex(canonicalStringify({
    review_schema_version: REVIEW_SCHEMA_VERSION,
    evidence_hash: evidenceHash,
    conversion_evidence_hash: conversionEvidenceHash,
    conversion_cutoff_at: conversionCutoffAt,
    decision,
    decision_note: String(plan?.review_note || ""),
    reviewed_at: reviewedAt,
    review_snapshot_captured_at: reviewedSnapshotAt,
    decision_policy_id: policy.policy_id,
    decision_policy_reason_codes: policy.reason_codes,
    decision_policy_evidence_hash: policyEvidenceHash,
    decision_override_note: policy.override_note || "",
    decision_override_hash: policy.override_hash || "",
  }));
  if (exactSha256(plan?.review_identity_hash) !== reviewIdentityHash) {
    return { error: "reviewed_parent_decision_policy_stale" };
  }

  return {
    policyId: policy.policy_id,
    reasonCodes: policy.reason_codes,
    policyEvidenceHash,
    comparableFixedAgeSnapshots: 0,
    overrideNote: policy.override_note || "",
    overrideHash: policy.override_hash || "",
    reviewIdentityHash,
  };
}

async function validatedStoredConversionEvidence(
  plan: any,
  metric: any,
  {
    platform,
    campaign,
    content,
    publishedAt,
    snapshotDays,
    reviewedSnapshotAt,
    evidenceHash,
    reviewedAt,
    windowClosesAt,
  }: any,
): Promise<any | null> {
  const raw = plan?.review_conversion_evidence;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (
    canonicalStringify(Object.keys(raw).sort())
      !== canonicalStringify([...CONVERSION_EVIDENCE_FIELDS].sort())
  ) {
    return null;
  }
  const cohortStartAt = timestamp(raw?.cohort_start_at);
  const cutoffAt = timestamp(raw?.cutoff_at);
  const storedCutoffAt = timestamp(plan?.review_conversion_cutoff_at);
  const cohortStartMs = cohortStartAt
    ? new Date(cohortStartAt).getTime()
    : 0;
  const cutoffMs = cutoffAt ? new Date(cutoffAt).getTime() : 0;
  const snapshotMs = new Date(reviewedSnapshotAt || 0).getTime();
  const reviewedMs = new Date(reviewedAt || 0).getTime();
  const windowCloseMs = new Date(windowClosesAt || 0).getTime();
  const exactHandoff = DECLARED_CLICKABLE_HANDOFFS.has(
    normalized(plan?.cta_channel),
  );
  const expectedAttributionMethod = exactHandoff
    ? "declared_content_link"
    : "social_evidence_only";
  const expectedConclusion = exactHandoff
    ? "exact_declared_link"
    : "inconclusive_no_declared_link";
  if (
    raw?.schema_version !== CONVERSION_EVIDENCE_SCHEMA
    || raw?.platform !== platform
    || raw?.campaign !== campaign
    || raw?.content !== content
    || raw?.cohort_start_at !== cohortStartAt
    || cohortStartAt !== publishedAt
    || raw?.cutoff_at !== cutoffAt
    || cutoffAt !== reviewedSnapshotAt
    || raw?.snapshot_days !== snapshotDays
    || raw?.snapshot_captured_at !== reviewedSnapshotAt
    || exactSha256(raw?.social_evidence_hash) !== evidenceHash
    || raw?.attribution_method !== expectedAttributionMethod
    || raw?.post_conversion_eligible !== exactHandoff
    || raw?.conversion_conclusion !== expectedConclusion
    || raw?.conversion_counters_available !== exactHandoff
    || !cohortStartAt
    || !cutoffAt
    || storedCutoffAt !== cutoffAt
    || !Number.isFinite(cohortStartMs)
    || !Number.isFinite(snapshotMs)
    || !Number.isFinite(reviewedMs)
    || !Number.isFinite(windowCloseMs)
    || cutoffMs < cohortStartMs
    || cutoffMs > reviewedMs
    || cutoffMs > windowCloseMs
  ) {
    return null;
  }
  const rawObservedFields = raw?.owned_intent_observed_fields;
  if (!Array.isArray(rawObservedFields)) return null;
  const metricFields = metricObservedFields(metric)
    || CONTENT_METRIC_FIELDS.filter(
      (field) => Object.prototype.hasOwnProperty.call(metric || {}, field),
    );
  const expectedObservedFields = OWNED_INTENT_FIELDS.filter(
    (field) => metricFields.includes(field),
  );
  if (
    canonicalStringify(rawObservedFields)
      !== canonicalStringify(expectedObservedFields)
    || new Set(rawObservedFields).size !== rawObservedFields.length
  ) {
    return null;
  }
  for (const field of CONVERSION_EVIDENCE_SOCIAL_COUNTER_FIELDS) {
    if (exactNonNegativeInteger(raw?.[field]) === null) return null;
  }
  const metricLinkClicks = Object.prototype.hasOwnProperty.call(
    metric || {},
    "link_clicks",
  )
    ? exactNonNegativeInteger(metric?.link_clicks)
    : 0;
  const metricDmIntents = Object.prototype.hasOwnProperty.call(
    metric || {},
    "dm_intents",
  )
    ? exactNonNegativeInteger(metric?.dm_intents)
    : 0;
  if (
    metricLinkClicks === null
    || metricDmIntents === null
    || raw.link_clicks !== (
      expectedObservedFields.includes("link_clicks") ? metricLinkClicks : 0
    )
    || raw.dm_intents !== (
      expectedObservedFields.includes("dm_intents") ? metricDmIntents : 0
    )
    || raw.owned_intents !== raw.link_clicks + raw.dm_intents
  ) {
    return null;
  }
  const expectedRetentionMature = cutoffMs
    >= cohortStartMs + 30 * DAY_MS;
  if (
    raw?.retention_window_days !== 30
    || raw?.retention_mature !== expectedRetentionMature
  ) {
    return null;
  }
  if (exactHandoff) {
    for (const field of CONVERSION_EVIDENCE_DOWNSTREAM_FIELDS) {
      if (exactNonNegativeInteger(raw?.[field]) === null) return null;
    }
    const retentionEligibleUsers = exactNonNegativeInteger(
      raw?.retention_eligible_users,
    );
    const retainedUsers = exactNonNegativeInteger(raw?.retained_users);
    const retentionRate = typeof raw?.retention_rate === "number"
        && Number.isFinite(raw.retention_rate)
        && raw.retention_rate >= 0
        && raw.retention_rate <= 1
      ? raw.retention_rate
      : null;
    if (
      raw?.activation_timing_complete !== true
      || raw?.paid_timing_complete !== true
      || retentionEligibleUsers === null
      || retainedUsers === null
      || retainedUsers > retentionEligibleUsers
      || (
        !expectedRetentionMature
        && (
          retentionEligibleUsers !== 0
          || retainedUsers !== 0
          || raw?.retention_rate !== null
        )
      )
      || (
        retentionEligibleUsers === 0
          ? raw?.retention_rate !== null
          : retentionRate === null
            || retentionRate !== retainedUsers / retentionEligibleUsers
      )
    ) {
      return null;
    }
    const activatedUsers = exactNonNegativeInteger(raw?.activated_users);
    const firstActivationAt = timestamp(raw?.first_activation_at);
    const lastActivationAt = timestamp(raw?.last_activation_at);
    if (
      raw?.first_activation_at !== firstActivationAt
      || raw?.last_activation_at !== lastActivationAt
      || (
        activatedUsers === 0
          ? firstActivationAt !== null || lastActivationAt !== null
          : !firstActivationAt
            || !lastActivationAt
            || new Date(firstActivationAt).getTime() < cohortStartMs
            || new Date(firstActivationAt).getTime()
              > new Date(lastActivationAt).getTime()
            || new Date(lastActivationAt).getTime() > cutoffMs
      )
    ) {
      return null;
    }
  } else {
    const unavailableFields = [
      ...CONVERSION_EVIDENCE_DOWNSTREAM_FIELDS,
      "first_activation_at",
      "last_activation_at",
      "retention_eligible_users",
      "retained_users",
      "retention_rate",
    ];
    if (
      raw?.activation_timing_complete !== false
      || raw?.paid_timing_complete !== false
      || unavailableFields.some((field) => raw?.[field] !== null)
    ) {
      return null;
    }
  }
  const conversionEvidenceHash = await sha256Hex(canonicalStringify(raw));
  if (
    conversionEvidenceHash
      !== exactSha256(plan?.review_conversion_evidence_hash)
  ) {
    return null;
  }
  return {
    evidence: raw,
    conversionEvidenceHash,
    conversionCutoffAt: cutoffAt,
  };
}

function newestBatchMetric(records: any[]): {
  metric?: any;
  conflict?: boolean;
} {
  if (!records.length) return {};
  const sorted = [...records].sort((left, right) => (
    new Date(timestamp(right?.snapshot_captured_at) || 0).getTime()
      - new Date(timestamp(left?.snapshot_captured_at) || 0).getTime()
    || String(right?.updated_date || "").localeCompare(
      String(left?.updated_date || ""),
    )
    || String(right?.created_date || "").localeCompare(
      String(left?.created_date || ""),
    )
  ));
  const latestCapturedAt = timestamp(sorted[0]?.snapshot_captured_at);
  const candidates = sorted.filter(
    (record) => timestamp(record?.snapshot_captured_at) === latestCapturedAt,
  );
  if (new Set(candidates.map(batchSnapshotPayload)).size > 1) {
    return { conflict: true };
  }
  return { metric: candidates[0] };
}

async function loadReviewedBatchEvidence(
  planEntity: any,
  metricEntity: any,
  parentValue: any,
): Promise<any> {
  const platform = token(parentValue?.platform);
  const campaign = token(parentValue?.campaign, "1000-users");
  const content = token(parentValue?.content);
  if (!PLATFORMS.has(platform) || !campaign || !content) {
    return { error: "invalid_reviewed_parent", status: 400 };
  }
  const plans = asArray(await planEntity.filter(
    { campaign, content },
    "-updated_date",
    50,
  )).filter((plan) => normalizedMeasurementPlatform(plan?.platform) === platform);
  if (plans.length !== 1) {
    return {
      error: plans.length ? "content_plan_conflict" : "content_plan_not_found",
      status: plans.length ? 409 : 404,
    };
  }
  const plan = plans[0];
  const publishedAt = timestamp(plan?.published_at);
  const decision = token(plan?.review_decision);
  const evidenceHash = exactSha256(plan?.review_evidence_hash);
  const reviewedAt = timestamp(plan?.reviewed_at);
  const reviewedSnapshotAt = timestamp(plan?.review_snapshot_captured_at);
  if (
    !publishedAt
    || token(plan?.delivery_status) === "canceled"
  ) {
    return { error: "reviewed_parent_not_published", status: 409 };
  }
  if (decision === "hold") {
    return { error: "reviewed_parent_on_hold", status: 409 };
  }
  if (
    !["repeat", "iterate"].includes(decision)
    || !evidenceHash
    || !reviewedAt
    || !reviewedSnapshotAt
  ) {
    return { error: "reviewed_parent_required", status: 409 };
  }
  if (unsafeGeneratedText(plan?.review_note)) {
    return { error: "reviewed_parent_note_not_generation_safe", status: 409 };
  }
  const snapshotDays = Number(plan?.snapshot_days || 7);
  const metrics = asArray(await metricEntity.filter(
    { campaign, content, snapshot_days: snapshotDays },
    "-snapshot_captured_at",
    50,
  )).filter(
    (metric) => normalizedMeasurementPlatform(metric?.platform) === platform,
  );
  const canonical = newestBatchMetric(metrics);
  if (canonical.conflict) {
    return { error: "content_snapshot_conflict", status: 409 };
  }
  const metric = canonical.metric;
  const capturedAt = timestamp(metric?.snapshot_captured_at);
  const dueMs = new Date(publishedAt).getTime() + snapshotDays * DAY_MS;
  const closeMs = dueMs + SNAPSHOT_GRACE_MS;
  const capturedMs = capturedAt ? new Date(capturedAt).getTime() : 0;
  if (!metric?.id || !capturedAt || capturedMs < dueMs) {
    return { error: "fixed_age_snapshot_required", status: 409 };
  }
  if (capturedMs > closeMs) {
    return { error: "fixed_age_snapshot_window_missed", status: 409 };
  }
  const computedEvidenceHash = await sha256Hex(batchSnapshotPayload(metric));
  if (
    exactSha256(metric?.snapshot_fingerprint) !== computedEvidenceHash
    || evidenceHash !== computedEvidenceHash
    || reviewedSnapshotAt !== capturedAt
  ) {
    return { error: "reviewed_parent_evidence_stale", status: 409 };
  }
  const conversion = await validatedStoredConversionEvidence(
    plan,
    metric,
    {
      platform,
      campaign,
      content,
      publishedAt,
      snapshotDays,
      reviewedSnapshotAt,
      evidenceHash,
      reviewedAt,
      windowClosesAt: new Date(closeMs).toISOString(),
    },
  );
  if (!conversion) {
    return {
      error: "reviewed_parent_conversion_evidence_stale",
      status: 409,
    };
  }
  const policy = await validatedStoredDecisionPolicy(plan, metric, {
    decision,
    evidenceHash,
    snapshotDays,
    reviewedSnapshotAt,
    conversionEvidence: conversion.evidence,
    conversionEvidenceHash: conversion.conversionEvidenceHash,
    conversionCutoffAt: conversion.conversionCutoffAt,
    reviewedAt,
  });
  if (policy?.error) {
    return { error: policy.error, status: 409 };
  }
  return {
    platform,
    campaign,
    content,
    plan,
    metric,
    decision,
    evidenceHash,
    reviewHash: policy.reviewIdentityHash,
    reviewSchemaVersion: REVIEW_SCHEMA_VERSION,
    decisionPolicyId: policy.policyId,
    decisionPolicyReasonCodes: policy.reasonCodes,
    decisionPolicyEvidenceHash: policy.policyEvidenceHash,
    comparableFixedAgeSnapshots: policy.comparableFixedAgeSnapshots,
    decisionOverrideNote: policy.overrideNote,
    decisionOverrideHash: policy.overrideHash,
    conversionEvidence: conversion.evidence,
    conversionEvidenceHash: conversion.conversionEvidenceHash,
    conversionCutoffAt: conversion.conversionCutoffAt,
    reviewedAt,
    reviewedSnapshotAt,
  };
}

function scheduledGenerationParent(value: any): any | null {
  const platform = normalizedMeasurementPlatform(value?.platform);
  const campaign = token(value?.campaign);
  const content = token(value?.content);
  if (
    !PLATFORMS.has(platform)
    || campaign !== PRODUCTION_GROWTH_CAMPAIGN
    || !content
  ) {
    return null;
  }
  return { platform, campaign, content };
}

function scheduledBatchParent(batch: any): any | null {
  return scheduledGenerationParent({
    platform: batch?.parent_platform,
    campaign: batch?.parent_campaign,
    content: batch?.parent_content,
  });
}

function batchDecisionPolicyMatches(batch: any, evidence: any): boolean {
  return token(batch?.review_schema_version) === REVIEW_SCHEMA_VERSION
    && normalized(batch?.decision_policy_id) === evidence.decisionPolicyId
    && canonicalStringify(batch?.decision_policy_reason_codes)
      === canonicalStringify(evidence.decisionPolicyReasonCodes)
    && exactSha256(batch?.decision_policy_evidence_hash)
      === evidence.decisionPolicyEvidenceHash
    && exactNonNegativeInteger(batch?.comparable_fixed_age_snapshots)
      === evidence.comparableFixedAgeSnapshots
    && String(batch?.decision_override_note || "")
      === evidence.decisionOverrideNote
    && exactSha256(batch?.decision_override_hash)
      === evidence.decisionOverrideHash;
}

async function prepareScheduledGenerationRequest(
  body: any,
  planEntity: any,
  metricEntity: any,
  batchEntity: any,
  sourceEntity: any,
): Promise<any> {
  if (
    !body
    || typeof body !== "object"
    || Array.isArray(body)
    || Object.keys(body).some(
      (field) => !SCHEDULED_GENERATION_REQUEST_FIELDS.has(field),
    )
  ) {
    return { error: "invalid_scheduled_generation_request", status: 400 };
  }
  const seedPack = body?.seed_pack?.pack || body?.seed_pack;
  if (!seedPack || typeof seedPack !== "object" || Array.isArray(seedPack)) {
    return { error: "scheduled_generation_seed_pack_required", status: 400 };
  }
  const targetDate = scheduledGenerationTargetDate();
  if (!targetDate) {
    return { error: "scheduled_generation_target_date_unavailable", status: 503 };
  }

  const allBatches = await listAllDependencies(
    batchEntity,
    "Growth content batches",
  );
  const targetRows = allBatches.filter((batch) => (
    String(batch?.target_date || "") === targetDate
    && token(batch?.state) !== "superseded"
  ));
  if (targetRows.length > 1) {
    return { error: "scheduled_generation_date_conflict", status: 409 };
  }

  const existing = targetRows[0];
  let parent: any | null = null;
  if (existing) {
    const state = token(existing?.state);
    if (state === "revoked") {
      return { error: "scheduled_generation_date_revoked", status: 409 };
    }
    const slotKeys = cleanTokenList(existing?.slot_keys, 3);
    const seedConceptIds = cleanTokenList(existing?.seed_concept_ids, 3);
    parent = scheduledBatchParent(existing);
    if (
      !parent
      || batchInputMode(existing) !== BATCH_INPUT_REVIEWED
      || batchContentProfile(existing) !== FEATURE_EXPLAINER_VIDEO_PROFILE
      || Number(existing?.concept_count || 0) !== 2
      || Number(existing?.slot_count || 0) !== 2
      || canonicalStringify(slotKeys)
        !== canonicalStringify(NEXT_BATCH_SLOTS.slice(0, 2))
      || seedConceptIds.length !== 2
      || new Set(seedConceptIds).size !== 2
      || token(existing?.timezone) !== token(NEXT_BATCH_TIMEZONE)
      || !["generating", "ready", "render_authorized", "failed"].includes(state)
    ) {
      return { error: "scheduled_generation_date_incompatible", status: 409 };
    }
    if (
      state === "failed"
      && Number(existing?.attempt_count || 0) >= SCHEDULED_GENERATION_MAX_ATTEMPTS
    ) {
      return { error: "scheduled_generation_attempts_exhausted", status: 409 };
    }
  } else {
    const plans = await listAllDependencies(
      planEntity,
      "Growth content plans",
    );
    const candidates = plans.filter((plan) => (
      scheduledGenerationParent(plan)
      && Boolean(timestamp(plan?.published_at))
      && token(plan?.delivery_status) !== "canceled"
      && ["repeat", "iterate"].includes(token(plan?.review_decision))
      && Boolean(timestamp(plan?.reviewed_at))
      && Boolean(timestamp(plan?.review_snapshot_captured_at))
      && Boolean(exactSha256(plan?.review_evidence_hash))
      && Boolean(exactSha256(plan?.review_conversion_evidence_hash))
      && Boolean(timestamp(plan?.review_conversion_cutoff_at))
    )).sort((left, right) => (
      new Date(timestamp(right?.reviewed_at) || 0).getTime()
        - new Date(timestamp(left?.reviewed_at) || 0).getTime()
      || String(right?.updated_date || "").localeCompare(
        String(left?.updated_date || ""),
      )
      || String(right?.created_date || "").localeCompare(
        String(left?.created_date || ""),
      )
      || String(right?.id || "").localeCompare(String(left?.id || ""))
    ));
    if (!candidates.length) {
      return { error: "scheduled_generation_reviewed_parent_required", status: 409 };
    }
    const latestReviewedAt = timestamp(candidates[0]?.reviewed_at);
    const latestParents = new Map<string, any>();
    for (const candidate of candidates) {
      if (timestamp(candidate?.reviewed_at) !== latestReviewedAt) break;
      const candidateParent = scheduledGenerationParent(candidate);
      if (!candidateParent) continue;
      latestParents.set(
        `${candidateParent.platform}|${candidateParent.campaign}|${candidateParent.content}`,
        candidateParent,
      );
    }
    if (latestParents.size !== 1) {
      return { error: "scheduled_generation_parent_conflict", status: 409 };
    }
    parent = latestParents.values().next().value || null;
  }

  const evidence = await loadReviewedBatchEvidence(
    planEntity,
    metricEntity,
    parent,
  );
  if (evidence?.error) {
    return { error: evidence.error, status: evidence.status || 409 };
  }
  const batchKey = await sha256Hex(canonicalStringify({
    schema: NEXT_BATCH_SCHEMA,
    parent: {
      platform: evidence.platform,
      campaign: evidence.campaign,
      content: evidence.content,
    },
    review_schema_version: evidence.reviewSchemaVersion,
    review_hash: evidence.reviewHash,
    decision_policy_id: evidence.decisionPolicyId,
    decision_policy_evidence_hash: evidence.decisionPolicyEvidenceHash,
    conversion_evidence_hash: evidence.conversionEvidenceHash,
    conversion_cutoff_at: evidence.conversionCutoffAt,
    target_date: targetDate,
    content_profile: FEATURE_EXPLAINER_VIDEO_PROFILE,
  }));
  if (existing && exactSha256(existing?.batch_key) !== batchKey) {
    return { error: "scheduled_generation_existing_batch_stale", status: 409 };
  }
  if (
    existing
    && ["ready", "render_authorized"].includes(token(existing?.state))
  ) {
    const seedPackSha256 = await sha256Hex(canonicalStringify(seedPack));
    if (
      !configuredRenderPackHashes().has(seedPackSha256)
      || exactSha256(existing?.seed_pack_sha256) !== seedPackSha256
    ) {
      return { error: "scheduled_generation_seed_pack_conflict", status: 409 };
    }
    const current = await validateCurrentBatch(
      existing,
      planEntity,
      metricEntity,
      sourceEntity,
    );
    if (!current.ok) {
      return { error: current.error, status: 409 };
    }
    return { existing, pack: current.pack };
  }

  return {
    request: {
      action: "build_next_batch",
      parent,
      target_date: targetDate,
      concept_count: 2,
      content_profile: FEATURE_EXPLAINER_VIDEO_PROFILE,
      seed_pack: body.seed_pack,
    },
  };
}

function safeBatch(batch: any): any {
  return {
    id: batch?.id,
    batch_input_mode: batchInputMode(batch),
    batch_key: batch?.batch_key,
    request_hash: batch?.request_hash,
    parent_platform: batch?.parent_platform,
    parent_campaign: batch?.parent_campaign,
    parent_content: batch?.parent_content,
    review_hash: batch?.review_hash,
    review_schema_version: batch?.review_schema_version,
    decision_policy_id: batch?.decision_policy_id,
    decision_policy_reason_codes: Array.isArray(
      batch?.decision_policy_reason_codes,
    ) ? batch.decision_policy_reason_codes : [],
    decision_policy_evidence_hash: batch?.decision_policy_evidence_hash,
    comparable_fixed_age_snapshots: batch?.comparable_fixed_age_snapshots,
    decision_override_hash: batch?.decision_override_hash,
    evidence_hash: batch?.evidence_hash,
    conversion_evidence_hash: batch?.conversion_evidence_hash,
    conversion_cutoff_at: batch?.conversion_cutoff_at,
    review_decision: batch?.review_decision,
    bootstrap_policy_version: batch?.bootstrap_policy_version,
    bootstrap_authorized_at: batch?.bootstrap_authorized_at,
    target_date: batch?.target_date,
    content_profile: batchContentProfile(batch),
    timezone: batch?.timezone,
    concept_count: Number(batch?.concept_count || 0),
    slot_keys: cleanTokenList(batch?.slot_keys, 3),
    source_asset_keys: cleanTokenList(batch?.source_asset_keys, 3),
    seed_concept_ids: cleanTokenList(batch?.seed_concept_ids, 3),
    state: token(batch?.state),
    canonical_pack_sha256: batch?.canonical_pack_sha256,
    pack_artifact_count: Number(batch?.pack_artifact_count || 0),
    attempt_count: Number(batch?.attempt_count || 0),
    requested_at: batch?.requested_at,
    state_changed_at: batch?.state_changed_at,
    ready_at: batch?.ready_at,
    render_authorized_at: batch?.render_authorized_at,
    failed_at: batch?.failed_at,
    last_error_code: batch?.last_error_code,
    last_error_message: safeProviderError(batch?.last_error_message, ""),
  };
}

function scheduledGenerationHandoff(batch: any): any {
  return {
    schema_version: SCHEDULED_GENERATION_HANDOFF_SCHEMA,
    state: "unrendered_ready",
    state_scope: "scheduled_generation_output",
    batch_key: exactSha256(batch?.batch_key),
    target_date: String(batch?.target_date || ""),
    canonical_concept_count: Number(batch?.concept_count || 0),
    planned_rendition_count: Number(batch?.pack_artifact_count || 0),
    review_schema_version: token(batch?.review_schema_version),
    decision_policy_id: normalized(batch?.decision_policy_id),
    decision_policy_evidence_hash: exactSha256(
      batch?.decision_policy_evidence_hash,
    ),
    decision_policy_reason_codes: Array.isArray(
      batch?.decision_policy_reason_codes,
    ) ? batch.decision_policy_reason_codes : [],
    decision_policy_supported: true,
    rendered_media_created_by_invocation: 0,
    creative_artifacts_created_by_invocation: 0,
    publish_jobs_created_by_invocation: 0,
    requires_human_approval: true,
    external_pipeline_gates: [
      "owner_pack_authorization",
      "render_media",
      "host_and_verify_media",
      "import_render_result",
      "rendition_review",
      "owner_rendition_approval",
      "schedule_activation",
    ],
  };
}

function seedDonorPool(renderPack: any, contentProfile = NEXT_BATCH_PROFILE): {
  error?: string;
  donors?: any[];
  sourceByKey?: Map<string, any>;
} {
  if (
    !renderPack
    || renderPack?.schema_version !== "growth-render-pack.v1"
    || !token(renderPack?.batch_id)
    || !renderPack?.template
    || typeof renderPack.template !== "object"
    || !renderPack?.output
    || typeof renderPack.output !== "object"
  ) {
    return { error: "invalid_seed_render_pack" };
  }
  const sources = asArray(renderPack?.sources);
  const artifacts = asArray(renderPack?.artifacts);
  if (
    !sources.length
    || sources.length > MAX_SOURCE_BATCH
    || !artifacts.length
    || artifacts.length > MAX_RENDER_IMPORT
  ) {
    return { error: "invalid_seed_render_pack" };
  }
  const sourceByKey = new Map<string, any>();
  const videoFeatureExplainer =
    contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE;
  for (const source of sources) {
    const assetKey = token(source?.asset_key);
    if (
      !assetKey
      || sourceByKey.has(assetKey)
      || !["asset_pack", "repository_public"].includes(
        token(source?.source_origin),
      )
      || !localReference(source?.source_reference)
      || !exactSha256(source?.source_sha256)
      || token(source?.privacy_status) !== "safe"
      || token(source?.rights_status) !== "firstknock_owned"
      || (
        videoFeatureExplainer
        && !FEATURE_EXPLAINER_SOURCE_KINDS.has(token(source?.media_kind))
      )
    ) {
      continue;
    }
    sourceByKey.set(assetKey, source);
  }
  const grouped = new Map<string, any[]>();
  for (const artifact of artifacts) {
    if (
      token(artifact?.distribution_state) !== "publish_candidate"
      || token(artifact?.format) !== "video"
    ) {
      continue;
    }
    const conceptId = token(artifact?.concept_id);
    const platform = token(artifact?.platform);
    const artifactKey = token(artifact?.artifact_key);
    const platformContentId = token(artifact?.platform_content_id);
    const sourceKey = token(artifact?.source_asset_key);
    if (
      !conceptId
      || !PLATFORMS.has(platform)
      || !artifactKey
      || platformContentId !== artifactKey
      || !sourceByKey.has(sourceKey)
      || !artifact?.render
      || typeof artifact.render !== "object"
    ) {
      continue;
    }
    if (!grouped.has(conceptId)) grouped.set(conceptId, []);
    grouped.get(conceptId)?.push(artifact);
  }
  const donors: any[] = [];
  for (const [conceptId, candidates] of grouped.entries()) {
    const byPlatform = new Map(
      candidates.map((artifact) => [token(artifact?.platform), artifact]),
    );
    if (
      candidates.length !== 2
      || byPlatform.size !== 2
      || !byPlatform.has("instagram")
      || !byPlatform.has("tiktok")
    ) {
      continue;
    }
    const instagram = byPlatform.get("instagram");
    const tiktok = byPlatform.get("tiktok");
    const sourceKey = token(instagram?.source_asset_key);
    if (sourceKey !== token(tiktok?.source_asset_key)) continue;
    donors.push({
      conceptId,
      sourceKey,
      source: sourceByKey.get(sourceKey),
      instagram,
      tiktok,
    });
  }
  if (!donors.length) return { error: "seed_pack_has_no_safe_donors" };
  return {
    donors: donors.sort(
      (left, right) => left.conceptId.localeCompare(right.conceptId),
    ),
    sourceByKey,
  };
}

function donorLineage(donors: any[]): any[] {
  return donors.map((donor) => ({
    concept_id: donor.conceptId,
    source_asset_key: donor.sourceKey,
    instagram_artifact_key: token(donor.instagram?.artifact_key),
    tiktok_artifact_key: token(donor.tiktok?.artifact_key),
  }));
}

function exactDonorSources(donors: any[]): any[] {
  return donors.map((donor) => ({
    asset_key: donor.sourceKey,
    source_origin: token(donor.source?.source_origin),
    source_reference: localReference(donor.source?.source_reference),
    source_sha256: exactSha256(donor.source?.source_sha256),
  }));
}

function batchPromptSourceSnapshot(
  sourceKeys: any[],
  currentSources: any[],
): any[] {
  return sourceKeys.map((sourceKey, index) => ({
    asset_key: token(sourceKey),
    safe_source_summary: compactText(
      currentSources[index]?.safe_summary,
      1000,
    ),
  }));
}

function storedPack(batch: any): any | null {
  const raw = String(batch?.canonical_pack_json || "");
  if (!raw || raw.length > 100_000) return null;
  try {
    const parsed = JSON.parse(raw);
    return canonicalStringify(parsed) === raw ? parsed : null;
  } catch {
    return null;
  }
}

async function storedPackIsValid(batch: any): Promise<boolean> {
  const pack = storedPack(batch);
  return Boolean(
    pack
    && exactSha256(batch?.canonical_pack_sha256)
      === await sha256Hex(canonicalStringify(pack)),
  );
}

function batchesConflictByCooldown(
  leftTargetDate: any,
  leftSources: any,
  rightTargetDate: any,
  rightSources: any,
): boolean {
  const leftMs = phoenixDateStart(leftTargetDate);
  const rightMs = phoenixDateStart(rightTargetDate);
  if (
    !leftMs
    || !rightMs
    || Math.abs(leftMs - rightMs) >= SOURCE_COOLDOWN_DAYS * DAY_MS
  ) {
    return false;
  }
  const rightKeys = new Set(cleanTokenList(rightSources, 10));
  return cleanTokenList(leftSources, 10).some((key) => rightKeys.has(key));
}

function batchSourceReservationTokens(batch: any): string[] {
  const tokens = cleanTokenList(batch?.source_asset_keys, 3);
  for (const lineage of asArray(batch?.source_lineage).slice(0, 3)) {
    const sourceSha256 = exactSha256(lineage?.source_sha256);
    if (sourceSha256) tokens.push(`sha256-${sourceSha256}`);
  }
  return [...new Set(tokens)];
}

function donorSourceReservationTokens(donor: any): string[] {
  const sourceSha256 = exactSha256(donor?.source?.source_sha256);
  return [
    donor?.sourceKey,
    ...(sourceSha256 ? [`sha256-${sourceSha256}`] : []),
  ];
}

function artifactSourceReservationTokens(artifact: any): string[] {
  const reservations = cleanTokenList(artifact?.source_asset_keys, 20);
  const snapshot = cleanRenderSourceLineage(
    artifact?.source_lineage_snapshot,
  );
  const lineageValues = snapshot?.length
    ? snapshot
    : asArray(artifact?.render_source_lineage).slice(0, 20);
  for (const lineage of lineageValues) {
    const assetKey = token(lineage?.asset_key);
    const sourceSha256 = exactSha256(lineage?.source_sha256);
    if (assetKey) reservations.push(assetKey);
    if (sourceSha256) reservations.push(`sha256-${sourceSha256}`);
  }
  return [...new Set(reservations)];
}

function immutableJobReservationRecord(job: any, artifact: any = null): any {
  const snapshot = cleanRenderSourceLineage(job?.source_lineage_snapshot);
  const hasSnapshot = Boolean(snapshot?.length);
  const sourceAssetKeys = hasSnapshot
    ? snapshot?.map((source) => source.asset_key)
    : cleanTokenList(artifact?.source_asset_keys, 20);
  return {
    ...(artifact || {}),
    id: String(job?.artifact_id || artifact?.id || ""),
    concept_id: token(job?.concept_id) || token(artifact?.concept_id),
    platform: token(job?.platform) || token(artifact?.platform),
    platform_content_id: token(job?.platform_content_id)
      || token(artifact?.platform_content_id),
    source_asset_keys: sourceAssetKeys,
    source_lineage_snapshot: hasSnapshot
      ? snapshot
      : artifact?.source_lineage_snapshot,
    render_source_lineage: hasSnapshot
      ? undefined
      : artifact?.render_source_lineage,
    hook: compactText(job?.hook_snapshot, 300)
      || compactText(artifact?.hook, 300),
    render_pack_sha256: hasSnapshot
      ? exactSha256(job?.render_pack_sha256) || undefined
      : exactSha256(artifact?.render_pack_sha256) || undefined,
    growth_batch_key: hasSnapshot
      ? exactSha256(job?.growth_batch_key) || undefined
      : exactSha256(artifact?.growth_batch_key) || undefined,
  };
}

function immutableSourceLineage(
  sources: any[],
  sourceKeys: string[],
): any[] | null {
  if (
    !sourceKeys.length
    || sources.length !== sourceKeys.length
    || new Set(sourceKeys).size !== sourceKeys.length
  ) {
    return null;
  }
  const lineage = sourceKeys.map((assetKey, index) => ({
    asset_key: token(sources[index]?.asset_key),
    source_reference: localReference(sources[index]?.source_reference),
    source_sha256: exactSha256(sources[index]?.source_sha256),
  }));
  return lineage.every((item, index) => (
    item.asset_key === sourceKeys[index]
    && Boolean(item.source_reference)
    && Boolean(item.source_sha256)
  ))
    ? lineage
    : null;
}

function sameReservationTokens(left: any, right: any): boolean {
  const leftTokens = artifactSourceReservationTokens(left).sort();
  const rightTokens = artifactSourceReservationTokens(right).sort();
  return leftTokens.length > 0
    && leftTokens.length === rightTokens.length
    && leftTokens.every((value, index) => value === rightTokens[index]);
}

function sameDistributionPair(candidate: any, current: any): boolean {
  const candidatePlatform = token(candidate?.platform);
  const currentPlatform = token(current?.platform);
  const candidatePack = exactSha256(candidate?.render_pack_sha256);
  const currentPack = exactSha256(current?.render_pack_sha256);
  return Boolean(
    current
    && token(candidate?.concept_id)
    && token(candidate?.concept_id) === token(current?.concept_id)
    && PLATFORMS.has(candidatePlatform)
    && PLATFORMS.has(currentPlatform)
    && candidatePlatform !== currentPlatform
    && candidatePack
    && candidatePack === currentPack
    && sameReservationTokens(candidate, current),
  );
}

function batchReservationActive(batch: any, nowMs = Date.now()): boolean {
  const state = token(batch?.state);
  if (["ready", "render_authorized"].includes(state)) return true;
  if (state !== "generating") return false;
  const expiresMs = new Date(timestamp(batch?.lease_expires_at) || 0).getTime();
  return expiresMs > nowMs;
}

function batchReservedHooks(batch: any): string[] {
  const stored = cleanStringList(
    batch?.generated_hook_reservations,
    6,
    120,
  );
  if (stored.length) return stored;
  if (!["ready", "render_authorized"].includes(token(batch?.state))) return [];
  const seen = new Set<string>();
  const hooks: string[] = [];
  for (const artifact of asArray(storedPack(batch)?.artifacts)) {
    const hook = compactText(artifact?.hook, 120);
    const signature = hookTokens(hook).join(" ");
    if (!hook || !signature || seen.has(signature)) continue;
    seen.add(signature);
    hooks.push(hook);
    if (hooks.length === 3) break;
  }
  return hooks;
}

function packConceptHooks(pack: any): string[] | null {
  const orderedConcepts: string[] = [];
  const orderedHooks: string[] = [];
  const conceptByHookSignature = new Map<string, string>();
  const platformsByConcept = new Map<string, Set<string>>();
  for (const artifact of asArray(pack?.artifacts)) {
    const conceptId = token(artifact?.concept_id);
    const platform = token(artifact?.platform);
    const hook = compactText(artifact?.hook, 120);
    if (!conceptId || !PLATFORMS.has(platform) || !hook) return null;
    if (!platformsByConcept.has(conceptId)) {
      orderedConcepts.push(conceptId);
      platformsByConcept.set(conceptId, new Set());
    }
    const hookSignature = hookTokens(hook).join(" ");
    if (!hookSignature) return null;
    const priorConcept = conceptByHookSignature.get(hookSignature);
    if (priorConcept && priorConcept !== conceptId) return null;
    if (!priorConcept) {
      conceptByHookSignature.set(hookSignature, conceptId);
      orderedHooks.push(hook);
    }
    const platforms = platformsByConcept.get(conceptId);
    if (platforms?.has(platform)) return null;
    platforms?.add(platform);
  }
  if (
    orderedConcepts.length < 2
    || orderedConcepts.length > 3
    || orderedConcepts.some(
      (conceptId) => platformsByConcept.get(conceptId)?.size !== 2,
    )
  ) {
    return null;
  }
  return orderedHooks;
}

function batchArtifactProvenanceMap(
  batch: any,
  pack: any,
): Map<string, any> | null {
  const batchKey = exactSha256(batch?.batch_key);
  const targetDate = String(batch?.target_date || "").trim();
  const conceptCount = Number(batch?.concept_count || 0);
  const contentProfile = batchContentProfile(batch);
  const slots = cleanTokenList(batch?.slot_keys, 3);
  const artifacts = asArray(pack?.artifacts);
  if (
    !batchKey
    || !NEXT_BATCH_PROFILES.has(contentProfile)
    || !phoenixDateStart(targetDate)
    || ![2, 3].includes(conceptCount)
    || (
      contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE
      && conceptCount !== 2
    )
    || slots.length !== conceptCount
    || slots.some(
      (slot, index) => slot !== NEXT_BATCH_SLOTS[index],
    )
  ) {
    return null;
  }
  const conceptOrder: string[] = [];
  const artifactsByConcept = new Map<string, any[]>();
  for (const artifact of artifacts) {
    const conceptId = token(artifact?.concept_id);
    const artifactKey = token(artifact?.artifact_key);
    const platform = token(artifact?.platform);
    if (!conceptId || !artifactKey || !PLATFORMS.has(platform)) return null;
    if (!artifactsByConcept.has(conceptId)) {
      conceptOrder.push(conceptId);
      artifactsByConcept.set(conceptId, []);
    }
    artifactsByConcept.get(conceptId)?.push(artifact);
  }
  if (conceptOrder.length !== conceptCount) return null;
  const provenance = new Map<string, any>();
  for (let index = 0; index < conceptOrder.length; index += 1) {
    const conceptArtifacts = artifactsByConcept.get(conceptOrder[index]) || [];
    if (
      conceptArtifacts.length !== 2
      || new Set(
        conceptArtifacts.map((artifact) => token(artifact?.platform)),
      ).size !== 2
    ) {
      return null;
    }
    for (const artifact of conceptArtifacts) {
      const artifactKey = token(artifact?.artifact_key);
      if (provenance.has(artifactKey)) return null;
      provenance.set(artifactKey, {
        growth_batch_key: batchKey,
        growth_batch_target_date: targetDate,
        growth_batch_slot_key: slots[index],
      });
    }
  }
  return provenance;
}

function batchesConflictByHooks(
  leftTargetDate: any,
  leftHooks: any,
  rightTargetDate: any,
  rightHooks: any,
): boolean {
  const leftMs = phoenixDateStart(leftTargetDate);
  const rightMs = phoenixDateStart(rightTargetDate);
  const leftValues = cleanStringList(leftHooks, 3, 120);
  const rightValues = cleanStringList(rightHooks, 3, 120);
  if (
    !leftMs
    || !rightMs
    || !leftValues.length
    || !rightValues.length
    || Math.abs(leftMs - rightMs) >= HOOK_DEDUPE_DAYS * DAY_MS
  ) {
    return false;
  }
  return leftValues.some((left) => (
    rightValues.some((right) => hookSimilarity(left, right) >= 0.75)
  ));
}

function activeBatchReservations(
  batches: any[],
  targetDate: string,
  ignoredBatchKey = "",
): Set<string> {
  const reserved = new Set<string>();
  const targetMs = phoenixDateStart(targetDate);
  for (const batch of batches) {
    const batchTargetMs = phoenixDateStart(batch?.target_date);
    if (
      !batchReservationActive(batch)
      || exactSha256(batch?.batch_key) === ignoredBatchKey
      || !targetMs
      || !batchTargetMs
      || Math.abs(targetMs - batchTargetMs) >= SOURCE_COOLDOWN_DAYS * DAY_MS
    ) {
      continue;
    }
    for (const sourceToken of batchSourceReservationTokens(batch)) {
      reserved.add(sourceToken);
    }
  }
  return reserved;
}

async function currentDonorSources(
  sourceEntity: any,
  donors: any[],
  contentProfile = NEXT_BATCH_PROFILE,
): Promise<any[] | null> {
  const keys = donors.map((donor) => donor.sourceKey);
  if (new Set(keys).size !== keys.length) return null;
  const sources = await sourcesForArtifact(sourceEntity, keys);
  if (!sourcesAreSafe(sources, keys.length)) return null;
  for (let index = 0; index < sources.length; index += 1) {
    if (
      localReference(sources[index]?.source_reference)
        !== localReference(donors[index]?.source?.source_reference)
      || exactSha256(sources[index]?.source_sha256)
        !== exactSha256(donors[index]?.source?.source_sha256)
      || (
        contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE
        && (
          !FEATURE_EXPLAINER_SOURCE_KINDS.has(
            token(sources[index]?.media_kind),
          )
          || !FEATURE_EXPLAINER_SOURCE_KINDS.has(
            token(donors[index]?.source?.media_kind),
          )
          || token(sources[index]?.media_kind)
            !== token(donors[index]?.source?.media_kind)
        )
      )
    ) {
      return null;
    }
  }
  return sources;
}

function chooseDonors(
  pool: any[],
  conceptCount: number,
  requestedConceptIds: string[],
  parentContent: string,
  reservedSources: Set<string>,
  conceptPriority: Map<string, number> | null = null,
): { donors?: any[]; error?: string; eligible?: number } {
  const eligible = pool.filter((donor) => (
    donorSourceReservationTokens(donor).every(
      (sourceToken) => !reservedSources.has(sourceToken),
    )
  ));
  const eligibleById = new Map(
    eligible.map((donor) => [donor.conceptId, donor]),
  );
  if (requestedConceptIds.length) {
    if (
      requestedConceptIds.length !== conceptCount
      || new Set(requestedConceptIds).size !== requestedConceptIds.length
    ) {
      return { error: "invalid_seed_concept_selection", eligible: eligible.length };
    }
    const selected = requestedConceptIds.map((conceptId) => (
      eligibleById.get(conceptId)
    ));
    if (selected.some((donor) => !donor)) {
      return { error: "seed_donor_unavailable", eligible: eligible.length };
    }
    if (
      new Set(selected.map((donor) => donor.sourceKey)).size !== conceptCount
      || new Set(
        selected.map((donor) => exactSha256(donor?.source?.source_sha256)),
      ).size !== conceptCount
    ) {
      return { error: "duplicate_seed_source", eligible: eligible.length };
    }
    return { donors: selected, eligible: eligible.length };
  }
  const ordered = [...eligible].sort((left, right) => {
    const leftMatches = [
      token(left.instagram?.platform_content_id),
      token(left.tiktok?.platform_content_id),
    ].includes(parentContent) ? 0 : 1;
    const rightMatches = [
      token(right.instagram?.platform_content_id),
      token(right.tiktok?.platform_content_id),
    ].includes(parentContent) ? 0 : 1;
    const leftPriority = conceptPriority?.get(left.conceptId)
      ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = conceptPriority?.get(right.conceptId)
      ?? Number.MAX_SAFE_INTEGER;
    return leftMatches - rightMatches
      || leftPriority - rightPriority
      || left.conceptId.localeCompare(right.conceptId);
  });
  const selected: any[] = [];
  const usedSources = new Set<string>();
  for (const donor of ordered) {
    const sourceTokens = donorSourceReservationTokens(donor);
    if (sourceTokens.some((sourceToken) => usedSources.has(sourceToken))) continue;
    selected.push(donor);
    sourceTokens.forEach((sourceToken) => usedSources.add(sourceToken));
    if (selected.length === conceptCount) break;
  }
  if (selected.length !== conceptCount) {
    return { error: "insufficient_eligible_donors", eligible: selected.length };
  }
  return { donors: selected, eligible: eligible.length };
}

function nextBatchGeneratorSchema(
  conceptCount: number,
  contentProfile = NEXT_BATCH_PROFILE,
): any {
  const featureExplainer =
    contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE;
  const variantProperties = featureExplainer
    ? {
      platform: {
        type: "string",
        enum: ["instagram", "tiktok"],
      },
      problem: { type: "string" },
      visible_feature_behavior: { type: "string" },
      practical_benefit: { type: "string" },
      cta_label: { type: "string" },
    }
    : {
      platform: {
        type: "string",
        enum: ["instagram", "tiktok"],
      },
      caption: { type: "string" },
      cta_label: { type: "string" },
    };
  const variantRequired = featureExplainer
    ? [
      "platform",
      "problem",
      "visible_feature_behavior",
      "practical_benefit",
      "cta_label",
    ]
    : ["platform", "caption", "cta_label"];
  return {
    type: "object",
    properties: {
      concepts: {
        type: "array",
        minItems: conceptCount,
        maxItems: conceptCount,
        items: {
          type: "object",
          properties: {
            donor_concept_id: { type: "string" },
            title: { type: "string" },
            hook: { type: "string" },
            overlay_text: {
              type: "array",
              items: { type: "string" },
            },
            shot_list: {
              type: "array",
              items: { type: "string" },
            },
            overlay_cta: { type: "string" },
            variants: {
              type: "array",
              minItems: 2,
              maxItems: 2,
              items: {
                type: "object",
                properties: variantProperties,
                required: variantRequired,
              },
            },
          },
          required: [
            "donor_concept_id",
            "title",
            "hook",
            "overlay_text",
            "shot_list",
            "overlay_cta",
            "variants",
          ],
        },
      },
    },
    required: ["concepts"],
  };
}

function hookTokens(value: any): string[] {
  return normalized(value)
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^-|-$/g, ""))
    .filter(Boolean);
}

function hookSimilarity(left: any, right: any): number {
  const leftSet = new Set(hookTokens(left));
  const rightSet = new Set(hookTokens(right));
  if (!leftSet.size || !rightSet.size) return 0;
  const intersection = [...leftSet].filter((word) => rightSet.has(word)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union ? intersection / union : 0;
}

function unsafeGeneratedText(value: any): boolean {
  const textValue = String(value || "");
  return (
    /https?:\/\/|www\./i.test(textValue)
    || /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#][^\s]*)?/i
      .test(textValue)
    || /(^|[\s([{])@[a-z0-9](?:[a-z0-9._-]{0,29}[a-z0-9])?\b/i
      .test(textValue)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(textValue)
    || /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/.test(
      textValue,
    )
    || /\b\d{10}\b/.test(textValue)
    || /\b(?:account|customer|client|user)\s*(?:id|number|#)\b/i.test(
      textValue,
    )
  );
}

function unsafeGeneratedClaim(value: any): boolean {
  const textValue = String(value || "");
  return (
    /[\d$€£¥₹]/.test(textValue)
    || /\b(?:double|triple|quadruple|twice)\b/i.test(textValue)
    || /\b(?:guarantee|guaranteed|proven result|customer result|client result|testimonial|case study|success story)\b/i
      .test(textValue)
    || /\b(?:increase|boost|improve|multiply|grow)\b.{0,40}\b(?:sales|revenue|close rate|conversion|performance|results?)\b/i
      .test(textValue)
  );
}

function unsafeGeneratedQuantification(value: any): boolean {
  return /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|percent(?:age)?|times?|fold)\b/i
    .test(String(value || ""));
}

function sentTimeByArtifact(jobs: any[]): Map<string, number> {
  const sent = new Map<string, number>();
  for (const job of jobs) {
    if (!durableSentEvidence(job)) continue;
    const sentAt = timestamp(job?.provider_sent_at)
      || timestamp(job?.due_at);
    const sentMs = sentAt ? new Date(sentAt).getTime() : 0;
    if (!Number.isFinite(sentMs) || sentMs <= 0) continue;
    const keys = [
      String(job?.artifact_id || "").trim()
        ? `id:${String(job.artifact_id).trim()}`
        : "",
      token(job?.platform) && token(job?.platform_content_id)
        ? `content:${token(job.platform)}:${token(job.platform_content_id)}`
        : "",
    ].filter(Boolean);
    for (const key of keys) {
      sent.set(key, Math.max(sent.get(key) || 0, sentMs));
    }
  }
  return sent;
}

function reservationTimeByArtifact(jobs: any[]): Map<string, number> {
  const reserved = new Map<string, number>();
  for (const job of jobs) {
    if (!jobBlocksContentIdReuse(job)) continue;
    const reservedAt = timestamp(job?.provider_sent_at)
      || timestamp(job?.due_at);
    const reservedMs = reservedAt ? new Date(reservedAt).getTime() : 0;
    if (!Number.isFinite(reservedMs) || reservedMs <= 0) continue;
    const keys = [
      String(job?.artifact_id || "").trim()
        ? `id:${String(job.artifact_id).trim()}`
        : "",
      token(job?.platform) && token(job?.platform_content_id)
        ? `content:${token(job.platform)}:${token(job.platform_content_id)}`
        : "",
    ].filter(Boolean);
    for (const key of keys) {
      reserved.set(key, Math.max(reserved.get(key) || 0, reservedMs));
    }
  }
  return reserved;
}

function artifactSentTime(
  artifact: any,
  sentTimes: Map<string, number>,
): number {
  return Math.max(
    sentTimes.get(`id:${String(artifact?.id || "").trim()}`) || 0,
    sentTimes.get(
      `content:${token(artifact?.platform)}:${token(
        artifact?.platform_content_id,
      )}`,
    ) || 0,
  );
}

function contentSourceReservations(
  artifacts: any[],
  jobs: any[],
  targetDate: string,
  ignoredBatchKey = "",
  ignoredArtifact: any = null,
): Set<string> {
  const reservations = new Set<string>();
  const targetMs = phoenixDateStart(targetDate);
  const reservedTimes = reservationTimeByArtifact(jobs);
  if (!targetMs) return reservations;
  const artifactsById = new Map(
    artifacts
      .filter((artifact) => String(artifact?.id || "").trim())
      .map((artifact) => [String(artifact.id), artifact]),
  );
  const artifactsByContent = new Map(
    artifacts.map((artifact) => [
      `${token(artifact?.platform)}|${token(artifact?.platform_content_id)}`,
      artifact,
    ]),
  );
  for (const job of jobs) {
    if (!jobBlocksContentIdReuse(job)) continue;
    const reservedAt = timestamp(job?.provider_sent_at)
      || timestamp(job?.due_at);
    const reservedMs = reservedAt ? new Date(reservedAt).getTime() : 0;
    if (
      !Number.isFinite(reservedMs)
      || reservedMs <= 0
      || Math.abs(targetMs - phoenixDateStart(phoenixDateKey(reservedMs)))
        >= SOURCE_COOLDOWN_DAYS * DAY_MS
    ) {
      continue;
    }
    const mutableArtifact = artifactsById.get(String(job?.artifact_id || ""))
      || artifactsByContent.get(
        `${token(job?.platform)}|${token(job?.platform_content_id)}`,
      );
    const candidate = immutableJobReservationRecord(job, mutableArtifact);
    if (
      String(job?.artifact_id || "") === String(ignoredArtifact?.id || "")
      || (
        ignoredArtifact
        && token(job?.platform) === token(ignoredArtifact?.platform)
        && token(job?.platform_content_id)
          === token(ignoredArtifact?.platform_content_id)
      )
      || (
        ignoredBatchKey
        && exactSha256(
          candidate?.growth_batch_key || job?.growth_batch_key,
        ) === ignoredBatchKey
      )
      || (
        sameDistributionPair(candidate, ignoredArtifact)
        && phoenixDateKey(reservedMs) === targetDate
      )
    ) {
      continue;
    }
    for (const sourceToken of artifactSourceReservationTokens(candidate)) {
      reservations.add(sourceToken);
    }
  }
  for (const artifact of artifacts) {
    if (
      ignoredArtifact?.id
      && String(artifact?.id || "") === String(ignoredArtifact.id)
    ) {
      continue;
    }
    if (
      ignoredBatchKey
      && exactSha256(artifact?.growth_batch_key) === ignoredBatchKey
    ) {
      continue;
    }
    const sentMs = artifactSentTime(artifact, reservedTimes);
    if (
      !sentMs
      || Math.abs(targetMs - phoenixDateStart(phoenixDateKey(sentMs)))
        >= SOURCE_COOLDOWN_DAYS * DAY_MS
    ) {
      continue;
    }
    if (
      sameDistributionPair(artifact, ignoredArtifact)
      && phoenixDateKey(sentMs) === targetDate
    ) {
      continue;
    }
    for (const sourceToken of artifactSourceReservationTokens(artifact)) {
      reservations.add(sourceToken);
    }
  }
  return reservations;
}

function historicalBatchHooks(
  artifacts: any[],
  batches: any[],
  targetDate: string,
  ignoredBatchKey: string,
  jobs: any[] = [],
  ignoredArtifact: any = null,
): string[] {
  const targetMs = phoenixDateStart(targetDate);
  const cutoffMs = targetMs - HOOK_DEDUPE_DAYS * DAY_MS;
  const sentTimes = reservationTimeByArtifact(jobs);
  const artifactsById = new Map(
    artifacts
      .filter((artifact) => String(artifact?.id || "").trim())
      .map((artifact) => [String(artifact.id), artifact]),
  );
  const artifactsByContent = new Map(
    artifacts.map((artifact) => [
      `${token(artifact?.platform)}|${token(artifact?.platform_content_id)}`,
      artifact,
    ]),
  );
  const hooks = jobs
    .filter((job) => {
      if (!jobBlocksContentIdReuse(job)) return false;
      const reservedAt = timestamp(job?.provider_sent_at)
        || timestamp(job?.due_at);
      const reservedMs = reservedAt ? new Date(reservedAt).getTime() : 0;
      if (
        !Number.isFinite(reservedMs)
        || reservedMs < cutoffMs
        || reservedMs > targetMs + DAY_MS
      ) {
        return false;
      }
      const mutableArtifact = artifactsById.get(String(job?.artifact_id || ""))
        || artifactsByContent.get(
          `${token(job?.platform)}|${token(job?.platform_content_id)}`,
        );
      const candidate = immutableJobReservationRecord(job, mutableArtifact);
      return !(
        String(job?.artifact_id || "") === String(ignoredArtifact?.id || "")
        || (
          ignoredArtifact
          && token(job?.platform) === token(ignoredArtifact?.platform)
          && token(job?.platform_content_id)
            === token(ignoredArtifact?.platform_content_id)
        )
        || (
          ignoredBatchKey
          && exactSha256(
            candidate?.growth_batch_key || job?.growth_batch_key,
          ) === ignoredBatchKey
        )
        || (
          sameDistributionPair(candidate, ignoredArtifact)
          && phoenixDateKey(reservedMs) === targetDate
        )
      );
    })
    .map((job) => {
      const artifact = artifactsById.get(String(job?.artifact_id || ""))
        || artifactsByContent.get(
          `${token(job?.platform)}|${token(job?.platform_content_id)}`,
        );
      return compactText(job?.hook_snapshot || artifact?.hook, 300);
    })
    .filter(Boolean);
  hooks.push(...artifacts
    .filter((artifact) => {
      if (
        (ignoredArtifact?.id
          && String(artifact?.id || "") === String(ignoredArtifact.id))
        || (
          ignoredBatchKey
          && exactSha256(artifact?.growth_batch_key) === ignoredBatchKey
        )
      ) {
        return false;
      }
      const sentMs = artifactSentTime(artifact, sentTimes);
      if (
        sameDistributionPair(artifact, ignoredArtifact)
        && (!sentMs || phoenixDateKey(sentMs) === targetDate)
      ) {
        return false;
      }
      if (
        token(artifact?.approval_status) !== "approved"
        && !sentMs
      ) {
        return false;
      }
      const createdMs = sentMs || new Date(
        timestamp(artifact?.approved_at)
          || timestamp(artifact?.created_date)
          || timestamp(artifact?.updated_date)
          || 0,
      ).getTime();
      return !createdMs || (createdMs >= cutoffMs && createdMs <= targetMs + DAY_MS);
    })
    .map((artifact) => compactText(artifact?.hook, 300))
    .filter(Boolean));
  for (const batch of batches) {
    const batchKey = exactSha256(batch?.batch_key);
    const batchTargetMs = phoenixDateStart(batch?.target_date);
    if (
      batchKey === ignoredBatchKey
      || !["ready", "render_authorized"].includes(token(batch?.state))
      || !batchTargetMs
      || batchTargetMs < cutoffMs
      || batchTargetMs > targetMs
    ) {
      continue;
    }
    const pack = storedPack(batch);
    if (!pack) continue;
    hooks.push(
      ...asArray(pack?.artifacts)
        .map((artifact) => compactText(artifact?.hook, 300))
        .filter(Boolean),
    );
  }
  return hooks;
}

function normalizeGeneratedConcepts(
  value: any,
  donors: any[],
  historicalHooks: string[],
  contentProfile = NEXT_BATCH_PROFILE,
): any[] | null {
  const featureExplainer =
    contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE;
  const concepts = asArray(value?.concepts);
  if (concepts.length !== donors.length) return null;
  const byDonor = new Map(
    concepts.map((concept) => [token(concept?.donor_concept_id), concept]),
  );
  if (byDonor.size !== donors.length) return null;
  const normalizedConcepts: any[] = [];
  const generatedHooks: string[] = [];
  for (const donor of donors) {
    const concept = byDonor.get(donor.conceptId);
    if (!concept) return null;
    const title = compactText(concept?.title, 160);
    const hook = compactText(concept?.hook, 120);
    const overlayText = cleanStringList(concept?.overlay_text, 6, 80);
    const shotList = cleanStringList(concept?.shot_list, 8, 300);
    const overlayCta = compactText(concept?.overlay_cta, 80);
    const variants = asArray(concept?.variants);
    const variantByPlatform = new Map(
      variants.map((variant) => [token(variant?.platform), variant]),
    );
    const hookWordCount = hookTokens(hook).length;
    if (
      !title
      || hookWordCount < 4
      || hookWordCount > 7
      || !overlayText.length
      || !shotList.length
      || !overlayCta
      || variants.length !== 2
      || variantByPlatform.size !== 2
      || !variantByPlatform.has("instagram")
      || !variantByPlatform.has("tiktok")
      || [
        title,
        hook,
        ...overlayText,
        ...shotList,
        overlayCta,
      ].some(unsafeGeneratedText)
      || [
        title,
        hook,
        ...overlayText,
        ...shotList,
        overlayCta,
      ].some(unsafeGeneratedClaim)
      || historicalHooks.some((priorHook) => hookSimilarity(hook, priorHook) >= 0.75)
      || generatedHooks.some((priorHook) => hookSimilarity(hook, priorHook) >= 0.75)
    ) {
      return null;
    }
    const normalizedVariants: any = {};
    for (const platform of PLATFORMS) {
      const variant = variantByPlatform.get(platform);
      const ctaLabel = compactText(variant?.cta_label, 80);
      if (featureExplainer) {
        const problem = compactText(variant?.problem, 280);
        const visibleFeatureBehavior = compactText(
          variant?.visible_feature_behavior,
          400,
        );
        const practicalBenefit = compactText(
          variant?.practical_benefit,
          280,
        );
        const sections = [
          problem,
          visibleFeatureBehavior,
          practicalBenefit,
        ];
        const normalizedVariant = {
          problem,
          visible_feature_behavior: visibleFeatureBehavior,
          practical_benefit: practicalBenefit,
          cta_label: ctaLabel,
        };
        if (
          !ctaLabel
          || sections.some((section) => hookTokens(section).length < 4)
          || !/\bfirstknock\b/i.test(visibleFeatureBehavior)
          || new Set(sections.map(normalized)).size !== sections.length
          || [...sections, ctaLabel].some(unsafeGeneratedText)
          || [...sections, ctaLabel].some(unsafeGeneratedClaim)
          || unsafeGeneratedQuantification(practicalBenefit)
          || (
            platform === "tiktok"
            && (
              problem.length > TIKTOK_FEATURE_SECTION_LIMITS.problem
              || visibleFeatureBehavior.length
                > TIKTOK_FEATURE_SECTION_LIMITS.visible_feature_behavior
              || practicalBenefit.length
                > TIKTOK_FEATURE_SECTION_LIMITS.practical_benefit
              || ctaLabel.length > TIKTOK_FEATURE_SECTION_LIMITS.cta_label
            )
          )
          || featureExplainerProviderCaption(
            normalizedVariant,
            "https://firstknock.online/start",
            platform,
          ).length > socialPostTextLimit(platform)
        ) {
          return null;
        }
        normalizedVariants[platform] = normalizedVariant;
        continue;
      }
      const caption = String(variant?.caption || "").trim();
      if (
        !caption
        || caption.length > 1800
        || !ctaLabel
        || unsafeGeneratedText(caption)
        || unsafeGeneratedText(ctaLabel)
        || unsafeGeneratedClaim(caption)
        || unsafeGeneratedClaim(ctaLabel)
        || socialPostText({
          platform,
          caption,
          disclosure: generatedDisclosure(platform),
          cta_label: ctaLabel,
          cta_url: "https://firstknock.online/start",
        }).length > socialPostTextLimit(platform)
      ) {
        return null;
      }
      normalizedVariants[platform] = { caption, cta_label: ctaLabel };
    }
    normalizedConcepts.push({
      donor_concept_id: donor.conceptId,
      title,
      hook,
      overlay_text: overlayText,
      shot_list: shotList,
      overlay_cta: overlayCta,
      variants: normalizedVariants,
    });
    generatedHooks.push(hook);
  }
  return normalizedConcepts;
}

function generatedDisclosure(platform: string): string {
  return token(platform) === "tiktok"
    ? TIKTOK_FEATURE_DISCLOSURE
    : NEXT_BATCH_DISCLOSURE;
}

function featureExplainerProviderCaption(
  variant: any,
  ctaUrl: string,
  platform: string,
): string {
  const isTikTok = token(platform) === "tiktok";
  return [
    compactText(variant?.problem, 280),
    compactText(variant?.visible_feature_behavior, 400),
    compactText(variant?.practical_benefit, 280),
    generatedDisclosure(platform),
    isTikTok
      ? compactText(variant?.cta_label, 80)
      : `${compactText(variant?.cta_label, 80)}: ${ctaUrl}`,
  ].filter(Boolean).join("\n\n");
}

function generatedRenderPack(
  seedPack: any,
  donors: any[],
  generatedConcepts: any[],
  batchKey: string,
  targetDate: string,
  campaign: string,
  contentProfile = NEXT_BATCH_PROFILE,
): any {
  const compactDate = targetDate.replaceAll("-", "");
  const batchId = token(`growth-${compactDate}-${batchKey.slice(0, 12)}`);
  const sources = donors.map((donor) => cloneJson(donor.source));
  const artifacts: any[] = [];
  for (let index = 0; index < donors.length; index += 1) {
    const donor = donors[index];
    const generated = generatedConcepts[index];
    const sequence = String(index + 1).padStart(2, "0");
    const conceptId = token(
      `fk-auto-${compactDate}-${sequence}-${batchKey.slice(0, 8)}`,
    );
    for (const platform of ["instagram", "tiktok"]) {
      const prefix = platformPrefix(platform);
      const artifactKey = token(
        `${prefix}-auto-${compactDate}-${sequence}-${batchKey.slice(0, 8)}`,
      );
      const donorArtifact = platform === "instagram"
        ? donor.instagram
        : donor.tiktok;
      const ctaUrl = platformTrackedUrl(platform, campaign, artifactKey);
      const caption = contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE
        ? featureExplainerProviderCaption(
          generated.variants[platform],
          ctaUrl,
          platform,
        )
        : generated.variants[platform].caption;
      artifacts.push({
        artifact_key: artifactKey,
        concept_id: conceptId,
        platform,
        platform_content_id: artifactKey,
        campaign,
        title: generated.title,
        pillar: compactText(donorArtifact?.pillar, 120),
        format: "video",
        ai_generated: true,
        distribution_state: "publish_candidate",
        source_asset_key: donor.sourceKey,
        hook: generated.hook,
        overlay_text: cloneJson(generated.overlay_text),
        shot_list: cloneJson(generated.shot_list),
        caption,
        cta_label: generated.variants[platform].cta_label,
        cta_url: ctaUrl,
        overlay_cta: generated.overlay_cta,
        disclosure: generatedDisclosure(platform),
        render: cloneJson(donorArtifact?.render),
      });
    }
  }
  return {
    schema_version: "growth-render-pack.v1",
    batch_id: batchId,
    template: cloneJson(seedPack.template),
    output: cloneJson(seedPack.output),
    sources,
    artifacts,
  };
}

function auditedBootstrapRenderPack(
  seedPack: any,
  donors: any[],
): any | null {
  const sources = donors.map((donor) => cloneJson(donor.source));
  const artifacts = donors.flatMap((donor) => [
    cloneJson(donor.instagram),
    cloneJson(donor.tiktok),
  ]);
  return {
    schema_version: "growth-render-pack.v1",
    batch_id: token(seedPack?.batch_id),
    template: cloneJson(seedPack.template),
    output: cloneJson(seedPack.output),
    sources,
    artifacts,
  };
}

function batchGenerationPrompt(
  evidence: any,
  donors: any[],
  promptSources: any[],
  conceptCount: number,
  contentProfile = NEXT_BATCH_PROFILE,
): string {
  const featureExplainer =
    contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE;
  const conversion = evidence?.conversionEvidence || {};
  const conversionContext = {
    schema_version: conversion?.schema_version || null,
    review_schema_version: evidence?.reviewSchemaVersion,
    evidence_sha256: evidence?.conversionEvidenceHash,
    cohort_start_at: conversion?.cohort_start_at || null,
    cutoff_at: evidence?.conversionCutoffAt,
    attribution_method: conversion?.attribution_method || null,
    conversion_conclusion: conversion?.conversion_conclusion || null,
    post_conversion_eligible: conversion?.post_conversion_eligible === true,
    conversion_counters_available:
      conversion?.conversion_counters_available === true,
    owned_intent_observed_fields:
      asArray(conversion?.owned_intent_observed_fields),
    link_clicks: conversion?.link_clicks ?? null,
    dm_intents: conversion?.dm_intents ?? null,
    owned_intents: conversion?.owned_intents ?? null,
    landing_sessions: conversion?.landing_sessions ?? null,
    signup_cta_sessions: conversion?.signup_cta_sessions ?? null,
    auth_completed: conversion?.auth_completed ?? null,
    signups: conversion?.signups ?? null,
    activated_workspaces: conversion?.activated_workspaces ?? null,
    activated_users: conversion?.activated_users ?? null,
    activated_reps: conversion?.activated_reps ?? null,
    paid_users: conversion?.paid_users ?? null,
    activation_timing_complete:
      conversion?.activation_timing_complete === true,
    paid_timing_complete: conversion?.paid_timing_complete === true,
    first_activation_at: conversion?.first_activation_at ?? null,
    last_activation_at: conversion?.last_activation_at ?? null,
    retention_window_days: conversion?.retention_window_days ?? null,
    retention_mature: conversion?.retention_mature === true,
    retention_eligible_users:
      conversion?.retention_eligible_users ?? null,
    retained_users: conversion?.retained_users ?? null,
    retention_rate: conversion?.retention_rate ?? null,
  };
  const sourceContext = donors.map((donor, index) => ({
    donor_concept_id: donor.conceptId,
    ...(featureExplainer
      ? { source_media_kind: token(donor.source?.media_kind) }
      : {}),
    pillar: compactText(donor.instagram?.pillar, 120),
    prior_hook: compactText(donor.instagram?.hook, 120),
    prior_caption_instagram: String(donor.instagram?.caption || "").slice(0, 600),
    prior_caption_tiktok: String(donor.tiktok?.caption || "").slice(0, 600),
    safe_source_summary: promptSources[index]?.safe_source_summary,
  }));
  if (featureExplainer) {
    return `You are FirstKnock's measured video feature-explainer editor. Produce exactly
${conceptCount} video concepts from the reviewed direction and the exact audited donor
context below.

Reviewed direction: ${evidence.decision}
Winning hook or variable: ${compactText(evidence?.plan?.hook, 300)}
Major variable: ${compactText(evidence?.plan?.major_variable, 160)}
INTERNAL-ONLY frozen conversion evidence (never quote, paraphrase, imply, or expose in
public copy):
${JSON.stringify(conversionContext)}
Audited video donor context:
${JSON.stringify(sourceContext)}

Return exactly one concept for every donor_concept_id, in the same order, and exactly one
Instagram plus one TikTok variant for each concept. Each variant must return these four
fields in this semantic order:
1. problem: the recognizable workflow friction shown by the donor context;
2. visible_feature_behavior: what the source visibly demonstrates the app doing, stated
   with the word FirstKnock and without inferring any unshown screen or capability;
3. practical_benefit: a concrete workflow advantage, never a quantified outcome or
   performance promise;
4. cta_label: a short action inviting the viewer to inspect FirstKnock.

The server assembles those fields into the final caption. Instagram receives the fixed
DEMO disclosure and tracked CTA URL. TikTok receives the shorter "Product demo."
disclosure and CTA label; its tracked URL remains on the artifact for the controlled
profile link because raw organic caption URLs are not a reliable clickable handoff.
Buffer currently permits 2,200-character TikTok descriptions. For every TikTok variant,
problem must be at most 280 characters, visible_feature_behavior at most 400 characters,
practical_benefit at most 280 characters, and cta_label at most 80 characters. Do not
return a URL or disclosure. Derive all public
product statements only from safe_source_summary and the audited prior hook/captions in
the supplied donor context. Each hook must be 4-7 words. Use 1-6 short overlay lines and
a practical shot list that edits the inherited source video rather than inventing new
footage. For Repeat, preserve the proven problem/benefit pattern without copying the old
hook. For Iterate, change only the named major variable while preserving the rest of the
pattern. Never invent customer results, performance numbers, testimonials, names,
addresses, emails, account identifiers, internal metrics, or capabilities.`;
  }
  const metricContext = {
    snapshot_days: Number(evidence?.plan?.snapshot_days || 7),
    reach: Number(evidence?.metric?.reach || 0),
    views: Number(evidence?.metric?.views || 0),
    shares: Number(evidence?.metric?.shares || 0),
    saves: Number(evidence?.metric?.saves || 0),
    comments: Number(evidence?.metric?.comments || 0),
    follows: Number(evidence?.metric?.follows || 0),
    profile_visits: Number(evidence?.metric?.profile_visits || 0),
    link_clicks: Number(evidence?.metric?.link_clicks || 0),
    dm_intents: Number(evidence?.metric?.dm_intents || 0),
  };
  return `You are FirstKnock's measured social-content editor. Produce ${conceptCount}
new product-proof concepts from an exact reviewed organic-social experiment and sanitized
FirstKnock-owned donor recipes.

Decision: ${evidence.decision}
Operator interpretation: ${String(evidence?.plan?.review_note || "").slice(0, 500)}
Winning hook or variable: ${compactText(evidence?.plan?.hook, 300)}
Major variable: ${compactText(evidence?.plan?.major_variable, 160)}
Internal fixed-age metrics (context only; never quote these in public copy):
${JSON.stringify(metricContext)}
INTERNAL-ONLY frozen conversion evidence (never quote, paraphrase, imply, or expose in
public copy):
${JSON.stringify(conversionContext)}
Trusted donor context:
${JSON.stringify(sourceContext)}

Return exactly one concept for every donor_concept_id, in the same order, and exactly one
Instagram plus one TikTok variant for each concept. Each hook must be 4-7 words. Use 1-6
short overlay lines, a practical shot list, one overlay CTA, and platform-native captions.
Keep each TikTok caption plus the server-added "Product demo." disclosure and CTA label
within 2,200 characters; do not return a URL.
For Repeat, preserve the proven problem/benefit pattern without copying the old hook. For
Iterate, change only the named major variable while preserving the rest of the pattern.
Never invent customer results, performance numbers, testimonials, names, addresses,
emails, account identifiers, or URLs. Do not include disclosure text; the server adds the
fixed DEMO disclosure. Do not mention internal metrics.`;
}

function batchOrder(left: any, right: any): number {
  return String(left?.created_date || "").localeCompare(
    String(right?.created_date || ""),
  ) || String(left?.id || "").localeCompare(String(right?.id || ""));
}

async function rawBatchRows(batchEntity: any, batchKey: string): Promise<any[]> {
  return asArray(await batchEntity.filter(
    { batch_key: batchKey },
    "created_date",
    20,
  )).sort(batchOrder);
}

async function exactBatchRows(batchEntity: any, batchKey: string): Promise<any[]> {
  const rows = await rawBatchRows(batchEntity, batchKey);
  const live = rows.filter((row) => token(row?.state) !== "superseded");
  if (live.length !== 1) return rows;
  const superseded = rows.filter((row) => token(row?.state) === "superseded");
  if (superseded.every((row) => (
    exactSha256(row?.batch_key) === batchKey
    && exactSha256(row?.superseded_by_batch_key) === batchKey
    && Boolean(timestamp(row?.superseded_at))
  ))) {
    return live;
  }
  return rows;
}

function batchLeaseOwned(
  batch: any,
  leaseToken: string,
  leaseGeneration: number,
  nowMs = Date.now(),
): boolean {
  const expiresMs = new Date(timestamp(batch?.lease_expires_at) || 0).getTime();
  return token(batch?.state) === "generating"
    && Number(batch?.lease_generation || 0) === leaseGeneration
    && String(batch?.lease_token || "") === leaseToken
    && Number.isFinite(expiresMs)
    && expiresMs > nowMs;
}

async function claimNextBatch(
  batchEntity: any,
  fields: any,
  user: any,
): Promise<any> {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseToken = `${fields.batch_key.slice(0, 16)}-${crypto.randomUUID()}`;
  const leaseExpiresAt = new Date(now.getTime() + BATCH_LEASE_MS).toISOString();
  let rows = await exactBatchRows(batchEntity, fields.batch_key);
  if (rows.length > 1) {
    const winner = rows[0];
    for (const loser of rows.slice(1)) {
      if (ACTIVE_BATCH_STATES.has(token(loser?.state))) {
        await batchEntity.updateMany(
          {
            id: loser.id,
            state: loser.state,
            lease_generation: Number(loser?.lease_generation || 0),
          },
          {
            $set: {
              state: "superseded",
              superseded_by_batch_key: fields.batch_key,
              superseded_at: nowIso,
              state_changed_at: nowIso,
              lease_token: "",
            },
            $unset: { lease_expires_at: true },
          },
        );
      }
    }
    rows = [winner];
  }
  const current = rows[0];
  if (current) {
    if (current.request_hash !== fields.request_hash) {
      return { error: "growth_batch_request_conflict", status: 409 };
    }
    const state = token(current?.state);
    if (["ready", "render_authorized"].includes(state)) {
      if (!(await storedPackIsValid(current))) {
        return { error: "growth_batch_storage_conflict", status: 409 };
      }
      return {
        idempotent: true,
        batch: current,
        renderPack: storedPack(current),
      };
    }
    if (["superseded", "revoked"].includes(state)) {
      return { error: `growth_batch_${state}`, status: 409 };
    }
    const leaseExpiresMs = new Date(
      timestamp(current?.lease_expires_at) || 0,
    ).getTime();
    if (state === "generating" && leaseExpiresMs > now.getTime()) {
      return {
        error: "growth_batch_generation_in_progress",
        status: 409,
        retry_at: current.lease_expires_at,
      };
    }
    if (!["generating", "failed"].includes(state)) {
      return { error: "growth_batch_state_conflict", status: 409 };
    }
    const generation = Number(current?.lease_generation || 0) + 1;
    const result = await batchEntity.updateMany(
      {
        id: current.id,
        state: current.state,
        lease_generation: Number(current?.lease_generation || 0),
      },
      {
        $set: {
          ...fields,
          state: "generating",
          lease_token: leaseToken,
          lease_generation: generation,
          lease_acquired_at: nowIso,
          lease_expires_at: leaseExpiresAt,
          attempt_count: Number(current?.attempt_count || 0) + 1,
          requested_by: String(user?.id || "").slice(0, 160),
          requested_at: current?.requested_at || nowIso,
          state_changed_at: nowIso,
          last_error_code: "",
          last_error_message: "",
        },
        $unset: {
          failed_at: true,
          ready_at: true,
          canonical_pack_json: true,
          canonical_pack_sha256: true,
          pack_schema_version: true,
          pack_artifact_count: true,
          generated_hook_reservations: true,
          generated_hooks_sha256: true,
        },
      },
    );
    if (Number(result?.updated || 0) !== 1) {
      return { error: "growth_batch_claim_contended", status: 409 };
    }
    return {
      batch: await batchEntity.get(current.id),
      leaseToken,
      leaseGeneration: generation,
    };
  }
  const generation = 1;
  const saved = await batchEntity.create({
    ...fields,
    state: "generating",
    lease_token: leaseToken,
    lease_generation: generation,
    lease_acquired_at: nowIso,
    lease_expires_at: leaseExpiresAt,
    attempt_count: 1,
    requested_by: String(user?.id || "").slice(0, 160),
    requested_at: nowIso,
    state_changed_at: nowIso,
  });
  rows = await rawBatchRows(batchEntity, fields.batch_key);
  const winner = rows[0];
  if (String(winner?.id || "") !== String(saved?.id || "")) {
    await batchEntity.updateMany(
      {
        id: saved.id,
        state: "generating",
        lease_generation: generation,
        lease_token: leaseToken,
      },
      {
        $set: {
          state: "superseded",
          superseded_by_batch_key: fields.batch_key,
          superseded_at: nowIso,
          state_changed_at: nowIso,
          lease_token: "",
        },
        $unset: { lease_expires_at: true },
      },
    );
    if (
      winner?.request_hash === fields.request_hash
      && ["ready", "render_authorized"].includes(token(winner?.state))
      && await storedPackIsValid(winner)
    ) {
      return {
        idempotent: true,
        batch: winner,
        renderPack: storedPack(winner),
      };
    }
    return {
      error: winner?.request_hash === fields.request_hash
        ? "growth_batch_generation_in_progress"
        : "growth_batch_request_conflict",
      status: 409,
    };
  }
  for (const loser of rows.slice(1)) {
    if (!ACTIVE_BATCH_STATES.has(token(loser?.state))) continue;
    await batchEntity.updateMany(
      {
        id: loser.id,
        state: loser.state,
        lease_generation: Number(loser?.lease_generation || 0),
      },
      {
        $set: {
          state: "superseded",
          superseded_by_batch_key: fields.batch_key,
          superseded_at: nowIso,
          state_changed_at: nowIso,
          lease_token: "",
        },
        $unset: { lease_expires_at: true },
      },
    );
  }
  const canonical = await exactBatchRows(batchEntity, fields.batch_key);
  if (
    canonical.length !== 1
    || String(canonical[0]?.id || "") !== String(saved?.id || "")
  ) {
    return { error: "growth_batch_claim_contended", status: 409 };
  }
  return {
    batch: saved,
    leaseToken,
    leaseGeneration: generation,
  };
}

async function enforceBatchReservation(
  batchEntity: any,
  batch: any,
  leaseToken: string,
  leaseGeneration: number,
): Promise<{ ok: boolean; error?: string }> {
  const initial = await batchEntity.get(batch.id).catch(() => null);
  if (!batchLeaseOwned(initial, leaseToken, leaseGeneration)) {
    return {
      ok: false,
      error: initial
        && token(initial?.state) === "generating"
        && Number(initial?.lease_generation || 0) === leaseGeneration
        && String(initial?.lease_token || "") === leaseToken
        ? "growth_batch_lease_expired"
        : "growth_batch_reservation_contended",
    };
  }
  const allBatches = await listAllDependencies(
    batchEntity,
    "Growth content batches",
  );
  const batchHooks = batchReservedHooks(initial);
  const contenders = allBatches.filter((candidate) => (
    String(candidate?.id || "") !== String(initial?.id || "")
    && exactSha256(candidate?.batch_key) !== exactSha256(initial?.batch_key)
    && batchReservationActive(candidate)
    && (
      String(candidate?.target_date || "") === String(initial?.target_date || "")
      || batchesConflictByCooldown(
        initial?.target_date,
        batchSourceReservationTokens(initial),
        candidate?.target_date,
        batchSourceReservationTokens(candidate),
      )
      || batchesConflictByHooks(
        initial?.target_date,
        batchHooks,
        candidate?.target_date,
        batchReservedHooks(candidate),
      )
    )
  ));
  for (const contenderSnapshot of contenders) {
    const contender = await batchEntity.get(
      contenderSnapshot.id,
    ).catch(() => null);
    if (!contender || !batchReservationActive(contender)) continue;
    const sameDate = String(contender?.target_date || "")
      === String(initial?.target_date || "");
    const sourceConflict = batchesConflictByCooldown(
      initial?.target_date,
      batchSourceReservationTokens(initial),
      contender?.target_date,
      batchSourceReservationTokens(contender),
    );
    const hookConflict = batchesConflictByHooks(
      initial?.target_date,
      batchHooks,
      contender?.target_date,
      batchReservedHooks(contender),
    );
    const conflictError = sameDate
      ? "daily_growth_batch_already_claimed"
      : sourceConflict
      ? "source_cooldown_conflict"
      : hookConflict
      ? "hook_dedupe_conflict"
      : "growth_batch_reservation_conflict";
    const contenderIsFinal = ["ready", "render_authorized"].includes(
      token(contender?.state),
    );
    const [winner] = [initial, contender].sort(batchOrder);
    if (
      contenderIsFinal
      || String(winner?.id || "") !== String(initial?.id || "")
    ) {
      const nowIso = new Date().toISOString();
      const superseded = await batchEntity.updateMany(
        {
          id: initial.id,
          state: "generating",
          lease_generation: leaseGeneration,
          lease_token: leaseToken,
          lease_expires_at: { $gt: nowIso },
        },
        {
          $set: {
            state: "superseded",
            superseded_by_batch_key: contender.batch_key,
            superseded_at: nowIso,
            state_changed_at: nowIso,
            lease_token: "",
          },
          $unset: { lease_expires_at: true },
        },
      );
      if (Number(superseded?.updated || 0) !== 1) {
        return { ok: false, error: "growth_batch_reservation_contended" };
      }
      return {
        ok: false,
        error: conflictError,
      };
    }
    if (token(contender?.state) !== "generating") {
      return { ok: false, error: "growth_batch_reservation_conflict" };
    }
    const nowIso = new Date().toISOString();
    const superseded = await batchEntity.updateMany(
      {
        id: contender.id,
        state: "generating",
        lease_generation: Number(contender?.lease_generation || 0),
        lease_token: String(contender?.lease_token || ""),
        lease_expires_at: { $gt: nowIso },
      },
      {
        $set: {
          state: "superseded",
          superseded_by_batch_key: initial.batch_key,
          superseded_at: nowIso,
          state_changed_at: nowIso,
          lease_token: "",
        },
        $unset: { lease_expires_at: true },
      },
    );
    if (Number(superseded?.updated || 0) !== 1) {
      const latestContender = await batchEntity.get(contender.id).catch(() => null);
      if (latestContender && batchReservationActive(latestContender)) {
        return { ok: false, error: "growth_batch_reservation_contended" };
      }
    }
  }
  const final = await batchEntity.get(initial.id).catch(() => null);
  return batchLeaseOwned(final, leaseToken, leaseGeneration)
    ? { ok: true }
    : { ok: false, error: "growth_batch_lease_expired" };
}

async function markBatchFailed(
  batchEntity: any,
  batch: any,
  leaseToken: string,
  leaseGeneration: number,
  code: string,
  message: string,
): Promise<void> {
  const failedAt = new Date().toISOString();
  await batchEntity.updateMany(
    {
      id: batch.id,
      state: "generating",
      lease_generation: leaseGeneration,
      lease_token: leaseToken,
      lease_expires_at: { $gt: failedAt },
    },
    {
      $set: {
        state: "failed",
        failed_at: failedAt,
        state_changed_at: failedAt,
        last_error_code: token(code),
        last_error_message: safeProviderError(message, "Generation failed."),
        lease_token: "",
      },
      $unset: { lease_expires_at: true },
    },
  );
}

function featureExplainerPackContractError(
  pack: any,
  auditedBootstrap = false,
): string {
  const sources = asArray(pack?.sources);
  const artifacts = asArray(pack?.artifacts);
  if (sources.length !== 2) return "source_count";
  if (sources.some((source) => (
    !FEATURE_EXPLAINER_SOURCE_KINDS.has(token(source?.media_kind))
  ))) {
    return "source_kind";
  }
  if (artifacts.length !== 4) return "artifact_count";
  for (const artifact of artifacts) {
    const platform = token(artifact?.platform);
    const isTikTok = platform === "tiktok";
    const ctaLabel = compactText(artifact?.cta_label, 80);
    const ctaUrl = String(artifact?.cta_url || "").trim();
    const blocks = String(artifact?.caption || "")
      .split(/\n{2,}/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (token(artifact?.format) !== "video") return "artifact_format";
    if (
      token(artifact?.distribution_state) !== "publish_candidate"
    ) {
      return "distribution_state";
    }
    if (blocks.length !== 5) return "caption_blocks";
    if (blocks.slice(0, 3).some(
      (section) => hookTokens(section).length < 4,
    )) {
      return "caption_section_length";
    }
    if (!/\bfirstknock\b/i.test(blocks[1])) return "feature_grounding";
    if (blocks.slice(0, 3).some(
      (section) => unsafeGeneratedText(section)
        || unsafeGeneratedClaim(section),
    )) {
      return "caption_safety";
    }
    const artifactDisclosure = compactText(artifact?.disclosure, 300);
    if (
      auditedBootstrap
      && !(
        (isTikTok && artifactDisclosure === TIKTOK_FEATURE_DISCLOSURE)
        || (
          !isTikTok
          && AUDITED_BOOTSTRAP_INSTAGRAM_DISCLOSURES.has(
            artifactDisclosure,
          )
        )
      )
    ) {
      return "disclosure_policy";
    }
    if (
      blocks[3] !== (
        auditedBootstrap
          ? artifactDisclosure
          : generatedDisclosure(platform)
      )
    ) {
      return "disclosure";
    }
    if (
      blocks[4] !== (isTikTok ? ctaLabel : `${ctaLabel}: ${ctaUrl}`)
    ) {
      return "cta";
    }
    if (socialPostText(artifact) !== artifact.caption) return "post_text";
    if (artifact.caption.length > socialPostTextLimit(platform)) {
      return "platform_length";
    }
  }
  return "";
}

function featureExplainerPackContract(
  pack: any,
  auditedBootstrap = false,
): boolean {
  return !featureExplainerPackContractError(pack, auditedBootstrap);
}

function bootstrapBatchIdentity(batch: any): any {
  return {
    schema: NEXT_BATCH_SCHEMA,
    batch_input_mode: BATCH_INPUT_BOOTSTRAP,
    bootstrap_policy_version: BOOTSTRAP_POLICY_VERSION,
    content_profile: FEATURE_EXPLAINER_VIDEO_PROFILE,
    campaign: PRODUCTION_GROWTH_CAMPAIGN,
    target_date: String(batch?.target_date || ""),
    seed_pack_sha256: exactSha256(batch?.seed_pack_sha256),
    seed_concept_ids: cleanTokenList(batch?.seed_concept_ids, 2),
  };
}

function bootstrapAuthorizationPayload(batch: any): any {
  return {
    batch_key: exactSha256(batch?.batch_key),
    ...bootstrapBatchIdentity(batch),
    seed_artifact_keys: cleanTokenList(batch?.seed_artifact_keys, 4),
    source_lineage: asArray(batch?.source_lineage),
    authorized_by: String(batch?.bootstrap_authorized_by || ""),
    authorized_at: timestamp(batch?.bootstrap_authorized_at) || "",
    authorization_note: String(batch?.bootstrap_authorization_note || ""),
    acknowledgement: true,
  };
}

function bootstrapRequestPayload(batch: any): any {
  return {
    batch_key: exactSha256(batch?.batch_key),
    bootstrap_authorization_hash: exactSha256(
      batch?.bootstrap_authorization_hash,
    ),
    seed_pack_batch_id: token(batch?.seed_pack_batch_id),
    seed_artifact_keys: cleanTokenList(batch?.seed_artifact_keys, 4),
    seed_lineage: asArray(batch?.seed_lineage),
    source_lineage: asArray(batch?.source_lineage),
    prompt_source_sha256: exactSha256(batch?.prompt_source_sha256),
  };
}

async function bootstrapBatchTrustIsValid(
  batch: any,
  pack: any,
): Promise<boolean> {
  const seedConceptIds = cleanTokenList(batch?.seed_concept_ids, 2);
  const seedArtifactKeys = cleanTokenList(batch?.seed_artifact_keys, 4);
  const sourceKeys = cleanTokenList(batch?.source_asset_keys, 2);
  const seedLineage = asArray(batch?.seed_lineage);
  const expectedBatchKey = await sha256Hex(canonicalStringify(
    bootstrapBatchIdentity(batch),
  ));
  const expectedAuthorizationHash = await sha256Hex(canonicalStringify(
    bootstrapAuthorizationPayload(batch),
  ));
  const expectedRequestHash = await sha256Hex(canonicalStringify(
    bootstrapRequestPayload(batch),
  ));
  const expectedPackId = token(batch?.seed_pack_batch_id);
  const artifacts = asArray(pack?.artifacts);
  const packArtifactKeys = artifacts.map(
    (artifact) => token(artifact?.artifact_key),
  );
  const packConceptIds = [
    ...new Set(artifacts.map((artifact) => token(artifact?.concept_id))),
  ];
  const packSourceKeys = asArray(pack?.sources).map(
    (source) => token(source?.asset_key),
  );
  const lineageArtifactKeys = seedLineage.flatMap((item) => [
    token(item?.instagram_artifact_key),
    token(item?.tiktok_artifact_key),
  ]);
  return batchInputMode(batch) === BATCH_INPUT_BOOTSTRAP
    && token(batch?.bootstrap_policy_version) === BOOTSTRAP_POLICY_VERSION
    && batchContentProfile(batch) === FEATURE_EXPLAINER_VIDEO_PROFILE
    && Number(batch?.concept_count || 0) === 2
    && Number(batch?.slot_count || 0) === 2
    && cleanTokenList(batch?.slot_keys, 2).join("|") === "morning|midday"
    && seedConceptIds.length === 2
    && seedArtifactKeys.length === 4
    && sourceKeys.length === 2
    && seedLineage.length === 2
    && new Set(seedLineage.map((item) => token(item?.concept_id))).size === 2
    && new Set(
      seedLineage.map((item) => token(item?.source_asset_key)),
    ).size === 2
    && canonicalStringify(
      seedLineage.map((item) => token(item?.concept_id)),
    ) === canonicalStringify(seedConceptIds)
    && canonicalStringify(
      seedLineage.map((item) => token(item?.source_asset_key)),
    ) === canonicalStringify(sourceKeys)
    && canonicalStringify(lineageArtifactKeys)
      === canonicalStringify(seedArtifactKeys)
    && canonicalStringify(packArtifactKeys)
      === canonicalStringify(seedArtifactKeys)
    && canonicalStringify(packConceptIds)
      === canonicalStringify(seedConceptIds)
    && canonicalStringify(packSourceKeys) === canonicalStringify(sourceKeys)
    && exactSha256(batch?.batch_key) === expectedBatchKey
    && exactSha256(batch?.bootstrap_authorization_hash)
      === expectedAuthorizationHash
    && exactSha256(batch?.request_hash) === expectedRequestHash
    && configuredRenderPackHashes().has(
      exactSha256(batch?.seed_pack_sha256),
    )
    && String(batch?.bootstrap_authorized_by || "").length > 0
    && Boolean(timestamp(batch?.bootstrap_authorized_at))
    && compactText(batch?.bootstrap_authorization_note, 500).length >= 10
    && token(pack?.batch_id) === expectedPackId
    && featureExplainerPackContract(pack, true)
    && artifacts.every((artifact) => {
      const platform = token(artifact?.platform);
      const artifactKey = token(artifact?.artifact_key);
      return token(artifact?.campaign) === PRODUCTION_GROWTH_CAMPAIGN
        && artifact?.ai_generated !== true
        && token(artifact?.platform_content_id) === artifactKey
        && String(artifact?.cta_url || "") === platformTrackedUrl(
          platform,
          PRODUCTION_GROWTH_CAMPAIGN,
          artifactKey,
        );
    });
}

function isProductionGrowthCampaign(value: any): boolean {
  return token(value) === PRODUCTION_GROWTH_CAMPAIGN;
}

async function productionBatchScheduleReadiness(
  artifactEntity: any,
  sourceEntity: any,
  batch: any,
  targetArtifact: any,
  nowMs = Date.now(),
): Promise<{ ok: boolean; error?: string; artifacts?: any[] }> {
  const batchKey = exactSha256(batch?.batch_key);
  const pack = storedPack(batch);
  const provenance = batchArtifactProvenanceMap(batch, pack);
  const targetDate = String(batch?.target_date || "").trim();
  if (
    !batchKey
    || batchContentProfile(batch) !== FEATURE_EXPLAINER_VIDEO_PROFILE
    || Number(batch?.concept_count || 0) !== 2
    || !featureExplainerPackContract(
      pack,
      batchInputMode(batch) === BATCH_INPUT_BOOTSTRAP,
    )
    || !provenance
    || provenance.size !== 4
    || !phoenixDateStart(targetDate)
  ) {
    return { ok: false, error: "production_batch_required" };
  }
  const artifacts = asArray(await artifactEntity.filter(
    { growth_batch_key: batchKey },
    "artifact_key",
    20,
  )).filter((artifact) => (
    exactSha256(artifact?.growth_batch_key) === batchKey
  ));
  if (artifacts.length !== 4) {
    return { ok: false, error: "production_batch_incomplete" };
  }
  const byKey = new Map<string, any>();
  const byConcept = new Map<string, any[]>();
  for (const artifact of artifacts) {
    const artifactKey = token(artifact?.artifact_key);
    const conceptId = token(artifact?.concept_id);
    const platform = token(artifact?.platform);
    const expected = provenance.get(artifactKey);
    const approvedHash = await artifactApprovalHash(artifact);
    const dueAt = batchSlotDueAt(
      artifact?.growth_batch_target_date,
      artifact?.growth_batch_slot_key,
    );
    const dueMs = new Date(dueAt || 0).getTime();
    if (
      !artifactKey
      || byKey.has(artifactKey)
      || !conceptId
      || !PLATFORMS.has(platform)
      || !expected
      || token(artifact?.campaign) !== PRODUCTION_GROWTH_CAMPAIGN
      || token(artifact?.format) !== "video"
      || exactSha256(artifact?.render_pack_sha256)
        !== exactSha256(batch?.canonical_pack_sha256)
      || exactSha256(artifact?.growth_batch_key) !== expected.growth_batch_key
      || artifact?.growth_batch_target_date !== expected.growth_batch_target_date
      || token(artifact?.growth_batch_slot_key)
        !== expected.growth_batch_slot_key
      || artifact?.approval_status !== "approved"
      || artifact?.review_status !== "passed"
      || !artifact?.approved_hash
      || artifact.approved_hash !== approvedHash
      || artifact?.privacy_cleared !== true
      || artifact?.demo_labeled !== true
      || artifact?.claims_supported !== true
      || artifact?.media_rights_confirmed !== true
      || !artifactMediaReady(artifact)
      || !Number.isFinite(dueMs)
      || dueMs < nowMs + MIN_SCHEDULE_LEAD_MS
      || dueMs > nowMs + MAX_SCHEDULE_LEAD_MS
    ) {
      return { ok: false, error: "production_batch_not_schedulable" };
    }
    const sourceKeys = cleanTokenList(artifact?.source_asset_keys);
    const sources = await sourcesForArtifact(sourceEntity, sourceKeys);
    if (
      !sourcesAreSafe(sources, sourceKeys.length)
      || !renderLineageMatchesSources(artifact, sources)
    ) {
      return { ok: false, error: "production_batch_not_schedulable" };
    }
    byKey.set(artifactKey, artifact);
    if (!byConcept.has(conceptId)) byConcept.set(conceptId, []);
    byConcept.get(conceptId)?.push(artifact);
  }
  if (
    byKey.size !== provenance.size
    || byConcept.size !== 2
    || (
      targetArtifact?.id
      && (
        !byConcept.has(token(targetArtifact?.concept_id))
        || !artifacts.some((artifact) => (
          String(artifact?.id || "") === String(targetArtifact.id)
        ))
      )
    )
    || [...byConcept.values()].some((pair) => (
      pair.length !== 2
      || new Set(pair.map((artifact) => token(artifact?.platform))).size !== 2
      || !pair.some((artifact) => token(artifact?.platform) === "instagram")
      || !pair.some((artifact) => token(artifact?.platform) === "tiktok")
      || new Set(pair.map((artifact) => token(artifact?.growth_batch_slot_key))).size !== 1
    ))
  ) {
    return { ok: false, error: "production_batch_incomplete" };
  }
  return { ok: true, artifacts };
}

async function validateCurrentBatch(
  batch: any,
  planEntity: any,
  metricEntity: any,
  sourceEntity: any,
): Promise<{ ok: boolean; error?: string; evidence?: any; pack?: any }> {
  const contentProfile = batchContentProfile(batch);
  const inputMode = batchInputMode(batch);
  if (!NEXT_BATCH_PROFILES.has(contentProfile)) {
    return { ok: false, error: "growth_batch_profile_conflict" };
  }
  if (![BATCH_INPUT_REVIEWED, BATCH_INPUT_BOOTSTRAP].includes(inputMode)) {
    return { ok: false, error: "growth_batch_input_mode_conflict" };
  }
  if (!(await storedPackIsValid(batch))) {
    return { ok: false, error: "growth_batch_storage_conflict" };
  }
  const pack = storedPack(batch);
  let evidence: any = null;
  if (inputMode === BATCH_INPUT_REVIEWED) {
    evidence = await loadReviewedBatchEvidence(
      planEntity,
      metricEntity,
      {
        platform: batch?.parent_platform,
        campaign: batch?.parent_campaign,
        content: batch?.parent_content,
      },
    );
    if (
      evidence?.error
      || evidence.reviewHash !== exactSha256(batch?.review_hash)
      || evidence.evidenceHash !== exactSha256(batch?.evidence_hash)
      || token(batch?.review_schema_version) !== REVIEW_SCHEMA_VERSION
      || evidence.reviewSchemaVersion !== token(batch?.review_schema_version)
      || !batchDecisionPolicyMatches(batch, evidence)
      || evidence.conversionEvidenceHash
        !== exactSha256(batch?.conversion_evidence_hash)
      || evidence.conversionCutoffAt
        !== timestamp(batch?.conversion_cutoff_at)
      || evidence.decision !== token(batch?.review_decision)
    ) {
      return { ok: false, error: "growth_batch_evidence_stale" };
    }
  } else if (!(await bootstrapBatchTrustIsValid(batch, pack))) {
    return { ok: false, error: "growth_batch_bootstrap_stale" };
  }
  const packSources = asArray(pack?.sources);
  const sourceKeys = cleanTokenList(batch?.source_asset_keys, 3);
  const conceptCount = Number(batch?.concept_count || 0);
  if (
    !pack
    || sourceKeys.length !== conceptCount
    || packSources.length !== sourceKeys.length
    || packSources.some(
      (source, index) => token(source?.asset_key) !== sourceKeys[index],
    )
  ) {
    return { ok: false, error: "growth_batch_lineage_conflict" };
  }
  const currentSources = await sourcesForArtifact(sourceEntity, sourceKeys);
  if (!sourcesAreSafe(currentSources, sourceKeys.length)) {
    return { ok: false, error: "growth_batch_source_unavailable" };
  }
  if (
    contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE
    && (
      conceptCount !== 2
      || currentSources.some(
        (source) => (
          !FEATURE_EXPLAINER_SOURCE_KINDS.has(token(source?.media_kind))
        ),
      )
      || !featureExplainerPackContract(
        pack,
        inputMode === BATCH_INPUT_BOOTSTRAP,
      )
    )
  ) {
    return { ok: false, error: "growth_batch_profile_conflict" };
  }
  const promptSourceSha256 = await sha256Hex(canonicalStringify(
    batchPromptSourceSnapshot(sourceKeys, currentSources),
  ));
  if (promptSourceSha256 !== exactSha256(batch?.prompt_source_sha256)) {
    return { ok: false, error: "growth_batch_prompt_source_changed" };
  }
  for (let index = 0; index < currentSources.length; index += 1) {
    if (
      localReference(currentSources[index]?.source_reference)
        !== localReference(packSources[index]?.source_reference)
      || exactSha256(currentSources[index]?.source_sha256)
        !== exactSha256(packSources[index]?.source_sha256)
      || (
        contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE
        && token(currentSources[index]?.media_kind)
          !== token(packSources[index]?.media_kind)
      )
    ) {
      return { ok: false, error: "growth_batch_source_lineage_changed" };
    }
  }
  const storedHooks = cleanStringList(
    batch?.generated_hook_reservations,
    6,
    120,
  );
  const packHooks = packConceptHooks(pack);
  if (
    !packHooks
    || !batchArtifactProvenanceMap(batch, pack)
    || storedHooks.length !== packHooks.length
    || canonicalStringify(storedHooks) !== canonicalStringify(packHooks)
    || exactSha256(batch?.generated_hooks_sha256)
      !== await sha256Hex(canonicalStringify(storedHooks))
  ) {
    return { ok: false, error: "growth_batch_hook_lineage_conflict" };
  }
  return { ok: true, evidence, pack };
}

async function authorizedBatchForPack(
  batchEntity: any,
  packSha256: string,
  renderPack: any,
): Promise<{ batch?: any; error?: string }> {
  if (!packSha256) return {};
  const matches = asArray(await batchEntity.filter(
    {
      canonical_pack_sha256: packSha256,
      state: "render_authorized",
    },
    "-render_authorized_at",
    20,
  ));
  if (matches.length > 1) {
    return { error: "growth_batch_authorization_conflict" };
  }
  const batch = matches[0];
  if (!batch) return {};
  const pack = storedPack(batch);
  if (
    !pack
    || canonicalStringify(pack) !== canonicalStringify(renderPack)
    || !(await storedPackIsValid(batch))
  ) {
    return { error: "growth_batch_render_pack_tampered" };
  }
  return { batch };
}

async function artifactBatchTrust(
  artifact: any,
  batchEntity: any,
  planEntity: any,
  metricEntity: any,
  sourceEntity: any,
): Promise<{ ok: boolean; error?: string; batch?: any }> {
  const packSha256 = exactSha256(artifact?.render_pack_sha256);
  const claimedBatchKey = exactSha256(artifact?.growth_batch_key);
  if (!artifact?.render_result_schema || !packSha256) {
    return claimedBatchKey
      ? { ok: false, error: "growth_batch_lineage_conflict" }
      : { ok: true };
  }
  const batches = asArray(await batchEntity.filter(
    { canonical_pack_sha256: packSha256 },
    "-state_changed_at",
    20,
  ));
  if (!batches.length) {
    return configuredRenderPackHashes().has(packSha256) && !claimedBatchKey
      ? { ok: true }
      : { ok: false, error: "growth_batch_not_authorized" };
  }
  if (batches.length !== 1 || token(batches[0]?.state) !== "render_authorized") {
    return { ok: false, error: "growth_batch_not_authorized" };
  }
  const current = await validateCurrentBatch(
    batches[0],
    planEntity,
    metricEntity,
    sourceEntity,
  );
  if (!current.ok) {
    return {
      ok: false,
      error: current.error || "growth_batch_not_authorized",
    };
  }
  const provenance = batchArtifactProvenanceMap(batches[0], current.pack);
  const expected = provenance?.get(token(artifact?.artifact_key));
  if (
    !expected
    || artifact?.growth_batch_key !== expected.growth_batch_key
    || artifact?.growth_batch_target_date
      !== expected.growth_batch_target_date
    || token(artifact?.growth_batch_slot_key)
      !== expected.growth_batch_slot_key
  ) {
    return { ok: false, error: "growth_batch_lineage_conflict" };
  }
  return { ok: true, batch: batches[0] };
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") return response({ error: "method_not_allowed" }, 405);

    let body = await readBody(req);
    let action = token(body?.action);
    const scheduledGeneration = action === SCHEDULED_GENERATION_ACTION;
    let user: any;
    if (scheduledGeneration) {
      const auth = scheduledGenerationSecret(req);
      if (auth.configured.length < 32) {
        return response({ error: "growth_generation_worker_not_configured" }, 503);
      }
      if (
        !auth.supplied
        || !constantTimeEqual(auth.configured, auth.supplied)
      ) {
        return response({ error: "worker_unauthorized" }, 401);
      }
      if (
        normalized(Deno.env.get("GROWTH_SCHEDULED_GENERATION_ENABLED"))
          !== "true"
      ) {
        return response({ error: "growth_scheduled_generation_disabled" }, 503);
      }
      if (
        normalized(Deno.env.get("GROWTH_CONTENT_GENERATION_ENABLED"))
          !== "true"
      ) {
        return response({ error: "content_generation_not_configured" }, 503);
      }
      user = {
        id: SCHEDULED_GENERATION_ACTOR_ID,
        role: "admin",
        is_owner: false,
      };
    }

    const base44 = createClientFromRequest(req);
    if (!scheduledGeneration) {
      user = await base44.auth.me();
      if (!user?.id) return response({ error: "unauthorized" }, 401);
      if (!canManageGrowth(user)) {
        return response({ error: "growth_admin_required" }, 403);
      }
    }
    if (
      [
        "approve",
        "revoke",
        "schedule",
        "preflight_batch_activation",
        "cancel_job",
        "resolve_job",
        "build_audited_bootstrap_batch",
        "authorize_batch",
        "revoke_batch",
      ].includes(action)
      && !canApproveGrowth(user)
    ) {
      return response({ error: "growth_owner_required" }, 403);
    }

    const sourceEntity = base44.asServiceRole.entities.GrowthSourceAsset;
    const artifactEntity = base44.asServiceRole.entities.GrowthCreativeArtifact;
    const jobEntity = base44.asServiceRole.entities.GrowthPublishJob;
    const heartbeatEntity = base44.asServiceRole.entities.GrowthPublishHeartbeat;
    const planEntity = base44.asServiceRole.entities.GrowthContentPlan;
    const metricEntity = base44.asServiceRole.entities.GrowthContentMetric;
    const batchEntity = base44.asServiceRole.entities.GrowthContentBatch;

    if (scheduledGeneration) {
      const prepared = await prepareScheduledGenerationRequest(
        body,
        planEntity,
        metricEntity,
        batchEntity,
        sourceEntity,
      );
      if (prepared?.error) {
        return response(
          { error: prepared.error },
          prepared.status || 409,
        );
      }
      if (prepared?.existing) {
        return response({
          success: true,
          idempotent: true,
          scheduled_generation: true,
          batch: safeBatch(prepared.existing),
          pack_sha256: prepared.existing.canonical_pack_sha256,
          render_pack: prepared.pack,
          generation_handoff: scheduledGenerationHandoff(prepared.existing),
        });
      }
      body = prepared.request;
      action = "build_next_batch";
    }

    if (action === "list") {
      const [sources, artifacts, jobs, batches, capabilities] = await Promise.all([
        sourceEntity.list("-updated_date", MAX_LIST),
        artifactEntity.list("-updated_date", MAX_LIST),
        jobEntity.list("-created_date", MAX_LIST),
        batchEntity.list("-requested_at", MAX_BATCH_LIST),
        publicCapabilities(user, heartbeatEntity),
      ]);
      const summary = {
        sources: asArray(sources).length,
        drafts: asArray(artifacts).filter(
          (item) => item?.approval_status === "not_approved"
            && item?.review_status !== "passed",
        ).length,
        needs_review: asArray(artifacts).filter(
          (item) => item?.review_status !== "passed"
            && item?.approval_status === "not_approved",
        ).length,
        approved: asArray(artifacts).filter(
          (item) => item?.approval_status === "approved",
        ).length,
        queued: asArray(jobs).filter(
          (item) => token(item?.state) === SCHEDULE_RESERVATION_STATE
            ? scheduleReservationActive(item)
            : !TERMINAL_JOB_STATES.has(token(item?.state)),
        ).length,
        attention: asArray(jobs).filter(
          (item) => [
            "create_reconcile",
            "delivery_reconcile",
            "review_required",
          ].includes(token(item?.state)),
        ).length,
        batches_ready: asArray(batches).filter(
          (item) => token(item?.state) === "ready",
        ).length,
        batches_authorized: asArray(batches).filter(
          (item) => token(item?.state) === "render_authorized",
        ).length,
      };
      return response({
        capabilities,
        summary,
        sources: asArray(sources).map(safeSource),
        artifacts: asArray(artifacts),
        jobs: asArray(jobs).map(safeJob),
        batches: asArray(batches).map(safeBatch),
      });
    }

    if (action === "preflight_batch_activation") {
      const batchKey = exactSha256(body?.batch_key);
      if (!batchKey) return response({ error: "production_batch_required" }, 400);
      const rows = await exactBatchRows(batchEntity, batchKey);
      if (rows.length !== 1 || token(rows[0]?.state) !== "render_authorized") {
        return response({ error: "production_batch_required" }, 409);
      }
      const batch = rows[0];
      const current = await validateCurrentBatch(
        batch,
        planEntity,
        metricEntity,
        sourceEntity,
      );
      if (!current.ok) {
        return response({ error: current.error || "production_batch_required" }, 409);
      }
      const packArtifacts = asArray(current.pack?.artifacts);
      const targetArtifact = packArtifacts[0] || {};
      const readiness = await productionBatchScheduleReadiness(
        artifactEntity,
        sourceEntity,
        batch,
        targetArtifact,
      );
      if (!readiness.ok) return response({ error: readiness.error }, 409);
      const publishEnvironment = publisherEnvironment();
      if (
        !publishEnvironment.publisherReady
        || !publishEnvironment.instagramChannelId
        || !publishEnvironment.tiktokChannelId
      ) {
        return response({ error: "publishing_not_configured" }, 503);
      }
      const heartbeat = await recentWorkerHeartbeat(
        heartbeatEntity,
        publishEnvironment,
      );
      if (!heartbeat.ready) {
        return response({ error: "publisher_worker_unavailable" }, 503);
      }
      return response({
        success: true,
        batch: safeBatch(batch),
        artifacts: (readiness.artifacts || []).map((artifact) => ({
          id: artifact.id,
          artifact_key: artifact.artifact_key,
          concept_id: artifact.concept_id,
          platform: artifact.platform,
          due_at: batchSlotDueAt(
            artifact?.growth_batch_target_date,
            artifact?.growth_batch_slot_key,
          ),
        })),
      });
    }

    if (action === "register_sources") {
      if (
        !Array.isArray(body?.sources)
        || body.sources.length < 1
        || body.sources.length > MAX_SOURCE_BATCH
      ) {
        return response({ error: "invalid_source_batch" }, 400);
      }
      const sources = body.sources.map(normalizeSource);
      if (
        sources.some((source: any) => !source)
        || new Set(sources.map((source: any) => source.asset_key)).size !== sources.length
      ) {
        return response({ error: "invalid_source_asset" }, 400);
      }
      const existing = asArray(await sourceEntity.filter(
        { asset_key: { $in: sources.map((source: any) => source.asset_key) } },
        "-updated_date",
        MAX_SOURCE_BATCH * 3,
      ));
      const grouped = new Map<string, any[]>();
      for (const row of existing) {
        const key = token(row?.asset_key);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)?.push(row);
      }
      if ([...grouped.values()].some((rows) => rows.length > 1)) {
        return response({ error: "source_asset_conflict" }, 409);
      }
      let created = 0;
      let updated = 0;
      const guardedChanges = sources.filter((source: any) => {
        const current = grouped.get(source.asset_key)?.[0];
        return current?.id && sourceRequiresDependencyFence(current, source);
      });
      const guardedKeys = new Set(
        guardedChanges.map((source: any) => source.asset_key),
      );
      const lineageChangeKeys = new Set(
        guardedChanges
          .filter((source: any) => sourceRenderIdentityChanged(
            grouped.get(source.asset_key)?.[0],
            source,
          ))
          .map((source: any) => source.asset_key),
      );
      if (existing.some((source) => sourcePrivacyFenceActive(source))) {
        return response({ error: "source_privacy_change_in_progress" }, 409);
      }
      if (existing.some((source) => (
        source?.privacy_change_pending === true
        && !guardedKeys.has(token(source?.asset_key))
      ))) {
        return response({
          error: "stale_source_privacy_change_requires_downgrade_retry",
        }, 409);
      }
      const privacyFences: any[] = [];
      if (guardedChanges.length) {
        try {
          for (const source of guardedChanges) {
            const current = grouped.get(source.asset_key)?.[0];
            const fence = await acquireSourcePrivacyFence(sourceEntity, current);
            if (!fence) {
              return response({ error: "source_privacy_change_in_progress" }, 409);
            }
            privacyFences.push(fence);
          }
          const [allArtifacts, allJobs] = await Promise.all([
            listAllDependencies(artifactEntity, "Creative artifacts"),
            listAllDependencies(jobEntity, "Publish jobs"),
          ]);
          const dependentArtifacts = allArtifacts.filter((artifact) => (
            cleanTokenList(artifact?.source_asset_keys)
              .some((key) => guardedKeys.has(key))
          ));
          const artifactIds = new Set(
            dependentArtifacts.map((artifact) => String(artifact?.id || "")),
          );
          const contentKeys = new Set(
            dependentArtifacts.map((artifact) => (
              `${token(artifact?.platform)}|${token(artifact?.platform_content_id)}`
            )),
          );
          const dependentJobs = allJobs.filter((job) => (
            artifactIds.has(String(job?.artifact_id || ""))
            || contentKeys.has(
              `${token(job?.platform)}|${token(job?.platform_content_id)}`,
            )
          ));
          for (const job of dependentJobs) {
            if (
              token(job?.state) === SCHEDULE_RESERVATION_STATE
              && !scheduleReservationActive(job)
            ) {
              const expiration = await expireScheduleReservation(
                jobEntity,
                planEntity,
                job,
              ).catch(() => ({
                finalized: false,
                error: "content_plan_unavailable",
              }));
              if (!expiration.finalized) {
                return response({
                  error: expiration.error
                    || "source_privacy_cancellation_required",
                  message: expiration.repairPending
                    ? "The expired scheduling reservation is durably waiting for measurement-plan cancellation."
                    : "The expired scheduling reservation could not be fenced safely; retry the source change.",
                }, 409);
              }
            }
          }
          const refreshedDependentJobs = await Promise.all(
            dependentJobs.map(
              (job) => jobEntity.get(job.id).catch(() => job),
            ),
          );
          if (refreshedDependentJobs.some((job) => (
            token(job?.state) === SCHEDULE_RESERVATION_STATE
            && !scheduleReservationActive(job)
          ))) {
            return response({
              error: "source_privacy_cancellation_required",
              message:
                "An expired scheduling reservation could not be fenced safely; retry the source change.",
            }, 409);
          }
          const liveDependentJobs = refreshedDependentJobs.filter((job) => (
            token(job?.state) !== SCHEDULE_RESERVATION_STATE
            || scheduleReservationActive(job)
          ));
          const blockingJobs = liveDependentJobs.filter((job) => {
            if (durableSentEvidence(job)) return false;
            if (
              job?.provider_post_id
              && !ownerVerifiedProviderCancellation(job)
            ) {
              return true;
            }
            if (
              TERMINAL_JOB_STATES.has(token(job?.state))
              || token(job?.state) === "measurement_retry"
            ) {
              return false;
            }
            return !["queued", "retry_wait", "delivery_reconcile"].includes(
              token(job?.state),
            );
          });
          if (blockingJobs.length) {
            return response({
              error: "source_privacy_cancellation_required",
              message:
                "Cancel or resolve live and ambiguous provider work before changing source safety or render identity.",
            }, 409);
          }
          const cancelableJobs = liveDependentJobs.filter((job) => (
            !durableSentEvidence(job)
            && ["queued", "retry_wait", "delivery_reconcile"].includes(
              token(job?.state),
            )
          ));
          for (const job of cancelableJobs) {
            const dependentArtifact = dependentArtifacts.find((artifact) => (
              String(artifact?.id || "") === String(job?.artifact_id || "")
              || (
                token(artifact?.platform) === token(job?.platform)
                && token(artifact?.platform_content_id)
                  === token(job?.platform_content_id)
              )
            ));
            const lineageChanged = cleanTokenList(
              dependentArtifact?.source_asset_keys,
            ).some((key) => lineageChangeKeys.has(key));
            const canceledAt = new Date().toISOString();
            const verifiedCancellation = ownerVerifiedProviderCancellation(job);
            const canceled = await jobEntity.updateMany(
              {
                id: job.id,
                state: job.state,
                lease_generation: Number(job?.lease_generation || 0),
              },
              {
                $set: {
                  state: "canceled",
                  canceled_at: verifiedCancellation
                    ? timestamp(job?.canceled_at) || canceledAt
                    : canceledAt,
                  ...(verifiedCancellation
                    ? {}
                    : {
                      last_error_code: lineageChanged
                        ? "source_render_lineage_changed"
                        : "source_privacy_downgraded",
                      last_error_message: lineageChanged
                        ? "A rendered source changed before provider submission."
                        : "A dependent source was blocked before provider submission.",
                    }),
                },
                $unset: {
                  next_retry_at: true,
                  delivery_reconcile_target: true,
                  lease_source_state: true,
                },
              },
            );
            if (Number(canceled?.updated || 0) !== 1) {
              return response({
                error: "source_privacy_cancellation_required",
                message:
                  "A dependent publish job began processing while source safety or render identity was changing.",
              }, 409);
            }
            const saved = await jobEntity.get(job.id);
            const delivery = await reconcileCanceledMeasurementPlan(
              planEntity,
              jobEntity,
              saved,
            );
            if (!delivery.ok) {
              return response({
                error: delivery.error,
                message:
                  "The publish job was canceled, but its measurement plan needs attention.",
              }, 409);
            }
          }
          for (const source of guardedChanges) {
            const fence = privacyFences.find(
              (item) => item.assetKey === source.asset_key,
            );
            const result = await sourceEntity.updateMany(
              {
                id: fence?.id,
                privacy_change_pending: true,
                privacy_change_generation: fence?.generation,
                privacy_change_token: fence?.token,
              },
              {
                $set: {
                  ...source,
                  privacy_change_pending: false,
                  privacy_change_token: "",
                },
                $unset: { privacy_change_expires_at: true },
              },
            );
            if (Number(result?.updated || 0) !== 1) {
              return response({ error: "source_asset_changed_during_update" }, 409);
            }
            fence.committed = true;
            updated += 1;
          }
        } finally {
          await Promise.all(
            privacyFences.map((fence) => (
              releaseSourcePrivacyFence(sourceEntity, fence)
            )),
          );
        }
      }
      for (const source of sources) {
        if (guardedKeys.has(source.asset_key)) continue;
        const current = grouped.get(source.asset_key)?.[0];
        if (current?.id) {
          const result = await sourceEntity.updateMany(
            {
              id: current.id,
              updated_date: current.updated_date,
            },
            {
              $set: {
                ...source,
                privacy_change_pending: false,
                privacy_change_token: "",
              },
              $unset: { privacy_change_expires_at: true },
            },
          );
          if (Number(result?.updated || 0) !== 1) {
            return response({ error: "source_asset_changed_during_update" }, 409);
          }
          updated += 1;
        } else {
          await sourceEntity.create({
            ...source,
            privacy_change_pending: false,
            privacy_change_generation: 0,
            privacy_change_token: "",
          });
          created += 1;
        }
      }
      return response({ success: true, created, updated, total: sources.length });
    }

    if (action === "build_audited_bootstrap_batch") {
      if (normalized(Deno.env.get("GROWTH_CONTENT_GENERATION_ENABLED")) !== "true") {
        return response({ error: "content_generation_not_configured" }, 503);
      }
      const targetDate = validBatchTargetDate(body?.target_date);
      const note = compactText(body?.authorization_note, 500);
      const requestedContentProfile = token(body?.content_profile);
      const requestedConceptCount = body?.concept_count === undefined
        ? 2
        : Number(body?.concept_count);
      if (
        !targetDate
        || body?.bootstrap_acknowledged !== true
        || note.length < 10
        || requestedConceptCount !== 2
        || (
          requestedContentProfile
          && requestedContentProfile !== FEATURE_EXPLAINER_VIDEO_PROFILE
        )
        || body?.seed_concept_ids !== undefined
      ) {
        return response({ error: "invalid_bootstrap_batch_request" }, 400);
      }
      const seedPack = body?.seed_pack?.pack || body?.seed_pack;
      const seedPackSha256 = await sha256Hex(canonicalStringify(seedPack));
      const allowedSeedHashes = configuredRenderPackHashes();
      if (!allowedSeedHashes.size) {
        return response({ error: "trusted_seed_pack_not_configured" }, 503);
      }
      if (!allowedSeedHashes.has(seedPackSha256)) {
        return response({ error: "untrusted_seed_render_pack" }, 409);
      }
      const seed = seedDonorPool(
        seedPack,
        FEATURE_EXPLAINER_VIDEO_PROFILE,
      );
      if (seed.error || !seed.donors) {
        return response({
          error: seed.error === "seed_pack_has_no_safe_donors"
            ? "insufficient_eligible_video_donors"
            : seed.error || "invalid_seed_render_pack",
          required_donors: 2,
          eligible_donors: 0,
        }, seed.error === "invalid_seed_render_pack" ? 400 : 409);
      }
      if (seed.donors.length < 2) {
        return response({
          error: "insufficient_eligible_video_donors",
          required_donors: 2,
          eligible_donors: seed.donors.length,
        }, 409);
      }
      const [
        allBatches,
        reservationArtifacts,
        reservationJobs,
      ] = await Promise.all([
        listAllDependencies(batchEntity, "Growth content batches"),
        listAllDependencies(artifactEntity, "Growth creative artifacts"),
        listAllDependencies(jobEntity, "Growth publish jobs"),
      ]);
      const sameDateRows = allBatches.filter((batch) => (
        batchInputMode(batch) === BATCH_INPUT_BOOTSTRAP
        && String(batch?.target_date || "") === targetDate
        && token(batch?.state) !== "superseded"
      )).sort(batchOrder);
      if (sameDateRows.length > 1) {
        return response({ error: "bootstrap_daily_batch_conflict" }, 409);
      }
      const prior = sameDateRows[0];
      if (
        prior
        && (
          token(prior?.bootstrap_policy_version) !== BOOTSTRAP_POLICY_VERSION
          || exactSha256(prior?.seed_pack_sha256) !== seedPackSha256
          || batchContentProfile(prior) !== FEATURE_EXPLAINER_VIDEO_PROFILE
        )
      ) {
        return response({ error: "bootstrap_daily_batch_conflict" }, 409);
      }
      if (
        prior
        && ["revoked", "superseded"].includes(token(prior?.state))
      ) {
        return response({
          error: `growth_batch_${token(prior?.state)}`,
        }, 409);
      }
      const authorizedBy = String(user?.id || "").slice(0, 160);
      if (
        prior
        && (
          String(prior?.bootstrap_authorization_note || "") !== note
          || String(prior?.bootstrap_authorized_by || "") !== authorizedBy
        )
      ) {
        return response({ error: "bootstrap_authorization_conflict" }, 409);
      }
      if (
        prior
        && ["ready", "render_authorized"].includes(token(prior?.state))
      ) {
        const current = await validateCurrentBatch(
          prior,
          planEntity,
          metricEntity,
          sourceEntity,
        );
        if (!current.ok) return response({ error: current.error }, 409);
        return response({
          success: true,
          idempotent: true,
          batch: safeBatch(prior),
          pack_sha256: prior.canonical_pack_sha256,
          render_pack: current.pack,
        });
      }
      const bootstrapRows = allBatches.filter((batch) => (
        batchInputMode(batch) === BATCH_INPUT_BOOTSTRAP
        && token(batch?.bootstrap_policy_version) === BOOTSTRAP_POLICY_VERSION
        && exactSha256(batch?.seed_pack_sha256) === seedPackSha256
        && !["revoked", "superseded"].includes(token(batch?.state))
      ));
      if (!prior && bootstrapRows.length >= MAX_BOOTSTRAP_BATCHES) {
        return response({
          error: "bootstrap_batch_limit_reached",
          maximum_batches: MAX_BOOTSTRAP_BATCHES,
        }, 409);
      }
      const priorBatchKey = exactSha256(prior?.batch_key);
      const reservedSources = activeBatchReservations(
        allBatches,
        targetDate,
        priorBatchKey,
      );
      for (const sourceToken of contentSourceReservations(
        reservationArtifacts,
        reservationJobs,
        targetDate,
      )) {
        reservedSources.add(sourceToken);
      }
      const selected = chooseDonors(
        seed.donors,
        2,
        prior ? cleanTokenList(prior?.seed_concept_ids, 2) : [],
        "",
        reservedSources,
        BOOTSTRAP_CONCEPT_PRIORITY,
      );
      if (selected.error || !selected.donors) {
        return response({
          error: [
            "insufficient_eligible_donors",
            "seed_donor_unavailable",
          ].includes(String(selected.error || ""))
            ? "insufficient_eligible_video_donors"
            : selected.error || "insufficient_eligible_video_donors",
          required_donors: 2,
          eligible_donors: Number(selected.eligible || 0),
          source_cooldown_days: SOURCE_COOLDOWN_DAYS,
        }, 409);
      }
      const donors = selected.donors;
      const currentSources = await currentDonorSources(
        sourceEntity,
        donors,
        FEATURE_EXPLAINER_VIDEO_PROFILE,
      );
      if (!currentSources) {
        return response({ error: "seed_donor_source_unavailable" }, 409);
      }
      const sourceKeys = donors.map((donor) => donor.sourceKey);
      const promptSources = batchPromptSourceSnapshot(sourceKeys, currentSources);
      if (promptSources.some((source) => !source.safe_source_summary)) {
        return response({ error: "seed_donor_summary_unavailable" }, 409);
      }
      const promptSourceSha256 = await sha256Hex(
        canonicalStringify(promptSources),
      );
      const sourceLineage = exactDonorSources(donors);
      const seedLineage = donorLineage(donors);
      const seedArtifactKeys = seedLineage.flatMap((lineage) => [
        lineage.instagram_artifact_key,
        lineage.tiktok_artifact_key,
      ]);
      const identityFields = {
        target_date: targetDate,
        seed_pack_sha256: seedPackSha256,
        seed_concept_ids: donors.map((donor) => donor.conceptId),
      };
      const batchKey = await sha256Hex(canonicalStringify(
        bootstrapBatchIdentity(identityFields),
      ));
      if (prior && exactSha256(prior?.batch_key) !== batchKey) {
        return response({ error: "bootstrap_daily_batch_conflict" }, 409);
      }
      const authorizedAt = prior
        ? timestamp(prior?.bootstrap_authorized_at) || ""
        : new Date().toISOString();
      if (!authorizedAt) {
        return response({ error: "bootstrap_authorization_conflict" }, 409);
      }
      const fields: any = {
        batch_input_mode: BATCH_INPUT_BOOTSTRAP,
        batch_key: batchKey,
        bootstrap_policy_version: BOOTSTRAP_POLICY_VERSION,
        bootstrap_authorized_by: authorizedBy,
        bootstrap_authorized_at: authorizedAt,
        bootstrap_authorization_note: note,
        target_date: targetDate,
        content_profile: FEATURE_EXPLAINER_VIDEO_PROFILE,
        timezone: NEXT_BATCH_TIMEZONE,
        concept_count: 2,
        slot_count: 2,
        slot_keys: NEXT_BATCH_SLOTS.slice(0, 2),
        source_asset_keys: sourceKeys,
        source_lineage: sourceLineage,
        prompt_source_sha256: promptSourceSha256,
        seed_pack_batch_id: token(seedPack?.batch_id),
        seed_pack_sha256: seedPackSha256,
        seed_concept_ids: donors.map((donor) => donor.conceptId),
        seed_artifact_keys: seedArtifactKeys,
        seed_lineage: seedLineage,
      };
      fields.bootstrap_authorization_hash = await sha256Hex(
        canonicalStringify(bootstrapAuthorizationPayload(fields)),
      );
      fields.request_hash = await sha256Hex(
        canonicalStringify(bootstrapRequestPayload(fields)),
      );
      if (
        prior
        && (
          exactSha256(prior?.bootstrap_authorization_hash)
            !== fields.bootstrap_authorization_hash
          || exactSha256(prior?.request_hash) !== fields.request_hash
        )
      ) {
        return response({ error: "bootstrap_authorization_conflict" }, 409);
      }
      const renderPack = auditedBootstrapRenderPack(
        seedPack,
        donors,
      );
      const generatedHooks = renderPack ? packConceptHooks(renderPack) : null;
      if (!renderPack) {
        return response({ error: "invalid_audited_bootstrap_caption" }, 409);
      }
      if (!generatedHooks) {
        return response({ error: "invalid_audited_bootstrap_hooks" }, 409);
      }
      const bootstrapContractError = featureExplainerPackContractError(
        renderPack,
        true,
      );
      if (bootstrapContractError) {
        return response({
          error: "invalid_audited_bootstrap_contract",
          contract_failure: bootstrapContractError,
        }, 409);
      }
      const generatedHooksSha256 = await sha256Hex(
        canonicalStringify(generatedHooks),
      );
      const canonicalPackJson = canonicalStringify(renderPack);
      const canonicalPackSha256 = await sha256Hex(canonicalPackJson);
      if (
        canonicalPackJson.length > 100_000
        || asArray(renderPack?.artifacts).length !== 4
      ) {
        return response({ error: "generated_batch_too_large" }, 409);
      }
      const claim = await claimNextBatch(batchEntity, fields, user);
      if (claim.error) {
        return response({
          error: claim.error,
          ...(claim.retry_at ? { retry_at: claim.retry_at } : {}),
        }, claim.status || 409);
      }
      if (claim.idempotent) {
        const current = await validateCurrentBatch(
          claim.batch,
          planEntity,
          metricEntity,
          sourceEntity,
        );
        if (!current.ok) return response({ error: current.error }, 409);
        return response({
          success: true,
          idempotent: true,
          batch: safeBatch(claim.batch),
          pack_sha256: claim.batch.canonical_pack_sha256,
          render_pack: current.pack,
        });
      }
      const reservation = await enforceBatchReservation(
        batchEntity,
        claim.batch,
        claim.leaseToken,
        claim.leaseGeneration,
      );
      if (!reservation.ok) {
        return response({ error: reservation.error }, 409);
      }
      const capRows = (await listAllDependencies(
        batchEntity,
        "Growth content batches",
      )).filter((batch) => (
        batchInputMode(batch) === BATCH_INPUT_BOOTSTRAP
        && token(batch?.bootstrap_policy_version) === BOOTSTRAP_POLICY_VERSION
        && exactSha256(batch?.seed_pack_sha256) === seedPackSha256
        && !["revoked", "superseded"].includes(token(batch?.state))
      )).sort(batchOrder);
      const capIndex = capRows.findIndex(
        (batch) => String(batch?.id || "") === String(claim.batch.id),
      );
      if (capIndex < 0 || capIndex >= MAX_BOOTSTRAP_BATCHES) {
        const limitedAt = new Date().toISOString();
        const policyWinner = capRows[MAX_BOOTSTRAP_BATCHES - 1];
        await batchEntity.updateMany(
          {
            id: claim.batch.id,
            state: "generating",
            lease_generation: claim.leaseGeneration,
            lease_token: claim.leaseToken,
          },
          {
            $set: {
              state: "superseded",
              superseded_by_batch_key:
                exactSha256(policyWinner?.batch_key) || batchKey,
              superseded_at: limitedAt,
              state_changed_at: limitedAt,
              lease_token: "",
            },
            $unset: { lease_expires_at: true },
          },
        );
        return response({
          error: "bootstrap_batch_limit_reached",
          maximum_batches: MAX_BOOTSTRAP_BATCHES,
        }, 409);
      }
      const [
        freshSources,
        freshArtifacts,
        freshBatches,
        freshJobs,
      ] = await Promise.all([
        currentDonorSources(
          sourceEntity,
          donors,
          FEATURE_EXPLAINER_VIDEO_PROFILE,
        ),
        listAllDependencies(artifactEntity, "Growth creative artifacts"),
        listAllDependencies(batchEntity, "Growth content batches"),
        listAllDependencies(jobEntity, "Growth publish jobs"),
      ]);
      const freshPromptSources = freshSources
        ? batchPromptSourceSnapshot(sourceKeys, freshSources)
        : [];
      const freshPromptSourceSha256 = freshSources
        ? await sha256Hex(canonicalStringify(freshPromptSources))
        : "";
      if (
        !configuredRenderPackHashes().has(seedPackSha256)
        || !freshSources
        || freshPromptSourceSha256 !== promptSourceSha256
      ) {
        await markBatchFailed(
          batchEntity,
          claim.batch,
          claim.leaseToken,
          claim.leaseGeneration,
          "growth_batch_inputs_changed",
          "The audited seed allowlist or trusted source lineage changed.",
        );
        return response({ error: "growth_batch_inputs_changed" }, 409);
      }
      const freshPublishedSources = contentSourceReservations(
        freshArtifacts,
        freshJobs,
        targetDate,
      );
      if (donors.some((donor) => (
        donorSourceReservationTokens(donor).some(
          (sourceToken) => freshPublishedSources.has(sourceToken),
        )
      ))) {
        await markBatchFailed(
          batchEntity,
          claim.batch,
          claim.leaseToken,
          claim.leaseGeneration,
          "source_cooldown_conflict",
          "A selected source was published during bootstrap.",
        );
        return response({ error: "source_cooldown_conflict" }, 409);
      }
      const freshHistoricalHooks = historicalBatchHooks(
        freshArtifacts,
        freshBatches,
        targetDate,
        batchKey,
        freshJobs,
      );
      if (generatedHooks.some((hook) => (
        freshHistoricalHooks.some(
          (priorHook) => hookSimilarity(hook, priorHook) >= 0.75,
        )
      ))) {
        await markBatchFailed(
          batchEntity,
          claim.batch,
          claim.leaseToken,
          claim.leaseGeneration,
          "growth_batch_hook_conflict",
          "A current 28-day hook reservation conflicts with this bootstrap.",
        );
        return response({ error: "growth_batch_hook_conflict" }, 409);
      }
      const hookReservationAt = new Date().toISOString();
      const hookReservation = await batchEntity.updateMany(
        {
          id: claim.batch.id,
          state: "generating",
          request_hash: fields.request_hash,
          bootstrap_authorization_hash:
            fields.bootstrap_authorization_hash,
          lease_generation: claim.leaseGeneration,
          lease_token: claim.leaseToken,
          lease_expires_at: { $gt: hookReservationAt },
        },
        {
          $set: {
            generated_hook_reservations: generatedHooks,
            generated_hooks_sha256: generatedHooksSha256,
          },
        },
      );
      if (Number(hookReservation?.updated || 0) !== 1) {
        return response({ error: "growth_batch_lease_expired" }, 409);
      }
      const finalReservation = await enforceBatchReservation(
        batchEntity,
        claim.batch,
        claim.leaseToken,
        claim.leaseGeneration,
      );
      if (!finalReservation.ok) {
        return response({ error: finalReservation.error }, 409);
      }
      const readyAt = new Date().toISOString();
      const finalized = await batchEntity.updateMany(
        {
          id: claim.batch.id,
          state: "generating",
          request_hash: fields.request_hash,
          bootstrap_authorization_hash:
            fields.bootstrap_authorization_hash,
          prompt_source_sha256: promptSourceSha256,
          generated_hooks_sha256: generatedHooksSha256,
          lease_generation: claim.leaseGeneration,
          lease_token: claim.leaseToken,
          lease_expires_at: { $gt: readyAt },
        },
        {
          $set: {
            state: "ready",
            pack_schema_version: "growth-render-pack.v1",
            pack_artifact_count: renderPack.artifacts.length,
            canonical_pack_json: canonicalPackJson,
            canonical_pack_sha256: canonicalPackSha256,
            ready_at: readyAt,
            state_changed_at: readyAt,
            lease_token: "",
            last_error_code: "",
            last_error_message: "",
          },
          $unset: { lease_expires_at: true },
        },
      );
      if (Number(finalized?.updated || 0) !== 1) {
        return response({ error: "growth_batch_finalize_contended" }, 409);
      }
      const saved = await batchEntity.get(claim.batch.id);
      return response({
        success: true,
        idempotent: false,
        batch: safeBatch(saved),
        pack_sha256: canonicalPackSha256,
        render_pack: renderPack,
      }, 201);
    }

    if (action === "build_next_batch") {
      if (normalized(Deno.env.get("GROWTH_CONTENT_GENERATION_ENABLED")) !== "true") {
        return response({ error: "content_generation_not_configured" }, 503);
      }
      const targetDate = validBatchTargetDate(body?.target_date);
      const conceptCount = Number(body?.concept_count);
      const requestedContentProfile = token(body?.content_profile);
      const contentProfile = requestedContentProfile || NEXT_BATCH_PROFILE;
      if (!NEXT_BATCH_PROFILES.has(contentProfile)) {
        return response({ error: "invalid_content_profile" }, 400);
      }
      if (
        contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE
        && conceptCount !== 2
      ) {
        return response({
          error: "feature_explainer_requires_two_concepts",
          required_concepts: 2,
        }, 400);
      }
      const seedPack = body?.seed_pack?.pack || body?.seed_pack;
      const requestedSeedValues = asArray(body?.seed_concept_ids);
      const requestedSeedConceptIds = cleanTokenList(
        requestedSeedValues,
        3,
      );
      if (
        !targetDate
        || ![2, 3].includes(conceptCount)
        || (
          requestedSeedValues.length
          && requestedSeedValues.length !== requestedSeedConceptIds.length
        )
      ) {
        return response({ error: "invalid_growth_batch_request" }, 400);
      }
      const evidence = await loadReviewedBatchEvidence(
        planEntity,
        metricEntity,
        body?.parent,
      );
      if (evidence?.error) {
        return response({ error: evidence.error }, evidence.status || 409);
      }
      const seedPackSha256 = await sha256Hex(canonicalStringify(seedPack));
      const allowedSeedHashes = configuredRenderPackHashes();
      if (!allowedSeedHashes.size) {
        return response({ error: "trusted_seed_pack_not_configured" }, 503);
      }
      if (!allowedSeedHashes.has(seedPackSha256)) {
        return response({ error: "untrusted_seed_render_pack" }, 409);
      }
      const seed = seedDonorPool(seedPack, contentProfile);
      if (seed.error || !seed.donors) {
        if (
          contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE
          && seed.error === "seed_pack_has_no_safe_donors"
        ) {
          return response({
            error: "insufficient_eligible_video_donors",
            required_donors: 2,
            eligible_donors: 0,
          }, 409);
        }
        return response({ error: seed.error || "invalid_seed_render_pack" }, 400);
      }
      if (
        contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE
        && seed.donors.length < 2
      ) {
        return response({
          error: "insufficient_eligible_video_donors",
          required_donors: 2,
          eligible_donors: seed.donors.length,
        }, 409);
      }
      const batchIdentity: any = {
        schema: NEXT_BATCH_SCHEMA,
        parent: {
          platform: evidence.platform,
          campaign: evidence.campaign,
          content: evidence.content,
        },
        review_schema_version: evidence.reviewSchemaVersion,
        review_hash: evidence.reviewHash,
        decision_policy_id: evidence.decisionPolicyId,
        decision_policy_evidence_hash: evidence.decisionPolicyEvidenceHash,
        conversion_evidence_hash: evidence.conversionEvidenceHash,
        conversion_cutoff_at: evidence.conversionCutoffAt,
        target_date: targetDate,
      };
      if (requestedContentProfile) {
        batchIdentity.content_profile = contentProfile;
      }
      const batchKey = await sha256Hex(canonicalStringify(batchIdentity));
      const priorRows = await exactBatchRows(batchEntity, batchKey);
      if (priorRows.length > 1) {
        return response({ error: "growth_batch_conflict" }, 409);
      }
      const prior = priorRows[0];
      let selectionIds = requestedSeedConceptIds;
      if (prior) {
        const storedSelection = cleanTokenList(prior?.seed_concept_ids, 3);
        if (
          selectionIds.length
          && canonicalStringify(selectionIds)
            !== canonicalStringify(storedSelection)
        ) {
          return response({ error: "growth_batch_request_conflict" }, 409);
        }
        selectionIds = storedSelection;
      }
      const [
        allBatches,
        reservationArtifacts,
        reservationJobs,
      ] = await Promise.all([
        listAllDependencies(batchEntity, "Growth content batches"),
        listAllDependencies(artifactEntity, "Growth creative artifacts"),
        listAllDependencies(jobEntity, "Growth publish jobs"),
      ]);
      const reservedSources = activeBatchReservations(
        allBatches,
        targetDate,
        batchKey,
      );
      for (const sourceToken of contentSourceReservations(
        reservationArtifacts,
        reservationJobs,
        targetDate,
      )) {
        reservedSources.add(sourceToken);
      }
      const selected = chooseDonors(
        seed.donors,
        conceptCount,
        selectionIds,
        evidence.content,
        reservedSources,
      );
      if (selected.error || !selected.donors) {
        const profileCapacityError =
          contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE
          && [
            "insufficient_eligible_donors",
            "seed_donor_unavailable",
          ].includes(String(selected.error || ""));
        return response({
          error: profileCapacityError
            ? "insufficient_eligible_video_donors"
            : selected.error || "insufficient_eligible_donors",
          required_donors: conceptCount,
          eligible_donors: Number(selected.eligible || 0),
          source_cooldown_days: SOURCE_COOLDOWN_DAYS,
        }, 409);
      }
      const donors = selected.donors;
      const currentSources = await currentDonorSources(
        sourceEntity,
        donors,
        contentProfile,
      );
      if (!currentSources) {
        return response({ error: "seed_donor_source_unavailable" }, 409);
      }
      const sourceKeys = donors.map((donor) => donor.sourceKey);
      const promptSources = batchPromptSourceSnapshot(sourceKeys, currentSources);
      if (promptSources.some((source) => !source.safe_source_summary)) {
        return response({ error: "seed_donor_summary_unavailable" }, 409);
      }
      const promptSourceSha256 = await sha256Hex(
        canonicalStringify(promptSources),
      );
      const sourceLineage = exactDonorSources(donors);
      const seedLineage = donorLineage(donors);
      const seedArtifactKeys = seedLineage.flatMap((lineage) => [
        lineage.instagram_artifact_key,
        lineage.tiktok_artifact_key,
      ]);
      const requestHash = await sha256Hex(canonicalStringify({
        batch_key: batchKey,
        review_schema_version: evidence.reviewSchemaVersion,
        review_hash: evidence.reviewHash,
        decision_policy_id: evidence.decisionPolicyId,
        decision_policy_evidence_hash: evidence.decisionPolicyEvidenceHash,
        conversion_evidence_hash: evidence.conversionEvidenceHash,
        conversion_cutoff_at: evidence.conversionCutoffAt,
        generation_profile: contentProfile,
        ...(requestedContentProfile ? { content_profile: contentProfile } : {}),
        concept_count: conceptCount,
        seed_pack_sha256: seedPackSha256,
        seed_pack_batch_id: token(seedPack?.batch_id),
        seed_concept_ids: donors.map((donor) => donor.conceptId),
        seed_artifact_keys: seedArtifactKeys,
        source_lineage: sourceLineage,
        prompt_source_sha256: promptSourceSha256,
      }));
      const fields = {
        batch_input_mode: BATCH_INPUT_REVIEWED,
        batch_key: batchKey,
        request_hash: requestHash,
        parent_platform: evidence.platform,
        parent_campaign: evidence.campaign,
        parent_content: evidence.content,
        review_hash: evidence.reviewHash,
        review_schema_version: evidence.reviewSchemaVersion,
        decision_policy_id: evidence.decisionPolicyId,
        decision_policy_reason_codes: evidence.decisionPolicyReasonCodes,
        decision_policy_evidence_hash: evidence.decisionPolicyEvidenceHash,
        comparable_fixed_age_snapshots:
          evidence.comparableFixedAgeSnapshots,
        ...(evidence.decisionOverrideNote ? {
          decision_override_note: evidence.decisionOverrideNote,
          decision_override_hash: evidence.decisionOverrideHash,
        } : {}),
        evidence_hash: evidence.evidenceHash,
        conversion_evidence_hash: evidence.conversionEvidenceHash,
        conversion_cutoff_at: evidence.conversionCutoffAt,
        review_decision: evidence.decision,
        reviewed_at: evidence.reviewedAt,
        review_snapshot_captured_at: evidence.reviewedSnapshotAt,
        target_date: targetDate,
        content_profile: contentProfile,
        timezone: NEXT_BATCH_TIMEZONE,
        concept_count: conceptCount,
        slot_count: conceptCount,
        slot_keys: NEXT_BATCH_SLOTS.slice(0, conceptCount),
        source_asset_keys: donors.map((donor) => donor.sourceKey),
        source_lineage: sourceLineage,
        prompt_source_sha256: promptSourceSha256,
        seed_pack_batch_id: token(seedPack?.batch_id),
        seed_pack_sha256: seedPackSha256,
        seed_concept_ids: donors.map((donor) => donor.conceptId),
        seed_artifact_keys: seedArtifactKeys,
        seed_lineage: seedLineage,
      };
      const claim = await claimNextBatch(batchEntity, fields, user);
      if (claim.error) {
        return response({
          error: claim.error,
          ...(claim.retry_at ? { retry_at: claim.retry_at } : {}),
        }, claim.status || 409);
      }
      if (claim.idempotent) {
        if (!batchDecisionPolicyMatches(claim.batch, evidence)) {
          return response({ error: "growth_batch_evidence_stale" }, 409);
        }
        return response({
          success: true,
          idempotent: true,
          ...(scheduledGeneration ? { scheduled_generation: true } : {}),
          batch: safeBatch(claim.batch),
          pack_sha256: claim.batch.canonical_pack_sha256,
          render_pack: claim.renderPack,
          ...(scheduledGeneration
            ? { generation_handoff: scheduledGenerationHandoff(claim.batch) }
            : {}),
        });
      }
      const reservation = await enforceBatchReservation(
        batchEntity,
        claim.batch,
        claim.leaseToken,
        claim.leaseGeneration,
      );
      if (!reservation.ok) {
        return response({ error: reservation.error }, 409);
      }
      const [recentArtifacts, currentBatches, recentJobs] = await Promise.all([
        listAllDependencies(artifactEntity, "Growth creative artifacts"),
        listAllDependencies(batchEntity, "Growth content batches"),
        listAllDependencies(jobEntity, "Growth publish jobs"),
      ]);
      const priorHooks = historicalBatchHooks(
        asArray(recentArtifacts),
        currentBatches,
        targetDate,
        batchKey,
        recentJobs,
      );
      let generated;
      try {
        generated = await base44.integrations.Core.InvokeLLM({
          prompt: batchGenerationPrompt(
            evidence,
            donors,
            promptSources,
            conceptCount,
            contentProfile,
          ),
          add_context_from_internet: false,
          response_json_schema: nextBatchGeneratorSchema(
            conceptCount,
            contentProfile,
          ),
        });
      } catch (error: any) {
        await markBatchFailed(
          batchEntity,
          claim.batch,
          claim.leaseToken,
          claim.leaseGeneration,
          "content_generation_failed",
          safeProviderError(error?.message, "Content generation failed."),
        );
        return response({ error: "content_generation_failed" }, 502);
      }
      const postGenerationLease = await batchEntity.get(
        claim.batch.id,
      ).catch(() => null);
      if (!batchLeaseOwned(
        postGenerationLease,
        claim.leaseToken,
        claim.leaseGeneration,
      )) {
        return response({ error: "growth_batch_lease_expired" }, 409);
      }
      const generatedConcepts = normalizeGeneratedConcepts(
        generated,
        donors,
        priorHooks,
        contentProfile,
      );
      if (!generatedConcepts) {
        await markBatchFailed(
          batchEntity,
          claim.batch,
          claim.leaseToken,
          claim.leaseGeneration,
          "invalid_generated_batch",
          "The generated batch failed bounded creative validation.",
        );
        return response({ error: "invalid_generated_batch" }, 502);
      }
      const generatedHooks = generatedConcepts.map(
        (concept) => compactText(concept?.hook, 120),
      );
      const generatedHooksSha256 = await sha256Hex(
        canonicalStringify(generatedHooks),
      );
      const renderPack = generatedRenderPack(
        seedPack,
        donors,
        generatedConcepts,
        batchKey,
        targetDate,
        evidence.campaign,
        contentProfile,
      );
      const canonicalPackJson = canonicalStringify(renderPack);
      const canonicalPackSha256 = await sha256Hex(canonicalPackJson);
      if (
        canonicalPackJson.length > 100_000
        || asArray(renderPack?.artifacts).length !== conceptCount * 2
      ) {
        await markBatchFailed(
          batchEntity,
          claim.batch,
          claim.leaseToken,
          claim.leaseGeneration,
          "generated_batch_too_large",
          "The generated render pack exceeded the bounded batch envelope.",
        );
        return response({ error: "generated_batch_too_large" }, 502);
      }
      const [
        freshEvidence,
        freshSources,
        freshArtifacts,
        freshBatches,
        freshJobs,
      ] = await Promise.all([
        loadReviewedBatchEvidence(planEntity, metricEntity, {
          platform: evidence.platform,
          campaign: evidence.campaign,
          content: evidence.content,
        }),
        currentDonorSources(sourceEntity, donors, contentProfile),
        listAllDependencies(artifactEntity, "Growth creative artifacts"),
        listAllDependencies(batchEntity, "Growth content batches"),
        listAllDependencies(jobEntity, "Growth publish jobs"),
      ]);
      const freshPromptSources = freshSources
        ? batchPromptSourceSnapshot(sourceKeys, freshSources)
        : [];
      const freshPromptSourceSha256 = freshSources
        ? await sha256Hex(canonicalStringify(freshPromptSources))
        : "";
      if (
        freshEvidence?.error
        || freshEvidence.reviewHash !== evidence.reviewHash
        || freshEvidence.evidenceHash !== evidence.evidenceHash
        || freshEvidence.reviewSchemaVersion !== evidence.reviewSchemaVersion
        || freshEvidence.decisionPolicyId !== evidence.decisionPolicyId
        || freshEvidence.decisionPolicyEvidenceHash
          !== evidence.decisionPolicyEvidenceHash
        || freshEvidence.conversionEvidenceHash
          !== evidence.conversionEvidenceHash
        || freshEvidence.conversionCutoffAt !== evidence.conversionCutoffAt
        || !freshSources
        || freshPromptSourceSha256 !== promptSourceSha256
      ) {
        await markBatchFailed(
          batchEntity,
          claim.batch,
          claim.leaseToken,
          claim.leaseGeneration,
          "growth_batch_inputs_changed",
          "Reviewed evidence or trusted source lineage changed during generation.",
        );
        return response({ error: "growth_batch_inputs_changed" }, 409);
      }
      const freshPublishedSources = contentSourceReservations(
        freshArtifacts,
        freshJobs,
        targetDate,
      );
      if (donors.some((donor) => (
        donorSourceReservationTokens(donor).some(
          (sourceToken) => freshPublishedSources.has(sourceToken),
        )
      ))) {
        await markBatchFailed(
          batchEntity,
          claim.batch,
          claim.leaseToken,
          claim.leaseGeneration,
          "source_cooldown_conflict",
          "A selected source was published during generation.",
        );
        return response({ error: "source_cooldown_conflict" }, 409);
      }
      const freshHistoricalHooks = historicalBatchHooks(
        freshArtifacts,
        freshBatches,
        targetDate,
        batchKey,
        freshJobs,
      );
      if (generatedHooks.some((hook) => (
        freshHistoricalHooks.some(
          (priorHook) => hookSimilarity(hook, priorHook) >= 0.75,
        )
      ))) {
        await markBatchFailed(
          batchEntity,
          claim.batch,
          claim.leaseToken,
          claim.leaseGeneration,
          "growth_batch_hook_conflict",
          "A current 28-day hook reservation conflicts with this generation.",
        );
        return response({ error: "growth_batch_hook_conflict" }, 409);
      }
      const hookReservationAt = new Date().toISOString();
      const hookReservation = await batchEntity.updateMany(
        {
          id: claim.batch.id,
          state: "generating",
          request_hash: requestHash,
          review_hash: evidence.reviewHash,
          review_schema_version: evidence.reviewSchemaVersion,
          decision_policy_id: evidence.decisionPolicyId,
          decision_policy_evidence_hash: evidence.decisionPolicyEvidenceHash,
          conversion_evidence_hash: evidence.conversionEvidenceHash,
          conversion_cutoff_at: evidence.conversionCutoffAt,
          lease_generation: claim.leaseGeneration,
          lease_token: claim.leaseToken,
          lease_expires_at: { $gt: hookReservationAt },
        },
        {
          $set: {
            generated_hook_reservations: generatedHooks,
            generated_hooks_sha256: generatedHooksSha256,
          },
        },
      );
      if (Number(hookReservation?.updated || 0) !== 1) {
        return response({ error: "growth_batch_lease_expired" }, 409);
      }
      const finalReservation = await enforceBatchReservation(
        batchEntity,
        claim.batch,
        claim.leaseToken,
        claim.leaseGeneration,
      );
      if (!finalReservation.ok) {
        return response({ error: finalReservation.error }, 409);
      }
      const readyAt = new Date().toISOString();
      const finalized = await batchEntity.updateMany(
        {
          id: claim.batch.id,
          state: "generating",
          request_hash: requestHash,
          review_hash: evidence.reviewHash,
          review_schema_version: evidence.reviewSchemaVersion,
          decision_policy_id: evidence.decisionPolicyId,
          decision_policy_evidence_hash: evidence.decisionPolicyEvidenceHash,
          conversion_evidence_hash: evidence.conversionEvidenceHash,
          conversion_cutoff_at: evidence.conversionCutoffAt,
          prompt_source_sha256: promptSourceSha256,
          generated_hooks_sha256: generatedHooksSha256,
          lease_generation: claim.leaseGeneration,
          lease_token: claim.leaseToken,
          lease_expires_at: { $gt: readyAt },
        },
        {
          $set: {
            state: "ready",
            pack_schema_version: "growth-render-pack.v1",
            pack_artifact_count: renderPack.artifacts.length,
            canonical_pack_json: canonicalPackJson,
            canonical_pack_sha256: canonicalPackSha256,
            ready_at: readyAt,
            state_changed_at: readyAt,
            lease_token: "",
            last_error_code: "",
            last_error_message: "",
          },
          $unset: { lease_expires_at: true },
        },
      );
      if (Number(finalized?.updated || 0) !== 1) {
        return response({ error: "growth_batch_finalize_contended" }, 409);
      }
      const saved = await batchEntity.get(claim.batch.id);
      return response({
        success: true,
        idempotent: false,
        ...(scheduledGeneration ? { scheduled_generation: true } : {}),
        batch: safeBatch(saved),
        pack_sha256: canonicalPackSha256,
        render_pack: renderPack,
        ...(scheduledGeneration
          ? { generation_handoff: scheduledGenerationHandoff(saved) }
          : {}),
      }, 201);
    }

    if (action === "get_batch") {
      const batchKey = exactSha256(body?.batch_key);
      if (!batchKey) return response({ error: "invalid_growth_batch_key" }, 400);
      const rows = await exactBatchRows(batchEntity, batchKey);
      if (rows.length !== 1) {
        return response({
          error: rows.length ? "growth_batch_conflict" : "growth_batch_not_found",
        }, rows.length ? 409 : 404);
      }
      const batch = rows[0];
      if (!["ready", "render_authorized"].includes(token(batch?.state))) {
        return response({ error: "growth_batch_not_ready" }, 409);
      }
      const current = await validateCurrentBatch(
        batch,
        planEntity,
        metricEntity,
        sourceEntity,
      );
      if (!current.ok) return response({ error: current.error }, 409);
      return response({
        success: true,
        batch: safeBatch(batch),
        pack_sha256: batch.canonical_pack_sha256,
        render_pack: current.pack,
      });
    }

    if (action === "authorize_batch") {
      const batchKey = exactSha256(body?.batch_key);
      const expectedPackSha256 = exactSha256(body?.expected_pack_sha256);
      const note = compactText(body?.note, 500);
      if (
        !batchKey
        || !expectedPackSha256
        || body?.inspection_acknowledged !== true
        || note.length < 5
      ) {
        return response({ error: "invalid_batch_authorization" }, 400);
      }
      const rows = await exactBatchRows(batchEntity, batchKey);
      if (rows.length !== 1) {
        return response({
          error: rows.length ? "growth_batch_conflict" : "growth_batch_not_found",
        }, rows.length ? 409 : 404);
      }
      const batch = rows[0];
      if (
        !["ready", "render_authorized"].includes(token(batch?.state))
        || exactSha256(batch?.canonical_pack_sha256) !== expectedPackSha256
      ) {
        return response({ error: "growth_batch_pack_mismatch" }, 409);
      }
      const current = await validateCurrentBatch(
        batch,
        planEntity,
        metricEntity,
        sourceEntity,
      );
      if (!current.ok) return response({ error: current.error }, 409);
      if (token(batch?.state) === "render_authorized") {
        if (String(batch?.render_authorization_note || "") !== note) {
          return response({ error: "growth_batch_authorization_conflict" }, 409);
        }
        return response({
          success: true,
          idempotent: true,
          batch: safeBatch(batch),
        });
      }
      const authorizedAt = new Date().toISOString();
      const authorizationHash = await sha256Hex(canonicalStringify({
        batch_key: batchKey,
        pack_sha256: expectedPackSha256,
        inspection_acknowledged: true,
        note,
        authorized_by: String(user?.id || ""),
      }));
      const result = await batchEntity.updateMany(
        {
          id: batch.id,
          state: "ready",
          canonical_pack_sha256: expectedPackSha256,
          ...(batchInputMode(batch) === BATCH_INPUT_BOOTSTRAP
            ? {
              bootstrap_authorization_hash:
                batch.bootstrap_authorization_hash,
            }
            : { review_hash: batch.review_hash }),
        },
        {
          $set: {
            state: "render_authorized",
            render_authorized_by: String(user?.id || "").slice(0, 160),
            render_authorized_at: authorizedAt,
            render_authorization_hash: authorizationHash,
            render_authorization_note: note,
            state_changed_at: authorizedAt,
          },
        },
      );
      if (Number(result?.updated || 0) !== 1) {
        return response({ error: "growth_batch_authorization_contended" }, 409);
      }
      return response({
        success: true,
        idempotent: false,
        batch: safeBatch(await batchEntity.get(batch.id)),
      });
    }

    if (action === "revoke_batch") {
      const batchKey = exactSha256(body?.batch_key);
      const note = compactText(body?.note, 500);
      if (!batchKey || note.length < 5) {
        return response({ error: "invalid_batch_revocation" }, 400);
      }
      const rows = await exactBatchRows(batchEntity, batchKey);
      if (rows.length !== 1) {
        return response({
          error: rows.length ? "growth_batch_conflict" : "growth_batch_not_found",
        }, rows.length ? 409 : 404);
      }
      const batch = rows[0];
      if (token(batch?.state) === "revoked") {
        return response({
          success: true,
          idempotent: true,
          batch: safeBatch(batch),
        });
      }
      if (!["ready", "render_authorized", "failed"].includes(token(batch?.state))) {
        return response({ error: "growth_batch_not_revocable" }, 409);
      }
      if (exactSha256(batch?.canonical_pack_sha256)) {
        const [importedArtifacts, publishJobs] = await Promise.all([
          artifactEntity.filter(
            { render_pack_sha256: batch.canonical_pack_sha256 },
            "-updated_date",
            MAX_RENDER_IMPORT * 3,
          ).then(asArray),
          listAllDependencies(jobEntity, "Growth publish jobs"),
        ]);
        const sentTimes = sentTimeByArtifact(publishJobs);
        if (importedArtifacts.some(
          (artifact) => artifactSentTime(artifact, sentTimes) > 0,
        )) {
          return response({
            error: "growth_batch_published_history_immutable",
            message:
              "A rendition from this measured batch was published, so its cooldown and hook history must remain durable.",
          }, 409);
        }
        if (importedArtifacts.some((artifact) => (
          artifact?.approval_status === "approved"
        ))) {
          return response({
            error: "growth_batch_artifact_revocation_required",
            message:
              "Revoke each approved rendition and its queued delivery before revoking the generated batch.",
          }, 409);
        }
      }
      const revokedAt = new Date().toISOString();
      const result = await batchEntity.updateMany(
        {
          id: batch.id,
          state: batch.state,
          lease_generation: Number(batch?.lease_generation || 0),
        },
        {
          $set: {
            state: "revoked",
            revoked_by: String(user?.id || "").slice(0, 160),
            revoked_at: revokedAt,
            revocation_note: note,
            state_changed_at: revokedAt,
            lease_token: "",
          },
          $unset: { lease_expires_at: true },
        },
      );
      if (Number(result?.updated || 0) !== 1) {
        return response({ error: "growth_batch_revocation_contended" }, 409);
      }
      return response({
        success: true,
        idempotent: false,
        batch: safeBatch(await batchEntity.get(batch.id)),
      });
    }

    if (action === "import_render_result") {
      const mediaOrigin = configuredMediaOrigin();
      const mediaPathPrefix = configuredMediaPathPrefix();
      const allowedPackHashes = configuredRenderPackHashes();
      const allowedRenderEnvironmentHashes =
        configuredRenderEnvironmentHashes();
      const renderResult = body?.render_result;
      const renderPack = renderResult?.pack;
      const rawArtifacts = asArray(renderResult?.artifacts);
      const packArtifacts = asArray(renderPack?.artifacts);
      const packSources = asArray(renderPack?.sources);
      const packSha256 = normalized(renderResult?.pack_sha256);
      const expectedAudioMode = token(renderPack?.output?.audio_mode);
      const expectedAudioRecipe = token(renderPack?.output?.audio_recipe);
      const templateId = token(renderResult?.template?.id);
      const templateVersion = compactText(renderResult?.template?.version, 80);
      const renderProfileId = token(renderResult?.renderer?.profile_id);
      const renderEnvironment = {
        profile_id: renderProfileId,
        renderer_sha256: normalized(renderResult?.renderer?.renderer_sha256),
        bold_font_sha256: normalized(
          renderResult?.renderer?.bold_font_sha256,
        ),
        regular_font_sha256: normalized(
          renderResult?.renderer?.regular_font_sha256,
        ),
        ffmpeg_build_sha256: normalized(
          renderResult?.renderer?.ffmpeg_build_sha256,
        ),
      };
      const renderEnvironmentSha256 = normalized(
        renderResult?.renderer?.environment_sha256,
      );
      const [computedPackSha256, computedRenderEnvironmentSha256] =
        await Promise.all([
          sha256Hex(canonicalStringify(renderPack)),
          sha256Hex(canonicalStringify(renderEnvironment)),
        ]);
      const authorizedBatchResult = await authorizedBatchForPack(
        batchEntity,
        packSha256,
        renderPack,
      );
      if (authorizedBatchResult.error) {
        return response({ error: authorizedBatchResult.error }, 409);
      }
      const authorizedBatch = authorizedBatchResult.batch || null;
      const packIsTrusted = allowedPackHashes.has(packSha256)
        || Boolean(authorizedBatch);
      const packArtifactByKey = new Map(
        packArtifacts.map((artifact) => [token(artifact?.artifact_key), artifact]),
      );
      const packSourceByKey = new Map(
        packSources.map((source) => [token(source?.asset_key), source]),
      );
      if (
        !mediaOrigin
        || !mediaPathPrefix
        || !allowedRenderEnvironmentHashes.size
        || renderResult?.schema_version !== RENDER_RESULT_SCHEMA
        || !token(renderResult?.batch_id)
        || renderPack?.schema_version !== "growth-render-pack.v1"
        || token(renderPack?.batch_id) !== token(renderResult?.batch_id)
        || computedPackSha256 !== packSha256
        || !packIsTrusted
        || !templateId
        || !templateVersion
        || token(renderPack?.template?.id) !== templateId
        || compactText(renderPack?.template?.version, 80) !== templateVersion
        || renderProfileId !== RENDER_PROFILE_ID
        || !AUDIO_MODES.has(expectedAudioMode)
        || (
          expectedAudioMode === "baked_owned_or_licensed"
          && expectedAudioRecipe !== PROCEDURAL_AUDIO_RECIPE
        )
        || (
          expectedAudioMode === "silent"
          && Boolean(expectedAudioRecipe)
        )
        || !/^[a-f0-9]{64}$/.test(renderEnvironmentSha256)
        || !allowedRenderEnvironmentHashes.has(renderEnvironmentSha256)
        || Object.values(renderEnvironment).some((value) => (
          value !== RENDER_PROFILE_ID
          && !/^[a-f0-9]{64}$/.test(value)
        ))
        || computedRenderEnvironmentSha256 !== renderEnvironmentSha256
        || String(renderResult?.media_origin || "") !== mediaOrigin
        || !packArtifacts.length
        || packArtifacts.length > MAX_RENDER_IMPORT
        || packArtifactByKey.size !== packArtifacts.length
        || !packSources.length
        || packSources.length > MAX_SOURCE_BATCH
        || packSourceByKey.size !== packSources.length
        || !rawArtifacts.length
        || rawArtifacts.length > MAX_RENDER_IMPORT
        || Number(renderResult?.artifact_count) !== rawArtifacts.length
        || new Set(rawArtifacts.map((item) => token(item?.artifact_key))).size
          !== rawArtifacts.length
        || rawArtifacts.some((item) => (
          !packArtifactByKey.has(token(item?.artifact_key))
        ))
        || rawArtifacts.some((item) => (
          !["publish_candidate", "sanitized_preview_only"].includes(
            token(item?.distribution_state),
          )
          || (
            token(item?.distribution_state) === "sanitized_preview_only"
            && item?.qc?.ready_for_content_engine_import !== false
          )
        ))
        || (
          authorizedBatch
          && (
            rawArtifacts.length !== packArtifacts.length
            || rawArtifacts.some(
              (item) => token(item?.distribution_state) !== "publish_candidate",
            )
            || packArtifacts.some(
              (item) => token(item?.distribution_state) !== "publish_candidate",
            )
            || [...packArtifactByKey.keys()].some((key) => (
              !rawArtifacts.some((item) => token(item?.artifact_key) === key)
            ))
          )
        )
      ) {
        return response({ error: "invalid_render_result" }, 400);
      }
      const publishCandidates = rawArtifacts.filter(
        (item) => token(item?.distribution_state) === "publish_candidate",
      );
      const previewSkipped = rawArtifacts.length - publishCandidates.length;
      if (!publishCandidates.length) {
        return response({ error: "render_result_has_no_publish_candidates" }, 400);
      }
      const items = await Promise.all(publishCandidates.map(async (item) => {
        const packArtifact = packArtifactByKey.get(token(item?.artifact_key));
        const packSource = packSourceByKey.get(
          token(packArtifact?.source_asset_key),
        );
        if (!packArtifact || !packSource) return null;
        const durationMs = Number(packArtifact?.render?.duration_ms);
        const thumbnailOffsetMs = Math.min(
          Number(renderPack?.output?.thumbnail_offset_ms),
          durationMs - 1,
        );
        const recipe = {
          schema_version: renderPack.schema_version,
          batch_id: renderPack.batch_id,
          template: renderPack.template,
          output: {
            ...renderPack.output,
            duration_ms: durationMs,
            thumbnail_offset_ms: thumbnailOffsetMs,
          },
          renderer: renderEnvironment,
          source: packSource,
          artifact: packArtifact,
        };
        return normalizeRenderImportItem(item, {
          mediaOrigin,
          mediaPathPrefix,
          packSha256,
          templateId,
          templateVersion,
          renderProfileId,
          renderEnvironmentSha256,
          packArtifact,
          packSource,
          expectedAudioMode,
          expectedAudioRecipe,
          expectedRenderInputSha256: await sha256Hex(
            canonicalStringify(recipe),
          ),
        });
      }));
      if (
        items.some((item) => !item)
        || new Set(items.map((item) => item.draft.artifact_key)).size !== items.length
      ) {
        return response({ error: "invalid_render_result_artifact" }, 400);
      }
      const sourceKeys = [...new Set(items.flatMap(
        (item) => item.draft.source_asset_keys,
      ))];
      const sources = await sourcesForArtifact(sourceEntity, sourceKeys);
      const sourceByKey = new Map(
        sources.map((source) => [token(source?.asset_key), source]),
      );
      if (
        !sourcesAreSafe(sources, sourceKeys.length)
        || items.some((item) => item.lineage.some((lineage) => {
          const source = sourceByKey.get(lineage.asset_key);
          return normalized(source?.source_sha256) !== lineage.source_sha256
            || localReference(source?.source_reference)
              !== lineage.source_reference;
        }))
      ) {
        return response({ error: "render_source_lineage_unavailable" }, 409);
      }
      let dynamicProvenance: Map<string, any> | null = null;
      if (authorizedBatch) {
        const latestAuthorizedBatch = await batchEntity.get(authorizedBatch.id);
        if (
          token(latestAuthorizedBatch?.state) !== "render_authorized"
          || exactSha256(latestAuthorizedBatch?.canonical_pack_sha256)
            !== packSha256
        ) {
          return response({ error: "growth_batch_not_authorized" }, 409);
        }
        const currentBatch = await validateCurrentBatch(
          latestAuthorizedBatch,
          planEntity,
          metricEntity,
          sourceEntity,
        );
        if (!currentBatch.ok) {
          return response({ error: currentBatch.error }, 409);
        }
        dynamicProvenance = batchArtifactProvenanceMap(
          latestAuthorizedBatch,
          currentBatch.pack,
        );
        if (!dynamicProvenance) {
          return response({ error: "growth_batch_lineage_conflict" }, 409);
        }
        for (const item of items) {
          const provenance = dynamicProvenance.get(
            token(item?.draft?.artifact_key),
          );
          if (!provenance) {
            return response({ error: "growth_batch_lineage_conflict" }, 409);
          }
          Object.assign(item.draft, provenance);
          Object.assign(item.fields, provenance);
        }
      }
      const artifactKeys = items.map((item) => item.draft.artifact_key);
      const existing = asArray(await artifactEntity.filter(
        { artifact_key: { $in: artifactKeys } },
        "-updated_date",
        artifactKeys.length * 3,
      ));
      const existingByKey = new Map<string, any[]>();
      for (const artifact of existing) {
        const key = token(artifact?.artifact_key);
        if (!existingByKey.has(key)) existingByKey.set(key, []);
        existingByKey.get(key)?.push(artifact);
      }
      if ([...existingByKey.values()].some((rows) => rows.length > 1)) {
        return response({ error: "creative_artifact_conflict" }, 409);
      }
      const planned = items.map((item) => {
        const current = existingByKey.get(item.draft.artifact_key)?.[0] || null;
        const next = current
          ? normalizeDraft(item.fields, current, current?.generation_status)
          : item.draft;
        const provenance = dynamicProvenance?.get(item.draft.artifact_key);
        if (next && provenance) Object.assign(next, provenance);
        return { item, current, next };
      });
      if (
        planned.some(({ item, current, next }) => (
          !next
          || next.artifact_key !== item.draft.artifact_key
          || (
            current?.approval_status === "approved"
            && !renderImportMatches(current, next)
          )
        ))
      ) {
        return response({ error: "approved_artifact_immutable" }, 409);
      }
      let created = 0;
      let updated = 0;
      let idempotent = 0;
      for (const { current, next } of planned) {
        if (current && renderImportMatches(current, next)) {
          idempotent += 1;
          continue;
        }
        if (!current) {
          const saved = await artifactEntity.create(next);
          const reconciled = await reconcileNewRenderArtifact(
            artifactEntity,
            saved,
            next,
          );
          if (reconciled.status === "conflict") {
            return response({ error: "creative_artifact_conflict" }, 409);
          }
          if (reconciled.status === "idempotent") idempotent += 1;
          else created += 1;
          continue;
        }
        const patch = optionalDraftFields(next);
        const result = await artifactEntity.updateMany(
          {
            id: current.id,
            revision: Number(current?.revision || 0),
            approval_status: current.approval_status,
          },
          {
            $set: patch.set,
            $unset: patch.unset,
          },
        );
        if (Number(result?.updated || 0) !== 1) {
          return response({ error: "creative_changed_during_render_import" }, 409);
        }
        updated += 1;
      }
      return response({
        success: true,
        created,
        updated,
        idempotent,
        preview_skipped: previewSkipped,
        imported: created + updated + idempotent,
      });
    }

    if (action === "create_draft") {
      const draft = normalizeDraft(body?.artifact);
      if (!draft) return response({ error: "invalid_content_draft" }, 400);
      const sources = await sourcesForArtifact(sourceEntity, draft.source_asset_keys);
      if (
        sources.length !== draft.source_asset_keys.length
        || sources.some((source) => (
          source?.active === false
          || source?.privacy_change_pending === true
          || source?.privacy_status === "blocked"
        ))
      ) {
        return response({ error: "source_asset_unavailable" }, 409);
      }
      const existing = asArray(await artifactEntity.filter(
        { artifact_key: draft.artifact_key },
        "-updated_date",
        20,
      ));
      if (existing.length > 1) return response({ error: "creative_artifact_conflict" }, 409);
      if (existing.length === 1) {
        if (
          await artifactApprovalHash(existing[0])
          !== await artifactApprovalHash(draft)
        ) {
          return response({ error: "creative_artifact_request_conflict" }, 409);
        }
        return response({
          success: true,
          idempotent: true,
          artifact: existing[0],
        });
      }
      const saved = await artifactEntity.create(draft);
      return response({ success: true, idempotent: false, artifact: saved }, 201);
    }

    if (action === "generate_drafts") {
      if (normalized(Deno.env.get("GROWTH_CONTENT_GENERATION_ENABLED")) !== "true") {
        return response({ error: "content_generation_not_configured" }, 503);
      }
      const conceptId = token(body?.concept_id);
      const campaign = token(body?.campaign, "1000-users");
      const title = compactText(body?.title, 160);
      const pillar = compactText(body?.pillar, 120);
      const direction = compactText(body?.direction, 1000);
      const sourceAssetKeys = cleanTokenList(body?.source_asset_keys);
      const platforms = [...new Set(
        asArray(body?.platforms).map((value) => token(value)).filter((value) => (
          PLATFORMS.has(value)
        )),
      )];
      if (
        !conceptId
        || !title
        || !pillar
        || !direction
        || !sourceAssetKeys.length
        || !platforms.length
      ) {
        return response({ error: "invalid_generation_brief" }, 400);
      }
      const sources = await sourcesForArtifact(sourceEntity, sourceAssetKeys);
      if (
        sources.length !== sourceAssetKeys.length
        || sources.some((source) => (
          source?.active === false
          || source?.privacy_change_pending === true
          || source?.privacy_status === "blocked"
        ))
      ) {
        return response({ error: "source_asset_unavailable" }, 409);
      }
      const desiredKeys = platforms.map(
        (platform) => token(`${platformPrefix(platform)}-${conceptId}`),
      );
      const existing = asArray(await artifactEntity.filter(
        { artifact_key: { $in: desiredKeys } },
        "-updated_date",
        desiredKeys.length * 3,
      ));
      const existingByKey = new Map<string, any[]>();
      for (const artifact of existing) {
        const key = token(artifact?.artifact_key);
        if (!existingByKey.has(key)) existingByKey.set(key, []);
        existingByKey.get(key)?.push(artifact);
      }
      if ([...existingByKey.values()].some((rows) => rows.length > 1)) {
        return response({ error: "creative_artifact_conflict" }, 409);
      }
      if (desiredKeys.every((key) => existingByKey.get(key)?.length === 1)) {
        return response({
          success: true,
          idempotent: true,
          artifacts: desiredKeys.map((key) => existingByKey.get(key)?.[0]),
        });
      }
      if (existingByKey.size) {
        return response({ error: "partial_generation_conflict" }, 409);
      }

      const sourceContext = sources.map((source) => ({
        asset_key: source.asset_key,
        media_kind: source.media_kind,
        privacy_status: source.privacy_status,
        safe_summary: source.safe_summary,
      }));
      const prompt = `You are FirstKnock's social content editor. Create concise, truthful
organic-social draft variants from sanitized product source summaries.

Campaign: ${campaign}
Concept ID: ${conceptId}
Title: ${title}
Pillar: ${pillar}
Creative direction: ${direction}
Platforms: ${platforms.join(", ")}
Sanitized sources: ${JSON.stringify(sourceContext)}

Return exactly one variant for each requested platform. A variant is caption, hook,
4-7 word overlay lines, and a practical shot list; it is not rendered media. Never
invent customer outcomes, performance numbers, names, addresses, emails, account
identifiers, or testimonials. Label demo data in disclosure copy. Use one clear CTA.
TikTok and Instagram copy should feel native but convey the same concept. Keep TikTok
provider text within its 2,200-character limit after disclosure and CTA assembly.`;

      const generated = await base44.integrations.Core.InvokeLLM({
        prompt,
        add_context_from_internet: false,
        response_json_schema: generatorSchema(),
      });
      const variants = asArray(generated?.variants);
      const variantByPlatform = new Map(
        variants.map((variant) => [token(variant?.platform), variant]),
      );
      if (
        platforms.some((platform) => !variantByPlatform.has(platform))
        || variantByPlatform.size !== platforms.length
      ) {
        return response({ error: "invalid_generated_content" }, 502);
      }
      const drafts = platforms.map((platform) => normalizeDraft({
        ...variantByPlatform.get(platform),
        concept_id: conceptId,
        campaign,
        platform,
        platform_content_id: `${platformPrefix(platform)}-${conceptId}`,
        title,
        pillar,
        source_asset_keys: sourceAssetKeys,
        ai_generated: true,
      }, null, "draft_ready"));
      if (drafts.some((draft) => !draft)) {
        return response({ error: "invalid_generated_content" }, 502);
      }
      const saved: any[] = [];
      for (const draft of drafts) saved.push(await artifactEntity.create(draft));
      return response({ success: true, idempotent: false, artifacts: saved }, 201);
    }

    if (action === "update_draft") {
      const current = await uniqueArtifactById(artifactEntity, body?.artifact_id);
      if (!current?.id) return response({ error: "creative_artifact_not_found" }, 404);
      if (current?.approval_status === "approved") {
        return response({ error: "approved_artifact_immutable" }, 409);
      }
      if (current?.render_result_schema) {
        return response({ error: "rendered_artifact_requires_rerender" }, 409);
      }
      const next = normalizeDraft(body?.artifact, current, current?.generation_status);
      if (!next || next.artifact_key !== current.artifact_key) {
        return response({ error: "invalid_content_draft" }, 400);
      }
      const sources = await sourcesForArtifact(sourceEntity, next.source_asset_keys);
      if (
        sources.length !== next.source_asset_keys.length
        || sources.some((source) => (
          source?.active === false
          || source?.privacy_change_pending === true
          || source?.privacy_status === "blocked"
        ))
        || !renderLineageMatchesSources(next, sources)
      ) {
        return response({ error: "source_asset_unavailable" }, 409);
      }
      const patch = optionalDraftFields(next);
      const result = await artifactEntity.updateMany(
        {
          id: current.id,
          revision: Number(current?.revision || 0),
          approval_status: current.approval_status,
        },
        {
          $set: patch.set,
          $unset: patch.unset,
        },
      );
      if (Number(result?.updated || 0) !== 1) {
        return response({ error: "creative_changed_before_save" }, 409);
      }
      const saved = await artifactEntity.get(current.id);
      return response({ success: true, artifact: saved });
    }

    if (action === "review") {
      const current = await uniqueArtifactById(artifactEntity, body?.artifact_id);
      if (!current?.id) return response({ error: "creative_artifact_not_found" }, 404);
      if (current?.approval_status === "approved") {
        return response({ error: "approved_artifact_immutable" }, 409);
      }
      const batchTrust = await artifactBatchTrust(
        current,
        batchEntity,
        planEntity,
        metricEntity,
        sourceEntity,
      );
      if (!batchTrust.ok) {
        return response({ error: batchTrust.error }, 409);
      }
      const checks = {
        privacy_cleared: body?.privacy_cleared === true,
        demo_labeled: body?.demo_labeled === true,
        claims_supported: body?.claims_supported === true,
        media_rights_confirmed: body?.media_rights_confirmed === true,
      };
      const sources = await sourcesForArtifact(
        sourceEntity,
        cleanTokenList(current?.source_asset_keys),
      );
      const passed = Object.values(checks).every(Boolean)
        && sourcesAreSafe(sources, cleanTokenList(current?.source_asset_keys).length)
        && renderLineageMatchesSources(current, sources)
        && artifactMediaReady(current);
      const reviewNote = compactText(body?.note, 1000);
      const result = await artifactEntity.updateMany(
        {
          id: current.id,
          revision: Number(current?.revision || 0),
          approval_status: current.approval_status,
        },
        {
          $set: {
            ...checks,
            review_status: passed ? "passed" : "changes_requested",
            reviewed_by: String(user.id),
            reviewed_at: new Date().toISOString(),
            approval_status: "not_approved",
            ...(reviewNote ? { review_note: reviewNote } : {}),
          },
          $unset: {
            ...(!reviewNote ? { review_note: true } : {}),
            approved_hash: true,
            approved_by: true,
            approved_at: true,
            revoked_at: true,
            revocation_note: true,
          },
        },
      );
      if (Number(result?.updated || 0) !== 1) {
        return response({ error: "creative_changed_before_review" }, 409);
      }
      const saved = await artifactEntity.get(current.id);
      return response({ success: true, passed, artifact: saved });
    }

    if (action === "approve") {
      const current = await uniqueArtifactById(artifactEntity, body?.artifact_id);
      if (!current?.id) return response({ error: "creative_artifact_not_found" }, 404);
      const batchTrust = await artifactBatchTrust(
        current,
        batchEntity,
        planEntity,
        metricEntity,
        sourceEntity,
      );
      if (!batchTrust.ok) {
        return response({ error: batchTrust.error }, 409);
      }
      if (
        current?.review_status !== "passed"
        || current?.privacy_cleared !== true
        || current?.demo_labeled !== true
        || current?.claims_supported !== true
        || current?.media_rights_confirmed !== true
      ) {
        return response({ error: "content_review_required" }, 409);
      }
      const sourceKeys = cleanTokenList(current?.source_asset_keys);
      const sources = await sourcesForArtifact(sourceEntity, sourceKeys);
      if (
        !sourcesAreSafe(sources, sourceKeys.length)
        || !renderLineageMatchesSources(current, sources)
      ) {
        return response({ error: "source_privacy_clearance_required" }, 409);
      }
      if (!artifactMediaReady(current)) {
        return response({ error: "publishable_media_required" }, 409);
      }
      const approvedHash = await artifactApprovalHash(current);
      if (
        current?.approval_status === "approved"
        && current?.approved_hash === approvedHash
      ) {
        return response({
          success: true,
          idempotent: true,
          artifact: current,
        });
      }
      const result = await artifactEntity.updateMany(
        {
          id: current.id,
          revision: Number(current?.revision || 0),
          approval_status: "not_approved",
          review_status: "passed",
          privacy_cleared: true,
          demo_labeled: true,
          claims_supported: true,
          media_rights_confirmed: true,
        },
        {
          $set: {
            approval_status: "approved",
            approved_hash: approvedHash,
            approved_by: String(user.id),
            approved_at: new Date().toISOString(),
          },
          $unset: {
            revoked_at: true,
            revocation_note: true,
          },
        },
      );
      if (Number(result?.updated || 0) !== 1) {
        const latest = await artifactEntity.get(current.id).catch(() => null);
        if (
          latest?.approval_status === "approved"
          && latest?.approved_hash === await artifactApprovalHash(latest)
        ) {
          return response({ success: true, idempotent: true, artifact: latest });
        }
        return response({ error: "creative_changed_before_approval" }, 409);
      }
      const saved = await artifactEntity.get(current.id);
      return response({ success: true, idempotent: false, artifact: saved });
    }

    if (action === "revoke") {
      const current = await uniqueArtifactById(artifactEntity, body?.artifact_id);
      if (!current?.id) return response({ error: "creative_artifact_not_found" }, 404);
      const artifactRows = asArray(await artifactEntity.filter(
        { artifact_key: token(current?.artifact_key) },
        "-updated_date",
        50,
      ));
      if (
        !current?.artifact_key
        || artifactRows.length !== 1
        || artifactRows[0]?.id !== current.id
      ) {
        return response({
          error: "creative_artifact_conflict",
          message:
            "Duplicate creative records must be resolved before approval can be revoked safely.",
        }, 409);
      }
      if (current?.approval_status !== "approved") {
        return response({ success: true, idempotent: true, artifact: current });
      }
      const lockExpiresAt = new Date(current?.schedule_lock_expires_at || 0).getTime();
      if (
        current?.schedule_lock_token
        && (!Number.isFinite(lockExpiresAt) || lockExpiresAt > Date.now())
      ) {
        return response({
          error: "publish_schedule_in_progress",
          message: "Wait for the active scheduling operation to finish before revoking approval.",
        }, 409);
      }
      const allJobs = asArray(await jobEntity.filter(
        {
          platform: current.platform,
          platform_content_id: current.platform_content_id,
        },
        "-created_date",
        100,
      ));
      for (const job of allJobs) {
        if (
          token(job?.state) === SCHEDULE_RESERVATION_STATE
          && !scheduleReservationActive(job)
        ) {
          const expiration = await expireScheduleReservation(
            jobEntity,
            planEntity,
            job,
          ).catch(() => ({
            finalized: false,
            error: "content_plan_unavailable",
          }));
          if (!expiration.finalized) {
            return response({
              error: expiration.error || "provider_cancellation_required",
              message: expiration.repairPending
                ? "The expired scheduling reservation is durably waiting for measurement-plan cancellation."
                : "The expired scheduling reservation could not be fenced safely; retry the revocation.",
            }, 409);
          }
        }
      }
      const refreshedJobs = await Promise.all(
        allJobs.map((job) => jobEntity.get(job.id).catch(() => job)),
      );
      if (refreshedJobs.some((job) => (
        token(job?.state) === SCHEDULE_RESERVATION_STATE
        && !scheduleReservationActive(job)
      ))) {
        return response({
          error: "provider_cancellation_required",
          message:
            "An expired scheduling reservation could not be fenced safely; retry the revocation.",
        }, 409);
      }
      const activeJobs = refreshedJobs.filter(
        (job) => token(job?.state) === SCHEDULE_RESERVATION_STATE
          ? scheduleReservationActive(job)
          : !TERMINAL_JOB_STATES.has(token(job?.state)),
      );
      const unresolvedProviderJobs = refreshedJobs.filter((job) => (
        token(job?.state) !== "sent"
        && job?.provider_post_id
        && !(
          (
            token(job?.state) === "canceled"
            || (
              token(job?.state) === "delivery_reconcile"
              && token(job?.delivery_reconcile_target) === "canceled"
            )
          )
          && token(job?.last_error_code) === "owner_verified_provider_canceled"
        )
      ));
      if (
        unresolvedProviderJobs.length
        || activeJobs.some((job) => (
          !["queued", "retry_wait", "delivery_reconcile"].includes(token(job?.state))
        ))
      ) {
        return response({
          error: "provider_cancellation_required",
          message: "Cancel the live or ambiguous Buffer post before revoking approval.",
        }, 409);
      }
      const revokedAt = new Date().toISOString();
      for (const job of activeJobs) {
        const ownerVerifiedProviderCancellation = Boolean(
          job?.provider_post_id
          && token(job?.state) === "delivery_reconcile"
          && token(job?.delivery_reconcile_target) === "canceled"
          && token(job?.last_error_code) === "owner_verified_provider_canceled",
        );
        const canceled = await jobEntity.updateMany(
          {
            id: job.id,
            state: job.state,
            lease_generation: Number(job?.lease_generation || 0),
          },
          {
            $set: {
              state: "canceled",
              canceled_at: ownerVerifiedProviderCancellation
                ? timestamp(job?.canceled_at) || revokedAt
                : revokedAt,
              ...(ownerVerifiedProviderCancellation
                ? {}
                : {
                  last_error_code: "approval_revoked",
                  last_error_message:
                    "Approval was revoked before provider submission.",
                }),
            },
            $unset: {
              next_retry_at: true,
              delivery_reconcile_target: true,
              lease_source_state: true,
            },
          },
        );
        if (Number(canceled?.updated || 0) !== 1) {
          return response({
            error: "provider_cancellation_required",
            message: "A publish job began processing while approval was being revoked.",
          }, 409);
        }
      }
      const measurementJob = activeJobs[0] || refreshedJobs.find((job) => (
        ["failed", "canceled", "delivery_reconcile"].includes(token(job?.state))
        && (
          !job?.provider_post_id
          || token(job?.last_error_code) === "owner_verified_provider_canceled"
        )
      ));
      let measurementRepairPending = false;
      if (measurementJob) {
        const delivery = await reconcileCanceledMeasurementPlan(
          planEntity,
          jobEntity,
          measurementJob,
        );
        if (!delivery.ok) {
          return response({
            error: delivery.error,
            message: "Delivery was canceled, but its measurement plan needs attention.",
          }, 409);
        }
        measurementRepairPending = delivery.repairPending === true;
      } else if (PLATFORMS.has(token(current?.platform))) {
        const delivery = await setSocialMeasurementDelivery(
          planEntity,
          current,
          "canceled",
        ).catch(() => ({ ok: false, error: "content_plan_unavailable" }));
        if (!delivery.ok) {
          return response({
            error: delivery.error,
            message:
              "Approval remains active because its social measurement plan could not be canceled.",
          }, 409);
        }
      }
      const revoked = await artifactEntity.updateMany(
        {
          id: current.id,
          revision: Number(current?.revision || 0),
          approval_status: "approved",
          approved_hash: current.approved_hash,
          schedule_lock_generation: Number(current?.schedule_lock_generation || 0),
          ...(current?.schedule_lock_token
            ? { schedule_lock_token: current.schedule_lock_token }
            : {}),
          ...(current?.schedule_lock_expires_at
            ? { schedule_lock_expires_at: current.schedule_lock_expires_at }
            : {}),
        },
        {
          $set: {
            approval_status: "revoked",
            revoked_at: revokedAt,
            revocation_note:
              compactText(body?.note, 500) || "Approval revoked by owner.",
          },
        },
      );
      if (Number(revoked?.updated || 0) !== 1) {
        return response({ error: "creative_changed_before_revocation" }, 409);
      }
      const saved = await artifactEntity.get(current.id);
      return response({
        success: true,
        idempotent: false,
        measurement_repair_pending: measurementRepairPending,
        artifact: saved,
      });
    }

    if (action === "schedule") {
      const artifact = await uniqueArtifactById(artifactEntity, body?.artifact_id);
      if (!artifact?.id) return response({ error: "creative_artifact_not_found" }, 404);
      const batchTrust = await artifactBatchTrust(
        artifact,
        batchEntity,
        planEntity,
        metricEntity,
        sourceEntity,
      );
      if (!batchTrust.ok) {
        return response({ error: batchTrust.error }, 409);
      }
      const approvedHash = await artifactApprovalHash(artifact);
      if (
        artifact?.approval_status !== "approved"
        || !artifact?.approved_hash
        || artifact.approved_hash !== approvedHash
        || artifact?.review_status !== "passed"
        || artifact?.privacy_cleared !== true
        || artifact?.demo_labeled !== true
        || artifact?.claims_supported !== true
        || artifact?.media_rights_confirmed !== true
      ) {
        return response({ error: "approved_artifact_required" }, 409);
      }
      const sourceKeys = cleanTokenList(artifact?.source_asset_keys);
      const sources = await sourcesForArtifact(sourceEntity, sourceKeys);
      const sourceLineageSnapshot = immutableSourceLineage(sources, sourceKeys);
      if (
        !sourcesAreSafe(sources, sourceKeys.length)
        || !sourceLineageSnapshot
        || !renderLineageMatchesSources(artifact, sources)
        || !artifactMediaReady(artifact)
      ) {
        return response({ error: "publish_preflight_failed" }, 409);
      }
      const schedulingArtifact = {
        ...artifact,
        source_lineage_snapshot: sourceLineageSnapshot,
      };
      const dueAt = timestamp(body?.due_at);
      const dueMs = dueAt ? new Date(dueAt).getTime() : 0;
      const nowMs = Date.now();
      if (!dueAt) {
        return response({ error: "invalid_publish_schedule" }, 400);
      }
      const schedulingType = token(body?.scheduling_type, "automatic");
      const timezone = compactText(body?.timezone, 80) || "America/Phoenix";
      if (
        !SCHEDULING_TYPES.has(schedulingType)
        || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(timezone)
      ) {
        return response({ error: "invalid_publish_schedule" }, 400);
      }
      if (
        batchTrust.batch
        && (
          timezone !== NEXT_BATCH_TIMEZONE
          || phoenixDateKey(dueMs)
            !== String(batchTrust.batch?.target_date || "")
          || artifact?.growth_batch_target_date
            !== String(batchTrust.batch?.target_date || "")
          || dueAt !== batchSlotDueAt(
            artifact?.growth_batch_target_date,
            artifact?.growth_batch_slot_key,
          )
        )
      ) {
        return response({ error: "growth_batch_schedule_slot_mismatch" }, 409);
      }
      if (isProductionGrowthCampaign(artifact?.campaign)) {
        if (schedulingType !== "automatic") {
          return response({ error: "production_batch_automatic_required" }, 409);
        }
        if (!batchTrust.batch) {
          return response({ error: "production_batch_required" }, 409);
        }
        const productionReadiness = await productionBatchScheduleReadiness(
          artifactEntity,
          sourceEntity,
          batchTrust.batch,
          artifact,
          nowMs,
        );
        if (!productionReadiness.ok) {
          return response({ error: productionReadiness.error }, 409);
        }
      }
      const [
        scheduleBatches,
        scheduleArtifacts,
        scheduleJobs,
      ] = await Promise.all([
        listAllDependencies(batchEntity, "Growth content batches"),
        listAllDependencies(artifactEntity, "Growth creative artifacts"),
        listAllDependencies(jobEntity, "Growth publish jobs"),
      ]);
      const scheduleDate = phoenixDateKey(dueMs);
      const ownBatchKey = exactSha256(batchTrust.batch?.batch_key);
      const sourceReservations = activeBatchReservations(
        scheduleBatches,
        scheduleDate,
        ownBatchKey,
      );
      for (const sourceToken of contentSourceReservations(
        scheduleArtifacts,
        scheduleJobs,
        scheduleDate,
        ownBatchKey,
        schedulingArtifact,
      )) {
        sourceReservations.add(sourceToken);
      }
      if (artifactSourceReservationTokens(schedulingArtifact).some(
        (sourceToken) => sourceReservations.has(sourceToken),
      )) {
        return response({ error: "source_cooldown_conflict" }, 409);
      }
      const scheduleHooks = historicalBatchHooks(
        scheduleArtifacts,
        scheduleBatches,
        scheduleDate,
        ownBatchKey,
        scheduleJobs,
        schedulingArtifact,
      );
      if (scheduleHooks.some(
        (priorHook) => hookSimilarity(artifact?.hook, priorHook) >= 0.75,
      )) {
        return response({ error: "hook_dedupe_conflict" }, 409);
      }
      if (
        token(artifact?.audio_mode) === "silent"
        && schedulingType === "automatic"
        && body?.confirm_silent_automatic !== true
      ) {
        return response({ error: "silent_media_decision_required" }, 409);
      }
      const publishEnvironment = publisherEnvironment();
      if (!publishEnvironment.publisherReady) {
        return response({ error: "publishing_not_configured" }, 503);
      }
      const heartbeat = await recentWorkerHeartbeat(
        heartbeatEntity,
        publishEnvironment,
        nowMs,
      );
      if (!heartbeat.ready) {
        return response({
          error: "publisher_worker_unavailable",
          message:
            "The Buffer worker has not completed a recent authenticated scheduler run.",
        }, 503);
      }
      const providerOrganizationId = publishEnvironment.organizationId;
      const mediaOrigin = publishEnvironment.mediaOrigin;
      const mediaPathPrefix = publishEnvironment.mediaPathPrefix;
      const providerChannelId = artifact.platform === "tiktok"
        ? publishEnvironment.tiktokChannelId
        : publishEnvironment.instagramChannelId;
      if (
        !providerOrganizationId
        || !providerChannelId
        || !mediaOrigin
        || !mediaPathPrefix
        || !mediaUrlUsesNamespace(
          artifact.media_url,
          mediaOrigin,
          mediaPathPrefix,
        )
      ) {
        return response({ error: "publishing_not_configured" }, 503);
      }
      const configRevision = await sha256Hex([
        "buffer",
        providerOrganizationId,
        providerChannelId,
        artifact.platform,
        mediaOrigin,
        mediaPathPrefix,
      ].join("|"));
      const request = {
        provider: "buffer",
        provider_organization_id: providerOrganizationId,
        provider_channel_id: providerChannelId,
        provider_service: artifact.platform,
        config_revision: configRevision,
        media_origin: mediaOrigin,
        media_path_prefix: mediaPathPrefix,
        artifact_id: artifact.id,
        artifact_hash: approvedHash,
        source_lineage_snapshot: sourceLineageSnapshot,
        hook_snapshot: compactText(artifact?.hook, 300),
        render_pack_sha256: exactSha256(artifact?.render_pack_sha256)
          || undefined,
        growth_batch_key: exactSha256(artifact?.growth_batch_key)
          || undefined,
        platform: artifact.platform,
        platform_content_id: artifact.platform_content_id,
        due_at: dueAt,
        scheduling_type: schedulingType,
        timezone,
      };
      const [jobKey, requestHash] = await Promise.all([
        publishJobKey(request),
        publishJobRequestHash(request),
      ]);
      let replaceTerminal = body?.retry_terminal === true;
      let prior = await exactPublishJob(
        jobEntity,
        jobKey,
        requestHash,
        replaceTerminal,
      );
      if (prior.error) return response({ error: prior.error }, 409);
      if (
        prior.job
        && token(prior.job?.state) === SCHEDULE_RESERVATION_STATE
      ) {
        if (scheduleReservationActive(prior.job, nowMs)) {
          return response({ error: "publish_schedule_in_progress" }, 409);
        }
        const expiration = await expireScheduleReservation(
          jobEntity,
          planEntity,
          prior.job,
        ).catch(() => ({
          finalized: false,
          error: "content_plan_unavailable",
        }));
        if (!expiration.finalized) {
          return response({
            error: expiration.error || "publish_schedule_in_progress",
          }, 409);
        }
        replaceTerminal = true;
        prior = await exactPublishJob(
          jobEntity,
          jobKey,
          requestHash,
          true,
        );
        if (prior.error) return response({ error: prior.error }, 409);
      }
      if (prior.job) {
        return response({
          success: true,
          idempotent: true,
          job: safeJob(prior.job),
        });
      }
      if (
        dueMs < nowMs + MIN_SCHEDULE_LEAD_MS
        || dueMs > nowMs + MAX_SCHEDULE_LEAD_MS
      ) {
        return response({ error: "invalid_publish_schedule" }, 400);
      }
      const priorRelated = asArray(await jobEntity.filter(
        {
          provider: "buffer",
          platform: artifact.platform,
          platform_content_id: artifact.platform_content_id,
        },
        "-created_date",
        50,
      )).filter(jobBlocksContentIdReuse);
      if (priorRelated.length) {
        return response({ error: contentIdReuseError(priorRelated) }, 409);
      }
      const lock = await acquireScheduleLock(artifactEntity, artifact, approvedHash);
      if (!lock) {
        const raced = await waitForContendedPublishJob(jobEntity, jobKey, requestHash);
        if (raced.error) return response({ error: raced.error }, 409);
        if (raced.job) {
          if (token(raced.job?.state) === SCHEDULE_RESERVATION_STATE) {
            return response({ error: "publish_schedule_in_progress" }, 409);
          }
          return response({
            success: true,
            idempotent: true,
            job: safeJob(raced.job),
          });
        }
        return response({ error: "publish_schedule_in_progress" }, 409);
      }
      let measurementPlanned = false;
      let measurementCancellationHandled = false;
      let jobPersisted = false;
      let reservation: any = null;
      try {
        const lockedExact = await exactPublishJob(
          jobEntity,
          jobKey,
          requestHash,
          replaceTerminal,
        );
        if (lockedExact.error) return response({ error: lockedExact.error }, 409);
        if (lockedExact.job) {
          if (token(lockedExact.job?.state) === SCHEDULE_RESERVATION_STATE) {
            return response({ error: "publish_schedule_in_progress" }, 409);
          }
          return response({
            success: true,
            idempotent: true,
            job: safeJob(lockedExact.job),
          });
        }
        const related = asArray(await jobEntity.filter(
          {
            provider: "buffer",
            platform: artifact.platform,
            platform_content_id: artifact.platform_content_id,
          },
          "-created_date",
          50,
        )).filter(jobBlocksContentIdReuse);
        if (related.length) {
          return response({ error: contentIdReuseError(related) }, 409);
        }
        if (!await scheduleLockStillOwned(artifactEntity, lock)) {
          return response({ error: "publish_schedule_in_progress" }, 409);
        }
        if (!await renewScheduleLock(artifactEntity, lock)) {
          return response({ error: "publish_schedule_in_progress" }, 409);
        }
        const reservationAcquiredAt = new Date().toISOString();
        const jobFields = {
          job_key: jobKey,
          request_hash: requestHash,
          provider: "buffer",
          provider_organization_id: providerOrganizationId,
          provider_channel_id: providerChannelId,
          provider_service: artifact.platform,
          config_revision: configRevision,
          media_origin: mediaOrigin,
          media_path_prefix: mediaPathPrefix,
          artifact_id: artifact.id,
          artifact_key: artifact.artifact_key,
          artifact_hash: approvedHash,
          source_lineage_snapshot: sourceLineageSnapshot,
          hook_snapshot: compactText(artifact?.hook, 300),
          render_pack_sha256: exactSha256(artifact?.render_pack_sha256)
            || undefined,
          growth_batch_key: exactSha256(artifact?.growth_batch_key)
            || undefined,
          concept_id: artifact.concept_id,
          campaign: artifact.campaign,
          platform: artifact.platform,
          platform_content_id: artifact.platform_content_id,
          due_at: dueAt,
          timezone,
          scheduling_type: schedulingType,
          state: SCHEDULE_RESERVATION_STATE,
          attempt_count: 0,
          reconciliation_count: 0,
          schedule_cutoff_at: new Date(dueMs - SCHEDULE_CUTOFF_MS).toISOString(),
          lease_token: lock.token,
          lease_acquired_at: reservationAcquiredAt,
          lease_expires_at: lock.expiresAt,
        };
        if (lockedExact.terminal) {
          const nextLeaseGeneration =
            Number(lockedExact.terminal?.lease_generation || 0) + 1;
          const retried = await jobEntity.updateMany(
            {
              id: lockedExact.terminal.id,
              state: lockedExact.terminal.state,
              lease_generation: Number(lockedExact.terminal?.lease_generation || 0),
            },
            {
              $set: {
                ...jobFields,
                lease_generation: nextLeaseGeneration,
              },
              $unset: {
                provider_status: true,
                provider_post_id: true,
                provider_due_at: true,
                provider_sent_at: true,
                provider_external_link: true,
                provider_response_hash: true,
                next_retry_at: true,
                delivery_reconcile_target: true,
                lease_source_state: true,
                last_attempt_at: true,
                last_error_code: true,
                last_error_message: true,
                canceled_at: true,
                resolved_by: true,
                resolved_at: true,
                resolution_evidence_note: true,
              },
            },
          );
          if (Number(retried?.updated || 0) !== 1) {
            return response({ error: "publish_job_changed_before_retry" }, 409);
          }
          reservation = await jobEntity.get(lockedExact.terminal.id);
        } else {
          reservation = await jobEntity.create({
            ...jobFields,
            lease_generation: 1,
          });
          if (!reservation?.id) throw new Error("publish_job_not_persisted");
        }
        const [
          reservedBatches,
          reservedArtifacts,
          reservedJobs,
        ] = await Promise.all([
          listAllDependencies(batchEntity, "Growth content batches"),
          listAllDependencies(artifactEntity, "Growth creative artifacts"),
          listAllDependencies(jobEntity, "Growth publish jobs"),
        ]);
        const competingJobs = reservationCompetitorJobs(
          reservedJobs,
          reservation,
        );
        const reservedSources = activeBatchReservations(
          reservedBatches,
          scheduleDate,
          ownBatchKey,
        );
        for (const sourceToken of contentSourceReservations(
          reservedArtifacts,
          competingJobs,
          scheduleDate,
          ownBatchKey,
          schedulingArtifact,
        )) {
          reservedSources.add(sourceToken);
        }
        let reservationConflict = artifactSourceReservationTokens(
          schedulingArtifact,
        ).some((sourceToken) => reservedSources.has(sourceToken))
          ? "source_cooldown_conflict"
          : "";
        if (!reservationConflict) {
          const reservedHooks = historicalBatchHooks(
            reservedArtifacts,
            reservedBatches,
            scheduleDate,
            ownBatchKey,
            competingJobs,
            schedulingArtifact,
          );
          if (reservedHooks.some(
            (priorHook) => hookSimilarity(artifact?.hook, priorHook) >= 0.75,
          )) {
            reservationConflict = "hook_dedupe_conflict";
          }
        }
        if (reservationConflict) {
          await cancelOwnedScheduleReservation(
            jobEntity,
            reservation,
            reservationConflict,
            reservationConflict === "source_cooldown_conflict"
              ? "A current source reservation conflicts with this delivery."
              : "A current hook reservation conflicts with this delivery.",
          );
          return response({ error: reservationConflict }, 409);
        }
        const priorReservationExpiry = reservation.lease_expires_at;
        if (!await renewScheduleLock(artifactEntity, lock)) {
          return response({ error: "publish_schedule_in_progress" }, 409);
        }
        const renewedReservation = await jobEntity.updateMany(
          {
            id: reservation.id,
            state: SCHEDULE_RESERVATION_STATE,
            lease_token: reservation.lease_token,
            lease_generation: Number(reservation?.lease_generation || 0),
            lease_expires_at: priorReservationExpiry,
          },
          { $set: { lease_expires_at: lock.expiresAt } },
        );
        if (Number(renewedReservation?.updated || 0) !== 1) {
          return response({ error: "publish_schedule_in_progress" }, 409);
        }
        reservation.lease_expires_at = lock.expiresAt;
        const measurement = await syncSocialMeasurementPlan(
          planEntity,
          artifact,
          dueAt,
        );
        if (!measurement.ok) {
          return response({ error: measurement.error }, 409);
        }
        measurementPlanned = PLATFORMS.has(token(artifact?.platform));
        if (!await scheduleLockStillOwned(artifactEntity, lock)) {
          return response({ error: "publish_schedule_in_progress" }, 409);
        }
        const queueAt = new Date().toISOString();
        const queued = await jobEntity.updateMany(
          {
            id: reservation.id,
            state: SCHEDULE_RESERVATION_STATE,
            lease_token: reservation.lease_token,
            lease_generation: Number(reservation?.lease_generation || 0),
            $and: [
              { lease_expires_at: reservation.lease_expires_at },
              { lease_expires_at: { $gt: queueAt } },
            ],
          },
          {
            $set: { state: "queued" },
            $unset: {
              lease_token: true,
              lease_acquired_at: true,
              lease_expires_at: true,
            },
          },
        );
        if (Number(queued?.updated || 0) !== 1) {
          return response({ error: "publish_schedule_in_progress" }, 409);
        }
        jobPersisted = true;
        const saved = await jobEntity.get(reservation.id);
        return response({
          success: true,
          idempotent: false,
          retried: Boolean(lockedExact.terminal),
          job: safeJob(saved),
        }, lockedExact.terminal ? 200 : 201);
      } finally {
        try {
          if (reservation?.id && !jobPersisted) {
            const cancellation = await cancelOwnedScheduleReservation(
              jobEntity,
              reservation,
              "schedule_reservation_aborted",
              "The scheduling operation ended before the reservation was queued.",
              measurementPlanned ? planEntity : null,
            ).catch(() => null);
            measurementCancellationHandled = Boolean(
              cancellation?.finalized || cancellation?.repairPending,
            );
          }
          if (
            measurementPlanned
            && !jobPersisted
            && !measurementCancellationHandled
          ) {
            const durable = asArray(await jobEntity.filter(
              { job_key: jobKey },
              "-created_date",
              20,
            )).some((job) => !["failed", "canceled"].includes(token(job?.state)));
            if (!durable) {
              await setSocialMeasurementDelivery(
                planEntity,
                artifact,
                "canceled",
              ).catch(() => null);
            }
          }
        } finally {
          await releaseScheduleLock(artifactEntity, lock);
        }
      }
    }

    if (action === "cancel_job") {
      const jobId = String(body?.job_id || "").trim();
      const current = jobId ? await jobEntity.get(jobId).catch(() => null) : null;
      if (!current?.id) return response({ error: "publish_job_not_found" }, 404);
      if (
        token(current?.state) === "delivery_reconcile"
        && token(current?.delivery_reconcile_target) === "canceled"
      ) {
        return response({
          success: true,
          idempotent: true,
          measurement_repair_pending: true,
          job: safeJob(current),
        }, 202);
      }
      if (current?.state === "canceled") {
        const delivery = await reconcileCanceledMeasurementPlan(
          planEntity,
          jobEntity,
          current,
        );
        if (!delivery.ok) {
          return response({ error: delivery.error, job: safeJob(current) }, 409);
        }
        return response({
          success: true,
          idempotent: true,
          measurement_repair_pending: delivery.repairPending === true,
          job: safeJob(delivery.job || current),
        }, delivery.repairPending ? 202 : 200);
      }
      if (
        current?.provider_post_id
        || !["queued", "retry_wait"].includes(token(current?.state))
      ) {
        return response({ error: "provider_cancellation_required" }, 409);
      }
      const canceledAt = new Date().toISOString();
      const canceled = await jobEntity.updateMany(
        {
          id: current.id,
          state: current.state,
          lease_generation: Number(current?.lease_generation || 0),
        },
        {
          $set: {
            state: "canceled",
            canceled_at: canceledAt,
            last_error_code: "owner_canceled",
            last_error_message: "Canceled before provider submission.",
          },
        },
      );
      if (Number(canceled?.updated || 0) !== 1) {
        const latest = await jobEntity.get(current.id).catch(() => null);
        if (latest?.state === "canceled") {
          const delivery = await reconcileCanceledMeasurementPlan(
            planEntity,
            jobEntity,
            latest,
          );
          if (!delivery.ok) {
            return response({ error: delivery.error, job: safeJob(latest) }, 409);
          }
          return response({
            success: true,
            idempotent: true,
            measurement_repair_pending: delivery.repairPending === true,
            job: safeJob(delivery.job || latest),
          }, delivery.repairPending ? 202 : 200);
        }
        return response({ error: "provider_cancellation_required" }, 409);
      }
      const saved = await jobEntity.get(current.id);
      const delivery = await reconcileCanceledMeasurementPlan(
        planEntity,
        jobEntity,
        saved,
      );
      if (!delivery.ok) {
        return response({
          error: delivery.error,
          job: safeJob(saved),
          message: "Delivery was canceled, but its measurement plan needs attention.",
        }, 409);
      }
      return response({
        success: true,
        idempotent: false,
        measurement_repair_pending: delivery.repairPending === true,
        job: safeJob(delivery.job || saved),
      }, delivery.repairPending ? 202 : 200);
    }

    if (action === "resolve_job") {
      if (body?.provider_cancellation_verified !== true) {
        return response({ error: "provider_resolution_confirmation_required" }, 400);
      }
      const jobId = String(body?.job_id || "").trim();
      const current = jobId ? await jobEntity.get(jobId).catch(() => null) : null;
      if (!current?.id) return response({ error: "publish_job_not_found" }, 404);
      if (
        token(current?.state) === "delivery_reconcile"
        && token(current?.delivery_reconcile_target) === "canceled"
      ) {
        return response({
          success: true,
          idempotent: true,
          measurement_repair_pending: true,
          job: safeJob(current),
        }, 202);
      }
      if (current?.state === "canceled") {
        const delivery = await reconcileCanceledMeasurementPlan(
          planEntity,
          jobEntity,
          current,
        );
        if (!delivery.ok) {
          return response({ error: delivery.error, job: safeJob(current) }, 409);
        }
        return response({
          success: true,
          idempotent: true,
          measurement_repair_pending: delivery.repairPending === true,
          job: safeJob(delivery.job || current),
        }, delivery.repairPending ? 202 : 200);
      }
      if (token(current?.state) !== "review_required") {
        return response({ error: "publish_job_not_reviewable" }, 409);
      }
      if (
        token(current?.provider_status) === "sent"
        || timestamp(current?.provider_sent_at)
      ) {
        return response({ error: "provider_post_already_sent" }, 409);
      }
      const resolvedAt = new Date().toISOString();
      const evidenceNote = compactText(body?.resolution_evidence_note, 500);
      const resolutionFence = {
        id: current.id,
        state: "review_required",
        lease_generation: Number(current?.lease_generation || 0),
        ...(current?.provider_post_id
          ? { provider_post_id: String(current.provider_post_id) }
          : {}),
      };
      const resolved = await jobEntity.updateMany(
        resolutionFence,
        {
          $set: {
            state: "canceled",
            canceled_at: resolvedAt,
            last_error_code: "owner_verified_provider_canceled",
            last_error_message:
              "Owner verified that no live or scheduled Buffer post remains.",
            resolved_by: String(user.id),
            resolved_at: resolvedAt,
            ...(evidenceNote ? { resolution_evidence_note: evidenceNote } : {}),
          },
          ...(!evidenceNote
            ? { $unset: { resolution_evidence_note: true } }
            : {}),
        },
      );
      if (Number(resolved?.updated || 0) !== 1) {
        const latest = await jobEntity.get(current.id).catch(() => null);
        if (latest?.state === "canceled") {
          const delivery = await reconcileCanceledMeasurementPlan(
            planEntity,
            jobEntity,
            latest,
          );
          if (!delivery.ok) {
            return response({ error: delivery.error, job: safeJob(latest) }, 409);
          }
          return response({
            success: true,
            idempotent: true,
            measurement_repair_pending: delivery.repairPending === true,
            job: safeJob(delivery.job || latest),
          }, delivery.repairPending ? 202 : 200);
        }
        return response({ error: "publish_job_changed_before_resolution" }, 409);
      }
      const saved = await jobEntity.get(current.id);
      const delivery = await reconcileCanceledMeasurementPlan(
        planEntity,
        jobEntity,
        saved,
      );
      if (!delivery.ok) {
        return response({
          error: delivery.error,
          job: safeJob(saved),
          message: "Provider resolution was recorded, but its measurement plan needs attention.",
        }, 409);
      }
      return response({
        success: true,
        idempotent: false,
        measurement_repair_pending: delivery.repairPending === true,
        job: safeJob(delivery.job || saved),
      }, delivery.repairPending ? 202 : 200);
    }

    return response({ error: "invalid_content_engine_action" }, 400);
  } catch (error) {
    const status = Number(error?.status || 0);
    if (status === 413) return response({ error: "content_engine_request_too_large" }, 413);
    if (error instanceof SyntaxError) return response({ error: "invalid_json" }, 400);
    console.error("[manageGrowthContentEngine]", safeProviderError(error?.message));
    return response({ error: "content_engine_unavailable" }, 500);
  }
});
