import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const PAGE_SIZE = 5000;
const MAX_USERS = 10000;
const MAX_ACTIVITY_RECORDS = 100000;
const MAX_GROWTH_RECORDS = 25000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_GRACE_MS = DAY_MS;
const RETENTION_WINDOW_DAYS = 30;
const TOUCH_SIGNUP_SKEW_MS = 5 * 60 * 1000;
const PACE_CAMPAIGN = "1000-users";
const PACE_OBSERVATION_DAYS = 28;
const PACE_EXCLUDED_CONTENT = new Set(["ig-release-smoke"]);
const SOCIAL_PLATFORMS = new Set(["instagram", "tiktok"]);
const DECISION_POLICY_ID = "growth-decision-sufficiency.v1";
const DECLARED_CLICKABLE_HANDOFFS = new Set([
  "story_link",
  "dm_reply",
  "comment_reply",
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

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function normalized(value: any): string {
  return String(value || "").trim().toLowerCase();
}

function canViewGrowth(user: any): boolean {
  return user?.is_owner === true
    || normalized(user?.role) === "admin"
    || normalized(user?.app_role) === "admin";
}

function growthEvidenceConflict(message: string): Error {
  const error: any = new Error(message);
  error.code = "growth_content_conflict";
  return error;
}

function isActivated(user: any, activationIndex: any): boolean {
  const role = normalized(user?.app_role);
  if (role === "rep") return Number(user?.outcomes_logged || 0) > 0;
  if (role === "manager" || role === "admin") {
    return activationIndex.managerIds.has(String(user?.id || ""))
      || activationIndex.managerEmails.has(normalized(user?.email));
  }
  return false;
}

function isPaid(user: any): boolean {
  return Boolean(user?.first_paid_at)
    || (
      user?.subscription_paid_confirmed === true
      && normalized(user?.subscription_status) === "active"
    );
}

function dateValue(record: any, fields: string[]): number {
  for (const field of fields) {
    const parsed = new Date(record?.[field] || "");
    if (Number.isFinite(parsed.getTime())) return parsed.getTime();
  }
  return 0;
}

function isoValue(value: any): string | null {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function isSyntheticRecord(record: any): boolean {
  return record?.is_test === true
    || record?.test === true
    || ["test", "testing", "sandbox"].includes(normalized(record?.environment))
    || ["test", "synthetic"].includes(normalized(record?.trust_source));
}

async function requestedConversionScope(req: Request): Promise<any> {
  let body: any = {};
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.body === null) return { scope: null };
    try {
      body = await req.json();
    } catch {
      return { error: "invalid_conversion_scope" };
    }
  }
  const supplied = [
    body?.platform,
    body?.campaign,
    body?.content,
    body?.conversion_cutoff_at,
  ].some((value) => value !== undefined && value !== null && value !== "");
  if (!supplied) return { scope: null };

  const platform = normalized(body?.platform);
  const campaign = normalized(body?.campaign);
  const content = normalized(body?.content);
  const cutoffAt = isoValue(body?.conversion_cutoff_at);
  const snapshotAt = body?.snapshot_captured_at
    ? isoValue(body.snapshot_captured_at)
    : cutoffAt;
  const cutoffMs = cutoffAt ? new Date(cutoffAt).getTime() : 0;
  if (
    !SOCIAL_PLATFORMS.has(platform)
    || !campaign
    || !content
    || !cutoffAt
    || !snapshotAt
    || snapshotAt !== cutoffAt
    || cutoffMs > Date.now() + TOUCH_SIGNUP_SKEW_MS
  ) {
    return { error: "invalid_conversion_scope" };
  }
  return {
    scope: {
      platform,
      campaign,
      content,
      cutoff_at: cutoffAt,
      cutoff_ms: cutoffMs,
    },
  };
}

function isRecent(record: any, days: number, fields: string[]): boolean {
  const value = dateValue(record, fields);
  return value > 0 && value >= Date.now() - days * DAY_MS;
}

async function listAll(entity: any, maxRecords: number, label: string): Promise<any[]> {
  const records: any[] = [];
  for (let skip = 0; skip < maxRecords; skip += PAGE_SIZE) {
    const page = asArray(await entity.list("-created_date", PAGE_SIZE, skip));
    records.push(...page);
    if (page.length < PAGE_SIZE) return records;
  }
  throw new Error(`${label} exceeded the safe reporting limit.`);
}

function buildActivationIndex(routes: any[], canvasSessions: any[]) {
  const managerIds = new Set<string>();
  const managerEmails = new Set<string>();
  for (const route of routes) {
    const propertyCount = Array.isArray(route?.property_hashes)
      ? route.property_hashes.filter(Boolean).length
      : 0;
    if (propertyCount < 1) continue;
    // created_by is platform-stamped. manager_id is client-writable on
    // SavedRoute and is therefore not sufficient activation evidence alone.
    if (route?.created_by) managerEmails.add(normalized(route.created_by));
  }
  for (const session of canvasSessions) {
    if (
      session?.manager_id
      && ["deployed", "completed"].includes(normalized(session?.status))
    ) {
      managerIds.add(String(session.manager_id));
    }
  }
  return { managerIds, managerEmails };
}

function buildActivityIndex(
  users: any[],
  routes: any[],
  canvasSessions: any[],
  interactions: any[],
  teamMembers: any[],
  days = 30,
) {
  const cutoff = Date.now() - days * DAY_MS;
  const userIds = new Set<string>();
  const userEmails = new Set<string>();
  const usersById = new Map(users.map((user) => [String(user?.id || ""), user]));
  const membersById = new Map(teamMembers.map((member) => [String(member?.id || ""), member]));
  const markUserId = (value: any) => {
    const id = String(value || "");
    if (id) userIds.add(id);
  };
  const markEmail = (value: any) => {
    const email = normalized(value);
    if (email) userEmails.add(email);
  };
  const isWithinWindow = (record: any, fields: string[]) => (
    dateValue(record, fields) >= cutoff
  );

  for (const route of routes) {
    if (!isWithinWindow(route, ["updated_date", "created_date"])) continue;
    const propertyCount = Array.isArray(route?.property_hashes)
      ? route.property_hashes.filter(Boolean).length
      : 0;
    if (propertyCount > 0) markEmail(route?.created_by);
  }
  for (const session of canvasSessions) {
    if (
      ["deployed", "completed"].includes(normalized(session?.status))
      && isWithinWindow(session, ["completed_at", "deployed_at", "updated_date", "created_date"])
    ) {
      markUserId(session?.manager_id);
    }
  }
  for (const interaction of interactions) {
    if (
      interaction?.counts_as_knock === false
      || !isWithinWindow(interaction, ["created_date", "sale_date"])
    ) {
      continue;
    }
    markUserId(interaction?.logged_by_user_id);
    markEmail(interaction?.created_by);
    const repId = String(interaction?.rep_id || "");
    if (usersById.has(repId)) markUserId(repId);
    const member = membersById.get(repId);
    if (member?.user_id) markUserId(member.user_id);
  }
  return { userIds, userEmails };
}

function buildProductTimelines(
  users: any[],
  routes: any[],
  canvasSessions: any[],
  interactions: any[],
  teamMembers: any[],
  events: any[],
) {
  const activationByUserId = new Map<string, number[]>();
  const activationByEmail = new Map<string, number[]>();
  const activityByUserId = new Map<string, number[]>();
  const activityByEmail = new Map<string, number[]>();
  const paidByUserId = new Map<string, number[]>();
  const usersById = new Map(users.map((user) => [String(user?.id || ""), user]));
  const membersById = new Map(teamMembers.map((member) => [String(member?.id || ""), member]));
  const add = (index: Map<string, number[]>, keyValue: any, timeValue: any) => {
    const key = String(keyValue || "").trim().toLowerCase();
    const time = typeof timeValue === "number"
      ? timeValue
      : new Date(timeValue || "").getTime();
    if (!key || !Number.isFinite(time) || time <= 0) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key)?.push(time);
  };
  const addFields = (
    index: Map<string, number[]>,
    key: any,
    record: any,
    fields: string[],
  ) => {
    for (const field of fields) add(index, key, record?.[field]);
  };
  const addActivationId = (id: any, record: any, fields: string[]) => {
    add(activationByUserId, id, dateValue(record, fields));
    addFields(activityByUserId, id, record, fields);
  };
  const addActivationEmail = (email: any, record: any, fields: string[]) => {
    add(activationByEmail, normalized(email), dateValue(record, fields));
    addFields(activityByEmail, normalized(email), record, fields);
  };

  for (const route of routes) {
    if (isSyntheticRecord(route)) continue;
    const propertyCount = Array.isArray(route?.property_hashes)
      ? route.property_hashes.filter(Boolean).length
      : 0;
    if (propertyCount < 1 || !route?.created_by) continue;
    addActivationEmail(route.created_by, route, ["created_date", "updated_date"]);
  }
  for (const session of canvasSessions) {
    if (
      isSyntheticRecord(session)
      || !session?.manager_id
      || !["deployed", "completed"].includes(normalized(session?.status))
    ) {
      continue;
    }
    addActivationId(session.manager_id, session, [
      "deployed_at",
      "completed_at",
      "created_date",
      "updated_date",
    ]);
  }
  for (const interaction of interactions) {
    if (isSyntheticRecord(interaction) || interaction?.counts_as_knock === false) continue;
    const fields = ["created_date", "sale_date", "updated_date"];
    addActivationId(interaction?.logged_by_user_id, interaction, fields);
    addActivationEmail(interaction?.created_by, interaction, fields);
    const repId = String(interaction?.rep_id || "");
    if (usersById.has(repId)) addActivationId(repId, interaction, fields);
    const member = membersById.get(repId);
    if (member?.user_id) addActivationId(member.user_id, interaction, fields);
  }
  for (const event of events) {
    if (
      isSyntheticRecord(event)
      || !["trusted_product_function", "stripe_webhook"].includes(
        normalized(event?.trust_source),
      )
      || !event?.evidence_id
    ) {
      continue;
    }
    const occurredAt = event?.occurred_at;
    if (["workspace_activated", "invited_rep_activated"].includes(
      normalized(event?.event_name),
    )) {
      add(activationByUserId, event?.user_id || event?.workspace_manager_id, occurredAt);
      add(activityByUserId, event?.user_id || event?.workspace_manager_id, occurredAt);
    }
    if (normalized(event?.event_name) === "paid_conversion") {
      add(paidByUserId, event?.user_id || event?.workspace_manager_id, occurredAt);
    }
  }
  for (const user of users) {
    addFields(paidByUserId, user?.id, user, [
      "first_paid_at",
      "subscription_paid_confirmed_at",
      "paid_at",
    ]);
  }
  for (const index of [
    activationByUserId,
    activationByEmail,
    activityByUserId,
    activityByEmail,
    paidByUserId,
  ]) {
    for (const values of index.values()) values.sort((left, right) => left - right);
  }
  return {
    activationByUserId,
    activationByEmail,
    activityByUserId,
    activityByEmail,
    paidByUserId,
  };
}

