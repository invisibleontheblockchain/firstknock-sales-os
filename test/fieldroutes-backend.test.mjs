import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const integrationPath = 'base44/functions/fieldRoutesIntegration/entry.ts';
const migrationPath = 'base44/functions/setupFieldRoutesIntegration/entry.ts';
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

function loadInternals({ fetchImpl = async () => Response.json({ success: true }), env = {} } = {}) {
  const exposed = [
    'providerLocation', 'providerCall', 'parseCreatedId', 'exactCustomerMatch',
    'appointmentHasMarker', 'safeConnection', 'redactRecursive', 'encryptJson',
    'decryptJson', 'resolveCanvasStreetOwnership', 'scheduleResponse', 'normalizeContact',
    'serviceTypesFromPayload', 'parseBody', 'canonicalCanvasHouseIdentity', 'safeRateBudget',
    'validateConfiguredServiceType', 'validateCanvasAddressWithBatchData',
    'fieldRoutesAddressLine', 'canvasVerificationDistanceOutcome', 'canvasAddressVerificationInputHash',
    'reusableCanvasAddressValidation', 'requestIntegrationSnapshot', 'assertRequestIntegrationSnapshot',
    'fieldRoutesAppointmentNotes', 'canSupersedeCanvasAddressReview', 'retryAllowed', 'sha256',
    'fieldRoutesModes', 'assertFieldRoutesScheduleSourceEnabled'
  ];
  const transpiled = ts.transpileModule(readSource(integrationPath), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: integrationPath,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], 'FieldRoutes integration contains TypeScript errors');
  const executable = transpiled.outputText
    .replace(/^import .*;\s*$/gm, '')
    .replace('Deno.serve(', `globalThis.__fieldRoutesInternals = { ${exposed.join(', ')} }; Deno.serve(`);
  const context = {
    console,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Request,
    Response,
    URL,
    URLSearchParams,
    atob,
    btoa,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    neon: () => { throw new Error('database must not be used by helper tests'); },
    createClientFromRequest: () => { throw new Error('auth must not be used by helper tests'); },
    Deno: {
      env: { get: (key) => env[key] ?? null },
      serve: () => {}
    }
  };
  vm.runInNewContext(executable, context, { filename: integrationPath });
  return context.__fieldRoutesInternals;
}

function batchDataHarness(makeAddresses, { httpStatus = 200, payloadStatus = 200 } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), options, body });
      const request = body.requests[0];
      const base = {
        street: '42 West Oak Street',
        streetNoUnit: '42 West Oak Street',
        city: 'Phoenix',
        state: 'AZ',
        zip: '85001-1234',
        hash: 'batchdata-provider-address-hash',
        latitude: 33.45005,
        longitude: -112.07005,
        requestId: request.requestId,
        meta: { error: false, normalized: true, hashed: true },
        error: false,
        houseNumber: '42',
        unitNumber: request.street.includes('#') ? '4B' : null,
        unitType: request.street.includes('#') ? 'APT' : null,
        dpvMatchCode: 'Y',
        dpvFootnotes: 'AABB'
      };
      const addresses = makeAddresses ? makeAddresses(base, request) : [base];
      return Response.json({ status: { code: payloadStatus, text: payloadStatus === 200 ? 'OK' : 'Error' }, results: { addresses } }, { status: httpStatus });
    }
  };
}

test('FieldRoutes backend and migration transpile deterministically', () => {
  for (const path of [integrationPath, migrationPath]) {
    const transpiled = ts.transpileModule(readSource(path), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: path,
      reportDiagnostics: true
    });
    const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    assert.deepEqual(errors, [], `${path} contains TypeScript errors`);
  }
});

test('provider host allowlist permits only FieldRoutes production subdomains and exact legacy staging', () => {
  const { providerLocation } = loadInternals();
  assert.deepEqual(
    JSON.parse(JSON.stringify(providerLocation({ environment: 'production', subdomain: 'acme-west' }))),
    { environment: 'production', subdomain: 'acme-west', baseUrl: 'https://acme-west.fieldroutes.com/api/' }
  );
  assert.equal(providerLocation({ environment: 'legacy_staging' }).baseUrl, 'https://stagingdemo.pestroutes.com/api/');
  assert.throws(() => providerLocation({ environment: 'production', subdomain: 'evil.example.com' }));
  assert.throws(() => providerLocation({ environment: 'https://evil.example.com', subdomain: 'acme' }));
});

