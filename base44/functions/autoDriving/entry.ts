// base44/functions/autoDriving/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// base44/shared/autoDriving.js
var AUTO_DRIVING_MAX_POINTS = 60;
var AUTO_DRIVING_MAX_DELAY_MS = 48 * 36e5;
var AUTO_DRIVING_MAX_GAP_MS = 45e3;
var AUTO_DRIVING_MAX_ACCURACY_METERS = 35;
var AUTO_DRIVING_MIN_SPEED_MPS = 4.4704;
var AUTO_DRIVING_MAX_SPEED_MPS = 55;
var AutoDrivingError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
var finite = (value) => typeof value === "number" && Number.isFinite(value);
function normalizeDrivingPoint(point, now = Date.now()) {
  const at = typeof point?.observed_at === "string" ? Date.parse(point.observed_at) : NaN;
  if (!finite(point?.lat) || Math.abs(point.lat) > 90 || !finite(point?.lng) || Math.abs(point.lng) > 180 || !finite(point?.accuracy) || point.accuracy < 0 || point.accuracy > 1e4 || !Number.isFinite(at) || at > now + 1e4 || at < now - AUTO_DRIVING_MAX_DELAY_MS || point.speed != null && (!finite(point.speed) || point.speed < 0 || point.speed > 200)) {
    throw new AutoDrivingError(400, "Invalid or expired GPS sample.");
  }
  return {
    observed_at: new Date(at).toISOString(),
    lat: point.lat,
    lng: point.lng,
    accuracy: point.accuracy,
    speed: point.speed == null ? null : point.speed
  };
}
function drivingMeters(a, b) {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 63710088e-1 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
var precise = (point) => finite(point?.lat) && Math.abs(point.lat) <= 90 && finite(point?.lng) && Math.abs(point.lng) <= 180 && finite(point?.accuracy) && point.accuracy >= 0 && point.accuracy <= AUTO_DRIVING_MAX_ACCURACY_METERS;
var unionMs = (intervals) => {
  let total = 0, previous = null;
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    if (!previous || interval[0] > previous[1]) {
      if (previous) total += previous[1] - previous[0];
      previous = [...interval];
    } else previous[1] = Math.max(previous[1], interval[1]);
  }
  return total + (previous ? previous[1] - previous[0] : 0);
};
function summarizeAutoDriving(batches, shifts, range, now = Date.now(), people = []) {
  const groups = new Map(people.map((person) => [person.rep_user_id, { ...person, shifts: [], batches: [] }]));
  for (const shift of shifts) {
    if (!["active", "closed"].includes(shift.status)) continue;
    const start = Date.parse(shift.clock_in_at), end = shift.status === "closed" ? Date.parse(shift.clock_out_at) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= range.start || start >= range.end) continue;
    if (!groups.has(shift.rep_user_id)) groups.set(shift.rep_user_id, {
      member_id: shift.member_id,
      rep_user_id: shift.rep_user_id,
      rep_name: shift.rep_name || shift.rep_email || "Team member",
      shifts: [],
      batches: []
    });
    groups.get(shift.rep_user_id).shifts.push(shift);
  }
  for (const batch of batches) groups.get(batch.rep_user_id)?.batches.push(batch);
  return [...groups.values()].map((group) => {
    const shiftById = new Map(group.shifts.map((shift) => [shift.id, shift]));
    const pointsByTime = /* @__PURE__ */ new Map(), work = [], observed = [];
    for (const shift of group.shifts) work.push([
      Math.max(range.start, Date.parse(shift.clock_in_at)),
      Math.min(range.end, shift.status === "closed" ? Date.parse(shift.clock_out_at) : now)
    ]);
    for (const batch of group.batches) {
      const shift = shiftById.get(batch.shift_id);
      if (!shift || batch.manager_id !== shift.manager_id || batch.member_id !== shift.member_id || batch.rep_user_id !== shift.rep_user_id || !batch.session_id) continue;
      const end = shift.status === "closed" ? Date.parse(shift.clock_out_at) : now;
      for (const point of Array.isArray(batch.points) ? batch.points : []) {
        const at = Date.parse(point.observed_at);
        if (!Number.isFinite(at) || at < Date.parse(shift.clock_in_at) || at > end || at < range.start || at >= range.end) continue;
        const key = `${shift.id}:${at}`;
        const candidate = { ...point, at, shift_id: shift.id, session_id: batch.session_id };
        const previous = pointsByTime.get(key);
        if (!previous) pointsByTime.set(key, candidate);
        else if (previous.lat !== candidate.lat || previous.lng !== candidate.lng || previous.accuracy !== candidate.accuracy || previous.speed !== candidate.speed) previous.ambiguous = true;
        else if (candidate.session_id < previous.session_id) previous.session_id = candidate.session_id;
      }
    }
    const points = [...pointsByTime.values()].sort((a, b) => a.at - b.at || a.session_id.localeCompare(b.session_id));
    let meters = 0, drivingSegments = 0;
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index], elapsed = b.at - a.at;
      if (a.ambiguous || b.ambiguous || a.shift_id !== b.shift_id || a.session_id !== b.session_id || !precise(a) || !precise(b) || elapsed < 2e3 || elapsed > AUTO_DRIVING_MAX_GAP_MS) continue;
      const distance = drivingMeters(a, b), speed = distance / (elapsed / 1e3);
      if (speed > AUTO_DRIVING_MAX_SPEED_MPS || a.speed != null && (!finite(a.speed) || a.speed < 0 || a.speed > AUTO_DRIVING_MAX_SPEED_MPS) || b.speed != null && (!finite(b.speed) || b.speed < 0 || b.speed > AUTO_DRIVING_MAX_SPEED_MPS)) continue;
      observed.push([a.at, b.at]);
      const reportedSpeeds = [a.speed, b.speed].filter((value) => value != null);
      if (speed < AUTO_DRIVING_MIN_SPEED_MPS || distance <= Math.max(8, a.accuracy + b.accuracy) || reportedSpeeds.some((value) => value < AUTO_DRIVING_MIN_SPEED_MPS)) continue;
      meters += distance;
      drivingSegments++;
    }
    const workingSeconds = Math.round(unionMs(work) / 1e3), observedSeconds = Math.round(unionMs(observed) / 1e3);
    const coverage = workingSeconds > 0 ? Math.min(1, observedSeconds / workingSeconds) : 0;
    const status = !observedSeconds ? "not_recorded" : coverage >= 0.95 ? "recorded" : "partial";
    return {
      member_id: group.member_id,
      rep_user_id: group.rep_user_id,
      rep_name: group.rep_name,
      miles: status === "not_recorded" ? null : Math.round(meters / 1609.344 * 1e3) / 1e3,
      observed_seconds: observedSeconds,
      working_seconds: workingSeconds,
      coverage,
      status,
      sample_count: points.filter((point) => precise(point) && !point.ambiguous).length,
      driving_segments: drivingSegments,
      last_observed_at: points.length ? new Date(points.at(-1).at).toISOString() : null
    };
  }).sort((a, b) => String(a.rep_name).localeCompare(String(b.rep_name)));
}

