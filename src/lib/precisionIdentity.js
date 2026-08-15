// @ts-check

/**
 * Resolve the immutable Precision workspace identity from either Base44 user
 * shape. The SDK may expose custom fields at the top level or under `data`.
 */
export function getPrecisionWorkspaceId(user) {
  return String(
    user?.team_manager_id
    || user?.data?.team_manager_id
    || user?.id
    || ''
  ).trim();
}
