import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const lat = 32.3199;
        const lng = -106.7637;
        const radius = 8;
        const headers = { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY };

        const results = {};

        // OLD ENDPOINT: /properties with saleDateRange=1:90 (3 months = ~90 days)
        const oldUrl = `${RENTCAST_BASE}/properties?latitude=${lat}&longitude=${lng}&radius=${radius}&limit=500&offset=0&saleDateRange=1:90&includeTotalCount=true`;
        console.log(`[compare] OLD endpoint: ${oldUrl}`);
        const oldRes = await fetch(oldUrl, { headers });
        const oldTotal = oldRes.headers.get('X-Total-Count');
        const oldData = await oldRes.json();
        results.old_properties_endpoint = {
            url: '/properties?saleDateRange=1:90',
            status: oldRes.status,
            total_count: oldTotal ? parseInt(oldTotal) : (Array.isArray(oldData) ? oldData.length : 0),
            returned_this_page: Array.isArray(oldData) ? oldData.length : 0,
            sample: Array.isArray(oldData) && oldData.length > 0 ? {
                address: oldData[0].formattedAddress,
                lastSaleDate: oldData[0].lastSaleDate,
                lastSalePrice: oldData[0].lastSalePrice
            } : null
        };

        // NEW ENDPOINT: /listings/sale?status=Inactive&daysOld=0:90 (sold in last 3 months)
        const newSoldUrl = `${RENTCAST_BASE}/listings/sale?latitude=${lat}&longitude=${lng}&radius=${radius}&limit=500&offset=0&status=Inactive&daysOld=0:90&includeTotalCount=true`;
        console.log(`[compare] NEW sold endpoint: ${newSoldUrl}`);
        const newSoldRes = await fetch(newSoldUrl, { headers });
        const newSoldTotal = newSoldRes.headers.get('X-Total-Count');
        const newSoldData = await newSoldRes.json();
        results.new_listings_sold = {
            url: '/listings/sale?status=Inactive&daysOld=0:90',
            status: newSoldRes.status,
            total_count: newSoldTotal ? parseInt(newSoldTotal) : (Array.isArray(newSoldData) ? newSoldData.length : 0),
            returned_this_page: Array.isArray(newSoldData) ? newSoldData.length : 0,
            sample: Array.isArray(newSoldData) && newSoldData.length > 0 ? {
                address: newSoldData[0].formattedAddress,
                removedDate: newSoldData[0].removedDate,
                price: newSoldData[0].price
            } : null
        };

        // NEW ENDPOINT: /listings/sale?status=Active (currently for sale)
        const newActiveUrl = `${RENTCAST_BASE}/listings/sale?latitude=${lat}&longitude=${lng}&radius=${radius}&limit=500&offset=0&status=Active&includeTotalCount=true`;
        console.log(`[compare] NEW active endpoint: ${newActiveUrl}`);
        const newActiveRes = await fetch(newActiveUrl, { headers });
        const newActiveTotal = newActiveRes.headers.get('X-Total-Count');
        const newActiveData = await newActiveRes.json();
        results.new_listings_active = {
            url: '/listings/sale?status=Active',
            status: newActiveRes.status,
            total_count: newActiveTotal ? parseInt(newActiveTotal) : (Array.isArray(newActiveData) ? newActiveData.length : 0),
            returned_this_page: Array.isArray(newActiveData) ? newActiveData.length : 0,
            sample: Array.isArray(newActiveData) && newActiveData.length > 0 ? {
                address: newActiveData[0].formattedAddress,
                listedDate: newActiveData[0].listedDate,
                price: newActiveData[0].price
            } : null
        };

        const oldCount = results.old_properties_endpoint.total_count;
        const newSoldCount = results.new_listings_sold.total_count;
        const newActiveCount = results.new_listings_active.total_count;
        const newTotal = newSoldCount + newActiveCount;

        results.summary = {
            old_endpoint_3mo: oldCount,
            new_mls_sold_3mo: newSoldCount,
            new_mls_active: newActiveCount,
            new_total: newTotal,
            improvement: oldCount > 0 ? `${Math.round(newTotal / oldCount)}x more data` : `${newTotal} vs ${oldCount}`,
            api_calls_used: 3
        };

        console.log(`[compare] SUMMARY: OLD=${oldCount} | NEW_SOLD=${newSoldCount} | NEW_ACTIVE=${newActiveCount} | TOTAL_NEW=${newTotal}`);

        return Response.json(results);
    } catch (error) {
        console.error('[compare] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});