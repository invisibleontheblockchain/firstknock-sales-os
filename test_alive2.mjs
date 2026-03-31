import fs from 'fs';

async function check() {
    const { createClient } = await import('@base44/sdk');
    const base44 = createClient('https://my-to-do-list-81bfaad7.base44.app', { serviceRoleKey: process.env.BASE44_SERVICE_KEY || 'srole' });
    
    const verified = JSON.parse(fs.readFileSync('./src/data/verified85.json'));
    
    // get ALL properties from Christian's zips
    const zips = ['29621', '29624', '29625', '29627'];
    const res = await base44.asServiceRole.entities.MasterProperty.list('-created_date', 1000, {
        zip_code: { $in: zips }
    });
    
    let matchCount = 0;
    
    for (const p of res) {
        if (!p.house_number || !p.street_name) continue;
        const address = `${p.house_number} ${p.street_name}`.trim().toLowerCase();
        if (verified.includes(address)) {
            matchCount++;
            if (p.sale_confidence === 'REJECTED' || p.original_status === 'REJECTED') {
                 console.log(`ERROR: Verified Property ${address} is REJECTED!`);
            }
        } else {
             if (p.sale_confidence !== 'REJECTED') {
                 console.log(`Unverified property still alive: ${address}`);
             }
        }
    }
    
    console.log(`Matched exactly ${matchCount} from verification array.`);
    
    // count alive
    const aliveCount = res.filter(p => p.sale_confidence !== 'REJECTED' && p.original_status !== 'REJECTED').length;
    console.log(`Total Alive in DB for his zips: ${aliveCount}`);
}

check().catch(console.error);
