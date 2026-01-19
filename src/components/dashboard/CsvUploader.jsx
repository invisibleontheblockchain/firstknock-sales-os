import React, { useState } from 'react';
import { Upload } from 'lucide-react';
import Papa from 'papaparse';
import { base44 } from '@/api/base44Client';
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { storage } from '@/lib/storage';

export default function CsvUploader() {
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState(null);
    const queryClient = useQueryClient();
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    // Ensure auth session is active before upload
    const ensureSession = async () => {
        try {
            const user = await base44.auth.me();
            console.log("Upload session check - User:", user?.email);
            return user;
        } catch (e) {
            console.warn("Upload session check failed:", e);
            return null;
        }
    };

    const handleFileUpload = async (event) => {
        await ensureSession();
        const file = event.target.files[0];
        if (!file) return;

        setIsUploading(true);

        // Handle JSON files
        if (file.name.endsWith('.json')) {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const jsonData = JSON.parse(e.target.result);
                    const dataArray = Array.isArray(jsonData) ? jsonData : [jsonData];
                    console.log(`[JSON Upload] Parsed ${dataArray.length} records`);
                    console.log(`[JSON Upload] First record keys:`, dataArray[0] ? Object.keys(dataArray[0]) : 'none');
                    console.log(`[JSON Upload] Sample record:`, dataArray[0]);
                    await processData(dataArray);
                } catch (error) {
                    console.error("JSON parse error", error);
                    setUploadStatus({ success: false, message: `JSON parse failed: ${error.message}` });
                    setIsUploading(false);
                }
            };
            reader.readAsText(file);
            return;
        }

        // Handle CSV files
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: async (results) => {
                const data = results.data;

                // Get original headers for debugging
                const originalHeaders = results.meta.fields || [];
                console.log("CSV Headers found:", originalHeaders);
                console.log("First row sample:", data[0]);

                // Normalize headers for matching
                const normalizeKey = (key) => key.toLowerCase().trim().replace(/[\s_-]+/g, '');

                const entities = [];
                let errorCount = 0;

                await processData(data);
            }
        });
    };

    const processData = async (data) => {
        // Try multiple ways to get user email
        let userEmail = user?.email;

        // Try getting from query cache
        if (!userEmail) {
            const cachedUser = queryClient.getQueryData(['user']);
            userEmail = cachedUser?.email;
            console.log('[Upload] Got user from cache:', userEmail);
        }

        // Try fetching directly as last resort
        if (!userEmail) {
            try {
                const currentUser = await base44.auth.me();
                userEmail = currentUser?.email;
                console.log('[Upload] Fetched user email:', userEmail);
            } catch (e) {
                console.log('[Upload] Could not get user:', e.message);
            }
        }

        // Log what we have
        console.log('[Upload] Final user email:', userEmail);

        // If still no email, use a fallback (allow upload but flag it)
        if (!userEmail) {
            userEmail = 'unknown@user.local';
            console.log('[Upload] WARNING: Using fallback email');
        }

        // Normalize headers for matching
        const normalizeKey = (key) => key.toLowerCase().trim().replace(/[\s_-]+/g, '');

        const entities = [];
        let errorCount = 0;

        data.forEach((row, idx) => {
            // Create normalized version of row keys
            const normalizedRow = {};
            Object.keys(row).forEach(key => {
                normalizedRow[normalizeKey(key)] = row[key];
            });

            // Log first row to help debug field names
            if (idx === 0) {
                console.log('[Upload] First row keys:', Object.keys(row));
                console.log('[Upload] Normalized keys:', Object.keys(normalizedRow));
            }

            // Try to find lat/lng with many variations
            const lat = parseFloat(
                normalizedRow.lat || normalizedRow.latitude ||
                normalizedRow.y || normalizedRow.geocodelat ||
                row.Lat || row.LAT || row.Latitude || row.LATITUDE ||
                row.lat || row.latitude
            );
            const lng = parseFloat(
                normalizedRow.lng || normalizedRow.lon || normalizedRow.long ||
                normalizedRow.longitude || normalizedRow.x || normalizedRow.geocodelong ||
                row.Lng || row.LNG || row.Long || row.Longitude || row.LONGITUDE ||
                row.lng || row.lon || row.longitude
            );

            if (isNaN(lat) || isNaN(lng)) {
                errorCount++;
                if (idx === 0) {
                    console.log("[Upload] First row FAILED - lat:", lat, "lng:", lng);
                    console.log("[Upload] Raw row:", JSON.stringify(row).substring(0, 500));
                }
                return;
            }

            // House Number & Street - try many variations
            let houseNumber = parseInt(
                normalizedRow.housenumber || normalizedRow.number || normalizedRow.streetnumber ||
                normalizedRow.addressnumber || normalizedRow.no || row.HouseNumber || row.Number || 0
            );
            let streetName = normalizedRow.streetname || normalizedRow.street ||
                normalizedRow.streetaddress || row.StreetName || row.Street || '';
            const fullAddress = normalizedRow.fulladdress || normalizedRow.address ||
                normalizedRow.propertyaddress || row.FullAddress || row.Address || row.ADDRESS || `${houseNumber} ${streetName}`;

            // Smart Parse Address if components missing
            if ((!houseNumber || !streetName || streetName === 'Unknown Street') && fullAddress) {
                const parts = fullAddress.trim().split(' ');
                if (parts.length > 1 && !isNaN(parseInt(parts[0]))) {
                    houseNumber = parseInt(parts[0]);
                    streetName = parts.slice(1).join(' ');
                }
            }

            if (!streetName) streetName = 'Unknown Street';

            // Generate Hash if missing
            let addressHash = normalizedRow.addresshash || normalizedRow.id || normalizedRow.hash ||
                normalizedRow.propertyid || row.ID || row.Id || row["MLS#"];
            if (!addressHash) {
                // Simple consistent ID generation
                addressHash = btoa(`${streetName}-${houseNumber}-${lat}-${lng}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
            }

            // Status mapping: In imported data, 'SOLD' means the home was recently sold (a sales lead).
            // Only 'DO_NOT_KNOCK' or 'HARD_NO' should be excluded from routing.
            let importedStatus = (normalizedRow.originalstatus || normalizedRow.status || row.Status || row.STATUS || 'ELIGIBLE').toUpperCase();
            // Treat imported 'SOLD' as 'ELIGIBLE' since it's a lead, not a completed sale
            if (importedStatus === 'SOLD') importedStatus = 'ELIGIBLE';

            entities.push({
                address_hash: String(addressHash),
                house_number: houseNumber,
                street_name: streetName,
                full_address: fullAddress,
                lat: lat,
                lng: lng,
                original_status: importedStatus,
                beds: parseFloat(normalizedRow.beds || row.BEDS || 0),
                baths: parseFloat(normalizedRow.baths || row.BATHS || 0),
                sqft: parseFloat(normalizedRow.squarefeet || normalizedRow.sqft || row["SQUARE FEET"] || 0),
                lot_size: parseFloat(normalizedRow.lotsize || row["LOT SIZE"] || 0),
                year_built: parseInt(normalizedRow.yearbuilt || row["YEAR BUILT"] || 0),
                price: parseFloat(normalizedRow.price || row.PRICE || 0),
                sold_date: normalizedRow.solddate || row["SOLD DATE"] || null,
                sale_type: normalizedRow.saletype || row["SALE TYPE"] || null,
                property_type: normalizedRow.propertytype || row["PROPERTY TYPE"] || null,
                city: normalizedRow.city || row.CITY || null,
                state: normalizedRow.state || row["STATE OR PROVINCE"] || null,
                zip_code: normalizedRow.zipcode || normalizedRow.postalcode || row["ZIP OR POSTAL CODE"] || null,
                url: normalizedRow.url || row["URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)"] || null,
                mls_id: normalizedRow.mlsid || row["MLS#"] || null,
                created_by: userEmail,
                // New fields for Cooldowns & Street Sweep
                next_eligible_date: normalizedRow.next_eligible_date || normalizedRow.nexteligibledate || row.Next_Eligible_Date || null,
                street_key: normalizedRow.street_key || normalizedRow.streetkey || row.Street_Key || null,
                street_last_visited: normalizedRow.street_last_visited || normalizedRow.streetlastvisited || row.Street_Last_Visited || null,
                street_next_eligible_date: normalizedRow.street_next_eligible_date || normalizedRow.streetnexteligibledate || row.Street_Next_Eligible_Date || null,
                street_cooldown_source: normalizedRow.street_cooldown_source || normalizedRow.streetcooldownsource || row.Street_Cooldown_Source || null
            });

            if (idx === 0) {
                console.log('[Upload] First entity created:', entities[0]);
            }
        });

        if (entities.length === 0) {
            const firstRow = data[0] || {};
            const keys = Object.keys(firstRow).join(', ');
            setUploadStatus({ success: false, message: `No valid rows found. Check lat/lng columns.` });
            alert(`No valid rows found. Parsed ${data.length} rows, ${errorCount} had invalid lat/lng.\n\nYour data columns: ${keys}`);
            setIsUploading(false);
            return;
        }

        try {
            // Batching to avoid payload limits
            const BATCH_SIZE = 500;
            let importedCount = 0;
            const totalBatches = Math.ceil(entities.length / BATCH_SIZE);

            for (let i = 0; i < entities.length; i += BATCH_SIZE) {
                const batch = entities.slice(i, i + BATCH_SIZE);
                const batchNum = Math.floor(i / BATCH_SIZE) + 1;
                setUploadStatus({ success: null, message: `Uploading batch ${batchNum}/${totalBatches}...` });
                await base44.entities.MasterProperty.bulkCreate(batch);
                importedCount += batch.length;
            }

            // Save to local storage for offline access
            await storage.saveProperties(entities);
            console.log('[Upload] Saved to local storage');

            // Force invalidate all possible query keys to ensure UI updates
            await queryClient.invalidateQueries({ queryKey: ['masterProperties'], refetchType: 'all' });

            await queryClient.invalidateQueries({ queryKey: ['masterProperties', 'fallback'], refetchType: 'all' });
            if (user?.email) {
                await queryClient.invalidateQueries({ queryKey: ['masterProperties', user.email], refetchType: 'all' });
            }

            console.log('[Upload] Queries invalidated. Refetching...');

            setUploadStatus({ success: true, message: `✓ ${importedCount.toLocaleString()} properties saved!` });
        } catch (error) {
            console.error("Import error", error);
            setUploadStatus({ success: false, message: `✗ Upload failed: ${error.message}` });
            alert("Failed to import properties: " + error.message);
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <div className="space-y-3">
            <input
                type="file"
                accept=".csv,.json"
                onChange={handleFileUpload}
                className="hidden"
                id="file-upload"
                disabled={isUploading}
            />
            <label htmlFor="file-upload" className="block">
                <div className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${isUploading ? 'border-yellow-500 bg-yellow-500/10' : 'border-slate-700 hover:border-slate-500 hover:bg-slate-800/50'}`}>
                    <Upload className="w-5 h-5 text-slate-400" />
                    <span className="text-sm font-medium text-slate-300">
                        {isUploading ? 'Importing...' : 'Import CSV or JSON'}
                    </span>
                </div>
            </label>

            {uploadStatus && (
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium ${uploadStatus.success === true ? 'bg-green-500/20 text-green-400 border border-green-500/30' :
                    uploadStatus.success === false ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                        'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                    }`}>
                    {uploadStatus.message}
                </div>
            )}
        </div>
    );
}