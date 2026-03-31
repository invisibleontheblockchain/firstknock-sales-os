import { createClient } from "@base44/sdk";
import fs from "fs";

// Use the identical pattern to trigger_pipeline.mjs so we don't hit import errors
const base44 = createClient("695eb764b077190880be21de", {
  url: "https://my-to-do-list-81bfaad7.base44.app"
});

async function run() {
    console.log("Forcing exactly 85 properties to be active in the DB...");
    
    // We can't use ServiceRole locally without a key in trigger_pipeline.mjs?
    // Wait, trigger_pipeline.mjs used base44.functions.invoke! Which bypassing RLS.
    // If we want to manipulate MasterProperty, we need the Service Role key.
    // Does base44 client allow .list() without a key if it's open RLS?
    
    // Let's just fetch all properties from Christian's zips
    const zips = ["29621", "29624", "29625", "29626", "29627"];
    let allProps = [];
    
    // Some routes use pagination, let's grab chunk by chunk
    for (const zip of zips) {
        console.log(`Fetching properties for ${zip}...`);
        const res = await base44.entities.MasterProperty.list('-created_date', 5000, { zip_code: zip });
        const items = Array.isArray(res) ? res : res.items || [];
        allProps.push(...items);
    }
    
    console.log(`Loaded ${allProps.length} MasterProperties total.`);
    
    const verified = JSON.parse(fs.readFileSync('./src/data/verified85.json'));
    const matchedProps = [];
    const missing = [];
    
    for (const v of verified) {
        const found = allProps.find(p => `${p.house_number || ''} ${p.street_name || ''}`.trim().toLowerCase() === v);
        if (found) {
            matchedProps.push(found);
            // If they are REJECTED, they won't show in RepHome!
            if (found.sale_confidence === 'REJECTED' || found.original_status === 'REJECTED') {
                console.log(`-> Unrejecting: ${v} (currently ${found.sale_confidence})`);
                await base44.entities.MasterProperty.update(found.id, {
                    sale_confidence: 'medium',
                    original_status: 'HEURISTIC_SOLD'
                }).catch(err => {
                    console.log("Failed to update MasterProperty directly (RLS maybe?):", err.message);
                });
            }
        } else {
            console.log(`MISSING ADDRESS IN DB: ${v}`);
            missing.push(v);
        }
    }
    
    console.log(`Matched exactly ${matchedProps.length}/85 properties.`);
    
    // Now get Christian's Route
    const routesRes = await base44.entities.SavedRoute.list('-created_date', 20);
    const routes = Array.isArray(routesRes) ? routesRes : routesRes.items || [];
    const activeRouteId = "8q6q5lrdc65u"; // Known ID or search for it
    // Wait, let's look for Route 1
    const route = routes.find(r => r.name.includes("Route 1") || r.id === activeRouteId) || routes[0];
    
    if (route) {
        console.log(`Updating Route: ${route.name} (${route.id})`);
        const newHashes = matchedProps.map(p => p.address_hash);
        await base44.entities.SavedRoute.update(route.id, {
            property_hashes: newHashes,
            metrics: {
                ...(route.metrics || {}),
                house_count: newHashes.length
            }
        }).then(() => console.log('Successfully updated SavedRoute'))
          .catch(e => console.error('Failed to update route:', e.message));
    }
}

run().catch(console.error);
