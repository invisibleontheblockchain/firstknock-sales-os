import React from 'react';
import { TrendingUp, TrendingDown, Target, Users, Navigation, MapPin, CheckCircle2, Flame } from 'lucide-react';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';

function StatCard({ label, value, subValue, icon: Icon, color, trend, featured }) {
    const { accent } = useTheme();
    const cardColor = color || accent;

    return (
        <div className={`group relative overflow-hidden rounded-2xl p-5 flex flex-col gap-2 transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${
            featured 
                ? 'border border-white/10 col-span-2 sm:col-span-1' 
                : 'border border-white/5'
        }`} style={{
            background: featured ? `linear-gradient(135deg, ${cardColor}15, #000000)` : 'linear-gradient(180deg, rgba(20,20,20,0.8) 0%, rgba(10,10,10,0.9) 100%)',
            boxShadow: featured ? `0 0 40px -10px ${cardColor}30` : '0 4px 20px -2px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(10px)'
        }}>
            {/* Glow effect */}
            <div className="absolute -top-10 -right-10 w-32 h-32 blur-3xl opacity-20 group-hover:opacity-40 transition-opacity duration-500 rounded-full pointer-events-none" style={{ background: cardColor }} />
            
            <div className="flex items-center justify-between relative z-10">
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">{label}</span>
                <div className="w-8 h-8 rounded-xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110" style={{ background: `${cardColor}20`, border: `1px solid ${cardColor}30` }}>
                    <Icon className="w-4 h-4 drop-shadow-md" style={{ color: cardColor }} />
                </div>
            </div>
            
            <div className="relative z-10 mt-1">
                <p className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-gray-400 tracking-tight drop-shadow-sm">{value}</p>
            </div>
            
            <div className="flex items-center gap-2 mt-auto relative z-10 pt-1">
                {subValue && <span className="text-xs text-gray-500 font-medium">{subValue}</span>}
                {trend !== undefined && trend !== 0 && (
                    <span className={`text-[10px] font-bold flex items-center gap-0.5 px-2 py-0.5 rounded-md backdrop-blur-sm border ${
                        trend >= 0 ? 'text-green-400 bg-green-500/10 border-green-500/20' : 'text-red-400 bg-red-500/10 border-red-500/20'
                    }`}>
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
    const knocksPerSale = sales.length > 0 ? Math.round(logs.length / sales.length) : 0;

    const totalDoors = properties.length;
    const knockedDoors = new Set(logs.map(l => l.address_hash)).size;

    return (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <StatCard
                label="Today"
                value={todayLogs.length}
                subValue={`${todaySales.length} sale${todaySales.length !== 1 ? 's' : ''}`}
                icon={Target}
                featured
            />
            <StatCard
                label="This Week"
                value={thisWeekLogs.length}
                subValue="knocks"
                icon={Flame}
                color="#f97316"
                trend={weeklyTrend}
            />
            <StatCard
                label="Knocks / Sale"
                value={knocksPerSale || '-'}
                subValue="doors per deal"
                icon={Navigation}
                color="#eab308"
            />
            <StatCard
                label="Conversion"
                value={`${conversionRate}%`}
                subValue={`${sales.length}/${logs.length}`}
                icon={CheckCircle2}
                color="#22c55e"
            />
            <StatCard
                label="Coverage"
                value={totalDoors > 0 ? `${Math.round((knockedDoors / totalDoors) * 100)}%` : '0%'}
                subValue={`${knockedDoors} of ${totalDoors}`}
                icon={MapPin}
                color="#3b82f6"
            />
            <StatCard
                label="Team"
                value={teamMembers.length}
                subValue="reps"
                icon={Users}
                color="#8b5cf6"
            />
            <StatCard
                label="Daily Avg"
                value={thisWeekLogs.length > 0 ? Math.round(thisWeekLogs.length / 7) : 0}
                subValue="knocks/day"
                icon={TrendingUp}
                color="#06b6d4"
            />
            <StatCard
                label="Territory"
                value={totalDoors.toLocaleString()}
                subValue="total doors"
                icon={Target}
                color="#ec4899"
            />
        </div>
    );
}