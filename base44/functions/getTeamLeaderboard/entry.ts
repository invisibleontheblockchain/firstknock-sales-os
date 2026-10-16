// base44/functions/getTeamLeaderboard/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// base44/shared/teamActivity.js
var DAY_MS = 864e5;
var DOOR_STATUSES = /* @__PURE__ */ new Set(["SOLD", "QUALIFIED", "HARD_NO", "NOT_QUALIFIED", "CALLBACK", "NO_ANSWER", "NOT_MOVED_IN", "DM_NOT_HOME"]);
var TALKED_STATUSES = /* @__PURE__ */ new Set(["SOLD", "QUALIFIED", "HARD_NO", "NOT_QUALIFIED", "CALLBACK"]);
var NON_DOOR_SOURCES = /* @__PURE__ */ new Set(["house_note", "workflow_transition", "decision_clear"]);
var normalized = (value) => String(value || "").trim().toLowerCase();
var identifier = (value) => String(value || "").trim();
var dayFormatters = /* @__PURE__ */ new Map();
function activityDayKey(value, timeZone = "UTC") {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (!dayFormatters.has(timeZone)) dayFormatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }));
  const parts = Object.fromEntries(dayFormatters.get(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function isTeamDoorLog(log) {
  return log?.counts_as_knock !== false && DOOR_STATUSES.has(String(log?.parsed_status || "").trim().toUpperCase()) && !NON_DOOR_SOURCES.has(normalized(log?.source)) && normalized(log?.raw_input_text) !== "photo proof uploaded";
}
function isTeamLogInPeriod(log, period = "all", timeZone = "UTC", now = /* @__PURE__ */ new Date()) {
  if (!isTeamDoorLog(log)) return false;
  const date = new Date(log?.created_date);
  const current = new Date(now);
  if (!log?.created_date || !Number.isFinite(date.getTime())) return false;
  if (period === "all") return true;
  const limit = { today: 1, week: 7, month: 30 }[period];
  if (!limit) return false;
  const days = (Date.parse(activityDayKey(current, timeZone)) - Date.parse(activityDayKey(date, timeZone))) / DAY_MS;
  return days >= 0 && days < limit;
}
function indexIdentity(index, key, member) {
  const value = identifier(key);
  if (!value) return;
  if (index.has(value) && index.get(value) !== member) index.set(value, null);
  else if (!index.has(value)) index.set(value, member);
}
function buildTeamActivityIndex(members = []) {
  const byUserId = /* @__PURE__ */ new Map();
  const byMemberId = /* @__PURE__ */ new Map();
  const byEmail = /* @__PURE__ */ new Map();
  for (const member of members) {
    indexIdentity(byMemberId, member?.id, member);
    for (const alias of member?.activity_member_ids || []) indexIdentity(byMemberId, alias, member);
    indexIdentity(byUserId, member?.user_id || (member?.isTeamManager ? member.id : ""), member);
    indexIdentity(byEmail, normalized(member?.email), member);
  }
  return { byUserId, byMemberId, byEmail };
}
function resolveTeamLogMember(log, membersOrIndex = []) {
  const index = Array.isArray(membersOrIndex) ? buildTeamActivityIndex(membersOrIndex) : membersOrIndex;
  const resolveId = (id) => {
    const byUser = index.byUserId.has(id) ? index.byUserId.get(id) : void 0;
    const byMember = index.byMemberId.has(id) ? index.byMemberId.get(id) : void 0;
    if (byUser !== void 0 && byMember !== void 0 && byUser !== byMember) return null;
    return byUser || byMember || null;
  };
  const actorId = identifier(log?.logged_by_user_id);
  if (actorId) return resolveId(actorId);
  for (const field of ["rep_id", "actor_user_id", "created_by_id"]) {
    const id = identifier(log?.[field]);
    if (!id) continue;
    return resolveId(id);
  }
  return index.byEmail.get(normalized(log?.created_by)) || null;
}
function emptyMetrics() {
  return { sales: 0, knocks: 0, doorsKnocked: 0, talkedTo: 0, conversion: 0, contactRate: 0, revenue: 0, callbacks: 0 };
}
function addLog(metrics, log) {
  const status = String(log.parsed_status || "").trim().toUpperCase();
  metrics.knocks += 1;
  metrics.doorsKnocked += 1;
  if (status === "SOLD") {
    metrics.sales += 1;
    const amount = Number(log.sale_amount || 0);
    if (Number.isFinite(amount) && amount > 0) metrics.revenue += amount;
  }
  if (TALKED_STATUSES.has(status)) metrics.talkedTo += 1;
  if (status === "CALLBACK") metrics.callbacks += 1;
}
function finishMetrics(metrics) {
  metrics.conversion = metrics.knocks ? metrics.sales / metrics.knocks * 100 : 0;
  metrics.contactRate = metrics.knocks ? metrics.talkedTo / metrics.knocks * 100 : 0;
  return metrics;
}
function dayBucket(days, day) {
  if (!days.has(day)) days.set(day, { date: day, ...emptyMetrics() });
  return days.get(day);
}
function activityKey(log, position) {
  if (log?.id) return `id:${log.id}`;
  return `legacy:${position}`;
}
function actionKey(log) {
  const actor = identifier(log?.logged_by_user_id || log?.rep_id || log?.actor_user_id || log?.created_by_id) || normalized(log?.created_by);
  return log?.idempotency_key && actor ? `${actor}:${log.idempotency_key}` : null;
}
function isTeamActivityScopeLog(log, {
  managerId,
  managerEmail = "",
  ownedRouteIds = []
} = {}, membersOrIndex = []) {
  const expectedManager = identifier(managerId);
  const tenant = identifier(log?.manager_id);
  if (tenant) return expectedManager ? tenant === expectedManager : !!resolveTeamLogMember(log, membersOrIndex);
  const ownedRoutes = ownedRouteIds instanceof Set ? ownedRouteIds : new Set(ownedRouteIds.map(identifier));
  if (identifier(log?.route_id) && ownedRoutes.has(identifier(log.route_id))) return true;
  const actorId = identifier(log?.logged_by_user_id || log?.rep_id || log?.actor_user_id || log?.created_by_id);
  const actor = actorId ? resolveTeamLogMember(log, membersOrIndex) : null;
  return !!expectedManager && (actorId ? actorId === expectedManager || actor?.isTeamManager === true : !!normalized(managerEmail) && normalized(log?.created_by) === normalized(managerEmail));
}
function buildTeamActivity({
  members = [],
  logs = [],
  managerId,
  managerEmail = "",
  ownedRouteIds = [],
  restrictToMembers = false,
  period = "all",
  timeZone = "UTC",
  now = /* @__PURE__ */ new Date()
} = {}) {
  const index = buildTeamActivityIndex(members);
  const rows = members.filter((member) => member?.id).map((member) => ({
    id: member.id,
    user_id: member.user_id || null,
    name: member.name || member.full_name || "Team Member",
    email: member.email || "",
    role: member.role || "rep",
    status: member.status || "active",
    color: member.color || "#FFD700",
    metrics: emptyMetrics(),
    history: []
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const memberDays = new Map(rows.map((row) => [row.id, /* @__PURE__ */ new Map()]));
  const totals = emptyMetrics();
  const outcomeCounts = Object.fromEntries([...DOOR_STATUSES].map((status) => [status, 0]));
  const days = /* @__PURE__ */ new Map();
  const unique = /* @__PURE__ */ new Map();
  const scope = { managerId, managerEmail, ownedRouteIds: new Set(ownedRouteIds) };
  logs.forEach((log, position) => {
    if (!isTeamActivityScopeLog(log, scope, index)) return;
    const key = activityKey(log, position);
    const previous = unique.get(key);
    if (!previous || Date.parse(log.updated_date || log.created_date) > Date.parse(previous.updated_date || previous.created_date)) unique.set(key, log);
  });
  const actions = /* @__PURE__ */ new Set();
  const ordered = [...unique.values()].sort((a, b) => Date.parse(b.updated_date || b.created_date) - Date.parse(a.updated_date || a.created_date));
  for (const log of ordered) {
    const action = actionKey(log);
    if (action && actions.has(action)) continue;
    if (action) actions.add(action);
    if (!isTeamLogInPeriod(log, period, timeZone, now)) continue;
    const member = resolveTeamLogMember(log, index);
    if (restrictToMembers && !member) continue;
    const date = activityDayKey(log.created_date, timeZone);
    addLog(totals, log);
    outcomeCounts[String(log.parsed_status || "").trim().toUpperCase()] += 1;
    addLog(dayBucket(days, date), log);
    const row = member && byId.get(member.id);
    if (!row) continue;
    addLog(row.metrics, log);
    addLog(dayBucket(memberDays.get(row.id), date), log);
  }
  for (const row of rows) {
    finishMetrics(row.metrics);
    row.history = [...memberDays.get(row.id).values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({ ...finishMetrics(day), score: day.sales }));
  }
  return {
    rows,
    totals: finishMetrics(totals),
    outcome_counts: outcomeCounts,
    daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(finishMetrics)
  };
}

// base44/shared/teamLeaderboard.js
var DAY_MS2 = 864e5;
var normalized2 = (value) => String(value || "").trim().toLowerCase();
function buildTeamLeaderboard({
  members = [],
  logs = [],
  managerId,
  managerEmail,
  ownedRouteIds = [],
  period = "today",
  timeZone = "UTC",
  now = /* @__PURE__ */ new Date()
} = {}) {
  const today = Date.parse(activityDayKey(now, timeZone));
  const activity = buildTeamActivity({ members, logs, managerId, managerEmail, ownedRouteIds, period, timeZone, now });
  return activity.rows.filter((member) => normalized2(member.status) !== "inactive").map((row) => {
    const days = new Map(row.history.map((day) => [day.date, day]));
    return {
      ...row,
      history: Array.from({ length: 7 }, (_, index) => {
        const date = new Date(today - (6 - index) * DAY_MS2).toISOString().slice(0, 10);
        return { date, score: days.get(date)?.sales || 0 };
      })
    };
  }).sort((a, b) => b.metrics.sales - a.metrics.sales || b.metrics.knocks - a.metrics.knocks || a.name.localeCompare(b.name));
}

// base44/shared/teamMembershipLifecycle.js
var normalized3 = (value) => String(value || "").trim().toLowerCase();
var identifier2 = (value) => String(value || "").trim();
function isActiveTeamRep(member) {
  return normalized3(member?.role) === "rep" && normalized3(member?.status) === "active";
}
async function loadAllTeamRows(entity, query, { sort = "-created_date", pageSize = 100, maxPages = 100 } = {}) {
  const rows = /* @__PURE__ */ new Map();
  const pages = /* @__PURE__ */ new Set();
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const response = await entity.filter(query, sort, pageSize, pageIndex * pageSize);
    const page = Array.isArray(response) ? response : response?.items;
    if (!Array.isArray(page)) throw new Error("The team membership response could not be verified.");
    for (const row of page) if (row?.id) rows.set(String(row.id), row);
    if (page.length < pageSize) return [...rows.values()];
    const signature = JSON.stringify(page.map((row) => String(row?.id || "")));
    if (pages.has(signature)) throw new Error("The team membership lookup repeated a page. Please retry.");
    pages.add(signature);
  }
  throw new Error("The team membership lookup exceeded its verification limit.");
}
function chronologicalMemberOrder(left, right) {
  const leftTime = Date.parse(left?.created_date);
  const rightTime = Date.parse(right?.created_date);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
  const leftId = identifier2(left?.id);
  const rightId = identifier2(right?.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
function selectCanonicalTeamMember(rows, user, {
  managerId,
  memberId = "",
  allowUnlinked = false,
  includeInactive = false
} = {}) {
  const userId = identifier2(user?.id);
  const email = normalized3(user?.email);
  const expectedManager = identifier2(managerId);
  if (!userId || !email || !expectedManager) return null;
  const matching = rows.filter((member) => {
    const linkedUser = identifier2(member?.user_id);
    const status = normalized3(member?.status);
    return identifier2(member?.id) && identifier2(member?.manager_id) === expectedManager && normalized3(member?.role) === "rep" && normalized3(member?.email) === email && (status === "active" || includeInactive && status === "inactive") && (linkedUser === userId || allowUnlinked && !linkedUser);
  });
  matching.sort((left, right) => {
    const activeDifference = Number(isActiveTeamRep(right)) - Number(isActiveTeamRep(left));
    if (activeDifference) return activeDifference;
    const linkedDifference = Number(identifier2(right.user_id) === userId) - Number(identifier2(left.user_id) === userId);
    if (linkedDifference) return linkedDifference;
    const cachedDifference = Number(identifier2(right.id) === identifier2(memberId)) - Number(identifier2(left.id) === identifier2(memberId));
    return cachedDifference || chronologicalMemberOrder(left, right);
  });
  return matching[0] || null;
}

// base44/shared/companySeatAccess.js
var normalized4 = (value) => String(value || "").trim().toLowerCase();
function isCompanyManager(user) {
  return user?.is_owner === true || ["manager", "admin"].includes(normalized4(user?.app_role || user?.data?.app_role)) || ["manager", "admin"].includes(normalized4(user?.role || user?.data?.role));
}
function membershipRequired() {
  return Object.assign(new Error("Your company membership needs to be verified. Ask your manager to check your team access."), {
    status: 403,
    code: "team_membership_required"
  });
}
async function resolveOutcomeBillingContext(base44, authenticatedUser) {
  const actor = await base44.asServiceRole.entities.User.get(authenticatedUser.id).catch(() => null);
  if (!actor || normalized4(actor.email) !== normalized4(authenticatedUser.email)) {
    throw Object.assign(new Error("The authenticated account could not be verified."), {
      status: 401,
      code: "invalid_authenticated_user"
    });
  }
  const personalContext = { actor, billingUser: actor, managerId: actor.id, teamMember: null };
  let managerId = String(actor.team_manager_id || actor.data?.team_manager_id || "").trim();
  const memberId = String(actor.team_member_id || actor.data?.team_member_id || "").trim();
  const appRole = normalized4(actor.app_role || actor.data?.app_role);
  const teamAccount = appRole === "rep" || !!memberId && !["manager", "admin"].includes(appRole);
  if (managerId === String(actor.id)) {
    if (teamAccount) throw membershipRequired();
    return personalContext;
  }
  if (!managerId && !teamAccount && (actor.is_owner === true || normalized4(actor.role) === "admin")) return personalContext;
  const memberships = await loadAllTeamRows(base44.asServiceRole.entities.TeamMember, {
    user_id: actor.id,
    ...managerId ? { manager_id: managerId } : {}
  }, { sort: "-updated_date" });
  const verified = memberships.filter(
    (member) => String(member?.user_id || "") === String(actor.id) && !!member?.manager_id && (!managerId || String(member.manager_id) === managerId) && normalized4(member?.email) === normalized4(actor.email) && String(member.manager_id) !== String(actor.id) && isActiveTeamRep(member)
  );
  if (!managerId) {
    const managerIds = [...new Set(verified.map((member) => String(member.manager_id)))];
    if (!managerIds.length && !teamAccount) return personalContext;
    if (managerIds.length !== 1) throw membershipRequired();
    managerId = managerIds[0];
  }
  const teamMember = selectCanonicalTeamMember(verified, actor, { managerId, memberId });
  if (!teamMember) throw membershipRequired();
  const billingUser = await base44.asServiceRole.entities.User.get(managerId).catch(() => null);
  if (!billingUser || !isCompanyManager(billingUser)) throw membershipRequired();
  return { actor, billingUser, managerId, teamMember };
}

// base44/shared/teamRoster.js
var normalized5 = (value) => String(value || "").trim().toLowerCase();
var isActive = (member) => normalized5(member?.status || "active") !== "inactive";
function matchesManager(member, manager) {
  return member.user_id ? member.user_id === manager.id : member.id === manager.id || !!member.email && normalized5(member.email) === normalized5(manager.email);
}
function buildTeamRoster(members = [], manager, currentUserId, activeTeamCode = "all") {
  const unique = /* @__PURE__ */ new Map();
  for (const member of members) {
    if (!member?.id || manager && matchesManager(member, manager)) continue;
    if (activeTeamCode !== "all" && member.invite_code !== activeTeamCode) continue;
    const key = member.user_id ? `user:${member.user_id}` : normalized5(member.email) || `member:${member.id}`;
    if (!unique.has(key) || !isActive(unique.get(key)) && isActive(member)) unique.set(key, member);
  }
  const roster = [...unique.values()];
  if (!manager?.id) return roster;
  const existing = members.find((member) => matchesManager(member, manager));
  return [{
    ...existing,
    ...manager,
    id: existing?.id || manager.id,
    isTeamManager: true,
    isManagerSelf: currentUserId === manager.id,
    auto_assign_enabled: false
  }, ...roster];
}

// base44/shared/teamActivityLogs.js
var identifier3 = (value) => String(value || "").trim();
var normalized6 = (value) => identifier3(value).toLowerCase();
var asArray = (value) => Array.isArray(value) ? value : value?.items;
var unavailable = (message) => Object.assign(new Error(message), { status: 503 });
async function loadPages(entity, query, { pageSize = 5e3, maxPages = 100 } = {}) {
  const rows = /* @__PURE__ */ new Map();
  const signatures = /* @__PURE__ */ new Set();
  for (let page = 0; page < maxPages; page += 1) {
    const result = asArray(await entity.filter(query, "-created_date", pageSize, page * pageSize));
    if (!Array.isArray(result)) throw unavailable("Team activity could not be verified. Please retry.");
    for (const row of result) if (row?.id) rows.set(String(row.id), row);
    if (result.length < pageSize) return [...rows.values()];
    const signature = JSON.stringify(result.map((row) => row?.id));
    if (signatures.has(signature)) throw unavailable("Team activity pagination did not advance. Please retry.");
    signatures.add(signature);
  }
  throw unavailable("There is too much activity to summarize. Choose a shorter period.");
}
async function mapWithConcurrency(values, fn, concurrency = 6) {
  let next = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
    }
  }));
  return results;
}
function managerProfile(manager) {
  return {
    id: manager.id,
    user_id: manager.id,
    manager_id: manager.id,
    name: manager.full_name || manager.data?.full_name || "Team Manager",
    email: manager.email,
    role: "manager",
    status: "active",
    color: "#FFD700",
    profile_image_url: manager.profile_image_url || manager.data?.profile_image_url || null
  };
}
async function loadTeamActivityContext(base44, { period = "all", now = /* @__PURE__ */ new Date() } = {}) {
  const identity = await base44.auth.me();
  if (!identity?.id) throw Object.assign(new Error("Sign in to view team activity."), { status: 401 });
  const context = await resolveOutcomeBillingContext(base44, identity);
  if (!context.teamMember && !isCompanyManager(context.actor)) {
    throw Object.assign(new Error("Join a team before viewing its activity."), { status: 403 });
  }
  const managerId = identifier3(context.managerId);
  if (!managerId || identifier3(context.billingUser?.id) !== managerId || !isCompanyManager(context.billingUser)) {
    throw Object.assign(new Error("Your team manager could not be verified."), { status: 403 });
  }
  const service = base44.asServiceRole.entities;
  const roster = (await loadAllTeamRows(service.TeamMember, { manager_id: managerId }, { pageSize: 500 })).filter((member) => identifier3(member.manager_id) === managerId);
  const manager = managerProfile(context.billingUser);
  const members = buildTeamRoster(roster, manager, context.actor.id).map((member) => ({
    ...member,
    activity_member_ids: roster.filter((row) => row.user_id && identifier3(row.user_id) === identifier3(member.user_id)).map((row) => identifier3(row.id))
  }));
  const days = { today: 1, week: 7, month: 30 }[period];
  const dateQuery = days ? {
    created_date: {
      $lte: new Date(new Date(now).getTime() + 2 * 864e5).toISOString(),
      $gte: new Date(new Date(now).getTime() - (days + 2) * 864e5).toISOString()
    }
  } : {};
  const routeFilters = [{ manager_id: managerId }];
  if (manager.email) routeFilters.push({ created_by: manager.email });
  const routeGroups = await mapWithConcurrency(routeFilters, (filter) => loadPages(service.SavedRoute, filter, { pageSize: 500 }));
  const ownedRouteIds = /* @__PURE__ */ new Set();
  for (const group of routeGroups) for (const route of group) {
    const tenant = identifier3(route.manager_id);
    if (tenant === managerId || !tenant && normalized6(route.created_by) === normalized6(manager.email)) ownedRouteIds.add(identifier3(route.id));
  }
  const identities = {
    logged_by_user_id: /* @__PURE__ */ new Set(),
    actor_user_id: /* @__PURE__ */ new Set(),
    created_by_id: /* @__PURE__ */ new Set(),
    rep_id: /* @__PURE__ */ new Set(),
    created_by: /* @__PURE__ */ new Set(),
    route_id: ownedRouteIds
  };
  for (const member of members) {
    const userId = identifier3(member.user_id || (member.isTeamManager ? managerId : ""));
    for (const field of ["logged_by_user_id", "actor_user_id", "created_by_id"]) if (userId) identities[field].add(userId);
    for (const id of [member.id, userId, ...member.activity_member_ids || []]) if (id) identities.rep_id.add(identifier3(id));
    for (const email of [identifier3(member.email), normalized6(member.email)]) if (email) identities.created_by.add(email);
  }
  const filters = [{ manager_id: managerId }];
  for (const [field, values] of Object.entries(identities)) {
    const items = [...values];
    for (let offset = 0; offset < items.length; offset += 100) filters.push({ [field]: { $in: items.slice(offset, offset + 100) } });
  }
  const groups = await mapWithConcurrency(filters, (filter) => loadPages(service.InteractionLog, { ...filter, ...dateQuery }));
  const unique = /* @__PURE__ */ new Map();
  for (const group of groups) for (const log of group) {
    const tenant = identifier3(log.manager_id);
    if (!tenant || tenant === managerId) unique.set(identifier3(log.id), log);
  }
  const candidates = [...unique.values()];
  const legacyScope = { ownedRouteIds: [...ownedRouteIds], managerEmail: manager.email || "" };
  const logs = candidates.filter((log) => isTeamActivityScopeLog(log, { managerId, ...legacyScope }, members));
  return { managerId, manager, members, logs, legacyScope };
}

// base44/functions/getTeamLeaderboard/entry.ts
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const period = { "7d": "week", "30d": "month" }[body.period] || body.period || "today";
    if (!["today", "week", "month", "all"].includes(period)) throw new HttpError(400, "Choose a valid leaderboard period.");
    const timeZone = String(body.time_zone || "UTC");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(/* @__PURE__ */ new Date());
    } catch {
      throw new HttpError(400, "Choose a valid time zone.");
    }
    const now = /* @__PURE__ */ new Date();
    const context = await loadTeamActivityContext(base44, { period, now });
    return Response.json({
      success: true,
      manager_id: context.managerId,
      period,
      rows: buildTeamLeaderboard({
        members: context.members,
        logs: context.logs,
        managerId: context.managerId,
        ...context.legacyScope,
        period,
        timeZone,
        now
      })
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : error?.response?.status === 401 || error?.response?.status === 403 ? error.response.status : 500;
    if (status === 500) console.error("Team leaderboard load failed:", error);
    return Response.json({ error: error instanceof HttpError ? error.message : "Unable to load your team leaderboard. Please retry." }, { status });
  }
});
