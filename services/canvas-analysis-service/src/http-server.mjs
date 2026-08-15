import http from 'node:http';

import { safeTokenEqual } from './canonical.mjs';
import { ServiceError, asServiceError } from './errors.mjs';

const MAX_REQUEST_BYTES = 512_000;

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new ServiceError(413, 'request_too_large', 'Request exceeds its byte limit.');
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_REQUEST_BYTES) throw new ServiceError(413, 'request_too_large', 'Request exceeds its byte limit.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ServiceError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

function bearer(request) {
  const header = String(request.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function requiredHeader(request, name) {
  const value = String(request.headers[name] || '').trim();
  if (!value) throw new ServiceError(400, 'missing_scope_header', `${name} is required.`);
  return value;
}

export function createAnalysisHttpServer({ service, serviceToken, store }) {
  if (String(serviceToken || '').length < 32) throw new ServiceError(503, 'configuration_missing', 'Canvas service bearer token is missing.');
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://canvas-analysis.local');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        await store.health();
        return json(response, 200, { ok: true });
      }
      if (!safeTokenEqual(bearer(request), serviceToken)) throw new ServiceError(401, 'unauthorized', 'Service authentication required.');
      if (request.method === 'POST' && url.pathname === '/v1/canvas/analyses') {
        return json(response, 200, { job: await service.start(await readJson(request)) });
      }
      const match = url.pathname.match(/^\/v1\/canvas\/analyses\/([^/]+)\/(status|cancel|result)$/);
      if (!match) throw new ServiceError(404, 'not_found', 'Endpoint not found.');
      const workerJobId = decodeURIComponent(match[1]);
      if (request.method === 'GET' && match[2] === 'status') {
        return json(response, 200, { job: await service.status(
          workerJobId,
          requiredHeader(request, 'x-firstknock-manager-id'),
          requiredHeader(request, 'x-firstknock-job-id'),
        ) });
      }
      if (request.method === 'POST' && match[2] === 'cancel') {
        return json(response, 200, { job: await service.cancel(workerJobId, await readJson(request)) });
      }
      if (request.method === 'GET' && match[2] === 'result') {
        return json(response, 200, { job: await service.result(
          workerJobId,
          requiredHeader(request, 'x-firstknock-manager-id'),
          requiredHeader(request, 'x-firstknock-job-id'),
        ) });
      }
      throw new ServiceError(405, 'method_not_allowed', 'Method not allowed.');
    } catch (error) {
      const failure = asServiceError(error);
      json(response, failure.status, { error: failure.code, message: failure.message, retryable: failure.retryable });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export function createHealthHttpServer({ store }) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://canvas-analysis.local');
      if (request.method !== 'GET' || url.pathname !== '/healthz') throw new ServiceError(404, 'not_found', 'Endpoint not found.');
      await store.health();
      json(response, 200, { ok: true, mode: 'worker' });
    } catch (error) {
      const failure = asServiceError(error);
      json(response, failure.status, { error: failure.code, message: failure.message });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export function listen(server, { host = '0.0.0.0', port = 8080 } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}
