import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOMEDATA_DATASET_ID, HOMEDATA_DATASET_URL, HOMEDATA_EXPECTED_ROWS, MARYLAND_TILE_COUNT, resolveBuildState,
} from '../scripts/canvas-evidence/statewide/build-state.mjs';
import { workerStartupRecord } from '../scripts/canvas-evidence/statewide/maryland-build-worker.mjs';

function state(chunks = []) {
  const rows = chunks.reduce((sum, chunk) => sum + chunk.rows, 0);
  return {
    schema: 'firstknock.canvas-statewide-build-state', schema_version: 1, revision: 311,
    phases: { '01_overture_address': { status: 'complete' }, '02_overture_building': { status: 'complete' }, '03_overture_place': { status: 'complete' }, '04_homedata': { status: 'running' } },
    sources: {
      overture_address: { status: 'complete' }, overture_building: { status: 'complete' }, overture_place: { status: 'complete' },
      homedata: { dataset_id: HOMEDATA_DATASET_ID, dataset_url: HOMEDATA_DATASET_URL, query: { filter: null, order: ':id' }, upstream_count: HOMEDATA_EXPECTED_ROWS, offset: rows, rows, chunks },
    },
    compiler: { expected_tiles: MARYLAND_TILE_COUNT, completed_tiles: 0, failures: 0 },
  };
}

const hash = 'a'.repeat(64);
const chunk = { object_key: `canvas-source-artifacts/maryland/statewide-v1/homedata/chunks/000000-${hash}.ndjson`, offset_start: 0, offset_end: 5000, rows: 5000, sha256: hash };

test('declares the durable R2 startup contract before checkpoint verification', () => {
  assert.deepEqual(workerStartupRecord(), {
    event: 'worker_starting',
    phase: '04_homedata',
    dataset: 'ed4q-f8tm',
    expected_rows: 2_440_779,
    state_authority: 'r2',
  });
});

test('resolves the next statewide HomeData offset from contiguous R2 journal chunks', () => {
  const result = resolveBuildState(state([chunk]));
  assert.equal(result.next_missing_offset, 5000);
  assert.equal(result.retained_chunks, 1);
  assert.equal(result.expected_rows, 2_440_779);
  assert.equal(result.expected_tiles, 2_144);
});

test('rejects the Montgomery County filtered HomeData view', () => {
  const input = state([chunk]);
  input.sources.homedata.dataset_id = 'kb22-is2w';
  assert.throws(() => resolveBuildState(input), /ed4q-f8tm/);
});

test('rejects a gap instead of restarting or skipping retained HomeData', () => {
  const input = state([chunk, { ...chunk, object_key: chunk.object_key.replace('000000', '000001'), offset_start: 10_000, offset_end: 15_000 }]);
  input.sources.homedata.offset = 10_000;
  input.sources.homedata.rows = 10_000;
  assert.throws(() => resolveBuildState(input), /not contiguous/);
});