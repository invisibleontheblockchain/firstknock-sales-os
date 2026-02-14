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
        <Card className="bg-[#151515] border-gray-800">
            <CardHeader className="pb-2">
                <CardTitle className="text-xs font-bold text-gray-400 flex items-center gap-2 uppercase">
                    <MapPin className="w-3.5 h-3.5" /> Route Efficiency (Activity / Houses)
                </CardTitle>
            </CardHeader>
            <CardContent className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                        <XAxis dataKey="name" stroke="#555" fontSize={9} tickLine={false} angle={-20} textAnchor="end" height={50} />
                        <YAxis stroke="#555" fontSize={10} tickLine={false} unit="%" domain={[0, 100]} />
                        <Tooltip content={<CustomTooltip />} />
                        <Bar dataKey="efficiency" name="Efficiency %" radius={[4, 4, 0, 0]} barSize={22}>
                            {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Bar>
                    </BarChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}