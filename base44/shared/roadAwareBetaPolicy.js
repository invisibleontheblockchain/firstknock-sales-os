// Workspace-scoped beta configuration. Never accept an enable flag from a client.
import { NATIONAL_ROAD_COVERAGE, insideNationalRoadCoverage } from './nationalRoadCoverage.js';
export const CHARLOTTE_BETA_COVERAGE = NATIONAL_ROAD_COVERAGE; // Retained export for existing callers.

export function insideRoadBetaCoverage(point, bounds = CHARLOTTE_BETA_COVERAGE) {
    if (bounds === NATIONAL_ROAD_COVERAGE) return insideNationalRoadCoverage(point);
    const lat = Number(point?.lat), lng = Number(point?.lng);
    return point?.lat != null && point?.lng != null && Number.isFinite(lat) && Number.isFinite(lng)
        && lat >= bounds[0] && lat <= bounds[2] && lng >= bounds[1] && lng <= bounds[3];
}

export function roadBetaEligibleOwner(user, workspaceId, configuredIds = '') {
    const ids = configuredIds.split(',').map(id => id.trim()).filter(Boolean);
    if (ids.length) return ids.includes(workspaceId);
    // Existing internal application owner, as identified by authenticated SDK
    // identity. This is a cohort selection, not a permission or entitlement.
    return user?.id === workspaceId
        && String(user?.email || '').toLowerCase() === 'invisibleontheblockchain@gmail.com';
}

export function assertRoadBetaProxyRequest(service, coordinates, query = {}) {
    if (!['route', 'table', 'nearest'].includes(service)) throw new Error('Unsupported road service.');
    const points = String(coordinates).split(';').map(pair => {
        const [lng, lat, ...extra] = pair.split(',').map(Number);
        if (extra.length || !insideRoadBetaCoverage({ lat, lng })) throw new Error('OUTSIDE_GRAPH_COVERAGE');
        return { lat, lng };
    });
    const limit = service === 'nearest' ? 1 : service === 'table' ? 100 : 502;
    if (!points.length || points.length > limit || (service !== 'nearest' && points.length < 2)) throw new Error('Road request exceeds its bounded limit.');
    const allowed = new Set(['approaches', 'bearings', 'radiuses', 'continue_straight', 'steps', 'overview',
        'geometries', 'annotations', 'sources', 'destinations', 'number']);
    for (const [key, value] of Object.entries(query)) {
        if (!allowed.has(key) || typeof value !== 'string' || value.length > 15000) throw new Error('Invalid road request option.');
    }
    if (query.radiuses?.split(';').some(radius => radius !== '100')
        || query.radiuses?.split(';').length !== points.length) throw new Error('Road matching must remain 100 m.');
    if (query.approaches && (query.approaches.split(';').length !== points.length
        || query.approaches.split(';').some(value => value !== 'unrestricted'))) throw new Error('Curb inference is outside this beta.');
    if (query.bearings && query.bearings.replaceAll(';', '') !== '') throw new Error('Do not guess approach bearings.');
    if (service === 'route' && query.continue_straight !== 'true') throw new Error('Reversal policy must be preserved.');
    for (const field of ['sources', 'destinations']) if (query[field]) {
        if (query[field].split(';').some(value => !/^\d+$/.test(value) || Number(value) >= points.length)) throw new Error('Invalid table indices.');
    }
    const values = { steps: ['true', 'false'], overview: ['full', 'simplified', 'false'],
        geometries: ['geojson'], annotations: ['distance', 'duration', 'distance,duration', 'duration,distance', 'false'],
        number: ['1'], continue_straight: ['true'] };
    for (const [key, choices] of Object.entries(values)) if (query[key] && !choices.includes(query[key])) throw new Error('Invalid road request option value.');
    return points;
}