test('provider client posts urlencoded data with authentication fields last', async () => {
  let captured;
  const { providerCall } = loadInternals({
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return Response.json({ success: true, result: 41, tokenUsage: { writesToday: 2 } });
    }
  });
  const result = await providerCall(
    { environment: 'production', subdomain: 'acme', base_url: 'https://acme.fieldroutes.com/api/' },
    { authenticationKey: 'key-value', authenticationToken: 'token-value' },
    'customer/create',
    { fname: 'Ada', lname: 'Lovelace' },
    true
  );
  assert.equal(captured.url, 'https://acme.fieldroutes.com/api/customer/create');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['content-type'], 'application/x-www-form-urlencoded');
  const keys = [...new URLSearchParams(captured.options.body).keys()];
  assert.deepEqual(keys.slice(-2), ['authenticationKey', 'authenticationToken']);
  assert.equal(result.tokenUsage.writesToday, 2);
});

test('provider client accepts Swagger responses without success and rejects stored host tampering', async () => {
  let calls = 0;
  const { providerCall } = loadInternals({ fetchImpl: async () => { calls += 1; return Response.json(98765); } });
  const connection = { environment: 'production', subdomain: 'acme', base_url: 'https://acme.fieldroutes.com/api/' };
  const credentials = { authenticationKey: 'key', authenticationToken: 'token' };
  const result = await providerCall(connection, credentials, 'customer/create', {}, true);
  assert.equal(result.payload, 98765);
  await assert.rejects(() => providerCall({ ...connection, base_url: 'https://evil.example/api/' }, credentials, 'customer/create', {}, true));
  assert.equal(calls, 1, 'tampered host must be rejected before fetch');
});

test('create ID parser supports only the documented raw and result shapes', () => {
  const { parseCreatedId } = loadInternals();
  assert.equal(parseCreatedId(123, 'customerID'), '123');
  assert.equal(parseCreatedId({ success: true, result: 456 }, 'customerID'), '456');
  assert.equal(parseCreatedId({ result: { appointmentID: '789' } }, 'appointmentID'), '789');
  assert.throws(() => parseCreatedId({ success: true, customerID: 123 }, 'customerID'));
  assert.throws(() => parseCreatedId({ success: true, result: 0 }, 'customerID'));
});

test('dedup requires exact normalized street, ZIP, and unit and marker reads appointmentNotes', () => {
  const { exactCustomerMatch, appointmentHasMarker, fieldRoutesAddressLine } = loadInternals();
  const address = { street_address: '12 W. Oak St.', zip: '85001-1234', unit: 'Apt 4B' };
  assert.equal(fieldRoutesAddressLine(address), '12 W. Oak St. # 4B');
  assert.equal(exactCustomerMatch({ address: '12 West Oak Street # 4B', zip: '85001' }, address), true);
  assert.equal(exactCustomerMatch({ address: '12 West Oak Street # 4C', zip: '85001' }, address), false);
  assert.equal(exactCustomerMatch({ address: '12 West Oak Street', zip: '85001' }, address), false, 'base-building rows cannot satisfy a unit request');
  assert.equal(exactCustomerMatch({ address: '12 West Oak Street # 4B', zip: '85002' }, address), false);
  assert.equal(exactCustomerMatch(
    { address: '103 McCoy Street # A', zip: '85001' },
    { street_address: '103 McCoy St Unit A', zip: '85001', unit: null }
  ), true, 'an embedded Precision unit remains part of exact identity');
  assert.equal(appointmentHasMarker({ appointmentNotes: 'Lead FK:opaque-marker' }, 'FK:opaque-marker'), true);
});

test('reviewed contact requires explicit first and last name plus a valid contact channel', () => {
  const { normalizeContact } = loadInternals();
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeContact({ first_name: 'Ada', last_name: 'Lovelace', email: 'ADA@example.com' }))), {
    first_name: 'Ada', last_name: 'Lovelace', phone: null, email: 'ada@example.com'
  });
  assert.equal(normalizeContact({ first_name: 'Ada', last_name: 'Lovelace', phone: '+1 (602) 555-1212' }).phone, '6025551212');
  assert.throws(() => normalizeContact({ first_name: 'Ada', last_name: 'Lovelace' }));
  assert.throws(() => normalizeContact({ first_name: 'Ada', last_name: 'Lovelace', phone: '60255512' }));
  assert.throws(() => normalizeContact({ first_name: 'Ada', last_name: 'Lovelace', phone: '602555121' }));
  assert.throws(() => normalizeContact({ first_name: 'Ada', email: 'ada@example.com' }));
  assert.throws(() => normalizeContact({ last_name: 'Lovelace', phone: '6025551212' }));
});

