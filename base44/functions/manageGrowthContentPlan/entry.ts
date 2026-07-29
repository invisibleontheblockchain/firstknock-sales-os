import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const FORMATS = new Set(["reel", "carousel", "story", "collab", "live", "other"]);
const PLATFORMS = new Set(["instagram", "tiktok"]);
const CTA_CHANNELS = new Set([
  "story_link",
  "dm_reply",
  "comment_reply",
  "bio",
  "caption_url",
]);
const SNAPSHOT_DAYS = new Set([1, 3, 7, 30]);
const DECISIONS = new Set(["repeat", "iterate", "hold"]);
const REVIEW_LOCKING_BATCH_STATES = new Set(["ready", "render_authorized"]);
const MAX_BODY_BYTES = 100_000;
const MAX_SEED_PLANS = 25;
const PAGE_SIZE = 5000;
const MAX_RECORDS = 25000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_GRACE_MS = DAY_MS;
const PLAN_DEFINITION_FIELDS = [
  "platform",
  "campaign",
  "content",
  "sprint",
  "sequence",
  "format",
  "audience",
  "hook",
  "script",
  "cta_label",
  "cta_channel",
  "primary_metric",
  "hypothesis",
  "comparison_group",
  "major_variable",
  "planned_publish_at",
  "snapshot_days",
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

function text(value: any, max: number): string {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function timestamp(value: any): string | null {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function timeValue(record: any, fields: string[]): number {
  for (const field of fields) {
    const parsed = new Date(record?.[field] || "");
    if (Number.isFinite(parsed.getTime())) return parsed.getTime();
  }
  return 0;
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function canManageGrowth(user: any): boolean {
  return user?.is_owner === true
    || normalized(user?.role) === "admin"
    || normalized(user?.app_role) === "admin";
}

function response(data: any, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function latest(
  records: any[],
  timeFields = ["updated_date", "created_date"],
): any | null {
  return [...records].sort((left, right) => (
    timeValue(right, timeFields)
      - timeValue(left, timeFields)
    || String(right?.id || "").localeCompare(String(left?.id || ""))
  ))[0] || null;
}

async function listAll(entity: any, label: string): Promise<any[]> {
  const records: any[] = [];
  for (let skip = 0; skip < MAX_RECORDS; skip += PAGE_SIZE) {
    const page = asArray(await entity.list("-created_date", PAGE_SIZE, skip));
    records.push(...page);
    if (page.length < PAGE_SIZE) return records;
  }
  throw new Error(`${label} exceeded the safe limit.`);
}

function socialPlatform(value: any): string {
  const platform = token(value);
  return PLATFORMS.has(platform) ? platform : "instagram";
}

function planKey(campaign: any, content: any, platform: any = "instagram"): string {
  return `${socialPlatform(platform)}|${token(campaign, "1000-users")}|${token(content)}`;
}

function batchLocksParentReview(batch: any, nowMs = Date.now()): boolean {
  const state = token(batch?.state);
  if (REVIEW_LOCKING_BATCH_STATES.has(state)) return true;
  if (state !== "generating") return false;
  const expiresMs = new Date(batch?.lease_expires_at || 0).getTime();
  return !Number.isFinite(expiresMs) || expiresMs > nowMs;
}

function metricKey(
  campaign: any,
  content: any,
  snapshotDays: any,
  platform: any = "instagram",
): string {
  const key = planKey(campaign, content, platform);
  return key.endsWith("|") ? "" : `${key}|${Number(snapshotDays || 7)}`;
}

function planLifecycleRank(plan: any): number {
  if (
    plan?.review_evidence_hash
    || plan?.review_snapshot_captured_at
    || plan?.review_decision
    || plan?.reviewed_at
  ) {
    return 2;
  }
  return timestamp(plan?.published_at) ? 1 : 0;
}

function planDefinitionPayload(plan: any): string {
  return JSON.stringify(Object.fromEntries(
    PLAN_DEFINITION_FIELDS.map((field) => [
      field,
      field === "platform" ? socialPlatform(plan?.platform) : plan?.[field] ?? null,
    ]),
  ));
}

function reviewPayload(plan: any): string {
  return JSON.stringify({
    decision: normalized(plan?.review_decision),
    note: String(plan?.review_note || ""),
    snapshot_captured_at: timestamp(plan?.review_snapshot_captured_at) || "",
    evidence_hash: String(plan?.review_evidence_hash || ""),
  });
}

function canonicalPlan(records: any[]): { record: any | null; conflict: boolean } {
  if (!records.length) return { record: null, conflict: false };
  const lifecycleRecords = records.filter((record) => planLifecycleRank(record) > 0);
  const publishedValues = new Set(
    lifecycleRecords
      .map((record) => timestamp(record?.published_at))
      .filter(Boolean),
  );
  const reviewedValues = new Set(
    lifecycleRecords
      .filter((record) => planLifecycleRank(record) === 2)
      .map(reviewPayload),
  );
  const executedDefinitions = new Set(lifecycleRecords.map(planDefinitionPayload));
  const conflict = publishedValues.size > 1
    || reviewedValues.size > 1
    || executedDefinitions.size > 1;
  const record = [...records].sort((left, right) => (
    planLifecycleRank(right) - planLifecycleRank(left)
    || timeValue(right, [
      "reviewed_at",
      "review_snapshot_captured_at",
      "published_at",
      "updated_date",
      "created_date",
    ])
      - timeValue(left, [
        "reviewed_at",
        "review_snapshot_captured_at",
        "published_at",
        "updated_date",
        "created_date",
      ])
    || String(right?.id || "").localeCompare(String(left?.id || ""))
  ))[0] || null;
  return { record, conflict };
}

function canonicalPlanMap(records: any[]): {
  records: Map<string, any>;
  conflictKey: string | null;
} {
  const grouped = new Map<string, any[]>();
  for (const record of records) {
    const key = planKey(record?.campaign, record?.content, record?.platform);
    if (!key || key.endsWith("|")) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(record);
  }
  const canonical = new Map<string, any>();
  for (const [key, values] of grouped.entries()) {
    const result = canonicalPlan(values);
    if (result.conflict) return { records: canonical, conflictKey: key };
    if (result.record) canonical.set(key, result.record);
  }
  return { records: canonical, conflictKey: null };
}

function normalizePlan(value: any): any | null {
  const platform = token(value?.platform, "instagram");
  const campaign = token(value?.campaign, "1000-users");
  const content = token(value?.content);
  const sprint = token(value?.sprint);
  const sequence = Number(value?.sequence);
  const format = token(value?.format);
  const audience = text(value?.audience, 300);
  const hook = text(value?.hook, 300);
  const script = text(value?.script, 2500);
  const ctaLabel = text(value?.cta_label, 160);
  const ctaChannel = token(value?.cta_channel);
  const primaryMetric = text(value?.primary_metric, 160);
  const hypothesis = text(value?.hypothesis, 500);
  const comparisonGroup = token(value?.comparison_group);
  const majorVariable = text(value?.major_variable, 160);
  const plannedPublishAt = timestamp(value?.planned_publish_at);
  const snapshotDays = Number(value?.snapshot_days || 7);

  if (
    !PLATFORMS.has(platform)
    || !content
    || !sprint
    || !Number.isSafeInteger(sequence)
    || sequence < 1
    || sequence > 10000
    || !FORMATS.has(format)
    || !audience
    || !hook
    || !script
    || !ctaLabel
    || !CTA_CHANNELS.has(ctaChannel)
    || !primaryMetric
    || !hypothesis
    || !comparisonGroup
    || !majorVariable
    || !plannedPublishAt
    || !SNAPSHOT_DAYS.has(snapshotDays)
  ) {
    return null;
  }

  return {
    platform,
    campaign,
    content,
    sprint,
    sequence,
    format,
    audience,
    hook,
    script,
    cta_label: ctaLabel,
    cta_channel: ctaChannel,
    primary_metric: primaryMetric,
    hypothesis,
    comparison_group: comparisonGroup,
    major_variable: majorVariable,
    planned_publish_at: plannedPublishAt,
    snapshot_days: snapshotDays,
  };
}

function snapshotPayload(metric: any): string {
  return JSON.stringify({
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
  });
}

function metricConflictKey(records: any[]): string | null {
  const grouped = new Map<string, any[]>();
  for (const record of records) {
    const key = metricKey(
      record?.campaign,
      record?.content,
      record?.snapshot_days,
      record?.platform,
    );
    if (!key || key.endsWith("|")) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(record);
  }
  for (const [key, values] of grouped.entries()) {
    const latestCapturedAt = Math.max(
      ...values.map((record) => timeValue(record, ["snapshot_captured_at"])),
    );
    const latestCandidates = values.filter(
      (record) => timeValue(record, ["snapshot_captured_at"]) === latestCapturedAt,
    );
    if (new Set(latestCandidates.map(snapshotPayload)).size > 1) return key;
  }
  return null;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalByKey(
  records: any[],
  keyFor: (record: any) => string,
  timeFields = ["updated_date", "created_date"],
): Map<string, any> {
  const grouped = new Map<string, any[]>();
  for (const record of records) {
    const key = keyFor(record);
    if (!key || key.endsWith("|")) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(record);
  }
  return new Map(
    [...grouped.entries()].map(([key, values]) => [key, latest(values, timeFields)]),
  );
}

function providerOwnsPlan(plan: any): boolean {
  return Boolean(
    timestamp(plan?.published_at)
    || token(plan?.sprint) === "content-engine"
    || token(plan?.delivery_managed_by) === "buffer",
  );
}

async function contentEngineOwnsKey(
  artifactEntity: any,
  platform: string,
  campaign: string,
  content: string,
): Promise<boolean> {
  const rows = asArray(await artifactEntity.filter(
    {
      platform,
      campaign,
      platform_content_id: content,
    },
    "-updated_date",
    20,
  ));
  return rows.length > 0;
}

async function currentPlanForKey(
  planEntity: any,
  platform: string,
  campaign: string,
  content: string,
): Promise<{ record: any | null; conflict: boolean }> {
  return canonicalPlan(asArray(await planEntity.filter(
    { campaign, content },
    "-updated_date",
    50,
  )).filter((record) => socialPlatform(record?.platform) === platform));
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

    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
      return response({ error: "content_plan_too_large" }, 413);
    }
    const body = JSON.parse(rawBody || "{}");
    const action = normalized(body?.action);
    const planEntity = base44.asServiceRole.entities.GrowthContentPlan;
    const artifactEntity = base44.asServiceRole.entities.GrowthCreativeArtifact;

    if (action === "seed") {
      if (
        !Array.isArray(body?.plans)
        || body.plans.length < 1
        || body.plans.length > MAX_SEED_PLANS
      ) {
        return response({ error: "invalid_content_plan_batch" }, 400);
      }
      const plans = body.plans.map(normalizePlan);
      if (plans.some((plan: any) => !plan)) {
        return response({ error: "invalid_content_plan" }, 400);
      }

      // Read the complete current queue before writing so a lookup outage never
      // fails open into duplicate creates. Partial writes remain retry-safe.
      const existingResult = canonicalPlanMap(
        await listAll(planEntity, "Growth content plan"),
      );
      if (existingResult.conflictKey) {
        return response({
          error: "content_plan_conflict",
          content_key: existingResult.conflictKey,
        }, 409);
      }
      const existing = existingResult.records;
      let created = 0;
      let updated = 0;
      let preserved = 0;
      for (const plan of plans) {
        const key = planKey(plan.campaign, plan.content, plan.platform);
        if (await contentEngineOwnsKey(
          artifactEntity,
          plan.platform,
          plan.campaign,
          plan.content,
        )) {
          preserved += 1;
          continue;
        }
        const liveResult = await currentPlanForKey(
          planEntity,
          plan.platform,
          plan.campaign,
          plan.content,
        );
        if (liveResult.conflict) {
          return response({
            error: "content_plan_conflict",
            content_key: key,
          }, 409);
        }
        const current = liveResult.record || existing.get(key);
        if (current?.id) {
          if (providerOwnsPlan(current)) {
            // Once an asset is published, its creative definition and snapshot
            // horizon are historical evidence. Provider-managed definitions are
            // owned by the approved content-engine artifact and publish job even
            // before delivery. A sprint sync may repair missing manual plans, but
            // it cannot rewrite either kind of measurement contract.
            preserved += 1;
          } else {
            const result = await planEntity.updateMany(
              {
                id: current.id,
                updated_date: current.updated_date,
              },
              { $set: plan },
            );
            if (Number(result?.updated || 0) === 1) {
              updated += 1;
            } else {
              const raced = await currentPlanForKey(
                planEntity,
                plan.platform,
                plan.campaign,
                plan.content,
              );
              if (
                !raced.conflict
                && raced.record?.id
                && (
                  providerOwnsPlan(raced.record)
                  || await contentEngineOwnsKey(
                    artifactEntity,
                    plan.platform,
                    plan.campaign,
                    plan.content,
                  )
                )
              ) {
                preserved += 1;
              } else {
                return response({
                  error: raced.conflict
                    ? "content_plan_conflict"
                    : "content_plan_changed_during_seed",
                  content_key: key,
                }, 409);
              }
            }
          }
        } else {
          if (await contentEngineOwnsKey(
            artifactEntity,
            plan.platform,
            plan.campaign,
            plan.content,
          )) {
            preserved += 1;
            continue;
          }
          const raced = await currentPlanForKey(
            planEntity,
            plan.platform,
            plan.campaign,
            plan.content,
          );
          if (raced.conflict) {
            return response({
              error: "content_plan_conflict",
              content_key: key,
            }, 409);
          }
          if (raced.record?.id) {
            if (providerOwnsPlan(raced.record)) {
              preserved += 1;
              continue;
            }
            return response({
              error: "content_plan_changed_during_seed",
              content_key: key,
            }, 409);
          }
          const saved = await planEntity.create(plan);
          const verified = await currentPlanForKey(
            planEntity,
            plan.platform,
            plan.campaign,
            plan.content,
          );
          if (verified.conflict || !verified.record?.id) {
            return response({
              error: "content_plan_conflict",
              content_key: key,
            }, 409);
          }
          existing.set(key, saved || plan);
          created += 1;
        }
      }
      return response({
        success: true,
        created,
        updated,
        preserved,
        total: plans.length,
      });
    }

    const requestedPlatform = token(body?.platform, "instagram");
    if (!PLATFORMS.has(requestedPlatform)) {
      return response({ error: "invalid_content_plan" }, 400);
    }
    const platform = requestedPlatform;
    const campaign = token(body?.campaign, "1000-users");
    const content = token(body?.content);
    if (!content) return response({ error: "invalid_content_plan" }, 400);
    const currentResult = await currentPlanForKey(
      planEntity,
      platform,
      campaign,
      content,
    );
    if (currentResult.conflict) {
      return response({ error: "content_plan_conflict" }, 409);
    }
    const current = currentResult.record;
    if (!current?.id) return response({ error: "content_plan_not_found" }, 404);

    if (action === "publish") {
      if (
        token(current?.sprint) === "content-engine"
        || token(current?.delivery_managed_by) === "buffer"
      ) {
        return response({ error: "provider_managed_publication" }, 409);
      }
      if (current?.published_at) {
        return response({
          success: true,
          idempotent: true,
          published_at: current.published_at,
        });
      }
      const hasPublishedAt = Object.prototype.hasOwnProperty.call(body, "published_at");
      const publishedAt = hasPublishedAt
        ? timestamp(body.published_at)
        : new Date().toISOString();
      if (!publishedAt) {
        return response({ error: "invalid_published_at" }, 400);
      }
      if (new Date(publishedAt).getTime() > Date.now() + 5 * 60 * 1000) {
        return response({ error: "invalid_published_at" }, 400);
      }
      const published = await planEntity.updateMany(
        {
          id: current.id,
          updated_date: current.updated_date,
        },
        { $set: { published_at: publishedAt } },
      );
      if (Number(published?.updated || 0) !== 1) {
        const raced = await currentPlanForKey(
          planEntity,
          platform,
          campaign,
          content,
        );
        if (raced.conflict) {
          return response({ error: "content_plan_conflict" }, 409);
        }
        if (
          token(raced.record?.sprint) === "content-engine"
          || token(raced.record?.delivery_managed_by) === "buffer"
        ) {
          return response({ error: "provider_managed_publication" }, 409);
        }
        if (raced.record?.published_at) {
          return response({
            success: true,
            idempotent: true,
            published_at: raced.record.published_at,
          });
        }
        return response({ error: "content_plan_changed_before_publish" }, 409);
      }
      return response({
        success: true,
        idempotent: false,
        published_at: publishedAt,
      });
    }

    if (action === "review") {
      const decision = normalized(body?.decision);
      const note = text(body?.note, 500);
      if (!DECISIONS.has(decision) || note.length < 5) {
        return response({ error: "invalid_growth_decision" }, 400);
      }
      const batchEntity = base44.asServiceRole.entities.GrowthContentBatch;
      const descendants = asArray(await batchEntity.filter(
        {
          parent_campaign: campaign,
          parent_content: content,
        },
        "-state_changed_at",
        100,
      )).filter(
        (batch) => socialPlatform(batch?.parent_platform) === platform,
      );
      if (descendants.length >= 100) {
        return response({ error: "growth_batch_lineage_conflict" }, 409);
      }
      if (descendants.some((batch) => batchLocksParentReview(batch))) {
        return response({
          error: "growth_review_lineage_locked",
          message:
            "Revoke the active downstream batch before changing its reviewed parent decision.",
        }, 409);
      }
      const publishedAt = timestamp(current?.published_at);
      if (!publishedAt) return response({ error: "content_not_published" }, 409);
      const snapshotDays = Number(current?.snapshot_days || 7);
      const metricEntity = base44.asServiceRole.entities.GrowthContentMetric;
      const metricRecords = asArray(await metricEntity.filter(
          { campaign, content, snapshot_days: snapshotDays },
          "-snapshot_captured_at",
          50,
      )).filter((record) => socialPlatform(record?.platform) === platform);
      if (metricConflictKey(metricRecords)) {
        return response({ error: "content_snapshot_conflict" }, 409);
      }
      const metric = latest(
        metricRecords,
        ["snapshot_captured_at", "updated_date", "created_date"],
      );
      const capturedAt = timestamp(metric?.snapshot_captured_at);
      const dueAt = new Date(
        new Date(publishedAt).getTime() + snapshotDays * DAY_MS,
      ).toISOString();
      const windowClosesAt = new Date(
        new Date(dueAt).getTime() + SNAPSHOT_GRACE_MS,
      ).toISOString();
      if (!metric?.id || !capturedAt || capturedAt < dueAt) {
        return response({ error: "fixed_age_snapshot_required", due_at: dueAt }, 409);
      }
      if (capturedAt > windowClosesAt) {
        return response({
          error: "fixed_age_snapshot_window_missed",
          due_at: dueAt,
          window_closes_at: windowClosesAt,
          captured_at: capturedAt,
        }, 409);
      }

      if (decision === "hold") {
        const [allPlans, allMetrics] = await Promise.all([
          listAll(planEntity, "Growth content plan"),
          listAll(metricEntity, "Growth content metric"),
        ]);
        const canonicalPlanResult = canonicalPlanMap(allPlans);
        if (canonicalPlanResult.conflictKey) {
          return response({
            error: "content_plan_conflict",
            content_key: canonicalPlanResult.conflictKey,
          }, 409);
        }
        const canonicalPlans = canonicalPlanResult.records;
        const metricConflict = metricConflictKey(allMetrics);
        if (metricConflict) {
          return response({
            error: "content_snapshot_conflict",
            content_key: metricConflict,
          }, 409);
        }
        const canonicalMetrics = canonicalByKey(
          allMetrics,
          (record) => metricKey(
            record?.campaign,
            record?.content,
            record?.snapshot_days,
            record?.platform,
          ),
          ["snapshot_captured_at", "updated_date", "created_date"],
        );
        let comparableSnapshots = 0;
        for (const plan of canonicalPlans.values()) {
          if (
            socialPlatform(plan?.platform) !== platform
            || normalized(plan?.campaign) !== normalized(current?.campaign)
            || normalized(plan?.comparison_group) !== normalized(current?.comparison_group)
            || Number(plan?.snapshot_days || 7) !== snapshotDays
          ) {
            continue;
          }
          const planPublishedAt = timestamp(plan?.published_at);
          const planSnapshotDays = Number(plan?.snapshot_days || 7);
          const comparableMetric = canonicalMetrics.get(metricKey(
            plan?.campaign,
            plan?.content,
            planSnapshotDays,
            plan?.platform,
          ));
          const comparableCapturedAt = timestamp(comparableMetric?.snapshot_captured_at);
          const comparableDueAt = planPublishedAt
            ? new Date(planPublishedAt).getTime() + planSnapshotDays * DAY_MS
            : 0;
          if (
            planPublishedAt
            && comparableCapturedAt
            && new Date(comparableCapturedAt).getTime() >= comparableDueAt
            && new Date(comparableCapturedAt).getTime()
              <= comparableDueAt + SNAPSHOT_GRACE_MS
          ) {
            comparableSnapshots += 1;
          }
        }
        if (comparableSnapshots < 3) {
          return response({
            error: "hold_requires_three_comparable_snapshots",
            comparable_snapshots: comparableSnapshots,
          }, 409);
        }
      }

      const evidenceHash = metric?.snapshot_fingerprint
        || await sha256(snapshotPayload(metric));
      if (!metric?.snapshot_fingerprint) {
        await metricEntity.update(metric.id, { snapshot_fingerprint: evidenceHash });
      }
      const reviewedAt = new Date().toISOString();
      await planEntity.update(current.id, {
        review_decision: decision,
        review_note: note,
        reviewed_at: reviewedAt,
        review_snapshot_captured_at: capturedAt,
        review_evidence_hash: evidenceHash,
      });
      return response({
        success: true,
        decision,
        reviewed_at: reviewedAt,
        evidence_hash: evidenceHash,
      });
    }

    return response({ error: "invalid_content_plan_action" }, 400);
  } catch (error: any) {
    if (error instanceof SyntaxError) {
      return response({ error: "invalid_json" }, 400);
    }
    console.error("[manageGrowthContentPlan]", error?.message || error);
    return response({ error: "content_plan_unavailable" }, 503);
  }
});
