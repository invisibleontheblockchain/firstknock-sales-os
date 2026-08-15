// Benchmark harness for the decomposition portfolio (research tool, not shipped code).
//
//   node scripts/route-decomposition-benchmark.mjs <doors.json> [candidateIds]
//
// Runs the named portfolio candidates (default: all) through the identical
// production stack and reports independently measured road miles per candidate,
// so a decomposition is only ever adopted on measured evidence.

import { readFileSync } from 'node:fs';
import {
    sequenceBestDecomposition,
    DEFAULT_DECOMPOSITION_PORTFOLIO
} from '../base44/shared/roadDecompositionPortfolio.js';
import { measureRoadPath } from '../base44/shared/roadPathMeasure.js';

const [doorsPath, idList] = process.argv.slice(2);
const doors = JSON.parse(readFileSync(doorsPath, 'utf8'))
    .filter((door) => Number.isFinite(Number(door?.lat)) && Number.isFinite(Number(door?.lng)));

const ids = idList ? idList.split(',').map((value) => value.trim()).filter(Boolean) : null;
const portfolio = ids
    ? DEFAULT_DECOMPOSITION_PORTFOLIO.filter((candidate) => ids.includes(candidate.id))
    : DEFAULT_DECOMPOSITION_PORTFOLIO;

const startedAt = Date.now();
const result = await sequenceBestDecomposition(doors, {
    portfolio,
    measurePath: measureRoadPath,
    onCandidate: ({ index, total, id, result: candidate }) => {
        process.stderr.write(`[${index}/${total}] ${id}: ${
            candidate?.ok ? `${candidate.verified_road_miles} mi in ${(candidate.runtime_ms / 1000).toFixed(1)}s` : (candidate?.reason || 'skipped')
        }\n`);
    }
});

if (!result.ok) {
    console.log(JSON.stringify({ ok: false, code: result.code, candidates: result.candidates }, null, 2));
    process.exit(1);
}

console.log(JSON.stringify({
    ok: true,
    door_count: doors.length,
    unique_doors: new Set(result.order).size,
    selected: result.best.id,
    selected_miles: result.best.verified_road_miles,
    frozen_baseline_miles: 358.285,
    vs_frozen_baseline: Math.round((result.best.verified_road_miles - 358.285) * 1000) / 1000,
    total_runtime_s: Math.round((Date.now() - startedAt) / 100) / 10,
    candidates: result.candidates.map(({ order, telemetry, ...rest }) => rest)
}, null, 2));