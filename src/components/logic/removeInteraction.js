const HISTORY_KEYS = ['interactionLogs', 'selectedPropertyHistory', 'routeChecklistLogs'];

// A stale history card can outlive its server row. Only a genuine 404 is
// idempotent; permission and network failures must leave the history intact.
export default async function removeInteraction({ id, remove, queryClient, pendingOutcomes }) {
    let missing = false;
    try {
        await remove(id);
    } catch (error) {
        const status = error?.response?.status ?? error?.status;
        if (Number(status) !== 404) throw error;
        missing = true;
    }

    // Stop an older history read from restoring the row after removal.
    await Promise.all(HISTORY_KEYS.map((key) => queryClient.cancelQueries({ queryKey: [key] })));
    for (const [key, entry] of pendingOutcomes.entries()) {
        if (entry?.id === id || entry?.server_id === id) pendingOutcomes.delete(key);
    }
    const withoutRemoved = (rows) => rows.filter((row) => row?.id !== id);
    for (const key of HISTORY_KEYS) {
        queryClient.setQueriesData({ queryKey: [key] }, (old) => {
            if (Array.isArray(old)) return withoutRemoved(old);
            if (Array.isArray(old?.items)) return { ...old, items: withoutRemoved(old.items) };
            return old;
        });
    }
    await Promise.all(HISTORY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    return { missing };
}