import React from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import CsvUploader from '../components/dashboard/CsvUploader';
import SyncManager from '../components/dashboard/SyncManager';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Database, Upload, Download } from 'lucide-react';

export default function SyncPage() {
    // Fetch Logs for SyncManager
    const { data: logs } = useQuery({
        queryKey: ['interactionLogs'],
        queryFn: () => base44.entities.InteractionLog.list({limit: 5000, sort: {created_date: -1}}),
        initialData: []
    });

    return (
        <div className="h-full bg-slate-900 p-6 overflow-auto">
            <h1 className="text-2xl font-bold text-white mb-6">Data Sync</h1>
            
            <div className="space-y-6 max-w-md mx-auto">
                <Card className="bg-slate-800 border-slate-700">
                    <CardHeader>
                        <CardTitle className="text-white flex items-center gap-2">
                            <Upload className="w-5 h-5 text-indigo-400" />
                            Import Data
                        </CardTitle>
                        <CardDescription className="text-slate-400">
                            Upload a CSV or JSON file to update property records.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <CsvUploader />
                    </CardContent>
                </Card>

                <Card className="bg-slate-800 border-slate-700">
                    <CardHeader>
                        <CardTitle className="text-white flex items-center gap-2">
                            <Download className="w-5 h-5 text-green-400" />
                            Export Activity
                        </CardTitle>
                        <CardDescription className="text-slate-400">
                            Download your field activity logs from the last 24 hours.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex justify-start">
                            <SyncManager logs={logs} />
                        </div>
                    </CardContent>
                </Card>

                <div className="mt-8 text-center">
                    <p className="text-xs text-slate-500">
                        Local Database Status: <span className="text-green-500 font-bold">Active</span>
                    </p>
                    <p className="text-xs text-slate-600 mt-1">
                        Version 1.0.4 (Offline-First)
                    </p>
                </div>
            </div>
        </div>
    );
}