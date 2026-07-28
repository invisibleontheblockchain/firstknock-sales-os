// Guard: every shared route helper a page CALLS must actually be imported.
//
// The reoptimization handler called `haversineDistanceMiles(...)` while
// Home.jsx imported only `calculateRouteDistanceMiles` and `isValidRoutePoint`.
// Every Optimize click would have thrown ReferenceError at runtime.
//
// Nothing caught it: the build bundles it fine (the reference is only resolved
// when the callback runs), typecheck passed, and 659 tests passed — because the
// pure objective tests inject their own distanceFn and never execute the real
// page callback.
//
// This walks the actual module graph: for each page, it resolves what each
// helper module exports and asserts that anything called by name is imported.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PAGES = [
  'src/pages/Home.jsx',
  'src/components/map/MapToolbar.jsx',
  'src/components/map/OptimizeRouteInline.jsx'
];

const HELPER_MODULES = [
  ['@/lib/routeBounds', 'src/lib/routeBounds.js'],
  ['@/lib/routeOriginModes', 'src/lib/routeOriginModes.js'],
  ['@/lib/routeOptimizeUpdate', 'src/lib/routeOptimizeUpdate.js'],
  ['@/lib/parkedCarLocation', 'src/lib/parkedCarLocation.js']
];

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/** Named exports of a module, by source scan (these files are plain ESM). */
function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  return names;
}

/** Names a file imports from a given specifier. */
function importedFrom(source, specifier) {
  const pattern = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${specifier.replace(/[/@]/g, '\\$&')}['"]`);
  const match = source.match(pattern);
  if (!match) return new Set();
  return new Set(match[1].split(',').map((entry) => entry.trim().split(/\s+as\s+/)[0]).filter(Boolean));
}

/** Locally declared names, so a page defining its own helper is not flagged. */
function locallyDefined(source) {
  const names = new Set();
  for (const match of source.matchAll(/(?:function|const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  return names;
}

test('DEP-01 every shared route helper called by a page is imported by that page', async () => {
  const problems = [];

  for (const page of PAGES) {
    const pageSource = await read(page);
    const declared = locallyDefined(pageSource);

    for (const [specifier, modulePath] of HELPER_MODULES) {
      const exports = exportedNames(await read(modulePath));
      const imported = importedFrom(pageSource, specifier);

      for (const name of exports) {
        // Only flag a call, not an incidental mention in a comment or string.
        const called = new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(pageSource);
        if (called && !imported.has(name) && !declared.has(name)) {
          problems.push(`${page} calls ${name}() from ${specifier} without importing it`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});

test('DEP-02 the guard is non-vacuous — it detects a removed import', async () => {
  const pageSource = await read('src/pages/Home.jsx');
  const boundsExports = exportedNames(await read('src/lib/routeBounds.js'));

  // Simulate exactly the defect: drop haversineDistanceMiles from the import.
  const broken = pageSource.replace(
    /import\s*\{([^}]+)\}\s*from\s*'@\/lib\/routeBounds';/,
    (full, names) => `import {${names.split(',').filter((n) => !n.includes('haversineDistanceMiles')).join(',')}} from '@/lib/routeBounds';`
  );

  assert.notEqual(broken, pageSource, 'the simulation must actually change the source');

  const imported = importedFrom(broken, '@/lib/routeBounds');
  const declared = locallyDefined(broken);
  assert.ok(boundsExports.has('haversineDistanceMiles'), 'routeBounds must export it');
  assert.equal(imported.has('haversineDistanceMiles'), false, 'simulated removal');

  const called = /(?<![.\w])haversineDistanceMiles\s*\(/.test(broken);
  assert.ok(called && !declared.has('haversineDistanceMiles'),
    'the guard would flag this — which is precisely what shipped before this fix');
});

test('DEP-03 Home.jsx imports the distance helper its objective comparison uses', async () => {
  const pageSource = await read('src/pages/Home.jsx');
  const imported = importedFrom(pageSource, '@/lib/routeBounds');

  assert.ok(imported.has('haversineDistanceMiles'),
    'the reoptimization objective calls it directly');
  assert.match(pageSource, /distanceFn:\s*\(from, to\) => haversineDistanceMiles\(from, to\)/);
});
