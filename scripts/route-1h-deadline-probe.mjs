/**
 * Does the road-aware order actually SURVIVE the trip to the saved route?
 *
 * The solver produces a good order in ~27s. The route that shipped is 200 miles
 * worse. This probe replicates the backend's cluster-tier branch end to end, at
 * production's own timeout, and times each phase against the two deadlines that
 * can discard the result:
 *
 *   ROAD_MATRIX_DEADLINE_MS = 45000   frontend, per route (roadMatrixOptimize.js)
 *   timeout_ms = 12000                per OSRM call, sent by the frontend
 *
 * It also counts how many all-or-nothing measurement requests sit between a good
 * order and a saved one: optimizeRouteRoadMatrix measures BOTH the proposed and
 * the current order, and `validated = proposedPath.ok && currentPath.ok`. One
 * failed chunk out of ~42 sets keepCurrent and ships the order the solver beat.
 */

import fs from 'node:fs';
import { sequenceRoadHierarchy } from '../base44/shared/roadHierarchySequencer.js';
import { measureRoadPath } from '../base44/shared/roadPathMeasure.js';
import { DEFAULT_OSRM_BASE_URL } from '../base44/shared/roadMatrix.js';
import { osrmCounters } from '../base44/shared/osrmDispatcher.js';

const CSV = process.argv[2];
// Production sends timeout_ms: 12000 (roadMatrixOptimize.js payload).
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 12000);
const FRONTEND_DEADLINE_MS = 45000;
const BASE_URL = process.env.OSRM_BASE_URL || DEFAULT_OSRM_BASE_URL;

function parseCsv(src) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < src.length; i += 1) {
        const c = src[i];
        if (q) { if (c === '"') { if (src[i + 1] === '"') { field += '"'; i += 1; } else q = false; } else field += c; }
        else if (c === '"') q = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

const rows = parseCsv(fs.readFileSync(CSV, 'utf8')).filter((r) => r.length > 3);
const head = rows[0], at = (n) => head.indexOf(n);
const doors = rows.slice(1).map((r) => ({
    stop: Number(r[at('Stop #')]), address_hash: r[at('Address Hash')],
    house_number: r[at('House #')], street_name: r[at('Street')],
    city: r[at('City')], zip_code: r[at('Zip')],
    lat: Number(r[at('Latitude')]), lng: Number(r[at('Longitude')])
})).filter((d) => Number.isFinite(d.lat) && d.address_hash).sort((a, b) => a.stop - b.stop);

const canonical = [...doors].sort((a, b) => (String(a.address_hash) < String(b.address_hash) ? -1 : 1));
const options = { baseUrl: BASE_URL, profile: 'driving', timeoutMs: TIMEOUT_MS };

console.log(`doors ${doors.length} · per-call timeout ${TIMEOUT_MS}ms · frontend deadline ${FRONTEND_DEADLINE_MS}ms\n`);

const t0 = Date.now();
const hierarchy = await sequenceRoadHierarchy(canonical, { ...options, measurePath: measureRoadPath });
const tSeq = Date.now() - t0;
if (!hierarchy.ok) {
    console.log(`SEQUENCING FAILED after ${(tSeq / 1000).toFixed(1)}s: ${hierarchy.code}`);
    console.log('-> backend falls through to the bounded representative matrix path');
    process.exit(0);
}
console.log(`phase 1  sequencing ............. ${(tSeq / 1000).toFixed(1)}s`);

const withAnchors = (order) => order;
const t1 = Date.now();
const [proposedPath, currentPath] = await Promise.all([
    measureRoadPath(withAnchors(hierarchy.order), options),
    measureRoadPath(withAnchors(doors), options)
]);
const tMeasure = Date.now() - t1;
console.log(`phase 2  dual measurement ....... ${(tMeasure / 1000).toFixed(1)}s`
    + `  (${(proposedPath.requestCount || 0) + (currentPath.requestCount || 0)} all-or-nothing /route requests)`);

const total = Date.now() - t0;
const validated = proposedPath.ok && currentPath.ok;
const keepCurrent = !validated || currentPath.totalMiles <= proposedPath.totalMiles;

console.log(`\nproposed measured .... ${proposedPath.ok ? `${proposedPath.totalMiles.toFixed(2)} mi` : `FAILED — ${proposedPath.error}`}`);
console.log(`current measured ..... ${currentPath.ok ? `${currentPath.totalMiles.toFixed(2)} mi` : `FAILED — ${currentPath.error}`}`);
console.log(`validated ............ ${validated}`);
console.log(`keepCurrent .......... ${keepCurrent}  -> backend returns selected: '${keepCurrent ? 'current' : 'road_aware'}'`);

const counters = osrmCounters();
console.log(`\nOSRM: ${counters.requests} requests, ${counters.retries} retries, ${counters.rateLimited} rate-limited, ${counters.transportFailures ?? 0} transport failures`);

console.log(`\nTOTAL BACKEND TIME ... ${(total / 1000).toFixed(1)}s`);
if (total > FRONTEND_DEADLINE_MS) {
    console.log(`EXCEEDS the ${FRONTEND_DEADLINE_MS / 1000}s frontend deadline by ${((total - FRONTEND_DEADLINE_MS) / 1000).toFixed(1)}s`);
    console.log('-> tryRoadMatrixOptimize resolves null and the generated (aerial) order is kept.');
} else {
    console.log(`fits inside the ${FRONTEND_DEADLINE_MS / 1000}s frontend deadline with `
        + `${((FRONTEND_DEADLINE_MS - total) / 1000).toFixed(1)}s to spare`);
}
