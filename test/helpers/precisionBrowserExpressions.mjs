// MODEL 1 / PR A — extraction of the browser-side order expressions.
//
// The repository has no DOM test tooling (no jsdom / testing-library / vitest),
// so the React components cannot be mounted. Instead of hand-copying the
// arithmetic into a test — which would prove nothing about production — this
// helper LOCATES the exact expression text inside the real .jsx source and
// evaluates that text.
//
// Consequences of this technique, stated plainly:
//   - It DOES prove what the production expression computes for given inputs.
//   - It DOES fail loudly if the production expression is edited or moved.
//   - It does NOT prove the React state wiring, effect ordering, or that the
//     expression is reached in a given UI flow. Those remain EVIDENCE_GAP and
//     are recorded as such in the evidence register.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const BROWSER_SOURCES = {
  panel: 'src/components/map/PrecisionPullPanel.jsx',
  prompt: 'src/components/map/TerritoryPrompt.jsx'
};

function read(path) {
  return readFileSync(resolve(rootDir, path), 'utf8');
}

/**
 * Pulls one capture group out of a production source file. Throws with the
 * file path if the anchor no longer matches, so drift cannot pass silently.
 */
export function extractExpression(path, anchor, { label }) {
  const source = read(path);
  const match = source.match(anchor);
  assert.ok(match, `[${label}] anchor no longer matches ${path}: ${anchor}`);
  return match[1].trim();
}

/** Evaluates an extracted expression against a supplied variable scope. */
export function evaluateExpression(expression, scope) {
  return vm.runInNewContext(`(${expression})`, { Math, Number, ...scope });
}

/* --------------------------------------------------------------- anchors */

/**
 * PrecisionPullPanel: the number input's onChange handler caps the typed value
 * at the currently displayed allowance.
 *   setRequestedPropertyCount(Math.min(Number(value) || 1, Math.max(1, Number(maxProperties) || 1)));
 */
export function typedCountAfterPanelCap({ typedValue, maxProperties }) {
  const expression = extractExpression(
    BROWSER_SOURCES.panel,
    /setRequestedPropertyCount\((Math\.min\(Number\(value\)[^;]*?)\);/,
    { label: 'panel-onChange-cap' }
  );
  return evaluateExpression(expression, { value: typedValue, maxProperties });
}

/**
 * PrecisionPullPanel: the same input's onBlur handler re-clamps into [1, max].
 */
export function typedCountAfterPanelBlur({ requestedPropertyCount, maxProperties }) {
  const expression = extractExpression(
    BROWSER_SOURCES.panel,
    /onBlur=\{\(\) => setRequestedPropertyCount\((Math\.max\(1, Math\.min\([^;]*?)\)\}/,
    { label: 'panel-onBlur-clamp' }
  );
  return evaluateExpression(expression, { requestedPropertyCount, maxProperties });
}

/**
 * TerritoryPrompt.handlePaidBatchDataPull: the count actually submitted to the
 * server, after a fresh allowance fetch.
 *   usingMaxAvailable ? freshMaxProperties
 *                     : Math.max(0, Math.min(Number(requestedPropertyCount) || 0, freshMaxProperties))
 */
export function submittedCount({ usingMaxAvailable, requestedPropertyCount, freshMaxProperties }) {
  const expression = extractExpression(
    BROWSER_SOURCES.prompt,
    /const effectiveRequestedPropertyCount = (usingMaxAvailable[\s\S]*?freshMaxProperties\)\));/,
    { label: 'prompt-submitted-count' }
  );
  return evaluateExpression(expression, { usingMaxAvailable, requestedPropertyCount, freshMaxProperties });
}

/** TerritoryPrompt: the count_mode flag actually placed on the request body. */
export function submittedCountMode({ isPreviousAreaPull, repullMode, propertyCountMode }) {
  const expression = extractExpression(
    BROWSER_SOURCES.prompt,
    /const usingMaxAvailable = (\(isPreviousAreaPull[\s\S]*?'max_available');/,
    { label: 'prompt-using-max-available' }
  );
  const usingMaxAvailable = evaluateExpression(expression, { isPreviousAreaPull, repullMode, propertyCountMode });
  return { usingMaxAvailable, count_mode: usingMaxAvailable ? 'max_available' : 'fixed' };
}

/** TerritoryPrompt: min/max home value coercion placed on the request body. */
export function submittedPrices({ minHomeValue, maxHomeValue }) {
  const minExpression = extractExpression(
    BROWSER_SOURCES.prompt,
    /const effectiveMinPrice = (minHomeValue \? Number\(minHomeValue\) : null);/,
    { label: 'prompt-min-price' }
  );
  const maxExpression = extractExpression(
    BROWSER_SOURCES.prompt,
    /const effectiveMaxPrice = (maxHomeValue \? Number\(maxHomeValue\) : null);/,
    { label: 'prompt-max-price' }
  );
  return {
    min_price: evaluateExpression(minExpression, { minHomeValue }),
    max_price: evaluateExpression(maxExpression, { maxHomeValue })
  };
}

/** PrecisionPullPanel: the money input's own character filter. */
export function moneyInputToNumber(rawInput) {
  const expression = extractExpression(
    BROWSER_SOURCES.panel,
    /function moneyInputToNumber\(value\) \{\s*const raw = ([\s\S]*?);\s*return raw \? Number\(raw\) : '';/,
    { label: 'panel-money-input' }
  );
  const raw = evaluateExpression(expression, { String, value: rawInput });
  return raw ? Number(raw) : '';
}

/** PrecisionPullPanel: the custom ownership-range clamp applied before submit. */
export function normalizeOwnershipRangeDays(value) {
  const source = read(BROWSER_SOURCES.panel);
  const match = source.match(/(function normalizeOwnershipRangeDays\(value\) \{[\s\S]*?\n\})/);
  assert.ok(match, `normalizeOwnershipRangeDays no longer found in ${BROWSER_SOURCES.panel}`);
  const constants = source.match(/(const OWNERSHIP_RANGE_MIN_DAYS[\s\S]*?const DEFAULT_OWNERSHIP_RANGE_DAYS = \[\d+, \d+\];)/);
  assert.ok(constants, 'ownership range constants no longer found');
  const result = vm.runInNewContext(
    `${constants[1]}\n${match[1]}\nnormalizeOwnershipRangeDays(input)`,
    { Number, Math, Array, input: value }
  );
  // Re-hydrate out of the sandbox realm so host-side deep comparison works.
  return JSON.parse(JSON.stringify(result));
}
