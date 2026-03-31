import { createClient } from "@base44/sdk";
import fs from "fs";

const base44 = createClient("695eb764b077190880be21de", {
  url: "https://my-to-do-list-81bfaad7.base44.app"
});

async function run() {
    const verified = JSON.parse(fs.readFileSync('./src/data/verified85.json'));
    console.log(`\n=== DIAGNOSTIC: Route 85 Sync ===`);
    console.log(`Verified addresses in JSON: ${verified.length}`);
    
    // Step 1: Get all properties from Christian's zip codes
    const zips = ["29621", "29624", "29625", "29626", "29627"];
    let allProps = [];
    
    for (const zip of zips) {
        console.log(`\nFetching MasterProperty for zip ${zip}...`);
        try {
            const res = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
            const items = Array.isArray(res) ? res : (res?.items || []);
            console.log(`  -> ${items.length} properties`);
            allProps.push(...items);
        } catch(e) {
            console.error(`  -> FAILED: ${e.message}`);
        }
    }
    
    console.log(`\nTotal properties in DB across 5 zips: ${allProps.length}`);
    
    // Step 2: Match verified addresses to DB records
    const matched = [];
    const missing = [];
    
    for (const addr of verified) {
        const found = allProps.find(p => {
            const dbAddr = `${p.house_number || ''} ${p.street_name || ''}`.trim().toLowerCase();
            return dbAddr === addr;
        });
        if (found) {
            matched.push(found);
        } else {
            missing.push(addr);
        }
    }
    
    console.log(`\n=== MATCH RESULTS ===`);
    console.log(`Matched in DB: ${matched.length}/85`);
    console.log(`Missing from DB: ${missing.length}`);
    
    if (missing.length > 0) {
        console.log(`\nMISSING ADDRESSES (not in MasterProperty table):`);
        missing.forEach(a => console.log(`  - "${a}"`));
    }
    
    // Step 3: Show the actual hashes for matched properties  
    console.log(`\n=== MATCHED HASHES (first 10) ===`);
    matched.slice(0, 10).forEach(p => {
        console.log(`  hash: "${p.address_hash}" | addr: "${p.house_number} ${p.street_name}" | zip: ${p.zip_code} | status: ${p.original_status}`);
    });
    
    // Step 4: Get Christian's current route
    console.log(`\n=== ROUTES ===`);
    try {
        const routesRes = await base44.entities.SavedRoute.list('-created_date', 20);
        const routes = Array.isArray(routesRes) ? routesRes : (routesRes?.items || []);
        console.log(`Found ${routes.length} routes total`);
        
        routes.forEach(r => {
            console.log(`  Route: "${r.name}" | id: ${r.id} | status: ${r.status} | hashes: ${r.property_hashes?.length || 0}`);
        });
        
        // Find Route 1
        const route1 = routes.find(r => r.name?.includes("Route 1")) || routes[0];
        if (route1) {
            console.log(`\n=== ACTIVE ROUTE: "${route1.name}" (${route1.id}) ===`);
            console.log(`Current hashes: ${route1.property_hashes?.length || 0}`);
            
            // Show first 5 current hashes 
            if (route1.property_hashes?.length) {
                console.log(`\nFirst 5 current hashes on route:`);
                route1.property_hashes.slice(0, 5).forEach(h => console.log(`  "${h}"`));
            }
            
            // Step 5: If we have matched props, show what the UPDATE would be
            if (matched.length > 0) {
                const newHashes = matched.map(p => p.address_hash);
                console.log(`\n=== PROPOSED UPDATE ===`);
                console.log(`Would set property_hashes to ${newHashes.length} hashes`);
                console.log(`First 5 proposed hashes:`);
                newHashes.slice(0, 5).forEach(h => console.log(`  "${h}"`));
                
                // Actually do the update
                console.log(`\nAPPLYING UPDATE NOW...`);
                await base44.entities.SavedRoute.update(route1.id, {
                    property_hashes: newHashes,
                    metrics: {
                        ...(route1.metrics || {}),
                        house_count: newHashes.length
                    }
                });
                console.log(`✅ Route updated to ${newHashes.length} properties!`);
            }
        }
    } catch(e) {
        console.error(`Route fetch failed: ${e.message}`);
    }
}

run().catch(console.error);
