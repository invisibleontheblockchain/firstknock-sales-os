import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, Loader2, Plus, Zap, Filter, ChevronDown, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';
import { format, isToday, isTomorrow, isThisWeek, parseISO } from 'date-fns';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

import AppointmentCard from '@/components/appointments/AppointmentCard';
import AppointmentDetail from '@/components/appointments/AppointmentDetail';
import AutoSchedulePanel from '@/components/appointments/AutoSchedulePanel';
import { getIndustryLabel, INDUSTRIES } from '@/components/appointments/EligibilityScorer';

export default function Appointments() {
    const { accent } = useTheme();
    const accentText = contrastText(accent);
    const queryClient = useQueryClient();

    const [selectedAppointment, setSelectedAppointment] = useState(null);
    const [showAutoSchedule, setShowAutoSchedule] = useState(false);
    const [statusFilter, setStatusFilter] = useState('all');
    const [industryFilter, setIndustryFilter] = useState('all');
    const [timeFilter, setTimeFilter] = useState('upcoming');

    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    const { data: appointments = [], isLoading } = useQuery({
        queryKey: ['appointments'],
        queryFn: () => base44.entities.Appointment.list('-scheduled_date', 500),
        initialData: [],
    });

    const { data: properties = [] } = useQuery({
        queryKey: ['masterProperties-appts', user?.email, user?.territory_zip_codes],
        queryFn: async () => {
            if (!user) return [];
            if (user.territory_zip_codes?.length > 0) {
                const results = await Promise.all(
                    user.territory_zip_codes.map(zip => base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000))
                );
                return results.flatMap(r => Array.isArray(r) ? r : (r?.items || []));
            }
            const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 5000);
            return Array.isArray(result) ? result : (result?.items || []);
        },
        enabled: !!user,
    });

    const { data: logs = [] } = useQuery({
        queryKey: ['interactionLogs-appts'],
        queryFn: () => base44.entities.InteractionLog.list('-created_date', 5000),
        enabled: !!user,
    });

    const { data: teamMembers = [] } = useQuery({
        queryKey: ['teamMembers-appts', user?.id],
        queryFn: () => user?.id
            ? base44.entities.TeamMember.filter({ manager_id: user.id }, '-created_date', 100).then(r => Array.isArray(r) ? r : (r?.items || []))
            : [],
        enabled: !!user?.id,
    });

    const filteredAppointments = useMemo(() => {
        const now = new Date();
        return (Array.isArray(appointments) ? appointments : [])
            .filter(a => {
                if (statusFilter !== 'all' && a.status !== statusFilter) return false;
                if (industryFilter !== 'all' && a.industry !== industryFilter) return false;
                if (timeFilter === 'today' && a.scheduled_date && !isToday(parseISO(a.scheduled_date))) return false;
                if (timeFilter === 'tomorrow' && a.scheduled_date && !isTomorrow(parseISO(a.scheduled_date))) return false;
                if (timeFilter === 'this_week' && a.scheduled_date && !isThisWeek(parseISO(a.scheduled_date))) return false;
                if (timeFilter === 'upcoming' && a.scheduled_date && new Date(a.scheduled_date) < now) return false;
                if (timeFilter === 'past' && a.scheduled_date && new Date(a.scheduled_date) >= now) return false;
                return true;
            })
            .sort((a, b) => new Date(a.scheduled_date) - new Date(b.scheduled_date));
    }, [appointments, statusFilter, industryFilter, timeFilter]);

    // Group by date
    const grouped = useMemo(() => {
        const groups = {};
        filteredAppointments.forEach(a => {
            const dateKey = a.scheduled_date ? format(parseISO(a.scheduled_date), 'yyyy-MM-dd') : 'unscheduled';
            if (!groups[dateKey]) groups[dateKey] = [];
            groups[dateKey].push(a);
        });
        return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
    }, [filteredAppointments]);

    const stats = useMemo(() => {
        const all = Array.isArray(appointments) ? appointments : [];
        const now = new Date();
        return {
            total: all.length,
            upcoming: all.filter(a => a.scheduled_date && new Date(a.scheduled_date) >= now && a.status !== 'cancelled').length,
            today: all.filter(a => a.scheduled_date && isToday(parseISO(a.scheduled_date))).length,
            completed: all.filter(a => a.status === 'completed').length,
        };
    }, [appointments]);

    const handleRefresh = () => {
        queryClient.invalidateQueries({ queryKey: ['appointments'] });
    };

    const formatDateLabel = (dateKey) => {
        if (dateKey === 'unscheduled') return 'Unscheduled';
        const date = parseISO(dateKey);
        if (isToday(date)) return 'Today';
        if (isTomorrow(date)) return 'Tomorrow';
        return format(date, 'EEEE, MMM d');
    };

    return (
        <div className="h-full flex flex-col" style={{ background: '#0A0A0A' }}>
            {/* Header */}
            <div className="px-4 pt-4 pb-3 border-b border-gray-800/40 sticky top-0 z-10" style={{ background: '#0A0A0A' }}>
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: `${accent}15` }}>
                            <Calendar className="w-4 h-4" style={{ color: accent }} />
                        </div>
                        <div>
                            <h1 className="text-base font-extrabold text-white tracking-tight">Appointments</h1>
                            <p className="text-[10px] text-gray-500">{stats.upcoming} upcoming · {stats.today} today</p>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <Link to={createPageUrl('AdvancedAnalytics')}>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-[10px] font-bold border-gray-700 gap-1"
                                style={{ color: accent }}
                            >
                                <BarChart3 className="w-3 h-3" /> Analytics
                            </Button>
                        </Link>
                        <Button
                            onClick={() => setShowAutoSchedule(!showAutoSchedule)}
                            variant="outline"
                            size="sm"
                            className="h-8 text-[10px] font-bold border-gray-700 gap-1"
                            style={{ color: accent }}
                        >
                            <Zap className="w-3 h-3" /> Auto
                        </Button>
                    </div>
                </div>

                {/* Quick stats */}
                <div className="grid grid-cols-4 gap-2 mb-3">
                    {[
                        { label: 'Total', value: stats.total },
                        { label: 'Upcoming', value: stats.upcoming },
                        { label: 'Today', value: stats.today },
                        { label: 'Done', value: stats.completed },
                    ].map(s => (
                        <div key={s.label} className="bg-white/[0.03] rounded-xl py-2 text-center">
                            <p className="text-sm font-extrabold text-white">{s.value}</p>
                            <p className="text-[8px] text-gray-600 uppercase">{s.label}</p>
                        </div>
                    ))}
                </div>

                {/* Filters */}
                <div className="flex gap-2 overflow-x-auto pb-1">
                    <Select value={timeFilter} onValueChange={setTimeFilter}>
                        <SelectTrigger className="h-7 bg-black/30 border-gray-800 text-[10px] text-white w-auto min-w-[90px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#1a1a1a] border-gray-700">
                            <SelectItem value="upcoming" className="text-white text-xs">Upcoming</SelectItem>
                            <SelectItem value="today" className="text-white text-xs">Today</SelectItem>
                            <SelectItem value="tomorrow" className="text-white text-xs">Tomorrow</SelectItem>
                            <SelectItem value="this_week" className="text-white text-xs">This Week</SelectItem>
                            <SelectItem value="past" className="text-white text-xs">Past</SelectItem>
                            <SelectItem value="all" className="text-white text-xs">All Time</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                        <SelectTrigger className="h-7 bg-black/30 border-gray-800 text-[10px] text-white w-auto min-w-[90px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#1a1a1a] border-gray-700">
                            <SelectItem value="all" className="text-white text-xs">All Status</SelectItem>
                            <SelectItem value="scheduled" className="text-white text-xs">Scheduled</SelectItem>
                            <SelectItem value="confirmed" className="text-white text-xs">Confirmed</SelectItem>
                            <SelectItem value="completed" className="text-white text-xs">Completed</SelectItem>
                            <SelectItem value="cancelled" className="text-white text-xs">Cancelled</SelectItem>
                            <SelectItem value="no_show" className="text-white text-xs">No Show</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={industryFilter} onValueChange={setIndustryFilter}>
                        <SelectTrigger className="h-7 bg-black/30 border-gray-800 text-[10px] text-white w-auto min-w-[80px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#1a1a1a] border-gray-700">
                            <SelectItem value="all" className="text-white text-xs">All Industries</SelectItem>
                            {INDUSTRIES.map(i => (
                                <SelectItem key={i} value={i} className="text-white text-xs">{getIndustryLabel(i)}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 space-y-3">
                {showAutoSchedule && (
                    <AutoSchedulePanel
                        properties={properties}
                        logs={Array.isArray(logs) ? logs : []}
                        teamMembers={teamMembers}
                        onComplete={handleRefresh}
                    />
                )}

                {isLoading ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                        <Loader2 className="w-7 h-7 animate-spin" style={{ color: accent }} />
                        <span className="text-xs text-gray-500">Loading appointments...</span>
                    </div>
                ) : filteredAppointments.length === 0 ? (
                    <div className="text-center py-16">
                        <Calendar className="w-10 h-10 text-gray-700 mx-auto mb-3" />
                        <p className="text-sm font-bold text-gray-500">No appointments found</p>
                        <p className="text-[10px] text-gray-600 mt-1">Use Auto-Schedule to book top leads</p>
                    </div>
                ) : (
                    grouped.map(([dateKey, appts]) => (
                        <div key={dateKey}>
                            <div className="flex items-center gap-2 mb-2 mt-1">
                                <span className="text-[10px] font-bold text-gray-500 uppercase">{formatDateLabel(dateKey)}</span>
                                <span className="text-[10px] text-gray-700 bg-gray-800/50 px-1.5 py-0.5 rounded-full">{appts.length}</span>
                                <div className="flex-1 h-px bg-gray-800/30" />
                            </div>
                            <div className="space-y-2">
                                {appts.map(a => (
                                    <AppointmentCard key={a.id} appointment={a} onClick={setSelectedAppointment} />
                                ))}
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Detail modal */}
            {selectedAppointment && (
                <AppointmentDetail
                    appointment={selectedAppointment}
                    onClose={() => setSelectedAppointment(null)}
                    onUpdate={() => {
                        handleRefresh();
                        setSelectedAppointment(null);
                    }}
                />
            )}
        </div>
    );
}