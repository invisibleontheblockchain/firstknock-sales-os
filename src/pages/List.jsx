import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Loader2, BarChart3, Navigation, Users } from 'lucide-react';
import { subDays, startOfDay, isAfter } from 'date-fns';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { useTheme } from '@/components/theme/ThemeProvider';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { INDUSTRIES } from '@/components/appointments/EligibilityScorer';

import OverviewStats from '@/components/analytics/OverviewStats';
import TimeOfDayEffectiveness from '@/components/analytics/TimeOfDayEffectiveness';
import TeamPerformance from '@/components/analytics/TeamPerformance';
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
        { id: 'overview', label: 'Advanced Overview', icon: BarChart3 },
        { id: 'routes', label: 'Routes', icon: Navigation },
        { id: 'team', label: 'Team', icon: Users },
    ];

    return (
        <div className="h-full flex flex-col" style={{ background: '#0A0A0F' }}>
            {/* Header */}
            <div className="px-4 pt-4 pb-3 border-b border-white/5 sticky top-0 z-20 backdrop-blur-xl bg-black/60 shadow-xl">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center border shadow-inner" style={{ background: `${accent}20`, borderColor: `${accent}40` }}>
                            <BarChart3 className="w-5 h-5 drop-shadow-md" style={{ color: accent }} />
                        </div>
                        <div>
                            <h1 className="text-xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight drop-shadow-sm">Advanced Analytics</h1>
                            <p className="text-[10px] text-gray-500 font-medium tracking-wide mt-0.5">Performance & territory insights</p>
                        </div>
                    </div>
                </div>
                <div className="flex p-0.5 bg-black/40 rounded-xl border border-white/5 mb-4">
                    {tabs.map(tab => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex-1 py-2 rounded-lg text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 ${
                                    isActive ? 'bg-white text-black shadow-md' : 'text-[#8888A0] hover:text-white'
                                }`}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                {tab.label}
                            </button>
                        );
                    })}
                </div>

                {activeTab === 'overview' && (
                    <div className="flex flex-col md:flex-row gap-3 mt-2">
                        <DateRangeFilter selectedDays={dateDays} onChangeDays={setDateDays} accent={accent} />
                        <IndustryFilterBar industries={activeIndustries} selected={industryFilter} onSelect={setIndustryFilter} accent={accent} />
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
                            <div className="space-y-5 max-w-7xl mx-auto">
                                <KpiSummaryCards appointments={filteredAppointments} teamMembers={teamMembers} />
                                
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                                    <OverviewStats routes={savedRoutes} logs={logs} properties={effectiveProperties} teamMembers={teamMembers} />
                                    <TimeOfDayEffectiveness logs={logs} />
                                </div>

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                                    <AppointmentTimeline appointments={filteredAppointments} days={dateDays || 90} />
                                    <AppointmentForecast appointments={appointments} />
                                </div>

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                                    <ConversionByIndustry appointments={filteredAppointments} />
                                    <RepSuccessRate appointments={filteredAppointments} teamMembers={teamMembers} />
                                </div>

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                                    <LeadScoringEffectiveness appointments={filteredAppointments} />
                                    <RouteEfficiency routes={savedRoutes} appointments={filteredAppointments} logs={logs} />
                                </div>
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