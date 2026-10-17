// Level 3: what the rep actually drives.
//
// The hierarchy approximates in order to search 1,000 doors affordably. The
// number we then SHOW a manager must not be an approximation, and the line drawn
// on the map must not be a straight-line cartoon of a road route. Both come from
// here: the final order is walked through OSRM's /route service, which returns
// real per-leg driving distance and the real driven geometry.
//
// This is a measurement, never a decision. It runs once on a fixed order, so its
// cost is linear in doors (one request per 599 legs) rather than quadratic.
//
// Matching degrades PER STOP. A door is matched within 100 m first. When OSRM
// says one coordinate has no road segment that close, only that stop is widened
// to 500 m (the gateway's cap); when it is still unmatched there, it is reported
// as unmatched and the path is measured through the remaining stops. One long
// rural driveway no longer discards the whole route's measurement — before this,
// 11 of 1,000 Charlotte doors farther than 100 m from a road each silently
// failed validation and the incumbent order was kept with no reason given.

import { fetchOsrmJson } from './osrmDispatcher.js';
import { summarizeLegMiles } from './roadLegDistribution.js';
import { requireRoadEngineUrl, ROAD_MATCH_MAX_RADIUS_METERS } from './roadMatrix.js';
import { vehicleServicePoint } from './serviceAccess.js';

const METERS_TO_MILES = 0.000621371;
// Coordinates per /route request — the gateway's limit, so a route of up to 600
// stops is ONE call. Longer routes are chunked; chunks overlap by one point so
// the leg that spans a boundary is measured exactly once, by the following chunk.
export const ROUTE_CHUNK_POINTS = 600;
// The match radius every stop starts with.
export const ROUTE_MATCH_RADIUS_METERS = 100;
// Geometry is persisted and rendered; ManagerMapLayers refuses anything longer
// than 12,000 points, so the path is thinned rather than silently rejected.
const MAX_GEOMETRY_POINTS = 12000;
// Escalations per chunk before the measurement gives up: each round fixes one
// stop, so this bounds the extra requests a pathological chunk can cost.
const MAX_MATCH_ROUNDS_PER_CHUNK = 40;

const UNMATCHED = 'unmatched';
// Per-engine memo of stops that needed more than the default radius, so the
// several measurements of one optimization (current, proposed, re-measured)
// rediscover nothing. Bounded; correctness never depends on it.
const matchMemo = new Map();
const MAX_MATCH_MEMO_ENTRIES = 20000;

const stopCoordinate = (stop) => {
    const point = vehicleServicePoint(stop);
    return `${Number(point.lng).toFixed(6)},${Number(point.lat).toFixed(6)}`;
};

function rememberMatch(key, value) {
    if (matchMemo.size >= MAX_MATCH_MEMO_ENTRIES) matchMemo.clear();
    matchMemo.set(key, value);
}

