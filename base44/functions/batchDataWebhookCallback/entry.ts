import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Only accept POST
        if (req.method !== 'POST') {
            return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
        }

        const data = await req.json();
        console.log(`[BatchDataWebhook] Received payload from BatchData!`);
        
        // Based on BatchData's async standard, it should either be { results: { properties: [...] }, meta: ... }
        // or an array of request/response objects. We'll handle the typical structure.
        let properties = [];
        if (data.results && data.results.properties) {
            properties = data.results.properties;
        } else if (Array.isArray(data)) {
            properties = data;
        } else if (data.data && Array.isArray(data.data)) {
            properties = data.data;
        }

        if (properties.length === 0) {
            console.log(`[BatchDataWebhook] Webhook contained 0 properties.`);
            return Response.json({ status: 'ok', processed: 0 });
        }

        let processed = 0;

        for (const prop of properties) {
            // requestId was passed as the ValidationQueue item.id
            const validationId = prop.requestId || (prop.meta && prop.meta.requestId);
            
            let originalItem = null;
            if (validationId) {
                originalItem = await base44.asServiceRole.entities.ValidationQueue.read(validationId);
            }

            // Extract status
            let apiStatus = 'unknown';
            let statusCategory = 'unknown';
            let soldPrice = 0;

            const listing = prop.listing || (prop.property && prop.property.listing) || {};
            apiStatus = (listing.status || 'unknown').toLowerCase();
            statusCategory = (listing.statusCategory || 'unknown').toLowerCase();
            soldPrice = listing.soldPrice || 0;

            // statusCategory and soldPrice are valid BatchData fields (NOT RentCast fields)
            const isSold = apiStatus.includes('sold') || statusCategory === 'sold' || soldPrice > 0;
            const isPending = statusCategory === 'pending' || apiStatus.includes('pending');
            
            const expiresAt = new Date();
            // Pending = under contract, not yet closed — re-check in 30 days per PENDING_CONFIRMATION spec
            const cacheStatus = isSold ? 'sold' : isPending ? 'pending_confirmation' : 'rejected';
            expiresAt.setDate(expiresAt.getDate() + (isSold ? 30 : isPending ? 30 : 7));

            // If we have the original queue item, update Cache directly with its hash.
            if (originalItem) {
                await base44.asServiceRole.entities.PropertyValidationCache.create({
                    address_hash: originalItem.address_hash,
                    normalized_address: originalItem.normalized_address,
                    status: cacheStatus,
                    expires_at: expiresAt.toISOString(),
                    provider_id: 'batchdata',
                    is_stale: false,
                    latitude: 0,
                    longitude: 0
                });

                await base44.asServiceRole.entities.ValidationQueue.update(originalItem.id, { 
                    status: 'completed'
                });

                // If pending confirmation — hold, do not update MasterProperty yet, re-check in 30 days
                if (isPending && !isSold) {
                    console.log(`[BatchDataWebhook] Property ${originalItem.address_hash} is PENDING_CONFIRMATION — holding for 30-day re-check`);
                }

                // If confirmed sold — mark MasterProperty as verified
                if (isSold) {
                    // Update MasterProperty matching this hash
                    const mpRecords = await base44.asServiceRole.entities.MasterProperty.filter({
                        address_hash: originalItem.address_hash
                    }, null, 5);
                    const mpArr = Array.isArray(mpRecords) ? mpRecords : (mpRecords?.items || []);
                    for (const mp of mpArr) {
                        await base44.asServiceRole.entities.MasterProperty.update(mp.id, {
                            sale_confidence: 'verified',
                            original_status: 'CONFIRMED_SOLD'
                        });
                    }
                }
                processed++;
            } else {
                console.warn(`[BatchDataWebhook] Could not map returned property back to Queue item. No requestId found.`);
            }
        }

        console.log(`[BatchDataWebhook] Successfully processed ${processed} items from webhook.`);
        return Response.json({ status: 'ok', processed });

    } catch (error) {
        console.error('[BatchDataWebhook] FATAL Error:', error);
        return Response.json({ error: String(error) }, { status: 500 });
    }
});