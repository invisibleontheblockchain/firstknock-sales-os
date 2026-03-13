import React, { useMemo, useState, useEffect } from 'react';
import { X, TrendingUp, DoorOpen, Trophy, Clock, Flame, DollarSign, Target, Phone, Percent, Zap, Calendar, MapPin, Award } from 'lucide-react';
import { format, subDays, isAfter, startOfDay, isToday } from 'date-fns';
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";

const SALES_STATUSES = ['SOLD', 'QUALIFIED'];
const CONTACT_EXCLUDE = ['NO_ANSWER', 'ELIGIBLE'];

export default function RepAnalytics({ logs, routeProperties, onClose }) {
    const [commissionPct, setCommissionPct] = useState(() => {
        const saved = localStorage.getItem('fk_commission_pct');
        return saved ? parseFloat(saved) : 10;
    });
    const [dateDays, setDateDays] = useState(30);

    useEffect(() => {
        localStorage.setItem('fk_commission_pct', String(commissionPct));
    }, [commissionPct]);

    const analytics = useMemo(() => {
        if (!logs?.length) return null;
        const now = new Date();
        const today = startOfDay(now);
        const cutoff = subDays(today, dateDays);
        const weekCutoff = subDays(today, 7);

        const periodLogs = logs.filter(l => isAfter(new Date(l.created_date), cutoff));
        const todayLogs = logs.filter(l => isToday(new Date(l.created_date)));
        const weekLogs = logs.filter(l => isAfter(new Date(l.created_date), weekCutoff));

        const countStatus = (arr, statuses) => arr.filter(l => statuses.includes(l.parsed_status)).length;
        const contacts = (arr) => arr.filter(l => !CONTACT_EXCLUDE.includes(l.parsed_status)).length;

        // Revenue
        const totalRevenue = periodLogs.reduce((s, l) => s + (l.sale_amount || 0), 0);
        const todayRevenue = todayLogs.reduce((s, l) => s + (l.sale_amount || 0), 0);
        const weekRevenue = weekLogs.reduce((s, l) => s + (l.sale_amount || 0), 0);
        const allTimeRevenue = logs.reduce((s, l) => s + (l.sale_amount || 0), 0);
        const salesCount = countStatus(periodLogs, SALES_STATUSES);
        const avgDeal = salesCount > 0 ? Math.round(totalRevenue / salesCount) : 0;

        // Rates
        const contactRate = periodLogs.length ? Math.round((contacts(periodLogs) / periodLogs.length) * 100) : 0;
        const conversionRate = periodLogs.length ? ((salesCount / periodLogs.length) * 100).toFixed(1) : 0;

        // Streak
        let streak = 0;
        for (let i = 0; i < 365; i++) {
            const day = subDays(today, i);
            if (logs.some(l => startOfDay(new Date(l.created_date)).getTime() === day.getTime())) streak++;
            else break;
        }

        // Best hour
        const hourBuckets = Array.from({ length: 13 }, (_, i) => i + 8).map(hour => {
            const hLogs = periodLogs.filter(l => new Date(l.created_date).getHours() === hour);
            const hContacts = contacts(hLogs);
            return { hour, knocks: hLogs.length, rate: hLogs.length ? Math.round((hContacts / hLogs.length) * 100) : 0 };
        });
        const bestHour = [...hourBuckets].sort((a, b) => b.rate - a.rate || b.knocks - a.knocks)[0] || { hour: 17, rate: 0 };

        // Daily breakdown (last 7 days)
        const daily = [];
        for (let i = 6; i >= 0; i--) {
            const day = subDays(today, i);
            const dLogs = logs.filter(l => startOfDay(new Date(l.created_date)).getTime() === day.getTime());
            daily.push({
                label: i === 0 ? 'Today' : format(day, 'EEE'),
                knocks: dLogs.length,
                sales: countStatus(dLogs, SALES_STATUSES),
                revenue: dLogs.reduce((s, l) => s + (l.sale_amount || 0), 0),
            });
        }
        const maxKnocks = Math.max(...daily.map(d => d.knocks), 1);

        // Route progress
        const totalProps = routeProperties?.length || 0;
        const doneProps = routeProperties?.filter(p => p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'CALLBACK').length || 0;

        // Active days
        const activeDays = new Set(periodLogs.map(l => l.created_date?.split('T')[0]).filter(Boolean)).size;
        const avgPerDay = activeDays > 0 ? Math.round(periodLogs.length / activeDays) : 0;

        // Callbacks / no-answers
        const callbacks = countStatus(periodLogs, ['CALLBACK']);
        const noAnswer = countStatus(periodLogs, ['NO_ANSWER']);
        const hardNo = countStatus(periodLogs, ['HARD_NO']);

        return {
            todayKnocks: todayLogs.length, todaySales: countStatus(todayLogs, SALES_STATUSES),
            todayCallbacks: countStatus(todayLogs, ['CALLBACK']), todayNoAnswer: countStatus(todayLogs, ['NO_ANSWER']),
            todayRevenue, weekKnocks: weekLogs.length, weekSales: countStatus(weekLogs, SALES_STATUSES), weekRevenue,
            periodKnocks: periodLogs.length, salesCount, totalRevenue, allTimeRevenue, avgDeal,
            contactRate, conversionRate, streak, bestHourLabel: format(new Date(0, 0, 0, bestHour.hour), 'ha'),
            bestHourRate: bestHour.rate, daily, maxKnocks, totalProps, doneProps, activeDays, avgPerDay,
            contacts: contacts(periodLogs), callbacks, noAnswer, hardNo,
        };
    }, [logs, routeProperties, dateDays]);

    if (!analytics) {
        return (
            <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
                <div className="bg-[#111] rounded-2xl p-8 text-center border border-gray-800" onClick={e => e.stopPropagation()}>
                    <p className="text-gray-500">No data yet. Start knocking!</p>
                    <button onClick={onClose} className="mt-4 text-yellow-500 font-bold text-sm">Close</button>
                </div>
            </div>
        );
    }

    const myCommission = Math.round(analytics.totalRevenue * (commissionPct / 100));
    const allTimeCommission = Math.round(analytics.allTimeRevenue * (commissionPct / 100));
    const fmt = (v) => v >= 1000000 ? `$${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toLocaleString()}`;

    return (
        <div className="fixed inset-0 z-50 bg-black/95 backdrop-blur-md flex flex-col" onClick={onClose}>
            <div className="flex-1 overflow-y-auto" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="sticky top-0 bg-black/95 backdrop-blur px-4 py-3 flex items-center justify-between border-b border-white/5 z-20">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-yellow-500/20 to-orange-500/20 flex items-center justify-center border border-yellow-500/20">
                            <TrendingUp className="w-4 h-4 text-yellow-500" />
                        </div>
                        <div>
                            <h2 className="font-bold text-base text-white tracking-tight">My Performance</h2>
                            <p className="text-[9px] text-gray-500 font-medium uppercase tracking-wider">Revenue · Metrics · Motivation</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>

                {/* Date range */}
                <div className="px-4 pt-3 pb-1 flex items-center gap-1 bg-black/50">
                    {[7, 30, 90].map(r => (
                        <button key={r} onClick={() => setDateDays(r)}
                            className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all ${dateDays === r ? 'bg-white text-black' : 'text-gray-500 bg-white/[0.03] hover:bg-white/5'}`}
                        >{r}D</button>
                    ))}
                </div>

                <div className="p-4 space-y-4">
                    {/* REVENUE HERO */}
                    <div className="rounded-2xl border border-green-500/20 bg-gradient-to-br from-green-500/[0.08] to-transparent p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-green-400">Account Value ({dateDays}D)</span>
                            <DollarSign className="w-4 h-4 text-green-400" />
                        </div>
                        <div className="text-3xl font-black text-white tracking-tight">{fmt(analytics.totalRevenue)}</div>
                        <div className="grid grid-cols-3 gap-2">
                            <MiniStat label="Today" value={fmt(analytics.todayRevenue)} />
                            <MiniStat label="7D" value={fmt(analytics.weekRevenue)} />
                            <MiniStat label="All-Time" value={fmt(analytics.allTimeRevenue)} />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <MiniStat label="Deals Closed" value={analytics.salesCount} />
                            <MiniStat label="Avg Deal" value={fmt(analytics.avgDeal)} />
                        </div>
                    </div>

                    {/* MY CUT — Commission */}
                    <div className="rounded-2xl border border-purple-500/20 bg-gradient-to-br from-purple-500/[0.06] to-transparent p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-purple-400">My Commission</span>
                            <Percent className="w-4 h-4 text-purple-400" />
                        </div>
                        <div className="text-3xl font-black text-white tracking-tight">{fmt(myCommission)}</div>
                        <p className="text-[10px] text-gray-500">at {commissionPct}% of {fmt(analytics.totalRevenue)} in {dateDays}D revenue</p>

                        {/* Commission slider */}
                        <div className="space-y-2 pt-1">
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] text-gray-400">Commission Rate</span>
                                <div className="flex items-center gap-1.5">
                                    <Input
                                        type="number"
                                        value={commissionPct}
                                        onChange={e => setCommissionPct(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                                        className="w-14 h-7 text-center text-xs bg-white/5 border-white/10 text-white px-1"
                                    />
                                    <span className="text-[10px] text-gray-500">%</span>
                                </div>
                            </div>
                            <Slider
                                value={[commissionPct]}
                                onValueChange={([v]) => setCommissionPct(v)}
                                min={1} max={50} step={0.5}
                                className="w-full"
                            />
                            <div className="flex justify-between text-[9px] text-gray-600">
                                <span>1%</span>
                                <span>25%</span>
                                <span>50%</span>
                            </div>
                        </div>
                        <div className="bg-white/[0.03] rounded-xl p-2.5 flex items-center justify-between">
                            <span className="text-[10px] text-gray-400">All-Time Commission</span>
                            <span className="text-sm font-black text-purple-300">{fmt(allTimeCommission)}</span>
                        </div>
                    </div>

                    {/* Streak */}
                    {analytics.streak > 0 && (
                        <div className="bg-gradient-to-r from-orange-600/15 to-yellow-600/10 border border-orange-500/20 rounded-2xl p-3.5 flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-orange-500/20 flex items-center justify-center shrink-0">
                                <Flame className="w-5 h-5 text-orange-500" />
                            </div>
                            <div>
                                <p className="text-xl font-black text-orange-400">{analytics.streak} Day Streak 🔥</p>
                                <p className="text-[10px] text-gray-500">Consistency is the key to closing</p>
                            </div>
                        </div>
                    )}

                    {/* TODAY */}
                    <SectionLabel>Today</SectionLabel>
                    <div className="grid grid-cols-4 gap-2">
                        <KpiCard icon={DoorOpen} label="Knocks" value={analytics.todayKnocks} accent="#3b82f6" />
                        <KpiCard icon={Trophy} label="Sales" value={analytics.todaySales} accent="#22c55e" />
                        <KpiCard icon={Clock} label="Callbacks" value={analytics.todayCallbacks} accent="#f59e0b" />
                        <KpiCard icon={Target} label="No Answer" value={analytics.todayNoAnswer} accent="#6b7280" />
                    </div>

                    {/* CORE METRICS */}
                    <SectionLabel>{dateDays}D Metrics</SectionLabel>
                    <div className="grid grid-cols-3 gap-2">
                        <KpiCard icon={DoorOpen} label="Knocks" value={analytics.periodKnocks.toLocaleString()} accent="#8b5cf6" />
                        <KpiCard icon={Phone} label="Contacts" value={analytics.contacts} accent="#06b6d4" />
                        <KpiCard icon={TrendingUp} label="Conv %" value={`${analytics.conversionRate}%`} accent="#22c55e" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        <KpiCard icon={Zap} label="Contact %" value={`${analytics.contactRate}%`} accent="#f59e0b" />
                        <KpiCard icon={Calendar} label="Active Days" value={analytics.activeDays} accent="#ec4899" />
                        <KpiCard icon={MapPin} label="Avg/Day" value={analytics.avgPerDay} accent="#a855f7" />
                    </div>

                    {/* FUNNEL */}
                    <SectionLabel>Sales Funnel</SectionLabel>
                    <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-4 space-y-3">
                        <FunnelBar label="Knocks" value={analytics.periodKnocks} max={analytics.periodKnocks} color="#ffffff" />
                        <FunnelBar label="Contacts" value={analytics.contacts} max={analytics.periodKnocks} color="#06b6d4" />
                        <FunnelBar label="Callbacks" value={analytics.callbacks} max={analytics.periodKnocks} color="#f59e0b" />
                        <FunnelBar label="Wins" value={analytics.salesCount} max={analytics.periodKnocks} color="#22c55e" />
                    </div>

                    {/* WEEKLY CHART */}
                    <SectionLabel>Last 7 Days</SectionLabel>
                    <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-4">
                        <div className="flex items-end gap-1.5 h-24 mb-2">
                            {analytics.daily.map((day, i) => (
                                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                    <div className="w-full flex flex-col items-center justify-end" style={{ height: '80px' }}>
                                        {day.sales > 0 && (
                                            <div className="w-full rounded-t bg-green-500 min-h-[4px]"
                                                style={{ height: `${(day.sales / analytics.maxKnocks) * 80}px` }} />
                                        )}
                                        <div className="w-full bg-yellow-500/80 min-h-[2px]"
                                            style={{
                                                height: `${(Math.max(day.knocks - day.sales, 0) / analytics.maxKnocks) * 80}px`,
                                                borderRadius: day.sales > 0 ? '0' : '4px 4px 0 0'
                                            }} />
                                    </div>
                                    <span className="text-[8px] text-gray-500 font-bold">{day.label}</span>
                                </div>
                            ))}
                        </div>
                        <div className="flex items-center gap-3 text-[9px] text-gray-500 border-t border-white/5 pt-2">
                            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-sm bg-yellow-500" /> Knocks</span>
                            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-sm bg-green-500" /> Sales</span>
                        </div>
                    </div>

                    {/* FOCUS SIGNALS */}
                    <SectionLabel>Focus Signals</SectionLabel>
                    <div className="grid grid-cols-2 gap-2">
                        <FocusCard label="Best Hour" value={analytics.bestHourLabel} sub={`${analytics.bestHourRate}% contact rate`} icon={Clock} accent="#f59e0b" />
                        <FocusCard label="Open Callbacks" value={analytics.callbacks} sub="people to revisit" icon={Phone} accent="#06b6d4" />
                        <FocusCard label="Hard No's" value={analytics.hardNo} sub="not interested" icon={X} accent="#ef4444" />
                        <FocusCard label="No Answers" value={analytics.noAnswer} sub="try different time" icon={Target} accent="#6b7280" />
                    </div>

                    {/* ROUTE PROGRESS */}
                    {analytics.totalProps > 0 && (
                        <>
                            <SectionLabel>Route Progress</SectionLabel>
                            <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-4">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-xs text-gray-400">Properties Completed</span>
                                    <span className="text-sm font-black text-white">{analytics.doneProps}/{analytics.totalProps}</span>
                                </div>
                                <div className="h-3 bg-white/[0.04] rounded-full overflow-hidden">
                                    <div className="h-full bg-gradient-to-r from-yellow-500 to-green-500 rounded-full transition-all"
                                        style={{ width: `${(analytics.doneProps / analytics.totalProps) * 100}%` }} />
                                </div>
                            </div>
                        </>
                    )}

                    {/* Motivational footer */}
                    <div className="text-center py-4">
                        <Award className="w-6 h-6 text-yellow-500/40 mx-auto mb-2" />
                        <p className="text-[10px] text-gray-600 font-medium">Every door is an opportunity. Keep grinding.</p>
                    </div>
                </div>
            </div>
        </div>
    );
}

function SectionLabel({ children }) {
    return <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider pt-1">{children}</p>;
}

function MiniStat({ label, value }) {
    return (
        <div className="bg-white/[0.04] rounded-lg p-2 text-center">
            <div className="text-sm font-black text-white">{value}</div>
            <p className="text-[8px] text-gray-500 mt-0.5">{label}</p>
        </div>
    );
}

function KpiCard({ icon: Icon, label, value, accent }) {
    return (
        <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-2.5 text-center">
            <div className="w-6 h-6 rounded-lg mx-auto mb-1.5 flex items-center justify-center" style={{ background: `${accent}15` }}>
                <Icon className="w-3 h-3" style={{ color: accent }} />
            </div>
            <div className="text-base font-black text-white leading-none">{value}</div>
            <p className="text-[8px] text-gray-500 mt-1 font-semibold uppercase tracking-wide">{label}</p>
        </div>
    );
}

function FunnelBar({ label, value, max, color }) {
    const pct = max > 0 ? (value / max) * 100 : 0;
    return (
        <div>
            <div className="flex items-baseline justify-between mb-1">
                <span className="text-xs font-semibold text-gray-300">{label}</span>
                <span className="text-sm font-black text-white">{value.toLocaleString()}</span>
            </div>
            <div className="h-2.5 rounded-full bg-white/[0.04] overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${Math.max(pct, 2)}%`, background: `linear-gradient(90deg, ${color}60, ${color})` }} />
            </div>
        </div>
    );
}

function FocusCard({ label, value, sub, icon: Icon, accent }) {
    return (
        <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-3">
            <div className="flex items-center justify-between mb-2">
                <span className="text-[8px] font-bold uppercase tracking-wider text-gray-500">{label}</span>
                <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: `${accent}15` }}>
                    <Icon className="w-2.5 h-2.5" style={{ color: accent }} />
                </div>
            </div>
            <div className="text-lg font-black text-white leading-none">{value}</div>
            <p className="text-[8px] text-gray-500 mt-1">{sub}</p>
        </div>
    );
}