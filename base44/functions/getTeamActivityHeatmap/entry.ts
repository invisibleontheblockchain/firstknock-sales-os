import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const PAGE_SIZE = 5000;
const MAX_RECORDS_PER_QUERY = 500000;
const MAX_QUERY_WINDOW_DAYS = 732;
const DAY_MS = 24 * 60 * 60 * 1000;

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function normalized(value: any): string {
  return String(value || "").trim().toLowerCase();
}

function canManageTeam(user: any): boolean {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true
    || user?.data?.is_owner === true
    || ["manager", "admin"].includes(appRole)
    || ["manager", "admin"].includes(accountRole);
}

function parseWindow(body: any) {
  const start = new Date(body?.start_at || "");
  const end = new Date(body?.end_at || "");
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new HttpError(400, "invalid_activity_range", "Choose a valid activity date range.");
  }
  if ((end.getTime() - start.getTime()) / DAY_MS > MAX_QUERY_WINDOW_DAYS) {
    throw new HttpError(400, "activity_range_too_large", "The activity comparison window is too large.");
  }

  const timeZone = String(body?.time_zone || "UTC").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(start);
  } catch {
    throw new HttpError(400, "invalid_time_zone", "Choose a valid time zone.");
  }
  return { start, end, timeZone };
}

async function fetchAll(entity: any, query: any, sort: string, label: string): Promise<any[]> {
  const rows: any[] = [];
  for (let skip = 0; skip < MAX_RECORDS_PER_QUERY; skip += PAGE_SIZE) {
    const page = asArray(await entity.filter(query, sort, PAGE_SIZE, skip));
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
  throw new HttpError(
    503,
    "activity_volume_exceeded",
    `${label} exceeded the safe reporting limit. Narrow the date range and retry.`
  );
}

function timeZoneDayKey(value: any, timeZone: string): string | null {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return byType.year && byType.month && byType.day
    ? `${byType.year}-${byType.month}-${byType.day}`
    : null;
}

function addIdentityMapping(map: Map<string, any>, rawKey: any, identity: any) {
  const key = String(rawKey || "").trim();
  if (!key) return;
  const existing = map.get(key);
  if (existing && existing.key !== identity.key) {
    map.set(key, null);
    return;
  }
  if (existing !== null) map.set(key, identity);
}

function buildIdentityIndex(user: any, members: any[]) {
  const identities = new Map<string, any>();
  const byUserId = new Map<string, any>();
  const byMemberId = new Map<string, any>();
  const byEmail = new Map<string, any>();
  const managerIdentity = {
    key: `user:${user.id}`,
    actor_user_id: user.id,
    actor_team_member_id: null,
    actor_email: user.email || null
  };
  identities.set(managerIdentity.key, managerIdentity);
  addIdentityMapping(byUserId, user.id, managerIdentity);
  addIdentityMapping(byEmail, normalized(user.email), managerIdentity);

  for (const member of members) {
    const key = member?.user_id ? `user:${member.user_id}` : `member:${member.id}`;
    if (!member?.id || !key) continue;
    const existing = identities.get(key);
    const identity = existing || {
      key,
      actor_user_id: member.user_id || null,
      actor_team_member_id: member.id,
      actor_email: member.email || null
    };
    identities.set(key, identity);
    addIdentityMapping(byMemberId, member.id, identity);
    addIdentityMapping(byUserId, member.user_id, identity);
    addIdentityMapping(byEmail, normalized(member.email), identity);
  }

  return { identities, byUserId, byMemberId, byEmail };
}

function chooseIdentity(candidates: any[], source: string): any {
  const valid = candidates.filter(Boolean);
  if (!valid.length) return null;
  const keys = new Set(valid.map((candidate) => candidate.key));
  if (keys.size > 1) {
    throw new HttpError(
      409,
      "activity_identity_conflict",
      `${source} activity has conflicting user identity links and was not attributed.`
    );
  }
  return valid[0];
}

function resolveInteractionIdentity(log: any, index: any): any {
  const repId = String(log?.rep_id || "");
  return chooseIdentity([
    index.byUserId.get(String(log?.logged_by_user_id || "")),
    index.byUserId.get(repId),
    index.byMemberId.get(repId),
    index.byEmail.get(normalized(log?.created_by))
  ], "Knock");
}

function resolveCanvasIdentity(event: any, index: any): any {
  return chooseIdentity([
    index.byUserId.get(String(event?.actor_user_id || "")),
    index.byMemberId.get(String(event?.actor_team_member_id || ""))
  ], "Canvas");
}

function activityBucket(identity: any, date: string) {
  return {
    date,
    actor_user_id: identity.actor_user_id,
    actor_team_member_id: identity.actor_team_member_id,
    logs: 0,
    doors: 0,
    sales: 0,
    callbacks: 0,
    knock_logs: 0,
    canvas_logs: 0,
    last_activity: null
  };
}

function addActivity(
  buckets: Map<string, any>,
  identity: any,
  date: string,
  timestamp: string,
  source: "knock" | "canvas",
  { door = false, sale = false, callback = false } = {}
) {
  if (!identity || !date) return;
  const key = `${identity.key}|${date}`;
  const bucket = buckets.get(key) || activityBucket(identity, date);
  bucket.logs += 1;
  if (door) bucket.doors += 1;
  if (sale) bucket.sales += 1;
  if (callback) bucket.callbacks += 1;
  if (source === "knock") bucket.knock_logs += 1;
  if (source === "canvas") bucket.canvas_logs += 1;
  if (!bucket.last_activity || Date.parse(timestamp) > Date.parse(bucket.last_activity)) {
    bucket.last_activity = timestamp;
  }
  buckets.set(key, bucket);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) throw new HttpError(401, "unauthorized", "Sign in to view team activity.");
    if (!canManageTeam(user)) {
      throw new HttpError(403, "manager_access_required", "Manager access is required for team adoption data.");
    }

    const body = await req.json().catch(() => ({}));
    const { start, end, timeZone } = parseWindow(body);
    const range = { $gte: start.toISOString(), $lt: end.toISOString() };
    const managerId = String(user.id);

    const members = await fetchAll(
      base44.asServiceRole.entities.TeamMember,
      { manager_id: managerId },
      "-created_date",
      "Team roster"
    );
    const scopedMembers = members.filter((member) => String(member?.manager_id || "") === managerId);
    const identityIndex = buildIdentityIndex(user, scopedMembers);

    // Never authorize service-role legacy logs by roster email; only the stamped
    // tenant key is safe for manager-level aggregation.
    const modernLogsPromise = fetchAll(
      base44.asServiceRole.entities.InteractionLog,
      { manager_id: managerId, created_date: range },
      "-created_date",
      "Knock activity"
    );
    const canvasEventsPromise = fetchAll(
      base44.asServiceRole.entities.CanvasHouseEvent,
      { manager_id: managerId, write_status: "committed", client_recorded_at: range },
      "-client_recorded_at",
      "Canvas activity"
    );

    const [modernLogs, canvasEvents] = await Promise.all([
      modernLogsPromise,
      canvasEventsPromise
    ]);
    const logsById = new Map<string, any>();
    for (const log of modernLogs) {
      if (log?.id) logsById.set(String(log.id), log);
    }

    const buckets = new Map<string, any>();
    for (const log of logsById.values()) {
      if (log?.manager_id && String(log.manager_id) !== managerId) continue;
      if (log?.source === "csv_history_import") continue;
      const timestamp = String(log?.created_date || "");
      const date = timeZoneDayKey(timestamp, timeZone);
      const identity = resolveInteractionIdentity(log, identityIndex);
      addActivity(buckets, identity, date, timestamp, "knock", {
        door: log?.counts_as_knock !== false,
        sale: String(log?.parsed_status || "").toUpperCase() === "SOLD",
        callback: String(log?.parsed_status || "").toUpperCase() === "CALLBACK"
      });
    }

    for (const event of canvasEvents) {
      if (
        String(event?.manager_id || "") !== managerId
        || event?.write_status !== "committed"
      ) continue;
      const timestamp = String(event?.client_recorded_at || "");
      const date = timeZoneDayKey(timestamp, timeZone);
      const identity = resolveCanvasIdentity(event, identityIndex);
      const outcome = normalized(event?.outcome);
      addActivity(buckets, identity, date, timestamp, "canvas", {
        door: true,
        sale: outcome === "sale",
        callback: outcome === "callback"
      });
    }

    const activity = [...buckets.values()].sort((left, right) => (
      left.date.localeCompare(right.date)
      || String(left.actor_user_id || left.actor_team_member_id || "")
        .localeCompare(String(right.actor_user_id || right.actor_team_member_id || ""))
    ));

    return Response.json({
      success: true,
      activity,
      time_zone: timeZone,
      range: {
        start_at: start.toISOString(),
        end_at: end.toISOString()
      },
      generated_at: new Date().toISOString(),
      source_counts: {
        interaction_logs: logsById.size,
        canvas_events: canvasEvents.length
      }
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    console.error("[getTeamActivityHeatmap]", error?.message || error);
    return Response.json({
      error: "team_activity_unavailable",
      message: "Team activity could not be loaded. Retry in a moment."
    }, { status: 503 });
  }
});
