import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { Client } from 'npm:@neondatabase/serverless@0.9.0';
import Stripe from 'npm:stripe@14.14.0';
import {
    executePrecisionStart,
    precisionErrorPayload
} from '../_shared/precisionActiveJobCriteria.js';

const PROCESSOR_START_WAIT_MS = 900;
const FCC_LOOKUP_TIMEOUT_MS = 8000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveFips(center) {
    const url = `https://geo.fcc.gov/api/census/block/find?latitude=${encodeURIComponent(center.lat)}&longitude=${encodeURIComponent(center.lng)}&format=json`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            controller?.abort();
            reject(new Error('FCC county lookup timed out.'));
        }, FCC_LOOKUP_TIMEOUT_MS);
    });
    let response;
    try {
        response = await Promise.race([
            fetch(url, controller ? { signal: controller.signal } : undefined),
            timeout
        ]);
    } finally {
        clearTimeout(timeoutId);
    }
    if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
            throw new Error(`FCC county lookup returned transient HTTP ${response.status}.`);
        }
        return null;
    }
    const data = await response.json();
    return {
        fips_code: data?.County?.FIPS || null,
        county_name: data?.County?.name || null,
        state_code: data?.State?.code || null,
        state_name: data?.State?.name || null
    };
}

async function startProcessor(base44, jobId, processorToken) {
    const invocation = base44.asServiceRole.functions.invoke('processFetchChunk', {
        job_id: jobId,
        expected_chunk: 0,
        processor_token: processorToken
    }).catch(error => {
        console.warn(`[startBatchDataPull] Background processor invoke failed: ${error.message}`);
    });
    await Promise.race([invocation, sleep(PROCESSOR_START_WAIT_MS)]);
}

function publicResponse(result) {
    const {
        kind,
        job,
        processorToken,
        ...payload
    } = result;
    if (kind === 'dry_run') {
        return {
            success: true,
            dry_run: true,
            ...payload
        };
    }
    if (kind === 'started') {
        return {
            success: true,
            ...payload,
            job_id: job.id
        };
    }
    return payload;
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
        const body = await req.json().catch(() => ({}));
        const result = await executePrecisionStart({
            base44,
            user,
            body,
            adapterName: 'startBatchDataPull',
            allowRetry: true,
            allowDryRunSelfTest: true,
            StripeClass: Stripe,
            ClientClass: Client,
            stripeSecret: Deno.env.get('STRIPE_SECRET_KEY'),
            databaseUrl: Deno.env.get('DATABASE_URL'),
            betaAccessGrants: Deno.env.get('BETA_ACCESS_GRANTS'),
            resolveFips
        });
        if (result.kind === 'started') {
            await startProcessor(base44, result.job.id, result.processorToken);
        }
        return Response.json(publicResponse(result));
    } catch (error) {
        const failure = precisionErrorPayload(error);
        console.error('[startBatchDataPull] Failed:', error?.message || error);
        return Response.json(failure.body, { status: failure.status });
    }
});
