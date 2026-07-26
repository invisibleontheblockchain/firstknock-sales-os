import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { isHouseNoteLog, withoutHouseNotes } from '../src/components/logic/outcomeStatus.js';

const readSource = (relativePath) => fs.readFileSync(path.resolve(relativePath), 'utf8');

const outcome = (status, at, extra = {}) => ({
  address_hash: 'hash-a',
  parsed_status: status,
  created_date: at,
  ...extra
});

const houseNote = (at, description = 'gate code 4412') => ({
  address_hash: 'hash-a',
  source: 'house_note',
  description,
  created_date: at,
  counts_as_knock: false,
  counts_toward_free_limit: false,
  workflow_action: 'HOUSE_NOTE'
});

test('a house note is recognised and filtered out of decision logs', () => {
  assert.equal(isHouseNoteLog(houseNote('2026-07-25T19:00:00.000Z')), true);
  assert.equal(isHouseNoteLog(outcome('SOLD', '2026-07-25T18:00:00.000Z')), false);
  assert.equal(isHouseNoteLog(null), false);
  assert.deepEqual(withoutHouseNotes(null), []);
  assert.deepEqual(withoutHouseNotes(undefined), []);
});

// The whole point of the isolation: a note is saved *after* the outcome, so a
// naive "latest log wins" would reopen a house the rep already closed.
test('a note saved after a sale is not the latest decision', () => {
  const logs = [
    outcome('SOLD', '2026-07-25T18:00:00.000Z'),
    houseNote('2026-07-25T19:00:00.000Z')
  ];

  const decisions = withoutHouseNotes(logs);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].parsed_status, 'SOLD');
});

test('a note on an otherwise untouched house leaves no decision behind', () => {
  assert.deepEqual(withoutHouseNotes([houseNote('2026-07-25T19:00:00.000Z')]), []);
});

test('filtering keeps every real decision, including non-metered workflow rows', () => {
  const logs = [
    outcome('SOLD', '2026-07-25T17:00:00.000Z'),
    outcome('ELIGIBLE', '2026-07-25T18:00:00.000Z', {
      counts_as_knock: false,
      workflow_action: 'CLEAR_TO_TODO'
    }),
    houseNote('2026-07-25T20:00:00.000Z')
  ];

  const decisions = withoutHouseNotes(logs);
  assert.equal(decisions.length, 2);
  assert.equal(decisions.some(isHouseNoteLog), false);
  assert.equal(decisions[1].workflow_action, 'CLEAR_TO_TODO');
});

// territoryLogic is .jsx so it cannot be imported here; assert it routes every
// status derivation through the filter rather than the raw log array.
test('both status derivations run on decision logs, never raw logs', () => {
  const territory = readSource('src/components/logic/territoryLogic.jsx');

  assert.match(territory, /import \{ withoutHouseNotes \} from '\.\/outcomeStatus\.js'/);

  const effective = territory.slice(
    territory.indexOf('export const determineEffectiveStatus'),
    territory.indexOf('export const getPropertyResultSummary')
  );
  assert.match(effective, /const decisionLogs = withoutHouseNotes\(logs\)/);
  assert.match(effective, /if \(decisionLogs\.length === 0\)/);
  assert.match(effective, /\[\.\.\.decisionLogs\]\.sort/);
  // No path inside the derivation may still read the unfiltered array.
  assert.doesNotMatch(effective, /\[\.\.\.logs\]\.sort/);
  assert.doesNotMatch(effective, /!logs \|\| logs\.length === 0/);

  const summary = territory.slice(territory.indexOf('export const getPropertyResultSummary'));
  assert.match(summary, /const decisionLogs = withoutHouseNotes\(logs\)/);
  assert.match(summary, /\[\.\.\.decisionLogs\]\.sort/);
  assert.doesNotMatch(summary, /\[\.\.\.logs\]\.sort/);
});
