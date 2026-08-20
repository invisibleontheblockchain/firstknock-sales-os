/**
 * GRANTS KEYED ON THE IMMUTABLE USER ID.
 *
 * The email list is the weak link. It already carries two spellings of one
 * domain (nativa/native) and two of another (reef/reif), and the address a
 * person signs in with need not match the one stored on their record — a
 * mismatch that fails silently, leaving the account metered as free with no
 * indication that a grant was intended.
 *
 * A Base44 user ID cannot be mistyped into somebody else's account and does
 * not drift when an address changes, so it is checked first. This is
 * server-side configuration rather than a field on the user, so it does not
 * cross the rule that client-visible flags (is_owner, subscription_paid_confirmed)
 * must never grant entitlement — that rule is enforced by
 * precision-pull-cap.test.mjs and still holds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {
    PRECISION_GRANTS_BY_EMAIL_DOMAIN,
    PRECISION_GRANTS_BY_USER_ID,
    UNLIMITED_PROPERTY_CAP,
    currentGrantPeriod,
    precisionGrantLabel,
    precisionGrantLimit
} from '../base44/shared/privilegedAccounts.js';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHRISTIAN_ID = '6978c7229935cf40cde25086';

function loadEndpoint(endpoint, exportNames) {
    const js = ts.transpileModule(readFileSync(resolve(rootDir, endpoint), 'utf8'), {
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
            Stripe: class { constructor() { throw new Error('Stripe reached for a granted account'); } },
            Deno: { env: { get: () => undefined }, serve: () => {} },
            Request, Response, TextEncoder, crypto: globalThis.crypto, setTimeout,
            __exports: undefined
        },
        { filename: endpoint }
    );
}

test('UID-01 the ID grants 1,000 Precision properties whatever address he signs in with', () => {
    assert.equal(precisionGrantLimit({ id: CHRISTIAN_ID, email: 'christian@nativapest.com' }), 1000);
    // The failure mode an email list cannot see.
    assert.equal(precisionGrantLimit({ id: CHRISTIAN_ID, email: 'christian@nativepest.com' }), 1000);
    assert.equal(precisionGrantLimit({ id: CHRISTIAN_ID, email: 'someone.else@gmail.com' }), 1000);
    assert.equal(precisionGrantLimit({ id: CHRISTIAN_ID }), 1000);
    assert.equal(precisionGrantLimit({ id: ` ${CHRISTIAN_ID} ` }), 1000);
});

test('UID-02 the email route still works when the ID is absent', () => {
    assert.equal(precisionGrantLimit({ email: 'christian@nativapest.com' }), 1000);
    assert.equal(precisionGrantLimit({ email: 'invisibleontheblockchain@gmail.com' }), UNLIMITED_PROPERTY_CAP);
});

test('UID-03 the BatchData pull honours it with no Stripe anywhere', async () => {
    // Stripe throws on construction here, and STRIPE_SECRET_KEY is unset.
    const api = loadEndpoint('base44/functions/startBatchDataPull/entry.ts', ['resolvePrecisionEntitlement']);
    const entitlement = await api.resolvePrecisionEntitlement({ id: CHRISTIAN_ID, email: 'mismatched@example.com' });
    assert.equal(entitlement.paidAccess, true, 'hasPaidPrecisionCapacity reads this');
    assert.equal(entitlement.precisionLimit, 1000);
    assert.equal(entitlement.kind, 'beta');
});

test('UID-04 the meter agrees with the pull path, so no free-limit banner', () => {
    const api = loadEndpoint('base44/functions/getPrecisionUsage/entry.ts', ['betaPrecisionEvidence']);
    const entitlement = api.betaPrecisionEvidence({ id: CHRISTIAN_ID, email: 'mismatched@example.com' });
    // PrecisionPullPanel renders "Free Precision limit" only for kind 'trial'.
    assert.equal(entitlement.kind, 'beta');
    assert.equal(entitlement.limit, 1000);
    assert.equal(entitlement.periodStart, currentGrantPeriod().periodStart);
});

test('UID-05 nobody else is granted by ID', () => {
    for (const id of ['', ' ', 'other-user', '6978c7229935cf40cde25087', null, undefined]) {
        assert.equal(precisionGrantLimit({ id, email: 'a@b.com' }), null, String(id));
    }
    assert.equal(precisionGrantLimit(null), null);
    assert.equal(precisionGrantLimit({}), null);
    // Christian and Devin (devinfgalligan@gmail.com) are the only ID grants.
    assert.equal(PRECISION_GRANTS_BY_USER_ID.size, 2);
    assert.equal(precisionGrantLimit({ id: '69fb8c76e8bf4b0b31e8d4f9', email: 'mismatched@example.com' }), 1000);
});

test('UID-06 client-visible flags still grant nothing', () => {
    // The invariant precision-pull-cap.test.mjs enforces must survive this.
    assert.equal(precisionGrantLimit({ id: 'x', email: 'a@b.com', is_owner: true }), null);
    assert.equal(precisionGrantLimit({ id: 'x', email: 'a@b.com', subscription_paid_confirmed: true }), null);
    assert.equal(precisionGrantLimit({ id: 'x', email: 'a@b.com', subscription_status: 'active' }), null);
});

test('UID-07 any address at his company domains is granted', () => {
    // The last resort when an identity will not match: an account can exist
    // twice, and a person can sign in under an address that is not the one on
    // the record. Both look identical from outside — a silent fall to free.
    assert.equal(precisionGrantLimit({ email: 'christian@nativapest.com' }), 1000);
    for (const email of [
        'christian@nativepest.com',
        'christian@nativepestmanagement.com',
        'c.rodriguez@nativapest.com'
    ]) {
        assert.equal(precisionGrantLimit({ email }), 1000, email);
    }
    assert.equal(precisionGrantLimit({ email: 'CHRISTIAN@NativaPest.com ' }), 1000);
});

test('UID-08 the domain grant does not leak past those domains', () => {
    for (const email of [
        'christian@gmail.com',
        'a@b.com',
        'someone@notnativapest.com',
        'nativapest.com',
        'user@sub.nativapest.com',
        '@nativapest.com',
        'trailing@nativapest.com.evil.com'
    ]) {
        assert.equal(precisionGrantLimit({ email }), null, email);
    }
    assert.equal(PRECISION_GRANTS_BY_EMAIL_DOMAIN.size, 3);
});