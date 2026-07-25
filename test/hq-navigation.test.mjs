import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_HQ_SECTION,
  hashForSection,
  HQ_SECTION_IDS,
  nextSectionForKey,
  sectionFromHash,
} from '../src/admin/hqNavigation.js';

test('HQ section hashes resolve every real panel and fail closed to Field', () => {
  assert.equal(DEFAULT_HQ_SECTION, 'field');
  assert.deepEqual(HQ_SECTION_IDS, [
    'field',
    'revenue',
    'pulse',
    'cash',
    'leaderboard',
    'live',
    'customers',
    'operations',
  ]);
  for (const sectionId of HQ_SECTION_IDS) {
    assert.equal(sectionFromHash(`#${sectionId}`), sectionId);
    assert.equal(hashForSection(sectionId), `#${sectionId}`);
  }
  assert.equal(sectionFromHash(''), 'field');
  assert.equal(sectionFromHash('#unknown'), 'field');
  assert.equal(hashForSection('unknown'), '#field');
});

test('HQ tab keyboard navigation wraps and supports Home and End', () => {
  assert.equal(nextSectionForKey('field', 'ArrowLeft'), 'operations');
  assert.equal(nextSectionForKey('operations', 'ArrowRight'), 'field');
  assert.equal(nextSectionForKey('pulse', 'ArrowRight'), 'cash');
  assert.equal(nextSectionForKey('pulse', 'ArrowLeft'), 'revenue');
  assert.equal(nextSectionForKey('cash', 'Home'), 'field');
  assert.equal(nextSectionForKey('cash', 'End'), 'operations');
  assert.equal(nextSectionForKey('cash', 'ArrowDown'), null);
});
