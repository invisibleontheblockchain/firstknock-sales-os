import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  OUTCOME_COLORS,
  OUTCOME_OPTIONS,
  findHouseNoteLog,
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
  const checklist = [readSource('src/components/routes/RouteChecklist.jsx'), readSource('src/components/routes/HouseNoteField.jsx')].join('\n');

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
  const checklist = [readSource('src/components/routes/RouteChecklist.jsx'), readSource('src/components/routes/HouseNoteField.jsx')].join('\n');

  assert.match(checklist, /houseNotes\[prop\.address_hash\]/);
  assert.match(checklist, /onChange=\{\(e\) => onChange\(property, e\.target\.value\)\}/);
  assert.match(checklist, /const addressHash = property\.address_hash/);
  assert.match(checklist, /logsByProperty\.get\(property\?\.address_hash\)/);
  assert.doesNotMatch(checklist, /houseNotes\[idx\]|houseNotes\[index\]/);
});

// The dedicated note row is authoritative, and older notes that were attached
// to an outcome still show, so nothing saved before house notes existed is lost.
test('the dedicated note row wins over a note attached to an old outcome', () => {
  const logs = [
    log({ description: 'legacy note on an outcome', created_date: '2026-07-25T18:00:00.000Z' }),
    log({
      id: 'note-1',
      source: 'house_note',
      description: 'gate code 4412',
      created_date: '2026-07-25T17:00:00.000Z'
    })
  ];

  assert.equal(findHouseNoteLog(logs)?.id, 'note-1');
  assert.equal(latestOutcomeNote(logs), 'gate code 4412');
  assert.equal(latestOutcomeNote([log({ description: 'legacy only' })]), 'legacy only');
});

test('clearing a house note empties it rather than falling back to an old outcome note', () => {
  const logs = [
    log({ description: 'stale outcome note', created_date: '2026-07-25T18:00:00.000Z' }),
    log({ source: 'house_note', description: '', created_date: '2026-07-25T19:00:00.000Z' })
  ];
  assert.equal(latestOutcomeNote(logs), '');
});

