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
            transformHeader: (h) => h.toLowerCase().trim().replace(/[\s_]+/g, ''),
            complete: async (results) => {
                const data = results.data;
                
                // Flexible mapping
                // We expect normalized headers: lat, lng, addresshash, housenumber, streetname, fulladdress, originalstatus
                // But user might provide: Latitude, Longitude, Address, etc.
                
                const entities = [];
                let errorCount = 0;

                data.forEach(row => {
                    // Try to find lat/lng
                    const lat = parseFloat(row.lat || row.latitude);
                    const lng = parseFloat(row.lng || row.longitude || row.long);
                    
                    if (isNaN(lat) || isNaN(lng)) {
                        errorCount++;
                        return;
                    }

                    // House Number & Street
                    const houseNumber = parseInt(row.housenumber || row.number || 0);
                    const streetName = row.streetname || row.street || 'Unknown Street';
                    const fullAddress = row.fulladdress || row.address || `${houseNumber} ${streetName}`;

                    // Generate Hash if missing
                    let addressHash = row.addresshash || row.id || row.hash;
                    if (!addressHash) {
                        // Simple consistent ID generation
                        addressHash = btoa(`${streetName}-${houseNumber}-${lat}-${lng}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
                    }

                    entities.push({
                        address_hash: addressHash,
                        house_number: houseNumber,
                        street_name: streetName,
                        full_address: fullAddress,
                        lat: lat,
                        lng: lng,
                        original_status: (row.originalstatus || row.status || 'ELIGIBLE').toUpperCase()
                    });
                });

                if (entities.length === 0) {
                    const firstRow = data[0] || {};
                    const keys = Object.keys(firstRow).join(', ');
                    alert(`No valid rows found. Parsed ${data.length} rows.\n\nRequired columns: "lat", "lng".\n\nColumns found in your CSV: ${keys}\n\nPlease rename your columns to match "lat" and "lng" or "latitude" and "longitude".`);
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