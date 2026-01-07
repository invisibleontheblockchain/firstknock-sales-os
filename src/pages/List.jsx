import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPin, Search, Filter } from 'lucide-react';
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import moment from 'moment';

export default function ListPage() {
    const [searchTerm, setSearchTerm] = useState("");
    
    // Fetch Master Properties
    const { data: properties, isLoading } = useQuery({
        queryKey: ['masterProperties'],
        queryFn: () => base44.entities.MasterProperty.list({limit: 1000, sort: {created_date: -1}}),
        initialData: []
    });

    const filteredProperties = properties.filter(p => 
        p.full_address?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.street_name?.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="h-full bg-slate-900 flex flex-col">
            <div className="p-4 border-b border-slate-800 bg-slate-900 z-10 sticky top-0">
                <h1 className="text-2xl font-bold text-white mb-4">Properties</h1>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-500 w-4 h-4" />
                    <Input 
                        placeholder="Search addresses..." 
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="pl-9 bg-slate-800 border-slate-700 text-white"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-3">
                {isLoading ? (
                    <div className="flex justify-center p-8">
                        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                    </div>
                ) : filteredProperties.length === 0 ? (
                    <div className="text-center text-slate-500 mt-10">
                        No properties found
                    </div>
                ) : (
                    filteredProperties.map(prop => (
                        <Card key={prop.id} className="bg-slate-800 border-slate-700 p-4">
                            <div className="flex justify-between items-start">
                                <div>
                                    <h3 className="font-semibold text-slate-100">{prop.full_address}</h3>
                                    <div className="flex items-center gap-2 mt-1 text-sm text-slate-400">
                                        <MapPin className="w-3 h-3" />
                                        <span>{prop.street_name}</span>
                                    </div>
                                </div>
                                <Badge variant="outline" className={
                                    prop.original_status === 'SOLD' ? 'bg-red-900/20 text-red-400 border-red-900' :
                                    prop.original_status === 'HARD_NO' ? 'bg-red-900/20 text-red-400 border-red-900' :
                                    'bg-green-900/20 text-green-400 border-green-900'
                                }>
                                    {prop.original_status}
                                </Badge>
                            </div>
                        </Card>
                    ))
                )}
            </div>
        </div>
    );
}