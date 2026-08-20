/**
 * GRANTED ACCOUNTS ARE METERED MONTHLY, like a paying customer.
 *
 * Grants used to carry a single fixed 2026-2030 window. That made a granted
 * allowance a lifetime total rather than a monthly one, with two consequences
 * that presented together as "the builder stopped working":
 *
 *   - usage never reset, so the allowance was spent once and never returned;
 *   - reconcileLegacyJobs classifies a legacy pull as billable when it started
 *     inside the entitlement window, so a four-year window swept up every pull
 *     the account had ever made and charged them all to the new grant.
 *
 * An account with real history therefore reached zero remaining the moment its
 * grant went live. TerritoryPrompt derives what a draw may request from
 * `remaining` (`min(requested, remaining)`), so zero remaining means a drawn
 * area requests zero properties and silently does nothing.
 *
 * These execute the real endpoint rather than reading it.
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
const endpoint = 'base44/functions/getPrecisionUsage/entry.ts';

function loadEndpoint() {
    const source = readFileSync(resolve(rootDir, endpoint), 'utf8');
    const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }).outputText.replace(/^import .*;\s*$/gm, '');
    return vm.runInNewContext(
        `${js}\n__exports = { betaPrecisionEvidence, calculateUsage, FREE_PROPERTY_LIMIT };\n__exports;`,
        {
            console,
            UNLIMITED_PROPERTY_CAP,
            currentGrantPeriod,
            precisionGrantLabel,
            precisionGrantLimit,
            createClientFromRequest: () => ({}),
            Stripe: class {},
            Deno: { env: { get: () => undefined }, serve: () => {} },
            Request, Response, TextEncoder, crypto: globalThis.crypto, setTimeout,
            __exports: undefined
        },
        { filename: endpoint }
    );
}

const api = loadEndpoint();
const CHRISTIAN = { id: '6978c7229935cf40cde25086', email: 'christian@nativapest.com' };

// precision_usage_recorded_at is what makes jobUsage honour the explicit
// count; without it a completed job falls back to legacy count fields and
// reads as zero, which would make these tests pass for the wrong reason.
const paidJob = (count, period) => ({
    status: 'completed',
    precision_usage_kind: 'paid',
    precision_usage_count: count,
    precision_usage_reserved: 0,
    precision_usage_recorded_at: period.periodStart,
    precision_subscription_id: 'account_precision_grant',
    precision_usage_period_start: period.periodStart,
    precision_usage_period_end: period.periodEnd
});

function priorMonth(period) {
    const start = new Date(period.periodStart);
    return currentGrantPeriod(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 15)));
}

test('GRANT-01 the granted window is the current calendar month, not a fixed block', () => {
    const entitlement = api.betaPrecisionEvidence(CHRISTIAN);
    const expected = currentGrantPeriod();
    assert.equal(entitlement.limit, UNLIMITED_PROPERTY_CAP);
    assert.equal(entitlement.periodStart, expected.periodStart);
    assert.equal(entitlement.periodEnd, expected.periodEnd);

    // The window it used to hand out. A four-year period is what made the
    // allowance a lifetime total and swept historical pulls into it.
    assert.notEqual(entitlement.periodStart, new Date(2026, 0, 1).toISOString());
    const spanDays = (new Date(entitlement.periodEnd) - new Date(entitlement.periodStart)) / 86400000;
    assert.ok(spanDays >= 28 && spanDays <= 31, `granted window should be one month, got ${spanDays} days`);
});

test('GRANT-02 last month’s usage does not consume this month’s allowance', () => {
    const entitlement = api.betaPrecisionEvidence(CHRISTIAN);
    const previous = priorMonth(entitlement);

    // The reported state: an account whose history already exceeds the grant.
    const spentLastMonth = [paidJob(4000, previous)];
    const usage = api.calculateUsage(spentLastMonth, entitlement);
    assert.equal(usage.used, 0, 'a previous period must not count against this one');
    assert.equal(usage.remaining, UNLIMITED_PROPERTY_CAP, 'the allowance resets with the month');
});

test('GRANT-03 a drawn area can still request properties', () => {
    // TerritoryPrompt: effectiveRequestedPropertyCount = min(requested, remaining).
    // At remaining 0 a draw requests nothing and appears broken.
    const entitlement = api.betaPrecisionEvidence(CHRISTIAN);
    const previous = priorMonth(entitlement);
    const requestable = (jobs, requested) => {
        const usage = api.calculateUsage(jobs, entitlement);
        return Math.max(0, Math.min(requested, usage.remaining));
    };
    assert.equal(requestable([paidJob(4000, previous)], 500), 500, 'history must not block a draw');
    assert.equal(requestable([], 500), 500);
});

test('GRANT-04 this month’s usage tracks against the uncapped safety ceiling', () => {
    const entitlement = api.betaPrecisionEvidence(CHRISTIAN);
    const usage = api.calculateUsage([paidJob(400, entitlement)], entitlement);
    assert.equal(usage.used, 400);
    assert.equal(usage.remaining, UNLIMITED_PROPERTY_CAP - 400);

    // The shared finite safety ceiling still protects persisted job math.
    const spent = api.calculateUsage([paidJob(UNLIMITED_PROPERTY_CAP + 200, entitlement)], entitlement);
    assert.equal(spent.used, UNLIMITED_PROPERTY_CAP);
    assert.equal(spent.remaining, 0);
});

test('GRANT-05 an unmetered legacy pull never counts against the grant', () => {
    const entitlement = api.betaPrecisionEvidence(CHRISTIAN);
    const usage = api.calculateUsage([
        {
            status: 'completed',
            precision_usage_kind: 'unmetered',
            precision_usage_count: 9000,
            precision_usage_reserved: 0,
            precision_usage_recorded_at: new Date().toISOString()
        }
    ], entitlement);
    assert.equal(usage.used, 0);
    assert.equal(usage.remaining, UNLIMITED_PROPERTY_CAP);
});

test('GRANT-06 the owner keeps an uncapped ceiling on the same monthly window', () => {
    const owner = api.betaPrecisionEvidence({ id: 'owner', email: 'invisibleontheblockchain@gmail.com' });
    assert.equal(owner.limit, UNLIMITED_PROPERTY_CAP);
    assert.equal(owner.periodStart, currentGrantPeriod().periodStart);
});

test('GRANT-07 the window is UTC, so it does not shift with the caller', () => {
    const period = currentGrantPeriod(new Date('2026-08-01T00:30:00Z'));
    assert.equal(period.periodStart, '2026-08-01T00:00:00.000Z');
    assert.equal(period.periodEnd, '2026-09-01T00:00:00.000Z');
    // December must roll into the next year rather than month 12.
    const december = currentGrantPeriod(new Date('2026-12-14T00:00:00Z'));
    assert.equal(december.periodEnd, '2027-01-01T00:00:00.000Z');
});