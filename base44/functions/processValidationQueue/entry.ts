import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const BATCH_DATA_API_KEY = Deno.env.get("BATCH_DATA_API_KEY") || Deno.env.get("BATCH_DATA_SANDBOX_KEY");
const BATCH_DATA_URL = 'https://api.batchdata.com/api/v1/property/search';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);

        if (!BATCH_DATA_API_KEY) {
            return Response.json({ error: 'No BatchData API key configured' }, { status: 500 });
        }

        // 1. Fetch pending items from the queue (Limit to 50 per execution to respect time limits)
        const pendingItems = await base44.asServiceRole.entities.ValidationQueue.filter(
            { status: 'pending' }, 
            'created_date', 
            50
        );
        const queueArr = Array.isArray(pendingItems) ? pendingItems : (pendingItems?.items || []);

        if (queueArr.length === 0) {
            return Response.json({ message: 'Queue is empty. Nothing to process.' });
        }

        console.log(`[ValidationWorker] Processing ${queueArr.length} pending items...`);

        let processedCount = 0;
        let authErrors = 0;

        // 2. Process each item sequentially to respect API rate limits
        for (const item of queueArr) {
            // Update status to processing to prevent double-processing
            await base44.asServiceRole.entities.ValidationQueue.update(item.id, { status: 'processing' });

            try {
                // Formatting payload per our rigorous sandbox payload tests
                const payload = {
                    searchCriteria: {
                        query: item.normalized_address
                    }
                };

                const response = await fetch(BATCH_DATA_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${BATCH_DATA_API_KEY}`
                    },
                    body: JSON.stringify(payload)
                });

                if (response.status === 401 || response.status === 403) {
                    authErrors++;
                    console.error("[ValidationWorker] BatchData Auth Error! Verify your API Key.");
                    await base44.asServiceRole.entities.ValidationQueue.update(item.id, { status: 'failed', error_log: 'Auth Rejected' });
                    continue; // Skip the rest if auth fails
                }

                const data = await response.json();
                
                // 3. Extract MLS Status from the response payload
                let apiStatus = 'unknown';
                if (data.results && data.results.length > 0) {
                    const result = data.results[0];
                    if (result.listing && result.listing.status) {
                        apiStatus = result.listing.status.toLowerCase();
                    }
                }

                // Is it definitively sold?
                const isSold = apiStatus.includes('sold');
                
                // 4. Upsert/Create the record in the PropertyValidationCache
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 14); // 14-day Time-to-Live

                await base44.asServiceRole.entities.PropertyValidationCache.create({
                    address_hash: item.address_hash,
                    normalized_address: item.normalized_address,
                    status: isSold ? 'sold' : 'rejected',
                    expires_at: expiresAt.toISOString(),
                    provider_id: 'batchdata',
                    is_stale: false,
                    latitude: 0, // Placeholder, usually read from RentCast initial pass
                    longitude: 0 // Placeholder
                });

                // 5. Mark queue item as completed
                await base44.asServiceRole.entities.ValidationQueue.update(item.id, { 
                    status: 'completed' 
                });

                processedCount++;

            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.error(`[ValidationWorker] Error processing ${item.address_hash}: ${errMsg}`);
                await base44.asServiceRole.entities.ValidationQueue.update(item.id, { 
                    status: 'failed', 
                    error_log: errMsg 
                });
            }

            // Small delay to prevent API throttling
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        // If we hit auth errors, alert the platform
        if (authErrors > 0) {
            return Response.json({ error: `Processed ${processedCount}, but encountered ${authErrors} Auth Errors. Check API Key.` }, { status: 401 });
        }

        // If there are more items pending, recursively invoke ourselves (Base44 pattern)
        if (queueArr.length === 50) {
            setTimeout(() => base44.functions.invoke('processValidationQueue', {}).catch(() => {}), 1000);
        }

        return Response.json({ 
            message: `BatchData Validation Worker Completed. Processed ${processedCount} records.`,
            processed: processedCount
        });

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('[ValidationWorker] FATAL:', errMsg);
        return Response.json({ error: errMsg }, { status: 500 });
    }
});
