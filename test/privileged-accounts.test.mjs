/**
 * PRIVILEGED ACCOUNTS — who bypasses the usage gates.
 *
 * The grant lists were previously copy-pasted across four functions, and the
 * near-miss spellings that survived in them (reef/reif, nativa/native) are what
 * that cost: an address added to one file and mistyped in another produces an
 * account that is exempt from some gates and not others, which reads to the
 * user as random failure. These assert the grants by behaviour, and that every
 * gate reads the same list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    KNOCK_GATE_EXEMPT_EMAILS,
    UNLIMITED_PRECISION_EMAILS,
    UNLIMITED_PROPERTY_CAP,
    hasUnlimitedPrecision,
    isKnockGateExempt,
    normalizeAccountEmail
} from '../base44/shared/privilegedAccounts.js';

const CHRISTIAN = 'christian@nativapest.com';
const OWNER = 'invisibleontheblockchain@gmail.com';

test('PRIV-01 Christian clears both the Precision cap and the knock gate', () => {
    assert.equal(hasUnlimitedPrecision({ email: CHRISTIAN }), true);
    assert.equal(isKnockGateExempt({ email: CHRISTIAN }), true);
});

test('PRIV-02 the grant survives the casing and whitespace a real login carries', () => {
    for (const variant of [' christian@nativapest.com', 'Christian@NativaPest.com', 'CHRISTIAN@NATIVAPEST.COM ']) {
        assert.equal(hasUnlimitedPrecision({ email: variant }), true, variant);
        assert.equal(isKnockGateExempt({ email: variant }), true, variant);
    }
});

test('PRIV-03 the older nativepest spellings stay exempt from the knock gate', () => {
    // Whichever address he actually signs in with, he keeps logging outcomes.
    assert.equal(isKnockGateExempt({ email: 'christian@nativepest.com' }), true);
    assert.equal(isKnockGateExempt({ email: 'christian@nativepestmanagement.com' }), true);
});

test('PRIV-04 unlimited Precision implies knock exemption, never the reverse', () => {
    // An account that can pull without limit must be able to knock what it pulled.
    for (const email of UNLIMITED_PRECISION_EMAILS) {
        assert.equal(KNOCK_GATE_EXEMPT_EMAILS.has(email), true, email);
    }
    // Not symmetric: a knock exemption alone must not uncap Precision spend.
    assert.equal(hasUnlimitedPrecision({ email: 'justinhoskins44@gmail.com' }), false);
});

test('PRIV-05 the owner keeps the grant that already existed', () => {
    assert.equal(hasUnlimitedPrecision({ email: OWNER }), true);
    assert.equal(isKnockGateExempt({ email: OWNER }), true);
});

test('PRIV-06 nobody else is granted anything', () => {
    for (const email of ['a@b.com', '', null, undefined, 'christian@example.com', 'nativapest.com']) {
        assert.equal(hasUnlimitedPrecision({ email }), false, String(email));
        assert.equal(isKnockGateExempt({ email }), false, String(email));
    }
    assert.equal(hasUnlimitedPrecision(null), false);
    assert.equal(hasUnlimitedPrecision({}), false);
    assert.equal(normalizeAccountEmail(undefined), '');
});

test('PRIV-07 every gate reads the shared list, none keeps a private copy', () => {
    const gates = [
        'base44/functions/getPrecisionUsage/entry.ts',
        'base44/functions/startBatchDataPull/entry.ts',
        'base44/functions/fetchAreaProperties/entry.ts',
        'base44/functions/recordKnockOutcome/entry.ts'
    ];
    for (const path of gates) {
        const source = fs.readFileSync(path, 'utf8');
        assert.match(source, /shared\/privilegedAccounts\.js/, `${path} must import the shared grants`);
        // A re-introduced local list is the exact regression this guards.
        assert.doesNotMatch(source, /const\s+(UNLIMITED_PRECISION_EMAIL|EXEMPT_EMAILS)\b/, `${path} redeclares a grant list`);
    }
});

test('PRIV-08 the uncapped ceiling stays a finite number', () => {
    // Reservation, expected-count and progress math persist this on the FetchJob,
    // so Infinity or MAX_SAFE_INTEGER would poison those records.
    assert.equal(Number.isSafeInteger(UNLIMITED_PROPERTY_CAP), true);
    assert.equal(UNLIMITED_PROPERTY_CAP, 1000000);
});
