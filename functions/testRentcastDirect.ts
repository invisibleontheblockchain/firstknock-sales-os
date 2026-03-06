Deno.serve(async (req) => {
    const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
    const lat = 34.50394;
    const lng = -82.64832;
    const radius = 8;

    // Test 1: saleDateRange as single value (just the max days)
    const params1 = new URLSearchParams({
        latitude: String(lat), longitude: String(lng),
        radius: String(radius), limit: '10', offset: '0',
        propertyType: 'Single Family|Townhouse|Condo|Multi-Family|Manufactured|Apartment|Land',
        saleDateRange: '90',
        includeTotalCount: 'true'
    });

    // Test 2: No saleDateRange filter at all
    const params2 = new URLSearchParams({
        latitude: String(lat), longitude: String(lng),
        radius: String(radius), limit: '10', offset: '0',
        propertyType: 'Single Family|Townhouse|Condo|Multi-Family|Manufactured|Apartment|Land',
        includeTotalCount: 'true'
    });

    // Test 3: saleDateRange with min:max format "1:90"
    const params3 = new URLSearchParams({
        latitude: String(lat), longitude: String(lng),
        radius: String(radius), limit: '10', offset: '0',
        propertyType: 'Single Family|Townhouse|Condo|Multi-Family|Manufactured|Apartment|Land',
        saleDateRange: '1:90',
        includeTotalCount: 'true'
    });

    // Test 4: Larger range - 365 days
    const params4 = new URLSearchParams({
        latitude: String(lat), longitude: String(lng),
        radius: String(radius), limit: '10', offset: '0',
        propertyType: 'Single Family|Townhouse|Condo|Multi-Family|Manufactured|Apartment|Land',
        saleDateRange: '365',
        includeTotalCount: 'true'
    });

    const BASE = "https://api.rentcast.io/v1";
    const headers = { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY };

    const results = {};

    for (const [name, params] of [['saleDateRange=90', params1], ['no_filter', params2], ['saleDateRange=1:90', params3], ['saleDateRange=365', params4]]) {
        const url = `${BASE}/properties?${params}`;
        console.log(`Testing: ${name} -> ${url}`);
        const res = await fetch(url, { headers });
        const total = res.headers.get('X-Total-Count');
        let data = [];
        if (res.ok) {
            data = await res.json();
        } else {
            const errText = await res.text();
            console.error(`${name} failed: ${res.status} ${errText}`);
        }
        results[name] = {
            status: res.status,
            totalCount: total,
            recordsReturned: Array.isArray(data) ? data.length : 0,
            sampleSaleDates: Array.isArray(data) ? data.slice(0, 3).map(d => ({ addr: d.addressLine1, lastSaleDate: d.lastSaleDate, lastSalePrice: d.lastSalePrice })) : []
        };
    }

    return Response.json(results);
});