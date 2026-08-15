import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const FORMATS = new Set(["reel", "carousel", "story", "collab", "live", "other"]);
const PLATFORMS = new Set(["instagram", "tiktok"]);
const SNAPSHOT_DAYS = new Set([1, 3, 7, 30]);
const MAX_METRIC = 1_000_000_000;
const MAX_BODY_BYTES = 32_000;
const METRIC_FIELDS = [
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

function normalized(value: any): string {
  return String(value || "").trim().toLowerCase();
}

function token(value: any, fallback = ""): string {
  return normalized(value)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || fallback;
}

function text(value: any, max = 300): string {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function wholeNumber(value: any): number | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 0
    || parsed > MAX_METRIC
  ) {
    return null;
  }
  return parsed;
}

function optionalTimestamp(value: any): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function canManageGrowth(user: any): boolean {
  return user?.is_owner === true
    || normalized(user?.role) === "admin"
    || normalized(user?.app_role) === "admin";
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function dateValue(record: any, fields: string[]): number {
  for (const field of fields) {
    const parsed = new Date(record?.[field] || "");
    if (Number.isFinite(parsed.getTime())) return parsed.getTime();
  }
  return 0;
}

function latestMetric(records: any[]): any | null {
  return [...records].sort((left, right) => (
    dateValue(right, ["snapshot_captured_at", "updated_date", "created_date"])
      - dateValue(left, ["snapshot_captured_at", "updated_date", "created_date"])
    || String(right?.id || "").localeCompare(String(left?.id || ""))
  ))[0] || null;
}

function bufferManagedPlan(plan: any): boolean {
  return normalized(plan?.delivery_managed_by) === "buffer"
    || normalized(plan?.sprint) === "content-engine";
}

async function bufferManualRepairGate(
  entities: any,
  {
    platform,
    campaign,
    content,
    snapshotDays,
    requestedPublishedAt,
  }: {
    platform: string;
    campaign: string;
    content: string;
    snapshotDays: number;
    requestedPublishedAt?: string;
  },
): Promise<{ allowed: boolean; error?: string }> {
  const planRows = asArray(await entities.GrowthContentPlan.filter(
    { campaign, content },
    "-updated_date",
    50,
  )).filter((plan) => (
    metricPlatform(plan) === platform
    && bufferManagedPlan(plan)
  ));
  if (!planRows.length) return { allowed: true };

  const publishedClocks = new Set(
    planRows
      .map((plan) => optionalTimestamp(plan?.published_at))
      .filter(Boolean),
  );
  if (publishedClocks.size > 1) {
    return { allowed: false, error: "content_plan_conflict" };
  }
  const publishedAt = [...publishedClocks][0];
  if (!publishedAt) {
    return { allowed: false, error: "buffer_checkpoint_still_collecting" };
  }
  if (requestedPublishedAt && requestedPublishedAt !== publishedAt) {
    return { allowed: false, error: "buffer_checkpoint_identity_mismatch" };
  }

  const exactJobs = asArray(await entities.GrowthPublishJob.filter(
    {
      provider: "buffer",
      platform,
      platform_content_id: content,
    },
    "-updated_date",
    50,
  )).filter((job) => (
    token(job?.campaign, "1000-users") === campaign
    && optionalTimestamp(job?.metrics_published_at) === publishedAt
  ));
  if (exactJobs.length > 1) {
    return { allowed: false, error: "buffer_checkpoint_conflict" };
  }
  const exactJob = exactJobs[0];
  if (!exactJob) {
    return { allowed: false, error: "buffer_checkpoint_still_collecting" };
  }

  const exactCheckpoints = asArray(exactJob?.metrics_checkpoints).filter(
    (checkpoint) => Number(checkpoint?.snapshot_days) === snapshotDays,
  );
  if (exactCheckpoints.length > 1) {
    return { allowed: false, error: "buffer_checkpoint_conflict" };
  }
  if (normalized(exactCheckpoints[0]?.status) !== "review_needed") {
    return { allowed: false, error: "buffer_checkpoint_still_collecting" };
  }
  return { allowed: true };
}

function metricPlatform(metric: any): string {
  const platform = token(metric?.platform);
  return PLATFORMS.has(platform) ? platform : "instagram";
}

function snapshotPayload(metric: any): string {
  // Keep the historical fingerprint shape stable. Platform is part of the
  // checkpoint lookup key, so legacy Instagram evidence hashes remain valid.
  const values: any = {
    campaign: token(metric?.campaign, "1000-users"),
    content: token(metric?.content),
    snapshot_days: Number(metric?.snapshot_days || 7),
    snapshot_captured_at: optionalTimestamp(metric?.snapshot_captured_at) || "",
    published_at: optionalTimestamp(metric?.published_at) || "",
  };
  for (const field of METRIC_FIELDS) {
    values[field] = Math.max(0, Number(metric?.[field] || 0));
  }
  const observedFields = Array.isArray(metric?.observed_metric_fields)
    ? metric.observed_metric_fields
    : normalized(metric?.metric_source) === "buffer"
      && Array.isArray(metric?.provider_observed_metric_types)
    ? metric.provider_observed_metric_types
    : null;
  if (observedFields) {
    const observed = new Set(
      observedFields.map((field: any) => normalized(field)),
    );
    values.observed_fields = METRIC_FIELDS.filter(
      (field) => observed.has(field),
    );
  }
  return JSON.stringify(values);
}

function latestCheckpointConflict(records: any[]): boolean {
  if (records.length < 2) return false;
  const latestCapturedAt = Math.max(
    ...records.map((record) => dateValue(record, ["snapshot_captured_at"])),
  );
  const latestCandidates = records.filter(
    (record) => dateValue(record, ["snapshot_captured_at"]) === latestCapturedAt,
  );
  return new Set(latestCandidates.map(snapshotPayload)).size > 1;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function response(data: any, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") {
      return response({ error: "method_not_allowed" }, 405);
    }

    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) {
      return response({ error: "unauthorized" }, 401);
    }
    if (!canManageGrowth(user)) {
      return response({ error: "growth_admin_required" }, 403);
    }

    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
      return response({ error: "content_metric_too_large" }, 413);
    }
    const body = JSON.parse(rawBody || "{}");
    const platform = token(body?.platform, "instagram");
    const campaign = token(body?.campaign, "1000-users");
    const content = token(body?.content);
    const format = token(body?.format, "reel");
    const snapshotDays = Number(body?.snapshot_days || 7);
    if (
      !PLATFORMS.has(platform)
      || !content
      || !FORMATS.has(format)
      || !SNAPSHOT_DAYS.has(snapshotDays)
    ) {
      return response({ error: "invalid_content_metric" }, 400);
    }

    const now = new Date().toISOString();
    const capturedAt = body?.snapshot_captured_at
      ? optionalTimestamp(body.snapshot_captured_at)
      : now;
    const publishedAt = body?.published_at
      ? optionalTimestamp(body.published_at)
      : undefined;
    if (
      !capturedAt
      || (body?.published_at && !publishedAt)
      || new Date(capturedAt).getTime() > Date.now() + 5 * 60 * 1000
      || (publishedAt && publishedAt > capturedAt)
    ) {
      return response({ error: "invalid_content_metric_timestamp" }, 400);
    }
    const metricValues: any = {};
    for (const field of METRIC_FIELDS) {
      const value = wholeNumber(body?.[field]);
      if (value === null) {
        return response({ error: "invalid_content_metric", field }, 400);
      }
      if (value !== undefined) metricValues[field] = value;
    }
    if (
      !Object.prototype.hasOwnProperty.call(metricValues, "reach")
      && !Object.prototype.hasOwnProperty.call(metricValues, "views")
    ) {
      return response({
        error: "invalid_content_metric",
        field: "reach_or_views",
      }, 400);
    }
    const observedMetricFields = METRIC_FIELDS.filter(
      (field) => Object.prototype.hasOwnProperty.call(metricValues, field),
    );
    const metric = {
      platform,
      campaign,
      content,
      format,
      hook: text(body?.hook),
      cta_variant: text(body?.cta_variant, 120),
      ...(publishedAt ? { published_at: publishedAt } : {}),
      snapshot_days: snapshotDays,
      snapshot_captured_at: capturedAt,
      ...metricValues,
      observed_metric_fields: observedMetricFields,
    };
    const fingerprint = await sha256(snapshotPayload(metric));
    const completeMetric = { ...metric, snapshot_fingerprint: fingerprint };

    const entities = base44.asServiceRole.entities;
    const repairGate = await bufferManualRepairGate(entities, {
      platform,
      campaign,
      content,
      snapshotDays,
      requestedPublishedAt: publishedAt,
    });
    if (!repairGate.allowed) {
      return response({ error: repairGate.error }, 409);
    }

    const entity = entities.GrowthContentMetric;
    const existingRecords = asArray(await entity.filter(
      { campaign, content, snapshot_days: snapshotDays },
      "-snapshot_captured_at",
      50,
    )).filter((record) => metricPlatform(record) === platform);
    if (latestCheckpointConflict(existingRecords)) {
      return response({ error: "content_snapshot_conflict" }, 409);
    }
    const existing = latestMetric(existingRecords);
    const existingCapturedAt = optionalTimestamp(existing?.snapshot_captured_at);
    if (existingCapturedAt && existingCapturedAt > capturedAt) {
      return response({
        error: "stale_content_snapshot",
        latest_snapshot_captured_at: existingCapturedAt,
      }, 409);
    }
    if (existingCapturedAt === capturedAt) {
      const existingFingerprint = existing?.snapshot_fingerprint
        || await sha256(snapshotPayload(existing));
      if (existingFingerprint !== fingerprint) {
        return response({ error: "content_snapshot_conflict" }, 409);
      }
      return response({
        success: true,
        created: false,
        idempotent: true,
        metric: { ...existing, platform },
      });
    }
    // Provider evidence is immutable. A manual repair becomes a newer,
    // provider-free checkpoint row instead of partially overwriting a Buffer
    // row and leaving stale provider IDs or hashes attached to manual values.
    const repairsAutomatedRow = existing?.id
      && normalized(existing?.metric_source) === "buffer";
    const saved = existing?.id && !repairsAutomatedRow
      ? await entity.update(existing.id, completeMetric)
      : await entity.create(completeMetric);

    return response({
      success: true,
      created: !existing?.id || repairsAutomatedRow,
      idempotent: false,
      metric: saved || { ...completeMetric, id: existing?.id },
    });
  } catch (error: any) {
    if (error instanceof SyntaxError) {
      return response({ error: "invalid_json" }, 400);
    }
    console.error("[upsertGrowthContentMetric]", error?.message || error);
    return response({ error: "content_metric_unavailable" }, 503);
  }
});