/** Index of the coordinate OSRM could not snap, from its NoSegment message. */
function noSegmentCoordinate(error) {
    if (error?.code !== 'NoSegment') return null;
    const match = /coordinate (\d+)/.exec(String(error.message || ''));
    return match ? Number(match[1]) : null;
}

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
 *   longestLegIndex, legDistribution, geometry, requestCount, widenedStops,
 *   unmatchedStops, bypassedLegIndexes }`, or `{ ok: false, error, code }` when
 *   the measurement could not be completed — the caller then reports the route
 *   as unmeasured rather than quoting a mixed-source total.
 *
 *   `widenedStops` are stop indexes matched only within 500 m. `unmatchedStops`
 *   are stop indexes with no road within 500 m; the path is measured through the
 *   other stops, the bypass distance is attributed to the first leg into the
 *   unmatched run and its remaining legs are 0 and listed in
 *   `bypassedLegIndexes`. `legMiles` therefore always has one entry per leg.
 */
export async function measureRoadPath(order, options = {}) {
    const {
        baseUrl = '',
        profile = 'driving',
        timeoutMs = 20000,
        signal = null,
        fetchJson = fetchOsrmJson
    } = options;

    if (!Array.isArray(order) || order.length < 2) {
        return { ok: false, error: 'A road path needs at least two stops.', code: 'TOO_FEW_STOPS' };
    }
    let engine;
    try { engine = requireRoadEngineUrl(baseUrl); }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }

    const coordinates = order.map(stopCoordinate);
    const memoKey = (index) => `${engine}|${profile}|${coordinates[index]}`;
    // Per stop: the radius to request, or UNMATCHED.
    const radius = coordinates.map((_, index) => matchMemo.get(memoKey(index)) ?? ROUTE_MATCH_RADIUS_METERS);

    // Measured legs between CONSECUTIVE MATCHED stops, keyed by the earlier stop.
    const matchedLegMiles = new Map();
    const geometry = [];
    let requestCount = 0;

    try {
        // Chunks are cut over the original order; unmatched stops inside a chunk
        // are dropped from its request. Overlap stays on a matched stop.
        let start = 0;
        while (start < order.length - 1) {
            const end = Math.min(start + ROUTE_CHUNK_POINTS, order.length);
            let measured = null;
            for (let round = 0; round < MAX_MATCH_ROUNDS_PER_CHUNK && !measured; round += 1) {
                const members = [];
                for (let index = start; index < end; index += 1) if (radius[index] !== UNMATCHED) members.push(index);
                if (members.length < 2) { measured = { members, legs: [], coordinates: [] }; break; }
                const url = `${engine}/route/v1/${profile}/`
                    + `${members.map((index) => coordinates[index]).join(';')}`
                    + '?overview=full&geometries=geojson&steps=false&annotations=false&continue_straight=true'
                    + `&radiuses=${members.map((index) => radius[index]).join(';')}`;
                let payload;
                requestCount += 1;
                try {
                    payload = await fetchJson(url, { timeoutMs, ...(signal ? { signal } : {}) });
                } catch (error) {
                    const position = noSegmentCoordinate(error);
                    if (position == null || position >= members.length) throw error;
                    const stop = members[position];
                    radius[stop] = radius[stop] < ROAD_MATCH_MAX_RADIUS_METERS ? ROAD_MATCH_MAX_RADIUS_METERS : UNMATCHED;
                    rememberMatch(memoKey(stop), radius[stop]);
                    continue;
                }
                const route = payload?.routes?.[0];
                const legs = Array.isArray(route?.legs) ? route.legs : null;
                if (!legs || legs.length !== members.length - 1) {
                    return {
                        ok: false,
                        code: 'ROAD_PATH_SHAPE',
                        error: `OSRM returned ${legs?.length ?? 0} legs for ${members.length - 1} requested.`
                    };
                }
                measured = { members, legs, coordinates: route?.geometry?.coordinates };
            }
            if (!measured) {
                return { ok: false, code: 'ROAD_PATH_MATCH_ROUNDS', error: 'Too many stops in one stretch could not be matched to a road.' };
            }
            measured.legs.forEach((leg, position) => {
                const meters = Number(leg?.distance);
                matchedLegMiles.set(measured.members[position], Number.isFinite(meters) ? meters * METERS_TO_MILES : NaN);
            });
            if (Array.isArray(measured.coordinates)) {
                measured.coordinates.forEach(([lng, lat], index) => {
                    // Consecutive chunks share a stop, so the first vertex of a
                    // later chunk repeats the previous chunk's last one.
                    if (geometry.length && index === 0) return;
                    geometry.push({ lat, lng });
                });
            }
            if (end >= order.length) break;
            // Next chunk starts on the last MATCHED stop of this one, so the
            // spanning leg is measured once and no stop falls between chunks.
            const lastMatched = measured.members.at(-1);
            start = lastMatched != null && lastMatched > start ? lastMatched : end - 1;
        }
    } catch (error) {
        return { ok: false, error: error.message, code: error.code || error.name || 'ROAD_PATH_FAILED' };
    }

    const unmatchedStops = [];
    const widenedStops = [];
    radius.forEach((value, index) => {
        if (value === UNMATCHED) unmatchedStops.push(index);
        else if (value > ROUTE_MATCH_RADIUS_METERS) widenedStops.push(index);
    });
    if (order.length - unmatchedStops.length < 2) {
        return { ok: false, code: 'ROAD_PATH_UNMATCHED', error: 'Fewer than two stops could be matched to a road.', unmatchedStops };
    }

    // Spread matched legs back over the original legs.
    const legMiles = new Array(order.length - 1).fill(0);
    const bypassedLegIndexes = [];
    for (let index = 0; index < order.length - 1; index += 1) {
        if (radius[index] === UNMATCHED || radius[index + 1] === UNMATCHED) bypassedLegIndexes.push(index);
    }
    let previousMatched = null;
    for (let index = 0; index < order.length; index += 1) {
        if (radius[index] === UNMATCHED) continue;
        if (previousMatched != null) {
            if (!matchedLegMiles.has(previousMatched)) {
                return { ok: false, code: 'ROAD_PATH_INCOMPLETE', error: `Leg from stop ${previousMatched + 1} was not measured.` };
            }
            legMiles[previousMatched] = matchedLegMiles.get(previousMatched);
        }
        previousMatched = index;
    }
    if (legMiles.some((miles) => !Number.isFinite(miles))) {
        return { ok: false, code: 'ROAD_PATH_UNMEASURABLE_LEG', error: 'The road path contains an unmeasurable leg.' };
    }

    let longestLegIndex = 0;
    legMiles.forEach((miles, index) => {
        if (miles > legMiles[longestLegIndex]) longestLegIndex = index;
    });
    const bypassed = new Set(bypassedLegIndexes);

    return {
        ok: true,
        totalMiles: legMiles.reduce((total, miles) => total + miles, 0),
        legMiles,
        longestLegMiles: legMiles[longestLegIndex],
        // 0-based leg index: leg i is the drive from stop i+1 to stop i+2.
        longestLegIndex,
        // Percentiles and threshold counts over the legs that were actually
        // driven stop to stop, so a bypass never poses as one leg.
        legDistribution: summarizeLegMiles(legMiles.filter((_, index) => !bypassed.has(index))),
        geometry: thinGeometry(geometry),
        requestCount,
        widenedStops,
        unmatchedStops,
        bypassedLegIndexes
    };
}
