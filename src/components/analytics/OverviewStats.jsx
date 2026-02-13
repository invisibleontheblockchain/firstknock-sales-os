import React from 'react';
import { TrendingUp, TrendingDown, Target, Users, Navigation, MapPin, CheckCircle2, XCircle, Clock, Flame } from 'lucide-react';

const BRAND = { gold: '#FFD700', charcoal: '#1F1F1F' };

function StatCard({ label, value, subValue, icon: Icon, color = BRAND.gold, trend }) {
    return (
        <div className="bg-[#151515] border border-gray-800 rounded-xl p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">{label}</span>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${color}15` }}>
                    <Icon className="w-4 h-4" style={{ color }} />
                </div>
            </div>
            <p className="text-2xl font-bold text-white">{value}</p>
            <div className="flex items-center justify-between">
                {subValue && <span className="text-[10px] text-gray-500">{subValue}</span>}
                {trend !== undefined && (
                    <span className={`text-[10px] font-bold flex items-center gap-0.5 ${trend >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {trend >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {Math.abs(trend)}%
                    </span>
                )}
            </div>
        </div>
    );
}

export default function OverviewStats({ routes, logs, properties, teamMembers }) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 86400000);
    const twoWeeksAgo = new Date(today.getTime() - 14 * 86400000);

    const todayLogs = logs.filter(l => new Date(l.created_date) >= today);
    const thisWeekLogs = logs.filter(l => new Date(l.created_date) >= weekAgo);
    const lastWeekLogs = logs.filter(l => {
        const d = new Date(l.created_date);
        return d >= twoWeeksAgo && d < weekAgo;
    });

    const weeklyTrend = lastWeekLogs.length > 0 
        ? Math.round(((thisWeekLogs.length - lastWeekLogs.length) / lastWeekLogs.length) * 100) 
        : thisWeekLogs.length > 0 ? 100 : 0;

    const activeRoutes = routes.filter(r => r.status === 'ACTIVE' || r.status === 'IN_PROGRESS');
    const completedRoutes = routes.filter(r => r.status === 'COMPLETED');
    
    const sales = logs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status));
    const todaySales = sales.filter(l => new Date(l.created_date) >= today);
    const conversionRate = logs.length > 0 ? ((sales.length / logs.length) * 100).toFixed(1) : '0';

    const totalDoors = properties.length;
    const knockedDoors = new Set(logs.map(l => l.address_hash)).size;

    return (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
                label="Today's Knocks"
                value={todayLogs.length}
                subValue={`${todaySales.length} sales today`}
                icon={Target}
                color="#FFD700"
            />
            <StatCard
                label="This Week"
                value={thisWeekLogs.length}
                subValue="total knocks"
                icon={Flame}
                color="#f97316"
                trend={weeklyTrend}
            />
            <StatCard
                label="Conversion"
                value={`${conversionRate}%`}
                subValue={`${sales.length} of ${logs.length} knocks`}
                icon={CheckCircle2}
                color="#22c55e"
            />
            <StatCard
                label="Territory"
                value={knockedDoors}
                subValue={`of ${totalDoors} total doors`}
                icon={MapPin}
                color="#3b82f6"
            />
            <StatCard
                label="Active Routes"
                value={activeRoutes.length}
                subValue={`${completedRoutes.length} completed`}
                icon={Navigation}
                color="#FFD700"
            />
            <StatCard
                label="Team Size"
                value={teamMembers.length}
                subValue="active reps"
                icon={Users}
                color="#8b5cf6"
            />
            <StatCard
                label="Avg/Day"
                value={thisWeekLogs.length > 0 ? Math.round(thisWeekLogs.length / 7) : 0}
                subValue="knocks per day"
                icon={TrendingUp}
                color="#06b6d4"
            />
            <StatCard
                label="Coverage"
                value={totalDoors > 0 ? `${Math.round((knockedDoors / totalDoors) * 100)}%` : '0%'}
                subValue="territory covered"
                icon={Target}
                color="#ec4899"
            />
        </div>
    );
}