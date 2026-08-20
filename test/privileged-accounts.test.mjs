/**
 * PRIVILEGED ACCOUNTS — who bypasses the usage gates, and by how much.
 *
 * Grants are per-account numbers rather than membership flags, because
 * BatchData bills per property: the difference between 1,000 and the uncapped
 * ceiling is three orders of magnitude of spend, and it should be readable at
 * a glance rather than implied by which list an address sits in.
 *
 * The near-miss spellings still in the knock list (reef/reif, nativa/native)
 * are why these lists were consolidated: an address added to one file and
 * mistyped in another produces an account that clears some gates and not
 * others, which reads to the user as random failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    KNOCK_GATE_EXEMPT_EMAILS,
    PRECISION_GRANTS,
    UNLIMITED_PROPERTY_CAP,
    hasPrecisionGrant,
    isKnockGateExempt,
    normalizeAccountEmail,
    precisionGrantLabel,
    precisionGrantLimit
} from '../base44/shared/privilegedAccounts.js';

const CHRISTIAN = 'christian@nativapest.com';
const OWNER = 'invisibleontheblockchain@gmail.com';
const FREE_LIMIT = 50;

test('PRIV-01 Christian is granted 1,000 properties, not the free 50', () => {
    // The reported symptom: an owner-flagged admin still capped at 50.
    assert.equal(precisionGrantLimit({ email: CHRISTIAN }), 1000);
    assert.ok(precisionGrantLimit({ email: CHRISTIAN }) > FREE_LIMIT);
    assert.equal(isKnockGateExempt({ email: CHRISTIAN }), true);
});

test('PRIV-02 the grant survives the casing and whitespace a real login carries', () => {
    for (const variant of [' christian@nativapest.com', 'Christian@NativaPest.com', 'CHRISTIAN@NATIVAPEST.COM ']) {
        assert.equal(precisionGrantLimit({ email: variant }), 1000, variant);
        assert.equal(isKnockGateExempt({ email: variant }), true, variant);
    }
});

test('PRIV-03 the older nativepest spellings stay exempt from the knock gate', () => {
    // Whichever address he actually signs in with, he keeps logging outcomes.
    assert.equal(isKnockGateExempt({ email: 'christian@nativepest.com' }), true);
    assert.equal(isKnockGateExempt({ email: 'christian@nativepestmanagement.com' }), true);
});

test('PRIV-04 raising an account is a number change, not a list move', () => {
    // The point of the map: this is what a future raise looks like.
    const raised = new Map(PRECISION_GRANTS);
    raised.set(CHRISTIAN, 25000);
    assert.equal(raised.get(CHRISTIAN), 25000);
    assert.equal(raised.size, PRECISION_GRANTS.size, 'raising must not add an entry');
});

test('PRIV-05 the owner keeps the uncapped ceiling', () => {
    assert.equal(precisionGrantLimit({ email: OWNER }), UNLIMITED_PROPERTY_CAP);
    assert.equal(isKnockGateExempt({ email: OWNER }), true);
});

test('PRIV-06 every granted account can knock what it pulled', () => {
    for (const email of PRECISION_GRANTS.keys()) {
        assert.equal(KNOCK_GATE_EXEMPT_EMAILS.has(email), true, email);
    }
    // Not symmetric: a knock exemption alone must not grant Precision spend.
    assert.equal(precisionGrantLimit({ email: 'justinhoskins44@gmail.com' }), null);
    assert.equal(hasPrecisionGrant({ email: 'justinhoskins44@gmail.com' }), false);
});

test('PRIV-06b the knock gate follows the ID and domain grants too', () => {
    // The hole the ID and domain maps were added to close, re-opened one gate
    // later: an account granted by ID cleared the Precision cap and was then
    // stopped by the card gate at 25 outcomes. The pull works, the knocking
    // does not, which reads as random failure rather than as a gate.
    assert.equal(isKnockGateExempt({ id: '6978c7229935cf40cde25086', email: 'unrecorded@example.com' }), true);
    assert.equal(isKnockGateExempt({ id: '6978c7229935cf40cde25086' }), true);
    // Granted by domain, under an address nobody wrote down.
    assert.equal(isKnockGateExempt({ email: 'c.rodriguez@nativapest.com' }), true);
    // Still bounded by the grant: no grant, no exemption.
    assert.equal(isKnockGateExempt({ id: 'someone-else', email: 'someone@notnativapest.com' }), false);
});

test('PRIV-07 an ungranted account falls through to live Stripe, not to zero', () => {
    // null and not 0, so a caller cannot read "no grant" as "granted nothing"
    // and hand somebody a cap of zero properties.
    for (const email of ['a@b.com', '', null, undefined, 'christian@example.com', 'nativapest.com']) {
        assert.equal(precisionGrantLimit({ email }), null, String(email));
        assert.equal(isKnockGateExempt({ email }), false, String(email));
    }
    assert.equal(precisionGrantLimit(null), null);
    assert.equal(precisionGrantLimit({}), null);
    assert.equal(normalizeAccountEmail(undefined), '');
});

test('PRIV-08 every gate reads the shared grants, none keeps a private copy', () => {
    const gates = [
        'base44/functions/getPrecisionUsage/entry.ts',
        'base44/functions/startBatchDataPull/entry.ts',
        'base44/functions/fetchAreaProperties/entry.ts',
        'base44/functions/recordKnockOutcome/entry.ts'
    ];
    for (const path of gates) {
        const source = fs.readFileSync(path, 'utf8');
        assert.match(source, /shared\/privilegedAccounts\.js/, `${path} must import the shared grants`);
        assert.doesNotMatch(source, /const\s+(UNLIMITED_PRECISION_EMAIL|EXEMPT_EMAILS)\b/, `${path} redeclares a grant list`);
    }
});

test('PRIV-09 the Precision endpoints report the granted number, not a constant', () => {
    // A grant of 1,000 that still reported UNLIMITED_PROPERTY_CAP would let the
    // meter promise capacity the pull path would refuse.
    for (const path of [
        'base44/functions/getPrecisionUsage/entry.ts',
        'base44/functions/startBatchDataPull/entry.ts',
        'base44/functions/fetchAreaProperties/entry.ts'
    ]) {
        const source = fs.readFileSync(path, 'utf8');
        assert.match(source, /precisionLimit: grantedLimit/, `${path} must report the granted limit`);
    }
});

test('PRIV-10 the uncapped ceiling stays a finite, labelled number', () => {
    // Reservation, expected-count and progress math persist this on the FetchJob,
    // so Infinity or MAX_SAFE_INTEGER would poison those records.
    assert.equal(Number.isSafeInteger(UNLIMITED_PROPERTY_CAP), true);
    assert.equal(UNLIMITED_PROPERTY_CAP, 1000000);
    assert.equal(precisionGrantLabel(UNLIMITED_PROPERTY_CAP), 'owner_unlimited_grant');
    assert.equal(precisionGrantLabel(1000), 'account_precision_grant');
});
