import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Upload } from 'lucide-react';
import Papa from 'papaparse';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from "@tanstack/react-query";

export default function CsvUploader() {
    const [isUploading, setIsUploading] = useState(false);
    const queryClient = useQueryClient();

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
        const file = event.target.files[0];
        if (!file) return;

        setIsUploading(true);
        
        // Handle JSON files
        if (file.name.endsWith('.json')) {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const jsonData = JSON.parse(e.target.result);
                    await processData(Array.isArray(jsonData) ? jsonData : [jsonData]);
                } catch (error) {
                    console.error("JSON parse error", error);
                    alert("Failed to parse JSON file. Please check the format.");
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
            
            // Try to find lat/lng with many variations
            const lat = parseFloat(
                normalizedRow.lat || normalizedRow.latitude || 
                normalizedRow.y || normalizedRow.geocodelat || row.Lat || row.LAT || row.Latitude
            );
            const lng = parseFloat(
                normalizedRow.lng || normalizedRow.lon || normalizedRow.long || 
                normalizedRow.longitude || normalizedRow.x || normalizedRow.geocodelong ||
                row.Lng || row.LNG || row.Long || row.Longitude
            );
            
            if (isNaN(lat) || isNaN(lng)) {
                errorCount++;
                if (idx === 0) {
                    console.log("First row failed - lat:", lat, "lng:", lng, "normalizedRow:", normalizedRow);
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

            entities.push({
                address_hash: String(addressHash),
                house_number: houseNumber,
                street_name: streetName,
                full_address: fullAddress,
                lat: lat,
                lng: lng,
                original_status: (normalizedRow.originalstatus || normalizedRow.status || row.Status || row.STATUS || 'ELIGIBLE').toUpperCase(),
                
                // New Fields
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
                mls_id: normalizedRow.mlsid || row["MLS#"] || null
            });
        });

        if (entities.length === 0) {
            const firstRow = data[0] || {};
            const keys = Object.keys(firstRow).join(', ');
            alert(`No valid rows found. Parsed ${data.length} rows, ${errorCount} had invalid lat/lng.\n\nYour data columns: ${keys}\n\nLooking for lat/lng columns like: lat, latitude, Lat, LAT, lng, lon, long, longitude, Lng, Long\n\nFirst row values: ${JSON.stringify(firstRow).substring(0, 200)}`);
            setIsUploading(false);
            return;
        }

        try {
            // Batching to avoid payload limits
            const BATCH_SIZE = 500;
            let importedCount = 0;
            
            for (let i = 0; i < entities.length; i += BATCH_SIZE) {
                const batch = entities.slice(i, i + BATCH_SIZE);
                await base44.entities.MasterProperty.bulkCreate(batch);
                importedCount += batch.length;
            }

            queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
            alert(`Successfully imported ${importedCount} properties.`);
        } catch (error) {
            console.error("Import error", error);
            alert("Failed to import properties.");
        } finally {
            setIsUploading(false);
        }
    };

    const dummyFunction = () => {
        // Placeholder to maintain structure after refactor
        const data = [];
        data.forEach((row, idx) => {
            if (idx === 0) {
                // Keep existing logic structure
            }
        });
    };

    return (
        <div className="relative">
            <input
                type="file"
                accept=".csv,.json"
                onChange={handleFileUpload}
                className="hidden"
                id="file-upload"
                disabled={isUploading}
            />
            <label htmlFor="file-upload">
                <Button 
                    variant="outline" 
                    className="bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white gap-2"
                    asChild
                    disabled={isUploading}
                >
                    <span>
                        <Upload className="w-4 h-4" />
                        {isUploading ? 'Importing...' : 'Import CSV or JSON'}
                    </span>
                </Button>
            </label>
        </div>
    );
}