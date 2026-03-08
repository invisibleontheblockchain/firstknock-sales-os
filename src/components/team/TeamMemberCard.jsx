import React from 'react';
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { base44 } from '@/api/base44Client';
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { TrendingUp, ChevronRight, Zap, Trash2
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from 'react-router-dom';
import { createPageUrl } from '../../utils';
import { toast } from "sonner";

const BRAND = {
    gold: '#FFD700',
    voidBlack: '#0A0A0A',
    charcoal: '#1F1F1F',
    green: '#22c55e',
    blue: '#3b82f6'
};

export default function TeamMemberCard({ member, routes, metrics, allRoutes, onAssignRoute, onUnassignAll, onDelete, action }) {
    const queryClient = useQueryClient();
    const completedRoutes = routes.filter(r => r.status === 'COMPLETED');
    const activeRoutes = routes.filter(r => r.status === 'ACTIVE' || r.status === 'IN_PROGRESS');

    const toggleAutoAssignMutation = useMutation({
        mutationFn: (checked) => base44.entities.TeamMember.update(member.id, { auto_assign_enabled: checked }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['teamMembers'] });
            toast.success("Auto-assign updated");
        }
    });

    // Calculate conversion rate
    const conversionRate = metrics.doorsKnocked > 0 
        ? ((metrics.sales / metrics.doorsKnocked) * 100).toFixed(1) 
        : '0.0';

    return (
        <div className="bg-[#111] border border-gray-800 rounded-xl overflow-hidden hover:border-yellow-500/30 transition-all duration-300 shadow-lg group">
            {/* Header / Profile - Compact */}
            <div className="p-3 md:p-4 border-b border-gray-800 bg-gradient-to-r from-[#151515] to-[#0A0A0A] relative">
                <div className="flex justify-between items-center">
                    <div className="flex gap-3 items-center min-w-0">
                        <div className="relative flex-shrink-0">
                            <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-gradient-to-br from-yellow-400 to-yellow-600 flex items-center justify-center text-black font-bold text-base md:text-lg">
                                {member.name?.[0]?.toUpperCase() || '?'}
                            </div>
                            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 border-2 border-[#151515] rounded-full" />
                        </div>
                        
                        <div className="min-w-0">
                            <h3 className="font-bold text-base md:text-lg text-white tracking-tight truncate">{member.name}</h3>
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className="bg-white/5 border-white/10 text-[10px] font-medium text-gray-400 h-5">
                                    {member.role?.toUpperCase()}
                                </Badge>
                                <div className="flex items-center gap-1 bg-yellow-500/10 border border-yellow-500/20 rounded-full px-2 h-5">
                                    <TrendingUp className="w-3 h-3 text-yellow-500" />
                                    <span className="text-[10px] font-bold text-yellow-500">{conversionRate}% Close Rate</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-3 flex-shrink-0">
                        <div className="text-right">
                            <p className="text-2xl md:text-3xl font-bold text-white tracking-tighter">{metrics.sales}</p>
                            <p className="text-[9px] text-gray-500 font-bold uppercase">Sales</p>
                        </div>
                        {!member.isManagerSelf && onDelete && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onDelete(member); }}
                                className="p-2 rounded-lg text-gray-600 hover:text-red-500 hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100"
                                title="Remove team member"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Metrics Grid - Compact */}
            <div className="grid grid-cols-3 divide-x divide-gray-800 border-b border-gray-800 bg-[#0F0F0F]">
                <div className="p-2 md:p-3 text-center">
                    <p className="text-lg md:text-xl font-bold text-white">{metrics.doorsKnocked}</p>
                    <p className="text-[9px] font-bold text-gray-600 uppercase">Knocked</p>
                </div>
                <div className="p-2 md:p-3 text-center">
                    <p className="text-lg md:text-xl font-bold text-white">{metrics.talkedTo}</p>
                    <p className="text-[9px] font-bold text-gray-600 uppercase">Talked</p>
                </div>
                <div className="p-2 md:p-3 text-center">
                    <p className="text-lg md:text-xl font-bold text-blue-400">{routes.length}</p>
                    <p className="text-[9px] font-bold text-gray-600 uppercase">Routes</p>
                </div>
            </div>

            {/* Routes Section - Compact */}
            <div className="p-3 bg-[#0A0A0A]">
                {/* Controls Row */}
                <div className="flex items-center justify-between mb-3 px-1" onClick={(e) => e.stopPropagation()}>
                    {!member.isManagerSelf ? (
                        <div className="flex items-center space-x-2" title="Automatically assign a new route when the current one is completed">
                            <Switch 
                                id={`auto-assign-${member.id}`} 
                                checked={member.auto_assign_enabled || false}
                                onCheckedChange={(c) => toggleAutoAssignMutation.mutate(c)}
                                className="scale-75 data-[state=checked]:bg-yellow-500"
                            />
                            <Label htmlFor={`auto-assign-${member.id}`} className="text-[10px] text-gray-400 flex items-center gap-1 cursor-pointer select-none">
                                <Zap className="w-3 h-3 text-yellow-500" /> Auto-Assign
                            </Label>
                        </div>
                    ) : (
                        <div /> /* Spacer if no toggle */
                    )}
                    
                    {/* Injected Action (Assign Zips) */}
                    <div>{action}</div>
                </div>

                {activeRoutes.length > 0 && (
                    <div className="flex justify-between items-center mb-2 px-1">
                        <span className="text-[10px] font-bold text-gray-500 uppercase">Active Assignments</span>
                        <button 
                            onClick={(e) => { e.stopPropagation(); onUnassignAll(); }}
                            className="text-[10px] text-red-500 hover:text-red-400 font-bold"
                        >
                            Unassign All
                        </button>
                    </div>
                )}

                {activeRoutes.length === 0 ? (
                    <div className="text-center py-4 border border-dashed border-gray-800 rounded-lg bg-gray-900/20">
                        <p className="text-xs text-gray-500 mb-2">No active routes</p>
                        <div onClick={e => e.stopPropagation()}>
                            <Select onValueChange={(routeId) => onAssignRoute(routeId, member.id)}>
                                <SelectTrigger className="w-32 mx-auto h-7 text-[10px] bg-yellow-500/10 border-yellow-500/50 text-yellow-500">
                                    <SelectValue placeholder="Assign" />
                                </SelectTrigger>
                                <SelectContent className="bg-[#1F1F1F] border-gray-800 text-white">
                                    {allRoutes.filter(r => !r.assigned_to).map(r => (
                                        <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        {activeRoutes.slice(0, 3).map(route => (
                            <Link 
                                key={route.id} 
                                to={createPageUrl('ZipCodeExplorer') + `?routeId=${route.id}`}
                                className="flex items-center justify-between bg-[#151515] p-2 rounded-lg border border-gray-800 hover:border-yellow-500/50 transition-colors"
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    <div className="w-2 h-2 rounded-full flex-shrink-0 bg-blue-500 animate-pulse" />
                                    <div className="min-w-0">
                                        <p className="text-[11px] font-bold text-white truncate">{route.name}</p>
                                        <p className="text-[9px] text-gray-500">{route.metrics?.house_count || 0} homes</p>
                                    </div>
                                </div>
                                <ChevronRight className="w-4 h-4 text-gray-600 flex-shrink-0" />
                            </Link>
                        ))}
                        {activeRoutes.length > 3 && (
                            <p className="text-[10px] text-center text-gray-500 py-1">
                                +{activeRoutes.length - 3} more routes
                            </p>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}