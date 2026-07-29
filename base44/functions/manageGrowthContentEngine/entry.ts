import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import {
  MAX_SOCIAL_POST_TEXT,
  artifactApprovalHash,
  asArray,
  compactText,
  instagramTrackedUrl,
  isContentAddressedMediaUrl,
  isPublicHttpsUrl,
  isStablePublicHttpsUrl,
  normalized,
  publishJobKey,
  publishJobRequestHash,
  safeProviderError,
  sha256Hex,
  socialPostText,
  timestamp,
  token,
} from "../_shared/growthContentEngine.js";

const MAX_BODY_BYTES = 200_000;
const MAX_SOURCE_BATCH = 50;
const MAX_LIST = 500;
const DEPENDENCY_PAGE_SIZE = 1000;
const MAX_DEPENDENCY_RECORDS = 25000;
const PLATFORMS = new Set(["instagram", "tiktok"]);
const FORMATS = new Set(["video", "photo", "carousel"]);
const MEDIA_KINDS = new Set(["video", "image"]);
const PRIVACY_STATES = new Set(["safe", "redaction_required", "blocked"]);
const MIME_TYPES = new Set(["video/mp4", "image/jpeg", "image/png", "image/webp"]);
const SCHEDULING_TYPES = new Set(["automatic", "notification"]);
const TERMINAL_JOB_STATES = new Set(["sent", "failed", "canceled"]);
const MIN_SCHEDULE_LEAD_MS = 15 * 60 * 1000;
const MAX_SCHEDULE_LEAD_MS = 366 * 24 * 60 * 60 * 1000;
const SCHEDULE_CUTOFF_MS = 10 * 60 * 1000;
const SCHEDULE_LOCK_MS = 5 * 60 * 1000;
const SOURCE_PRIVACY_FENCE_MS = 10 * 60 * 1000;
const WORKER_HEARTBEAT_KEY = "buffer-publisher";
const WORKER_HEARTBEAT_MAX_AGE_MS = 3 * 60 * 1000;

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

