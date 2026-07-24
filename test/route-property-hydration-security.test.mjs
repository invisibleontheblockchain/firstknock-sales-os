import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('base44/functions/getRoutePropertiesByHashes/entry.ts', 'utf8')
  .replace(/^import .*;\s*$/gm, '');

test('optional ownership columns cannot make route hydration depend on a completed Neon migration', () => {
  for (const column of ['owner_occupied', 'corporate_owned', 'investor_owned']) {
    assert.doesNotMatch(source, new RegExp(`p\\.${column}`));
    assert.match(source, new RegExp(`to_jsonb\\(p\\) ->> '${column}'`));
  }
});

function loadHandler({
  user = { id: 'rep_1', email: 'rep@example.com', role: 'user' },
  route = {
    id: 'route_1',
    created_by: 'manager@example.com',
    property_hashes: ['hash_1'],
  },
  workspaceRows = [],
  canonicalRows = [],
} = {}) {
  let handler;
  const sqlCalls = [];
  const sql = async (strings) => {
    const query = strings.join(' ');
    sqlCalls.push(query);
    if (query.includes('FROM workspace_properties')) return workspaceRows;
    if (query.includes('FROM properties p')) return canonicalRows;
    throw new Error(`Unexpected SQL in hydration test: ${query}`);
  };
  const base44 = {
    auth: { me: async () => user },
    entities: {
      SavedRoute: { get: async (id) => id === route?.id ? route : null },
      InteractionLog: { filter: async () => [] },
    },
    asServiceRole: {
      entities: {
        MasterProperty: { filter: async () => [] },
      },
    },
  };
  const sandbox = {
    createClientFromRequest: () => base44,
    neon: () => sql,
    Deno: {
      env: { get: () => 'postgres://test' },
      serve: (candidate) => { handler = candidate; },
    },
    Response,
    console,
  };
  vm.runInNewContext(source, sandbox);
  return { handler, sqlCalls };
}

async function invoke(handler, body) {
  const response = await handler({ json: async () => body });
  return { response, result: await response.json() };
}

test('visible saved routes hydrate legacy canonical properties without a workspace link', async () => {
  const property = {
    id: 42,
    address_hash: 'hash_1',
    full_address: '100 Main St',
    lat: 33.45,
    lng: -112.07,
  };
  const { handler, sqlCalls } = loadHandler({ canonicalRows: [property] });

  const { response, result } = await invoke(handler, {
    route_id: 'route_1',
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(result.properties[0].address_hash, 'hash_1');
  assert.equal(result.properties[0].lat, 33.45);
  assert.equal(sqlCalls.filter(query => query.includes('FROM workspace_properties')).length, 1);
  assert.equal(sqlCalls.filter(query => query.includes('FROM properties p')).length, 1);
});

test('canonical property fallback never runs for arbitrary hashes without a route', async () => {
  const { handler, sqlCalls } = loadHandler({
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 0);
  assert.equal(sqlCalls.filter(query => query.includes('FROM properties p')).length, 0);
});

test('route hydration rejects hashes that are not on the caller-visible route', async () => {
  const { handler, sqlCalls } = loadHandler();

  const { response, result } = await invoke(handler, {
    route_id: 'route_1',
    address_hashes: ['not_on_route'],
  });

  assert.equal(response.status, 403);
  assert.equal(result.code, 'route_hash_mismatch');
  assert.equal(sqlCalls.length, 0);
});
