import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
    Users, Plus, Trash2, Route, ChevronRight, User, 
    CheckCircle, Clock, AlertCircle, GripVertical, X 
} from 'lucide-react';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const REP_COLORS = ['#FFD700', '#ef4444', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#f97316', '#06b6d4'];

export default function AdminTeam() {
    const queryClient = useQueryClient();
    const [showAddMember, setShowAddMember] = useState(false);
    const [newMember, setNewMember] = useState({ name: '', email: '', phone: '', role: 'rep' });
    const [selectedRep, setSelectedRep] = useState(null);
    const [assigningRoute, setAssigningRoute] = useState(null);

    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    const { data: teamMembers = [], isLoading: teamLoading } = useQuery({
        queryKey: ['teamMembers'],
        queryFn: () => base44.entities.TeamMember.list('-created_date', 100)
    });

    const { data: savedRoutes = [], isLoading: routesLoading } = useQuery({
        queryKey: ['savedRoutes'],
        queryFn: () => base44.entities.SavedRoute.list('-created_date', 200)
    });

    const createMemberMutation = useMutation({
        mutationFn: (data) => base44.entities.TeamMember.create(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['teamMembers'] });
            setShowAddMember(false);
            setNewMember({ name: '', email: '', phone: '', role: 'rep' });
        }
    });

    const deleteMemberMutation = useMutation({
        mutationFn: (id) => base44.entities.TeamMember.delete(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teamMembers'] })
    });

    const updateRouteMutation = useMutation({
        mutationFn: ({ id, data }) => base44.entities.SavedRoute.update(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
            setAssigningRoute(null);
        }
    });

    const handleAddMember = () => {
        const color = REP_COLORS[teamMembers.length % REP_COLORS.length];
        createMemberMutation.mutate({ ...newMember, color, status: 'active' });
    };

    const handleAssignRoute = (routeId, memberId) => {
        const member = teamMembers.find(m => m.id === memberId);
        updateRouteMutation.mutate({
            id: routeId,
            data: {
                assigned_to: memberId || null,
                assigned_to_name: member?.name || null,
                status: memberId ? 'ACTIVE' : 'PENDING'
            }
        });
    };

    const handleSetPriority = (routeId, priority) => {
        updateRouteMutation.mutate({ id: routeId, data: { priority } });
    };

    // Group routes by assignee
    const routesByRep = useMemo(() => {
        const grouped = { unassigned: [] };
        teamMembers.forEach(m => { grouped[m.id] = []; });
        
        savedRoutes.forEach(route => {
            if (route.assigned_to && grouped[route.assigned_to]) {
                grouped[route.assigned_to].push(route);
            } else {
                grouped.unassigned.push(route);
            }
        });

        // Sort each group by priority
        Object.keys(grouped).forEach(key => {
            grouped[key].sort((a, b) => (a.priority || 999) - (b.priority || 999));
        });

        return grouped;
    }, [savedRoutes, teamMembers]);

    // Stats per rep
    const repStats = useMemo(() => {
        const stats = {};
        teamMembers.forEach(m => {
            const routes = routesByRep[m.id] || [];
            stats[m.id] = {
                totalRoutes: routes.length,
                totalHouses: routes.reduce((sum, r) => sum + (r.metrics?.house_count || 0), 0),
                completed: routes.filter(r => r.status === 'COMPLETED').length,
                inProgress: routes.filter(r => r.status === 'IN_PROGRESS').length
            };
        });
        return stats;
    }, [teamMembers, routesByRep]);

    return (
        <div className="h-full overflow-auto p-4" style={{ background: BRAND.voidBlack }}>
            <div className="max-w-6xl mx-auto space-y-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: BRAND.gold }}>
                            <Users className="w-6 h-6" />
                            Team Management
                        </h1>
                        <p className="text-sm mt-1" style={{ color: '#888' }}>
                            {teamMembers.length} team members • {savedRoutes.length} routes
                        </p>
                    </div>
                    <Button
                        onClick={() => setShowAddMember(true)}
                        style={{ background: BRAND.gold, color: BRAND.voidBlack }}
                        className="font-bold"
                    >
                        <Plus className="w-4 h-4 mr-2" />
                        ADD REP
                    </Button>
                </div>

                {/* Add Member Form */}
                {showAddMember && (
                    <div className="p-4 rounded-xl border" style={{ background: BRAND.charcoal, borderColor: '#333' }}>
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-bold" style={{ color: BRAND.offWhite }}>Add Team Member</h3>
                            <button onClick={() => setShowAddMember(false)}>
                                <X className="w-4 h-4" style={{ color: '#888' }} />
                            </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                            <Input
                                placeholder="Name"
                                value={newMember.name}
                                onChange={(e) => setNewMember({ ...newMember, name: e.target.value })}
                                className="bg-black border-gray-700 text-white"
                            />
                            <Input
                                placeholder="Email"
                                value={newMember.email}
                                onChange={(e) => setNewMember({ ...newMember, email: e.target.value })}
                                className="bg-black border-gray-700 text-white"
                            />
                            <Input
                                placeholder="Phone"
                                value={newMember.phone}
                                onChange={(e) => setNewMember({ ...newMember, phone: e.target.value })}
                                className="bg-black border-gray-700 text-white"
                            />
                            <Select value={newMember.role} onValueChange={(v) => setNewMember({ ...newMember, role: v })}>
                                <SelectTrigger className="bg-black border-gray-700 text-white">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="rep">Sales Rep</SelectItem>
                                    <SelectItem value="manager">Manager</SelectItem>
                                    <SelectItem value="admin">Admin</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <Button onClick={handleAddMember} className="mt-3" style={{ background: BRAND.gold, color: BRAND.voidBlack }}>
                            Save Member
                        </Button>
                    </div>
                )}

                {/* Unassigned Routes */}
                {routesByRep.unassigned.length > 0 && (
                    <div className="p-4 rounded-xl border" style={{ background: '#1a0a0a', borderColor: '#ef4444' }}>
                        <div className="flex items-center gap-2 mb-3">
                            <AlertCircle className="w-4 h-4 text-red-500" />
                            <h3 className="font-bold text-red-400">Unassigned Routes ({routesByRep.unassigned.length})</h3>
                        </div>
                        <div className="space-y-2">
                            {routesByRep.unassigned.map(route => (
                                <div 
                                    key={route.id}
                                    className="p-3 rounded-lg flex items-center justify-between"
                                    style={{ background: BRAND.charcoal }}
                                >
                                    <div>
                                        <p className="font-medium" style={{ color: BRAND.offWhite }}>{route.name}</p>
                                        <p className="text-xs" style={{ color: '#888' }}>
                                            {route.metrics?.house_count || 0} houses • Score: {route.metrics?.score || 0}
                                        </p>
                                    </div>
                                    <Select onValueChange={(v) => handleAssignRoute(route.id, v)}>
                                        <SelectTrigger className="w-40 bg-black border-gray-700 text-white">
                                            <SelectValue placeholder="Assign to..." />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {teamMembers.filter(m => m.status === 'active').map(m => (
                                                <SelectItem key={m.id} value={m.id}>
                                                    <div className="flex items-center gap-2">
                                                        <div className="w-2 h-2 rounded-full" style={{ background: m.color }} />
                                                        {m.name}
                                                    </div>
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Team Members Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {teamMembers.map(member => {
                        const stats = repStats[member.id] || {};
                        const routes = routesByRep[member.id] || [];

                        return (
                            <div 
                                key={member.id}
                                className="rounded-xl border overflow-hidden"
                                style={{ background: BRAND.charcoal, borderColor: member.color + '40' }}
                            >
                                {/* Rep Header */}
                                <div 
                                    className="p-4 flex items-center justify-between"
                                    style={{ borderBottom: `2px solid ${member.color}` }}
                                >
                                    <div className="flex items-center gap-3">
                                        <div 
                                            className="w-10 h-10 rounded-full flex items-center justify-center text-black font-bold"
                                            style={{ background: member.color }}
                                        >
                                            {member.name.charAt(0)}
                                        </div>
                                        <div>
                                            <p className="font-bold" style={{ color: BRAND.offWhite }}>{member.name}</p>
                                            <p className="text-xs" style={{ color: '#888' }}>{member.email}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Badge style={{ background: member.role === 'manager' ? '#3b82f6' : '#333' }}>
                                            {member.role.toUpperCase()}
                                        </Badge>
                                        <button onClick={() => deleteMemberMutation.mutate(member.id)}>
                                            <Trash2 className="w-4 h-4 text-red-500" />
                                        </button>
                                    </div>
                                </div>

                                {/* Stats */}
                                <div className="p-3 grid grid-cols-4 gap-2 text-center border-b" style={{ borderColor: '#333' }}>
                                    <div>
                                        <p className="text-lg font-bold" style={{ color: BRAND.gold }}>{stats.totalRoutes}</p>
                                        <p className="text-[10px]" style={{ color: '#888' }}>ROUTES</p>
                                    </div>
                                    <div>
                                        <p className="text-lg font-bold" style={{ color: BRAND.offWhite }}>{stats.totalHouses}</p>
                                        <p className="text-[10px]" style={{ color: '#888' }}>HOUSES</p>
                                    </div>
                                    <div>
                                        <p className="text-lg font-bold" style={{ color: '#3b82f6' }}>{stats.inProgress}</p>
                                        <p className="text-[10px]" style={{ color: '#888' }}>ACTIVE</p>
                                    </div>
                                    <div>
                                        <p className="text-lg font-bold" style={{ color: '#22c55e' }}>{stats.completed}</p>
                                        <p className="text-[10px]" style={{ color: '#888' }}>DONE</p>
                                    </div>
                                </div>

                                {/* Route Queue */}
                                <div className="p-3 max-h-60 overflow-y-auto">
                                    {routes.length === 0 ? (
                                        <p className="text-center py-4 text-sm" style={{ color: '#666' }}>No routes assigned</p>
                                    ) : (
                                        <div className="space-y-2">
                                            {routes.map((route, idx) => (
                                                <div 
                                                    key={route.id}
                                                    className="p-2 rounded-lg flex items-center gap-2"
                                                    style={{ background: '#1a1a1a' }}
                                                >
                                                    <div 
                                                        className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold"
                                                        style={{ 
                                                            background: idx === 0 ? BRAND.gold : '#333',
                                                            color: idx === 0 ? BRAND.voidBlack : '#888'
                                                        }}
                                                    >
                                                        {idx + 1}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-medium truncate" style={{ color: BRAND.offWhite }}>
                                                            {route.name}
                                                        </p>
                                                        <p className="text-[10px]" style={{ color: '#888' }}>
                                                            {route.metrics?.house_count} houses • {route.metrics?.distance}mi
                                                        </p>
                                                    </div>
                                                    <Badge 
                                                        className="text-[9px]"
                                                        style={{ 
                                                            background: route.status === 'COMPLETED' ? '#22c55e' : 
                                                                        route.status === 'IN_PROGRESS' ? '#3b82f6' : '#333'
                                                        }}
                                                    >
                                                        {route.status}
                                                    </Badge>
                                                    <button onClick={() => handleAssignRoute(route.id, null)}>
                                                        <X className="w-3 h-3 text-red-500" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}