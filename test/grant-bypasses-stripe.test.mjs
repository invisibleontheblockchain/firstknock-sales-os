/**
 * A GRANT DOES NOT REQUIRE STRIPE.
 *
 * The worry these answer: that the BatchData pull needs a card, customer and
 * subscription on file before an elevated cap can apply, and that a granted
 * account therefore has to be given Stripe records first.
 *
 * It does not. resolvePrecisionEntitlement consults the grant list before it
 * reads STRIPE_SECRET_KEY, constructs a Stripe client, or looks at
 * subscription_id / stripe_customer_id. A granted account returns from that
 * first branch and never reaches the billing code at all — which is exactly
 * how the existing kevin@reifenvironmental.com and baysecurity@gmail.com
 * exceptions work.
 *
 * These execute the real endpoint with a Stripe client that throws on
 * construction and an environment with no STRIPE_SECRET_KEY, so any code path
 * that touched Stripe would fail loudly rather than pass quietly.
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
const endpoint = 'base44/functions/startBatchDataPull/entry.ts';

class ExplodingStripe {
    constructor() {
        throw new Error('Stripe must not be constructed for a granted account');
    }
}

function loadEndpoint(file = endpoint, exportNames = ['resolvePrecisionEntitlement', 'betaPrecisionEvidence']) {
    const source = readFileSync(resolve(rootDir, file), 'utf8');
    const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }).outputText.replace(/^import .*;\s*$/gm, '');
    return vm.runInNewContext(
        `${js}\n__exports = { ${exportNames.join(', ')} };\n__exports;`,
        {
            console,
            UNLIMITED_PROPERTY_CAP,
            currentGrantPeriod,
            precisionGrantLabel,
            precisionGrantLimit,
            createClientFromRequest: () => ({}),
            Client: class {},
            Stripe: ExplodingStripe,
            // No STRIPE_SECRET_KEY: the billing branch would throw
            // 'Stripe billing verification is unavailable.' if it were reached.
            Deno: { env: { get: () => undefined }, serve: () => {} },
            Request, Response, TextEncoder, crypto: globalThis.crypto, setTimeout,
            __exports: undefined
        },
        { filename: file }
    );
}

const api = loadEndpoint();

// Christian's record verbatim: every Stripe field empty, exactly as reported.
const CHRISTIAN = {
    id: '6978c7229935cf40cde25086',
    email: 'christian@nativapest.com',
    role: 'admin',
    app_role: 'admin',
    is_owner: true,
    subscription_status: 'active',
    subscription_tier: undefined,
    subscription_id: undefined,
    subscription_paid_confirmed: undefined,
    subscription_paid_confirmed_at: undefined,
    subscription_period_start: undefined,
    subscription_period_end: undefined,
    stripe_customer_id: undefined,
    stripe_card_on_file_confirmed: undefined
};

test('STRIPELESS-01 a granted account resolves with no Stripe records at all', async () => {
    const entitlement = await api.resolvePrecisionEntitlement(CHRISTIAN);
    assert.equal(entitlement.paidAccess, true, 'paidAccess is what every pull gate reads');
    assert.equal(entitlement.precisionLimit, 1000);
    assert.equal(entitlement.kind, 'beta');
});

test('STRIPELESS-02 Kevin resolves the same way, on the same branch', async () => {
    // The existing exception this was modelled on.
    const kevin = { id: 'k', email: 'kevin@reifenvironmental.com' };
    const entitlement = await api.resolvePrecisionEntitlement(kevin);
    assert.equal(entitlement.paidAccess, true);
    assert.equal(entitlement.precisionLimit, 1000);
});

test('STRIPELESS-03 an ungranted account does reach the Stripe branch', async () => {
    // The control. Without this, STRIPELESS-01 could pass because the billing
    // code is unreachable in this harness rather than because it was skipped.
    await assert.rejects(
        () => api.resolvePrecisionEntitlement({ id: 'x', email: 'nobody@example.com' }),
        /Stripe billing verification is unavailable/
    );
});

test('STRIPELESS-04 the grant is consulted before any Stripe read, in source order', () => {
    const source = readFileSync(resolve(rootDir, endpoint), 'utf8');
    const resolver = source.slice(source.indexOf('async function resolvePrecisionEntitlement'));
    const grantAt = resolver.indexOf('betaPrecisionEvidence(user)');
    const stripeAt = resolver.indexOf('STRIPE_SECRET_KEY');
    assert.ok(grantAt >= 0 && stripeAt >= 0);
    assert.ok(grantAt < stripeAt, 'the grant check must precede the Stripe read');
});

/**
 * The three gates above cover startBatchDataPull only. A grant that bypasses
 * Stripe on the pull but not on the meter still reads to the user as broken:
 * the pull would run while the panel showed a free-tier ceiling. These extend
 * the same ExplodingStripe proof to the other Precision gates.
 */