test('service type normalization handles includeData maps and preserves scheduling metadata', () => {
  const { serviceTypesFromPayload, validateConfiguredServiceType } = loadInternals();
  const result = serviceTypesFromPayload({
    serviceTypes: {
      15: { typeID: 15, officeID: 2, description: 'Initial inspection', defaultLength: 45, initial: 1, visible: 1 },
      16: { typeID: 16, officeID: 2, description: 'Hidden', defaultLength: 30, initial: 1, visible: 0 },
      17: { typeID: 17, officeID: 2, description: 'Recurring', defaultLength: 60, initial: 0, visible: 1 }
    }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{
    id: '15', type_id: '15', name: 'Initial inspection', description: 'Initial inspection',
    visible: true, initial: true, default_length: 45, office_id: '2'
  }]);
  assert.equal(validateConfiguredServiceType({ default_service_type_id: '15', office_id: null }, result).id, '15');
  assert.throws(() => validateConfiguredServiceType({ default_service_type_id: '99', office_id: null }, result));
  assert.throws(() => validateConfiguredServiceType({ default_service_type_id: '15', office_id: null }, [
    ...result,
    { ...result[0], id: '18', type_id: '18', office_id: '3' }
  ]));
});

test('Canvas business identity ignores point jitter but separates units', () => {
  const { canonicalCanvasHouseIdentity } = loadInternals();
  const first = canonicalCanvasHouseIdentity('campaign-1', 'zone-1', 'street-1', { street_address: '42 Oak St.', zip: '85001', unit: 'Apt A', lat: 33.1, lng: -112.1 });
  const nearby = canonicalCanvasHouseIdentity('campaign-1', 'zone-1', 'street-1', { street_address: '42 Oak Street', zip: '85001-1000', unit: '#A', lat: 33.10005, lng: -112.10005 });
  const otherUnit = canonicalCanvasHouseIdentity('campaign-1', 'zone-1', 'street-1', { street_address: '42 Oak Street', zip: '85001', unit: 'B', lat: 33.1, lng: -112.1 });
  assert.equal(first, nearby);
  assert.notEqual(first, otherUnit);
});

test('Canvas address verification uses the documented correlated BatchData response and provider-confirmed unit', async () => {
  const harness = batchDataHarness();
  const { validateCanvasAddressWithBatchData } = loadInternals({ env: { BATCH_DATA_API_KEY: 'test-batch-key' }, fetchImpl: harness.fetchImpl });
  const result = await validateCanvasAddressWithBatchData({ address: {
    street_address: '42 W. Oak St.', city: 'Phoenix', state: 'AZ', zip: '85001', unit: 'Apt 4B', lat: 33.45, lng: -112.07
  } });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].url, 'https://api.batchdata.com/api/v1/address/verify');
  assert.equal(harness.calls[0].options.headers.authorization, 'Bearer test-batch-key');
  assert.deepEqual(Object.keys(harness.calls[0].body.requests[0]), ['street', 'city', 'state', 'zip', 'requestId']);
  assert.equal(harness.calls[0].body.requests[0].street, '42 W. Oak St. # 4B');
  assert.match(harness.calls[0].body.requests[0].requestId, /^[a-f0-9]{64}$/);
  assert.equal(result.address.street_address, '42 West Oak Street');
  assert.equal(result.address.unit, '4B', 'unit must come from BatchData unitNumber, never client text');
  assert.equal(result.receipt.provider_address_hash, 'batchdata-provider-address-hash');
  assert.equal(result.receipt.dpv_match_code, 'Y');
});

test('BatchData accepts normalized street/direction and USPS city alias but ignores geoLocation ordering', async () => {
  const harness = batchDataHarness((base) => [{ ...base, city: 'Scottsdale', geoLocation: [-112.07, 33.45] }]);
  const { validateCanvasAddressWithBatchData } = loadInternals({ env: { BATCH_DATA_API_KEY: 'key' }, fetchImpl: harness.fetchImpl });
  const result = await validateCanvasAddressWithBatchData({ address: {
    street_address: '42 W Oak St', city: 'Phoenix', state: 'AZ', zip: '85001', unit: null, lat: 33.45, lng: -112.07
  } });
  assert.equal(result.address.city, 'Scottsdale');
  assert.equal(result.address.unit, null);
});

