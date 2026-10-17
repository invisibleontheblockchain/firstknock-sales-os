import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const baseline = JSON.parse(readFileSync(new URL('./fixtures/giant-home-regression.json', import.meta.url), 'utf8'));

test('the modeled 6965-stop baseline remains identifiable without publishing the private export', () => {
    assert.equal(baseline.stopCount, 6965); assert.equal(baseline.unresolvedStops, 44);
    assert.equal(baseline.visibleRoutes, 1); assert.equal(baseline.matchLimitMeters, 100);
    assert.equal(baseline.metrics.acceptedRegressions, 0);
    assert.ok(baseline.metrics.distanceReductionPercent > 8.37 && baseline.metrics.distanceReductionPercent < 8.38);
    assert.ok(baseline.metrics.timeReductionPercent > 9.57 && baseline.metrics.timeReductionPercent < 9.58);
    assert.equal(baseline.exportSha256.length, 64); assert.equal(baseline.providerFingerprint.length, 64);
});
test('neighborhood v5 explicitly versions the driving review while preserving frozen window connector scoring', () => {
    // The original modeled baseline and its source hashes remain historical
    // evidence. V11 verifies an interior shared driving leg with arrival and
    // departure context in both requests and uses its validated step geometry.
    // vehicle-route-chunk-validation.test.mjs covers chunk boundaries, omitted
    // overview points, genuine path/cost disagreement and exact leg coverage.
    // A live 316-stop comparison also passed all three shared-leg checks.
    // V13 retries a disagreeing shared leg with 8/16/32 predecessor stops,
    // preserving the 100-point cap and the exact directed path/cost guard.
    // Added fixtures cover final and interior adaptive seams, rejected graph
    // changes and mismatches, and exact-once coverage after shorter chunks.
    // The live 377-stop county/public composite passed with an eight-stop retry.
    // Match radii, headings, parking and frozen connector scoring stay fixed.
    // This does not remeasure
    // the private export or change its historical source hashes.
    // Reviewed: vehicleRouting.js now requests redirect 'manual' instead of
    // 'error', which the Base44 edge runtime rejects before connecting. A
    // redirect is still !ok and fails the request; no routing logic changed.
    // Reviewed: chunk seams may backtrack up to MAX_SEAM_BACKTRACKS legs when
    // the retained leg depends on departure (successor) context, which extra
    // predecessors cannot supply. The shared leg must still match exactly in
    // path, time and distance; a persistent disagreement still rejects. Live
    // 377-stop Charlotte route: previously rejected at a seam on both the
    // private gateway and the public demo, now joins and validates.
    // Reviewed: a resolved stop's service-road check accepts a /route junction
    // label ("A / B") that names the expected road; the snap-distance checks are
    // unchanged. Live, /nearest and /route disagreed on exactly that label.
    // Reviewed: long routes request every chunk whose seam joins on the first
    // try together, then join them in order exactly as before; a chunk request
    // depends only on its start, so the answers and the seam checks are
    // unchanged. Retries and backtracks still fetch their new starts on demand.
    const frozen = { 'coreDrivingPilot.js': '44ecbfad3d3578258d4d4a19d5ce7f1a43e345f61e5f0f362a71118a5e5d8f90',
        'guardedDrivingWindows.js': baseline.sourceHashes['base44/shared/guardedDrivingWindows.js'],
        'vehicleRouting.js': '6223cc865f1ceef3a83915cd419a15c5e6ea684f7bcd4443b2e8f00832712d82' };
    for (const [file, hash] of Object.entries(frozen)) {
        const source = readFileSync(new URL('../base44/shared/' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(createHash('sha256').update(source).digest('hex'), hash, file + ' needs explicit regression review');
    }
});
