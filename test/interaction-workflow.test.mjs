import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { filterKnockActivityLogs, isKnockActivityLog } from '../src/lib/interactionLogs.js';

test('only explicit workflow transitions are excluded from knock analytics', () => {
  const legacyKnock = { id: 'legacy' };
  const currentKnock = { id: 'knock', counts_as_knock: true };
  const workflowMove = { id: 'move', counts_as_knock: false, workflow_action: 'BULK_MOVE_TO_TODO' };

  assert.equal(isKnockActivityLog(legacyKnock), true);
  assert.equal(isKnockActivityLog(currentKnock), true);
  assert.equal(isKnockActivityLog(workflowMove), false);
  assert.deepEqual(filterKnockActivityLogs([legacyKnock, workflowMove, currentKnock]).map((log) => log.id), ['legacy', 'knock']);
});

test('InteractionLog schema keeps sale snapshots and workflow metadata tenant-scoped on one record', () => {
  const schema = readFileSync(new URL('../base44/entities/InteractionLog.jsonc', import.meta.url), 'utf8');

  for (const field of [
    'sale_date',
    'property_address',
    'homeowner_name',
    'rep_id',
    'rep_name',
    'route_name',
    'counts_as_knock',
    'workflow_action',
    'workflow_bucket',
  ]) {
    assert.match(schema, new RegExp(`"${field}"`));
  }
  assert.match(schema, /"sale_amount"[\s\S]*?"minimum": 0/);
});

test('workflow transitions stay out of analytics, dispatch scoring, optimization, and model training', () => {
  const sources = [
    '../src/pages/List.jsx',
    '../src/pages/AdminTeam.jsx',
    '../src/components/dashboard/CommandCenterDashboard.jsx',
    '../src/pages/Home.jsx',
    '../src/components/logic/routeOptimizer.jsx',
    '../base44/functions/generateCoachingTips/entry.ts',
    '../base44/functions/trainLeadPredictor/entry.ts',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

  for (const source of sources.slice(0, 5)) assert.match(source, /isKnockActivityLog|filterKnockActivityLogs/);
  for (const source of sources.slice(5)) assert.match(source, /counts_as_knock !== false/);
});

test('both manager and rep sale writes keep durable snapshots and wait for persistence', () => {
  const repHome = readFileSync(new URL('../src/pages/RepHome.jsx', import.meta.url), 'utf8');
  const managerHome = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');

  for (const source of [repHome, managerHome]) {
    for (const field of ['sale_date', 'property_address', 'homeowner_name', 'rep_id', 'rep_name', 'route_name']) {
      assert.match(source, new RegExp(field));
    }
    assert.match(source, /mutateAsync/);
  }
});
