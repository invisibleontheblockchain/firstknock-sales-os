import React, { useState, useMemo } from 'react';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    AreaChart, Area, BarChart, Bar, LineChart, Line,
    XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, Cell
} from 'recharts';
import { 
    DollarSign, Users, Database, Zap, TrendingUp, Server,
    ArrowLeft, Info, Shield
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

// ============================================
// COST MODEL CONSTANTS
// ============================================

// RentCast API (Updated with overage fees)
const RENTCAST_PLANS = [
    { name: 'Developer', calls: 50, price: 0, overage: 0.20 },
    { name: 'Foundation', calls: 1000, price: 74, overage: 0.06 },
    { name: 'Growth', calls: 5000, price: 199, overage: 0.03 },
    { name: 'Scale', calls: 25000, price: 449, overage: 0.015 },
    { name: 'Enterprise', calls: 50000, price: 899, overage: 0.01 },
    { name: 'Enterprise+', calls: 200000, price: 3499, overage: 0.005 },
    { name: 'Custom', calls: 1000000, price: 14999, overage: 0.002 },
];

// Average zip codes per user, API calls per zip fetch
const AVG_ZIPS_PER_USER = 3;
const API_CALLS_PER_ZIP = 4; // Up to 2000 props per zip (4 × 500)
const CACHE_HIT_RATE = 0.85; // 85% of zips are re-used (cached in Base44 DB)

// Base44 Platform
const BASE44_FREE_TIER = 0;
const BASE44_PRO = 29; // /mo estimate
const BASE44_GROWTH = 79;
const BASE44_ENTERPRISE = 199;

// Stripe Fees
const STRIPE_PERCENT = 2.9;
const STRIPE_FIXED = 0.30;

// App Store Fees (Apple/Google take 30% on in-app purchases, 15% for small business program)
const APP_STORE_CUT_PERCENT = 30; // Default 30%
const MOBILE_REVENUE_PERCENT = 0.40; // Estimated 40% of revenue comes through mobile app stores

// Revenue model
const BASE_PRICE = 49;
const DISCOUNT_PER_USER = 1;
const MIN_PRICE_PER_USER = 20;
const AVG_TEAM_SIZE = 5; // Average team per paying manager

const getPricePerUser = (teamSize) => Math.max(MIN_PRICE_PER_USER, BASE_PRICE - (teamSize - 1) * DISCOUNT_PER_USER);

// ============================================
// SCALING TIERS
// ============================================
const USER_TIERS = [1, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];

function getRentCastPlan(apiCalls) {
    // Find the first plan that covers the API calls, or return the largest plan if none fit
    return RENTCAST_PLANS.find(p => p.calls >= apiCalls) || RENTCAST_PLANS[RENTCAST_PLANS.length - 1];
}

function getBase44Cost(users) {
    if (users <= 10) return BASE44_FREE_TIER;
    if (users <= 100) return BASE44_PRO;
    if (users <= 1000) return BASE44_GROWTH;
    return BASE44_ENTERPRISE;
}

function computeMetrics(users) {
    // Users are individual reps + managers. Assume 1 manager per AVG_TEAM_SIZE users
    const managers = Math.ceil(users / AVG_TEAM_SIZE);
    const payingAccounts = managers; // Managers pay

    // Revenue
    const avgPricePerUser = getPricePerUser(AVG_TEAM_SIZE);
    const monthlyRevenue = payingAccounts * AVG_TEAM_SIZE * avgPricePerUser;
    const annualRevenue = monthlyRevenue * 12;

    // RentCast: Only new zips cost API calls (cache handles the rest)
    const totalZipsNeeded = managers * AVG_ZIPS_PER_USER;
    const newZipsPerMonth = Math.ceil(totalZipsNeeded * (1 - CACHE_HIT_RATE)); // Only 15% need fresh API calls after initial
    const monthlyApiCalls = newZipsPerMonth * API_CALLS_PER_ZIP;
    
    const rentCastPlan = getRentCastPlan(monthlyApiCalls);
    let rentCastCost = rentCastPlan.price;
    
    // Add overage if applicable
    if (monthlyApiCalls > rentCastPlan.calls) {
        rentCastCost += (monthlyApiCalls - rentCastPlan.calls) * rentCastPlan.overage;
    }

    // Base44
    const base44Cost = getBase44Cost(users);

    // Stripe: ~2.9% + $0.30 per transaction
    const monthlyTransactions = payingAccounts; // 1 sub charge per manager/mo
    const stripeFees = monthlyTransactions * (monthlyRevenue / monthlyTransactions * (STRIPE_PERCENT / 100) + STRIPE_FIXED);

    // App Store Fees: 30% cut on mobile-originated revenue
    const mobileRevenue = monthlyRevenue * MOBILE_REVENUE_PERCENT;
    const appStoreFees = Math.round(mobileRevenue * (APP_STORE_CUT_PERCENT / 100));

    // Database storage estimate
    const propertiesPerZip = 1500; // avg
    const totalProperties = totalZipsNeeded * propertiesPerZip;
    const avgRecordSizeKb = 0.5; // ~500 bytes per property record
    const dbSizeGb = (totalProperties * avgRecordSizeKb) / (1024 * 1024);

    // Interaction logs (avg 20 logs per user per day)
    const dailyLogs = users * 20;
    const monthlyLogs = dailyLogs * 22; // working days
    const logStorageGb = (monthlyLogs * 0.3) / (1024 * 1024); // ~300 bytes per log

    // Infrastructure estimates (hosting, CDN, etc.)
    const infraCost = users <= 100 ? 0 : users <= 1000 ? 50 : users <= 10000 ? 200 : users <= 100000 ? 1000 : 5000;

    // Total costs
    const totalMonthlyCost = rentCastCost + base44Cost + stripeFees + appStoreFees + infraCost;
    const totalAnnualCost = totalMonthlyCost * 12;

    // Margins
    const monthlyProfit = monthlyRevenue - totalMonthlyCost;
    const profitMargin = monthlyRevenue > 0 ? (monthlyProfit / monthlyRevenue * 100) : 0;

    return {
        users,
        managers,
        payingAccounts,
        monthlyRevenue: Math.round(monthlyRevenue),
        annualRevenue: Math.round(annualRevenue),
        avgPricePerUser: Math.round(avgPricePerUser),
        totalZipsNeeded,
        newZipsPerMonth,
        monthlyApiCalls,
        rentCastPlan: rentCastPlan.name,
        rentCastCost,
        base44Cost,
        stripeFees: Math.round(stripeFees),
        appStoreFees,
        infraCost,
        totalMonthlyCost: Math.round(totalMonthlyCost),
        totalAnnualCost: Math.round(totalAnnualCost),
        monthlyProfit: Math.round(monthlyProfit),
        profitMargin: Math.round(profitMargin * 10) / 10,
        totalProperties: Math.round(totalProperties),
        dbSizeGb: Math.round(dbSizeGb * 100) / 100,
        monthlyLogs,
        logStorageGb: Math.round(logStorageGb * 100) / 100,
        dailyLogs,
    };
}

// ============================================
// COMPONENTS
// ============================================

function MetricCard({ title, value, sub, icon: Icon, color, bg }) {
    return (
        <Card className="bg-[#151515] border-gray-800">
            <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">{title}</span>
                    <div className={`p-1.5 rounded-lg ${bg}`}><Icon className={`w-3.5 h-3.5 ${color}`} /></div>
                </div>
                <p className="text-xl font-bold text-white">{value}</p>
                {sub && <p className="text-[10px] text-gray-600 mt-0.5">{sub}</p>}
            </CardContent>
        </Card>
    );
}

function CustomTooltip({ active, payload, label }) {
    if (!active || !payload?.length) return null;
    return (
        <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs max-w-[220px]">
            <p className="font-bold text-white mb-1">{label} users</p>
            {payload.map((p, i) => (
                <p key={i} style={{ color: p.color }} className="flex justify-between gap-4">
                    <span>{p.name}:</span>
                    <span className="font-bold">${p.value?.toLocaleString()}</span>
                </p>
            ))}
        </div>
    );
}

export default function CostProjections() {
    const { accent } = useTheme();
    const accentText = contrastText(accent);
    const [selectedTier, setSelectedTier] = useState(1000);

    const allMetrics = useMemo(() => USER_TIERS.map(computeMetrics), []);
    const selected = useMemo(() => computeMetrics(selectedTier), [selectedTier]);

    // Chart data
    const revenueVsCostData = allMetrics.map(m => ({
        name: m.users >= 1000 ? `${(m.users / 1000).toFixed(0)}K` : m.users.toString(),
        users: m.users,
        revenue: m.monthlyRevenue,
        cost: m.totalMonthlyCost,
        profit: m.monthlyProfit,
    }));

    const costBreakdownData = allMetrics.map(m => ({
        name: m.users >= 1000 ? `${(m.users / 1000).toFixed(0)}K` : m.users.toString(),
        'RentCast': m.rentCastCost,
        'Base44': m.base44Cost,
        'Stripe': m.stripeFees,
        'App Stores': m.appStoreFees,
        'Infra': m.infraCost,
    }));

    const marginData = allMetrics.map(m => ({
        name: m.users >= 1000 ? `${(m.users / 1000).toFixed(0)}K` : m.users.toString(),
        margin: m.profitMargin,
    }));

    return (
        <div className="h-full flex flex-col" style={{ background: '#0A0A0A' }}>
            {/* Header */}
            <div className="px-4 md:px-6 pt-4 pb-3 border-b border-gray-800/40 sticky top-0 z-10" style={{ background: '#0A0A0A' }}>
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: `${accent}15` }}>
                            <TrendingUp className="w-4 h-4" style={{ color: accent }} />
                        </div>
                        <div>
                            <h1 className="text-base font-extrabold text-white tracking-tight">Cost Projections</h1>
                            <p className="text-[10px] text-gray-500">Scaling metrics from 1 to 1,000,000 users</p>
                        </div>
                    </div>
                    <Link to={createPageUrl('Billing')}>
                        <Button variant="ghost" size="sm" className="text-gray-500 hover:text-white text-xs">
                            <ArrowLeft className="w-4 h-4 mr-1" /> Plans
                        </Button>
                    </Link>
                </div>

                {/* Tier Selector */}
                <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
                    {USER_TIERS.map(tier => (
                        <button
                            key={tier}
                            onClick={() => setSelectedTier(tier)}
                            className={`shrink-0 px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                                selectedTier === tier ? 'text-black shadow' : 'text-gray-500 hover:text-white bg-black/30 border border-gray-800'
                            }`}
                            style={selectedTier === tier ? { background: accent, color: accentText } : {}}
                        >
                            {tier >= 1000 ? `${(tier / 1000).toFixed(0)}K` : tier}
                        </button>
                    ))}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 md:p-6">
                <div className="max-w-7xl mx-auto space-y-5">

                    {/* KPI Row for Selected Tier */}
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                        <MetricCard title="Total Users" value={selected.users.toLocaleString()} sub={`${selected.managers} paying managers`} icon={Users} color="text-blue-400" bg="bg-blue-500/10" />
                        <MetricCard title="Monthly Revenue" value={`$${selected.monthlyRevenue.toLocaleString()}`} sub={`$${selected.annualRevenue.toLocaleString()}/yr`} icon={DollarSign} color="text-green-400" bg="bg-green-500/10" />
                        <MetricCard title="Monthly Cost" value={`$${selected.totalMonthlyCost.toLocaleString()}`} sub={`$${selected.totalAnnualCost.toLocaleString()}/yr`} icon={Server} color="text-red-400" bg="bg-red-500/10" />
                        <MetricCard title="Profit Margin" value={`${selected.profitMargin}%`} sub={`$${selected.monthlyProfit.toLocaleString()}/mo profit`} icon={TrendingUp} color="text-yellow-400" bg="bg-yellow-500/10" />
                        <MetricCard title="Properties" value={selected.totalProperties.toLocaleString()} sub={`${selected.dbSizeGb} GB storage`} icon={Database} color="text-purple-400" bg="bg-purple-500/10" />
                        <MetricCard title="API Calls/Mo" value={selected.monthlyApiCalls.toLocaleString()} sub={`${selected.rentCastPlan} plan`} icon={Zap} color="text-cyan-400" bg="bg-cyan-500/10" />
                    </div>

                    {/* Cost Breakdown for Selected Tier */}
                    <Card className="bg-[#151515] border-gray-800">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-bold text-gray-400 uppercase flex items-center gap-2">
                                <Info className="w-3.5 h-3.5" /> Detailed Breakdown — {selected.users.toLocaleString()} Users
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Revenue Side */}
                                <div className="space-y-3">
                                    <h4 className="text-[10px] font-bold text-green-400 uppercase tracking-wider">Revenue</h4>
                                    <div className="space-y-2">
                                        <Row label="Paying Managers" value={selected.payingAccounts.toLocaleString()} />
                                        <Row label="Avg Team Size" value={`${AVG_TEAM_SIZE} users`} />
                                        <Row label="Price/User/Mo" value={`$${selected.avgPricePerUser}`} />
                                        <Row label="Monthly Revenue" value={`$${selected.monthlyRevenue.toLocaleString()}`} highlight="green" />
                                        <Row label="Annual Revenue" value={`$${selected.annualRevenue.toLocaleString()}`} highlight="green" />
                                    </div>
                                </div>

                                {/* Cost Side */}
                                <div className="space-y-3">
                                    <h4 className="text-[10px] font-bold text-red-400 uppercase tracking-wider">Costs</h4>
                                    <div className="space-y-2">
                                        <Row label="RentCast API" value={`$${selected.rentCastCost}/mo`} sub={`${selected.rentCastPlan} — ${selected.monthlyApiCalls} calls`} />
                                        <Row label="Base44 Platform" value={`$${selected.base44Cost}/mo`} />
                                        <Row label="Stripe Fees" value={`$${selected.stripeFees}/mo`} sub={`2.9% + $0.30 × ${selected.payingAccounts} txns`} />
                                        <Row label="App Store Fees" value={`$${selected.appStoreFees.toLocaleString()}/mo`} sub={`${APP_STORE_CUT_PERCENT}% cut on ${Math.round(MOBILE_REVENUE_PERCENT * 100)}% mobile revenue`} />
                                        <Row label="Infrastructure" value={`$${selected.infraCost}/mo`} sub="Hosting, CDN, monitoring" />
                                        <Row label="Total Monthly" value={`$${selected.totalMonthlyCost.toLocaleString()}`} highlight="red" />
                                        <Row label="Net Profit/Mo" value={`$${selected.monthlyProfit.toLocaleString()}`} highlight={selected.monthlyProfit >= 0 ? 'green' : 'red'} />
                                    </div>
                                </div>
                            </div>

                            {/* Data & Storage */}
                            <div className="mt-4 pt-4 border-t border-gray-800">
                                <h4 className="text-[10px] font-bold text-purple-400 uppercase tracking-wider mb-2">Data & Storage</h4>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                    <MiniStat label="Total Zips" value={selected.totalZipsNeeded.toLocaleString()} />
                                    <MiniStat label="New Zips/Mo" value={selected.newZipsPerMonth.toLocaleString()} sub={`${Math.round(CACHE_HIT_RATE * 100)}% cache hit`} />
                                    <MiniStat label="Properties" value={selected.totalProperties.toLocaleString()} sub={`${selected.dbSizeGb} GB`} />
                                    <MiniStat label="Daily Logs" value={selected.dailyLogs.toLocaleString()} sub={`${selected.logStorageGb} GB/mo`} />
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Revenue vs Cost Chart */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        <Card className="bg-[#151515] border-gray-800">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-xs font-bold text-gray-400 uppercase">Revenue vs Cost at Scale</CardTitle>
                            </CardHeader>
                            <CardContent className="h-[300px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <AreaChart data={revenueVsCostData}>
                                        <defs>
                                            <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                                            </linearGradient>
                                            <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                                        <XAxis dataKey="name" stroke="#555" fontSize={10} tickLine={false} />
                                        <YAxis stroke="#555" fontSize={10} tickLine={false} tickFormatter={v => `$${v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : v >= 1000 ? `${(v/1000).toFixed(0)}K` : v}`} />
                                        <Tooltip content={<CustomTooltip />} />
                                        <Legend wrapperStyle={{ fontSize: '10px' }} />
                                        <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#22c55e" fill="url(#revGrad)" strokeWidth={2} />
                                        <Area type="monotone" dataKey="cost" name="Cost" stroke="#ef4444" fill="url(#costGrad)" strokeWidth={2} />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </CardContent>
                        </Card>

                        <Card className="bg-[#151515] border-gray-800">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-xs font-bold text-gray-400 uppercase">Profit Margin %</CardTitle>
                            </CardHeader>
                            <CardContent className="h-[300px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={marginData}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                                        <XAxis dataKey="name" stroke="#555" fontSize={10} tickLine={false} />
                                        <YAxis stroke="#555" fontSize={10} tickLine={false} unit="%" domain={[0, 100]} />
                                        <Tooltip content={({ active, payload, label }) => {
                                            if (!active || !payload?.length) return null;
                                            return (
                                                <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs">
                                                    <p className="font-bold text-white">{label} users</p>
                                                    <p className="text-yellow-400">Margin: {payload[0].value}%</p>
                                                </div>
                                            );
                                        }} />
                                        <Bar dataKey="margin" name="Margin %" radius={[4, 4, 0, 0]} barSize={20}>
                                            {marginData.map((m, i) => (
                                                <Cell key={i} fill={m.margin >= 80 ? '#22c55e' : m.margin >= 50 ? '#FFD700' : m.margin >= 0 ? '#f97316' : '#ef4444'} />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Stacked Cost Breakdown */}
                    <Card className="bg-[#151515] border-gray-800">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-bold text-gray-400 uppercase">Cost Composition at Each Tier</CardTitle>
                        </CardHeader>
                        <CardContent className="h-[300px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={costBreakdownData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                                    <XAxis dataKey="name" stroke="#555" fontSize={10} tickLine={false} />
                                    <YAxis stroke="#555" fontSize={10} tickLine={false} tickFormatter={v => `$${v >= 1000 ? `${(v/1000).toFixed(0)}K` : v}`} />
                                    <Tooltip content={({ active, payload, label }) => {
                                        if (!active || !payload?.length) return null;
                                        const total = payload.reduce((s, p) => s + (p.value || 0), 0);
                                        return (
                                            <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs">
                                                <p className="font-bold text-white mb-1">{label} users</p>
                                                {payload.map((p, i) => (
                                                    <p key={i} style={{ color: p.color }}>{p.name}: ${p.value?.toLocaleString()}</p>
                                                ))}
                                                <p className="text-white font-bold mt-1 pt-1 border-t border-gray-700">Total: ${total.toLocaleString()}</p>
                                            </div>
                                        );
                                    }} />
                                    <Legend wrapperStyle={{ fontSize: '10px' }} />
                                    <Bar dataKey="RentCast" stackId="a" fill="#f97316" />
                                    <Bar dataKey="Base44" stackId="a" fill="#8b5cf6" />
                                    <Bar dataKey="Stripe" stackId="a" fill="#3b82f6" />
                                    <Bar dataKey="App Stores" stackId="a" fill="#ec4899" />
                                    <Bar dataKey="Infra" stackId="a" fill="#6b7280" radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>

                    {/* Full Table */}
                    <Card className="bg-[#151515] border-gray-800">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-bold text-gray-400 uppercase flex items-center gap-2">
                                <Database className="w-3.5 h-3.5" /> Complete Scaling Table
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <table className="w-full text-xs text-left">
                                    <thead className="text-[10px] text-gray-500 uppercase bg-black/30">
                                        <tr>
                                            <th className="px-3 py-2 rounded-l-lg sticky left-0 bg-[#111]">Users</th>
                                            <th className="px-3 py-2">Managers</th>
                                            <th className="px-3 py-2 text-green-400">Revenue/Mo</th>
                                            <th className="px-3 py-2 text-orange-400">RentCast</th>
                                            <th className="px-3 py-2 text-purple-400">Base44</th>
                                            <th className="px-3 py-2 text-blue-400">Stripe</th>
                                            <th className="px-3 py-2 text-pink-400">App Stores</th>
                                            <th className="px-3 py-2 text-gray-400">Infra</th>
                                            <th className="px-3 py-2 text-red-400">Total Cost</th>
                                            <th className="px-3 py-2 text-green-400">Profit/Mo</th>
                                            <th className="px-3 py-2 text-yellow-400">Margin</th>
                                            <th className="px-3 py-2 text-cyan-400">API Calls</th>
                                            <th className="px-3 py-2 text-purple-400">Properties</th>
                                            <th className="px-3 py-2 rounded-r-lg">DB Size</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-800/50">
                                        {allMetrics.map(m => (
                                            <tr
                                                key={m.users}
                                                onClick={() => setSelectedTier(m.users)}
                                                className={`hover:bg-white/5 cursor-pointer transition-colors ${
                                                    selectedTier === m.users ? 'bg-yellow-500/5 border-l-2 border-yellow-500' : ''
                                                }`}
                                            >
                                                <td className="px-3 py-2.5 font-bold text-white sticky left-0 bg-[#151515]">{m.users.toLocaleString()}</td>
                                                <td className="px-3 py-2.5 text-gray-400">{m.managers.toLocaleString()}</td>
                                                <td className="px-3 py-2.5 text-green-400 font-bold">${m.monthlyRevenue.toLocaleString()}</td>
                                                <td className="px-3 py-2.5 text-orange-400">${m.rentCastCost.toLocaleString()}</td>
                                                <td className="px-3 py-2.5 text-purple-400">${m.base44Cost}</td>
                                                <td className="px-3 py-2.5 text-blue-400">${m.stripeFees.toLocaleString()}</td>
                                                <td className="px-3 py-2.5 text-pink-400">${m.appStoreFees.toLocaleString()}</td>
                                                <td className="px-3 py-2.5 text-gray-500">${m.infraCost.toLocaleString()}</td>
                                                <td className="px-3 py-2.5 text-red-400 font-bold">${m.totalMonthlyCost.toLocaleString()}</td>
                                                <td className={`px-3 py-2.5 font-bold ${m.monthlyProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    ${m.monthlyProfit.toLocaleString()}
                                                </td>
                                                <td className="px-3 py-2.5">
                                                    <Badge className={`text-[9px] ${
                                                        m.profitMargin >= 80 ? 'bg-green-900/50 text-green-400' :
                                                        m.profitMargin >= 50 ? 'bg-yellow-900/50 text-yellow-400' :
                                                        'bg-red-900/50 text-red-400'
                                                    }`}>
                                                        {m.profitMargin}%
                                                    </Badge>
                                                </td>
                                                <td className="px-3 py-2.5 text-cyan-400">{m.monthlyApiCalls.toLocaleString()}</td>
                                                <td className="px-3 py-2.5 text-purple-300">{m.totalProperties.toLocaleString()}</td>
                                                <td className="px-3 py-2.5 text-gray-500">{m.dbSizeGb} GB</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Assumptions */}
                    <Card className="bg-[#111] border-gray-800">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-bold text-gray-500 uppercase flex items-center gap-2">
                                <Shield className="w-3.5 h-3.5" /> Model Assumptions
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-[11px] text-gray-500">
                                <div>
                                    <p className="font-bold text-gray-400 mb-1">Revenue Model</p>
                                    <ul className="space-y-1">
                                        <li>• Base price: ${BASE_PRICE}/user/mo</li>
                                        <li>• Volume discount: ${DISCOUNT_PER_USER}/user for each team member</li>
                                        <li>• Floor: ${MIN_PRICE_PER_USER}/user/mo minimum</li>
                                        <li>• Avg team size: {AVG_TEAM_SIZE} users per manager</li>
                                    </ul>
                                </div>
                                <div>
                                    <p className="font-bold text-gray-400 mb-1">API & Data</p>
                                    <ul className="space-y-1">
                                        <li>• {AVG_ZIPS_PER_USER} zip codes per manager avg</li>
                                        <li>• {API_CALLS_PER_ZIP} API calls per new zip fetch</li>
                                        <li>• {Math.round(CACHE_HIT_RATE * 100)}% cache hit rate (Base44 DB)</li>
                                        <li>• ~1,500 properties per zip code avg</li>
                                    </ul>
                                </div>
                                <div>
                                    <p className="font-bold text-gray-400 mb-1">Costs</p>
                                    <ul className="space-y-1">
                                        <li>• Stripe: {STRIPE_PERCENT}% + ${STRIPE_FIXED}/txn</li>
                                        <li>• App Stores: {APP_STORE_CUT_PERCENT}% on ~{Math.round(MOBILE_REVENUE_PERCENT * 100)}% of revenue</li>
                                        <li>• RentCast plans scale by usage tier</li>
                                        <li>• Infra costs increase with user count</li>
                                        <li>• 20 interaction logs/user/day assumed</li>
                                    </ul>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                </div>
            </div>
        </div>
    );
}

function Row({ label, value, sub, highlight }) {
    const colors = {
        green: 'text-green-400',
        red: 'text-red-400',
        yellow: 'text-yellow-400',
    };
    return (
        <div className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-black/20">
            <div>
                <span className="text-xs text-gray-400">{label}</span>
                {sub && <p className="text-[9px] text-gray-600">{sub}</p>}
            </div>
            <span className={`text-sm font-bold ${highlight ? colors[highlight] : 'text-white'}`}>{value}</span>
        </div>
    );
}

function MiniStat({ label, value, sub }) {
    return (
        <div className="bg-black/30 rounded-lg p-2.5 border border-gray-800">
            <p className="text-[9px] text-gray-500 font-bold uppercase">{label}</p>
            <p className="text-sm font-bold text-white">{value}</p>
            {sub && <p className="text-[9px] text-gray-600">{sub}</p>}
        </div>
    );
}