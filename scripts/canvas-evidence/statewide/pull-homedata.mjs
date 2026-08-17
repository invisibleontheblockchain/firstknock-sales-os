#!/usr/bin/env node
// Resumable statewide Maryland SDAT HomeData pull (Socrata), checkpointed to R2.
// Usage: node pull-homedata.mjs <output.ndjson>
// Resume state lives in <output>.state.json; the finished artifact is uploaded
// immutably so a sandbox recycle never loses a completed pull.
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileHash, headObject, putObject } from './r2-object.mjs';

const DATASET_URL = 'https://opendata.maryland.gov/resource/kb22-is2w.json';
const PAGE_SIZE = 50000;
const ARTIFACT_KEY = 'canvas-source-artifacts/maryland/statewide-v1/homedata/statewide.ndjson';

async function fetchPage(offset) {
  const url = `${DATASET_URL}?$limit=${PAGE_SIZE}&$offset=${offset}&$order=:id`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(url, { redirect: 'manual' });
    if (response.status === 200) return response.json();
    await response.arrayBuffer().catch(() => {});
    if (attempt === 5) throw new Error(`HomeData page failed at offset ${offset}: HTTP ${response.status}`);
    await new Promise((wait) => setTimeout(wait, attempt * 5000));
  }
  return [];
}

async function main() {
  const outputPath = resolve(process.argv[2] || '');
  if (!process.argv[2]) throw new TypeError('Usage: pull-homedata.mjs <output.ndjson>');
  const existing = await headObject(ARTIFACT_KEY);
  if (existing) {
    process.stdout.write(`${JSON.stringify({ done: true, status: 'checkpoint_exists', key: ARTIFACT_KEY, ...existing })}\n`);
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const statePath = `${outputPath}.state.json`;
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { offset: 0, rows: 0 };
  const stream = createWriteStream(outputPath, { flags: state.offset > 0 ? 'a' : 'w' });
  for (;;) {
    const rows = await fetchPage(state.offset);
    if (!rows.length) break;
    stream.write(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    state = { offset: state.offset + rows.length, rows: state.rows + rows.length };
    writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(`homedata rows=${state.rows}\n`);
    if (rows.length < PAGE_SIZE) break;
  }
  await new Promise((done) => stream.end(done));
  const sha256 = await fileHash(outputPath);
  const uploaded = await putObject(outputPath, ARTIFACT_KEY);
  process.stdout.write(`${JSON.stringify({ done: true, rows: state.rows, sha256, uploaded })}\n`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });