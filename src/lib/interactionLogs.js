/**
 * Legacy interaction rows predate the counts_as_knock field, so an omitted
 * value remains a real field activity. Only explicit workflow transitions are
 * excluded from performance analytics.
 */
export function isKnockActivityLog(log) {
  return log?.counts_as_knock !== false;
}

export function filterKnockActivityLogs(logs = []) {
  return logs.filter(isKnockActivityLog);
}
