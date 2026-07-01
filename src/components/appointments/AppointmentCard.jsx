import React from 'react';
import { Calendar, ChevronRight, MapPin, Phone, Navigation, Trash2 } from 'lucide-react';
import { format, isToday, isPast, parseISO } from 'date-fns';

const STATUS_STYLES = {
    scheduled: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/20', label: 'Scheduled' },
    confirmed: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/20', label: 'Confirmed' },
    completed: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20', label: 'Completed' },
    cancelled: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/20', label: 'Cancelled' },
    no_show: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/20', label: 'No Show' },
    rescheduled: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/20', label: 'Rescheduled' },
};

const OUTCOME_LABELS = {
    sold: { label: 'Sold', color: 'text-green-400' },
    follow_up: { label: 'Follow Up', color: 'text-yellow-400' },
    not_interested: { label: 'Not Interested', color: 'text-red-400' },
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

    return (
        <div
            className={`w-full text-left rounded-xl sm:rounded-2xl p-3 sm:p-4 md:p-5 transition-all group border min-h-[100px] ${
                isOverdue ? 'bg-red-500/[0.03] border-red-500/10 hover:border-red-500/20' :
                isTodayAppt ? 'bg-yellow-500/[0.03] border-yellow-500/10 hover:border-yellow-500/20' :
                'bg-white/[0.02] border-white/[0.05] hover:border-white/[0.1]'
            }`}
        >
            <button onClick={() => onClick?.(appointment)} className="w-full text-left flex items-start gap-2 sm:gap-3 md:gap-4">
                <div className="w-12 h-12 sm:w-14 md:w-16 rounded-lg sm:rounded-xl md:rounded-2xl flex flex-col items-center justify-center shrink-0 border border-white/10 bg-white/[0.04] text-white">
                    <span className="text-[9px] font-black uppercase tracking-wider text-white/35">Appt</span>
                    <span className="text-base sm:text-lg md:text-xl font-black leading-none">#{appointmentNumber || '-'}</span>
                </div>

                <div className="flex-1 min-w-0 flex flex-col">
                    <p className="text-xs sm:text-sm md:text-base font-bold text-white truncate mb-1">{appointment.full_address || 'Unknown'}</p>
                    {appointment.route_name && (
                        <p className="flex items-center gap-1 text-[9px] sm:text-[10px] text-[#39FF4A]/80 truncate mb-1.5">
                            <MapPin className="w-2.5 h-2.5 shrink-0" />
                            {appointment.route_name}
                        </p>
                    )}

                    <div className="flex flex-wrap items-center gap-1 mb-1.5">
                        <span className={`text-[8px] sm:text-[10px] font-bold px-2 py-0.5 rounded-full border ${status.bg} ${status.text} ${status.border} whitespace-nowrap`}>
                            {status.label}
                        </span>
                        {outcome.label && (
                            <span className={`text-[8px] sm:text-[9px] font-bold ${outcome.color} whitespace-nowrap`}>• {outcome.label}</span>
                        )}
                    </div>

                    <div className="flex items-center gap-1.5 text-[8px] sm:text-[10px] text-gray-500">
                        <Calendar className="w-2.5 h-2.5 shrink-0" />
                        <span className="truncate">{appointment.scheduled_date ? format(new Date(appointment.scheduled_date), 'MMM d') : 'Unscheduled'}</span>
                        {appointment.phone && (
                            <>
                                <span className="hidden sm:inline">•</span>
                                <Phone className="w-2.5 h-2.5 shrink-0 hidden sm:inline" />
                                <span className="hidden sm:inline truncate">{appointment.phone.slice(-4)}</span>
                            </>
                        )}
                    </div>
                </div>

                <ChevronRight className="w-4 h-4 sm:w-5 text-gray-700 group-hover:text-gray-400 transition-colors shrink-0 mt-1" />
            </button>

            <div className="mt-3 grid grid-cols-3 gap-1.5 sm:gap-2 pl-0 sm:pl-16 md:pl-20">
                <button onClick={() => canNavigate && onViewMap?.(appointment)} disabled={!canNavigate} className="h-9 rounded-xl border border-[#39FF4A]/30 bg-[#39FF4A]/10 text-[9px] sm:text-[10px] font-black uppercase tracking-[0.1em] text-[#39FF4A] disabled:opacity-35 disabled:text-[#39FF4A]/40 flex items-center justify-center gap-1 active:scale-95">
                    <MapPin className="w-3.5 h-3.5" /> Map
                </button>
                <button onClick={() => canNavigate && onRun?.(appointment)} disabled={!canNavigate} className="h-9 rounded-xl border border-white/10 bg-white/[0.06] text-[9px] sm:text-[10px] font-black uppercase tracking-[0.1em] text-white disabled:opacity-35 disabled:text-white/40 flex items-center justify-center gap-1 active:scale-95">
                    <Navigation className="w-3.5 h-3.5" /> Run
                </button>
                <button onClick={() => onDelete?.(appointment)} className="h-9 rounded-xl border border-red-500/20 bg-red-500/10 text-[9px] sm:text-[10px] font-black uppercase tracking-[0.1em] text-red-300 flex items-center justify-center gap-1 active:scale-95">
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
            </div>
        </div>
    );
}