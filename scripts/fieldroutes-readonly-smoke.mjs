#!/usr/bin/env node

/**
 * Read-only FieldRoutes contract probe.
 *
 * Required environment variables:
 *   FIELDROUTES_SMOKE_BASE_URL=https://customer.fieldroutes.com/api
 *   FIELDROUTES_SMOKE_AUTH_KEY=...
 *   FIELDROUTES_SMOKE_AUTH_TOKEN=...
 *
 * The script never prints a provider response object because FieldRoutes can
 * echo authentication parameters inside HTTP-200 error responses.
 */

class SmokeError extends Error {}

const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new SmokeError(`${name} is required.`);
  return value;
};

let baseUrl;
let authenticationKey;
let authenticationToken;

const productionHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fieldroutes\.com$/i;

function maskKnownSecrets(value) {
  let safe = String(value || '');
  for (const secret of [authenticationKey, authenticationToken]) {
    for (const candidate of [secret, encodeURIComponent(secret), new URLSearchParams({ value: secret }).toString().slice(6)]) {
      if (candidate) safe = safe.replaceAll(candidate, '[redacted]');
    }
  }
  return safe.replace(/[\r\n\t]+/g, ' ').slice(0, 120);
}

function looksLikeServiceType(row) {
  return row && typeof row === 'object' && !Array.isArray(row)
    && ['typeID', 'serviceTypeID', 'serviceID', 'id'].some((key) => row[key] !== undefined);
}

function serviceTypeRows(payload) {
  const candidates = [
    payload,
    payload?.serviceTypes,
    payload?.serviceType,
    payload?.serviceTypeData,
    payload?.types,
    payload?.result?.serviceTypes,
    payload?.result?.serviceType,
    payload?.result?.serviceTypeData,
    payload?.result?.types,
    payload?.result?.data,
    payload?.result,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const rows = candidate.filter(looksLikeServiceType);
      if (rows.length) return rows;
    }
    if (looksLikeServiceType(candidate)) return [candidate];
    if (candidate && typeof candidate === 'object') {
      const rows = Object.values(candidate).filter(looksLikeServiceType);
      if (rows.length) return rows;
    }
  }
  return [];
}

function serviceTypeIds(payload) {
  const candidates = [payload?.serviceTypeIDs, payload?.result?.serviceTypeIDs];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(String).filter((value) => /^[1-9]\d*$/.test(value));
  }
  return [];
}

async function postForm(path, fields) {
  const form = new URLSearchParams();
  for (const [name, value] of fields) {
    if (value !== undefined && value !== null && String(value) !== '') form.append(name, String(value));
  }
  // FieldRoutes requires these to be the final request parameters.
  form.append('authenticationKey', authenticationKey);
  form.append('authenticationToken', authenticationToken);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    let response;
    try {
      response = await fetch(new URL(`${baseUrl.pathname.replace(/\/$/, '')}${path}`, baseUrl.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: controller.signal,
        redirect: 'error'
      });
    } catch (error) {
      throw new SmokeError(error?.name === 'AbortError'
        ? 'Provider read-only probe timed out.'
        : 'Provider read-only probe could not reach the approved host.');
    }
    const raw = await response.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new SmokeError(`Provider returned a non-JSON response (HTTP ${response.status}).`);
    }
    if (!response.ok || payload?.success === false) {
      // Never print provider-controlled error text. FieldRoutes can echo the
      // complete request, including both credentials, in an HTTP-200 body.
      throw new SmokeError(`Provider rejected the read-only probe (HTTP ${response.status}).`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

try {
  try {
    baseUrl = new URL(required('FIELDROUTES_SMOKE_BASE_URL'));
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw new SmokeError('FIELDROUTES_SMOKE_BASE_URL is not a valid URL.');
  }
  authenticationKey = required('FIELDROUTES_SMOKE_AUTH_KEY');
  authenticationToken = required('FIELDROUTES_SMOKE_AUTH_TOKEN');
  const allowedHost = productionHost.test(baseUrl.hostname)
    || baseUrl.hostname.toLowerCase() === 'stagingdemo.pestroutes.com';
  if (baseUrl.protocol !== 'https:' || !allowedHost) {
    throw new SmokeError('Smoke base URL must use HTTPS on a FieldRoutes production host or the documented staging host.');
  }
  if (!/^\/api\/?$/.test(baseUrl.pathname)) {
    throw new SmokeError('Smoke base URL must end with /api.');
  }

  const serviceTypes = await postForm('/serviceType/search', [
    ['includeData', '1']
  ]);
  const records = serviceTypeRows(serviceTypes);
  const returnedIds = serviceTypeIds(serviceTypes);
  if (!records.length) {
    throw new SmokeError(returnedIds.length
      ? 'FieldRoutes returned service type IDs without readable includeData metadata. Staging contract verification failed.'
      : 'FieldRoutes returned no readable service type metadata. Staging contract verification failed.');
  }
  const safeTypes = records.slice(0, 50).map((record) => ({
    typeID: String(record?.typeID ?? record?.serviceTypeID ?? ''),
    description: maskKnownSecrets(record?.description || record?.name || ''),
    officeID: record?.officeID === undefined ? null : String(record.officeID),
    defaultLength: Number.isFinite(Number(record?.defaultLength)) ? Number(record.defaultLength) : null,
    initial: record?.initial ?? null,
    visible: record?.visible ?? null
  }));
  console.log(JSON.stringify({
    success: true,
    host: baseUrl.hostname,
    serviceTypeCount: returnedIds.length || safeTypes.length,
    serviceTypes: safeTypes
  }, null, 2));
} catch (error) {
  const message = error instanceof SmokeError
    ? error.message
    : 'The read-only smoke probe failed before a safe result could be produced.';
  console.error(`FieldRoutes read-only smoke failed: ${message}`);
  process.exitCode = 1;
}
