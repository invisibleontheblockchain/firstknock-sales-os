import React, { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, DollarSign, Loader2, Navigation, Sparkles } from 'lucide-react';
import { format, startOfDay, subDays } from 'date-fns';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { hydrateRoutesForMap } from '@/components/logic/routeHydration';
import { isManagerAccount } from '@/lib/roles';
import {
    filterAnalyticsRecords,
    fetchAllAnalyticsPages,
    getAnalyticsDateWindow,
    isWithinAnalyticsDateWindow,
    parseAnalyticsTimestamp,
    summarizeAnalyticsAppointments,
} from '@/lib/analyticsDateFilter';
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
import SalesEditor from '@/components/analytics/SalesEditor';
import { normalizeSaleEmail, salesLogBelongsToScope } from '@/components/analytics/salesManagement';
import { filterKnockActivityLogs } from '@/lib/interactionLogs';

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
    const [selectedDate, setSelectedDate] = useState(null);
    const dateWindow = useMemo(
        () => getAnalyticsDateWindow({ dateDays, selectedDate }),
        [dateDays, selectedDate]
    );
    const selectedDateKey = selectedDate && dateWindow.start && dateWindow.end
        ? `${dateWindow.start.toISOString()}_${dateWindow.end.toISOString()}`
        : null;

    const handleChangeDays = (days) => {
        setSelectedDate(null);
        setDateDays(days);
    };

    const handleSelectDate = (date) => {
        if (!date) return;
        const day = startOfDay(date);
        if (day > startOfDay(new Date())) return;
        setSelectedDate(day);
        setDateDays(1);
    };

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
    const managerAnalytics = isManagerAccount(user);
    const { data: salesTeamMembersRaw = [], isLoading: salesMembersLoading } = useQuery({
        queryKey: ['teamMembers', 'salesManager', tenantManagerId, userEmail],
        queryFn: async () => {
            if (!tenantManagerId || !managerAnalytics) return [];
            const response = await base44.entities.TeamMember.filter({ manager_id: tenantManagerId }, '-created_date', 5000);
            return toEntityArray(response).filter((member) => member.manager_id === tenantManagerId);
        },
        enabled: userReady && managerAnalytics && !!tenantManagerId,
    });
    const salesTeamMembers = managerAnalytics
        ? toEntityArray(salesTeamMembersRaw)
        : [currentTeamMember].filter(Boolean);
    const salesCreatorEmails = [...new Set([
        user?.email,
        userEmail,
        ...(managerAnalytics ? salesTeamMembers.map((member) => member.email) : []),
    ].filter(Boolean))];
    const salesCreatorEmailsKey = salesCreatorEmails.map(normalizeSaleEmail).sort().join(',');
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
    const savedRoutes = toEntityArray(savedRoutesRaw).filter((route) => route.status !== 'ARCHIVED');

    const { data: hydratedRoutes = [], isLoading: hydratedRoutesLoading } = useQuery({
        queryKey: ['analyticsHydratedRoutes', savedRoutes.map(route => route.id).join(','), userEmail, tenantManagerId],
        queryFn: () => savedRoutes.length ? hydrateRoutesForMap(savedRoutes, user?.email, []) : [],
        enabled: userReady && !!userEmail && savedRoutes.length > 0,
        staleTime: 1000 * 60 * 2,
    });

    const {
        data: logsRaw = [],
        isLoading: logsLoading,
        isError: logsError,
        refetch: refetchLogs,
    } = useQuery({
        queryKey: ['interactionLogs', 'analytics', userEmail, tenantManagerId, selectedDateKey],
        staleTime: 1000 * 60 * 2,
        queryFn: async () => {
            if (!userEmail) return [];
            const creatorEmails = [...new Set([user?.email, userEmail].filter(Boolean))];
            const recentResults = await Promise.all(
                creatorEmails.map((email) => base44.entities.InteractionLog.filter({ created_by: email }, '-created_date', 5000))
            );

            const selectedResults = selectedDate && dateWindow.start && dateWindow.end
                ? await Promise.all(creatorEmails.map((email) => fetchAllAnalyticsPages(
                    (limit, skip) => base44.entities.InteractionLog.filter({
                        created_by: email,
                        created_date: {
                            $gte: dateWindow.start.toISOString(),
                            $lt: dateWindow.end.toISOString(),
                        },
                    }, '-created_date', limit, skip)
                )))
                : [];

            return dedupeEntities([
                ...recentResults.flatMap(toEntityArray),
                ...selectedResults.flatMap(toEntityArray),
            ])
                .filter((log) => personalRecordBelongsToCurrentAccount(log, user));
        },
        enabled: userReady && !!userEmail,
    });
    const logs = toEntityArray(logsRaw);
    const activityLogs = useMemo(() => filterKnockActivityLogs(logs), [logs]);

    const {
        data: salesLogsRaw = [],
        isLoading: salesLogsLoading,
        isError: salesLogsError,
        refetch: refetchSalesLogs,
    } = useQuery({
        queryKey: ['salesManagerLogs', managerAnalytics ? 'team' : 'personal', tenantManagerId, userEmail, salesCreatorEmailsKey],
        staleTime: 1000 * 60 * 2,
        queryFn: async () => {
            if (!userEmail) return [];
            const queries = [];

            if (managerAnalytics && tenantManagerId) {
                queries.push(fetchAllAnalyticsPages(
                    (limit, skip) => base44.entities.InteractionLog.filter({
                        manager_id: tenantManagerId,
                        parsed_status: 'SOLD',
                    }, '-created_date', limit, skip)
                ));
            }

            salesCreatorEmails.forEach((email) => {
                queries.push(fetchAllAnalyticsPages(
                    (limit, skip) => base44.entities.InteractionLog.filter({
                        created_by: email,
                        parsed_status: 'SOLD',
                    }, '-created_date', limit, skip)
                ));
            });

            const results = await Promise.all(queries);
            return dedupeEntities(results.flatMap(toEntityArray)).filter((log) => salesLogBelongsToScope(log, {
                userEmail,
                tenantManagerId,
                manager: managerAnalytics,
                memberEmails: salesTeamMembers.map((member) => member.email),
            }));
        },
        enabled: userReady && !!userEmail && activeTab === 'sales' && (!managerAnalytics || !salesMembersLoading),
    });
    const salesLogs = toEntityArray(salesLogsRaw);

    const {
        data: appointmentsRaw = [],
        isLoading: apptsLoading,
        isError: apptsError,
        refetch: refetchAppointments,
    } = useQuery({
        queryKey: ['appointments', 'analytics', userEmail, tenantManagerId, myRepIdsKey, selectedDateKey],
        queryFn: async () => {
            if (!userReady) return [];
            const recentQueries = [];
            if (myRepIds.length > 0) {
                recentQueries.push(base44.entities.Appointment.filter({ assigned_rep: myRepIds }, '-scheduled_date', 5000));
            }
            const creatorEmails = [...new Set([user?.email, userEmail].filter(Boolean))];
            creatorEmails.forEach((email) => {
                recentQueries.push(base44.entities.Appointment.filter({ created_by: email }, '-scheduled_date', 5000));
            });

            const recentResults = await Promise.all(recentQueries);
            const selectedDayFilter = selectedDate && dateWindow.start && dateWindow.end
                ? {
                    $or: [
                        {
                            scheduled_date: {
                                $gte: dateWindow.start.toISOString(),
                                $lt: dateWindow.end.toISOString(),
                            },
                        },
                        { scheduled_date: format(dateWindow.start, 'yyyy-MM-dd') },
                    ],
                }
                : null;
            const selectedQueries = [];

            if (selectedDayFilter && myRepIds.length > 0) {
                selectedQueries.push(fetchAllAnalyticsPages(
                    (limit, skip) => base44.entities.Appointment.filter({
                        assigned_rep: myRepIds,
                        ...selectedDayFilter,
                    }, '-scheduled_date', limit, skip)
                ));
            }
            if (selectedDayFilter) {
                creatorEmails.forEach((email) => {
                    selectedQueries.push(fetchAllAnalyticsPages(
                        (limit, skip) => base44.entities.Appointment.filter({
                            created_by: email,
                            ...selectedDayFilter,
                        }, '-scheduled_date', limit, skip)
                    ));
                });
            }

            const selectedResults = await Promise.all(selectedQueries);
            return dedupeEntities([
                ...recentResults.flatMap(toEntityArray),
                ...selectedResults.flatMap(toEntityArray),
            ])
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
        return filterAnalyticsRecords(activityLogs, 'created_date', dateWindow);
    }, [activityLogs, dateWindow]);

    const filteredAppointments = useMemo(() => {
        return filterAnalyticsRecords(personalAppointments, 'scheduled_date', dateWindow);
    }, [personalAppointments, dateWindow]);

    const periodOutcomeProperties = useMemo(() => {
        const latestByDoor = new Map();
        filteredLogs.forEach((log) => {
            const key = log.address_hash || log.id;
            if (!key) return;
            const timestamp = parseAnalyticsTimestamp(log.created_date)?.getTime() || 0;
            const current = latestByDoor.get(key);
            if (!current || timestamp >= current.timestamp) {
                latestByDoor.set(key, {
                    id: key,
                    effective_status: log.parsed_status || 'OTHER',
                    timestamp,
                });
            }
        });
        return [...latestByDoor.values()];
    }, [filteredLogs]);

    const analytics = useMemo(() => {
        const todayWindow = getAnalyticsDateWindow({ dateDays: 1 });
        const weekWindow = getAnalyticsDateWindow({ dateDays: 7 });
        const todayLogs = activityLogs.filter((log) => isWithinAnalyticsDateWindow(log.created_date, todayWindow));
        const weekLogs = activityLogs.filter((log) => isWithinAnalyticsDateWindow(log.created_date, weekWindow));
        const sales = filteredLogs.filter((log) => SALES_STATUSES.includes(log.parsed_status)).length;
        const contacts = filteredLogs.filter((log) => !NON_CONTACT_STATUSES.includes(log.parsed_status)).length;
        const callbacks = filteredLogs.filter((log) => log.parsed_status === 'CALLBACK').length;
        const appointmentMetrics = summarizeAnalyticsAppointments(filteredAppointments, {
            selectedDay: !!selectedDate,
        });
        const analyticsHashes = new Set(analyticsProperties.map((property) => property.address_hash || property.id).filter(Boolean));
        const coverageLogs = selectedDate ? filteredLogs : activityLogs;
        const workedDoors = new Set(coverageLogs.map((log) => log.address_hash).filter(hash => hash && (!analyticsHashes.size || analyticsHashes.has(hash)))).size;
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
        const hasTimedActivity = hourBuckets.some((bucket) => bucket.knocks > 0);
        const bestHourLabel = hasTimedActivity
            ? new Date(0, 0, 0, bestHour.hour, 0).toLocaleTimeString('en-US', { hour: 'numeric' })
            : 'N/A';

        const activeDays = new Set(activityLogs.map((log) => startOfDay(new Date(log.created_date)).getTime()));
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
            upcomingAppointments: appointmentMetrics.upcomingCount,
            appointmentCount: appointmentMetrics.appointmentCount,
            conversionRate: filteredLogs.length ? Math.round((sales / filteredLogs.length) * 100) : 0,
            contactRate: filteredLogs.length ? Math.round((contacts / filteredLogs.length) * 100) : 0,
            noShowRate: appointmentMetrics.noShowRate,
            workedDoors,
            coveragePct: totalDoors ? Math.round((workedDoors / totalDoors) * 100) : 0,
            activeRoutes,
            totalRoutes: savedRoutes.length,
            bestHourLabel,
            bestHourRate: bestHour.contactRate,
            streak,
            totalRevenue,
        };
    }, [activityLogs, filteredLogs, filteredAppointments, analyticsProperties, savedRoutes, selectedDate]);

    const isAnalyticsTab = activeTab === 'performance' || activeTab === 'advanced';
    const isSalesTab = activeTab === 'sales';
    const isLoading = userLoading || userFetching || propsLoading || logsLoading || routesLoading || hydratedRoutesLoading || (isAnalyticsTab && apptsLoading) || (isSalesTab && (salesMembersLoading || salesLogsLoading));
    const hasAnalyticsError = (isSalesTab ? salesLogsError : logsError) || (isAnalyticsTab && apptsError);

    const retryAnalytics = () => {
        refetchLogs();
        if (isAnalyticsTab) refetchAppointments();
        if (isSalesTab) refetchSalesLogs();
    };

    const primaryTabs = [
        { id: 'performance', label: 'Performance', icon: BarChart3 },
        { id: 'advanced', label: 'Advanced', icon: Sparkles },
        { id: 'sales', label: 'Sales', icon: DollarSign },
    ];
    const routesTab = { id: 'routes', label: 'Routes', icon: Navigation };
    const tabs = [...primaryTabs, routesTab];

    return (
        <div className="h-full flex flex-col bg-[#09090b]">
            {/* Tab bar */}
            <div className="px-4 md:px-6 pt-3 pb-2 border-b border-white/[0.04] sticky top-0 z-20 backdrop-blur-xl bg-[#09090b]/80">
                <div className="max-w-7xl mx-auto">
                    <div
                        role="group"
                        aria-label="Primary analytics views"
                        className="grid grid-cols-3 md:flex p-1 bg-white/[0.03] rounded-xl border border-white/[0.05]"
                    >
                        {tabs.map((tab) => {
                            const Icon = tab.icon;
                            const isActive = activeTab === tab.id;
                            return (
                                <button
                                    type="button"
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    aria-pressed={isActive}
                                    aria-controls="analytics-results"
                                    className={`${tab.id === routesTab.id ? 'hidden md:flex' : 'flex'} flex-1 min-w-0 md:min-w-[100px] py-2 px-1.5 sm:px-3 rounded-lg text-[11px] sm:text-xs font-bold transition-all duration-200 items-center justify-center gap-1 sm:gap-2 ${
                                        isActive
                                            ? 'bg-white text-black shadow-lg shadow-white/10'
                                            : 'text-gray-500 hover:text-white hover:bg-white/5'
                                    }`}
                                >
                                    <Icon className="w-3.5 h-3.5 shrink-0" />
                                    {tab.label}
                                </button>
                            );
                        })}
                    </div>

                </div>
            </div>

            <div className="flex-1 overflow-auto">
                {/* Keep the date controls mounted while a new day loads so focus and scroll position stay put. */}
                <RepAnalyticsHeader
                    dateDays={dateDays}
                    selectedDate={selectedDate}
                    onChangeDays={handleChangeDays}
                    onSelectDate={handleSelectDate}
                    streak={analytics.streak}
                    showDateControls={isAnalyticsTab}
                    onOpenRouteAnalytics={() => setActiveTab(routesTab.id)}
                    routeAnalyticsActive={activeTab === routesTab.id}
                />

                <div id="analytics-results" role="region" aria-label="Analytics results" aria-busy={isLoading}>
                    {isLoading ? (
                        <div className="flex flex-col justify-center items-center py-24 gap-3">
                            <Loader2 className="w-6 h-6 animate-spin text-white/40" />
                            <span className="text-xs text-gray-400">Loading analytics...</span>
                        </div>
                    ) : hasAnalyticsError ? (
                        <div role="alert" className="mx-auto flex max-w-md flex-col items-center px-5 py-20 text-center">
                            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-red-400/20 bg-red-500/10">
                                <AlertTriangle className="h-5 w-5 text-red-300" />
                            </div>
                            <h2 className="mt-4 text-sm font-black text-white">Could not load analytics</h2>
                            <p className="mt-1 text-xs text-gray-400">
                                The data request failed, so this is not being shown as a zero-activity day.
                            </p>
                            <button
                                type="button"
                                onClick={retryAnalytics}
                                className="mt-4 min-h-10 rounded-lg bg-white px-4 text-xs font-black text-black hover:bg-gray-200"
                            >
                                Try again
                            </button>
                        </div>
                    ) : (
                        <>

                        {activeTab === 'performance' && (
                            <div className="p-2.5 md:p-5 space-y-2 md:space-y-3 max-w-7xl mx-auto pb-24">
                                <RepAnalyticsKpis metrics={analytics} dateDays={dateDays} selectedDate={selectedDate} />
                                <RevenueMetrics logs={filteredLogs} dateDays={dateDays} selectedDate={selectedDate} />
                                <RepAnalyticsPipeline metrics={analytics} />
                                <StatusBreakdown properties={selectedDate ? periodOutcomeProperties : analyticsProperties} />
                            </div>
                        )}

                        {activeTab === 'advanced' && (
                            <div className="p-2.5 md:p-5 space-y-2 md:space-y-3 max-w-7xl mx-auto pb-24">
                                <RepAdvancedAnalytics
                                    logs={activityLogs}
                                    filteredLogs={filteredLogs}
                                    properties={analyticsProperties}
                                    appointments={filteredAppointments}
                                    dateDays={dateDays}
                                    selectedDate={selectedDate}
                                />
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 md:gap-3">
                                    <TimeOfDayEffectiveness logs={filteredLogs} />
                                    <AppointmentTimeline appointments={filteredAppointments} days={dateDays} selectedDate={selectedDate} />
                                </div>
                            </div>
                        )}

                        {activeTab === 'sales' && (
                            <div className="p-2.5 md:p-5 max-w-7xl mx-auto pb-24">
                                <SalesEditor
                                    logs={salesLogs}
                                    members={salesTeamMembers}
                                    routes={hydratedRoutes.length > 0 ? hydratedRoutes : savedRoutes}
                                    properties={analyticsProperties}
                                    currentUser={user}
                                />
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
        </div>
    );
}
