import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Map, Upload, Download, Database, FileSpreadsheet, MapPin, ArrowRight } from 'lucide-react';
import CsvUploader from '../components/dashboard/CsvUploader';
import TerritoryFilter from '../components/setup/TerritoryFilter';
import BetaUsageMeter from '../components/beta/BetaUsageMeter';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { storage } from '@/lib/storage';

export default function Setup() {
    const navigate = useNavigate();
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    const { data: userProperties = [], isLoading } = useQuery({
        queryKey: ['masterProperties', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 10000);
            return Array.isArray(result) ? result : (result?.items || []);
        },
        enabled: !!user?.email
    });

    const { data: fallbackProperties = [] } = useQuery({
        queryKey: ['masterProperties', 'fallback'],
        queryFn: async () => {
            const result = await base44.entities.MasterProperty.filter({ created_by: 'unknown@user.local' }, '-created_date', 10000);
            return Array.isArray(result) ? result : (result?.items || []);
        }
    });

    const { data: localProperties = [] } = useQuery({
        queryKey: ['localProperties'],
        queryFn: async () => await storage.getProperties(),
    });

    const properties = useMemo(() => {
        const combined = [...userProperties, ...fallbackProperties, ...localProperties];
        const seen = new Set();
        return combined.filter(p => {
            if (!p?.address_hash || seen.has(p.address_hash)) return false;
            seen.add(p.address_hash);
            return true;
        });
    }, [userProperties, fallbackProperties, localProperties]);

    const handleContinue = () => navigate(createPageUrl('Home'));

    const handleExport = () => {
        if (properties.length === 0) { alert("No data to export"); return; }
        const headers = Object.keys(properties[0]).join(',');
        const rows = properties.map(p => Object.values(p).map(v => `"${v}"`).join(',')).join('\n');
        const csvContent = "data:text/csv;charset=utf-8," + headers + "\n" + rows;
        const link = document.createElement("a");
        link.setAttribute("href", encodeURI(csvContent));
        link.setAttribute("download", `property_export_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const [activeTab, setActiveTab] = React.useState('territory');

    const tabs = [
        { id: 'territory', label: 'Territory' },
        { id: 'import', label: 'Import' },
    ];

    return (
        <div className="h-full overflow-auto bg-[#09090b] text-white pb-24">
            <div className="max-w-2xl w-full mx-auto p-4 md:p-6 space-y-5">

                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-black tracking-tight text-white">Data Center</h1>
                        <p className="text-sm text-gray-500 mt-0.5">Manage territory data and imports</p>
                    </div>
                    <Button onClick={handleContinue} className="bg-white text-black font-bold hover:bg-gray-200 rounded-xl h-10 px-5 text-xs gap-2">
                        Map <ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                </div>

                {/* Quick stats */}
                <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-4">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">Records</span>
                            <Database className="w-3.5 h-3.5 text-green-400" />
                        </div>
                        <div className="text-2xl font-black text-white">{isLoading ? '...' : properties.length.toLocaleString()}</div>
                        <p className="text-[10px] text-gray-500 mt-1">in database</p>
                    </div>
                    <button onClick={handleExport} className="rounded-2xl border border-white/[0.06] bg-[#111113] p-4 text-left hover:bg-white/[0.04] transition-colors group">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">Export</span>
                            <Download className="w-3.5 h-3.5 text-blue-400 group-hover:text-blue-300" />
                        </div>
                        <div className="text-sm font-bold text-white">Download CSV</div>
                        <p className="text-[10px] text-gray-500 mt-1">backup all data</p>
                    </button>
                </div>

                {/* Pull from map CTA */}
                <div className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-[#111113] to-[#0d0d12] p-5 relative overflow-hidden">
                    <div className="absolute -top-16 -right-16 w-40 h-40 bg-yellow-500/5 blur-[60px] rounded-full pointer-events-none" />
                    <div className="relative z-10 flex items-start gap-4">
                        <div className="w-10 h-10 rounded-xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center shrink-0">
                            <Map className="w-5 h-5 text-yellow-400" />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-sm font-bold text-white mb-1">Pull Data From Map</h3>
                            <p className="text-xs text-gray-500 mb-3">Draw your territory on the map and pull all properties instantly — no spreadsheet needed.</p>
                            <Button onClick={handleContinue} className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-9 px-5 rounded-xl text-xs">
                                Go Draw Territory
                            </Button>
                        </div>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 p-1 bg-white/[0.03] rounded-xl border border-white/[0.05]">
                    {tabs.map(t => (
                        <button key={t.id} onClick={() => setActiveTab(t.id)}
                            className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === t.id ? 'bg-white text-black' : 'text-gray-500 hover:text-white hover:bg-white/5'}`}
                        >{t.label}</button>
                    ))}
                </div>

                {/* Tab Content */}
                {activeTab === 'territory' && (
                    <div className="space-y-4">
                        <TerritoryFilter user={user} properties={properties} />
                        <BetaUsageMeter />
                    </div>
                )}

                {activeTab === 'import' && (
                    <div className="space-y-4">
                        <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-5">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-9 h-9 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center">
                                    <FileSpreadsheet className="w-4 h-4 text-green-400" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-white">Import from CSV / JSON</h3>
                                    <p className="text-[11px] text-gray-500">SalesRabbit, Spotio, Redfin, or custom exports</p>
                                </div>
                            </div>
                            <CsvUploader />
                        </div>
                    </div>
                )}

            </div>
        </div>
    );
}