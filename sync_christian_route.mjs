/**
 * sync_christian_route.mjs
 * 
 * COMPREHENSIVE FIX: Sync the 85 verified addresses into Christian's route
 * 
 * Strategy:
 * 1. Fetch ALL MasterProperty records from Christian's zip codes
 * 2. Match each verified address to real DB records using flexible matching
 * 3. Report exact match status (matched, rejected, missing)
 * 4. For matched: extract real address_hash, ensure sale_confidence is NOT rejected
 * 5. Update the SavedRoute with the real address_hash values
 * 6. Report any addresses missing from the DB that need to be created
 */

import { createClient } from "@base44/sdk";
import fs from "fs";

const base44 = createClient("695eb764b077190880be21de", {
  url: "https://my-to-do-list-81bfaad7.base44.app"
});

// ── Address Normalization (matching processFetchChunk exactly) ──
const STREET_ABBREVIATIONS = {
    'STREET': 'ST', 'AVENUE': 'AVE', 'BOULEVARD': 'BLVD', 'DRIVE': 'DR',
    'LANE': 'LN', 'ROAD': 'RD', 'COURT': 'CT', 'CIRCLE': 'CIR',
    'PLACE': 'PL', 'TERRACE': 'TER', 'WAY': 'WAY', 'TRAIL': 'TRL',
    'PARKWAY': 'PKWY', 'HIGHWAY': 'HWY', 'NORTH': 'N', 'SOUTH': 'S',
    'EAST': 'E', 'WEST': 'W', 'NORTHEAST': 'NE', 'NORTHWEST': 'NW',
    'SOUTHEAST': 'SE', 'SOUTHWEST': 'SW', 'APARTMENT': 'APT', 'SUITE': 'STE',
    'UNIT': 'UNIT', 'BUILDING': 'BLDG', 'FLOOR': 'FL'
};