test('BatchData fails closed on unit, DPV, correlation, identity, and result ambiguity', async () => {
  const input = { address: { street_address: '42 W Oak St', city: 'Phoenix', state: 'AZ', zip: '85001', unit: '4B', lat: 33.45, lng: -112.07 } };
  const cases = [
    ['canvas_address_validation_unit_mismatch', (base) => [{ ...base, unitNumber: null, unitType: null }]],
    ['canvas_address_validation_secondary_missing', (base) => [{ ...base, dpvMatchCode: 'D' }]],
    ['canvas_address_validation_not_deliverable', (base) => [{ ...base, dpvMatchCode: 'S' }]],
    ['canvas_address_validation_correlation_mismatch', (base) => [{ ...base, requestId: 'wrong-request' }]],
    ['canvas_address_validation_primary_mismatch', (base) => [{ ...base, houseNumber: '43', streetNoUnit: '43 West Oak Street' }]],
    ['canvas_address_validation_region_mismatch', (base) => [{ ...base, state: 'CA' }]],
    ['canvas_address_validation_not_verified', (base) => [{ ...base, meta: { error: false, normalized: false, hashed: true } }]],
    ['canvas_address_validation_not_verified', (base) => [{ ...base, meta: { error: false, normalized: true, hashed: false } }]],
    ['canvas_address_validation_missing_coordinates', (base) => [{ ...base, latitude: null, longitude: null }]],
    ['canvas_address_validation_ambiguous', (base) => [base, { ...base }]]
  ];
  for (const [code, makeAddresses] of cases) {
    const harness = batchDataHarness(makeAddresses);
    const { validateCanvasAddressWithBatchData } = loadInternals({ env: { BATCH_DATA_API_KEY: 'key' }, fetchImpl: harness.fetchImpl });
    await assert.rejects(() => validateCanvasAddressWithBatchData(input), (error) => error?.code === code, code);
  }
  const noMatch = batchDataHarness(() => []);
  const { validateCanvasAddressWithBatchData: validateNoMatch } = loadInternals({ env: { BATCH_DATA_API_KEY: 'key' }, fetchImpl: noMatch.fetchImpl });
  await assert.rejects(() => validateNoMatch(input), (error) => error?.code === 'canvas_address_validation_no_match');
  const noUnitDpv = batchDataHarness((base) => [{ ...base, dpvMatchCode: 'D', unitNumber: null, unitType: null }]);
  const { validateCanvasAddressWithBatchData: validateNoUnitDpv } = loadInternals({ env: { BATCH_DATA_API_KEY: 'key' }, fetchImpl: noUnitDpv.fetchImpl });
  await assert.rejects(
    () => validateNoUnitDpv({ ...input, address: { ...input.address, unit: null } }),
    (error) => error?.code === 'canvas_address_validation_secondary_missing'
  );
});

test('Canvas coordinate policy passes 30m, reviews 30.01–75m, and rejects beyond 75m', () => {
  const { canvasVerificationDistanceOutcome } = loadInternals();
  assert.equal(canvasVerificationDistanceOutcome(30), 'pass');
  assert.equal(canvasVerificationDistanceOutcome(30.01), 'location_uncertain');
  assert.equal(canvasVerificationDistanceOutcome(75), 'location_uncertain');
  assert.equal(canvasVerificationDistanceOutcome(75.01), 'location_mismatch');
});

