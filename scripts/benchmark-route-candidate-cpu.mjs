// Read-only CPU comparison. No app/backend requests or saved routes are touched.
// Pass an optional Git ref to compare another baseline with the working tree.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLocalDrivingCandidates } from '../base44/shared/localDrivingNeighborhoods.js';
import { buildDrivingAreaDoorCandidates } from '../base44/shared/drivingAreaDoorSearch.js';

const baselineRef = process.argv[2] || 'a67702ab';
const shared = new URL('../base44/shared/', import.meta.url).href;
const loadBaseline = async file => {
    const source = execFileSync('git', ['show', `${baselineRef}:base44/shared/${file}`], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    }).replaceAll("from './", `from '${shared}`);
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};
const baselineLocal = (await loadBaseline('localDrivingNeighborhoods.js')).buildLocalDrivingCandidates;
const baselineArea = (await loadBaseline('drivingAreaDoorSearch.js')).buildDrivingAreaDoorCandidates;
const context = {
    optimizationCostBetween: (a, b) => 3 + (a.index * 31 + b.index * 17) % 29,
    distanceBetween: (a, b) => 1 + (a.index * 11 + b.index * 7) % 13,
    accessFor: () => null,
};
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => Math.round(value * 100) / 100;
for (const size of [10, 12, 25, 40]) {
    const stops = Array.from({ length: size }, (_, index) => ({ id: `stop-${index}`, index,
        lat: 35, lng: -81 + index / 10000, street_name: 'Test Lane' }));
    const before = size <= 12 ? baselineLocal : baselineArea;
    const after = size <= 12 ? buildLocalDrivingCandidates : buildDrivingAreaDoorCandidates;
    const samples = { before: [], after: [] };
    let actual;
    for (let trial = 0; trial < 6; trial++) {
        let expected;
        for (const [name, search] of [['before', before], ['after', after]]) {
            const started = performance.now();
            const result = search(stops, context);
            const elapsed = performance.now() - started;
            if (trial) samples[name].push(elapsed);
            if (name === 'before') expected = result;
            else { actual = result; assert.deepEqual(actual, expected, 'CPU optimization changed candidate output'); }
        }
    }
    const beforeMs = median(samples.before), afterMs = median(samples.after);
    console.log(JSON.stringify({ baselineRef, search: size <= 12 ? 'local_dp' : 'area', stops: size,
        beforeMedianMs: round(beforeMs), afterMedianMs: round(afterMs),
        cpuReductionPercent: round((beforeMs - afterMs) / beforeMs * 100),
        identicalCandidates: actual.length, evaluations: actual[0]?.searchEvaluations ?? null }));
}
