import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from 'lucide-react';
import Papa from 'papaparse';
import moment from 'moment';

export default function SyncManager({ logs }) {
    const [isExporting, setIsExporting] = useState(false);

    const handleSync = async () => {
        setIsExporting(true);
        try {
            // Filter logs for last 24 hours
            const yesterday = moment().subtract(24, 'hours');
            const recentLogs = logs.filter(log => moment(log.created_date).isAfter(yesterday));

            if (recentLogs.length === 0) {
                alert("No interactions recorded in the last 24 hours to sync.");
                setIsExporting(false);
                return;
            }

            // Prepare CSV Data
            const csvData = recentLogs.map(log => ({
                InteractionID: log.id,
                AddressHash: log.address_hash,
                Timestamp: log.created_date,
                InputText: log.raw_input_text,
                Status: log.parsed_status,
                GPS_Lat: log.gps_proof_lat,
                GPS_Lng: log.gps_proof_lng,
                NextEligible: log.next_eligible_date
            }));

            const csv = Papa.unparse(csvData);
            
            // Trigger Download
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `Results_${moment().format('YYYY-MM-DD')}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            // Simulating "Push" to server (in this case it's just local download as per "Offline-first" / CSV centric workflow)
            // But we could also call an API here if backend functions were enabled for cloud sync.

            alert(`Synced! Exported ${recentLogs.length} records.`);
        } catch (err) {
            console.error(err);
            alert("Sync failed.");
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <Button 
            variant="outline" 
            className="bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white gap-2"
            onClick={handleSync}
            disabled={isExporting}
        >
            {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            <span>{isExporting ? 'Syncing...' : 'Sync (24h)'}</span>
        </Button>
    );
}