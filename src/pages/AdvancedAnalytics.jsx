import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Loader2, BarChart3, X } from 'lucide-react';
import { subDays, startOfDay, isAfter } from 'date-fns';
import { useTheme } from '@/components/theme/ThemeProvider';
import { Button } from "@/components/ui/button";
import { createPageUrl } from '@/utils';
import { Link } from 'react-router-dom';
import { INDUSTRIES } from '@/components/appointments/EligibilityScorer';

import DateRangeFilter from '@/components/analytics/DateRangeFilter';
import IndustryFilterBar from '@/components/analytics/IndustryFilterBar';
import KpiSummaryCards from '@/components/analytics/KpiSummaryCards';
import ConversionByIndustry from '@/components/analytics/ConversionByIndustry';
import RepSuccessRate from '@/components/analytics/RepSuccessRate';
import LeadScoringEffectiveness from '@/components/analytics/LeadScoringEffectiveness';
import RouteEfficiency from '@/components/analytics/RouteEfficiency';
import AppointmentForecast from '@/components/analytics/AppointmentForecast';
import AppointmentTimeline from '@/components/analytics/AppointmentTimeline';
import {
    dedupeEntities,
    getTenantManagerId,
    getUserEmail,
    normalizeEmail,
    recordBelongsToCurrentAccount,
    toEntityArray,
} from '@/lib/accountScope';

