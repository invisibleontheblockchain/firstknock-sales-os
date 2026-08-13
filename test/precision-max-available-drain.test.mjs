import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// "Max available" must behave like draining a well: it keeps paging until the
// provider has nothing left inside the drawn area, and never stops because a
// record count was reached. Metered accounts must still stop at their allowance.
//
// The two decisions under test live inline in the processor, so each is
// extracted from the REAL source text and evaluated — no reimplementation.

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chunkSource = readFileSync(resolve(rootDir, 'base44/functions/processFetchChunk/entry.ts'), 'utf8');
const startSource = readFileSync(resolve(rootDir, 'base44/functions/startBatchDataPull/entry.ts'), 'utf8');

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source anchor: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source terminator after: ${startMarker}`);
  return source.slice(start, end + endMarker.length);
}

const drainsUntilExhaustedSource = extract(
  chunkSource,
  'function drainsUntilExhausted(job) {',
  '}',
);
const continuationSource = extract(chunkSource, 'const moreWorkAvailable =', ';');
const remainingTargetSource = extract(chunkSource, 'const remainingTarget = drainMode', ';');
const chunkMaxSelected = Number(
  /const CHUNK_MAX_SELECTED = (\d+);/.exec(chunkSource)?.[1],
);

const evaluate = (code, scope) => vm.runInNewContext(
  `${code}\n__result;`,
  { ...scope, Math, Number, Array, __result: undefined },
);

test('drainsUntilExhausted only trusts the persisted job flag', () => {
  const run = (job) => evaluate(
    `${drainsUntilExhaustedSource}\nconst __result = drainsUntilExhausted(job);`,
    { job },
  );
  assert.equal(run({ dry_run_metadata: { drain_until_exhausted: true } }), true);
  assert.equal(run({ dry_run_metadata: { drain_until_exhausted: false } }), false);
  // A metered pull, a legacy job, or a client-supplied truthy string must not
  // be able to unlock draining.
  assert.equal(run({ dry_run_metadata: {} }), false);
  assert.equal(run({}), false);
  assert.equal(run({ dry_run_metadata: { drain_until_exhausted: 'true' } }), false);
});

test('a draining pull keeps going after its numeric target is reached', () => {
  const moreWork = evaluate(
    `${continuationSource}\nconst __result = moreWorkAvailable;`,
    {
      providerExhausted: false,
      drainMode: true,
      // Already delivered far beyond the reservation number.
      settledUsageCount: 1_000_000,
      requestedTarget: 1_000_000,
      nextSkip: 5000,
      resumeSkip: 2500,
    },
  );
  assert.equal(moreWork, true, 'max-available must not stop on a record count');
});

test('an empty provider page ends even a draining pull', () => {
  const moreWork = evaluate(
    `${continuationSource}\nconst __result = moreWorkAvailable;`,
    {
      providerExhausted: true,
      drainMode: true,
      settledUsageCount: 10,
      requestedTarget: 1_000_000,
      nextSkip: 5000,
      resumeSkip: 2500,
    },
  );
  assert.equal(moreWork, false, 'the well is dry — the pull must complete');
});

test('a metered pull still stops at its allowance', () => {
  const run = (settledUsageCount) => evaluate(
    `${continuationSource}\nconst __result = moreWorkAvailable;`,
    {
      providerExhausted: false,
      drainMode: false,
      settledUsageCount,
      requestedTarget: 1000,
      nextSkip: 5000,
      resumeSkip: 2500,
    },
  );
  assert.equal(run(999), true, 'below the cap the pull continues');
  assert.equal(run(1000), false, 'a capped account must not overshoot its allowance');
});

test('a stalled offset cannot chain forever', () => {
  const moreWork = evaluate(
    `${continuationSource}\nconst __result = moreWorkAvailable;`,
    {
      providerExhausted: false,
      drainMode: true,
      settledUsageCount: 0,
      requestedTarget: 1_000_000,
      // The scan made no forward progress, so chaining would loop.
      nextSkip: 2500,
      resumeSkip: 2500,
    },
  );
  assert.equal(moreWork, false, 'draining must not chain without a new offset');
});

test('a draining chunk asks for a full chunk instead of a remaining count', () => {
  const scope = {
    drainMode: true,
    CHUNK_MAX_SELECTED: chunkMaxSelected,
    requestedTarget: 1_000_000,
    deliveredBefore: 999_999,
  };
  assert.ok(Number.isInteger(chunkMaxSelected) && chunkMaxSelected > 0);
  assert.equal(
    evaluate(`${remainingTargetSource}\nconst __result = remainingTarget;`, scope),
    chunkMaxSelected,
    'draining must not shrink its page request as delivery grows',
  );
  assert.equal(
    evaluate(
      `${remainingTargetSource}\nconst __result = remainingTarget;`,
      { ...scope, drainMode: false },
    ),
    1,
    'a metered pull still asks only for the records missing from its target',
  );
});

test('only an uncapped max-available order persists the drain flag', () => {
  const flagSource = extract(startSource, 'drain_until_exhausted: countMode', ',');
  const unlimitedCap = Number(
    /const UNLIMITED_PROPERTY_CAP = (\d+);/.exec(startSource)?.[1],
  );
  const paidCap = Number(/const PAID_PROPERTY_CAP = (\d+);/.exec(startSource)?.[1]);
  assert.ok(unlimitedCap > paidCap);

  const run = (countMode, lockedPaidPropertyLimit) => evaluate(
    `const __result = { ${flagSource.replace(/,$/, '')} }.drain_until_exhausted;`,
    { countMode, lockedPaidPropertyLimit, UNLIMITED_PROPERTY_CAP: unlimitedCap },
  );
  assert.equal(run('max_available', unlimitedCap), true, 'stress-test account drains');
  assert.equal(run('max_available', paidCap), false, 'a paid account stays capped');
  assert.equal(run('fixed', unlimitedCap), false, 'a fixed count is never a drain');
});