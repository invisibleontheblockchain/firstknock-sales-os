#!/usr/bin/env node
import { R2Client } from './r2-client.mjs';
import { loadLatestBuildState, resolveBuildState } from './build-state.mjs';
import { runHomeDataWorker } from './homedata-worker.mjs';

export function workerStartupRecord() {
  return {
    event: 'worker_starting',
    phase: '04_homedata',
    dataset: 'ed4q-f8tm',
    expected_rows: 2_440_779,
    state_authority: 'r2',
  };
}

export async function runMarylandBuildWorker(argv = process.argv.slice(2), dependencies = {}) {
  const r2 = dependencies.r2 || new R2Client();
  if (argv.includes('--status')) return resolveBuildState(await loadLatestBuildState(r2));
  const log = dependencies.log || console.log;
  log(JSON.stringify(workerStartupRecord()));
  const state = await runHomeDataWorker({ r2, once: argv.includes('--once'), fetchImpl: dependencies.fetchImpl || fetch, log });
  const status = resolveBuildState(state);
  if (status.homedata_rows === status.expected_rows && status.completed_tiles < status.expected_tiles) {
    throw new Error('HomeData is complete; statewide input partition orchestration must be restored before tile compilation can start.');
  }
  return status;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) runMarylandBuildWorker().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });