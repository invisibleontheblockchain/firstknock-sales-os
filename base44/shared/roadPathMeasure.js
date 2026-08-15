// Level 3: what the rep actually drives.
//
// The hierarchy approximates in order to search 1,000 doors affordably. The
// number we then SHOW a manager must not be an approximation, and the line drawn
// on the map must not be a straight-line cartoon of a road route. Both come from
// here: the final order is walked through OSRM's /route service, which returns
// real per-leg driving distance and the real driven geometry.
//
// This is a measurement, never a decision. It runs once on a fixed order, so its
// cost is linear in doors (~1 request per 49 legs) rather than quadratic.

import { fetchOsrmJson } from './osrmDispatcher.js';
import { summarizeLegMiles } from './roadLegDistribution.js';
import { DEFAULT_OSRM_BASE_URL } from './roadMatrix.js';

const METERS_TO_MILES = 0.000621371;
// Coordinates per /route request. Chunks overlap by one point so the leg that
// spans a chunk boundary is measured exactly once, by the following chunk.
const ROUTE_CHUNK_POINTS = 50;
// Geometry is persisted and rendered; ManagerMapLayers refuses anything longer
// than 12,000 points, so the path is thinned rather than silently rejected.
const MAX_GEOMETRY_POINTS = 12000;

const coordinateParam = (point) => `${Number(point.lng).toFixed(6)},${Number(point.lat).toFixed(6)}`;

function thinGeometry(points) {
    if (points.length <= MAX_GEOMETRY_POINTS) return points;
    const stride = Math.ceil(points.length / MAX_GEOMETRY_POINTS);
    const thinned = points.filter((_, index) => index % stride === 0);
    const last = points[points.length - 1];
    const tail = thinned[thinned.length - 1];
    if (tail.lat !== last.lat || tail.lng !== last.lng) thinned.push(last);
    return thinned;
}

/**
 * Measure an ordered stop list on the real road network.
 *
 * @returns {object} `{ ok: true, totalMiles, legMiles, longestLegMiles,
 *   longestLegIndex, legDistribution, geometry, requestCount }`, or
 *   `{ ok: false, error }` when
 *   the measurement could not be completed — the caller then reports the route
 *   as unmeasured rather than quoting a mixed-source total.
 */
export async function measureRoadPath(order, options = {}) {
    const {
        baseUrl = DEFAULT_OSRM_BASE_URL,
        profile = 'driving',
        timeoutMs = 20000
    } = options;

    if (!Array.isArray(order) || order.length < 2) {
        return { ok: false, error: 'A road path needs at least two stops.' };
    }

    const legMiles = [];
    const geometry = [];
    let requestCount = 0;

    try {
        for (let start = 0; start < order.length - 1; start += ROUTE_CHUNK_POINTS - 1) {
            const chunk = order.slice(start, start + ROUTE_CHUNK_POINTS);
            if (chunk.length < 2) break;
            const url = `${String(baseUrl).replace(/\/+$/, '')}/route/v1/${profile}/`
                + `${chunk.map(coordinateParam).join(';')}`
                + '?overview=full&geometries=geojson&steps=false&annotations=false';
            const payload = await fetchOsrmJson(url, { timeoutMs });
            requestCount += 1;

            const route = payload?.routes?.[0];
            const legs = Array.isArray(route?.legs) ? route.legs : null;
            if (!legs || legs.length !== chunk.length - 1) {
                return {
                    ok: false,
                    error: `OSRM returned ${legs?.length ?? 0} legs for ${chunk.length - 1} requested.`
                };
            }
            legs.forEach((leg) => {
                const meters = Number(leg?.distance);
                legMiles.push(Number.isFinite(meters) ? meters * METERS_TO_MILES : NaN);
            });

            const coordinates = route?.geometry?.coordinates;
            if (Array.isArray(coordinates)) {
                coordinates.forEach(([lng, lat], index) => {
                    // The chunks overlap by one stop, so the first vertex of every
                    // chunk after the first repeats the previous chunk's last one.
                    if (start > 0 && index === 0) return;
                    geometry.push({ lat, lng });
                });
            }
        }
    } catch (error) {
        return { ok: false, error: error.message };
    }

    if (legMiles.length !== order.length - 1) {
        return {
            ok: false,
            error: `Measured ${legMiles.length} legs for a ${order.length}-stop route.`
        };
    }
    if (legMiles.some((miles) => !Number.isFinite(miles))) {
        return { ok: false, error: 'The road path contains an unmeasurable leg.' };
    }

    let longestLegIndex = 0;
    legMiles.forEach((miles, index) => {
        if (miles > legMiles[longestLegIndex]) longestLegIndex = index;
    });

    return {
        ok: true,
        totalMiles: legMiles.reduce((total, miles) => total + miles, 0),
        legMiles,
        longestLegMiles: legMiles[longestLegIndex],
        // 0-based leg index: leg i is the drive from stop i+1 to stop i+2.
        longestLegIndex,
        // Percentiles and threshold counts over these same measured legs, so
        // continuity is never judged from the maximum alone.
        legDistribution: summarizeLegMiles(legMiles),
        geometry: thinGeometry(geometry),
        requestCount
    };
}