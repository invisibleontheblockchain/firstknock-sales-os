// base44/functions/redeemInviteCode/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// base44/shared/teamMembershipLifecycle.js
var normalized = (value) => String(value || "").trim().toLowerCase();
var identifier = (value) => String(value || "").trim();
function isActiveTeamRep(member) {
  return normalized(member?.role) === "rep" && normalized(member?.status) === "active";
}
function countUniqueActiveTeamReps(rows, managerId) {
  const expectedManager = identifier(managerId);
  const identities = rows.filter((member) => isActiveTeamRep(member) && identifier(member?.manager_id) === expectedManager && identifier(member?.user_id) !== expectedManager).map((member) => {
    const userId = identifier(member.user_id);
    const email = normalized(member.email);
    return userId ? `user:${userId}` : email ? `email:${email}` : `member:${identifier(member.id)}`;
  });
  return new Set(identities).size;
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

// base44/functions/redeemInviteCode/entry.ts
var CLAIM_EXISTING_ACTION = "claim_existing";
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
function toArray(result) {
  return Array.isArray(result) ? result : result?.items || [];
}
function normalized2(value) {
  return String(value || "").trim().toLowerCase();
}
function isActiveRep(member) {
  return isActiveTeamRep(member);
}
function isManagerAccount(user) {
  const appRole = normalized2(user?.app_role || user?.data?.app_role);
  const accountRole = normalized2(user?.role || user?.data?.role);
  return user?.is_owner === true || appRole === "manager" || appRole === "admin" || accountRole === "manager" || accountRole === "admin";
}
async function getManager(service, managerId) {
  try {
    const manager = await service.entities.User.get(managerId);
    return manager && isManagerAccount(manager) ? manager : null;
  } catch {
    return null;
  }
}
async function claimExistingMembership(service, user) {
  const email = normalized2(user?.email);
  if (!email) throw new HttpError(400, "Your account needs a verified email before it can join a team.");
  const [linkedResult, emailResult] = await Promise.all([
    loadAllTeamRows(service.entities.TeamMember, { user_id: user.id }),
    loadAllTeamRows(service.entities.TeamMember, { email })
  ]);
  const byId = /* @__PURE__ */ new Map();
  for (const member2 of [...toArray(linkedResult), ...toArray(emailResult)]) {
    if (member2?.id) byId.set(String(member2.id), member2);
  }
  const identityMatches = [...byId.values()].filter((member2) => {
    const linkedUserId = String(member2?.user_id || "").trim();
    return isActiveRep(member2) && !!member2?.manager_id && normalized2(member2?.email) === email && (!linkedUserId || linkedUserId === String(user.id));
  });
  const verified = [];
  const managersById = /* @__PURE__ */ new Map();
  for (const member2 of identityMatches) {
    if (!managersById.has(member2.manager_id)) {
      managersById.set(member2.manager_id, await getManager(service, member2.manager_id));
    }
    const manager = managersById.get(member2.manager_id);
    if (!manager) continue;
    const alreadyLinked = String(member2.user_id || "") === String(user.id);
    const createdByManager = normalized2(member2.created_by) === normalized2(manager.email);
    if (alreadyLinked || createdByManager) verified.push({ member: member2, manager });
  }
  const currentManagerId = String(user?.team_manager_id || user?.data?.team_manager_id || "").trim();
  const currentMatches = currentManagerId ? verified.filter(({ member: member2 }) => String(member2.manager_id) === currentManagerId) : [];
  const linkedMatches = verified.filter(({ member: member2 }) => String(member2.user_id || "") === String(user.id));
  const preferred = currentManagerId ? currentMatches : linkedMatches.length > 0 ? linkedMatches : verified;
  const managerIds = new Set(preferred.map(({ member: member2 }) => String(member2.manager_id)));
  if (managerIds.size === 0) {
    throw new HttpError(404, "No active team membership could be verified. Ask your manager for a current invite code.");
  }
  if (managerIds.size > 1) {
    throw new HttpError(409, "More than one team membership matches this account. Use the invite code for the team you want to join.");
  }
  const selectedManagerId = [...managerIds][0];
  let member = selectCanonicalTeamMember(preferred.map(({ member: member2 }) => member2), user, {
    managerId: selectedManagerId,
    memberId: user?.team_member_id || user?.data?.team_member_id,
    allowUnlinked: true
  });
  if (!member) throw new HttpError(404, "No active team membership could be verified. Ask your manager for a current invite code.");
  if (String(member.user_id || "") !== String(user.id)) {
    member = await service.entities.TeamMember.update(member.id, { user_id: user.id });
  }
  const userUpdates = {
    app_role: "rep",
    team_manager_id: selectedManagerId,
    team_member_id: member.id
  };
  if (member.invite_code) userUpdates.team_invite_code = member.invite_code;
  await service.entities.User.update(user.id, userUpdates);
  return {
    success: true,
    role: "rep",
    manager_id: selectedManagerId,
    team_member_id: member.id,
    claimed_existing: true
  };
}
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) throw new HttpError(401, "Unauthorized");
    const body = await req.json().catch(() => ({}));
    const service = base44.asServiceRole;
    if (body?.action === CLAIM_EXISTING_ACTION) {
      return Response.json(await claimExistingMembership(service, user));
    }
    const code = body?.code;
    if (!code || typeof code !== "string") {
      throw new HttpError(400, "Missing invite code");
    }
    const email = normalized2(user.email);
    if (!email) throw new HttpError(400, "Your account needs a verified email before it can join a team.");
    const normalizedCode = code.trim().toUpperCase();
    const codes = toArray(await service.entities.InviteCode.filter(
      { code: normalizedCode, is_active: true },
      "-created_date",
      1
    ));
    const validCode = codes[0];
    if (!validCode) throw new HttpError(404, "Invalid or expired code");
    const managerId = String(validCode.linked_user_id || "").trim();
    if (!managerId) {
      throw new HttpError(400, "This team code is not linked to a manager account");
    }
    const manager = await getManager(service, managerId);
    if (!manager) throw new HttpError(400, "This team code is not linked to an active manager account");
    if (String(user.id) === managerId) {
      throw new HttpError(403, "You already manage this workspace. Share this code with a rep to join your team.");
    }
    if (normalized2(validCode.role) !== "rep") {
      throw new HttpError(403, "Only rep invite codes can be redeemed. Ask an administrator to grant elevated access.");
    }
    const [linkedResult, emailResult] = await Promise.all([
      loadAllTeamRows(service.entities.TeamMember, { user_id: user.id, manager_id: managerId }),
      loadAllTeamRows(service.entities.TeamMember, { email, manager_id: managerId })
    ]);
    const candidates = [...toArray(linkedResult), ...toArray(emailResult)];
    let member = selectCanonicalTeamMember(candidates, user, {
      managerId,
      memberId: user?.team_member_id || user?.data?.team_member_id,
      allowUnlinked: true,
      includeInactive: true
    });
    const alreadyActiveOnThisTeam = isActiveRep(member);
    const conflictingMember = candidates.find((candidate) => String(candidate?.manager_id || "") === managerId && normalized2(candidate?.email) === email && candidate?.user_id && String(candidate.user_id) !== String(user.id));
    if (!member && conflictingMember) {
      throw new HttpError(409, "This team membership is already linked to another account.");
    }
    if (!alreadyActiveOnThisTeam && normalized2(validCode.role) !== "manager") {
      const isTestCode = validCode.code === "0000";
      const paidSeatLimit = isTestCode ? 2 : manager.is_owner || manager.subscription_paid_confirmed === true ? manager.total_seats || 1 : 0;
      const codeSeatLimit = Number.isFinite(Number(validCode.max_uses)) ? Number(validCode.max_uses) : paidSeatLimit;
      const usableSeatLimit = Math.max(0, Math.min(paidSeatLimit, codeSeatLimit));
      const teamMembers = await loadAllTeamRows(service.entities.TeamMember, { manager_id: managerId });
      const activeRepCount = countUniqueActiveTeamReps(teamMembers, managerId);
      if (activeRepCount >= usableSeatLimit) {
        throw new HttpError(403, "This team has no paid seats available. Ask your manager to add a seat first.");
      }
    }
    const isNewMembership = !member;
    if (!member) {
      member = await service.entities.TeamMember.create({
        name: user.full_name || email.split("@")[0],
        email,
        user_id: user.id,
        role: validCode.role,
        status: "active",
        color: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
        manager_id: managerId,
        invite_code: validCode.code
      });
    } else {
      const updates = {};
      if (String(member.user_id || "") !== String(user.id)) updates.user_id = user.id;
      if (member.invite_code !== validCode.code) updates.invite_code = validCode.code;
      if (member.role !== validCode.role) updates.role = validCode.role;
      if (normalized2(member.status) === "inactive") updates.status = "active";
      if (Object.keys(updates).length > 0) {
        member = await service.entities.TeamMember.update(member.id, updates);
      }
    }
    await service.entities.User.update(user.id, {
      app_role: validCode.role,
      team_manager_id: managerId,
      team_member_id: member.id,
      team_invite_code: validCode.code
    });
    if (isNewMembership) {
      await service.entities.InviteCode.update(validCode.id, {
        used_count: (validCode.used_count || 0) + 1
      });
    }
    return Response.json({
      success: true,
      role: validCode.role,
      manager_id: managerId,
      team_member_id: member.id,
      claimed_existing: false
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return Response.json({ error: error?.message || "Unable to join team" }, { status });
  }
});
