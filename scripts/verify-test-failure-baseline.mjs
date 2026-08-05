import {
  appendFile,
  readFile,
  readdir,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MINIMUM_TEST_COUNT = 763;
export const MINIMUM_TEST_FILE_COUNT = 71;

// Main currently carries these failures. A pull request may fix any subset, but
// it may not add, duplicate, rename, or move one. Pairing each exact test name
// with its source file keeps this exception narrower than a numeric allowance.
export const KNOWN_TEST_FAILURES = Object.freeze([
  Object.freeze({
    name: 'Canvas keeps owner-scoped previews safe, shows planner feedback, and fits successful plans',
    file: 'test/canvas-production-ui.test.mjs',
  }),
  Object.freeze({
    name: 'the checklist logs outcomes optimistically on the same terms as the knock tab',
    file: 'test/knock-outcome-feedback.test.mjs',
  }),
  Object.freeze({
    name: 'an optimistic checklist row carries created_by so the org filter keeps it',
    file: 'test/knock-outcome-feedback.test.mjs',
  }),
  Object.freeze({
    name: 'NEWBUILD-05 the window rolls with the calendar',
    file: 'test/new-construction.test.mjs',
  }),
  Object.freeze({
    name: 'ANCHOR-09 ANCHORS sits beside Split Route, Optimize and Export',
    file: 'test/route-anchors.test.mjs',
  }),
  Object.freeze({
    name: 'Precision route bounds are explicit, off by default, and wired through persistence',
    file: 'test/route-bounds-integration.test.mjs',
  }),
  Object.freeze({
    name: 'Home and RepHome interactive optimizers never depend on live road loading',
    file: 'test/route-continuity-call-sites.test.mjs',
  }),
  Object.freeze({
    name: 'DEP-02 the guard is non-vacuous — it detects a removed import',
    file: 'test/route-module-dependencies.test.mjs',
  }),
  Object.freeze({
    name: 'DEP-03 Home.jsx imports the distance helper its objective comparison uses',
    file: 'test/route-module-dependencies.test.mjs',
  }),
  Object.freeze({
    name: 'a geographically wide street remains one block instead of being split by clustering',
    file: 'test/route-street-sweep.test.mjs',
  }),
  Object.freeze({
    name: 'initial, manager, and rep optimization keep whole streets contiguous',
    file: 'test/route-street-sweep.test.mjs',
  }),
  Object.freeze({
    name: 'Analytics exposes an all-pages Sales Manager with update, correction, and confirmed deletion',
    file: 'test/sales-management.test.mjs',
  }),
  Object.freeze({
    name: 'Team keeps its heatmap while HQ redirects before normal app authentication',
    file: 'test/user-activity-heatmap.test.mjs',
  }),
]);

function normalizeName(value) {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function normalizeSourceFile(value) {
  let location = String(value || '').trim();
  try {
    location = decodeURIComponent(location);
  } catch {
    // A malformed URL cannot match an allowlisted source path.
  }
  location = location.replace(/^file:\/\//i, '').replace(/\\+/g, '/');
  const match = location.match(/(?:^|\/)(test\/[^:'"]+?\.test\.mjs)(?::\d+:\d+)?$/i);
  return match ? match[1] : null;
}

function parseTopLevelTests(output) {
  const entries = [];
  let current = null;

  for (const line of output.split('\n')) {
    const event = line.match(/^(not ok|ok) (\d+) - (.+?)\s*$/);
    if (event) {
      if (current) entries.push(current);
      current = {
        ok: event[1] === 'ok',
        index: Number(event[2]),
        name: normalizeName(event[3]),
        diagnostics: [],
      };
    } else if (current) {
      current.diagnostics.push(line);
    }
  }
  if (current) entries.push(current);

  return entries.map((entry) => {
    const locationLine = entry.diagnostics
      .map((line) => line.match(/^\s+location:\s+(['"])(.*?)\1\s*$/))
      .find(Boolean);
    return {
      ok: entry.ok,
      index: entry.index,
      name: entry.name,
      file: normalizeSourceFile(locationLine?.[2]),
    };
  });
}

function parseSingleNumber(output, pattern) {
  const matches = [...output.matchAll(pattern)];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

function fail(reason, details = {}) {
  return {
    ok: false,
    reason,
    failures: [],
    inheritedFailures: [],
    newFailures: [],
    ...details,
  };
}

export function analyzeTestOutput(output, commandExitCode, options = {}) {
  const {
    knownFailures = KNOWN_TEST_FAILURES,
    minimumTestCount = MINIMUM_TEST_COUNT,
    minimumTestFileCount = MINIMUM_TEST_FILE_COUNT,
    testFileCount,
    teeExitCode = 0,
  } = options;
  const text = String(output || '').replace(/\r\n/g, '\n');
  const entries = parseTopLevelTests(text);
  const failures = entries.filter((entry) => !entry.ok);
  const exitCode = Number(commandExitCode);
  const capturedOutputExitCode = Number(teeExitCode);

  if (/^\s*Bail out!/m.test(text)) {
    return fail('The test runner bailed out before completing.', { failures });
  }
  if (![0, 1].includes(exitCode)) {
    return fail(`The test command exit status was invalid or abnormal: ${commandExitCode}.`, { failures });
  }
  if (capturedOutputExitCode !== 0) {
    return fail(`Capturing the test output failed with status ${teeExitCode}.`, { failures });
  }

  const plan = parseSingleNumber(text, /^1\.\.(\d+)\s*$/gm);
  const summary = Object.fromEntries([
    'tests',
    'pass',
    'fail',
    'cancelled',
    'skipped',
    'todo',
  ].map((label) => [
    label,
    parseSingleNumber(text, new RegExp(`^# ${label} (\\d+)\\s*$`, 'gm')),
  ]));

  if (plan === null || Object.values(summary).some((value) => value === null)) {
    return fail('The test run did not produce exactly one complete TAP plan and summary.', { failures });
  }
  if (plan !== summary.tests) {
    return fail(`The TAP plan reported ${plan} tests but the summary reported ${summary.tests}.`, {
      ...summary,
      plan,
      failures,
    });
  }
  if (entries.length !== summary.tests
    || entries.some((entry, index) => entry.index !== index + 1)) {
    return fail('The top-level TAP test records were missing, duplicated, or out of sequence.', {
      ...summary,
      plan,
      failures,
    });
  }
  const accountedTests = summary.pass
    + summary.fail
    + summary.cancelled
    + summary.skipped
    + summary.todo;
  if (accountedTests !== summary.tests) {
    return fail(`The TAP summary accounted for ${accountedTests} of ${summary.tests} tests.`, {
      ...summary,
      plan,
      failures,
    });
  }
  if (summary.cancelled !== 0 || summary.skipped !== 0 || summary.todo !== 0) {
    return fail('Cancelled, skipped, or todo tests are not permitted in the blocking suite.', {
      ...summary,
      plan,
      failures,
    });
  }
  if (failures.length !== summary.fail
    || entries.filter((entry) => entry.ok).length !== summary.pass) {
    return fail('The parsed TAP pass/fail records did not match the summary.', {
      ...summary,
      plan,
      failures,
    });
  }
  if ((summary.fail === 0 && exitCode !== 0) || (summary.fail > 0 && exitCode !== 1)) {
    return fail(`The test command exited ${exitCode} with ${summary.fail} reported failures.`, {
      ...summary,
      plan,
      failures,
    });
  }
  if (summary.tests < minimumTestCount) {
    return fail(`Only ${summary.tests} tests ran; at least ${minimumTestCount} are required.`, {
      ...summary,
      plan,
      failures,
    });
  }
  if (!Number.isInteger(testFileCount) || testFileCount < minimumTestFileCount) {
    return fail(`Only ${testFileCount ?? 'an unknown number of'} test files were discovered; at least ${minimumTestFileCount} are required.`, {
      ...summary,
      plan,
      failures,
    });
  }

  const allowedCounts = new Map(knownFailures.map(({ name, file }) => [
    `${normalizeName(name)}\0${normalizeSourceFile(file)}`,
    1,
  ]));
  const seenCounts = new Map();
  const inheritedFailures = [];
  const newFailures = [];
  for (const failure of failures) {
    const key = `${failure.name}\0${failure.file}`;
    const seen = (seenCounts.get(key) || 0) + 1;
    seenCounts.set(key, seen);
    if (seen <= (allowedCounts.get(key) || 0)) inheritedFailures.push(failure);
    else newFailures.push(failure);
  }

  return {
    ok: newFailures.length === 0,
    reason: newFailures.length === 0
      ? null
      : `${newFailures.length} test failure${newFailures.length === 1 ? '' : 's'} are not in the main-branch baseline.`,
    ...summary,
    plan,
    testFileCount,
    failures,
    inheritedFailures,
    newFailures,
  };
}

function markdownCode(value) {
  return String(value).replace(/`/g, '\\`');
}

function summaryMarkdown(result) {
  const lines = [
    '### Test gate: no new failures',
    '',
    `- tests executed: **${result.tests ?? 'unknown'}**`,
    `- test files discovered: **${result.testFileCount ?? 'unknown'}**`,
    `- inherited failing tests: **${result.inheritedFailures?.length ?? 0}**`,
    `- new failing tests: **${result.newFailures?.length ?? result.failures?.length ?? 'unknown'}**`,
  ];
  if (result.newFailures?.length) {
    lines.push(
      '',
      'New failures:',
      '',
      ...result.newFailures.map(({ name, file }) => `- \`${markdownCode(name)}\` (${markdownCode(file || 'source unknown')})`),
    );
  }
  if (result.reason && !result.newFailures?.length) lines.push('', `Gate error: ${result.reason}`);
  return `${lines.join('\n')}\n`;
}

function commandValue(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

async function countTestFiles() {
  const entries = await readdir(resolve('test'), { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs')).length;
}

async function main() {
  const outputPath = process.argv[2];
  const commandExitCode = process.argv[3];
  const teeExitCode = process.argv[4];
  if (!outputPath || commandExitCode === undefined || teeExitCode === undefined) {
    throw new Error('Usage: node scripts/verify-test-failure-baseline.mjs <tap-output> <test-exit-code> <tee-exit-code>');
  }

  const [output, testFileCount] = await Promise.all([
    readFile(resolve(outputPath), 'utf8'),
    countTestFiles(),
  ]);
  const result = analyzeTestOutput(output, commandExitCode, { teeExitCode, testFileCount });
  const summary = summaryMarkdown(result);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
  }
  if (!result.ok) {
    for (const failure of result.newFailures || []) {
      process.stderr.write(`::error::New test failure: ${commandValue(failure.name)} [${commandValue(failure.file || 'source unknown')}]\n`);
    }
    process.stderr.write(`::error::${commandValue(result.reason || 'The test failure baseline could not be verified.')}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