function normalizeAddress(address) {
    if (!address) return '';
    let norm = address.toUpperCase().trim();
    norm = norm.replace(/[.,#]/g, '').replace(/\s+/g, ' ');
    for (const [full, abbr] of Object.entries(STREET_ABBREVIATIONS)) {
        norm = norm.replace(new RegExp(`\\b${full}\\b`, 'g'), abbr);
    }
    return norm;
}

function generateNormalizedHash(addressLine, zipCode) {
    const normAddr = normalizeAddress(addressLine);
    const normZip = (zipCode || '00000').trim().slice(0, 5);
    return `${normAddr}|${normZip}`;
}

async function run() {
    const verified = JSON.parse(fs.readFileSync('./src/data/verified85.json'));
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  CHRISTIAN ROUTE SYNC — ${verified.length} Verified Addresses`);
    console.log(`${'═'.repeat(70)}\n`);

    // ── Step 1: Fetch all properties from Christian's zips ──
    const zips = ["29621", "29624", "29625", "29626", "29627"];
    let allProps = [];

    for (const zip of zips) {
        process.stdout.write(`  Fetching zip ${zip}...`);
        try {
            const res = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
            const items = Array.isArray(res) ? res : (res?.items || []);
            allProps.push(...items);
            console.log(` ${items.length} properties`);
        } catch(e) {
            console.log(` FAILED: ${e.message}`);
        }
    }

    console.log(`\n  Total properties in DB: ${allProps.length}\n`);

    // ── Step 2: Build index for matching ──
    // Index by normalized "house_number street_name" (lowercase)
    const propsByAddr = new Map();
    const propsByHash = new Map();
    allProps.forEach(p => {
        const addr = `${p.house_number || ''} ${p.street_name || ''}`.trim().toLowerCase();
        if (!propsByAddr.has(addr)) propsByAddr.set(addr, []);
        propsByAddr.get(addr).push(p);
        propsByHash.set(p.address_hash, p);
    });

    // ── Step 3: Match verified addresses ──
    const matched = [];       // Found in DB, address_hash extracted
    const rejected = [];      // Found but marked REJECTED
    const missing = [];       // NOT found in DB at all
    const fixedRejected = []; // Were rejected but we'll un-reject them

    console.log(`  MATCHING RESULTS:`);
    console.log(`  ${'─'.repeat(66)}`);

    for (const addr of verified) {
        const addrLower = addr.toLowerCase().trim();
        
        // Try exact match
        let found = propsByAddr.get(addrLower);
        
        // Try with suffix normalization (e.g. "rd" vs "road")
        if (!found || found.length === 0) {
            // Generate what the hash SHOULD be for each zip and check
            for (const zip of zips) {
                const expectedHash = generateNormalizedHash(addr, zip);
                const byHash = propsByHash.get(expectedHash);
                if (byHash) {
                    found = [byHash];
                    break;
                }
            }
        }
        
        // Fuzzy: try matching just house number + first word of street
        if (!found || found.length === 0) {
            const parts = addrLower.split(' ');
            if (parts.length >= 2) {
                const houseNum = parts[0];
                const streetStart = parts.slice(1).join(' ');
                for (const [key, props] of propsByAddr) {
                    if (key.startsWith(houseNum + ' ') && (
                        key.includes(streetStart) || streetStart.includes(key.split(' ').slice(1).join(' '))
                    )) {
                        found = props;
                        break;
                    }
                }
            }
        }

        if (found && found.length > 0) {
            // Take the most recent one
            const best = found.sort((a, b) => new Date(b.sold_date || 0) - new Date(a.sold_date || 0))[0];
            
            if (best.sale_confidence === 'REJECTED' || best.original_status === 'REJECTED') {
                console.log(`  ⚠  REJECTED: "${addr}" → hash: ${best.address_hash} | status: ${best.original_status} | conf: ${best.sale_confidence}`);
                rejected.push(best);
                fixedRejected.push(best);
                matched.push(best); // Still include — we'll un-reject it
            } else {
                console.log(`  ✓  MATCHED:  "${addr}" → hash: ${best.address_hash.substring(0, 40)}... | status: ${best.original_status} | lat: ${best.lat}`);
                matched.push(best);
            }
        } else {
            console.log(`  ✗  MISSING:  "${addr}" — NOT in MasterProperty DB`);
            missing.push(addr);
        }
    }

    console.log(`\n  ${'─'.repeat(66)}`);
    console.log(`  SUMMARY: ${matched.length} matched | ${rejected.length} were rejected | ${missing.length} missing`);
    
    // ── Step 4: Un-reject any rejected properties ──
    if (fixedRejected.length > 0) {
        console.log(`\n  UN-REJECTING ${fixedRejected.length} properties...`);
        for (const prop of fixedRejected) {
            try {
                await base44.entities.MasterProperty.update(prop.id, {
                    sale_confidence: 'medium',
                    original_status: 'HEURISTIC_SOLD'
                });
                console.log(`    ✓ Un-rejected: ${prop.house_number} ${prop.street_name} (was ${prop.sale_confidence})`);
            } catch (e) {
                console.log(`    ✗ Failed to un-reject ${prop.house_number} ${prop.street_name}: ${e.message}`);
            }
        }
    }

    // ── Step 5: Validate all matched properties have required fields ──
    console.log(`\n  FIELD VALIDATION:`);
    let fieldIssues = 0;
    for (const prop of matched) {
        const issues = [];
        if (!prop.lat || !prop.lng || Math.abs(prop.lat) < 0.01) issues.push('missing lat/lng');
        if (!prop.house_number) issues.push('missing house_number');
        if (!prop.street_name) issues.push('missing street_name');
        if (!prop.zip_code) issues.push('missing zip_code');
        if (!prop.address_hash) issues.push('missing address_hash');
        
        if (issues.length > 0) {
            console.log(`    ⚠ ${prop.house_number} ${prop.street_name}: ${issues.join(', ')}`);
            fieldIssues++;
        }
    }
    if (fieldIssues === 0) {
        console.log(`    ✓ All ${matched.length} properties have required fields (lat, lng, house_number, street_name, zip_code, address_hash)`);
    }

    // ── Step 6: Find & update Christian's route ──
    console.log(`\n  ROUTE UPDATE:`);
    console.log(`  ${'─'.repeat(66)}`);
    
    try {
        const routesRes = await base44.entities.SavedRoute.list('-created_date', 50);
        const routes = Array.isArray(routesRes) ? routesRes : (routesRes?.items || []);
        
        console.log(`  Found ${routes.length} total routes in system:`);
        routes.forEach(r => {
            console.log(`    - "${r.name}" | id: ${r.id} | status: ${r.status} | hashes: ${r.property_hashes?.length || 0} | assigned: ${r.assigned_to_name || 'unassigned'}`);
        });

        // Find Route 1 (Christian's route)
        const route1 = routes.find(r => r.name?.includes("Route 1")) || routes[0];
        
        if (!route1) {
            console.log(`\n  ✗ No route found! Cannot update.`);
            return;
        }

        console.log(`\n  Target route: "${route1.name}" (${route1.id})`);
        console.log(`  Current hashes: ${route1.property_hashes?.length || 0}`);

        if (matched.length === 0) {
            console.log(`  ✗ No matched properties — cannot update route.`);
            return;
        }

        // Deduplicate hashes
        const newHashes = [...new Set(matched.map(p => p.address_hash))];
        
        console.log(`  New hashes: ${newHashes.length} (deduplicated)`);
        console.log(`\n  First 5 hashes:`);
        newHashes.slice(0, 5).forEach(h => console.log(`    "${h}"`));

        // Actually update the route
        console.log(`\n  ⏳ Updating route...`);
        await base44.entities.SavedRoute.update(route1.id, {
            property_hashes: newHashes,
            metrics: {
                ...(route1.metrics || {}),
                house_count: newHashes.length
            },
            status: 'ACTIVE'
        });
        
        console.log(`  ✅ Route "${route1.name}" updated to ${newHashes.length} properties!`);

    } catch(e) {
        console.error(`  ✗ Route update failed: ${e.message}`);
    }

    // ── Step 7: Report missing addresses ──
    if (missing.length > 0) {
        console.log(`\n  ${'═'.repeat(70)}`);
        console.log(`  ⚠ ${missing.length} ADDRESSES NOT IN DATABASE:`);
        console.log(`  These need to be manually created or re-fetched via the pipeline.`);
        console.log(`  ${'─'.repeat(66)}`);
        missing.forEach(a => console.log(`    - "${a}"`));
        
        // Write missing to file for reference
        fs.writeFileSync('./missing_addresses.json', JSON.stringify(missing, null, 2));
        console.log(`\n  Written to ./missing_addresses.json`);
    }

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  DONE. Christian should refresh the app to see ${matched.length} houses.`);
    console.log(`${'═'.repeat(70)}\n`);
}

run().catch(e => {
    console.error("FATAL:", e);
    process.exit(1);
});
