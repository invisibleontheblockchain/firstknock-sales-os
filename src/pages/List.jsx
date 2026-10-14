import React, { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, DollarSign, Loader2, Navigation, Sparkles } from 'lucide-react';
import { startOfDay, subDays } from 'date-fns';
import { buildLogsByAddress, withDerivedStatus } from '@/components/logic/routePropertyStatus';
import { hydrateRoutesForMap } from '@/components/logic/routeHydration';
import { isManagerAccount } from '@/lib/roles';
import { withReadDeadline } from '@/lib/readRequest';
import {
    ANALYTICS_APPOINTMENT_FIELDS,
    ANALYTICS_ROUTE_FIELDS,
    adjustAnalyticsStatusCounts,
    collectAnalyticsRouteProperties,
    countAnalyticsWorkedDoors,
    fetchAnalyticsTerritorySummary,
    fetchPersonalAnalyticsLogs,
    getAnalyticsAppointmentDateFilter,
    requireCompleteAnalyticsRouteProperties,
} from '@/lib/analyticsLoading';
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
    const [loadRouteStatuses, setLoadRouteStatuses] = useState(false);
    const isAnalyticsTab = activeTab === 'performance' || activeTab === 'advanced';
    const isSalesTab = activeTab === 'sales';
    const isRoutesTab = activeTab === 'routes';
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

    const { data: user, isLoading: userLoading, isError: userError, refetch: refetchUser } = useQuery({
        queryKey: ['user'],
        queryFn: () => withReadDeadline(() => base44.auth.me()),
        staleTime: 1000 * 60 * 5,
    });

    const userReady = !!user;
    const userEmail = getUserEmail(user);
    const tenantManagerId = getTenantManagerId(user);

    const { data: teamMemberData = { primary: null, allIds: [] }, isLoading: identityLoading, isError: identityError, refetch: refetchIdentity } = useQuery({
        queryKey: ['currentTeamMember', 'analytics', user?.id, userEmail, tenantManagerId],
        queryFn: async () => {
            if (!userEmail) return { primary: null, allIds: [] };
            const res = await withReadDeadline(() => base44.entities.TeamMember.filter({ email: userEmail }, '-created_date', 50));
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
        staleTime: 1000 * 60 * 5,
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
            const response = await withReadDeadline(() => base44.entities.TeamMember.filter({ manager_id: tenantManagerId }, '-created_date', 5000));
            return toEntityArray(response).filter((member) => member.manager_id === tenantManagerId);
        },
        enabled: userReady && managerAnalytics && !!tenantManagerId && isSalesTab,
        staleTime: 1000 * 60 * 2,
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

    const { data: savedRoutesRaw = [], isLoading: routesLoading, isSuccess: routesReady, isError: routesError, refetch: refetchRoutes } = useQuery({
        queryKey: ['savedRoutes', 'analytics', user?.id, userEmail, tenantManagerId, myRepIdsKey],
        queryFn: async () => {
            if (!userReady) return [];
            const queries = [];
            if (myRepIds.length > 0) {
                queries.push(withReadDeadline(() => base44.entities.SavedRoute.filter({ assigned_to: myRepIds }, '-created_date', 500, 0, ANALYTICS_ROUTE_FIELDS)));
            }
            if (isManagerAccount(user)) {
                if (tenantManagerId) queries.push(withReadDeadline(() => base44.entities.SavedRoute.filter({ manager_id: tenantManagerId }, '-created_date', 500, 0, ANALYTICS_ROUTE_FIELDS)));
                if (user?.email) queries.push(withReadDeadline(() => base44.entities.SavedRoute.filter({ created_by: user.email }, '-created_date', 500, 0, ANALYTICS_ROUTE_FIELDS)));
            }
            const results = await Promise.all(queries);
            return dedupeEntities(results.flatMap(toEntityArray)).filter((route) => {
                const assignedToMe = route.assigned_to && myRepIds.includes(route.assigned_to);
                if (assignedToMe && (!route.manager_id || recordBelongsToCurrentAccount(route, user))) return true;
                return isManagerAccount(user) && recordBelongsToCurrentAccount(route, user);
            });
        },
        enabled: userReady && !identityLoading && !identityError,
        staleTime: 1000 * 60 * 2,
    });
    const savedRoutes = toEntityArray(savedRoutesRaw).filter((route) => route.status !== 'ARCHIVED');
    const routeManifestProperties = useMemo(() => collectAnalyticsRouteProperties(savedRoutes), [savedRoutesRaw]);

    const {
        data: logsRaw = [],
        isLoading: logsLoading,
        isSuccess: logsReady,
        isError: logsError,
        refetch: refetchLogs,
    } = useQuery({
        queryKey: ['interactionLogs', 'analytics', userEmail, tenantManagerId, selectedDateKey, dateWindow.isAllTime || isRoutesTab],
        staleTime: 1000 * 60 * 2,
        queryFn: async () => {
            if (!userEmail) return [];
            const rows = await fetchPersonalAnalyticsLogs(base44.entities.InteractionLog, [user?.email, userEmail], {
                selectedWindow: selectedDate ? dateWindow : null,
                allTime: dateWindow.isAllTime || isRoutesTab,
            });
            return dedupeEntities(rows)
                .filter((log) => personalRecordBelongsToCurrentAccount(log, user));
        },
        enabled: userReady && !!userEmail && !isSalesTab,
    });
    const logs = toEntityArray(logsRaw);
    const activityLogs = useMemo(() => filterKnockActivityLogs(logs), [logs]);
    const territoryLogHashes = useMemo(() => [...new Set(logs.map((log) => log.address_hash).filter(Boolean))], [logsRaw]);
    const { data: territorySummary, isLoading: propsLoading, isError: propsError, refetch: refetchProperties } = useQuery({
        queryKey: ['masterProperties', 'analyticsSummary', userEmail, tenantManagerId, analyticsZipCodesKey, territoryLogHashes.join(',')],
        staleTime: 1000 * 60 * 3,
        queryFn: () => fetchAnalyticsTerritorySummary(territoryLogHashes, async (hashes) => {
            const response = await withReadDeadline(() => base44.functions.invoke('getRouteCandidatesFromNeon', {
                zip_codes: analyticsZipCodes,
                sold_months: 'all',
                response_mode: 'analytics_summary',
                analytics_hashes: hashes,
                limit: 100000,
            }));
            return response.data;
        }),
        // Route inventory is already present in SavedRoute. The territory
        // fallback returns aggregate counts and only doors with outcome logs.
        enabled: userReady && isAnalyticsTab && routesReady && logsReady && !routeManifestProperties.length && analyticsZipCodes.length > 0,
    });
    const properties = territorySummary?.properties || [];

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
                    (limit, skip) => withReadDeadline(() => base44.entities.InteractionLog.filter({
                        manager_id: tenantManagerId,
                        parsed_status: 'SOLD',
                    }, '-created_date', limit, skip))
                ));
            }

            // A single creator-set query avoids one full-history request per rep.
            if (salesCreatorEmails.length) {
                queries.push(fetchAllAnalyticsPages(
                    (limit, skip) => withReadDeadline(() => base44.entities.InteractionLog.filter({
                        created_by: { $in: salesCreatorEmails },
                        parsed_status: 'SOLD',
                    }, '-created_date', limit, skip))
                ));
            }

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
    const legacySalesHashes = new Set(salesLogs.filter((log) => !log.property_address && !log.full_address).map((log) => log.address_hash).filter(Boolean));
    const legacySalesRoutes = savedRoutes.filter((route) => route.property_hashes?.some((hash) => legacySalesHashes.has(hash)));
    const routesToHydrate = isAnalyticsTab && loadRouteStatuses ? savedRoutes : legacySalesRoutes;
    const { data: hydratedRoutes = [], isSuccess: statusesReady, isLoading: statusesLoading, isError: statusesError, refetch: refetchStatuses } = useQuery({
        queryKey: ['analyticsHydratedRoutes', routesToHydrate.map(route => `${route.id}:${route.updated_date || ''}`).join(','), userEmail, tenantManagerId, isAnalyticsTab && loadRouteStatuses],
        queryFn: async () => {
            const hydrated = await hydrateRoutesForMap(routesToHydrate, user?.email, []);
            return isAnalyticsTab && loadRouteStatuses ? requireCompleteAnalyticsRouteProperties(hydrated) : hydrated;
        },
        // Legacy sales without address snapshots enrich in the background.
        // Performance and Routes need manifests, never map geometry.
        enabled: userReady && !!userEmail && ((isSalesTab && legacySalesRoutes.length > 0) || (isAnalyticsTab && loadRouteStatuses && savedRoutes.length > 0)),
        staleTime: 1000 * 60 * 2,
        retry: false,
    });

    const {
        data: appointmentsRaw = [],
        isLoading: apptsLoading,
        isError: apptsError,
        refetch: refetchAppointments,
    } = useQuery({
        queryKey: ['appointments', 'analytics', userEmail, tenantManagerId, myRepIdsKey, dateWindow.start?.toISOString(), dateWindow.end?.toISOString()],
        staleTime: 1000 * 60 * 2,
        queryFn: async () => {
            if (!userReady) return [];
            const creatorEmails = [...new Set([user?.email, userEmail].filter(Boolean))];
            const scopes = [
                ...(myRepIds.length ? [{ assigned_rep: myRepIds }] : []),
                ...creatorEmails.map((email) => ({ created_by: email })),
            ];
            const periodFilter = getAnalyticsAppointmentDateFilter(dateWindow);
            const results = await Promise.all(scopes.map((scope) => fetchAllAnalyticsPages(
                (limit, skip) => withReadDeadline(() => base44.entities.Appointment.filter({
                    ...scope,
                    ...periodFilter,
                }, '-scheduled_date', limit, skip, ANALYTICS_APPOINTMENT_FIELDS))
            )));
            return dedupeEntities(results.flatMap(toEntityArray))
                .filter((appointment) => isPersonalAppointmentForUser(appointment, user, myRepIds));
        },
        enabled: userReady && isAnalyticsTab && !identityLoading && !identityError,
    });
    const appointments = toEntityArray(appointmentsRaw);

    const personalAppointments = useMemo(() => {
        return appointments.filter((appointment) => isPersonalAppointmentForUser(appointment, user, myRepIds));
    }, [appointments, myRepIdsKey, user]);

    const effectiveProperties = useMemo(() => {
        const propsArray = Array.isArray(properties) ? properties : (properties?.items || []);
        return withDerivedStatus(propsArray
            .filter((property) => property?.lat && property?.lng && !isNaN(property.lat) && !isNaN(property.lng))
            .map((property) => {
                return {
                    ...property,
                    lat: parseFloat(property.lat),
                    lng: parseFloat(property.lng),
                };
            }), buildLogsByAddress(logs));
    }, [properties, logs]);

    const analyticsProperties = useMemo(() => {
        return routeManifestProperties.length > 0
            ? withDerivedStatus(statusesReady && isAnalyticsTab && loadRouteStatuses
                ? collectAnalyticsRouteProperties(hydratedRoutes)
                : routeManifestProperties, buildLogsByAddress(logs))
            : effectiveProperties;
    }, [routeManifestProperties, effectiveProperties, logs, statusesReady, isAnalyticsTab, loadRouteStatuses, hydratedRoutes]);
    const analyticsStatusCounts = useMemo(() => routeManifestProperties.length
        ? null
        : adjustAnalyticsStatusCounts(territorySummary?.statusCounts, effectiveProperties),
    [routeManifestProperties, territorySummary, effectiveProperties]);

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
        const workedDoors = countAnalyticsWorkedDoors(coverageLogs, analyticsHashes, routeManifestProperties.length > 0 || !!territorySummary);
        const totalDoors = routeManifestProperties.length || territorySummary?.count || 0;
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
    }, [activityLogs, filteredLogs, filteredAppointments, analyticsProperties, routeManifestProperties, territorySummary, savedRoutes, selectedDate]);

    const isLoading = userLoading || identityLoading || routesLoading || (isAnalyticsTab && (propsLoading || logsLoading || apptsLoading)) || (isRoutesTab && logsLoading) || (isSalesTab && (salesMembersLoading || salesLogsLoading));
    const hasAnalyticsError = userError || identityError || routesError || (isSalesTab ? salesLogsError : logsError) || (isAnalyticsTab && (apptsError || propsError));

    const retryAnalytics = () => {
        if (userError) refetchUser();
        if (identityError) refetchIdentity();
        if (!isSalesTab) refetchLogs();
        if (routesError) refetchRoutes();
        if (isAnalyticsTab && propsError) refetchProperties();
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
                                {selectedDate || !routeManifestProperties.length || (loadRouteStatuses && statusesReady) ? (
                                    <StatusBreakdown properties={selectedDate ? periodOutcomeProperties : analyticsProperties} statusCounts={selectedDate ? null : analyticsStatusCounts} />
                                ) : (
                                    <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-4">
                                        <h3 className="text-sm font-black text-white">Status Breakdown</h3>
                                        <p role={statusesError ? 'alert' : 'status'} className="mt-2 text-xs text-gray-400">
                                            {statusesLoading ? 'Loading door statuses...' : statusesError ? 'Door statuses could not be verified. Please try again.' : 'Load current door statuses for all of your saved routes.'}
                                        </p>
                                        {!statusesLoading && <button type="button" onClick={() => statusesError ? refetchStatuses() : setLoadRouteStatuses(true)} className="mt-3 min-h-10 rounded-lg border border-white/10 px-3 text-xs font-bold text-white">
                                            {statusesError ? 'Try again' : 'Load door statuses'}
                                        </button>}
                                    </div>
                                )}
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
                                <RouteProgress routes={savedRoutes} logs={logs} />
                            </div>
                        )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
