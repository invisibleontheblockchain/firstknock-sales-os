import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Loader2, BarChart3, Navigation, Users, Target } from 'lucide-react';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';

import OverviewStats from '@/components/analytics/OverviewStats';
import ActivityChart from '@/components/analytics/ActivityChart';
import TeamPerformance from '@/components/analytics/TeamPerformance';
import RouteProgress from '@/components/analytics/RouteProgress';
import StatusBreakdown from '@/components/analytics/StatusBreakdown';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

export default function ListPage() {
    const [activeTab, setActiveTab] = useState('overview');

    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    const { data: teamMembers = [] } = useQuery({
        queryKey: ['teamMembers', user?.id],
        queryFn: () => user?.id 
            ? base44.entities.TeamMember.filter({ manager_id: user.id }, '-created_date', 100)
                .then(res => Array.isArray(res) ? res : (res?.items || []))
            : [],
        enabled: !!user?.id
    });

    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', user?.email, user?.territory_zip_codes],
        queryFn: async () => {
            if (!user) return [];
            if (user.territory_zip_codes?.length > 0) {
                const promises = user.territory_zip_codes.map(zip =>
                    base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000)
                );
                const results = await Promise.all(promises);
                return results.flatMap(r => Array.isArray(r) ? r : (r.items || []));
            }
            const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 5000);
            return Array.isArray(result) ? result : (result?.items || []);
        },
        enabled: !!user
    });

    const { data: savedRoutesRaw = [], isLoading: routesLoading } = useQuery({
        queryKey: ['savedRoutes', user?.id],
        queryFn: () => user?.id ? base44.entities.SavedRoute.filter({ manager_id: user.id }, '-created_date', 500) : [],
        enabled: !!user?.id
    });
    const savedRoutes = Array.isArray(savedRoutesRaw) ? savedRoutesRaw : (savedRoutesRaw?.items || []);

    const { data: logsRaw = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        queryFn: () => user ? base44.entities.InteractionLog.list('-created_date', 5000) : [],
        enabled: !!user
    });
    const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.items || []);

    const effectiveProperties = useMemo(() => {
        const propsArray = Array.isArray(properties) ? properties : (properties?.items || []);
        return propsArray
            .filter(p => p?.lat && p?.lng && !isNaN(p.lat) && !isNaN(p.lng))
            .map(p => {
                const propLogs = logs.filter(l => l.address_hash === p.address_hash);
                return {
                    ...p,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    effective_status: determineEffectiveStatus(p, propLogs)
                };
            });
    }, [properties, logs]);

    const isLoading = propsLoading || logsLoading || routesLoading;

    const tabs = [
        { id: 'overview', label: 'Overview', icon: BarChart3 },
        { id: 'routes', label: 'Routes', icon: Navigation },
        { id: 'team', label: 'Team', icon: Users },
    ];

    return (
        <div className="h-full flex flex-col" style={{ background: BRAND.voidBlack }}>
            {/* Header */}
            <div className="px-4 pt-4 pb-2 border-b sticky top-0 z-10" style={{ background: BRAND.voidBlack, borderColor: BRAND.charcoal }}>
                <div className="flex items-center gap-2 mb-3">
                    <BarChart3 className="w-5 h-5 text-yellow-500" />
                    <h1 className="text-lg font-bold text-white tracking-wide">ANALYTICS</h1>
                </div>
                <div className="flex p-0.5 bg-[#151515] rounded-lg border border-gray-800">
                    {tabs.map(tab => {
                        const Icon = tab.icon;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex-1 py-2 rounded-md text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                                    activeTab === tab.id
                                        ? 'bg-yellow-500 text-black shadow-lg'
                                        : 'text-gray-500 hover:text-white'
                                }`}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                {tab.label}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 space-y-4">
                {isLoading ? (
                    <div className="flex justify-center items-center py-20">
                        <Loader2 className="w-8 h-8 animate-spin text-yellow-500" />
                    </div>
                ) : (
                    <>
                        {activeTab === 'overview' && (
                            <>
                                <OverviewStats
                                    routes={savedRoutes}
                                    logs={logs}
                                    properties={effectiveProperties}
                                    teamMembers={teamMembers}
                                />
                                <ActivityChart logs={logs} days={14} />
                                <StatusBreakdown properties={effectiveProperties} />
                            </>
                        )}

                        {activeTab === 'routes' && (
                            <RouteProgress routes={savedRoutes} logs={logs} />
                        )}

                        {activeTab === 'team' && (
                            <TeamPerformance
                                teamMembers={teamMembers}
                                logs={logs}
                                routes={savedRoutes}
                            />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}