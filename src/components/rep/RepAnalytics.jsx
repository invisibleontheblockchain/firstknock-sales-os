import React, { useMemo } from 'react';
import { X, TrendingUp, Target, DoorOpen, Trophy, Clock, Flame } from 'lucide-react';
import { format, subDays, isAfter, startOfDay, isToday } from 'date-fns';

export default function RepAnalytics({ logs, routeProperties, onClose }) {
    const analytics = useMemo(() => {
        if (!logs?.length) return null;

        const now = new Date();
        const today = startOfDay(now);
        const last7 = subDays(today, 7);
        const last30 = subDays(today, 30);

        const todayLogs = logs.filter(l => isToday(new Date(l.created_date)));
        const week = logs.filter(l => isAfter(new Date(l.created_date), last7));
        const month = logs.filter(l => isAfter(new Date(l.created_date), last30));

        const countStatus = (arr, statuses) => arr.filter(l => statuses.includes(l.parsed_status)).length;

        // Today
        const todayKnocks = todayLogs.length;
        const todaySales = countStatus(todayLogs, ['SOLD', 'QUALIFIED']);
        const todayCallbacks = countStatus(todayLogs, ['CALLBACK']);
        const todayNoAnswer = countStatus(todayLogs, ['NO_ANSWER']);

        // This week
        const weekKnocks = week.length;
        const weekSales = countStatus(week, ['SOLD', 'QUALIFIED']);

        // This month
        const monthKnocks = month.length;
        const monthSales = countStatus(month, ['SOLD', 'QUALIFIED']);

        // Conversion rate
        const conversionRate = weekKnocks > 0 ? ((weekSales / weekKnocks) * 100).toFixed(1) : 0;

        // Streak: consecutive days with at least 1 knock
        let streak = 0;
        for (let i = 0; i < 60; i++) {
            const day = subDays(today, i);
            const dayLogs = logs.filter(l => {
                const d = startOfDay(new Date(l.created_date));
                return d.getTime() === day.getTime();
            });
            if (dayLogs.length > 0) streak++;
            else break;
        }

        // Route progress
        const totalProps = routeProperties?.length || 0;
        const doneProps = routeProperties?.filter(p => p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'CALLBACK').length || 0;

        // Daily breakdown (last 7 days)
        const dailyBreakdown = [];
        for (let i = 6; i >= 0; i--) {
            const day = subDays(today, i);
            const dayLogs = logs.filter(l => {
                const d = startOfDay(new Date(l.created_date));
                return d.getTime() === day.getTime();
            });
            dailyBreakdown.push({
                label: i === 0 ? 'Today' : format(day, 'EEE'),
                knocks: dayLogs.length,
                sales: countStatus(dayLogs, ['SOLD', 'QUALIFIED']),
            });
        }
        const maxKnocks = Math.max(...dailyBreakdown.map(d => d.knocks), 1);

        return {
            todayKnocks, todaySales, todayCallbacks, todayNoAnswer,
            weekKnocks, weekSales, monthKnocks, monthSales,
            conversionRate, streak, totalProps, doneProps,
            dailyBreakdown, maxKnocks,
        };
    }, [logs, routeProperties]);

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

    return (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col" onClick={onClose}>
            <div className="flex-1 overflow-y-auto" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="sticky top-0 bg-black/95 backdrop-blur px-5 py-4 flex items-center justify-between border-b border-white/5 z-20 shadow-xl">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-500/20 to-orange-500/20 flex items-center justify-center border border-yellow-500/20">
                            <TrendingUp className="w-5 h-5 text-yellow-500" />
                        </div>
                        <div>
                            <h2 className="font-bold text-lg text-white tracking-tight">My Performance</h2>
                            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Analytics Overview</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>

                <div className="p-5 space-y-6">
                    {/* Streak Banner */}
                    {analytics.streak > 0 && (
                        <div className="bg-gradient-to-r from-orange-600/20 to-yellow-600/20 border border-orange-500/30 rounded-2xl p-4 flex items-center gap-4">
                            <div className="w-12 h-12 rounded-full bg-orange-500/20 flex items-center justify-center">
                                <Flame className="w-6 h-6 text-orange-500" />
                            </div>
                            <div>
                                <p className="text-2xl font-bold text-orange-500">{analytics.streak} Day Streak 🔥</p>
                                <p className="text-xs text-gray-400">Keep it up!</p>
                            </div>
                        </div>
                    )}

                    {/* Today's Stats */}
                    <div>
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-3">Today</p>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <StatCard icon={DoorOpen} label="Knocks" value={analytics.todayKnocks} color="text-blue-400" />
                            <StatCard icon={Trophy} label="Sales" value={analytics.todaySales} color="text-green-400" />
                            <StatCard icon={Clock} label="Callbacks" value={analytics.todayCallbacks} color="text-yellow-400" />
                            <StatCard icon={Target} label="No Answer" value={analytics.todayNoAnswer} color="text-gray-400" />
                        </div>
                    </div>

                    {/* Weekly Chart */}
                    <div>
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-3">Last 7 Days</p>
                        <div className="bg-[#151515] rounded-xl p-4 border border-gray-800">
                            <div className="flex items-end gap-1.5 h-24 mb-2">
                                {analytics.dailyBreakdown.map((day, i) => (
                                    <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                        <div className="w-full flex flex-col items-center justify-end" style={{ height: '80px' }}>
                                            {day.sales > 0 && (
                                                <div
                                                    className="w-full rounded-t bg-green-500 min-h-[4px]"
                                                    style={{ height: `${(day.sales / analytics.maxKnocks) * 80}px` }}
                                                />
                                            )}
                                            <div
                                                className="w-full bg-yellow-500/80 min-h-[2px]"
                                                style={{ 
                                                    height: `${(Math.max(day.knocks - day.sales, 0) / analytics.maxKnocks) * 80}px`,
                                                    borderRadius: day.sales > 0 ? '0' : '4px 4px 0 0'
                                                }}
                                            />
                                        </div>
                                        <span className="text-[9px] text-gray-500 font-bold">{day.label}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="flex items-center gap-4 text-[10px] text-gray-500 border-t border-gray-800 pt-2 mt-1">
                                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-yellow-500" /> Knocks</span>
                                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500" /> Sales</span>
                            </div>
                        </div>
                    </div>

                    {/* Summary Stats */}
                    <div>
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-3">Summary</p>
                        <div className="space-y-2">
                            <SummaryRow label="This Week" knocks={analytics.weekKnocks} sales={analytics.weekSales} />
                            <SummaryRow label="This Month" knocks={analytics.monthKnocks} sales={analytics.monthSales} />
                            <div className="bg-[#151515] rounded-xl p-4 border border-gray-800 flex items-center justify-between">
                                <span className="text-sm text-gray-400">Conversion Rate (7d)</span>
                                <span className={`text-xl font-bold ${parseFloat(analytics.conversionRate) > 5 ? 'text-green-500' : 'text-yellow-500'}`}>
                                    {analytics.conversionRate}%
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Route Progress */}
                    {analytics.totalProps > 0 && (
                        <div>
                            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-3">Route Progress</p>
                            <div className="bg-[#151515] rounded-xl p-4 border border-gray-800">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-sm text-gray-400">Properties Completed</span>
                                    <span className="font-bold text-white">{analytics.doneProps}/{analytics.totalProps}</span>
                                </div>
                                <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
                                    <div 
                                        className="h-full bg-gradient-to-r from-yellow-500 to-green-500 rounded-full transition-all"
                                        style={{ width: `${(analytics.doneProps / analytics.totalProps) * 100}%` }}
                                    />
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function StatCard({ icon: Icon, label, value, color }) {
    return (
        <div className="bg-[#151515] rounded-xl p-3 border border-gray-800 text-center">
            <Icon className={`w-4 h-4 mx-auto mb-1 ${color}`} />
            <p className="text-xl font-bold text-white">{value}</p>
            <p className="text-[9px] text-gray-500 font-bold uppercase">{label}</p>
        </div>
    );
}

function SummaryRow({ label, knocks, sales }) {
    return (
        <div className="bg-[#151515] rounded-xl p-4 border border-gray-800 flex items-center justify-between">
            <span className="text-sm text-gray-400">{label}</span>
            <div className="flex items-center gap-4">
                <span className="text-sm text-gray-300"><span className="font-bold text-white">{knocks}</span> knocks</span>
                <span className="text-sm text-green-400"><span className="font-bold">{sales}</span> sales</span>
            </div>
        </div>
    );
}