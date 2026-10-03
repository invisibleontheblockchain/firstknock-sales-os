/**
 * Phase 4 measurement: how much of a territory sits behind a single entrance,
 * and how often does the route enter one more than once?
 *
 * This decides whether the branch rule is worth building. The pipeline fix cut
 * Route 1H from 627.6 to 394.1 measured road miles and barely moved the
 * behaviour (pocket re-entries 38 -> 18, progression 14.1% -> 18.2%). Pockets
 * are a proximity heuristic though, not topology. A pocket is "doors that are
 * near each other"; a BRANCH is "doors you can only reach through one gate", and
 * only the second one makes re-entry provably wasteful.
 *
 * Method, with no hardcoded geography:
 *   1. build a road-cost adjacency graph over the doors (spatially tiled OSRM
 *      matrices, so cost is linear in doors rather than quadratic)
 *   2. Tarjan articulation points -> every vertex whose removal disconnects
 *      the graph
 *   3. for each cut vertex, the smaller components it strands are single-entry
 *      areas: a peninsula, a gated subdivision, a cul-de-sac cluster
 *   4. walk each candidate order and count how many times it enters each area
 *
 * A branch entered once is correct by construction. A branch entered N times
 * pays its entrance cost N times, and that is the failure the rule removes.
 *
 * Usage:
 *   node scripts/route-branch-audit.mjs <doors.csv> [--solve] [--threshold 0.3]
 *     --solve      also run the production solver and audit ITS order, so the
 *                  fixed route is measured rather than assumed
 *     --threshold  road miles under which two doors are considered adjacent
 */

import fs from 'node:fs';
import { fetchRoadMatrix } from '../base44/shared/roadMatrix.js';
import { DEFAULT_OSRM_BASE_URL } from '../base44/shared/roadMatrix.js';

const CSV = process.argv[2];
const SOLVE = process.argv.includes('--solve');
const thresholdArg = process.argv.indexOf('--threshold');
const THRESHOLDS = thresholdArg > 0
    ? [Number(process.argv[thresholdArg + 1])]
    : [0.25, 0.35, 0.5];
const BASE_URL = process.env.OSRM_BASE_URL || DEFAULT_OSRM_BASE_URL;
const MIN_BRANCH_DOORS = 5;

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

const N = doors.length;
const R = 3958.7613, rad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

console.log(`doors ${N} · OSRM ${BASE_URL}`);

// ---------------------------------------------------------------------------
// 1. Road-cost adjacency, tiled.
//
// A full 1,000x1,000 matrix is 484 requests. Adjacency only needs SHORT pairs,
// and two doors more than a tile apart in the air cannot be adjacent on the
// road, so a matrix per spatial tile finds every edge that matters for a
// fraction of the cost.
// ---------------------------------------------------------------------------
const MAX_TILE_DOORS = 46;
const TILE_MILES = 1.2;

