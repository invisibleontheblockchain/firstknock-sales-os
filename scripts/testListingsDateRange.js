import fs from 'fs';

const API_KEY = process.argv[2];

const LATITUDE = 32.866;
const LONGITUDE = -79.788;
const RADIUS_MILES = 3.56;

async function run() {
    const headers = { accept: 'application/json', 'X-Api-Key': API_KEY };
    
    // test with saleDateRange
    const p = new URLSearchParams({
        latitude: String(LATITUDE), longitude: String(LONGITUDE),
        radius: String(RADIUS_MILES), limit: '10', 
        historyDays: '365',
        status: 'Inactive',
        saleDateRange: '1:30' // Undocumented but worth a try
    });
    const res = await fetch(`https://api.rentcast.io/v1/listings/sale?${p}`, { headers });
    const data = await res.json();
    console.log("With saleDateRange: 1:30", Array.isArray(data) ? data.length : data);

    // test with listedDateRange or removedDateRange
    const p2 = new URLSearchParams({
        latitude: String(LATITUDE), longitude: String(LONGITUDE),
        radius: String(RADIUS_MILES), limit: '10', 
        historyDays: '365',
        status: 'Inactive',
        removedDateRange: '1:30' // Undocumented but maybe?
    });
    const res2 = await fetch(`https://api.rentcast.io/v1/listings/sale?${p2}`, { headers });
    const data2 = await res2.json();
    console.log("With removedDateRange: 1:30", Array.isArray(data2) ? data2.length : data2);
}
run().catch(console.error);
