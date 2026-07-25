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
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  },
  visibleOwnerRoutes = route ? [route] : [],
  routeFilter,
  interactionLogs = [],
  interactionError = null,
  workspaceRows = [],
  canonicalRows = [],
  masterProperties = [],
  workspaceError = null,
  canonicalError = null,
  managerRecord,
} = {}) {
  let handler;
  const sqlCalls = [];
  const sqlValueCalls = [];
  const routeFilterQueries = [];
  const interactionFilterQueries = [];
  const sql = async (strings, ...values) => {
    const query = strings.join(' ');
    sqlCalls.push(query);
    sqlValueCalls.push({ query, values });
    if (query.includes('INSERT INTO workspace_properties')) return [];
    if (query.includes('FROM workspace_properties')) {
      if (workspaceError) throw workspaceError;
      return typeof workspaceRows === 'function'
        ? workspaceRows({ query, values })
        : workspaceRows;
    }
    if (query.includes('FROM properties p')) {
      if (canonicalError) throw canonicalError;
      return canonicalRows;
    }
    throw new Error(`Unexpected SQL in hydration test: ${query}`);
  };
  const filterMasterProperty = async (query) => {
    const [field, criterion] = Object.entries(query || {})[0] || [];
    const values = Array.isArray(criterion)
      ? criterion
      : (Array.isArray(criterion?.$in) ? criterion.$in : [criterion]);
    return masterProperties.filter(property => values.includes(property?.[field]));
  };
  const base44 = {
    auth: { me: async () => user },
    entities: {
      SavedRoute: {
        get: async (id) => id === route?.id ? route : null,
        filter: async (query, sort, limit, skip) => {
          routeFilterQueries.push(query);
          if (routeFilter) return routeFilter({ query, sort, limit, skip, route });
          return visibleOwnerRoutes;
        },
      },
      InteractionLog: {
        filter: async (query, sort, limit, skip) => {
          interactionFilterQueries.push(query);
          if (interactionError) throw interactionError;
          return typeof interactionLogs === 'function'
            ? interactionLogs({ query, sort, limit, skip })
            : interactionLogs;
        },
      },
    },
    asServiceRole: {
      entities: {
        MasterProperty: { filter: filterMasterProperty },
        User: {
          get: async (id) => {
            if (managerRecord !== undefined) return managerRecord;
            return id === user?.data?.team_manager_id
              ? { id, email: 'manager@example.com' }
              : null;
          },
        },
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
  return {
    handler,
    interactionFilterQueries,
    routeFilterQueries,
    sqlCalls,
    sqlValueCalls,
  };
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
  const user = {
    id: 'manager_1',
    email: 'manager@example.com',
    role: 'user',
  };
  const route = {
    id: 'route_1',
    manager_id: 'manager_1',
    created_by: 'manager@example.com',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const { handler, sqlCalls } = loadHandler({
    user,
    route,
    canonicalRows: [property],
  });

  const { response, result } = await invoke(handler, {
    route_id: 'route_1',
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(result.properties[0].address_hash, 'hash_1');
  assert.equal(result.properties[0].lat, 33.45);
  assert.equal(sqlCalls.filter(query => query.includes('FROM workspace_properties')).length, 1);
  assert.equal(sqlCalls.filter(query =>
    query.includes('FROM properties p') && !query.includes('INSERT INTO workspace_properties')
  ).length, 1);
  assert.equal(sqlCalls.filter(query => query.includes('INSERT INTO workspace_properties')).length, 1);
});

test('a legacy route updated after the cutoff receives pin-safe recovery without read-repair', async () => {
  const route = {
    id: 'route_updated',
    manager_id: 'manager_1',
    created_by: 'manager@example.com',
    created_date: '2026-07-23T20:00:00.000Z',
    updated_date: '2026-07-24T02:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const { handler, sqlCalls } = loadHandler({
    user: {
      id: 'manager_1',
      email: 'manager@example.com',
      role: 'user',
    },
    route,
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      full_address: '100 Main St',
      owner_full_name: 'Sensitive Owner',
      price: 750000,
      sold_date: '2025-10-01T00:00:00.000Z',
      lat: 33.45,
      lng: -112.07,
    }],
  });

  const { response, result } = await invoke(handler, {
    route_id: 'route_updated',
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(result.properties[0].full_address, '100 Main St');
  assert.equal(result.properties[0].owner_full_name, undefined);
  assert.equal(result.properties[0].price, 750000);
  assert.equal(result.properties[0].sold_date, '2025-10-01T00:00:00.000Z');
  assert.equal(result.properties[0].recovery_limited, true);
  assert.equal(sqlCalls.filter(query => query.includes('INSERT INTO workspace_properties')).length, 0);
});

test('canonical property fallback never runs for arbitrary hashes without a route', async () => {
  const { handler, sqlCalls } = loadHandler({
    route: null,
    visibleOwnerRoutes: [],
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
    user_email: 'manager@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 0);
  assert.equal(sqlCalls.filter(query =>
    query.includes('FROM properties p') && !query.includes('INSERT INTO workspace_properties')
  ).length, 0);
});

test('legacy clients hydrate only when a caller-visible route has the exact requested manifest', async () => {
  const property = {
    id: 42,
    address_hash: 'hash_1',
    full_address: '100 Main St',
    lat: 33.45,
    lng: -112.07,
  };
  const { handler, routeFilterQueries, sqlCalls } = loadHandler({ canonicalRows: [property] });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
    user_email: 'manager@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(result.user_email, 'manager@example.com');
  assert.deepEqual([...routeFilterQueries[0].property_hashes.$all], ['hash_1']);
  assert.equal(sqlCalls.filter(query =>
    query.includes('FROM properties p') && !query.includes('INSERT INTO workspace_properties')
  ).length, 1);
});

test('legacy discovery scans visible owner routes when $all silently returns no rows', async () => {
  const property = {
    id: 42,
    address_hash: 'hash_1',
    full_address: '100 Main St',
    lat: 33.45,
    lng: -112.07,
  };
  const { handler, routeFilterQueries } = loadHandler({
    canonicalRows: [property],
    routeFilter: ({ query, route }) => (
      query.property_hashes ? [] : (query.created_by ? [route] : [])
    ),
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
    user_email: 'manager@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.ok(routeFilterQueries.some(query => query.created_by === 'manager@example.com'));
});

test('manager-owned routes hydrate by tenant manager even when a rep created them', async () => {
  const user = {
    id: 'manager_1',
    email: 'manager@example.com',
    role: 'user',
  };
  const route = {
    id: 'route_rep_created',
    manager_id: 'manager_1',
    created_by: 'rep@example.com',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const { handler } = loadHandler({
    user,
    route,
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
    routeFilter: ({ query }) => (
      query.manager_id === 'manager_1' ? [route] : []
    ),
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
    user_email: 'manager@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(result.user_email, 'manager@example.com');
  assert.equal(result.count, 1);
});

test('post-cutoff rep-created routes try both manager and creator workspaces', async () => {
  const user = {
    id: 'manager_1',
    email: 'manager@example.com',
    role: 'user',
  };
  const route = {
    id: 'route_new_rep_created',
    manager_id: 'manager_1',
    created_by: 'rep@example.com',
    created_date: '2026-07-24T02:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const property = {
    id: 42,
    address_hash: 'hash_1',
    lat: 33.45,
    lng: -112.07,
  };
  const { handler, sqlValueCalls } = loadHandler({
    user,
    route,
    routeFilter: ({ query }) => (
      query.manager_id === 'manager_1' ? [route] : []
    ),
    workspaceRows: ({ values }) => (
      values.includes('rep@example.com') ? [property] : []
    ),
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
    user_email: 'manager@example.com',
  });

  const queriedEmails = sqlValueCalls
    .filter(call => call.query.includes('FROM workspace_properties'))
    .map(call => call.values[0]);
  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.deepEqual(queriedEmails, ['manager@example.com', 'rep@example.com']);
});

test('route hydration never trusts a client-supplied workspace owner', async () => {
  const user = {
    id: 'manager_1',
    email: 'manager@example.com',
    role: 'user',
  };
  const route = {
    id: 'route_new',
    manager_id: 'manager_1',
    created_by: 'rep@example.com',
    created_date: '2026-07-24T02:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const attackerProperty = {
    id: 42,
    address_hash: 'hash_1',
    created_by: 'victim@example.com',
    owner_full_name: 'Victim Owner',
    lat: 33.45,
    lng: -112.07,
  };
  const { handler, sqlValueCalls } = loadHandler({
    user,
    route,
    workspaceRows: ({ values }) => (
      values.includes('victim@example.com') ? [attackerProperty] : []
    ),
    masterProperties: [attackerProperty],
  });

  const { response, result } = await invoke(handler, {
    route_id: 'route_new',
    address_hashes: ['hash_1'],
    user_email: 'victim@example.com',
  });

  const queriedEmails = sqlValueCalls
    .filter(call => call.query.includes('FROM workspace_properties'))
    .map(call => call.values[0]);
  assert.equal(response.status, 200);
  assert.equal(result.count, 0);
  assert.deepEqual(queriedEmails, ['manager@example.com', 'rep@example.com']);
});

test('assigned reps hydrate through the verified manager tenant instead of the route creator', async () => {
  const user = {
    id: 'rep_user_1',
    email: 'rep@example.com',
    role: 'user',
    data: { team_manager_id: 'manager_1' },
  };
  const route = {
    id: 'route_assigned',
    manager_id: 'manager_1',
    created_by: 'importer@example.com',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const { handler } = loadHandler({
    user,
    route,
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
    routeFilter: ({ query }) => (
      query.manager_id === 'manager_1' ? [route] : []
    ),
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
    user_email: 'importer@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(result.user_email, 'manager@example.com');
  assert.equal(result.count, 1);
});

test('legacy discovery accepts the top-level team manager identity used by older rep sessions', async () => {
  const user = {
    id: 'rep_user_1',
    email: 'rep@example.com',
    role: 'user',
    team_manager_id: 'manager_1',
  };
  const route = {
    id: 'route_assigned',
    manager_id: 'manager_1',
    created_by: 'manager@example.com',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const { handler, routeFilterQueries } = loadHandler({
    user,
    route,
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
    routeFilter: ({ query }) => (
      query.manager_id === 'manager_1' ? [route] : []
    ),
    managerRecord: { id: 'manager_1', email: 'manager@example.com' },
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
    user_email: 'manager@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.ok(routeFilterQueries.some(query => query.manager_id === 'manager_1'));
});

test('an unresolved manager identity can recover pins but cannot read-repair another workspace', async () => {
  const user = {
    id: 'rep_user_1',
    email: 'rep@example.com',
    role: 'user',
    data: { team_manager_id: 'manager_1' },
  };
  const route = {
    id: 'route_assigned',
    manager_id: 'manager_1',
    created_by: 'importer@example.com',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const { handler, sqlCalls } = loadHandler({
    user,
    route,
    managerRecord: null,
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
    routeFilter: ({ query }) => (
      query.manager_id === 'manager_1' ? [route] : []
    ),
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
    user_email: 'importer@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(
    sqlCalls.filter(query => query.includes('INSERT INTO workspace_properties')).length,
    0
  );
});

test('legacy discovery prefers the recoverable historical route over a newer duplicate', async () => {
  const legacyRoute = {
    id: 'route_old',
    manager_id: 'manager_1',
    created_by: 'manager@example.com',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const newerRoute = {
    ...legacyRoute,
    id: 'route_new',
    created_date: '2026-07-24T02:00:00.000Z',
  };
  const mutableLegacyRoute = {
    ...legacyRoute,
    id: 'route_old_but_edited',
    updated_date: '2026-07-24T02:00:00.000Z',
  };
  const { handler, sqlValueCalls } = loadHandler({
    user: {
      id: 'manager_1',
      email: 'manager@example.com',
      role: 'user',
    },
    route: legacyRoute,
    visibleOwnerRoutes: [mutableLegacyRoute, newerRoute, legacyRoute],
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
    user_email: 'manager@example.com',
  });

  const repairCall = sqlValueCalls.find(call => (
    call.query.includes('INSERT INTO workspace_properties')
  ));
  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.ok(repairCall?.values.includes('route_old'));
  assert.ok(!repairCall?.values.includes('route_new'));
  assert.ok(!repairCall?.values.includes('route_old_but_edited'));
});

test('service-created legacy routes without created_by still hydrate for their manager', async () => {
  const user = {
    id: 'manager_1',
    email: 'manager@example.com',
    role: 'user',
  };
  const route = {
    id: 'route_service_created',
    manager_id: 'manager_1',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const { handler } = loadHandler({
    user,
    route,
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
    routeFilter: ({ query }) => (
      query.manager_id === 'manager_1' ? [route] : []
    ),
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.user_email, 'manager@example.com');
  assert.equal(result.count, 1);
});

test('fully logged service-created legacy routes still receive exact canonical recovery', async () => {
  const user = {
    id: 'manager_1',
    email: 'manager@example.com',
    role: 'user',
  };
  const route = {
    id: 'route_service_created',
    manager_id: 'manager_1',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const { handler } = loadHandler({
    user,
    route,
    interactionLogs: [{ address_hash: 'hash_1', created_by: 'manager@example.com' }],
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
    routeFilter: ({ query }) => (
      query.manager_id === 'manager_1' ? [route] : []
    ),
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
});

test('fully logged service routes resolve the assigned rep manager workspace', async () => {
  const user = {
    id: 'rep_1',
    email: 'rep@example.com',
    role: 'user',
    team_manager_id: 'manager_1',
  };
  const route = {
    id: 'route_service_created',
    manager_id: 'manager_1',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const { handler } = loadHandler({
    user,
    route,
    managerRecord: { id: 'manager_1', email: 'manager@example.com' },
    interactionLogs: [{ address_hash: 'hash_1', created_by: 'rep@example.com' }],
    masterProperties: [{
      id: 'base44_manager_copy',
      address_hash: 'hash_1',
      created_by: 'manager@example.com',
      lat: 33.45,
      lng: -112.07,
    }],
    routeFilter: ({ query }) => (
      query.manager_id === 'manager_1' ? [route] : []
    ),
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.user_email, 'manager@example.com');
  assert.equal(result.count, 1);
});

test('an interaction-log outage cannot block exact service-route recovery', async () => {
  const user = {
    id: 'manager_1',
    email: 'manager@example.com',
    role: 'user',
  };
  const route = {
    id: 'route_service_created',
    manager_id: 'manager_1',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const { handler } = loadHandler({
    user,
    route,
    interactionError: new Error('interaction index unavailable'),
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
    routeFilter: ({ query }) => (
      query.manager_id === 'manager_1' ? [route] : []
    ),
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
});

test('an interaction-log outage cannot block complete workspace hydration', async () => {
  const property = {
    id: 42,
    address_hash: 'hash_1',
    lat: 33.45,
    lng: -112.07,
  };
  const { handler } = loadHandler({
    route: null,
    visibleOwnerRoutes: [],
    interactionError: new Error('interaction index unavailable'),
    workspaceRows: [property],
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
});

test('a failed workspace lookup falls through to canonical route recovery', async () => {
  const { handler } = loadHandler({
    workspaceError: new Error('workspace relation unavailable'),
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
  });

  const { response, result } = await invoke(handler, {
    route_id: 'route_1',
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
});

test('a failed Neon recovery falls through to the route-authorized Base44 copy', async () => {
  const { handler } = loadHandler({
    workspaceError: new Error('workspace relation unavailable'),
    canonicalError: new Error('canonical relation unavailable'),
    masterProperties: [{
      id: 'base44_1',
      address_hash: 'hash_1',
      created_by: 'manager@example.com',
      lat: 33.45,
      lng: -112.07,
    }],
  });

  const { response, result } = await invoke(handler, {
    route_id: 'route_1',
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(result.properties[0].id, 'base44_1');
});

test('Base44 recovery rejects null and zero-sentinel coordinates', async () => {
  const { handler } = loadHandler({
    workspaceError: new Error('workspace relation unavailable'),
    canonicalError: new Error('canonical relation unavailable'),
    masterProperties: [
      {
        id: 'null_coords',
        address_hash: 'hash_1',
        created_by: 'manager@example.com',
        lat: null,
        lng: null,
      },
      {
        id: 'zero_coords',
        address_hash: 'hash_1',
        created_by: 'manager@example.com',
        lat: 0,
        lng: 0,
      },
    ],
  });

  const { response, result } = await invoke(handler, {
    route_id: 'route_1',
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 0);
});

test('legacy compatibility rejects partial manifests and never reaches canonical properties', async () => {
  const route = {
    id: 'route_1',
    created_by: 'manager@example.com',
    created_date: '2026-07-23T20:00:00.000Z',
    property_hashes: ['hash_1', 'hash_2'],
  };
  const { handler, sqlCalls } = loadHandler({
    route,
    canonicalRows: [{
      id: 42,
      address_hash: 'hash_1',
      lat: 33.45,
      lng: -112.07,
    }],
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
    user_email: 'manager@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 0);
  assert.equal(sqlCalls.filter(query =>
    query.includes('FROM properties p') && !query.includes('INSERT INTO workspace_properties')
  ).length, 0);
});

test('a newly client-created exact-manifest route cannot authorize canonical recovery', async () => {
  const route = {
    id: 'route_new',
    created_by: 'rep@example.com',
    created_date: '2026-07-24T02:00:00.000Z',
    property_hashes: ['guessed_hash'],
  };
  const { handler, sqlCalls } = loadHandler({
    route,
    canonicalRows: [{
      id: 99,
      address_hash: 'guessed_hash',
      lat: 33.45,
      lng: -112.07,
    }],
    masterProperties: [{
      id: 'base44_99',
      address_hash: 'guessed_hash',
      created_by: 'different-tenant@example.com',
      lat: 33.45,
      lng: -112.07,
    }],
  });

  const { response, result } = await invoke(handler, {
    route_id: 'route_new',
    address_hashes: ['guessed_hash'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 0);
  assert.equal(sqlCalls.filter(query =>
    query.includes('FROM properties p') && !query.includes('INSERT INTO workspace_properties')
  ).length, 0);
  assert.equal(sqlCalls.filter(query => query.includes('INSERT INTO workspace_properties')).length, 0);
});

test('post-cutoff Base44-only routes retain the creator-owned CSV fallback', async () => {
  const route = {
    id: 'route_new_csv',
    created_by: 'rep@example.com',
    created_date: '2026-07-24T02:00:00.000Z',
    property_hashes: ['csv_hash'],
  };
  const { handler } = loadHandler({
    route,
    masterProperties: [{
      id: 'base44_csv',
      address_hash: 'csv_hash',
      created_by: 'rep@example.com',
      lat: 33.45,
      lng: -112.07,
    }],
  });

  const { response, result } = await invoke(handler, {
    route_id: 'route_new_csv',
    address_hashes: ['csv_hash'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(result.properties[0].id, 'base44_csv');
});

test('caller-visible interaction history authorizes creator-owned Base44 callback recovery', async () => {
  const property = {
    id: 'base44_42',
    address_hash: 'hash_1',
    created_by: 'manager@example.com',
    full_address: '100 Main St',
    lat: 33.45,
    lng: -112.07,
  };
  const { handler, sqlCalls } = loadHandler({
    route: null,
    interactionLogs: [{ address_hash: 'hash_1', created_by: 'manager@example.com' }],
    canonicalRows: [{ ...property, owner_full_name: 'Must not come from canonical' }],
    masterProperties: [property],
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(sqlCalls.filter(query =>
    query.includes('FROM properties p') && !query.includes('INSERT INTO workspace_properties')
  ).length, 0);
});

test('interaction history never authorizes a global canonical property read', async () => {
  const { handler, sqlCalls } = loadHandler({
    route: null,
    interactionLogs: [{ address_hash: 'victim_hash', created_by: 'attacker@example.com' }],
    canonicalRows: [{
      id: 42,
      address_hash: 'victim_hash',
      owner_full_name: 'Victim Owner',
      lat: 33.45,
      lng: -112.07,
    }],
    masterProperties: [{
      id: 'victim_copy',
      address_hash: 'victim_hash',
      created_by: 'victim@example.com',
      lat: 33.45,
      lng: -112.07,
    }],
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['victim_hash'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 0);
  assert.equal(sqlCalls.filter(query =>
    query.includes('FROM properties p') && !query.includes('INSERT INTO workspace_properties')
  ).length, 0);
});

test('callback proof wins over an exact post-cutoff route collision', async () => {
  const route = {
    id: 'one_door_route',
    manager_id: 'manager_1',
    created_by: 'manager@example.com',
    created_date: '2026-07-24T02:00:00.000Z',
    property_hashes: ['hash_1'],
  };
  const property = {
    id: 42,
    address_hash: 'hash_1',
    full_address: '100 Main St',
    lat: 33.45,
    lng: -112.07,
  };
  const { handler, routeFilterQueries } = loadHandler({
    route,
    interactionLogs: [{ address_hash: 'hash_1', created_by: 'manager@example.com' }],
    masterProperties: [{ ...property, created_by: 'manager@example.com' }],
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.ok(routeFilterQueries.length > 0);
});

test('partial callback proof is retried after no-owner route discovery', async () => {
  const route = {
    id: 'two_door_route',
    manager_id: 'manager_1',
    created_by: 'manager@example.com',
    created_date: '2026-07-24T02:00:00.000Z',
    property_hashes: ['hash_1', 'hash_2'],
  };
  const { handler, interactionFilterQueries } = loadHandler({
    user: {
      id: 'manager_1',
      email: 'manager@example.com',
      role: 'user',
    },
    route,
    routeFilter: ({ query }) => (
      query.manager_id === 'manager_1' ? [route] : []
    ),
    interactionLogs: ({ query }) => (
      query.address_hash.includes('hash_2') && query.address_hash.length === 1
        ? [{ address_hash: 'hash_2', created_by: 'manager@example.com' }]
        : [{ address_hash: 'hash_1', created_by: 'manager@example.com' }]
    ),
    masterProperties: [
      {
        id: 'base44_1',
        address_hash: 'hash_1',
        created_by: 'manager@example.com',
        lat: 33.45,
        lng: -112.07,
      },
      {
        id: 'base44_2',
        address_hash: 'hash_2',
        created_by: 'manager@example.com',
        lat: 33.46,
        lng: -112.08,
      },
    ],
  });

  const { response, result } = await invoke(handler, {
    address_hashes: ['hash_1', 'hash_2'],
  });

  assert.equal(response.status, 200);
  assert.equal(result.count, 2);
  assert.deepEqual(
    interactionFilterQueries.map(query => query.address_hash),
    [['hash_1', 'hash_2'], ['hash_2']]
  );
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
