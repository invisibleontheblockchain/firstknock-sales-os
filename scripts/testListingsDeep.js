import fs from 'fs';

const RENTCAST_API_KEY = process.argv[2];

const LATITUDE = 32.866;
const LONGITUDE = -79.788;
const RADIUS_MILES = 3.56;

async function run() {
    const headers = { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY };

    // Test 1: Listings with status=Active
    console.log("=== TEST 1: Listings status=Active ===");
    const p1 = new URLSearchParams({
        latitude: String(LATITUDE), longitude: String(LONGITUDE),
        radius: String(RADIUS_MILES), limit: '5', status: 'Active'
    });
    const r1 = await fetch(`https://api.rentcast.io/v1/listings/sale?${p1}`, { headers });
    const d1 = await r1.json();
    console.log(`Count: ${Array.isArray(d1) ? d1.length : 'error'}`);
    if (Array.isArray(d1) && d1.length > 0) {
        console.log("Sample:", JSON.stringify(d1[0], null, 2));
    }

    // Test 2: Listings with status=Inactive
    console.log("\n=== TEST 2: Listings status=Inactive ===");
    const p2 = new URLSearchParams({
        latitude: String(LATITUDE), longitude: String(LONGITUDE),
        radius: String(RADIUS_MILES), limit: '5', status: 'Inactive'
    });
    const r2 = await fetch(`https://api.rentcast.io/v1/listings/sale?${p2}`, { headers });
    const d2 = await r2.json();
    console.log(`Count: ${Array.isArray(d2) ? d2.length : 'error'}`);
    if (Array.isArray(d2) && d2.length > 0) {
        // Show all fields of first 3
        d2.slice(0, 3).forEach((item, i) => {
            console.log(`\n--- Inactive Item ${i+1} ---`);
            console.log(`Address: ${item.formattedAddress}`);
            console.log(`Status: ${item.status}`);
            console.log(`Price: ${item.price}`);
            console.log(`Listed: ${item.listedDate}`);
            console.log(`Removed: ${item.removedDate}`);
            console.log(`Days on Market: ${item.daysOnMarket}`);
            console.log(`Listing Type: ${item.listingType}`);
            // Check for any sale-related fields
            console.log(`All top-level keys: ${Object.keys(item).join(', ')}`);
            if (item.history) {
                console.log(`History events: ${JSON.stringify(item.history, null, 2)}`);
            }
        });
    }

    // Test 3: Properties API with very recent saleDateRange to compare
    console.log("\n=== TEST 3: Properties with saleDateRange=1:30 (last 30 days deed transfers) ===");
    const p3 = new URLSearchParams({
        latitude: String(LATITUDE), longitude: String(LONGITUDE),
        radius: String(RADIUS_MILES), limit: '5', saleDateRange: '1:30'
    });
    const r3 = await fetch(`https://api.rentcast.io/v1/properties?${p3}`, { headers });
    const d3 = await r3.json();
    console.log(`Count: ${Array.isArray(d3) ? d3.length : 'error'}`);
    if (Array.isArray(d3) && d3.length > 0) {
        d3.forEach((item, i) => {
            console.log(`\n--- Recently Sold Property ${i+1} ---`);
            console.log(`Address: ${item.formattedAddress}`);
            console.log(`Last Sale Date: ${item.lastSaleDate}`);
            console.log(`Last Sale Price: ${item.lastSalePrice}`);
        });
    }
}
run().catch(console.error);
