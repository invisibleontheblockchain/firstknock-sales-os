import React, { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Loader2, Navigation, Sparkles } from 'lucide-react';
import { isAfter, startOfDay, subDays } from 'date-fns';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';

import TimeOfDayEffectiveness from '@/components/analytics/TimeOfDayEffectiveness';
import RouteProgress from '@/components/analytics/RouteProgress';
import StatusBreakdown from '@/components/analytics/StatusBreakdown';
import AppointmentTimeline from '@/components/analytics/AppointmentTimeline';
import RepAnalyticsHeader from '@/components/analytics/rep/RepAnalyticsHeader';
import RepAnalyticsKpis from '@/components/analytics/rep/RepAnalyticsKpis';
import RepAnalyticsPipeline from '@/components/analytics/rep/RepAnalyticsPipeline';
import RepAnalyticsFocus from '@/components/analytics/rep/RepAnalyticsFocus';
import RepAdvancedAnalytics from '@/components/analytics/rep/RepAdvancedAnalytics';

const SALES_STATUSES = ['SOLD', 'QUALIFIED'];
const NON_CONTACT_STATUSES = ['NO_ANSWER', 'ELIGIBLE'];

export default function ListPage() {
    const [activeTab, setActiveTab] = useState('performance');
    const [dateDays, setDateDays] = useState(30);

    const { data: user } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me(),
        retry: false,
    });

    const { data: currentTeamMember = null } = useQuery({
        queryKey: ['currentTeamMember', user?.email],
        queryFn: async () => {
            if (!user?.email) return null;
            const res = await base44.entities.TeamMember.filter({ email: user.email }, '-created_date', 1);
            const items = Array.isArray(res) ? res : (res?.items || []);
            return items[0] || null;
        },
        enabled: !!user?.email,
    });

    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', user?.email, user?.territory_zip_codes, currentTeamMember?.assigned_zip_codes],
        queryFn: async () => {
            if (!user) return [];
            const zipCodes = currentTeamMember?.assigned_zip_codes?.length ? currentTeamMember.assigned_zip_codes : user.territory_zip_codes;
            if (zipCodes?.length > 0) {
                const results = await Promise.all(
                    zipCodes.map((zip) => base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000))
                );
                return results.flatMap((result) => Array.isArray(result) ? result : (result?.items || []));
            }
            const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 5000);
            return Array.isArray(result) ? result : (result?.items || []);
        },
        enabled: !!user,
    });

    const { data: savedRoutesRaw = [], isLoading: routesLoading } = useQuery({
        queryKey: ['savedRoutes', user?.id, currentTeamMember?.id],
        queryFn: async () => {
            if (currentTeamMember?.id) {
                return await base44.entities.SavedRoute.filter({ assigned_to: currentTeamMember.id }, '-created_date', 500);
            }
            if (user?.id) {
                return await base44.entities.SavedRoute.filter({ manager_id: user.id }, '-created_date', 500);
            }
            return [];
        },
        enabled: !!user,
    });
    const savedRoutes = Array.isArray(savedRoutesRaw) ? savedRoutesRaw : (savedRoutesRaw?.items || []);

    const { data: logsRaw = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        queryFn: () => user?.email ? base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 5000) : [],
        enabled: !!user?.email,
    });
    const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.items || []);

    const { data: appointmentsRaw = [], isLoading: apptsLoading } = useQuery({
        queryKey: ['appointments', user?.email],
        queryFn: () => user ? base44.entities.Appointment.list('-scheduled_date', 5000) : [],
        enabled: !!user,
    });
    const appointments = Array.isArray(appointmentsRaw) ? appointmentsRaw : (appointmentsRaw?.items || []);

    const personalAppointments = useMemo(() => {
        return appointments.filter((appointment) => {
            if (currentTeamMember?.id && appointment.assigned_rep === currentTeamMember.id) return true;
            if (appointment.created_by === user?.email) return true;
            if (!currentTeamMember?.id && appointment.assigned_rep_name && appointment.assigned_rep_name === user?.full_name) return true;
            return false;
        });
    }, [appointments, currentTeamMember?.id, user?.email, user?.full_name]);

    const effectiveProperties = useMemo(() => {
        const propsArray = Array.isArray(properties) ? properties : (properties?.items || []);
        return propsArray
            .filter((property) => property?.lat && property?.lng && !isNaN(property.lat) && !isNaN(property.lng))
            .map((property) => {
                const propertyLogs = logs.filter((log) => log.address_hash === property.address_hash);
                return {
                    ...property,
                    lat: parseFloat(property.lat),
                    lng: parseFloat(property.lng),
                    effective_status: determineEffectiveStatus(property, propertyLogs),
                };
            });
    }, [properties, logs]);

    const filteredLogs = useMemo(() => {
        const cutoff = startOfDay(subDays(new Date(), dateDays));
        return logs.filter((log) => log.created_date && isAfter(new Date(log.created_date), cutoff));
    }, [logs, dateDays]);

    const filteredAppointments = useMemo(() => {
        const cutoff = startOfDay(subDays(new Date(), dateDays));
        return personalAppointments.filter((appointment) => {
            if (!appointment.scheduled_date) return false;
            return isAfter(new Date(appointment.scheduled_date), cutoff);
        });
    }, [personalAppointments, dateDays]);

    const analytics = useMemo(() => {
        const today = startOfDay(new Date());
        const weekCutoff = startOfDay(subDays(new Date(), 7));
        const todayLogs = logs.filter((log) => log.created_date && isAfter(new Date(log.created_date), today));
        const weekLogs = logs.filter((log) => log.created_date && isAfter(new Date(log.created_date), weekCutoff));
        const sales = filteredLogs.filter((log) => SALES_STATUSES.includes(log.parsed_status)).length;
        const contacts = filteredLogs.filter((log) => !NON_CONTACT_STATUSES.includes(log.parsed_status)).length;
        const callbacks = filteredLogs.filter((log) => log.parsed_status === 'CALLBACK').length;
        const upcomingAppointments = filteredAppointments.filter((appointment) => ['scheduled', 'confirmed'].includes(appointment.status)).length;
        const noShows = filteredAppointments.filter((appointment) => appointment.status === 'no_show').length;
        const workedDoors = new Set(logs.map((log) => log.address_hash).filter(Boolean)).size;
        const totalDoors = effectiveProperties.length;
        const activeRoutes = savedRoutes.filter((route) => ['ACTIVE', 'IN_PROGRESS'].includes(route.status)).length;
        const totalRevenue = filteredLogs.reduce((sum, log) => sum + (log.sale_amount || 0), 0);

        const hourBuckets = Array.from({ length: 13 }, (_, index) => index + 8).map((hour) => {
            const hourLogs = filteredLogs.filter((log) => new Date(log.created_date).getHours() === hour);
            const hourContacts = hourLogs.filter((log) => !NON_CONTACT_STATUSES.includes(log.parsed_status)).length;
            return { hour, knocks: hourLogs.length, contactRate: hourLogs.length ? Math.round((hourContacts / hourLogs.length) * 100) : 0 };
        });
        const bestHour = [...hourBuckets].sort((a, b) => (b.contactRate - a.contactRate) || (b.knocks - a.knocks))[0] || { hour: 17, contactRate: 0 };
        const bestHourLabel = new Date(0, 0, 0, bestHour.hour, 0).toLocaleTimeString('en-US', { hour: 'numeric' });

        const activeDays = new Set(logs.map((log) => startOfDay(new Date(log.created_date)).getTime()));
        let streak = 0;
        for (let i = 0; i < 60; i++) {
            const day = startOfDay(subDays(new Date(), i)).getTime();
            if (activeDays.has(day)) streak += 1;
            else break;
        }

        return {
            todayKnocks: todayLogs.length,
            weekKnocks: weekLogs.length,
            periodKnocks: filteredLogs.length,
            contacts,
            callbacks,
            sales,
            upcomingAppointments,
            conversionRate: filteredLogs.length ? Math.round((sales / filteredLogs.length) * 100) : 0,
            contactRate: filteredLogs.length ? Math.round((contacts / filteredLogs.length) * 100) : 0,
            noShowRate: filteredAppointments.length ? Math.round((noShows / filteredAppointments.length) * 100) : 0,
            workedDoors,
            coveragePct: totalDoors ? Math.round((workedDoors / totalDoors) * 100) : 0,
            activeRoutes,
            totalRoutes: savedRoutes.length,
            bestHourLabel,
            bestHourRate: bestHour.contactRate,
            streak,
            totalRevenue,
        };
    }, [logs, filteredLogs, filteredAppointments, effectiveProperties, savedRoutes]);

    const isLoading = propsLoading || logsLoading || routesLoading || apptsLoading;

    const tabs = [
        { id: 'performance', label: 'Performance', icon: BarChart3 },
        { id: 'advanced', label: 'Advanced', icon: Sparkles },
        { id: 'routes', label: 'Routes', icon: Navigation },
    ];

    return (
        <div className="h-full flex flex-col bg-[#09090b]">
            {/* Tab bar */}
            <div className="px-4 md:px-6 pt-3 pb-2 border-b border-white/[0.04] sticky top-0 z-20 backdrop-blur-xl bg-[#09090b]/80">
                <div className="max-w-7xl mx-auto flex p-1 bg-white/[0.03] rounded-xl border border-white/[0.05] overflow-x-auto no-scrollbar">
                    {tabs.map((tab) => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex-1 min-w-[100px] py-2 px-3 rounded-lg text-xs font-bold transition-all duration-200 flex items-center justify-center gap-2 ${
                                    isActive
                                        ? 'bg-white text-black shadow-lg shadow-white/10'
                                        : 'text-gray-500 hover:text-white hover:bg-white/5'
                                }`}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                {tab.label}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flex-1 overflow-auto">
                {isLoading ? (
                    <div className="flex flex-col justify-center items-center py-24 gap-3">
                        <Loader2 className="w-6 h-6 animate-spin text-white/40" />
                        <span className="text-xs text-gray-600">Loading analytics...</span>
                    </div>
                ) : (
                    <>
                        {/* Shared header for performance + advanced */}
                        {(activeTab === 'performance' || activeTab === 'advanced') && (
                            <RepAnalyticsHeader
                                dateDays={dateDays}
                                onChangeDays={setDateDays}
                                streak={analytics.streak}
                            />
                        )}

                        {activeTab === 'performance' && (
                            <div className="p-3 md:p-6 space-y-3 md:space-y-6 max-w-7xl mx-auto pb-24">
                                <RepAnalyticsKpis metrics={analytics} dateDays={dateDays} />

                                <div className="grid grid-cols-1 xl:grid-cols-[1.1fr,0.9fr] gap-4 md:gap-6">
                                    <RepAnalyticsPipeline metrics={analytics} />
                                    <RepAnalyticsFocus metrics={analytics} />
                                </div>

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
                                    <TimeOfDayEffectiveness logs={filteredLogs} />
                                    <StatusBreakdown properties={effectiveProperties} />
                                </div>

                                <AppointmentTimeline appointments={filteredAppointments} days={dateDays} />
                            </div>
                        )}

                        {activeTab === 'advanced' && (
                            <div className="p-3 md:p-6 max-w-7xl mx-auto pb-24">
                                <RepAdvancedAnalytics
                                    logs={logs}
                                    filteredLogs={filteredLogs}
                                    properties={effectiveProperties}
                                    appointments={filteredAppointments}
                                    dateDays={dateDays}
                                />
                            </div>
                        )}

                        {activeTab === 'routes' && (
                            <div className="p-3 md:p-6 max-w-7xl mx-auto pb-24">
                                <RouteProgress routes={savedRoutes} logs={logs} />
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}