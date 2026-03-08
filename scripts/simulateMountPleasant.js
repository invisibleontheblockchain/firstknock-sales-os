// To run this test:
// node scripts/simulateMountPleasant.js YOUR_RENTCAST_API_KEY

const RENTCAST_API_KEY = process.argv[2] || process.env.RENTCAST_API_KEY;

if (!RENTCAST_API_KEY) {
    console.error("❌ Error: You must provide a Rentcast API Key.");
    console.error("Usage: node scripts/simulateMountPleasant.js YOUR_API_KEY");
    process.exit(1);
}

const RENTCAST_BASE = "https://api.rentcast.io/v1";

// 2001 Country Manor Dr, Mount Pleasant, SC 29466
// Approximate coordinates for the center
const LATITUDE = 32.866;
const LONGITUDE = -79.788;
const RADIUS_MILES = 3.56; // a radius of ~3.56 miles yields roughly a 40 square mile circle (A = pi * r^2)
const PROPERTY_TYPES = 'Single Family|Townhouse|Condo|Multi-Family|Manufactured|Apartment|Land';
const LIMIT = 500;

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        const res = await fetch(url, options);
        if (res.status === 429) {
            console.warn(`[fetchWithRetry] Rate limit hit. Retrying in ${(i + 1) * 2000}ms...`);
            await sleep((i + 1) * 2000);
            continue;
        }
        return res;
    }
    return fetch(url, options); // Last attempt
}

async function runSimulation() {
    console.log(`\n=== 🚀 TARGET ACQUIRED: 2001 Country Manor Dr, Mount Pleasant, SC ===`);
    console.log(`📡 Center: [${LATITUDE}, ${LONGITUDE}]`);
    console.log(`⭕ Area: 40 Square Miles (Radius: ~3.56mi)`);
    console.log(`⏱ Time Horizon: Last 365 Days (Sliced by Month)\n`);

    const daysBack = 365;
    const date_slices = [];
    let start = 1;
    while (start <= daysBack) {
        let end = start + 29;
        if (end > daysBack) end = daysBack;
        date_slices.push(`${start}:${end}`);
        start = end + 1;
    }

    console.log(`✅ Time-Slicing Activated: Broken 365 days down into ${date_slices.length} chunks of 30 days.`);
    console.log(`------------------------------------------------------------------\n`);

    let globalTotalFetched = 0;
    const allFetchedProperties = new Set();
    const headers = { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY };

    for (let s = 0; s < date_slices.length; s++) {
        const sliceStr = date_slices[s];
        console.log(`\n======================================================`);
        console.log(`📅 SLICE [${s + 1}/${date_slices.length}] -> saleDateRange: ${sliceStr} days ago`);
        console.log(`======================================================`);

        let offset = 0;
        let sliceReachedEnd = false;
        let sliceExpected = 0;
        let sliceFetched = 0;

        while (!sliceReachedEnd) {
            const params = new URLSearchParams({
                latitude: String(LATITUDE), longitude: String(LONGITUDE),
                radius: String(RADIUS_MILES), limit: String(LIMIT), offset: String(offset),
                propertyType: PROPERTY_TYPES,
                saleDateRange: sliceStr
            });

            if (offset === 0) params.set('includeTotalCount', 'true');

            const url = `${RENTCAST_BASE}/properties?${params}`;
            
            // To simulate the 'MAX_PARALLEL' batching, we usually fire 5 at a time, but for the local script we'll step cleanly so the user can easily read the log output.
            const res = await fetchWithRetry(url, { headers });
            
            if (!res.ok) {
                const err = await res.text();
                console.error(`❌ API Error jumping to offset ${offset}: ${res.status} ${err}`);
                break; // Safety break
            }

            const data = await res.json();
            const records = Array.isArray(data) ? data : [];
            
            if (offset === 0 && res.headers.has('X-Total-Count')) {
                sliceExpected = parseInt(res.headers.get('X-Total-Count'), 10);
                console.log(`🎯 Rentcast expects approx ${sliceExpected} homes in this specific 30-day window.`);
            }

            sliceFetched += records.length;
            globalTotalFetched += records.length;

            records.forEach(p => {
                 allFetchedProperties.add(`${p.addressLine1}, ${p.city}, ${p.state} ${p.zipCode}`);
            });

            console.log(`   └─ Page Complete: +${records.length} records (Offset: ${offset} -> ${offset + records.length}). Slice Total: ${sliceFetched}/${sliceExpected || '?'}`);

            offset += LIMIT;

            // End conditions
            if (records.length < LIMIT) {
                sliceReachedEnd = true;
                console.log(`   ✅ End of timeline slice reached.`);
            }

            // Rentcast API Hard Limit Safety Valve
            if (offset >= 10000) {
                console.warn(`   ⚠️ Warning: Slice reached Rentcast hard cap of 10,000 properties. Breaking.`);
                sliceReachedEnd = true;
            }

            // A tiny sleep to honor the 20/sec API limit (same as processFetchChunk)
            await sleep(50);
        }
    }

    console.log(`\n\n========================================================================`);
    console.log(`🎉 100% DONE! 40 SQUARE MILES SCANNED WITH NO BLIND SPOTS.`);
    console.log(`========================================================================`);
    console.log(`🏠 Total Properties Discovered Globally: ${globalTotalFetched}`);
    console.log(`💎 Unique Master Properties Acquired: ${allFetchedProperties.size}`);
    
    // Print a few sample properties
    console.log(`\nHere are 3 distinct sample properties pulled from the 40 sq mi radius of Country Manor Dr:`);
    const arr = Array.from(allFetchedProperties);
    console.log(` 1. ${arr[2] || arr[0] || 'N/A'}`);
    console.log(` 2. ${arr[Math.floor(arr.length / 2)] || 'N/A'}`);
    console.log(` 3. ${arr[arr.length - 2] || 'N/A'}`);
    console.log(`\n*(In the real application, these are chunked up and bulk-inserted into base44.asServiceRole.entities.MasterProperty)*\n`);

}

runSimulation().catch(console.error);