export default function AdvancedAnalytics() {
    const { accent } = useTheme();
    const [dateDays, setDateDays] = useState(30);
    const [industryFilter, setIndustryFilter] = useState('all');

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

    const fetchCurrentAccountRows = async (entity, sort, limit) => {
        if (!userReady) return [];
        const queries = [];
        if (tenantManagerId) queries.push(entity.filter({ manager_id: tenantManagerId }, sort, limit));
        if (user?.email) {
            const creatorEmails = [...new Set([user.email, userEmail].filter(Boolean))];
            creatorEmails.forEach((email) => {
                queries.push(entity.filter({ created_by: email }, sort, limit));
            });
        }
        const results = await Promise.all(queries);
        return dedupeEntities(results.flatMap(toEntityArray))
            .filter((row) => recordBelongsToCurrentAccount(row, user));
    };

    const { data: appointments = [], isLoading: apptsLoading } = useQuery({
        queryKey: ['appointments', 'advancedAnalytics', tenantManagerId, userEmail],
        queryFn: () => fetchCurrentAccountRows(base44.entities.Appointment, '-scheduled_date', 5000),
        enabled: userReady,
    });

    const { data: teamMembers = [] } = useQuery({
        queryKey: ['teamMembers', 'advancedAnalytics', tenantManagerId, userEmail],
        queryFn: () => tenantManagerId
            ? base44.entities.TeamMember.filter({ manager_id: tenantManagerId }, '-created_date', 100)
                .then(r => toEntityArray(r).filter((member) => member.manager_id === tenantManagerId))
            : userEmail
                ? base44.entities.TeamMember.filter({ email: userEmail }, '-created_date', 10)
                    .then(r => toEntityArray(r).filter((member) => normalizeEmail(member.email) === userEmail))
            : [],
        enabled: userReady && (!!tenantManagerId || !!userEmail),
    });

    const { data: savedRoutesRaw = [], isLoading: routesLoading } = useQuery({
        queryKey: ['savedRoutes', 'advancedAnalytics', tenantManagerId, userEmail],
        queryFn: () => fetchCurrentAccountRows(base44.entities.SavedRoute, '-created_date', 500),
        enabled: userReady,
    });
    const savedRoutes = toEntityArray(savedRoutesRaw).filter((route) => route.status !== 'ARCHIVED');

    const { data: logsRaw = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', 'advancedAnalytics', tenantManagerId, userEmail],
        queryFn: () => fetchCurrentAccountRows(base44.entities.InteractionLog, '-created_date', 5000),
        enabled: userReady,
    });
    const logs = toEntityArray(logsRaw);

    // Filter appointments by date range and industry
    const filtered = useMemo(() => {
        let result = Array.isArray(appointments) ? appointments : [];

        // Date filter
        if (dateDays !== null) {
            const cutoff = startOfDay(subDays(new Date(), dateDays));
            result = result.filter(a => {
                if (!a.scheduled_date) return false;
                return isAfter(new Date(a.scheduled_date), cutoff);
            });
        }

        // Industry filter
        if (industryFilter !== 'all') {
            result = result.filter(a => a.industry === industryFilter);
        }

        return result;
    }, [appointments, dateDays, industryFilter]);

    // Unique industries present in data
    const activeIndustries = useMemo(() => {
        const set = new Set((Array.isArray(appointments) ? appointments : []).map(a => a.industry).filter(Boolean));
        return INDUSTRIES.filter(i => set.has(i));
    }, [appointments]);

    const isLoading = userLoading || userFetching || apptsLoading || routesLoading || logsLoading;

    return (
        <div className="h-full flex flex-col relative" style={{ background: '#050505' }}>
            {/* Ambient Background Glows */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-blue-500/5 blur-[150px] pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-96 h-96 bg-purple-500/5 blur-[150px] pointer-events-none" />

            {/* Header */}
            <div className="px-4 md:px-6 pt-6 pb-4 border-b border-white/5 sticky top-0 z-20 backdrop-blur-xl bg-black/60 shadow-xl">
                <div className="flex items-center justify-between mb-5">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-2xl flex items-center justify-center border shadow-inner" style={{ background: `${accent}20`, borderColor: `${accent}40` }}>
                            <BarChart3 className="w-6 h-6 drop-shadow-md" style={{ color: accent }} />
                        </div>
                        <div>
                            <h1 className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight drop-shadow-sm">Advanced Analytics</h1>
                            <p className="text-xs text-gray-500 font-medium tracking-wide mt-0.5">
                                Appointments, leads & route performance •{' '}
                                <span className="text-white font-bold">{filtered.length}</span> appts
                            </p>
                        </div>
                    </div>
                    <Link to={createPageUrl('Appointments')}>
                        <Button variant="ghost" size="icon" className="text-gray-400 hover:text-white hover:bg-white/10 rounded-full h-10 w-10">
                            <X className="w-5 h-5" />
                        </Button>
                    </Link>
                </div>

                {/* Filters */}
                <div className="flex flex-col md:flex-row gap-3">
                    <DateRangeFilter selectedDays={dateDays} onChangeDays={setDateDays} accent={accent} />
                    <IndustryFilterBar industries={activeIndustries} selected={industryFilter} onSelect={setIndustryFilter} accent={accent} />
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 md:p-6 relative z-10">
                {isLoading ? (
                    <div className="flex flex-col justify-center items-center py-20 gap-3">
                        <Loader2 className="w-7 h-7 animate-spin" style={{ color: accent }} />
                        <span className="text-xs text-gray-500">Loading analytics...</span>
                    </div>
                ) : (
                    <div className="max-w-7xl mx-auto space-y-5">
                        {/* KPI Cards */}
                        <KpiSummaryCards appointments={filtered} teamMembers={teamMembers} />

                        {/* Row 1: Timeline + Forecast */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                            <AppointmentTimeline appointments={filtered} days={dateDays || 90} />
                            <AppointmentForecast appointments={Array.isArray(appointments) ? appointments : []} />
                        </div>

                        {/* Row 2: Conversion by Industry + Rep Success */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                            <ConversionByIndustry appointments={filtered} />
                            <RepSuccessRate appointments={filtered} teamMembers={teamMembers} />
                        </div>

                        {/* Row 3: Lead Scoring + Route Efficiency */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                            <LeadScoringEffectiveness appointments={filtered} />
                            <RouteEfficiency routes={savedRoutes} appointments={filtered} logs={logs} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
