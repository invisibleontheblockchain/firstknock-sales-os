import { base44 } from '@/api/base44Client';
import { compareRoadAwareBeta } from '../../base44/shared/roadAwareBetaOptimizer.js';
import { routePropertyOrderFingerprint } from '../../base44/shared/routeFingerprint.js';
import { ROAD_VERIFICATION, stampRoadVerification, summarizeRoadVerification } from './routeRoadVerification';
import { reviewNeighborhoodExcursions } from '../../base44/shared/neighborhoodExcursions.js';
import { tryRoadMatrixOptimize } from './roadMatrixOptimize';

const invoke = async (body, client = base44) => (await client.functions.invoke('roadAwareRoutingBeta', body)).data;
const lastStatus = new WeakMap();
export async function getRoadAwareBetaStatus(client = base44) {
    const actor = await client.auth.me(), previous = lastStatus.get(client);
    try {
        const status = await invoke({ action: 'status' }, client);
        lastStatus.set(client, { actorId: actor.id, status });
        return status;
    } catch (error) {
        if (previous?.actorId === actor.id && previous.status.enabled) error.betaKnownEnabled = true;
        throw error;
    }
}
export async function setRoadAwareBetaEnabled(enabled, client = base44) {
    const status = await invoke({ action: 'set_enabled', enabled }, client);
    lastStatus.set(client, { actorId: status.workspaceId, status });
    return status;
}
export const getRoadAwareBetaHistory = (client = base44) => invoke({ action: 'history' }, client);
export const restoreRoadAwareBetaComparison = (comparisonId, client = base44) => invoke({ action: 'restore', comparison_id: comparisonId }, client);
export async function bindBetaGeneratedRoutes(response, client = base44) {
    const routes = Array.isArray(response) ? response : response?.items || response?.data || (response?.id ? [response] : []);
    await Promise.all(routes.map(async route => {
        if (!route.metadata?.road_aware_comparison_id || !route.id || String(route.id).startsWith('local_')) return;
        try { await invoke({ action: 'bind_generated', comparison_id: route.metadata.road_aware_comparison_id, route_id: route.id }, client); }
        catch { console.warn('Route saved; generation history could not be linked to its route ID.'); }
    }));
    return response;
}

/** Null means OFF and preserves the existing production path. A beta failure
 * returns the supplied order, never another unguarded optimizer proposal. */
