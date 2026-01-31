import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Upload, Download, Database } from 'lucide-react';
import CsvUploader from '../components/dashboard/CsvUploader';
import DataMarketplace from '../components/dashboard/DataMarketplace';
import TerritoryFilter from '../components/setup/TerritoryFilter';
import IngestionTools from '../components/admin/IngestionTools';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { storage } from '@/lib/storage';

export default function Setup() {
    const navigate = useNavigate();
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    // User-specific properties
    const { data: userProperties = [], isLoading } = useQuery({
        queryKey: ['masterProperties', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 10000);
            return Array.isArray(result) ? result : (result?.items || []);
        },
        enabled: !!user?.email
    });

    // Fallback for mobile auth
    const { data: fallbackProperties = [] } = useQuery({
        queryKey: ['masterProperties', 'fallback'],
        queryFn: async () => {
            const result = await base44.entities.MasterProperty.filter({ created_by: 'unknown@user.local' }, '-created_date', 10000);
            return Array.isArray(result) ? result : (result?.items || []);
        }
    });

    // Local Storage query (Offline support)
    const { data: localProperties = [] } = useQuery({
        queryKey: ['localProperties'],
        queryFn: async () => {
            return await storage.getProperties();
        }
    });

    // Combine and deduplicate
    const properties = useMemo(() => {
        const combined = [...userProperties, ...fallbackProperties, ...localProperties];
        const seen = new Set();
        return combined.filter(p => {
            if (!p?.address_hash || seen.has(p.address_hash)) return false;
            seen.add(p.address_hash);
            return true;
        });
    }, [userProperties, fallbackProperties, localProperties]);


    const handleContinue = () => {
        navigate(createPageUrl('Home'));
    };

    const [activeTab, setActiveTab] = React.useState('upload');

    const handleExport = () => {
        if (properties.length === 0) {
            alert("No data to export");
            return;
        }
        const headers = Object.keys(properties[0]).join(',');
        const rows = properties.map(p => Object.values(p).map(v => `"${v}"`).join(',')).join('\n');
        const csvContent = "data:text/csv;charset=utf-8," + headers + "\n" + rows;
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `property_export_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    return (
        <div className="h-full overflow-auto bg-black text-white p-4 pb-8">
            <div className="max-w-2xl w-full mx-auto bg-[#111] p-5 rounded-2xl border border-[#222] shadow-2xl">
                <div className="text-center space-y-3 mb-6">
                    <div className="flex justify-center">
                        <div className="w-14 h-14 bg-yellow-500 rounded-2xl flex items-center justify-center shadow-[0_0_20px_rgba(255,215,0,0.3)]">
                            <Upload className="w-7 h-7 text-black" />
                        </div>
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">Data Center</h1>
                    <p className="text-gray-400 text-sm max-w-sm mx-auto">
                        Manage your territory data. Upload lists or connect to national feeds.
                    </p>
                </div>

                <div className="flex p-1 bg-[#0A0A0A] rounded-lg mb-6 border border-[#222]">
                    <button
                        onClick={() => setActiveTab('upload')}
                        className={`flex-1 py-2 text-sm font-bold rounded-md transition-colors ${activeTab === 'upload' ? 'bg-[#222] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        My Uploads
                    </button>
                    <button
                        onClick={() => setActiveTab('marketplace')}
                        className={`flex-1 py-2 text-sm font-bold rounded-md transition-colors ${activeTab === 'marketplace' ? 'bg-[#222] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        National Feeds
                    </button>
                </div>

                <div className="space-y-4">
                    {activeTab === 'upload' ? (
                        <>
                            <div className="p-4 rounded-xl bg-[#0A0A0A] border border-[#222]">
                                <h3 className="text-base font-bold text-white mb-1">Upload New List</h3>
                                <p className="text-xs text-gray-500 mb-3">CSV, JSON. Merges with existing records.</p>
                                <CsvUploader />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 rounded-xl bg-[#0A0A0A] border border-[#222]">
                                    <h4 className="text-white font-bold flex items-center gap-2 text-sm">
                                        <Database className="w-4 h-4 text-green-500" />
                                        {isLoading ? '...' : properties.length.toLocaleString()} Records
                                    </h4>
                                    <p className="text-xs text-gray-500 mt-1">Saved in database</p>
                                </div>
                                <button
                                    onClick={handleExport}
                                    className="p-3 rounded-xl bg-[#0A0A0A] border border-[#222] text-left hover:bg-[#151515] transition-colors"
                                >
                                    <h4 className="text-white font-bold flex items-center gap-2 text-sm">
                                        <Download className="w-4 h-4 text-blue-500" />
                                        Export Data
                                    </h4>
                                    <p className="text-xs text-gray-500 mt-1">Download backup</p>
                                </button>
                            </div>

                            {/* Territory Filter */}
                            <TerritoryFilter user={user} properties={properties} />
                        </>
                    ) : (
                        <DataMarketplace />
                    )}

                    <Button
                        onClick={handleContinue}
                        className="w-full h-12 text-base bg-yellow-500 text-black font-bold hover:bg-yellow-400 rounded-xl mt-4"
                    >
                        GO TO MAP
                    </Button>
                </div>
            </div>
        </div>
    );
}