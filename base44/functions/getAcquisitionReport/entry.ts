import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const PAGE_SIZE = 5000;
const MAX_USERS = 10000;
const MAX_ACTIVITY_RECORDS = 100000;
const MAX_GROWTH_RECORDS = 25000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function acquisitionTouchForUser(user: any, usersById: Map<string, any>): any {
  if (normalized(user?.app_role) === "rep" && user?.team_manager_id) {
    const manager = usersById.get(String(user.team_manager_id));
    if (manager?.acquisition_first_touch) return manager.acquisition_first_touch;
  }
  return user?.acquisition_first_touch;
}

function instagramEvents(events: any[]): any[] {
  return events.filter((event) => normalized(event?.source) === "instagram");
}

function uniqueCount(records: any[], field: string): number {
  return new Set(records.map((record) => String(record?.[field] || "")).filter(Boolean)).size;
}

function summarize(
  users: any[],
  allUsersById: Map<string, any>,
  activationIndex: any,
  activityIndex: any,
  events: any[],
  metrics: any[],
) {
  const instagram = users.filter((user) => (
    normalized(acquisitionTouchForUser(user, allUsersById)?.source) === "instagram"
  ));
  const instagramManagers = instagram.filter((user) => (
    ["manager", "admin"].includes(normalized(user?.app_role))
  ));
  const igEvents = instagramEvents(events);
  return {
    users: users.length,
    activated_users: users.filter((user) => isActivated(user, activationIndex)).length,
    retained_active_users_30d: users.filter(
      (user) => isRetainedActive(user, activationIndex, activityIndex),
    ).length,
    paid_users: users.filter(isPaid).length,
    instagram_reach: metrics.reduce(
      (total, metric) => total + Math.max(0, Number(metric?.reach || 0)),
      0,
    ),
    instagram_content_assets: metrics.length,
    instagram_landing_sessions: uniqueCount(
      igEvents.filter((event) => event?.event_name === "landing_viewed"),
      "session_id",
    ),
    instagram_signup_cta_sessions: uniqueCount(
      igEvents.filter((event) => event?.event_name === "signup_cta_clicked"),
      "session_id",
    ),
    instagram_auth_completed: uniqueCount(
      igEvents.filter((event) => event?.event_name === "auth_completed"),
      "user_id",
    ),
    instagram_acquired_users: instagram.length,
    instagram_signups: instagramManagers.length,
    instagram_activated_workspaces: instagramManagers
      .filter((user) => isActivated(user, activationIndex)).length,
    instagram_activated_users: instagram
      .filter((user) => isActivated(user, activationIndex)).length,
    instagram_paid_users: instagram.filter(isPaid).length,
  };
}

function rowKey(campaign: any, content: any): string {
  return `${normalized(campaign) || "unassigned"}|${normalized(content) || "unassigned"}`;
}

function contentRows(
  users: any[],
  allUsersById: Map<string, any>,
  activationIndex: any,
  events: any[],
  metrics: any[],
) {
  const rows = new Map<string, any>();
  const ensureRow = (campaign: any, content: any) => {
    const cleanCampaign = normalized(campaign) || "unassigned";
    const cleanContent = normalized(content) || "unassigned";
    const key = rowKey(cleanCampaign, cleanContent);
    if (!rows.has(key)) {
      rows.set(key, {
        source: "instagram",
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
        first_signup_at: null,
        last_signup_at: null,
        metric_timestamp: 0,
      });
    }
    return rows.get(key);
  };

  // Keep the most recently captured cumulative Instagram snapshot per asset.
  for (const metric of metrics) {
    const row = ensureRow(metric?.campaign, metric?.content);
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
      "profile_visits",
      "link_clicks",
      "dm_intents",
    ]) {
      row[field] = Math.max(0, Number(metric?.[field] || 0));
    }
  }

  for (const event of instagramEvents(events)) {
    const row = ensureRow(event?.campaign, event?.content);
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
    const touch = acquisitionTouchForUser(user, allUsersById);
    if (normalized(touch?.source) !== "instagram") continue;
    const row = ensureRow(touch?.campaign, touch?.content);
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

  return [...rows.values()]
    .map((row) => {
      const landingSessions = row.landing_session_ids.size;
      const signupCtaSessions = row.signup_cta_session_ids.size;
      const authCompleted = row.auth_user_ids.size;
      const ownedIntents = row.link_clicks + row.dm_intents;
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
        first_signup_at: row.first_signup_at,
        last_signup_at: row.last_signup_at,
      };
    })
    .sort((left, right) => (
      right.activated_users - left.activated_users
      || right.signups - left.signups
      || right.reach - left.reach
      || left.content.localeCompare(right.content)
    ));
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!canViewGrowth(user)) {
      return Response.json({ error: "growth_admin_required" }, { status: 403 });
    }

    const [
      users,
      routes,
      canvasSessions,
      interactions,
      teamMembers,
      events,
      metrics,
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
    return Response.json({
      success: true,
      generated_at: new Date().toISOString(),
      all_time: summarize(
        users,
        usersById,
        activationIndex,
        activityIndex,
        events,
        metrics,
      ),
      last_28_days: summarize(
        users.filter((candidate) => isRecent(candidate, 28, ["created_date"])),
        usersById,
        activationIndex,
        activityIndex,
        events.filter((event) => isRecent(event, 28, ["occurred_at", "created_date"])),
        metrics.filter((metric) => isRecent(metric, 28, [
          "published_at",
          "snapshot_captured_at",
          "created_date",
        ])),
      ),
      last_7_days: summarize(
        users.filter((candidate) => isRecent(candidate, 7, ["created_date"])),
        usersById,
        activationIndex,
        activityIndex,
        events.filter((event) => isRecent(event, 7, ["occurred_at", "created_date"])),
        metrics.filter((metric) => isRecent(metric, 7, [
          "published_at",
          "snapshot_captured_at",
          "created_date",
        ])),
      ),
      by_content: contentRows(users, usersById, activationIndex, events, metrics),
      definitions: {
        acquisition_unit: "manager_workspace",
        manager_activation: "saved route with at least one property or deployed Canvas campaign",
        rep_activation: "first logged door outcome",
        attribution_model: "first touch",
        invite_attribution: "rep outcomes roll up to the acquiring manager workspace",
        reach_source: "owner-entered Instagram Insights snapshot",
        anonymous_funnel: "unique pseudonymous browser sessions; no names, emails, or contact fields before auth",
        north_star: "activated users with verified product activity in the last 30 days",
        reporting_window_user_basis: "accounts created in the window; activation reflects their current verified state",
      },
    });
  } catch (error: any) {
    console.error("[getAcquisitionReport]", error?.message || error);
    return Response.json({ error: "acquisition_report_unavailable" }, { status: 503 });
  }
});
