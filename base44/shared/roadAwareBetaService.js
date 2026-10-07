import { tenantManagerId, isRepAccount, toEntityArray } from './accountTenancy.js';
import { roadBetaEligibleOwner, assertRoadBetaProxyRequest, CHARLOTTE_BETA_COVERAGE } from './roadAwareBetaPolicy.js';
import { vehicleProviderConfig } from './vehicleProviderConfig.js';
import { routePropertyOrderFingerprint } from './routeFingerprint.js';

export class RoadBetaError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
const sameOrder = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const routeFields = ['property_hashes', 'metrics', 'metadata', 'start_location', 'end_location', 'route_origin_mode'];
const snapshot = route => ({ ...Object.fromEntries(routeFields.map(key => [key, route[key] ?? null])),
    route_origin_mode: route.route_origin_mode || 'none', metrics: route.metrics || {}, metadata: route.metadata || {} });
const updateFields = value => Object.fromEntries(routeFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
function membership(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length > 10000
        || a.some(id => typeof id !== 'string' || !id) || new Set(a).size !== a.length
        || new Set(b).size !== b.length || !sameOrder([...a].sort(), [...b].sort())) throw new RoadBetaError(409, 'Route membership changed.');
}
export function validateBetaComparison(c, fingerprint, dataVersion) {
    membership(c?.beforeOrder, c?.afterOrder);
    if (c.graphFingerprint !== fingerprint || c.dataVersion !== dataVersion || c.acceptedRegressions !== 0
        || c.membershipCount !== c.beforeOrder.length) throw new RoadBetaError(409, 'Comparison identity or guard is invalid.');
    if (c.beforeFingerprint !== routePropertyOrderFingerprint(c.beforeOrder)
        || c.afterFingerprint !== routePropertyOrderFingerprint(c.afterOrder)) throw new RoadBetaError(409, 'Comparison fingerprint is invalid.');
    for (const cost of [c.before, c.after].filter(Boolean)) {
        if (!Number.isFinite(cost.miles) || !Number.isFinite(cost.seconds) || cost.miles < 0 || cost.seconds < 0) throw new RoadBetaError(409, 'Comparison costs are invalid.');
    }
    const changed = !sameOrder(c.beforeOrder, c.afterOrder);
    if (changed && (!['road_aware', 'road_aware_sections'].includes(c.guard)
        || !Number.isFinite(c.before?.miles) || !Number.isFinite(c.after?.miles)
        || !Number.isFinite(c.before?.seconds) || !Number.isFinite(c.after?.seconds)
        || c.after.seconds >= c.before.seconds || c.after.miles > c.before.miles)) throw new RoadBetaError(409, 'Comparison violates the time/mileage guard.');
    for (const id of c.unresolvedIds || []) if (!c.beforeOrder.includes(id) || c.beforeOrder.indexOf(id) !== c.afterOrder.indexOf(id)) throw new RoadBetaError(409, 'Unresolved access moved.');
}

