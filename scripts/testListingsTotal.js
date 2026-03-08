import fs from 'fs';

const API_KEY = process.argv[2];

const LATITUDE = 32.866;
const LONGITUDE = -79.788;
const RADIUS_MILES = 3.56;

async function run() {
    const headers = { accept: 'application/json', 'X-Api-Key': API_KEY };
    const p = new URLSearchParams({
        latitude: String(LATITUDE), longitude: String(LONGITUDE),
        radius: String(RADIUS_MILES), limit: '10', 
        historyDays: '365', // Look back a whole year
        status: 'Inactive' // Removed from market (usually means sold or pulled)
    });
    const res = await fetch(`https://api.rentcast.io/v1/listings/sale?${p}`, { headers });
    const total = res.headers.get('X-Total-Count');
    console.log("Total Inactive Listings in 365 days:", total);
    const data = await res.json();
    if(Array.isArray(data) && data.length > 0) {
        console.log("Sample listing payload:", JSON.stringify(data[0], null, 2));
    }
}
run().catch(console.error);
