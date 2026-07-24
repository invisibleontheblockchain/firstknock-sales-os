import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const backendPath = 'base44/functions/generateRoutesBackend/entry.ts';

function loadBackendHandler() {
  const source = readFileSync(resolve(rootDir, backendPath), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: backendPath,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${backendPath} contains TypeScript syntax errors`);

  let handler;
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => ({
      auth: { me: async () => ({ id: 'route_test_user' }) },
    }),
    Deno: { serve: (registeredHandler) => { handler = registeredHandler; } },
    Request,
    Response,
  }, { filename: backendPath });
  assert.equal(typeof handler, 'function');
  return handler;
}

async function generate(properties, extraBody = {}) {
  const handler = loadBackendHandler();
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      properties,
      houses_per_route: 100,
      ...extraBody,
    }),
  }));
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

function property({
  id,
  subdivision,
  street,
  house,
  lat,
  lng,
}) {
  return {
    id,
    address_hash: id,
    subdivision_name: subdivision,
    street_name: street,
    house_number: String(house),
    city: 'Example',
    state: 'NC',
    zip_code: '28000',
    lat,
    lng,
  };
}

function compressed(values) {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function routePropertyOrderFingerprint(properties) {
  const identities = properties.map((door) => String(door.address_hash || door.legacy_hash || door.id || '').trim());
  assert.equal(identities.every(Boolean), true);

  let first = 2166136261;
  let second = 2246822507;
  identities.forEach((identity) => {
    const framed = `${identity.length}:${identity}|`;
    for (let index = 0; index < framed.length; index += 1) {
      const code = framed.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 3266489909);
    }
  });
  return `${identities.length}:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

test('large backend uses deterministic suffix-preserving street blocks inside atomic subdivision access blocks', async () => {
  const properties = [
    property({ id: 'a-oak-st-1', subdivision: 'Access A', street: 'Oak Street', house: 101, lat: 35.000, lng: -80.000 }),
    property({ id: 'a-oak-st-2', subdivision: 'Access A', street: 'Oak St.', house: 102, lat: 35.001, lng: -80.000 }),
    property({ id: 'b-birch-1', subdivision: 'Access B', street: 'Birch Lane', house: 201, lat: 35.004, lng: -80.001 }),
    property({ id: 'a-oak-rd-1', subdivision: 'Access A', street: 'Oak Road', house: 301, lat: 35.008, lng: -80.001 }),
    property({ id: 'a-pine-1', subdivision: 'Access A', street: 'Pine Court', house: 401, lat: 35.009, lng: -80.002 }),
    property({ id: 'b-birch-2', subdivision: 'Access B', street: 'Birch Ln', house: 202, lat: 35.005, lng: -80.001 }),
    property({ id: 'a-oak-rd-2', subdivision: 'Access A', street: 'Oak Rd.', house: 302, lat: 35.007, lng: -80.001 }),
    property({ id: 'a-pine-2', subdivision: 'Access A', street: 'Pine Ct', house: 402, lat: 35.010, lng: -80.002 }),
    property({ id: 'a-pine-3', subdivision: 'Access A', street: 'Pine Court', house: 403, lat: 35.011, lng: -80.002 }),
  ];

  const result = await generate(properties);
  const reversedInputResult = await generate([...properties].reverse());
  const output = result.routes.flatMap((route) => route.properties);
  const outputIds = output.map((door) => door.id);
  const reversedInputIds = reversedInputResult.routes.flatMap((route) => route.properties).map((door) => door.id);
  const subdivisionSequence = compressed(output.map((door) => door.subdivision_name));

  assert.deepEqual(outputIds, reversedInputIds);
  assert.deepEqual([...outputIds].sort(), properties.map((door) => door.id).sort());
  assert.equal(new Set(outputIds).size, properties.length);
  assert.equal(subdivisionSequence.length, 2);
  assert.deepEqual(new Set(subdivisionSequence), new Set(['Access A', 'Access B']));
  assert.equal(result.routing_metadata.canonical_street_block_count, 4);
  assert.equal(result.routing_metadata.subdivision_access_block_count, 2);
  assert.equal(result.routing_metadata.exact_once_verified, true);
  result.routes.forEach((route) => {
    assert.equal(
      route.metadata.routing.property_order_fingerprint,
      routePropertyOrderFingerprint(route.properties),
    );
  });
});

test('large backend rejects properties that could not produce a durable map pin', async () => {
  for (const invalidCoordinates of [
    { lat: null, lng: null },
    { lat: 0, lng: 0 },
  ]) {
    const handler = loadBackendHandler();
    const response = await handler(new Request('https://app.example.com/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        properties: [
          property({
            id: 'valid',
            subdivision: 'Access A',
            street: 'Pine Court',
            house: 401,
            lat: 35,
            lng: -80,
          }),
          property({
            id: 'invalid',
            subdivision: 'Access A',
            street: 'Pine Court',
            house: 403,
            ...invalidCoordinates,
          }),
        ],
        houses_per_route: 100,
      }),
    }));
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.equal(result.code, 'INVALID_PROPERTY_COORDINATES');
    assert.equal(result.invalid_property_index, 1);
  }
});

