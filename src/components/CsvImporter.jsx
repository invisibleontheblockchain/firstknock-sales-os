import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Upload, Loader2 } from 'lucide-react';
import Papa from 'papaparse';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from "@tanstack/react-query";

export default function CsvImporter() {
    const [uploading, setUploading] = useState(false);
    const queryClient = useQueryClient();
    
    const normalize = (key) => key.toLowerCase().trim().replace(/[\s_-]+/g, '');
    
    const handleFile = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        setUploading(true);
        
        // JSON file
        if (file.name.endsWith('.json')) {
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    await processData(Array.isArray(data) ? data : [data]);
                } catch (err) {
                    alert('Failed to parse JSON file');
                    setUploading(false);
                }
            };
            reader.readAsText(file);
            return;
        }
        
        // CSV file
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: async (results) => {
                await processData(results.data);
            }
        });
    };
    
    const processData = async (data) => {
        const entities = [];
        
        data.forEach(row => {
            const norm = {};
            Object.keys(row).forEach(k => { norm[normalize(k)] = row[k]; });
            
            const lat = parseFloat(norm.lat || norm.latitude || norm.y || row.Lat || row.Latitude);
            const lng = parseFloat(norm.lng || norm.lon || norm.long || norm.longitude || norm.x || row.Lng || row.Long || row.Longitude);
            
            if (isNaN(lat) || isNaN(lng)) return;
            
            const houseNumber = parseInt(norm.housenumber || norm.number || norm.streetnumber || row.HouseNumber || 0);
            const streetName = norm.streetname || norm.street || row.StreetName || row.Street || 'Unknown';
            const fullAddress = norm.fulladdress || norm.address || row.FullAddress || row.Address || `${houseNumber} ${streetName}`;
            
            let hash = norm.addresshash || norm.id || norm.hash || row.ID;
            if (!hash) {
                hash = btoa(`${streetName}-${houseNumber}-${lat}-${lng}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
            }
            
            entities.push({
                address_hash: String(hash),
                house_number: houseNumber,
                street_name: streetName,
                full_address: fullAddress,
                lat, lng,
                original_status: (norm.originalstatus || norm.status || row.Status || 'ELIGIBLE').toUpperCase()
            });
        });
        
        if (entities.length === 0) {
            alert('No valid rows found. Ensure your data has lat/lng columns.');
            setUploading(false);
            return;
        }
        
        try {
            const BATCH = 500;
            for (let i = 0; i < entities.length; i += BATCH) {
                await base44.entities.MasterProperty.bulkCreate(entities.slice(i, i + BATCH));
            }
            queryClient.invalidateQueries({ queryKey: ['properties'] });
            alert(`Imported ${entities.length} properties`);
        } catch (err) {
            alert('Import failed');
        }
        
        setUploading(false);
    };
    
    return (
        <div>
            <input type="file" accept=".csv,.json" onChange={handleFile} className="hidden" id="csv-upload" disabled={uploading} />
            <label htmlFor="csv-upload">
                <Button variant="outline" className="bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 gap-2" asChild disabled={uploading}>
                    <span>
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                        {uploading ? 'Importing...' : 'Import CSV'}
                    </span>
                </Button>
            </label>
        </div>
    );
}