// base44/shared/timeClock.js
var TimeClockError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
function timeClockRange(start, end) {
  const valid = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  if (!valid(start) || !valid(end) || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 367 * 864e5) {
    throw new TimeClockError(400, "Choose a valid date range of up to one year.");
  }
  return { start: Date.parse(start), end: Date.parse(end) };
}
var DEFAULT_CLOCK_TIMEZONE = "America/Phoenix";
function validateClockTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new TimeClockError(400, "Choose a valid reporting timezone.");
  }
  if (typeof timezone !== "string" || !timezone) throw new TimeClockError(400, "Choose a valid reporting timezone.");
  return timezone;
}
var zoneParts = (value, timezone) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
}).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
function zonedClockDate(value = Date.now(), timezone = DEFAULT_CLOCK_TIMEZONE) {
  const parts = zoneParts(value, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
var calendarDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new TimeClockError(400, "Choose valid dates.");
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new TimeClockError(400, "Choose valid dates.");
  return date;
};
var advanceDate = (value, days) => {
  const date = calendarDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
function clockDateRangeInZone(start, end, timezone = DEFAULT_CLOCK_TIMEZONE) {
  validateClockTimezone(timezone);
  const midnight = (value) => {
    const target = calendarDate(value).getTime();
    let candidate = target;
    for (let attempt = 0; attempt < 5; attempt++) {
      const p = zoneParts(candidate, timezone);
      const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
      const correction = target - wall;
      if (!correction) return candidate;
      candidate += correction;
    }
    const candidates = [candidate, candidate + 36e5, candidate - 36e5].filter((time) => zonedClockDate(time, timezone) === value).sort((a, b) => a - b);
    if (!candidates.length) throw new TimeClockError(400, "This date does not exist in the reporting timezone.");
    return candidates[0];
  };
  const first = midnight(start);
  calendarDate(end);
  if (start > end) throw new TimeClockError(400, "Choose a valid date range.");
  const last = midnight(advanceDate(end, 1));
  return { ...timeClockRange(new Date(first).toISOString(), new Date(last).toISOString()), start_at: new Date(first).toISOString(), end_at: new Date(last).toISOString() };
}

// base44/shared/teamMembershipLifecycle.js
var normalized = (value) => String(value || "").trim().toLowerCase();
var identifier = (value) => String(value || "").trim();
function isActiveTeamRep(member) {
  return normalized(member?.role) === "rep" && normalized(member?.status) === "active";
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
  const leftId = identifier(left?.id);
  const rightId = identifier(right?.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
function selectCanonicalTeamMember(rows, user, {
  managerId,
  memberId = "",
  allowUnlinked = false,
  includeInactive = false
} = {}) {
  const userId = identifier(user?.id);
  const email = normalized(user?.email);
  const expectedManager = identifier(managerId);
  if (!userId || !email || !expectedManager) return null;
  const matching = rows.filter((member) => {
    const linkedUser = identifier(member?.user_id);
    const status = normalized(member?.status);
    return identifier(member?.id) && identifier(member?.manager_id) === expectedManager && normalized(member?.role) === "rep" && normalized(member?.email) === email && (status === "active" || includeInactive && status === "inactive") && (linkedUser === userId || allowUnlinked && !linkedUser);
  });
  matching.sort((left, right) => {
    const activeDifference = Number(isActiveTeamRep(right)) - Number(isActiveTeamRep(left));
    if (activeDifference) return activeDifference;
    const linkedDifference = Number(identifier(right.user_id) === userId) - Number(identifier(left.user_id) === userId);
    if (linkedDifference) return linkedDifference;
    const cachedDifference = Number(identifier(right.id) === identifier(memberId)) - Number(identifier(left.id) === identifier(memberId));
    return cachedDifference || chronologicalMemberOrder(left, right);
  });
  return matching[0] || null;
}

// base44/shared/companySeatAccess.js
var normalized2 = (value) => String(value || "").trim().toLowerCase();
function isCompanyManager(user) {
  return user?.is_owner === true || ["manager", "admin"].includes(normalized2(user?.app_role || user?.data?.app_role)) || ["manager", "admin"].includes(normalized2(user?.role || user?.data?.role));
}
function membershipRequired() {
  return Object.assign(new Error("Your company membership needs to be verified. Ask your manager to check your team access."), {
    status: 403,
    code: "team_membership_required"
  });
}
async function resolveOutcomeBillingContext(base44, authenticatedUser) {
  const actor = await base44.asServiceRole.entities.User.get(authenticatedUser.id).catch(() => null);
  if (!actor || normalized2(actor.email) !== normalized2(authenticatedUser.email)) {
    throw Object.assign(new Error("The authenticated account could not be verified."), {
      status: 401,
      code: "invalid_authenticated_user"
    });
  }
  const personalContext = { actor, billingUser: actor, managerId: actor.id, teamMember: null };
  let managerId = String(actor.team_manager_id || actor.data?.team_manager_id || "").trim();
  const memberId = String(actor.team_member_id || actor.data?.team_member_id || "").trim();
  const appRole = normalized2(actor.app_role || actor.data?.app_role);
  const teamAccount = appRole === "rep" || !!memberId && !["manager", "admin"].includes(appRole);
  if (managerId === String(actor.id)) {
    if (teamAccount) throw membershipRequired();
    return personalContext;
  }
  if (!managerId && !teamAccount && (actor.is_owner === true || normalized2(actor.role) === "admin")) return personalContext;
  const memberships = await loadAllTeamRows(base44.asServiceRole.entities.TeamMember, {
    user_id: actor.id,
    ...managerId ? { manager_id: managerId } : {}
  }, { sort: "-updated_date" });
  const verified = memberships.filter(
    (member) => String(member?.user_id || "") === String(actor.id) && !!member?.manager_id && (!managerId || String(member.manager_id) === managerId) && normalized2(member?.email) === normalized2(actor.email) && String(member.manager_id) !== String(actor.id) && isActiveTeamRep(member)
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

// base44/functions/autoDriving/entry.ts
var normalized3 = (value) => String(value || "").trim().toLowerCase();
var asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  throw new AutoDrivingError(503, "GPS records could not be verified. Retry the report.");
};
var managerAccount = (user) => user?.is_owner === true || user?.data?.is_owner === true || ["manager", "admin"].includes(normalized3(user?.app_role || user?.data?.app_role)) || ["manager", "admin"].includes(normalized3(user?.role || user?.data?.role));
async function allPages(entity, query, sort = "created_date") {
  const records = [], seenPages = /* @__PURE__ */ new Set();
  for (let page = 0; page < 100; page++) {
    const rows = asArray(await entity.filter(query, sort, 5e3, page * 5e3));
    records.push(...rows);
    if (rows.length < 5e3) return records;
    const signature = JSON.stringify(rows.map((row) => row.id));
    if (seenPages.has(signature)) throw new AutoDrivingError(503, "GPS pagination could not be verified. Retry the report.");
    seenPages.add(signature);
  }
  throw new AutoDrivingError(503, "Too many GPS records. Choose a shorter date range.");
}
function identifier2(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw new AutoDrivingError(400, `${label} is required.`);
  return value.trim();
}
Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") throw new AutoDrivingError(405, "Method not allowed.");
    const base44 = createClientFromRequest(req), identity = await base44.auth.me();
    if (!identity?.id) throw new AutoDrivingError(401, "Sign in to use automatic mileage.");
    let body;
    try {
      body = await req.json();
    } catch {
      throw new AutoDrivingError(400, "Invalid request.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AutoDrivingError(400, "Invalid request.");
    const action = body.action || "report", now = Date.now();
    const service = base44.asServiceRole.entities, context = await resolveOutcomeBillingContext(base44, identity);
    const user = context.actor, ownMember = context.teamMember, managesTeam = !ownMember && managerAccount(user);
    if (user?.id !== identity.id) throw new AutoDrivingError(401, "Account could not be verified.");
    const managerId = context.managerId, manager = context.billingUser;
    if (!managesTeam && !ownMember) {
      if (action === "status") return Response.json({ success: true, manager_id: user.id, eligible: false, member_id: null, current_shift: null });
      throw new AutoDrivingError(403, "An active team membership is required.");
    }
    if (!manager || manager.id !== managerId || !managerAccount(manager)) throw new AutoDrivingError(403, "Team manager could not be verified.");
    if (action === "status") {
      const shifts = managesTeam ? [] : (await allPages(service.TimeShift, { manager_id: managerId, rep_user_id: user.id, status: "active" })).filter((shift) => shift.manager_id === managerId && shift.rep_user_id === user.id && shift.member_id === ownMember.id && shift.id === ownMember.time_clock_active_shift_id && shift.status === "active" && Date.parse(shift.clock_in_at) <= now);
      return Response.json({
        success: true,
        manager_id: managerId,
        eligible: !!ownMember,
        member_id: ownMember?.id || null,
        current_shift: shifts.length === 1 ? {
          id: shifts[0].id,
          manager_id: managerId,
          member_id: ownMember.id,
          rep_user_id: user.id,
          status: "active",
          clock_in_at: shifts[0].clock_in_at
        } : null
      });
    }
    if (action === "append") {
      const shiftId = identifier2(body.shift_id, "Shift ID"), sessionId = identifier2(body.session_id, "Session ID"), batchId = identifier2(body.batch_id, "Batch ID");
      const shift = await service.TimeShift.get(shiftId);
      const expectedMemberId = managesTeam ? `manager:${managerId}` : ownMember.id;
      if (!shift || shift.id !== shiftId || shift.manager_id !== managerId || shift.rep_user_id !== user.id || shift.member_id !== expectedMemberId || !["active", "closed"].includes(shift.status)) throw new AutoDrivingError(403, "GPS samples must belong to your verified work shift.");
      if (shift.status === "active" && !managesTeam && ownMember.time_clock_active_shift_id !== shift.id) throw new AutoDrivingError(409, "Refresh your current work shift before recording mileage.");
      if (!Array.isArray(body.points) || !body.points.length || body.points.length > AUTO_DRIVING_MAX_POINTS) throw new AutoDrivingError(400, "Send between 1 and 60 GPS samples.");
      const rawPoints = body.points.map((point) => normalizeDrivingPoint(point, now)).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
      const start = Date.parse(shift.clock_in_at), end = shift.status === "closed" ? Date.parse(shift.clock_out_at) : now + 1e4;
      if (!Number.isFinite(start) || !Number.isFinite(end) || Date.parse(rawPoints.at(-1).observed_at) - Date.parse(rawPoints[0].observed_at) > 5 * 6e4) throw new AutoDrivingError(400, "GPS samples must belong to one short work batch.");
      const points = rawPoints.filter((point) => Date.parse(point.observed_at) >= start && Date.parse(point.observed_at) <= end);
      const droppedPoints = rawPoints.length - points.length;
      if (!points.length) throw new AutoDrivingError(400, "No GPS samples fall inside the recorded shift.");
      const existing = (await allPages(service.AutoDrivingBatch, { manager_id: managerId, rep_user_id: user.id, batch_id: batchId })).find((row) => row.manager_id === managerId && row.rep_user_id === user.id && row.batch_id === batchId);
      if (existing) {
        const samePoints = Array.isArray(existing.points) && existing.points.length === points.length && points.every((point, index) => ["observed_at", "lat", "lng", "accuracy", "speed"].every((key) => existing.points[index]?.[key] === point[key]));
        if (existing.shift_id !== shiftId || existing.session_id !== sessionId || !samePoints) throw new AutoDrivingError(409, "This GPS batch was already saved with different samples.");
        return Response.json({ success: true, manager_id: managerId, batch_id: batchId, duplicate: true, dropped_points: droppedPoints });
      }
      await service.AutoDrivingBatch.create({
        manager_id: managerId,
        member_id: expectedMemberId,
        rep_user_id: user.id,
        shift_id: shiftId,
        session_id: sessionId,
        batch_id: batchId,
        started_at: points[0].observed_at,
        ended_at: points.at(-1).observed_at,
        received_at: new Date(now).toISOString(),
        points,
        dropped_points: droppedPoints
      });
      return Response.json({ success: true, manager_id: managerId, batch_id: batchId, dropped_points: droppedPoints });
    }
    if (action !== "report") throw new AutoDrivingError(400, "Unknown automatic mileage action.");
    const members = managesTeam ? (await allPages(service.TeamMember, { manager_id: managerId })).filter((member) => member.manager_id === managerId) : [];
    const timezone = validateClockTimezone(manager.time_clock_timezone || manager.data?.time_clock_timezone || DEFAULT_CLOCK_TIMEZONE);
    const range = clockDateRangeInZone(body.start_date, body.end_date, timezone);
    if (Date.parse(`${body.end_date}T00:00:00Z`) - Date.parse(`${body.start_date}T00:00:00Z`) > 30 * 864e5) throw new AutoDrivingError(400, "Choose a date range of up to 31 days.");
    const scope = { manager_id: managerId, ...!managesTeam ? { rep_user_id: user.id } : {} };
    const [rawShifts, rawBatches] = await Promise.all([
      allPages(service.TimeShift, {
        ...scope,
        clock_in_at: { $lt: range.end_at },
        $or: [{ status: "active" }, { clock_out_at: { $gte: range.start_at } }]
      }),
      allPages(service.AutoDrivingBatch, { ...scope, started_at: { $lt: range.end_at }, ended_at: { $gte: range.start_at } })
    ]);
    const inScope = (row) => row.manager_id === managerId && (managesTeam || row.rep_user_id === user.id);
    const people = managesTeam ? members.filter((member) => member.user_id).map((member) => ({
      member_id: member.id,
      rep_user_id: member.user_id,
      rep_name: member.name || member.email || "Team member"
    })) : [{ member_id: ownMember.id, rep_user_id: user.id, rep_name: ownMember.name || user.email || "You" }];
    if (managesTeam) people.unshift({ member_id: `manager:${managerId}`, rep_user_id: managerId, rep_name: user.full_name || user.email || "Manager" });
    const reps = summarizeAutoDriving(rawBatches.filter(inScope), rawShifts.filter(inScope), range, now, people);
    return Response.json({ success: true, manager_id: managerId, timezone, reps, totals: {
      miles: reps.some((rep) => rep.miles != null) ? Math.round(reps.reduce((sum, rep) => sum + (rep.miles || 0), 0) * 1e3) / 1e3 : null,
      recorded_reps: reps.filter((rep) => rep.status !== "not_recorded").length,
      missing_reps: reps.filter((rep) => rep.status === "not_recorded").length
    } });
  } catch (error) {
    console.error("Automatic mileage failed", error);
    return Response.json({ error: error.status ? error.message : "Automatic mileage is temporarily unavailable.", code: error.status ? "AUTO_DRIVING_INVALID" : "AUTO_DRIVING_UNAVAILABLE" }, { status: error.status || 503 });
  }
});
