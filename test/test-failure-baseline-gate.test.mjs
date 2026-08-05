import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeTestOutput,
  KNOWN_TEST_FAILURES,
} from '../scripts/verify-test-failure-baseline.mjs';

const TEST_OPTIONS = Object.freeze({
  minimumTestCount: 1,
  minimumTestFileCount: 1,
  testFileCount: 1,
  teeExitCode: 0,
});

function tapOutput({
  tests = 3,
  failures = [],
  cancelled = 0,
  skipped = 0,
  todo = 0,
} = {}) {
  const lines = ['TAP version 13'];
  for (let index = 1; index <= tests; index += 1) {
    const failure = failures.find((item) => item.index === index);
    if (failure) {
      lines.push(
        `not ok ${index} - ${failure.name}`,
        '  ---',
        `  location: '${failure.file || 'test/unknown.test.mjs'}:1:1'`,
        "  failureType: 'testCodeFailure'",
        '  ...',
      );
    } else {
      lines.push(`ok ${index} - test ${index}`);
    }
  }
  const fail = failures.length;
  const pass = tests - fail - cancelled - skipped - todo;
  lines.push(
    `1..${tests}`,
    `# tests ${tests}`,
    `# pass ${pass}`,
    `# fail ${fail}`,
    `# cancelled ${cancelled}`,
    `# skipped ${skipped}`,
    `# todo ${todo}`,
  );
  return lines.join('\n');
}

function analyze(output, exitCode) {
  return analyzeTestOutput(output, exitCode, TEST_OPTIONS);
}

test('known main failures are tolerated by exact name and source while clean runs pass', () => {
  const known = KNOWN_TEST_FAILURES[0];
  const inherited = analyze(tapOutput({
    failures: [{ index: 2, ...known }],
  }), 1);
  assert.equal(inherited.ok, true);
  assert.deepEqual(inherited.inheritedFailures.map(({ name }) => name), [known.name]);
  assert.deepEqual(inherited.newFailures, []);

  const clean = analyze(tapOutput(), 0);
  assert.equal(clean.ok, true);
  assert.equal(clean.fail, 0);
});

test('new, duplicate, or moved failures block the gate', () => {
  const newFailure = analyze(tapOutput({
    failures: [{ index: 1, name: 'brand-new regression', file: 'test/new.test.mjs' }],
  }), 1);
  assert.equal(newFailure.ok, false);
  assert.deepEqual(newFailure.newFailures.map(({ name }) => name), ['brand-new regression']);

  const known = KNOWN_TEST_FAILURES[0];
  const duplicate = analyze(tapOutput({
    tests: 2,
    failures: [{ index: 1, ...known }, { index: 2, ...known }],
  }), 1);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.newFailures[0].name, known.name);

  const moved = analyze(tapOutput({
    failures: [{ index: 1, name: known.name, file: 'test/different.test.mjs' }],
  }), 1);
  assert.equal(moved.ok, false);
});

test('incomplete, inconsistent, or abnormal test runs fail closed', () => {
  assert.equal(analyze('not ok 1 - truncated', 1).ok, false);

  const mismatched = tapOutput({ failures: [{ index: 1, ...KNOWN_TEST_FAILURES[0] }] })
    .replace('# fail 1', '# fail 2');
  assert.equal(analyze(mismatched, 1).ok, false);

  const duplicatePlan = `${tapOutput()}\n1..3`;
  assert.equal(analyze(duplicatePlan, 0).ok, false);
  assert.equal(analyze(tapOutput(), 1).ok, false);
  assert.equal(analyzeTestOutput(tapOutput(), 0, { ...TEST_OPTIONS, teeExitCode: 1 }).ok, false);
  assert.equal(analyze(tapOutput(), 2).ok, false);
});

test('bailouts, omitted coverage, skips, cancellations, and todos fail closed', () => {
  assert.equal(analyze(`${tapOutput()}\nBail out! worker crashed`, 0).ok, false);
  assert.equal(analyze(tapOutput({ tests: 3, skipped: 1 }), 0).ok, false);
  assert.equal(analyze(tapOutput({ tests: 3, cancelled: 1 }), 0).ok, false);
  assert.equal(analyze(tapOutput({ tests: 3, todo: 1 }), 0).ok, false);

  const belowMinimumTests = analyzeTestOutput(tapOutput(), 0, {
    ...TEST_OPTIONS,
    minimumTestCount: 4,
  });
  assert.equal(belowMinimumTests.ok, false);

  const belowMinimumFiles = analyzeTestOutput(tapOutput(), 0, {
    ...TEST_OPTIONS,
    minimumTestFileCount: 2,
  });
  assert.equal(belowMinimumFiles.ok, false);
});
