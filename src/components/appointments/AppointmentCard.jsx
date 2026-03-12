import React from 'react';
import { Calendar, User, Star, ChevronRight, MapPin, Phone } from 'lucide-react';
import { format, isToday, isPast, parseISO } from 'date-fns';
import { getIndustryLabel } from './EligibilityScorer';

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

export default function AppointmentCard({ appointment, onClick }) {
    const status = STATUS_STYLES[appointment.status] || STATUS_STYLES.scheduled;
    const score = appointment.eligibility_score || 0;
    const scoreColor = score >= 70 ? 'text-green-400' : score >= 40 ? 'text-yellow-400' : 'text-red-400';
    const scoreBg = score >= 70 ? 'bg-green-500/10 border-green-500/20' : score >= 40 ? 'bg-yellow-500/10 border-yellow-500/20' : 'bg-red-500/10 border-red-500/20';

    const isOverdue = appointment.scheduled_date && isPast(new Date(appointment.scheduled_date)) && !['completed', 'cancelled'].includes(appointment.status);
    const isTodayAppt = appointment.scheduled_date && isToday(parseISO(appointment.scheduled_date));
    const outcome = OUTCOME_LABELS[appointment.outcome] || OUTCOME_LABELS.pending;

    return (
        <button
            onClick={() => onClick?.(appointment)}
            className={`w-full text-left rounded-2xl p-3.5 transition-all group border ${
                isOverdue ? 'bg-red-500/[0.03] border-red-500/10 hover:border-red-500/20' :
                isTodayAppt ? 'bg-yellow-500/[0.03] border-yellow-500/10 hover:border-yellow-500/20' :
                'bg-white/[0.02] border-white/[0.05] hover:border-white/[0.1]'
            }`}
        >
            <div className="flex items-start gap-3">
                {/* Score circle */}
                <div className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center shrink-0 border ${scoreBg}`}>
                    <span className={`text-sm font-black leading-none ${scoreColor}`}>{score}</span>
                    <Star className={`w-2 h-2 mt-0.5 ${scoreColor}`} />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    {/* Address + status */}
                    <div className="flex items-center gap-2 mb-1">
                        <p className="text-[13px] font-bold text-white truncate">{appointment.full_address || 'Unknown Address'}</p>
                    </div>

                    {/* Meta row */}
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mb-1.5">
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${status.bg} ${status.text} ${status.border}`}>
                            {status.label}
                        </span>
                        {outcome.label && (
                            <span className={`text-[9px] font-bold ${outcome.color}`}>• {outcome.label}</span>
                        )}
                        <span className="text-[9px] font-medium text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded-full">
                            {getIndustryLabel(appointment.industry)}
                        </span>
                    </div>

                    {/* Details row */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-500">
                        <span className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            {appointment.scheduled_date ? format(new Date(appointment.scheduled_date), 'MMM d, h:mm a') : 'Unscheduled'}
                        </span>
                        {appointment.assigned_rep_name && (
                            <span className="flex items-center gap-1">
                                <User className="w-3 h-3" />
                                {appointment.assigned_rep_name}
                            </span>
                        )}
                        {appointment.homeowner_name && (
                            <span className="flex items-center gap-1">
                                <User className="w-2.5 h-2.5" />
                                {appointment.homeowner_name}
                            </span>
                        )}
                        {appointment.phone && (
                            <span className="flex items-center gap-1">
                                <Phone className="w-2.5 h-2.5" />
                                {appointment.phone}
                            </span>
                        )}
                    </div>
                </div>

                <ChevronRight className="w-4 h-4 text-gray-700 group-hover:text-gray-400 transition-colors shrink-0 mt-2" />
            </div>
        </button>
    );
}