import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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

    const allProperties = [];
    // Pass 1: Fetch Golden Doors (Recent Sales in last 3 years)
    let requestCount = 0;
    let pass1Offset = 0;
    const pass1Limit = 500;
    const maxPass1Items = 50000; // Increased cap to get all recent sales

    while (allProperties.length < maxPass1Items) {
      const params = new URLSearchParams({
        zipCode: zip,
        limit: String(pass1Limit),
        offset: String(pass1Offset),
        saleDateRange: '0:1095' // ONLY recently sold in last 3 years
      });

      const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
      console.log(`[FetchZip Phase 1 - Recent Sales] Request ${requestCount + 1}: offset=${pass1Offset}`);

      const response = await fetch(url, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[FetchZip Phase 1] RentCast error ${response.status}: ${errText}`);
        if (response.status === 401) return Response.json({ error: 'RentCast API key invalid or expired.' }, { status: 500 });
        if (response.status === 429) break;
        if (requestCount === 0) return Response.json({ error: `RentCast API error: ${response.status}` }, { status: 500 });
        break;
      }

      const data = await response.json();
      const batch = Array.isArray(data) ? data : [];
      allProperties.push(...batch);
      requestCount++;

      if (batch.length < pass1Limit) break;
      pass1Offset += pass1Limit;
      if (requestCount >= 100) break; // Max 100 pages for Pass 1
    }

    console.log(`[FetchZip Phase 1] Finished. Found ${allProperties.length} recently sold properties.`);

    // Pass 2: Fetch Density (General Properties) to fill the rest of the limit
    let pass2Offset = 0;
    const pass2Limit = 500;
    const maxTotalItems = 50000; // Total upper limit for the entire pull

    while (allProperties.length < maxTotalItems) {
      const currentLimit = Math.min(pass2Limit, maxTotalItems - allProperties.length);
      const params = new URLSearchParams({
        zipCode: zip,
        limit: String(currentLimit),
        offset: String(pass2Offset)
      });

      const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
      console.log(`[FetchZip Phase 2 - Density] Request ${requestCount + 1}: offset=${pass2Offset}`);

      const response = await fetch(url, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[FetchZip Phase 2] RentCast error ${response.status}: ${errText}`);
        break;
      }

      const data = await response.json();
      const batch = Array.isArray(data) ? data : [];

      // Deduplicate Pass 2 against Pass 1
      const existingIds = new Set(allProperties.map(p => p.id));
      const newProperties = batch.filter(p => !existingIds.has(p.id));

      allProperties.push(...newProperties);
      requestCount++;

      if (batch.length < currentLimit) break; // Use original batch length to check if API exhausted
      pass2Offset += currentLimit;
      if (requestCount >= 200) { console.warn('[FetchZip] Reached total combined page safety cap (200).'); break; }
    }

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
        return {
          address_hash: p.id || `${p.addressLine1}-${zip}`,
          house_number, street_name,
          full_address: p.formattedAddress || p.addressLine1,
          city: p.city || '', state: p.state || '', zip_code: p.zipCode || zip,
          lat: p.latitude, lng: p.longitude, original_status,
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