import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Upload } from 'lucide-react';
import Papa from 'papaparse';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from "@tanstack/react-query";

export default function CsvUploader() {
    const [isUploading, setIsUploading] = useState(false);
    const queryClient = useQueryClient();

    const handleFileUpload = (event) => {
        const file = event.target.files[0];
        if (!file) return;

        setIsUploading(true);
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
                    const houseNumber = parseInt(
                        normalizedRow.housenumber || normalizedRow.number || normalizedRow.streetnumber ||
                        normalizedRow.addressnumber || normalizedRow.no || row.HouseNumber || row.Number || 0
                    );
                    const streetName = normalizedRow.streetname || normalizedRow.street || 
                        normalizedRow.streetaddress || row.StreetName || row.Street || 'Unknown Street';
                    const fullAddress = normalizedRow.fulladdress || normalizedRow.address || 
                        normalizedRow.propertyaddress || row.FullAddress || row.Address || `${houseNumber} ${streetName}`;

                    // Generate Hash if missing
                    let addressHash = normalizedRow.addresshash || normalizedRow.id || normalizedRow.hash || 
                        normalizedRow.propertyid || row.ID || row.Id;
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
                        original_status: (normalizedRow.originalstatus || normalizedRow.status || row.Status || 'ELIGIBLE').toUpperCase()
                    });
                });

                if (entities.length === 0) {
                    const firstRow = data[0] || {};
                    const keys = Object.keys(firstRow).join(', ');
                    alert(`No valid rows found. Parsed ${data.length} rows, ${errorCount} had invalid lat/lng.\n\nYour CSV columns: ${keys}\n\nLooking for lat/lng columns like: lat, latitude, Lat, LAT, lng, lon, long, longitude, Lng, Long\n\nFirst row values: ${JSON.stringify(firstRow).substring(0, 200)}`);
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
            }
        });
    };

    return (
        <div className="relative">
            <input
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="hidden"
                id="csv-upload"
                disabled={isUploading}
            />
            <label htmlFor="csv-upload">
                <Button 
                    variant="outline" 
                    className="bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white gap-2"
                    asChild
                    disabled={isUploading}
                >
                    <span>
                        <Upload className="w-4 h-4" />
                        {isUploading ? 'Importing...' : 'Import Master CSV'}
                    </span>
                </Button>
            </label>
        </div>
    );
}