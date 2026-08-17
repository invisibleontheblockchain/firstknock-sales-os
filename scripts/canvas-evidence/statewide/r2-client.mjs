import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const EMPTY_HASH = createHash('sha256').update('').digest('hex');
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);

export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new TypeError(`${name} is required.`);
  return value;
}

export class R2Client {
  constructor(env = process.env) {
    this.accountId = required(env, 'CANVAS_R2_ACCOUNT_ID');
    this.accessKeyId = required(env, 'CANVAS_R2_ACCESS_KEY_ID');
    this.secretAccessKey = required(env, 'CANVAS_R2_SECRET_ACCESS_KEY');
    this.bucket = required(env, 'CANVAS_R2_BUCKET');
  }

  signedRequest({ method, key = '', query = [], payloadHash = EMPTY_HASH, headers = {} }) {
    const host = `${this.accountId}.r2.cloudflarestorage.com`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const canonicalUri = `/${encode(this.bucket)}${key ? `/${key.split('/').map(encode).join('/')}` : ''}`;
    const requestHeaders = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...headers };
    const names = Object.keys(requestHeaders).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = names.map((name) => `${name}:${String(requestHeaders[name]).trim()}\n`).join('');
    const canonicalQuery = [...query].sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${encode(name)}=${encode(value)}`).join('&');
    const scope = `${date}/auto/s3/aws4_request`;
    const canonical = [method, canonicalUri, canonicalQuery, canonicalHeaders, names.join(';'), payloadHash].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, date), 'auto'), 's3'), 'aws4_request');
    requestHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(signingKey, stringToSign, 'hex')}`;
    return { url: `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`, headers: requestHeaders };
  }

  async head(key) {
    const request = this.signedRequest({ method: 'GET', key, headers: { range: 'bytes=0-0' } });
    const response = await fetch(request.url, { headers: request.headers, redirect: 'manual' });
    if ([404, 416].includes(response.status)) { await response.arrayBuffer(); return null; }
    if (response.status !== 206) throw new Error(`R2 metadata probe failed for ${key}: HTTP ${response.status}`);
    const bytes = Number((response.headers.get('content-range') || '').match(/\/(\d+)$/)?.[1]);
    await response.arrayBuffer();
    return { key, bytes, sha256: response.headers.get('x-amz-meta-sha256') };
  }

  async list(prefix) {
    const objects = [];
    let token = '';
    do {
      const query = [['list-type', '2'], ['max-keys', '1000'], ['prefix', prefix], ...(token ? [['continuation-token', token]] : [])];
      const request = this.signedRequest({ method: 'GET', query });
      const response = await fetch(request.url, { headers: request.headers, redirect: 'manual' });
      if (!response.ok) throw new Error(`R2 list failed for ${prefix}: HTTP ${response.status}`);
      const xml = await response.text();
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const field = (name) => (match[1].match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`)) || [])[1];
        objects.push({ key: field('Key')?.replaceAll('&amp;', '&'), bytes: Number(field('Size')), modified_at: field('LastModified') });
      }
      token = (xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/) || [])[1] || '';
    } while (token);
    return objects;
  }

  async download(key, path, expectedHash) {
    const request = this.signedRequest({ method: 'GET', key });
    const response = await fetch(request.url, { headers: request.headers, redirect: 'manual' });
    if (response.status !== 200) throw new Error(`R2 GET failed for ${key}: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
    const actualHash = await fileHash(path);
    if (expectedHash && actualHash !== expectedHash) throw new Error(`R2 hash verification failed for ${key}.`);
    return { key, path, sha256: actualHash };
  }

  async put(path, key, { immutable = true } = {}) {
    const info = await stat(path);
    const expectedHash = await fileHash(path);
    const existing = await this.head(key);
    if (immutable && existing) {
      if (existing.bytes === info.size && existing.sha256 === expectedHash) return { key, bytes: info.size, sha256: expectedHash, status: 'verified_existing' };
      const error = new Error(`Immutable R2 key already exists: ${key}`);
      error.code = 'R2_OBJECT_EXISTS';
      throw error;
    }
    const headers = { 'content-length': String(info.size), 'x-amz-meta-sha256': expectedHash, ...(immutable ? { 'if-none-match': '*' } : {}) };
    const request = this.signedRequest({ method: 'PUT', key, payloadHash: expectedHash, headers });
    const response = await fetch(request.url, { method: 'PUT', headers: request.headers, body: createReadStream(path), duplex: 'half', redirect: 'manual' });
    if (immutable && [409, 412].includes(response.status)) { const error = new Error(`Immutable R2 key collision: ${key}`); error.code = 'R2_OBJECT_EXISTS'; throw error; }
    if (!response.ok) throw new Error(`R2 PUT failed for ${key}: HTTP ${response.status}`);
    const stored = await this.head(key);
    if (!stored || stored.bytes !== info.size || stored.sha256 !== expectedHash) throw new Error(`R2 write verification failed for ${key}.`);
    return { key, bytes: info.size, sha256: expectedHash, status: existing ? 'replaced' : 'uploaded' };
  }
}