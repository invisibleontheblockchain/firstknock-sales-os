import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalDrivingCandidates } from '../base44/shared/localDrivingNeighborhoods.js';
import { neighborhoodStreetKey } from '../base44/shared/neighborhoodExcursions.js';
import { trustedAccess } from '../base44/shared/streetSideRouting.js';

const id = p => String(p?.address_hash || p?.legacy_hash || p?.id || '');
// Frozen pre-optimization search is an independent differential oracle. Keep
// its transition evaluation and tolerant comparator so CPU changes must return
// exactly the same bounded choices, including directed costs and service ties.
function compareSearch(a, b) {
    // Keep tolerances small and separate from the final continuous-drive guard.
    if (Math.abs(a.seconds - b.seconds) > 0.1) return a.seconds - b.seconds;
    if (Math.abs(a.miles - b.miles) > 0.0001) return a.miles - b.miles;
    return a.crossings - b.crossings || a.passovers - b.passovers
        || a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds
        || a.entrySeconds - b.entrySeconds || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);
}

function serviceTransition(a, b, unvisited, context) {
    const first = context.accessFor?.(a), second = context.accessFor?.(b);
    if (!trustedAccess(first) || !trustedAccess(second) || first.chainKey !== second.chainKey) {
        return { crossings: 0, passovers: 0 };
    }
    // A nearby opposite-side house can deliberately be left for the return pass.
    // Only skipping a still-unserved house on this same side counts as passing it.
    const low = Math.min(first.positionMeters, second.positionMeters);
    const high = Math.max(first.positionMeters, second.positionMeters);
    return { crossings: Number(first.side !== second.side), passovers: unvisited.filter(stop => {
        const access = context.accessFor?.(stop);
        return trustedAccess(access) && access.chainKey === first.chainKey && access.side === first.side
            && access.positionMeters > low + 0.1 && access.positionMeters < high - 0.1;
    }).length };
}

// K-best Held–Karp states keep alternative service tours, including split-street
// tours. No aerial fallback is permitted in search. Both fixed boundary stops
// are priced; extra overlapping boundary legs are checked during validation.
function referenceSearch(stops, context, start = null, end = null, options = {}) {
    if (stops.length < 2 || stops.length > 12) return [];
    const width = Math.max(1, Math.min(8, options.localSearchWidth || 4));
    const duration = (a, b) => a && b ? context.optimizationCostBetween(a, b) : 0;
    const distance = (a, b) => a && b ? context.distanceBetween(a, b) : 0;
    const states = new Map();
    const insert = (mask, last, candidate) => {
        if (!Number.isFinite(candidate.seconds) || !Number.isFinite(candidate.miles)) return;
        const key = `${mask}:${last}`;
        const choices = states.get(key) || [];
        choices.push(candidate); choices.sort(compareSearch);
        states.set(key, choices.slice(0, width));
    };
    for (let i = 0; i < stops.length; i++) {
        const seconds = duration(start, stops[i]);
        insert(1 << i, i, { path: [i], seconds, miles: distance(start, stops[i]), startSeconds: seconds,
            endSeconds: 0, entrySeconds: 0, crossings: 0, passovers: 0, fingerprint: id(stops[i]) });
    }
    const full = (1 << stops.length) - 1;
    for (let mask = 1; mask <= full; mask++) {
        for (let last = 0; last < stops.length; last++) {
            for (const prior of states.get(`${mask}:${last}`) || []) {
                for (let next = 0; next < stops.length; next++) {
                    if (mask & (1 << next)) continue;
                    const a = stops[last], b = stops[next];
                    const preference = serviceTransition(a, b, stops.filter((_, i) => !(mask & (1 << i)) && i !== next), context);
                    const seconds = duration(a, b);
                    insert(mask | (1 << next), next, { ...prior, path: [...prior.path, next],
                        seconds: prior.seconds + seconds, miles: prior.miles + distance(a, b),
                        crossings: prior.crossings + preference.crossings, passovers: prior.passovers + preference.passovers,
                        entrySeconds: prior.entrySeconds + (neighborhoodStreetKey(a) !== neighborhoodStreetKey(b) ? seconds : 0),
                        fingerprint: `${prior.fingerprint}|${id(b)}` });
                }
            }
        }
    }
    const candidates = [];
    for (let last = 0; last < stops.length; last++) {
        for (const prior of states.get(`${full}:${last}`) || []) {
            const endSeconds = duration(stops[last], end);
            candidates.push({ ...prior, seconds: prior.seconds + endSeconds,
                miles: prior.miles + distance(stops[last], end), endSeconds,
                order: prior.path.map(i => stops[i]) });
        }
    }
    return candidates.filter(p => Number.isFinite(p.seconds) && Number.isFinite(p.miles)).sort(compareSearch);
}

