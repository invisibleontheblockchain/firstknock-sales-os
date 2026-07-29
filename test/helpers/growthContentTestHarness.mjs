import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import * as growthHelpers from '../../base44/functions/_shared/growthContentEngine.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '../..');
const defaultHeartbeatRevision = createHash('sha256')
  .update([
    'buffer-publisher',
    'org_firstknock',
    'channel_instagram',
    'channel_tiktok',
    'https://media.firstknock.online',
  ].join('|'))
  .digest('hex');

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fieldMatches(actual, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return actual === expected;
  }
  if ('$in' in expected && !expected.$in.includes(actual)) return false;
  if ('$nin' in expected && expected.$nin.includes(actual)) return false;
  if ('$eq' in expected && actual !== expected.$eq) return false;
  if ('$ne' in expected && actual === expected.$ne) return false;
  if ('$gt' in expected && !(actual > expected.$gt)) return false;
  if ('$gte' in expected && !(actual >= expected.$gte)) return false;
  if ('$lt' in expected && !(actual < expected.$lt)) return false;
  if ('$lte' in expected && !(actual <= expected.$lte)) return false;
  return true;
}

function recordMatches(record, query = {}) {
  if (query.$and && !query.$and.every((nested) => recordMatches(record, nested))) return false;
  if (query.$or && !query.$or.some((nested) => recordMatches(record, nested))) return false;
  if (query.$nor && query.$nor.some((nested) => recordMatches(record, nested))) return false;
  return Object.entries(query)
    .filter(([key]) => !key.startsWith('$'))
    .every(([key, expected]) => fieldMatches(record?.[key], expected));
}

function sorted(records, sort) {
  if (!sort) return [...records];
  const descending = String(sort).startsWith('-');
  const field = String(sort).replace(/^[+-]/, '');
  return [...records].sort((left, right) => {
    const a = left?.[field] ?? '';
    const b = right?.[field] ?? '';
    const result = typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b));
    return descending ? -result : result;
  });
}

export function memoryEntity(initial = [], name = 'Entity') {
  let sequence = 0;
  const records = initial.map((value) => {
    sequence += 1;
    return {
      id: value.id || `${name.toLowerCase()}_${sequence}`,
      created_date: value.created_date || new Date().toISOString(),
      updated_date: value.updated_date || new Date().toISOString(),
      ...jsonClone(value),
    };
  });
  const counters = {
    list: 0,
    filter: 0,
    get: 0,
    create: 0,
    delete: 0,
    update: 0,
    updateMany: 0,
  };
  const cleanPatch = (value) => Object.fromEntries(
    Object.entries(value || {}).filter(([, nested]) => nested !== undefined),
  );

  return {
    records,
    counters,
    async list(sort, limit = 50, skip = 0) {
      counters.list += 1;
      return jsonClone(sorted(records, sort).slice(skip, skip + limit));
    },
    async filter(query, sort, limit = 50, skip = 0) {
      counters.filter += 1;
      return jsonClone(
        sorted(records.filter((record) => recordMatches(record, query)), sort)
          .slice(skip, skip + limit),
      );
    },
    async get(id) {
      counters.get += 1;
      const found = records.find((record) => record.id === id);
      if (!found) throw new Error(`${name} not found`);
      return jsonClone(found);
    },
    async create(value) {
      counters.create += 1;
      sequence += 1;
      const now = new Date().toISOString();
      const saved = {
        id: `${name.toLowerCase()}_${sequence}`,
        created_date: now,
        updated_date: now,
        ...cleanPatch(jsonClone(value)),
      };
      records.push(saved);
      return jsonClone(saved);
    },
    async delete(id) {
      counters.delete += 1;
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`${name} not found`);
      records.splice(index, 1);
      return { success: true };
    },
    async update(id, value) {
      counters.update += 1;
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`${name} not found`);
      records[index] = {
        ...records[index],
        ...cleanPatch(jsonClone(value)),
        updated_date: new Date().toISOString(),
      };
      return jsonClone(records[index]);
    },
    async updateMany(query, operations) {
      counters.updateMany += 1;
      let count = 0;
      for (let index = 0; index < records.length; index += 1) {
        if (!recordMatches(records[index], query)) continue;
        const next = { ...records[index] };
        for (const [field, value] of Object.entries(operations?.$set || {})) {
          if (value !== undefined) next[field] = jsonClone(value);
        }
        for (const [field, value] of Object.entries(operations?.$inc || {})) {
          next[field] = Number(next[field] || 0) + Number(value || 0);
        }
        for (const field of Object.keys(operations?.$unset || {})) delete next[field];
        next.updated_date = new Date().toISOString();
        records[index] = next;
        count += 1;
      }
      return { success: true, updated: count, has_more: false };
    },
  };
}