function timelineValuesForUser(
  user: any,
  byUserId: Map<string, number[]>,
  byEmail?: Map<string, number[]>,
): number[] {
  return [...new Set([
    ...(byUserId.get(String(user?.id || "")) || []),
    ...(byEmail?.get(normalized(user?.email)) || []),
  ])].sort((left, right) => left - right);
}

function isRetainedActive(user: any, activationIndex: any, activityIndex: any): boolean {
  if (!isActivated(user, activationIndex)) return false;
  return activityIndex.userIds.has(String(user?.id || ""))
    || activityIndex.userEmails.has(normalized(user?.email));
}

function membershipKey(managerId: any, userId: any): string {
  return `${String(managerId || "")}|${String(userId || "")}`;
}

function acquisitionTouchForUser(
  user: any,
  usersById: Map<string, any>,
  activeMemberships: Set<string>,
): any {
  if (
    normalized(user?.app_role) === "rep"
    && user?.team_manager_id
    && activeMemberships.has(membershipKey(user.team_manager_id, user.id))
  ) {
    const manager = usersById.get(String(user.team_manager_id));
    if (manager?.acquisition_first_touch) return manager.acquisition_first_touch;
  }
  return user?.acquisition_first_touch;
}

function socialPlatform(value: any): string {
  const platform = normalized(value);
  return SOCIAL_PLATFORMS.has(platform) ? platform : "instagram";
}

function recordPlatform(record: any): string {
  return socialPlatform(record?.platform || record?.source);
}

function platformEvents(events: any[], platform: string): any[] {
  return events.filter((event) => normalized(event?.source) === platform);
}

function uniqueCount(records: any[], field: string): number {
  return new Set(records.map((record) => String(record?.[field] || "")).filter(Boolean)).size;
}

function assetKey(
  campaign: any,
  content: any,
  platform: any = "instagram",
): string {
  const cleanContent = normalized(content);
  return cleanContent
    ? `${socialPlatform(platform)}|${normalized(campaign) || "1000-users"}|${cleanContent}`
    : "";
}

function checkpointKey(
  campaign: any,
  content: any,
  snapshotDays: any,
  platform: any = "instagram",
): string {
  const key = assetKey(campaign, content, platform);
  return key ? `${key}|${Number(snapshotDays || 7)}` : "";
}

function latestRecord(records: any[], fields: string[]): any | null {
  return [...records].sort((left, right) => (
    dateValue(right, fields) - dateValue(left, fields)
    || String(right?.id || "").localeCompare(String(left?.id || ""))
  ))[0] || null;
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
  return dateValue(plan, ["published_at"]) > 0 ? 1 : 0;
}

function planDefinitionPayload(plan: any): string {
  return JSON.stringify(Object.fromEntries(
    PLAN_DEFINITION_FIELDS.map((field) => [
      field,
      field === "platform" ? recordPlatform(plan) : plan?.[field] ?? null,
    ]),
  ));
}

