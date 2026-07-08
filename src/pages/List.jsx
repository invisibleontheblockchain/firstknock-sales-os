import React, { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Loader2, Navigation, Sparkles } from 'lucide-react';
import { isAfter, startOfDay, subDays } from 'date-fns';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { hydrateRoutesForMap } from '@/components/logic/routeHydration';
import { isManagerAccount } from '@/lib/roles';
import {
    dedupeEntities,
    getTenantManagerId,
    getUserEmail,
    normalizeEmail,
    personalRecordBelongsToCurrentAccount,
    recordBelongsToCurrentAccount,
    recordCreatedByCurrentUser,
    toEntityArray,
} from '@/lib/accountScope';

import TimeOfDayEffectiveness from '@/components/analytics/TimeOfDayEffectiveness';
import RouteProgress from '@/components/analytics/RouteProgress';
import StatusBreakdown from '@/components/analytics/StatusBreakdown';
import AppointmentTimeline from '@/components/analytics/AppointmentTimeline';
import RepAnalyticsHeader from '@/components/analytics/rep/RepAnalyticsHeader';
import RepAnalyticsKpis from '@/components/analytics/rep/RepAnalyticsKpis';
import RepAnalyticsPipeline from '@/components/analytics/rep/RepAnalyticsPipeline';
import RepAdvancedAnalytics from '@/components/analytics/rep/RepAdvancedAnalytics';
import RevenueMetrics from '@/components/analytics/rep/RevenueMetrics';

const SALES_STATUSES = ['SOLD', 'QUALIFIED'];
const NON_CONTACT_STATUSES = ['NO_ANSWER', 'ELIGIBLE'];

function isPersonalAppointmentForUser(appointment, user, repIds = []) {
    if (!appointment || !user) return false;
    const repIdSet = new Set(repIds.filter(Boolean));
    const assignedToMe = appointment.assigned_rep && repIdSet.has(appointment.assigned_rep);
    const createdByMe = recordCreatedByCurrentUser(appointment, user);
    const legacyNameMatch = !appointment.manager_id &&
        appointment.assigned_rep_name &&
        appointment.assigned_rep_name === user?.full_name;

    return recordBelongsToCurrentAccount(appointment, user) &&
        (assignedToMe || createdByMe || legacyNameMatch);
}

