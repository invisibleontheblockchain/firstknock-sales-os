import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

test('legacy account maintenance endpoints cannot delete or rewrite saved routes', () => {
  const cleanup = read('base44/functions/cleanupRoutes/entry.ts');
  const restore = read('base44/functions/restoreKevinRoutes/entry.ts');

  for (const source of [cleanup, restore]) {
    assert.match(source, /await base44\.auth\.me\(\)/);
    assert.match(source, /Admin access required/);
    assert.match(source, /status:\s*410/);
    assert.doesNotMatch(source, /asServiceRole/);
    assert.doesNotMatch(source, /SavedRoute\.(?:delete|update|updateMany)\(/);
  }
});

test('account-specific diagnostics require admin authentication before service-role reads', () => {
  const source = read('base44/functions/checkKevinRoutes/entry.ts');
  const authIndex = source.indexOf('await base44.auth.me()');
  const adminIndex = source.indexOf('Admin access required');
  const serviceRoleIndex = source.indexOf('base44.asServiceRole');

  assert.ok(authIndex >= 0);
  assert.ok(adminIndex > authIndex);
  assert.ok(serviceRoleIndex > adminIndex);
  assert.doesNotMatch(source, /SavedRoute\.(?:delete|update|updateMany)\(/);
});

test('route manifests remain required and legacy recovery repairs only missing tenant links', () => {
  const routeSchema = JSON.parse(read('base44/entities/SavedRoute.jsonc'));
  const hydration = read('base44/functions/getRoutePropertiesByHashes/entry.ts');

  assert.ok(routeSchema.required.includes('property_hashes'));
  assert.match(hydration, /LEGACY_CANONICAL_RECOVERY_CUTOFF/);
  assert.match(hydration, /INSERT INTO workspace_properties/);
  assert.match(hydration, /ON CONFLICT \(property_id, user_email\) DO NOTHING/);
  assert.doesNotMatch(hydration, /(?:DELETE FROM|UPDATE)\s+(?:properties|workspace_properties)/i);
});