test('BatchData transport/configuration errors have deterministic retry versus review semantics', async () => {
  const input = { address: { street_address: '42 W Oak St', city: 'Phoenix', state: 'AZ', zip: '85001', unit: null, lat: 33.45, lng: -112.07 } };
  const { validateCanvasAddressWithBatchData: noKey } = loadInternals({ fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(() => noKey(input), (error) => error?.code === 'canvas_address_validator_not_configured');

  for (const status of [401, 403]) {
    const harness = batchDataHarness(null, { httpStatus: status, payloadStatus: status });
    const { validateCanvasAddressWithBatchData } = loadInternals({ env: { BATCH_DATA_API_KEY: 'key' }, fetchImpl: harness.fetchImpl });
    await assert.rejects(() => validateCanvasAddressWithBatchData(input), (error) => error?.code === 'canvas_address_validation_configuration_error');
  }
  for (const status of [429, 500]) {
    const harness = batchDataHarness(null, { httpStatus: status, payloadStatus: status });
    const { validateCanvasAddressWithBatchData } = loadInternals({ env: { BATCH_DATA_API_KEY: 'key' }, fetchImpl: harness.fetchImpl });
    await assert.rejects(() => validateCanvasAddressWithBatchData(input), (error) => error?.code === 'canvas_address_validation_unavailable' && error?.retryable === true);
  }
  const { validateCanvasAddressWithBatchData: networkFailure } = loadInternals({
    env: { BATCH_DATA_API_KEY: 'key' }, fetchImpl: async () => { throw new Error('network'); }
  });
  await assert.rejects(() => networkFailure(input), (error) => error?.code === 'canvas_address_validation_unavailable' && error?.retryable === true);
  const { validateCanvasAddressWithBatchData: malformed } = loadInternals({
    env: { BATCH_DATA_API_KEY: 'key' }, fetchImpl: async () => new Response('{', { status: 200 })
  });
  await assert.rejects(() => malformed(input), (error) => error?.code === 'canvas_address_validation_malformed' && error?.retryable === true);
  const nonstandardSuccess = batchDataHarness(null, { httpStatus: 201, payloadStatus: 200 });
  const { validateCanvasAddressWithBatchData: malformed2xx } = loadInternals({ env: { BATCH_DATA_API_KEY: 'key' }, fetchImpl: nonstandardSuccess.fetchImpl });
  await assert.rejects(() => malformed2xx(input), (error) => error?.code === 'canvas_address_validation_malformed' && error?.retryable === true);
});

test('encrypted BatchData receipt is reusable only for the same validator version and immutable input hash', async () => {
  const key = Buffer.alloc(32, 9).toString('base64url');
  const harness = batchDataHarness();
  const internals = loadInternals({ env: { BATCH_DATA_API_KEY: 'key', FIELDROUTES_ENCRYPTION_KEY: key }, fetchImpl: harness.fetchImpl });
  const payload = { address: { street_address: '42 W Oak St', city: 'Phoenix', state: 'AZ', zip: '85001', unit: null, lat: 33.45, lng: -112.07 } };
  const inputHash = await internals.canvasAddressVerificationInputHash(payload);
  const validation = await internals.validateCanvasAddressWithBatchData(payload, inputHash);
  const envelope = await internals.encryptJson(validation.receipt, 'address-validation', 'manager-1', 'request-1');
  const row = {
    id: 'request-1', manager_id: 'manager-1', address_validation_envelope: envelope,
    address_validation_version: validation.receipt.validator_version,
    address_validation_input_hash: inputHash,
    address_validation_receipt_hash: await internals.sha256(validation.receipt)
  };
  const reused = await internals.reusableCanvasAddressValidation(row, payload, inputHash);
  assert.equal(reused.address.street_address, '42 West Oak Street');
  assert.equal(await internals.reusableCanvasAddressValidation({ ...row, address_validation_version: 'old-version' }, payload, inputHash), null);
  assert.equal(await internals.reusableCanvasAddressValidation(row, payload, '0'.repeat(64)), null);
});

test('AES-256-GCM envelopes are versioned, hide plaintext, and bind tenant/purpose with AAD', async () => {
  const key = Buffer.alloc(32, 7).toString('base64url');
  const { encryptJson, decryptJson } = loadInternals({ env: { FIELDROUTES_ENCRYPTION_KEY: key } });
  const envelope = await encryptJson({ authenticationKey: 'very-secret' }, 'credentials', 'manager-1', 'manager-1');
  assert.equal(envelope.v, 1);
  assert.equal(envelope.alg, 'A256GCM');
  assert.equal(JSON.stringify(envelope).includes('very-secret'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(await decryptJson(envelope, 'credentials', 'manager-1', 'manager-1'))), { authenticationKey: 'very-secret' });
  await assert.rejects(() => decryptJson(envelope, 'credentials', 'manager-2', 'manager-1'));
});

test('durable requests pin account/service identity and preserve reviewed appointment notes', () => {
  const { requestIntegrationSnapshot, assertRequestIntegrationSnapshot, fieldRoutesAppointmentNotes } = loadInternals();
  const connection = {
    environment: 'production', subdomain: 'acme', base_url: 'https://acme.fieldroutes.com/api/',
    default_service_type_id: '15', appointment_duration_minutes: 45, source_id: '7'
  };
  const snapshot = requestIntegrationSnapshot(connection);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    environment: 'production', account_host: 'acme.fieldroutes.com', service_type_id: '15',
    appointment_duration_minutes: 45, source_id: '7'
  });
  const pinned = assertRequestIntegrationSnapshot(
    { ...connection, appointment_duration_minutes: 90, source_id: '8' },
    { integration: snapshot }
  );
  assert.equal(pinned.appointment_duration_minutes, 45);
  assert.equal(pinned.source_id, '7');
  assert.throws(() => assertRequestIntegrationSnapshot({ ...connection, default_service_type_id: '16' }, { integration: snapshot }));
  assert.throws(() => assertRequestIntegrationSnapshot({ ...connection, subdomain: 'other', base_url: 'https://other.fieldroutes.com/api/' }, { integration: snapshot }));
  const notes = fieldRoutesAppointmentNotes(
    { appointment_marker: 'FK:marker' },
    { address: { street_address: '42 Oak St', unit: '4B', city: 'Phoenix', state: 'AZ', zip: '85001' }, actor: { display_name: 'Ada' }, note: 'Gate code 1234' }
  );
  assert.match(notes, /FK:marker/);
  assert.match(notes, /42 Oak St # 4B/);
  assert.match(notes, /Office note: Gate code 1234/);
  assert.ok(notes.length <= 2_000);
});

test('only pre-provider Canvas address reviews can be superseded; outage exhaustion remains explicitly retryable', () => {
  const { canSupersedeCanvasAddressReview, retryAllowed } = loadInternals();
  const review = {
    source_kind: 'canvas', state: 'review_required', checkpoint: 'address_validation_review',
    last_error_code: 'canvas_address_validation_unit_mismatch', request_hash: 'old-hash',
    attempt_count: 0, fieldroutes_customer_id: null, fieldroutes_appointment_id: null, used_existing_customer: null
  };
  assert.equal(canSupersedeCanvasAddressReview(review, 'new-hash'), true);
  assert.equal(canSupersedeCanvasAddressReview({ ...review, attempt_count: 1 }, 'new-hash'), false);
  assert.equal(canSupersedeCanvasAddressReview({ ...review, fieldroutes_customer_id: '12' }, 'new-hash'), false);
  assert.equal(canSupersedeCanvasAddressReview(review, 'old-hash'), false);
  assert.equal(canSupersedeCanvasAddressReview({ ...review, last_error_code: 'canvas_address_validation_retry_exhausted' }, 'new-hash'), false);
  assert.equal(retryAllowed({ state: 'review_required', last_error_code: 'canvas_address_validation_retry_exhausted' }), true);
  assert.equal(retryAllowed({ state: 'review_required', last_error_code: 'canvas_address_validator_not_configured' }), true);
  assert.equal(retryAllowed(review), false);
});

test('capability and request responses are sanitized and durable response semantics are explicit', async () => {
  const { safeConnection, redactRecursive, scheduleResponse } = loadInternals();
  assert.equal(safeConnection(null).enabled, true);
  assert.equal(safeConnection(null).precision_enabled, true);
  assert.equal(safeConnection(null).canvas_enabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(safeConnection(null).modes)), { precision: true, canvas: false });
  const connection = safeConnection({
    environment: 'production', subdomain: 'acme', credential_envelope: { ct: 'ciphertext' },
    default_service_type_id: '15', default_service_type_name: 'Initial inspection',
    appointment_duration_minutes: 60, connection_status: 'connected', config_revision: 2
  });
  assert.equal(connection.config_ready, true);
  assert.equal(connection.account_host, 'acme.fieldroutes.com');
  assert.equal(JSON.stringify(connection).includes('ciphertext'), false);
  const legacyMultiOffice = safeConnection({ ...connection, credential_envelope: { ct: 'ciphertext' }, default_service_type_id: '15', connection_status: 'connected', office_id: '2' });
  assert.equal(legacyMultiOffice.config_ready, false);
  assert.equal(legacyMultiOffice.connected, false);
  assert.equal(legacyMultiOffice.office_id, null);
  assert.equal(safeConnection({ ...connection, credential_envelope: { ct: 'ciphertext' }, default_service_type_id: '15', connection_status: 'disconnected', disabled_at: 'now' }).config_ready, false);
  assert.deepEqual(JSON.parse(JSON.stringify(redactRecursive({ authenticationToken: 'secret', nested: { apiKey: 'key' } }))), {
    authenticationToken: '[REDACTED]', nested: { apiKey: '[REDACTED]' }
  });
  const pending = scheduleResponse({ id: 'request-1', state: 'retry_wait', checkpoint: 'outbox_persisted', source_kind: 'canvas', source_reference: 'source', appointment_marker: 'FK:x', created_at: 'now', updated_at: 'now' });
  assert.equal(pending.status, 202);
  const body = await pending.json();
  assert.equal(body.accepted, true);
  assert.equal(body.request_id, 'request-1');
  const failed = scheduleResponse({ id: 'request-2', state: 'failed', checkpoint: 'customer_resolved', source_kind: 'precision', source_reference: 'source', appointment_marker: 'FK:y', last_error_code: 'provider_validation_failed', created_at: 'now', updated_at: 'now' });
  assert.equal(failed.status, 202);
  const failedBody = await failed.json();
  assert.equal(failedBody.accepted, true);
  assert.equal(failedBody.durable, true);
  assert.equal(failedBody.needs_attention, true);
  assert.equal(failedBody.request_id, 'request-2');
});