test('STRIPELESS-05 the area fetch resolves a grant with no Stripe client', async () => {
    const api = loadEndpoint('base44/functions/fetchAreaProperties/entry.ts', ['resolvePrecisionEntitlement']);
    const entitlement = await api.resolvePrecisionEntitlement(CHRISTIAN);
    assert.equal(entitlement.kind, 'beta');
    assert.equal(entitlement.paidAccess, true);
    assert.equal(entitlement.precisionLimit, 1000);
});

test('STRIPELESS-06 the meter resolves a grant with no Stripe client', async () => {
    const api = loadEndpoint('base44/functions/getPrecisionUsage/entry.ts', ['resolveEntitlement']);
    const entitlement = await api.resolveEntitlement(CHRISTIAN);
    assert.equal(entitlement.kind, 'beta');
    // calculateUsage divides the period budget by .limit, not .precisionLimit;
    // a grant that set only the latter would meter him against undefined.
    assert.equal(entitlement.limit, 1000);
    assert.equal(entitlement.precisionLimit, 1000);
});

test('STRIPELESS-07 both still reach Stripe for an ungranted account', async () => {
    // The controls for 05 and 06: without these they could pass because the
    // billing code is unreachable in this harness rather than because it was
    // skipped for a granted account.
    for (const [file, exported] of [
        ['base44/functions/fetchAreaProperties/entry.ts', 'resolvePrecisionEntitlement'],
        ['base44/functions/getPrecisionUsage/entry.ts', 'resolveEntitlement']
    ]) {
        const api = loadEndpoint(file, [exported]);
        await assert.rejects(
            () => api[exported]({ id: 'x', email: 'nobody@example.com' }),
            /Stripe billing verification is unavailable/,
            file
        );
    }
});

test('STRIPELESS-08 every Precision gate orders the grant ahead of the Stripe read', () => {
    // reconcilePrecisionUsage resolves the grant inline in its Deno.serve
    // handler rather than in a named resolver, so it is covered here by source
    // order and by reconcile-granted-account.test.mjs by execution.
    for (const [file, resolver] of [
        ['base44/functions/getPrecisionUsage/entry.ts', 'async function resolveEntitlement'],
        ['base44/functions/startBatchDataPull/entry.ts', 'async function resolvePrecisionEntitlement'],
        ['base44/functions/fetchAreaProperties/entry.ts', 'async function resolvePrecisionEntitlement'],
        ['base44/functions/reconcilePrecisionUsage/entry.ts', 'Deno.serve']
    ]) {
        const source = readFileSync(resolve(rootDir, file), 'utf8');
        const start = source.indexOf(resolver);
        assert.ok(start >= 0, `${file}: could not find ${resolver}`);
        const body = source.slice(start);
        const grantAt = body.search(/precisionGrantLimit\(|betaPrecisionEvidence\(user\)/);
        const stripeAt = body.indexOf('STRIPE_SECRET_KEY');
        assert.ok(grantAt >= 0, `${file} must consult the shared grant`);
        assert.ok(stripeAt >= 0, `${file} must still have a Stripe path for everyone else`);
        assert.ok(grantAt < stripeAt, `${file}: the grant must precede the Stripe read`);
    }
});