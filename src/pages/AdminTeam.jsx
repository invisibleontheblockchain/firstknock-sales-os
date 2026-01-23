import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Users, Plus, UserPlus, Map, CheckCircle2, AlertCircle, X, Key } from 'lucide-react';
import { toast } from "sonner";

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

export default function AdminTeam() {
    const queryClient = useQueryClient();
    const [isAddRepOpen, setIsAddRepOpen] = useState(false);
    const [isRouteManagerOpen, setIsRouteManagerOpen] = useState(false);
    const [isCodeManagerOpen, setIsCodeManagerOpen] = useState(false);
    const [routeSearch, setRouteSearch] = useState('');
    const [newRep, setNewRep] = useState({ name: '', email: '', phone: '', role: 'rep' });
    const [newCode, setNewCode] = useState({ code: '', role: 'manager', label: '' });

    // --- Queries ---
    const { data: teamMembers = [], isLoading: teamLoading } = useQuery({
        queryKey: ['teamMembers'],
        queryFn: async () => {
            const res = await base44.entities.TeamMember.list('-created_date', 100);
            return Array.isArray(res) ? res : (res?.items || []);
        }
    });

    const { data: routes = [], isLoading: routesLoading } = useQuery({
        queryKey: ['allRoutes'],
        queryFn: async () => {
            const res = await base44.entities.SavedRoute.list('-created_date', 200);
            return Array.isArray(res) ? res : (res?.items || []);
        }
    });

    const { data: inviteCodes = [] } = useQuery({
        queryKey: ['inviteCodes'],
        queryFn: async () => {
            const res = await base44.entities.InviteCode.list('-created_date', 50);
            return Array.isArray(res) ? res : (res?.items || []);
        }
    });

    // --- Mutations ---
    const createRepMutation = useMutation({
        mutationFn: (data) => base44.entities.TeamMember.create({ ...data, status: 'active', color: '#FFD700' }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['teamMembers'] });
            setIsAddRepOpen(false);
            setNewRep({ name: '', email: '', phone: '', role: 'rep' });
            toast.success("Team member added successfully");
        }
    });

    const assignRouteMutation = useMutation({
        mutationFn: ({ routeId, memberId, memberName }) => 
            base44.entities.SavedRoute.update(routeId, {
                assigned_to: memberId,
                assigned_to_name: memberName,
                status: 'ACTIVE' // Activate route on assignment
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['allRoutes'] });
            toast.success("Route assigned");
        }
    });

    const createCodeMutation = useMutation({
        mutationFn: (data) => base44.entities.InviteCode.create(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['inviteCodes'] });
            setNewCode({ code: '', role: 'manager', label: '' });
            toast.success("Invite code created");
        }
    });

    const deleteCodeMutation = useMutation({
        mutationFn: (id) => base44.entities.InviteCode.delete(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['inviteCodes'] })
    });

    // --- Derived State ---
    const routesByRep = useMemo(() => {
        const grouped = { unassigned: [] };
        teamMembers.forEach(m => grouped[m.id] = []);
        
        routes.forEach(r => {
            if (r.assigned_to && grouped[r.assigned_to]) {
                grouped[r.assigned_to].push(r);
            } else {
                grouped.unassigned.push(r);
            }
        });
        return grouped;
    }, [routes, teamMembers]);

    // --- Handlers ---
    const handleAddRep = () => {
        if (!newRep.name || !newRep.email) {
            toast.error("Name and Email are required");
            return;
        }
        createRepMutation.mutate(newRep);
    };

    const handleAssign = (routeId, memberId) => {
        const member = teamMembers.find(m => m.id === memberId);
        assignRouteMutation.mutate({ 
            routeId, 
            memberId, 
            memberName: member?.name 
        });
    };

    if (teamLoading || routesLoading) {
        return <div className="p-10 text-center text-white">Loading Team Data...</div>;
    }

    return (
        <div className="h-full overflow-auto bg-black text-white p-6 pb-20">
            <div className="max-w-6xl mx-auto space-y-8">
                
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold flex items-center gap-3">
                            <Users className="w-8 h-8 text-yellow-500" />
                            Team Management
                        </h1>
                        <p className="text-gray-400 mt-1">Manage your reps and assign territories.</p>
                    </div>
                    
                    <div className="flex gap-3">
                        <Dialog open={isCodeManagerOpen} onOpenChange={setIsCodeManagerOpen}>
                            <DialogTrigger asChild>
                                <Button variant="outline" className="border-gray-700 text-white hover:bg-gray-800">
                                    <Key className="w-4 h-4 mr-2" />
                                    Codes
                                </Button>
                            </DialogTrigger>
                            <DialogContent className="bg-[#1F1F1F] border-gray-800 text-white">
                                <DialogHeader>
                                    <DialogTitle>Access Codes</DialogTitle>
                                </DialogHeader>
                                <div className="space-y-6">
                                    <div className="space-y-3 p-4 bg-black/40 rounded-lg border border-gray-800">
                                        <h4 className="text-xs font-bold text-gray-500 uppercase">Create New Code</h4>
                                        <div className="grid grid-cols-2 gap-2">
                                            <Input 
                                                placeholder="Code (e.g. 1234)" 
                                                value={newCode.code}
                                                onChange={(e) => setNewCode({...newCode, code: e.target.value})}
                                                className="bg-black border-gray-700"
                                            />
                                            <Input 
                                                placeholder="Label (e.g. Managers)" 
                                                value={newCode.label}
                                                onChange={(e) => setNewCode({...newCode, label: e.target.value})}
                                                className="bg-black border-gray-700"
                                            />
                                        </div>
                                        <div className="flex gap-2">
                                            <Select 
                                                value={newCode.role} 
                                                onValueChange={(v) => setNewCode({...newCode, role: v})}
                                            >
                                                <SelectTrigger className="bg-black border-gray-700 flex-1">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent className="bg-[#1F1F1F] border-gray-800 text-white">
                                                    <SelectItem value="rep">Sales Rep</SelectItem>
                                                    <SelectItem value="manager">Manager</SelectItem>
                                                </SelectContent>
                                            </Select>
                                            <Button 
                                                onClick={() => createCodeMutation.mutate(newCode)}
                                                disabled={!newCode.code}
                                                className="bg-green-600 hover:bg-green-700 font-bold"
                                            >
                                                Create
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="space-y-2">
                                        <h4 className="text-xs font-bold text-gray-500 uppercase">Active Codes</h4>
                                        {inviteCodes.length === 0 ? (
                                            <p className="text-sm text-gray-500 italic">No active codes</p>
                                        ) : (
                                            inviteCodes.map(code => (
                                                <div key={code.id} className="flex items-center justify-between p-3 bg-black/20 rounded border border-gray-800">
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-mono font-bold text-yellow-500 text-lg">{code.code}</span>
                                                            <Badge variant="outline" className="text-[10px] border-gray-700">{code.role}</Badge>
                                                        </div>
                                                        <p className="text-xs text-gray-400">{code.label}</p>
                                                    </div>
                                                    <Button 
                                                        variant="ghost" 
                                                        size="sm"
                                                        onClick={() => deleteCodeMutation.mutate(code.id)}
                                                        className="text-red-500 hover:bg-red-900/20 h-8 w-8 p-0"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </DialogContent>
                        </Dialog>

                        <Dialog open={isRouteManagerOpen} onOpenChange={setIsRouteManagerOpen}>
                            <DialogTrigger asChild>
                                <Button variant="outline" className="border-gray-700 text-white hover:bg-gray-800">
                                    <Map className="w-4 h-4 mr-2" />
                                    Route Registry
                                </Button>
                            </DialogTrigger>
                            <DialogContent className="bg-[#1F1F1F] border-gray-800 text-white max-w-4xl max-h-[80vh] flex flex-col">
                                <DialogHeader>
                                    <DialogTitle>Route Registry</DialogTitle>
                                </DialogHeader>
                                <div className="p-4 space-y-4 flex-1 overflow-hidden flex flex-col">
                                    <Input 
                                        placeholder="Search routes..." 
                                        value={routeSearch}
                                        onChange={(e) => setRouteSearch(e.target.value)}
                                        className="bg-black border-gray-700"
                                    />
                                    <div className="flex-1 overflow-y-auto space-y-2 pr-2">
                                        {routes
                                            .filter(r => r.name.toLowerCase().includes(routeSearch.toLowerCase()))
                                            .map(route => (
                                            <div key={route.id} className="flex items-center justify-between p-3 bg-black/40 rounded border border-gray-800">
                                                <div>
                                                    <p className="font-bold text-white">{route.name}</p>
                                                    <p className="text-xs text-gray-400">
                                                        {route.metrics?.house_count || 0} homes • {route.status}
                                                    </p>
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    {route.assigned_to_name && (
                                                        <Badge variant="outline" className="text-xs border-gray-600">
                                                            Assigned: {route.assigned_to_name}
                                                        </Badge>
                                                    )}
                                                    <Select onValueChange={(memberId) => handleAssign(route.id, memberId)}>
                                                        <SelectTrigger className="w-[180px] h-8 text-xs bg-[#1F1F1F] border-gray-700">
                                                            <SelectValue placeholder="Reassign..." />
                                                        </SelectTrigger>
                                                        <SelectContent className="bg-[#1F1F1F] border-gray-800 text-white">
                                                            {teamMembers.map(m => (
                                                                <SelectItem key={m.id} value={m.id}>
                                                                    {m.name}
                                                                </SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </DialogContent>
                        </Dialog>

                        <Dialog open={isAddRepOpen} onOpenChange={setIsAddRepOpen}>
                            <DialogTrigger asChild>
                                <Button className="bg-yellow-500 text-black font-bold hover:bg-yellow-400">
                                    <UserPlus className="w-4 h-4 mr-2" />
                                    Add New Rep
                                </Button>
                            </DialogTrigger>
                        <DialogContent className="bg-[#1F1F1F] border-gray-800 text-white">
                            <DialogHeader>
                                <DialogTitle>Add Team Member</DialogTitle>
                            </DialogHeader>
                            <div className="space-y-4 py-4">
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400">FULL NAME</label>
                                    <Input 
                                        value={newRep.name}
                                        onChange={(e) => setNewRep({...newRep, name: e.target.value})}
                                        className="bg-black border-gray-700"
                                        placeholder="John Doe"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400">EMAIL</label>
                                    <Input 
                                        value={newRep.email}
                                        onChange={(e) => setNewRep({...newRep, email: e.target.value})}
                                        className="bg-black border-gray-700"
                                        placeholder="john@example.com"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400">PHONE</label>
                                    <Input 
                                        value={newRep.phone}
                                        onChange={(e) => setNewRep({...newRep, phone: e.target.value})}
                                        className="bg-black border-gray-700"
                                        placeholder="(555) 123-4567"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400">ROLE</label>
                                    <Select 
                                        value={newRep.role} 
                                        onValueChange={(v) => setNewRep({...newRep, role: v})}
                                    >
                                        <SelectTrigger className="bg-black border-gray-700">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent className="bg-[#1F1F1F] border-gray-800 text-white">
                                            <SelectItem value="rep">Sales Rep</SelectItem>
                                            <SelectItem value="manager">Manager</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <Button 
                                    onClick={handleAddRep}
                                    className="w-full bg-yellow-500 text-black font-bold mt-4"
                                >
                                    Create Member
                                </Button>
                            </div>
                        </DialogContent>
                    </Dialog>
                    </div>
                </div>

                {/* Unassigned Routes Section */}
                {routesByRep.unassigned.length > 0 && (
                    <div className="bg-[#1a0f0f] border border-red-900/30 rounded-xl p-6">
                        <div className="flex items-center gap-2 mb-4 text-red-400">
                            <AlertCircle className="w-5 h-5" />
                            <h3 className="font-bold text-lg">Unassigned Routes ({routesByRep.unassigned.length})</h3>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {routesByRep.unassigned.map(route => (
                                <div key={route.id} className="bg-black/40 border border-gray-800 rounded-lg p-4 flex flex-col gap-3">
                                    <div>
                                        <h4 className="font-bold text-white">{route.name}</h4>
                                        <p className="text-xs text-gray-400 mt-1">
                                            {route.metrics?.house_count || 0} homes • {route.metrics?.distance || 0} mi
                                        </p>
                                    </div>
                                    <div className="mt-auto">
                                        <Select onValueChange={(memberId) => handleAssign(route.id, memberId)}>
                                            <SelectTrigger className="w-full h-8 text-xs bg-[#1F1F1F] border-gray-700">
                                                <SelectValue placeholder="Assign to Rep..." />
                                            </SelectTrigger>
                                            <SelectContent className="bg-[#1F1F1F] border-gray-800 text-white">
                                                {teamMembers.map(m => (
                                                    <SelectItem key={m.id} value={m.id}>
                                                        {m.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Team Roster & Assignments */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {teamMembers.map(member => {
                        const memberRoutes = routesByRep[member.id] || [];
                        const completedRoutes = memberRoutes.filter(r => r.status === 'COMPLETED').length;
                        
                        return (
                            <div key={member.id} className="bg-[#1F1F1F] border border-gray-800 rounded-xl overflow-hidden">
                                <div className="p-5 border-b border-gray-800 flex justify-between items-start">
                                    <div className="flex gap-4">
                                        <div className="w-12 h-12 rounded-full bg-yellow-500 flex items-center justify-center text-black font-bold text-xl">
                                            {member.name?.[0] || '?'}
                                        </div>
                                        <div>
                                            <h3 className="font-bold text-lg">{member.name}</h3>
                                            <p className="text-sm text-gray-400">{member.email}</p>
                                            <div className="flex gap-2 mt-2">
                                                <Badge variant="outline" className="border-gray-600 text-xs">
                                                    {member.role?.toUpperCase()}
                                                </Badge>
                                                <Badge className="bg-green-900 text-green-300 hover:bg-green-900 text-xs">
                                                    ACTIVE
                                                </Badge>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className="text-2xl font-bold text-white">{memberRoutes.length}</p>
                                        <p className="text-[10px] text-gray-500 font-bold tracking-wider">ROUTES</p>
                                    </div>
                                </div>

                                {/* Assigned Routes List */}
                                <div className="p-4 bg-black/20 min-h-[100px]">
                                    <h4 className="text-xs font-bold text-gray-500 mb-3 uppercase tracking-wider">Assigned Territories</h4>
                                    {memberRoutes.length === 0 ? (
                                        <p className="text-sm text-gray-600 italic">No active routes assigned</p>
                                    ) : (
                                        <div className="space-y-2">
                                            {memberRoutes.map(route => (
                                                <div key={route.id} className="flex items-center justify-between bg-[#151515] p-2 rounded border border-gray-800">
                                                    <div className="flex items-center gap-3">
                                                        <Map className="w-4 h-4 text-gray-500" />
                                                        <div>
                                                            <p className="text-sm font-medium">{route.name}</p>
                                                            <p className="text-[10px] text-gray-500">
                                                                {route.metrics?.house_count} homes
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <Badge className={
                                                        route.status === 'COMPLETED' ? 'bg-green-500 text-black' : 
                                                        route.status === 'IN_PROGRESS' ? 'bg-blue-500 text-white' : 
                                                        'bg-gray-700 text-gray-300'
                                                    }>
                                                        {route.status}
                                                    </Badge>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>

                {teamMembers.length === 0 && (
                    <div className="text-center py-20 border-2 border-dashed border-gray-800 rounded-xl">
                        <Users className="w-16 h-16 text-gray-700 mx-auto mb-4" />
                        <h3 className="text-xl font-bold text-gray-400">No Team Members Yet</h3>
                        <p className="text-gray-600 mb-6">Add your first sales rep to start assigning routes.</p>
                        <Button 
                            onClick={() => setIsAddRepOpen(true)}
                            className="bg-yellow-500 text-black font-bold"
                        >
                            Add First Rep
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}