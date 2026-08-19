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

function loadEndpoint() {
    const source = readFileSync(resolve(rootDir, endpoint), 'utf8');
    const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }).outputText.replace(/^import .*;\s*$/gm, '');
    return vm.runInNewContext(
        `${js}\n__exports = { resolvePrecisionEntitlement, betaPrecisionEvidence };\n__exports;`,
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
        { filename: endpoint }
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