test('Canvas scheduling is disabled by default and enabled only by its explicit feature flag', () => {
  const disabled = loadInternals();
  assert.deepEqual(JSON.parse(JSON.stringify(disabled.fieldRoutesModes())), {
    precision_enabled: true,
    canvas_enabled: false,
    modes: { precision: true, canvas: false }
  });
  for (const body of [
    { source: { kind: 'canvas' } },
    { source: { mode: 'CANVAS' } },
    { source: { source_kind: ' canvas ' } },
    { source: { source_mode: 'canvas' } },
    { source_kind: 'canvas' },
    { source_mode: 'canvas' },
    { mode: 'canvas' },
    { source: { kind: 'precision', source_mode: 'canvas' } }
  ]) {
    assert.throws(
      () => disabled.assertFieldRoutesScheduleSourceEnabled(body),
      (error) => error?.status === 409
        && error?.code === 'canvas_fieldroutes_not_enabled'
        && error?.message === 'Canvas FieldRoutes scheduling is not available yet. Precision FieldRoutes scheduling remains available.'
    );
  }
  assert.doesNotThrow(() => disabled.assertFieldRoutesScheduleSourceEnabled({ source: { kind: 'precision' } }));

  const enabled = loadInternals({ env: { FIELDROUTES_CANVAS_ENABLED: 'true' } });
  assert.deepEqual(JSON.parse(JSON.stringify(enabled.fieldRoutesModes())), {
    precision_enabled: true,
    canvas_enabled: true,
    modes: { precision: true, canvas: true }
  });
  assert.doesNotThrow(() => enabled.assertFieldRoutesScheduleSourceEnabled({ source: { kind: 'canvas' } }));
  assert.equal(enabled.safeConnection(null).canvas_enabled, true);
});

