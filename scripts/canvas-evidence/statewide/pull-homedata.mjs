#!/usr/bin/env node
// Compatibility entry point for the durable R2-authoritative Maryland worker.
import { R2Client } from './r2-client.mjs';
import { runHomeDataWorker } from './homedata-worker.mjs';

runHomeDataWorker({ r2: new R2Client(), once: process.argv.includes('--once') })
  .then((state) => process.stdout.write(`${JSON.stringify({ done: state.sources.homedata.status === 'complete', rows: state.sources.homedata.rows, revision: state.revision })}\n`))
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });