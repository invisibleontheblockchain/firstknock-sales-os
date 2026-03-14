import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");

Deno.serve(async (req) => {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { zip_codes = ['88001', '88005', '88012'], latitude, longitude, radius } = body;
    
    const results = { api_calls: 0, by_zip: {}, by_circle: null };
    const headers = { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY };
    
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    
    // Test each ZIP with /listings/sale for both Active and Inactive
    for (const zip of zip_codes) {
        const zipResult = {};
        
        // Inactive (sold) listings - total count
        const inactiveUrl = `https://api.rentcast.io/v1/listings/sale?zipCode=${zip}&status=Inactive&limit=1&includeTotalCount=true`;
        console.log(`[test] Inactive listings: ${inactiveUrl}`);
        const inactiveRes = await fetch(inactiveUrl, { headers });
        results.api_calls++;
        zipResult.inactive_total = inactiveRes.headers.get('X-Total-Count');
        zipResult.inactive_status = inactiveRes.status;
        await sleep(200);
        
        // Active listings - total count  
        const activeUrl = `https://api.rentcast.io/v1/listings/sale?zipCode=${zip}&status=Active&limit=1&includeTotalCount=true`;
        console.log(`[test] Active listings: ${activeUrl}`);
        const activeRes = await fetch(activeUrl, { headers });
        results.api_calls++;
        zipResult.active_total = activeRes.headers.get('X-Total-Count');
        zipResult.active_status = activeRes.status;
        await sleep(200);
        
        // Inactive with daysOld filter (recent sold only)
        const recentSoldUrl = `https://api.rentcast.io/v1/listings/sale?zipCode=${zip}&status=Inactive&daysOld=0:420&limit=5&includeTotalCount=true`;
        console.log(`[test] Recent sold listings (14mo): ${recentSoldUrl}`);
        const recentSoldRes = await fetch(recentSoldUrl, { headers });
        results.api_calls++;
        const recentSoldData = await recentSoldRes.json();
        zipResult.inactive_14mo_total = recentSoldRes.headers.get('X-Total-Count');
        zipResult.inactive_14mo_sample = (Array.isArray(recentSoldData) ? recentSoldData : []).slice(0, 3).map(r => ({
            address: r.formattedAddress, price: r.price, status: r.status,
            listedDate: r.listedDate, removedDate: r.removedDate, daysOnMarket: r.daysOnMarket
        }));
        await sleep(200);
        
        // Inactive with daysOld filter (3 months)
        const recent3moUrl = `https://api.rentcast.io/v1/listings/sale?zipCode=${zip}&status=Inactive&daysOld=0:90&limit=1&includeTotalCount=true`;
        console.log(`[test] Recent sold listings (3mo): ${recent3moUrl}`);
        const recent3moRes = await fetch(recent3moUrl, { headers });
        results.api_calls++;
        zipResult.inactive_3mo_total = recent3moRes.headers.get('X-Total-Count');
        await sleep(200);
        
        results.by_zip[zip] = zipResult;
    }
    
    // Circle-based test
    if (latitude && longitude && radius) {
        const circleResult = {};
        
        const circleInactiveUrl = `https://api.rentcast.io/v1/listings/sale?latitude=${latitude}&longitude=${longitude}&radius=${radius}&status=Inactive&limit=1&includeTotalCount=true`;
        console.log(`[test] Circle Inactive: ${circleInactiveUrl}`);
        const circleInactiveRes = await fetch(circleInactiveUrl, { headers });
        results.api_calls++;
        circleResult.inactive_total = circleInactiveRes.headers.get('X-Total-Count');
        await sleep(200);
        
        const circleActiveUrl = `https://api.rentcast.io/v1/listings/sale?latitude=${latitude}&longitude=${longitude}&radius=${radius}&status=Active&limit=1&includeTotalCount=true`;
        console.log(`[test] Circle Active: ${circleActiveUrl}`);
        const circleActiveRes = await fetch(circleActiveUrl, { headers });
        results.api_calls++;
        circleResult.active_total = circleActiveRes.headers.get('X-Total-Count');
        await sleep(200);

        const circleInactive14moUrl = `https://api.rentcast.io/v1/listings/sale?latitude=${latitude}&longitude=${longitude}&radius=${radius}&status=Inactive&daysOld=0:420&limit=1&includeTotalCount=true`;
        console.log(`[test] Circle Inactive 14mo: ${circleInactive14moUrl}`);
        const circleInactive14moRes = await fetch(circleInactive14moUrl, { headers });
        results.api_calls++;
        circleResult.inactive_14mo_total = circleInactive14moRes.headers.get('X-Total-Count');
        
        results.by_circle = circleResult;
    }
    
    console.log('[test] Results:', JSON.stringify(results, null, 2));
    return Response.json(results);
});