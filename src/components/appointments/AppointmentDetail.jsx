import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Calendar, User, Phone, Mail, FileText, X, Check, Ban, Clock, RotateCcw, Star, MapPin, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';
import { getIndustryLabel } from './EligibilityScorer';

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

    const handleDelete = async () => {
        if (!confirm('Delete this appointment?')) return;
        await base44.entities.Appointment.delete(appointment.id);
        onUpdate?.();
    };

    return (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
            <div className="bg-[#0c0c0e] border border-white/[0.06] rounded-t-3xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
                
                {/* Header */}
                <div className="sticky top-0 bg-[#0c0c0e] px-5 py-4 border-b border-white/[0.06] flex items-start justify-between z-10">
                    <div className="flex-1 min-w-0 pr-3">
                        <p className="text-sm font-bold text-white truncate">{appointment.full_address || 'Unknown Address'}</p>
                        <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] text-gray-500">{getIndustryLabel(appointment.industry)}</span>
                            {appointment.zip_code && <span className="text-[10px] text-gray-600">• {appointment.zip_code}</span>}
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/[0.06] flex items-center justify-center hover:bg-white/[0.1] transition-colors shrink-0">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>

                <div className="p-5 space-y-5">

                    {/* Score card */}
                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                                <Star className="w-4 h-4" style={{ color: scoreColor }} />
                                <span className="text-xs font-bold text-gray-400">Lead Score</span>
                            </div>
                            <span className="text-2xl font-black" style={{ color: scoreColor }}>{score}</span>
                        </div>
                        {Object.keys(factors).length > 0 && (
                            <div className="space-y-2">
                                {Object.entries(factors).map(([key, val]) => (
                                    <div key={key} className="flex items-center gap-2">
                                        <span className="text-[10px] text-gray-500 w-20 capitalize truncate">{key.replace(/_/g, ' ')}</span>
                                        <div className="flex-1 h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                                            <div className="h-full rounded-full transition-all" style={{ width: `${val}%`, background: val >= 70 ? '#22c55e' : val >= 40 ? '#eab308' : '#ef4444' }} />
                                        </div>
                                        <span className="text-[10px] font-bold text-gray-500 w-6 text-right">{val}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Details */}
                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Details</span>
                            {!editing && (
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
                                : <span className="text-gray-400">{appointment.notes || 'No notes'}</span>
                        } />
                        {appointment.assigned_rep_name && !editing && (
                            <DetailRow icon={User} label={<span>Rep: <span className="text-white font-medium">{appointment.assigned_rep_name}</span></span>} />
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