import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const BATCHDATA_BASE_URL = 'https://api.batchdata.com/api/v1/property/search';

function firstValue(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function normalizeAddressParts(record) {
    const address = record.address || record.propertyAddress || record.situsAddress || {};
    const street = firstValue(address.street, address.streetAddress, address.addressLine1, record.addressLine1, record.formattedAddress?.split?.(',')?.[0]);
    return {
        street: street || '',
        city: firstValue(address.city, record.city) || '',
        state: firstValue(address.state, record.state) || '',
        zip: String(firstValue(address.zip, address.zipCode, record.zipCode, '') || '').slice(0, 5),
        lat: Number(firstValue(address.latitude, address.lat, record.latitude)),
        lng: Number(firstValue(address.longitude, address.lng, record.longitude))
    };
}

function mapBatchDataRecord(record) {
    const property = record.property || record;
    const address = normalizeAddressParts(property);
    const owner = property.owner || {};
    const listing = property.listing || {};
    const building = property.building || property.structure || {};
    const sale = property.sale || property.lastSale || {};
    const lastSale = sale.lastSale || sale.lastTransfer || sale;
    const ids = property.ids || property.identifiers || {};
    const ownerName = firstValue(owner.fullName, owner.name, owner.names?.[0]?.full, owner.names?.[0]);
    const listingStatus = firstValue(listing.status, listing.statusCategory);
    const saleDate = firstValue(lastSale.recordingDate, lastSale.saleDate, lastSale.date, property.lastSaleDate);
    const price = Number(firstValue(lastSale.price, lastSale.salePrice, property.lastSalePrice, listing.price));

    return {
        address_hash_seed: `${address.street}|${address.zip}`.toUpperCase(),
        full_address: [address.street, address.city, address.state, address.zip].filter(Boolean).join(', '),
        city: address.city,
        state: address.state,
        zip_code: address.zip,
        lat: Number.isFinite(address.lat) ? address.lat : null,
        lng: Number.isFinite(address.lng) ? address.lng : null,
        fips_code: firstValue(address.countyFipsCode, ids.fipsCode, ids.countyFipsCode),
        batchdata_property_id: firstValue(ids.id, ids.propertyId, property.id, property.propertyId),
        owner_full_name: ownerName || null,
        owner_occupied: owner.ownerOccupied ?? null,
        corporate_owned: property.quickLists?.corporateOwned ?? null,
        investor_owned: property.quickLists?.investorOwned ?? null,
        listing_status: listingStatus || null,
        beds: Number(firstValue(building.bedrooms, property.bedrooms)),
        baths: Number(firstValue(building.bathrooms, property.bathrooms)),
        sqft: Number(firstValue(building.livingArea, building.squareFeet, property.squareFootage)),
        lot_size: Number(firstValue(property.lot?.size, property.lotSize)),
        year_built: Number(firstValue(building.yearBuilt, property.yearBuilt)),
        price: Number.isFinite(price) ? price : null,
        sold_date: saleDate || null,
        property_type: firstValue(property.propertyType, property.landUse, building.propertyType) || null,
        data_source: 'batchdata',
        raw_keys: Object.keys(property).sort()
    };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const body = await req.json().catch(() => ({}));
        const useSandbox = body.sandbox !== false;
        const apiKey = useSandbox
            ? (Deno.env.get('BATCH_DATA_SANDBOX_KEY') || Deno.env.get('BATCH_DATA_API_KEY'))
            : Deno.env.get('BATCH_DATA_API_KEY');

        if (!apiKey) {
            return Response.json({ error: useSandbox ? 'BATCH_DATA_SANDBOX_KEY is not configured' : 'BATCH_DATA_API_KEY is not configured' }, { status: 500 });
        }

        const query = String(body.query || '1295 Chrismill Ln, Mount Pleasant, SC 29466').trim();
        const response = await fetch(BATCHDATA_BASE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                searchCriteria: { query },
                options: { datasets: ['basic', 'listing', 'deed', 'owner'] }
            })
        });

        const responseText = await response.text();
        let payload = null;
        try { payload = responseText ? JSON.parse(responseText) : null; } catch { payload = { raw_text: responseText.slice(0, 1000) }; }

        if (!response.ok) {
            return Response.json({
                success: false,
                sandbox: useSandbox,
                status: response.status,
                query,
                error: payload,
                note: 'Sandbox probe failed; no app data was changed.'
            }, { status: 200 });
        }

        const records = payload?.results?.properties || payload?.properties || payload?.results || [];
        const list = Array.isArray(records) ? records : [records].filter(Boolean);
        const mapped = list.slice(0, 5).map(mapBatchDataRecord);

        return Response.json({
            success: true,
            sandbox: useSandbox,
            query,
            record_count: list.length,
            mapped_preview: mapped,
            top_level_keys: payload && typeof payload === 'object' ? Object.keys(payload).sort() : [],
            note: 'Shape probe only. No FetchJob, route, or property data was changed.'
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});