import { recordBelongsToCurrentAccount } from '@/lib/accountScope';

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