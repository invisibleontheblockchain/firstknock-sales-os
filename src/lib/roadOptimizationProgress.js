// Live progress for long road optimizations (Optimize, base-to-base, Create
// Route, splits, merges, campaigns, imports). Callers start a job and report
// each route's passes; RoadOptimizationProgressHost shows it.

const listeners = new Set();
let jobs = [];
let nextId = 1;

// Show the progress screen right away from this many stops; smaller jobs show
// it only once they have run this long.
export const LONG_OPTIMIZATION_STOPS = 150;
export const LONG_OPTIMIZATION_AFTER_MS = 15000;

// Measured on the custom road server with the full search (all passes, 150
// checks per pass, approximate access, cached failures):
//   184 stops (Lincolnton)   29 s
//   1,000 stops (Hickory)    102 s;  1,000 stops (Charlotte 1H)  169 s
// The range spans those runs with headroom; one route at a time.
const SECONDS_PER_STOP = { low: 0.11, high: 0.16 };
const BASE_SECONDS = { low: 10, high: 15 };

/** Expected seconds for one route of `stops`, as a { low, high } range. */
export function estimateRoadOptimizationSeconds(stops) {
    const count = Math.max(0, Number(stops) || 0);
    return {
        low: Math.round(BASE_SECONDS.low + SECONDS_PER_STOP.low * count),
        high: Math.round(BASE_SECONDS.high + SECONDS_PER_STOP.high * count),
    };
}

/** "about 2–3 minutes", "about 30–60 seconds". */
export function describeEstimate({ low, high }) {
    if (high < 90) {
        const round = value => Math.max(5, Math.round(value / 5) * 5);
        return `about ${round(low)}–${round(high)} seconds`;
    }
    const lowMinutes = Math.max(1, Math.floor(low / 60));
    const highMinutes = Math.max(lowMinutes + 1, Math.ceil(high / 60));
    return `about ${lowMinutes}–${highMinutes} minutes`;
}

/** Estimate for a whole job: routes optimized `concurrency` at a time. */
export function estimateJobSeconds(routeStopCounts, concurrency = 1) {
    const lanes = Array.from({ length: Math.max(1, concurrency) }, () => ({ low: 0, high: 0 }));
    for (const stops of [...routeStopCounts].sort((a, b) => b - a)) {
        const lane = lanes.reduce((best, item) => (item.high < best.high ? item : best));
        const estimate = estimateRoadOptimizationSeconds(stops);
        lane.low += estimate.low; lane.high += estimate.high;
    }
    return { low: Math.max(...lanes.map(lane => lane.low)), high: Math.max(...lanes.map(lane => lane.high)) };
}

function publish() {
    const snapshot = jobs;
    for (const listener of listeners) listener(snapshot);
}

export function subscribeRoadOptimizationJobs(listener) {
    listeners.add(listener);
    listener(jobs);
    return () => listeners.delete(listener);
}

export function getRoadOptimizationJobs() {
    return jobs;
}

/**
 * Start a job. `routes` is [{ name, stops }]. `background` lets the user hide
 * the screen and keep working while it finishes.
 */
export function startRoadOptimizationJob({ title, routes, concurrency = 1, background = false }) {
    const id = nextId++;
    const job = {
        id, title, background, startedAt: Date.now(), finishedAt: null, finishing: false,
        estimate: estimateJobSeconds(routes.map(route => route.stops), concurrency),
        routes: routes.map(route => ({ name: route.name || null, stops: route.stops, status: 'waiting',
            passesDone: 0, maxPasses: null, checksDone: null, checksTotal: null, savedMiles: 0, bestMiles: null })),
    };
    jobs = [...jobs, job];
    publish();
    const patchRoute = (index, patch) => {
        jobs = jobs.map(item => (item.id !== id ? item : {
            ...item, routes: item.routes.map((route, i) => (i === index ? { ...route, ...patch } : route)),
        }));
        publish();
    };
    return {
        id,
        /** A route started optimizing. */
        startRoute: index => patchRoute(index, { status: 'optimizing' }),
        /** onSearchProgress payload from tryRoadMatrixOptimize. */
        progress: (index, { passesDone, maxPasses, checksDone, checksTotal, savedMiles, bestMiles }) => patchRoute(index, {
            passesDone, maxPasses, checksDone, checksTotal, savedMiles, bestMiles }),
        /** outcome: 'improved' | 'kept' | 'failed'. */
        finishRoute: (index, outcome, patch = {}) => patchRoute(index, { status: outcome, ...patch }),
        /** The first result is saved; the rest runs behind the "Keep working" pill. */
        finishInBackground: () => {
            jobs = jobs.map(item => (item.id !== id ? item : { ...item, finishing: true, background: true }));
            publish();
        },
        finish: () => {
            jobs = jobs.filter(item => item.id !== id);
            publish();
        },
    };
}

/** Run `work(route, index)` over routes, at most `concurrency` at once, in order. */
export async function runWithConcurrency(items, concurrency, work) {
    const results = new Array(items.length);
    let next = 0;
    const lane = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
    return results;
}
