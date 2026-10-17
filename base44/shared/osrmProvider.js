// The one place a backend function learns which road engine it may use.
//
// FirstKnock's engine is a private OSRM gateway (OSRM_BASE_URL) that requires a
// bearer key (OSRM_GATEWAY_KEY). There is deliberately no public-demo fallback:
// with the secret unset, `baseUrl` is empty and every caller takes its
// continuity fallback, so a missing engine can never block route creation.

import { configureOsrmDispatcher } from './osrmDispatcher.js';
import { vehicleProviderConfig } from './vehicleProviderConfig.js';

// Boxes are [minLat, minLng, maxLat, maxLng]. The gateway's US car graph covers
// the contiguous states, Alaska and Hawaii; Puerto Rico and the other
// territories are outside it, and a point there must not be sent at all.
export const OSRM_DEFAULT_COVERAGE = Object.freeze([
    Object.freeze([24.3, -125.0, 49.5, -66.8]),
    Object.freeze([51.0, -180.0, 71.6, -129.9]),
    Object.freeze([18.8, -160.4, 22.4, -154.7])
]);

/**
 * Parse OSRM_COVERAGE_BOUNDS: boxes separated by `;`, each
 * `minLat,minLng,maxLat,maxLng`. Invalid or empty input yields the default.
 */
export function parseRoadCoverage(text) {
    const boxes = String(text || '').split(';').map(part => part.trim()).filter(Boolean).map(part => part.split(',').map(Number));
    const valid = boxes.length > 0 && boxes.every(box => box.length === 4 && box.every(Number.isFinite)
        && box[0] < box[2] && box[1] < box[3] && Math.abs(box[0]) <= 90 && Math.abs(box[2]) <= 90
        && Math.abs(box[1]) <= 180 && Math.abs(box[3]) <= 180);
    return valid ? Object.freeze(boxes.map(box => Object.freeze(box))) : OSRM_DEFAULT_COVERAGE;
}

/** Accepts one box or a list of boxes. */
export function insideRoadCoverage(point, coverage = OSRM_DEFAULT_COVERAGE) {
    const lat = Number(point?.lat), lng = Number(point?.lng);
    if (point?.lat == null || point?.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    const boxes = Array.isArray(coverage?.[0]) ? coverage : [coverage];
    return boxes.some(box => lat >= box[0] && lat <= box[2] && lng >= box[1] && lng <= box[3]);
}

/**
 * Read the engine secrets and configure the process-wide dispatcher with them.
 *
 * Returns `{ baseUrl, gatewayKey, configured, coverage }`. `baseUrl` is '' when
 * OSRM_BASE_URL is unset or is not an HTTPS private origin; callers must then
 * take their non-road fallback instead of choosing a default engine.
 */
export function readOsrmProvider(readSecret) {
    const read = name => {
        try { return String(readSecret(name) || '').trim(); } catch { return ''; }
    };
    let baseUrl = '';
    const raw = read('OSRM_BASE_URL');
    if (raw) {
        try { baseUrl = vehicleProviderConfig({ baseUrl: raw, production: true }).baseUrl; }
        catch { baseUrl = ''; }
    }
    const gatewayKey = read('OSRM_GATEWAY_KEY');
    const maxConcurrent = read('OSRM_MAX_CONCURRENCY');
    const spacingMs = read('OSRM_DISPATCH_SPACING_MS');
    configureOsrmDispatcher({
        baseUrl,
        gatewayKey,
        ...(maxConcurrent ? { maxConcurrent } : {}),
        ...(spacingMs ? { spacingMs } : {})
    });
    return Object.freeze({
        baseUrl,
        gatewayKey,
        configured: Boolean(baseUrl),
        coverage: parseRoadCoverage(read('OSRM_COVERAGE_BOUNDS'))
    });
}
