import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import {
  artifactApprovalHash,
  asArray,
  canonicalStringify,
  constantTimeEqual,
  isContentAddressedMediaUrl,
  isPublicHttpsUrl,
  isStablePublicHttpsUrl,
  mediaUrlMatchesDeliveryKey,
  mediaUrlUsesNamespace,
  normalized,
  normalizeMediaPathPrefix,
  publishJobRequestHash,
  safeProviderError,
  sha256BytesHex,
  sha256Hex,
  socialPostText,
  socialPostTextLimit,
  timestamp,
  token,
} from "../_shared/growthContentEngine.js";

const BUFFER_API_URL = "https://api.buffer.com";
const PROVIDER_STATUSES = new Set([
  "draft",
  "error",
  "needs_approval",
  "scheduled",
  "sending",
  "sent",
]);
const SOCIAL_PLATFORMS = new Set(["instagram", "tiktok"]);
const MIME_TYPES = new Set(["video/mp4", "image/jpeg", "image/png", "image/webp"]);
const LEASE_MS = 90 * 1000;
const MAX_BATCH = 5;
const MAX_RECONCILIATIONS = 3;
const REQUEST_TIMEOUT_MS = 20 * 1000;
const MEDIA_REQUEST_TIMEOUT_MS = 45 * 1000;
const MAX_MEDIA_BYTES = 250 * 1024 * 1024;
const STATE_SCAN_LIMIT = 100;
const WORKER_HEARTBEAT_KEY = "buffer-publisher";
const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_GRACE_MS = DAY_MS;
const METRIC_RETRY_MS = 2 * 60 * 60 * 1000;
const METRIC_FINAL_READ_TOLERANCE_MS = 10 * 60 * 1000;
const METRIC_CHECKPOINT_DAYS = [1, 3, 7, 30];
const MAX_CONTENT_METRIC = 1_000_000_000;
const CONTENT_FORMATS = new Set([
  "reel",
  "carousel",
  "story",
  "collab",
  "live",
  "other",
]);
const BUFFER_COUNT_METRIC_TYPES = new Set([
  "reach",
  "views",
  "shares",
  "saves",
  "comments",
  "follows",
]);
const BUFFER_METRIC_REQUEST_CODES = new Set([
  "provider_network_error",
  "provider_invalid_response",
  "provider_rate_limited",
  "provider_authorization_failed",
  "provider_server_error",
  "provider_request_rejected",
  "provider_post_missing",
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

function response(data: any, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function workerSecret(req: Request): { configured: string; supplied: string } {
  const configured = String(Deno.env.get("GROWTH_PUBLISH_WORKER_SECRET") || "");
  const authorization = String(req.headers.get("authorization") || "");
  const bearer = authorization.match(/^Bearer ([^\s]+)$/i)?.[1] || "";
  const header = String(req.headers.get("x-growth-publish-worker-secret") || "");
  return { configured, supplied: bearer || header };
}

function configuration(): any | null {
  const apiKey = String(Deno.env.get("BUFFER_API_KEY") || "").trim();
  const organizationId = String(Deno.env.get("BUFFER_ORGANIZATION_ID") || "").trim();
  const instagramChannelId = String(
    Deno.env.get("BUFFER_INSTAGRAM_CHANNEL_ID") || "",
  ).trim();
  const tiktokChannelId = String(
    Deno.env.get("BUFFER_TIKTOK_CHANNEL_ID") || "",
  ).trim();
  const rawMediaOrigin = String(Deno.env.get("GROWTH_MEDIA_ORIGIN") || "").trim();
  const mediaPathPrefix = normalizeMediaPathPrefix(
    Deno.env.get("GROWTH_MEDIA_PATH_PREFIX"),
  );
  let mediaOrigin = "";
  try {
    const url = new URL(rawMediaOrigin);
    if (
      isPublicHttpsUrl(rawMediaOrigin)
      && url.pathname === "/"
      && !url.search
      && !url.hash
      && !url.username
      && !url.password
    ) {
      mediaOrigin = url.origin;
    }
  } catch {
    mediaOrigin = "";
  }
  if (
    !apiKey
    || !organizationId
    || !mediaOrigin
    || !mediaPathPrefix
    || (!instagramChannelId && !tiktokChannelId)
  ) {
    return null;
  }
  return {
    apiKey,
    organizationId,
    instagramChannelId,
    tiktokChannelId,
    mediaOrigin,
    mediaPathPrefix,
  };
}

function channelFor(config: any, platform: string): string {
  return platform === "tiktok" ? config.tiktokChannelId : config.instagramChannelId;
}

async function publisherHeartbeatRevision(config: any): Promise<string> {
  return sha256Hex([
    "buffer-publisher",
    config?.organizationId || "",
    config?.instagramChannelId || "",
    config?.tiktokChannelId || "",
    config?.mediaOrigin || "",
    config?.mediaPathPrefix || "",
  ].join("|"));
}

async function recordWorkerHeartbeat(
  entity: any,
  config: any,
  observedAt: string,
  inspected: number,
  processed: number,
): Promise<boolean> {
  if (!entity?.filter || !entity?.create || !entity?.updateMany) return false;
  const fields = {
    heartbeat_key: WORKER_HEARTBEAT_KEY,
    config_revision: await publisherHeartbeatRevision(config),
    observed_at: observedAt,
    status: "ready",
    last_batch_inspected: Math.max(0, Math.trunc(inspected)),
    last_batch_processed: Math.max(0, Math.trunc(processed)),
  };
  const rows = asArray(await entity.filter(
    { heartbeat_key: WORKER_HEARTBEAT_KEY },
    "-observed_at",
    5,
  ));
  if (!rows[0]?.id) {
    const created = await entity.create({
      ...fields,
      invocation_generation: 1,
    });
    return Boolean(created?.id);
  }
  const updated = await entity.updateMany(
    { id: rows[0].id },
    {
      $set: fields,
      $inc: { invocation_generation: 1 },
    },
  );
  return Number(updated?.updated || 0) === 1;
}

function cleanSecrets(value: any, secrets: string[]): string {
  let output = String(value || "");
  for (const secret of secrets.filter(Boolean)) {
    output = output.split(secret).join("[redacted]");
  }
  return safeProviderError(output);
}

function artifactMediaReady(artifact: any, config: any): boolean {
  if (
    !isStablePublicHttpsUrl(artifact?.media_url)
    || !isContentAddressedMediaUrl(artifact?.media_url, artifact?.media_sha256)
    || !mediaUrlUsesNamespace(
      artifact?.media_url,
      config?.mediaOrigin,
      config?.mediaPathPrefix,
    )
    || (
      artifact?.render_delivery_key
      && !mediaUrlMatchesDeliveryKey(
        artifact?.media_url,
        artifact?.media_sha256,
        artifact?.render_delivery_key,
        config?.mediaOrigin,
        config?.mediaPathPrefix,
      )
    )
    || !/^[a-f0-9]{64}$/.test(normalized(artifact?.media_sha256))
    || !MIME_TYPES.has(normalized(artifact?.mime_type))
    || Number(artifact?.width || 0) < 1
    || Number(artifact?.height || 0) < 1
    || artifact?.provider_text !== socialPostText(artifact)
    || !artifact?.provider_text
    || artifact.provider_text.length > socialPostTextLimit(artifact?.platform)
  ) {
    return false;
  }
  if (artifact?.format === "video") {
    return artifact?.mime_type === "video/mp4" && Number(artifact?.duration_ms || 0) > 0;
  }
  return artifact?.format === "photo"
    && String(artifact?.mime_type || "").startsWith("image/");
}

function metricCheckpointDays(job: any): Set<number> {
  return new Set(
    asArray(job?.metrics_checkpoints)
      .filter((checkpoint) => (
        ["captured", "review_needed"].includes(token(checkpoint?.status))
      ))
      .map((checkpoint) => Number(checkpoint?.snapshot_days || 0))
      .filter((days) => METRIC_CHECKPOINT_DAYS.includes(days)),
  );
}

function inferredNextMetricCheckpointAt(job: any): string {
  const publishedAt = timestamp(
    job?.metrics_published_at || job?.provider_sent_at,
  );
  if (!publishedAt) return "";
  const completed = metricCheckpointDays(job);
  const nextDays = METRIC_CHECKPOINT_DAYS.find((days) => !completed.has(days));
  if (!nextDays) return "";
  return new Date(new Date(publishedAt).getTime() + nextDays * DAY_MS)
    .toISOString();
}

function metricScheduleFields(publishedValue: any): any {
  const publishedAt = timestamp(publishedValue);
  if (!publishedAt) return {};
  return {
    metrics_published_at: publishedAt,
    metrics_next_checkpoint_at: new Date(
      new Date(publishedAt).getTime() + DAY_MS,
    ).toISOString(),
    metrics_checkpoints: [],
    metrics_sync_attempt_count: 0,
  };
}

function dueForProcessing(job: any, nowMs: number): boolean {
  if (job?.state === "sent") {
    if (timestamp(job?.metrics_sync_completed_at)) return false;
    const nextCheckpointMs = new Date(
      job?.metrics_next_checkpoint_at
      || inferredNextMetricCheckpointAt(job)
      || 0,
    ).getTime();
    return Number.isFinite(nextCheckpointMs) && nextCheckpointMs <= nowMs;
  }
  const nextRetryMs = new Date(job?.next_retry_at || 0).getTime();
  if (Number.isFinite(nextRetryMs) && nextRetryMs > nowMs) return false;
  if (job?.state !== "processing") return true;
  const leaseExpiresMs = new Date(job?.lease_expires_at || 0).getTime();
  return !Number.isFinite(leaseExpiresMs) || leaseExpiresMs <= nowMs;
}

async function candidateRows(
  entity: any,
  nowMs: number,
  limit: number,
): Promise<any[]> {
  const scans = [
    ["processing", "lease_expires_at"],
    ["delivery_reconcile", "next_retry_at"],
    ["measurement_retry", "next_retry_at"],
    ["queued", "schedule_cutoff_at"],
    ["retry_wait", "next_retry_at"],
    ["create_reconcile", "next_retry_at"],
    ["sending", "next_retry_at"],
    ["scheduled", "next_retry_at"],
    ["approval_wait", "next_retry_at"],
    ["sent", "metrics_next_checkpoint_at"],
  ];
  const pages = await Promise.all(scans.map(async ([state, sort], priority) => (
    asArray(await entity.filter({ state }, sort, STATE_SCAN_LIMIT))
      .map((job) => ({ job, priority }))
  )));
  return pages
    .flat()
    .filter(({ job }) => dueForProcessing(job, nowMs))
    .sort((left, right) => (
      left.priority - right.priority
      || new Date(
        left.job?.schedule_cutoff_at
        || left.job?.next_retry_at
        || left.job?.metrics_next_checkpoint_at
        || left.job?.lease_expires_at
        || left.job?.created_date
        || 0,
      ).getTime()
        - new Date(
          right.job?.schedule_cutoff_at
          || right.job?.next_retry_at
          || right.job?.metrics_next_checkpoint_at
          || right.job?.lease_expires_at
          || right.job?.created_date
          || 0,
        ).getTime()
    ))
    .slice(0, limit)
    .map(({ job }) => job);
}

async function expiredReservationRows(
  entity: any,
  now: Date,
  limit: number,
): Promise<any[]> {
  if (limit < 1) return [];
  const nowIso = now.toISOString();
  return asArray(await entity.filter(
    {
      state: "reservation_pending",
      lease_expires_at: { $lte: nowIso },
    },
    "lease_expires_at",
    limit,
  )).filter((job) => {
    const expiresAt = timestamp(job?.lease_expires_at);
    return Boolean(expiresAt)
      && new Date(expiresAt || 0).getTime() <= now.getTime();
  });
}

async function sweepExpiredReservation(
  entities: any,
  reservation: any,
  now: Date,
): Promise<string | null> {
  const observedExpiry = timestamp(reservation?.lease_expires_at);
  if (
    !observedExpiry
    || new Date(observedExpiry).getTime() > now.getTime()
  ) {
    return null;
  }
  const observedToken = String(reservation?.lease_token || "");
  const observedGeneration = Number(reservation?.lease_generation || 0);
  const retryAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
  const repairMessage =
    "The scheduler reservation expired before it could be queued. "
    + "Measurement-plan cancellation will retry.";

  // Persist the repair state before touching the measurement plan so a crash
  // cannot leave an untracked planned-delivery record behind.
  const fenced = await entities.GrowthPublishJob.updateMany(
    {
      id: reservation.id,
      state: "reservation_pending",
      lease_token: observedToken,
      lease_generation: observedGeneration,
      lease_expires_at: String(reservation?.lease_expires_at || ""),
    },
    {
      $set: {
        state: "delivery_reconcile",
        delivery_reconcile_target: "canceled",
        next_retry_at: retryAt,
        last_error_code: "schedule_reservation_expired",
        last_error_message: repairMessage,
      },
      $unset: {
        lease_token: true,
        lease_acquired_at: true,
        lease_expires_at: true,
        lease_source_state: true,
      },
    },
  );
  if (Number(fenced?.updated || 0) !== 1) return null;

  const delivery = await cancelPlatformMeasurementDelivery(
    entities,
    reservation,
  ).catch(() => ({ ok: false, error: "content_plan_unavailable" }));
  if (!delivery.ok) return "delivery_reconcile";

  const finalized = await entities.GrowthPublishJob.updateMany(
    {
      id: reservation.id,
      state: "delivery_reconcile",
      lease_generation: observedGeneration,
      next_retry_at: retryAt,
      last_error_code: "schedule_reservation_expired",
    },
    {
      $set: {
        state: "canceled",
        canceled_at: now.toISOString(),
        last_error_message:
          "The scheduler reservation expired before it could be queued.",
      },
      $unset: {
        delivery_reconcile_target: true,
        next_retry_at: true,
      },
    },
  );
  return Number(finalized?.updated || 0) === 1 ? "canceled" : "lease_lost";
}

async function configRevision(job: any): Promise<string> {
  return sha256Hex([
    "buffer",
    String(job?.provider_organization_id || ""),
    String(job?.provider_channel_id || ""),
    token(job?.provider_service),
    String(job?.media_origin || ""),
    String(job?.media_path_prefix || ""),
  ].join("|"));
}

async function fencedUpdate(
  entity: any,
  job: any,
  leaseToken: string,
  leaseGeneration: number,
  fields: any,
): Promise<boolean> {
  const result = await entity.updateMany(
    {
      id: job.id,
      state: "processing",
      lease_token: leaseToken,
      lease_generation: leaseGeneration,
    },
    {
      $set: {
        ...fields,
        lease_token: "",
        lease_expires_at: new Date().toISOString(),
      },
      $unset: {
        lease_source_state: true,
        ...(fields?.next_retry_at === undefined ? { next_retry_at: true } : {}),
        ...(fields?.state !== "delivery_reconcile"
          ? { delivery_reconcile_target: true }
          : {}),
      },
    },
  );
  return Number(result?.updated || 0) === 1;
}

async function renewClaimLease(
  entity: any,
  claim: any,
  now: Date,
): Promise<boolean> {
  const priorExpiry = String(claim.row?.lease_expires_at || "");
  const priorExpiryMs = new Date(priorExpiry || 0).getTime();
  if (!Number.isFinite(priorExpiryMs) || priorExpiryMs <= now.getTime()) {
    return false;
  }
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  const result = await entity.updateMany(
    {
      id: claim.row.id,
      state: "processing",
      lease_token: claim.leaseToken,
      lease_generation: claim.leaseGeneration,
      lease_expires_at: priorExpiry,
    },
    {
      $set: {
        lease_expires_at: leaseExpiresAt,
      },
    },
  );
  if (Number(result?.updated || 0) !== 1) return false;
  claim.row.lease_expires_at = leaseExpiresAt;
  return true;
}

async function claimJob(entity: any, job: any, now: Date): Promise<any | null> {
  const leaseToken = crypto.randomUUID();
  const priorGeneration = Number(job?.lease_generation || 0);
  const increments: any = {
    lease_generation: 1,
  };
  if (!["delivery_reconcile", "sent"].includes(job?.state)) {
    increments.attempt_count = 1;
  }
  if (job?.state === "sent") increments.metrics_sync_attempt_count = 1;
  if (job?.state === "create_reconcile") increments.reconciliation_count = 1;
  const result = await entity.updateMany(
    {
      id: job.id,
      state: job.state,
      lease_generation: priorGeneration,
    },
    {
      $set: {
        state: "processing",
        lease_source_state: token(job?.state),
        lease_token: leaseToken,
        lease_acquired_at: now.toISOString(),
        lease_expires_at: new Date(now.getTime() + LEASE_MS).toISOString(),
        last_attempt_at: now.toISOString(),
      },
      $inc: increments,
    },
  );
  if (Number(result?.updated || 0) !== 1) return null;
  const claimed = await entity.get(job.id).catch(() => null);
  const leaseGeneration = priorGeneration + 1;
  if (
    claimed?.state !== "processing"
    || claimed?.lease_token !== leaseToken
    || Number(claimed?.lease_generation || 0) !== leaseGeneration
  ) {
    return null;
  }
  return {
    row: claimed,
    leaseToken,
    leaseGeneration,
    sourceState: token(job?.state),
  };
}

async function recoverExpiredLease(entity: any, job: any, now: Date): Promise<boolean> {
  const sourceState = token(job?.lease_source_state);
  const deliveryOnly = sourceState === "delivery_reconcile";
  const measurementOnly = sourceState === "measurement_retry";
  const metricsOnly = sourceState === "sent";
  const recoveryState = deliveryOnly
    ? "delivery_reconcile"
    : measurementOnly
      ? "measurement_retry"
      : metricsOnly
        ? "sent"
      : "create_reconcile";
  const result = await entity.updateMany(
    {
      id: job.id,
      state: "processing",
      lease_token: String(job?.lease_token || ""),
      lease_generation: Number(job?.lease_generation || 0),
      lease_expires_at: String(job?.lease_expires_at || ""),
    },
    {
      $set: {
        state: recoveryState,
        next_retry_at: now.toISOString(),
        last_error_code: deliveryOnly || measurementOnly || metricsOnly
          ? token(
            job?.last_error_code,
            deliveryOnly
              ? "delivery_failed"
              : measurementOnly
                ? "content_plan_unavailable"
                : "buffer_metrics_retry",
          )
          : "expired_ambiguous_lease",
        last_error_message: deliveryOnly || measurementOnly || metricsOnly
          ? safeProviderError(
            job?.last_error_message,
            deliveryOnly
              ? "Measurement-plan cancellation will retry."
              : measurementOnly
                ? "The published post's measurement clock will retry."
                : "The published post's metric checkpoint will retry.",
          )
          : "A prior provider attempt ended without a durable result.",
        lease_token: "",
        lease_expires_at: now.toISOString(),
      },
      $unset: { lease_source_state: true },
    },
  );
  return Number(result?.updated || 0) === 1;
}

function nextPollAt(providerStatus: string, dueAt: any, now: Date): string | undefined {
  if (providerStatus === "sent" || providerStatus === "error") return undefined;
  if (providerStatus === "sending") {
    return new Date(now.getTime() + 2 * 60 * 1000).toISOString();
  }
  if (providerStatus === "draft" || providerStatus === "needs_approval") {
    return new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  }
  const dueMs = new Date(dueAt || 0).getTime();
  const sixHours = now.getTime() + 6 * 60 * 60 * 1000;
  const beforeDue = Number.isFinite(dueMs) ? dueMs - 5 * 60 * 1000 : sixHours;
  return new Date(Math.max(now.getTime() + 5 * 60 * 1000, Math.min(sixHours, beforeDue)))
    .toISOString();
}

function providerState(providerStatus: string): string {
  if (providerStatus === "sent") return "sent";
  if (providerStatus === "sending") return "sending";
  if (providerStatus === "scheduled") return "scheduled";
  if (providerStatus === "draft" || providerStatus === "needs_approval") {
    return "approval_wait";
  }
  return "review_required";
}

function postFields(): string {
  return `id channelId channelService status schedulingType dueAt sentAt externalLink text createdAt updatedAt
    assets { source mimeType type }
    error { message supportUrl }`;
}

function createMutation(artifact: any, job: any): string {
  const isVideo = artifact?.format === "video";
  const asset = isVideo
    ? `{video:{url:${JSON.stringify(artifact.media_url)},metadata:{thumbnailOffset:${Number(
      artifact?.thumbnail_offset_ms || 0
    )}}}}`
    : `{image:{url:${JSON.stringify(artifact.media_url)}}}`;
  const metadata = artifact.platform === "instagram"
    ? `{instagram:{type:${isVideo ? "reel" : "post"},shouldShareToFeed:true,isAiGenerated:${artifact?.ai_generated === true}}}`
    : `{tiktok:{isAiGenerated:${artifact?.ai_generated === true}${
      isVideo ? "" : `,title:${JSON.stringify(String(artifact.title || "").slice(0, 150))}`
    }}}`;
  return `mutation {
    createPost(input:{
      text:${JSON.stringify(String(artifact.provider_text || ""))}
      channelId:${JSON.stringify(String(job.provider_channel_id || ""))}
      schedulingType:${job.scheduling_type === "notification" ? "notification" : "automatic"}
      mode:customScheduled
      dueAt:${JSON.stringify(String(job.due_at || ""))}
      aiAssisted:${artifact?.ai_generated === true}
      assets:[${asset}]
      metadata:${metadata}
    }) {
      __typename
      ... on PostActionSuccess { post { ${postFields()} } }
      ... on MutationError { message }
    }
  }`;
}

function postQuery(providerPostId: string): string {
  return `query {
    post(input:{id:${JSON.stringify(providerPostId)}}) {
      ${postFields()}
    }
  }`;
}

function postMetricsQuery(providerPostId: string): string {
  return `query {
    post(input:{id:${JSON.stringify(providerPostId)}}) {
      id
      channelId
      channelService
      status
      sentAt
      metricsUpdatedAt
      metrics {
        type
        name
        value
        unit
      }
    }
  }`;
}

function channelQuery(providerChannelId: string): string {
  return `query {
    channel(input:{id:${JSON.stringify(providerChannelId)}}) {
      id
      organizationId
      service
      isDisconnected
      isLocked
      isQueuePaused
    }
  }`;
}

function reconcileQuery(job: any): string {
  const dueMs = new Date(job?.due_at || 0).getTime();
  const start = new Date(dueMs - 2 * 60 * 1000).toISOString();
  const end = new Date(dueMs + 2 * 60 * 1000).toISOString();
  return `query {
    posts(first:50,input:{
      organizationId:${JSON.stringify(String(job.provider_organization_id || ""))}
      filter:{
        channelIds:[${JSON.stringify(String(job.provider_channel_id || ""))}]
        status:[draft,error,needs_approval,scheduled,sending,sent]
        dueAt:{start:${JSON.stringify(start)},end:${JSON.stringify(end)}}
      }
      sort:[{field:createdAt,direction:desc}]
    }) {
      edges { node { ${postFields()} } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

async function bufferRequest(
  query: string,
  config: any,
  operation: "create" | "read",
): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let providerResponse: Response | null = null;
  let document: any = null;
  try {
    providerResponse = await fetch(BUFFER_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    document = await providerResponse.json();
  } catch {
    return {
      ok: false,
      outcome: operation === "create" ? "ambiguous" : "retry",
      code: providerResponse
        ? "provider_invalid_response"
        : "provider_network_error",
      message: providerResponse
        ? "The provider response body was unreadable or timed out."
        : "The provider request did not return a confirmable response.",
    };
  } finally {
    clearTimeout(timeoutId);
  }
  if (!providerResponse) {
    return {
      ok: false,
      outcome: operation === "create" ? "ambiguous" : "retry",
      code: "provider_network_error",
      message: "The provider request did not return a confirmable response.",
    };
  }

  const retryAfter = Math.max(
    30,
    Math.min(
      4 * 60 * 60,
      Number(providerResponse.headers.get("retry-after") || 30),
    ),
  );
  if (
    operation === "create"
    && document?.data?.createPost?.__typename === "PostActionSuccess"
    && document?.data?.createPost?.post?.id
  ) {
    return { ok: true, document };
  }

  if (providerResponse.status === 429) {
    return {
      ok: false,
      outcome: operation === "create" ? "ambiguous" : "retry",
      retryAfter,
      code: "provider_rate_limited",
      message: "The provider rate limit delayed this request.",
    };
  }
  if (providerResponse.status === 401 || providerResponse.status === 403) {
    return {
      ok: false,
      outcome: "review",
      code: "provider_authorization_failed",
      message: "Buffer authorization or channel access needs review.",
    };
  }
  if (providerResponse.status >= 500) {
    return {
      ok: false,
      outcome: operation === "create" ? "ambiguous" : "retry",
      code: "provider_server_error",
      message: "Buffer did not return a confirmable result.",
    };
  }
  if (!providerResponse.ok) {
    return {
      ok: false,
      outcome: operation === "create" ? "ambiguous" : "review",
      code: operation === "create"
        ? "provider_create_http_unconfirmed"
        : "provider_request_rejected",
      message: operation === "create"
        ? "Buffer did not return a durable create result."
        : "Buffer rejected the provider read request.",
    };
  }

  const topError = asArray(document?.errors)[0];
  if (topError) {
    const code = token(topError?.extensions?.code, "provider_graphql_error");
    if (operation === "create") {
      return {
        ok: false,
        outcome: "ambiguous",
        retryAfter,
        code,
        message: "Buffer did not return a confirmable create result.",
      };
    }
    if (["not-found", "not_found"].includes(code)) {
      return {
        ok: false,
        outcome: "review",
        code: "provider_post_missing",
        message: "The known Buffer post could not be found.",
      };
    }
    if (["rate-limit-exceeded", "rate_limit_exceeded"].includes(code)) {
      return {
        ok: false,
        outcome: "retry",
        retryAfter,
        code: "provider_rate_limited",
        message: "The provider rate limit delayed this request.",
      };
    }
    if (["unauthorized", "forbidden"].includes(code)) {
      return {
        ok: false,
        outcome: "review",
        code: "provider_authorization_failed",
        message: "Buffer authorization or channel access needs review.",
      };
    }
    return {
      ok: false,
      outcome: "retry",
      code,
      message: "Buffer returned a provider error.",
    };
  }
  return { ok: true, document };
}

async function verifyConfiguredChannel(
  job: any,
  config: any,
): Promise<{ ok: boolean; outcome?: string; code?: string; message?: string }> {
  const result = await bufferRequest(
    channelQuery(String(job?.provider_channel_id || "")),
    config,
    "read",
  );
  if (!result.ok) return result;
  const channel = result.document?.data?.channel;
  if (
    String(channel?.id || "") !== String(job?.provider_channel_id || "")
    || String(channel?.organizationId || "")
      !== String(job?.provider_organization_id || "")
    || token(channel?.service) !== token(job?.provider_service)
    || channel?.isDisconnected === true
    || channel?.isLocked === true
  ) {
    return {
      ok: false,
      outcome: "review",
      code: "provider_channel_mismatch",
      message:
        "The configured Buffer channel does not match the approved organization and platform.",
    };
  }
  if (channel?.isQueuePaused === true) {
    return {
      ok: false,
      outcome: "review",
      code: "provider_channel_paused",
      message:
        "The configured Buffer channel queue is paused and cannot publish scheduled posts.",
    };
  }
  return { ok: true };
}

function rowsFromPosts(document: any): { posts: any[]; hasNextPage: boolean } {
  const connection = document?.data?.posts;
  const edges = asArray(connection?.edges);
  const nodes = asArray(connection?.nodes);
  return {
    posts: edges.length ? edges.map((edge) => edge?.node).filter(Boolean) : nodes,
    hasNextPage: connection?.pageInfo?.hasNextPage === true,
  };
}

async function readResponseBytes(
  responseValue: Response,
  maximum: number,
): Promise<{ bytes?: Uint8Array; tooLarge?: boolean }> {
  if (!responseValue.body) {
    const bytes = new Uint8Array(await responseValue.arrayBuffer());
    return bytes.byteLength > maximum ? { tooLarge: true } : { bytes };
  }
  const reader = responseValue.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += chunk.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => null);
      return { tooLarge: true };
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

async function verifyApprovedMediaBytes(
  artifact: any,
  config: any,
): Promise<{ ok: boolean; outcome?: string; code?: string; message?: string }> {
  let mediaUrl: URL;
  try {
    mediaUrl = new URL(String(artifact?.media_url || ""));
  } catch {
    return {
      ok: false,
      outcome: "review",
      code: "media_namespace_mismatch",
      message: "Approved media is not in the configured immutable media namespace.",
    };
  }
  if (!mediaUrlUsesNamespace(
    mediaUrl.href,
    config.mediaOrigin,
    config.mediaPathPrefix,
  )) {
    return {
      ok: false,
      outcome: "review",
      code: "media_namespace_mismatch",
      message: "Approved media is not in the configured immutable media namespace.",
    };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MEDIA_REQUEST_TIMEOUT_MS);
  let mediaResponse: Response;
  try {
    mediaResponse = await fetch(mediaUrl.href, {
      method: "GET",
      headers: { accept: String(artifact?.mime_type || "*/*") },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeoutId);
    return {
      ok: false,
      outcome: "retry",
      code: "media_fetch_unavailable",
      message: "The approved media could not be fetched for byte verification.",
    };
  }
  try {
    if (
      (mediaResponse.status >= 300 && mediaResponse.status < 400)
      || mediaResponse.type === "opaqueredirect"
    ) {
      return {
        ok: false,
        outcome: "review",
        code: "media_redirect_blocked",
        message: "Approved media must not redirect away from its immutable URL.",
      };
    }
    let finalUrl = "";
    try {
      finalUrl = new URL(mediaResponse.url || mediaUrl.href).href;
    } catch {
      finalUrl = "";
    }
    if (!mediaUrlUsesNamespace(
      finalUrl,
      config.mediaOrigin,
      config.mediaPathPrefix,
    )) {
      return {
        ok: false,
        outcome: "review",
        code: "media_redirect_blocked",
        message: "The approved media redirected away from its immutable media namespace.",
      };
    }
    if (!mediaResponse.ok) {
      return {
        ok: false,
        outcome: mediaResponse.status >= 500 ? "retry" : "review",
        code: "media_fetch_rejected",
        message: "The immutable media origin rejected the approved media request.",
      };
    }
    const contentLength = Number(mediaResponse.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BYTES) {
      return {
        ok: false,
        outcome: "review",
        code: "media_too_large",
        message: "The approved media exceeds the worker verification limit.",
      };
    }
    const contentType = normalized(
      String(mediaResponse.headers.get("content-type") || "").split(";")[0],
    );
    if (contentType !== normalized(artifact?.mime_type)) {
      return {
        ok: false,
        outcome: "review",
        code: "media_mime_mismatch",
        message: "The immutable media response type does not match approval.",
      };
    }
    const read = await readResponseBytes(mediaResponse, MAX_MEDIA_BYTES);
    if (read.tooLarge) {
      return {
        ok: false,
        outcome: "review",
        code: "media_too_large",
        message: "The approved media exceeds the worker verification limit.",
      };
    }
    const bytes = read.bytes || new Uint8Array();
    if (!bytes.length) {
      return {
        ok: false,
        outcome: "review",
        code: "media_empty",
        message: "The approved media response was empty.",
      };
    }
    if (await sha256BytesHex(bytes) !== normalized(artifact?.media_sha256)) {
      return {
        ok: false,
        outcome: "review",
        code: "media_hash_mismatch",
        message: "Fetched media bytes do not match the owner-approved SHA-256.",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      outcome: "retry",
      code: "media_fetch_unavailable",
      message: "The approved media could not be read for byte verification.",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function exactPostMatches(post: any, artifact: any, job: any): boolean {
  const expectedDueAt = timestamp(job?.due_at);
  const actualDueAt = timestamp(post?.dueAt);
  const sources = asArray(post?.assets).map((asset) => String(asset?.source || ""));
  return Boolean(post?.id)
    && PROVIDER_STATUSES.has(token(post?.status))
    && String(post?.channelId || "") === String(job?.provider_channel_id || "")
    && token(post?.channelService) === token(job?.provider_service)
    && token(post?.schedulingType) === token(job?.scheduling_type)
    && expectedDueAt === actualDueAt
    && String(post?.text || "") === String(artifact?.provider_text || "")
    && sources.includes(String(artifact?.media_url || ""));
}

function providerFields(post: any, now: Date): any {
  const providerStatus = token(post?.status);
  const state = providerState(providerStatus);
  const providerError = safeProviderError(post?.error?.message, "");
  const externalLink = String(post?.externalLink || "").slice(0, 2048);
  return {
    state,
    provider_status: PROVIDER_STATUSES.has(providerStatus) ? providerStatus : "error",
    provider_scheduling_type: ["automatic", "notification"].includes(
      token(post?.schedulingType),
    )
      ? token(post?.schedulingType)
      : undefined,
    provider_post_id: String(post?.id || "").slice(0, 300),
    provider_due_at: timestamp(post?.dueAt) || undefined,
    provider_sent_at: timestamp(post?.sentAt) || undefined,
    provider_external_link: isPublicHttpsUrl(externalLink)
      ? externalLink
      : undefined,
    next_retry_at: nextPollAt(providerStatus, post?.dueAt, now),
    last_error_code: state === "review_required" ? "provider_post_error" : "",
    last_error_message: state === "review_required"
      ? providerError || "Buffer marked this post as an error."
      : "",
  };
}

async function measurementPlansForPlatform(
  entity: any,
  platform: string,
  campaign: string,
  content: string,
): Promise<any[]> {
  const explicit = asArray(await entity.filter(
    { platform, campaign, content },
    "-updated_date",
    20,
  ));
  if (platform !== "instagram" || explicit.length) return explicit;

  // Platform was added after the original Instagram measurement plans shipped.
  // Keep those rows addressable as Instagram without allowing them to match TikTok.
  const legacy = asArray(await entity.filter(
    { campaign, content },
    "-updated_date",
    20,
  )).filter((plan) => !token(plan?.platform));
  return legacy;
}

async function syncPlatformPublication(
  entities: any,
  artifact: any,
  post: any,
  now: Date,
): Promise<{ ok: boolean; error?: string; publishedAt?: string }> {
  const platform = token(artifact?.platform);
  if (!SOCIAL_PLATFORMS.has(platform) || token(post?.status) !== "sent") {
    return { ok: true };
  }
  const plans = await measurementPlansForPlatform(
    entities.GrowthContentPlan,
    platform,
    token(artifact?.campaign, "1000-users"),
    token(artifact?.platform_content_id),
  );
  if (plans.length !== 1) {
    return { ok: false, error: "content_plan_conflict" };
  }
  const providerSentAt = timestamp(post?.sentAt);
  const authoritativeSentAt = providerSentAt
    && new Date(providerSentAt).getTime() <= now.getTime() + 5 * 60 * 1000
    ? providerSentAt
    : null;
  const existingPublishedAt = timestamp(plans[0]?.published_at);
  if (
    existingPublishedAt
    && plans[0]?.delivery_managed_by === "buffer"
    && plans[0]?.delivery_status === "published"
    && !authoritativeSentAt
  ) {
    return { ok: true, publishedAt: existingPublishedAt };
  }
  const publishedAt = authoritativeSentAt || now.toISOString();
  if (
    existingPublishedAt === publishedAt
    && plans[0]?.delivery_managed_by === "buffer"
    && plans[0]?.delivery_status === "published"
  ) {
    return { ok: true, publishedAt };
  }
  const updated = await entities.GrowthContentPlan.updateMany(
    {
      id: plans[0].id,
      updated_date: plans[0].updated_date,
    },
    {
      $set: {
        published_at: publishedAt,
        delivery_managed_by: "buffer",
        delivery_status: "published",
      },
    },
  );
  if (Number(updated?.updated || 0) !== 1) {
    const latest = await entities.GrowthContentPlan.get(plans[0].id)
      .catch(() => null);
    if (
        timestamp(latest?.published_at) === publishedAt
      && latest?.delivery_managed_by === "buffer"
      && latest?.delivery_status === "published"
      ) {
        return { ok: true, publishedAt };
    }
    return { ok: false, error: "content_plan_changed_before_publish" };
  }
  return { ok: true, publishedAt };
}

async function cancelPlatformMeasurementDelivery(
  entities: any,
  job: any,
): Promise<{ ok: boolean; error?: string }> {
  const platform = token(job?.platform);
  if (!SOCIAL_PLATFORMS.has(platform)) return { ok: true };
  const plans = await measurementPlansForPlatform(
    entities.GrowthContentPlan,
    platform,
    token(job?.campaign, "1000-users"),
    token(job?.platform_content_id),
  );
  if (!plans.length) return { ok: true };
  if (plans.length !== 1) return { ok: false, error: "content_plan_conflict" };
  const current = plans[0];
  if (
    timestamp(current?.published_at)
    || current?.delivery_status === "published"
  ) {
    return { ok: false, error: "content_plan_already_published" };
  }
  if (
    current?.delivery_managed_by === "buffer"
    && current?.delivery_status === "canceled"
  ) {
    return { ok: true };
  }
  const updated = await entities.GrowthContentPlan.updateMany(
    {
      id: current.id,
      updated_date: current.updated_date,
    },
    {
      $set: {
        delivery_managed_by: "buffer",
        delivery_status: "canceled",
      },
    },
  );
  if (Number(updated?.updated || 0) === 1) return { ok: true };
  const latest = await entities.GrowthContentPlan.get(current.id).catch(() => null);
  return latest?.delivery_managed_by === "buffer"
      && latest?.delivery_status === "canceled"
    ? { ok: true }
    : { ok: false, error: "content_plan_changed_before_cancel" };
}

async function measurementAwareFields(
  entities: any,
  artifact: any,
  post: any,
  now: Date,
): Promise<any> {
  const fields = providerFields(post, now);
  if (fields.state !== "sent") return fields;
  const measurement = await syncPlatformPublication(
    entities,
    artifact,
    post,
    now,
  ).catch(() => ({ ok: false, error: "content_plan_unavailable" }));
  if (measurement.ok) {
    return {
      ...fields,
      ...metricScheduleFields(measurement.publishedAt || fields.provider_sent_at),
    };
  }
  return {
    ...fields,
    state: "measurement_retry",
    next_retry_at: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
    last_error_code: measurement.error || "content_plan_unavailable",
    last_error_message:
      "Buffer published the post, but its platform measurement clock could not be started.",
  };
}

type SourceReadinessState =
  | "safe"
  | "unsafe"
  | "lineage_changed"
  | "lineage_missing"
  | "unavailable";

function opaqueSourceReference(value: any): string {
  const reference = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,299}$/.test(reference)
    ? reference
    : "";
}

function lineageMatchesSources(
  lineageValue: any,
  sourceKeys: string[],
  groupedSources: Map<string, any[]>,
): boolean {
  const lineage = asArray(lineageValue);
  if (
    lineage.length !== sourceKeys.length
    || new Set(sourceKeys).size !== sourceKeys.length
  ) {
    return false;
  }
  return lineage.every((item, index) => {
    const assetKey = token(item?.asset_key);
    const sources = groupedSources.get(assetKey) || [];
    const source = sources[0];
    const lineageReference = opaqueSourceReference(item?.source_reference);
    const sourceReference = opaqueSourceReference(source?.source_reference);
    const lineageSha256 = normalized(item?.source_sha256);
    const sourceSha256 = normalized(source?.source_sha256);
    return assetKey === sourceKeys[index]
      && sources.length === 1
      && Boolean(lineageReference)
      && lineageReference === sourceReference
      && /^[a-f0-9]{64}$/.test(lineageSha256)
      && lineageSha256 === sourceSha256;
  });
}

async function sourceReadinessState(
  entities: any,
  artifact: any,
  job: any,
): Promise<SourceReadinessState> {
  try {
    const sourceKeys = asArray(artifact?.source_asset_keys)
      .map((value) => token(value))
      .filter(Boolean);
    if (!sourceKeys.length) return "unsafe";
    const sources = asArray(await entities.GrowthSourceAsset.filter(
      { asset_key: { $in: sourceKeys } },
      "-updated_date",
      Math.max(20, sourceKeys.length * 3),
    ));
    const grouped = new Map<string, any[]>();
    for (const source of sources) {
      const key = token(source?.asset_key);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)?.push(source);
    }
    const unsafe = sourceKeys.some((key) => {
      const rows = grouped.get(key) || [];
      return rows.length !== 1
        || rows[0]?.active === false
        || rows[0]?.privacy_change_pending === true
        || token(rows[0]?.privacy_status) !== "safe";
    });
    if (unsafe) return "unsafe";
    const jobSnapshot = asArray(job?.source_lineage_snapshot);
    if (jobSnapshot.length) {
      if (!lineageMatchesSources(jobSnapshot, sourceKeys, grouped)) {
        return "lineage_changed";
      }
      if (
        artifact?.render_result_schema
        && !lineageMatchesSources(
          artifact?.render_source_lineage,
          sourceKeys,
          grouped,
        )
      ) {
        return "lineage_changed";
      }
      return "safe";
    }
    if (!artifact?.render_result_schema) return "lineage_missing";
    return lineageMatchesSources(
      artifact?.render_source_lineage,
      sourceKeys,
      grouped,
    )
      ? "safe"
      : "lineage_changed";
  } catch {
    return "unavailable";
  }
}

async function preflight(
  entities: any,
  job: any,
  config: any,
): Promise<{ artifact?: any; error?: string; outcome?: string }> {
  if (
    job?.provider !== "buffer"
    || !["instagram", "tiktok"].includes(token(job?.platform))
    || job?.provider_service !== job?.platform
    || String(job?.provider_organization_id || "") !== config.organizationId
    || String(job?.provider_channel_id || "") !== channelFor(config, job.platform)
    || String(job?.media_origin || "") !== config.mediaOrigin
    || String(job?.media_path_prefix || "") !== config.mediaPathPrefix
    || await configRevision(job) !== job?.config_revision
    || await publishJobRequestHash(job) !== job?.request_hash
  ) {
    return { error: "publish_job_configuration_changed" };
  }
  const artifact = await entities.GrowthCreativeArtifact.get(job.artifact_id)
    .catch(() => null);
  if (!artifact?.id) return { error: "creative_artifact_not_found" };
  if (!mediaUrlUsesNamespace(
    artifact?.media_url,
    config.mediaOrigin,
    config.mediaPathPrefix,
  )) {
    return { error: "media_namespace_mismatch" };
  }
  const approvalHash = await artifactApprovalHash(artifact);
  if (
    artifact?.approval_status !== "approved"
    || artifact?.approved_hash !== approvalHash
    || approvalHash !== job?.artifact_hash
    || artifact?.artifact_key !== job?.artifact_key
    || artifact?.platform !== job?.platform
    || artifact?.platform_content_id !== job?.platform_content_id
    || artifact?.review_status !== "passed"
    || artifact?.privacy_cleared !== true
    || artifact?.demo_labeled !== true
    || artifact?.claims_supported !== true
    || artifact?.media_rights_confirmed !== true
    || !artifactMediaReady(artifact, config)
  ) {
    return { error: "artifact_approval_changed" };
  }
  const sourceState = await sourceReadinessState(entities, artifact, job);
  if (sourceState === "unavailable") {
    return {
      error: "source_privacy_clearance_unavailable",
      outcome: "retry",
    };
  }
  if (sourceState === "lineage_changed") {
    return { error: "source_render_lineage_changed" };
  }
  if (sourceState === "lineage_missing") {
    return { error: "source_lineage_snapshot_missing" };
  }
  if (sourceState !== "safe") {
    return { error: "source_privacy_clearance_changed" };
  }
  return { artifact };
}

async function finishFailure(
  entities: any,
  job: any,
  claim: any,
  outcome: any,
  now: Date,
  secrets: string[],
): Promise<string> {
  const message = cleanSecrets(outcome?.message, secrets);
  let state = job?.provider_post_id || Number(job?.reconciliation_count || 0) > 0
    ? "review_required"
    : "failed";
  let nextRetryAt: string | undefined;
  if (outcome?.outcome === "ambiguous") {
    state = "create_reconcile";
    nextRetryAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
  } else if (outcome?.outcome === "reconcile_retry") {
    state = "create_reconcile";
    const seconds = Math.max(30, Number(outcome?.retryAfter || 120));
    nextRetryAt = new Date(now.getTime() + seconds * 1000).toISOString();
  } else if (outcome?.outcome === "retry") {
    state = claim?.sourceState === "measurement_retry"
      ? "measurement_retry"
      : claim?.sourceState === "create_reconcile"
      ? "create_reconcile"
      : job?.provider_post_id
      ? providerState(token(job?.provider_status, "scheduled"))
      : "retry_wait";
    const seconds = Math.max(30, Number(outcome?.retryAfter || 120));
    nextRetryAt = new Date(now.getTime() + seconds * 1000).toISOString();
  }
  if (state === "failed") {
    const delivery = await cancelPlatformMeasurementDelivery(entities, job)
      .catch(() => ({ ok: false, error: "content_plan_unavailable" }));
    if (!delivery.ok) {
      state = "delivery_reconcile";
      nextRetryAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
    }
  }
  const saved = await fencedUpdate(
    entities.GrowthPublishJob,
    claim.row,
    claim.leaseToken,
    claim.leaseGeneration,
    {
      state,
      next_retry_at: nextRetryAt,
      delivery_reconcile_target: state === "delivery_reconcile"
        ? "failed"
        : undefined,
      last_error_code: token(outcome?.code, "provider_request_failed"),
      last_error_message: state === "delivery_reconcile"
        ? `${message} Measurement-plan cancellation will retry.`.slice(0, 240)
        : message.replace(/\s*Measurement-plan cancellation will retry\.$/, ""),
    },
  );
  return saved ? state : "lease_lost";
}

async function processDeliveryReconcile(
  entities: any,
  claim: any,
  now: Date,
  secrets: string[],
): Promise<string> {
  const delivery = await cancelPlatformMeasurementDelivery(entities, claim.row)
    .catch(() => ({ ok: false, error: "content_plan_unavailable" }));
  const baseMessage = cleanSecrets(
    claim.row?.last_error_message || "Delivery failed before provider submission.",
    secrets,
  ).replace(/\s*Measurement-plan cancellation will retry\.$/, "");
  const targetState = token(claim.row?.delivery_reconcile_target) === "canceled"
    ? "canceled"
    : "failed";
  const state = delivery.ok ? targetState : "delivery_reconcile";
  const saved = await fencedUpdate(
    entities.GrowthPublishJob,
    claim.row,
    claim.leaseToken,
    claim.leaseGeneration,
    {
      state,
      delivery_reconcile_target: delivery.ok ? undefined : targetState,
      next_retry_at: delivery.ok
        ? undefined
        : new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
      last_error_code: token(claim.row?.last_error_code, "delivery_failed"),
      last_error_message: delivery.ok
        ? baseMessage
        : `${baseMessage} Measurement-plan cancellation will retry.`.slice(0, 240),
    },
  );
  return saved ? state : "lease_lost";
}

async function processMeasurementRetry(
  entities: any,
  claim: any,
  now: Date,
  secrets: string[],
): Promise<string> {
  const job = claim.row;
  if (
    !job?.provider_post_id
    || token(job?.provider_status) !== "sent"
  ) {
    return finishFailure(
      entities,
      job,
      claim,
      {
        outcome: "review",
        code: "published_measurement_evidence_missing",
        message:
          "The measurement repair no longer has durable evidence of a published provider post.",
      },
      now,
      secrets,
    );
  }
  const sentAt = timestamp(job?.provider_sent_at) || undefined;
  const measurement = await syncPlatformPublication(
    entities,
    job,
    {
      id: job.provider_post_id,
      status: "sent",
      sentAt,
    },
    now,
  ).catch(() => ({ ok: false, error: "content_plan_unavailable" }));
  const fields = measurement.ok
    ? {
      state: "sent",
      provider_status: "sent",
      ...(sentAt ? { provider_sent_at: sentAt } : {}),
      ...metricScheduleFields(measurement.publishedAt || sentAt),
      next_retry_at: undefined,
      last_error_code: "",
      last_error_message: "",
    }
    : {
      state: "measurement_retry",
      next_retry_at: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
      last_error_code: measurement.error || "content_plan_unavailable",
      last_error_message:
        "Buffer published the post, but its platform measurement clock could not be started.",
    };
  const saved = await fencedUpdate(
    entities.GrowthPublishJob,
    job,
    claim.leaseToken,
    claim.leaseGeneration,
    fields,
  );
  return saved ? fields.state : "lease_lost";
}

function contentMetricPlatform(metric: any): string {
  const platform = token(metric?.platform);
  return SOCIAL_PLATFORMS.has(platform) ? platform : "instagram";
}

function contentMetricObservedFields(metric: any): string[] | null {
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

function contentMetricSnapshotPayload(metric: any): string {
  // This intentionally matches upsertGrowthContentMetric's historical
  // fingerprint byte-for-byte when observation metadata is absent. Platform
  // remains part of the lookup key.
  const payload: any = {
    campaign: token(metric?.campaign, "1000-users"),
    content: token(metric?.content),
    snapshot_days: Number(metric?.snapshot_days || 7),
    snapshot_captured_at: timestamp(metric?.snapshot_captured_at) || "",
    published_at: timestamp(metric?.published_at) || "",
  };
  for (const field of CONTENT_METRIC_FIELDS) {
    payload[field] = Math.max(0, Number(metric?.[field] || 0));
  }
  const observedFields = contentMetricObservedFields(metric);
  if (observedFields) payload.observed_fields = observedFields;
  return JSON.stringify(payload);
}

async function contentMetricFingerprint(metric: any): Promise<string> {
  return sha256Hex(contentMetricSnapshotPayload(metric));
}

function hasOwn(value: any, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function compactMetricText(value: any, max: number): string {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function automatedMetricDimensions(
  job: any,
  format: string,
  ctaVariant: string,
): any {
  const growthBatchKey = normalized(job?.growth_batch_key);
  return {
    format: CONTENT_FORMATS.has(token(format)) ? token(format) : "other",
    hook: compactMetricText(job?.hook_snapshot, 300),
    cta_variant: compactMetricText(ctaVariant, 120),
    artifact_key: String(job?.artifact_key || "").slice(0, 120),
    concept_id: String(job?.concept_id || "").slice(0, 120),
    ...(/^[a-f0-9]{64}$/.test(growthBatchKey)
      ? { growth_batch_key: growthBatchKey }
      : {}),
  };
}

function normalizedBufferCountMetrics(post: any): {
  ok: boolean;
  code?: string;
  values?: Record<string, number>;
  observedTypes?: string[];
} {
  const values: Record<string, number> = {};
  const seen = new Map<string, number>();
  for (const metric of asArray(post?.metrics)) {
    const type = token(metric?.type);
    if (!BUFFER_COUNT_METRIC_TYPES.has(type)) continue;
    if (token(metric?.unit) !== "count") {
      return { ok: false, code: "buffer_metrics_invalid_count_unit" };
    }
    const value = Number(metric?.value);
    if (
      !Number.isSafeInteger(value)
      || value < 0
      || value > MAX_CONTENT_METRIC
    ) {
      return { ok: false, code: "buffer_metrics_invalid_count_value" };
    }
    if (seen.has(type) && seen.get(type) !== value) {
      return { ok: false, code: "buffer_metrics_conflicting_count" };
    }
    seen.set(type, value);
    values[type] = value;
  }
  if (!seen.size) return { ok: false, code: "buffer_metrics_unavailable" };
  if (!seen.has("reach") && !seen.has("views")) {
    return { ok: false, code: "buffer_metrics_exposure_unavailable" };
  }
  return {
    ok: true,
    values,
    observedTypes: [...seen.keys()].sort(),
  };
}

function bufferMetricRequestErrorCode(value: any): string {
  const code = token(value);
  return BUFFER_METRIC_REQUEST_CODES.has(code)
    ? code
    : "buffer_metrics_provider_error";
}

async function normalizedProviderMetricsHash(
  job: any,
  metricsUpdatedAt: string,
  values: Record<string, number>,
  observedTypes: string[],
): Promise<string> {
  return sha256Hex(canonicalStringify({
    provider: "buffer",
    provider_post_id: String(job?.provider_post_id || ""),
    provider_channel_id: String(job?.provider_channel_id || ""),
    provider_channel_service: token(job?.provider_service),
    metrics_updated_at: metricsUpdatedAt,
    observed_metric_types: observedTypes,
    metrics: values,
  }));
}

async function exactAutomatedMetricCheckpoint(
  metric: any,
  job: any,
  checkpoint: {
    days: number;
    dueAt: string;
    closeAt: string;
    dueMs: number;
    closeMs: number;
  },
  publishedAt: string,
  format: string,
  ctaVariant: string,
  observedAt: Date,
): Promise<{
  ok: boolean;
  metric?: any;
  providerMetricsUpdatedAt?: string;
  providerMetricsHash?: string;
}> {
  const platform = token(job?.platform);
  const campaign = token(job?.campaign, "1000-users");
  const content = token(job?.platform_content_id);
  const window = checkpointTimes(publishedAt, checkpoint.days);
  if (
    !metric?.id
    || job?.provider !== "buffer"
    || !SOCIAL_PLATFORMS.has(platform)
    || !campaign
    || !content
    || token(job?.provider_service) !== platform
    || !String(job?.provider_organization_id || "")
    || timestamp(job?.provider_sent_at) !== publishedAt
    || timestamp(job?.metrics_published_at) !== publishedAt
    || await configRevision(job) !== job?.config_revision
    || await publishJobRequestHash(job) !== job?.request_hash
    || checkpoint.dueAt !== window.dueAt
    || checkpoint.closeAt !== window.closeAt
    || checkpoint.dueMs !== window.dueMs
    || checkpoint.closeMs !== window.closeMs
    || metric.platform !== platform
    || metric.campaign !== campaign
    || metric.content !== content
    || metric.snapshot_days !== checkpoint.days
    || metric.metric_source !== "buffer"
    || hasOwn(metric, "observed_metric_fields")
    || String(metric.provider_post_id || "")
      !== String(job?.provider_post_id || "").slice(0, 300)
    || String(metric.provider_channel_id || "")
      !== String(job?.provider_channel_id || "").slice(0, 300)
  ) {
    return { ok: false };
  }

  const dimensions = automatedMetricDimensions(job, format, ctaVariant);
  for (const field of [
    "format",
    "hook",
    "cta_variant",
    "artifact_key",
    "concept_id",
  ]) {
    if (!hasOwn(metric, field) || metric[field] !== dimensions[field]) {
      return { ok: false };
    }
  }
  const expectsGrowthBatchKey = hasOwn(dimensions, "growth_batch_key");
  if (
    hasOwn(metric, "growth_batch_key") !== expectsGrowthBatchKey
    || (
      expectsGrowthBatchKey
      && metric.growth_batch_key !== dimensions.growth_batch_key
    )
  ) {
    return { ok: false };
  }

  const metricPublishedAt = timestamp(metric?.published_at);
  const capturedAt = timestamp(metric?.snapshot_captured_at);
  const metricsUpdatedAt = timestamp(metric?.provider_metrics_updated_at);
  const capturedMs = new Date(capturedAt || 0).getTime();
  if (
    !metricPublishedAt
    || metricPublishedAt !== publishedAt
    || String(metric.published_at || "") !== metricPublishedAt
    || !capturedAt
    || String(metric.snapshot_captured_at || "") !== capturedAt
    || !metricsUpdatedAt
    || String(metric.provider_metrics_updated_at || "") !== metricsUpdatedAt
    || capturedAt !== metricsUpdatedAt
    || capturedMs < checkpoint.dueMs
    || capturedMs > checkpoint.closeMs
    || capturedMs > observedAt.getTime() + 5 * 60 * 1000
  ) {
    return { ok: false };
  }

  if (
    !hasOwn(metric, "provider_observed_metric_types")
    || !Array.isArray(metric.provider_observed_metric_types)
  ) {
    return { ok: false };
  }
  const observedTypes = metric.provider_observed_metric_types;
  if (observedTypes.length < 1 || observedTypes.length > BUFFER_COUNT_METRIC_TYPES.size) {
    return { ok: false };
  }
  const canonicalObservedTypes = observedTypes.map((value: any) => token(value));
  const sortedObservedTypes = [...canonicalObservedTypes].sort();
  if (
    observedTypes.some(
      (value: any, index: number) => value !== canonicalObservedTypes[index],
    )
    || canonicalStringify(canonicalObservedTypes)
      !== canonicalStringify(sortedObservedTypes)
    || new Set(canonicalObservedTypes).size !== canonicalObservedTypes.length
    || canonicalObservedTypes.some(
      (value: string) => !BUFFER_COUNT_METRIC_TYPES.has(value),
    )
    || (
      !canonicalObservedTypes.includes("reach")
      && !canonicalObservedTypes.includes("views")
    )
  ) {
    return { ok: false };
  }

  const observedSet = new Set(canonicalObservedTypes);
  const values: Record<string, number> = {};
  for (const field of CONTENT_METRIC_FIELDS) {
    const expectedField = observedSet.has(field);
    if (hasOwn(metric, field) !== expectedField) {
      return { ok: false };
    }
    if (!expectedField) continue;
    const value = metric[field];
    if (
      typeof value !== "number"
      || !Number.isSafeInteger(value)
      || value < 0
      || value > MAX_CONTENT_METRIC
    ) {
      return { ok: false };
    }
    values[field] = value;
  }

  const storedProviderHash = String(metric?.provider_metrics_hash || "");
  if (
    !/^[a-f0-9]{64}$/.test(storedProviderHash)
    || storedProviderHash !== await normalizedProviderMetricsHash(
      job,
      metricsUpdatedAt,
      values,
      canonicalObservedTypes,
    )
  ) {
    return { ok: false };
  }
  const storedFingerprint = String(metric?.snapshot_fingerprint || "");
  if (
    !/^[a-f0-9]{64}$/.test(storedFingerprint)
    || storedFingerprint !== await contentMetricFingerprint(metric)
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    metric,
    providerMetricsUpdatedAt: metricsUpdatedAt,
    providerMetricsHash: storedProviderHash,
  };
}

async function existingAutomatedMetricCheckpoint(
  entity: any,
  job: any,
  checkpoint: {
    days: number;
    dueAt: string;
    closeAt: string;
    dueMs: number;
    closeMs: number;
  },
  publishedAt: string,
  format: string,
  ctaVariant: string,
  observedAt: Date,
): Promise<{
  state: "none" | "exact" | "conflict";
  metric?: any;
  providerMetricsUpdatedAt?: string;
  providerMetricsHash?: string;
}> {
  const platform = token(job?.platform);
  const campaign = token(job?.campaign, "1000-users");
  const content = token(job?.platform_content_id);
  const rows = asArray(await entity.filter(
    { campaign, content, snapshot_days: checkpoint.days },
    "-snapshot_captured_at",
    50,
  )).filter((record) => contentMetricPlatform(record) === platform);
  if (!rows.length) return { state: "none" };
  if (rows.length !== 1) return { state: "conflict" };
  const exact = await exactAutomatedMetricCheckpoint(
    rows[0],
    job,
    checkpoint,
    publishedAt,
    format,
    ctaVariant,
    observedAt,
  );
  return exact.ok
    ? {
      state: "exact",
      metric: exact.metric,
      providerMetricsUpdatedAt: exact.providerMetricsUpdatedAt,
      providerMetricsHash: exact.providerMetricsHash,
    }
    : { state: "conflict" };
}

function validatedMetricsCheckpoints(job: any): {
  ok: boolean;
  records: any[];
} {
  const records = asArray(job?.metrics_checkpoints);
  if (records.length > METRIC_CHECKPOINT_DAYS.length) {
    return { ok: false, records };
  }
  const seen = new Set<number>();
  for (const record of records) {
    const days = Number(record?.snapshot_days || 0);
    if (
      !METRIC_CHECKPOINT_DAYS.includes(days)
      || seen.has(days)
      || !["captured", "review_needed"].includes(token(record?.status))
      || !timestamp(record?.due_at)
      || !timestamp(record?.window_closes_at)
      || !timestamp(record?.recorded_at)
    ) {
      return { ok: false, records };
    }
    seen.add(days);
  }
  return {
    ok: true,
    records: [...records].sort(
      (left, right) => Number(left?.snapshot_days || 0)
        - Number(right?.snapshot_days || 0),
    ),
  };
}

function checkpointTimes(publishedAt: string, snapshotDays: number): {
  dueAt: string;
  closeAt: string;
  dueMs: number;
  closeMs: number;
} {
  const publishedMs = new Date(publishedAt).getTime();
  const dueMs = publishedMs + snapshotDays * DAY_MS;
  const closeMs = dueMs + SNAPSHOT_GRACE_MS;
  return {
    dueAt: new Date(dueMs).toISOString(),
    closeAt: new Date(closeMs).toISOString(),
    dueMs,
    closeMs,
  };
}

function nextMetricCheckpoint(
  publishedAt: string,
  records: any[],
): { days: number; dueAt: string; closeAt: string; dueMs: number; closeMs: number }
  | null {
  const recorded = new Set(records.map((record) => Number(record?.snapshot_days || 0)));
  const days = METRIC_CHECKPOINT_DAYS.find((value) => !recorded.has(value));
  if (!days) return null;
  const times = checkpointTimes(publishedAt, days);
  return { days, ...times };
}

function reviewNeededCheckpoint(
  checkpoint: {
    days: number;
    dueAt: string;
    closeAt: string;
  },
  now: Date,
  errorCode: string,
  providerEvidence: any = {},
): any {
  return {
    snapshot_days: checkpoint.days,
    due_at: checkpoint.dueAt,
    window_closes_at: checkpoint.closeAt,
    status: "review_needed",
    recorded_at: now.toISOString(),
    error_code: token(errorCode, "buffer_metrics_checkpoint_missed"),
    ...(timestamp(providerEvidence?.provider_metrics_updated_at)
      ? {
        provider_metrics_updated_at: timestamp(
          providerEvidence.provider_metrics_updated_at,
        ),
      }
      : {}),
    ...(/^[a-f0-9]{64}$/.test(normalized(providerEvidence?.provider_metrics_hash))
      ? { provider_metrics_hash: normalized(providerEvidence.provider_metrics_hash) }
      : {}),
  };
}

function metricsProgressFields(
  publishedAt: string,
  records: any[],
  now: Date,
): any {
  const next = nextMetricCheckpoint(publishedAt, records);
  return next
    ? {
      state: "sent",
      metrics_published_at: publishedAt,
      metrics_checkpoints: records,
      metrics_next_checkpoint_at: next.dueAt,
    }
    : {
      state: "sent",
      metrics_published_at: publishedAt,
      metrics_checkpoints: records,
      metrics_sync_completed_at: now.toISOString(),
    };
}

async function automatedMetricUpsert(
  entity: any,
  job: any,
  checkpoint: {
    days: number;
    dueAt: string;
    closeAt: string;
    dueMs: number;
    closeMs: number;
  },
  publishedAt: string,
  capturedAt: string,
  metricsUpdatedAt: string,
  providerMetricsHash: string,
  values: Record<string, number>,
  observedTypes: string[],
  format: string,
  ctaVariant: string,
  observedAt: Date,
): Promise<{
  ok: boolean;
  code?: string;
  metric?: any;
}> {
  const platform = token(job?.platform);
  const campaign = token(job?.campaign, "1000-users");
  const content = token(job?.platform_content_id);
  if (!SOCIAL_PLATFORMS.has(platform) || !campaign || !content) {
    return { ok: false, code: "buffer_metrics_attribution_invalid" };
  }
  const metric: any = {
    platform,
    campaign,
    content,
    ...automatedMetricDimensions(job, format, ctaVariant),
    published_at: publishedAt,
    snapshot_days: checkpoint.days,
    snapshot_captured_at: capturedAt,
    ...values,
    metric_source: "buffer",
    provider_post_id: String(job?.provider_post_id || "").slice(0, 300),
    provider_channel_id: String(job?.provider_channel_id || "").slice(0, 300),
    provider_metrics_updated_at: metricsUpdatedAt,
    provider_metrics_hash: providerMetricsHash,
    provider_observed_metric_types: [...observedTypes].sort(),
  };
  metric.snapshot_fingerprint = await contentMetricFingerprint(metric);

  const existing = await existingAutomatedMetricCheckpoint(
    entity,
    job,
    checkpoint,
    publishedAt,
    format,
    ctaVariant,
    observedAt,
  );
  if (existing.state === "exact") {
    return { ok: true, metric: existing.metric };
  }
  if (existing.state === "conflict") {
    return { ok: false, code: "content_snapshot_conflict" };
  }
  try {
    const created = await entity.create(metric);
    if (!created?.id) {
      return { ok: false, code: "content_metric_unavailable" };
    }
    return { ok: true, metric: created };
  } catch {
    // A prior lease may have created the row immediately before losing its
    // job fence. Re-read once and accept only exact provider evidence.
    const raced = await existingAutomatedMetricCheckpoint(
      entity,
      job,
      checkpoint,
      publishedAt,
      format,
      ctaVariant,
      observedAt,
    );
    return raced.state === "exact"
      ? { ok: true, metric: raced.metric }
      : {
        ok: false,
        code: raced.state === "conflict"
          ? "content_snapshot_conflict"
          : "content_metric_unavailable",
      };
  }
}

async function finishMetricCheckpoint(
  entities: any,
  claim: any,
  publishedAt: string,
  records: any[],
  checkpoint: {
    days: number;
    dueAt: string;
    closeAt: string;
  },
  now: Date,
  result: {
    status: "captured" | "review_needed";
    metric?: any;
    errorCode?: string;
    providerMetricsUpdatedAt?: string;
    providerMetricsHash?: string;
  },
): Promise<string> {
  const nextRecords = [
    ...records,
    result.status === "captured"
      ? {
        snapshot_days: checkpoint.days,
        due_at: checkpoint.dueAt,
        window_closes_at: checkpoint.closeAt,
        status: "captured",
        recorded_at: now.toISOString(),
        metric_id: String(result.metric?.id || "").slice(0, 160),
        snapshot_captured_at: timestamp(result.metric?.snapshot_captured_at),
        snapshot_fingerprint: normalized(result.metric?.snapshot_fingerprint),
        provider_metrics_updated_at: timestamp(result.providerMetricsUpdatedAt),
        provider_metrics_hash: normalized(result.providerMetricsHash),
      }
      : reviewNeededCheckpoint(
        checkpoint,
        now,
        result.errorCode || "buffer_metrics_checkpoint_missed",
        {
          provider_metrics_updated_at: result.providerMetricsUpdatedAt,
          provider_metrics_hash: result.providerMetricsHash,
        },
      ),
  ].sort(
    (left, right) => Number(left?.snapshot_days || 0)
      - Number(right?.snapshot_days || 0),
  );
  const fields = {
    ...metricsProgressFields(publishedAt, nextRecords, now),
    ...(timestamp(result.providerMetricsUpdatedAt)
      ? { provider_metrics_updated_at: timestamp(result.providerMetricsUpdatedAt) }
      : {}),
    ...(/^[a-f0-9]{64}$/.test(normalized(result.providerMetricsHash))
      ? { provider_metrics_hash: normalized(result.providerMetricsHash) }
      : {}),
    last_error_code: result.status === "captured"
      ? ""
      : token(result.errorCode, "buffer_metrics_checkpoint_missed"),
    last_error_message: result.status === "captured"
      ? ""
      : "A fixed-age Buffer metric checkpoint needs human review.",
  };
  const saved = await fencedUpdate(
    entities.GrowthPublishJob,
    claim.row,
    claim.leaseToken,
    claim.leaseGeneration,
    fields,
  );
  return saved ? "sent" : "lease_lost";
}

async function reconcileExistingMetricCheckpoint(
  entities: any,
  claim: any,
  publishedAt: string,
  records: any[],
  checkpoint: {
    days: number;
    dueAt: string;
    closeAt: string;
    dueMs: number;
    closeMs: number;
  },
  now: Date,
  format: string,
  ctaVariant: string,
): Promise<string | null> {
  const existing = await existingAutomatedMetricCheckpoint(
    entities.GrowthContentMetric,
    claim.row,
    checkpoint,
    publishedAt,
    format,
    ctaVariant,
    now,
  );
  if (existing.state === "none") return null;
  if (existing.state === "conflict") {
    return finishMetricCheckpoint(
      entities,
      claim,
      publishedAt,
      records,
      checkpoint,
      now,
      {
        status: "review_needed",
        errorCode: "content_snapshot_conflict",
      },
    );
  }
  return finishMetricCheckpoint(
    entities,
    claim,
    publishedAt,
    records,
    checkpoint,
    now,
    {
      status: "captured",
      metric: existing.metric,
      providerMetricsUpdatedAt: existing.providerMetricsUpdatedAt,
      providerMetricsHash: existing.providerMetricsHash,
    },
  );
}

async function retryMetricCheckpoint(
  entities: any,
  claim: any,
  publishedAt: string,
  records: any[],
  checkpoint: {
    days: number;
    dueAt: string;
    closeAt: string;
    closeMs: number;
  },
  now: Date,
  errorCode: string,
  providerMetricsUpdatedAt?: string,
  providerMetricsHash?: string,
): Promise<string> {
  if (now.getTime() >= checkpoint.closeMs) {
    return finishMetricCheckpoint(
      entities,
      claim,
      publishedAt,
      records,
      checkpoint,
      now,
      {
        status: "review_needed",
        errorCode,
        providerMetricsUpdatedAt,
        providerMetricsHash,
      },
    );
  }
  const retryAt = new Date(Math.min(
    now.getTime() + METRIC_RETRY_MS,
    checkpoint.closeMs,
  )).toISOString();
  const saved = await fencedUpdate(
    entities.GrowthPublishJob,
    claim.row,
    claim.leaseToken,
    claim.leaseGeneration,
    {
      state: "sent",
      metrics_published_at: publishedAt,
      metrics_checkpoints: records,
      metrics_next_checkpoint_at: retryAt,
      ...(timestamp(providerMetricsUpdatedAt)
        ? { provider_metrics_updated_at: timestamp(providerMetricsUpdatedAt) }
        : {}),
      ...(/^[a-f0-9]{64}$/.test(normalized(providerMetricsHash))
        ? { provider_metrics_hash: normalized(providerMetricsHash) }
        : {}),
      last_error_code: token(errorCode, "buffer_metrics_retry"),
      last_error_message: "Buffer metric evidence was not ready; this checkpoint will retry.",
    },
  );
  return saved ? "sent" : "lease_lost";
}

async function resolveMetricsPlan(
  entities: any,
  job: any,
): Promise<{
  ok: boolean;
  code?: string;
  publishedAt?: string;
  format?: string;
  ctaVariant?: string;
}> {
  const plans = await measurementPlansForPlatform(
    entities.GrowthContentPlan,
    token(job?.platform),
    token(job?.campaign, "1000-users"),
    token(job?.platform_content_id),
  ).catch(() => []);
  if (plans.length !== 1) {
    return { ok: false, code: "metrics_plan_missing_or_ambiguous" };
  }
  const plan = plans[0];
  const planPublishedAt = timestamp(plan?.published_at);
  const durable = timestamp(job?.metrics_published_at || job?.provider_sent_at);
  if (
    !planPublishedAt
    || (durable && durable !== planPublishedAt)
  ) {
    return { ok: false, code: "metrics_publication_clock_missing" };
  }
  const format = token(plan?.format);
  if (!CONTENT_FORMATS.has(format)) {
    return { ok: false, code: "metrics_plan_format_invalid" };
  }
  const ctaVariant = String(plan?.cta_label || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  if (!ctaVariant) {
    return { ok: false, code: "metrics_plan_cta_missing" };
  }
  return {
    ok: true,
    publishedAt: durable || planPublishedAt,
    format,
    ctaVariant,
  };
}

async function sentMetricsConfigurationMatches(
  job: any,
  config: any,
): Promise<boolean> {
  const platform = token(job?.platform);
  return job?.provider === "buffer"
    && SOCIAL_PLATFORMS.has(platform)
    && token(job?.provider_service) === platform
    && String(job?.provider_organization_id || "") === config.organizationId
    && String(job?.provider_channel_id || "") === channelFor(config, platform)
    && await configRevision(job) === job?.config_revision
    && await publishJobRequestHash(job) === job?.request_hash;
}

async function processSentMetrics(
  entities: any,
  claim: any,
  config: any,
  now: Date,
): Promise<string> {
  const job = claim.row;
  if (
    !job?.provider_post_id
    || token(job?.provider_status) !== "sent"
    || !SOCIAL_PLATFORMS.has(token(job?.platform))
    || String(job?.provider_channel_id || "").length < 1
    || token(job?.provider_service) !== token(job?.platform)
  ) {
    const saved = await fencedUpdate(
      entities.GrowthPublishJob,
      job,
      claim.leaseToken,
      claim.leaseGeneration,
      {
        state: "sent",
        metrics_sync_completed_at: now.toISOString(),
        last_error_code: "published_metrics_evidence_missing",
        last_error_message:
          "The sent post lacks immutable provider evidence for metric checkpoints.",
      },
    );
    return saved ? "sent" : "lease_lost";
  }
  const metricsPlan = await resolveMetricsPlan(entities, job);
  const publishedAt = metricsPlan.publishedAt || "";
  const checked = validatedMetricsCheckpoints(job);
  if (!metricsPlan.ok || !publishedAt || !checked.ok) {
    const saved = await fencedUpdate(
      entities.GrowthPublishJob,
      job,
      claim.leaseToken,
      claim.leaseGeneration,
      {
        state: "sent",
        metrics_sync_completed_at: now.toISOString(),
        last_error_code: !metricsPlan.ok
          ? metricsPlan.code || "metrics_plan_invalid"
          : !publishedAt
          ? "metrics_publication_clock_missing"
          : "metrics_checkpoint_history_invalid",
        last_error_message:
          "Automated fixed-age metrics need review because their durable clock or history is invalid.",
      },
    );
    return saved ? "sent" : "lease_lost";
  }

  const records = [...checked.records];
  let checkpoint = nextMetricCheckpoint(publishedAt, records);
  while (
    checkpoint
    && now.getTime() > checkpoint.closeMs + METRIC_FINAL_READ_TOLERANCE_MS
  ) {
    const reconciled = await reconcileExistingMetricCheckpoint(
      entities,
      claim,
      publishedAt,
      records,
      checkpoint,
      now,
      metricsPlan.format || "other",
      metricsPlan.ctaVariant || "",
    );
    if (reconciled) return reconciled;
    records.push(reviewNeededCheckpoint(
      checkpoint,
      now,
      "buffer_metrics_checkpoint_window_missed",
    ));
    checkpoint = nextMetricCheckpoint(publishedAt, records);
  }
  if (!checkpoint) {
    const saved = await fencedUpdate(
      entities.GrowthPublishJob,
      job,
      claim.leaseToken,
      claim.leaseGeneration,
      {
        ...metricsProgressFields(publishedAt, records, now),
        last_error_code: records.some((record) => record?.status === "review_needed")
          ? "buffer_metrics_checkpoint_window_missed"
          : "",
        last_error_message: records.some((record) => record?.status === "review_needed")
          ? "One or more fixed-age Buffer metric checkpoints need human review."
          : "",
      },
    );
    return saved ? "sent" : "lease_lost";
  }
  if (now.getTime() < checkpoint.dueMs) {
    const saved = await fencedUpdate(
      entities.GrowthPublishJob,
      job,
      claim.leaseToken,
      claim.leaseGeneration,
      {
        state: "sent",
        metrics_published_at: publishedAt,
        metrics_checkpoints: records,
        metrics_next_checkpoint_at: checkpoint.dueAt,
      },
    );
    return saved ? "sent" : "lease_lost";
  }
  const reconciled = await reconcileExistingMetricCheckpoint(
    entities,
    claim,
    publishedAt,
    records,
    checkpoint,
    now,
    metricsPlan.format || "other",
    metricsPlan.ctaVariant || "",
  );
  if (reconciled) return reconciled;
  if (!await sentMetricsConfigurationMatches(job, config)) {
    return finishMetricCheckpoint(
      entities,
      claim,
      publishedAt,
      records,
      checkpoint,
      now,
      {
        status: "review_needed",
        errorCode: "buffer_metrics_configuration_mismatch",
      },
    );
  }

  const result = await bufferRequest(
    postMetricsQuery(String(job.provider_post_id)),
    config,
    "read",
  );
  if (!result.ok) {
    return retryMetricCheckpoint(
      entities,
      claim,
      publishedAt,
      records,
      checkpoint,
      now,
      bufferMetricRequestErrorCode(result?.code),
    );
  }
  const post = result.document?.data?.post;
  const providerSentAt = timestamp(post?.sentAt);
  const expectedSentAt = timestamp(job?.provider_sent_at);
  if (
    String(post?.id || "") !== String(job?.provider_post_id || "")
    || String(post?.channelId || "") !== String(job?.provider_channel_id || "")
    || token(post?.channelService) !== token(job?.provider_service)
    || token(post?.status) !== "sent"
    || !providerSentAt
    || (expectedSentAt && providerSentAt !== expectedSentAt)
  ) {
    return finishMetricCheckpoint(
      entities,
      claim,
      publishedAt,
      records,
      checkpoint,
      now,
      {
        status: "review_needed",
        errorCode: "buffer_metrics_provider_mismatch",
      },
    );
  }
  const metricsUpdatedAt = timestamp(post?.metricsUpdatedAt);
  const normalizedMetrics = normalizedBufferCountMetrics(post);
  if (
    !metricsUpdatedAt
    || new Date(metricsUpdatedAt).getTime() > now.getTime() + 5 * 60 * 1000
    || !normalizedMetrics.ok
  ) {
    return retryMetricCheckpoint(
      entities,
      claim,
      publishedAt,
      records,
      checkpoint,
      now,
      normalizedMetrics.code || "buffer_metrics_refresh_missing",
      metricsUpdatedAt,
    );
  }
  const providerMetricsHash = await normalizedProviderMetricsHash(
    job,
    metricsUpdatedAt,
    normalizedMetrics.values || {},
    normalizedMetrics.observedTypes || [],
  );
  const metricsUpdatedMs = new Date(metricsUpdatedAt).getTime();
  if (metricsUpdatedMs < checkpoint.dueMs) {
    return retryMetricCheckpoint(
      entities,
      claim,
      publishedAt,
      records,
      checkpoint,
      now,
      "buffer_metrics_refresh_stale",
      metricsUpdatedAt,
      providerMetricsHash,
    );
  }
  if (metricsUpdatedMs > checkpoint.closeMs) {
    return finishMetricCheckpoint(
      entities,
      claim,
      publishedAt,
      records,
      checkpoint,
      now,
      {
        status: "review_needed",
        errorCode: "buffer_metrics_refresh_after_window",
        providerMetricsUpdatedAt: metricsUpdatedAt,
        providerMetricsHash,
      },
    );
  }
  const capturedAt = metricsUpdatedAt;
  const upserted = await automatedMetricUpsert(
    entities.GrowthContentMetric,
    job,
    checkpoint,
    publishedAt,
    capturedAt,
    metricsUpdatedAt,
    providerMetricsHash,
    normalizedMetrics.values || {},
    normalizedMetrics.observedTypes || [],
    metricsPlan.format || "other",
    metricsPlan.ctaVariant || "",
    now,
  );
  if (!upserted.ok) {
    return finishMetricCheckpoint(
      entities,
      claim,
      publishedAt,
      records,
      checkpoint,
      now,
      {
        status: "review_needed",
        errorCode: upserted.code || "content_metric_unavailable",
        providerMetricsUpdatedAt: metricsUpdatedAt,
        providerMetricsHash,
      },
    );
  }
  return finishMetricCheckpoint(
    entities,
    claim,
    publishedAt,
    records,
    checkpoint,
    now,
    {
      status: "captured",
      metric: upserted.metric,
      providerMetricsUpdatedAt: metricsUpdatedAt,
      providerMetricsHash,
    },
  );
}

async function processCreate(
  entities: any,
  claim: any,
  artifact: any,
  config: any,
  now: Date,
  secrets: string[],
): Promise<string> {
  const mediaVerification = await verifyApprovedMediaBytes(artifact, config);
  if (!mediaVerification.ok) {
    return finishFailure(
      entities,
      claim.row,
      claim,
      mediaVerification,
      now,
      secrets,
    );
  }
  const channelVerification = await verifyConfiguredChannel(claim.row, config);
  if (!channelVerification.ok) {
    return finishFailure(
      entities,
      claim.row,
      claim,
      channelVerification,
      now,
      secrets,
    );
  }
  const sourceState = await sourceReadinessState(
    entities,
    artifact,
    claim.row,
  );
  if (sourceState !== "safe") {
    return finishFailure(
      entities,
      claim.row,
      claim,
      {
        outcome: sourceState === "unavailable" ? "retry" : "review",
        code: sourceState === "unavailable"
          ? "source_privacy_clearance_unavailable"
          : sourceState === "lineage_missing"
          ? "source_lineage_snapshot_missing"
          : sourceState === "lineage_changed"
          ? "source_render_lineage_changed"
          : "source_privacy_clearance_changed",
        message: sourceState === "unavailable"
          ? "Source privacy clearance could not be re-read before publishing."
          : sourceState === "lineage_missing"
          ? "The publish job has no immutable source-lineage snapshot."
          : sourceState === "lineage_changed"
          ? "Registered source lineage changed before provider submission."
          : "A source was blocked or deactivated before provider submission.",
      },
      now,
      secrets,
    );
  }
  const latestArtifact = await entities.GrowthCreativeArtifact.get(
    claim.row.artifact_id,
  ).catch(() => null);
  if (
    !latestArtifact
    || latestArtifact?.approval_status !== "approved"
    || latestArtifact?.approved_hash !== claim.row.artifact_hash
    || await artifactApprovalHash(latestArtifact) !== claim.row.artifact_hash
  ) {
    return finishFailure(
      entities,
      claim.row,
      claim,
      {
        outcome: "review",
        code: "artifact_approval_changed",
        message: "Approval changed immediately before provider submission.",
      },
      now,
      secrets,
    );
  }
  if (!await renewClaimLease(entities.GrowthPublishJob, claim, new Date())) {
    return "lease_lost";
  }
  const result = await bufferRequest(
    createMutation(latestArtifact, claim.row),
    config,
    "create",
  );
  if (!result.ok) {
    return finishFailure(
      entities,
      claim.row,
      claim,
      result,
      now,
      secrets,
    );
  }
  const mutation = result.document?.data?.createPost;
  if (mutation?.__typename !== "PostActionSuccess" || !mutation?.post?.id) {
    const outcome = mutation?.__typename && mutation?.__typename !== "PostActionSuccess"
      ? {
        outcome: "review",
        code: `provider_${token(mutation.__typename, "mutation_rejected")}`,
        message: mutation?.message || "Buffer rejected the post.",
      }
      : {
        outcome: "ambiguous",
        code: "provider_create_unconfirmed",
        message: "Buffer did not return a durable post identifier.",
      };
    return finishFailure(
      entities,
      claim.row,
      claim,
      outcome,
      now,
      secrets,
    );
  }
  const post = mutation.post;
  if (!exactPostMatches(post, artifact, claim.row)) {
    const fields = providerFields(post, now);
    const saved = await fencedUpdate(
      entities.GrowthPublishJob,
      claim.row,
      claim.leaseToken,
      claim.leaseGeneration,
      {
        ...fields,
        state: "review_required",
        last_error_code: "provider_post_mismatch",
        last_error_message:
          "Buffer created a post, but its channel, publishing mode, time, text, or media did not match approval.",
      },
    );
    return saved ? "review_required" : "lease_lost";
  }
  const fields = await measurementAwareFields(entities, artifact, post, now);
  fields.provider_response_hash = await sha256Hex(canonicalStringify({
    id: post.id,
    channelId: post.channelId,
    schedulingType: post.schedulingType,
    status: post.status,
    dueAt: post.dueAt,
    sentAt: post.sentAt,
    externalLink: post.externalLink,
    updatedAt: post.updatedAt,
  }));
  const saved = await fencedUpdate(
    entities.GrowthPublishJob,
    claim.row,
    claim.leaseToken,
    claim.leaseGeneration,
    fields,
  );
  return saved ? fields.state : "lease_lost";
}

async function processReconcile(
  entities: any,
  claim: any,
  artifact: any,
  config: any,
  now: Date,
  secrets: string[],
): Promise<string> {
  const result = await bufferRequest(reconcileQuery(claim.row), config, "read");
  if (!result.ok) {
    const retryResult = result.outcome === "review"
      ? result
      : { ...result, outcome: "reconcile_retry" };
    return finishFailure(
      entities,
      claim.row,
      claim,
      retryResult,
      now,
      secrets,
    );
  }
  const { posts, hasNextPage } = rowsFromPosts(result.document);
  const matches = posts.filter((post) => exactPostMatches(post, artifact, claim.row));
  if (hasNextPage || matches.length > 1) {
    return finishFailure(
      entities,
      claim.row,
      claim,
      {
        outcome: "review",
        code: "provider_duplicate_match",
        message: "Provider reconciliation found multiple possible posts.",
      },
      now,
      secrets,
    );
  }
  if (matches.length === 1) {
    const fields = await measurementAwareFields(
      entities,
      artifact,
      matches[0],
      now,
    );
    fields.provider_response_hash = await sha256Hex(canonicalStringify({
      id: matches[0].id,
      channelId: matches[0].channelId,
      schedulingType: matches[0].schedulingType,
      status: matches[0].status,
      dueAt: matches[0].dueAt,
      sentAt: matches[0].sentAt,
      externalLink: matches[0].externalLink,
      updatedAt: matches[0].updatedAt,
    }));
    const saved = await fencedUpdate(
      entities.GrowthPublishJob,
      claim.row,
      claim.leaseToken,
      claim.leaseGeneration,
      fields,
    );
    return saved ? fields.state : "lease_lost";
  }
  if (Number(claim.row?.reconciliation_count || 0) >= MAX_RECONCILIATIONS) {
    return finishFailure(
      entities,
      claim.row,
      claim,
      {
        outcome: "review",
        code: "provider_create_unresolved",
        message: "The possible provider create could not be reconciled safely.",
      },
      now,
      secrets,
    );
  }
  const saved = await fencedUpdate(
    entities.GrowthPublishJob,
    claim.row,
    claim.leaseToken,
    claim.leaseGeneration,
    {
      state: "create_reconcile",
      next_retry_at: new Date(
        now.getTime() + (Number(claim.row?.reconciliation_count || 0) + 1) * 5 * 60 * 1000,
      ).toISOString(),
      last_error_code: "provider_match_not_visible",
      last_error_message: "Waiting for the provider post to become visible.",
    },
  );
  return saved ? "create_reconcile" : "lease_lost";
}

async function processKnownPost(
  entities: any,
  claim: any,
  artifact: any,
  config: any,
  now: Date,
  secrets: string[],
): Promise<string> {
  const result = await bufferRequest(
    postQuery(claim.row.provider_post_id),
    config,
    "read",
  );
  if (!result.ok) {
    return finishFailure(
      entities,
      claim.row,
      claim,
      result,
      now,
      secrets,
    );
  }
  const post = result.document?.data?.post;
  if (!post?.id || !PROVIDER_STATUSES.has(token(post?.status))) {
    return finishFailure(
      entities,
      claim.row,
      claim,
      {
        outcome: "review",
        code: "provider_post_missing",
        message: "The known Buffer post could not be verified.",
      },
      now,
      secrets,
    );
  }
  if (String(post.id) !== String(claim.row.provider_post_id)) {
    return finishFailure(
      entities,
      claim.row,
      claim,
      {
        outcome: "review",
        code: "provider_post_identity_changed",
        message: "Buffer returned a different post identifier than the tracked post.",
      },
      now,
      secrets,
    );
  }
  if (!exactPostMatches(post, artifact, claim.row)) {
    const fields = providerFields(post, now);
    const saved = await fencedUpdate(
      entities.GrowthPublishJob,
      claim.row,
      claim.leaseToken,
      claim.leaseGeneration,
      {
        ...fields,
        state: "review_required",
        last_error_code: "provider_post_mismatch",
        last_error_message:
          "The tracked Buffer post no longer matches its approved channel, publishing mode, time, text, or media.",
      },
    );
    return saved ? "review_required" : "lease_lost";
  }
  const fields = await measurementAwareFields(entities, artifact, post, now);
  fields.provider_response_hash = await sha256Hex(canonicalStringify({
    id: post.id,
    channelId: post.channelId,
    schedulingType: post.schedulingType,
    status: post.status,
    dueAt: post.dueAt,
    sentAt: post.sentAt,
    externalLink: post.externalLink,
    updatedAt: post.updatedAt,
  }));
  const saved = await fencedUpdate(
    entities.GrowthPublishJob,
    claim.row,
    claim.leaseToken,
    claim.leaseGeneration,
    fields,
  );
  return saved ? fields.state : "lease_lost";
}

function jobOrder(left: any, right: any): number {
  return new Date(left?.created_date || 0).getTime()
    - new Date(right?.created_date || 0).getTime()
    || String(left?.id || "").localeCompare(String(right?.id || ""));
}

function duplicateCandidateFence(candidate: any): any {
  return {
    id: candidate.id,
    state: candidate.state,
    lease_generation: Number(candidate?.lease_generation || 0),
    ...(candidate?.state === "processing"
      ? {
        lease_token: String(candidate?.lease_token || ""),
        lease_expires_at: String(candidate?.lease_expires_at || ""),
      }
      : {}),
  };
}

async function suppressDuplicatePublishJob(
  entity: any,
  candidate: any,
): Promise<{ process: boolean; state?: string }> {
  const rows = asArray(await entity.filter(
    { job_key: String(candidate?.job_key || "") },
    "created_date",
    50,
  ));
  if (rows.length <= 1) return { process: true };
  const providerKnown = rows.filter((row) => row?.provider_post_id).sort(jobOrder);
  const winner = (providerKnown.length ? providerKnown : [...rows].sort(jobOrder))[0];
  if (String(winner?.id || "") === String(candidate?.id || "")) {
    if (providerKnown.length <= 1) return { process: true };
    const moved = await entity.updateMany(
      duplicateCandidateFence(candidate),
      {
        $set: {
          state: "review_required",
          last_error_code: "duplicate_provider_jobs_detected",
          last_error_message:
            "Multiple durable jobs already know provider posts for the same approved content.",
        },
      },
    );
    return {
      process: false,
      state: Number(moved?.updated || 0) === 1 ? "review_required" : "lease_lost",
    };
  }
  const state = candidate?.provider_post_id ? "review_required" : "failed";
  const moved = await entity.updateMany(
    duplicateCandidateFence(candidate),
    {
      $set: {
        state,
        last_error_code: candidate?.provider_post_id
          ? "duplicate_provider_jobs_detected"
          : "duplicate_publish_job_suppressed",
        last_error_message: candidate?.provider_post_id
          ? "Another duplicate job also knows a provider post; manual review is required."
          : "A canonical duplicate job owns delivery for this approved content.",
      },
    },
  );
  return {
    process: false,
    state: Number(moved?.updated || 0) === 1 ? state : "lease_lost",
  };
}

Deno.serve(async (req: Request) => {
  const auth = workerSecret(req);
  if (auth.configured.length < 32) {
    return response({ error: "growth_publish_worker_not_configured" }, 503);
  }
  if (!auth.supplied || !constantTimeEqual(auth.configured, auth.supplied)) {
    return response({ error: "worker_unauthorized" }, 401);
  }
  if (req.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  if (normalized(Deno.env.get("GROWTH_PUBLISH_ENABLED")) !== "true") {
    return response({ error: "growth_publishing_disabled" }, 503);
  }
  const config = configuration();
  if (!config) return response({ error: "buffer_not_configured" }, 503);

  try {
    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : {};
    const limit = Math.max(1, Math.min(MAX_BATCH, Math.trunc(Number(body?.limit || MAX_BATCH))));
    const now = new Date();
    const base44 = createClientFromRequest(req);
    const entities = base44.asServiceRole.entities;
    const jobEntity = entities.GrowthPublishJob;
    const expiredReservations = await expiredReservationRows(
      jobEntity,
      now,
      limit,
    );
    const remaining = Math.max(0, limit - expiredReservations.length);
    const candidates = remaining
      ? await candidateRows(jobEntity, now.getTime(), remaining)
      : [];
    const states: Record<string, number> = {};
    let processed = 0;

    for (const reservation of expiredReservations) {
      const state = await sweepExpiredReservation(entities, reservation, now);
      if (!state) continue;
      states[state] = (states[state] || 0) + 1;
      processed += 1;
    }

    for (const candidate of candidates) {
      const duplicate = await suppressDuplicatePublishJob(jobEntity, candidate);
      if (!duplicate.process) {
        const duplicateState = duplicate.state || "lease_lost";
        states[duplicateState] = (states[duplicateState] || 0) + 1;
        processed += 1;
        continue;
      }
      if (candidate?.state === "processing") {
        if (await recoverExpiredLease(jobEntity, candidate, now)) {
          const leaseSourceState = token(candidate?.lease_source_state);
          const recoveredState = leaseSourceState === "delivery_reconcile"
            ? "delivery_reconcile"
            : leaseSourceState === "measurement_retry"
              ? "measurement_retry"
              : leaseSourceState === "sent"
                ? "sent"
              : "create_reconcile";
          states[recoveredState] = (states[recoveredState] || 0) + 1;
          processed += 1;
        }
        continue;
      }
      const claim = await claimJob(jobEntity, candidate, now);
      if (!claim) continue;
      if (claim.sourceState === "delivery_reconcile") {
        const state = await processDeliveryReconcile(
          entities,
          claim,
          now,
          [auth.configured, config.apiKey],
        );
        states[state] = (states[state] || 0) + 1;
        processed += 1;
        continue;
      }
      if (claim.sourceState === "measurement_retry") {
        const state = await processMeasurementRetry(
          entities,
          claim,
          now,
          [auth.configured, config.apiKey],
        );
        states[state] = (states[state] || 0) + 1;
        processed += 1;
        continue;
      }
      if (claim.sourceState === "sent") {
        const state = await processSentMetrics(
          entities,
          claim,
          config,
          now,
        );
        states[state] = (states[state] || 0) + 1;
        processed += 1;
        continue;
      }
      const cutoffMs = new Date(claim.row?.schedule_cutoff_at || 0).getTime();
      if (
        ["queued", "retry_wait"].includes(claim.sourceState)
        && Number.isFinite(cutoffMs)
        && now.getTime() >= cutoffMs
        && !claim.row?.provider_post_id
      ) {
        const state = await finishFailure(
          entities,
          claim.row,
          claim,
          {
            outcome: "review",
            code: "missed_schedule_window",
            message: "The safe Buffer scheduling window was missed.",
          },
          now,
          [auth.configured, config.apiKey],
        );
        states[state] = (states[state] || 0) + 1;
        processed += 1;
        continue;
      }
      const operation = claim.sourceState === "create_reconcile"
        ? "reconcile"
        : claim.row?.provider_post_id
          ? "poll"
          : "create";
      const check = await preflight(entities, claim.row, config);
      if (!check.artifact) {
        const state = await finishFailure(
          entities,
          claim.row,
          claim,
          {
            outcome: check.outcome || "review",
            code: check.error,
            message: "The approved content or publishing configuration changed.",
          },
          now,
          [auth.configured, config.apiKey],
        );
        states[state] = (states[state] || 0) + 1;
        processed += 1;
        continue;
      }
      const latestArtifact = await entities.GrowthCreativeArtifact.get(
        claim.row.artifact_id,
      ).catch(() => null);
      if (
        !latestArtifact
        || latestArtifact?.approval_status !== "approved"
        || await artifactApprovalHash(latestArtifact) !== claim.row.artifact_hash
      ) {
        const state = await finishFailure(
          entities,
          claim.row,
          claim,
          {
            outcome: "review",
            code: "artifact_approval_changed",
            message: "Approval changed before provider submission.",
          },
          now,
          [auth.configured, config.apiKey],
        );
        states[state] = (states[state] || 0) + 1;
        processed += 1;
        continue;
      }

      let state = "review_required";
      if (operation === "create") {
        state = await processCreate(
          entities,
          claim,
          latestArtifact,
          config,
          now,
          [auth.configured, config.apiKey],
        );
      } else if (operation === "reconcile") {
        state = await processReconcile(
          entities,
          claim,
          latestArtifact,
          config,
          now,
          [auth.configured, config.apiKey],
        );
      } else {
        state = await processKnownPost(
          entities,
          claim,
          latestArtifact,
          config,
          now,
          [auth.configured, config.apiKey],
        );
      }
      states[state] = (states[state] || 0) + 1;
      processed += 1;
    }

    const heartbeatSaved = await recordWorkerHeartbeat(
      entities.GrowthPublishHeartbeat,
      config,
      new Date().toISOString(),
      expiredReservations.length + candidates.length,
      processed,
    );
    if (!heartbeatSaved) throw new Error("publisher_heartbeat_not_persisted");
    return response({
      success: true,
      inspected: expiredReservations.length + candidates.length,
      processed,
      states,
    });
  } catch (error) {
    console.error("[processGrowthPublishQueue]", safeProviderError(error?.message));
    return response({ error: "growth_publish_worker_unavailable" }, 500);
  }
});
