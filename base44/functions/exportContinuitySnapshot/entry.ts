import { neon } from 'npm:@neondatabase/serverless@0.9.0';

// Writes a full gzipped NDJSON snapshot of the continuity mirror to an
// S3-compatible bucket. This is the third copy: it survives losing the Base44
// entity store and the Neon replica at the same time.
//
// Cloudflare R2 is the intended destination — zero egress fees, so pulling the
// archive back during an actual incident costs nothing. Any S3-compatible
// provider works by changing the env vars.
//
// Dormant until configured. With no bucket credentials the function reports
// not_configured and exits without touching anything, so it is safe to deploy
// and schedule before the bucket exists.
//
// Required env when enabling:
//   CONTINUITY_SNAPSHOT_BUCKET      bucket name
//   CONTINUITY_SNAPSHOT_ENDPOINT    e.g. https://<account>.r2.cloudflarestorage.com
//   CONTINUITY_SNAPSHOT_ACCESS_KEY  access key id
//   CONTINUITY_SNAPSHOT_SECRET_KEY  secret access key
//   CONTINUITY_SNAPSHOT_REGION      optional, defaults to "auto" (correct for R2)
//   CONTINUITY_SNAPSHOT_PREFIX      optional key prefix, defaults to "firstknock"

const WORKER_SECRET_ENV = 'CONTINUITY_WORKER_SECRET';
const SELECT_CHUNK = 2000;
const MAX_ROWS = 2_000_000;

function timingSafeEqual(expected: string, received: string) {
    if (!expected || !received || expected.length !== received.length) return false;
    let mismatch = 0;
    for (let index = 0; index < expected.length; index += 1) {
        mismatch |= expected.charCodeAt(index) ^ received.charCodeAt(index);
    }
    return mismatch === 0;
}

function isAuthorizedWorker(req: Request) {
    const expected = Deno.env.get(WORKER_SECRET_ENV);
    if (!expected) return false;
    return timingSafeEqual(expected, req.headers.get('x-continuity-worker-secret') || '');
}

function snapshotConfig() {
    const bucket = Deno.env.get('CONTINUITY_SNAPSHOT_BUCKET');
    const endpoint = Deno.env.get('CONTINUITY_SNAPSHOT_ENDPOINT');
    const accessKey = Deno.env.get('CONTINUITY_SNAPSHOT_ACCESS_KEY');
    const secretKey = Deno.env.get('CONTINUITY_SNAPSHOT_SECRET_KEY');
    if (!bucket || !endpoint || !accessKey || !secretKey) return null;
    return {
        bucket,
        endpoint: endpoint.replace(/\/+$/, ''),
        accessKey,
        secretKey,
        region: Deno.env.get('CONTINUITY_SNAPSHOT_REGION') || 'auto',
        prefix: (Deno.env.get('CONTINUITY_SNAPSHOT_PREFIX') || 'firstknock').replace(/^\/+|\/+$/g, '')
    };
}

function toHex(buffer: ArrayBuffer) {
    return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: Uint8Array | string) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(key: Uint8Array, message: string) {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
    return new Uint8Array(signature);
}