function mediaUsesOrigin(value: any, origin: string): boolean {
  if (!origin || !isStablePublicHttpsUrl(value)) return false;
  try {
    return new URL(String(value)).origin === origin;
  } catch {
    return false;
  }
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
      ?? (platform === "instagram"
        ? instagramTrackedUrl(campaign, platformContentId)
        : "https://firstknock.online"),
  ).trim().slice(0, 2048);
  const ctaUrl = platform === "instagram"
    ? instagramTrackedUrl(campaign, platformContentId)
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
  const providerText = socialPostText({
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
    || providerText.length > MAX_SOCIAL_POST_TEXT
    || width > 20000
    || height > 20000
    || durationMs > 3600000
    || thumbnailOffsetMs > 3600000
    || (mediaUrl && !isStablePublicHttpsUrl(mediaUrl))
    || (mediaSha256 && !/^[a-f0-9]{64}$/.test(mediaSha256))
    || (mimeType && !MIME_TYPES.has(mimeType))
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

function artifactMediaReady(artifact: any): boolean {
  if (
    !isStablePublicHttpsUrl(artifact?.media_url)
    || !isContentAddressedMediaUrl(artifact?.media_url, artifact?.media_sha256)
    || !/^[a-f0-9]{64}$/.test(normalized(artifact?.media_sha256))
    || !MIME_TYPES.has(normalized(artifact?.mime_type))
    || artifact?.provider_text !== socialPostText(artifact)
    || !artifact?.provider_text
    || artifact.provider_text.length > MAX_SOCIAL_POST_TEXT
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
    && Boolean(mediaOrigin);
  return {
    publishingEnabled,
    hasApiKey,
    hasWorkerSecret,
    organizationId,
    mediaOrigin,
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
  const heartbeat = await recentWorkerHeartbeat(heartbeatEntity, environment);
  const publisherReady = environment.publisherReady && heartbeat.ready;
  const instagramConfigured = Boolean(environment.instagramChannelId);
  const tiktokConfigured = Boolean(environment.tiktokChannelId);
  return {
    can_approve: canApproveGrowth(user),
    can_schedule: canApproveGrowth(user),
    draft_generation_configured:
      normalized(Deno.env.get("GROWTH_CONTENT_GENERATION_ENABLED")) === "true",
    media_rendering: "external_required",
    immutable_media_origin_configured: Boolean(environment.mediaOrigin),
    publishing_environment_ready: environment.publisherReady,
    worker_healthy: heartbeat.ready,
    worker_last_seen_at: heartbeat.observedAt,
    publishing_enabled: publisherReady && (instagramConfigured || tiktokConfigured),
    instagram: {
      delivery: publisherReady && instagramConfigured
        ? "buffer"
        : "not_configured",
      attribution: "configured",
    },
    tiktok: {
      delivery: publisherReady && tiktokConfigured
        ? "buffer"
        : "not_configured",
      attribution: "not_configured",
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

function instagramMeasurementPlan(artifact: any, dueAt: string): any {
  return {
    campaign: artifact.campaign,
    content: artifact.platform_content_id,
    sprint: "content-engine",
    sequence: measurementSequence(artifact.platform_content_id),
    format: artifact.format === "video" ? "reel" : "other",
    audience: "Door-to-door sales teams evaluating FirstKnock",
    hook: artifact.hook,
    script: artifact.provider_text,
    cta_label: artifact.cta_label,
    cta_channel: "caption_url",
    primary_metric: "Instagram activated users",
    hypothesis: `${artifact.pillar} content will convert qualified organic reach into FirstKnock activation.`,
    comparison_group: token(`${artifact.pillar}-${artifact.format}`),
    major_variable: compactText(artifact.hook, 160),
    planned_publish_at: dueAt,
    snapshot_days: 7,
    delivery_managed_by: "buffer",
    delivery_status: "planned",
  };
}

async function setInstagramMeasurementDelivery(
  planEntity: any,
  job: any,
  deliveryStatus: "planned" | "published" | "canceled",
): Promise<{ ok: boolean; error?: string }> {
  if (token(job?.platform) !== "instagram") return { ok: true };
  const rows = asArray(await planEntity.filter(
    {
      campaign: token(job?.campaign, "1000-users"),
      content: token(job?.platform_content_id),
    },
    "-updated_date",
    20,
  ));
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
    token(job?.platform) !== "instagram"
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
  const delivery = await setInstagramMeasurementDelivery(
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

async function syncInstagramMeasurementPlan(
  planEntity: any,
  artifact: any,
  dueAt: string,
): Promise<{ ok: boolean; error?: string }> {
  if (artifact?.platform !== "instagram") return { ok: true };
  const rows = asArray(await planEntity.filter(
    {
      campaign: artifact.campaign,
      content: artifact.platform_content_id,
    },
    "-updated_date",
    20,
  ));
  if (rows.length > 1) return { ok: false, error: "content_plan_conflict" };
  const plan = instagramMeasurementPlan(artifact, dueAt);
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
    const verified = asArray(await planEntity.filter(
      {
        campaign: artifact.campaign,
        content: artifact.platform_content_id,
      },
      "-updated_date",
      20,
    ));
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

function jobBlocksContentIdReuse(job: any): boolean {
  const state = token(job?.state);
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

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") return response({ error: "method_not_allowed" }, 405);

    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) return response({ error: "unauthorized" }, 401);
    if (!canManageGrowth(user)) {
      return response({ error: "growth_admin_required" }, 403);
    }

    const body = await readBody(req);
    const action = token(body?.action);
    if (
      ["approve", "revoke", "schedule", "cancel_job", "resolve_job"].includes(action)
      && !canApproveGrowth(user)
    ) {
      return response({ error: "growth_owner_required" }, 403);
    }

    const sourceEntity = base44.asServiceRole.entities.GrowthSourceAsset;
    const artifactEntity = base44.asServiceRole.entities.GrowthCreativeArtifact;
    const jobEntity = base44.asServiceRole.entities.GrowthPublishJob;
    const heartbeatEntity = base44.asServiceRole.entities.GrowthPublishHeartbeat;
    const planEntity = base44.asServiceRole.entities.GrowthContentPlan;

    if (action === "list") {
      const [sources, artifacts, jobs, capabilities] = await Promise.all([
        sourceEntity.list("-updated_date", MAX_LIST),
        artifactEntity.list("-updated_date", MAX_LIST),
        jobEntity.list("-created_date", MAX_LIST),
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
          (item) => !TERMINAL_JOB_STATES.has(token(item?.state)),
        ).length,
        attention: asArray(jobs).filter(
          (item) => [
            "create_reconcile",
            "delivery_reconcile",
            "review_required",
          ].includes(token(item?.state)),
        ).length,
      };
      return response({
        capabilities,
        summary,
        sources: asArray(sources).map(safeSource),
        artifacts: asArray(artifacts),
        jobs: asArray(jobs).map(safeJob),
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
      const downgrades = sources.filter((source: any) => {
        const current = grouped.get(source.asset_key)?.[0];
        return current?.id && sourceSafetyDowngraded(current, source);
      });
      const downgradeKeys = new Set(
        downgrades.map((source: any) => source.asset_key),
      );
      if (existing.some((source) => sourcePrivacyFenceActive(source))) {
        return response({ error: "source_privacy_change_in_progress" }, 409);
      }
      if (existing.some((source) => (
        source?.privacy_change_pending === true
        && !downgradeKeys.has(token(source?.asset_key))
      ))) {
        return response({
          error: "stale_source_privacy_change_requires_downgrade_retry",
        }, 409);
      }
      const privacyFences: any[] = [];
      if (downgrades.length) {
        try {
          for (const source of downgrades) {
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
              .some((key) => downgradeKeys.has(key))
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
          const blockingJobs = dependentJobs.filter((job) => {
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
                "Cancel or resolve live and ambiguous provider work before downgrading source privacy.",
            }, 409);
          }
          const cancelableJobs = dependentJobs.filter((job) => (
            !durableSentEvidence(job)
            && ["queued", "retry_wait", "delivery_reconcile"].includes(
              token(job?.state),
            )
          ));
          for (const job of cancelableJobs) {
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
                      last_error_code: "source_privacy_downgraded",
                      last_error_message:
                        "A dependent source was blocked before provider submission.",
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
                  "A dependent publish job began processing while source privacy was changing.",
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
          for (const source of downgrades) {
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
        if (downgradeKeys.has(source.asset_key)) continue;
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
TikTok and Instagram copy should feel native but convey the same concept.`;

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
      if (!sourcesAreSafe(sources, sourceKeys.length)) {
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
      const activeJobs = allJobs.filter(
        (job) => !TERMINAL_JOB_STATES.has(token(job?.state)),
      );
      const unresolvedProviderJobs = allJobs.filter((job) => (
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
      const measurementJob = activeJobs[0] || allJobs.find((job) => (
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
      } else if (token(current?.platform) === "instagram") {
        const delivery = await setInstagramMeasurementDelivery(
          planEntity,
          current,
          "canceled",
        ).catch(() => ({ ok: false, error: "content_plan_unavailable" }));
        if (!delivery.ok) {
          return response({
            error: delivery.error,
            message:
              "Approval remains active because its Instagram measurement plan could not be canceled.",
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
      if (!sourcesAreSafe(sources, sourceKeys.length) || !artifactMediaReady(artifact)) {
        return response({ error: "publish_preflight_failed" }, 409);
      }
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
      const providerChannelId = artifact.platform === "tiktok"
        ? publishEnvironment.tiktokChannelId
        : publishEnvironment.instagramChannelId;
      if (
        !providerOrganizationId
        || !providerChannelId
        || !mediaOrigin
        || !mediaUsesOrigin(artifact.media_url, mediaOrigin)
      ) {
        return response({ error: "publishing_not_configured" }, 503);
      }
      const configRevision = await sha256Hex([
        "buffer",
        providerOrganizationId,
        providerChannelId,
        artifact.platform,
        mediaOrigin,
      ].join("|"));
      const request = {
        provider: "buffer",
        provider_organization_id: providerOrganizationId,
        provider_channel_id: providerChannelId,
        provider_service: artifact.platform,
        config_revision: configRevision,
        media_origin: mediaOrigin,
        artifact_id: artifact.id,
        artifact_hash: approvedHash,
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
      const replaceTerminal = body?.retry_terminal === true;
      const prior = await exactPublishJob(
        jobEntity,
        jobKey,
        requestHash,
        replaceTerminal,
      );
      if (prior.error) return response({ error: prior.error }, 409);
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
          return response({
            success: true,
            idempotent: true,
            job: safeJob(raced.job),
          });
        }
        return response({ error: "publish_schedule_in_progress" }, 409);
      }
      let measurementPlanned = false;
      let jobPersisted = false;
      try {
        const lockedExact = await exactPublishJob(
          jobEntity,
          jobKey,
          requestHash,
          replaceTerminal,
        );
        if (lockedExact.error) return response({ error: lockedExact.error }, 409);
        if (lockedExact.job) {
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
        const measurement = await syncInstagramMeasurementPlan(
          planEntity,
          artifact,
          dueAt,
        );
        if (!measurement.ok) {
          return response({ error: measurement.error }, 409);
        }
        measurementPlanned = artifact.platform === "instagram";
        const jobFields = {
          job_key: jobKey,
          request_hash: requestHash,
          provider: "buffer",
          provider_organization_id: providerOrganizationId,
          provider_channel_id: providerChannelId,
          provider_service: artifact.platform,
          config_revision: configRevision,
          media_origin: mediaOrigin,
          artifact_id: artifact.id,
          artifact_key: artifact.artifact_key,
          artifact_hash: approvedHash,
          concept_id: artifact.concept_id,
          campaign: artifact.campaign,
          platform: artifact.platform,
          platform_content_id: artifact.platform_content_id,
          due_at: dueAt,
          timezone,
          scheduling_type: schedulingType,
          state: "queued",
          attempt_count: 0,
          reconciliation_count: 0,
          schedule_cutoff_at: new Date(dueMs - SCHEDULE_CUTOFF_MS).toISOString(),
        };
        if (!await renewScheduleLock(artifactEntity, lock)) {
          await setInstagramMeasurementDelivery(
            planEntity,
            artifact,
            "canceled",
          ).catch(() => null);
          return response({ error: "publish_schedule_in_progress" }, 409);
        }
        let saved: any;
        if (lockedExact.terminal) {
          const retried = await jobEntity.updateMany(
            {
              id: lockedExact.terminal.id,
              state: lockedExact.terminal.state,
              lease_generation: Number(lockedExact.terminal?.lease_generation || 0),
            },
            {
              $set: jobFields,
              $unset: {
                provider_status: true,
                provider_post_id: true,
                provider_due_at: true,
                provider_sent_at: true,
                provider_external_link: true,
                provider_response_hash: true,
                next_retry_at: true,
                delivery_reconcile_target: true,
                lease_token: true,
                lease_source_state: true,
                lease_acquired_at: true,
                lease_expires_at: true,
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
          jobPersisted = true;
          saved = await jobEntity.get(lockedExact.terminal.id);
        } else {
          saved = await jobEntity.create({
            ...jobFields,
            lease_generation: 0,
          });
          jobPersisted = Boolean(saved?.id);
          if (!jobPersisted) throw new Error("publish_job_not_persisted");
        }
        return response({
          success: true,
          idempotent: false,
          retried: Boolean(lockedExact.terminal),
          job: safeJob(saved),
        }, lockedExact.terminal ? 200 : 201);
      } finally {
        try {
          if (measurementPlanned && !jobPersisted) {
            const durable = asArray(await jobEntity.filter(
              { job_key: jobKey },
              "-created_date",
              20,
            )).some((job) => !["failed", "canceled"].includes(token(job?.state)));
            if (!durable) {
              await setInstagramMeasurementDelivery(
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
