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
  masterPropertyFilter,
  databaseUrl = 'postgres://test',
  routeGet,
  managerGet,
} = {}) {
  let handler;
  const sqlCalls = [];
  const sqlValueCalls = [];
  const routeFilterQueries = [];
  const interactionFilterQueries = [];
  const masterPropertyQueries = [];
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
  const filterMasterProperty = async (query, sort, limit) => {
    masterPropertyQueries.push({ query, sort, limit });
    if (masterPropertyFilter) return masterPropertyFilter({ query, sort, limit });
    const [field, criterion] = Object.entries(query || {})[0] || [];
    const values = Array.isArray(criterion)
      ? criterion
      : (Array.isArray(criterion?.$in) ? criterion.$in : [criterion]);
    return masterProperties.filter(property => values.includes(property?.[field]) && (!query.manager_id || property.manager_id === query.manager_id)).slice(0, limit);
  };
  const base44 = {
    auth: { me: async () => user },
    entities: {
      SavedRoute: {
        get: async (id) => routeGet ? routeGet(id) : (id === route?.id ? route : null),
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
            if (managerGet) return managerGet(id);
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
      env: { get: () => databaseUrl },
      serve: (candidate) => { handler = candidate; },
    },
    Response,
    console,
    setTimeout: callback => setTimeout(callback, 0),
  };
  vm.runInNewContext(source, sandbox);
  return {
    handler,
    interactionFilterQueries,
    routeFilterQueries,
    sqlCalls,
    sqlValueCalls,
    masterPropertyQueries,
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

const serviceImportRoute = { id: 'import-route', manager_id: 'manager_1', created_by: 'manager@example.com', created_date: '2026-10-02T19:08:28.934Z', property_hashes: ['import_hash'], metadata: { source: 'csv_import' } };
const serviceImportProperty = { id: 'import-property', address_hash: 'import_hash', manager_id: 'manager_1', created_by: 'service+runtime-id@no-reply.base44.com', data_source: 'csv_import', lat: 28.7, lng: -81.3 };

test('service-created imported stops load for their verified manager and assigned workspace reps', async () => {
  for (const user of [
    {id:'manager_1',email:'manager@example.com',role:'user'},
    {id:'rep_1',email:'rep@example.com',role:'user',data:{team_manager_id:'manager_1'}},
  ]) {
    const {handler}=loadHandler({user,route:serviceImportRoute,masterProperties:[serviceImportProperty]});
    const {response,result}=await invoke(handler,{route_id:serviceImportRoute.id,address_hashes:serviceImportRoute.property_hashes});
    assert.equal(response.status,200);
    assert.equal(result.count,1);
    assert.equal(result.properties[0].id,'import-property');
  }
});

test('service import lookup scopes duplicate hashes before response limits', async () => {
  const foreign={...serviceImportProperty,id:'foreign-property',manager_id:'other-manager'};
  const user={id:'manager_1',email:'manager@example.com',role:'user'};
  const {handler}=loadHandler({user,route:serviceImportRoute,masterProperties:[foreign,serviceImportProperty]});
  const {result}=await invoke(handler,{route_id:serviceImportRoute.id,address_hashes:serviceImportRoute.property_hashes});
  assert.equal(result.count,1);
  assert.equal(result.properties[0].id,'import-property');
});

test('missing or foreign workspace tags and caller-forged import tags cannot authorize service recovery', async () => {
  const user={id:'manager_1',email:'manager@example.com',role:'user'};
  for (const property of [
    {...serviceImportProperty,manager_id:undefined},
    {...serviceImportProperty,manager_id:'foreign-manager'},
    {...serviceImportProperty,created_by:'outsider@example.com'},
    {...serviceImportProperty,data_source:'manual'},
  ]) {
    const {handler}=loadHandler({user,route:serviceImportRoute,masterProperties:[property]});
    const {result}=await invoke(handler,{route_id:serviceImportRoute.id,address_hashes:serviceImportRoute.property_hashes});
    assert.equal(result.count,0);
  }
});

test('a caller-visible route with a forged foreign manager cannot expose that manager service imports', async () => {
  const user={id:'attacker',email:'attacker@example.com',role:'user'};
  const route={...serviceImportRoute,created_by:user.email};
  const {handler}=loadHandler({user,route,masterProperties:[serviceImportProperty]});
  const {result}=await invoke(handler,{route_id:route.id,address_hashes:route.property_hashes});
  assert.equal(result.count,0);
});

test('service-created team imports hydrate every batch for managers and reps without Neon', async () => {
  const properties = Array.from({ length: 263 }, (_, index) => ({
    ...serviceImportProperty, id: `import-${index}`, address_hash: `hash-${index}`,
  }));
  const route = {
    ...serviceImportRoute, created_by: serviceImportProperty.created_by,
    property_hashes: properties.map(property => property.address_hash),
  };
  for (const user of [
    { id: 'manager_1', email: 'manager@example.com', role: 'user', app_role: 'manager' },
    { id: 'rep_1', email: 'rep@example.com', role: 'user', data: { team_manager_id: 'manager_1' } },
    { id: 'rep_2', email: 'rep2@example.com', role: 'user', team_manager_id: 'manager_1' },
  ]) {
    const { handler, sqlCalls, masterPropertyQueries } = loadHandler({ user, route, masterProperties: properties, databaseUrl: null });
    const { response, result } = await invoke(handler, { route_id: route.id, address_hashes: route.property_hashes });
    assert.equal(response.status, 200);
    assert.equal(result.count, 263);
    assert.deepEqual(result.properties.map(property => property.address_hash), route.property_hashes);
    assert.equal(sqlCalls.length, 0);
    assert.equal(masterPropertyQueries.length, 1);
    assert.ok(masterPropertyQueries.every(({ query }) => query.manager_id === 'manager_1' && Array.isArray(query.address_hash?.$in)));
  }
});

test('service import fast lookup retries the alternate filter when the first read fails', async () => {
  let calls = 0;
  const { handler, sqlCalls } = loadHandler({
    user: { id: 'manager_1', email: 'manager@example.com', role: 'user' },
    route: serviceImportRoute,
    masterPropertyFilter: () => {
      if (++calls === 1) throw new Error('temporarily unavailable');
      return [serviceImportProperty];
    },
    databaseUrl: null,
  });
  const { response, result } = await invoke(handler, { route_id: serviceImportRoute.id, address_hashes: ['import_hash'] });
  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(calls, 2);
  assert.equal(sqlCalls.length, 0);
});

test('a shared service audit email cannot authorize another team properties', async () => {
  const { handler } = loadHandler({
    user: { id: 'manager_1', email: 'manager@example.com', role: 'user' },
    route: { ...serviceImportRoute, created_by: serviceImportProperty.created_by },
    masterProperties: [{ ...serviceImportProperty, manager_id: 'foreign-manager' }],
  });
  const { result } = await invoke(handler, { route_id: serviceImportRoute.id, address_hashes: ['import_hash'] });
  assert.equal(result.count, 0);
});

test('service import legacy aliases load in manifest order and remain route-authorized', async () => {
  const property = { ...serviceImportProperty, legacy_hash: 'old-import-hash' };
  const route = { ...serviceImportRoute, property_hashes: ['old-import-hash'] };
  const { handler, sqlCalls } = loadHandler({
    user: { id: 'manager_1', email: 'manager@example.com', role: 'user' },
    route, masterProperties: [property], databaseUrl: null,
  });
  const { response, result } = await invoke(handler, { route_id: route.id, address_hashes: ['old-import-hash'] });
  assert.equal(response.status, 200);
  assert.equal(result.properties[0].id, property.id);
  assert.equal(sqlCalls.length, 0);
  const denied = await invoke(handler, { route_id: route.id, address_hashes: ['import_hash'] });
  assert.equal(denied.response.status, 403);
});

test('rate-limited imported property reads retry the same tenant query instead of returning empty routes', async () => {
  let calls = 0;
  const { handler, sqlCalls, masterPropertyQueries } = loadHandler({
    user: { id: 'manager_1', email: 'manager@example.com', role: 'user' },
    route: serviceImportRoute,
    masterPropertyFilter: () => {
      if (++calls <= 2) throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      return [serviceImportProperty];
    },
  });
  const { response, result } = await invoke(handler, { route_id: serviceImportRoute.id, address_hashes: ['import_hash'] });
  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(calls, 3);
  assert.ok(masterPropertyQueries.every(({ query }) => query.manager_id === 'manager_1' && query.address_hash.$in));
  assert.equal(sqlCalls.length, 0);
});

test('persistent import rate limits remain retryable failures and never become successful empty loads', async () => {
  let calls = 0;
  const { handler, sqlCalls } = loadHandler({
    user: { id: 'manager_1', email: 'manager@example.com', role: 'user' },
    route: serviceImportRoute,
    masterPropertyFilter: () => {
      calls++;
      throw Object.assign(new Error('Rate limit exceeded'), { response: { status: 429 } });
    },
  });
  const { response, result } = await invoke(handler, { route_id: serviceImportRoute.id, address_hashes: ['import_hash'] });
  assert.equal(response.status, 429);
  assert.equal(result.count, undefined);
  assert.equal(calls, 4);
  assert.equal(sqlCalls.length, 0);
});

test('route authorization throttling retries instead of reporting access denied', async () => {
  let calls = 0;
  const { handler } = loadHandler({
    user: { id: 'manager_1', email: 'manager@example.com', role: 'user' },
    route: serviceImportRoute, masterProperties: [serviceImportProperty],
    routeGet: () => {
      if (++calls === 1) throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      return serviceImportRoute;
    },
  });
  const { response, result } = await invoke(handler, { route_id: serviceImportRoute.id, address_hashes: ['import_hash'] });
  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(calls, 2);
});

test('rep manager resolution recovers from throttling without switching workspaces', async () => {
  let calls = 0;
  const { handler } = loadHandler({
    user: { id: 'rep_1', email: 'rep@example.com', role: 'user', team_manager_id: 'manager_1' },
    route: { ...serviceImportRoute, created_by: serviceImportProperty.created_by },
    masterProperties: [serviceImportProperty],
    managerGet: () => {
      if (++calls === 1) throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      return { id: 'manager_1', email: 'manager@example.com' };
    },
  });
  const { response, result } = await invoke(handler, { route_id: serviceImportRoute.id, address_hashes: ['import_hash'] });
  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(result.user_email, 'manager@example.com');
  assert.equal(calls, 2);
});

test('older clients do not turn throttled route discovery into empty successful hydration', async () => {
  let calls = 0;
  const { handler, sqlCalls } = loadHandler({
    user: { id: 'manager_1', email: 'manager@example.com', role: 'user' },
    route: serviceImportRoute,
    routeFilter: () => {
      calls++;
      throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    },
  });
  const { response, result } = await invoke(handler, { user_email: 'manager@example.com', address_hashes: ['import_hash'] });
  assert.equal(response.status, 429);
  assert.equal(result.count, undefined);
  assert.equal(calls, 4);
  assert.equal(sqlCalls.length, 0);
});

test('Precision routes use their Neon workspace without scanning Base44 imports', async () => {
  const route = { ...serviceImportRoute, property_hashes: ['provider-hash'], metadata: { source: 'precision_generation_job' } };
  const property = { id: 'provider-property', address_hash: 'provider-hash', lat: 28.7, lng: -81.3 };
  const { handler, masterPropertyQueries } = loadHandler({
    user: { id: 'manager_1', email: 'manager@example.com', role: 'user' },
    route, workspaceRows: [property],
  });
  const { response, result } = await invoke(handler, { route_id: route.id, address_hashes: route.property_hashes });
  assert.equal(response.status, 200);
  assert.equal(result.count, 1);
  assert.equal(masterPropertyQueries.length, 0);
});

test('the 17-route import overview reads manifests once and 2,774 homes in six tenant-scoped batches', async () => {
  const properties = Array.from({ length: 2774 }, (_, index) => ({
    ...serviceImportProperty, id: `door-${index}`, address_hash: `import_${index}`,
  }));
  const routes = Array.from({ length: 17 }, (_, index) => ({
    ...serviceImportRoute, id: `route-${index}`,
    property_hashes: properties.slice(index * 160, index === 16 ? undefined : (index + 1) * 160).map(property => property.address_hash),
  }));
  for (const user of [
    { id: 'manager_1', email: 'manager@example.com', role: 'user' },
    { id: 'rep_1', email: 'rep@example.com', role: 'user', team_manager_id: 'manager_1' },
  ]) {
    const harness = loadHandler({ user, visibleOwnerRoutes: routes, masterProperties: properties, databaseUrl: null });
    const { response, result } = await invoke(harness.handler, { route_ids: routes.map(route => route.id), user_email: 'foreign@example.com' });
    assert.equal(response.status, 200);
    assert.equal(result.routes.length, 17);
    assert.equal(result.routes.reduce((count, route) => count + route.properties.length, 0), 2774);
    assert.equal(harness.routeFilterQueries.length, 1);
    assert.equal(harness.masterPropertyQueries.length, 6);
    assert.equal(harness.sqlCalls.length, 0);
    assert.ok(harness.masterPropertyQueries.every(({ query }) => query.manager_id === 'manager_1'));
  }
});

test('a batch cannot expose unassigned/foreign routes or forged manager identities', async () => {
  for (const options of [
    { visibleOwnerRoutes: [] },
    { visibleOwnerRoutes: [{ ...serviceImportRoute, manager_id: 'foreign-manager' }] },
  ]) {
    const harness = loadHandler({
      user: { id: 'rep_1', email: 'rep@example.com', role: 'user', team_manager_id: 'manager_1' },
      masterProperties: [serviceImportProperty], ...options,
    });
    const { response } = await invoke(harness.handler, { route_ids: [serviceImportRoute.id] });
    assert.equal(response.status, 403);
    assert.equal(harness.masterPropertyQueries.length, 0);
  }
});

test('bulk import reads reject oversized requests and preserve persistent rate limits', async () => {
  const malformed = loadHandler();
  for (const route_ids of [[], [''], [42], Array.from({ length: 41 }, (_, index) => `route-${index}`)]) {
    const { response } = await invoke(malformed.handler, { route_ids });
    assert.equal(response.status, 400);
  }
  assert.equal(malformed.routeFilterQueries.length, 0);
  const throttled = loadHandler({
    user: { id: 'manager_1', email: 'manager@example.com', role: 'user' },
    visibleOwnerRoutes: [serviceImportRoute],
    masterPropertyFilter: () => { throw Object.assign(new Error('Rate limit exceeded'), { status: 429, response: { headers: { 'retry-after': '30' } } }); },
  });
  const { response } = await invoke(throttled.handler, { route_ids: [serviceImportRoute.id] });
  assert.equal(response.status, 429);
  assert.equal(throttled.masterPropertyQueries.length, 1);
  assert.equal(response.headers.get('retry-after'), '30');
});
