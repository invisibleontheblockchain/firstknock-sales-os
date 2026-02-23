import React from 'react';
import { TrendingUp, TrendingDown, Target, Users, Navigation, MapPin, CheckCircle2, Flame } from 'lucide-react';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';

function StatCard({ label, value, subValue, icon: Icon, color, trend, featured }) {
    const { accent } = useTheme();
    const cardColor = color || accent; 

    return (
        <div 
            className={`group relative overflow-hidden rounded-2xl p-4 flex flex-col gap-1 transition-all duration-300 hover:scale-[1.02] border ${featured ? 'border-white/20 shadow-[0_0_30px_rgba(255,255,255,0.1)]' : 'border-gray-800 hover:border-gray-600'} bg-[#111]`}
            style={{ 
                boxShadow: featured ? `0 0 40px ${cardColor}15` : 'none',
                borderColor: featured ? `${cardColor}40` : undefined
            }}
        >
            <div className="absolute -top-10 -right-10 w-32 h-32 blur-3xl opacity-0 group-hover:opacity-20 transition-opacity duration-500 rounded-full pointer-events-none" style={{ background: cardColor }} />
            
            <div className="flex items-center justify-between relative z-10 mb-1">
                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">{label}</span>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center transition-transform duration-300 group-hover:scale-110 group-hover:shadow-[0_0_15px_rgba(255,255,255,0.3)]" style={{ background: `${cardColor}15`, color: cardColor }}>
                    <Icon className="w-3.5 h-3.5" />
                </div>
            </div>
            
            <div className="relative z-10">
                <p className="text-2xl font-black tracking-tight text-white group-hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.5)] transition-all duration-300">{value}</p>
            </div>
            
            <div className="flex items-center justify-between mt-auto relative z-10 pt-1">
                {subValue && <span className="text-[10px] text-gray-500 font-medium">{subValue}</span>}
                {trend !== undefined && trend !== 0 && (
                    <span className={`text-[9px] font-bold flex items-center gap-0.5 px-1.5 py-0.5 rounded backdrop-blur-sm ${
                        trend >= 0 ? 'text-green-400 bg-green-400/10' : 'text-red-400 bg-red-400/10'
                    }`}>
                        {trend >= 0 ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
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
        <div className={`grid grid-cols-2 ${isEssential ? 'sm:grid-cols-2' : 'sm:grid-cols-4'} gap-3`}>
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