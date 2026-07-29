import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const PAGE_SIZE = 5000;
const MAX_USERS = 10000;
const MAX_ACTIVITY_RECORDS = 100000;
const MAX_GROWTH_RECORDS = 25000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PACE_CAMPAIGN = "1000-users";
const PACE_OBSERVATION_DAYS = 28;
const PACE_EXCLUDED_CONTENT = new Set(["ig-release-smoke"]);
const SOCIAL_PLATFORMS = new Set(["instagram", "tiktok"]);
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
    decision: normalized(plan?.review_decision),
    note: String(plan?.review_note || ""),
    snapshot_captured_at: dateValue(plan, ["review_snapshot_captured_at"]),
    evidence_hash: String(plan?.review_evidence_hash || ""),
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

function hasContentSnapshot(metric: any): boolean {
  const capturedAt = dateValue(metric, ["snapshot_captured_at"]);
  const reach = Number(metric?.reach);
  return capturedAt > 0
    && Number.isSafeInteger(reach)
    && reach >= 0;
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
      return metric
        && publishedAt > 0
        && capturedAt >= publishedAt + expected * DAY_MS
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
  "content_assets",
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
  return {
    reach: platformMetrics.reduce(
      (total, metric) => total + Math.max(0, Number(metric?.reach || 0)),
      0,
    ),
    content_assets: platformMetrics.length,
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
    const platformUsers = recentUsersForPlatform(platform);
    const managers = platformUsers.filter((user) => (
      ["manager", "admin"].includes(normalized(user?.app_role))
    ));
    return {
      reach: platformMetrics.reduce(
        (total, metric) => total + Math.max(0, Number(metric?.reach || 0)),
        0,
      ),
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
      instagram_content_assets: instagram.content_assets,
      instagram_activated_workspaces: instagram.activated_workspaces,
      instagram_retained_active_users_30d: instagram.retained_active_users_30d,
      tiktok_reach: tiktok.reach,
      tiktok_content_assets: tiktok.content_assets,
      tiktok_activated_workspaces: tiktok.activated_workspaces,
      tiktok_retained_active_users_30d: tiktok.retained_active_users_30d,
      social_reach: instagram.reach + tiktok.reach,
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

function contentRows(
  users: any[],
  allUsersById: Map<string, any>,
  activationIndex: any,
  events: any[],
  metrics: any[],
  rosterGroups: any[],
) {
  const activeMemberships = activeRepMemberships(rosterGroups);
  const rows = new Map<string, any>();
  const ensureRow = (platform: any, campaign: any, content: any) => {
    const cleanPlatform = socialPlatform(platform);
    const cleanCampaign = normalized(campaign) || "unassigned";
    const cleanContent = normalized(content) || "unassigned";
    const key = rowKey(cleanPlatform, cleanCampaign, cleanContent);
    if (!rows.has(key)) {
      rows.set(key, {
        source: cleanPlatform,
        medium: "organic_social",
        campaign: cleanCampaign,
        content: cleanContent,
        format: "",
        hook: "",
        snapshot_days: null,
        reach: 0,
        views: 0,
        shares: 0,
        saves: 0,
        comments: 0,
        follows: 0,
        profile_visits: 0,
        link_clicks: 0,
        dm_intents: 0,
        landing_session_ids: new Set<string>(),
        signup_cta_session_ids: new Set<string>(),
        auth_user_ids: new Set<string>(),
        signups: 0,
        acquired_users: 0,
        activated_workspaces: 0,
        activated_users: 0,
        paid_users: 0,
        manager_signups: 0,
        rep_signups: 0,
        active_rep_roster_keys: new Set<string>(),
        joined_rep_user_ids: new Set<string>(),
        activated_rep_user_ids: new Set<string>(),
        rep_identity_conflicts: 0,
        first_signup_at: null,
        last_signup_at: null,
        metric_timestamp: 0,
      });
    }
    return rows.get(key);
  };

  // Keep the most recently captured cumulative snapshot per platform asset.
  for (const metric of metrics) {
    const row = ensureRow(
      recordPlatform(metric),
      metric?.campaign,
      metric?.content,
    );
    const metricTimestamp = dateValue(metric, [
      "snapshot_captured_at",
      "updated_date",
      "created_date",
    ]);
    if (metricTimestamp < row.metric_timestamp) continue;
    row.metric_timestamp = metricTimestamp;
    row.format = normalized(metric?.format);
    row.hook = String(metric?.hook || "");
    row.snapshot_days = Number(metric?.snapshot_days || 0) || null;
    for (const field of [
      "reach",
      "views",
      "shares",
      "saves",
      "comments",
      "follows",
      "profile_visits",
      "link_clicks",
      "dm_intents",
    ]) {
      row[field] = Math.max(0, Number(metric?.[field] || 0));
    }
  }

  for (const event of events) {
    const source = normalized(event?.source);
    if (!SOCIAL_PLATFORMS.has(source)) continue;
    const row = ensureRow(source, event?.campaign, event?.content);
    if (event?.event_name === "landing_viewed" && event?.session_id) {
      row.landing_session_ids.add(String(event.session_id));
    }
    if (event?.event_name === "signup_cta_clicked" && event?.session_id) {
      row.signup_cta_session_ids.add(String(event.session_id));
    }
    if (event?.event_name === "auth_completed" && event?.user_id) {
      row.auth_user_ids.add(String(event.user_id));
    }
  }

  for (const user of users) {
    const touch = acquisitionTouchForUser(user, allUsersById, activeMemberships);
    const source = normalized(touch?.source);
    if (!SOCIAL_PLATFORMS.has(source)) continue;
    const row = ensureRow(source, touch?.campaign, touch?.content);
    row.medium = normalized(touch?.medium) || "organic_social";
    row.acquired_users += 1;
    if (isActivated(user, activationIndex)) row.activated_users += 1;
    if (normalized(user?.app_role) === "manager" || normalized(user?.app_role) === "admin") {
      row.signups += 1;
      row.manager_signups += 1;
      if (isActivated(user, activationIndex)) row.activated_workspaces += 1;
      if (isPaid(user)) row.paid_users += 1;
    }
    if (normalized(user?.app_role) === "rep") row.rep_signups += 1;

    const createdAt = String(user?.created_date || touch?.captured_at || "");
    if (createdAt) {
      if (!row.first_signup_at || createdAt < row.first_signup_at) row.first_signup_at = createdAt;
      if (!row.last_signup_at || createdAt > row.last_signup_at) row.last_signup_at = createdAt;
    }
  }

  for (const group of rosterGroups) {
    const manager = allUsersById.get(String(group?.manager_id || ""));
    const touch = manager?.acquisition_first_touch;
    const source = normalized(touch?.source);
    if (!SOCIAL_PLATFORMS.has(source)) continue;
    const row = ensureRow(source, touch?.campaign, touch?.content);
    row.active_rep_roster_keys.add(group.key);
    if (group.identity_conflict) row.rep_identity_conflicts += 1;
    const joinedUser = group.joined_user;
    if (joinedUser?.id) {
      const joinedKey = membershipKey(group.manager_id, joinedUser.id);
      row.joined_rep_user_ids.add(joinedKey);
      if (Number(joinedUser?.outcomes_logged || 0) > 0) {
        row.activated_rep_user_ids.add(joinedKey);
      }
    }
  }

  return [...rows.values()]
    .map((row) => {
      const landingSessions = row.landing_session_ids.size;
      const signupCtaSessions = row.signup_cta_session_ids.size;
      const authCompleted = row.auth_user_ids.size;
      const ownedIntents = row.link_clicks + row.dm_intents;
      const activeRepRosterCount = row.active_rep_roster_keys.size;
      const joinedReps = row.joined_rep_user_ids.size;
      const activatedReps = row.activated_rep_user_ids.size;
      return {
        source: row.source,
        medium: row.medium,
        campaign: row.campaign,
        content: row.content,
        format: row.format,
        hook: row.hook,
        snapshot_days: row.snapshot_days,
        reach: row.reach,
        views: row.views,
        shares: row.shares,
        saves: row.saves,
        comments: row.comments,
        follows: row.follows,
        profile_visits: row.profile_visits,
        link_clicks: row.link_clicks,
        dm_intents: row.dm_intents,
        owned_intents: ownedIntents,
        landing_sessions: landingSessions,
        signup_cta_sessions: signupCtaSessions,
        auth_completed: authCompleted,
        signups: row.signups,
        acquired_users: row.acquired_users,
        activated_workspaces: row.activated_workspaces,
        activated_users: row.activated_users,
        paid_users: row.paid_users,
        manager_signups: row.manager_signups,
        rep_signups: row.rep_signups,
        active_rep_roster: activeRepRosterCount,
        joined_reps: joinedReps,
        activated_reps: activatedReps,
        rep_identity_conflicts: row.rep_identity_conflicts,
        reach_to_landing_rate: row.reach ? landingSessions / row.reach : 0,
        landing_to_cta_rate: landingSessions ? signupCtaSessions / landingSessions : 0,
        cta_to_signup_rate: signupCtaSessions ? row.signups / signupCtaSessions : 0,
        reach_to_signup_rate: row.reach ? row.signups / row.reach : 0,
        reach_to_activation_rate: row.reach ? row.activated_users / row.reach : 0,
        activation_rate: row.signups ? row.activated_workspaces / row.signups : 0,
        users_per_activated_workspace: row.activated_workspaces
          ? row.activated_users / row.activated_workspaces
          : 0,
        paid_rate: row.activated_workspaces ? row.paid_users / row.activated_workspaces : 0,
        roster_to_join_rate: activeRepRosterCount
          ? joinedReps / activeRepRosterCount
          : 0,
        joined_to_activation_rate: joinedReps ? activatedReps / joinedReps : 0,
        first_signup_at: row.first_signup_at,
        last_signup_at: row.last_signup_at,
      };
    })
    .sort((left, right) => (
      right.activated_users - left.activated_users
      || right.signups - left.signups
      || right.reach - left.reach
      || left.source.localeCompare(right.source)
      || left.content.localeCompare(right.content)
    ));
}

function buildContentQueue(
  plans: any[],
  metricCheckpoints: any[],
  byContent: any[],
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
    const checkpoints = checkpointsByAsset.get(key) || [];
    const canonicalMetric = checkpoints.find(
      (metric) => Number(metric?.snapshot_days || 7) === snapshotDays,
    ) || null;
    const capturedAt = dateValue(canonicalMetric, ["snapshot_captured_at"]);
    const fixedSnapshotCaptured = snapshotDueAt > 0 && capturedAt >= snapshotDueAt;
    const capturedCheckpointDays = checkpoints
      .filter((metric) => {
        const checkpointDays = Number(metric?.snapshot_days || 7);
        const checkpointCapturedAt = dateValue(metric, ["snapshot_captured_at"]);
        return publishedAt > 0
          && checkpointCapturedAt >= publishedAt + checkpointDays * DAY_MS;
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
      && !capturedCheckpointSet.has(checkpointDays)
    )) || null;
    const earlyMetric = latestRecord(
      checkpoints.filter((metric) => {
        const checkpointDays = Number(metric?.snapshot_days || 7);
        const value = dateValue(metric, ["snapshot_captured_at"]);
        return checkpointDays < snapshotDays
          && publishedAt > 0
          && value >= publishedAt
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
    } else if (publishedAt > 0) {
      state = asOf >= snapshotDueAt ? "snapshot_due" : "published";
    } else if (plannedPublishAt > 0 && asOf >= plannedPublishAt) {
      state = "publish_due";
    }
    let snapshotStatus = "scheduled";
    if (publishedAt > 0 && fixedSnapshotCaptured) {
      snapshotStatus = "captured";
    } else if (publishedAt > 0 && asOf > snapshotDueAt + DAY_MS) {
      snapshotStatus = "overdue";
    } else if (publishedAt > 0 && asOf >= snapshotDueAt) {
      snapshotStatus = "due";
    } else if (publishedAt > 0) {
      snapshotStatus = "collecting";
    }
    const conversion = conversionsByAsset.get(key) || {};
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
      reach: Number(canonicalMetric?.reach || 0),
      owned_intents: Number(conversion?.owned_intents || 0),
      landing_sessions: Number(conversion?.landing_sessions || 0),
      signups: Number(conversion?.signups || 0),
      activated_workspaces: Number(conversion?.activated_workspaces || 0),
      activated_users: Number(conversion?.activated_users || 0),
      activated_reps: Number(conversion?.activated_reps || 0),
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
    if (!item.fixed_snapshot_captured_at) continue;
    const groupKey = `${item.platform}|${item.campaign}|${item.comparison_group}|${item.snapshot_days}`;
    completedByGroup.set(
      groupKey,
      (completedByGroup.get(groupKey) || 0) + 1,
    );
  }
  for (const item of queue) {
    const groupKey = `${item.platform}|${item.campaign}|${item.comparison_group}|${item.snapshot_days}`;
    item.hold_eligible = (completedByGroup.get(groupKey) || 0) >= 3;
  }

  const nextPublish = queue.find(
    (item) => !item.published_at && item.delivery_status !== "canceled",
  ) || null;
  const canonicalSnapshotDue = [...queue]
    .filter((item) => (
      item.published_at
      && !item.fixed_snapshot_captured_at
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
      && item.next_early_snapshot_days
    ))
    .sort((left, right) => (
      String(left.next_early_snapshot_due_at || "").localeCompare(
        String(right.next_early_snapshot_due_at || ""),
      )
    ))[0] || null;
  const scheduledSnapshot = [...queue]
    .filter((item) => item.published_at && !item.fixed_snapshot_captured_at)
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
    ]);
    const activationIndex = buildActivationIndex(routes, canvasSessions);
    const activityIndex = buildActivityIndex(
      users,
      routes,
      canvasSessions,
      interactions,
      teamMembers,
    );
    const usersById = new Map(users.map((candidate) => [
      String(candidate?.id || ""),
      candidate,
    ]));
    const rosterGroups = activeRepRoster(teamMembers, usersById);
    const plans = canonicalContentPlans(contentPlans);
    const metricCheckpoints = canonicalMetricCheckpoints(metrics);
    const operatingMetrics = operatingContentMetrics(metricCheckpoints, plans);
    const byContent = contentRows(
      users,
      usersById,
      activationIndex,
      events,
      operatingMetrics,
      rosterGroups,
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
        new Date(generatedAt).getTime(),
      ),
      definitions: {
        acquisition_unit: "manager_workspace",
        manager_activation: "saved route with at least one property or deployed Canvas campaign",
        rep_activation: "first logged door outcome",
        attribution_model: "first touch",
        team_attribution: "current active rep roster state rolls up to the acquiring manager workspace",
        active_rep_roster: "unique active rep roster seat by manager and normalized email",
        joined_rep: "active roster seat linked to exactly one matching rep User by user ID, manager, and email",
        team_multiplier_window_basis: "current roster, join, and activation state for managers whose accounts were created in the reporting window",
        reach_source: "owner-entered Instagram Insights or TikTok analytics snapshot",
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
