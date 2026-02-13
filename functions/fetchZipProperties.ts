import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { zip_code, force_sync } = await req.json();

    if (!zip_code || !/^\d{5}$/.test(zip_code.trim())) {
      return Response.json({ error: 'Valid 5-digit zip code required' }, { status: 400 });
    }

    const zip = zip_code.trim();

    // 1. Check if we already have data for this zip
    if (!force_sync) {
      const existing = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 1);
      const existingArr = Array.isArray(existing) ? existing : (existing?.items || []);
      if (existingArr.length > 0) {
        // Count total
        const allExisting = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
        const count = Array.isArray(allExisting) ? allExisting.length : (allExisting?.items?.length || 0);
        return Response.json({
          status: 'exists',
          count,
          message: `Already have ${count} properties for ${zip}`
        });
      }
    }

    // 2. Fetch from RentCast API — recently sold single family homes
    console.log(`[FetchZip] Fetching from RentCast for zip: ${zip}`);

    const allProperties = [];
    let offset = 0;
    const limit = 500; // Max per request
    let hasMore = true;
    let requestCount = 0;
    const MAX_REQUESTS = 4; // Cap at 2000 properties per zip to conserve API credits

    while (hasMore && requestCount < MAX_REQUESTS) {
      const params = new URLSearchParams({
        zipCode: zip,
        propertyType: 'Single Family',
        limit: String(limit),
        offset: String(offset),
      });

      const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
      console.log(`[FetchZip] Request ${requestCount + 1}: offset=${offset}`);

      const response = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'X-Api-Key': RENTCAST_API_KEY
        }
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[FetchZip] RentCast error ${response.status}: ${errText}`);
        
        if (response.status === 401) {
          return Response.json({ error: 'RentCast API key is invalid or expired. Check your RENTCAST_API_KEY secret.' }, { status: 500 });
        }
        if (response.status === 429) {
          console.warn('[FetchZip] Rate limited, stopping pagination');
          break;
        }
        // For other errors on first request, fail. On subsequent, just stop.
        if (requestCount === 0) {
          return Response.json({ error: `RentCast API error: ${response.status}` }, { status: 500 });
        }
        break;
      }

      const data = await response.json();
      const batch = Array.isArray(data) ? data : [];
      console.log(`[FetchZip] Got ${batch.length} properties`);

      allProperties.push(...batch);
      requestCount++;

      if (batch.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    console.log(`[FetchZip] Total fetched: ${allProperties.length} properties in ${requestCount} requests`);

    if (allProperties.length === 0) {
      return Response.json({
        status: 'empty',
        count: 0,
        message: `No properties found for zip ${zip}. This zip may not have single family homes in RentCast's database.`
      });
    }

    // 3. If force_sync, get existing hashes to deduplicate
    let existingHashes = new Set();
    if (force_sync) {
      const existingProps = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
      const existingArr = Array.isArray(existingProps) ? existingProps : (existingProps?.items || []);
      existingHashes = new Set(existingArr.map(p => p.address_hash));
    }

    // 4. Map RentCast data to MasterProperty schema
    const mapped = allProperties
      .filter(p => p.latitude && p.longitude && p.addressLine1)
      .filter(p => !existingHashes.has(p.id))
      .map(p => {
        const addressMatch = (p.addressLine1 || "").match(/^(\d+)\s+(.*)$/);
        const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
        const street_name = addressMatch ? addressMatch[2] : (p.addressLine1 || "Unknown");

        // Determine status from sale history
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

    console.log(`[FetchZip] Mapped ${mapped.length} valid properties for import`);

    if (mapped.length === 0) {
      return Response.json({
        status: 'empty',
        count: 0,
        message: `Properties found but none had valid coordinates for zip ${zip}.`
      });
    }

    // 5. Bulk insert into MasterProperty
    let successCount = 0;
    const CHUNK_SIZE = 50;

    for (let i = 0; i < mapped.length; i += CHUNK_SIZE) {
      const chunk = mapped.slice(i, i + CHUNK_SIZE);
      try {
        await base44.entities.MasterProperty.bulkCreate(chunk);
        successCount += chunk.length;
      } catch (e) {
        console.error(`[FetchZip] Bulk create failed for chunk ${i}, trying singles:`, e.message);
        for (const prop of chunk) {
          try {
            await base44.entities.MasterProperty.create(prop);
            successCount++;
          } catch (err) {
            console.error(`[FetchZip] Single create failed:`, err.message);
          }
        }
      }
    }

    console.log(`[FetchZip] Successfully imported ${successCount}/${mapped.length} properties`);

    return Response.json({
      status: 'imported',
      zip_code: zip,
      count: successCount,
      total_found: allProperties.length,
      message: `Imported ${successCount} properties for zip ${zip}`
    });

  } catch (error) {
    console.error('[FetchZip] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});