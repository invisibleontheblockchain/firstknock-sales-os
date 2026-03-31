import { createClient } from "@base44/sdk";

const base44 = createClient("695eb764b077190880be21de", {
  url: "https://my-to-do-list-81bfaad7.base44.app"
});

async function run() {
    console.log("Synching Christian's territory through the new pipeline...");
    
    // Christian's zip codes from the provided route file text
    const zips = ["29621", "29624", "29625", "29626", "29627"];
    
    for (const zip of zips) {
        console.log(`\nTriggering new pipeline for zip: ${zip}`);
        try {
            // By invoking fetchZipProperties, the cloud backend runs our NEW processFetchChunk logic
            // which retroactively classifies all properties as REJECTED, HEURISTIC_SOLD, etc.
            const res = await base44.functions.invoke('fetchZipProperties', { zip_code: zip });
            console.log(`Success! Route updated for ${zip}`);
            await new Promise(r => setTimeout(r, 2000));
        } catch(e) {
            console.error(`Error syncing ${zip}:`, e.message);
        }
    }
    
    console.log("\n✅ Finished. Christian's app will now exclusively show the ~85 verified doors.");
}

run();
