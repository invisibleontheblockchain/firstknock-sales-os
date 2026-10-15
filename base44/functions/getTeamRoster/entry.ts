// base44/functions/getTeamRoster/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

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

// base44/functions/getTeamRoster/entry.ts
var normalized3 = (value) => String(value || "").trim().toLowerCase();
var isActive = (member) => normalized3(member?.status) === "active";
function isManager(user) {
  return user?.is_owner === true || user?.data?.is_owner === true || ["manager", "admin"].includes(normalized3(user?.app_role || user?.data?.app_role)) || ["manager", "admin"].includes(normalized3(user?.role || user?.data?.role));
}
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
async function loadMembers(service, managerId) {
  const rows = await loadAllTeamRows(service.entities.TeamMember, { manager_id: managerId }, { pageSize: 500 });
  return rows.filter((member) => member.manager_id === managerId);
}
function publicMember(member) {
  return Object.fromEntries([
    "id",
    "user_id",
    "manager_id",
    "name",
    "email",
    "role",
    "status",
    "color",
    "profile_image_url"
  ].filter((key) => member[key] !== void 0).map((key) => [key, member[key]]));
}
Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const base44 = createClientFromRequest(req);
    const identity = await base44.auth.me();
    if (!identity?.id) throw new HttpError(401, "Sign in to view your team.");
    const service = base44.asServiceRole;
    const context = await resolveOutcomeBillingContext(base44, identity);
    const user = context.actor;
    const managesTeam = !context.teamMember && isManager(user);
    const managerId = context.managerId;
    const manager = context.billingUser;
    if (!managesTeam && !context.teamMember) throw new HttpError(403, "Join a team before viewing its roster.");
    if (!manager || manager.id !== managerId || !isManager(manager)) {
      throw new HttpError(403, "Your team manager could not be verified.");
    }
    const members = await loadMembers(service, managerId);
    const managerProfile = {
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
    if (managesTeam) managerProfile.assigned_zip_codes = manager.territory_zip_codes || manager.data?.territory_zip_codes || [];
    return Response.json({
      success: true,
      manager_id: managerId,
      manager: managerProfile,
      members: managesTeam ? members : members.filter(isActive).map(publicMember)
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status === 500) console.error("Team roster load failed:", error);
    return Response.json({
      error: status === 500 ? "Unable to load the team roster. Please retry." : error.message,
      ...typeof error?.code === "string" ? { code: error.code } : {}
    }, { status });
  }
});
