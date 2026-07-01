import React from 'react';
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { base44 } from '@/api/base44Client';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { TrendingUp, Trash2, Camera, Loader2, Shield } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

const BRAND = {
    gold: '#FFD700',
    voidBlack: '#0A0A0A',
    charcoal: '#1F1F1F',
    green: '#22c55e',
    blue: '#3b82f6'
};

export default function TeamMemberCard({ member, routes, metrics, allRoutes, onAssignRoute, onDelete, onPromote, action, canManage = true }) {
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

    const uploadPhotoMutation = useMutation({
        mutationFn: async (file) => {
            const uploaded = await base44.integrations.Core.UploadFile({ file });
            const imageUrl = uploaded?.file_url || uploaded?.url;
            await base44.entities.TeamMember.update(member.id, { profile_image_url: imageUrl });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['teamMembers'] });
            toast.success("Profile photo updated");
        }
    });

    const handlePhotoChange = (event) => {
        event.stopPropagation();
        const file = event.target.files?.[0];
        if (file && !member.isManagerSelf) uploadPhotoMutation.mutate(file);
        event.target.value = '';
    };

    // Calculate conversion rate
    const conversionRate = metrics.doorsKnocked > 0 
        ? ((metrics.sales / metrics.doorsKnocked) * 100).toFixed(1) 
        : '0.0';

    return (
        <div className="bg-[#111] border border-gray-800 rounded-xl overflow-hidden hover:border-yellow-500/30 transition-all duration-300 shadow-lg group">
            {/* Header / Profile - Compact */}
            <div className="p-2 md:p-3 border-b border-gray-800 bg-gradient-to-r from-[#151515] to-[#0A0A0A] relative">
                <div className="flex justify-between items-center">
                    <div className="flex gap-2 md:gap-3 items-center min-w-0">
                        <div className="relative flex-shrink-0">
                            <div className="w-8 h-8 md:w-10 md:h-10 rounded-lg bg-gradient-to-br from-yellow-400 to-yellow-600 flex items-center justify-center text-black font-bold text-sm md:text-base overflow-hidden">
                                {member.profile_image_url ? (
                                    <img src={member.profile_image_url} alt={member.name || 'Team member'} className="h-full w-full object-cover" />
                                ) : (
                                    member.name?.[0]?.toUpperCase() || '?'
                                )}
                            </div>
                            {!member.isManagerSelf && (
                                <label
                                    onClick={(e) => e.stopPropagation()}
                                    className="absolute -bottom-1 -right-1 w-5 h-5 md:w-6 md:h-6 rounded-full bg-[#2EEB57] border-2 border-[#151515] flex items-center justify-center cursor-pointer shadow-lg active:scale-95"
                                    title="Change profile photo"
                                >
                                    {uploadPhotoMutation.isPending ? <Loader2 className="w-3 h-3 text-black animate-spin" /> : <Camera className="w-3 h-3 text-black" />}
                                    <input type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} disabled={uploadPhotoMutation.isPending} />
                                </label>
                            )}
                            <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 md:w-3 md:h-3 bg-green-500 border-2 border-[#151515] rounded-full" />
                        </div>
                        
                        <div className="min-w-0">
                            <h3 className="font-bold text-sm md:text-base text-white tracking-tight truncate">{member.name}</h3>
                            <div className="flex items-center gap-1.5 md:gap-2">
                                <Badge variant="outline" className="bg-white/5 border-white/10 text-[8px] md:text-[10px] font-medium text-gray-400 h-4 md:h-5 px-1 md:px-2">
                                    {member.role?.toUpperCase()}
                                </Badge>
                                <div className="flex items-center gap-0.5 md:gap-1 bg-yellow-500/10 border border-yellow-500/20 rounded-full px-1.5 md:px-2 h-4 md:h-5">
                                    <TrendingUp className="w-2.5 h-2.5 md:w-3 md:h-3 text-yellow-500" />
                                    <span className="text-[8px] md:text-[10px] font-bold text-yellow-500">{conversionRate}%</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 md:gap-3 flex-shrink-0">
                        <div className="text-right">
                            <p className="text-lg md:text-2xl font-bold text-white tracking-tighter">{metrics.sales}</p>
                            <p className="text-[8px] md:text-[9px] text-gray-500 font-bold uppercase">Sales</p>
                        </div>
                        {canManage && !member.isManagerSelf && onDelete && (
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
                <div className="py-1.5 md:p-2 text-center">
                    <p className="text-sm md:text-lg font-bold text-white">{metrics.doorsKnocked}</p>
                    <p className="text-[7px] md:text-[9px] font-bold text-gray-600 uppercase">Knocked</p>
                </div>
                <div className="py-1.5 md:p-2 text-center">
                    <p className="text-sm md:text-lg font-bold text-white">{metrics.talkedTo}</p>
                    <p className="text-[7px] md:text-[9px] font-bold text-gray-600 uppercase">Talked</p>
                </div>
                <div className="py-1.5 md:p-2 text-center">
                    <p className="text-sm md:text-lg font-bold text-blue-400">{routes.length}</p>
                    <p className="text-[7px] md:text-[9px] font-bold text-gray-600 uppercase">Routes</p>
                </div>
            </div>

            {canManage && (
                <div className="p-2 bg-[#0A0A0A]" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between gap-2">
                        {!member.isManagerSelf ? (
                            <div className="flex items-center space-x-2" title="Automatically assign a new route when the current one is completed">
                                <Switch 
                                    id={`auto-assign-${member.id}`} 
                                    checked={member.auto_assign_enabled || false}
                                    onCheckedChange={(c) => toggleAutoAssignMutation.mutate(c)}
                                    className="scale-75 data-[state=checked]:bg-yellow-500"
                                />
                                <Label htmlFor={`auto-assign-${member.id}`} className="text-[10px] text-gray-400 cursor-pointer select-none">
                                    Auto-Assign
                                </Label>
                            </div>
                        ) : <div />}
                        <div>{action}</div>
                    </div>
                    {canManage && !member.isManagerSelf && member.role !== 'manager' && onPromote && (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); onPromote(member); }}
                            className="mt-2 h-7 w-full border-yellow-500/40 text-yellow-500 hover:bg-yellow-500/10 text-[10px] font-bold"
                        >
                            <Shield className="w-3 h-3 mr-1" /> Make Manager
                        </Button>
                    )}
                    {activeRoutes.length === 0 && (
                        <div className="mt-2">
                            <Select onValueChange={(routeId) => onAssignRoute(routeId, member.id)}>
                                <SelectTrigger className="w-full h-7 text-[10px] bg-yellow-500/10 border-yellow-500/50 text-yellow-500">
                                    <SelectValue placeholder="Assign route" />
                                </SelectTrigger>
                                <SelectContent className="bg-[#1F1F1F] border-gray-800 text-white">
                                    {allRoutes.filter(r => !r.assigned_to).map(r => (
                                        <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}