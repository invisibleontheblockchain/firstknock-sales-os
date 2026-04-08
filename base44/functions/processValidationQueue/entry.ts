import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const BATCH_DATA_API_KEY = Deno.env.get("BATCH_DATA_API_KEY") || Deno.env.get("BATCH_DATA_SANDBOX_KEY");
const BATCH_DATA_URL = 'https://api.batchdata.com/api/v1/property/lookup/async';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const originUrl = new URL(req.url);
        
        // Use explicit env var if set, otherwise construct from request URL
        // Append PIPELINE_SECRET as query param for webhook authentication
        const PIPELINE_SECRET = Deno.env.get('PIPELINE_SECRET');
        const baseWebhookUrl = Deno.env.get('BATCHDATA_WEBHOOK_URL') 
            || `${originUrl.origin}/api/functions/batchDataWebhookCallback`;
        const webhookUrl = PIPELINE_SECRET 
            ? `${baseWebhookUrl}?secret=${encodeURIComponent(PIPELINE_SECRET)}` 
            : baseWebhookUrl;

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

        // ── Graceful BatchData failure handling ──
        // If credits exhausted (402), unauthorized (401/403), or any non-200:
        // Fall back to heuristic-only classification instead of failing the whole batch.
        // Properties keep their heuristic score but stay at 'low' confidence.
        if (!response.ok) {
            const statusCode = response.status;
            const body = await response.text().catch(() => 'no body');
            const isCreditsIssue = statusCode === 401 || statusCode === 402 || statusCode === 403;
            const reason = isCreditsIssue 
                ? `[BatchData] Credits exhausted or unauthorized (${statusCode}) — falling back to heuristic-only for this batch`
                : `[BatchData] API error (${statusCode}) — falling back to heuristic-only for this batch`;
            
            console.warn(reason);
            console.warn(`[ValidationWorker] Response body: ${body.slice(0, 300)}`);

            // Downgrade all queued items to heuristic-only instead of failing them
            let downgraded = 0;
            for (const item of queueArr) {
                // Mark queue item as completed (heuristic fallback) not failed
                await base44.asServiceRole.entities.ValidationQueue.update(item.id, { 
                    status: 'completed', 
                    error_log: reason 
                }).catch(() => {});

                // Downgrade the MasterProperty from 'medium' to 'low' confidence
                // This ensures the property still renders but without the verified badge
                if (item.address_hash) {
                    const mpRecords = await base44.asServiceRole.entities.MasterProperty.filter(
                        { address_hash: item.address_hash }, null, 1
                    ).catch(() => []);
                    const mpArr = Array.isArray(mpRecords) ? mpRecords : (mpRecords?.items || []);
                    for (const mp of mpArr) {
                        if (mp.sale_confidence === 'medium') {
                            await base44.asServiceRole.entities.MasterProperty.update(mp.id, {
                                sale_confidence: 'low'
                            }).catch(() => {});
                        }
                    }
                }
                downgraded++;
            }

            // Log warning to any active FetchJob so the user sees it in the UI
            const runningJobs = await base44.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', 1).catch(() => []);
            const jobArr = Array.isArray(runningJobs) ? runningJobs : (runningJobs?.items || []);
            if (jobArr.length > 0) {
                const job = jobArr[0];
                const existingLog = job.error_log || [];
                existingLog.push(`[${new Date().toISOString()}] ${reason}`);
                await base44.asServiceRole.entities.FetchJob.update(job.id, { error_log: existingLog }).catch(() => {});
            }

            return Response.json({ 
                status: 'fallback_heuristic',
                message: reason,
                downgraded,
                statusCode
            });
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