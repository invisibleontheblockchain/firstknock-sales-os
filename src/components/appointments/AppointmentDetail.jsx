import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Calendar, MapPin, User, Phone, Mail, Star, FileText, X, Check, Ban, Clock, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';
import { format } from 'date-fns';
import { getIndustryLabel } from './EligibilityScorer';

const OUTCOMES = [
    { value: 'sold', label: 'Sold', color: '#22c55e', icon: Check },
    { value: 'follow_up', label: 'Follow Up', color: '#eab308', icon: Clock },
    { value: 'not_interested', label: 'Not Interested', color: '#ef4444', icon: Ban },
    { value: 'not_home', label: 'Not Home', color: '#6b7280', icon: RotateCcw },
];

const STATUSES = [
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'no_show', label: 'No Show' },
    { value: 'rescheduled', label: 'Rescheduled' },
];

export default function AppointmentDetail({ appointment, onClose, onUpdate }) {
    const { accent } = useTheme();
    const accentText = contrastText(accent);
    const [editing, setEditing] = useState(false);
    const [form, setForm] = useState({
        homeowner_name: appointment.homeowner_name || '',
        phone: appointment.phone || '',
        email: appointment.email || '',
        notes: appointment.notes || '',
        scheduled_date: appointment.scheduled_date ? format(new Date(appointment.scheduled_date), "yyyy-MM-dd'T'HH:mm") : '',
    });
    const [saving, setSaving] = useState(false);

    const score = appointment.eligibility_score || 0;
    const scoreColor = score >= 70 ? '#22c55e' : score >= 40 ? '#eab308' : '#ef4444';
    const factors = appointment.scoring_factors || {};

    const handleSave = async () => {
        setSaving(true);
        await base44.entities.Appointment.update(appointment.id, {
            ...form,
            scheduled_date: form.scheduled_date ? new Date(form.scheduled_date).toISOString() : appointment.scheduled_date,
        });
        onUpdate?.();
        setEditing(false);
        setSaving(false);
    };

    const handleStatusChange = async (newStatus) => {
        await base44.entities.Appointment.update(appointment.id, { status: newStatus });
        onUpdate?.();
    };

    const handleOutcome = async (outcome) => {
        await base44.entities.Appointment.update(appointment.id, { outcome, status: 'completed' });
        onUpdate?.();
    };

    return (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
            <div className="bg-[#111] border border-gray-800/60 rounded-t-3xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="sticky top-0 bg-[#111] px-5 py-4 border-b border-gray-800/40 flex items-center justify-between z-10">
                    <div>
                        <p className="text-sm font-bold text-white">{appointment.full_address}</p>
                        <p className="text-[10px] text-gray-500">{getIndustryLabel(appointment.industry)} Appointment</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-800/50 flex items-center justify-center hover:bg-gray-700">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>

                <div className="p-5 space-y-5">
                    {/* Score */}
                    <div className="bg-black/30 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-xs font-bold text-gray-400">Eligibility Score</span>
                            <span className="text-2xl font-extrabold" style={{ color: scoreColor }}>{score}</span>
                        </div>
                        <div className="space-y-2">
                            {Object.entries(factors).map(([key, val]) => (
                                <div key={key} className="flex items-center gap-2">
                                    <span className="text-[10px] text-gray-500 w-24 capitalize">{key.replace(/_/g, ' ')}</span>
                                    <div className="flex-1 h-1.5 bg-gray-800/50 rounded-full overflow-hidden">
                                        <div className="h-full rounded-full" style={{ width: `${val}%`, background: val >= 70 ? '#22c55e' : val >= 40 ? '#eab308' : '#ef4444' }} />
                                    </div>
                                    <span className="text-[10px] font-bold text-gray-400 w-8 text-right">{val}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Details / Edit */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-xs text-gray-300">
                            <Calendar className="w-3.5 h-3.5 text-gray-500" />
                            {editing ? (
                                <Input type="datetime-local" value={form.scheduled_date} onChange={e => setForm({ ...form, scheduled_date: e.target.value })} className="h-8 bg-black/30 border-gray-700 text-xs text-white" />
                            ) : (
                                <span>{appointment.scheduled_date ? format(new Date(appointment.scheduled_date), 'EEEE, MMM d yyyy • h:mm a') : 'No date set'}</span>
                            )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-gray-300">
                            <User className="w-3.5 h-3.5 text-gray-500" />
                            {editing ? (
                                <Input placeholder="Homeowner name" value={form.homeowner_name} onChange={e => setForm({ ...form, homeowner_name: e.target.value })} className="h-8 bg-black/30 border-gray-700 text-xs text-white" />
                            ) : (
                                <span>{appointment.homeowner_name || 'Unknown'}</span>
                            )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-gray-300">
                            <Phone className="w-3.5 h-3.5 text-gray-500" />
                            {editing ? (
                                <Input placeholder="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="h-8 bg-black/30 border-gray-700 text-xs text-white" />
                            ) : (
                                <span>{appointment.phone || 'No phone'}</span>
                            )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-gray-300">
                            <FileText className="w-3.5 h-3.5 text-gray-500" />
                            {editing ? (
                                <Input placeholder="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="h-8 bg-black/30 border-gray-700 text-xs text-white" />
                            ) : (
                                <span>{appointment.notes || 'No notes'}</span>
                            )}
                        </div>
                        {appointment.assigned_rep_name && (
                            <div className="flex items-center gap-2 text-xs text-gray-300">
                                <User className="w-3.5 h-3.5 text-gray-500" />
                                <span>Rep: {appointment.assigned_rep_name}</span>
                            </div>
                        )}
                    </div>

                    {editing ? (
                        <div className="flex gap-2">
                            <Button onClick={handleSave} disabled={saving} className="flex-1 h-10 font-bold" style={{ background: accent, color: accentText }}>
                                {saving ? 'Saving...' : 'Save'}
                            </Button>
                            <Button variant="outline" onClick={() => setEditing(false)} className="h-10 border-gray-700 text-gray-300">Cancel</Button>
                        </div>
                    ) : (
                        <Button onClick={() => setEditing(true)} variant="outline" className="w-full h-10 border-gray-700 text-gray-300">Edit Details</Button>
                    )}

                    {/* Status */}
                    <div>
                        <p className="text-[10px] font-bold text-gray-500 uppercase mb-2">Status</p>
                        <div className="flex flex-wrap gap-1.5">
                            {STATUSES.map(s => (
                                <button
                                    key={s.value}
                                    onClick={() => handleStatusChange(s.value)}
                                    className={`text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-all ${
                                        appointment.status === s.value ? 'text-black' : 'text-gray-500 bg-gray-800/50 hover:text-white'
                                    }`}
                                    style={appointment.status === s.value ? { background: accent } : {}}
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Outcome */}
                    <div>
                        <p className="text-[10px] font-bold text-gray-500 uppercase mb-2">Record Outcome</p>
                        <div className="grid grid-cols-2 gap-2">
                            {OUTCOMES.map(o => {
                                const Icon = o.icon;
                                return (
                                    <button
                                        key={o.value}
                                        onClick={() => handleOutcome(o.value)}
                                        className={`flex items-center gap-2 text-xs font-bold px-3 py-2.5 rounded-xl transition-all ${
                                            appointment.outcome === o.value ? 'ring-2' : 'bg-gray-800/40 hover:bg-gray-800/70'
                                        }`}
                                        style={appointment.outcome === o.value ? { background: `${o.color}20`, color: o.color, ringColor: o.color } : { color: '#999' }}
                                    >
                                        <Icon className="w-3.5 h-3.5" />
                                        {o.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}