// Minimal AWS SigV4 for a single PUT. Written out rather than pulled from an
// SDK to keep this function's dependency surface as small as its job.
async function signedPut(config: any, objectKey: string, body: Uint8Array, contentType: string) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(config.endpoint).host;
    const canonicalUri = `/${config.bucket}/${objectKey}`.replace(/\/+/g, '/');
    const payloadHash = await sha256Hex(body);

    const canonicalHeaders = `host:${host}\n`
        + `x-amz-content-sha256:${payloadHash}\n`
        + `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
        'PUT',
        canonicalUri,
        '',
        canonicalHeaders,
        signedHeaders,
        payloadHash
    ].join('\n');

    const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        await sha256Hex(canonicalRequest)
    ].join('\n');

    const encoder = new TextEncoder();
    let signingKey = await hmac(encoder.encode(`AWS4${config.secretKey}`), dateStamp);
    signingKey = await hmac(signingKey, config.region);
    signingKey = await hmac(signingKey, 's3');
    signingKey = await hmac(signingKey, 'aws4_request');
    const signature = toHex((await hmac(signingKey, stringToSign)).buffer as ArrayBuffer);

    const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await fetch(`${config.endpoint}${canonicalUri}`, {
        method: 'PUT',
        headers: {
            authorization,
            host,
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
            'content-type': contentType,
            'content-length': String(body.byteLength)
        },
        body
    });

    if (!response.ok) {
        // Provider error bodies can echo credentials or key material.
        throw new Error(`Snapshot upload rejected with status ${response.status}`);
    }
    return { objectKey, payloadHash };
}

function gzip(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (req.method !== 'POST') {
        return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
    }
    if (!isAuthorizedWorker(req)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) {
        return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
    }

    const config = snapshotConfig();
    if (!config) {
        return Response.json({
            success: true,
            skipped: 'not_configured',
            message: 'Off-site snapshots are dormant. Set CONTINUITY_SNAPSHOT_* to enable.',
            required_env: [
                'CONTINUITY_SNAPSHOT_BUCKET',
                'CONTINUITY_SNAPSHOT_ENDPOINT',
                'CONTINUITY_SNAPSHOT_ACCESS_KEY',
                'CONTINUITY_SNAPSHOT_SECRET_KEY'
            ]
        });
    }

    const sql = neon(databaseUrl);
    const startedRows = await sql(
        `INSERT INTO continuity.snapshot_exports (destination) VALUES ($1) RETURNING export_id`,
        [`s3://${config.bucket}`]
    ).catch(() => null);
    const exportId = startedRows?.[0]?.export_id || null;

    try {
        // Snapshot the mirror, not the live store: the mirror already holds
        // tombstoned records the live store has lost, and reading it cannot add
        // load to anything a rep is using.
        const lines: string[] = [];
        const entityCounts: Record<string, number> = {};
        let rowCount = 0;
        let lastKey: { entity: string; recordId: string } | null = null;

        while (rowCount < MAX_ROWS) {
            const page: any[] = lastKey
                ? await sql(
                    `SELECT entity, record_id, manager_id, created_by, payload, payload_hash,
                            source_updated_at, deleted_detected_at, first_seen_at, last_seen_at
                     FROM continuity.record_current
                     WHERE (entity, record_id) > ($1, $2)
                     ORDER BY entity, record_id
                     LIMIT ${SELECT_CHUNK}`,
                    [lastKey.entity, lastKey.recordId]
                )
                : await sql(
                    `SELECT entity, record_id, manager_id, created_by, payload, payload_hash,
                            source_updated_at, deleted_detected_at, first_seen_at, last_seen_at
                     FROM continuity.record_current
                     ORDER BY entity, record_id
                     LIMIT ${SELECT_CHUNK}`
                );

            if (!page.length) break;

            for (const row of page) {
                lines.push(JSON.stringify(row));
                entityCounts[row.entity] = (entityCounts[row.entity] || 0) + 1;
            }
            rowCount += page.length;
            const tail = page[page.length - 1];
            lastKey = { entity: tail.entity, recordId: tail.record_id };
            if (page.length < SELECT_CHUNK) break;
        }

        const header = JSON.stringify({
            _snapshot: 'firstknock-continuity',
            version: 1,
            generated_at: new Date().toISOString(),
            row_count: rowCount,
            entities: entityCounts
        });
        const payload = new TextEncoder().encode([header, ...lines].join('\n') + '\n');
        const compressed = await gzip(payload);
        const contentHash = await sha256Hex(compressed);

        const now = new Date();
        const objectKey = [
            config.prefix,
            String(now.getUTCFullYear()),
            String(now.getUTCMonth() + 1).padStart(2, '0'),
            String(now.getUTCDate()).padStart(2, '0'),
            `continuity-${now.toISOString().replace(/[:.]/g, '-')}.ndjson.gz`
        ].filter(Boolean).join('/');

        await signedPut(config, objectKey, compressed, 'application/gzip');

        if (exportId) {
            await sql(
                `UPDATE continuity.snapshot_exports SET
                     finished_at = NOW(), object_key = $2, byte_size = $3, row_count = $4,
                     entities = $5::jsonb, content_sha256 = $6, ok = TRUE
                 WHERE export_id = $1`,
                [exportId, objectKey, compressed.byteLength, rowCount, JSON.stringify(entityCounts), contentHash]
            ).catch(() => null);
        }

        return Response.json({
            success: true,
            export_id: exportId,
            object_key: objectKey,
            row_count: rowCount,
            entities: entityCounts,
            compressed_bytes: compressed.byteLength,
            content_sha256: contentHash,
            truncated: rowCount >= MAX_ROWS
        });
    } catch (error: any) {
        console.error('[exportContinuitySnapshot] failed', error?.message);
        if (exportId) {
            await sql(
                `UPDATE continuity.snapshot_exports SET finished_at = NOW(), ok = FALSE, error = $2
                 WHERE export_id = $1`,
                [exportId, String(error?.message || 'unknown').slice(0, 500)]
            ).catch(() => null);
        }
        return Response.json({ error: 'snapshot_export_failed' }, { status: 500 });
    }
});
