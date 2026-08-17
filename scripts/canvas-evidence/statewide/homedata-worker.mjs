import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BUILD_PREFIX, HOMEDATA_CHUNK_ROWS, HOMEDATA_DATASET_URL, HOMEDATA_EXPECTED_ROWS,
  commitBuildState, loadLatestBuildState, resolveBuildState,
} from './build-state.mjs';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchJson(url, fetchImpl, label) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetchImpl(url, { redirect: 'manual' });
    if (response.status === 200) return response.json();
    await response.arrayBuffer().catch(() => {});
    if (attempt === 5) throw new Error(`${label} failed: HTTP ${response.status}`);
    await sleep(attempt * 5_000);
  }
}

export async function verifyHomeDataCheckpoint(r2, state, { verifyLastBody = true } = {}) {
  const chunks = state.sources.homedata.chunks;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(12, chunks.length || 1) }, async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      const info = await r2.head(chunk.object_key);
      if (!info || info.sha256 !== chunk.sha256) throw new Error(`Missing or unverified HomeData chunk: ${chunk.object_key}`);
    }
  });
  await Promise.all(workers);
  if (verifyLastBody && chunks.length) {
    const last = chunks.at(-1);
    const directory = await mkdtemp(join(tmpdir(), 'firstknock-md-last-chunk-'));
    try { await r2.download(last.object_key, join(directory, 'last.ndjson'), last.sha256); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  return resolveBuildState(state);
}

export async function pullNextHomeDataChunk({ r2, state, fetchImpl = fetch, now = new Date() }) {
  const resolved = resolveBuildState(state);
  if (resolved.homedata_rows === HOMEDATA_EXPECTED_ROWS) return state;
  const countUrl = new URL(HOMEDATA_DATASET_URL);
  countUrl.searchParams.set('$select', 'count(*)');
  const countRows = await fetchJson(countUrl, fetchImpl, 'HomeData statewide count');
  const upstreamCount = Number(countRows?.[0]?.count);
  if (upstreamCount !== HOMEDATA_EXPECTED_ROWS) throw new Error(`HomeData statewide count changed: expected ${HOMEDATA_EXPECTED_ROWS}, received ${upstreamCount}.`);

  const url = new URL(HOMEDATA_DATASET_URL);
  url.searchParams.set('$limit', String(HOMEDATA_CHUNK_ROWS));
  url.searchParams.set('$offset', String(resolved.next_missing_offset));
  url.searchParams.set('$order', ':id');
  const rows = await fetchJson(url, fetchImpl, `HomeData offset ${resolved.next_missing_offset}`);
  const expected = Math.min(HOMEDATA_CHUNK_ROWS, HOMEDATA_EXPECTED_ROWS - resolved.next_missing_offset);
  if (!Array.isArray(rows) || rows.length !== expected) throw new Error(`HomeData offset ${resolved.next_missing_offset} returned ${rows?.length ?? 'invalid'} rows; expected ${expected}.`);

  const body = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const hash = createHash('sha256').update(body).digest('hex');
  const index = state.sources.homedata.chunks.length;
  const key = `${BUILD_PREFIX}/homedata/chunks/${String(index).padStart(6, '0')}-${hash}.ndjson`;
  const directory = await mkdtemp(join(tmpdir(), 'firstknock-md-homedata-'));
  try {
    const local = join(directory, 'chunk.ndjson');
    const verified = join(directory, 'verified.ndjson');
    await writeFile(local, body);
    await r2.put(local, key, { immutable: true });
    await r2.download(key, verified, hash);
    if ((await readFile(verified)).byteLength !== Buffer.byteLength(body)) throw new Error(`HomeData byte verification failed for ${key}.`);
  } finally { await rm(directory, { recursive: true, force: true }); }

  const offsetEnd = resolved.next_missing_offset + rows.length;
  const complete = offsetEnd === HOMEDATA_EXPECTED_ROWS;
  const next = {
    ...state,
    phases: { ...state.phases, '04_homedata': { status: complete ? 'complete' : 'running' } },
    sources: {
      ...state.sources,
      homedata: {
        ...state.sources.homedata,
        status: complete ? 'complete' : 'running', offset: offsetEnd, rows: offsetEnd,
        chunks: [...state.sources.homedata.chunks, { object_key: key, offset_start: resolved.next_missing_offset, offset_end: offsetEnd, rows: rows.length, sha256: hash }],
      },
    },
  };
  return commitBuildState(r2, state, next, now);
}

export async function runHomeDataWorker({ r2, once = false, fetchImpl = fetch, log = console.log }) {
  let state = await loadLatestBuildState(r2);
  const before = await verifyHomeDataCheckpoint(r2, state);
  log(JSON.stringify({ event: 'checkpoint_verified', ...before }));
  while (resolveBuildState(state).homedata_rows < HOMEDATA_EXPECTED_ROWS) {
    state = await pullNextHomeDataChunk({ r2, state, fetchImpl });
    log(JSON.stringify({ event: 'checkpoint_advanced', ...resolveBuildState(state) }));
    if (once) break;
  }
  return state;
}