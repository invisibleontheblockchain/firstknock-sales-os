import React from 'react';
import { FileSpreadsheet, Upload, CheckCircle2, ArrowDown } from 'lucide-react';

const IMPORT_SOURCES = [
    { name: 'SalesRabbit', format: 'CSV', steps: 'Settings → Export → Download CSV' },
    { name: 'Spotio', format: 'CSV', steps: 'Reports → Export Pins → CSV' },
    { name: 'Redfin', format: 'CSV', steps: 'Search → Download All → CSV' },
    { name: 'Custom Spreadsheet', format: 'CSV/JSON', steps: 'Needs: Address, City, State, Zip' },
];

export default function ImportGuide() {
    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 mb-1">
                <FileSpreadsheet className="w-4 h-4 text-green-400" />
                <h3 className="text-sm font-bold text-white">Quick Import Guide</h3>
            </div>
            <p className="text-xs text-gray-500 mb-3">Export your data from your current tool, then drag it into the uploader below.</p>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {IMPORT_SOURCES.map((s, i) => (
                    <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:border-white/[0.1] transition-colors">
                        <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0 mt-0.5">
                            <Upload className="w-3.5 h-3.5 text-blue-400" />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <p className="text-xs font-bold text-white">{s.name}</p>
                                <span className="text-[9px] text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded-full">{s.format}</span>
                            </div>
                            <p className="text-[10px] text-gray-500 mt-0.5">{s.steps}</p>
                        </div>
                    </div>
                ))}
            </div>

            <div className="flex items-center justify-center gap-2 py-2 text-gray-600">
                <ArrowDown className="w-3 h-3 animate-bounce" />
                <span className="text-[10px] font-bold uppercase tracking-wider">Then upload below</span>
                <ArrowDown className="w-3 h-3 animate-bounce" />
            </div>
        </div>
    );
}