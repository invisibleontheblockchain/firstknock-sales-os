import React from 'react';
import { Badge } from "@/components/ui/badge";
import { format } from 'date-fns';
import { CheckCircle2, XCircle, Clock, Home, MessageSquare, Image, MapPin, Trash2, UserX } from 'lucide-react';

const STATUS_ICONS = {
    SOLD: { icon: CheckCircle2, color: 'text-[#39FF4A]', bg: 'bg-[#2EEB57]/10' },
    HARD_NO: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10' },
    CALLBACK: { icon: Clock, color: 'text-[#2EEB57]', bg: 'bg-[#2EEB57]/10' },
    NO_ANSWER: { icon: Home, color: 'text-white', bg: 'bg-white/10' },
    ELIGIBLE: { icon: Home, color: 'text-gray-500', bg: 'bg-gray-500/10' },
    QUALIFIED: { icon: CheckCircle2, color: 'text-[#39FF4A]', bg: 'bg-[#2EEB57]/10' },
    NOT_MOVED_IN: { icon: Clock, color: 'text-orange-400', bg: 'bg-orange-500/10' },
    DM_NOT_HOME: { icon: UserX, color: 'text-gray-300', bg: 'bg-white/10' },
};

export default function PropertyHistory({ logs, onClearDecision }) {
    if (!logs || logs.length === 0) {
        return (
            <div className="text-center py-6 border border-dashed border-gray-800 rounded-xl bg-gray-900/20">
                <MessageSquare className="w-6 h-6 text-gray-700 mx-auto mb-2" />
                <p className="text-xs text-gray-500">No previous interactions</p>
                <p className="text-[10px] text-gray-600 mt-1">Notes and history will appear here</p>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {logs.map((log, idx) => {
                const config = STATUS_ICONS[log.parsed_status] || STATUS_ICONS.ELIGIBLE;
                const StatusIcon = config.icon;

                // Parse note from raw_input_text
                const noteMatch = log.raw_input_text?.match(/Note:\s*(.+?)(\s*\||$)/);
                const note = noteMatch?.[1]?.trim();
                const phoneMatch = log.raw_input_text?.match(/Phone:\s*(.+?)(\s*\||$)/);
                const phone = phoneMatch?.[1]?.trim();
                const timeMatch = log.raw_input_text?.match(/Time:\s*(.+?)(\s*\||$)/);
                const callbackTime = timeMatch?.[1]?.trim();

                return (
                    <div key={log.id || idx} className="bg-white/[0.04] border border-white/10 rounded-2xl p-3 space-y-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                        {/* Header Row */}
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <div className={`w-8 h-8 rounded-xl ${config.bg} border border-white/10 flex items-center justify-center`}>
                                    <StatusIcon className={`w-3.5 h-3.5 ${config.color}`} />
                                </div>
                                <div>
                                    <Badge variant="outline" className={`text-[10px] h-5 border-0 ${config.bg} ${config.color}`}>
                                        {log.parsed_status}
                                    </Badge>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                {log.parsed_status !== 'ELIGIBLE' && onClearDecision && idx === 0 && (
                                    <button
                                        onClick={() => onClearDecision(log)}
                                        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 text-[10px] font-bold active:scale-95"
                                    >
                                        <Trash2 className="w-3 h-3" />
                                        Clear
                                    </button>
                                )}
                                <div className="text-right">
                                    <p className="text-[10px] text-gray-500">
                                        {log.created_date ? format(new Date(log.created_date), 'MMM d, yyyy') : 'Unknown'}
                                    </p>
                                    <p className="text-[9px] text-gray-600">
                                        {log.created_date ? format(new Date(log.created_date), 'h:mm a') : ''}
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Note */}
                        {note && (
                            <div className="bg-black/40 rounded-lg p-2.5 border border-gray-800/50">
                                <p className="text-xs text-gray-300 leading-relaxed">{note}</p>
                            </div>
                        )}

                        {/* Metadata Row */}
                        <div className="flex flex-wrap gap-2">
                            {phone && (
                                <span className="text-[10px] text-gray-500 bg-gray-900 px-2 py-0.5 rounded-full">
                                    📞 {phone}
                                </span>
                            )}
                            {callbackTime && (
                                <span className="text-[10px] text-[#39FF4A]/80 bg-[#2EEB57]/10 px-2 py-0.5 rounded-full">
                                    ⏰ {callbackTime}
                                </span>
                            )}
                            {log.image_url && (
                                <a href={log.image_url} target="_blank" rel="noreferrer"
                                    className="text-[10px] text-white bg-white/5 px-2 py-0.5 rounded-full flex items-center gap-1 hover:bg-white/10">
                                    <Image className="w-3 h-3" /> Photo
                                </a>
                            )}
                            {log.gps_proof_lat && log.gps_accuracy > 0 && (
                                <span className="text-[10px] text-gray-600 flex items-center gap-1">
                                    <MapPin className="w-3 h-3" /> GPS verified
                                </span>
                            )}
                            {log.created_by && (
                                <span className="text-[10px] text-gray-600 ml-auto">
                                    by {log.created_by.split('@')[0]}
                                </span>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}