test('large backend chunks near the target at access boundaries without losing or duplicating doors', async () => {
  const properties = [];
  for (let index = 0; index < 4; index++) {
    properties.push(property({
      id: `a-one-${index}`,
      subdivision: 'Access A',
      street: 'First Street',
      house: 101 + index,
      lat: 35 + index * 0.0001,
      lng: -80,
    }));
    properties.push(property({
      id: `a-two-${index}`,
      subdivision: 'Access A',
      street: 'Second Street',
      house: 201 + index,
      lat: 35.001 + index * 0.0001,
      lng: -80,
    }));
  }
  for (let index = 0; index < 11; index++) {
    properties.push(property({
      id: `b-${index}`,
      subdivision: 'Access B',
      street: 'Third Avenue',
      house: 301 + index,
      lat: 35.01 + index * 0.0001,
      lng: -80,
    }));
  }

  const result = await generate(properties, { houses_per_route: 10 });
  const output = result.routes.flatMap((route) => route.properties);
  const outputIds = output.map((door) => door.id);

  assert.deepEqual(result.routes.map((route) => route.houseCount).sort((a, b) => a - b), [8, 11]);
  assert.equal(result.routes.every((route) =>
    new Set(route.properties.map((door) => door.subdivision_name)).size === 1
  ), true);
  assert.deepEqual([...outputIds].sort(), properties.map((door) => door.id).sort());
  assert.equal(new Set(outputIds).size, properties.length);
  assert.equal(result.routing_metadata.input_property_count, properties.length);
  assert.equal(result.routing_metadata.output_property_count, properties.length);
  assert.equal(result.routing_metadata.route_count, 2);
  result.routes.forEach((route) => {
    assert.equal(
      route.metadata.routing.property_order_fingerprint,
      routePropertyOrderFingerprint(route.properties),
    );
  });
});

test('large backend orients a complete street sweep against both fixed endpoints and reports fallback metadata', async () => {
  const properties = [
    property({ id: 'left', subdivision: 'Access A', street: 'Main Street', house: 101, lat: 10, lng: 10.01 }),
    property({ id: 'middle', subdivision: 'Access A', street: 'Main Street', house: 103, lat: 10, lng: 10.02 }),
    property({ id: 'right', subdivision: 'Access A', street: 'Main Street', house: 105, lat: 10, lng: 10.03 }),
  ];
  const start = { lat: 10, lng: 10.04 };
  const end = { lat: 10, lng: 10 };

  const result = await generate(properties, {
    start_location: start,
    end_location: end,
    route_origin_mode: 'current_to_home',
  });
  const [route] = result.routes;

  assert.deepEqual(route.properties.map((door) => door.id), ['right', 'middle', 'left']);
  assert.deepEqual(route.startLocation, start);
  assert.deepEqual(route.endLocation, end);
  assert.equal(route.routeOriginMode, 'current_to_home');
  assert.equal(route.metadata.routing.fallback, true);
  assert.equal(route.metadata.routing.road_network_used, false);
  assert.equal(result.routing_metadata.strategy, 'canonical_street_subdivision_continuity');
  assert.equal(result.routing_metadata.fallback_reason, 'road_network_unavailable_in_large_route_backend');
});
