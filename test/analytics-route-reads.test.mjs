import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ANALYTICS_ROUTE_FIELDS, ANALYTICS_ROUTE_SCOPE_FIELDS, fetchAnalyticsRouteRows } from '../src/lib/analyticsLoading.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const user = { id: 'manager', email: 'boss@example.com' };
const repIds = ['manager', 'member-1'];
const analyticsRoutes = [
    { id: 'tenant-1', manager_id: 'manager', assigned_to: 'member-1', created_by: 'boss@example.com', created_date: '2026-10-05', property_hashes: ['a', 'b'] },
    { id: 'tenant-2', manager_id: 'manager', assigned_to: 'other', created_by: 'boss@example.com', created_date: '2026-10-04', property_hashes: ['c'] },
    // Legacy rows the tenant read cannot see.
    { id: 'legacy-assigned', assigned_to: 'member-1', created_by: 'rep@example.com', created_date: '2026-10-03', property_hashes: ['d'] },
    { id: 'legacy-created', created_by: 'boss@example.com', created_date: '2026-10-02', property_hashes: ['e'] },
    // Another tenant's routes are never shown.
    { id: 'foreign-assigned', manager_id: 'foreign', assigned_to: 'member-1', created_by: 'x@example.com', created_date: '2026-10-01', property_hashes: ['f'] },
    { id: 'foreign-created', manager_id: 'foreign', created_by: 'boss@example.com', created_date: '2026-09-30', property_hashes: ['g'] },
];
const listFilters = () => {
    const tenantFilter = { manager_id: 'manager' };
    return { filters: [{ assigned_to: repIds }, tenantFilter, { created_by: user.email }], tenantFilter };
};
// Same rule List.jsx applies after dedupe.
const belongs = route => route.manager_id === 'manager' || (!route.manager_id && route.created_by === user.email);
const isVisible = route => {
    const assignedToMe = route.assigned_to && repIds.includes(route.assigned_to);
    if (assignedToMe && (!route.manager_id || belongs(route))) return true;
    return belongs(route);
};

function routeStore(rows = analyticsRoutes) {
    const reads = [];
    const matches = (route, filter) => Object.entries(filter).every(([key, value]) => (
        Array.isArray(value) ? value.includes(route[key]) : value?.$in ? value.$in.includes(route[key]) : route[key] === value
    ));
    const readRoutes = async (filter, limit, fields) => {
        const out = rows.filter(route => matches(route, filter)).slice(0, limit)
            .map(route => Object.fromEntries(fields.filter(field => field in route).map(field => [field, route[field]])));
        reads.push({ filter, limit, fields, bytes: JSON.stringify(out).length });
        return out;
    };
    return { reads, readRoutes };
}

const dedupe = rows => [...new Map(rows.map(row => [row.id, row])).values()];

test('analytics route reads return the same routes as three full reads', async () => {
    const naive = routeStore();
    const { filters } = listFilters();
    const fullRows = (await Promise.all(filters.map(filter => naive.readRoutes(filter, 500, ANALYTICS_ROUTE_FIELDS)))).flat();
    const trimmed = routeStore();
    const rows = await fetchAnalyticsRouteRows(trimmed.readRoutes, { ...listFilters(), isVisible });

    assert.deepEqual(dedupe(rows).filter(isVisible), dedupe(fullRows).filter(isVisible));
    assert.deepEqual(dedupe(rows).filter(isVisible).map(route => route.id), ['tenant-1', 'legacy-assigned', 'tenant-2', 'legacy-created']);
    // Only the tenant read and the by-id fill-in carry full rows.
    assert.deepEqual(trimmed.reads.map(read => read.fields === ANALYTICS_ROUTE_FIELDS), [false, true, false, true]);
    assert.deepEqual(trimmed.reads[0].fields, ANALYTICS_ROUTE_SCOPE_FIELDS);
    assert.deepEqual(trimmed.reads[3].filter, { id: { $in: ['legacy-assigned', 'legacy-created'] } });
    assert.ok(trimmed.reads.reduce((sum, read) => sum + read.bytes, 0) < naive.reads.reduce((sum, read) => sum + read.bytes, 0));
});

test('analytics route reads skip the fill-in when the tenant read already has every route', async () => {
    const store = routeStore(analyticsRoutes.filter(route => !route.id.startsWith('legacy')));
    const rows = await fetchAnalyticsRouteRows(store.readRoutes, { ...listFilters(), isVisible });
    assert.equal(store.reads.length, 3);
    assert.deepEqual(dedupe(rows).filter(isVisible).map(route => route.id), ['tenant-1', 'tenant-2']);
    assert.ok(rows.every(route => 'property_hashes' in route));
});

test('analytics route reads keep a group whole when a visible row has no id, and reps read in full', async () => {
    const noId = { manager_id: 'manager', assigned_to: 'member-1', created_by: 'boss@example.com', created_date: '2026-10-06', property_hashes: ['z'] };
    const store = routeStore([...analyticsRoutes, noId]);
    const rows = await fetchAnalyticsRouteRows(store.readRoutes, { ...listFilters(), isVisible });
    assert.ok(rows.some(route => !route.id && route.property_hashes?.[0] === 'z'));
    assert.deepEqual(store.reads.map(read => read.fields === ANALYTICS_ROUTE_FIELDS), [false, true, false, true, true]);

    const rep = routeStore();
    const repRows = await fetchAnalyticsRouteRows(rep.readRoutes, { filters: [{ assigned_to: repIds }], tenantFilter: null, isVisible });
    assert.equal(rep.reads.length, 1);
    assert.equal(rep.reads[0].fields, ANALYTICS_ROUTE_FIELDS);
    assert.ok(repRows.every(route => 'property_hashes' in route));
});

test('List reads saved routes through the trimmed helper with its visibility rule', () => {
    const source = read('src/pages/List.jsx');
    assert.match(source, /fetchAnalyticsRouteRows\(\(filter, limit, fields\) => withReadDeadline\(\(\) => \(\s*base44\.entities\.SavedRoute\.filter\(filter, '-created_date', limit, 0, fields\)/);
    assert.match(source, /if \(tenantManagerId\) filters\.push\(tenantFilter = \{ manager_id: tenantManagerId \}\);/);
    assert.match(source, /return dedupeEntities\(rows\)\.filter\(isVisible\);/);
    assert.doesNotMatch(source, /SavedRoute\.filter\(\{ created_by: user\.email \}/);
});
