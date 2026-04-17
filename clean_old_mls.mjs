// v15 Database Cleanup Script
// Demotes ALL old MLS (RentCast) records that aren't deed-confirmed to REJECTED.
// This clears the database of the 450-day MLS garbage so fresh v15 pulls work correctly.
//
// Run: node clean_old_mls.mjs

import { createClient } from "@base44/sdk";

const base44 = createClient("695eb764b077190880be21de", {
  url: "https://my-to-do-list-81bfaad7.base44.app"
});

async function run() {
    console.log("=== v15 MLS Database Cleanup ===\n");
    
    // Fetch ALL RentCast-sourced properties across Anderson County zips
    const zips = ["29621", "29624", "29625", "29626", "29627", "29670", "29673", "29669", "29697"];
    let allMls = [];
    
    for (const zip of zips) {
        try {
            const res = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
            const items = Array.isArray(res) ? res : (res?.items || []);
            
            // Only MLS-sourced records (data_source = 'rentcast')
            const mlsItems = items.filter(p => 
                p.data_source === 'rentcast' && 
                p.original_status !== 'DEED_CONFIRMED' &&
                p.original_status !== 'BATCHDATA_CONFIRMED' &&
                p.sale_confidence !== 'verified' &&
                p.sale_confidence !== 'high'
            );
            
            allMls.push(...mlsItems);
            console.log(`Zip ${zip}: ${items.length} total, ${mlsItems.length} unverified MLS`);
        } catch(e) {
            console.error(`Zip ${zip} failed: ${e.message}`);
        }
    }
    
    console.log(`\nTotal unverified MLS records to clean: ${allMls.length}`);
    
    // Show breakdown by original_status
    const statusCounts = {};
    for (const p of allMls) {
        const key = `${p.original_status} / ${p.sale_confidence}`;
        statusCounts[key] = (statusCounts[key] || 0) + 1;
    }
    console.log("\nBreakdown by status:");
    for (const [key, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${key}: ${count}`);
    }
    
    // Check how many are older than 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const oldMls = allMls.filter(p => {
        if (!p.sold_date) return true;
        const d = new Date(p.sold_date);
        return isNaN(d.getTime()) || d < thirtyDaysAgo;
    });
    
    const recentMls = allMls.filter(p => {
        if (!p.sold_date) return false;
        const d = new Date(p.sold_date);
        return !isNaN(d.getTime()) && d >= thirtyDaysAgo;
    });
    
    console.log(`\n> Older than 30 days (will be REJECTED): ${oldMls.length}`);
    console.log(`> Within last 30 days (will keep as low-confidence): ${recentMls.length}`);
    
    // STEP 1: Reject all old MLS records (older than 30 days)
    console.log(`\nStep 1: Rejecting ${oldMls.length} old MLS records...`);
    let rejected = 0, errors = 0;
    
    for (let i = 0; i < oldMls.length; i++) {
        try {
            await base44.entities.MasterProperty.update(oldMls[i].id, {
                original_status: 'REJECTED',
                sale_confidence: 'REJECTED'
            });
            rejected++;
            if (rejected % 50 === 0) {
                console.log(`  ... rejected ${rejected}/${oldMls.length}`);
            }
        } catch(e) {
            errors++;
        }
    }
    
    // STEP 2: Demote recent MLS records to low confidence (they need BatchData verification)
    console.log(`\nStep 2: Demoting ${recentMls.length} recent MLS records to MLS_PENDING_VERIFICATION...`);
    let demoted = 0;
    
    for (let i = 0; i < recentMls.length; i++) {
        try {
            await base44.entities.MasterProperty.update(recentMls[i].id, {
                original_status: 'MLS_PENDING_VERIFICATION',
                sale_confidence: 'low'
            });
            demoted++;
        } catch(e) {
            errors++;
        }
    }
    
    console.log(`\n=== CLEANUP COMPLETE ===`);
    console.log(`Rejected (old MLS): ${rejected}`);
    console.log(`Demoted to pending verification: ${demoted}`);
    console.log(`Errors: ${errors}`);
    console.log(`\nNow re-pull data from the Command Center to get fresh v15 results.`);
}

run().catch(console.error);
