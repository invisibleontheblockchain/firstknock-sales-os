// The walking order is the saved route order without the doors nobody walks to
// any more. Those doors stay on the route record, so a list is never re-imported
// over them by accident, but they get no stop number, sit off the route line
// and are listed together at the bottom as "kept on file".
//
// Field request (Flotilla, Nov 2026): Not Qualified houses cluttered the middle
// of long routes that are re-walked for days. Only Not Qualified is kept on
// file; Not Interested and Sold doors keep their place in the order.
//
// Dependency-free so node --test can import it directly.

export const KEPT_ON_FILE_STATUSES = Object.freeze(['NOT_QUALIFIED']);

const KEPT_ON_FILE_SET = new Set(KEPT_ON_FILE_STATUSES);

export const isKeptOnFileStatus = (status) => KEPT_ON_FILE_SET.has(status);

const effectiveStatus = (stop) => stop?.effective_status;

/**
 * Splits route stops into the walking order and the kept-on-file group. Both
 * keep the saved route order, so nothing is reshuffled by the split.
 */
export function splitWalkingOrder(stops = [], statusOf = effectiveStatus) {
    const walking = [];
    const keptOnFile = [];
    (Array.isArray(stops) ? stops : []).forEach((stop) => {
        if (!stop) return;
        (isKeptOnFileStatus(statusOf(stop)) ? keptOnFile : walking).push(stop);
    });
    return { walking, keptOnFile };
}

/**
 * Stop number (1-based) for every stop in the walking order. Kept-on-file
 * stops are absent from the map, so they never get a number.
 */
export function walkingStopNumbers(stops = [], keyOf, statusOf = effectiveStatus) {
    const numbers = new Map();
    splitWalkingOrder(stops, statusOf).walking.forEach((stop, index) => {
        const key = keyOf(stop);
        if (key !== undefined && key !== null && key !== '' && !numbers.has(key)) numbers.set(key, index + 1);
    });
    return numbers;
}

/** Route stops a line should connect: the walking order only. */
export const walkingStops = (stops = [], statusOf = effectiveStatus) =>
    splitWalkingOrder(stops, statusOf).walking;
