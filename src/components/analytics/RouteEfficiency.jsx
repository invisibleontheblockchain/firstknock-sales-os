import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, Cell } from 'recharts';
import { MapPin } from 'lucide-react';

const COLORS = ['#FFD700', '#3b82f6', '#22c55e', '#8b5cf6', '#ec4899', '#f97316', '#06b6d4', '#ef4444'];

export default function RouteEfficiency({ routes, appointments, logs }) {
    const data = useMemo(() => {
        return routes
            .filter(r => r.property_hashes?.length > 0)
            .slice(0, 12) // Top 12 routes
            .map((route, idx) => {
                const houseCount = route.metrics?.house_count || route.property_hashes?.length || 0;
                const distance = route.metrics?.distance || 0;
                const score = route.metrics?.score || 0;

                // Count appointments linked to this route
                const routeAppts = appointments.filter(a => a.route_id === route.id);
                const routeSold = routeAppts.filter(a => a.outcome === 'sold').length;

                // Count knocks from logs matching route properties
                const routeHashes = new Set(route.property_hashes || []);
                const routeKnocks = logs.filter(l => routeHashes.has(l.address_hash)).length;

                const efficiencyScore = houseCount > 0
                    ? Math.round(((routeKnocks + routeAppts.length) / houseCount) * 100)
                    : 0;

                return {
                    name: route.name?.length > 12 ? route.name.slice(0, 12) + '…' : (route.name || `Route ${idx + 1}`),
                    houses: houseCount,
                    distance: Math.round(distance * 10) / 10,
                    score,
                    knocks: routeKnocks,
                    appointments: routeAppts.length,
                    sold: routeSold,
                    efficiency: Math.min(efficiencyScore, 100),
                    rep: route.assigned_to_name || 'Unassigned',
                };
            })
            .sort((a, b) => b.efficiency - a.efficiency);
    }, [routes, appointments, logs]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        const d = payload[0]?.payload;
        return (
            <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs">
                <p className="font-bold text-white mb-1">{label}</p>
                <p className="text-gray-400">Rep: {d?.rep}</p>
                <p className="text-gray-400">Houses: {d?.houses} • {d?.distance} mi</p>
                <p className="text-blue-400">Knocks: {d?.knocks}</p>
                <p className="text-yellow-400">Appointments: {d?.appointments}</p>
                <p className="text-green-400">Sold: {d?.sold}</p>
                <p className="text-purple-400">Efficiency: {d?.efficiency}%</p>
            </div>
        );
    };

    if (data.length === 0) return null;

    return (
        <div className="relative bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-3xl p-6 shadow-2xl overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-pink-500/10 blur-[100px] rounded-full pointer-events-none" />
            
            <div className="flex items-center justify-between mb-6 relative z-10">
                <h3 className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-pink-500/20 border border-pink-500/40">
                        <MapPin className="w-5 h-5 text-pink-400 drop-shadow-[0_0_10px_rgba(236,72,153,0.5)]" />
                    </div>
                    Route Efficiency
                </h3>
            </div>
            
            <div className="h-[280px] relative z-10 mt-4">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                        <XAxis dataKey="name" stroke="#888" fontSize={10} fontWeight={600} tickLine={false} angle={-25} textAnchor="end" height={60} dy={10} />
                        <YAxis stroke="#888" fontSize={11} fontWeight={600} tickLine={false} unit="%" domain={[0, 100]} dx={-5} />
                        <Tooltip content={<CustomTooltip />} cursor={{ fill: '#ffffff0a' }} />
                        <Bar dataKey="efficiency" name="Efficiency %" radius={[6, 6, 0, 0]} barSize={26}>
                            {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} style={{ filter: `drop-shadow(0 0 6px ${COLORS[i % COLORS.length]}40)` }} />)}
                        </Bar>
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}