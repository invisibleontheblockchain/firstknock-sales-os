/**
 * THE USAGE REPAIR TOOL WORKS FOR GRANTED ACCOUNTS.
 *
 * reconcilePrecisionUsage went straight to Stripe and threw
 * "An active paid Precision subscription with a current positive payment is
 * required" for anyone without one — which is exactly the set of accounts a
 * grant exists for, and exactly the accounts whose job history most needs
 * repairing. An admin reaching for it to fix a granted account got a dead end.
 *
 * It now resolves the grant first and reconciles against the same monthly
 * window getPrecisionUsage meters that account against, so the repair and the
 * meter agree rather than disagreeing by a billing period.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {
    UNLIMITED_PROPERTY_CAP,
    currentGrantPeriod,
    precisionGrantLabel,
    precisionGrantLimit
} from '../base44/shared/privilegedAccounts.js';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = 'base44/functions/reconcilePrecisionUsage/entry.ts';

const CHRISTIAN = {
    id: '6978c7229935cf40cde25086',
    email: 'christian@nativapest.com',
    role: 'admin',
    is_owner: true
};

function harness({ jobs }) {
    const updates = { jobs: [], user: null };
    const rows = jobs.map((job) => ({ ...job }));
    const base44 = {
        auth: { me: async () => CHRISTIAN },
        asServiceRole: {
            entities: {
                FetchJob: {
                    filter: async () => rows,
                    update: async (id, patch) => {
                        updates.jobs.push({ id, patch });
                        Object.assign(rows.find((row) => row.id === id) || {}, patch);
                    }
                },
                User: {
                    filter: async () => [CHRISTIAN],
                    update: async (id, patch) => { updates.user = { id, patch }; }
                }
            }
        }
    };

    const js = ts.transpileModule(readFileSync(resolve(rootDir, endpoint), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }).outputText.replace(/^import .*;\s*$/gm, '');

    let handler;
    vm.runInNewContext(js, {
        console,
        currentGrantPeriod,
        precisionGrantLabel,
        precisionGrantLimit,
        createClientFromRequest: () => base44,
        // Any Stripe use at all is a failure for a granted account.
        Stripe: class { constructor() { throw new Error('Stripe reached for a granted account'); } },
        Deno: { env: { get: () => undefined }, serve: (fn) => { handler = fn; } },
        Request, Response, TextEncoder, crypto: globalThis.crypto, setTimeout
    }, { filename: endpoint });

    return { handler, updates, rows };
}

const request = () => new Request('https://example.test/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
});

test('RECON-01 a granted account reconciles without Stripe and without throwing', async () => {
    const { handler } = harness({ jobs: [] });
    const response = await handler(request());
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.paid_property_limit, 1000, 'the granted ceiling, not the Stripe one');
});

test('RECON-02 it reconciles against the same month the meter uses', async () => {
    const { handler } = harness({ jobs: [] });
    const body = await (await handler(request())).json();
    const expected = currentGrantPeriod();
    assert.equal(body.precision_usage_period_start, expected.periodStart);
    assert.equal(body.precision_usage_period_end, expected.periodEnd);
});

test('RECON-03 history from earlier months is not charged to the grant', async () => {
    const lastMonthStart = new Date(currentGrantPeriod().periodStart);
    lastMonthStart.setUTCMonth(lastMonthStart.getUTCMonth() - 1);
    const { handler, rows } = harness({
        jobs: [
            { id: 'old', status: 'completed', started_at: lastMonthStart.toISOString(), total_expected: 4000 },
            { id: 'now', status: 'completed', started_at: new Date().toISOString(), total_expected: 120 }
        ]
    });
    const body = await (await handler(request())).json();
    assert.equal(body.success, true);

    const older = rows.find((row) => row.id === 'old');
    const current = rows.find((row) => row.id === 'now');
    assert.notEqual(older.precision_usage_kind, 'paid', 'a prior-month pull must not consume this month');
    assert.equal(current.precision_usage_kind, 'paid');
});

test('RECON-04 billable rows are stamped with the grant, not a Stripe id', async () => {
    const { handler, rows } = harness({
        jobs: [{ id: 'now', status: 'completed', started_at: new Date().toISOString(), total_expected: 10 }]
    });
    await handler(request());
    const stamped = rows.find((row) => row.id === 'now');
    assert.equal(stamped.precision_subscription_id, precisionGrantLabel(precisionGrantLimit(CHRISTIAN)));
    // No Stripe invoice exists, so the field must be omitted rather than null.
    assert.equal('precision_invoice_id' in stamped, false);
});