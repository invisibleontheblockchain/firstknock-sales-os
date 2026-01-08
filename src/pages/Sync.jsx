import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, Download, Trash2, Loader2, Database } from 'lucide-react';
import CsvImporter from '../components/CsvImporter';
import Papa from 'papaparse';
import moment from 'moment';

export default function Sync() {
    const [exporting, setExporting] = useState(false);
    const [clearing, setClearing] = useState(false);
    const queryClient = useQueryClient();
    
    const { data: properties = [] } = useQuery({
        queryKey: ['properties'],
        queryFn: () => base44.entities.MasterProperty.list('-created_date', 5000)
    });
    
    const { data: results = [] } = useQuery({
        queryKey: ['results'],
        queryFn: () => base44.entities.DailyResult.list('-created_date', 5000)
    });
    
    const handleExport = () => {
        setExporting(true);
        
        // Export last 24 hours
        const cutoff = moment().subtract(24, 'hours');
        const recent = results.filter(r => moment(r.date_visited).isAfter(cutoff));
        
        if (recent.length === 0) {
            alert('No activity in the last 24 hours');
            setExporting(false);
            return;
        }
        
        const csv = Papa.unparse(recent);
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `activity_${moment().format('YYYY-MM-DD')}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        
        setExporting(false);
    };
    
    const handleClearAll = async () => {
        if (!confirm('Delete ALL properties and results? This cannot be undone.')) return;
        
        setClearing(true);
        try {
            // Delete in batches
            const propIds = properties.map(p => p.id);
            const resultIds = results.map(r => r.id);
            
            for (const id of propIds) {
                await base44.entities.MasterProperty.delete(id);
            }
            for (const id of resultIds) {
                await base44.entities.DailyResult.delete(id);
            }
            
            queryClient.invalidateQueries({ queryKey: ['properties'] });
            queryClient.invalidateQueries({ queryKey: ['results'] });
            alert('All data cleared');
        } catch (err) {
            alert('Failed to clear data');
        }
        setClearing(false);
    };
    
    return (
        <div className="h-full bg-slate-900 p-4 overflow-y-auto">
            <h1 className="text-xl font-bold text-white mb-4">Data Sync</h1>
            
            <div className="space-y-4 max-w-md mx-auto">
                {/* Import */}
                <Card className="bg-slate-800 border-slate-700">
                    <CardHeader>
                        <CardTitle className="text-white flex items-center gap-2">
                            <Upload className="w-5 h-5 text-indigo-400" />
                            Import Properties
                        </CardTitle>
                        <CardDescription className="text-slate-400">
                            Upload CSV or JSON with property data
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <CsvImporter />
                    </CardContent>
                </Card>
                
                {/* Export */}
                <Card className="bg-slate-800 border-slate-700">
                    <CardHeader>
                        <CardTitle className="text-white flex items-center gap-2">
                            <Download className="w-5 h-5 text-green-400" />
                            Export Activity
                        </CardTitle>
                        <CardDescription className="text-slate-400">
                            Download results from the last 24 hours
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button 
                            variant="outline" 
                            className="bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-700 gap-2"
                            onClick={handleExport}
                            disabled={exporting}
                        >
                            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                            Export CSV
                        </Button>
                    </CardContent>
                </Card>
                
                {/* Clear */}
                <Card className="bg-slate-800 border-slate-700">
                    <CardHeader>
                        <CardTitle className="text-white flex items-center gap-2">
                            <Trash2 className="w-5 h-5 text-red-400" />
                            Clear All Data
                        </CardTitle>
                        <CardDescription className="text-slate-400">
                            Remove all properties and results
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button 
                            variant="destructive" 
                            className="gap-2"
                            onClick={handleClearAll}
                            disabled={clearing}
                        >
                            {clearing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                            Clear Everything
                        </Button>
                    </CardContent>
                </Card>
                
                {/* Stats */}
                <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
                    <div className="flex items-center gap-2 mb-3">
                        <Database className="w-4 h-4 text-slate-500" />
                        <span className="text-sm text-slate-400 font-medium">Database Stats</span>
                    </div>
                    <div className="grid grid-cols-2 gap-4 text-center">
                        <div>
                            <div className="text-2xl font-bold text-white">{properties.length}</div>
                            <div className="text-xs text-slate-500">Properties</div>
                        </div>
                        <div>
                            <div className="text-2xl font-bold text-white">{results.length}</div>
                            <div className="text-xs text-slate-500">Results</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}