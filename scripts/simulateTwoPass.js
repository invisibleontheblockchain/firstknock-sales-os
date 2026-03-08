import fs from 'fs';

const RENTCAST_API_KEY = process.argv[2];

const LATITUDE = 32.866;
const LONGITUDE = -79.788;
const RADIUS_MILES = 3.56;
const PROPERTY_TYPES = 'Single Family|Townhouse|Condo|Multi-Family|Manufactured|Apartment|Land';
const LIMIT = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function runTwoPass() {
    const daysBack = 92; // Just simulate 3 months for speed
    let date_slices = [];
    let start = 1;
    while (start <= daysBack) {
        let end = start + 29;
        if (end > daysBack) end = daysBack;
        date_slices.push(`${start}:${end}`);
        start = end + 1;
    }

    const allAddresses = new Set();
    const headers = { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY };

    console.log("=== PASS 1: Properties API (Time-Slicing) ===");
    for (let s = 0; s < date_slices.length; s++) {
        const sliceStr = date_slices[s];
        let offset = 0;
        let reachedEnd = false;

        while (!reachedEnd) {
            const params = new URLSearchParams({
                latitude: String(LATITUDE), longitude: String(LONGITUDE),
                radius: String(RADIUS_MILES), limit: String(LIMIT), offset: String(offset),
                propertyType: PROPERTY_TYPES,
                saleDateRange: sliceStr
            });

            const url = `https://api.rentcast.io/v1/properties?${params}`;
            const res = await fetchWithRetry(url, { headers });
            if (!res.ok) break;

            const records = await res.json();
            const arr = Array.isArray(records) ? records : [];

            arr.forEach(p => {
                const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
                allAddresses.add(addressLine);
            });

            console.log(`Slice ${sliceStr} offset ${offset} -> ${arr.length} records`);
            offset += LIMIT;
            if (arr.length < LIMIT || offset >= 10000) reachedEnd = true;
            await sleep(50);
        }
    }
    const prePass1Count = allAddresses.size;
    console.log(`\nPass 1 Complete. Unique Addresses Found: ${prePass1Count}`);

    console.log("\n=== PASS 2: Listings API (Live 90 Days) ===");
    let offsetOuter = 0;
    let newFromPass2 = 0;
    while(true) {
        const p2 = new URLSearchParams({
            latitude: String(LATITUDE), longitude: String(LONGITUDE),
            radius: String(RADIUS_MILES), limit: String(LIMIT), offset: String(offsetOuter),
            historyDays: '90'
        });
        const res2 = await fetchWithRetry(`https://api.rentcast.io/v1/listings/sale?${p2}`, { headers });
        const data2 = await res2.json();
        if(!Array.isArray(data2) || data2.length === 0) break;

        data2.forEach(p => {
            const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
            if (!allAddresses.has(addressLine)) {
                allAddresses.add(addressLine);
                newFromPass2++;
            }
        });
        console.log(`Pass 2 offset ${offsetOuter} -> ${data2.length} records`);
        offsetOuter += LIMIT;
        if(data2.length < LIMIT) break;
    }

    console.log(`\nPass 2 Complete.`);
    console.log(`New Real-time listings found not in Pass 1: ${newFromPass2}`);
    console.log(`Total Combined Unique Listings: ${allAddresses.size}`);
}
runTwoPass().catch(console.error);
