/**
 * Budgeted, anchored refinement for an ordered list of atomic sweep blocks.
 *
 * The previous implementation refined only when the block count fell under a
 * hard limit (40 cost-only / 120 otherwise) and abandoned ordering entirely
 * above 500 blocks. Everything larger shipped raw greedy nearest-neighbor
 * order, which strands isolated blocks and makes a rep walk away and bounce
 * back for them many stops later.
 *
 * Two properties make refinement affordable at every scale:
 *
 * 1. Delta cost. A 2-opt reversal or a single-block relocation only changes the
 *    two or three transitions around the move, so a candidate is scored by those
 *    edges instead of re-running a full route cost. Transition costs come from a
 *    caller-supplied (memoized) pairCost, so a road-aware context pays for each
 *    distinct block pair once.
 * 2. Anchored windows. Long sequences are refined in overlapping windows, and
 *    each window is anchored to the exit of the block before it and the entry of
 *    the block after it. Refining a window blind to its neighbours can reorder it
 *    into an island that opens far from where the rep actually arrives — which is
 *    itself a source of long-jump backtracking.
 *
 * Ordering is deterministic: fixed scan order, strict improvement threshold,
 * best-improvement selection with a first-found tie-break, and a fixed step
 * budget rather than a wall-clock guard (which produces hardware-dependent
 * results).
 */

const IMPROVEMENT_EPSILON = 0.000001;

/**
 * Refine one window in place-free fashion.
 * headCost/tailCost describe how the window connects to whatever precedes and
 * follows it (an external start/finish point, or a neighbouring block).
 */
function refineWindow(sequence, headCost, tailCost, pairCost, maxPasses, budget) {
    const blocks = [...sequence];
    if (blocks.length < 2) return { blocks, budget };

    let remainingBudget = budget;
    const head = (block) => headCost(block);
    const tail = (block) => tailCost(block);
    const link = (first, second) => pairCost(first, second);

    for (let pass = 0; pass < maxPasses; pass++) {
        let bestDelta = -IMPROVEMENT_EPSILON;
        let bestMove = null;
        const count = blocks.length;

        // 2-opt: reverse blocks[start..finish]. Transition costs are symmetric
        // (each is the cheapest exit/entry pairing between two blocks), so every
        // edge inside the reversed span keeps its cost and only the two boundary
        // edges change.
        for (let start = 0; start < count - 1 && remainingBudget > 0; start++) {
            for (let finish = start + 1; finish < count && remainingBudget > 0; finish++) {
                remainingBudget--;
                const oldLead = start === 0
                    ? head(blocks[0])
                    : link(blocks[start - 1], blocks[start]);
                const newLead = start === 0
                    ? head(blocks[finish])
                    : link(blocks[start - 1], blocks[finish]);
                const oldTrail = finish === count - 1
                    ? tail(blocks[count - 1])
                    : link(blocks[finish], blocks[finish + 1]);
                const newTrail = finish === count - 1
                    ? tail(blocks[start])
                    : link(blocks[start], blocks[finish + 1]);
                const delta = (newLead + newTrail) - (oldLead + oldTrail);
                if (delta < bestDelta) {
                    bestDelta = delta;
                    bestMove = { type: 'reverse', start, finish };
                }
            }
        }

        // Or-opt: relocate a single block. Reversals alone cannot rescue a block
        // that greedy nearest-neighbor stranded.
        for (let from = 0; from < count && remainingBudget > 0; from++) {
            const moved = blocks[from];
            const beforeFrom = from > 0 ? blocks[from - 1] : null;
            const afterFrom = from < count - 1 ? blocks[from + 1] : null;
            const removed = (beforeFrom ? link(beforeFrom, moved) : head(moved))
                + (afterFrom ? link(moved, afterFrom) : tail(moved));
            const bridged = beforeFrom && afterFrom
                ? link(beforeFrom, afterFrom)
                : beforeFrom
                    ? tail(beforeFrom)
                    : afterFrom
                        ? head(afterFrom)
                        : 0;
            const removalGain = removed - bridged;
            // Index into the sequence with `from` removed, without allocating it.
            const reducedAt = (index) => blocks[index < from ? index : index + 1];
            const reducedCount = count - 1;

            for (let to = 0; to <= reducedCount && remainingBudget > 0; to++) {
                if (to === from) continue; // same position
                remainingBudget--;
                const left = to > 0 ? reducedAt(to - 1) : null;
                const right = to < reducedCount ? reducedAt(to) : null;
                const oldEdge = left && right
                    ? link(left, right)
                    : left
                        ? tail(left)
                        : right
                            ? head(right)
                            : 0;
                const newEdge = (left ? link(left, moved) : head(moved))
                    + (right ? link(moved, right) : tail(moved));
                const delta = (newEdge - oldEdge) - removalGain;
                if (delta < bestDelta) {
                    bestDelta = delta;
                    bestMove = { type: 'relocate', from, to };
                }
            }
        }

        if (!bestMove) break;
        if (bestMove.type === 'reverse') {
            const segment = blocks.slice(bestMove.start, bestMove.finish + 1).reverse();
            blocks.splice(bestMove.start, segment.length, ...segment);
        } else {
            const [moved] = blocks.splice(bestMove.from, 1);
            blocks.splice(bestMove.to, 0, moved);
        }
        if (remainingBudget <= 0) break;
    }

    return { blocks, budget: remainingBudget };
}

