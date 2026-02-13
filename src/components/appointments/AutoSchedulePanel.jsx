import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Zap, Calendar, Loader2, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';
import { scoreProperty, INDUSTRIES, getIndustryLabel } from './EligibilityScorer';
import { addDays, setHours, setMinutes, format } from 'date-fns';

export default function AutoSchedulePanel({ properties, logs, teamMembers, onComplete }) {
    const { accent } = useTheme();
    const accentText = contrastText(accent);
    const [industry, setIndustry] = useState('solar');
    const [minScore, setMinScore] = useState(50);
    const [maxAppointments, setMaxAppointments] = useState(10);
    const [daysAhead, setDaysAhead] = useState(7);
    const [slotsPerDay, setSlotsPerDay] = useState(4);
    const [isRunning, setIsRunning] = useState(false);
    const [result, setResult] = useState(null);

    const handleAutoSchedule = async () => {
        setIsRunning(true);
        setResult(null);

        // Build interaction map
        const interactionMap = {};
        logs.forEach(l => {
            if (!interactionMap[l.address_hash]) interactionMap[l.address_hash] = [];
            interactionMap[l.address_hash].push(l);
        });

        // Score all properties
        const scored = properties
            .filter(p => {
                const pLogs = interactionMap[p.address_hash] || [];
                const hasHardNo = pLogs.some(l => l.parsed_status === 'HARD_NO');
                return !hasHardNo && p.original_status !== 'DO_NOT_KNOCK';
            })
            .map(p => {
                const pLogs = interactionMap[p.address_hash] || [];
                const result = scoreProperty(p, pLogs, industry);
                return { ...p, eligibility_score: result.total, scoring_factors: result.factors };
            })
            .filter(p => p.eligibility_score >= minScore)
            .sort((a, b) => b.eligibility_score - a.eligibility_score)
            .slice(0, maxAppointments);

        if (scored.length === 0) {
            setResult({ count: 0, message: 'No properties met the minimum score threshold.' });
            setIsRunning(false);
            return;
        }

        // Generate time slots
        const slots = [];
        const startHour = 9;
        const endHour = 18;
        const slotDuration = Math.floor((endHour - startHour) / slotsPerDay);

        for (let d = 1; d <= daysAhead; d++) {
            const day = addDays(new Date(), d);
            if (day.getDay() === 0) continue; // skip Sunday
            for (let s = 0; s < slotsPerDay; s++) {
                const hour = startHour + (s * slotDuration);
                const slotTime = setMinutes(setHours(day, hour), 0);
                slots.push(slotTime);
            }
        }

        // Assign reps round-robin
        const activeReps = teamMembers.filter(m => m.status === 'active');

        // Create appointments
        const appointments = scored.map((prop, idx) => {
            const slot = slots[idx % slots.length];
            const rep = activeReps.length > 0 ? activeReps[idx % activeReps.length] : null;

            return {
                address_hash: prop.address_hash,
                full_address: prop.full_address,
                zip_code: prop.zip_code,
                lat: prop.lat,
                lng: prop.lng,
                scheduled_date: slot.toISOString(),
                industry,
                status: 'scheduled',
                eligibility_score: prop.eligibility_score,
                scoring_factors: prop.scoring_factors,
                assigned_rep: rep?.id || '',
                assigned_rep_name: rep?.name || '',
                outcome: 'pending',
            };
        });

        // Bulk create
        const CHUNK = 50;
        let created = 0;
        for (let i = 0; i < appointments.length; i += CHUNK) {
            const chunk = appointments.slice(i, i + CHUNK);
            await base44.entities.Appointment.bulkCreate(chunk);
            created += chunk.length;
        }

        setResult({ count: created, message: `Scheduled ${created} appointments across ${daysAhead} days.` });
        setIsRunning(false);
        onComplete?.();
    };

    return (
        <div className="bg-[#111] border border-gray-800/60 rounded-2xl p-5 space-y-5">
            <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: `${accent}15` }}>
                    <Zap className="w-4 h-4" style={{ color: accent }} />
                </div>
                <div>
                    <h3 className="text-sm font-bold text-white">Auto-Schedule</h3>
                    <p className="text-[10px] text-gray-500">AI scores properties & books top leads</p>
                </div>
            </div>

            <div className="space-y-4">
                {/* Industry */}
                <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase mb-1.5 block">Industry</label>
                    <Select value={industry} onValueChange={setIndustry}>
                        <SelectTrigger className="bg-black/30 border-gray-700 text-white text-xs h-9">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#1a1a1a] border-gray-700">
                            {INDUSTRIES.map(i => (
                                <SelectItem key={i} value={i} className="text-white text-xs">{getIndustryLabel(i)}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Min Score */}
                <div>
                    <div className="flex justify-between mb-1.5">
                        <label className="text-[10px] font-bold text-gray-500 uppercase">Min Score</label>
                        <span className="text-[10px] font-bold" style={{ color: accent }}>{minScore}</span>
                    </div>
                    <Slider value={[minScore]} onValueChange={([v]) => setMinScore(v)} min={10} max={90} step={5} className="accent-yellow-500" />
                </div>

                {/* Max Appointments */}
                <div>
                    <div className="flex justify-between mb-1.5">
                        <label className="text-[10px] font-bold text-gray-500 uppercase">Max Appointments</label>
                        <span className="text-[10px] font-bold" style={{ color: accent }}>{maxAppointments}</span>
                    </div>
                    <Slider value={[maxAppointments]} onValueChange={([v]) => setMaxAppointments(v)} min={1} max={50} step={1} />
                </div>

                {/* Days Ahead */}
                <div>
                    <div className="flex justify-between mb-1.5">
                        <label className="text-[10px] font-bold text-gray-500 uppercase">Schedule {daysAhead} Days Ahead</label>
                        <span className="text-[10px] font-bold" style={{ color: accent }}>{daysAhead}d</span>
                    </div>
                    <Slider value={[daysAhead]} onValueChange={([v]) => setDaysAhead(v)} min={1} max={14} step={1} />
                </div>

                {/* Slots per day */}
                <div>
                    <div className="flex justify-between mb-1.5">
                        <label className="text-[10px] font-bold text-gray-500 uppercase">Slots Per Day</label>
                        <span className="text-[10px] font-bold" style={{ color: accent }}>{slotsPerDay}</span>
                    </div>
                    <Slider value={[slotsPerDay]} onValueChange={([v]) => setSlotsPerDay(v)} min={1} max={8} step={1} />
                </div>
            </div>

            {/* Info */}
            <div className="flex gap-2 items-start bg-white/[0.02] rounded-xl p-3">
                <Info className="w-3.5 h-3.5 text-gray-500 mt-0.5 shrink-0" />
                <p className="text-[10px] text-gray-500 leading-relaxed">
                    Scores properties by age, value, lot size, interaction history, and sale recency — weighted for <span className="font-bold" style={{ color: accent }}>{getIndustryLabel(industry)}</span>. Books the top leads with your reps.
                </p>
            </div>

            {result && (
                <div className={`rounded-xl p-3 text-xs font-bold ${result.count > 0 ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                    {result.message}
                </div>
            )}

            <Button
                onClick={handleAutoSchedule}
                disabled={isRunning}
                className="w-full h-11 font-bold text-sm"
                style={{ background: accent, color: accentText }}
            >
                {isRunning ? (
                    <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Scoring & Scheduling...</>
                ) : (
                    <><Zap className="w-4 h-4 mr-2" /> Auto-Schedule Top Leads</>
                )}
            </Button>
        </div>
    );
}