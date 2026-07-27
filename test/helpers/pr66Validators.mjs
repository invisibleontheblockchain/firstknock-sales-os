// MODEL 1 / PR A — loader for PR #66's ACTUAL validators.
//
// The two files under test/fixtures/precision/pr66-reference/ are byte-exact
// copies of PR #66 source at head SHA 35396b50457e93fc3c5a1d838a23fae787c75fa6
// (branch codex/precision-phase1-containment). They are NOT re-implementations
// and NOT simplified duplicates; this module evaluates them verbatim.
//
// PR #66 is never modified, merged, or checked out by this code.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REFERENCE_DIR = resolve(rootDir, 'test', 'fixtures', 'precision', 'pr66-reference');

export const PR66_MANIFEST = JSON.parse(readFileSync(resolve(REFERENCE_DIR, 'manifest.json'), 'utf8'));

/**
 * Fails if a vendored copy no longer matches the checksum in the manifest.
 *
 * The digest is taken over LF-normalized content, because Git's `core.autocrlf`
 * rewrites line endings on checkout on Windows. Normalizing keeps the check
 * portable while still detecting any change to the actual source.
 */
export function verifyVendoredIntegrity() {
  for (const entry of PR66_MANIFEST.files) {
    const text = readFileSync(resolve(REFERENCE_DIR, entry.vendored_as), 'utf8').replace(/\r\n/g, '\n');
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    assert.equal(digest, entry.sha256_lf_normalized,
      `${entry.vendored_as} no longer matches the PR #66 source it was extracted from`);
  }
  return PR66_MANIFEST;
}

/**
 * Values returned from the sandbox carry that realm's prototypes, which breaks
 * host-side deep equality. Every captured function is wrapped so its RESULT is
 * re-hydrated as plain host JSON. Arguments and logic are untouched, so PR
 * #66's real code still decides every outcome.
 */
function rehydrateResults(bindings) {
  const wrapped = {};
  for (const [name, value] of Object.entries(bindings)) {
    if (typeof value !== 'function') {
      wrapped[name] = value === null || typeof value !== 'object' ? value : JSON.parse(JSON.stringify(value));
      continue;
    }
    wrapped[name] = (...args) => {
      const result = value(...args);
      if (result && typeof result.then === 'function') {
        return result.then((resolved) => (resolved === undefined ? resolved : JSON.parse(JSON.stringify(resolved))));
      }
      return result === undefined ? result : JSON.parse(JSON.stringify(result));
    };
  }
  return wrapped;
}

/**
 * The shared criteria module is a plain ES module. `import` cannot resolve a
 * .js file that lives in a fixtures directory without a package boundary, so
 * it is evaluated by exporting its top-level bindings through a sandbox global.
 */
export function loadSharedCriteriaModule() {
  const source = readFileSync(resolve(REFERENCE_DIR, 'precisionActiveJobCriteria.js'), 'utf8');
  const exported = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => match[1]);
  const exportedConsts = [...source.matchAll(/^export const (\w+)/gm)].map((match) => match[1]);
  const names = [...exported, ...exportedConsts];
  assert.ok(names.length > 0, 'no exports found in the vendored shared module');

  const executable = `${source.replace(/^export /gm, '')}\n;__collect({ ${names.join(', ')} });`;
  let collected = null;
  vm.runInNewContext(executable, {
    __collect: (value) => { collected = value; },
    JSON, Number, String, Boolean, Array, Object, Set, Map, Math, Date, Error, Promise, console
  }, { filename: 'pr66:precisionActiveJobCriteria.js' });

  assert.ok(collected, 'the shared module did not expose its bindings');
  return rehydrateResults(collected);
}

/**
 * `getRouteCandidatesFromNeon` keeps its validators module-scoped, so they are
 * captured the same way. The shared module's exports are injected as globals
 * because the transpiled import statement is stripped.
 */
export function loadCandidateValidators(shared = loadSharedCriteriaModule()) {
  const source = readFileSync(resolve(REFERENCE_DIR, 'getRouteCandidatesFromNeon.entry.ts'), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'getRouteCandidatesFromNeon.entry.ts',
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')), []);

  const WANTED = [
    'invalidPersistedCriteriaFields',
    'invalidLegacyCriteriaFields',
    'missingLegacyRouteCriteriaFields',
    'invalidLegacyRequestedCriteriaFields',
    'missingRouteCriteriaFields',
    'invalidRequestedCriteriaFields',
    'requestCriteriaFromBody',
    'getFetchJobWorkspaceId',
    'getAuthenticatedWorkspaceId',
    'fetchJobBelongsToUser',
    'normalizeWorkspaceId',
    'requestedSoldWindowDays',
    'requestFieldName'
  ];
  for (const name of WANTED) {
    assert.ok(new RegExp(`function ${name}\\b`).test(source),
      `PR #66 no longer defines ${name}; the compatibility audit must be revisited`);
  }

  const executable = `${transpiled.outputText.replace(/^import .*;\s*$/gm, '')}
;__collect({ ${WANTED.join(', ')} });`;

  let collected = null;
  vm.runInNewContext(executable, {
    ...shared,
    __collect: (value) => { collected = value; },
    Deno: { env: { get: () => 'test' }, serve: () => {} },
    createClientFromRequest: () => ({}),
    Client: class { async connect() {} async query() { return { rows: [] }; } async end() {} },
    Request, Response, TextEncoder, crypto: globalThis.crypto,
    JSON, Number, String, Boolean, Array, Object, Set, Map, Math, Date, Error, Promise, console,
    isNaN, isFinite, parseInt, parseFloat
  }, { filename: 'pr66:getRouteCandidatesFromNeon.entry.ts' });

  assert.ok(collected, 'the candidate entry point did not expose its validators');
  return rehydrateResults(collected);
}
