import React, { useMemo } from 'react';
import { X, TrendingUp, DoorOpen, Trophy, Clock, Flame, DollarSign, Target, Phone, Award, Zap } from 'lucide-react';
import { startOfDay, subDays, isToday } from 'date-fns';

const SALES_STATUSES = ['SOLD', 'QUALIFIED'];
const CONTACT_EXCLUDE = ['NO_ANSWER', 'ELIGIBLE'];

export default function RepAnalytics({ logs, routeProperties, activeRoute, onClose }) {
    const stats = useMemo(() => {
        if (!logs?.length) return null;
        const today = startOfDay(new Date());

        const todayLogs = logs.filter(l => isToday(new Date(l.created_date)));
        const countStatus = (arr, statuses) => arr.filter(l => statuses.includes(l.parsed_status)).length;
        const contacts = todayLogs.filter(l => !CONTACT_EXCLUDE.includes(l.parsed_status)).length;

        const knocks = todayLogs.length;
        const sales = countStatus(todayLogs, SALES_STATUSES);
        const callbacks = countStatus(todayLogs, ['CALLBACK']);
        const noAnswer = countStatus(todayLogs, ['NO_ANSWER']);
        const hardNo = countStatus(todayLogs, ['HARD_NO']);
        const revenue = todayLogs.reduce((s, l) => s + (l.sale_amount || 0), 0);
        const contactRate = knocks > 0 ? Math.round((contacts / knocks) * 100) : 0;
        const convRate = knocks > 0 ? ((sales / knocks) * 100).toFixed(1) : '0.0';

        // Streak
        let streak = 0;
        for (let i = 0; i < 365; i++) {
            const day = subDays(today, i);
            if (logs.some(l => startOfDay(new Date(l.created_date)).getTime() === day.getTime())) streak++;
            else break;
        }

        // Route progress
        const routeTotal = Math.max(
            routeProperties?.length || 0,
            activeRoute?.property_hashes?.length || 0,
            activeRoute?.metrics?.house_count || activeRoute?.houseCount || 0
        );
        const totalProps = routeTotal;
        const doneProps = routeProperties?.filter(p => p.effective_status !== 'ELIGIBLE').length || 0;

        // Hourly breakdown for today
        const hourly = [];
        const nowHour = new Date().getHours();
        for (let h = 8; h <= Math.max(nowHour, 20); h++) {
            const hLogs = todayLogs.filter(l => new Date(l.created_date).getHours() === h);
            hourly.push({ hour: h, count: hLogs.length });
        }
        const maxHourly = Math.max(...hourly.map(h => h.count), 1);

        return { knocks, sales, callbacks, noAnswer, hardNo, contacts, revenue, contactRate, convRate, streak, totalProps, doneProps, hourly, maxHourly };
    }, [logs, routeProperties, activeRoute]);

    if (!stats) {
        return (
            <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
                <div className="bg-[#111] rounded-2xl p-8 text-center border border-gray-800" onClick={e => e.stopPropagation()}>
                    <p className="text-gray-500">No data yet. Start knocking!</p>
                    <button onClick={onClose} className="mt-4 text-yellow-500 font-bold text-sm">Close</button>
                </div>
            </div>
        );
    }

    const fmt = (v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toLocaleString()}`;

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
                            <h2 className="font-bold text-base text-white tracking-tight">Today's Performance</h2>
                            <p className="text-[9px] text-gray-500 font-medium uppercase tracking-wider">Daily Stats · {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    {/* Revenue Hero — Today */}
                    <div className="rounded-2xl border border-green-500/20 bg-gradient-to-br from-green-500/[0.08] to-transparent p-4">
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-green-400">Today's Revenue</span>
                            <DollarSign className="w-4 h-4 text-green-400" />
                        </div>
                        <div className="text-3xl font-black text-white tracking-tight">{fmt(stats.revenue)}</div>
                        <p className="text-[10px] text-gray-500 mt-1">{stats.sales} deal{stats.sales !== 1 ? 's' : ''} closed today</p>
                    </div>

                    {/* Streak */}
                    {stats.streak > 0 && (
                        <div className="bg-gradient-to-r from-orange-600/15 to-yellow-600/10 border border-orange-500/20 rounded-2xl p-3 flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-orange-500/20 flex items-center justify-center shrink-0">
                                <Flame className="w-4 h-4 text-orange-500" />
                            </div>
                            <div>
                                <p className="text-lg font-black text-orange-400">{stats.streak} Day Streak 🔥</p>
                                <p className="text-[9px] text-gray-500">Keep the momentum going</p>
                            </div>
                        </div>
                    )}

                    {/* Main KPIs */}
                    <div className="grid grid-cols-4 gap-2">
                        <KpiCard icon={DoorOpen} label="Knocks" value={stats.knocks} accent="#3b82f6" />
                        <KpiCard icon={Trophy} label="Sales" value={stats.sales} accent="#22c55e" />
                        <KpiCard icon={Clock} label="Callbacks" value={stats.callbacks} accent="#f59e0b" />
                        <KpiCard icon={Target} label="No Answer" value={stats.noAnswer} accent="#6b7280" />
                    </div>

                    {/* Rates */}
                    <div className="grid grid-cols-3 gap-2">
                        <KpiCard icon={Phone} label="Contacts" value={stats.contacts} accent="#06b6d4" />
                        <KpiCard icon={Zap} label="Contact %" value={`${stats.contactRate}%`} accent="#f59e0b" />
                        <KpiCard icon={TrendingUp} label="Conv %" value={`${stats.convRate}%`} accent="#22c55e" />
                    </div>

                    {/* Hourly Activity */}
                    <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-4">
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-3">Hourly Activity</p>
                        <div className="flex items-end gap-1 h-16">
                            {stats.hourly.map((h, i) => (
                                <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                                    <div className="w-full rounded-t bg-yellow-500/80 min-h-[2px]"
                                        style={{ height: `${(h.count / stats.maxHourly) * 56}px`, borderRadius: '3px 3px 0 0' }} />
                                    <span className="text-[7px] text-gray-600 font-bold">{h.hour > 12 ? h.hour - 12 : h.hour}{h.hour >= 12 ? 'p' : 'a'}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Today's Funnel */}
                    <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-4 space-y-2.5">
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Today's Funnel</p>
                        <FunnelBar label="Knocks" value={stats.knocks} max={stats.knocks} color="#ffffff" />
                        <FunnelBar label="Contacts" value={stats.contacts} max={stats.knocks} color="#06b6d4" />
                        <FunnelBar label="Callbacks" value={stats.callbacks} max={stats.knocks} color="#f59e0b" />
                        <FunnelBar label="Sales" value={stats.sales} max={stats.knocks} color="#22c55e" />
                    </div>

                    {/* Route Progress */}
                    {stats.totalProps > 0 && (
                        <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-4">
                            <div className="flex justify-between items-center mb-2">
                                <span className="text-xs text-gray-400">Route Progress</span>
                                <span className="text-sm font-black text-white">{stats.doneProps}/{stats.totalProps}</span>
                            </div>
                            <div className="h-3 bg-white/[0.04] rounded-full overflow-hidden">
                                <div className="h-full bg-gradient-to-r from-yellow-500 to-green-500 rounded-full transition-all"
                                    style={{ width: `${(stats.doneProps / stats.totalProps) * 100}%` }} />
                            </div>
                        </div>
                    )}

                    {/* Footer */}
                    <div className="text-center py-3">
                        <Award className="w-5 h-5 text-yellow-500/30 mx-auto mb-1" />
                        <p className="text-[9px] text-gray-600">For detailed analytics & commission tracking, check the Analytics tab</p>
                    </div>
                </div>
            </div>
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
                <span className="text-sm font-black text-white">{value}</span>
            </div>
            <div className="h-2 rounded-full bg-white/[0.04] overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${Math.max(pct, 2)}%`, background: `linear-gradient(90deg, ${color}60, ${color})` }} />
            </div>
        </div>
    );
}