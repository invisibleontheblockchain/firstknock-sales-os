import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import {
  evaluateGrowthDecisionSufficiency,
  GROWTH_DECISION_POLICY_ID,
  GROWTH_REVIEW_SCHEMA_VERSION,
  isNontrivialGrowthDecisionOverride,
  normalizeGrowthDecisionOverrideNote,
} from "../_shared/growthDecisionSufficiency.js";

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
const CONVERSION_EVIDENCE_SCHEMA = "growth-conversion-evidence.v2";
const DECLARED_CLICKABLE_HANDOFFS = new Set([
  "story_link",
  "dm_reply",
  "comment_reply",
]);
const CONVERSION_COUNTER_FIELDS = [
  "landing_sessions",
  "signup_cta_sessions",
  "auth_completed",
  "decision_signups",
  "decision_activated_workspaces",
  "activated_users",
  "activated_reps",
  "paid_users",
];
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

function canonicalStringify(value: any): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalStringify(nested)}`)
    .join(",")}}`;
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
    || plan?.review_conversion_evidence_hash
    || plan?.review_conversion_cutoff_at
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
  return canonicalStringify({
    review_schema_version: normalized(plan?.review_schema_version),
    decision: normalized(plan?.review_decision),
    note: String(plan?.review_note || ""),
    snapshot_captured_at: timestamp(plan?.review_snapshot_captured_at) || "",
    evidence_hash: String(plan?.review_evidence_hash || ""),
    conversion_cutoff_at: timestamp(plan?.review_conversion_cutoff_at) || "",
    conversion_evidence_hash:
      String(plan?.review_conversion_evidence_hash || ""),
    conversion_evidence: plan?.review_conversion_evidence || null,
    decision_policy_id: normalized(plan?.review_decision_policy_id),
    decision_policy_reason_codes: Array.isArray(
      plan?.review_decision_policy_reason_codes,
    ) ? plan.review_decision_policy_reason_codes : [],
    decision_policy_evidence_hash:
      String(plan?.review_decision_policy_evidence_hash || ""),
    comparable_fixed_age_snapshots:
      Number(plan?.review_comparable_fixed_age_snapshots || 0),
    decision_override_note: String(plan?.review_decision_override_note || ""),
    decision_override_hash: String(plan?.review_decision_override_hash || ""),
    review_identity_hash: String(plan?.review_identity_hash || ""),
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

function snapshotPayload(metric: any): string {
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

function nonNegativeInteger(value: any): number {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function exactNonNegativeInteger(value: any): number | null {
  return typeof value === "number"
      && Number.isSafeInteger(value)
      && value >= 0
    ? value
    : null;
}

function platformNativeExposure(metric: any): {
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

async function comparableFixedAgeSnapshotCount(
  plans: Map<string, any>,
  metrics: Map<string, any>,
  current: any,
): Promise<number> {
  const platform = socialPlatform(current?.platform);
  const campaign = token(current?.campaign, "1000-users");
  const comparisonGroup = normalized(current?.comparison_group);
  const snapshotDays = Number(current?.snapshot_days || 7);
  let count = 0;
  for (const plan of plans.values()) {
    if (
      socialPlatform(plan?.platform) !== platform
      || token(plan?.campaign, "1000-users") !== campaign
      || normalized(plan?.comparison_group) !== comparisonGroup
      || Number(plan?.snapshot_days || 7) !== snapshotDays
    ) {
      continue;
    }
    const publishedAt = timestamp(plan?.published_at);
    const metric = metrics.get(metricKey(
      plan?.campaign,
      plan?.content,
      snapshotDays,
      plan?.platform,
    ));
    const capturedAt = timestamp(metric?.snapshot_captured_at);
    if (!publishedAt || !capturedAt || !metric?.id) continue;
    const dueMs = new Date(publishedAt).getTime() + snapshotDays * DAY_MS;
    const capturedMs = new Date(capturedAt).getTime();
    if (
      capturedMs < dueMs
      || capturedMs > dueMs + SNAPSHOT_GRACE_MS
      || platformNativeExposure(metric).fields.length < 1
    ) {
      continue;
    }
    const computedFingerprint = await sha256(snapshotPayload(metric));
    const storedFingerprint = normalized(metric?.snapshot_fingerprint);
    if (storedFingerprint && storedFingerprint !== computedFingerprint) {
      continue;
    }
    count += 1;
  }
  return count;
}

async function reviewIdentityHash({
  evidenceHash,
  conversionEvidenceHash,
  conversionCutoffAt,
  decision,
  note,
  reviewedAt,
  capturedAt,
  policy,
}: any): Promise<string> {
  return sha256(canonicalStringify({
    review_schema_version: GROWTH_REVIEW_SCHEMA_VERSION,
    evidence_hash: evidenceHash,
    conversion_evidence_hash: conversionEvidenceHash,
    conversion_cutoff_at: conversionCutoffAt,
    decision,
    decision_note: note,
    reviewed_at: reviewedAt,
    review_snapshot_captured_at: capturedAt,
    decision_policy_id: policy.policy_id,
    decision_policy_reason_codes: policy.reason_codes,
    decision_policy_evidence_hash: policy.evidence_hash,
    decision_override_note: policy.override_note || "",
    decision_override_hash: policy.override_hash || "",
  }));
}

async function loadControlledConversionEvidence(
  base44: any,
  {
    platform,
    campaign,
    content,
    metric,
    socialEvidenceHash,
    windowClosesAt,
    publishedAt,
    ctaChannel,
  }: any,
): Promise<any> {
  let invocation: any;
  try {
    if (typeof base44?.functions?.invoke !== "function") {
      return { error: "conversion_evidence_unavailable", status: 503 };
    }
    // Use the request-bound client so getAcquisitionReport authenticates the
    // same owner/admin. Its service-role reads remain behind its own auth gate.
    invocation = await base44.functions.invoke(
      "getAcquisitionReport",
      {
        platform,
        campaign,
        content,
        snapshot_captured_at: timestamp(metric?.snapshot_captured_at),
        conversion_cutoff_at: timestamp(metric?.snapshot_captured_at),
      },
    );
  } catch {
    return { error: "conversion_evidence_unavailable", status: 503 };
  }
  const report = invocation?.data?.data
    ?? invocation?.data
    ?? invocation;
  const reportGeneratedAt = timestamp(report?.generated_at);
  const snapshotCapturedAt = timestamp(metric?.snapshot_captured_at);
  const cohortStartAt = timestamp(publishedAt);
  const snapshotMs = snapshotCapturedAt
    ? new Date(snapshotCapturedAt).getTime()
    : 0;
  const cohortStartMs = cohortStartAt
    ? new Date(cohortStartAt).getTime()
    : 0;
  const reportGeneratedMs = reportGeneratedAt
    ? new Date(reportGeneratedAt).getTime()
    : 0;
  const windowCloseMs = new Date(windowClosesAt || 0).getTime();
  if (
    report?.success !== true
    || !reportGeneratedAt
    || !snapshotCapturedAt
    || !cohortStartAt
    || !Number.isFinite(windowCloseMs)
    || snapshotMs < cohortStartMs
    || snapshotMs > windowCloseMs
    || snapshotMs > Date.now() + 5 * 60 * 1000
    || reportGeneratedMs < snapshotMs
    || reportGeneratedMs > Date.now() + 5 * 60 * 1000
    || !Array.isArray(report?.by_content)
    || normalized(report?.request_scope?.platform) !== platform
    || token(report?.request_scope?.campaign) !== campaign
    || token(report?.request_scope?.content) !== content
    || timestamp(report?.request_scope?.cohort_start_at) !== cohortStartAt
    || timestamp(report?.request_scope?.conversion_cutoff_at) !== snapshotCapturedAt
  ) {
    return { error: "conversion_evidence_unavailable", status: 503 };
  }
  const rows = report.by_content.filter((row: any) => (
    token(row?.source || row?.platform) === platform
    && token(row?.campaign) === campaign
    && token(row?.content) === content
  ));
  if (rows.length !== 1) {
    return {
      error: rows.length
        ? "conversion_evidence_conflict"
        : "conversion_evidence_unavailable",
      status: rows.length ? 409 : 503,
    };
  }
  const row = rows[0];
  const exactHandoff = DECLARED_CLICKABLE_HANDOFFS.has(normalized(ctaChannel));
  const expectedConclusion = exactHandoff
    ? "exact_declared_link"
    : "inconclusive_no_declared_link";
  const expectedAttributionMethod = exactHandoff
    ? "declared_content_link"
    : "social_evidence_only";
  if (
    normalized(row?.attribution_granularity) !== "content"
    || normalized(row?.attribution_method) !== expectedAttributionMethod
    || normalized(row?.conversion_conclusion) !== expectedConclusion
    || row?.post_conversion_eligible !== exactHandoff
    || row?.conversion_counters_available !== exactHandoff
    || timestamp(row?.cohort_start_at) !== cohortStartAt
    || timestamp(row?.conversion_cutoff_at) !== snapshotCapturedAt
  ) {
    return { error: "conversion_evidence_ineligible", status: 409 };
  }
  const rowLinkClicks = exactNonNegativeInteger(row?.link_clicks);
  const rowDmIntents = exactNonNegativeInteger(row?.dm_intents);
  const rowOwnedIntents = exactNonNegativeInteger(row?.owned_intents);
  const counters = Object.fromEntries(CONVERSION_COUNTER_FIELDS.map((field) => [
    field,
    exactNonNegativeInteger(row?.[field]),
  ]));
  const retentionEligibleUsers = exactNonNegativeInteger(
    row?.retention_eligible_users,
  );
  const retainedUsers = exactNonNegativeInteger(row?.retained_users);
  const retentionRate = typeof row?.retention_rate === "number"
      && Number.isFinite(row.retention_rate)
      && row.retention_rate >= 0
      && row.retention_rate <= 1
    ? row.retention_rate
    : null;
  const firstActivationAt = timestamp(row?.first_activation_at);
  const lastActivationAt = timestamp(row?.last_activation_at);
  const expectedRetentionMature = snapshotMs
    >= cohortStartMs + 30 * DAY_MS;
  const exclusionFields = [
    "missing_event_timestamps",
    "missing_user_timestamps",
    "activation_timing_missing_users",
    "paid_timing_missing_users",
    "excluded_prepublication_events",
    "excluded_post_cutoff_events",
    "excluded_synthetic_events",
    "excluded_prepublication_users",
    "excluded_post_cutoff_users",
    "excluded_invalid_timing_users",
    "excluded_synthetic_users",
  ];
  const exclusions = Object.fromEntries(exclusionFields.map((field) => [
    field,
    exactNonNegativeInteger(row?.[field]),
  ]));
  const exactCountersValid = Object.values(counters).every(
    (value) => value !== null,
  );
  const exactRetentionValid = retentionEligibleUsers !== null
    && retainedUsers !== null
    && retainedUsers <= retentionEligibleUsers
    && (expectedRetentionMature || (
      retentionEligibleUsers === 0 && retainedUsers === 0
    ))
    && (
      retentionEligibleUsers === 0
        ? row?.retention_rate === null
        : retentionRate !== null
          && Math.abs(retentionRate - retainedUsers / retentionEligibleUsers) < 1e-12
    )
    && row?.retention_mature === expectedRetentionMature
    && Number(row?.retention_window_days) === 30
    && row?.activation_timing_complete === true
    && row?.paid_timing_complete === true;
  const activatedUsers = counters.activated_users;
  const exactActivationDatesValid = activatedUsers === 0
    ? row?.first_activation_at === null && row?.last_activation_at === null
    : Boolean(
      firstActivationAt
      && lastActivationAt
      && new Date(firstActivationAt).getTime() >= cohortStartMs
      && new Date(firstActivationAt).getTime()
        <= new Date(lastActivationAt).getTime()
      && new Date(lastActivationAt).getTime() <= snapshotMs,
    );
  const socialNullFields = [
    ...CONVERSION_COUNTER_FIELDS,
    "retention_eligible_users",
    "retained_users",
    "retention_rate",
    "first_activation_at",
    "last_activation_at",
  ];
  if (
    rowLinkClicks === null
    || rowDmIntents === null
    || rowOwnedIntents === null
    || rowOwnedIntents !== rowLinkClicks + rowDmIntents
    || Number(row?.snapshot_days) !== Number(metric?.snapshot_days || 7)
    || Object.values(exclusions).some((value) => value === null)
    || (
      exactHandoff
        ? !exactCountersValid || !exactRetentionValid || !exactActivationDatesValid
        : socialNullFields.some((field) => row?.[field] !== null)
          || row?.activation_timing_complete !== false
          || row?.paid_timing_complete !== false
          || Number(row?.retention_window_days) !== 30
          || typeof row?.retention_mature !== "boolean"
    )
  ) {
    return { error: "conversion_evidence_mismatch", status: 409 };
  }
  const observedMetricFields = metricObservedFields(metric)
    || CONTENT_METRIC_FIELDS.filter(
      (field) => Object.prototype.hasOwnProperty.call(metric || {}, field),
    );
  const ownedIntentObservedFields = ["link_clicks", "dm_intents"].filter(
    (field) => observedMetricFields.includes(field),
  );
  const linkClicks = ownedIntentObservedFields.includes("link_clicks")
    ? nonNegativeInteger(metric?.link_clicks)
    : 0;
  const dmIntents = ownedIntentObservedFields.includes("dm_intents")
    ? nonNegativeInteger(metric?.dm_intents)
    : 0;
  if (
    (ownedIntentObservedFields.includes("link_clicks")
      && rowLinkClicks !== linkClicks)
    || (ownedIntentObservedFields.includes("dm_intents")
      && rowDmIntents !== dmIntents)
  ) {
    return { error: "conversion_evidence_mismatch", status: 409 };
  }
  const evidence = {
    schema_version: CONVERSION_EVIDENCE_SCHEMA,
    platform,
    campaign,
    content,
    cohort_start_at: cohortStartAt,
    cutoff_at: snapshotCapturedAt,
    snapshot_days: Number(metric?.snapshot_days || 7),
    snapshot_captured_at: snapshotCapturedAt,
    social_evidence_hash: socialEvidenceHash,
    owned_intent_observed_fields: ownedIntentObservedFields,
    link_clicks: linkClicks,
    dm_intents: dmIntents,
    owned_intents: linkClicks + dmIntents,
    attribution_method: expectedAttributionMethod,
    post_conversion_eligible: exactHandoff,
    conversion_conclusion: expectedConclusion,
    conversion_counters_available: exactHandoff,
    landing_sessions: exactHandoff ? counters.landing_sessions : null,
    signup_cta_sessions: exactHandoff ? counters.signup_cta_sessions : null,
    auth_completed: exactHandoff ? counters.auth_completed : null,
    signups: exactHandoff ? counters.decision_signups : null,
    activated_workspaces: exactHandoff
      ? counters.decision_activated_workspaces
      : null,
    activated_users: exactHandoff ? counters.activated_users : null,
    activated_reps: exactHandoff ? counters.activated_reps : null,
    paid_users: exactHandoff ? counters.paid_users : null,
    activation_timing_complete: exactHandoff,
    paid_timing_complete: exactHandoff,
    first_activation_at: exactHandoff ? firstActivationAt : null,
    last_activation_at: exactHandoff ? lastActivationAt : null,
    retention_window_days: 30,
    retention_mature: row.retention_mature === true,
    retention_eligible_users: exactHandoff ? retentionEligibleUsers : null,
    retained_users: exactHandoff ? retainedUsers : null,
    retention_rate: exactHandoff ? row.retention_rate : null,
  };
  return {
    evidence,
    evidenceHash: await sha256(canonicalStringify(evidence)),
  };
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
      const requestedPolicyId = normalized(body?.decision_policy_id);
      if (requestedPolicyId && requestedPolicyId !== GROWTH_DECISION_POLICY_ID) {
        return response({
          error: "invalid_growth_decision_policy",
          policy_id: GROWTH_DECISION_POLICY_ID,
        }, 409);
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

      const computedEvidenceHash = await sha256(snapshotPayload(metric));
      const storedEvidenceHash = normalized(metric?.snapshot_fingerprint);
      if (storedEvidenceHash && storedEvidenceHash !== computedEvidenceHash) {
        return response({ error: "content_snapshot_conflict" }, 409);
      }
      const evidenceHash = computedEvidenceHash;
      const expectedEvidenceHash = normalized(
        body?.expected_social_evidence_hash,
      );
      const expectedCapturedAt = timestamp(body?.expected_snapshot_captured_at);
      if (
        (expectedEvidenceHash && expectedEvidenceHash !== evidenceHash)
        || (body?.expected_snapshot_captured_at && expectedCapturedAt !== capturedAt)
      ) {
        return response({
          error: "growth_decision_policy_stale",
          policy_id: GROWTH_DECISION_POLICY_ID,
        }, 409);
      }
      const conversion = await loadControlledConversionEvidence(base44, {
        platform,
        campaign,
        content,
        metric,
        socialEvidenceHash: evidenceHash,
        windowClosesAt,
        publishedAt,
        ctaChannel: current?.cta_channel,
      });
      if (conversion?.error || !conversion?.evidence || !conversion?.evidenceHash) {
        return response(
          { error: conversion?.error || "conversion_evidence_unavailable" },
          conversion?.status || 503,
        );
      }
      let comparableSnapshots = 0;
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
        comparableSnapshots = await comparableFixedAgeSnapshotCount(
          canonicalPlanResult.records,
          canonicalMetrics,
          current,
        );
        if (
          Object.prototype.hasOwnProperty.call(
            body,
            "expected_comparable_fixed_age_snapshots",
          )
          && Number(body.expected_comparable_fixed_age_snapshots)
            !== comparableSnapshots
        ) {
          return response({
            error: "growth_decision_policy_stale",
            policy_id: GROWTH_DECISION_POLICY_ID,
          }, 409);
        }
      }
      const overrideNote = normalizeGrowthDecisionOverrideNote(body?.override_note);
      const overrideHash = isNontrivialGrowthDecisionOverride(overrideNote)
        ? await sha256(overrideNote)
        : "";
      const exposure = platformNativeExposure(metric);
      const policy = evaluateGrowthDecisionSufficiency({
        decision,
        fixed_age_snapshot_valid: true,
        social_evidence_hash: evidenceHash,
        snapshot_days: snapshotDays,
        snapshot_captured_at: capturedAt,
        observed_platform_native_exposure_fields: exposure.fields,
        platform_native_exposure: exposure.values,
        conversion_evidence: conversion.evidence,
        comparable_fixed_age_snapshots: comparableSnapshots,
        override_note: overrideNote,
        override_hash: overrideHash,
      });
      const policyEvidenceHash = await sha256(
        canonicalStringify(policy.evidence),
      );
      const expectedPolicyEvidenceHash = normalized(
        body?.expected_decision_policy_evidence_hash,
      );
      if (
        expectedPolicyEvidenceHash
        && expectedPolicyEvidenceHash !== policyEvidenceHash
      ) {
        return response({
          error: "growth_decision_policy_stale",
          policy_id: GROWTH_DECISION_POLICY_ID,
        }, 409);
      }
      if (!policy.supported) {
        const unsupportedError = policy.reason_codes.includes(
          "hold_three_comparable_snapshots_required",
        )
          ? "hold_requires_three_comparable_snapshots"
          : "growth_decision_not_supported";
        return response({
          error: unsupportedError,
          policy_id: policy.policy_id,
          reason_codes: policy.reason_codes,
          comparable_fixed_age_snapshots: comparableSnapshots,
        }, 409);
      }
      if (overrideNote && !policy.override_note) {
        return response({
          error: "invalid_growth_decision_override",
          policy_id: policy.policy_id,
          reason_codes: policy.reason_codes,
        }, 409);
      }
      if (!storedEvidenceHash) {
        await metricEntity.update(metric.id, { snapshot_fingerprint: evidenceHash });
      }
      const reviewedAt = new Date().toISOString();
      const boundPolicy = {
        ...policy,
        evidence_hash: policyEvidenceHash,
      };
      const identityHash = await reviewIdentityHash({
        evidenceHash,
        conversionEvidenceHash: conversion.evidenceHash,
        conversionCutoffAt: conversion.evidence.cutoff_at,
        decision,
        note,
        reviewedAt,
        capturedAt,
        policy: boundPolicy,
      });
      const reviewFields = {
        review_schema_version: GROWTH_REVIEW_SCHEMA_VERSION,
        review_decision: decision,
        review_note: note,
        reviewed_at: reviewedAt,
        review_snapshot_captured_at: capturedAt,
        review_evidence_hash: evidenceHash,
        review_conversion_cutoff_at: conversion.evidence.cutoff_at,
        review_conversion_evidence_hash: conversion.evidenceHash,
        review_conversion_evidence: conversion.evidence,
        review_decision_policy_id: policy.policy_id,
        review_decision_policy_reason_codes: policy.reason_codes,
        review_decision_policy_evidence_hash: policyEvidenceHash,
        review_comparable_fixed_age_snapshots: comparableSnapshots,
        ...(policy.override_note ? {
          review_decision_override_note: policy.override_note,
          review_decision_override_hash: policy.override_hash,
        } : {}),
        review_identity_hash: identityHash,
      };
      const reviewQuery: any = { id: current.id };
      if (current?.updated_date) reviewQuery.updated_date = current.updated_date;
      const reviewUpdate: any = { $set: reviewFields };
      if (!policy.override_note) {
        reviewUpdate.$unset = {
          review_decision_override_note: true,
          review_decision_override_hash: true,
        };
      }
      const saved = await planEntity.updateMany(reviewQuery, reviewUpdate);
      if (Number(saved?.updated || 0) !== 1) {
        return response({ error: "content_plan_changed_before_review" }, 409);
      }
      return response({
        success: true,
        decision,
        reviewed_at: reviewedAt,
        evidence_hash: evidenceHash,
        conversion_cutoff_at: conversion.evidence.cutoff_at,
        conversion_evidence_hash: conversion.evidenceHash,
        conversion_evidence: conversion.evidence,
        review_schema_version: GROWTH_REVIEW_SCHEMA_VERSION,
        decision_policy_id: policy.policy_id,
        decision_policy_reason_codes: policy.reason_codes,
        decision_policy_evidence_hash: policyEvidenceHash,
        comparable_fixed_age_snapshots: comparableSnapshots,
        decision_override_note: policy.override_note || null,
        decision_override_hash: policy.override_hash || null,
        review_identity_hash: identityHash,
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
