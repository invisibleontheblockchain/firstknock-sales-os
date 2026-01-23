import React, { useState } from 'react';
import { Search, Map, Check, AlertCircle, ShoppingCart, Globe, Locate, Database, Server, Signal } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { base44 } from '@/api/base44Client';
import { useMutation } from "@tanstack/react-query";

const MOCK_REGIONS = [
    { id: 999, name: "Test County (Pipeline Demo)", count: 5000, price: "Free (Test)", status: "available" },
    { id: 'ca-la', name: 'Los Angeles County, CA', count: 2450000, price: '$0.00 (Public)', status: 'available' },
    { id: 'ca-oc', name: 'Orange County, CA', count: 980000, price: '$0.00 (Public)', status: 'available' },
    { id: 'tx-harris', name: 'Harris County, TX', count: 1200000, price: '$0.00 (Public)', status: 'available' },
    { id: 'fl-miami', name: 'Miami-Dade County, FL', count: 890000, price: '$0.00 (Public)', status: 'available' },
    { id: 'ny-kings', name: 'Kings County (Brooklyn), NY', count: 750000, price: '$0.00 (Public)', status: 'available' },
    { id: 'il-cook', name: 'Cook County, IL', count: 1800000, price: '$0.00 (Public)', status: 'available' },
    { id: 'az-maricopa', name: 'Maricopa County, AZ', count: 1600000, price: '$0.00 (Public)', status: 'available' },
];

