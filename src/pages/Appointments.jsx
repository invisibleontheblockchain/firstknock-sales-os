import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, Loader2, Plus, Zap, X, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PullToRefresh from '@/components/mobile/PullToRefresh';
import { format, isToday, isTomorrow, isThisWeek, parseISO } from 'date-fns';
import { toast } from 'sonner';

import AppointmentCard from '@/components/appointments/AppointmentCard';
import AppointmentDetail from '@/components/appointments/AppointmentDetail';
import AutoSchedulePanel from '@/components/appointments/AutoSchedulePanel';
import AppointmentsFilterBar from '@/components/appointments/AppointmentsFilterBar';
import TodayFocusBar from '@/components/appointments/TodayFocusBar';
import { openInMaps } from '@/components/logic/navigation';

const callbackKey = (item) => `${item.address_hash || ''}|${item.scheduled_date || item.next_eligible_date || ''}|${item.route_id || ''}`;
const callbackLogId = (item) => (item?.notes || '').match(/callback_log:([^\]]+)/)?.[1] || (item?._source === 'interaction_log' ? String(item.id || '').replace('callback-log-', '') : null);
const isCallbackAppointment = (item) => item?._source === 'interaction_log' || item?.outcome === 'follow_up' || /callback/i.test(item?.notes || '');

