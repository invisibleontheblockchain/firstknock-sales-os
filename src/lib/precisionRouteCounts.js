function positiveWholeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : null;
}

/**
 * Return the server-authorized route target for a Precision pull.
 *
 * `requested_properties_before_cap` is deliberately last: it represents the
 * user's original intent and is useful for an upgrade message, but it must not
 * enlarge the route target after a plan/free-home cap was applied.
 */
export function getRequestedPrecisionCount(jobStatus = {}) {
  const diagnostics = jobStatus?.diagnostics || {};
  const candidates = [
    diagnostics.requested_properties,
    jobStatus?.total_expected,
    jobStatus?.requested_properties,
    diagnostics?.batchdata_summary?.requested,
    jobStatus?.estimated_record_count,
    diagnostics.requested_properties_before_cap
  ];

  for (const candidate of candidates) {
    const count = positiveWholeCount(candidate);
    if (count !== null) return count;
  }
  return null;
}
