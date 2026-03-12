import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// Chunked migration: Convert legacy Base64 hashes to RentCast address-string format,
// merge duplicates, hydrate missing fields, mark unmatched as UNVERIFIED.
// Processes in chunks of ~500 with delays to avoid rate limits.
// Call repeatedly until it returns { complete: true }.

function buildAddressHash(fullAddress, city, state, zipCode) {
    if (!fullAddress) return null;
    let addr = fullAddress;
    if (!addr.includes(',') && city) {
        addr = `${addr}, ${city}`;
        if (state) addr += `, ${state}`;
        if (zipCode) addr += ` ${zipCode.split('-')[0]}`;
    }
    return addr
        .replace(/[^\w\s,-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req) => {
    const startTime = Date.now();

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const { dry_run = true, chunk_offset = 0, chunk_size = 300 } = await req.json().catch(() => ({}));

        console.log(`[migrate] chunk_offset=${chunk_offset} chunk_size=${chunk_size} dry_run=${dry_run}`);

        // Step 1: Load a chunk of legacy records
        // Legacy = sale_type is null (CSV imports never set sale_type) AND not yet migrated (no legacy_hash)
        const batch = await base44.asServiceRole.entities.MasterProperty.filter(
            { sale_type: null }, '-created_date', chunk_size
        );
        let legacyChunk = Array.isArray(batch) ? batch : (batch?.items || []);
        // Filter out already-migrated records and RentCast records
        legacyChunk = legacyChunk.filter(p => !p.legacy_hash && p.data_source !== 'rentcast');

        console.log(`[migrate] Found ${legacyChunk.length} unmigrated records in this chunk`);

        if (legacyChunk.length === 0) {
            return Response.json({
                complete: true,
                dry_run,
                message: 'No more legacy records to migrate',
                duration_seconds: Math.round((Date.now() - startTime) / 1000)
            });
        }

        // Step 2: Load RentCast records for dedup (only unique zips in this chunk)
        const chunkZips = [...new Set(legacyChunk.map(p => p.zip_code).filter(Boolean))];
        const rentcastHashes = new Map();

        for (let i = 0; i < chunkZips.length; i += 5) {
            const zipBatch = chunkZips.slice(i, i + 5);
            const promises = zipBatch.map(zip =>
                base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip, data_source: 'rentcast' }, null, 5000)
                    .then(res => {
                        const arr = Array.isArray(res) ? res : (res?.items || []);
                        arr.forEach(r => rentcastHashes.set(r.address_hash, r));
                    })
                    .catch(() => {})
            );
            await Promise.all(promises);
            if (i + 5 < chunkZips.length) await sleep(200);
        }

        console.log(`[migrate] Loaded ${rentcastHashes.size} RentCast records for dedup across ${chunkZips.length} zips`);

        const rcRecords = Array.from(rentcastHashes.values());

        const stats = {
            chunk_processed: legacyChunk.length,
            hash_converted: 0,
            merged_with_rentcast: 0,
            hydrated_fields: 0,
            marked_unverified: 0,
            date_normalized: 0,
            deleted_dupes: 0,
            errors: []
        };

        const updates = [];
        const toDelete = [];

        for (const legacy of legacyChunk) {
            const d = legacy;
            const oldHash = d.address_hash;
            const fullAddr = d.full_address;

            const newHash = buildAddressHash(fullAddr, d.city, d.state, d.zip_code);
            if (!newHash) {
                stats.errors.push(`No address for record ${legacy.id}`);
                continue;
            }

            const updateData = {
                legacy_hash: oldHash,
                data_source: 'csv_import'
            };

            if (d.sold_date === 'OFF MARKET' || d.sold_date === 'off market') {
                updateData.sold_date = null;
                stats.date_normalized++;
            }

            const rcMatch = rentcastHashes.get(newHash);
            if (rcMatch) {
                toDelete.push(legacy.id);
                stats.merged_with_rentcast++;
                stats.deleted_dupes++;
                continue;
            }

            updateData.address_hash = newHash;
            stats.hash_converted++;

            // Hydrate missing city/state/zip
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
                if (nearest && nearestDist < 0.5) {
                    if (!d.city && nearest.city) updateData.city = nearest.city;
                    if (!d.state && nearest.state) updateData.state = nearest.state;
                    if (!d.zip_code && nearest.zip_code) updateData.zip_code = nearest.zip_code;
                    stats.hydrated_fields++;
                }
            }

            // Mark UNVERIFIED (preserve user-set statuses)
            if (d.original_status !== 'HARD_NO' && d.original_status !== 'DO_NOT_KNOCK') {
                updateData.original_status = 'UNVERIFIED';
                stats.marked_unverified++;
            }

            updates.push({ id: legacy.id, data: updateData });
        }

        console.log(`[migrate] Plan: ${updates.length} updates, ${toDelete.length} deletes`);

        if (!dry_run) {
            let updated = 0;
            // Process in small batches with delays
            for (let i = 0; i < updates.length; i++) {
                const { id, data } = updates[i];
                try {
                    await base44.asServiceRole.entities.MasterProperty.update(id, data);
                    updated++;
                } catch (e) {
                    stats.errors.push(`Update ${id}: ${e.message}`);
                }
                // Throttle: pause every 20 updates
                if (updated % 20 === 0 && updated > 0) {
                    await sleep(500);
                    if (Date.now() - startTime > 50000) {
                        console.log(`[migrate] Time limit approaching, stopping at ${updated}/${updates.length}`);
                        break;
                    }
                }
            }

            let deleted = 0;
            for (let i = 0; i < toDelete.length; i++) {
                try {
                    await base44.asServiceRole.entities.MasterProperty.delete(toDelete[i]);
                    deleted++;
                } catch (e) {
                    stats.errors.push(`Delete ${toDelete[i]}: ${e.message}`);
                }
                if (deleted % 20 === 0 && deleted > 0) await sleep(500);
            }

            stats.actually_updated = updated;
            stats.actually_deleted = deleted;
            console.log(`[migrate] DONE chunk: updated=${updated} deleted=${deleted}`);

            // Auto-chain next chunk
            try {
                base44.functions.invoke('migrateHashLegacy', { dry_run: false, chunk_offset: chunk_offset + chunk_size }).catch(() => {});
            } catch (e) { /* caller can re-invoke manually */ }
        }

        return Response.json({
            complete: false,
            dry_run,
            duration_seconds: Math.round((Date.now() - startTime) / 1000),
            stats,
            next_chunk_offset: chunk_offset + chunk_size,
            sample_updates: updates.slice(0, 3).map(u => ({
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