import fetch from "node-fetch";

// RentCast API Key from your .env
const RENTCAST_API_KEY = "c18f27cfdbb94b0eb1988ef4a4bf85ea";

async function run() {
    const lat = 33.800701;
    const lng = -84.361949;
    const radius = 5; // Cindy's recommended 5 miles
    const soldMonths = 6;
    const DEED_LAG_DAYS = 90;
    const saleDateRange = (soldMonths * 30) + DEED_LAG_DAYS;

    const url = `https://api.rentcast.io/v1/properties?latitude=${lat}&longitude=${lng}&radius=${radius}&saleDateRange=${saleDateRange}&limit=500`;

    try {
        console.log("Fetching:", url);
        const res = await fetch(url, { headers: { "X-Api-Key": RENTCAST_API_KEY } });
        const data = await res.json();
        console.log(`Found ${data.length} properties for a 6 month range (${saleDateRange} days) in a 5 mile radius`);
        if (data.length > 0) {
           console.log("Sample sold date:", data[0].lastSaleDate);
        }
    } catch (e) {
        console.error(e);
    }
}
run();
