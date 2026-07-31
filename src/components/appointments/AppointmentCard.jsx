import React from 'react';
import { Calendar, ChevronRight, MapPin, Phone, Navigation, Trash2 } from 'lucide-react';
import { format, isToday, isPast, parseISO } from 'date-fns';

const STATUS_STYLES = {
    scheduled: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/20', label: 'Scheduled' },
    confirmed: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/20', label: 'Confirmed' },
    completed: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20', label: 'Completed' },
    cancelled: { bg: 'bg-white/[0.06]', text: 'text-gray-400', border: 'border-white/10', label: 'Cancelled' },
    no_show: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20', label: 'No Show' },
    rescheduled: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/20', label: 'Rescheduled' },
};

const OUTCOME_LABELS = {
    sold: { label: 'Sold', color: 'text-green-400' },
    follow_up: { label: 'Follow Up', color: 'text-[#39FF4A]' },
    not_interested: { label: 'Not Interested', color: 'text-gray-400' },
    not_home: { label: 'Not Home', color: 'text-gray-400' },
    pending: { label: '', color: '' },
};

export default function AppointmentCard({ appointment, appointmentNumber, onClick, onViewMap, onRun, onDelete }) {
    const status = STATUS_STYLES[appointment.status] || STATUS_STYLES.scheduled;
    const isOverdue = appointment.scheduled_date && isPast(new Date(appointment.scheduled_date)) && !['completed', 'cancelled'].includes(appointment.status);
    const isTodayAppt = appointment.scheduled_date && isToday(parseISO(appointment.scheduled_date));
    const outcome = OUTCOME_LABELS[appointment.outcome] || OUTCOME_LABELS.pending;
    const hasCoords = appointment.lat !== null && appointment.lat !== undefined && appointment.lng !== null && appointment.lng !== undefined && Number.isFinite(Number(appointment.lat)) && Number.isFinite(Number(appointment.lng));
    const canNavigate = !appointment.is_unresolved_callback && (hasCoords || !!appointment.full_address);
    // Urgency reads as a thin accent rail instead of a full tinted backdrop.
    const accent = isTodayAppt ? '#39FF4A' : isOverdue ? '#fbbf24' : 'rgba(255,255,255,0.08)';

    return (
        <div
            className="relative w-full overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 sm:p-4 transition-all group hover:border-white/[0.12] hover:bg-white/[0.035]"
        >
            <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: accent }} />

            <button onClick={() => onClick?.(appointment)} className="w-full text-left flex items-center gap-3 pl-1.5">
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex flex-col items-center justify-center shrink-0 border border-white/10 bg-white/[0.04] text-white">
                    <span className="text-[8px] font-black uppercase tracking-wider text-white/35">Appt</span>
                    <span className="text-base sm:text-lg font-black leading-none">#{appointmentNumber || '-'}</span>
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <p className="text-sm sm:text-base font-bold text-white truncate">{appointment.full_address || 'Unknown'}</p>
                        {isTodayAppt && (
                            <span className="shrink-0 text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-[#39FF4A]/15 text-[#39FF4A]">Today</span>
                        )}
                        {!isTodayAppt && isOverdue && (
                            <span className="shrink-0 text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">Overdue</span>
                        )}
                    </div>

                    <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mt-1.5">
                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${status.bg} ${status.text} ${status.border} whitespace-nowrap`}>
                            {status.label}
                        </span>
                        {outcome.label && (
                            <span className={`text-[9px] font-bold ${outcome.color} whitespace-nowrap`}>{outcome.label}</span>
                        )}
                        <span className="flex items-center gap-1 text-[10px] text-gray-500 whitespace-nowrap">
                            <Calendar className="w-2.5 h-2.5 shrink-0" />
                            {appointment.scheduled_date ? format(new Date(appointment.scheduled_date), 'MMM d, h:mm a') : 'Unscheduled'}
                        </span>
                        {appointment.phone && (
                            <span className="hidden sm:flex items-center gap-1 text-[10px] text-gray-500">
                                <Phone className="w-2.5 h-2.5 shrink-0" />{appointment.phone}
                            </span>
                        )}
                        {appointment.route_name && (
                            <span className="flex items-center gap-1 text-[10px] text-[#39FF4A]/70 truncate max-w-[140px]">
                                <MapPin className="w-2.5 h-2.5 shrink-0" />{appointment.route_name}
                            </span>
                        )}
                    </div>
                </div>

                <ChevronRight className="w-4 h-4 text-gray-700 group-hover:text-gray-400 transition-colors shrink-0" />
            </button>

            <div className="mt-3 flex items-center gap-1.5 pl-1.5 sm:pl-[68px]">
                <button
                    onClick={() => canNavigate && onRun?.(appointment)}
                    disabled={!canNavigate}
                    className="flex-1 h-9 rounded-xl border border-[#39FF4A]/25 bg-[#39FF4A]/10 text-[10px] font-black uppercase tracking-[0.1em] text-[#39FF4A] disabled:opacity-30 flex items-center justify-center gap-1.5 active:scale-95"
                >
                    <Navigation className="w-3.5 h-3.5" /> Navigate
                </button>
                <button
                    onClick={() => canNavigate && onViewMap?.(appointment)}
                    disabled={!canNavigate}
                    className="flex-1 h-9 rounded-xl border border-white/10 bg-white/[0.05] text-[10px] font-black uppercase tracking-[0.1em] text-white/80 disabled:opacity-30 flex items-center justify-center gap-1.5 active:scale-95"
                >
                    <MapPin className="w-3.5 h-3.5" /> Map
                </button>
                <button
                    onClick={() => onDelete?.(appointment)}
                    title="Delete appointment"
                    className="h-9 w-9 shrink-0 rounded-xl flex items-center justify-center text-gray-600 hover:text-red-300 hover:bg-white/[0.06] transition-colors active:scale-95"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
}