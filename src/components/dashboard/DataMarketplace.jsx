import React, { useState } from 'react';
import { Search, Map, Check, AlertCircle, ShoppingCart, Globe } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { base44 } from '@/api/base44Client';
import { useMutation } from "@tanstack/react-query";

const MOCK_REGIONS = [
    { id: 'ca-la', name: 'Los Angeles County, CA', count: 2450000, price: '$0.00 (Public)', status: 'available' },
    { id: 'ca-oc', name: 'Orange County, CA', count: 980000, price: '$0.00 (Public)', status: 'available' },
    { id: 'tx-harris', name: 'Harris County, TX', count: 1200000, price: '$0.00 (Public)', status: 'available' },
    { id: 'fl-miami', name: 'Miami-Dade County, FL', count: 890000, price: '$0.00 (Public)', status: 'available' },
    { id: 'ny-kings', name: 'Kings County (Brooklyn), NY', count: 750000, price: '$0.00 (Public)', status: 'available' },
];

export default function DataMarketplace() {
    const [searchTerm, setSearchTerm] = useState('');
    const [subscribedRegions, setSubscribedRegions] = useState(new Set());
    const [loading, setLoading] = useState(false);

    const subscribeMutation = useMutation({
        mutationFn: async (regionId) => {
            // Mock API call to subscribe to data stream
            await new Promise(resolve => setTimeout(resolve, 1500));
            return regionId;
        },
        onSuccess: (regionId) => {
            setSubscribedRegions(prev => new Set(prev).add(regionId));
            // In a real app, this would trigger a backend sync job
            // For now, we simulate success
        }
    });

    const filteredRegions = MOCK_REGIONS.filter(r => 
        r.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="space-y-6">
            <div className="bg-[#151515] p-6 rounded-xl border border-[#333]">
                <div className="flex items-center gap-4 mb-6">
                    <div className="w-12 h-12 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-900/20">
                        <Globe className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white">National Property Feed</h3>
                        <p className="text-gray-400 text-sm">Connect to live county assessor data feeds across the entire country.</p>
                    </div>
                </div>

                <div className="relative mb-6">
                    <Search className="absolute left-3 top-3 w-5 h-5 text-gray-500" />
                    <input
                        type="text"
                        placeholder="Search by County, State, or Zip Code..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full bg-[#0A0A0A] border border-[#333] text-white rounded-lg py-3 pl-10 pr-4 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                    />
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