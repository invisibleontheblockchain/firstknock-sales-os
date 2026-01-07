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
            complete: async (results) => {
                const data = results.data;
                const validRows = data.filter(row => row.lat && row.lng && row.address_hash);
                
                if (validRows.length === 0) {
                    alert("No valid rows found. Check CSV format.");
                    setIsUploading(false);
                    return;
                }

                // Transform to entity format
                const entities = validRows.map(row => ({
                    address_hash: row.address_hash,
                    house_number: parseInt(row.house_number) || 0,
                    street_name: row.street_name || '',
                    full_address: row.full_address || '',
                    lat: parseFloat(row.lat),
                    lng: parseFloat(row.lng),
                    original_status: row.original_status || 'ELIGIBLE'
                }));

                try {
                    // In a real app we might want to batch this or use a bulk endpoint
                    // For now, let's just do a bulk create (which is supported by base44 entities)
                    await base44.entities.MasterProperty.bulkCreate(entities);
                    queryClient.invalidateQueries(['masterProperties']);
                    alert(`Successfully imported ${entities.length} properties.`);
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