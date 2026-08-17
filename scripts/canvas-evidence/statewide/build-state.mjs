import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const BUILD_PREFIX = 'canvas-source-artifacts/maryland/statewide-v1';
export const STATE_KEY = `${BUILD_PREFIX}/build-state.json`;
export const REVISION_PREFIX = `${BUILD_PREFIX}/state-revisions/`;
export const HOMEDATA_DATASET_ID = 'ed4q-f8tm';
export const HOMEDATA_DATASET_URL = 'https://opendata.maryland.gov/resource/ed4q-f8tm.json';
export const HOMEDATA_EXPECTED_ROWS = 2_440_779;
export const HOMEDATA_CHUNK_ROWS = 5_000;
export const MARYLAND_TILE_COUNT = 2_144;

function assert(condition, message) { if (!condition) throw new TypeError(message); }

export function resolveBuildState(state) {
  const source = state?.sources?.homedata;
  assert(state?.schema === 'firstknock.canvas-statewide-build-state' && state?.schema_version === 1, 'Unsupported Maryland build state.');
  assert(source?.dataset_id === HOMEDATA_DATASET_ID && source?.dataset_url === HOMEDATA_DATASET_URL, 'HomeData must use the ed4q-f8tm statewide dataset.');
  assert(source?.query?.filter === null && source?.query?.order === ':id', 'HomeData query must be the unfiltered statewide :id order.');
  assert(source?.upstream_count === HOMEDATA_EXPECTED_ROWS, `HomeData expected total must be ${HOMEDATA_EXPECTED_ROWS}.`);
  assert(state?.compiler?.expected_tiles === MARYLAND_TILE_COUNT, `Maryland compiler must expect ${MARYLAND_TILE_COUNT} tiles.`);
  for (const name of ['overture_address', 'overture_building', 'overture_place']) assert(state?.sources?.[name]?.status === 'complete', `${name} is not complete.`);
  let offset = 0;
  for (const [index, chunk] of (source.chunks || []).entries()) {
    assert(chunk.offset_start === offset, `HomeData chunk ${index} is not contiguous.`);
    assert(chunk.offset_end - chunk.offset_start === chunk.rows, `HomeData chunk ${index} has inconsistent bounds.`);
    assert(chunk.rows > 0 && chunk.rows <= HOMEDATA_CHUNK_ROWS, `HomeData chunk ${index} has an invalid row count.`);
    assert(chunk.object_key?.includes(`/chunks/${String(index).padStart(6, '0')}-`) && chunk.object_key.endsWith(`-${chunk.sha256}.ndjson`), `HomeData chunk ${index} has an invalid immutable key.`);
    offset = chunk.offset_end;
  }
  assert(source.offset === offset && source.rows === offset, 'HomeData rows/offset do not match the retained contiguous chunks.');
  assert(offset <= HOMEDATA_EXPECTED_ROWS, 'HomeData progress exceeds the statewide total.');
  return Object.freeze({
    revision: state.revision,
    homedata_rows: offset,
    expected_rows: HOMEDATA_EXPECTED_ROWS,
    retained_chunks: source.chunks.length,
    next_missing_offset: offset,
    completed_tiles: state.compiler.completed_tiles,
    expected_tiles: MARYLAND_TILE_COUNT,
    failures: state.compiler.failures,
  });
}

function revisionNumber(key) { return Number((key.match(/state-revisions\/(\d+)\.json$/) || [])[1] || 0); }

export async function loadLatestBuildState(r2) {
  const revisions = (await r2.list(REVISION_PREFIX)).sort((left, right) => revisionNumber(right.key) - revisionNumber(left.key));
  const key = revisions[0]?.key || STATE_KEY;
  const info = await r2.head(key);
  if (!info?.sha256) throw new Error(`R2 state object is missing verified SHA-256 metadata: ${key}`);
  const directory = await mkdtemp(join(tmpdir(), 'firstknock-md-state-'));
  try {
    const path = join(directory, 'state.json');
    await r2.download(key, path, info.sha256);
    const state = JSON.parse(await readFile(path, 'utf8'));
    resolveBuildState(state);
    return state;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function commitBuildState(r2, priorState, update, now = new Date()) {
  const directory = await mkdtemp(join(tmpdir(), 'firstknock-md-state-write-'));
  try {
    for (let revision = Number(priorState.revision || 0) + 1; revision < Number(priorState.revision || 0) + 10_000; revision += 1) {
      const state = { ...update, revision, updated_at: now.toISOString() };
      const path = join(directory, `${String(revision).padStart(8, '0')}.json`);
      await writeFile(path, JSON.stringify(state));
      const key = `${REVISION_PREFIX}${String(revision).padStart(8, '0')}.json`;
      try {
        await r2.put(path, key, { immutable: true });
        await r2.put(path, STATE_KEY, { immutable: false });
        return state;
      } catch (error) {
        if (error.code !== 'R2_OBJECT_EXISTS') throw error;
      }
    }
    throw new Error('Unable to allocate a collision-safe Maryland state revision.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}