export async function prepareRoadAwareBetaComparison(properties, { bounds = {}, routeId = null,
    entryPoint = 'optimize', client = base44, status, enabledHint = false, signal, propose, partitionRun, continuityFor } = {}) {
    let config = status;
    if (!config) try { config = await getRoadAwareBetaStatus(client); }
    catch (error) {
        if (error.betaKnownEnabled || enabledHint) throw new Error('Routing beta is unavailable. The saved route was left unchanged.');
        return null; /* Resource may not be deployed; default OFF remains unchanged. */
    }
    if (!config.enabled) return null;
    const proxyFetch = async (input, options = {}) => {
        if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled', 'AbortError');
        const url = new URL(input), match = url.pathname.match(/^\/(route|table|nearest)\/v1\/car\/(.+)$/);
        if (url.origin !== 'https://firstknock-routing.invalid' || !match) throw new Error('Invalid routing proxy request.');
        try {
            const data = await invoke({ action: 'proxy', service: match[1], coordinates: decodeURIComponent(match[2]),
                query: Object.fromEntries(url.searchParams) }, client);
            if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled', 'AbortError');
            return { ok: true, status: 200, json: async () => data };
        } catch (error) {
            if (error.name === 'AbortError' || options.signal?.aborted) throw error;
            return { ok: false, status: error.response?.status || error.status || 503, json: async () => ({ code: 'ProviderUnavailable' }) };
        }
    };
    const optimizer = propose && partitionRun && continuityFor ? null : await import('@/components/logic/routeOptimizer.jsx');
    const continuity = continuityFor || (await import('@/components/logic/routeRoadContext.js')).createRouteContinuityContext;
    const partition = partitionRun || ((stops, limit) => optimizer.splitOrderedPropertiesByRoutingBoundaries(stops, limit, continuity(stops)));
    const proposal = propose || ((stops, context, anchors) => optimizer.optimizeRouteByStreetSweep(stops, anchors.startLocation, anchors.endLocation, context));
    const cacheKey = `fk-road-beta:${config.workspaceId}:${config.fingerprint}:${routeId || routePropertyOrderFingerprint(properties)}`;
    let resume = null;
    try { if (typeof localStorage !== 'undefined') resume = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch { /* Optional checkpoint. */ }
    const result = await compareRoadAwareBeta(properties, { bounds, propose: proposal, partitionRun: partition, continuityFor: continuity,
        provider: { available: config.available, fingerprint: config.fingerprint, dataVersion: config.dataVersion,
            baseUrl: 'https://firstknock-routing.invalid', fetch: proxyFetch }, signal, resume,
        onCheckpoint(state) { try { if (typeof localStorage !== 'undefined') localStorage.setItem(cacheKey, JSON.stringify(state)); } catch { /* Quota keeps the old checkpoint. */ } } });
    // History must persist before presenting an adoptable comparison. If that
    // write fails, no saved route is changed and generation retains its baseline.
    try {
        const record = await invoke({ action: 'record', route_id: routeId, entry_point: entryPoint, comparison: result.comparison }, client);
        result.comparisonId = record.id;
    } catch (error) {
        if (routeId) throw new Error(error.response?.data?.error || 'Comparison history could not be saved. The route was left unchanged.');
        return { properties, comparison: { ...result.comparison, afterOrder: result.comparison.beforeOrder,
            afterFingerprint: result.comparison.beforeFingerprint, after: result.comparison.before,
            changedStops: 0, milesSaved: 0, secondsSaved: 0, improvedWindows: 0,
            guard: 'legacy_fallback', reason: 'TELEMETRY_UNAVAILABLE' }, distanceMiles: null, metadata: null, geometry: { current: [], selected: [] } };
    }
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(cacheKey); } catch { /* Optional checkpoint. */ }
    return result;
}

export async function applyRoadAwareBetaComparison(result, routeUpdate, client = base44) {
    return invoke({ action: 'apply', comparison_id: result.comparisonId, route_update: routeUpdate }, client);
}
export const keepRoadAwareBetaCurrent = (result, client = base44) => invoke({ action: 'keep', comparison_id: result.comparisonId }, client);

