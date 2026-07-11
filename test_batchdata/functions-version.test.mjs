import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_FUNCTIONS_VERSION_STORAGE_KEY,
  resolveFunctionsVersion
} from '../src/lib/functionsVersion.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

test('an explicit version applies only to the current URL and clears a durable stale pin', () => {
  const storage = memoryStorage({ [LEGACY_FUNCTIONS_VERSION_STORAGE_KEY]: 'old-release' });
  assert.equal(resolveFunctionsVersion({
    search: '?functions_version=preview-release',
    storage
  }), 'preview-release');
  assert.equal(storage.getItem(LEGACY_FUNCTIONS_VERSION_STORAGE_KEY), null);
});

test('production does not reuse a previously persisted functions version', () => {
  const storage = memoryStorage({ [LEGACY_FUNCTIONS_VERSION_STORAGE_KEY]: 'old-release' });
  assert.equal(resolveFunctionsVersion({ search: '', storage }), null);
  assert.equal(storage.getItem(LEGACY_FUNCTIONS_VERSION_STORAGE_KEY), null);
  assert.equal(resolveFunctionsVersion({ search: '', configuredVersion: 'coordinated-release', storage }), 'coordinated-release');
});
