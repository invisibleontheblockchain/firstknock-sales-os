/**
 * Run the REAL production solver against Route 1H's doors and measure it.
 *
 * This is the harness the Route 1H diagnosis needs to become a fix: it calls the
 * same `sequenceRoadHierarchy` the backend calls, on the same door set that
 * shipped at 628.5 measured road miles, and measures the finished order with the
 * same `measureRoadPath`. Nothing is reimplemented — a change that moves the
 * number here is a change that moves the number in production.
 *
 * Usage:
 *   node scripts/route-1h-solver-bench.mjs <doors.csv> [variant ...]
 *
 * Variants (default: baseline):
 *   baseline        exactly what optimizeRouteRoadMatrix runs today
 *   budget8x        baseline with an 8x refinement step budget
 *   barrier         baseline + barrierRepair
 *   coarse          baseline + coarseBlockOrder
 *   barrier-budget  barrierRepair + 8x budget
 *   portfolio       the full decomposition portfolio, best measured candidate wins
 *
 * Results append to scripts/route-1h-bench-results.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sequenceRoadHierarchy, HIERARCHY_REFINEMENT_STEP_BUDGET } from '../base44/shared/roadHierarchySequencer.js';
import { sequenceBestDecomposition, DEFAULT_DECOMPOSITION_PORTFOLIO } from '../base44/shared/roadDecompositionPortfolio.js';
import { measureRoadPath } from '../base44/shared/roadPathMeasure.js';
import { planTieredRoadMatrix } from '../base44/shared/roadMatrixTiers.js';
import { buildStreetBlocks } from '../base44/shared/roadAwareStreetSweep.js';
import { DEFAULT_OSRM_BASE_URL } from '../base44/shared/roadMatrix.js';

const CSV = process.argv[2];
const VARIANTS = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ['baseline'];
const BASE_URL = process.env.OSRM_BASE_URL || DEFAULT_OSRM_BASE_URL;
const RESULTS = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'route-1h-bench-results.json');

function parseCsv(src) {
    const rows = []; let row = [], field = '', inQuotes = false;
    for (let i = 0; i < src.length; i += 1) {
        const c = src[i];
        if (inQuotes) {
            if (c === '"') { if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false; }
            else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
}

function loadDoors(csvPath) {
    const rows = parseCsv(fs.readFileSync(csvPath, 'utf8')).filter((r) => r.length > 3);
    const header = rows[0];
    const at = (name) => header.indexOf(name);
    return rows.slice(1).map((r) => ({
        stop: Number(r[at('Stop #')]),
        address_hash: r[at('Address Hash')],
        house_number: r[at('House #')],
        street_name: r[at('Street')],
        city: r[at('City')],
        zip_code: r[at('Zip')],
        lat: Number(r[at('Latitude')]),
        lng: Number(r[at('Longitude')])
    })).filter((d) => Number.isFinite(d.lat) && Number.isFinite(d.lng) && d.address_hash)
        .sort((a, b) => a.stop - b.stop);
}

const VARIANT_OPTIONS = {
    baseline: {},
    budget8x: { refinementStepBudget: HIERARCHY_REFINEMENT_STEP_BUDGET * 8 },
    barrier: { barrierRepair: true },
    coarse: { coarseBlockOrder: true },
    'barrier-budget': { barrierRepair: true, refinementStepBudget: HIERARCHY_REFINEMENT_STEP_BUDGET * 8 },
    // Level 5 on top of the shipped configuration.
    'branch': {
        barrierRepair: true,
        refinementStepBudget: HIERARCHY_REFINEMENT_STEP_BUDGET * 8,
        branchRepair: true
    },
    // The rule enforced regardless of mileage, to price what it actually costs.
    'branch-strict': {
        barrierRepair: true,
        refinementStepBudget: HIERARCHY_REFINEMENT_STEP_BUDGET * 8,
        branchRepair: true,
        branchOptions: { enforceRule: true, maxRepairs: 40 }
    }
};

const round = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

async function measure(order) {
    const measured = await measureRoadPath(order, { baseUrl: BASE_URL, profile: 'driving', timeoutMs: 25000 });
    if (!measured?.ok) return { ok: false, error: measured?.error || 'measurement failed' };
    return {
        ok: true,
        miles: round(measured.totalMiles),
        longestLeg: round(measured.longestLegMiles),
        p95: round(measured.legDistribution?.p95_miles),
        p99: round(measured.legDistribution?.p99_miles)
    };
}

/** Layer 2: does the order behave like a person drove it? */
function layer2(order) {
    const R = 3958.7613, rad = (d) => (d * Math.PI) / 180;
    const hav = (a, b) => {
        const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    };
    // single-link pockets at 0.35 mi
    const radius = 0.35, cell = radius / 60, grid = new Map();
    order.forEach((p, i) => {
        const k = `${Math.floor(p.lat / cell)}:${Math.floor(p.lng / cell)}`;
        if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    });
    const parent = order.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    order.forEach((p, i) => {
        const gi = Math.floor(p.lat / cell), gj = Math.floor(p.lng / cell);
        for (let di = -1; di <= 1; di += 1) for (let dj = -1; dj <= 1; dj += 1) {
            const bucket = grid.get(`${gi + di}:${gj + dj}`);
            if (!bucket) continue;
            for (const o of bucket) {
                if (o <= i) continue;
                if (hav(p, order[o]) <= radius) { const a = find(i), b = find(o); if (a !== b) parent[b] = a; }
            }
        }
    });
    const labels = order.map((_, i) => find(i));
    let runs = 1;
    for (let i = 1; i < labels.length; i += 1) if (labels[i] !== labels[i - 1]) runs += 1;
    const pockets = new Set(labels).size;

    let reversals = 0;
    for (let i = 1; i < order.length - 1; i += 1) {
        const b1 = Math.atan2(order[i].lat - order[i - 1].lat, order[i].lng - order[i - 1].lng);
        const b2 = Math.atan2(order[i + 1].lat - order[i].lat, order[i + 1].lng - order[i].lng);
        let d = Math.abs(b2 - b1); if (d > Math.PI) d = 2 * Math.PI - d;
        if (d > (2 * Math.PI) / 3) reversals += 1;
    }

    const mLat = order.reduce((t, p) => t + p.lat, 0) / order.length;
    const mLng = order.reduce((t, p) => t + p.lng, 0) / order.length;
    let sxx = 0, syy = 0, sxy = 0;
    order.forEach((p) => {
        const x = (p.lng - mLng) * Math.cos(rad(mLat)), y = p.lat - mLat;
        sxx += x * x; syy += y * y; sxy += x * y;
    });
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const proj = order.map((p) => ((p.lng - mLng) * Math.cos(rad(mLat))) * Math.cos(theta) + (p.lat - mLat) * Math.sin(theta));
    let absMove = 0;
    for (let i = 1; i < proj.length; i += 1) absMove += Math.abs(proj[i] - proj[i - 1]);
    const span = Math.max(...proj) - Math.min(...proj);

    return {
        pockets,
        pocket_visits: runs,
        pocket_reentries: runs - pockets,
        direction_reversals: reversals,
        direction_reversal_pct: Math.round((reversals / (order.length - 2)) * 1000) / 10,
        progression_efficiency_pct: Math.round((span / absMove) * 1000) / 10
    };
}