// Parity: the knock tab puts the note behind an Add Details toggle rather than
// leaving a textarea open on every row.
test('the note sits behind an Add Details button, like the knock tab', () => {
  const checklist = [readSource('src/components/routes/RouteChecklist.jsx'), readSource('src/components/routes/HouseNoteField.jsx')].join('\n');
  const knock = readSource('src/components/rep/PropertyDetailSheet.jsx');

  assert.match(knock, />\s*Add Details\s*</);
  assert.match(checklist, />\s*Add Details\s*</);

  // The toggle is per house and announced, and the field only exists when open.
  assert.match(checklist, /setDetailsOpenHash\(detailsOpen \? null : prop\.address_hash\)/);
  assert.match(checklist, /aria-expanded=\{open\}/);
  assert.match(checklist, /aria-controls=\{`house-note-panel-\$\{property\.address_hash\}`\}/);
  assert.match(checklist, /\{open && \([\s\S]{0,400}?<textarea/);
});

// A collapsed row still has to show that a note exists, without relying on colour.
test('a saved note is visible while Add Details is collapsed', () => {
  const checklist = [readSource('src/components/routes/RouteChecklist.jsx'), readSource('src/components/routes/HouseNoteField.jsx')].join('\n');

  assert.match(checklist, /\{noteBadge\}/);
  assert.match(checklist, /\{!open && savedNote &&/);
});

// Autosave: the rep types and walks away. The note must commit on a pause, on
// blur, and when the panel closes — never only on a button they may not press.
test('notes autosave on a pause and flush before they can be lost', () => {
  const checklist = [readSource('src/components/routes/RouteChecklist.jsx'), readSource('src/components/routes/HouseNoteField.jsx')].join('\n');

  assert.match(checklist, /noteTimersRef\.current\[addressHash\] = setTimeout\(/);
  assert.match(checklist, /onBlur=\{\(\) => onFlush\(property\)\}/);
  assert.match(checklist, /if \(detailsOpen\) flushHouseNote\(prop\);/);
  // Pending timers are cleared on unmount rather than firing into a dead tree.
  assert.match(checklist, /return \(\) => Object\.values\(timers\)\.forEach\(clearTimeout\)/);
});

// The interface must never claim a note was stored when the write failed.
test('a failed note save is reported, not swallowed', () => {
  const checklist = [readSource('src/components/routes/RouteChecklist.jsx'), readSource('src/components/routes/HouseNoteField.jsx')].join('\n');

  assert.match(checklist, /\[addressHash\]: 'error'/);
  assert.match(checklist, /role=\{noteState === 'error' \? 'alert' : undefined\}/);
  // The server's own reason is shown; a rejected write must not be blamed on
  // the rep's connection.
  assert.match(checklist, /error\?\.response\?\.data\?\.error/);
  assert.match(checklist, /Not saved — \$\{noteError \|\|/);
  assert.doesNotMatch(checklist, /check your connection/);
});

// The note is written by its own non-metered server action, never as an outcome.
test('the note save path is separate from outcome logging', () => {
  const checklist = [readSource('src/components/routes/RouteChecklist.jsx'), readSource('src/components/routes/HouseNoteField.jsx')].join('\n');
  const server = readSource('base44/functions/recordKnockOutcome/entry.ts');

  assert.match(checklist, /action: 'save_house_note'/);
  // An outcome never carries a note any more.
  assert.match(checklist, /const houseNotePayload = \(\) => \(\{\}\);/);

  assert.match(server, /async function saveHouseNote/);
  assert.match(server, /action === 'save_house_note'/);
  // Non-metered: autosaving a note can never consume a billed outcome.
  const noteFn = server.slice(server.indexOf('async function saveHouseNote'), server.indexOf('async function editSale'));
  assert.match(noteFn, /counts_toward_free_limit: false/);
  assert.match(noteFn, /counts_as_knock: false/);
  assert.doesNotMatch(noteFn, /enforceGate/);
  // workflow_action is an enum of route-bucket transitions; HOUSE_NOTE is not
  // one of them, and writing it is what a schema-validating backend rejects.
  assert.doesNotMatch(noteFn, /workflow_action:/);
});

// The InteractionLog schema declares required fields. A note row that omits any
// of them is rejected outright — this is what "Field required" was telling us.
test('a note row satisfies every required InteractionLog field', () => {
  const server = readSource('base44/functions/recordKnockOutcome/entry.ts');
  const schemaText = readSource('base44/entities/InteractionLog.jsonc').replace(/^\s*\/\/.*$/gm, '');
  const required = JSON.parse(schemaText).required;

  assert.deepEqual(required, ['address_hash', 'parsed_status', 'raw_input_text']);

  const noteFn = server.slice(server.indexOf('async function saveHouseNote'), server.indexOf('async function editSale'));
  const fields = noteFn.slice(noteFn.indexOf('const fields = {'), noteFn.indexOf('const saved ='));

  // Written in `fields` so updates carry them too, not only creates.
  for (const field of required) {
    assert.match(fields, new RegExp(`${field}:`), `note row must write ${field}`);
  }
  // ELIGIBLE means "no decision"; the filters keep it from ever being displayed.
  assert.match(fields, /parsed_status: 'ELIGIBLE'/);
});

// A note becomes the newest log, so any helper that reads "latest" must skip it.
test('workflow helpers read the latest decision, not the latest note', () => {
  const bulk = readSource('src/components/logic/routeBulkActions.js');

  assert.match(bulk, /import \{ withoutHouseNotes \} from '\.\/outcomeStatus\.js'/);
  assert.match(bulk, /\[\.\.\.withoutHouseNotes\(logs\)\]\.sort/);
  assert.doesNotMatch(bulk, /return \[\.\.\.logs\]\.sort/);
});

// A rejected write must not leave the interface claiming the note was saved.
test('a failed outcome keeps the note draft instead of reporting success', () => {
  const checklist = [readSource('src/components/routes/RouteChecklist.jsx'), readSource('src/components/routes/HouseNoteField.jsx')].join('\n');

  assert.match(checklist, /if \(saved === false\) return false;\s*\n\s*clearHouseNote\(property\.address_hash\)/);
});
