import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { latLngToCell } from 'npm:h3-js@4.1.0';

// v7 - Exhaustive ingestion, stale cache fix, territory auto-sync
const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

const FREE_ZIP_LIMIT = 3;
const ZIPS_PER_SEAT = 10;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { zip_code, force_sync = false, check_usage_only = false } = body;

    const isPaid = user.subscription_status === 'active' || user.subscription_status === 'trialing';
    const zipLimit = isPaid ? 10 : FREE_ZIP_LIMIT;
    const generatedZips = user.generated_zip_codes || [];
    const territoryZips = user.territory_zip_codes || [];
    const zipsUsed = generatedZips.length;
    const zipsRemaining = zipLimit - zipsUsed;
    const subTier = isPaid ? 'pro' : 'free';

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

    console.log(`[FetchZip-v7] zip=${zip_code}, tier=${subTier}, zips=${zipsUsed}/${zipLimit}`);

    if (!zip_code || !/^\d{5}$/.test(String(zip_code).trim())) {
      return Response.json({ error: 'Valid 5-digit zip code required' }, { status: 400 });
    }

    const zip = String(zip_code).trim();
    const alreadyGenerated = generatedZips.includes(zip);

    // --- TERRITORY AUTO-SYNC: Always ensure zip is in territory_zip_codes ---
    if (!territoryZips.includes(zip)) {
      const updatedTerritory = [...territoryZips, zip];
      try {
        await base44.auth.updateMe({ territory_zip_codes: updatedTerritory });
        console.log(`[FetchZip-v7] Added ${zip} to territory_zip_codes (now ${updatedTerritory.length} zips)`);
      } catch (e) {
        console.error(`[FetchZip-v7] Failed to update territory_zip_codes:`, e.message);
      }
    }

    // --- STALE CACHE CHECK: If data exists, check if it's fresh enough ---
    if (!force_sync) {
      console.log(`[FetchZip-v7] Checking existing data for ${zip}...`);
      const existing = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 1);
      const existingArr = Array.isArray(existing) ? existing : (existing?.items || []);
      
      if (existingArr.length > 0) {
        const lastUpdated = existingArr[0]?.created_date ? new Date(existingArr[0].created_date) : null;
        const isStale = !lastUpdated || (Date.now() - lastUpdated.getTime() > STALE_THRESHOLD_MS);
        
        if (!isStale) {
          // Data is fresh (< 24h old) — count total and return
          const countResult = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
          const totalCount = (Array.isArray(countResult) ? countResult : (countResult?.items || [])).length;
          console.log(`[FetchZip-v7] Data is fresh (${Math.round((Date.now() - lastUpdated.getTime()) / 3600000)}h old). ${totalCount} properties for ${zip}`);
          return Response.json({
            status: 'exists',
            count: totalCount,
            message: `${totalCount} properties for ${zip} (synced ${Math.round((Date.now() - lastUpdated.getTime()) / 3600000)}h ago)`,
            usage: { zips_used: zipsUsed, zip_limit: zipLimit, zips_remaining: Math.max(0, zipsRemaining), tier: subTier }
          });
        }
        
        console.log(`[FetchZip-v7] Data is STALE (>${Math.round(STALE_THRESHOLD_MS / 3600000)}h). Re-syncing recent sales for ${zip}...`);
      }
    }

    // --- ZIP LIMIT CHECK (only blocks NEW zips) ---
    if (!alreadyGenerated && zipsRemaining <= 0) {
      console.warn(`[FetchZip-v7] ZIP LIMIT REACHED: ${zipsUsed}/${zipLimit} (tier: ${subTier})`);
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

    console.log(`[FetchZip-v7] Fetching from RentCast for zip: ${zip}`);

    const allPropertiesMap = new Map();
    const PAGE_SIZE = 500;

    // --- Helper: Exhaustive paginated fetch ---
    async function fetchAllPages(baseUrl, params, label) {
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', '0');
      params.set('includeTotalCount', 'true');

      const firstUrl = `${baseUrl}?${params.toString()}`;
      console.log(`[${label}] Initial request...`);
      const firstRes = await fetch(firstUrl, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
      
      if (!firstRes.ok) {
        const errText = await firstRes.text();
        console.error(`[${label}] Error ${firstRes.status}: ${errText}`);
        return { ok: false, status: firstRes.status, items: [] };
      }

      const firstData = await firstRes.json();
      const totalHeader = firstRes.headers.get('X-Total-Count');
      const reportedTotal = totalHeader ? parseInt(totalHeader, 10) : (Array.isArray(firstData) ? firstData.length : 0);
      const items = Array.isArray(firstData) ? [...firstData] : [];

      console.log(`[${label}] Page 1: got ${items.length}, total reported: ${reportedTotal}`);

      if (reportedTotal > PAGE_SIZE) {
        const tasks = [];
        for (let offset = PAGE_SIZE; offset < reportedTotal; offset += PAGE_SIZE) {
          tasks.push(async () => {
            const p = new URLSearchParams(params);
            p.set('offset', String(offset));
            p.delete('includeTotalCount');
            try {
              const res = await fetch(`${baseUrl}?${p.toString()}`, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
              return res.ok ? await res.json() : [];
            } catch { return []; }
          });
        }

        console.log(`[${label}] Fetching ${tasks.length} additional pages...`);
        // Execute in batches of 5 to avoid rate limits
        for (let i = 0; i < tasks.length; i += 5) {
          const batch = tasks.slice(i, i + 5).map(t => t());
          const results = await Promise.all(batch);
          results.forEach(r => { if (Array.isArray(r)) items.push(...r); });
          if (i + 5 < tasks.length) await new Promise(r => setTimeout(r, 500));
        }
      }

      console.log(`[${label}] Complete: ${items.length} total items`);
      return { ok: true, items };
    }

    // === PHASE 1: Golden Doors (Recent Sales - last 365 days) ===
    const phase1Params = new URLSearchParams({ zipCode: zip, saleDateRange: '0:365' });
    const phase1 = await fetchAllPages(`${RENTCAST_BASE}/properties`, phase1Params, 'Phase1-RecentSales');
    
    if (!phase1.ok && phase1.status === 401) {
      return Response.json({ error: 'RentCast API key invalid or expired.' }, { status: 500 });
    }

    phase1.items.forEach(p => allPropertiesMap.set(p.id, p));
    console.log(`[FetchZip-v7 Phase 1] ${allPropertiesMap.size} recently sold properties`);

    // === PHASE 2: MLS-Sold (Inactive Listings - closes the deed recording gap) ===
    const phase2Params = new URLSearchParams({ zipCode: zip, status: 'Inactive', daysOld: '0:365' });
    const phase2 = await fetchAllPages(`${RENTCAST_BASE}/listings/sale`, phase2Params, 'Phase2-MLSSold');

    if (phase2.ok) {
      let mlsMerged = 0;
      phase2.items.forEach(l => {
        const id = l.propertyId || l.id;
        // MLS listing data takes priority for sale info (bypasses 14-90 day recording lag)
        const existing = allPropertiesMap.get(id) || {};
        allPropertiesMap.set(id, {
          ...existing,
          ...l,
          id: id,
          lastSaleDate: l.removedDate || l.listedDate || existing.lastSaleDate,
          lastSalePrice: l.price || existing.lastSalePrice,
          _mlsSold: true // Flag to prioritize SOLD status
        });
        mlsMerged++;
      });
      console.log(`[FetchZip-v7 Phase 2] Merged ${mlsMerged} MLS listings. Total unique: ${allPropertiesMap.size}`);
    }

    // === PHASE 3: Density Fill (General property records) ===
    let pass3Offset = 0;
    let requestCount = 0;
    const maxTotalItems = 50000;

    while (allPropertiesMap.size < maxTotalItems) {
      const currentLimit = Math.min(PAGE_SIZE, maxTotalItems - allPropertiesMap.size);
      const params = new URLSearchParams({ zipCode: zip, limit: String(currentLimit), offset: String(pass3Offset) });
      const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
      console.log(`[Phase3-Density] Request ${requestCount + 1}: offset=${pass3Offset}`);

      const response = await fetch(url, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
      if (!response.ok) break;

      const data = await response.json();
      const batch = Array.isArray(data) ? data : [];
      batch.forEach(p => { if (!allPropertiesMap.has(p.id)) allPropertiesMap.set(p.id, p); });

      requestCount++;
      if (batch.length < currentLimit) break;
      pass3Offset += currentLimit;
      if (requestCount >= 100) break;
    }

    const allProperties = Array.from(allPropertiesMap.values());
    console.log(`[FetchZip-v7] Combined Total: ${allProperties.length} properties before insertion.`);

    // --- Track this zip as generated (if new) ---
    if (!alreadyGenerated) {
      const updatedZips = [...generatedZips, zip];
      try {
        await base44.auth.updateMe({ generated_zip_codes: updatedZips });
        console.log(`[FetchZip-v7] Tracked new zip. Total zips: ${updatedZips.length}/${zipLimit}`);
      } catch (e) {
        console.error(`[FetchZip-v7] Failed to update zip tracker:`, e.message);
      }
    }

    const newZipsUsed = alreadyGenerated ? zipsUsed : zipsUsed + 1;
    const newZipsRemaining = zipLimit - newZipsUsed;

    console.log(`[FetchZip-v7] Total fetched: ${allProperties.length} in ${requestCount + phase1.items.length + phase2.items.length} records`);

    if (allProperties.length === 0) {
      return Response.json({
        status: 'empty', count: 0,
        message: `No properties found for zip ${zip}.`,
        usage: { zips_used: newZipsUsed, zip_limit: zipLimit, zips_remaining: newZipsRemaining, tier: subTier }
      });
    }

    // Always deduplicate against existing database records to prevent overlap
    let existingHashes = new Set();
    try {
      const existingProps = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
      const existingArr = Array.isArray(existingProps) ? existingProps : (existingProps?.items || []);
      existingHashes = new Set(existingArr.map(p => p.address_hash));
    } catch (e) {
      console.warn(`[FetchZip-v6] Failed to fetch existing properties for deduplication:`, e.message);
    }

    // Map to schema with H3 spatial indexing
    const mapped = allProperties
      .filter(p => p.latitude && p.longitude && p.addressLine1)
      .filter(p => !existingHashes.has(p.id))
      .map(p => {
        const addressMatch = (p.addressLine1 || "").match(/^(\d+)\s+(.*)$/);
        const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
        const street_name = addressMatch ? addressMatch[2] : (p.addressLine1 || "Unknown");
        
        // MLS-Sold flag takes priority (bypasses deed recording lag)
        let original_status = 'ELIGIBLE';
        if (p._mlsSold) {
          original_status = 'SOLD';
        } else if (p.lastSaleDate) {
          const saleDate = new Date(p.lastSaleDate);
          const oneYearAgo = new Date();
          oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
          if (saleDate > oneYearAgo) original_status = 'SOLD';
        }

        // H3 Resolution 9 index for spatial clustering
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
          sold_date: p.lastSaleDate || null, sale_type: p._mlsSold ? 'MLS' : 'Market',
          property_type: p.propertyType || 'Single Family',
          mls_id: p.assessorID || null, url: null
        };
      });

    console.log(`[FetchZip-v7] ${mapped.length} valid properties to import (${mapped.filter(m => m.original_status === 'SOLD').length} sold)`);

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
      const CHUNK_SIZE = 500; // Increase chunk size to reduce number of requests
      for (let i = 0; i < mapped.length; i += CHUNK_SIZE) {
        const chunk = mapped.slice(i, i + CHUNK_SIZE);
        try {
          await base44.entities.MasterProperty.bulkCreate(chunk);
          successCount += chunk.length;
          await new Promise(r => setTimeout(r, 1000)); // 1 second delay between large chunks
        } catch (e) {
          console.error(`[FetchZip-v6] Chunk failed, trying smaller chunks:`, e.message);
          const SMALL_CHUNK = 100;
          for (let j = 0; j < chunk.length; j += SMALL_CHUNK) {
            const small = chunk.slice(j, j + SMALL_CHUNK);
            try {
              await base44.entities.MasterProperty.bulkCreate(small);
              successCount += small.length;
              await new Promise(r => setTimeout(r, 1000)); // 1 second delay
            } catch {
              console.warn(`[FetchZip-v6] Small chunk failed, skipping`);
              await new Promise(r => setTimeout(r, 1000));
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