async function runVariant(name, doors) {
    const canonical = [...doors].sort((a, b) => (String(a.address_hash) < String(b.address_hash) ? -1 : 1));
    const started = Date.now();
    console.log(`\n${'='.repeat(70)}\nVARIANT: ${name}`);

    let order = null, telemetry = null, extra = {};
    if (name === 'portfolio') {
        const result = await sequenceBestDecomposition(canonical, {
            baseUrl: BASE_URL, profile: 'driving', timeoutMs: 25000, measurePath: measureRoadPath,
            portfolio: DEFAULT_DECOMPOSITION_PORTFOLIO,
            onCandidate: ({ index, total, id, result: r }) => {
                console.log(`  [${index}/${total}] ${id}: ${r?.ok ? `${r.verified_road_miles} mi (${(r.runtime_ms / 1000).toFixed(0)}s)` : `REJECTED ${r?.reason || 'skipped'}`}`);
            }
        });
        if (!result.ok) { console.log(`  FAILED: ${result.code}`); return { name, ok: false, code: result.code }; }
        order = result.order; telemetry = result.telemetry;
        extra = { selected_decomposition: telemetry.selected_decomposition, candidates: telemetry.decomposition_candidates };
    } else {
        const options = VARIANT_OPTIONS[name];
        if (!options) { console.log(`  unknown variant`); return { name, ok: false, code: 'UNKNOWN_VARIANT' }; }
        const result = await sequenceRoadHierarchy(canonical, {
            baseUrl: BASE_URL, profile: 'driving', timeoutMs: 25000,
            measurePath: measureRoadPath, ...options
        });
        if (!result.ok) { console.log(`  FAILED: ${result.code} ${result.reason || ''}`); return { name, ok: false, code: result.code }; }
        order = result.order; telemetry = result.telemetry;
    }

    const runtimeMs = Date.now() - started;
    const measured = await measure(order);
    const behaviour = layer2(order);

    const record = {
        name, ok: true, runtime_s: Math.round(runtimeMs / 1000),
        decomposition: telemetry.decomposition,
        window_grouping_road_priced: telemetry.window_grouping_road_priced,
        cluster_count: telemetry.cluster_count,
        street_block_count: telemetry.street_block_count,
        degraded: telemetry.degraded,
        order_affecting_aerial_decisions: telemetry.order_affecting_aerial_decisions,
        matrix_requests: telemetry.matrix_request_count,
        osrm_requests: telemetry.osrm_requests,
        layer1: measured,
        layer2: behaviour,
        ...extra
    };
    console.log(`  decomposition ......... ${record.decomposition} (road-priced grouping: ${record.window_grouping_road_priced})`);
    console.log(`  windows ............... ${record.cluster_count} over ${record.street_block_count} street blocks`);
    console.log(`  degraded .............. ${record.degraded}  aerial order decisions: ${record.order_affecting_aerial_decisions}`);
    console.log(`  LAYER 1 road miles .... ${measured.miles}   longest leg ${measured.longestLeg}   p95 ${measured.p95}`);
    console.log(`  LAYER 2 pockets ....... ${behaviour.pockets} entered ${behaviour.pocket_visits}x -> ${behaviour.pocket_reentries} re-entries`);
    console.log(`  LAYER 2 reversals ..... ${behaviour.direction_reversal_pct}%   progression ${behaviour.progression_efficiency_pct}%`);
    if (telemetry.branch_repair_ran !== undefined && telemetry.branches_found > 0) {
        console.log(`  BRANCHES .............. ${telemetry.branches_found} single-entry areas, ${telemetry.branch_doors_total} doors behind a gate`);
        console.log(`  re-entered ............ ${telemetry.branches_reentered_before} -> ${telemetry.branches_reentered_after}`
            + `   (extra entries ${telemetry.branch_extra_entries_before} -> ${telemetry.branch_extra_entries_after})`);
        console.log(`  repairs ............... ${telemetry.branches_repaired} kept, ${telemetry.branches_rejected_no_gain} measured longer`
            + `${telemetry.branches_enforced ? `, ${telemetry.branches_enforced} enforced anyway` : ''},`
            + ` net ${telemetry.branch_miles_saved} mi`);
    }
    console.log(`  runtime ............... ${record.runtime_s}s (${record.osrm_requests} OSRM requests)`);
    return record;
}

