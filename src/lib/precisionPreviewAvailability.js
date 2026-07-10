function finiteCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

/**
 * A zero count is authoritative only when both independent provider
 * predicates completed successfully. One successful zero plus one failed
 * predicate is unknown inventory, not proof that the union is empty.
 */
export function getPrecisionPreviewAvailability(previewResult) {
  const count = finiteCount(previewResult?.provider_candidate_count);
  const probe = previewResult?.count_probe || null;
  const intel = probe?.predicate_results?.intel;
  const sale = probe?.predicate_results?.sale;
  const inferredComplete = intel?.ok === true && sale?.ok === true;
  const complete = probe?.predicate_counts_complete === true || inferredComplete;
  const hasSuccessfulPredicate = probe
    ? (probe.ok === true || intel?.ok === true || sale?.ok === true)
    : count !== null;

  return {
    count,
    hasCount: count !== null,
    attempted: !!probe,
    hasSuccessfulPredicate,
    complete,
    partial: !!probe && hasSuccessfulPredicate && !complete,
    definitiveZero: complete && count === 0
  };
}

export function precisionGenerationBlockedByPreview(previewResult, {
  selectedHistoryArea = false,
  requiresShortWindowPreflight = false
} = {}) {
  if (selectedHistoryArea) return false;
  const availability = getPrecisionPreviewAvailability(previewResult);
  if (availability.definitiveZero) return true;
  if (!requiresShortWindowPreflight) return false;
  return !availability.hasSuccessfulPredicate;
}