/**
 * @param {Array} blocks Seed order (nearest-neighbor or spatial sort).
 * @param {Object} options
 * @param {Function} options.pairCost (first, second) => transition cost
 * @param {Function} options.startCost (block) => cost of entering from the trip start (0 when unbounded)
 * @param {Function} options.endCost (block) => cost of leaving toward the trip finish (0 when unbounded)
 * @param {Number} options.windowSize Blocks refined together
 * @param {Number} options.overlap Blocks shared between neighbouring windows
 * @param {Number} options.maxPasses Improvement passes per window
 * @param {Number} options.stepBudget Total candidate evaluations allowed
 */
export function refineBlockSequence(blocks, {
    pairCost,
    startCost,
    endCost,
    windowSize = 60,
    overlap = 20,
    maxPasses = 4,
    stepBudget = 250000
} = {}) {
    if (!Array.isArray(blocks) || blocks.length < 2) return [...(blocks || [])];
    if (typeof pairCost !== 'function') return [...blocks];

    const resolvedStartCost = typeof startCost === 'function' ? startCost : () => 0;
    const resolvedEndCost = typeof endCost === 'function' ? endCost : () => 0;

    if (blocks.length <= windowSize) {
        return refineWindow(
            blocks,
            resolvedStartCost,
            resolvedEndCost,
            pairCost,
            maxPasses,
            stepBudget
        ).blocks;
    }

    const step = Math.max(1, windowSize - overlap);
    let refined = [...blocks];
    let remainingBudget = stepBudget;

    for (let start = 0; start < refined.length && remainingBudget > 0; start += step) {
        const finish = Math.min(start + windowSize, refined.length);
        if (finish - start < 2) break;
        const anchorBefore = start > 0 ? refined[start - 1] : null;
        const anchorAfter = finish < refined.length ? refined[finish] : null;

        // Anchoring is what keeps windows from being optimized into disconnected
        // islands: entering the window is priced from the previous block's exit,
        // and leaving it is priced into the next block's entry.
        const windowHeadCost = anchorBefore
            ? (block) => pairCost(anchorBefore, block)
            : resolvedStartCost;
        const windowTailCost = anchorAfter
            ? (block) => pairCost(block, anchorAfter)
            : resolvedEndCost;

        const result = refineWindow(
            refined.slice(start, finish),
            windowHeadCost,
            windowTailCost,
            pairCost,
            maxPasses,
            remainingBudget
        );
        remainingBudget = result.budget;
        for (let index = 0; index < result.blocks.length; index++) {
            refined[start + index] = result.blocks[index];
        }
        if (finish === refined.length) break;
    }

    return refined;
}