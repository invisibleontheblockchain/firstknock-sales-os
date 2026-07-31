import { base44 } from '@/api/base44Client';
import {
  dedupeEntities,
  getTenantManagerId,
  getUserEmail,
  recordBelongsToCurrentAccount,
  toEntityArray,
} from '@/lib/accountScope';

// A global list('-created_date', 5000) is NOT account-scoped: an owner/admin can
// read every account's rows, so this account's sold outcomes fall outside that
// newest-5000 window and the map derives ELIGIBLE (route color instead of the
// green sold pin). Query by the tenant key and the author instead.
// An owner who is ALSO on a team (role admin + team_manager_id) has two valid
// tenant keys: their own id and their team manager's id. The outcome service
// stamps manager_id with the team manager, so scoping to only one of them threw
// away this account's own sold outcomes.
export function getAccountManagerIds(user) {
  return [getTenantManagerId(user), user?.team_manager_id || user?.data?.team_manager_id]
    .filter(Boolean)
    .filter((id, index, all) => all.indexOf(id) === index);
}

export async function fetchAccountInteractionLogs(user, limit = 5000) {
  const email = getUserEmail(user);
  const groups = await Promise.all([
    ...getAccountManagerIds(user).map((managerId) => (
      base44.entities.InteractionLog.filter({ manager_id: managerId }, '-created_date', limit)
    )),
    email ? base44.entities.InteractionLog.filter({ created_by: email }, '-created_date', limit) : [],
  ]);
  return dedupeEntities(groups.flatMap(toEntityArray));
}

// Outcomes are written by the outcome service, so their created_by is a service
// address rather than a rep email. Those rows are still owned by the account
// through manager_id — filtering on emails alone dropped every logged sale, so
// sold doors kept rendering as ELIGIBLE on the map.
export function scopeInteractionLogsToAccount(rows, user, teamMembers = []) {
  const list = Array.isArray(rows) ? rows : (rows?.items || []);
  if (!user) return [];
  const validEmails = new Set(
    [user.email, ...(teamMembers || []).map((m) => m?.email)]
      .filter(Boolean)
      .map((email) => String(email).toLowerCase())
  );
  const managerIds = new Set(getAccountManagerIds(user));
  return list.filter((log) => (
    (log?.created_by && validEmails.has(String(log.created_by).toLowerCase()))
    || (log?.manager_id && managerIds.has(log.manager_id))
    || recordBelongsToCurrentAccount(log, user)
  ));
}