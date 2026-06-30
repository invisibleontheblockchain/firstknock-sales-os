import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Calendar, User, Phone, Mail, FileText, ChevronLeft, Check, Ban, Clock, RotateCcw, MapPin, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';
const OUTCOMES = [
    { value: 'sold', label: 'Sold', color: '#22c55e', icon: Check },
    { value: 'follow_up', label: 'Follow Up', color: '#eab308', icon: Clock },
    { value: 'not_interested', label: 'Not Interested', color: '#ef4444', icon: Ban },
    { value: 'not_home', label: 'Not Home', color: '#6b7280', icon: RotateCcw },
];

const STATUSES = [
    { value: 'scheduled', label: 'Scheduled', color: '#3b82f6' },
    { value: 'confirmed', label: 'Confirmed', color: '#22c55e' },
    { value: 'completed', label: 'Completed', color: '#10b981' },
    { value: 'cancelled', label: 'Cancelled', color: '#ef4444' },
    { value: 'no_show', label: 'No Show', color: '#f97316' },
    { value: 'rescheduled', label: 'Rescheduled', color: '#8b5cf6' },
];

export default function AppointmentDetail({ appointment, onClose, onUpdate }) {
    const [editing, setEditing] = useState(false);
    const [form, setForm] = useState({
        homeowner_name: appointment.homeowner_name || '',
        phone: appointment.phone || '',
        email: appointment.email || '',
        notes: appointment.notes || '',
        scheduled_date: appointment.scheduled_date ? format(new Date(appointment.scheduled_date), "yyyy-MM-dd'T'HH:mm") : '',
    });
    const [saving, setSaving] = useState(false);

    const appointmentNumber = appointment.appointment_number || appointment.appointmentNumber;
    const routeName = appointment.route_name || appointment.routeName;
    const isLogOnly = appointment._source === 'interaction_log';

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

    const handleDelete = async () => {
        if (!confirm('Delete this appointment?')) return;
        await base44.entities.Appointment.delete(appointment.id);
        onUpdate?.();
    };

    return (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
            <div className="bg-[#0c0c0e] border border-white/[0.06] rounded-t-3xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
                
                {/* Header */}
                <div className="sticky top-0 bg-[#0c0c0e] px-3 py-3 border-b border-white/[0.06] flex items-center gap-3 z-10">
                    <button onClick={onClose} className="flex h-10 shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-3 text-xs font-bold text-white/85 hover:bg-white/[0.1] active:scale-95 transition-colors">
                        <ChevronLeft className="w-4 h-4" /> Back
                    </button>
                    <div className="flex-1 min-w-0 selectable-text">
                        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#39FF4A]">Appointment #{appointmentNumber || '-'}</p>
                        <p className="text-sm font-bold text-white truncate">{appointment.full_address || 'Unknown Address'}</p>
                        <div className="flex items-center gap-2 mt-1">
                            {routeName && <span className="text-[10px] text-gray-500 truncate">{routeName}</span>}
                            {appointment.zip_code && <span className="text-[10px] text-gray-600">• {appointment.zip_code}</span>}
                        </div>
                    </div>
                </div>

                <div className="p-5 space-y-5">

                    {/* Details */}
                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Details</span>
                            {!editing && !isLogOnly && (
                                <button onClick={() => setEditing(true)} className="text-[10px] font-bold text-gray-500 hover:text-white flex items-center gap-1 transition-colors">
                                    <Pencil className="w-3 h-3" /> Edit
                                </button>
                            )}
                        </div>

                        <DetailRow icon={Calendar} label={
                            editing
                                ? <Input type="datetime-local" value={form.scheduled_date} onChange={e => setForm({ ...form, scheduled_date: e.target.value })} className="h-8 bg-black/30 border-white/[0.08] text-xs text-white" />
                                : <span>{appointment.scheduled_date ? format(new Date(appointment.scheduled_date), 'EEE, MMM d • h:mm a') : 'No date set'}</span>
                        } />
                        <DetailRow icon={User} label={
                            editing
                                ? <Input placeholder="Homeowner" value={form.homeowner_name} onChange={e => setForm({ ...form, homeowner_name: e.target.value })} className="h-8 bg-black/30 border-white/[0.08] text-xs text-white" />
                                : <span>{appointment.homeowner_name || 'Unknown homeowner'}</span>
                        } />
                        <DetailRow icon={Phone} label={
                            editing
                                ? <Input placeholder="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="h-8 bg-black/30 border-white/[0.08] text-xs text-white" />
                                : <span>{appointment.phone || 'No phone'}</span>
                        } />
                        <DetailRow icon={FileText} label={
                            editing
                                ? <Input placeholder="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="h-8 bg-black/30 border-white/[0.08] text-xs text-white" />
                                : <span className="selectable-text text-gray-400">{appointment.notes || 'No notes'}</span>
                        } />
                        {appointment.assigned_rep_name && !editing && (
                            <DetailRow icon={User} label={<span>Rep: <span className="text-white font-medium">{appointment.assigned_rep_name}</span></span>} />
                        )}

                        {isLogOnly && (
                            <div className="rounded-xl border border-[#2EEB57]/20 bg-[#2EEB57]/[0.06] p-3 text-[11px] font-medium text-[#39FF4A]/80">
                                This callback came directly from interaction history and will become editable after it is saved as an appointment.
                            </div>
                        )}

                        {editing && (
                            <div className="flex gap-2 pt-2">
                                <Button onClick={handleSave} disabled={saving} className="flex-1 h-9 font-bold bg-white text-black hover:bg-gray-200 text-xs rounded-xl">
                                    {saving ? 'Saving...' : 'Save Changes'}
                                </Button>
                                <Button variant="outline" onClick={() => setEditing(false)} className="h-9 border-white/[0.08] text-gray-400 text-xs rounded-xl">Cancel</Button>
                            </div>
                        )}
                    </div>

                    {!isLogOnly && (
                    <>
                    {/* Status selector */}
                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-3">Status</span>
                        <div className="flex flex-wrap gap-1.5">
                            {STATUSES.map(s => (
                                <button key={s.value} onClick={() => handleStatusChange(s.value)}
                                    className={`text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-all border ${
                                        appointment.status === s.value
                                            ? 'text-white border-white/20'
                                            : 'text-gray-500 border-white/[0.04] hover:border-white/10 hover:text-gray-300'
                                    }`}
                                    style={appointment.status === s.value ? { background: `${s.color}20`, borderColor: `${s.color}40` } : {}}
                                >{s.label}</button>
                            ))}
                        </div>
                    </div>

                    {/* Outcome */}
                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-3">Record Outcome</span>
                        <div className="grid grid-cols-2 gap-2">
                            {OUTCOMES.map(o => {
                                const Icon = o.icon;
                                const isActive = appointment.outcome === o.value;
                                return (
                                    <button key={o.value} onClick={() => handleOutcome(o.value)}
                                        className={`flex items-center gap-2 text-xs font-bold px-3 py-2.5 rounded-xl transition-all border ${
                                            isActive ? 'border-white/15' : 'border-white/[0.04] hover:border-white/10'
                                        }`}
                                        style={isActive ? { background: `${o.color}15`, color: o.color } : { color: '#666' }}
                                    >
                                        <Icon className="w-3.5 h-3.5" />
                                        {o.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Delete */}
                    <button onClick={handleDelete} className="w-full text-center text-[10px] text-gray-600 hover:text-red-400 font-bold py-2 transition-colors">
                        Delete Appointment
                    </button>
                    </>
                    )}
                </div>
            </div>
        </div>
    );
}

function DetailRow({ icon: Icon, label }) {
    return (
        <div className="flex items-center gap-2.5 text-xs text-gray-300">
            <Icon className="w-3.5 h-3.5 text-gray-600 shrink-0" />
            <div className="flex-1 min-w-0">{label}</div>
        </div>
    );
}