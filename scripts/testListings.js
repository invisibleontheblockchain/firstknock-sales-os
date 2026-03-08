import fs from 'fs';

const API_KEY = process.argv[2];
const ZIP = '29466';

async function run() {
    const headers = { accept: 'application/json', 'X-Api-Key': API_KEY };
    
    console.log("\n--- TEST 1: Properties API (lastSaleDate public records) for 29466 ---");
    const p1 = new URLSearchParams({
        zipCode: ZIP, limit: '500', saleDateRange: '1:30'
    });
    const res1 = await fetch(`https://api.rentcast.io/v1/properties?${p1}`, { headers });
    const data1 = await res1.json();
    console.log(`Found: ${Array.isArray(data1) ? data1.length : JSON.stringify(data1)}`);
    
    console.log("\n--- TEST 2: Listings API (MLS active/pending/sold) for 29466 ---");
    const p2 = new URLSearchParams({
        zipCode: ZIP, limit: '500', 
        historyDays: '30',
        status: 'Sold'
    });
    try {
        const res2 = await fetch(`https://api.rentcast.io/v1/listings/sale?${p2}`, { headers });
        const text2 = await res2.text();
        try {
            const data2 = JSON.parse(text2);
            console.log(`Found with status='Sold': ${Array.isArray(data2) ? data2.length : JSON.stringify(data2)}`);
            if (Array.isArray(data2) && data2.length > 0) {
                console.log("Sample Listing:", data2[0].addressLine1, data2[0].status, data2[0].listedDate, data2[0].removedDate);
            }
        } catch(e) {
            console.log("Invalid JSON:", text2.substring(0, 100));
        }
    } catch(e) {
        console.error("Fetch 2 failed:", e);
    }
}
run().catch(console.error);
