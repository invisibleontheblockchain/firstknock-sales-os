const reference = value => value !== null && typeof value === 'object';

function memoizedMetric(metric, counters) {
    if (typeof metric !== 'function') return metric;
    const pairs = new WeakMap();
    return function (...args) {
        const [left, right] = args;
        // Route metrics have two immutable points for one request. Other calls
        // retain the original function's behavior and are never memoized.
        if (args.length !== 2 || !reference(left) || !reference(right)) return metric.apply(this, args);
        let targets = pairs.get(left);
        if (!targets) { targets = new WeakMap(); pairs.set(left, targets); }
        const prior = targets.get(right);
        if (prior && prior.receiver === this) {
            for (const { counter, delta } of prior.deltas) counter.target[counter.key] += delta;
            return prior.value;
        }
        const before = counters.map(counter => counter.target[counter.key]);
        const value = metric.apply(this, args);
        const deltas = [];
        counters.forEach((counter, i) => {
            const after = counter.target[counter.key];
            if (typeof before[i] === 'number' && Number.isFinite(before[i]) && typeof after === 'number'
                && Number.isFinite(after) && after !== before[i]) deltas.push({ counter, delta: after - before[i] });
        });
        targets.set(right, { receiver: this, value, deltas });
        return value;
    };
}

// Each request owns its caches. Keep distance and duration separate, preserve
// exact directed values (including unavailable results), and release point
// entries when their object references are no longer retained by the request.
// Optional numeric evaluation counters replay their original deltas on hits,
// so candidate-search telemetry still counts every evaluation, not cache misses.
export function createMemoizedRouteMetrics(metrics = {}, options = {}) {
    const counters = (options.evaluationCounters || []).filter(counter => reference(counter?.target)
        && (typeof counter.key === 'string' || typeof counter.key === 'symbol'));
    return { ...metrics, distanceBetween: memoizedMetric(metrics.distanceBetween, counters),
        durationBetween: memoizedMetric(metrics.durationBetween, counters) };
}
