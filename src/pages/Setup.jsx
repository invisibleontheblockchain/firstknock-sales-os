import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Map, Download, Database, FileSpreadsheet, ArrowRight, Rocket, Check, Clock, DollarSign } from 'lucide-react';
import CsvUploader from '../components/dashboard/CsvUploader';
import TerritoryFilter from '../components/setup/TerritoryFilter';
import BetaUsageMeter from '../components/beta/BetaUsageMeter';
import CompetitorSwitchBanner from '../components/setup/CompetitorSwitchBanner';
import ImportGuide from '../components/setup/ImportGuide';
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
        { id: 'import', label: 'Import Data' },
        { id: 'switch', label: '🔥 Switch Tool' },
    ];

    return (
        <div className="h-full overflow-auto bg-[#09090b] text-white pb-24">
            <div className="max-w-4xl w-full mx-auto p-4 md:p-8 space-y-6">

                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl md:text-3xl font-black tracking-tight text-white">Setup & Data Center</h1>
                        <p className="text-sm md:text-base text-gray-500 mt-1">Your territory, your data, your advantage</p>
                    </div>
                    <Button onClick={handleContinue} className="bg-white text-black font-bold hover:bg-gray-200 rounded-xl h-10 md:h-11 px-5 md:px-6 text-xs md:text-sm gap-2">
                        Map <ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                </div>

                {/* Quick stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <StatCard label="Records" value={isLoading ? '...' : properties.length.toLocaleString()} sub="in database" icon={Database} color="text-green-400" />
                    <button onClick={handleExport} className="rounded-2xl border border-white/[0.06] bg-[#111113] p-4 text-left hover:bg-white/[0.04] transition-colors group">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] md:text-[11px] font-semibold uppercase tracking-[0.15em] text-gray-500">Export</span>
                            <Download className="w-3.5 h-3.5 md:w-4 md:h-4 text-blue-400 group-hover:text-blue-300" />
                        </div>
                        <div className="text-sm md:text-base font-bold text-white">Download CSV</div>
                        <p className="text-[10px] md:text-[11px] text-gray-500 mt-1">backup all data</p>
                    </button>
                    <StatCard label="Setup" value="3 min" sub="avg onboarding" icon={Clock} color="text-yellow-400" />
                    <StatCard label="Savings" value="60%" sub="vs competitors" icon={DollarSign} color="text-purple-400" />
                </div>

                {/* Pull from map CTA */}
                <div className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-[#111113] to-[#0d0d12] p-5 md:p-7 relative overflow-hidden">
                    <div className="absolute -top-16 -right-16 w-40 h-40 bg-yellow-500/5 blur-[60px] rounded-full pointer-events-none" />
                    <div className="relative z-10 flex items-start gap-4">
                        <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center shrink-0">
                            <Map className="w-5 h-5 md:w-6 md:h-6 text-yellow-400" />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-sm md:text-lg font-bold text-white mb-1">Pull Data Instantly From Map</h3>
                            <p className="text-xs md:text-sm text-gray-500 mb-3">Draw your territory on the map and pull every property record — no spreadsheet, no manual entry. Just draw and go.</p>
                            <Button onClick={handleContinue} className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-9 md:h-10 px-5 rounded-xl text-xs md:text-sm">
                                <Rocket className="w-4 h-4 mr-1.5" /> Go Draw Territory
                            </Button>
                        </div>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 p-1 md:p-1.5 bg-white/[0.03] rounded-xl border border-white/[0.05]">
                    {tabs.map(t => (
                        <button key={t.id} onClick={() => setActiveTab(t.id)}
                            className={`flex-1 py-2 md:py-2.5 rounded-lg text-xs md:text-sm font-bold transition-all ${activeTab === t.id ? 'bg-white text-black' : 'text-gray-500 hover:text-white hover:bg-white/5'}`}
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
                    <div className="space-y-5">
                        <ImportGuide />
                        <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-5 md:p-7">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center">
                                    <FileSpreadsheet className="w-4 h-4 md:w-5 md:h-5 text-green-400" />
                                </div>
                                <div>
                                    <h3 className="text-sm md:text-base font-bold text-white">Upload Your File</h3>
                                    <p className="text-[11px] md:text-xs text-gray-500">CSV or JSON from any source — we'll auto-detect columns</p>
                                </div>
                            </div>
                            <CsvUploader />
                        </div>
                    </div>
                )}

                {activeTab === 'switch' && (
                    <div className="space-y-5">
                        <CompetitorSwitchBanner />

                        {/* Quick comparison table */}
                        <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-5 md:p-7">
                            <h3 className="text-base md:text-lg font-bold text-white mb-4">Why reps choose FirstKnock</h3>
                            <div className="space-y-2">
                                <CompareRow feature="Smart Route Optimization" us={true} them={false} />
                                <CompareRow feature="Real-Time Sold Data" us={true} them={false} />
                                <CompareRow feature="Territory Heatmaps" us={true} them={false} />
                                <CompareRow feature="One-Click CSV Import" us={true} them={true} />
                                <CompareRow feature="AI Lead Scoring" us={true} them={false} />
                                <CompareRow feature="Team Chat Built-In" us={true} them={false} />
                                <CompareRow feature="Starts at $49/mo" us={true} them={false} />
                            </div>
                        </div>

                        {/* CTA */}
                        <div className="rounded-2xl bg-gradient-to-r from-purple-600/20 to-blue-600/20 border border-purple-500/20 p-5 md:p-7 text-center">
                            <h3 className="text-lg md:text-xl font-black text-white mb-2">Ready to make the switch?</h3>
                            <p className="text-sm text-gray-400 mb-4">Import your data in 30 seconds. No contracts, cancel anytime.</p>
                            <Button onClick={() => setActiveTab('import')} className="bg-white text-black font-bold h-10 md:h-11 px-6 md:px-8 rounded-xl text-sm gap-2">
                                <Rocket className="w-4 h-4" /> Import My Data Now
                            </Button>
                        </div>
                    </div>
                )}

            </div>
        </div>
    );
}

function StatCard({ label, value, sub, icon: Icon, color }) {
    return (
        <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-4">
            <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] md:text-[11px] font-semibold uppercase tracking-[0.15em] text-gray-500">{label}</span>
                <Icon className={`w-3.5 h-3.5 md:w-4 md:h-4 ${color}`} />
            </div>
            <div className="text-xl md:text-2xl font-black text-white">{value}</div>
            <p className="text-[10px] md:text-[11px] text-gray-500 mt-1">{sub}</p>
        </div>
    );
}

function CompareRow({ feature, us, them }) {
    return (
        <div className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-white/[0.02] border border-white/[0.03]">
            <span className="text-xs md:text-sm text-gray-300 font-medium">{feature}</span>
            <div className="flex items-center gap-6 md:gap-10">
                <div className="flex flex-col items-center w-16">
                    {us ? (
                        <Check className="w-4 h-4 text-green-400" />
                    ) : (
                        <span className="text-red-500 text-sm">✕</span>
                    )}
                    <span className="text-[8px] text-gray-600 mt-0.5">FirstKnock</span>
                </div>
                <div className="flex flex-col items-center w-16">
                    {them ? (
                        <Check className="w-4 h-4 text-gray-500" />
                    ) : (
                        <span className="text-red-500 text-sm">✕</span>
                    )}
                    <span className="text-[8px] text-gray-600 mt-0.5">Others</span>
                </div>
            </div>
        </div>
    );
}