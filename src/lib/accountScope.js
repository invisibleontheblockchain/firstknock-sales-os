import { getManagerIdForAccount } from '@/lib/roles';

export function toEntityArray(result) {
  return Array.isArray(result) ? result : (result?.items || []);
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function getUserEmail(user) {
  return normalizeEmail(user?.email || user?.data?.email);
}

export function getTenantManagerId(user) {
  return getManagerIdForAccount(user) || null;
}

export function dedupeEntities(rows) {
  const seen = new Set();
  return rows.filter((row, index) => {
    const fallbackKey = [
      row?.created_by,
      row?.address_hash,
      row?.route_id,
      row?.scheduled_date,
      row?.created_date,
    ].filter(Boolean).join('|');
    const key = row?.id || fallbackKey || `row-${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function recordCreatedByCurrentUser(record, user) {
  const userEmail = getUserEmail(user);
  return !!userEmail && normalizeEmail(record?.created_by) === userEmail;
}

export function recordBelongsToCurrentAccount(record, user) {
  if (!record || !user) return false;
  const tenantManagerId = getTenantManagerId(user);
  if (tenantManagerId && record.manager_id === tenantManagerId) return true;
  return !record.manager_id && recordCreatedByCurrentUser(record, user);
}

export function personalRecordBelongsToCurrentAccount(record, user) {
  if (!record || !user || !recordCreatedByCurrentUser(record, user)) return false;
  const tenantManagerId = getTenantManagerId(user);
  return !tenantManagerId || !record.manager_id || record.manager_id === tenantManagerId;
}
