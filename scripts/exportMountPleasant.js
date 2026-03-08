import fs from 'fs';

const RENTCAST_API_KEY = process.argv[2] || process.env.RENTCAST_API_KEY;

if (!RENTCAST_API_KEY) {
    console.error("❌ Error: You must provide a Rentcast API Key.");
    process.exit(1);
}

const RENTCAST_BASE = "https://api.rentcast.io/v1";

const LATITUDE = 32.866;
const LONGITUDE = -79.788;
const RADIUS_MILES = 3.56;
const PROPERTY_TYPES = 'Single Family|Townhouse|Condo|Multi-Family|Manufactured|Apartment|Land';
const LIMIT = 500;

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        const res = await fetch(url, options);
        if (res.status === 429) {
            await sleep((i + 1) * 2000);
            continue;
        }
        return res;
    }
    return fetch(url, options);
}

async function runExport() {
    const daysBack = 365;
    const date_slices = [];
    let start = 1;
    while (start <= daysBack) {
        let end = start + 29;
        if (end > daysBack) end = daysBack;
        date_slices.push(`${start}:${end}`);
        start = end + 1;
    }

    const allProperties = new Map(); // Use Map to dedupe by address
    const headers = { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY };

    for (let s = 0; s < date_slices.length; s++) {
        const sliceStr = date_slices[s];
        let offset = 0;
        let sliceReachedEnd = false;

        while (!sliceReachedEnd) {
            const params = new URLSearchParams({
                latitude: String(LATITUDE), longitude: String(LONGITUDE),
                radius: String(RADIUS_MILES), limit: String(LIMIT), offset: String(offset),
                propertyType: PROPERTY_TYPES,
                saleDateRange: sliceStr
            });

            const url = `${RENTCAST_BASE}/properties?${params}`;
            const res = await fetchWithRetry(url, { headers });
            
            if (!res.ok) {
                break;
            }

            const data = await res.json();
            const records = Array.isArray(data) ? data : [];

            records.forEach(p => {
                const address = `${p.addressLine1}, ${p.city}, ${p.state} ${p.zipCode}`;
                if (!allProperties.has(address)) {
                    allProperties.set(address, {
                        address,
                        lastSaleDate: p.lastSaleDate,
                        propertyType: p.propertyType,
                        lastSalePrice: p.lastSalePrice
                    });
                }
            });

            offset += LIMIT;

            if (records.length < LIMIT || offset >= 10000) {
                sliceReachedEnd = true;
            }

            await sleep(50);
        }
    }

    const properties = Array.from(allProperties.values());
    
    // Sort by sale date descending
    properties.sort((a, b) => new Date(b.lastSaleDate) - new Date(a.lastSaleDate));

    // Split into 3 months vs 12 months
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const last3Months = [];
    const older9Months = [];

    properties.forEach(p => {
        if (new Date(p.lastSaleDate) >= ninetyDaysAgo) {
            last3Months.push(p);
        } else {
            older9Months.push(p);
        }
    });

    let mdOutput = `# Mount Pleasant 40 Sq Mi Property Export
Target: 2001 Country Manor Dr, Mount Pleasant, SC 29466
Radius: 3.56 miles (~40 square miles)

## Summary
- **Total Properties (Last 12 Months):** ${properties.length}
- **Properties (Last 3 Months):** ${last3Months.length}
- **Properties (3-12 Months Ago):** ${older9Months.length}

## Properties Sold in the Last 3 Months (${last3Months.length})
| Sale Date | Address | Type | Price |
| :--- | :--- | :--- | :--- |
`;

    last3Months.forEach(p => {
        mdOutput += `| ${p.lastSaleDate ? p.lastSaleDate.split('T')[0] : 'N/A'} | ${p.address} | ${p.propertyType} | ${p.lastSalePrice ? '$' + p.lastSalePrice.toLocaleString() : 'N/A'} |\n`;
    });

    mdOutput += `\n## Properties Sold 3-12 Months Ago (${older9Months.length})
| Sale Date | Address | Type | Price |
| :--- | :--- | :--- | :--- |
`;

    older9Months.forEach(p => {
        mdOutput += `| ${p.lastSaleDate ? p.lastSaleDate.split('T')[0] : 'N/A'} | ${p.address} | ${p.propertyType} | ${p.lastSalePrice ? '$' + p.lastSalePrice.toLocaleString() : 'N/A'} |\n`;
    });

    const outputPath = '/Users/nick/.gemini/antigravity/brain/71fab442-a6bf-4d3a-8ab6-3c228fdc128c/mount_pleasant_properties.md';
    fs.writeFileSync(outputPath, mdOutput);
    console.log(`Success! Wrote ${properties.length} properties to ${outputPath}`);
}

runExport().catch(console.error);