async function main() {
    if (!CSV || !fs.existsSync(CSV)) { console.log('Usage: node scripts/route-1h-solver-bench.mjs <doors.csv> [variant ...]'); process.exitCode = 2; return; }
    const doors = loadDoors(CSV);
    const plan = planTieredRoadMatrix(doors, []);
    const blocks = buildStreetBlocks(doors);
    console.log(`doors: ${doors.length}   street blocks: ${blocks.length}   matrix tier: ${plan.ok ? plan.tier : plan.code}`);
    console.log(`OSRM: ${BASE_URL}`);

    // The shipped order, measured the same way, so every variant has a like-for-like baseline.
    const shipped = await measure(doors);
    const shippedBehaviour = layer2(doors);
    console.log(`\nSHIPPED ORDER: ${shipped.miles} road mi · ${shippedBehaviour.pocket_reentries} pocket re-entries · ${shippedBehaviour.progression_efficiency_pct}% progression`);

    const records = [];
    for (const variant of VARIANTS) records.push(await runVariant(variant, doors));

    const payload = {
        measured_at: new Date().toISOString(),
        doors: doors.length,
        street_blocks: blocks.length,
        matrix_tier: plan.ok ? plan.tier : plan.code,
        shipped: { layer1: shipped, layer2: shippedBehaviour },
        variants: records
    };
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(RESULTS, 'utf8')); } catch { /* first run */ }
    fs.writeFileSync(RESULTS, JSON.stringify([...existing, payload], null, 2));

    console.log(`\n${'='.repeat(70)}\nSUMMARY vs shipped ${shipped.miles} mi`);
    records.filter((r) => r.ok).forEach((r) => {
        const delta = shipped.miles - r.layer1.miles;
        console.log(`  ${r.name.padEnd(16)} ${String(r.layer1.miles).padStart(7)} mi  ${delta >= 0 ? '-' : '+'}${Math.abs(round(delta))} (${round((delta / shipped.miles) * 100)}%)  re-entries ${r.layer2.pocket_reentries}  ${r.runtime_s}s`);
    });
    console.log(`\nresults appended to ${RESULTS}`);
}

main().catch((error) => { console.log('ERROR:', error.stack || error.message); process.exitCode = 1; });
