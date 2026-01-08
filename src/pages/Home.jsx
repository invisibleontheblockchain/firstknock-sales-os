import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from 'lucide-react';
import PropertyMap from '../components/map/PropertyMap';
import PropertyDrawer from '../components/PropertyDrawer';
import CsvImporter from '../components/CsvImporter';
import { getEffectiveStatus } from '../components/logic/resultParser';

export default function Home() {
    const [selectedProperty, setSelectedProperty] = useState(null);
    const queryClient = useQueryClient();
    
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['properties'],
        queryFn: () => base44.entities.MasterProperty.list('-created_date', 5000)
    });
    
    const { data: results = [], isLoading: resultsLoading } = useQuery({
        queryKey: ['results'],
        queryFn: () => base44.entities.DailyResult.list('-created_date', 5000)
    });
    
    const createResult = useMutation({
        mutationFn: (data) => base44.entities.DailyResult.create(data),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['results'] })
    });
    
    // Calculate effective status for each property
    const enhancedProperties = useMemo(() => {
        return properties.map(prop => {
            const propResults = results.filter(r => r.address_hash === prop.address_hash);
            return {
                ...prop,
                effective_status: getEffectiveStatus(prop, propResults)
            };
        });
    }, [properties, results]);
    
    const isLoading = propsLoading || resultsLoading;
    
    return (
        <div className="h-full flex flex-col relative">
            {isLoading ? (
                <div className="flex-1 flex items-center justify-center bg-slate-900">
                    <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                </div>
            ) : (
                <div className="flex-1">
                    <PropertyMap 
                        properties={enhancedProperties} 
                        onSelectProperty={setSelectedProperty} 
                    />
                </div>
            )}
            
            {/* Overlay Controls */}
            <div className="absolute top-4 left-4 z-50 flex flex-col gap-2">
                <CsvImporter />
                <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-700/50 rounded-md px-3 py-1.5 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500"></div>
                    <span className="text-xs font-medium text-slate-300">{properties.length} Properties</span>
                </div>
            </div>
            
            <PropertyDrawer 
                property={selectedProperty}
                open={!!selectedProperty}
                onClose={() => setSelectedProperty(null)}
                onSubmit={(data) => createResult.mutate(data)}
            />
        </div>
    );
}