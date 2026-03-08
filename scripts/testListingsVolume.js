import fs from 'fs';

const API_KEY = process.argv[2];
const LATITUDE = 32.866;
const LONGITUDE = -79.788;
const RADIUS_MILES = 3.56;

async function run() {
    const headers = { accept: 'application/json', 'X-Api-Key': API_KEY };
    
    let totalActive = 0;
    let totalInactive = 0;

    let offsetOuter = 0;
    while(true) {
        const p = new URLSearchParams({
            latitude: String(LATITUDE), longitude: String(LONGITUDE),
            radius: String(RADIUS_MILES), limit: '500', offset: String(offsetOuter),
            historyDays: '365'
        });
        const res = await fetch(`https://api.rentcast.io/v1/listings/sale?${p}`, { headers });
        const data = await res.json();
        if(!Array.isArray(data) || data.length === 0) break;
        data.forEach(d => {
            if(d.status === 'Active') totalActive++;
            if(d.status === 'Inactive') totalInactive++;
        });
        console.log(`Offset ${offsetOuter} -> Returned ${data.length} records (-Active: ${totalActive}, Inactive: ${totalInactive})`);
        offsetOuter += 500;
        if(data.length < 500) break;
    }
    console.log(`FINAL TOTAL in 365 days for 40 sq mi radius: Active=${totalActive}, Inactive=${totalInactive}`);
}
run().catch(console.error);
