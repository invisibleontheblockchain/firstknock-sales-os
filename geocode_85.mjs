/**
 * geocode_85.mjs
 * 
 * Geocodes all 85 verified addresses using free Nominatim (OpenStreetMap) API
 * and outputs a complete JSON file ready to be seeded into MasterProperty.
 * 
 * Rate limit: 1 request per second (Nominatim policy)
 */

import fs from 'fs';

const verified = JSON.parse(fs.readFileSync('./src/data/verified85.json'));

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Zip code to city/state mapping for known Anderson SC zip codes
const ZIP_INFO = {
    '29621': { city: 'Anderson', state: 'SC' },
    '29624': { city: 'Anderson', state: 'SC' },
    '29625': { city: 'Anderson', state: 'SC' },
    '29626': { city: 'Anderson', state: 'SC' },
    '29627': { city: 'Belton', state: 'SC' },
};

// Parse the original route file to get zip codes for each address
function parseOriginalRoute() {
    const routeText = fs.readFileSync('./documentation/validationlayer/routetoverify/christianroute.txt', 'utf8');
    const lines = routeText.split('\n');
    const addressMap = {};
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Match "Anderson, SC XXXXX" pattern
        const cityMatch = line.match(/^([\w\s]+),\s*(\w{2})\s+(\d{5})$/);
        if (cityMatch) {
            // The address is 2 lines above (index-2 in our array, accounting for the age line)
            // Pattern: number, address, blank, age, city line
            // Go backwards to find the address
            for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
                const prevLine = lines[j].trim();
                // Skip empty lines and age lines (like "2m", "12d")
                if (!prevLine || /^\d+[mdy]$/.test(prevLine) || /^\d+$/.test(prevLine)) continue;
                // This should be the address
                const addrLower = prevLine.toLowerCase();
                addressMap[addrLower] = {
                    address: prevLine,
                    city: cityMatch[1].trim(),
                    state: cityMatch[2],
                    zip: cityMatch[3]
                };
                break;
            }
        }
    }
    return addressMap;
}

async function geocodeAddress(address, city, state, zip) {
    const query = `${address}, ${city}, ${state} ${zip}`;
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=us`;
    
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'FirstKnock-SalesOS-GeocodeScript/1.0' }
        });
        const data = await res.json();
        if (data && data.length > 0) {
            return {
                lat: parseFloat(data[0].lat),
                lng: parseFloat(data[0].lon),
                display_name: data[0].display_name
            };
        }
    } catch (e) {
        console.error(`  Geocode error for "${query}": ${e.message}`);
    }
    return null;
}

async function run() {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  GEOCODING ${verified.length} VERIFIED ADDRESSES`);
    console.log(`${'═'.repeat(70)}\n`);

    const routeMap = parseOriginalRoute();
    console.log(`  Parsed ${Object.keys(routeMap).length} addresses from route file\n`);

    const results = [];
    let geocoded = 0;
    let failed = 0;

    for (let i = 0; i < verified.length; i++) {
        const addr = verified[i];
        const info = routeMap[addr] || routeMap[addr.toLowerCase()];
        
        // Default to 29621 if we can't find the zip
        const city = info?.city || 'Anderson';
        const state = info?.state || 'SC';
        const zip = info?.zip || '29621';

        process.stdout.write(`  [${i + 1}/${verified.length}] "${addr}" (${zip})... `);

        const geo = await geocodeAddress(addr, city, state, zip);
        
        if (geo) {
            const addressLine = addr.charAt(0).toUpperCase() + addr.slice(1);
            const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
            const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
            const street_name = addressMatch ? addressMatch[2] : addressLine;
            
            const hash = generateNormalizedHash(addressLine, zip);
            
            results.push({
                address_hash: hash,
                house_number,
                street_name: street_name.replace(/\b\w/g, c => c.toUpperCase()), // Title case
                city,
                state,
                zip_code: zip,
                lat: geo.lat,
                lng: geo.lng,
                original_status: 'HEURISTIC_SOLD',
                sale_confidence: 'verified',
                data_source: 'batchdata_verified',
                property_type: 'Single Family',
                sale_type: 'Deed',
                sold_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // ~30 days ago
                price: 0,
                beds: 0,
                baths: 0,
                sqft: 0,
                lot_size: 0,
                year_built: 0
            });
            
            console.log(`✓ (${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)})`);
            geocoded++;
        } else {
            console.log(`✗ FAILED`);
            failed++;
            
            // Still add with approximate coordinates (Anderson SC center + jitter)
            const addressLine = addr.charAt(0).toUpperCase() + addr.slice(1);
            const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
            const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
            const street_name = addressMatch ? addressMatch[2] : addressLine;
            const hash = generateNormalizedHash(addressLine, zip);
            
            results.push({
                address_hash: hash,
                house_number,
                street_name: street_name.replace(/\b\w/g, c => c.toUpperCase()),
                city,
                state,
                zip_code: zip,
                lat: 34.5034 + (Math.random() - 0.5) * 0.04,
                lng: -82.6501 + (Math.random() - 0.5) * 0.04,
                original_status: 'HEURISTIC_SOLD',
                sale_confidence: 'verified',
                data_source: 'batchdata_verified',
                property_type: 'Single Family',
                sale_type: 'Deed',
                sold_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
                price: 0,
                beds: 0,
                baths: 0,
                sqft: 0,
                lot_size: 0,
                year_built: 0,
                _geocode_failed: true
            });
        }

        // Respect Nominatim rate limit: 1 req/sec
        await sleep(1100);
    }

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`  Geocoded: ${geocoded}/${verified.length} | Failed: ${failed}`);
    console.log(`${'─'.repeat(70)}\n`);

    // Write the complete seed data
    fs.writeFileSync('./src/data/verified85_seed.json', JSON.stringify(results, null, 2));
    console.log(`  ✅ Written to ./src/data/verified85_seed.json`);
    console.log(`     ${results.length} properties ready to seed\n`);
}

run().catch(console.error);
