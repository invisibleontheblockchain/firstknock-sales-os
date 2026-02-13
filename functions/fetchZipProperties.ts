import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// v3 - RentCast powered, no Neon dependency
const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const zip_code = body.zip_code;
    const force_sync = body.force_sync || false;

    console.log(`[FetchZip-v2] Called with zip=${zip_code}, force=${force_sync}`);

    if (!zip_code || !/^\d{5}$/.test(String(zip_code).trim())) {
      return Response.json({ error: 'Valid 5-digit zip code required' }, { status: 400 });
    }

    const zip = String(zip_code).trim();

    // 1. Check if we already have data for this zip (skip if force_sync)
    if (!force_sync) {
      console.log(`[FetchZip-v2] Checking existing data for ${zip}...`);
      const existing = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
      const existingArr = Array.isArray(existing) ? existing : (existing?.items || []);
      if (existingArr.length > 0) {
        console.log(`[FetchZip-v2] Already have ${existingArr.length} properties for ${zip}`);
        return Response.json({
          status: 'exists',
          count: existingArr.length,
          message: `Already have ${existingArr.length} properties for ${zip}`
        });
      }
    }

    // 2. Fetch from RentCast API
    if (!RENTCAST_API_KEY) {
      return Response.json({ error: 'RENTCAST_API_KEY not configured' }, { status: 500 });
    }

    console.log(`[FetchZip-v2] Fetching from RentCast for zip: ${zip}`);

    const allProperties = [];
    let offset = 0;
    const limit = 500;
    let hasMore = true;
    let requestCount = 0;
    const MAX_REQUESTS = 4; // Up to 2000 properties per zip

    while (hasMore && requestCount < MAX_REQUESTS) {
      const params = new URLSearchParams({
        zipCode: zip,
        propertyType: 'Single Family',
        limit: String(limit),
        offset: String(offset),
      });

      const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
      console.log(`[FetchZip-v2] Request ${requestCount + 1}: offset=${offset}`);

      const response = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'X-Api-Key': RENTCAST_API_KEY
        }
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[FetchZip-v2] RentCast error ${response.status}: ${errText}`);

        if (response.status === 401) {
          return Response.json({ error: 'RentCast API key invalid or expired. Update RENTCAST_API_KEY in settings.' }, { status: 500 });
        }
        if (response.status === 429) {
          console.warn('[FetchZip-v2] Rate limited');
          break;
        }
        if (requestCount === 0) {
          return Response.json({ error: `RentCast API error: ${response.status} - ${errText}` }, { status: 500 });
        }
        break;
      }

      const data = await response.json();
      const batch = Array.isArray(data) ? data : [];
      console.log(`[FetchZip-v2] Got ${batch.length} properties`);

      allProperties.push(...batch);
      requestCount++;

      if (batch.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    console.log(`[FetchZip-v2] Total fetched: ${allProperties.length} in ${requestCount} API calls`);

    if (allProperties.length === 0) {
      return Response.json({
        status: 'empty',
        count: 0,
        message: `No single family properties found for zip ${zip} in RentCast.`
      });
    }

    // 3. Deduplicate against existing if force_sync
    let existingHashes = new Set();
    if (force_sync) {
      const existingProps = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
      const existingArr = Array.isArray(existingProps) ? existingProps : (existingProps?.items || []);
      existingHashes = new Set(existingArr.map(p => p.address_hash));
    }

    // 4. Map to MasterProperty schema
    const mapped = allProperties
      .filter(p => p.latitude && p.longitude && p.addressLine1)
      .filter(p => !existingHashes.has(p.id))
      .map(p => {
        const addressMatch = (p.addressLine1 || "").match(/^(\d+)\s+(.*)$/);
        const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
        const street_name = addressMatch ? addressMatch[2] : (p.addressLine1 || "Unknown");

        let original_status = 'ELIGIBLE';
        if (p.lastSaleDate) {
          const saleDate = new Date(p.lastSaleDate);
          const twoYearsAgo = new Date();
          twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
          if (saleDate > twoYearsAgo) {
            original_status = 'SOLD';
          }
        }

        return {
          address_hash: p.id || `${p.addressLine1}-${zip}`,
          house_number,
          street_name,
          full_address: p.formattedAddress || p.addressLine1,
          city: p.city || '',
          state: p.state || '',
          zip_code: p.zipCode || zip,
          lat: p.latitude,
          lng: p.longitude,
          original_status,
          beds: p.bedrooms || 0,
          baths: p.bathrooms || 0,
          sqft: p.squareFootage || 0,
          lot_size: p.lotSize || 0,
          year_built: p.yearBuilt || 0,
          price: p.lastSalePrice || 0,
          sold_date: p.lastSaleDate || null,
          sale_type: 'Market',
          property_type: p.propertyType || 'Single Family',
          mls_id: p.assessorID || null,
          url: null
        };
      });

    console.log(`[FetchZip-v2] ${mapped.length} valid properties to import`);

    if (mapped.length === 0) {
      return Response.json({
        status: 'empty',
        count: 0,
        message: `Properties found but none had valid coordinates for zip ${zip}.`
      });
    }

    // 5. Bulk insert
    let successCount = 0;
    const CHUNK_SIZE = 50;

    for (let i = 0; i < mapped.length; i += CHUNK_SIZE) {
      const chunk = mapped.slice(i, i + CHUNK_SIZE);
      try {
        await base44.entities.MasterProperty.bulkCreate(chunk);
        successCount += chunk.length;
        console.log(`[FetchZip-v2] Inserted chunk ${Math.floor(i / CHUNK_SIZE) + 1}, total: ${successCount}`);
      } catch (e) {
        console.error(`[FetchZip-v2] Bulk failed, trying singles:`, e.message);
        for (const prop of chunk) {
          try {
            await base44.entities.MasterProperty.create(prop);
            successCount++;
          } catch (err) {
            console.error(`[FetchZip-v2] Single failed:`, err.message);
          }
        }
      }
    }

    console.log(`[FetchZip-v2] Done! Imported ${successCount}/${mapped.length}`);

    return Response.json({
      status: 'imported',
      zip_code: zip,
      count: successCount,
      total_found: allProperties.length,
      message: `Imported ${successCount} properties for zip ${zip}`
    });

  } catch (error) {
    console.error('[FetchZip-v2] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});