test('Canvas feature gate runs before connection, authorization, or outbox work', () => {
  const source = readSource(integrationPath);
  const scheduleStart = source.indexOf('async function scheduleInspectionAction');
  const scheduleEnd = source.indexOf('function sourceReferencesFromBody', scheduleStart);
  const schedule = source.slice(scheduleStart, scheduleEnd);
  const gate = schedule.indexOf('assertFieldRoutesScheduleSourceEnabled(body)');
  assert.ok(gate >= 0);
  assert.ok(gate < schedule.indexOf('requireUsableConnection'));
  assert.ok(gate < schedule.indexOf('authorizeSource'));
  assert.ok(gate < schedule.indexOf('INSERT INTO fieldroutes_inspection_requests'));
});

test('account rate budget warning begins only above 2500 writes', () => {
  const { safeRateBudget } = loadInternals();
  const atThreshold = safeRateBudget({ last_token_usage: { writesToday: 2500, readsToday: 10 }, token_usage_observed_at: 'now' });
  const aboveThreshold = safeRateBudget({ last_token_usage: { writesToday: 2501, readsToday: 10 }, token_usage_observed_at: 'now' });
  assert.equal(atThreshold.over_warning_threshold, false);
  assert.equal(aboveThreshold.over_warning_threshold, true);
  assert.equal(aboveThreshold.remaining_writes, 499);
  assert.equal(safeRateBudget({ last_token_usage: { writesToday: 10, readsToday: 2500 } }).over_warning_threshold, false);
  assert.equal(safeRateBudget({ last_token_usage: { writesToday: 10, readsToday: 2501 } }).over_warning_threshold, true);
});

test('body byte limit is enforced for chunked requests without trusting Content-Length', async () => {
  const { parseBody } = loadInternals();
  const oversized = new Request('https://example.test', { method: 'POST', body: JSON.stringify({ value: 'x'.repeat(70_000) }) });
  await assert.rejects(() => parseBody(oversized), (error) => error?.code === 'request_too_large');
});

