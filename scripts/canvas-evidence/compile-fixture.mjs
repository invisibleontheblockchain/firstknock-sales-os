import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalStringify } from './contract.mjs';
import { compileCanvasEvidenceFixture } from './compiler.mjs';
import {
  LOCAL_FIXTURE_KEY_ID,
  LOCAL_FIXTURE_PRIVATE_KEY,
  LOCAL_FIXTURE_PUBLIC_KEY,
} from './local-fixture-keys.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultFixturePath = resolve(fileURLToPath(new URL('../../test/fixtures/canvas-evidence/input.json', import.meta.url)));

export async function compileLocalFixture(fixturePath = defaultFixturePath) {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  return compileCanvasEvidenceFixture(fixture, {
    privateKey: LOCAL_FIXTURE_PRIVATE_KEY,
    publicKey: LOCAL_FIXTURE_PUBLIC_KEY,
    keyId: LOCAL_FIXTURE_KEY_ID,
  });
}

if (resolve(process.argv[1] || '') === resolve(scriptPath)) {
  const fixturePath = process.argv[2] ? resolve(process.argv[2]) : defaultFixturePath;
  const bundle = await compileLocalFixture(fixturePath);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${canonicalStringify(bundle)}\n`);
  } else {
    process.stdout.write(`Canvas evidence fixture valid: ${bundle.manifest.release.release_id}\n`);
    process.stdout.write(`Tiles: ${bundle.manifest.tiles.length}; work units: ${bundle.manifest.tiles.reduce((sum, tile) => sum + tile.work_unit_count, 0)}\n`);
    process.stdout.write(`Signing key: ${bundle.manifest.signature.key_id}\n`);
  }
}
