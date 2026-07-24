Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
    }

    // Permanently retired. This legacy utility previously accepted an email
    // address and performed service-role account elevation without authorizing
    // the caller. Owner changes now go through the audited adminSetOwner flow.
    return Response.json({
        error: 'This legacy account-elevation endpoint has been retired.'
    }, { status: 410 });
});
