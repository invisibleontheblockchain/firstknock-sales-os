/**
 * Live progress feedback for the long phase of route optimization.
 *
 * The road-matrix optimizer is a real 6–10s backend call (matrix fetch, then a
 * fixed-budget solver). A single static "Checking real road distances..." toast
 * held for that long reads as a frozen app, which is what a user reported. This
 * keeps the same toast id and wording but appends a ticking elapsed count and,
 * past a threshold, an explicit reassurance that work is still in progress.
 *
 * Purely presentational: it never changes what the optimizer does or how long it
 * takes, and stop() is safe to call more than once.
 */

import { toast } from 'sonner';

const TICK_MS = 1000;
// Below this the elapsed counter would just flicker on and off for fast routes.
const SHOW_ELAPSED_AFTER_MS = 1500;
// Past this the wait is unusual enough to deserve an explicit "still working".
const REASSURE_AFTER_MS = 12000;

export function startOptimizeProgress({ id, label }) {
    const startedAt = Date.now();
    let currentLabel = label;
    let timer = null;

    const render = () => {
        const elapsedMs = Date.now() - startedAt;
        const seconds = Math.floor(elapsedMs / 1000);
        if (elapsedMs < SHOW_ELAPSED_AFTER_MS) {
            toast.loading(currentLabel, { id });
            return;
        }
        const suffix = elapsedMs >= REASSURE_AFTER_MS
            ? ` — still working (${seconds}s)`
            : ` (${seconds}s)`;
        toast.loading(`${currentLabel}${suffix}`, { id });
    };

    render();
    timer = setInterval(render, TICK_MS);

    return {
        /** Move to the next phase without losing the elapsed count. */
        update(nextLabel) {
            currentLabel = nextLabel;
            render();
        },
        /** Stop ticking. The caller still owns the final success/error toast. */
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        }
    };
}