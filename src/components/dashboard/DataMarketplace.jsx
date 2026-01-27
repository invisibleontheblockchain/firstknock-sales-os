import React from 'react';
import { Upload, FileJson, FileSpreadsheet, Info } from 'lucide-react';

export default function DataMarketplace() {
    return (
        <div className="space-y-6">
            <div className="bg-[#151515] p-6 rounded-xl border border-[#333]">
                <div className="flex items-center gap-4 mb-6">
                    <div className="w-12 h-12 bg-yellow-500 rounded-lg flex items-center justify-center shadow-lg shadow-yellow-900/20">
                        <Upload className="w-6 h-6 text-black" />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white">Import Your Data</h3>
                        <p className="text-gray-400 text-sm">Upload property data from CSV or JSON files.</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* CSV Upload */}
                    <div className="p-6 bg-[#0A0A0A] border border-[#333] rounded-xl hover:border-yellow-500/50 transition-colors">
                        <div className="flex items-center gap-3 mb-3">
                            <FileSpreadsheet className="w-8 h-8 text-green-500" />
                            <div>
                                <h4 className="font-bold text-white">CSV Upload</h4>
                                <p className="text-xs text-gray-500">Spreadsheet format</p>
                            </div>
                        </div>
                        <p className="text-sm text-gray-400 mb-4">
                            Upload a CSV file with columns: address, city, state, zip, beds, baths, sqft, price, sold_date
                        </p>
                        <p className="text-xs text-gray-600">
                            Use the CSV Uploader tab above to import your data.
                        </p>
                    </div>

                    {/* JSON Upload */}
                    <div className="p-6 bg-[#0A0A0A] border border-[#333] rounded-xl hover:border-yellow-500/50 transition-colors">
                        <div className="flex items-center gap-3 mb-3">
                            <FileJson className="w-8 h-8 text-blue-500" />
                            <div>
                                <h4 className="font-bold text-white">JSON Upload</h4>
                                <p className="text-xs text-gray-500">Structured data format</p>
                            </div>
                        </div>
                        <p className="text-sm text-gray-400 mb-4">
                            Upload a JSON array of property objects with standard fields.
                        </p>
                        <p className="text-xs text-gray-600">
                            Use the CSV Uploader tab above - it also supports JSON files.
                        </p>
                    </div>
                </div>

                <div className="mt-6 p-4 bg-yellow-900/20 border border-yellow-900/50 rounded-lg flex gap-3">
                    <Info className="w-5 h-5 text-yellow-400 flex-shrink-0" />
                    <div>
                        <h5 className="text-yellow-400 font-bold text-sm">On-Demand Generation</h5>
                        <p className="text-yellow-200/70 text-xs mt-1">
                            You can also generate property data instantly by searching any zip code in the Route Generator. 
                            Properties are created on-the-fly without using database storage.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}