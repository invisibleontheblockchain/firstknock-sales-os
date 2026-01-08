import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, MapPin } from 'lucide-react';
import { getEffectiveStatus } from '../components/logic/resultParser';
import moment from 'moment';

const STATUS_COLORS = {
    ELIGIBLE: 'bg-green-900 text-green-200',
    QUALIFIED: 'bg-blue-900 text-blue-200',
    CALLBACK: 'bg-yellow-900 text-yellow-200',
    NO_ANSWER: 'bg-slate-700 text-slate-300',
    SOLD: 'bg-red-900 text-red-200',
    HARD_NO: 'bg-red-900 text-red-200',
    OTHER: 'bg-slate-700 text-slate-300'
};

export default function List() {
    const [search, setSearch] = useState('');
    
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['properties'],
        queryFn: () => base44.entities.MasterProperty.list('-created_date', 5000)
    });
    
    const { data: results = [], isLoading: resultsLoading } = useQuery({
        queryKey: ['results'],
        queryFn: () => base44.entities.DailyResult.list('-created_date', 5000)
    });
    
    const enhancedProperties = useMemo(() => {
        return properties.map(prop => {
            const propResults = results.filter(r => r.address_hash === prop.address_hash);
            const lastVisit = propResults.length > 0 
                ? propResults.sort((a, b) => new Date(b.date_visited) - new Date(a.date_visited))[0]
                : null;
            return {
                ...prop,
                effective_status: getEffectiveStatus(prop, propResults),
                lastVisit
            };
        });
    }, [properties, results]);
    
    const filtered = useMemo(() => {
        if (!search.trim()) return enhancedProperties;
        const lower = search.toLowerCase();
        return enhancedProperties.filter(p => 
            p.full_address?.toLowerCase().includes(lower) ||
            p.street_name?.toLowerCase().includes(lower)
        );
    }, [enhancedProperties, search]);
    
    const isLoading = propsLoading || resultsLoading;
    
    return (
        <div className="h-full bg-slate-900 flex flex-col">
            {/* Search Header */}
            <div className="p-4 border-b border-slate-700">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <Input 
                        placeholder="Search properties..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="pl-10 bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
                    />
                </div>
                <p className="text-xs text-slate-500 mt-2">{filtered.length} properties</p>
            </div>
            
            {/* List */}
            <div className="flex-1 overflow-y-auto">
                {isLoading ? (
                    <div className="flex items-center justify-center h-32">
                        <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-32 text-slate-500">
                        <MapPin className="w-8 h-8 mb-2 opacity-50" />
                        <p className="text-sm">No properties found</p>
                    </div>
                ) : (
                    <div className="divide-y divide-slate-800">
                        {filtered.map(prop => (
                            <div key={prop.address_hash} className="p-4 hover:bg-slate-800/50 transition-colors">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex-1 min-w-0">
                                        <p className="font-medium text-white truncate">{prop.full_address}</p>
                                        <p className="text-xs text-slate-500">{prop.street_name}</p>
                                        {prop.lastVisit && (
                                            <p className="text-xs text-slate-600 mt-1">
                                                Last: {moment(prop.lastVisit.date_visited).format('MMM D')} — {prop.lastVisit.result_text}
                                            </p>
                                        )}
                                    </div>
                                    <Badge className={STATUS_COLORS[prop.effective_status]}>
                                        {prop.effective_status}
                                    </Badge>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}