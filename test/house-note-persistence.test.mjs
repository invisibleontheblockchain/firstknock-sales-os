import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  OUTCOME_COLORS,
  OUTCOME_OPTIONS,
  latestOutcomeNote,
  outcomeBorder,
  outcomeShortLabel,
  outcomeTint
} from '../src/components/logic/outcomeStatus.js';

const readSource = (relativePath) => fs.readFileSync(path.resolve(relativePath), 'utf8');

const log = (overrides = {}) => ({
  address_hash: 'hash-a',
  parsed_status: 'NO_ANSWER',
  created_date: '2026-07-25T18:00:00.000Z',
  ...overrides
});

// Acceptance: a note saved on Property A must never surface on Property B.
test('a house note is read only from that house\'s own logs', () => {
  const houseA = [log({ description: 'gate code 4412' })];
  const houseB = [log({ address_hash: 'hash-b', description: 'dog in yard' })];

  assert.equal(latestOutcomeNote(houseA), 'gate code 4412');
  assert.equal(latestOutcomeNote(houseB), 'dog in yard');
  assert.equal(latestOutcomeNote([]), '');
});

// Acceptance: editing a note persists — outcomes are append-only, so the most
// recent row carrying a note wins.
test('the newest note wins when a house has been logged more than once', () => {
  const logs = [
    log({ description: 'first pass', created_date: '2026-07-25T18:00:00.000Z' }),
    log({ description: 'corrected note', created_date: '2026-07-25T19:30:00.000Z' }),
    log({ description: 'middle', created_date: '2026-07-25T18:45:00.000Z' })
  ];
  assert.equal(latestOutcomeNote(logs), 'corrected note');
});

test('outcomes logged without a note do not erase an earlier one', () => {
  const logs = [
    log({ description: 'ask for Maria', created_date: '2026-07-25T18:00:00.000Z' }),
    log({ created_date: '2026-07-25T19:00:00.000Z' }),
    log({ description: '   ', created_date: '2026-07-25T20:00:00.000Z' }),
    log({ description: null, created_date: '2026-07-25T21:00:00.000Z' })
  ];
  assert.equal(latestOutcomeNote(logs), 'ask for Maria');
});

// Acceptance: existing checklist entries without details still render safely.
test('missing, malformed, and empty log sets are safe', () => {
  assert.equal(latestOutcomeNote(undefined), '');
  assert.equal(latestOutcomeNote([{}, null, { description: 42 }]), '');
});

test('notes are trimmed so whitespace is not mistaken for content', () => {
  assert.equal(latestOutcomeNote([log({ description: '  side door  ' })]), 'side door');
});

// The knock tab is the source of truth for status colour; the checklist must
// not carry its own near-duplicate palette.
test('the checklist renders outcomes from the shared status source', () => {
  const checklist = readSource('src/components/routes/RouteChecklist.jsx');

  assert.match(checklist, /from '\.\.\/logic\/outcomeStatus'/);
  assert.doesNotMatch(checklist, /const STATUS_OPTIONS = \[/);
  assert.doesNotMatch(checklist, /const STATUS_COLORS = \{/);

  // Equivalent statuses share the knock tab's values.
  const knock = readSource('src/components/rep/PropertyDetailSheet.jsx');
  for (const option of OUTCOME_OPTIONS) {
    assert.equal(OUTCOME_COLORS[option.id], option.color);
    assert.ok(
      knock.includes(option.color),
      `${option.id} colour ${option.color} should match the knock tab`
    );
  }
});

test('white reads as a surface tint rather than a transparent accent', () => {
  assert.equal(outcomeTint('#FFFFFF'), 'rgba(255,255,255,0.055)');
  assert.equal(outcomeBorder('#FFFFFF'), 'rgba(255,255,255,0.14)');
  assert.equal(outcomeTint('#39FF4A', '18'), '#39FF4A18');
  assert.equal(outcomeBorder('#39FF4A', '30'), '#39FF4A30');
});

// Colour must not be the only signal that a stop is done.
test('every outcome carries a text label alongside its colour', () => {
  for (const option of OUTCOME_OPTIONS) {
    assert.ok(option.label && option.label.trim().length > 0);
    assert.ok(outcomeShortLabel(option.id).length > 0);
  }
  assert.equal(outcomeShortLabel('NO_ANSWER'), 'N/A');
  assert.equal(outcomeShortLabel('SOLD'), 'SOLD');
});

// The note is keyed by the canonical property id, never by list position.
test('the checklist keys note drafts and history by address_hash', () => {
  const checklist = readSource('src/components/routes/RouteChecklist.jsx');

  assert.match(checklist, /houseNotes\[prop\.address_hash\]/);
  assert.match(checklist, /\[prop\.address_hash\]: e\.target\.value/);
  assert.match(checklist, /logsByProperty\.get\(property\?\.address_hash\)/);
  assert.doesNotMatch(checklist, /houseNotes\[idx\]|houseNotes\[index\]/);
});

// A rejected write must not leave the interface claiming the note was saved.
test('a failed outcome keeps the note draft instead of reporting success', () => {
  const checklist = readSource('src/components/routes/RouteChecklist.jsx');

  assert.match(checklist, /if \(saved === false\) return false;\s*\n\s*clearHouseNote\(property\.address_hash\)/);
});
