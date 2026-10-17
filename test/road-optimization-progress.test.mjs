import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEstimate, estimateJobSeconds, estimateRoadOptimizationSeconds, runWithConcurrency,
    startRoadOptimizationJob, subscribeRoadOptimizationJobs } from '../src/lib/roadOptimizationProgress.js';

test('the estimate scales with stops and reads as a short range', () => {
    const big = estimateRoadOptimizationSeconds(1000);
    assert.ok(big.low >= 90 && big.high <= 200, JSON.stringify(big));
    // Measured: 1,000 stops took 102-169 s, 184 stops 29 s.
    assert.equal(describeEstimate(big), 'about 2–3 minutes');
    assert.equal(describeEstimate(estimateRoadOptimizationSeconds(184)), 'about 30–45 seconds');
    // Two routes in parallel take as long as the longer lane, not the sum.
    assert.deepEqual(estimateJobSeconds([1000, 1000], 2), big);
    assert.deepEqual(estimateJobSeconds([1000, 1000], 1), { low: big.low * 2, high: big.high * 2 });
});

test('a job publishes each route from waiting to done, then disappears', () => {
    const seen = [];
    const stop = subscribeRoadOptimizationJobs(jobs => seen.push(jobs));
    const job = startRoadOptimizationJob({ routes: [{ name: 'A', stops: 300 }, { name: 'B', stops: 20 }], concurrency: 2, background: true });
    job.startRoute(0);
    job.progress(0, { passesDone: 2, maxPasses: 8, checksDone: 120, checksTotal: 340, savedMiles: 4.2, bestMiles: null });
    job.finishRoute(0, 'improved');
    let current = seen.at(-1).find(item => item.id === job.id);
    assert.equal(current.routes[0].status, 'improved');
    assert.equal(current.routes[0].checksDone, 120);
    assert.equal(current.routes[1].status, 'waiting');
    assert.equal(current.background, true);
    job.finish();
    assert.equal(seen.at(-1).some(item => item.id === job.id), false);
    stop();
});

test('routes run at most N at a time and results keep their order', async () => {
    let running = 0, peak = 0;
    const results = await runWithConcurrency([5, 1, 3, 2], 2, async (value) => {
        running++; peak = Math.max(peak, running);
        await new Promise(resolve => setTimeout(resolve, value));
        running--; return value * 10;
    });
    assert.equal(peak, 2);
    assert.deepEqual(results, [50, 10, 30, 20]);
});
