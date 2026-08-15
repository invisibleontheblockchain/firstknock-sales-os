// Re-measures the FROZEN Route 1I barrier regression against live road routing
// (research/verification tool, not shipped code).
//
//   node scripts/route-barrier-freeze-benchmark.mjs [candidateIds]
//
// Reads the permanent fixture, runs the named portfolio candidates (default: the
// two frozen ones) through the identical production stack, and diffs the result
// against the frozen numbers stored in the fixture. Needs live OSRM, ~250k road
// pairs and ~40s, which is why it is a script and not a unit test.

import { readFileSync } from 'node:fs';
import {
    sequenceBestDecomposition,
    DEFAULT_DECOMPOSITION_PORTFOLIO
} from '../base44/shared/roadDecompositionPortfolio.js';
import { measureRoadPath } from '../base44/shared/roadPathMeasure.js';

const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/charlotte-route-1i-barrier-1000.json', import.meta.url), 'utf8'));
const frozen = fixture.frozen_benchmark.candidates;

const ids = (process.argv[2] || 'baseline_windows_92,barrier_repaired_windows_92')
    .split(',').map((value) => value.trim()).filter(Boolean);
const portfolio = DEFAULT_DECOMPOSITION_PORTFOLIO.filter((candidate) => ids.includes(candidate.id));

const startedAt = Date.now();
const result = await sequenceBestDecomposition(fixture.doors, {
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

// Road data drifts as OpenStreetMap changes, so this reports the delta rather
// than asserting equality. A material regression is a conversation, not a crash.
const drift = (id, measured) => {
    const reference = id === 'barrier_repaired_windows_92' ? frozen.barrier_repair : frozen.geometric_baseline;
    return {
        frozen_miles: reference.verified_road_miles,
        measured_miles: measured,
        delta_miles: Math.round((measured - reference.verified_road_miles) * 1000) / 1000
    };
};

console.log(JSON.stringify({
    ok: true,
    fixture_version: fixture.fixture_version,
    door_count: fixture.doors.length,
    unique_doors: new Set(result.order).size,
    selected: result.best.id,
    frozen_selected: 'barrier_repaired_windows_92',
    total_runtime_s: Math.round((Date.now() - startedAt) / 100) / 10,
    candidates: result.candidates.map(({ order, telemetry, ...rest }) => ({
        ...rest,
        ...(rest.ok ? drift(rest.id, rest.verified_road_miles) : {}),
        barrier_straddling_windows: telemetry?.barrier_straddling_windows ?? null,
        barrier_blocks_moved: telemetry?.barrier_blocks_moved ?? null,
        barrier_doors_moved: telemetry?.barrier_doors_moved ?? null,
        decomposition: telemetry?.decomposition ?? null,
        order_affecting_aerial_decisions: telemetry?.order_affecting_aerial_decisions ?? null
    }))
}, null, 2));