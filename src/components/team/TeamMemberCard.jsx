import React from 'react';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { 
    Map, CheckCircle2, AlertCircle, TrendingUp, 
    Home, MessageSquare, DollarSign, ChevronRight 
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const BRAND = {
    gold: '#FFD700',
    voidBlack: '#0A0A0A',
    charcoal: '#1F1F1F',
    green: '#22c55e',
    blue: '#3b82f6'
};

export default function TeamMemberCard({ member, routes, metrics, allRoutes, onAssignRoute }) {
    const completedRoutes = routes.filter(r => r.status === 'COMPLETED').length;
    const activeRoutes = routes.filter(r => r.status === 'ACTIVE' || r.status === 'IN_PROGRESS');

    // Calculate conversion rate
    const conversionRate = metrics.doorsKnocked > 0 
        ? ((metrics.sales / metrics.doorsKnocked) * 100).toFixed(1) 
        : '0.0';

    return (
        <div className="bg-[#111] border border-gray-800 rounded-2xl overflow-hidden hover:border-yellow-500/30 transition-all duration-300 shadow-xl group">
            {/* Header / Profile */}
            <div className="p-5 border-b border-gray-800 bg-gradient-to-r from-[#151515] to-[#0A0A0A]">
                <div className="flex justify-between items-start">
                    <div className="flex gap-4">
                        <div className="relative">
                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-yellow-400 to-yellow-600 flex items-center justify-center text-black font-bold text-xl shadow-lg shadow-yellow-500/20">
                                {member.name?.[0]?.toUpperCase() || '?'}
                            </div>
                            <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-green-500 border-2 border-[#151515] rounded-full" />
                        </div>
                        
                        <div>
                            <h3 className="font-bold text-xl text-white tracking-tight">{member.name}</h3>
                            <p className="text-sm text-gray-500 font-medium mb-1">{member.email}</p>
                            <div className="flex gap-2">
                                <Badge variant="outline" className="bg-white/5 border-white/10 text-xs font-medium text-gray-300">
                                    {member.role?.toUpperCase()}
                                </Badge>
                                <Badge className="bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 text-xs border border-yellow-500/20">
                                    {conversionRate}% CONV
                                </Badge>
                            </div>
                        </div>
                    </div>

                    <div className="text-right hidden sm:block">
                        <p className="text-3xl font-bold text-white tracking-tighter">{metrics.sales}</p>
                        <p className="text-[10px] text-gray-500 font-bold tracking-widest uppercase">TOTAL SALES</p>
                    </div>
                </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-3 divide-x divide-gray-800 border-b border-gray-800 bg-[#0F0F0F]">
                <div className="p-4 text-center group/metric hover:bg-white/5 transition-colors">
                    <div className="flex items-center justify-center gap-2 text-gray-500 mb-1 group-hover/metric:text-yellow-500 transition-colors">
                        <Home className="w-4 h-4" />
                    </div>
                    <p className="text-2xl font-bold text-white">{metrics.doorsKnocked}</p>
                    <p className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">Knocked</p>
                </div>
                <div className="p-4 text-center group/metric hover:bg-white/5 transition-colors">
                    <div className="flex items-center justify-center gap-2 text-gray-500 mb-1 group-hover/metric:text-blue-500 transition-colors">
                        <MessageSquare className="w-4 h-4" />
                    </div>
                    <p className="text-2xl font-bold text-white">{metrics.talkedTo}</p>
                    <p className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">Talked To</p>
                </div>
                <div className="p-4 text-center group/metric hover:bg-white/5 transition-colors sm:hidden">
                    <div className="flex items-center justify-center gap-2 text-gray-500 mb-1 group-hover/metric:text-green-500 transition-colors">
                        <DollarSign className="w-4 h-4" />
                    </div>
                    <p className="text-2xl font-bold text-white">{metrics.sales}</p>
                    <p className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">Sales</p>
                </div>
                 <div className="p-4 text-center group/metric hover:bg-white/5 transition-colors hidden sm:block">
                    <div className="flex items-center justify-center gap-2 text-gray-500 mb-1 group-hover/metric:text-purple-500 transition-colors">
                        <Map className="w-4 h-4" />
                    </div>
                    <p className="text-2xl font-bold text-white">{routes.length}</p>
                    <p className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">Routes</p>
                </div>
            </div>

            {/* Routes Section */}
            <div className="p-4 bg-[#0A0A0A]">
                <div className="flex items-center justify-between mb-4">
                    <h4 className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                        <Map className="w-3 h-3" /> Active Territory
                    </h4>
                    <span className="text-[10px] bg-gray-800 text-gray-300 px-2 py-1 rounded-full">
                        {activeRoutes.length} Active
                    </span>
                </div>

                {routes.length === 0 ? (
                    <div className="text-center py-6 border border-dashed border-gray-800 rounded-xl bg-gray-900/20">
                        <p className="text-sm text-gray-500 italic mb-3">No territory assigned</p>
                        <Select onValueChange={(routeId) => onAssignRoute(routeId, member.id)}>
                            <SelectTrigger className="w-40 mx-auto h-8 text-xs bg-yellow-500/10 border-yellow-500/50 text-yellow-500 hover:bg-yellow-500 hover:text-black transition-all">
                                <SelectValue placeholder="Assign Route" />
                            </SelectTrigger>
                            <SelectContent className="bg-[#1F1F1F] border-gray-800 text-white">
                                {allRoutes.filter(r => !r.assigned_to).map(r => (
                                    <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {routes.slice(0, 3).map(route => (
                            <div key={route.id} className="flex items-center justify-between bg-[#151515] p-3 rounded-lg border border-gray-800 hover:border-gray-700 transition-colors">
                                <div className="flex items-center gap-3">
                                    <div className={`w-2 h-2 rounded-full ${route.status === 'COMPLETED' ? 'bg-green-500' : 'bg-blue-500 animate-pulse'}`} />
                                    <div>
                                        <p className="text-xs font-bold text-white">{route.name}</p>
                                        <p className="text-[10px] text-gray-500">
                                            {route.metrics?.house_count || 0} homes • {route.metrics?.score || 0} pts
                                        </p>
                                    </div>
                                </div>
                                <Badge variant="secondary" className="text-[10px] h-5 bg-gray-800 text-gray-300">
                                    {route.status}
                                </Badge>
                            </div>
                        ))}
                        {routes.length > 3 && (
                            <button className="w-full py-2 text-[10px] text-gray-500 hover:text-white transition-colors flex items-center justify-center gap-1">
                                View {routes.length - 3} more <ChevronRight className="w-3 h-3" />
                            </button>
                        )}
                        <div className="pt-2">
                             <Select onValueChange={(routeId) => onAssignRoute(routeId, member.id)}>
                                <SelectTrigger className="w-full h-8 text-xs bg-[#151515] border-gray-800 text-gray-400 hover:text-white hover:border-gray-600 transition-all">
                                    <SelectValue placeholder="+ Assign Another Route" />
                                </SelectTrigger>
                                <SelectContent className="bg-[#1F1F1F] border-gray-800 text-white">
                                    {allRoutes.filter(r => !r.assigned_to).map(r => (
                                        <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}