import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Loader2, BarChart3, Navigation } from 'lucide-react';
import { subDays, startOfDay, isAfter } from 'date-fns';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { useTheme } from '@/components/theme/ThemeProvider';
import { INDUSTRIES } from '@/components/appointments/EligibilityScorer';

import OverviewStats from '@/components/analytics/OverviewStats';
import TimeOfDayEffectiveness from '@/components/analytics/TimeOfDayEffectiveness';
import RouteProgress from '@/components/analytics/RouteProgress';
import StatusBreakdown from '@/components/analytics/StatusBreakdown';

import DateRangeFilter from '@/components/analytics/DateRangeFilter';
import IndustryFilterBar from '@/components/analytics/IndustryFilterBar';
import KpiSummaryCards from '@/components/analytics/KpiSummaryCards';
import ConversionByIndustry from '@/components/analytics/ConversionByIndustry';
import RepSuccessRate from '@/components/analytics/RepSuccessRate';
import LeadScoringEffectiveness from '@/components/analytics/LeadScoringEffectiveness';
import RouteEfficiency from '@/components/analytics/RouteEfficiency';
import AppointmentForecast from '@/components/analytics/AppointmentForecast';
import AppointmentTimeline from '@/components/analytics/AppointmentTimeline';

export default function ListPage() {
    const { accent } = useTheme();
    const [activeTab, setActiveTab] = useState('overview');
    const [viewMode, setViewMode] = useState('essential');
    const [dateDays, setDateDays] = useState(30);
    const [industryFilter, setIndustryFilter] = useState('all');

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

    const { data: appointmentsRaw = [], isLoading: apptsLoading } = useQuery({
        queryKey: ['appointments'],
        queryFn: () => base44.entities.Appointment.list('-scheduled_date', 5000),
        enabled: !!user,
    });
    const appointments = Array.isArray(appointmentsRaw) ? appointmentsRaw : (appointmentsRaw?.items || []);

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

    const filteredAppointments = useMemo(() => {
        let result = appointments;
        if (dateDays !== null) {
            const cutoff = startOfDay(subDays(new Date(), dateDays));
            result = result.filter(a => {
                if (!a.scheduled_date) return false;
                return isAfter(new Date(a.scheduled_date), cutoff);
            });
        }
        if (industryFilter !== 'all') {
            result = result.filter(a => a.industry === industryFilter);
        }
        return result;
    }, [appointments, dateDays, industryFilter]);

    const activeIndustries = useMemo(() => {
        const set = new Set(appointments.map(a => a.industry).filter(Boolean));
        return INDUSTRIES.filter(i => set.has(i));
    }, [appointments]);

    const isLoading = propsLoading || logsLoading || routesLoading || apptsLoading;

    const tabs = [
        { id: 'overview', label: 'Overview', icon: BarChart3 },
        { id: 'routes', label: 'Routes', icon: Navigation },
    ];

    return (
        <div className="h-full flex flex-col" style={{ background: '#0A0A0F' }}>
            {/* Header */}
            <div className="px-3 md:px-4 pt-3 md:pt-4 pb-2 md:pb-3 border-b border-white/5 sticky top-0 z-20 backdrop-blur-xl bg-black/60 shadow-xl">
                <div className="flex items-center justify-between mb-3 md:mb-4">
                    <div className="flex items-center gap-2 md:gap-3">
                        <div className="w-8 h-8 md:w-12 md:h-12 rounded-xl md:rounded-2xl flex items-center justify-center transition-transform hover:scale-105 duration-300" style={{ background: `linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05))`, boxShadow: `0 0 20px rgba(255,255,255,0.1)`, border: '1px solid rgba(255,255,255,0.1)' }}>
                            <BarChart3 className="w-4 h-4 md:w-6 md:h-6 text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
                        </div>
                        <div>
                            <h1 className="text-lg md:text-2xl font-black text-white tracking-tight drop-shadow-[0_0_10px_rgba(255,255,255,0.3)]">Analytics</h1>
                            <p className="text-[9px] md:text-xs text-gray-400 font-medium tracking-wide mt-0 md:mt-0.5">Performance & territory insights</p>
                        </div>
                    </div>
                </div>
                <div className="flex p-1 bg-black/40 backdrop-blur-md rounded-xl md:rounded-2xl border border-white/5 mb-3 md:mb-4 shadow-xl overflow-x-auto no-scrollbar">
                    {tabs.map(tab => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex-1 min-w-[70px] md:min-w-[90px] py-1.5 px-2 md:py-2.5 md:px-3 rounded-lg md:rounded-xl text-[10px] md:text-[12px] font-bold transition-all duration-300 flex items-center justify-center gap-1.5 md:gap-2 ${
                                    isActive ? 'bg-white text-black shadow-[0_0_20px_rgba(255,255,255,0.3)]' : 'text-gray-400 hover:text-white hover:bg-white/10'
                                }`}
                            >
                                <Icon className={`w-3 h-3 md:w-4 md:h-4 ${isActive ? 'text-black' : ''}`} />
                                {tab.label}
                            </button>
                        );
                    })}
                </div>

                {activeTab === 'overview' && (
                    <div className="flex flex-col gap-2 mt-1 md:mt-2">
                        <div className="flex overflow-x-auto no-scrollbar gap-2 pb-1">
                            <DateRangeFilter selectedDays={dateDays} onChangeDays={setDateDays} accent={accent} />
                            <IndustryFilterBar industries={activeIndustries} selected={industryFilter} onSelect={setIndustryFilter} accent={accent} />
                        </div>
                        <div className="flex items-center bg-black/50 backdrop-blur-md rounded-lg border border-white/10 p-0.5 w-full shadow-lg">
                            <button onClick={() => setViewMode('essential')} className={`flex-1 px-2 py-1 md:py-1.5 rounded-md text-[9px] md:text-[10px] uppercase tracking-wider font-bold transition-all duration-200 ${viewMode === 'essential' ? 'bg-white text-black shadow-[0_0_15px_rgba(255,255,255,0.2)]' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>Essential</button>
                            <button onClick={() => setViewMode('advanced')} className={`flex-1 px-2 py-1 md:py-1.5 rounded-md text-[9px] md:text-[10px] uppercase tracking-wider font-bold transition-all duration-200 ${viewMode === 'advanced' ? 'bg-white text-black shadow-[0_0_15px_rgba(255,255,255,0.2)]' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>Advanced</button>
                        </div>
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 md:p-6 space-y-4 relative z-10">
                {isLoading ? (
                    <div className="flex flex-col justify-center items-center py-20 gap-3">
                        <Loader2 className="w-7 h-7 animate-spin" style={{ color: accent }} />
                        <span className="text-xs text-gray-500">Loading analytics...</span>
                    </div>
                ) : (
                    <>
                        {activeTab === 'overview' && (
                            <div className="space-y-4 md:space-y-6 max-w-7xl mx-auto">
                                <OverviewStats routes={savedRoutes} logs={logs} properties={effectiveProperties} teamMembers={teamMembers} viewMode={viewMode} />
                                
                                {viewMode === 'advanced' && (
                                    <KpiSummaryCards appointments={filteredAppointments} teamMembers={teamMembers} />
                                )}

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
                                    <AppointmentTimeline appointments={filteredAppointments} days={dateDays || 90} />
                                    {viewMode === 'advanced' ? (
                                        <TimeOfDayEffectiveness logs={logs} />
                                    ) : (
                                        <StatusBreakdown properties={effectiveProperties} />
                                    )}
                                </div>

                                {viewMode === 'advanced' && (
                                    <div className="space-y-4 md:space-y-6">
                                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
                                            <ConversionByIndustry appointments={filteredAppointments} />
                                            <RepSuccessRate appointments={filteredAppointments} teamMembers={teamMembers} />
                                        </div>

                                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
                                            <AppointmentForecast appointments={appointments} />
                                            <LeadScoringEffectiveness appointments={filteredAppointments} />
                                        </div>

                                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
                                            <RouteEfficiency routes={savedRoutes} appointments={filteredAppointments} logs={logs} />
                                            <StatusBreakdown properties={effectiveProperties} />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'routes' && (
                            <RouteProgress routes={savedRoutes} logs={logs} />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}