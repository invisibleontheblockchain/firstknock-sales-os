import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const BATCH_DATA_API_KEY = Deno.env.get("BATCH_DATA_API_KEY") || Deno.env.get("BATCH_DATA_SANDBOX_KEY");
const BATCH_DATA_URL = 'https://api.batchdata.com/api/v1/property/lookup/async';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const originUrl = new URL(req.url);
        // e.g. https://[app-name].base44.app/api/functions/batchDataWebhookCallback
        // The path depends on how base44 exposes functions, but typically it aligns with the invoke path.
        // We will construct the public webhook URL relative to the current execution path.
        const webhookUrl = `${originUrl.origin}/api/functions/batchDataWebhookCallback`;

        if (!BATCH_DATA_API_KEY) {
            return Response.json({ error: 'No BatchData API key configured' }, { status: 500 });
        }

        // 1. Fetch pending items from the queue (Limit to 500 for bulk async processing)
        const pendingItems = await base44.asServiceRole.entities.ValidationQueue.filter(
            { status: 'pending' }, 
            'created_date', 
            500 
        );
        const queueArr = Array.isArray(pendingItems) ? pendingItems : (pendingItems?.items || []);

        if (queueArr.length === 0) {
            return Response.json({ message: 'Queue is empty. Nothing to process.' });
        }

        console.log(`[ValidationWorker] Processing ${queueArr.length} pending items in bulk async lookup...`);

        // 2. Map items to BatchData schema
        const requestsPayload = [];
        
        for (const item of queueArr) {
            // Update status to processing to prevent double-processing
            await base44.asServiceRole.entities.ValidationQueue.update(item.id, { status: 'processing' });
            
            // normalized_address: e.g. "123 Main St, Anderson, SC 29625"
            const parts = item.normalized_address.split(', ');
            let addrObj = {};

            if (parts.length >= 3) {
                const street = parts[0];
                const city = parts[1];
                const stateZipParts = parts.slice(2).join(' ').trim().split(' ');
                const state = stateZipParts[0];
                const zip = stateZipParts[1] || '';
                
                addrObj = { street, city, state, zip };
            } else {
                addrObj = { search: item.normalized_address };
            }

            requestsPayload.push({
                address: addrObj,
                requestId: item.id // Pass the DB ID so we can correlate it in the webhook!
            });
        }

        const payload = {
            requests: requestsPayload,
            options: {
                webhookUrl: webhookUrl
            }
        };

        // 3. Dispatch Async Job to BatchData
        const response = await fetch(BATCH_DATA_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BATCH_DATA_API_KEY}`
            },
            body: JSON.stringify(payload)
        });

        if (response.status === 401 || response.status === 403) {
            console.error(`[ValidationWorker] BatchData Auth Error (${response.status})!`);
            // Rollback processing statuses
            for (const item of queueArr) {
                await base44.asServiceRole.entities.ValidationQueue.update(item.id, { status: 'failed', error_log: `Auth ${response.status}` });
            }
            return Response.json({ error: 'BatchData authentication failed. Check API key and account balance.' }, { status: 401 });
        }

        if (!response.ok) {
            const body = await response.text();
            console.error(`[ValidationWorker] API Error (${response.status}):`, body);
            for (const item of queueArr) {
                await base44.asServiceRole.entities.ValidationQueue.update(item.id, { status: 'failed', error_log: `Batch Error ${response.status}` });
            }
            return Response.json({ error: `API Error ${response.status}` }, { status: 500 });
        }

        const data = await response.json();
        
        // 4. Return summary. Webhook will handle the actual data insertion.
        return Response.json({ 
            message: `BatchData Async Job Initiated. Dispatched ${queueArr.length} records to Webhook.`,
            dispatched: queueArr.length,
            batchResponsePath: webhookUrl,
            batchStatus: data
        });

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('[ValidationWorker] FATAL:', errMsg);
        return Response.json({ error: errMsg }, { status: 500 });
    }
});
