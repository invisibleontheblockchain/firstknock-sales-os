import fs from 'fs';

const RENTCAST_API_KEY = process.argv[2];

async function run() {
    const headers = { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY };
    const address = "1451 Crane Creek Dr";
    const zip = "29466";

    const p2 = new URLSearchParams({
        address: address,
        city: "Mount Pleasant",
        state: "SC"
    });

    console.log("=== Checking Properties API ===");
    const res1 = await fetch(`https://api.rentcast.io/v1/properties?${p2}`, { headers });
    console.log(JSON.stringify(await res1.json(), null, 2));

    console.log("=== Checking Listings API ===");
    const res2 = await fetch(`https://api.rentcast.io/v1/listings/sale?${p2}`, { headers });
    console.log(JSON.stringify(await res2.json(), null, 2));

}
run().catch(console.error);
