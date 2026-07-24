Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
    }

    // Retired because this legacy bulk endpoint bypassed the authoritative
    // card, paid-plan, counter, tenant, and idempotency checks. Offline clients
    // must replay each queued action through recordKnockOutcome.
    return Response.json({
        error: 'The legacy outcome sync endpoint has been retired.',
        code: 'offline_sync_endpoint_retired',
        replacement: 'recordKnockOutcome'
    }, { status: 410 });
});