function buildTiles() {
    const cell = TILE_MILES / 69;
    const buckets = new Map();
    doors.forEach((d, i) => {
        const key = `${Math.floor(d.lat / cell)}:${Math.floor(d.lng / cell)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
    });
    // Each tile is a cell plus its 8 neighbours, so an edge crossing a cell
    // boundary is still inside some tile.
    const tiles = [];
    buckets.forEach((members, key) => {
        const [gi, gj] = key.split(':').map(Number);
        const pool = [];
        for (let di = -1; di <= 1; di += 1) {
            for (let dj = -1; dj <= 1; dj += 1) {
                const near = buckets.get(`${gi + di}:${gj + dj}`);
                if (near) pool.push(...near);
            }
        }
        const centreLat = members.reduce((t, i) => t + doors[i].lat, 0) / members.length;
        const centreLng = members.reduce((t, i) => t + doors[i].lng, 0) / members.length;
        const centre = { lat: centreLat, lng: centreLng };
        const ordered = [...new Set(pool)].sort((a, b) => hav(centre, doors[a]) - hav(centre, doors[b]));
        tiles.push(ordered.slice(0, MAX_TILE_DOORS));
    });
    return tiles;
}

async function buildRoadAdjacency(maxThreshold) {
    const tiles = buildTiles();
    const edges = new Map(); // "i,j" (i<j) -> miles
    let requests = 0;
    for (let t = 0; t < tiles.length; t += 1) {
        const tile = tiles[t];
        if (tile.length < 2) continue;
        const points = tile.map((i) => doors[i]);
        let matrix;
        try {
            matrix = await fetchRoadMatrix(points, { baseUrl: BASE_URL, profile: 'driving', timeoutMs: 25000 });
        } catch (error) {
            console.log(`  tile ${t + 1}/${tiles.length} failed: ${error.message}`);
            continue;
        }
        requests += 1;
        for (let a = 0; a < tile.length; a += 1) {
            for (let b = a + 1; b < tile.length; b += 1) {
                const forward = matrix.distances?.[a]?.[b];
                const back = matrix.distances?.[b]?.[a];
                const miles = Math.min(
                    Number.isFinite(forward) ? forward : Infinity,
                    Number.isFinite(back) ? back : Infinity
                );
                if (!Number.isFinite(miles) || miles > maxThreshold) continue;
                const key = tile[a] < tile[b] ? `${tile[a]},${tile[b]}` : `${tile[b]},${tile[a]}`;
                const existing = edges.get(key);
                if (existing === undefined || miles < existing) edges.set(key, miles);
            }
        }
        if ((t + 1) % 10 === 0) process.stdout.write(`\r  road graph: tile ${t + 1}/${tiles.length}, ${edges.size} edges  `);
    }
    process.stdout.write(`\r  road graph: ${tiles.length} tiles, ${requests} matrices, ${edges.size} candidate edges\n`);
    return edges;
}

// ---------------------------------------------------------------------------
// 2. Articulation points (Tarjan), and the components each one strands.
// ---------------------------------------------------------------------------
function articulationPoints(adj) {
    const disc = new Array(N).fill(0), low = new Array(N).fill(0);
    const visited = new Array(N).fill(false), isArt = new Array(N).fill(false);
    let timer = 0;
    const dfs = (u, parent) => {
        visited[u] = true;
        disc[u] = low[u] = ++timer;
        let children = 0;
        for (const v of adj[u]) {
            if (v === parent) continue;
            if (visited[v]) { low[u] = Math.min(low[u], disc[v]); continue; }
            children += 1;
            dfs(v, u);
            low[u] = Math.min(low[u], low[v]);
            if (parent !== -1 && low[v] >= disc[u]) isArt[u] = true;
        }
        if (parent === -1 && children > 1) isArt[u] = true;
    };
    for (let i = 0; i < N; i += 1) if (!visited[i]) dfs(i, -1);
    return isArt;
}

function componentsWithout(adj, skip) {
    const seen = new Array(N).fill(false);
    seen[skip] = true;
    const comps = [];
    for (let i = 0; i < N; i += 1) {
        if (seen[i] || adj[i].length === 0) continue;
        const stack = [i]; seen[i] = true; const comp = [];
        while (stack.length) {
            const v = stack.pop(); comp.push(v);
            for (const w of adj[v]) if (!seen[w]) { seen[w] = true; stack.push(w); }
        }
        comps.push(comp);
    }
    return comps;
}

/** Count how many separate times an order enters a set of doors. */
function entriesInto(order, memberSet) {
    let entries = 0, inside = false;
    for (const door of order) {
        const now = memberSet.has(door.stop);
        if (now && !inside) entries += 1;
        inside = now;
    }
    return entries;
}

function auditOrder(label, order, branches) {
    let violated = 0, extraEntries = 0, doorsBehindViolated = 0;
    const worst = [];
    branches.forEach((branch) => {
        const entries = entriesInto(order, branch.memberSet);
        if (entries > 1) {
            violated += 1;
            extraEntries += entries - 1;
            doorsBehindViolated += branch.size;
            worst.push({ ...branch, entries });
        }
    });
    worst.sort((a, b) => (b.entries - a.entries) || (b.size - a.size));
    return { label, violated, extraEntries, doorsBehindViolated, worst };
}

async function main() {
    const maxThreshold = Math.max(...THRESHOLDS);
    const edges = await buildRoadAdjacency(maxThreshold);

    // The fixed order, measured rather than assumed.
    let fixedOrder = null;
    if (SOLVE) {
        const { sequenceRoadHierarchy, HIERARCHY_REFINEMENT_STEP_BUDGET } =
            await import('../base44/shared/roadHierarchySequencer.js');
        const { measureRoadPath } = await import('../base44/shared/roadPathMeasure.js');
        console.log('\nrunning the production solver (merged config) for its order...');
        const canonical = [...doors].sort((a, b) => (String(a.address_hash) < String(b.address_hash) ? -1 : 1));
        const result = await sequenceRoadHierarchy(canonical, {
            baseUrl: BASE_URL, profile: 'driving', timeoutMs: 25000,
            measurePath: measureRoadPath,
            barrierRepair: true,
            refinementStepBudget: HIERARCHY_REFINEMENT_STEP_BUDGET * 8
        });
        if (result.ok) {
            fixedOrder = result.order;
            const measured = await measureRoadPath(fixedOrder, { baseUrl: BASE_URL, profile: 'driving', timeoutMs: 25000 });
            console.log(`  solver order: ${measured.ok ? measured.totalMiles.toFixed(2) : '?'} road mi`);
        } else {
            console.log(`  solver failed: ${result.code}`);
        }
    }

    for (const threshold of THRESHOLDS) {
        const adj = Array.from({ length: N }, () => []);
        edges.forEach((miles, key) => {
            if (miles > threshold) return;
            const [a, b] = key.split(',').map(Number);
            adj[a].push(b); adj[b].push(a);
        });
        const linked = adj.filter((a) => a.length > 0).length;

        const isArt = articulationPoints(adj);
        const arts = isArt.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);

        // A cut vertex strands everything except the largest remaining piece.
        const seenSets = new Set();
        const branches = [];
        arts.forEach((gate) => {
            const comps = componentsWithout(adj, gate);
            if (comps.length < 2) return;
            comps.sort((a, b) => b.length - a.length);
            comps.slice(1).forEach((comp) => {
                if (comp.length < MIN_BRANCH_DOORS) return;
                const stops = comp.map((i) => doors[i].stop).sort((a, b) => a - b);
                const signature = stops.join(',');
                if (seenSets.has(signature)) return;
                seenSets.add(signature);
                branches.push({
                    gate,
                    gateStreet: doors[gate].street_name,
                    size: comp.length,
                    memberSet: new Set(stops),
                    streets: [...new Set(comp.map((i) => doors[i].street_name))]
                });
            });
        });
        branches.sort((a, b) => b.size - a.size);
        const doorsBehind = new Set();
        branches.forEach((b) => b.memberSet.forEach((s) => doorsBehind.add(s)));

        console.log(`\n${'='.repeat(74)}`);
        console.log(`THRESHOLD ${threshold.toFixed(2)} mi — ${linked}/${N} doors linked, ${arts.length} cut vertices`);
        console.log(`single-entry areas (>= ${MIN_BRANCH_DOORS} doors): ${branches.length}`);
        console.log(`doors sitting behind a single entrance: ${doorsBehind.size} of ${N} (${(100 * doorsBehind.size / N).toFixed(0)}%)`);

        const audits = [auditOrder('shipped (627.6 mi)', doors, branches)];
        if (fixedOrder) audits.push(auditOrder('after pipeline fix (394.1 mi)', fixedOrder, branches));

        console.log(`\n  order                          branches re-entered   wasted re-entries   doors affected`);
        audits.forEach((a) => {
            console.log(`  ${a.label.padEnd(30)} ${String(a.violated).padStart(6)} / ${branches.length}`
                + `${String(a.extraEntries).padStart(16)}${String(a.doorsBehindViolated).padStart(17)}`);
        });

        const primary = audits[audits.length - 1];
        if (primary.worst.length > 0) {
            console.log(`\n  worst offenders in "${primary.label}":`);
            primary.worst.slice(0, 8).forEach((b) => {
                console.log(`    ${String(b.entries)}x into ${String(b.size).padStart(3)} doors behind ${b.gateStreet}`
                    + `  [${b.streets.slice(0, 3).join(', ')}${b.streets.length > 3 ? ', ...' : ''}]`);
            });
        }
    }
}

main().catch((error) => { console.log('ERROR:', error.stack || error.message); process.exitCode = 1; });