function planReviewPayload(plan: any): string {
  return JSON.stringify({
    review_schema_version: normalized(plan?.review_schema_version),
    decision: normalized(plan?.review_decision),
    note: String(plan?.review_note || ""),
    snapshot_captured_at: dateValue(plan, ["review_snapshot_captured_at"]),
    evidence_hash: String(plan?.review_evidence_hash || ""),
    conversion_evidence_hash:
      String(plan?.review_conversion_evidence_hash || ""),
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

function canonicalContentPlans(plans: any[]): any[] {
  const grouped = new Map<string, any[]>();
  for (const plan of plans) {
    const key = assetKey(plan?.campaign, plan?.content, recordPlatform(plan));
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(plan);
  }
  const canonical: any[] = [];
  for (const [key, records] of grouped.entries()) {
    const lifecycleRecords = records.filter((record) => planLifecycleRank(record) > 0);
    const publishedValues = new Set(
      lifecycleRecords
        .map((record) => dateValue(record, ["published_at"]))
        .filter((value) => value > 0),
    );
    const reviewValues = new Set(
      lifecycleRecords
        .filter((record) => planLifecycleRank(record) === 2)
        .map(planReviewPayload),
    );
    const executedDefinitions = new Set(lifecycleRecords.map(planDefinitionPayload));
    if (
      publishedValues.size > 1
      || reviewValues.size > 1
      || executedDefinitions.size > 1
    ) {
      throw growthEvidenceConflict(
        `Conflicting lifecycle evidence for growth content plan ${key}.`,
      );
    }
    const selected = [...records].sort((left, right) => (
      planLifecycleRank(right) - planLifecycleRank(left)
      || dateValue(right, [
        "reviewed_at",
        "review_snapshot_captured_at",
        "published_at",
        "updated_date",
        "created_date",
      ])
        - dateValue(left, [
          "reviewed_at",
          "review_snapshot_captured_at",
          "published_at",
          "updated_date",
          "created_date",
        ])
      || String(right?.id || "").localeCompare(String(left?.id || ""))
    ))[0];
    if (selected) canonical.push(selected);
  }
  return canonical;
}

function metricFieldObserved(metric: any, field: string): boolean {
  if (Array.isArray(metric?.observed_metric_fields)) {
    return metric.observed_metric_fields
      .map(normalized)
      .includes(normalized(field));
  }
  if (
    normalized(metric?.metric_source) === "buffer"
    && Array.isArray(metric?.provider_observed_metric_types)
  ) {
    return metric.provider_observed_metric_types
      .map(normalized)
      .includes(normalized(field));
  }
  return Object.prototype.hasOwnProperty.call(metric || {}, field);
}

function hasContentSnapshot(metric: any): boolean {
  const capturedAt = dateValue(metric, ["snapshot_captured_at"]);
  const reach = Number(metric?.reach);
  const views = Number(metric?.views);
  const reachValid = metricFieldObserved(metric, "reach")
    && Number.isSafeInteger(reach)
    && reach >= 0;
  const viewsValid = metricFieldObserved(metric, "views")
    && Number.isSafeInteger(views)
    && views >= 0;
  return capturedAt > 0
    && (reachValid || viewsValid);
}

function metricEvidencePayload(metric: any): string {
  const payload: any = {
    platform: recordPlatform(metric),
    campaign: normalized(metric?.campaign) || "1000-users",
    content: normalized(metric?.content),
    snapshot_days: Number(metric?.snapshot_days || 7),
    snapshot_captured_at: dateValue(metric, ["snapshot_captured_at"]),
    published_at: dateValue(metric, ["published_at"]),
  };
  for (const field of CONTENT_METRIC_FIELDS) {
    payload[field] = Math.max(0, Number(metric?.[field] || 0));
  }
  payload.observed_fields = CONTENT_METRIC_FIELDS.filter(
    (field) => metricFieldObserved(metric, field),
  );
  return JSON.stringify(payload);
}

function canonicalMetricCheckpoints(metrics: any[]): any[] {
  const grouped = new Map<string, any[]>();
  for (const metric of metrics.filter(hasContentSnapshot)) {
    const key = checkpointKey(
      metric?.campaign,
      metric?.content,
      metric?.snapshot_days,
      recordPlatform(metric),
    );
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(metric);
  }
  const canonical: any[] = [];
  for (const [key, records] of grouped.entries()) {
    const latestCapture = Math.max(
      ...records.map((record) => dateValue(record, ["snapshot_captured_at"])),
    );
    const latestCandidates = records.filter(
      (record) => dateValue(record, ["snapshot_captured_at"]) === latestCapture,
    );
    const evidence = new Set(latestCandidates.map(metricEvidencePayload));
    if (evidence.size > 1) {
      throw growthEvidenceConflict(`Conflicting growth content checkpoint ${key}.`);
    }
    const selected = latestRecord(
      latestCandidates,
      ["snapshot_captured_at", "updated_date", "created_date"],
    );
    if (selected) canonical.push(selected);
  }
  return canonical;
}

function operatingContentMetrics(metrics: any[], plans: any[]): any[] {
  const plansByAsset = new Map(plans.map((plan) => [
    assetKey(plan?.campaign, plan?.content, recordPlatform(plan)),
    plan,
  ]));
  const grouped = new Map<string, any[]>();
  for (const metric of metrics) {
    const key = assetKey(metric?.campaign, metric?.content, recordPlatform(metric));
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(metric);
  }
  return [...grouped.entries()].map(([key, checkpoints]) => {
    const plan = plansByAsset.get(key);
    if (plan) {
      const expected = Number(plan?.snapshot_days || 7);
      const metric = checkpoints.find(
        (candidate) => Number(candidate?.snapshot_days || 7) === expected,
      );
      const publishedAt = dateValue(plan, ["published_at"]);
      const capturedAt = dateValue(metric, ["snapshot_captured_at"]);
      const dueAt = publishedAt + expected * DAY_MS;
      return metric
        && publishedAt > 0
        && capturedAt >= dueAt
        && capturedAt <= dueAt + SNAPSHOT_GRACE_MS
        ? metric
        : null;
    }
    const metric = checkpoints.find(
      (candidate) => Number(candidate?.snapshot_days || 7) === 7,
    ) || latestRecord(checkpoints, [
        "snapshot_captured_at",
        "updated_date",
        "created_date",
      ]);
    const publishedAt = dateValue(metric, ["published_at"]);
    const capturedAt = dateValue(metric, ["snapshot_captured_at"]);
    const snapshotDays = Number(metric?.snapshot_days || 7);
    return metric
      && (
        publishedAt <= 0
        || capturedAt >= publishedAt + snapshotDays * DAY_MS
      )
      ? metric
      : null;
  }).filter(Boolean);
}

function activeRepRoster(
  teamMembers: any[],
  allUsersById: Map<string, any>,
): any[] {
  const groups = new Map<string, any>();
  for (const member of teamMembers) {
    const memberId = String(member?.id || "");
    const managerId = String(member?.manager_id || "");
    const email = normalized(member?.email);
    if (
      !memberId
      || !managerId
      || !email
      || normalized(member?.role) !== "rep"
      || normalized(member?.status) !== "active"
    ) {
      continue;
    }
    const key = `${managerId}|${email}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        manager_id: managerId,
        email,
        member_ids: new Set<string>(),
        linked_user_ids: new Set<string>(),
      });
    }
    const group = groups.get(key);
    group.member_ids.add(memberId);
    if (member?.user_id) group.linked_user_ids.add(String(member.user_id));
  }

  return [...groups.values()].map((group) => {
    const validUserIds = new Set<string>();
    for (const userId of group.linked_user_ids) {
      const user = allUsersById.get(userId);
      if (
        user
        && String(user?.id || "") === userId
        && normalized(user?.app_role) === "rep"
        && String(user?.team_manager_id || "") === group.manager_id
        && normalized(user?.email) === group.email
      ) {
        validUserIds.add(userId);
      }
    }
    const joinedUserId = validUserIds.size === 1 ? [...validUserIds][0] : "";
    return {
      ...group,
      joined_user: joinedUserId ? allUsersById.get(joinedUserId) : null,
      identity_conflict: validUserIds.size > 1,
    };
  });
}

function activeRepMemberships(rosterGroups: any[]): Set<string> {
  return new Set(
    rosterGroups
      .filter((group) => group?.joined_user?.id)
      .map((group) => membershipKey(group.manager_id, group.joined_user.id)),
  );
}

function teamMultiplier(
  managerIds: Set<string>,
  rosterGroups: any[],
) {
  const managerRoster = rosterGroups.filter((group) => (
    managerIds.has(String(group?.manager_id || ""))
  ));
  const joinedRepUsers = managerRoster
    .map((group) => group.joined_user)
    .filter(Boolean);
  return {
    active_rep_roster: managerRoster.length,
    joined_reps: joinedRepUsers.length,
    activated_reps: joinedRepUsers.filter(
      (user) => Number(user?.outcomes_logged || 0) > 0,
    ).length,
    identity_conflicts: managerRoster.filter((group) => group.identity_conflict).length,
  };
}

const PLATFORM_SUMMARY_FIELDS = [
  "reach",
  "views",
  "reach_observed_assets",
  "views_observed_assets",
  "content_assets",
  "link_clicks",
  "dm_intents",
  "owned_intents",
  "owned_intents_observed_assets",
  "owned_intents_complete_assets",
  "landing_sessions",
  "signup_cta_sessions",
  "auth_completed",
  "acquired_users",
  "signups",
  "activated_workspaces",
  "activated_users",
  "retained_active_users_30d",
  "paid_users",
  "active_rep_roster",
  "joined_reps",
  "activated_reps",
  "rep_identity_conflicts",
];

function summarizePlatform(
  platform: string,
  users: any[],
  allUsersById: Map<string, any>,
  activationIndex: any,
  activityIndex: any,
  events: any[],
  metrics: any[],
  rosterGroups: any[],
): any {
  const activeMemberships = activeRepMemberships(rosterGroups);
  const acquired = users.filter((user) => (
    normalized(
      acquisitionTouchForUser(user, allUsersById, activeMemberships)?.source,
    ) === platform
  ));
  const managers = acquired.filter((user) => (
    ["manager", "admin"].includes(normalized(user?.app_role))
  ));
  const multiplier = teamMultiplier(
    new Set(managers.map((user) => String(user?.id || "")).filter(Boolean)),
    rosterGroups,
  );
  const socialEvents = platformEvents(events, platform);
  const platformMetrics = metrics.filter(
    (metric) => recordPlatform(metric) === platform,
  );
  const linkClicks = platformMetrics.reduce(
    (total, metric) => total + (
      metricFieldObserved(metric, "link_clicks")
        ? Math.max(0, Number(metric?.link_clicks || 0))
        : 0
    ),
    0,
  );
  const dmIntents = platformMetrics.reduce(
    (total, metric) => total + (
      metricFieldObserved(metric, "dm_intents")
        ? Math.max(0, Number(metric?.dm_intents || 0))
        : 0
    ),
    0,
  );
  return {
    reach: platformMetrics.reduce(
      (total, metric) => total + Math.max(0, Number(metric?.reach || 0)),
      0,
    ),
    views: platformMetrics.reduce(
      (total, metric) => total + Math.max(0, Number(metric?.views || 0)),
      0,
    ),
    reach_observed_assets: platformMetrics.filter(
      (metric) => metricFieldObserved(metric, "reach"),
    ).length,
    views_observed_assets: platformMetrics.filter(
      (metric) => metricFieldObserved(metric, "views"),
    ).length,
    content_assets: platformMetrics.length,
    link_clicks: linkClicks,
    dm_intents: dmIntents,
    owned_intents: linkClicks + dmIntents,
    owned_intents_observed_assets: platformMetrics.filter(
      (metric) => (
        metricFieldObserved(metric, "link_clicks")
        || metricFieldObserved(metric, "dm_intents")
      ),
    ).length,
    owned_intents_complete_assets: platformMetrics.filter(
      (metric) => (
        metricFieldObserved(metric, "link_clicks")
        && metricFieldObserved(metric, "dm_intents")
      ),
    ).length,
    landing_sessions: uniqueCount(
      socialEvents.filter((event) => event?.event_name === "landing_viewed"),
      "session_id",
    ),
    signup_cta_sessions: uniqueCount(
      socialEvents.filter((event) => event?.event_name === "signup_cta_clicked"),
      "session_id",
    ),
    auth_completed: uniqueCount(
      socialEvents.filter((event) => event?.event_name === "auth_completed"),
      "user_id",
    ),
    acquired_users: acquired.length,
    signups: managers.length,
    activated_workspaces: managers
      .filter((user) => isActivated(user, activationIndex)).length,
    activated_users: acquired
      .filter((user) => isActivated(user, activationIndex)).length,
    retained_active_users_30d: acquired
      .filter((user) => isRetainedActive(user, activationIndex, activityIndex)).length,
    paid_users: acquired.filter(isPaid).length,
    active_rep_roster: multiplier.active_rep_roster,
    joined_reps: multiplier.joined_reps,
    activated_reps: multiplier.activated_reps,
    rep_identity_conflicts: multiplier.identity_conflicts,
  };
}

function prefixedPlatformSummary(platform: string, summary: any): any {
  return Object.fromEntries(
    PLATFORM_SUMMARY_FIELDS.map((field) => [
      `${platform}_${field}`,
      Number(summary?.[field] || 0),
    ]),
  );
}

function summarize(
  users: any[],
  allUsersById: Map<string, any>,
  activationIndex: any,
  activityIndex: any,
  events: any[],
  metrics: any[],
  rosterGroups: any[],
) {
  const instagram = summarizePlatform(
    "instagram",
    users,
    allUsersById,
    activationIndex,
    activityIndex,
    events,
    metrics,
    rosterGroups,
  );
  const tiktok = summarizePlatform(
    "tiktok",
    users,
    allUsersById,
    activationIndex,
    activityIndex,
    events,
    metrics,
    rosterGroups,
  );
  const social = Object.fromEntries(
    PLATFORM_SUMMARY_FIELDS.map((field) => [
      field,
      Number(instagram[field] || 0) + Number(tiktok[field] || 0),
    ]),
  );
  return {
    users: users.length,
    activated_users: users.filter((user) => isActivated(user, activationIndex)).length,
    retained_active_users_30d: users.filter(
      (user) => isRetainedActive(user, activationIndex, activityIndex),
    ).length,
    paid_users: users.filter(isPaid).length,
    ...prefixedPlatformSummary("instagram", instagram),
    ...prefixedPlatformSummary("tiktok", tiktok),
    ...prefixedPlatformSummary("social", social),
    instagram_cumulative_post_reach: instagram.reach,
    tiktok_cumulative_post_reach: tiktok.reach,
    social_cumulative_post_reach: social.reach,
  };
}

function buildPaceEvidence(
  users: any[],
  allUsersById: Map<string, any>,
  activationIndex: any,
  activityIndex: any,
  metrics: any[],
  plans: any[],
  rosterGroups: any[],
) {
  const scopedPlans = plans.filter((plan) => (
    normalized(plan?.campaign) === PACE_CAMPAIGN
    && !PACE_EXCLUDED_CONTENT.has(normalized(plan?.content))
    && dateValue(plan, ["published_at"]) > 0
  ));
  const scopedAssetKeys = new Set(
    scopedPlans.map((plan) => assetKey(
      plan?.campaign,
      plan?.content,
      recordPlatform(plan),
    )),
  );
  const scopedPlansByAsset = new Map(scopedPlans.map((plan) => [
    assetKey(plan?.campaign, plan?.content, recordPlatform(plan)),
    plan,
  ]));
  const scopedMetrics = metrics.filter((metric) => (
    scopedAssetKeys.has(assetKey(
      metric?.campaign,
      metric?.content,
      recordPlatform(metric),
    ))
  ));
  const now = Date.now();
  const observationCutoff = now - PACE_OBSERVATION_DAYS * DAY_MS;
  const checkpointDueAt = (plan: any) => (
    dateValue(plan, ["published_at"])
    + Number(plan?.snapshot_days || 7) * DAY_MS
  );
  const recentMetrics = scopedMetrics.filter((metric) => {
    const plan = scopedPlansByAsset.get(assetKey(
      metric?.campaign,
      metric?.content,
      recordPlatform(metric),
    ));
    const dueAt = checkpointDueAt(plan);
    return dueAt >= observationCutoff && dueAt <= now;
  });
  const recentDuePlans = scopedPlans.filter((plan) => {
    const dueAt = checkpointDueAt(plan);
    return dueAt >= observationCutoff && dueAt <= now;
  });
  const allTimeDuePlans = scopedPlans.filter(
    (plan) => checkpointDueAt(plan) <= now,
  );
  const activeMemberships = activeRepMemberships(rosterGroups);
  const scopedUsers = users.filter((user) => {
    const touch = acquisitionTouchForUser(user, allUsersById, activeMemberships);
    const source = normalized(touch?.source);
    if (!SOCIAL_PLATFORMS.has(source)) return false;
    const plan = scopedPlansByAsset.get(assetKey(
      touch?.campaign,
      touch?.content,
      source,
    ));
    const publishedAt = dateValue(plan, ["published_at"]);
    const capturedAt = dateValue(touch, ["captured_at"]);
    return publishedAt > 0
      && capturedAt >= publishedAt
      && capturedAt <= now;
  });
  const recentUsers = scopedUsers.filter(
    (user) => isRecent(user, PACE_OBSERVATION_DAYS, ["created_date"]),
  );
  const recentUsersForPlatform = (platform: string) => recentUsers.filter((user) => (
    normalized(
      acquisitionTouchForUser(user, allUsersById, activeMemberships)?.source,
    ) === platform
  ));
  const paceForPlatform = (platform: string) => {
    const platformMetrics = recentMetrics.filter(
      (metric) => recordPlatform(metric) === platform,
    );
    const expectedDueAssets = recentDuePlans.filter(
      (plan) => recordPlatform(plan) === platform,
    ).length;
    const platformUsers = recentUsersForPlatform(platform);
    const managers = platformUsers.filter((user) => (
      ["manager", "admin"].includes(normalized(user?.app_role))
    ));
    return {
      reach: platformMetrics.reduce(
        (total, metric) => total + Math.max(0, Number(metric?.reach || 0)),
        0,
      ),
      views: platformMetrics.reduce(
        (total, metric) => total + Math.max(0, Number(metric?.views || 0)),
        0,
      ),
      reach_observed_assets: platformMetrics.filter(
        (metric) => metricFieldObserved(metric, "reach"),
      ).length,
      views_observed_assets: platformMetrics.filter(
        (metric) => metricFieldObserved(metric, "views"),
      ).length,
      expected_due_assets: expectedDueAssets,
      captured_assets: platformMetrics.length,
      content_assets: platformMetrics.length,
      activated_workspaces: managers.filter(
        (user) => isActivated(user, activationIndex),
      ).length,
      retained_active_users_30d: platformUsers.filter(
        (user) => isRetainedActive(user, activationIndex, activityIndex),
      ).length,
    };
  };
  const instagram = paceForPlatform("instagram");
  const tiktok = paceForPlatform("tiktok");
  const checkpointDueTimes = scopedPlans
    .map(checkpointDueAt)
    .filter((value) => value > 0);
  const firstCheckpointDueAt = checkpointDueTimes.length
    ? Math.min(...checkpointDueTimes)
    : 0;

  return {
    campaign: PACE_CAMPAIGN,
    scope: "canonical_mature_plan_backed_assets",
    observation_window_days: PACE_OBSERVATION_DAYS,
    observation_window_complete: firstCheckpointDueAt > 0
      && firstCheckpointDueAt <= observationCutoff,
    expected_due_assets_all_time: allTimeDuePlans.length,
    expected_due_assets_all_time_by_platform: {
      instagram: allTimeDuePlans.filter(
        (plan) => recordPlatform(plan) === "instagram",
      ).length,
      tiktok: allTimeDuePlans.filter(
        (plan) => recordPlatform(plan) === "tiktok",
      ).length,
    },
    measured_content_assets_all_time: scopedMetrics.length,
    measured_content_assets_all_time_by_platform: {
      instagram: scopedMetrics.filter(
        (metric) => recordPlatform(metric) === "instagram",
      ).length,
      tiktok: scopedMetrics.filter(
        (metric) => recordPlatform(metric) === "tiktok",
      ).length,
    },
    last_28_days: {
      instagram_reach: instagram.reach,
      instagram_cumulative_post_reach: instagram.reach,
      instagram_views: instagram.views,
      instagram_reach_observed_assets: instagram.reach_observed_assets,
      instagram_views_observed_assets: instagram.views_observed_assets,
      instagram_expected_due_assets: instagram.expected_due_assets,
      instagram_captured_assets: instagram.captured_assets,
      instagram_content_assets: instagram.content_assets,
      instagram_activated_workspaces: instagram.activated_workspaces,
      instagram_retained_active_users_30d: instagram.retained_active_users_30d,
      tiktok_reach: tiktok.reach,
      tiktok_cumulative_post_reach: tiktok.reach,
      tiktok_views: tiktok.views,
      tiktok_reach_observed_assets: tiktok.reach_observed_assets,
      tiktok_views_observed_assets: tiktok.views_observed_assets,
      tiktok_expected_due_assets: tiktok.expected_due_assets,
      tiktok_captured_assets: tiktok.captured_assets,
      tiktok_content_assets: tiktok.content_assets,
      tiktok_activated_workspaces: tiktok.activated_workspaces,
      tiktok_retained_active_users_30d: tiktok.retained_active_users_30d,
      social_reach: instagram.reach + tiktok.reach,
      social_cumulative_post_reach: instagram.reach + tiktok.reach,
      social_views: instagram.views + tiktok.views,
      social_reach_observed_assets:
        instagram.reach_observed_assets + tiktok.reach_observed_assets,
      social_views_observed_assets:
        instagram.views_observed_assets + tiktok.views_observed_assets,
      social_expected_due_assets:
        instagram.expected_due_assets + tiktok.expected_due_assets,
      social_captured_assets:
        instagram.captured_assets + tiktok.captured_assets,
      social_content_assets: instagram.content_assets + tiktok.content_assets,
      social_activated_workspaces:
        instagram.activated_workspaces + tiktok.activated_workspaces,
      social_retained_active_users_30d:
        instagram.retained_active_users_30d + tiktok.retained_active_users_30d,
    },
  };
}

function rowKey(platform: any, campaign: any, content: any): string {
  return `${socialPlatform(platform)}|${normalized(campaign) || "unassigned"}|${normalized(content) || "unassigned"}`;
}

function genericSocialContent(sourceValue: any, contentValue: any): boolean {
  const source = normalized(sourceValue);
  const content = normalized(contentValue);
  if (!SOCIAL_PLATFORMS.has(source)) return false;
  return !content
    || content === "unassigned"
    || content === (source === "instagram" ? "ig-bio" : "tt-bio");
}

function reportedContentAssist(touch: any): any | null {
  const source = normalized(touch?.source);
  const campaign = normalized(touch?.campaign) || "unassigned";
  const content = normalized(touch?.content) || "unassigned";
  const reportedContent = normalized(touch?.reported_content_id);
  const expectedPrefix = source === "instagram" ? "ig-" : "tt-";
  if (
    !SOCIAL_PLATFORMS.has(source)
    || !genericSocialContent(source, content)
    || normalized(touch?.reported_content_method) !== "visitor_self_report"
    || !reportedContent.startsWith(expectedPrefix)
    || genericSocialContent(source, reportedContent)
  ) {
    return null;
  }
  return {
    source,
    campaign,
    content: reportedContent,
    reported_at: dateValue(touch, ["reported_content_at"]),
  };
}

function reportedAcquisitionAssistForUser(user: any): any | null {
  const createdAt = dateValue(user, ["created_date"]);
  if (!createdAt) return null;
  for (const touch of [
    user?.acquisition_last_touch,
    user?.acquisition_first_touch,
  ]) {
    const assist = reportedContentAssist(touch);
    if (
      assist
      && assist.reported_at > 0
      && assist.reported_at <= createdAt + 5 * 60 * 1000
      && assist.reported_at >= createdAt - 90 * DAY_MS
    ) {
      return assist;
    }
  }
  return null;
}

function rowAttribution(source: string, content: string, plan: any): any {
  const generic = genericSocialContent(source, content);
  const staticBio = content === (source === "instagram" ? "ig-bio" : "tt-bio");
  const declaredClickableHandoff = Boolean(
    !generic
    && plan
    && DECLARED_CLICKABLE_HANDOFFS.has(normalized(plan?.cta_channel)),
  );
  return {
    attribution_granularity: generic ? "platform" : "content",
    attribution_method: generic
      ? staticBio
        ? "static_bio"
        : "source_inferred_or_unassigned"
      : declaredClickableHandoff
      ? "declared_content_link"
      : "social_evidence_only",
    conversion_evidence: declaredClickableHandoff
      ? "client_declared_content_first_touch"
      : generic
      ? "client_declared_platform_first_touch"
      : "social_metrics_only_no_declared_handoff",
    post_conversion_eligible: declaredClickableHandoff,
  };
}

function contentRows(
  users: any[],
  allUsersById: Map<string, any>,
  activationIndex: any,
  events: any[],
  metrics: any[],
  plans: any[],
  rosterGroups: any[],
  timelines: any,
  requestScope: any = null,
) {
  const activeMemberships = activeRepMemberships(rosterGroups);
  const plansByAsset = new Map(plans.map((plan) => [
    assetKey(plan?.campaign, plan?.content, recordPlatform(plan)),
    plan,
  ]));
  const rows = new Map<string, any>();
  const ensureRow = (platform: any, campaign: any, content: any) => {
    const cleanPlatform = socialPlatform(platform);
    const cleanCampaign = normalized(campaign) || "unassigned";
    const cleanContent = normalized(content) || "unassigned";
    const key = rowKey(cleanPlatform, cleanCampaign, cleanContent);
    if (!rows.has(key)) {
      const plan = plansByAsset.get(assetKey(cleanCampaign, cleanContent, cleanPlatform)) || null;
      const publishedAt = dateValue(plan, ["published_at"]);
      const attribution = rowAttribution(cleanPlatform, cleanContent, plan);
      rows.set(key, {
        key,
        plan,
        source: cleanPlatform,
        medium: "organic_social",
        campaign: cleanCampaign,
        content: cleanContent,
        format: normalized(plan?.format),
        hook: String(plan?.hook || ""),
        cta_channel: normalized(plan?.cta_channel),
        snapshot_days: null,
        published_at_ms: publishedAt,
        conversion_cutoff_ms: requestScope
            && key === rowKey(
              requestScope.platform,
              requestScope.campaign,
              requestScope.content,
            )
          ? requestScope.cutoff_ms
          : 0,
        ...attribution,
        reach: 0,
        views: 0,
        reach_observed: false,
        views_observed: false,
        shares: 0,
        saves: 0,
        comments: 0,
        follows: 0,
        profile_visits: 0,
        link_clicks: 0,
        dm_intents: 0,
        owned_intent_observed_fields: [],
        landing_session_ids: new Set<string>(),
        signup_cta_session_ids: new Set<string>(),
        auth_user_ids: new Set<string>(),
        self_reported_landing_session_ids: new Set<string>(),
        self_reported_signup_cta_session_ids: new Set<string>(),
        self_reported_signup_user_ids: new Set<string>(),
        self_reported_activated_workspace_user_ids: new Set<string>(),
        self_reported_paid_user_ids: new Set<string>(),
        accepted_user_ids: new Set<string>(),
        retained_user_ids: new Set<string>(),
        retention_eligible_user_ids: new Set<string>(),
        activated_rep_user_ids: new Set<string>(),
        signups: 0,
        acquired_users: 0,
        activated_workspaces: 0,
        activated_users: 0,
        paid_users: 0,
        manager_signups: 0,
        rep_signups: 0,
        first_signup_ms: 0,
        last_signup_ms: 0,
        first_activation_ms: 0,
        last_activation_ms: 0,
        metric_timestamp: 0,
        event_timing_complete: true,
        user_timing_complete: true,
        activation_timing_complete: true,
        paid_timing_complete: true,
        missing_event_timestamps: 0,
        missing_user_timestamps: 0,
        activation_timing_missing_users: 0,
        paid_timing_missing_users: 0,
        excluded_prepublication_events: 0,
        excluded_post_cutoff_events: 0,
        excluded_synthetic_events: 0,
        excluded_prepublication_users: 0,
        excluded_post_cutoff_users: 0,
        excluded_invalid_timing_users: 0,
        excluded_synthetic_users: 0,
      });
    }
    return rows.get(key);
  };
  const hasBoundedCohort = (row: any) => (
    row.published_at_ms > 0
    && row.conversion_cutoff_ms >= row.published_at_ms
  );
  const timestampStatus = (row: any, value: any): string => {
    const time = new Date(value || "").getTime();
    if (!Number.isFinite(time) || time <= 0) return "missing";
    if (!hasBoundedCohort(row) || time < row.published_at_ms) return "prepublication";
    if (time > row.conversion_cutoff_ms) return "post_cutoff";
    return "inside";
  };

  // The social checkpoint defines the immutable conversion cutoff for the row.
  for (const metric of metrics) {
    const row = ensureRow(recordPlatform(metric), metric?.campaign, metric?.content);
    const metricTimestamp = dateValue(metric, ["snapshot_captured_at"]);
    if (metricTimestamp < row.metric_timestamp) continue;
    row.metric_timestamp = metricTimestamp;
    if (!requestScope) row.conversion_cutoff_ms = metricTimestamp;
    row.format = normalized(metric?.format) || row.format;
    row.hook = String(metric?.hook || row.hook || "");
    row.snapshot_days = Number(metric?.snapshot_days || 0) || null;
    row.reach_observed = metricFieldObserved(metric, "reach");
    row.views_observed = metricFieldObserved(metric, "views");
    row.owned_intent_observed_fields = ["link_clicks", "dm_intents"].filter(
      (field) => metricFieldObserved(metric, field),
    );
    for (const field of CONTENT_METRIC_FIELDS) {
      row[field] = Math.max(0, Number(metric?.[field] || 0));
    }
  }

  for (const event of events) {
    const source = normalized(event?.source);
    if (!SOCIAL_PLATFORMS.has(source)) continue;
    const row = ensureRow(source, event?.campaign, event?.content);
    const conversionEvent = [
      "landing_viewed",
      "signup_cta_clicked",
      "auth_completed",
    ].includes(normalized(event?.event_name));
    if (conversionEvent && row.post_conversion_eligible) {
      if (isSyntheticRecord(event)) {
        row.excluded_synthetic_events += 1;
      } else {
        const status = timestampStatus(row, event?.occurred_at);
        if (status === "missing") {
          row.event_timing_complete = false;
          row.missing_event_timestamps += 1;
        } else if (status === "prepublication") {
          row.excluded_prepublication_events += 1;
        } else if (status === "post_cutoff") {
          row.excluded_post_cutoff_events += 1;
        } else if (event?.event_name === "landing_viewed" && event?.session_id) {
          row.landing_session_ids.add(String(event.session_id));
        } else if (event?.event_name === "signup_cta_clicked" && event?.session_id) {
          row.signup_cta_session_ids.add(String(event.session_id));
        } else if (event?.event_name === "auth_completed" && event?.user_id) {
          row.auth_user_ids.add(String(event.user_id));
        }
      }
    }

    // Visitor self-report remains an explicitly non-conversion assist. Bound it
    // to the same frozen checkpoint so dashboard values cannot drift later.
    const assist = reportedContentAssist(event);
    if (assist && event?.session_id) {
      const assistRow = ensureRow(assist.source, assist.campaign, assist.content);
      if (timestampStatus(assistRow, event?.occurred_at) === "inside") {
        if (
          event?.event_name === "content_assist_reported"
          || event?.event_name === "landing_viewed"
        ) {
          assistRow.self_reported_landing_session_ids.add(String(event.session_id));
        }
        if (event?.event_name === "signup_cta_clicked") {
          assistRow.self_reported_signup_cta_session_ids.add(String(event.session_id));
        }
      }
    }
  }

  for (const user of users) {
    const touch = acquisitionTouchForUser(user, allUsersById, activeMemberships);
    const source = normalized(touch?.source);
    if (!SOCIAL_PLATFORMS.has(source)) continue;
    const row = ensureRow(source, touch?.campaign, touch?.content);
    const role = normalized(user?.app_role);
    row.medium = normalized(touch?.medium) || "organic_social";

    if (row.post_conversion_eligible) {
      if (isSyntheticRecord(user) || isSyntheticRecord(touch)) {
        row.excluded_synthetic_users += 1;
      } else {
        const touchAt = new Date(touch?.captured_at || "").getTime();
        const createdAt = new Date(user?.created_date || "").getTime();
        const touchStatus = timestampStatus(row, touch?.captured_at);
        const createdStatus = timestampStatus(row, user?.created_date);
        if (touchStatus === "missing" || createdStatus === "missing") {
          row.user_timing_complete = false;
          row.missing_user_timestamps += 1;
        } else if (touchAt > createdAt + TOUCH_SIGNUP_SKEW_MS) {
          row.user_timing_complete = false;
          row.excluded_invalid_timing_users += 1;
        } else if (touchStatus === "prepublication" || createdStatus === "prepublication") {
          row.excluded_prepublication_users += 1;
        } else if (touchStatus === "post_cutoff" || createdStatus === "post_cutoff") {
          row.excluded_post_cutoff_users += 1;
        } else {
          const userId = String(user?.id || "");
          row.accepted_user_ids.add(userId);
          row.acquired_users += 1;
          if (!row.first_signup_ms || createdAt < row.first_signup_ms) row.first_signup_ms = createdAt;
          if (!row.last_signup_ms || createdAt > row.last_signup_ms) row.last_signup_ms = createdAt;
          if (["manager", "admin"].includes(role)) {
            row.signups += 1;
            row.manager_signups += 1;
          } else if (role === "rep") {
            row.rep_signups += 1;
          }

          const activationTimes = timelineValuesForUser(
            user,
            timelines.activationByUserId,
            timelines.activationByEmail,
          );
          const hasActivationState = isActivated(user, activationIndex)
            || activationTimes.length > 0;
          const validActivationTimes = activationTimes.filter(
            (value) => value >= createdAt && value >= row.published_at_ms,
          );
          const activationAt = validActivationTimes[0] || 0;
          if (hasActivationState && !activationAt) {
            row.activation_timing_complete = false;
            row.activation_timing_missing_users += 1;
          } else if (activationAt > 0 && activationAt <= row.conversion_cutoff_ms) {
            row.activated_users += 1;
            if (!row.first_activation_ms || activationAt < row.first_activation_ms) {
              row.first_activation_ms = activationAt;
            }
            if (!row.last_activation_ms || activationAt > row.last_activation_ms) {
              row.last_activation_ms = activationAt;
            }
            if (["manager", "admin"].includes(role)) row.activated_workspaces += 1;
            if (role === "rep") row.activated_rep_user_ids.add(userId);
            if (activationAt <= row.conversion_cutoff_ms - RETENTION_WINDOW_DAYS * DAY_MS) {
              row.retention_eligible_user_ids.add(userId);
              const activityTimes = timelineValuesForUser(
                user,
                timelines.activityByUserId,
                timelines.activityByEmail,
              );
              if (activityTimes.some((value) => (
                value > activationAt
                && value >= row.conversion_cutoff_ms - RETENTION_WINDOW_DAYS * DAY_MS
                && value <= row.conversion_cutoff_ms
              ))) {
                row.retained_user_ids.add(userId);
              }
            }
          }

          if (["manager", "admin"].includes(role)) {
            const allPaidTimes = timelineValuesForUser(
              user,
              timelines.paidByUserId,
            );
            const hasPaidState = isPaid(user) || allPaidTimes.length > 0;
            if (hasPaidState) {
              const paidTimes = allPaidTimes.filter(
                (value) => value >= createdAt && value >= row.published_at_ms,
              );
              const paidAt = paidTimes[0] || 0;
              if (!paidAt) {
                row.paid_timing_complete = false;
                row.paid_timing_missing_users += 1;
              } else if (paidAt <= row.conversion_cutoff_ms) {
                row.paid_users += 1;
              }
            }
          }
        }
      }
    }

    const assist = reportedAcquisitionAssistForUser(user);
    if (assist && ["manager", "admin"].includes(role) && user?.id) {
      const assistRow = ensureRow(assist.source, assist.campaign, assist.content);
      if (timestampStatus(assistRow, user?.created_date) === "inside") {
        const userId = String(user.id);
        assistRow.self_reported_signup_user_ids.add(userId);
        if (isActivated(user, activationIndex)) {
          assistRow.self_reported_activated_workspace_user_ids.add(userId);
        }
        if (isPaid(user)) assistRow.self_reported_paid_user_ids.add(userId);
      }
    }
  }

  const scopedKey = requestScope
    ? rowKey(requestScope.platform, requestScope.campaign, requestScope.content)
    : "";
  return [...rows.values()]
    .filter((row) => !scopedKey || row.key === scopedKey)
    .map((row) => {
      const bounded = hasBoundedCohort(row);
      const eventCountersAvailable = Boolean(
        row.post_conversion_eligible && bounded && row.event_timing_complete,
      );
      const userCountersAvailable = Boolean(
        row.post_conversion_eligible && bounded && row.user_timing_complete,
      );
      const activationCountersAvailable = Boolean(
        userCountersAvailable && row.activation_timing_complete,
      );
      const paidCountersAvailable = Boolean(
        userCountersAvailable && row.paid_timing_complete,
      );
      const conversionCountersAvailable = Boolean(
        eventCountersAvailable
        && activationCountersAvailable
        && paidCountersAvailable,
      );
      const conversionConclusion = !row.post_conversion_eligible
        ? "inconclusive_no_declared_link"
        : conversionCountersAvailable
        ? "exact_declared_link"
        : "inconclusive_missing_timestamps";
      const eventValue = (value: number) => eventCountersAvailable ? value : null;
      const userValue = (value: number) => userCountersAvailable ? value : null;
      const activationValue = (value: number) => activationCountersAvailable ? value : null;
      const paidValue = (value: number) => paidCountersAvailable ? value : null;
      const landingSessions = eventValue(row.landing_session_ids.size);
      const signupCtaSessions = eventValue(row.signup_cta_session_ids.size);
      const authCompleted = eventValue(row.auth_user_ids.size);
      const signups = userValue(row.signups);
      const activatedWorkspaces = activationValue(row.activated_workspaces);
      const activatedUsers = activationValue(row.activated_users);
      const activatedReps = activationValue(row.activated_rep_user_ids.size);
      const paidUsers = paidValue(row.paid_users);
      const retentionEligibleUsers = activationCountersAvailable
        ? row.retention_eligible_user_ids.size
        : null;
      const retainedUsers = activationCountersAvailable
        ? row.retained_user_ids.size
        : null;
      const retentionRate = retentionEligibleUsers
        ? retainedUsers / retentionEligibleUsers
        : null;
      const selfReportedLandingAssists = row.self_reported_landing_session_ids.size;
      const selfReportedSignupCtaAssists = row.self_reported_signup_cta_session_ids.size;
      const selfReportedSignupAssists = row.self_reported_signup_user_ids.size;
      const selfReportedActivatedWorkspaceAssists =
        row.self_reported_activated_workspace_user_ids.size;
      const selfReportedPaidAssists = row.self_reported_paid_user_ids.size;
      const hasVisitorAssist = Boolean(
        selfReportedLandingAssists
        || selfReportedSignupCtaAssists
        || selfReportedSignupAssists
        || selfReportedActivatedWorkspaceAssists
        || selfReportedPaidAssists
      );
      const rate = (numerator: number | null, denominator: number | null) => (
        typeof numerator === "number"
        && typeof denominator === "number"
        && denominator > 0
          ? numerator / denominator
          : null
      );
      return {
        source: row.source,
        medium: row.medium,
        campaign: row.campaign,
        content: row.content,
        format: row.format,
        hook: row.hook,
        cta_channel: row.cta_channel,
        snapshot_days: row.snapshot_days,
        published_at: row.published_at_ms
          ? new Date(row.published_at_ms).toISOString()
          : null,
        conversion_cutoff_at: row.conversion_cutoff_ms
          ? new Date(row.conversion_cutoff_ms).toISOString()
          : null,
        cohort_start_at: row.published_at_ms
          ? new Date(row.published_at_ms).toISOString()
          : null,
        reach: row.reach,
        views: row.views,
        reach_observed: row.reach_observed,
        views_observed: row.views_observed,
        shares: row.shares,
        saves: row.saves,
        comments: row.comments,
        follows: row.follows,
        profile_visits: row.profile_visits,
        link_clicks: row.link_clicks,
        dm_intents: row.dm_intents,
        owned_intents: row.link_clicks + row.dm_intents,
        owned_intent_observed_fields: row.owned_intent_observed_fields,
        landing_sessions: landingSessions,
        signup_cta_sessions: signupCtaSessions,
        auth_completed: authCompleted,
        self_reported_landing_assists: selfReportedLandingAssists,
        self_reported_signup_cta_assists: selfReportedSignupCtaAssists,
        self_reported_signup_assists: selfReportedSignupAssists,
        self_reported_activated_workspace_assists:
          selfReportedActivatedWorkspaceAssists,
        self_reported_paid_assists: selfReportedPaidAssists,
        self_reported_assist_method: hasVisitorAssist ? "visitor_self_report" : null,
        attribution_granularity: row.attribution_granularity,
        attribution_method: row.attribution_method,
        conversion_evidence: row.conversion_evidence,
        post_conversion_eligible: row.post_conversion_eligible,
        conversion_conclusion: conversionConclusion,
        conversion_counters_available: conversionCountersAvailable,
        decision_signups: signups,
        decision_activated_workspaces: activatedWorkspaces,
        signups,
        acquired_users: userValue(row.acquired_users),
        activated_workspaces: activatedWorkspaces,
        activated_users: activatedUsers,
        paid_users: paidUsers,
        manager_signups: userValue(row.manager_signups),
        rep_signups: userValue(row.rep_signups),
        active_rep_roster: null,
        joined_reps: null,
        activated_reps: activatedReps,
        rep_identity_conflicts: null,
        retention_window_days: RETENTION_WINDOW_DAYS,
        retention_mature: bounded
          && row.conversion_cutoff_ms
            >= row.published_at_ms + RETENTION_WINDOW_DAYS * DAY_MS,
        retention_eligible_users: retentionEligibleUsers,
        retained_users: retainedUsers,
        retention_rate: retentionRate,
        activation_timing_complete: row.post_conversion_eligible
          ? activationCountersAvailable
          : false,
        paid_timing_complete: row.post_conversion_eligible
          ? paidCountersAvailable
          : false,
        first_activation_at: activationCountersAvailable && row.first_activation_ms
          ? new Date(row.first_activation_ms).toISOString()
          : null,
        last_activation_at: activationCountersAvailable && row.last_activation_ms
          ? new Date(row.last_activation_ms).toISOString()
          : null,
        missing_event_timestamps: row.missing_event_timestamps,
        missing_user_timestamps: row.missing_user_timestamps,
        activation_timing_missing_users: row.activation_timing_missing_users,
        paid_timing_missing_users: row.paid_timing_missing_users,
        excluded_prepublication_events: row.excluded_prepublication_events,
        excluded_post_cutoff_events: row.excluded_post_cutoff_events,
        excluded_synthetic_events: row.excluded_synthetic_events,
        excluded_prepublication_users: row.excluded_prepublication_users,
        excluded_post_cutoff_users: row.excluded_post_cutoff_users,
        excluded_invalid_timing_users: row.excluded_invalid_timing_users,
        excluded_synthetic_users: row.excluded_synthetic_users,
        reach_to_landing_rate: row.reach_observed && row.reach > 0
          ? rate(landingSessions, row.reach)
          : null,
        landing_to_cta_rate: rate(signupCtaSessions, landingSessions),
        cta_to_signup_rate: rate(signups, signupCtaSessions),
        reach_to_signup_rate: row.reach_observed && row.reach > 0
          ? rate(signups, row.reach)
          : null,
        reach_to_activation_rate: row.reach_observed && row.reach > 0
          ? rate(activatedUsers, row.reach)
          : null,
        activation_rate: rate(activatedWorkspaces, signups),
        users_per_activated_workspace: rate(activatedUsers, activatedWorkspaces),
        paid_rate: rate(paidUsers, activatedWorkspaces),
        roster_to_join_rate: null,
        joined_to_activation_rate: null,
        first_signup_at: userCountersAvailable && row.first_signup_ms
          ? new Date(row.first_signup_ms).toISOString()
          : null,
        last_signup_at: userCountersAvailable && row.last_signup_ms
          ? new Date(row.last_signup_ms).toISOString()
          : null,
      };
    })
    .sort((left, right) => (
      Number(right.activated_users || 0) - Number(left.activated_users || 0)
      || Number(right.signups || 0) - Number(left.signups || 0)
      || right.reach - left.reach
      || left.source.localeCompare(right.source)
      || left.content.localeCompare(right.content)
    ));
}

function safeIso(value: any): string | null {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function safeBufferMetricCollection(plan: any, jobs: any[]): any | null {
  if (
    normalized(plan?.delivery_managed_by) !== "buffer"
    && normalized(plan?.sprint) !== "content-engine"
  ) {
    return null;
  }
  const publishedAt = dateValue(plan, ["published_at"]);
  const exactJobs = jobs.filter((job) => (
    normalized(job?.provider) === "buffer"
    && assetKey(
      job?.campaign,
      job?.platform_content_id,
      job?.platform,
    ) === assetKey(plan?.campaign, plan?.content, recordPlatform(plan))
    && dateValue(job, ["metrics_published_at"]) === publishedAt
  ));
  if (exactJobs.length !== 1) {
    return {
      provider: "buffer",
      status: exactJobs.length > 1 ? "conflict" : "unlinked",
      checkpoints: [],
      next_attempt_at: null,
      sync_completed_at: null,
    };
  }

  const job = exactJobs[0];
  const checkpointGroups = new Map<number, any[]>();
  for (const checkpoint of asArray(job?.metrics_checkpoints)) {
    const snapshotDays = Number(checkpoint?.snapshot_days);
    const status = normalized(checkpoint?.status);
    if (![1, 3, 7, 30].includes(snapshotDays)) continue;
    if (!["captured", "review_needed"].includes(status)) continue;
    if (!checkpointGroups.has(snapshotDays)) checkpointGroups.set(snapshotDays, []);
    checkpointGroups.get(snapshotDays)?.push(checkpoint);
  }
  if ([...checkpointGroups.values()].some((records) => records.length > 1)) {
    return {
      provider: "buffer",
      status: "conflict",
      checkpoints: [],
      next_attempt_at: safeIso(job?.metrics_next_checkpoint_at),
      sync_completed_at: safeIso(job?.metrics_sync_completed_at),
    };
  }
  const checkpoints = [...checkpointGroups.entries()]
    .map(([snapshotDays, records]) => {
      const checkpoint = records[0];
      return {
        snapshot_days: snapshotDays,
        status: normalized(checkpoint?.status),
        due_at: safeIso(checkpoint?.due_at),
        window_closes_at: safeIso(checkpoint?.window_closes_at),
        recorded_at: safeIso(checkpoint?.recorded_at),
        error_code: normalized(checkpoint?.error_code) || null,
      };
    })
    .sort((left, right) => left.snapshot_days - right.snapshot_days);
  return {
    provider: "buffer",
    status: job?.metrics_sync_completed_at ? "complete" : "collecting",
    checkpoints,
    next_attempt_at: safeIso(job?.metrics_next_checkpoint_at),
    sync_completed_at: safeIso(job?.metrics_sync_completed_at),
  };
}

function buildContentQueue(
  plans: any[],
  metricCheckpoints: any[],
  byContent: any[],
  publishJobs: any[],
  asOf: number,
) {
  const checkpointsByAsset = new Map<string, any[]>();
  for (const metric of metricCheckpoints) {
    const key = assetKey(
      metric?.campaign,
      metric?.content,
      recordPlatform(metric),
    );
    if (!checkpointsByAsset.has(key)) checkpointsByAsset.set(key, []);
    checkpointsByAsset.get(key)?.push(metric);
  }
  const conversionsByAsset = new Map(byContent.map((row) => [
    assetKey(row?.campaign, row?.content, row?.source),
    row,
  ]));

  const queue = plans.map((plan) => {
    const platform = recordPlatform(plan);
    const key = assetKey(plan?.campaign, plan?.content, platform);
    const snapshotDays = Number(plan?.snapshot_days || 7);
    const plannedPublishAt = dateValue(plan, ["planned_publish_at"]);
    const publishedAt = dateValue(plan, ["published_at"]);
    const deliveryManagedBy = normalized(plan?.delivery_managed_by) === "buffer"
      || normalized(plan?.sprint) === "content-engine"
      ? "buffer"
      : "manual";
    const recordedDeliveryStatus = normalized(plan?.delivery_status);
    const deliveryStatus = ["planned", "published", "canceled"].includes(
      recordedDeliveryStatus,
    )
      ? recordedDeliveryStatus
      : publishedAt > 0
        ? "published"
        : "planned";
    const canceled = deliveryStatus === "canceled" && publishedAt <= 0;
    const snapshotDueAt = publishedAt > 0
      ? publishedAt + snapshotDays * DAY_MS
      : 0;
    const snapshotWindowClosesAt = snapshotDueAt > 0
      ? snapshotDueAt + SNAPSHOT_GRACE_MS
      : 0;
    const checkpoints = checkpointsByAsset.get(key) || [];
    const canonicalMetric = checkpoints.find(
      (metric) => Number(metric?.snapshot_days || 7) === snapshotDays,
    ) || null;
    const capturedAt = dateValue(canonicalMetric, ["snapshot_captured_at"]);
    const fixedSnapshotCaptured = snapshotDueAt > 0
      && capturedAt >= snapshotDueAt
      && capturedAt <= snapshotWindowClosesAt;
    const snapshotWindowMissed = snapshotWindowClosesAt > 0
      && asOf > snapshotWindowClosesAt
      && !fixedSnapshotCaptured;
    const capturedCheckpointDays = checkpoints
      .filter((metric) => {
        const checkpointDays = Number(metric?.snapshot_days || 7);
        const checkpointCapturedAt = dateValue(metric, ["snapshot_captured_at"]);
        const checkpointDueAt = publishedAt + checkpointDays * DAY_MS;
        return publishedAt > 0
          && checkpointCapturedAt >= checkpointDueAt
          && checkpointCapturedAt <= checkpointDueAt + SNAPSHOT_GRACE_MS;
      })
      .map((metric) => Number(metric?.snapshot_days || 7));
    const capturedCheckpointSet = new Set(capturedCheckpointDays);
    const highestCapturedEarlyDays = Math.max(
      0,
      ...capturedCheckpointDays.filter((checkpointDays) => checkpointDays < snapshotDays),
    );
    const nextEarlySnapshotDays = [3, 1].find((checkpointDays) => (
      publishedAt > 0
      && checkpointDays < snapshotDays
      && checkpointDays > highestCapturedEarlyDays
      && asOf >= publishedAt + checkpointDays * DAY_MS
      && asOf <= publishedAt + checkpointDays * DAY_MS + SNAPSHOT_GRACE_MS
      && !capturedCheckpointSet.has(checkpointDays)
    )) || null;
    const earlyMetric = latestRecord(
      checkpoints.filter((metric) => {
        const checkpointDays = Number(metric?.snapshot_days || 7);
        const value = dateValue(metric, ["snapshot_captured_at"]);
        const checkpointDueAt = publishedAt + checkpointDays * DAY_MS;
        return checkpointDays < snapshotDays
          && publishedAt > 0
          && value >= checkpointDueAt
          && value <= checkpointDueAt + SNAPSHOT_GRACE_MS
          && value > 0
          && (!snapshotDueAt || value < snapshotDueAt);
      }),
      ["snapshot_captured_at", "updated_date", "created_date"],
    );
    const evidenceCurrent = Boolean(
      fixedSnapshotCaptured
      && plan?.review_decision
      && plan?.review_evidence_hash
      && canonicalMetric?.snapshot_fingerprint
      && String(plan.review_evidence_hash) === String(canonicalMetric.snapshot_fingerprint)
      && dateValue(plan, ["review_snapshot_captured_at"]) === capturedAt
    );
    const decisionStale = Boolean(plan?.review_decision && !evidenceCurrent);
    let state = "planned";
    if (canceled) {
      state = "canceled";
    } else if (fixedSnapshotCaptured) {
      state = evidenceCurrent ? "reviewed" : "review_due";
    } else if (snapshotWindowMissed) {
      state = "snapshot_missed";
    } else if (publishedAt > 0) {
      state = asOf >= snapshotDueAt ? "snapshot_due" : "published";
    } else if (plannedPublishAt > 0 && asOf >= plannedPublishAt) {
      state = "publish_due";
    }
    let snapshotStatus = "scheduled";
    if (publishedAt > 0 && fixedSnapshotCaptured) {
      snapshotStatus = "captured";
    } else if (publishedAt > 0 && snapshotWindowMissed) {
      snapshotStatus = "missed";
    } else if (publishedAt > 0 && asOf >= snapshotDueAt) {
      snapshotStatus = "due";
    } else if (publishedAt > 0) {
      snapshotStatus = "collecting";
    }
    const conversion = conversionsByAsset.get(key) || {};
    const conversionCounter = (field: string): number | null => (
      typeof conversion?.[field] === "number"
        && Number.isFinite(conversion[field])
        && conversion[field] >= 0
        ? conversion[field]
        : null
    );
    const metricCollection = safeBufferMetricCollection(plan, publishJobs);
    const observedPlatformNativeExposureFields = ["reach", "views"].filter(
      (field) => (
        metricFieldObserved(canonicalMetric, field)
        && Number.isSafeInteger(Number(canonicalMetric?.[field]))
        && Number(canonicalMetric?.[field]) >= 0
      ),
    );
    const socialEvidenceHash = fixedSnapshotCaptured
        && /^[a-f0-9]{64}$/.test(String(canonicalMetric?.snapshot_fingerprint || ""))
      ? String(canonicalMetric.snapshot_fingerprint)
      : null;
    return {
      platform,
      campaign: normalized(plan?.campaign) || "1000-users",
      content: normalized(plan?.content),
      sprint: normalized(plan?.sprint),
      sequence: Number(plan?.sequence || 0),
      format: normalized(plan?.format),
      audience: String(plan?.audience || ""),
      hook: String(plan?.hook || ""),
      script: String(plan?.script || ""),
      cta_label: String(plan?.cta_label || ""),
      cta_channel: normalized(plan?.cta_channel),
      primary_metric: String(plan?.primary_metric || ""),
      hypothesis: String(plan?.hypothesis || ""),
      comparison_group: normalized(plan?.comparison_group),
      major_variable: String(plan?.major_variable || ""),
      planned_publish_at: plannedPublishAt
        ? new Date(plannedPublishAt).toISOString()
        : null,
      published_at: publishedAt ? new Date(publishedAt).toISOString() : null,
      delivery_managed_by: deliveryManagedBy,
      delivery_status: deliveryStatus,
      snapshot_days: snapshotDays,
      snapshot_due_at: snapshotDueAt
        ? new Date(snapshotDueAt).toISOString()
        : null,
      snapshot_window_closes_at: snapshotWindowClosesAt
        ? new Date(snapshotWindowClosesAt).toISOString()
        : null,
      snapshot_window_missed: snapshotWindowMissed,
      fixed_snapshot_captured_at: fixedSnapshotCaptured
        ? new Date(capturedAt).toISOString()
        : null,
      early_snapshot_days: earlyMetric
        ? Number(earlyMetric?.snapshot_days || 0)
        : null,
      early_snapshot_captured_at: earlyMetric
        ? new Date(dateValue(earlyMetric, ["snapshot_captured_at"])).toISOString()
        : null,
      captured_checkpoint_days: [...new Set(capturedCheckpointDays)]
        .sort((left, right) => left - right),
      next_early_snapshot_days: nextEarlySnapshotDays,
      next_early_snapshot_due_at: nextEarlySnapshotDays && publishedAt
        ? new Date(publishedAt + nextEarlySnapshotDays * DAY_MS).toISOString()
        : null,
      state,
      snapshot_status: snapshotStatus,
      metric_collection: metricCollection,
      publish_overdue: !canceled
        && !publishedAt
        && plannedPublishAt > 0
        && asOf >= plannedPublishAt,
      decision: evidenceCurrent ? normalized(plan?.review_decision) : null,
      decision_note: evidenceCurrent ? String(plan?.review_note || "") : "",
      decision_at: evidenceCurrent && dateValue(plan, ["reviewed_at"])
        ? new Date(dateValue(plan, ["reviewed_at"])).toISOString()
        : null,
      decision_stale: decisionStale,
      decision_policy_id: DECISION_POLICY_ID,
      decision_policy_base_supported: Boolean(
        fixedSnapshotCaptured
        && socialEvidenceHash
        && observedPlatformNativeExposureFields.length > 0
      ),
      social_evidence_hash: socialEvidenceHash,
      observed_platform_native_exposure_fields:
        observedPlatformNativeExposureFields,
      comparable_fixed_age_snapshots: 0,
      review_schema_version: evidenceCurrent
        ? normalized(plan?.review_schema_version) || null
        : null,
      decision_policy_reason_codes: evidenceCurrent
          && normalized(plan?.review_decision_policy_id) === DECISION_POLICY_ID
          && Array.isArray(plan?.review_decision_policy_reason_codes)
        ? plan.review_decision_policy_reason_codes
        : [],
      decision_policy_evidence_hash: evidenceCurrent
        ? String(plan?.review_decision_policy_evidence_hash || "") || null
        : null,
      reviewed_comparable_fixed_age_snapshots: evidenceCurrent
        ? Number(plan?.review_comparable_fixed_age_snapshots || 0)
        : null,
      decision_override_note: evidenceCurrent
        ? String(plan?.review_decision_override_note || "") || null
        : null,
      decision_override_hash: evidenceCurrent
        ? String(plan?.review_decision_override_hash || "") || null
        : null,
      review_identity_hash: evidenceCurrent
        ? String(plan?.review_identity_hash || "") || null
        : null,
      reach: Number(canonicalMetric?.reach || 0),
      views: Number(canonicalMetric?.views || 0),
      conversion_conclusion: normalized(conversion?.conversion_conclusion) || null,
      conversion_counters_available:
        conversion?.conversion_counters_available === true,
      owned_intents: conversionCounter("owned_intents"),
      landing_sessions: conversionCounter("landing_sessions"),
      signups: conversionCounter("decision_signups"),
      activated_workspaces: conversionCounter("decision_activated_workspaces"),
      activated_users: conversionCounter("activated_users"),
      activated_reps: conversionCounter("activated_reps"),
      paid_users: conversionCounter("paid_users"),
      retention_window_days: Number(conversion?.retention_window_days || 0) || null,
      retention_mature: conversion?.retention_mature === true,
      retention_eligible_users: conversionCounter("retention_eligible_users"),
      retained_users: conversionCounter("retained_users"),
      retention_rate: typeof conversion?.retention_rate === "number"
          && Number.isFinite(conversion.retention_rate)
        ? conversion.retention_rate
        : null,
      self_reported_signup_assists: Number(
        conversion?.self_reported_signup_assists || 0,
      ),
      self_reported_activated_workspace_assists: Number(
        conversion?.self_reported_activated_workspace_assists || 0,
      ),
      hold_eligible: false,
    };
  }).sort((left, right) => (
    String(left.planned_publish_at || "").localeCompare(
      String(right.planned_publish_at || ""),
    )
    || left.sequence - right.sequence
    || left.content.localeCompare(right.content)
  ));

  const completedByGroup = new Map<string, number>();
  for (const item of queue) {
    if (
      !item.fixed_snapshot_captured_at
      || item.observed_platform_native_exposure_fields.length < 1
    ) continue;
    const groupKey = `${item.platform}|${item.campaign}|${item.comparison_group}|${item.snapshot_days}`;
    completedByGroup.set(
      groupKey,
      (completedByGroup.get(groupKey) || 0) + 1,
    );
  }
  for (const item of queue) {
    const groupKey = `${item.platform}|${item.campaign}|${item.comparison_group}|${item.snapshot_days}`;
    item.comparable_fixed_age_snapshots = completedByGroup.get(groupKey) || 0;
    item.hold_eligible = item.decision_policy_base_supported
      && item.comparable_fixed_age_snapshots >= 3;
  }

  const nextPublish = queue.find(
    (item) => !item.published_at && item.delivery_status !== "canceled",
  ) || null;
  const canonicalSnapshotDue = [...queue]
    .filter((item) => (
      item.published_at
      && !item.fixed_snapshot_captured_at
      && !item.snapshot_window_missed
      && item.snapshot_due_at
      && asOf >= new Date(item.snapshot_due_at).getTime()
    ))
    .sort((left, right) => (
      String(left.snapshot_due_at || "").localeCompare(
        String(right.snapshot_due_at || ""),
      )
    ))[0] || null;
  const earlySnapshotDue = [...queue]
    .filter((item) => (
      item.published_at
      && !item.fixed_snapshot_captured_at
      && !item.snapshot_window_missed
      && item.next_early_snapshot_days
    ))
    .sort((left, right) => (
      String(left.next_early_snapshot_due_at || "").localeCompare(
        String(right.next_early_snapshot_due_at || ""),
      )
    ))[0] || null;
  const scheduledSnapshot = [...queue]
    .filter((item) => (
      item.published_at
      && !item.fixed_snapshot_captured_at
      && !item.snapshot_window_missed
    ))
    .sort((left, right) => (
      String(left.snapshot_due_at || "").localeCompare(
        String(right.snapshot_due_at || ""),
      )
    ))[0] || null;
  const nextSnapshotBase = canonicalSnapshotDue || earlySnapshotDue || scheduledSnapshot;
  const nextSnapshot = nextSnapshotBase
    ? {
      ...nextSnapshotBase,
      snapshot_action_days: canonicalSnapshotDue
        ? nextSnapshotBase.snapshot_days
        : earlySnapshotDue
          ? nextSnapshotBase.next_early_snapshot_days
          : null,
      snapshot_action_due_at: canonicalSnapshotDue
        ? nextSnapshotBase.snapshot_due_at
        : earlySnapshotDue
          ? nextSnapshotBase.next_early_snapshot_due_at
          : null,
      snapshot_provider_checkpoint_status:
        nextSnapshotBase.delivery_managed_by === "buffer"
          ? nextSnapshotBase.metric_collection?.checkpoints?.find(
            (checkpoint: any) => Number(checkpoint?.snapshot_days) === Number(
              canonicalSnapshotDue
                ? nextSnapshotBase.snapshot_days
                : earlySnapshotDue
                  ? nextSnapshotBase.next_early_snapshot_days
                  : 0,
            ),
          )?.status || nextSnapshotBase.metric_collection?.status || "unlinked"
          : "manual",
      snapshot_manual_entry_allowed:
        nextSnapshotBase.delivery_managed_by !== "buffer"
        || nextSnapshotBase.metric_collection?.checkpoints?.some(
          (checkpoint: any) => (
            Number(checkpoint?.snapshot_days) === Number(
              canonicalSnapshotDue
                ? nextSnapshotBase.snapshot_days
                : earlySnapshotDue
                  ? nextSnapshotBase.next_early_snapshot_days
                  : 0,
            )
            && normalized(checkpoint?.status) === "review_needed"
          ),
        ) === true,
    }
    : null;
  const nextDecision = [...queue]
    .filter((item) => item.fixed_snapshot_captured_at && !item.decision)
    .sort((left, right) => (
      String(left.fixed_snapshot_captured_at || "").localeCompare(
        String(right.fixed_snapshot_captured_at || ""),
      )
    ))[0] || null;
  const summary = queue.reduce((totals: any, item) => {
    totals[item.state] = Number(totals[item.state] || 0) + 1;
    return totals;
  }, {
    total: queue.length,
    planned: 0,
    publish_due: 0,
    published: 0,
    snapshot_due: 0,
    snapshot_missed: 0,
    review_due: 0,
    reviewed: 0,
    canceled: 0,
  });

  return {
    summary,
    next_publish: nextPublish,
    next_snapshot: nextSnapshot,
    next_decision: nextDecision,
    items: queue,
  };
}

function reportResponse(data: any, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  try {
    const requested = await requestedConversionScope(req);
    if (requested.error) {
      return reportResponse({ error: requested.error }, 400);
    }
    const requestScope = requested.scope;
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) {
      return reportResponse({ error: "unauthorized" }, 401);
    }
    if (!canViewGrowth(user)) {
      return reportResponse({ error: "growth_admin_required" }, 403);
    }

    const [
      users,
      routes,
      canvasSessions,
      interactions,
      teamMembers,
      events,
      metrics,
      contentPlans,
      publishJobs,
    ] = await Promise.all([
      listAll(base44.asServiceRole.entities.User, MAX_USERS, "User report"),
      listAll(
        base44.asServiceRole.entities.SavedRoute,
        MAX_ACTIVITY_RECORDS,
        "Saved route report",
      ),
      listAll(
        base44.asServiceRole.entities.CanvasSession,
        MAX_ACTIVITY_RECORDS,
        "Canvas campaign report",
      ),
      listAll(
        base44.asServiceRole.entities.InteractionLog,
        MAX_ACTIVITY_RECORDS,
        "Interaction activity report",
      ),
      listAll(
        base44.asServiceRole.entities.TeamMember,
        MAX_ACTIVITY_RECORDS,
        "Team member report",
      ),
      listAll(
        base44.asServiceRole.entities.AcquisitionEvent,
        MAX_GROWTH_RECORDS,
        "Acquisition event report",
      ),
      listAll(
        base44.asServiceRole.entities.GrowthContentMetric,
        MAX_GROWTH_RECORDS,
        "Growth content report",
      ),
      listAll(
        base44.asServiceRole.entities.GrowthContentPlan,
        MAX_GROWTH_RECORDS,
        "Growth content plan report",
      ),
      listAll(
        base44.asServiceRole.entities.GrowthPublishJob,
        MAX_GROWTH_RECORDS,
        "Growth publish job report",
      ),
    ]);
    const activationIndex = buildActivationIndex(routes, canvasSessions);
    const activityIndex = buildActivityIndex(
      users,
      routes,
      canvasSessions,
      interactions,
      teamMembers,
    );
    const timelines = buildProductTimelines(
      users,
      routes,
      canvasSessions,
      interactions,
      teamMembers,
      events,
    );
    const usersById = new Map(users.map((candidate) => [
      String(candidate?.id || ""),
      candidate,
    ]));
    const rosterGroups = activeRepRoster(teamMembers, usersById);
    const plans = canonicalContentPlans(contentPlans);
    const metricCheckpoints = canonicalMetricCheckpoints(metrics);
    let operatingMetrics = operatingContentMetrics(metricCheckpoints, plans);
    if (requestScope) {
      const requestedKey = assetKey(
        requestScope.campaign,
        requestScope.content,
        requestScope.platform,
      );
      const requestedPlan = plans.filter((plan) => (
        assetKey(plan?.campaign, plan?.content, recordPlatform(plan)) === requestedKey
      ));
      const requestedMetrics = operatingMetrics.filter((metric) => (
        assetKey(metric?.campaign, metric?.content, recordPlatform(metric)) === requestedKey
        && dateValue(metric, ["snapshot_captured_at"]) === requestScope.cutoff_ms
      ));
      if (
        requestedPlan.length !== 1
        || requestedMetrics.length !== 1
        || dateValue(requestedPlan[0], ["published_at"]) <= 0
        || dateValue(requestedPlan[0], ["published_at"]) > requestScope.cutoff_ms
      ) {
        return reportResponse({ error: "conversion_scope_unavailable" }, 409);
      }
      operatingMetrics = requestedMetrics;
    }
    const byContent = contentRows(
      users,
      usersById,
      activationIndex,
      events,
      operatingMetrics,
      plans,
      rosterGroups,
      timelines,
      requestScope,
    );
    const paceEvidence = buildPaceEvidence(
      users,
      usersById,
      activationIndex,
      activityIndex,
      operatingMetrics,
      plans,
      rosterGroups,
    );
    const generatedAt = new Date().toISOString();
    return reportResponse({
      success: true,
      generated_at: generatedAt,
      request_scope: requestScope
        ? {
          platform: requestScope.platform,
          campaign: requestScope.campaign,
          content: requestScope.content,
          cohort_start_at: byContent[0]?.cohort_start_at || null,
          conversion_cutoff_at: requestScope.cutoff_at,
        }
        : null,
      all_time: summarize(
        users,
        usersById,
        activationIndex,
        activityIndex,
        events,
        operatingMetrics,
        rosterGroups,
      ),
      last_28_days: summarize(
        users.filter((candidate) => isRecent(candidate, 28, ["created_date"])),
        usersById,
        activationIndex,
        activityIndex,
        events.filter((event) => isRecent(event, 28, ["occurred_at", "created_date"])),
        operatingMetrics.filter((metric) => isRecent(metric, 28, [
          "published_at",
          "snapshot_captured_at",
          "created_date",
        ])),
        rosterGroups,
      ),
      last_7_days: summarize(
        users.filter((candidate) => isRecent(candidate, 7, ["created_date"])),
        usersById,
        activationIndex,
        activityIndex,
        events.filter((event) => isRecent(event, 7, ["occurred_at", "created_date"])),
        operatingMetrics.filter((metric) => isRecent(metric, 7, [
          "published_at",
          "snapshot_captured_at",
          "created_date",
        ])),
        rosterGroups,
      ),
      pace_evidence: paceEvidence,
      by_content: byContent,
      content_queue: buildContentQueue(
        plans,
        metricCheckpoints,
        byContent,
        publishJobs,
        new Date(generatedAt).getTime(),
      ),
      definitions: {
        acquisition_unit: "manager_workspace",
        manager_activation: "saved route with at least one property or deployed Canvas campaign",
        rep_activation: "first logged door outcome",
        attribution_model: "first touch",
        content_attribution_boundary: "post-level conversion association requires a content-preserving declared link; static bio and referrer-only touches remain platform-level",
        content_conversion_window: "publication timestamp through the explicitly requested fixed checkpoint cutoff; prepublication, synthetic, missing-time, and post-cutoff records are never credited",
        social_only_conclusion: "ordinary feed posts without a declared clickable handoff remain reviewable from social evidence with inconclusive_no_declared_link and null post-conversion counters",
        content_retention: "a content-attributed activated user becomes retention-eligible 30 days after timestamped activation and is retained only with later verified activity inside the 30 days ending at the frozen cutoff",
        visitor_reported_assist: "optional visitor selection from confirmed recent Buffer posts; shown separately and excluded from Repeat, Iterate, and Hold conversion evidence",
        team_attribution: "current active rep roster state rolls up to the acquiring manager workspace",
        active_rep_roster: "unique active rep roster seat by manager and normalized email",
        joined_rep: "active roster seat linked to exactly one matching rep User by user ID, manager, and email",
        team_multiplier_window_basis: "current roster, join, and activation state for managers whose accounts were created in the reporting window",
        reach_source: "fixed-age Buffer evidence or an owner-entered Instagram Insights or TikTok analytics snapshot",
        cumulative_post_reach: "sum of canonical per-asset reach; the same account may repeat across posts and platforms, so this is not unique campaign reach",
        pace_reach_basis: "Instagram cumulative post reach only; TikTok views remain a separate diagnostic and are never added to or converted into reach",
        anonymous_funnel: "unique pseudonymous browser sessions; no names, emails, or contact fields before auth",
        north_star: "activated users with verified product activity in the last 30 days",
        instagram_retained_active_user: "Instagram-attributed manager or active-team rep with verified product activity in the last 30 days",
        tiktok_retained_active_user: "TikTok-attributed manager or active-team rep with verified product activity in the last 30 days",
        social_retained_active_user: "Instagram- or TikTok-attributed manager or active-team rep with verified product activity in the last 30 days",
        reporting_window_user_basis: "manager accounts created in the window; activation and team metrics reflect their current verified state",
        pace_evidence_scope: "canonical mature 1000-users assets backed by a published GrowthContentPlan; release smoke, unplanned assets, and other campaigns are excluded",
        pace_observed_throughput: "current retained-active users whose accounts were created in the last 28 days; descriptive gross cohort contribution, not net retained-stock growth or an ETA",
      },
    });
  } catch (error: any) {
    console.error("[getAcquisitionReport]", error?.message || error);
    if (error?.code === "growth_content_conflict") {
      return reportResponse({ error: "growth_content_conflict" }, 409);
    }
    return reportResponse({ error: "acquisition_report_unavailable" }, 503);
  }
});
