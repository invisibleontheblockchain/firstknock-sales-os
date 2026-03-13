import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { latLngToCell } from 'npm:h3-js@4.1.0';

// v8 - Lean fetch: Only recently sold + MLS. No density fill. Respects sold_months param.
const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const PAGE_SIZE = 500;

async function fetchAllPages(baseUrl, params, label, apiKey) {
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', '0');
  params.set('includeTotalCount', 'true');

  const firstUrl = `${baseUrl}?${params.toString()}`;
  console.log(`[${label}] Request: ${firstUrl}`);
  const firstRes = await fetch(firstUrl, { headers: { 'accept': 'application/json', 'X-Api-Key': apiKey } });

  if (!firstRes.ok) {
    const errText = await firstRes.text();
    console.error(`[${label}] Error ${firstRes.status}: ${errText}`);
    return { ok: false, status: firstRes.status, items: [], apiCalls: 1 };
  }

  const firstData = await firstRes.json();
  const totalHeader = firstRes.headers.get('X-Total-Count');
  const reportedTotal = totalHeader ? parseInt(totalHeader, 10) : (Array.isArray(firstData) ? firstData.length : 0);
  const items = Array.isArray(firstData) ? [...firstData] : [];
  let apiCalls = 1;

  console.log(`[${label}] Page 1: ${items.length} items, total: ${reportedTotal}`);

  // Cap at 5000 to prevent runaway pagination
  const maxFetch = Math.min(reportedTotal, 5000);

  if (maxFetch > PAGE_SIZE) {
    const tasks = [];
    for (let offset = PAGE_SIZE; offset < maxFetch; offset += PAGE_SIZE) {
      tasks.push(offset);
    }

    // Execute in batches of 3 (conservative to avoid rate limits)
    for (let i = 0; i < tasks.length; i += 3) {
      const batch = tasks.slice(i, i + 3);
      const promises = batch.map(offset => {
        const p = new URLSearchParams(params);
        p.set('offset', String(offset));
        p.delete('includeTotalCount');
        apiCalls++;
        return fetch(`${baseUrl}?${p.toString()}`, { headers: { 'accept': 'application/json', 'X-Api-Key': apiKey } })
          .then(res => res.ok ? res.json() : [])
          .catch(() => []);
      });
      const results = await Promise.all(promises);
      results.forEach(r => { if (Array.isArray(r)) items.push(...r); });
      if (i + 3 < tasks.length) await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`[${label}] Complete: ${items.length} items in ${apiCalls} API calls`);
  return { ok: true, items, apiCalls };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { zip_code, force_sync = false, check_usage_only = false, sold_months = 12 } = body;

    const generatedZips = user.generated_zip_codes || [];
    const territoryZips = user.territory_zip_codes || [];

    if (check_usage_only) {
      return Response.json({ status: 'usage', zips_used: generatedZips.length, zip_limit: 'unlimited', generated_zips: generatedZips });
    }

    if (!zip_code || !/^\d{5}$/.test(String(zip_code).trim())) {
      return Response.json({ error: 'Valid 5-digit zip code required' }, { status: 400 });
    }

    const zip = String(zip_code).trim();
    const daysBack = Math.min(sold_months * 30, 365); // Cap at 1 year
    console.log(`[FetchZip-v8] zip=${zip}, sold_months=${sold_months}, daysBack=${daysBack}`);

    // Auto-add to territory
    if (!territoryZips.includes(zip)) {
      try {
        await base44.auth.updateMe({ territory_zip_codes: [...territoryZips, zip] });
        console.log(`[FetchZip-v8] Added ${zip} to territory`);
      } catch (e) { console.error(`[FetchZip-v8] Territory update failed:`, e.message); }
    }

    // Stale cache check
    if (!force_sync) {
      const existing = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 1);
      const existingArr = Array.isArray(existing) ? existing : (existing?.items || []);
      if (existingArr.length > 0) {
        const lastUpdated = existingArr[0]?.created_date ? new Date(existingArr[0].created_date) : null;
        const isStale = !lastUpdated || (Date.now() - lastUpdated.getTime() > STALE_THRESHOLD_MS);
        if (!isStale) {
          const countResult = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
          const totalCount = (Array.isArray(countResult) ? countResult : (countResult?.items || [])).length;
          console.log(`[FetchZip-v8] Cache hit — ${totalCount} props, ${Math.round((Date.now() - lastUpdated.getTime()) / 3600000)}h old`);
          return Response.json({ status: 'exists', count: totalCount, message: `${totalCount} properties cached for ${zip}` });
        }
        console.log(`[FetchZip-v8] Cache stale, re-syncing...`);
      }
    }

    if (!RENTCAST_API_KEY) return Response.json({ error: 'RENTCAST_API_KEY not configured' }, { status: 500 });

    let totalApiCalls = 0;
    const allPropertiesMap = new Map();

    // === PHASE 1: Recently Sold Properties (server-side filtered by saleDateRange) ===
    const phase1Params = new URLSearchParams({ zipCode: zip, saleDateRange: `0:${daysBack}` });
    const phase1 = await fetchAllPages(`${RENTCAST_BASE}/properties`, phase1Params, 'RecentSales', RENTCAST_API_KEY);
    totalApiCalls += phase1.apiCalls;

    if (!phase1.ok && phase1.status === 401) {
      return Response.json({ error: 'RentCast API key invalid or expired.' }, { status: 500 });
    }
    phase1.items.forEach(p => allPropertiesMap.set(p.id, p));
    console.log(`[FetchZip-v8] Phase 1: ${allPropertiesMap.size} recently sold (${phase1.apiCalls} calls)`);

    // === PHASE 2: MLS Sold Listings (fills deed recording gap) ===
    const phase2Params = new URLSearchParams({ zipCode: zip, status: 'Inactive', daysOld: `0:${daysBack}` });
    const phase2 = await fetchAllPages(`${RENTCAST_BASE}/listings/sale`, phase2Params, 'MLSSold', RENTCAST_API_KEY);
    totalApiCalls += phase2.apiCalls;

    if (phase2.ok) {
      let mlsMerged = 0;
      phase2.items.forEach(l => {
        const id = l.propertyId || l.id;
        const existing = allPropertiesMap.get(id) || {};
        allPropertiesMap.set(id, {
          ...existing, ...l, id,
          lastSaleDate: l.removedDate || l.listedDate || existing.lastSaleDate,
          lastSalePrice: l.price || existing.lastSalePrice,
          _mlsSold: true
        });
        mlsMerged++;
      });
      console.log(`[FetchZip-v8] Phase 2: Merged ${mlsMerged} MLS. Unique total: ${allPropertiesMap.size} (${phase2.apiCalls} calls)`);
    }

    // === NO PHASE 3 — no density fill. Only sold properties. ===
    console.log(`[FetchZip-v8] Total API calls used: ${totalApiCalls}`);

    const allProperties = Array.from(allPropertiesMap.values());

    // Track zip
    if (!generatedZips.includes(zip)) {
      try { await base44.auth.updateMe({ generated_zip_codes: [...generatedZips, zip] }); } catch (e) {}
    }

    if (allProperties.length === 0) {
      return Response.json({ status: 'empty', count: 0, message: `No recently sold properties found for ${zip} in last ${sold_months} months.`, api_calls: totalApiCalls });
    }

    // Dedup against existing DB records
    let existingHashes = new Set();
    try {
      const existingProps = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
      existingHashes = new Set((Array.isArray(existingProps) ? existingProps : (existingProps?.items || [])).map(p => p.address_hash));
    } catch (e) { console.warn(`[FetchZip-v8] Dedup fetch failed:`, e.message); }

    // Map to schema
    const mapped = allProperties
      .filter(p => p.latitude && p.longitude && p.addressLine1)
      .filter(p => !existingHashes.has(p.id))
      .map(p => {
        const addressMatch = (p.addressLine1 || "").match(/^(\d+)\s+(.*)$/);
        const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
        const street_name = addressMatch ? addressMatch[2] : (p.addressLine1 || "Unknown");

        let original_status = 'ELIGIBLE';
        if (p._mlsSold) {
          original_status = 'SOLD';
        } else if (p.lastSaleDate) {
          const saleDate = new Date(p.lastSaleDate);
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - daysBack);
          if (saleDate > cutoff) original_status = 'SOLD';
        }

        let h3_index = null;
        try { h3_index = latLngToCell(p.latitude, p.longitude, 9); } catch (e) {}

        return {
          address_hash: p.id || `${p.addressLine1}-${zip}`,
          house_number, street_name,
          full_address: p.formattedAddress || p.addressLine1,
          city: p.city || '', state: p.state || '', zip_code: p.zipCode || zip,
          lat: p.latitude, lng: p.longitude, original_status, h3_index,
          beds: p.bedrooms || 0, baths: p.bathrooms || 0,
          sqft: p.squareFootage || 0, lot_size: p.lotSize || 0,
          year_built: p.yearBuilt || 0, price: p.lastSalePrice || 0,
          sold_date: p.lastSaleDate || null, sale_type: p._mlsSold ? 'MLS' : 'Market',
          property_type: p.propertyType || 'Single Family',
          mls_id: p.assessorID || null, url: null,
          // Algorithm II Propensity Tags
          owner_occupied: p.ownerOccupied ?? null,
          absentee_owner: p.ownerOccupied === false,
          is_vacant: p.isVacant || false,
          owner_mailing_address: p.owner?.mailingAddress || null,
          // Calculate Out-of-State Absentee status
          is_out_of_state_absentee: p.ownerOccupied === false && 
                                   p.owner?.mailingAddress?.state && 
                                   p.owner.mailingAddress.state !== (p.state || 'SC'),
          // Equity Logic Placeholder (Simplified until batch AVM integrated)
          equity_percent: (p.lastSalePrice && p.lastSaleDate) ? Math.min(1, ((Date.now() - new Date(p.lastSaleDate).getTime()) / (1000 * 60 * 60 * 24 * 365)) / 30) : 0
        };
      });

    console.log(`[FetchZip-v8] ${mapped.length} new properties to import (${mapped.filter(m => m.original_status === 'SOLD').length} sold)`);

    if (mapped.length === 0) {
      return Response.json({ status: 'exists', count: 0, message: `All properties already in database.`, api_calls: totalApiCalls });
    }

    // Bulk insert
    let successCount = 0;
    const CHUNK_SIZE = 500;
    for (let i = 0; i < mapped.length; i += CHUNK_SIZE) {
      const chunk = mapped.slice(i, i + CHUNK_SIZE);
      try {
        await base44.entities.MasterProperty.bulkCreate(chunk);
        successCount += chunk.length;
      } catch (e) {
        console.error(`[FetchZip-v8] Chunk failed:`, e.message);
        // Retry with smaller chunks
        for (let j = 0; j < chunk.length; j += 100) {
          const small = chunk.slice(j, j + 100);
          try { await base44.entities.MasterProperty.bulkCreate(small); successCount += small.length; } catch {}
        }
      }
      if (i + CHUNK_SIZE < mapped.length) await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[FetchZip-v8] Done! Imported ${successCount}/${mapped.length}, used ${totalApiCalls} API calls`);

    return Response.json({
      status: 'imported', zip_code: zip, count: successCount,
      total_found: allProperties.length,
      sold_count: mapped.filter(m => m.original_status === 'SOLD').length,
      mls_count: mapped.filter(m => m.sale_type === 'MLS').length,
      api_calls: totalApiCalls,
      message: `Imported ${successCount} properties for ${zip} (${totalApiCalls} API calls)`
    });

  } catch (error) {
    console.error('[FetchZip-v8] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});