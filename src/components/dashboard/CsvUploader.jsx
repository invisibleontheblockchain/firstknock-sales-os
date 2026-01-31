import React, { useState } from 'react';
import { Upload, History, FilePlus, AlertCircle } from 'lucide-react';
import Papa from 'papaparse';
import { base44 } from '@/api/base44Client';
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { storage } from '@/lib/storage';
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export default function CsvUploader() {
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState(null);
    const [importMode, setImportMode] = useState('create'); // 'create' or 'history'
    
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
        setUploadStatus({ success: null, message: 'Parsing file...' });

        // Handle JSON files
        if (file.name.endsWith('.json')) {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const jsonData = JSON.parse(e.target.result);
                    let dataArray = Array.isArray(jsonData) ? jsonData : [jsonData];

                    // Smart Unwrapping: Check for common wrapper keys if it's an object
                    if (!Array.isArray(jsonData) && jsonData) {
                        if (Array.isArray(jsonData.properties)) dataArray = jsonData.properties;
                        else if (Array.isArray(jsonData.data)) dataArray = jsonData.data;
                        else if (Array.isArray(jsonData.items)) dataArray = jsonData.items;
                        else if (Array.isArray(jsonData.results)) dataArray = jsonData.results;
                    }

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
                await processData(data);
            },
            error: (err) => {
                setUploadStatus({ success: false, message: `CSV parse failed: ${err.message}` });
                setIsUploading(false);
            }
        });
    };

    const processData = async (data) => {
        // Get user email
        let userEmail = user?.email;
        if (!userEmail) {
            try {
                const currentUser = await base44.auth.me();
                userEmail = currentUser?.email;
            } catch (e) { console.log('Auth check failed', e); }
        }
        if (!userEmail) userEmail = 'unknown@user.local';

        if (importMode === 'history') {
            await processHistoryImport(data, userEmail);
        } else {
            await processPropertyImport(data, userEmail);
        }
    };

    const normalizeStatus = (rawStatus) => {
        if (!rawStatus) return 'ELIGIBLE';
        const s = String(rawStatus).toUpperCase().trim();
        
        if (['SOLD', 'BOUGHT', 'CLOSE'].some(x => s.includes(x))) return 'SOLD';
        if (['NO', 'NOT', 'REJECT', 'HARD', 'UNINTERESTED', 'STOP', 'DON'].some(x => s.includes(x))) return 'HARD_NO';
        if (['CALL', 'BACK', 'LATER', 'BUSY'].some(x => s.includes(x))) return 'CALLBACK';
        if (['ANSWER', 'HOME', 'DOOR'].some(x => s.includes(x))) return 'NO_ANSWER';
        if (['YES', 'INTERESTED', 'LEAD', 'QUALIFIED'].some(x => s.includes(x))) return 'QUALIFIED';
        
        return 'ELIGIBLE';
    };

    const processHistoryImport = async (data, userEmail) => {
        const logs = [];
        let errorCount = 0;
        const normalizeKey = (key) => key.toLowerCase().trim().replace(/[\s_-]+/g, '');

        data.forEach((row, idx) => {
            const normalizedRow = {};
            Object.keys(row).forEach(key => normalizedRow[normalizeKey(key)] = row[key]);

            // Try to construct address hash to link to property
            // We need enough info to recreate the hash: Street Name + House Number + Lat + Lng
            // OR if the CSV has the hash/ID directly
            
            let addressHash = normalizedRow.addresshash || normalizedRow.id || normalizedRow.hash || normalizedRow.propertyid || row["MLS#"];
            
            // If no hash, try to generate it using same logic as creation
            if (!addressHash) {
                const lat = parseFloat(normalizedRow.lat || normalizedRow.latitude || row.Lat || 0);
                const lng = parseFloat(normalizedRow.lng || normalizedRow.longitude || row.Lng || 0);
                
                let houseNumber = parseInt(normalizedRow.housenumber || normalizedRow.number || 0);
                let streetName = normalizedRow.streetname || normalizedRow.street || '';
                const fullAddress = normalizedRow.fulladdress || normalizedRow.address || `${houseNumber} ${streetName}`;

                // Parse address if needed
                if ((!houseNumber || !streetName) && fullAddress) {
                    const parts = fullAddress.trim().split(' ');
                    if (parts.length > 1 && !isNaN(parseInt(parts[0]))) {
                        houseNumber = parseInt(parts[0]);
                        streetName = parts.slice(1).join(' ');
                    }
                }
                
                if (houseNumber && streetName && !isNaN(lat) && !isNaN(lng)) {
                     addressHash = btoa(`${streetName}-${houseNumber}-${lat}-${lng}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
                }
            }

            if (!addressHash) {
                errorCount++;
                return;
            }

            const status = normalizeStatus(normalizedRow.status || normalizedRow.result || row.Status || 'ELIGIBLE');
            
            // Only create log if status is meaningful (not just eligible)
            if (status !== 'ELIGIBLE') {
                logs.push({
                    address_hash: String(addressHash),
                    raw_input_text: `Imported from CSV: ${row.Status || status}`,
                    parsed_status: status,
                    created_by: userEmail,
                    gps_proof_lat: parseFloat(normalizedRow.lat || 0),
                    gps_proof_lng: parseFloat(normalizedRow.lng || 0),
                    gps_accuracy: 0
                });
            }
        });

        if (logs.length === 0) {
            setUploadStatus({ success: false, message: `No valid status updates found. Check columns.` });
            setIsUploading(false);
            return;
        }

        try {
            const BATCH_SIZE = 500;
            let importedCount = 0;
            const totalBatches = Math.ceil(logs.length / BATCH_SIZE);

            for (let i = 0; i < logs.length; i += BATCH_SIZE) {
                const batch = logs.slice(i, i + BATCH_SIZE);
                setUploadStatus({ success: null, message: `Updating history batch ${Math.floor(i/BATCH_SIZE)+1}/${totalBatches}...` });
                await base44.entities.InteractionLog.bulkCreate(batch);
                importedCount += batch.length;
            }

            await queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
            await queryClient.invalidateQueries({ queryKey: ['masterProperties'] }); // Update effective statuses

            setUploadStatus({ success: true, message: `✓ Updated history for ${importedCount} properties!` });
        } catch (error) {
            console.error("History import error", error);
            setUploadStatus({ success: false, message: `Update failed: ${error.message}` });
        } finally {
            setIsUploading(false);
        }
    };

    const processPropertyImport = async (data, userEmail) => {
        const normalizeKey = (key) => key.toLowerCase().trim().replace(/[\s_-]+/g, '');
        const entities = [];
        let errorCount = 0;

        data.forEach((row, idx) => {
            const normalizedRow = {};
            Object.keys(row).forEach(key => normalizedRow[normalizeKey(key)] = row[key]);

            const lat = parseFloat(normalizedRow.lat || normalizedRow.latitude || row.Lat || row.LATITUDE || 0);
            const lng = parseFloat(normalizedRow.lng || normalizedRow.longitude || row.Lng || row.LONGITUDE || 0);

            if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) {
                if (errorCount === 0) {
                    console.warn("Import Validation Failed for Row:", row);
                    console.warn("Normalized Keys:", Object.keys(normalizedRow));
                    console.warn("Reason: Missing or invalid Latitude/Longitude");
                }
                errorCount++;
                return;
            }

            let houseNumber = parseInt(normalizedRow.housenumber || normalizedRow.number || 0);
            let streetName = normalizedRow.streetname || normalizedRow.street || '';
            const fullAddress = normalizedRow.fulladdress || normalizedRow.address || `${houseNumber} ${streetName}`;

            if ((!houseNumber || !streetName) && fullAddress) {
                const parts = fullAddress.trim().split(' ');
                if (parts.length > 1 && !isNaN(parseInt(parts[0]))) {
                    houseNumber = parseInt(parts[0]);
                    streetName = parts.slice(1).join(' ');
                }
            }
            if (!streetName) streetName = 'Unknown Street';

            let addressHash = normalizedRow.addresshash || normalizedRow.id || normalizedRow.hash || row["MLS#"] || normalizedRow["mls#"];
            if (!addressHash) {
                addressHash = btoa(`${streetName}-${houseNumber}-${lat}-${lng}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
            }

            let importedStatus = normalizeStatus(normalizedRow.status || normalizedRow.originalstatus || row.Status);

            // Robust field mapping for Redfin/Zillow formats
            entities.push({
                address_hash: String(addressHash),
                house_number: houseNumber,
                street_name: streetName,
                full_address: fullAddress,
                lat: lat,
                lng: lng,
                original_status: importedStatus,
                beds: parseFloat(normalizedRow.beds || 0),
                baths: parseFloat(normalizedRow.baths || 0),
                sqft: parseFloat(normalizedRow.sqft || normalizedRow.squarefeet || normalizedRow["squarefeet"] || 0),
                year_built: parseInt(normalizedRow.yearbuilt || normalizedRow["yearbuilt"] || 0),
                price: parseFloat(normalizedRow.price || 0),
                city: normalizedRow.city || null,
                state: normalizedRow.state || normalizedRow["stateorprovince"] || null,
                zip_code: normalizedRow.zipcode || normalizedRow.postalcode || normalizedRow["ziporpostalcode"] || null,
                created_by: userEmail
            });
        });

        if (entities.length === 0) {
            const msg = `No valid rows found. \n\nRequirement: Properties must have 'lat' and 'lng' (or 'latitude'/'longitude') columns to be placed on the map.\n\nCheck the browser console for details on the first rejected row.`;
            setUploadStatus({ success: false, message: `No valid rows with coordinates found.` });
            alert(msg);
            setIsUploading(false);
            return;
        }

        try {
            const BATCH_SIZE = 500;
            let importedCount = 0;
            for (let i = 0; i < entities.length; i += BATCH_SIZE) {
                const batch = entities.slice(i, i + BATCH_SIZE);
                setUploadStatus({ success: null, message: `Importing batch ${Math.floor(i/BATCH_SIZE)+1}...` });
                await base44.entities.MasterProperty.bulkCreate(batch);
                importedCount += batch.length;
            }

            await storage.saveProperties(entities);
            await queryClient.invalidateQueries({ queryKey: ['masterProperties'], refetchType: 'all' });

            setUploadStatus({ success: true, message: `✓ ${importedCount} properties imported!` });
        } catch (error) {
            console.error("Import error", error);
            setUploadStatus({ success: false, message: `Import failed: ${error.message}` });
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <div className="space-y-4">
            {/* Mode Switcher */}
            <div className="flex items-center gap-2 p-1 bg-[#1F1F1F] rounded-lg border border-gray-800 w-fit">
                <button
                    onClick={() => setImportMode('create')}
                    className={`flex items-center gap-2 px-3 py-2 rounded-md text-xs font-bold transition-all ${
                        importMode === 'create' ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-400 hover:text-white'
                    }`}
                >
                    <FilePlus className="w-4 h-4" />
                    NEW LIST
                </button>
                <button
                    onClick={() => setImportMode('history')}
                    className={`flex items-center gap-2 px-3 py-2 rounded-md text-xs font-bold transition-all ${
                        importMode === 'history' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'
                    }`}
                >
                    <History className="w-4 h-4" />
                    UPDATE HISTORY
                </button>
            </div>

            <div className="text-xs text-gray-400 px-1">
                {importMode === 'create' 
                    ? "Upload a new list of properties to build routes." 
                    : "Upload a list with statuses (Sold, Not Interested, etc) to update history and exclude from future routes."}
            </div>

            <input
                type="file"
                accept=".csv,.json"
                onChange={handleFileUpload}
                className="hidden"
                id="file-upload"
                disabled={isUploading}
            />
            <label htmlFor="file-upload" className="block">
                <div className={`flex items-center justify-center gap-2 px-4 py-6 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${isUploading ? 'border-yellow-500 bg-yellow-500/10' : 'border-slate-700 hover:border-slate-500 hover:bg-slate-800/50'}`}>
                    <Upload className={`w-6 h-6 ${isUploading ? 'text-yellow-500 animate-bounce' : 'text-slate-400'}`} />
                    <div className="text-center">
                        <span className="block text-sm font-bold text-slate-300">
                            {isUploading ? 'PROCESSING...' : `CLICK TO UPLOAD ${importMode === 'create' ? 'NEW LIST' : 'HISTORY'}`}
                        </span>
                        <span className="text-[10px] text-slate-500 mt-1 block">CSV or JSON</span>
                    </div>
                </div>
            </label>

            {uploadStatus && (
                <div className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs font-medium ${
                    uploadStatus.success === true ? 'bg-green-500/20 text-green-400 border border-green-500/30' :
                    uploadStatus.success === false ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                    'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                }`}>
                    {uploadStatus.success === false ? <AlertCircle className="w-4 h-4 shrink-0" /> : null}
                    {uploadStatus.message}
                </div>
            )}
        </div>
    );
}