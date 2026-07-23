import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ROUTE_BULK_ACTIONS,
  buildWorkflowTransitionLogs,
  getLatestInteractionLog,
  getPropertyAliases,
  getVisiblePropertyKeys,
  getWorkflowBucketFromLogs,
  orderRoutePropertiesByHashes,
  pruneSelectionToProperties,
  removeSelectedRouteStops,
  resolveWorkflowEffectiveStatus,
  togglePropertySelection,
  toggleVisiblePropertySelection,
} from '../src/components/logic/routeBulkActions.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

const stops = [
  { address_hash: 'canonical-a', legacy_hash: 'legacy-a', id: 1, lat: 35, lng: -82 },
  { address_hash: 'canonical-b', legacy_hash: 'legacy-b', id: 2 },
  { address_hash: 'canonical-c', id: 3 },
];

test('Select All toggles only the currently visible filtered stops', () => {
  const initiallySelected = new Set(['canonical-b']);
  const selected = toggleVisiblePropertySelection(initiallySelected, [stops[0], stops[2]]);

  assert.deepEqual([...selected].sort(), ['canonical-a', 'canonical-b', 'canonical-c']);
  assert.deepEqual(getVisiblePropertyKeys([stops[0], stops[2]]), ['canonical-a', 'canonical-c']);

  const clearedVisible = toggleVisiblePropertySelection(selected, [stops[0], stops[2]]);
  assert.deepEqual([...clearedVisible], ['canonical-b']);
});

test('individual selection toggles and filter changes prune hidden stops', () => {
  const selected = togglePropertySelection(new Set(), stops[0]);
  assert.deepEqual([...selected], ['canonical-a']);
  assert.deepEqual([...togglePropertySelection(selected, stops[0])], []);

  const pruned = pruneSelectionToProperties(
    new Set(['canonical-a', 'canonical-b', 'canonical-c']),
    [stops[1]]
  );
  assert.deepEqual([...pruned], ['canonical-b']);
});

test('route-stop deletion preserves order and matches canonical, legacy, and id aliases', () => {
  assert.deepEqual(getPropertyAliases(stops[0]), ['canonical-a', 'legacy-a', '1']);
  const result = removeSelectedRouteStops(
    ['keep-first', 'legacy-a', 'canonical-b', '3', 'keep-last'],
    stops
  );

  assert.deepEqual(result.removedHashes, ['legacy-a', 'canonical-b', '3']);
  assert.deepEqual(result.remainingHashes, ['keep-first', 'keep-last']);
  assert.deepEqual(result.unmatchedSelectionKeys, []);

  const staleSelection = removeSelectedRouteStops(['canonical-a'], [stops[0], stops[1]]);
  assert.deepEqual(staleSelection.unmatchedSelectionKeys, ['canonical-b']);
});

test('remaining route properties are rehydrated in saved hash order before metric recalculation', () => {
  const properties = [
    { id: 'id-a', address_hash: 'canonical-a', legacy_hash: 'legacy-a', lat: 33.1, lng: -112.1 },
    { id: 'id-b', address_hash: 'canonical-b', legacy_hash: 'legacy-b', lat: 33.2, lng: -112.2 },
  ];
  const result = orderRoutePropertiesByHashes(['legacy-b', 'canonical-a', 'missing'], properties);

  assert.deepEqual(result.orderedProperties.map((property) => property.id), ['id-b', 'id-a']);
  assert.deepEqual(result.unmatchedHashes, ['missing']);
});