export async function applyRoadAwareBetaToGeneratedRoutes(routes, { entryPoint = 'generation', client = base44, status, onProgress } = {}) {
    let config = status;
    if (!config) try { config = await getRoadAwareBetaStatus(client); } catch (error) {
        if (!error.betaKnownEnabled) return null;
        return { routes, appliedCount: 0, savedMiles: 0, skippedForBudget: 0, unverifiedCount: routes.length,
            verification: summarizeRoadVerification(routes), unverifiedMessage: 'Routing beta is unavailable; generated orders were preserved.' };
    }
    if (!config.enabled) return null;
    const out = []; let appliedCount = 0, savedMiles = 0;
    for (const [index, route] of routes.entries()) {
        if (route.metadata?.routing?.road_aware_routing_beta
            && route.metadata.routing.property_order_fingerprint === routePropertyOrderFingerprint(route.properties)) {
            out.push(route); continue;
        }
        onProgress?.({ index: index + 1, total: routes.length });
        const result = await prepareRoadAwareBetaComparison(route.properties, { client, status: config, entryPoint,
            bounds: { startLocation: route.startLocation, endLocation: route.returnToFirstStop ? route.properties[0] : route.endLocation } });
        if (!result?.metadata) { out.push(route); continue; }
        const accepted = result.comparison.changedStops > 0;
        if (accepted) { appliedCount++; savedMiles += result.comparison.milesSaved || 0; }
        const metadata = { ...route.metadata, ...result.metadata, road_aware_comparison_id: result.comparisonId,
            road_aware_legacy_order: result.comparison.beforeOrder };
        if (['home_round_trip', 'current_to_home', 'car_round_trip', 'private_anchor_round_trip', 'anchor_round_trip'].includes(route.routeOriginMode || route.route_origin_mode)) {
            delete metadata.road_geometry; delete metadata.road_geometry_segments;
        }
        out.push(stampRoadVerification({ ...route, properties: result.properties,
            totalDistance: result.comparison.fullMeasurement ? Math.round(result.distanceMiles * 100) / 100 : route.totalDistance,
            metadata }, result.comparison.fullMeasurement ? accepted ? ROAD_VERIFICATION.ADOPTED : ROAD_VERIFICATION.CONFIRMED : ROAD_VERIFICATION.PASS_FAILED,
            { reason: result.comparison.reason, measuredMiles: result.comparison.fullMeasurement ? result.distanceMiles : null }));
    }
    return { routes: out, appliedCount, savedMiles, skippedForBudget: 0,
        unverifiedCount: out.filter(route => route.metadata?.routing?.fallback).length,
        verification: summarizeRoadVerification(out), unverifiedMessage: out.some(route => route.metadata?.routing?.fallback)
            ? 'Some routes kept their existing order because road evidence was unavailable.' : null };
}

export async function completeBetaGeneratedRoutes(routes, options = {}) {
    const beta = await applyRoadAwareBetaToGeneratedRoutes(routes, options);
    if (beta) return beta.routes;
    // Merge, split, ZIP, campaign and import flows use this shared completion
    // tail too. Outside the beta, a flagged excursion still reaches the same
    // real-road optimizer used by Home and Optimize before any route is saved.
    const out = [], started = Date.now();
    let changed = false;
    for (const route of routes) {
        const initial = reviewNeighborhoodExcursions(route.properties);
        if (!initial.diagnostics.detected) { out.push(route); continue; }
        let measured = null;
        const road = Date.now() - started < 20 * 60 * 1000 ? await tryRoadMatrixOptimize(route.properties, {
            client: options.client || base44, start: route.startLocation,
            end: route.returnToFirstStop ? route.properties[0] : route.endLocation,
            onOutcome: (reason, measurement) => { if (reason === 'current_order_measured_best') measured = measurement; },
        }) : null;
        out.push({ ...route, properties: road?.order || route.properties,
            totalDistance: road?.objective.appliedDistance ?? measured?.distanceMiles ?? route.totalDistance,
            metadata: { ...route.metadata, neighborhood_excursion_review: initial.diagnostics,
                ...(road?.routingMetadata || measured?.routingMetadata || {}) } });
        changed = true;
    }
    return changed ? out : routes;
}

/** Tail for workflows that already assembled SavedRoute payloads. It preserves
 * their partitions, assignment, names, status and bounds. */
export async function completeBetaRouteRecords(records, properties, options = {}) {
    const byId = new Map();
    for (const p of properties) for (const value of [p.address_hash, p.legacy_hash, p.id].filter(Boolean)) byId.set(String(value), p);
    const hydrated = records.map(record => ({ ...record,
        properties: record.property_hashes.map(hash => {
            const property = byId.get(String(hash));
            return property ? { ...property, address_hash: String(hash) } : null;
        }),
        totalDistance: record.metrics?.distance, startLocation: record.start_location, endLocation: record.end_location }));
    if (hydrated.some(route => route.properties.some(p => !p))) return records;
    const completed = await completeBetaGeneratedRoutes(hydrated, options);
    if (completed === hydrated) return records;
    return completed.map((route, index) => ({ ...records[index],
        property_hashes: route.properties.map(p => p.address_hash || p.legacy_hash || p.id),
        metrics: { ...records[index].metrics, distance: route.totalDistance }, metadata: route.metadata }));
}
