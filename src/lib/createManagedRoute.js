// A local backup is useful, but it is not a saved account route. Let failures
// reject so delivery reporting and the completed-import recovery key survive.
const queueKey = actorId => `fk_pendingRouteSaves_v1_${actorId}`;
const running = new Map();
function storeFor(options) {
    try { return options.storage || globalThis.localStorage; } catch { return null; }
}
export function pendingRouteSaves(actorId, storage) {
    try {
        const entries = JSON.parse(storage?.getItem(queueKey(actorId)) || '[]');
        return Array.isArray(entries) ? entries.filter(entry => entry.actorId === actorId && entry.id && entry.route) : [];
    } catch { return []; }
}
function editQueue(actorId, storage, edit) {
    try { storage?.setItem(queueKey(actorId), JSON.stringify(edit(pendingRouteSaves(actorId, storage)))); }
    catch { /* A full or unavailable device cache must not prevent a cloud save. */ }
}
async function requestId(route) {
    const job = route.metadata?.newly_generated && !route.metadata?.rerun_from_route_id && !route.parent_route_id
        ? route.metadata?.precision_area?.job_id : null;
    const identity = job ? { job, homes: [...route.property_hashes].sort(), assignee: route.assigned_to, manager: route.manager_id } : route;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identity)));
    return `route-${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
export async function createManagedRoute(client, route, options = {}) {
    const actorId = options.actorId || (await client.auth?.me())?.id || route.manager_id;
    const storage = storeFor(options);
    const id = options.requestId || await requestId(route);
    const activeKey = `${actorId}:${id}`;
    if (running.has(activeKey)) return running.get(activeKey);
    editQueue(actorId, storage, entries => entries.some(entry => entry.id === id) ? entries
        : [...entries, { id, actorId, route, createdAt: new Date().toISOString() }]);
    const saving = save(client, route, id, options).then(saved => {
        editQueue(actorId, storage, entries => entries.filter(entry => entry.id !== id));
        return saved;
    }).finally(() => running.delete(activeKey));
    running.set(activeKey, saving);
    return saving;
}
async function save(client, route, id, options) {
    try {
        let response;
        for (let attempt = 0; ; attempt++) {
            try { response = await client.functions.invoke('createManagedRoute', { route, request_id: id }); break; }
            catch (error) {
                const status = Number(error?.status || error?.response?.status || 0);
                if (![0, 408, 409, 429, 500, 502, 503, 504].includes(status) || attempt >= 2) throw error;
                await (options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(500 * 2 ** attempt);
            }
        }
        const saved = response?.data?.route;
        const expectedHomes = new Set(route.property_hashes);
        if (!saved?.id || String(saved.id).startsWith('local_') || !Array.isArray(saved.property_hashes)
            || saved.property_hashes.length !== route.property_hashes.length
            || new Set(saved.property_hashes).size !== expectedHomes.size
            || saved.property_hashes.some(hash => !expectedHomes.has(hash))) throw new Error('The server did not confirm every saved home.');
        return saved;
    } catch (error) {
        const message = error?.response?.data?.message || error?.response?.data?.error || error?.message || 'Save unavailable.';
        throw new Error(`The route was generated but could not be saved to your account: ${message}`, { cause: error });
    }
}
export async function retryPendingRouteSaves(client, actorId, options = {}) {
    // Never send a previous account's cached drafts under a new session.
    if ((await client.auth.me())?.id !== actorId) return [];
    const entries = pendingRouteSaves(actorId, storeFor(options));
    const results = [];
    for (const entry of entries) {
        try { results.push({ status: 'fulfilled', value: await createManagedRoute(client, entry.route, { ...options, actorId, requestId: entry.id }) }); }
        catch (error) { results.push({ status: 'rejected', error }); }
    }
    return results;
}
export async function createManagedRoutes(client, routes) {
    // Keep partial successes discoverable by the caller's existing operation
    // reconciliation. Idempotency makes retrying the whole batch safe.
    const saved = [];
    for (const route of routes) saved.push(await createManagedRoute(client, route));
    return saved;
}
