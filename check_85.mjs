import fs from 'fs';

async function check() {
    // Read the exact 85 addresses
    const verified = JSON.parse(fs.readFileSync('./src/data/verified85.json'));
    
    // Send a REST request directly to base44 locally without SDK
    const res = await fetch('https://my-to-do-list-81bfaad7.base44.app/v1/data/MasterProperty?limit=1000', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer srole`
        },
        body: JSON.stringify({
            query: { zip_code: { $in: ['29621', '29624', '29625', '29626', '29627'] } }
        })
    });
    
    const data = await res.json();
    const props = Array.isArray(data) ? data : data.items || [];
    
    console.log(`Fetched ${props.length} total properties in those zip codes.`);
    
    let matchedInDb = [];
    let rejectedInDb = [];
    let notFound = [];
    
    verified.forEach(address => {
        const found = props.find(p => `${p.house_number || ''} ${p.street_name || ''}`.trim().toLowerCase() === address);
        if (found) {
            matchedInDb.push(found);
            if (found.sale_confidence === 'REJECTED' || found.original_status === 'REJECTED') {
                rejectedInDb.push(found);
            }
        } else {
            notFound.push(address);
        }
    });
    
    console.log(`Matched ${matchedInDb.length}/85 in the DB.`);
    console.log(`WARNING: ${rejectedInDb.length} of the 85 verified addresses are currently marked as REJECTED in the DB!`);
    console.log(`Missing completely from DB: ${notFound.length}`);
    if (notFound.length > 0) {
        console.log("Not found:", notFound.slice(0, 5));
    }
}

check().catch(console.error);