const safeIsoDate = (value, fallback) => {
    const date = new Date(value || fallback || Date.now());
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

export default function Appointments() {
    const queryClient = useQueryClient();
    const [selectedAppointment, setSelectedAppointment] = useState(null);
    const [showAutoSchedule, setShowAutoSchedule] = useState(false);
    const [showNewForm, setShowNewForm] = useState(false);
    const [statusFilter, setStatusFilter] = useState('all');
    // The page is a day-of tool first, so it opens on today's work.
    const [timeFilter, setTimeFilter] = useState('today');
    const [sourceFilter, setSourceFilter] = useState('all');
    const deletedCallbackLogsRef = React.useRef(new Set());

    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me(), staleTime: 1000 * 60 * 5 });
    const [localNavigationApp, setLocalNavigationApp] = useState(() => {
        try { return localStorage.getItem('fk_navigation_app') || 'apple'; } catch { return 'apple'; }
    });
    const navigationApp = user?.navigation_app || localNavigationApp || 'apple';

    React.useEffect(() => {
        if (user?.navigation_app) setLocalNavigationApp(user.navigation_app);
    }, [user?.navigation_app]);

    React.useEffect(() => {
        const handler = (event) => {
            const nextApp = event.detail?.navigationApp;
            if (nextApp === 'apple' || nextApp === 'google') setLocalNavigationApp(nextApp);
        };
        window.addEventListener('fk-navigation-app-changed', handler);
        return () => window.removeEventListener('fk-navigation-app-changed', handler);
    }, []);

    // Tenant key: managers own their team's appointments; reps roll up to their manager.
    // The UI filters again after RLS because admins can read global data, but this page must stay account-scoped.
    const tenantManagerId = user?.app_role === 'rep' ? (user?.team_manager_id || null) : (user?.id || null);
    const userEmail = (user?.email || '').toLowerCase();
    const belongsToCurrentAccount = (record) => {
        if (!record || !user) return false;
        if (tenantManagerId && record.manager_id === tenantManagerId) return true;
        const creator = String(record.created_by || '').toLowerCase();
        return !record.manager_id && !!userEmail && creator === userEmail;
    };

    const { data: appointments = [], isLoading: appointmentsLoading, isFetching: appointmentsFetching } = useQuery({
        queryKey: ['appointments', tenantManagerId, userEmail],
        staleTime: 1000 * 60 * 2,
        queryFn: async () => {
            const result = await base44.entities.Appointment.list('-scheduled_date', 500);
            const rows = Array.isArray(result) ? result : (result?.items || []);
            return rows.filter(belongsToCurrentAccount);
        },
        enabled: !!user,
    });

    const { data: properties = [] } = useQuery({
        queryKey: ['masterProperties-appts', user?.email, user?.territory_zip_codes],
        staleTime: 1000 * 60 * 5,
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

    const { data: logs = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs-appts', tenantManagerId, userEmail],
        queryFn: async () => {
            const result = await base44.entities.InteractionLog.list('-created_date', 5000);
            const rows = Array.isArray(result) ? result : (result?.items || []);
            return rows.filter(belongsToCurrentAccount);
        },
        enabled: !!user,
    });

    const callbackHashes = useMemo(() => [...new Set((Array.isArray(logs) ? logs : [])
        .filter((log) => log?.parsed_status === 'CALLBACK' && log.address_hash)
        .map((log) => String(log.address_hash).trim())
        .filter(Boolean))], [logs]);

    const { data: callbackRouteProperties = [] } = useQuery({
        queryKey: ['callbackRouteProperties-appts', user?.id, user?.team_manager_id, callbackHashes.join('|')],
        staleTime: 1000 * 60 * 5,
        queryFn: async () => {
            if (!callbackHashes.length) return [];
            const response = await base44.functions.invoke('getRoutePropertiesByHashes', {
                address_hashes: callbackHashes.slice(0, 5000),
                limit: callbackHashes.length
            });
            return Array.isArray(response.data?.properties) ? response.data.properties : [];
        },
        enabled: !!user && callbackHashes.length > 0,
    });

    const { data: teamMembers = [] } = useQuery({
        queryKey: ['teamMembers-appts', user?.id],
        queryFn: () => user?.id
            ? base44.entities.TeamMember.filter({ manager_id: user.id }, '-created_date', 100).then(r => Array.isArray(r) ? r : (r?.items || []))
            : [],
        enabled: !!user?.id,
    });

    const { data: savedRoutes = [] } = useQuery({
        queryKey: ['savedRoutes-appts', user?.id],
        queryFn: () => user ? base44.entities.SavedRoute.list('-created_date', 500).then(r => Array.isArray(r) ? r : (r?.items || [])) : [],
        enabled: !!user,
        staleTime: 1000 * 60 * 2,
    });

    const propertyByHash = useMemo(() => {
        const map = new Map();
        [...(Array.isArray(properties) ? properties : []), ...(Array.isArray(callbackRouteProperties) ? callbackRouteProperties : [])].forEach((property) => {
            if (property.address_hash) map.set(property.address_hash, property);
            if (property.legacy_hash) map.set(property.legacy_hash, property);
        });
        return map;
    }, [properties, callbackRouteProperties]);

    const routeNameById = useMemo(() => new Map((Array.isArray(savedRoutes) ? savedRoutes : []).map(route => [route.id, route.name])), [savedRoutes]);

    const persistedAppointmentRows = useMemo(() => (Array.isArray(appointments) ? appointments : [])
        .filter((appointment) => !(appointment.notes || '').includes('callback_log:') && (appointment.full_address || '').trim().toLowerCase() !== 'callback address')
        .map(appointment => ({
            ...appointment,
            route_name: appointment.route_name || (appointment.route_id ? routeNameById.get(appointment.route_id) : null)
        })), [appointments, routeNameById]);

    const appointmentRows = useMemo(() => {
        const rows = [...persistedAppointmentRows];
        const existingKeys = new Set(rows.map(callbackKey));
        const existingLogIds = new Set(rows
            .map((appointment) => (appointment.notes || '').match(/callback_log:([^\]]+)/)?.[1])
            .filter(Boolean));

        (Array.isArray(logs) ? logs : [])
            .filter((log) => log?.parsed_status === 'CALLBACK' && log.address_hash && !deletedCallbackLogsRef.current.has(log.id))
            .forEach((log) => {
                const scheduledDate = safeIsoDate(log.next_eligible_date, log.created_date);
                const key = callbackKey({ ...log, scheduled_date: scheduledDate });
                if (existingKeys.has(key) || (log.id && existingLogIds.has(log.id))) return;
                existingKeys.add(key);
                const property = propertyByHash.get(log.address_hash) || {};
                const fullAddress = property.full_address || property.address || `${property.house_number || ''} ${property.street_name || ''}`.trim();
                rows.push({
                    id: `callback-log-${log.id || key}`,
                    _source: 'interaction_log',
                    address_hash: log.address_hash,
                    manager_id: log.manager_id || tenantManagerId,
                    full_address: fullAddress || `Callback — ${log.address_hash}`,
                    is_unresolved_callback: !fullAddress,
                    homeowner_name: null,
                    phone: null,
                    scheduled_date: scheduledDate,
                    industry: 'other',
                    status: 'scheduled',
                    outcome: 'follow_up',
                    route_id: log.route_id || null,
                    route_name: log.route_id ? routeNameById.get(log.route_id) : null,
                    zip_code: property.zip_code || property.zip || null,
                    lat: property.lat || null,
                    lng: property.lng || null,
                    notes: `${log.raw_input_text || 'Callback scheduled from Knock Mode'}${log.id ? ` [callback_log:${log.id}]` : ''}`,
                    created_by: log.created_by,
                    created_date: log.created_date
                });
            });

        return rows;
    }, [persistedAppointmentRows, logs, propertyByHash, routeNameById, tenantManagerId]);

    const stats = useMemo(() => {
        const all = appointmentRows;
        const now = new Date();
        return {
            total: all.length,
            upcoming: all.filter(a => a.scheduled_date && new Date(a.scheduled_date) >= now && !['cancelled', 'completed'].includes(a.status)).length,
            today: all.filter(a => a.scheduled_date && isToday(parseISO(a.scheduled_date))).length,
            callbacks: all.filter(isCallbackAppointment).length,
            completed: all.filter(a => a.status === 'completed').length,
            noShow: all.filter(a => a.status === 'no_show').length,
            cancelled: all.filter(a => a.status === 'cancelled').length,
        };
    }, [appointmentRows]);

    // Counts shown on the time tabs so the day's workload is visible before switching.
    const timeCounts = useMemo(() => {
        const now = new Date();
        const scheduled = appointmentRows.filter(a => a.scheduled_date);
        return {
            today: scheduled.filter(a => isToday(parseISO(a.scheduled_date))).length,
            upcoming: scheduled.filter(a => new Date(a.scheduled_date) >= now).length,
            this_week: scheduled.filter(a => isThisWeek(parseISO(a.scheduled_date))).length,
            past: scheduled.filter(a => new Date(a.scheduled_date) < now).length,
            all: appointmentRows.length,
        };
    }, [appointmentRows]);

    const filteredAppointments = useMemo(() => {
        const now = new Date();
        return appointmentRows
            .filter(a => {
                if (statusFilter !== 'all' && a.status !== statusFilter) return false;
                if (sourceFilter === 'callbacks' && !isCallbackAppointment(a)) return false;
                if (sourceFilter === 'appointments' && isCallbackAppointment(a)) return false;
                if (timeFilter === 'today' && a.scheduled_date && !isToday(parseISO(a.scheduled_date))) return false;
                if (timeFilter === 'tomorrow' && a.scheduled_date && !isTomorrow(parseISO(a.scheduled_date))) return false;
                if (timeFilter === 'this_week' && a.scheduled_date && !isThisWeek(parseISO(a.scheduled_date))) return false;
                if (timeFilter === 'upcoming' && a.scheduled_date && new Date(a.scheduled_date) < now) return false;
                if (timeFilter === 'past' && a.scheduled_date && new Date(a.scheduled_date) >= now) return false;
                return true;
            })
            .sort((a, b) => {
                const now = Date.now();
                const aTime = a.scheduled_date ? new Date(a.scheduled_date).getTime() : Number.POSITIVE_INFINITY;
                const bTime = b.scheduled_date ? new Date(b.scheduled_date).getTime() : Number.POSITIVE_INFINITY;
                const aValid = Number.isFinite(aTime);
                const bValid = Number.isFinite(bTime);
                if (!aValid && !bValid) return 0;
                if (!aValid) return 1;
                if (!bValid) return -1;
                if (timeFilter === 'past') return bTime - aTime;
                const aUpcoming = aTime >= now;
                const bUpcoming = bTime >= now;
                if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
                return aUpcoming ? aTime - bTime : bTime - aTime;
            });
    }, [appointmentRows, statusFilter, sourceFilter, timeFilter]);

    const appointmentNumbers = useMemo(() => new Map(filteredAppointments.map((appointment, index) => [appointment.id, index + 1])), [filteredAppointments]);
    const showInitialLoading = !user || appointmentsLoading || (appointmentsFetching && appointmentRows.length === 0) || (logsLoading && appointmentRows.length === 0);

    const grouped = useMemo(() => {
        const groups = {};
        filteredAppointments.forEach(a => {
            const dateKey = a.scheduled_date ? format(parseISO(a.scheduled_date), 'yyyy-MM-dd') : 'unscheduled';
            if (!groups[dateKey]) groups[dateKey] = [];
            groups[dateKey].push(a);
        });
        return Object.entries(groups).sort(([a], [b]) => {
            if (a === 'unscheduled' && b === 'unscheduled') return 0;
            if (a === 'unscheduled') return 1;
            if (b === 'unscheduled') return -1;
            if (timeFilter === 'past') return b.localeCompare(a);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const aTime = new Date(a).getTime();
            const bTime = new Date(b).getTime();
            const aUpcoming = aTime >= today.getTime();
            const bUpcoming = bTime >= today.getTime();
            if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
            return aUpcoming ? aTime - bTime : bTime - aTime;
        });
    }, [filteredAppointments, timeFilter]);

    React.useEffect(() => {
        if (!appointments.length) return;
        const timers = appointments
            .filter(a => a.scheduled_date && !['completed', 'cancelled'].includes(a.status))
            .map((appointment) => {
                const scheduled = new Date(appointment.scheduled_date).getTime();
                const reminderAt = scheduled - 30 * 60 * 1000;
                const delay = reminderAt - Date.now();
                if (delay < 0 || delay > 24 * 60 * 60 * 1000) return null;
                return window.setTimeout(() => {
                    const key = `fk_callback_reminded_${appointment.id}`;
                    if (localStorage.getItem(key)) return;
                    localStorage.setItem(key, '1');
                    const title = 'Callback in 30 minutes';
                    const body = appointment.full_address || appointment.homeowner_name || 'Scheduled callback';
                    toast.info(`${title}: ${body}`, { duration: 10000 });
                    if ('Notification' in window) {
                        if (Notification.permission === 'granted') new Notification(title, { body });
                        else if (Notification.permission !== 'denied') {
                            Notification.requestPermission().then((permission) => {
                                if (permission === 'granted') new Notification(title, { body });
                            });
                        }
                    }
                }, delay);
            })
            .filter(Boolean);
        return () => timers.forEach((timer) => window.clearTimeout(timer));
    }, [appointments]);

    const handleRefresh = () => {
        queryClient.invalidateQueries({ queryKey: ['appointments'] });
        queryClient.invalidateQueries({ queryKey: ['interactionLogs-appts'] });
        queryClient.invalidateQueries({ queryKey: ['callbackRouteProperties-appts'] });
    };

    const buildAppointmentMapParams = (appointment) => {
        const params = new URLSearchParams();
        params.set('appointment', '1');
        if (appointment.route_id) params.set('savedRoute', appointment.route_id);
        if (appointment.address_hash) params.set('focus', appointment.address_hash);
        const lat = Number(appointment.lat);
        const lng = Number(appointment.lng);
        const hasCoords = appointment.lat !== null && appointment.lat !== undefined && appointment.lng !== null && appointment.lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng);
        if (hasCoords) {
            params.set('lat', String(lat));
            params.set('lng', String(lng));
        }
        if (appointment.full_address) params.set('address', appointment.full_address);
        return params;
    };

    const handleViewOnMap = (appointment) => {
        if (appointment.is_unresolved_callback) {
            toast.error('This callback is visible, but its address is still being hydrated.');
            return;
        }
        window.location.href = `/Home?${buildAppointmentMapParams(appointment).toString()}`;
    };

    const handleRunAppointment = (appointment) => {
        const lat = Number(appointment.lat);
        const lng = Number(appointment.lng);
        const hasCoords = appointment.lat !== null && appointment.lat !== undefined && appointment.lng !== null && appointment.lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng);
        const address = appointment.is_unresolved_callback ? '' : (appointment.full_address || '');
        if (!hasCoords && !address.trim()) {
            toast.error('This appointment needs an address before it can open in maps.');
            return;
        }
        openInMaps(hasCoords ? lat : undefined, hasCoords ? lng : undefined, address, navigationApp);
    };

    const deleteAppointmentRecord = async (appointment) => {
        const logId = callbackLogId(appointment);
        if (logId) deletedCallbackLogsRef.current.add(logId);
        if (appointment._source === 'interaction_log') {
            if (logId) {
                try { await base44.entities.InteractionLog.delete(logId); }
                catch (error) { console.warn('Callback log could not be deleted', error); }
            }
            return;
        }
        await base44.entities.Appointment.delete(appointment.id);
        if (logId) {
            try { await base44.entities.InteractionLog.delete(logId); }
            catch (error) { console.warn('Linked callback log could not be deleted', error); }
        }
    };

    const removeAppointmentsFromCache = (items) => {
        const ids = new Set(items.map((item) => item.id).filter((id) => id && !String(id).startsWith('callback-log-')));
        if (!ids.size) return;
        queryClient.setQueryData(['appointments', tenantManagerId, userEmail], (old) => {
            const rows = Array.isArray(old) ? old : (old?.items || []);
            const nextRows = rows.filter((row) => !ids.has(row.id));
            return Array.isArray(old) ? nextRows : { ...old, items: nextRows };
        });
    };

    const deleteMutation = useMutation({
        mutationFn: deleteAppointmentRecord,
        onSuccess: (_, appointment) => {
            removeAppointmentsFromCache([appointment]);
            toast.success('Appointment deleted');
            setSelectedAppointment(null);
            handleRefresh();
        },
        onError: () => toast.error('Could not delete appointment'),
    });

    const deleteAllMutation = useMutation({
        mutationFn: async (items) => {
            const results = await Promise.allSettled(items.map((appointment) => deleteAppointmentRecord(appointment)));
            const failed = results.filter((result) => result.status === 'rejected').length;
            return { deleted: items.length - failed, failed };
        },
        onSuccess: ({ deleted, failed }, items) => {
            removeAppointmentsFromCache(items);
            if (deleted > 0) toast.success(`${deleted} appointment${deleted === 1 ? '' : 's'} deleted`);
            if (failed > 0) toast.error(`${failed} appointment${failed === 1 ? '' : 's'} could not be deleted`);
            setSelectedAppointment(null);
            handleRefresh();
        },
        onError: () => toast.error('Could not delete all appointments'),
    });

    const handleDeleteAppointment = (appointment) => {
        if (!confirm('Delete this appointment?')) return;
        deleteMutation.mutate(appointment);
    };

    const handleDeleteAllShown = () => {
        if (!filteredAppointments.length) return;
        if (!confirm(`Delete ${filteredAppointments.length} currently shown appointment${filteredAppointments.length === 1 ? '' : 's'}?`)) return;
        deleteAllMutation.mutate(filteredAppointments);
    };

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
            <div className="px-4 md:px-8 lg:px-10 pt-4 md:pt-6 pb-2 md:pb-3 border-b border-white/[0.04] sticky top-0 z-20 backdrop-blur-xl bg-[#09090b]/90">
                <div className="max-w-7xl mx-auto">
                    {/* Title row */}
                    <div className="flex items-center justify-between gap-2 mb-3">
                        <div className="min-w-0">
                            <h1 className="text-lg md:text-2xl font-black text-white tracking-tight leading-none">Appointments</h1>
                            <p className="text-[10px] md:text-xs text-gray-500 mt-1 truncate">
                                {format(new Date(), 'EEEE, MMM d')} • {stats.today} today
                            </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <Button
                                onClick={() => { setShowNewForm(!showNewForm); setShowAutoSchedule(false); }}
                                className="h-9 md:h-10 px-3 md:px-5 text-[10px] md:text-xs font-bold rounded-xl bg-white text-black hover:bg-gray-200 gap-1.5"
                            >
                                <Plus className="w-3.5 h-3.5" /> New
                            </Button>
                            <Button
                                onClick={() => { setShowAutoSchedule(!showAutoSchedule); setShowNewForm(false); }}
                                className="h-9 md:h-10 px-3 md:px-5 text-[10px] md:text-xs font-bold rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-white border border-white/[0.08] gap-1.5"
                            >
                                <Zap className="w-3.5 h-3.5 text-[#39FF4A]" /> <span className="hidden sm:inline">Auto-Schedule</span><span className="sm:hidden">Auto</span>
                            </Button>
                            <button
                                onClick={handleDeleteAllShown}
                                disabled={deleteAllMutation.isPending || filteredAppointments.length === 0}
                                title="Delete all shown appointments"
                                className="h-9 w-9 md:h-10 md:w-10 shrink-0 rounded-xl flex items-center justify-center text-gray-600 hover:text-red-300 hover:bg-white/[0.06] transition-colors disabled:opacity-30 disabled:hover:text-gray-600"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    <div className="space-y-2 mb-1">
                        <TodayFocusBar
                            stats={stats}
                            timeFilter={timeFilter}
                            sourceFilter={sourceFilter}
                            onFocusToday={() => { setTimeFilter('today'); setSourceFilter('all'); setStatusFilter('all'); }}
                            onFocusCallbacks={() => { setSourceFilter(sourceFilter === 'callbacks' ? 'all' : 'callbacks'); setTimeFilter('all'); }}
                            onFocusStatus={(status) => { setStatusFilter(statusFilter === status ? 'all' : status); setTimeFilter('all'); }}
                        />
                        <AppointmentsFilterBar
                            timeFilter={timeFilter}
                            onTimeFilterChange={setTimeFilter}
                            sourceFilter={sourceFilter}
                            onSourceFilterChange={setSourceFilter}
                            statusFilter={statusFilter}
                            onStatusFilterChange={setStatusFilter}
                            counts={timeCounts}
                        />
                    </div>
                </div>
            </div>

            {/* Content */}
            <PullToRefresh onRefresh={handleRefresh} className="flex-1 overflow-auto">
                <div className="max-w-7xl mx-auto p-3 sm:p-4 md:p-8 lg:p-10 space-y-2 sm:space-y-3 md:space-y-5">
                    {showNewForm && (
                        <NewAppointmentForm
                            managerId={tenantManagerId}
                            onSave={() => { handleRefresh(); setShowNewForm(false); }}
                            onCancel={() => setShowNewForm(false)}
                        />
                    )}

                    {showAutoSchedule && (
                        <AutoSchedulePanel
                            managerId={tenantManagerId}
                            properties={properties}
                            logs={Array.isArray(logs) ? logs : []}
                            teamMembers={teamMembers}
                            onComplete={handleRefresh}
                        />
                    )}

                    {showInitialLoading ? (
                        <div className="flex flex-col items-center justify-center py-24 gap-3">
                            <Loader2 className="w-6 h-6 animate-spin text-white/30" />
                            <span className="text-xs text-gray-600">Loading appointments...</span>
                        </div>
                    ) : filteredAppointments.length === 0 ? (
                        <div className="text-center py-20">
                            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mx-auto mb-4">
                                <Calendar className="w-6 h-6 text-gray-600" />
                            </div>
                            <p className="text-sm font-bold text-gray-400 mb-1">
                                {timeFilter === 'today' ? 'Nothing booked for today' : 'No appointments found'}
                            </p>
                            <p className="text-xs text-gray-600">
                                {timeFilter === 'today' ? 'Check Upcoming, or add one with New.' : 'Try changing your filters or use Auto-Schedule.'}
                            </p>
                        </div>
                    ) : (
                        grouped.map(([dateKey, appts]) => (
                            <div key={dateKey}>
                                <div className="flex items-center gap-2 mb-2 md:mb-3 mt-2 md:mt-4">
                                    <span className={`text-[11px] md:text-sm font-bold uppercase tracking-wider ${dateKey !== 'unscheduled' && isToday(parseISO(dateKey)) ? 'text-yellow-400' : 'text-gray-500'}`}>
                                        {formatDateLabel(dateKey)}
                                    </span>
                                    <span className="text-[10px] md:text-xs text-gray-700 bg-white/[0.04] px-1.5 md:px-2 py-0.5 md:py-1 rounded-full font-bold">{appts.length}</span>
                                    <div className="flex-1 h-px bg-white/[0.04]" />
                                </div>
                                <div className="space-y-2 md:space-y-3">
                                    {appts.map((appointment) => (
                                        <AppointmentCard
                                            key={appointment.id}
                                            appointment={appointment}
                                            appointmentNumber={appointmentNumbers.get(appointment.id)}
                                            onClick={(appt) => setSelectedAppointment({ ...appt, appointment_number: appointmentNumbers.get(appt.id) })}
                                            onViewMap={handleViewOnMap}
                                            onRun={handleRunAppointment}
                                            onDelete={handleDeleteAppointment}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </PullToRefresh>

            {/* Detail modal */}
            {selectedAppointment && (
                <AppointmentDetail
                    appointment={selectedAppointment}
                    onClose={() => setSelectedAppointment(null)}
                    onUpdate={() => { handleRefresh(); setSelectedAppointment(null); }}
                    onViewMap={handleViewOnMap}
                    onRun={handleRunAppointment}
                    onDelete={handleDeleteAppointment}
                />
            )}
        </div>
    );
}

function NewAppointmentForm({ onSave, onCancel, managerId }) {
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState({
        full_address: '',
        homeowner_name: '',
        phone: '',
        scheduled_date: '',
        notes: '',
    });

    const handleCreate = async () => {
        if (!form.full_address.trim()) return;
        setSaving(true);
        try {
            await base44.entities.Appointment.create({
                full_address: form.full_address.trim(),
                homeowner_name: form.homeowner_name.trim() || null,
                phone: form.phone.trim() || null,
                scheduled_date: form.scheduled_date ? new Date(form.scheduled_date).toISOString() : new Date().toISOString(),
                notes: form.notes.trim() || null,
                status: 'scheduled',
                manager_id: managerId || null,
            });
            onSave?.();
        } catch (e) {
            console.error('Failed to create appointment', e);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 space-y-4 animate-in slide-in-from-top-2">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Plus className="w-4 h-4 text-yellow-400" /> New Appointment
                </h3>
                <button onClick={onCancel} className="text-gray-500 hover:text-white transition-colors">
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="md:col-span-2">
                    <label className="text-[10px] font-bold text-gray-500 mb-1 block uppercase tracking-wider">Address *</label>
                    <input
                        value={form.full_address}
                        onChange={e => setForm({ ...form, full_address: e.target.value })}
                        placeholder="123 Main St, City, ST 12345"
                        className="w-full h-9 px-3 text-sm bg-black/40 border border-white/[0.08] rounded-xl text-white placeholder:text-gray-600 outline-none focus:border-white/20"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-gray-500 mb-1 block uppercase tracking-wider">Homeowner</label>
                    <input
                        value={form.homeowner_name}
                        onChange={e => setForm({ ...form, homeowner_name: e.target.value })}
                        placeholder="John Doe"
                        className="w-full h-9 px-3 text-sm bg-black/40 border border-white/[0.08] rounded-xl text-white placeholder:text-gray-600 outline-none focus:border-white/20"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-gray-500 mb-1 block uppercase tracking-wider">Phone</label>
                    <input
                        type="tel"
                        value={form.phone}
                        onChange={e => setForm({ ...form, phone: e.target.value })}
                        placeholder="(555) 123-4567"
                        className="w-full h-9 px-3 text-sm bg-black/40 border border-white/[0.08] rounded-xl text-white placeholder:text-gray-600 outline-none focus:border-white/20"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-gray-500 mb-1 block uppercase tracking-wider">Date & Time</label>
                    <input
                        type="datetime-local"
                        value={form.scheduled_date}
                        onChange={e => setForm({ ...form, scheduled_date: e.target.value })}
                        className="w-full h-9 px-3 text-sm bg-black/40 border border-white/[0.08] rounded-xl text-white outline-none focus:border-white/20 [color-scheme:dark]"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-gray-500 mb-1 block uppercase tracking-wider">Notes</label>
                    <input
                        value={form.notes}
                        onChange={e => setForm({ ...form, notes: e.target.value })}
                        placeholder="Optional notes..."
                        className="w-full h-9 px-3 text-sm bg-black/40 border border-white/[0.08] rounded-xl text-white placeholder:text-gray-600 outline-none focus:border-white/20"
                    />
                </div>
            </div>

            <div className="flex gap-2 pt-1">
                <button
                    onClick={handleCreate}
                    disabled={saving || !form.full_address.trim()}
                    className="flex-1 h-10 rounded-xl text-xs font-bold transition-all disabled:opacity-40 bg-white text-black hover:bg-gray-200"
                >
                    {saving ? 'Creating...' : 'Create Appointment'}
                </button>
                <button
                    onClick={onCancel}
                    className="h-10 px-5 rounded-xl text-xs font-bold text-gray-500 bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] transition-all"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}