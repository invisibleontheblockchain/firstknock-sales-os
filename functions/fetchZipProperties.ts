import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { latLngToCell } from 'npm:h3-js@4.1.0';

// v6 - Free = 1 zip code only, paid = more zips based on plan
const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

// Zip limits: free = 3, paid = 10 per seat
const FREE_ZIP_LIMIT = 3;
const ZIPS_PER_SEAT = 10;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { zip_code, force_sync = false, check_usage_only = false } = body;

    // --- Determine user's zip limits (Flat rate: 3 free, 10 paid) ---
    const isPaid = user.subscription_status === 'active' || user.subscription_status === 'trialing';
    const zipLimit = isPaid ? 10 : FREE_ZIP_LIMIT;
    const generatedZips = user.generated_zip_codes || [];
    const zipsUsed = generatedZips.length;
    const zipsRemaining = zipLimit - zipsUsed;
    const subTier = isPaid ? 'pro' : 'free';

    // If just checking usage, return stats
    if (check_usage_only) {
      return Response.json({
        status: 'usage',
        zips_used: zipsUsed,
        zip_limit: zipLimit,
        zips_remaining: Math.max(0, zipsRemaining),
        generated_zips: generatedZips,
        tier: subTier,
        is_paid: isPaid
      });
    }

    console.log(`[FetchZip-v6] zip=${zip_code}, tier=${subTier}, zips=${zipsUsed}/${zipLimit}`);

    if (!zip_code || !/^\d{5}$/.test(String(zip_code).trim())) {
      return Response.json({ error: 'Valid 5-digit zip code required' }, { status: 400 });
    }

    const zip = String(zip_code).trim();

    // Check if this zip was already generated (always allow re-access to existing zips)
    const alreadyGenerated = generatedZips.includes(zip);

    if (!force_sync) {
      console.log(`[FetchZip-v6] Checking existing data for ${zip}...`);
      const existing = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
      const existingArr = Array.isArray(existing) ? existing : (existing?.items || []);
      if (existingArr.length > 0) {
        console.log(`[FetchZip-v6] Already have ${existingArr.length} properties for ${zip}`);
        return Response.json({
          status: 'exists',
          count: existingArr.length,
          message: `Already have ${existingArr.length} properties for ${zip}`,
          usage: { zips_used: zipsUsed, zip_limit: zipLimit, zips_remaining: Math.max(0, zipsRemaining), tier: subTier }
        });
      }
    }

    // --- ZIP LIMIT CHECK (only blocks NEW zips, not re-syncing existing ones) ---
    if (!alreadyGenerated && zipsRemaining <= 0) {
      console.warn(`[FetchZip-v6] ZIP LIMIT REACHED: ${zipsUsed}/${zipLimit} (tier: ${subTier})`);
      const upgradeMsg = !isPaid
        ? `You've used your ${FREE_ZIP_LIMIT} free zip codes. Subscribe to unlock more territories.`
        : `You've reached your ${zipLimit} zip code limit. Contact support for enterprise plans.`;
      return Response.json({
        error: 'Zip code limit reached',
        message: upgradeMsg,
        usage: { zips_used: zipsUsed, zip_limit: zipLimit, zips_remaining: 0, tier: subTier, is_paid: isPaid }
      }, { status: 429 });
    }

    if (!RENTCAST_API_KEY) {
      return Response.json({ error: 'RENTCAST_API_KEY not configured' }, { status: 500 });
    }

    console.log(`[FetchZip-v6] Fetching from RentCast for zip: ${zip}`);

    const allPropertiesMap = new Map();

    // Phase 1: Fetch Golden Doors (Recent Sales in last 1 year)
    const pass1Limit = 500;
    const initialParams = new URLSearchParams({
      zipCode: zip,
      limit: String(pass1Limit),
      offset: '0',
      saleDateRange: '0:365', // ONLY recently sold in last 1 year
      includeTotalCount: 'true'
    });

    const initialUrl = `${RENTCAST_BASE}/properties?${initialParams.toString()}`;
    console.log(`[FetchZip Phase 1 - Recent Sales] Initial Request`);

    const initialResponse = await fetch(initialUrl, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });

    if (!initialResponse.ok) {
      const errText = await initialResponse.text();
      console.error(`[FetchZip Phase 1] RentCast error ${initialResponse.status}: ${errText}`);
      if (initialResponse.status === 401) return Response.json({ error: 'RentCast API key invalid or expired.' }, { status: 500 });
      return Response.json({ error: `RentCast API error: ${initialResponse.status}` }, { status: 500 });
    }

    const initialData = await initialResponse.json();
    const totalCountHeader = initialResponse.headers.get('X-Total-Count');
    const reportedTotal = totalCountHeader ? parseInt(totalCountHeader, 10) : (Array.isArray(initialData) ? initialData.length : 0);

    if (Array.isArray(initialData)) {
      initialData.forEach(p => allPropertiesMap.set(p.id, p));
    }

    if (reportedTotal > pass1Limit) {
      const fetchTasks = [];
      for (let offset = pass1Limit; offset < reportedTotal; offset += pass1Limit) {
        fetchTasks.push(async () => {
          const params = new URLSearchParams({
            zipCode: zip,
            limit: String(pass1Limit),
            offset: String(offset),
            saleDateRange: '0:365'
          });
          try {
            const res = await fetch(`${RENTCAST_BASE}/properties?${params.toString()}`, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
            return res.ok ? await res.json() : [];
          } catch (err) {
            return [];
          }
        });
      }

      console.log(`[FetchZip Phase 1] Firing ${fetchTasks.length} parallel requests...`);
      for (let i = 0; i < fetchTasks.length; i += 5) {
        const chunk = fetchTasks.slice(i, i + 5).map(task => task());
        const results = await Promise.all(chunk);
        results.forEach(batch => {
          if (Array.isArray(batch)) {
            batch.forEach(p => allPropertiesMap.set(p.id, p));
          }
        });
      }
    }

    console.log(`[FetchZip Phase 1] Finished. Found ${allPropertiesMap.size} recently sold properties.`);

    // Phase 2: Fetch Inactive Listings (MLS-Sold but not yet recorded)
    const initialListingsParams = new URLSearchParams({
      zipCode: zip,
      limit: String(pass1Limit),
      offset: '0',
      status: 'Inactive',
      daysOld: '0:365',
      includeTotalCount: 'true'
    });

    console.log(`[FetchZip Phase 2 - MLS Sold] Initial Request`);
    const initialListingsResponse = await fetch(`${RENTCAST_BASE}/listings/sale?${initialListingsParams.toString()}`, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });

    if (initialListingsResponse.ok) {
      const initialListingsData = await initialListingsResponse.json();
      const listingsTotalCountHeader = initialListingsResponse.headers.get('X-Total-Count');
      const listingsTotal = listingsTotalCountHeader ? parseInt(listingsTotalCountHeader, 10) : (Array.isArray(initialListingsData) ? initialListingsData.length : 0);

      const processListingsBatch = (batch) => {
        if (Array.isArray(batch)) {
          batch.forEach(l => {
            const id = l.propertyId || l.id;
            allPropertiesMap.set(id, {
              ...allPropertiesMap.get(id),
              ...l,
              id: id,
              lastSaleDate: l.removedDate || l.listedDate,
              lastSalePrice: l.price
            });
          });
        }
      };

      processListingsBatch(initialListingsData);

      if (listingsTotal > pass1Limit) {
        const fetchTasks = [];
        for (let offset = pass1Limit; offset < listingsTotal; offset += pass1Limit) {
          fetchTasks.push(async () => {
            const params = new URLSearchParams({
              zipCode: zip,
              limit: String(pass1Limit),
              offset: String(offset),
              status: 'Inactive',
              daysOld: '0:365'
            });
            try {
              const res = await fetch(`${RENTCAST_BASE}/listings/sale?${params.toString()}`, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
              return res.ok ? await res.json() : [];
            } catch (err) {
              return [];
            }
          });
        }

        console.log(`[FetchZip Phase 2] Firing ${fetchTasks.length} parallel requests...`);
        for (let i = 0; i < fetchTasks.length; i += 5) {
          const chunk = fetchTasks.slice(i, i + 5).map(task => task());
          const results = await Promise.all(chunk);
          results.forEach(processListingsBatch);
        }
      }
    }
    console.log(`[FetchZip Phase 2] Finished. Total golden doors now: ${allPropertiesMap.size}`);

    // Phase 3: Fetch Density (General Properties)
    let pass3Offset = 0;
    let requestCount = 0;
    const maxTotalItems = 50000;

    while (allPropertiesMap.size < maxTotalItems) {
      const currentLimit = Math.min(pass1Limit, maxTotalItems - allPropertiesMap.size);
      const params = new URLSearchParams({
        zipCode: zip,
        limit: String(currentLimit),
        offset: String(pass3Offset)
      });

      const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
      console.log(`[FetchZip Phase 3 - Density] Request ${requestCount + 1}: offset=${pass3Offset}`);

      const response = await fetch(url, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });

      if (!response.ok) break;

      const data = await response.json();
      const batch = Array.isArray(data) ? data : [];

      batch.forEach(p => {
        if (!allPropertiesMap.has(p.id)) {
          allPropertiesMap.set(p.id, p);
        }
      });

      requestCount++;
      if (batch.length < currentLimit) break;
      pass3Offset += currentLimit;
      if (requestCount >= 100) break;
    }

    const allProperties = Array.from(allPropertiesMap.values());
    console.log(`[FetchZip] Combined Total: ${allProperties.length} properties before insertion.`);

    // --- Track this zip as generated (if new) ---
    if (!alreadyGenerated) {
      const updatedZips = [...generatedZips, zip];
      try {
        await base44.auth.updateMe({ generated_zip_codes: updatedZips });
        console.log(`[FetchZip-v6] Tracked new zip. Total zips: ${updatedZips.length}/${zipLimit}`);
      } catch (e) {
        console.error(`[FetchZip-v6] Failed to update zip tracker:`, e.message);
      }
    }

    const newZipsUsed = alreadyGenerated ? zipsUsed : zipsUsed + 1;
    const newZipsRemaining = zipLimit - newZipsUsed;

    console.log(`[FetchZip-v6] Total fetched: ${allProperties.length} in ${requestCount} API calls`);

    if (allProperties.length === 0) {
      return Response.json({
        status: 'empty', count: 0,
        message: `No properties found for zip ${zip}.`,
        usage: { zips_used: newZipsUsed, zip_limit: zipLimit, zips_remaining: newZipsRemaining, tier: subTier }
      });
    }

    // Deduplicate if force_sync
    let existingHashes = new Set();
    if (force_sync) {
      const existingProps = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
      const existingArr = Array.isArray(existingProps) ? existingProps : (existingProps?.items || []);
      existingHashes = new Set(existingArr.map(p => p.address_hash));
    }

    // Map to schema
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
          const oneYearAgo = new Date();
          oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
          if (saleDate > oneYearAgo) original_status = 'SOLD';
        }

        let h3_index = null;
        try {
          h3_index = latLngToCell(p.latitude, p.longitude, 9);
        } catch (e) {}

        return {
          address_hash: p.id || `${p.addressLine1}-${zip}`,
          house_number, street_name,
          full_address: p.formattedAddress || p.addressLine1,
          city: p.city || '', state: p.state || '', zip_code: p.zipCode || zip,
          lat: p.latitude, lng: p.longitude, original_status,
          h3_index,
          beds: p.bedrooms || 0, baths: p.bathrooms || 0,
          sqft: p.squareFootage || 0, lot_size: p.lotSize || 0,
          year_built: p.yearBuilt || 0, price: p.lastSalePrice || 0,
          sold_date: p.lastSaleDate || null, sale_type: 'Market',
          property_type: p.propertyType || 'Single Family',
          mls_id: p.assessorID || null, url: null
        };
      });

    console.log(`[FetchZip-v6] ${mapped.length} valid properties to import`);

    if (mapped.length === 0) {
      return Response.json({
        status: 'empty', count: 0,
        message: `Properties found but none had valid coordinates.`,
        usage: { zips_used: newZipsUsed, zip_limit: zipLimit, zips_remaining: newZipsRemaining, tier: subTier }
      });
    }

    // Bulk insert NEW properties only
    let successCount = 0;
    if (mapped.length > 0) {
      const CHUNK_SIZE = 100;
      for (let i = 0; i < mapped.length; i += CHUNK_SIZE) {
        const chunk = mapped.slice(i, i + CHUNK_SIZE);
        try {
          await base44.entities.MasterProperty.bulkCreate(chunk);
          successCount += chunk.length;
        } catch (e) {
          console.error(`[FetchZip-v6] Chunk failed, trying smaller chunks:`, e.message);
          const SMALL_CHUNK = 10;
          for (let j = 0; j < chunk.length; j += SMALL_CHUNK) {
            const small = chunk.slice(j, j + SMALL_CHUNK);
            try {
              await base44.entities.MasterProperty.bulkCreate(small);
              successCount += small.length;
            } catch {
              console.warn(`[FetchZip-v6] Small chunk failed, skipping`);
            }
          }
        }
      }
    }

    console.log(`[FetchZip-v6] Done! Imported ${successCount}/${mapped.length}`);

    return Response.json({
      status: 'imported',
      zip_code: zip,
      count: successCount,
      total_found: allProperties.length,
      message: `Imported ${successCount} properties for zip ${zip}`,
      usage: { zips_used: newZipsUsed, zip_limit: zipLimit, zips_remaining: newZipsRemaining, tier: subTier }
    });

  } catch (error) {
    console.error('[FetchZip-v6] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});