export default function ListPage() {
    const [activeTab, setActiveTab] = useState('performance');
    const [dateDays, setDateDays] = useState(30);

    const { data: user, isLoading: userLoading, isFetching: userFetching } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me(),
        staleTime: 0,
        refetchOnMount: 'always',
        retry: false,
    });

    const userReady = !!user && !userFetching;
    const userEmail = getUserEmail(user);
    const tenantManagerId = getTenantManagerId(user);

    const { data: teamMemberData = { primary: null, allIds: [] } } = useQuery({
        queryKey: ['currentTeamMember', 'analytics', user?.id, userEmail, tenantManagerId],
        queryFn: async () => {
            if (!userEmail) return { primary: null, allIds: [] };
            const res = await base44.entities.TeamMember.filter({ email: userEmail }, '-created_date', 50);
            const allMatches = toEntityArray(res).filter((member) => normalizeEmail(member.email) === userEmail);
            const accountMatches = tenantManagerId
                ? allMatches.filter((member) => member.manager_id === tenantManagerId)
                : allMatches;
            const primary = accountMatches.find((member) => member.user_id && member.user_id === user?.id) ||
                accountMatches[0] ||
                null;
            return {
                primary,
                allIds: [...new Set(accountMatches.map((member) => member.id).filter(Boolean))],
            };
        },
        enabled: userReady && !!userEmail,
    });
    const currentTeamMember = teamMemberData.primary;
    const currentTeamMemberIds = teamMemberData.allIds || [];
    const myRepIds = [...new Set([user?.id, ...currentTeamMemberIds].filter(Boolean))];
    const myRepIdsKey = myRepIds.join(',');
    const analyticsZipCodes = [...new Set(
        (currentTeamMember?.assigned_zip_codes?.length
            ? currentTeamMember.assigned_zip_codes
            : (user?.territory_zip_codes || []))
            .map((zip) => String(zip || '').trim())
            .filter(Boolean)
    )];
    const analyticsZipCodesKey = analyticsZipCodes.join(',');

    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', 'analytics', userEmail, tenantManagerId, analyticsZipCodesKey],
        staleTime: 1000 * 60 * 3,
        queryFn: async () => {
            if (!userReady || !analyticsZipCodes.length) return [];
            const response = await base44.functions.invoke('getRouteCandidatesFromNeon', {
                zip_codes: analyticsZipCodes,
                sold_months: 'all',
                limit: 100000
            });
            return Array.isArray(response.data?.properties) ? response.data.properties : [];
        },
        enabled: userReady && analyticsZipCodes.length > 0,
    });

    const { data: savedRoutesRaw = [], isLoading: routesLoading } = useQuery({
        queryKey: ['savedRoutes', 'analytics', user?.id, userEmail, tenantManagerId, myRepIdsKey],
        queryFn: async () => {
            if (!userReady) return [];
            const queries = [];
            if (myRepIds.length > 0) {
                queries.push(base44.entities.SavedRoute.filter({ assigned_to: myRepIds }, '-created_date', 500));
            }
            if (isManagerAccount(user)) {
                if (tenantManagerId) queries.push(base44.entities.SavedRoute.filter({ manager_id: tenantManagerId }, '-created_date', 500));
                if (user?.email) queries.push(base44.entities.SavedRoute.filter({ created_by: user.email }, '-created_date', 500));
            }
            const results = await Promise.all(queries);
            return dedupeEntities(results.flatMap(toEntityArray)).filter((route) => {
                const assignedToMe = route.assigned_to && myRepIds.includes(route.assigned_to);
                if (assignedToMe && (!route.manager_id || recordBelongsToCurrentAccount(route, user))) return true;
                return isManagerAccount(user) && recordBelongsToCurrentAccount(route, user);
            });
        },
        enabled: userReady,
    });
    const savedRoutes = toEntityArray(savedRoutesRaw);

    const { data: hydratedRoutes = [], isLoading: hydratedRoutesLoading } = useQuery({
        queryKey: ['analyticsHydratedRoutes', savedRoutes.map(route => route.id).join(','), userEmail, tenantManagerId],
        queryFn: () => savedRoutes.length ? hydrateRoutesForMap(savedRoutes, user?.email, []) : [],
        enabled: userReady && !!userEmail && savedRoutes.length > 0,
        staleTime: 1000 * 60 * 2,
    });

    const { data: logsRaw = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', 'analytics', userEmail, tenantManagerId],
        staleTime: 1000 * 60 * 2,
        queryFn: async () => {
            if (!userEmail) return [];
            const creatorEmails = [...new Set([user?.email, userEmail].filter(Boolean))];
            const results = await Promise.all(
                creatorEmails.map((email) => base44.entities.InteractionLog.filter({ created_by: email }, '-created_date', 5000))
            );
            return dedupeEntities(results.flatMap(toEntityArray))
                .filter((log) => personalRecordBelongsToCurrentAccount(log, user));
        },
        enabled: userReady && !!userEmail,
    });
    const logs = toEntityArray(logsRaw);

    const { data: appointmentsRaw = [], isLoading: apptsLoading } = useQuery({
        queryKey: ['appointments', 'analytics', userEmail, tenantManagerId, myRepIdsKey],
        queryFn: async () => {
            if (!userReady) return [];
            const queries = [];
            if (myRepIds.length > 0) {
                queries.push(base44.entities.Appointment.filter({ assigned_rep: myRepIds }, '-scheduled_date', 5000));
            }
            if (user?.email) {
                const creatorEmails = [...new Set([user.email, userEmail].filter(Boolean))];
                creatorEmails.forEach((email) => {
                    queries.push(base44.entities.Appointment.filter({ created_by: email }, '-scheduled_date', 5000));
                });
            }
            const results = await Promise.all(queries);
            return dedupeEntities(results.flatMap(toEntityArray))
                .filter((appointment) => isPersonalAppointmentForUser(appointment, user, myRepIds));
        },
        enabled: userReady,
    });
    const appointments = toEntityArray(appointmentsRaw);

    const personalAppointments = useMemo(() => {
        return appointments.filter((appointment) => isPersonalAppointmentForUser(appointment, user, myRepIds));
    }, [appointments, myRepIdsKey, user]);

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

    const analyticsProperties = useMemo(() => {
        const seen = new Set();
        const routeProps = [];
        hydratedRoutes.forEach(route => {
            const props = route.allProperties || route.properties || [];
            props.forEach(property => {
                const key = property.address_hash || property.id;
                if (key && !seen.has(key)) {
                    seen.add(key);
                    routeProps.push(property);
                }
            });
        });
        return routeProps.length > 0 ? routeProps : effectiveProperties;
    }, [hydratedRoutes, effectiveProperties]);

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
        const analyticsHashes = new Set(analyticsProperties.map((property) => property.address_hash || property.id).filter(Boolean));
        const workedDoors = new Set(logs.map((log) => log.address_hash).filter(hash => hash && (!analyticsHashes.size || analyticsHashes.has(hash)))).size;
        const totalDoors = analyticsProperties.length;
        const activeRoutes = savedRoutes.filter((route) => ['ACTIVE', 'IN_PROGRESS'].includes(route.status)).length;
        const totalRevenue = filteredLogs
            .filter((log) => SALES_STATUSES.includes(log.parsed_status))
            .reduce((sum, log) => sum + (log.sale_amount || 0), 0);

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
    }, [logs, filteredLogs, filteredAppointments, analyticsProperties, savedRoutes]);

    const isLoading = userLoading || userFetching || propsLoading || logsLoading || routesLoading || hydratedRoutesLoading || apptsLoading;

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
                            <div className="p-2.5 md:p-5 space-y-2 md:space-y-3 max-w-7xl mx-auto pb-24">
                                <RepAnalyticsKpis metrics={analytics} dateDays={dateDays} />
                                <RevenueMetrics logs={filteredLogs} dateDays={dateDays} />
                                <RepAnalyticsPipeline metrics={analytics} />
                                <StatusBreakdown properties={analyticsProperties} />
                            </div>
                        )}

                        {activeTab === 'advanced' && (
                            <div className="p-2.5 md:p-5 space-y-2 md:space-y-3 max-w-7xl mx-auto pb-24">
                                <RepAdvancedAnalytics
                                    logs={logs}
                                    filteredLogs={filteredLogs}
                                    properties={analyticsProperties}
                                    appointments={filteredAppointments}
                                    dateDays={dateDays}
                                />
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 md:gap-3">
                                    <TimeOfDayEffectiveness logs={filteredLogs} />
                                    <AppointmentTimeline appointments={filteredAppointments} days={dateDays} />
                                </div>
                            </div>
                        )}

                        {activeTab === 'routes' && (
                            <div className="p-3 md:p-6 max-w-7xl mx-auto pb-24">
                                <RouteProgress routes={hydratedRoutes.length > 0 ? hydratedRoutes : savedRoutes} logs={logs} />
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