export default function DataMarketplace() {
    const [searchTerm, setSearchTerm] = useState('');
    const [subscribedRegions, setSubscribedRegions] = useState(new Set());
    const [loading, setLoading] = useState(false);
    const [locating, setLocating] = useState(false);

    // Mock Live Stream Data
    const [liveFeed, setLiveFeed] = useState([
        { id: 1, text: "New Deed Recorded: 123 Maple Dr, Dallas TX", time: "2s ago" },
        { id: 2, text: "Property Sold: 4500 Ocean Blvd, Miami FL", time: "5s ago" },
        { id: 3, text: "New Build Permit: 88 Industrial Way, Phoenix AZ", time: "12s ago" },
        { id: 4, text: "Foreclosure Filing: 77 Oak St, Las Vegas NV", time: "8s ago" },
    ]);

    const handleLocateMe = () => {
        setLocating(true);
        // Simulate geo-location and matching to a county
        setTimeout(() => {
            setSearchTerm("Test County"); // Auto-select the demo county
            setLocating(false);
        }, 1200);
    };

    const subscribeMutation = useMutation({
        mutationFn: async (regionId) => {
            // If it's the Test County, actually run the simulated pipeline
            if (regionId === 999) {
                // Dynamic import to avoid bundling backend logic in frontend bundle (conceptually)
                const { runIngestionPipeline } = await import('@/functions/pipeline/ingestCounty');
                await runIngestionPipeline('TEST_COUNTY');
                return regionId;
            }
            
            // Mock API call for others
            await new Promise(resolve => setTimeout(resolve, 1500));
            return regionId;
        },
        onSuccess: (regionId) => {
            setSubscribedRegions(prev => new Set(prev).add(regionId));
            // In a real app, this would trigger a backend sync job
            // For now, we simulate success
            if (regionId === 999) {
                // Reload page or invalidate queries to show new data
                window.location.reload(); 
            }
        }
    });

    const filteredRegions = MOCK_REGIONS.filter(r => 
        r.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="space-y-6">
            {/* National Database Status Banner */}
            <div className="bg-gradient-to-r from-slate-900 to-slate-950 p-6 rounded-xl border border-slate-800 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-5">
                    <Database className="w-64 h-64 text-blue-500" />
                </div>
                <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
                    <div className="flex items-start gap-4">
                        <div className="w-12 h-12 bg-blue-500/20 rounded-xl flex items-center justify-center border border-blue-500/30">
                            <Server className="w-6 h-6 text-blue-400" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white mb-1">National Master Database</h2>
                            <p className="text-sm text-slate-400 max-w-lg">
                                We maintain an active, real-time index of every new home buyer in the United States. 
                                Connect to specific county feeds to sync local data to your territory.
                            </p>
                            <div className="flex gap-4 mt-3 text-xs font-mono text-slate-500">
                                <span className="flex items-center gap-1"><Check className="w-3 h-3 text-green-500" /> 3,143 COUNTIES</span>
                                <span className="flex items-center gap-1"><Check className="w-3 h-3 text-green-500" /> 158M+ PROPERTIES</span>
                                <span className="flex items-center gap-1 text-blue-400"><Signal className="w-3 h-3 animate-pulse" /> LIVE STREAMING</span>
                            </div>
                        </div>
                    </div>
                    <div className="text-right hidden md:block">
                        <div className="text-3xl font-bold text-white tabular-nums tracking-tight">14,205,100</div>
                        <div className="text-xs font-bold text-slate-500 tracking-widest uppercase">New Buyers (2025-26)</div>
                    </div>
                </div>
            </div>

            {/* Live Feed Ticker */}
            <div className="bg-black/50 border border-green-900/30 rounded-lg p-3 flex items-center gap-3 overflow-hidden">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse flex-shrink-0" />
                <span className="text-xs font-bold text-green-500 whitespace-nowrap">LIVE TRANSACTION FEED:</span>
                <div className="flex gap-8 overflow-hidden w-full mask-linear-fade">
                    {liveFeed.map(item => (
                        <span key={item.id} className="text-xs text-gray-400 whitespace-nowrap flex items-center gap-2">
                            {item.text} <span className="text-[10px] text-gray-600">({item.time})</span>
                        </span>
                    ))}
                </div>
            </div>

            <div className="bg-[#151515] p-6 rounded-xl border border-[#333]">
                <div className="flex items-center gap-4 mb-6">
                    <div className="w-12 h-12 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-900/20">
                        <Globe className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white">Territory Connection</h3>
                        <p className="text-gray-400 text-sm">Search or auto-detect your location to subscribe to the relevant data feed.</p>
                    </div>
                </div>

                <div className="flex gap-3 mb-6">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-3 w-5 h-5 text-gray-500" />
                        <input
                            type="text"
                            placeholder="Search by County, State, or Zip Code..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full bg-[#0A0A0A] border border-[#333] text-white rounded-lg py-3 pl-10 pr-4 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                        />
                    </div>
                    <Button 
                        onClick={handleLocateMe}
                        disabled={locating}
                        className="h-full bg-[#222] hover:bg-[#333] text-white border border-[#333]"
                    >
                        {locating ? (
                            <span className="animate-pulse">Locating...</span>
                        ) : (
                            <>
                                <Locate className="w-4 h-4 mr-2" />
                                Detect My County
                            </>
                        )}
                    </Button>
                </div>

                <div className="space-y-3">
                    {filteredRegions.map(region => {
                        const isSubscribed = subscribedRegions.has(region.id);
                        return (
                            <div 
                                key={region.id}
                                className="flex items-center justify-between p-4 bg-[#0A0A0A] border border-[#222] rounded-lg hover:border-[#444] transition-colors"
                            >
                                <div className="flex items-center gap-3">
                                    <Map className="w-5 h-5 text-gray-500" />
                                    <div>
                                        <h4 className="font-bold text-white text-sm">{region.name}</h4>
                                        <p className="text-xs text-gray-500">{region.count.toLocaleString()} properties • Updated daily</p>
                                    </div>
                                </div>
                                
                                {isSubscribed ? (
                                    <Badge className="bg-green-500/10 text-green-500 border-green-500/50 hover:bg-green-500/20">
                                        <Check className="w-3 h-3 mr-1" />
                                        CONNECTED
                                    </Badge>
                                ) : (
                                    <Button
                                        size="sm"
                                        onClick={() => subscribeMutation.mutate(region.id)}
                                        disabled={subscribeMutation.isPending}
                                        className="bg-[#222] hover:bg-blue-600 text-white font-bold text-xs"
                                    >
                                        {subscribeMutation.isPending && subscribeMutation.variables === region.id ? 'CONNECTING...' : 'CONNECT FEED'}
                                    </Button>
                                )}
                            </div>
                        );
                    })}
                    
                    {filteredRegions.length === 0 && (
                        <div className="text-center py-8 text-gray-500">
                            No regions found matching "{searchTerm}"
                        </div>
                    )}
                </div>

                <div className="mt-6 p-4 bg-blue-900/20 border border-blue-900/50 rounded-lg flex gap-3">
                    <AlertCircle className="w-5 h-5 text-blue-400 flex-shrink-0" />
                    <div>
                        <h5 className="text-blue-400 font-bold text-sm">Pro Tip: Data Streaming</h5>
                        <p className="text-blue-200/70 text-xs mt-1">
                            Connecting a National Feed will enable "Live Mode" on your map. 
                            Properties will stream in as you pan the map based on your view.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}