export async function fetchRoadBetaProxy({ provider, service, coordinates, query, dataVersion, fingerprint, token, fetchImpl = fetch }) {
    assertRoadBetaProxyRequest(service, coordinates, query);
    const url = new URL(`${provider.baseUrl}/${service}/v1/car/${coordinates}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error',
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
        if (!response.ok) return Response.json({ code: 'ProviderUnavailable' }, { status: response.status >= 500 ? 503 : 422 });
        if (Number(response.headers.get('content-length')) > 8000000) throw new RoadBetaError(502, 'Road response exceeds its size limit.');
        const reader = response.body.getReader(), chunks = []; let bytes = 0;
        for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            bytes += value.byteLength; if (bytes > 8000000) { await reader.cancel(); throw new RoadBetaError(502, 'Road response exceeds its size limit.'); }
            chunks.push(value);
        }
        const buffer = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
        const data = JSON.parse(new TextDecoder().decode(buffer));
        if (data.data_version !== dataVersion || data.build_fingerprint !== fingerprint) throw new RoadBetaError(409, 'Routing graph identity changed.');
        return Response.json(data);
    } finally { clearTimeout(timer); }
}

/** All settings/history access is server-only; the authenticated SDK supplies
 * identity. No caller-supplied workspace, provider origin or enable flag is used.
 * The route's normal RLS remains authoritative for apply/restore. */
export function createRoadAwareBetaHandler({ createClient, readSecret, fetchImpl = fetch }) {
    return async req => {
        try {
            const client = createClient(req), user = await client.auth.me();
            if (!user) throw new RoadBetaError(401, 'Unauthorized');
            const workspace = tenantManagerId(user), service = client.asServiceRole;
            if (!workspace) throw new RoadBetaError(403, 'Workspace unavailable.');
            if (isRepAccount(user)) {
                const members = toEntityArray(await service.entities.TeamMember.filter({ manager_id: workspace, user_id: user.id }, '-created_date', 100));
                if (!members.some(member => member.manager_id === workspace && member.user_id === user.id && member.status === 'active')) throw new RoadBetaError(403, 'Active workspace membership required.');
            }
            const owner = user.id === workspace ? user : await service.entities.User.get(workspace);
            const eligible = roadBetaEligibleOwner(owner, workspace, readSecret('ROAD_AWARE_ROUTING_BETA_WORKSPACE_IDS'));
            const body = await req.json().catch(() => ({}));
            const settings = eligible ? toEntityArray(await service.entities.RoadAwareRoutingBetaSettings.filter({ manager_id: workspace }, '-updated_date', 10)) : [];
            const setting = settings.find(row => row.manager_id === workspace);
            const killed = readSecret('ROAD_AWARE_ROUTING_BETA_DISABLED') === 'true';
            const enabled = eligible && !killed && setting?.enabled === true;
            const fingerprint = readSecret('ROAD_AWARE_OSRM_BUILD_FINGERPRINT'), dataVersion = readSecret('ROAD_AWARE_OSRM_DATA_VERSION');
            let provider = null;
            try { provider = vehicleProviderConfig({ baseUrl: readSecret('ROAD_AWARE_OSRM_BASE_URL'), profile: 'car', production: true }); } catch { /* Explicit availability. */ }
            const available = Boolean(provider && /^[a-f0-9]{64}$/.test(fingerprint) && dataVersion && readSecret('ROAD_AWARE_OSRM_GATEWAY_TOKEN'));
            const config = { eligible, enabled, available, workspaceId: workspace, fingerprint: available ? fingerprint : null,
                dataVersion: available ? dataVersion : null, coverage: CHARLOTTE_BETA_COVERAGE,
                canToggle: eligible && user.id === workspace, reason: killed ? 'BETA_DISABLED' : !available ? 'PROVIDER_NOT_CONFIGURED' : null };
            if (body.action === 'status') return Response.json(config);
            if (body.action === 'set_enabled') {
                if (!config.canToggle || typeof body.enabled !== 'boolean') throw new RoadBetaError(403, 'Only the beta workspace owner can change this flag.');
                if (body.enabled && (killed || !available)) throw new RoadBetaError(409, 'Configure the regional driving provider before enabling the beta.');
                if (setting) await service.entities.RoadAwareRoutingBetaSettings.update(setting.id, { enabled: body.enabled });
                else await service.entities.RoadAwareRoutingBetaSettings.create({ manager_id: workspace, enabled: body.enabled });
                return Response.json({ ...config, enabled: body.enabled && !killed });
            }
            if (!eligible) throw new RoadBetaError(403, 'This workspace is outside the routing beta.');
            if (body.action === 'proxy') {
                if (!enabled || !available) throw new RoadBetaError(409, 'Regional routing beta is unavailable.');
                return await fetchRoadBetaProxy({ provider, service: body.service, coordinates: body.coordinates,
                    query: body.query, dataVersion, fingerprint, token: readSecret('ROAD_AWARE_OSRM_GATEWAY_TOKEN'), fetchImpl });
            }
            if (body.action === 'history') {
                const rows = toEntityArray(await service.entities.RoadAwareRoutingComparison.filter({ manager_id: workspace }, '-created_date', 100));
                return Response.json({ comparisons: rows.filter(row => row.manager_id === workspace && (user.id === workspace || row.actor_user_id === user.id))
                    .map(row => ({ ...row, original_route: undefined })) });
            }
            const accessibleRoute = async id => {
                const route = await client.entities.SavedRoute.get(id);
                if (!route || (route.manager_id && route.manager_id !== workspace)
                    || (!route.manager_id && route.created_by !== owner.email)) throw new RoadBetaError(403, 'Route is outside this workspace.');
                return route;
            };
            if (body.action === 'bind_generated') {
                const row = await service.entities.RoadAwareRoutingComparison.get(body.comparison_id);
                if (!row || row.manager_id !== workspace || (user.id !== workspace && row.actor_user_id !== user.id)
                    || row.decision !== 'generated') throw new RoadBetaError(403, 'Generation comparison is outside this workspace.');
                const route = await accessibleRoute(body.route_id);
                if (route.metadata?.road_aware_comparison_id !== row.id || !sameOrder(route.property_hashes, row.comparison.afterOrder)
                    || (row.route_id && row.route_id !== route.id)) throw new RoadBetaError(409, 'Saved generation does not match this comparison.');
                await service.entities.RoadAwareRoutingComparison.update(row.id, { route_id: route.id });
                return Response.json({ linked: true });
            }
            if (body.action === 'record') {
                if (!enabled) throw new RoadBetaError(409, 'Beta was disabled; comparison was not recorded.');
                const c = body.comparison;
                validateBetaComparison(c, fingerprint, dataVersion);
                const route = body.route_id ? await accessibleRoute(body.route_id) : null;
                if (route && !sameOrder(route.property_hashes, c.beforeOrder)) throw new RoadBetaError(409, 'Route changed while comparison was running.');
                const row = await service.entities.RoadAwareRoutingComparison.create({ manager_id: workspace, actor_user_id: user.id,
                    route_id: route?.id || null, entry_point: String(body.entry_point || 'optimize').slice(0, 100),
                    comparison: c, original_route: route ? snapshot(route) : null, source_updated_date: route?.updated_date || null,
                    decision: route ? 'pending' : 'generated' });
                return Response.json({ id: row.id });
            }
            if (['apply', 'keep', 'restore'].includes(body.action)) {
                const row = await service.entities.RoadAwareRoutingComparison.get(body.comparison_id);
                if (!row || row.manager_id !== workspace || (user.id !== workspace && row.actor_user_id !== user.id)) throw new RoadBetaError(403, 'Comparison is outside this workspace.');
                if (body.action === 'keep') {
                    if (row.decision !== 'pending') throw new RoadBetaError(409, 'Comparison already resolved.');
                    await service.entities.RoadAwareRoutingComparison.update(row.id, { decision: 'kept_current' });
                    return Response.json({ kept: true });
                }
                const route = await accessibleRoute(row.route_id);
                if (body.action === 'restore') {
                    if (row.decision !== 'used_new' || !sameOrder(route.property_hashes, row.comparison.afterOrder)
                        || (row.applied_updated_date && route.updated_date !== row.applied_updated_date)) throw new RoadBetaError(409, 'Route changed since this comparison; restore would overwrite newer work.');
                    const restored = await client.entities.SavedRoute.update(route.id, row.original_route);
                    try { await service.entities.RoadAwareRoutingComparison.update(row.id, { decision: 'restored' }); }
                    catch { return Response.json({ route: restored, history_warning: 'Previous order restored, but the history decision could not be updated.' }); }
                    return Response.json({ route: restored });
                }
                if (!enabled || !available || row.decision !== 'pending') throw new RoadBetaError(409, 'This comparison can no longer be applied.');
                if (!sameOrder(route.property_hashes, row.comparison.beforeOrder)
                    || (row.source_updated_date && route.updated_date !== row.source_updated_date)) throw new RoadBetaError(409, 'Route changed while comparison was open.');
                const update = body.route_update;
                membership(route.property_hashes, update?.property_hashes);
                if (!sameOrder(update.property_hashes, row.comparison.afterOrder)) throw new RoadBetaError(409, 'Apply order differs from the guarded comparison.');
                validateBetaComparison(row.comparison, fingerprint, dataVersion);
                if (update.metadata?.routing?.property_order_fingerprint !== row.comparison.afterFingerprint) throw new RoadBetaError(409, 'Geometry/order provenance does not match the comparison.');
                const personal = ['home_round_trip', 'current_to_home', 'car_round_trip', 'private_anchor_round_trip', 'anchor_round_trip'].includes(update.route_origin_mode);
                const segments = update.metadata?.road_geometry_segments || (update.metadata?.road_geometry ? [{ points: update.metadata.road_geometry }] : []);
                if (!personal && routePropertyOrderFingerprint(segments.map(s => JSON.stringify(s.points))) !== row.comparison.geometryFingerprint) throw new RoadBetaError(409, 'Applied geometry differs from the comparison.');
                if (personal
                    && (update.metadata?.road_geometry || update.metadata?.road_geometry_segments?.length)) throw new RoadBetaError(409, 'Personal anchor geometry must stay in session memory.');
                const applied = await client.entities.SavedRoute.update(route.id, updateFields(update));
                try { await service.entities.RoadAwareRoutingComparison.update(row.id, { decision: 'used_new', applied_updated_date: applied.updated_date || null }); }
                catch { return Response.json({ route: applied, history_warning: 'New order saved, but the history decision could not be updated. Keep the saved comparison for recovery.' }); }
                return Response.json({ route: applied });
            }
            throw new RoadBetaError(400, 'Unknown routing beta action.');
        } catch (error) {
            const status = error instanceof RoadBetaError ? error.status : /OUTSIDE_GRAPH_COVERAGE/.test(error.message) ? 422 : 503;
            return Response.json({ error: error instanceof RoadBetaError ? error.message : 'Routing beta unavailable; the saved route was left unchanged.' }, { status });
        }
    };
}
