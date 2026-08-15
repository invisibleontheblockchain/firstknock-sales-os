// Barrier evidence for corpus territory selection, from OpenStreetMap via Overpass.
//
// A barrier is the only territory trait a door list cannot reveal: two doors 300 ft
// apart across a river are a 4-mile drive, and that is exactly the situation a
// decomposition either respects or pays for. So river/lake/motorway/rail presence
// is measured from the same public map data OSRM routes on, per territory bbox.
//
// NOT PRODUCTION CODE — research tooling under scripts/. Overpass is not called
// anywhere in the app, and these measurements never reach the solver.

import { haversineMiles } from './territoryGeography.js';

const OVERPASS_HOSTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
];

// Overpass asks callers to identify themselves; anonymous requests get throttled.
const USER_AGENT = 'FirstKnock-benchmark-corpus/1.0 (Precision routing research)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Metres along a way's geometry. */
function wayMeters(geometry) {
    if (!Array.isArray(geometry) || geometry.length < 2) return 0;
    let meters = 0;
    for (let i = 1; i < geometry.length; i += 1) {
        meters += haversineMiles(
            { lat: geometry[i - 1].lat, lng: geometry[i - 1].lon },
            { lat: geometry[i].lat, lng: geometry[i].lon }
        ) * 1609.344;
    }
    return meters;
}

/**
 * Fetch the barrier features inside a bbox and reduce them to metres and counts.
 *
 * Retries across mirrors because Overpass rate-limits; a territory whose barriers
 * cannot be measured is reported as unmeasured rather than silently treated as
 * barrier-free, since "no data" and "no river" must not classify the same way.
 *
 * @returns {Promise<object>} `{ ok, waterwayMeters, waterBodyCount, motorwayMeters, railwayMeters, bridgeCount }`
 */
export async function fetchBarrierFeatures(bounds, { attempts = 3 } = {}) {
    const bbox = `${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng}`;
    const query = `[out:json][timeout:90];(
        way["waterway"~"^(river|stream|canal)$"](${bbox});
        way["natural"="water"](${bbox});
        way["highway"~"^(motorway|trunk)$"](${bbox});
        way["railway"="rail"](${bbox});
        way["bridge"]["highway"](${bbox});
    );out tags geom;`;

    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const host = OVERPASS_HOSTS[attempt % OVERPASS_HOSTS.length];
        try {
            const response = await fetch(host, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
                body: `data=${encodeURIComponent(query)}`
            });
            if (!response.ok) throw new Error(`${host} -> ${response.status}`);
            const payload = await response.json();
            // The OSM base timestamp is recorded with every fixture: if a benchmark
            // improves from 354 to 351 miles six months from now, the map data may
            // have changed rather than the solver, and only this stamp can tell them
            // apart.
            return {
                ok: true,
                ...reduceFeatures(payload.elements || []),
                osmDataTimestamp: payload.osm3s?.timestamp_osm_base || null
            };
        } catch (error) {
            lastError = error;
            await sleep(2000 * (attempt + 1));
        }
    }
    return { ok: false, error: String(lastError) };
}

function reduceFeatures(elements) {
    let waterwayMeters = 0;
    let waterBodyCount = 0;
    let motorwayMeters = 0;
    let railwayMeters = 0;
    let bridgeCount = 0;

    for (const element of elements) {
        const tags = element.tags || {};
        const meters = wayMeters(element.geometry);
        if (tags.waterway) waterwayMeters += meters;
        // A lake counts once however large: what matters to a route is that the
        // doors around it cannot be visited in aerial order, not its shoreline length.
        if (tags.natural === 'water') waterBodyCount += 1;
        if (tags.highway === 'motorway' || tags.highway === 'trunk') motorwayMeters += meters;
        if (tags.railway === 'rail') railwayMeters += meters;
        if (tags.bridge && tags.highway) bridgeCount += 1;
    }

    return {
        waterwayMeters: Math.round(waterwayMeters),
        waterBodyCount,
        motorwayMeters: Math.round(motorwayMeters),
        railwayMeters: Math.round(railwayMeters),
        bridgeCount
    };
}