test('migration is tenant-scoped, independently authorized, additive, and never alters global property tables', () => {
  const source = readSource(migrationPath);
  assert.match(source, /FIELDROUTES_MIGRATION_SECRET/);
  assert.match(source, /x-fieldroutes-migration-secret/);
  assert.match(source, /constantTimeEqual/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS fieldroutes_connections/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS fieldroutes_inspection_requests/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS fieldroutes_sync_attempts/);
  assert.match(source, /manager_id is immutable/);
  assert.match(source, /UNIQUE \(manager_id, idempotency_key\)/);
  assert.doesNotMatch(source, /UNIQUE \(manager_id, business_key\)/);
  assert.match(source, /idx_fieldroutes_requests_active_business/);
  assert.match(source, /WHERE state <> 'superseded'/);
  assert.match(source, /address_validation_envelope JSONB/);
  assert.match(source, /address_validation_receipt_hash TEXT/);
  assert.match(source, /address_validation_attempt_count INTEGER/);
  assert.match(source, /retry_deadline_at TIMESTAMPTZ/);
  assert.match(source, /supersedes_request_id TEXT/);
  assert.match(source, /'superseded'/);
  assert.doesNotMatch(source, /ALTER TABLE\s+(?:properties|workspace_properties)\b/i);
});

test('schedule persists the encrypted outbox and returns immediately; only the bounded worker processes it', () => {
  const source = readSource(integrationPath);
  const scheduleStart = source.indexOf('async function scheduleInspectionAction');
  const scheduleEnd = source.indexOf('function sourceReferencesFromBody', scheduleStart);
  const schedule = source.slice(scheduleStart, scheduleEnd);
  assert.match(schedule, /INSERT INTO fieldroutes_inspection_requests/);
  assert.match(schedule, /return scheduleResponse\(inserted, false\)/);
  assert.doesNotMatch(schedule, /claimAndProcess/);
  const worker = source.slice(source.indexOf('async function processQueueAction'));
  assert.match(worker, /ROW_NUMBER\(\) OVER \(PARTITION BY r\.manager_id/);
  assert.match(worker, /Promise\.all/);
  assert.match(worker, /Math\.min\(5/);
  assert.match(worker, /worker_next_claim_at/);
  assert.match(source, /appointment_create_ambiguous/);
  assert.match(source, /customer_create_ambiguous/);
  assert.match(source, /FIELDROUTES_WORKER_SECRET/);
  assert.match(source, /x-fieldroutes-worker-secret/);
  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*(?:authenticationKey|authenticationToken|credentials)/);
  assert.match(source, /credential_envelope = NULL/);
  assert.match(source, /appointmentIDs: idsNeedingGet/);
  assert.match(source, /dateAddedStart: lowerBound/);
  assert.match(source, /dateAddedEnd: upperBound/);
  assert.match(source, /acquireCanvasZoneLease/);
  assert.match(source, /renewProcessingLease/);
  assert.match(source, /if \(resultIds\.length > 5\)/);
  assert.match(source, /Save this Canvas house pin before scheduling/);
  assert.match(source, /canvas_pin_do_not_knock/);
  assert.match(source, /A do-not-knock Canvas house cannot be sent/);
  assert.doesNotMatch(source, /full structured address and unit must match/);
  assert.match(source, /optional free-text label is not postal evidence/);
  assert.match(source, /BATCH_DATA_API_KEY/);
  assert.match(source, /api\/v1\/address\/verify/);
  assert.doesNotMatch(source, /api\/v1\/property\/lookup/);
  assert.match(source, /address_validation_envelope/);
  assert.match(source, /reusableCanvasAddressValidation/);
  assert.match(source, /assertRequestIntegrationSnapshot/);
  assert.match(source, /retry_deadline_at =/);
  const processing = source.slice(source.indexOf('async function processClaimedRequest'), source.indexOf('async function claimAndProcess'));
  assert.ok(processing.indexOf('assertRequestIntegrationSnapshot') < processing.indexOf('verifiedCanvasPayloadForRequest'));
  assert.match(schedule, /WITH superseded AS/);
  assert.match(schedule, /superseded_by_request_id/);
  assert.match(source, /fieldroutes_office_scope_required/);
  assert.doesNotMatch(source, /FIELDROUTES_ENABLE_MULTI_OFFICE_WRITES/);
  const createCustomer = source.slice(source.indexOf('async function createCustomer'), source.indexOf('function normalizedHouseNumber'));
  const createAppointment = source.slice(source.indexOf('async function createAppointment'), source.indexOf('function retryDelaySeconds'));
  assert.doesNotMatch(createCustomer, /officeID/);
  assert.doesNotMatch(createAppointment, /officeID/);
  assert.match(createCustomer, /fieldRoutesAddressLine\(payload\.address\)/);
  assert.match(createCustomer, /sourceID: payload\.integration\.source_id/);
  assert.match(createAppointment, /fieldRoutesAppointmentNotes/);
  assert.match(createAppointment, /type: payload\.integration\.service_type_id/);
  assert.match(createAppointment, /duration: payload\.integration\.appointment_duration_minutes/);
});
