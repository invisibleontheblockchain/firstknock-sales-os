import React from 'react';
import { Calendar, User, Star, ChevronRight } from 'lucide-react';
import { useTheme } from '@/components/theme/ThemeProvider';
import { format } from 'date-fns';
import { getIndustryLabel } from './EligibilityScorer';

const STATUS_COLORS = {
    scheduled: { bg: '#3b82f620', text: '#3b82f6', label: 'Scheduled' },
    confirmed: { bg: '#22c55e20', text: '#22c55e', label: 'Confirmed' },
    completed: { bg: '#10b98120', text: '#10b981', label: 'Completed' },
    cancelled: { bg: '#ef444420', text: '#ef4444', label: 'Cancelled' },
    no_show: { bg: '#f9731620', text: '#f97316', label: 'No Show' },
    rescheduled: { bg: '#8b5cf620', text: '#8b5cf6', label: 'Rescheduled' },
};

export default function AppointmentCard({ appointment, onClick }) {
    const { accent } = useTheme();
    const status = STATUS_COLORS[appointment.status] || STATUS_COLORS.scheduled;
    const score = appointment.eligibility_score || 0;
    const scoreColor = score >= 70 ? '#22c55e' : score >= 40 ? '#eab308' : '#ef4444';

    return (
        <button
            onClick={() => onClick?.(appointment)}
            className="w-full text-left bg-[#111] border border-gray-800/60 rounded-2xl p-4 hover:bg-white/[0.02] transition-all group"
        >
            <div className="flex items-start gap-3">
                {/* Score badge */}
                <div className="w-11 h-11 rounded-xl flex flex-col items-center justify-center shrink-0" style={{ background: `${scoreColor}15`, border: `1px solid ${scoreColor}30` }}>
                    <span className="text-sm font-extrabold" style={{ color: scoreColor }}>{score}</span>
                    <Star className="w-2.5 h-2.5" style={{ color: scoreColor }} />
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-bold text-white truncate">{appointment.full_address || 'Unknown Address'}</p>
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0" style={{ background: status.bg, color: status.text }}>
                            {status.label}
                        </span>
                    </div>

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
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full" style={{ background: `${accent}15`, color: accent }}>
                            {getIndustryLabel(appointment.industry)}
                        </span>
                    </div>

                    {appointment.homeowner_name && (
                        <p className="text-[10px] text-gray-400 mt-1.5">{appointment.homeowner_name} {appointment.phone ? `• ${appointment.phone}` : ''}</p>
                    )}
                </div>

                <ChevronRight className="w-4 h-4 text-gray-700 group-hover:text-gray-400 transition-colors shrink-0 mt-1" />
            </div>
        </button>
    );
}