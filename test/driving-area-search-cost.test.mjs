import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDrivingAreaDoorCandidates } from '../base44/shared/drivingAreaDoorSearch.js';
import { buildDrivingAreaDoorCandidates as referenceSearch } from './fixtures/referenceDrivingAreaDoorSearch.mjs';

function fixture(size, mode) {
    const stops = Array.from({ length: size }, (_, index) => ({ id: `door-${(index * 7) % 43}-${index}`, index,
        street_name: `Street ${index % 3}` }));
    const start = { id: 'start', index: size }, end = { id: 'end', index: size + 1 };
    const context = {
        optimizationCostBetween: (a, b) => mode === 'unreachable' && (a.index === 3 || b.index === 3) ? Infinity
            : mode === 'equal' ? 1 : mode === 'near-ties' ? 1 + (a.index * 7 + b.index * 3) % 5 * 0.04
                : 3 + (a.index * 31 + b.index * 17) % 29,
        distanceBetween: (a, b) => mode === 'equal' ? 0.001 : mode === 'near-ties'
            ? 0.001 + (a.index * 3 + b.index * 5) % 4 * 0.00004 : 1 + (a.index * 11 + b.index * 7) % 13,
    };
    return { stops, start, end, context };
}

for (const [name, size, mode, configure] of [
    ['asymmetric directed costs', 25, 'directed'],
    ['full forty-stop evaluation budget', 40, 'directed', (_data, options) => { options.maxEvaluations = 60000; }],
    ['completely tied costs', 12, 'equal'],
    ['tolerance boundary cost ties', 14, 'near-ties'],
    ['unreachable directed transitions', 10, 'unreachable'],
    ['explicit and property locks', 18, 'directed', (data, options) => {
        data.stops[2].locked = true; data.stops[6].order_locked = true;
        data.stops[10].routing_access = { resolution_status: 'unresolved' };
        options.lockedStopIds = [data.stops[14].id];
    }],
    ['external seed alternatives', 17, 'near-ties', (data, options) => {
        options.seedOrders = [[...data.stops].reverse(), [...data.stops.slice(3), ...data.stops.slice(0, 3)]];
    }],
    ['service constraint before the candidate cap', 15, 'directed', (_data, options) => {
        options.acceptOrder = order => order[0].index % 2 === 0; options.maxCandidates = 1;
    }],
    ['open route without anchors', 16, 'near-ties', data => { data.start = null; data.end = null; }],
    ['one anchored endpoint', 19, 'directed', data => { data.end = null; }],
]) test(`lazy area fingerprints preserve every candidate and evaluation count: ${name}`, () => {
    const data = fixture(size, mode), options = { maxEvaluations: 12000 };
    configure?.(data, options);
    const before = structuredClone(data.stops);
    const expected = referenceSearch(data.stops, data.context, data.start, data.end, options);
    const actual = buildDrivingAreaDoorCandidates(data.stops, data.context, data.start, data.end, options);
    assert.deepEqual(actual, expected);
    assert.deepEqual(data.stops, before);
});