export function createGrowthBase44({
  user = { id: 'owner_1', is_owner: true, role: 'admin' },
  sources = [],
  artifacts = [],
  jobs = [],
  plans = [],
  metrics = [],
  batches = [],
  heartbeats,
  invokeLlm,
} = {}) {
  const currentUser = { value: user };
  const entities = {
    GrowthSourceAsset: memoryEntity(sources, 'GrowthSourceAsset'),
    GrowthCreativeArtifact: memoryEntity(artifacts, 'GrowthCreativeArtifact'),
    GrowthPublishJob: memoryEntity(jobs, 'GrowthPublishJob'),
    GrowthPublishHeartbeat: memoryEntity(
      heartbeats ?? [{
        heartbeat_key: 'buffer-publisher',
        config_revision: defaultHeartbeatRevision,
        observed_at: new Date().toISOString(),
        status: 'ready',
        invocation_generation: 1,
        last_batch_inspected: 0,
        last_batch_processed: 0,
      }],
      'GrowthPublishHeartbeat',
    ),
    GrowthContentPlan: memoryEntity(plans, 'GrowthContentPlan'),
    GrowthContentMetric: memoryEntity(metrics, 'GrowthContentMetric'),
    GrowthContentBatch: memoryEntity(batches, 'GrowthContentBatch'),
  };
  const base44 = {
    auth: { me: async () => jsonClone(currentUser.value) },
    asServiceRole: { entities },
    integrations: {
      Core: {
        InvokeLLM: invokeLlm || (async () => {
          throw new Error('InvokeLLM was not expected in this test');
        }),
      },
    },
  };
  return { base44, entities, currentUser };
}

export function loadGrowthHandler(path, {
  base44,
  env = {},
  dateImpl = Date,
  fetchImpl = async () => {
    throw new Error('fetch was not expected');
  },
  consoleImpl = console,
  onClientCreate,
} = {}) {
  const source = readFileSync(resolve(rootDir, path), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript syntax errors`);
  let handler;
  const executable = transpiled.outputText.replace(/^import[\s\S]*?;\s*$/gm, '');
  vm.runInNewContext(executable, {
    ...growthHelpers,
    console: consoleImpl,
    createClientFromRequest: () => {
      onClientCreate?.();
      return base44;
    },
    Deno: {
      env: { get: (key) => env[key] ?? null },
      serve: (registeredHandler) => { handler = registeredHandler; },
    },
    Request,
    Response,
    URL,
    Date: dateImpl,
    TextEncoder,
    Uint8Array,
    crypto: globalThis.crypto,
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    structuredClone,
  }, { filename: path });
  assert.equal(typeof handler, 'function');
  return handler;
}

export async function invokeJson(handler, body, {
  secret,
  method = 'POST',
  headers = {},
} = {}) {
  const requestHeaders = {
    'content-type': 'application/json',
    ...headers,
  };
  if (secret) requestHeaders.authorization = `Bearer ${secret}`;
  const request = new Request('https://example.test/function', {
    method,
    headers: requestHeaders,
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  const result = await handler(request);
  return {
    status: result.status,
    body: await result.json(),
  };
}

export { growthHelpers };
