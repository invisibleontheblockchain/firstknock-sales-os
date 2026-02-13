import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Loader2, BarChart3, Navigation, Users } from 'lucide-react';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { useTheme } from '@/components/theme/ThemeProvider';

import OverviewStats from '@/components/analytics/OverviewStats';
import ActivityChart from '@/components/analytics/ActivityChart';
import TeamPerformance from '@/components/analytics/TeamPerformance';
import RouteProgress from '@/components/analytics/RouteProgress';
import StatusBreakdown from '@/components/analytics/StatusBreakdown';

export default function ListPage() {
    const { accent } = useTheme();
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
        <div className="h-full flex flex-col" style={{ background: '#0A0A0A' }}>
            {/* Header */}
            <div className="px-4 pt-4 pb-3 border-b border-gray-800/40 sticky top-0 z-10" style={{ background: '#0A0A0A' }}>
                <div className="flex items-center gap-2.5 mb-3">
                    <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: `${accent}15` }}>
                        <BarChart3 className="w-4 h-4" style={{ color: accent }} />
                    </div>
                    <div>
                        <h1 className="text-base font-extrabold text-white tracking-tight">Analytics</h1>
                        <p className="text-[10px] text-gray-500">Performance & territory insights</p>
                    </div>
                </div>
                <div className="flex p-0.5 bg-black/40 rounded-xl border border-gray-800/50">
                    {tabs.map(tab => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex-1 py-2 rounded-lg text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 ${
                                    isActive ? 'text-black shadow-md' : 'text-gray-500 hover:text-gray-300'
                                }`}
                                style={isActive ? { background: accent } : {}}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                {tab.label}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 space-y-3">
                {isLoading ? (
                    <div className="flex flex-col justify-center items-center py-20 gap-3">
                        <Loader2 className="w-7 h-7 animate-spin" style={{ color: accent }} />
                        <span className="text-xs text-gray-500">Loading analytics...</span>
                    </div>
                ) : (
                    <>
                        {activeTab === 'overview' && (
                            <div className="space-y-3">
                                <OverviewStats routes={savedRoutes} logs={logs} properties={effectiveProperties} teamMembers={teamMembers} />
                                <ActivityChart logs={logs} />
                                <StatusBreakdown properties={effectiveProperties} />
                            </div>
                        )}

                        {activeTab === 'routes' && (
                            <RouteProgress routes={savedRoutes} logs={logs} />
                        )}

                        {activeTab === 'team' && (
                            <TeamPerformance teamMembers={teamMembers} logs={logs} routes={savedRoutes} />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}