import React from 'react';
import MapView from '../components/dashboard/MapView';
import CsvUploader from '../components/dashboard/CsvUploader';
import SyncManager from '../components/dashboard/SyncManager';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from 'lucide-react';

export default function Home() {
    const queryClient = useQueryClient();

    // Fetch Master Properties
    const { data: properties, isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties'],
        queryFn: () => base44.entities.MasterProperty.list('-created_date', 5000),
        initialData: []
    });

    // Fetch Logs
    const { data: logs, isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs'],
        queryFn: () => base44.entities.InteractionLog.list('-created_date', 5000),
        initialData: []
    });

    // Create Log Mutation
    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
        },
    });

    const handleLogInteraction = (logData) => {
        createLogMutation.mutate(logData);
    };

    const isLoading = propsLoading || logsLoading;

    return (
        <div className="h-full flex flex-col relative">
            {/* Map Layer */}
            <div className="flex-1 z-0 relative">
                 {isLoading ? (
                     <div className="flex items-center justify-center h-full bg-slate-900">
                         <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                     </div>
                 ) : (
                    <MapView 
                        properties={properties} 
                        logs={logs} 
                        onLogInteraction={handleLogInteraction} 
                    />
                 )}
            </div>

            {/* Overlays */}
            <div className="absolute top-4 left-4 z-50 flex flex-col gap-2">
                <div className="flex gap-2">
                    <CsvUploader />
                    <SyncManager logs={logs} />
                </div>
                <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-700/50 rounded-md px-3 py-1.5 flex items-center gap-2 w-fit">
                   <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></div>
                   <span className="text-xs font-medium text-slate-300">
                       {properties.length} Properties
                   </span>
                </div>
            </div>
        </div>
    );
}