test('Todo and Re-Knock transitions restore eligibility without counting as knocks', () => {
  const todo = buildWorkflowTransitionLogs([stops[0]], ROUTE_BULK_ACTIONS.TODO, {
    routeId: 'route-1',
    managerId: 'manager-1',
  })[0];
  assert.equal(todo.parsed_status, 'ELIGIBLE');
  assert.equal(todo.counts_as_knock, false);
  assert.equal(todo.workflow_action, 'BULK_MOVE_TO_TODO');
  assert.equal(todo.workflow_bucket, 'TODO');
  assert.equal(todo.route_id, 'route-1');
  assert.equal(todo.manager_id, 'manager-1');
  assert.equal('gps_proof_lat' in todo, false);
  assert.equal('gps_proof_lng' in todo, false);

  const reKnock = buildWorkflowTransitionLogs([stops[1]], ROUTE_BULK_ACTIONS.RE_KNOCK)[0];
  assert.equal(reKnock.parsed_status, 'ELIGIBLE');
  assert.equal(reKnock.counts_as_knock, false);
  assert.equal(reKnock.workflow_action, 'BULK_MOVE_TO_RE_KNOCK');
  assert.equal(reKnock.workflow_bucket, 'RE_KNOCK');
  assert.equal(resolveWorkflowEffectiveStatus('COOLDOWN', [reKnock]), 'ELIGIBLE');

  const missingCoordinates = buildWorkflowTransitionLogs(
    [{ address_hash: 'no-coordinates', lat: null, lng: '' }],
    ROUTE_BULK_ACTIONS.TODO
  )[0];
  assert.equal('gps_proof_lat' in missingCoordinates, false);
  assert.equal('gps_proof_lng' in missingCoordinates, false);
});

test('Callback transitions are unscheduled workflow records', () => {
  const callback = buildWorkflowTransitionLogs([stops[2]], ROUTE_BULK_ACTIONS.CALLBACK)[0];
  assert.equal(callback.parsed_status, 'CALLBACK');
  assert.equal(callback.workflow_action, 'BULK_MOVE_TO_CALLBACK');
  assert.equal(callback.workflow_bucket, 'CALLBACK');
  assert.equal(callback.counts_as_knock, false);
  assert.equal('next_eligible_date' in callback, false);
  assert.equal(resolveWorkflowEffectiveStatus('COOLDOWN', [callback]), 'CALLBACK');
});

test('latest workflow metadata controls the visible bucket and preserves ordinary derived statuses', () => {
  const logs = [
    { created_date: '2026-07-20T12:00:00Z', parsed_status: 'NO_ANSWER' },
    {
      created_date: '2026-07-21T12:00:00Z',
      parsed_status: 'ELIGIBLE',
      counts_as_knock: false,
      workflow_action: 'BULK_MOVE_TO_RE_KNOCK',
      workflow_bucket: 'RE_KNOCK',
    },
  ];

  assert.equal(getLatestInteractionLog(logs), logs[1]);
  assert.equal(getWorkflowBucketFromLogs(logs), 'RE_KNOCK');
  assert.equal(resolveWorkflowEffectiveStatus('COOLDOWN', logs), 'ELIGIBLE');
  assert.equal(resolveWorkflowEffectiveStatus('COOLDOWN', [{
    created_date: '2026-07-22T12:00:00Z',
    parsed_status: 'ELIGIBLE',
    counts_as_knock: false,
    workflow_action: 'CLEAR_TO_TODO',
  }]), 'ELIGIBLE');
  assert.equal(resolveWorkflowEffectiveStatus('HARD_NO', [logs[0]]), 'HARD_NO');
});

test('RepHome wires accessible Done selection, bulk persistence, and the Re-Knock destination', () => {
  const repHome = readSource('src/pages/RepHome.jsx');
  const propertyCard = readSource('src/components/rep/PropertyCard.jsx');

  assert.match(repHome, /filterStatus === 'done'/);
  assert.match(repHome, /InteractionLog\.bulkCreate\(batch\)/);
  assert.match(repHome, /SavedRoute\.update\(activeRoute\.id/);
  assert.match(repHome, /workflow_action: 'CLEAR_TO_TODO'/);
  assert.match(repHome, /Re-Knock \$\{stats\.reKnock\}/);
  assert.match(repHome, /p\.workflow_bucket !== 'RE_KNOCK'/);
  assert.match(repHome, /toggleVisiblePropertySelection\(previous, filteredProperties\)/);
  assert.match(propertyCard, /type="checkbox"/);
  assert.match(propertyCard, /aria-label=\{`Select \$\{addressLabel\}`\}/);
  assert.match(propertyCard, /property\.workflow_bucket === 'RE_KNOCK'/);
});