function fixture(n, { seed = 1, sides = true, tied = false, unreachable = false } = {}) {
    const stops = Array.from({ length: n }, (_, i) => ({ address_hash: `stop-${(i * 7 + seed) % 19}-${i}`,
        index: i, street_name: ['Fairfield Drive', 'Parkmont Dr', 'Fairfield Dr'][i % 3], city: 'Troutman', zip_code: '28166' }));
    const start = { index: n, address_hash: 'start' }, end = { index: n + 1, address_hash: 'end' };
    const access = stops.map((p, i) => sides && i % 5 !== 3 ? {
        confidence: i % 5 === 4 ? 'low' : 'high', chainKey: `chain-${i % 3 === 1 ? 1 : 0}`,
        side: i % 2 ? 'left' : 'right', positionMeters: [30, 0, 30, 20, 40, 10, 60, 50, 70, 80, 90, 100][i],
    } : null);
    const seconds = Array.from({ length: n + 2 }, (_, i) => Array.from({ length: n + 2 }, (_, j) =>
        unreachable && ((i * 11 + j * 7 + seed) % 17 === 0) ? Infinity
            : tied ? 1 + ((i * 7 + j * 3 + seed) % 5) * 0.04 : 1 + ((i * 97 + j * 53 + seed * 31) % 137) / 7));
    const miles = seconds.map((row, i) => row.map((value, j) =>
        Number.isFinite(value) ? tied ? 0.001 + ((i * 3 + j * 5 + seed) % 4) * 0.00004
            : 0.01 + ((i * 31 + j * 13 + seed * 7) % 113) / 10000 : Infinity));
    const calls = { durations: 0, distances: 0, accesses: 0 };
    const context = {
        optimizationCostBetween: (a, b) => { calls.durations++; return seconds[a.index][b.index]; },
        distanceBetween: (a, b) => { calls.distances++; return miles[a.index][b.index]; },
        accessFor: p => { calls.accesses++; return access[p.index]; },
    };
    return { stops, start, end, context, calls };
}

const records = candidates => candidates.map(candidate => ({ ...candidate,
    order: candidate.order.map(p => p.address_hash) }));

test('cached DP returns the same complete bounded choices as the original directed search', () => {
    const cases = [
        [5, { seed: 3, sides: false }, 1],
        [7, { seed: 7, sides: true }, 4],
        [7, { seed: 11, sides: true, unreachable: true }, 8],
        [7, { seed: 13, sides: true, tied: true }, 4],
        [10, { seed: 17, sides: true, unreachable: true }, 4],
        [12, { seed: 19, sides: true }, 4],
    ];
    for (const [n, config, width] of cases) {
        const data = fixture(n, config);
        const options = { localSearchWidth: width };
        const expected = referenceSearch(data.stops, data.context, data.start, data.end, options);
        assert.deepEqual(records(buildLocalDrivingCandidates(data.stops, data.context, data.start, data.end, options)),
            records(expected), `n=${n}, config=${JSON.stringify(config)}, width=${width}`);
    }
});

test('cached DP preserves anchor-free and unreachable search outcomes', () => {
    const data = fixture(7, { seed: 23, tied: true });
    for (const [start, end] of [[null, null], [data.start, null], [null, data.end]]) {
        assert.deepEqual(records(buildLocalDrivingCandidates(data.stops, data.context, start, end)),
            records(referenceSearch(data.stops, data.context, start, end)));
    }
    data.context.optimizationCostBetween = () => Infinity;
    assert.deepEqual(buildLocalDrivingCandidates(data.stops, data.context, data.start, data.end), []);
    assert.deepEqual(referenceSearch(data.stops, data.context, data.start, data.end), []);
});

test('twelve-stop DP resolves each directed cost once instead of once per exponential transition', () => {
    const data = fixture(12, { seed: 29 });
    const candidates = buildLocalDrivingCandidates(data.stops, data.context, data.start, data.end);
    assert.ok(candidates.length > 0);
    const bound = data.stops.length * (data.stops.length - 1) + 2 * data.stops.length;
    assert.equal(data.calls.durations, bound);
    assert.equal(data.calls.distances, bound);
    assert.equal(data.calls.accesses, data.stops.length);
});