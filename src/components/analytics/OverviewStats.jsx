import React from 'react';
import { TrendingUp, TrendingDown, Target, Users, Navigation, MapPin, CheckCircle2, Flame } from 'lucide-react';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';

function StatCard({ label, value, subValue, icon: Icon, color, trend, featured }) {
    const { accent } = useTheme();
    const cardColor = color || accent; 

    return (
        <div 
            className={`group relative overflow-hidden rounded-xl p-3 flex flex-col gap-0.5 transition-all duration-300 hover:scale-[1.02] border ${featured ? 'border-white/20 shadow-[0_0_20px_rgba(255,255,255,0.08)]' : 'border-gray-800 hover:border-gray-600'} bg-[#111]`}
            style={{ 
                boxShadow: featured ? `0 0 30px ${cardColor}15` : 'none',
                borderColor: featured ? `${cardColor}40` : undefined
            }}
        >
            <div className="absolute -top-8 -right-8 w-24 h-24 blur-2xl opacity-0 group-hover:opacity-20 transition-opacity duration-500 rounded-full pointer-events-none" style={{ background: cardColor }} />
            
            <div className="flex items-center justify-between relative z-10 mb-0.5">
                <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">{label}</span>
                <div className="w-6 h-6 rounded-md flex items-center justify-center transition-transform duration-300 group-hover:scale-110 group-hover:shadow-[0_0_10px_rgba(255,255,255,0.2)]" style={{ background: `${cardColor}15`, color: cardColor }}>
                    <Icon className="w-3 h-3" />
                </div>
            </div>
            
            <div className="relative z-10">
                <p className="text-xl font-black tracking-tight text-white group-hover:drop-shadow-[0_0_6px_rgba(255,255,255,0.4)] transition-all duration-300">{value}</p>
            </div>
            
            <div className="flex items-center justify-between mt-auto relative z-10 pt-0.5">
                {subValue && <span className="text-[9px] text-gray-500 font-medium">{subValue}</span>}
                {trend !== undefined && trend !== 0 && (
                    <span className={`text-[8px] font-bold flex items-center gap-0.5 px-1 py-0.5 rounded backdrop-blur-sm ${
                        trend >= 0 ? 'text-green-400 bg-green-400/10' : 'text-red-400 bg-red-400/10'
                    }`}>
                        {trend >= 0 ? <TrendingUp className="w-2 h-2" /> : <TrendingDown className="w-2 h-2" />}
                        {Math.abs(trend)}%
                    </span>
                )}
            </div>
        </div>
    );
}

export default function OverviewStats({ routes, logs, properties, teamMembers, viewMode = 'advanced' }) {
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

    const isEssential = viewMode === 'essential';

    return (
        <div className={`grid grid-cols-2 ${isEssential ? 'sm:grid-cols-2' : 'sm:grid-cols-4'} gap-2`}>
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
            {!isEssential && (
                <>
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
                </>
            )}
        </div>
    );
}