import test from 'node:test';
import assert from 'node:assert/strict';
import { indexRouteLogs, logsForRouteProperty } from '../src/components/logic/routeLogIndex.js';

test('indexed route histories preserve both aliases, input order and rerun inclusion', () => {
    const logs = [
        { id: 'older', address_hash: 'legacy', created_date: '2026-10-01' },
        { id: 'same-route', address_hash: 'hash', route_id: 'route-1', created_date: '2026-10-01' },
        { id: 'legacy-new', address_hash: 'legacy', created_date: '2026-10-14' },
        { id: 'other', address_hash: 'other', created_date: '2026-10-14' },
        { id: 'primary-new', address_hash: 'hash', created_date: '2026-10-14' },
        { id: 'invalid', address_hash: 'legacy', created_date: 'invalid' },
    ];
    const property = { address_hash: 'hash', legacy_hash: 'legacy' };
    const indexed = indexRouteLogs(logs);
    assert.deepEqual(logsForRouteProperty(indexed, property).map(log => log.id), ['older', 'same-route', 'legacy-new', 'primary-new', 'invalid']);
    assert.deepEqual(logsForRouteProperty(indexed, property, {
        routeId: 'route-1', rerunCreatedAt: Date.parse('2026-10-10'),
    }).map(log => log.id), ['same-route', 'legacy-new', 'primary-new']);
    assert.deepEqual(logsForRouteProperty(indexed, { address_hash: 'hash', legacy_hash: 'hash' }).map(log => log.id), ['same-route', 'primary-new']);
});

test('large route status derivation reads the log hashes once instead of scanning history for every door', () => {
    let hashReads = 0;
    const logs = Array.from({ length: 5000 }, (_, index) => ({
        get address_hash() { hashReads++; return `house-${index}`; },
    }));
    const indexed = indexRouteLogs(logs);
    for (let index = 0; index < 5000; index++) {
        assert.equal(logsForRouteProperty(indexed, { address_hash: `house-${index}` }).length, 1);
    }
    assert.equal(hashReads, 5000, `read ${hashReads} hashes instead of 25 million`);
});
