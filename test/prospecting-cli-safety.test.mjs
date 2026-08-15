import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workspace = resolve(import.meta.dirname, '..');
const cli = resolve(workspace, 'scripts/prospecting/cli.mjs');

function prospect(overrides = {}) {
  return {
    id: 'person-1',
    first_name: 'Jordan',
    last_name: 'Example',
    title: 'Owner',
    email: 'jordan@desertpest.example',
    email_status: 'verified',
    residential_evidence: 'Residential pest-control services page',
    residential_evidence_url: 'https://desertpest.example/residential',
    d2d_evidence: 'Canvassing representative job listing',
    d2d_evidence_url: 'https://desertpest.example/careers/canvassing',
    target_company_id: 'org-1',
    person_organization_id: 'org-1',
    organization: {
      name: 'Desert Pest Example',
      primary_domain: 'desertpest.example',
      estimated_num_employees: 18,
    },
    ...overrides,
  };
}

async function fixtureDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'firstknock-prospect-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      HUNTER_API_KEY: '',
      MILLIONVERIFIER_API_KEY: '',
      APOLLO_API_KEY: '',
    },
  });
}

test('ingest fails closed when the suppression file is missing', async (t) => {
  const directory = await fixtureDirectory(t);
  const input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify([prospect()]), 'utf8');
  const result = runCli([
    'ingest', '--input', input,
    '--suppression', join(directory, 'missing.csv'),
    '--output-dir', join(directory, 'output'),
    '--verifier', 'none',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Suppression file not found/);
});

test('eligible verifier calls require an exact explicit spend confirmation', async (t) => {
  const directory = await fixtureDirectory(t);
  const input = join(directory, 'input.json');
  const suppression = join(directory, 'suppression.csv');
  await writeFile(input, JSON.stringify([prospect()]), 'utf8');
  await writeFile(suppression, 'email,domain,reason,opted_out_at\n', 'utf8');
  const result = runCli([
    'ingest', '--input', input,
    '--suppression', suppression,
    '--output-dir', join(directory, 'output'),
    '--verifier', 'hunter',
    '--max-verifications', '1',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /confirm-verification-spend/);
});

test('an imported opt-out never reaches a configured verifier', async (t) => {
  const directory = await fixtureDirectory(t);
  const input = join(directory, 'input.json');
  const suppression = join(directory, 'suppression.csv');
  const output = join(directory, 'output');
  await writeFile(input, JSON.stringify([prospect({
    suppression_status: 'opted_out',
    suppression_reason: 'recipient request',
    opted_out_at: '2026-08-01T00:00:00Z',
  })]), 'utf8');
  await writeFile(suppression, 'email,domain,reason,opted_out_at\n', 'utf8');
  const args = [
    'ingest', '--input', input,
    '--suppression', suppression,
    '--output-dir', output,
    '--verifier', 'hunter',
  ];
  const result = runCli(args);
  const concurrentSecond = runCli(args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(concurrentSecond.status, 0, concurrentSecond.stderr);
  const runDirectories = await readdir(output);
  assert.equal(runDirectories.length, 2);
  for (const runDirectory of runDirectories) {
    const report = JSON.parse(await readFile(join(output, runDirectory, 'run-report.json'), 'utf8'));
    assert.equal(report.vendor_addresses_submitted, 0);
    assert.equal(report.counts.rejected, 1);
  }
});
