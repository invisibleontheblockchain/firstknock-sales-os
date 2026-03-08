import fs from 'fs';

const API_KEY = process.argv[2];
const ZIP = '29466';

async function run() {
    const headers = { accept: 'application/json', 'X-Api-Key': API_KEY };
    
    // Look for a known recently sold home if possible, or just print inactive
    const p2 = new URLSearchParams({
        zipCode: ZIP, limit: '5', 
        historyDays: '60',
        status: 'Inactive'
    });
    const res2 = await fetch(`https://api.rentcast.io/v1/listings/sale?${p2}`, { headers });
    const data2 = await res2.json();
    console.log("Sample Inactive Listings:");
    data2.forEach(d => {
        console.log(`- ${d.addressLine1}: listed ${d.listedDate}, removed ${d.removedDate}, price ${d.price}`);
    });
}
run().catch(console.error);
