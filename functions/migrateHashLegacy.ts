import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// One-time migration: Convert legacy Base64 hashes to RentCast address-string format,
// merge duplicates, hydrate missing fields, mark unmatched as UNVERIFIED.

function buildAddressHash(fullAddress) {
    if (!fullAddress) return null;
    // Standardize to kebab-case format matching RentCast pipeline
    return fullAddress
        .replace(/[^\w\s,-]/g, '')  // remove special chars except comma/hyphen
        .replace(/\s+/g, '-')       // spaces to hyphens
        .replace(/-+/g, '-')        // collapse multiple hyphens
        .replace(/^-|-$/g, '');     // trim leading/trailing hyphens
}

function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 3959; // miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

Deno.serve(async (req) => {
    const startTime = Date.now();

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const { dry_run = true, batch_size = 200 } = await req.json().catch(() => ({}));

        console.log(`[migrate] Starting hash migration | dry_run=${dry_run}`);

        // Step 1: Load ALL legacy records (sale_type is null = CSV import)
        const allLegacy = [];
        let offset = 0;
        while (true) {
            const batch = await base44.asServiceRole.entities.MasterProperty.filter(
                { sale_type: null }, null, 500
            );
            const arr = Array.isArray(batch) ? batch : (batch?.items || []);
            allLegacy.push(...arr);
            if (arr.length < 500) break;
            offset += 500;
            // Safety: max 10k legacy records
            if (allLegacy.length >= 10000) break;
        }

        console.log(`[migrate] Found ${allLegacy.length} legacy records`);

        // Step 2: Load ALL RentCast records for dedup lookup
        const rentcastHashes = new Map(); // hash -> record
        for (const saleType of ['Deed', 'MLS']) {
            let rcOffset = 0;
            while (true) {
                const batch = await base44.asServiceRole.entities.MasterProperty.filter(
                    { sale_type: saleType }, null, 500
                );
                const arr = Array.isArray(batch) ? batch : (batch?.items || []);
                arr.forEach(r => rentcastHashes.set(r.address_hash, r));
                if (arr.length < 500) break;
                rcOffset += 500;
                if (rcOffset >= 20000) break;
            }
        }

        console.log(`[migrate] Loaded ${rentcastHashes.size} RentCast records for dedup`);

        // Build spatial index from RentCast records for hydration
        const rcRecords = Array.from(rentcastHashes.values());

        const stats = {
            total_legacy: allLegacy.length,
            hash_converted: 0,
            merged_with_rentcast: 0,
            hydrated_fields: 0,
            marked_unverified: 0,
            date_normalized: 0,
            deleted_dupes: 0,
            errors: []
        };

        const updates = []; // { id, data }
        const toDelete = []; // ids of legacy records that are dupes

        for (const legacy of allLegacy) {
            const d = legacy;
            const oldHash = d.address_hash;
            const fullAddr = d.full_address;

            // Build new standardized hash from full_address
            const newHash = buildAddressHash(fullAddr);
            if (!newHash) {
                stats.errors.push(`No address for record ${legacy.id}`);
                continue;
            }

            const updateData = {
                legacy_hash: oldHash,  // preserve original hash
                data_source: 'csv_import'
            };

            // Normalize sold_date
            if (d.sold_date === 'OFF MARKET' || d.sold_date === 'off market') {
                updateData.sold_date = null;
                stats.date_normalized++;
            }

            // Check if RentCast already has this address
            const rcMatch = rentcastHashes.get(newHash);
            if (rcMatch) {
                // MERGE: RentCast wins — delete legacy, keep RentCast record
                // But first, preserve any interaction-relevant data from legacy
                toDelete.push(legacy.id);
                stats.merged_with_rentcast++;
                stats.deleted_dupes++;
                continue;
            }

            // No RentCast match — update hash and mark UNVERIFIED
            updateData.address_hash = newHash;
            stats.hash_converted++;

            // Hydrate missing city/state/zip from nearest RentCast record
            if ((!d.city || !d.zip_code || !d.state) && d.lat && d.lng) {
                let nearest = null;
                let nearestDist = Infinity;

                for (const rc of rcRecords) {
                    if (!rc.lat || !rc.lng || !rc.city) continue;
                    const dist = haversineDistance(d.lat, d.lng, rc.lat, rc.lng);
                    if (dist < nearestDist) {
                        nearestDist = dist;
                        nearest = rc;
                    }
                }

                // Only hydrate if within 0.5 miles
                if (nearest && nearestDist < 0.5) {
                    if (!d.city && nearest.city) updateData.city = nearest.city;
                    if (!d.state && nearest.state) updateData.state = nearest.state;
                    if (!d.zip_code && nearest.zip_code) updateData.zip_code = nearest.zip_code;
                    stats.hydrated_fields++;
                }
            }

            // Mark as UNVERIFIED unless it has a real sold status
            if (d.original_status === 'ELIGIBLE' || !d.original_status) {
                updateData.original_status = 'UNVERIFIED';
                stats.marked_unverified++;
            }

            updates.push({ id: legacy.id, data: updateData });
        }

        console.log(`[migrate] Plan: ${updates.length} updates, ${toDelete.length} deletes`);
        console.log(`[migrate] Stats:`, JSON.stringify(stats));

        if (!dry_run) {
            // Execute updates in batches
            let updated = 0;
            for (const { id, data } of updates) {
                try {
                    await base44.asServiceRole.entities.MasterProperty.update(id, data);
                    updated++;
                } catch (e) {
                    stats.errors.push(`Update ${id} failed: ${e.message}`);
                }
                // Throttle
                if (updated % 50 === 0) {
                    await new Promise(r => setTimeout(r, 200));
                    console.log(`[migrate] Updated ${updated}/${updates.length}`);
                }
            }

            // Delete merged duplicates
            let deleted = 0;
            for (const id of toDelete) {
                try {
                    await base44.asServiceRole.entities.MasterProperty.delete(id);
                    deleted++;
                } catch (e) {
                    stats.errors.push(`Delete ${id} failed: ${e.message}`);
                }
                if (deleted % 50 === 0) {
                    await new Promise(r => setTimeout(r, 200));
                }
            }

            console.log(`[migrate] DONE: Updated ${updated}, Deleted ${deleted}`);
        }

        const duration = Math.round((Date.now() - startTime) / 1000);

        return Response.json({
            dry_run,
            duration_seconds: duration,
            stats,
            sample_updates: updates.slice(0, 5).map(u => ({
                id: u.id,
                new_hash: u.data.address_hash,
                legacy_hash: u.data.legacy_hash,
                status: u.data.original_status,
                hydrated: !!u.data.city || !!u.data.zip_code
            }))
        });

    } catch (error) {
        console.error('[migrate] FATAL:', error.message, error.stack);
        return Response.json({ error: error.message }, { status: 500 });
    }
});