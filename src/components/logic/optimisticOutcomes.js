// An outcome the rep has logged is shown immediately, before the server write
// finishes. The one rule that keeps a logged door from flipping back to Todo:
// the optimistic row is retired ONLY against positive evidence that its real
// row has landed. Never on a completed write, never on a timer — a refetch that
// has not caught up yet would then find nothing holding the door.

// Server and device clocks disagree; a real row can carry a timestamp slightly
// behind the optimistic one it replaces.
export const OUTCOME_CLOCK_SKEW_MS = 120_000;

// True when `rows` already contains the real row this optimistic entry stands
// for. Matches on id when the write told us which row it created, and otherwise
// falls back to the outcome itself, so an unexpected response shape degrades to
// a slower retirement rather than a door that reverts.
export function isOutcomeRowPresent(rows, entry) {
    if (!Array.isArray(rows) || !entry) return false;

    if (entry.server_id) {
        return rows.some((row) => row?.id && row.id === entry.server_id);
    }

    const loggedAt = new Date(entry.created_date || 0).getTime();
    if (!Number.isFinite(loggedAt)) return false;

    return rows.some((row) => {
        if (!row || row.id === entry.id) return false;
        if (row.address_hash !== entry.address_hash) return false;
        if (row.parsed_status !== entry.parsed_status) return false;
        const rowAt = new Date(row.created_date || 0).getTime();
        return Number.isFinite(rowAt) && rowAt >= loggedAt - OUTCOME_CLOCK_SKEW_MS;
    });
}

// Returns the optimistic rows that still need to be shown, retiring any whose
// real row is now visible. Mutates `pendingMap`, which is the point: retirement
// is driven by what a query actually returned.
//
// Deletion goes by map key, never by entry.id — confirmOutcomeRow swaps the
// entry's id to the server's, so keying off the entry would leak the row.
export function collectUnretiredOutcomes(pendingMap, rows, addressHash = null) {
    if (!pendingMap || pendingMap.size === 0) return [];

    const unretired = [];
    for (const [key, entry] of pendingMap.entries()) {
        if (addressHash && entry.address_hash !== addressHash) continue;
        if (isOutcomeRowPresent(rows, entry)) {
            pendingMap.delete(key);
            continue;
        }
        unretired.push(entry);
    }
    return unretired;
}

// Once the write returns, the response carries the authoritative row it created.
// Swap it in for the optimistic sketch so the door shows the real record and
// keeps showing it even if the list query is lagging, capped, or scoped in a way
// that never returns the row at all.
export function confirmOutcomeRow(pendingMap, optimisticId, serverRow) {
    if (!pendingMap || !optimisticId) return null;
    const entry = pendingMap.get(optimisticId);
    if (!entry) return null;
    if (!serverRow?.id) return entry;

    const confirmed = { ...entry, ...serverRow, id: serverRow.id, server_id: serverRow.id };
    pendingMap.set(optimisticId, confirmed);
    return confirmed;
}
