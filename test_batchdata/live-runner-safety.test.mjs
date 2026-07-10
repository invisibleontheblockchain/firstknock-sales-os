import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function runPlanOnly(script, args = []) {
    const result = spawnSync(process.execPath, [path.join(TEST_DIR, script), ...args], {
        cwd: path.resolve(TEST_DIR, '..'),
        encoding: 'utf8',
        env: {
            ...process.env,
            // A fake key makes the assertion stronger: absence of --confirm-live,
            // not absence of credentials, must prevent all live work.
            BATCH_DATA_API_KEY: 'x'
        }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('25-city freshness runner is plan-only unless live execution is explicit', () => {
    const plan = runPlanOnly('run-freshness-matrix.mjs', [
        '--city-filter=Phoenix,Seattle',
        '--counts-only=true',
        '--budget=25'
    ]);
    assert.equal(plan.mode, 'plan_only_no_network');
    assert.equal(plan.network_requests_made, 0);
    assert.equal(plan.live_http_budget, 25);
    assert.equal(plan.city_count, 2);
    assert.equal(plan.privacy.property_addresses_persisted, false);
    assert.equal(plan.privacy.raw_provider_payloads_persisted, false);
});

test('corrected-contract runner is plan-only unless live execution is explicit', () => {
    const plan = runPlanOnly('run-corrected-contract-probe.mjs', [
        '--mapper-evidence',
        '--budget=10'
    ]);
    assert.equal(plan.mode, 'plan_only_no_network');
    assert.equal(plan.network_requests_made, 0);
    assert.equal(plan.live_http_budget, 10);
    assert.equal(plan.requested_probe, 'mapper_evidence');
    assert.equal(plan.privacy.property_addresses_persisted, false);
    assert.equal(plan.privacy.property_ids_or_hashes_persisted, false);
});

test('house-level pipeline comparison is plan-only unless live execution is explicit', () => {
    const plan = runPlanOnly('run-pipeline-house-comparison.mjs', [
        '--as-of=2026-07-10',
        '--days=14',
        '--budget=6',
        '--sensitive-output'
    ]);
    assert.equal(plan.mode, 'plan_only_no_network');
    assert.equal(plan.network_requests_made, 0);
    assert.equal(plan.planned_requests, 6);
    assert.equal(plan.privacy.addresses_persisted_only_when_sensitive_output_is_explicit, true);
    assert.equal(plan.privacy.provider_payloads_persisted, false);
});
