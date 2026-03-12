import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, Loader2, Plus, Zap, Filter, ChevronDown, Clock, CheckCircle2, XCircle, AlertTriangle, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format, isToday, isTomorrow, isThisWeek, parseISO, isPast } from 'date-fns';

import AppointmentCard from '@/components/appointments/AppointmentCard';
import AppointmentDetail from '@/components/appointments/AppointmentDetail';
import AutoSchedulePanel from '@/components/appointments/AutoSchedulePanel';
import { getIndustryLabel, INDUSTRIES } from '@/components/appointments/EligibilityScorer';

const TIME_TABS = [
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'today', label: 'Today' },
    { id: 'this_week', label: 'This Week' },
    { id: 'past', label: 'Past' },
    { id: 'all', label: 'All' },
];

const STATUS_CHIPS = [
    { id: 'all', label: 'All' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'confirmed', label: 'Confirmed' },
    { id: 'completed', label: 'Completed' },
    { id: 'cancelled', label: 'Cancelled' },
    { id: 'no_show', label: 'No Show' },
];

export default function Appointments() {
    const queryClient = useQueryClient();
    const [selectedAppointment, setSelectedAppointment] = useState(null);
    const [showAutoSchedule, setShowAutoSchedule] = useState(false);
    const [statusFilter, setStatusFilter] = useState('all');
    const [timeFilter, setTimeFilter] = useState('upcoming');
    const [showFilters, setShowFilters] = useState(false);

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

    const stats = useMemo(() => {
        const all = Array.isArray(appointments) ? appointments : [];
        const now = new Date();
        return {
            total: all.length,
            upcoming: all.filter(a => a.scheduled_date && new Date(a.scheduled_date) >= now && !['cancelled', 'completed'].includes(a.status)).length,
            today: all.filter(a => a.scheduled_date && isToday(parseISO(a.scheduled_date))).length,
            completed: all.filter(a => a.status === 'completed').length,
            noShow: all.filter(a => a.status === 'no_show').length,
            cancelled: all.filter(a => a.status === 'cancelled').length,
        };
    }, [appointments]);

    const filteredAppointments = useMemo(() => {
        const now = new Date();
        return (Array.isArray(appointments) ? appointments : [])
            .filter(a => {
                if (statusFilter !== 'all' && a.status !== statusFilter) return false;
                if (timeFilter === 'today' && a.scheduled_date && !isToday(parseISO(a.scheduled_date))) return false;
                if (timeFilter === 'tomorrow' && a.scheduled_date && !isTomorrow(parseISO(a.scheduled_date))) return false;
                if (timeFilter === 'this_week' && a.scheduled_date && !isThisWeek(parseISO(a.scheduled_date))) return false;
                if (timeFilter === 'upcoming' && a.scheduled_date && new Date(a.scheduled_date) < now) return false;
                if (timeFilter === 'past' && a.scheduled_date && new Date(a.scheduled_date) >= now) return false;
                return true;
            })
            .sort((a, b) => {
                if (timeFilter === 'past') return new Date(b.scheduled_date) - new Date(a.scheduled_date);
                return new Date(a.scheduled_date) - new Date(b.scheduled_date);
            });
    }, [appointments, statusFilter, timeFilter]);

    const grouped = useMemo(() => {
        const groups = {};
        filteredAppointments.forEach(a => {
            const dateKey = a.scheduled_date ? format(parseISO(a.scheduled_date), 'yyyy-MM-dd') : 'unscheduled';
            if (!groups[dateKey]) groups[dateKey] = [];
            groups[dateKey].push(a);
        });
        return Object.entries(groups).sort(([a], [b]) => {
            if (timeFilter === 'past') return b.localeCompare(a);
            return a.localeCompare(b);
        });
    }, [filteredAppointments, timeFilter]);

    const handleRefresh = () => queryClient.invalidateQueries({ queryKey: ['appointments'] });

    const formatDateLabel = (dateKey) => {
        if (dateKey === 'unscheduled') return 'Unscheduled';
        const date = parseISO(dateKey);
        if (isToday(date)) return 'Today';
        if (isTomorrow(date)) return 'Tomorrow';
        return format(date, 'EEE, MMM d');
    };

    return (
        <div className="h-full flex flex-col bg-[#09090b]">
            {/* Header */}
            <div className="px-4 md:px-6 pt-4 pb-2 border-b border-white/[0.04] sticky top-0 z-20 backdrop-blur-xl bg-[#09090b]/90">
                <div className="max-w-3xl mx-auto">
                    {/* Title row */}
                    <div className="flex items-center justify-between mb-3">
                        <h1 className="text-lg font-black text-white tracking-tight">Appointments</h1>
                        <Button
                            onClick={() => setShowAutoSchedule(!showAutoSchedule)}
                            className="h-8 px-3 text-[10px] font-bold rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white border border-white/[0.08] gap-1.5"
                        >
                            <Zap className="w-3 h-3 text-yellow-400" /> Auto-Schedule
                        </Button>
                    </div>

                    {/* Stats row - scrollable on mobile */}
                    <div className="flex gap-2 mb-3 overflow-x-auto no-scrollbar -mx-4 px-4 md:mx-0 md:px-0">
                        <StatPill icon={CalendarDays} label="Upcoming" value={stats.upcoming} color="#3b82f6" />
                        <StatPill icon={Clock} label="Today" value={stats.today} color="#eab308" />
                        <StatPill icon={CheckCircle2} label="Done" value={stats.completed} color="#22c55e" />
                        <StatPill icon={AlertTriangle} label="No-Show" value={stats.noShow} color="#f97316" />
                    </div>

                    {/* Time tabs */}
                    <div className="flex gap-1 p-1 bg-white/[0.03] rounded-xl border border-white/[0.05] overflow-x-auto no-scrollbar">
                        {TIME_TABS.map(t => (
                            <button key={t.id} onClick={() => setTimeFilter(t.id)}
                                className={`flex-shrink-0 py-1.5 px-3 rounded-lg text-[10px] font-bold transition-all whitespace-nowrap ${
                                    timeFilter === t.id ? 'bg-white text-black shadow-sm' : 'text-gray-500 hover:text-white'
                                }`}
                            >{t.label}</button>
                        ))}
                    </div>

                    {/* Status chips */}
                    <div className="flex gap-1.5 mt-2 overflow-x-auto no-scrollbar -mx-4 px-4 md:mx-0 md:px-0 pb-2">
                        {STATUS_CHIPS.map(s => (
                            <button key={s.id} onClick={() => setStatusFilter(s.id)}
                                className={`flex-shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold transition-all border ${
                                    statusFilter === s.id ? 'bg-white/[0.08] border-white/15 text-white' : 'border-white/[0.04] text-gray-600 hover:text-gray-400'
                                }`}
                            >{s.label}</button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto">
                <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-3">
                    {showAutoSchedule && (
                        <AutoSchedulePanel
                            properties={properties}
                            logs={Array.isArray(logs) ? logs : []}
                            teamMembers={teamMembers}
                            onComplete={handleRefresh}
                        />
                    )}

                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center py-24 gap-3">
                            <Loader2 className="w-6 h-6 animate-spin text-white/30" />
                            <span className="text-xs text-gray-600">Loading appointments...</span>
                        </div>
                    ) : filteredAppointments.length === 0 ? (
                        <div className="text-center py-20">
                            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mx-auto mb-4">
                                <Calendar className="w-6 h-6 text-gray-600" />
                            </div>
                            <p className="text-sm font-bold text-gray-400 mb-1">No appointments found</p>
                            <p className="text-xs text-gray-600">Try changing your filters or use Auto-Schedule</p>
                        </div>
                    ) : (
                        grouped.map(([dateKey, appts]) => (
                            <div key={dateKey}>
                                <div className="flex items-center gap-2 mb-2 mt-2">
                                    <span className={`text-[11px] font-bold uppercase tracking-wider ${dateKey !== 'unscheduled' && isToday(parseISO(dateKey)) ? 'text-yellow-400' : 'text-gray-500'}`}>
                                        {formatDateLabel(dateKey)}
                                    </span>
                                    <span className="text-[10px] text-gray-700 bg-white/[0.04] px-1.5 py-0.5 rounded-full font-bold">{appts.length}</span>
                                    <div className="flex-1 h-px bg-white/[0.04]" />
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
            </div>

            {/* Detail modal */}
            {selectedAppointment && (
                <AppointmentDetail
                    appointment={selectedAppointment}
                    onClose={() => setSelectedAppointment(null)}
                    onUpdate={() => { handleRefresh(); setSelectedAppointment(null); }}
                />
            )}
        </div>
    );
}

function StatPill({ icon: Icon, label, value, color }) {
    return (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.05] shrink-0">
            <Icon className="w-3.5 h-3.5" style={{ color }} />
            <div>
                <p className="text-sm font-black text-white leading-none">{value}</p>
                <p className="text-[9px] text-gray-500 font-medium">{label}</p>
            </div>
        </div>
    );
}