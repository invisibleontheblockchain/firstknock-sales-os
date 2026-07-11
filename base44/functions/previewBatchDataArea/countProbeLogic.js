function successfulPredicate(result) {
    return result?.ok === true && Number.isFinite(Number(result?.count));
}

/**
 * Summarize the independent Intel and Sale count predicates without turning a
 * partial response into authoritative zero inventory.
 */
export function summarizeDualPredicateCounts(intel = {}, sale = {}) {
    const results = [intel, sale];
    const successful = results.filter(successfulPredicate);
    const counts = successful.map(result => Number(result.count));
    const complete = successful.length === results.length;
    const candidateCount = counts.length > 0 ? Math.max(...counts) : null;

    return {
        ok: successful.length > 0,
        complete,
        partial: successful.length > 0 && !complete,
        candidateCount,
        upperBound: complete ? Number(intel.count) + Number(sale.count) : null,
        definitiveZero: complete && candidateCount === 0
    };
}
