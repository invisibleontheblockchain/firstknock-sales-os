// Offline comparison against the shipped search. No customer records or provider
// calls: frozen matrices prove that speed comes from work reuse, not weaker routes.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { roadAwareStreetSweep } from '../base44/shared/roadAwareStreetSweep.js';
import { createMatrixMetricFns, packedRoadMatrixTiles } from '../base44/shared/roadMatrix.js';

const baselineRef = process.argv[2] || 'c141c37094eaa68c6235e1adc85a7a7ad5ff0d49';
const sharedRoot = new URL('../base44/shared/', import.meta.url);
const beforeSource = execFileSync('git', ['show', `${baselineRef}:base44/shared/roadAwareStreetSweep.js`], { encoding: 'utf8' })
    .replace(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, sharedRoot).href}'`);
const before = (await import(`data:text/javascript;base64,${Buffer.from(beforeSource).toString('base64')}`)).roadAwareStreetSweep;
const identity = order => order.map(p => p.address_hash || p.legacy_hash || p.id).join('|');
const rows = [];
for (const name of ['mesquite58', 'charlotte95', 'anderson183']) {
    const fixture = JSON.parse(readFileSync(new URL(`../test/fixtures/road-matrix-${name}.json`, import.meta.url), 'utf8'));
    const properties = [...fixture.properties].sort((a, b) => String(a.address_hash).localeCompare(String(b.address_hash)));
    // Index the fixture, not the sorted candidate input.
    const actualMetrics = createMatrixMetricFns(fixture.properties, { distances: fixture.distances_miles, durations: fixture.durations_minutes });
    for (const objective of ['distanceBetween', 'durationBetween']) {
        const options = { distanceBetween: actualMetrics[objective] };
        const started = performance.now();
        const oldOrder = before(properties, options);
        const beforeMs = performance.now() - started;
        const nextStarted = performance.now();
        const newOrder = roadAwareStreetSweep(properties, options);
        const afterMs = performance.now() - nextStarted;
        if (identity(oldOrder) !== identity(newOrder)) throw new Error(`${name}/${objective}: route order changed`);
        rows.push({ name, objective, count: properties.length, identicalOrder: true,
            fingerprint: createHash('sha256').update(identity(newOrder)).digest('hex'),
            beforeMs: Math.round(beforeMs), afterMs: Math.round(afterMs),
            reductionPercent: Math.round((1 - afterMs / beforeMs) * 1000) / 10 });
        process.stdout.write(`${JSON.stringify(rows.at(-1))}\n`);
    }
}
process.stdout.write(`${JSON.stringify({ tableRequests: [58, 95, 183, 215, 250].map(count => ({
    count, before: Math.ceil(count / 46) ** 2, after: packedRoadMatrixTiles(count).length,
})), rows })}\n`);
