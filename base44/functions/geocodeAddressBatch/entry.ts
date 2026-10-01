import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { CENSUS_MAX_BATCH, geocodeWithCensus } from '../../shared/censusGeocode.js';

// Resolves street addresses to coordinates for spreadsheet imports. The Census
// geocoder has no CORS headers, so the browser cannot call it directly.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const addresses = Array.isArray(body.addresses) ? body.addresses : [];
    if (addresses.length === 0) {
      return Response.json({ error: 'missing_addresses', message: 'Send at least one address to geocode.' }, { status: 400 });
    }
    if (addresses.length > CENSUS_MAX_BATCH) {
      return Response.json({ error: 'batch_too_large', message: `Send at most ${CENSUS_MAX_BATCH} addresses per call.` }, { status: 400 });
    }

    const items = addresses
      .map((row: Record<string, unknown>) => ({
        id: String(row?.id ?? '').trim(),
        address: String(row?.address ?? '').trim(),
        city: String(row?.city ?? '').trim(),
        state: String(row?.state ?? '').trim(),
        zip: String(row?.zip ?? '').trim(),
      }))
      .filter((row: { id: string; address: string }) => row.id && row.address);

    const results = await geocodeWithCensus(items);
    return Response.json({ success: true, requested: items.length, matched: Object.keys(results).length, results });
  } catch (error) {
    console.error('geocodeAddressBatch failed', error);
    return Response.json({ error: 'geocode_failed', message: (error as Error)?.message || 'Geocoding failed.' }, { status: 502 });
  }
});
