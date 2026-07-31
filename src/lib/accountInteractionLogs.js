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
export async function fetchAccountInteractionLogs(user, limit = 5000) {
  const managerId = getTenantManagerId(user);
  const email = getUserEmail(user);
  const groups = await Promise.all([
    managerId ? base44.entities.InteractionLog.filter({ manager_id: managerId }, '-created_date', limit) : [],
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
  return list.filter((log) => (
    (log?.created_by && validEmails.has(String(log.created_by).toLowerCase()))
    || recordBelongsToCurrentAccount(log, user)
  ));
}