import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { lat, lng, radius = 0.5, limit = 500 } = body;

    if (!lat || !lng) {
      return Response.json({ error: 'Latitude and Longitude are required' }, { status: 400 });
    }

    if (!RENTCAST_API_KEY) return Response.json({ error: 'RENTCAST_API_KEY not configured' }, { status: 500 });

    console.log(`[Fisherman] Radial search: lat=${lat}, lng=${lng}, radius=${radius} miles`);

    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      radius: String(radius),
      limit: String(limit),
      includeTotalCount: 'true'
    });

    const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
    const res = await fetch(url, { headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });

    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ error: `RentCast API error: ${errText}` }, { status: res.status });
    }

    const properties = await res.json();
    const totalCount = res.headers.get('X-Total-Count');

    // Filter out the anchor itself if needed, but let client handle it
    const mapped = properties.map(p => {
        const addressMatch = (p.addressLine1 || "").match(/^(\d+)\s+(.*)$/);
        const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
        const street_name = addressMatch ? addressMatch[2] : (p.addressLine1 || "Unknown");

        return {
          address_hash: p.id || `${p.addressLine1}-${p.zipCode}`,
          house_number, street_name,
          full_address: p.formattedAddress || p.addressLine1,
          city: p.city || '', state: p.state || '', zip_code: p.zipCode || '',
          lat: p.latitude, lng: p.longitude, 
          original_status: 'ELIGIBLE',
          beds: p.bedrooms || 0, baths: p.bathrooms || 0,
          sqft: p.squareFootage || 0, lot_size: p.lotSize || 0,
          year_built: p.yearBuilt || 0, price: p.lastSalePrice || 0,
          sold_date: p.lastSaleDate || null,
          property_type: p.propertyType || 'Single Family',
          // Algorithm II Propensity Tags (Optional for Fisherman, but helpful)
          owner_occupied: p.ownerOccupied ?? null,
          absentee_owner: p.ownerOccupied === false
        };
    });

    return Response.json({
      success: true,
      count: mapped.length,
      total_found: totalCount,
      properties: mapped
    });

  } catch (error) {
    console.error('[Fisherman] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
