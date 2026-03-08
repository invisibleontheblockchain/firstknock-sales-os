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

async function runPass2Export() {
    const headers = { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY };
    const allPass2Listings = [];

    console.log("=== EXPORTING PASS 2: Listings API (Live 90 Days) ===");
    let offsetOuter = 0;
    while(true) {
        const p2 = new URLSearchParams({
            latitude: String(LATITUDE), longitude: String(LONGITUDE),
            radius: String(RADIUS_MILES), limit: String(LIMIT), offset: String(offsetOuter),
            historyDays: '90',
            status: 'Inactive' // Specifically targeting Inactive (Off-market / Sold/ Pending)
        });
        const url = `${RENTCAST_BASE}/listings/sale?${p2}`;
        const res2 = await fetchWithRetry(url, { headers });
        if(!res2.ok) break;

        const data2 = await res2.json();
        if(!Array.isArray(data2) || data2.length === 0) break;

        allPass2Listings.push(...data2);

        offsetOuter += LIMIT;
        if(data2.length < LIMIT) break;
        await sleep(50);
    }

    // Dedupe by address
    const uniqueListingsMap = new Map();
    allPass2Listings.forEach(p => {
        const address = `${p.addressLine1}, ${p.city}, ${p.state} ${p.zipCode}`;
        if (!uniqueListingsMap.has(address)) {
             uniqueListingsMap.set(address, {
                 address: address,
                 listedDate: p.listedDate ? p.listedDate.split('T')[0] : 'Unknown',
                 removedDate: p.removedDate ? p.removedDate.split('T')[0] : 'Unknown',
                 price: p.price,
                 status: p.status,
                 daysOnMarket: p.daysOnMarket
             });
        }
    });

    const uniqueListings = Array.from(uniqueListingsMap.values());
    
    // Sort by most recently removed
    uniqueListings.sort((a, b) => new Date(b.removedDate) - new Date(a.removedDate));

    let mdOutput = `# Mount Pleasant "Pass 2" MLS Listings (Recent 90 Days)
Target: 2001 Country Manor Dr, Mount Pleasant, SC 29466
Radius: 3.56 miles (~40 square miles)

These are properties dynamically grabbed from the MLS that went "Inactive" (Pending or Sold) in the last 90 days. These properties bypass the county records 30-90 day delay.

## Summary
- **Total Inactive MLS Listings Found:** ${uniqueListings.length}

## Pass 2 Off-Market Properties (Sorting by removal date, newest first)
| Removed Date | Address | Price | Days on Market |
| :--- | :--- | :--- | :--- |
`;

    uniqueListings.forEach(p => {
        mdOutput += `| ${p.removedDate} | ${p.address} | ${p.price ? '$' + p.price.toLocaleString() : 'N/A'} | ${p.daysOnMarket || 'N/A'} |\n`;
    });

    const outputPath = '/Users/nick/.gemini/antigravity/brain/71fab442-a6bf-4d3a-8ab6-3c228fdc128c/pass2_mls_listings.md';
    fs.writeFileSync(outputPath, mdOutput);
    console.log(`Success! Wrote ${uniqueListings.length} Pass-2 properties to ${outputPath}`);
}

runPass2Export().catch(console.error);
