import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNavigate } from 'react-router-dom';
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Users, Plus, UserPlus, Map, CheckCircle2, AlertCircle, X, Key, Sparkles, TrendingUp, DollarSign, Home, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { toast } from "sonner";
import TeamMemberCard from "@/components/team/TeamMemberCard";

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

export default function AdminTeam() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [isAddRepOpen, setIsAddRepOpen] = useState(false);
    const [isRouteManagerOpen, setIsRouteManagerOpen] = useState(false);
    const [isCodeManagerOpen, setIsCodeManagerOpen] = useState(false);
    const [routeSearch, setRouteSearch] = useState('');
    const [zipSearch, setZipSearch] = useState('');
    const [newRep, setNewRep] = useState({ name: '', email: '', phone: '', role: 'rep' });
    const [newCode, setNewCode] = useState({ code: '', role: 'manager', label: '' });

    const handleZipSearch = () => {
        if (zipSearch && zipSearch.length >= 5) {
            navigate(createPageUrl('ZipCodeExplorer') + `?zip=${zipSearch}`);
        } else {
            toast.error("Please enter a valid zip code");
        }
    };

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

    // Fetch Logs for Metrics
    const { data: logs = [] } = useQuery({
        queryKey: ['teamLogs'],
        queryFn: async () => {
            // Fetch recent logs to aggregate metrics
            const res = await base44.entities.InteractionLog.list('-created_date', 5000);
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

    // Backup Handler
    const handleBackup = async () => {
        try {
            toast.info("Preparing backup...");
            const response = await base44.functions.invoke('backupData');
            
            // Create blob and download
            const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `firstknock_backup_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            
            toast.success("Backup downloaded successfully");
        } catch (e) {
            console.error(e);
            toast.error("Backup failed: " + e.message);
        }
    };

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

    // Aggregate Metrics by Rep Email
    const metricsByRep = useMemo(() => {
        const metrics = {};
        
        // Initialize for all members
        teamMembers.forEach(m => {
            metrics[m.email] = {
                doorsKnocked: 0,
                talkedTo: 0,
                sales: 0
            };
        });

        logs.forEach(log => {
            const email = log.created_by;
            if (!metrics[email]) return; // Skip if not current team member (or old rep)

            metrics[email].doorsKnocked++;
            
            if (log.parsed_status !== 'NO_ANSWER' && log.parsed_status !== 'ELIGIBLE') {
                metrics[email].talkedTo++;
            }

            if (log.parsed_status === 'SOLD' || log.parsed_status === 'QUALIFIED') {
                metrics[email].sales++;
            }
        });

        return metrics;
    }, [logs, teamMembers]);

    // Total Team Metrics
    const teamTotals = useMemo(() => {
        return Object.values(metricsByRep).reduce((acc, curr) => ({
            doorsKnocked: acc.doorsKnocked + curr.doorsKnocked,
            talkedTo: acc.talkedTo + curr.talkedTo,
            sales: acc.sales + curr.sales
        }), { doorsKnocked: 0, talkedTo: 0, sales: 0 });
    }, [metricsByRep]);

    // --- Handlers ---
    const handleAddRep = () => {
        if (!newRep.name || !newRep.email) {
            toast.error("Name and Email are required");
            return;
        }
        // Normalize email to ensure better matching
        createRepMutation.mutate({
            ...newRep,
            email: newRep.email.trim().toLowerCase()
        });
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
        <div className="h-full overflow-auto bg-black text-white p-4 md:p-6 pb-24">
            <div className="max-w-6xl mx-auto space-y-6">
                
                {/* Header - Mobile Optimized */}
                <div className="space-y-4">
                    {/* Title */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Users className="w-7 h-7 md:w-10 md:h-10 text-yellow-500" />
                            <h1 className="text-2xl md:text-4xl font-extrabold tracking-tight">Team</h1>
                        </div>
                        <Button 
                            onClick={() => setIsAddRepOpen(true)}
                            size="sm"
                            className="h-9 bg-yellow-500 text-black font-bold hover:bg-yellow-400 md:hidden"
                        >
                            <UserPlus className="w-4 h-4" />
                        </Button>
                    </div>
                    
                    {/* Team Stats - Compact on Mobile */}
                    <div className="grid grid-cols-3 gap-2 bg-[#111] rounded-xl p-3 border border-gray-800">
                        <div className="text-center">
                            <p className="text-xl md:text-2xl font-bold text-white">{teamTotals.doorsKnocked.toLocaleString()}</p>
                            <p className="text-[9px] md:text-[10px] font-bold text-gray-500 uppercase">Doors</p>
                        </div>
                        <div className="text-center border-x border-gray-800">
                            <p className="text-xl md:text-2xl font-bold text-green-400">{teamTotals.sales.toLocaleString()}</p>
                            <p className="text-[9px] md:text-[10px] font-bold text-gray-500 uppercase">Sales</p>
                        </div>
                        <div className="text-center">
                            <p className="text-xl md:text-2xl font-bold text-blue-400">{routes.length}</p>
                            <p className="text-[9px] md:text-[10px] font-bold text-gray-500 uppercase">Routes</p>
                        </div>
                    </div>

                    {/* Zip Search - Full Width on Mobile */}
                    <div className="flex gap-2 items-center bg-[#1F1F1F] p-2 rounded-lg border border-gray-700">
                        <Input 
                            placeholder="Enter Zip Code..." 
                            value={zipSearch}
                            onChange={(e) => setZipSearch(e.target.value)}
                            className="h-10 flex-1 bg-black border-gray-600 text-base"
                            onKeyDown={(e) => e.key === 'Enter' && handleZipSearch()}
                        />
                        <Button 
                            onClick={handleZipSearch}
                            className="h-10 bg-blue-600 hover:bg-blue-500 text-white px-4"
                        >
                            <Sparkles className="w-4 h-4 mr-1" />
                            <span className="hidden sm:inline">Generate</span>
                        </Button>
                    </div>

                    {/* Action Buttons - Scrollable on Mobile */}
                    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide">
                        <Link to={createPageUrl('Roadmap')}>
                            <Button className="h-9 bg-[#1F1F1F] border border-gray-700 text-white hover:bg-[#333] text-xs whitespace-nowrap">
                                <Shield className="w-4 h-4 mr-1" />
                                Audit
                            </Button>
                        </Link>
                        <Button 
                            onClick={handleBackup}
                            className="h-9 bg-[#1F1F1F] border border-gray-700 text-white hover:bg-[#333] text-xs whitespace-nowrap"
                        >
                            <DollarSign className="w-4 h-4 mr-1" />
                            Backup
                        </Button>
                        <Dialog open={isCodeManagerOpen} onOpenChange={setIsCodeManagerOpen}>
                            <DialogTrigger asChild>
                                <Button className="h-9 bg-[#1F1F1F] border border-gray-700 text-white hover:bg-[#333] text-xs whitespace-nowrap">
                                    <Key className="w-4 h-4 mr-1" />
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
                                            <div className="relative">
                                                <Input 
                                                    placeholder="Code" 
                                                    value={newCode.code}
                                                    onChange={(e) => setNewCode({...newCode, code: e.target.value})}
                                                    className="h-10 bg-black border-gray-700 pr-8"
                                                />
                                                <button 
                                                    onClick={() => setNewCode({...newCode, code: Math.floor(1000 + Math.random() * 9000).toString()})}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-yellow-500 hover:text-yellow-400"
                                                    title="Generate Random PIN"
                                                >
                                                    <Sparkles className="w-4 h-4" />
                                                </button>
                                            </div>
                                            <Input 
                                                placeholder="Label (e.g. Managers)" 
                                                value={newCode.label}
                                                onChange={(e) => setNewCode({...newCode, label: e.target.value})}
                                                className="h-10 bg-black border-gray-700"
                                            />
                                        </div>
                                        <div className="flex gap-2">
                                            <Select 
                                                value={newCode.role} 
                                                onValueChange={(v) => {
                                                    // Auto-generate code if empty when role is selected
                                                    const randomCode = Math.floor(1000 + Math.random() * 9000).toString();
                                                    setNewCode({
                                                        ...newCode, 
                                                        role: v, 
                                                        code: newCode.code || randomCode
                                                    });
                                                }}
                                            >
                                                <SelectTrigger className="h-10 bg-black border-gray-700 flex-1">
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
                                                className="h-10 bg-green-600 hover:bg-green-700 font-bold"
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
                                <Button className="h-9 bg-[#1F1F1F] border border-gray-700 text-white hover:bg-[#333] text-xs whitespace-nowrap">
                                    <Map className="w-4 h-4 mr-1" />
                                    Routes
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
                                        className="h-10 bg-black border-gray-700"
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
                                                        <SelectTrigger className="w-[180px] h-9 text-xs bg-[#1F1F1F] border-gray-700">
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
                                <Button className="h-9 bg-yellow-500 text-black font-bold hover:bg-yellow-400 text-xs whitespace-nowrap hidden md:flex">
                                    <UserPlus className="w-4 h-4 mr-1" />
                                    Add Rep
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
                                        className="h-10 bg-black border-gray-700"
                                        placeholder="John Doe"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400">EMAIL</label>
                                    <Input 
                                        value={newRep.email}
                                        onChange={(e) => setNewRep({...newRep, email: e.target.value})}
                                        className="h-10 bg-black border-gray-700"
                                        placeholder="john@example.com"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400">PHONE</label>
                                    <Input 
                                        value={newRep.phone}
                                        onChange={(e) => setNewRep({...newRep, phone: e.target.value})}
                                        className="h-10 bg-black border-gray-700"
                                        placeholder="(555) 123-4567"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400">ROLE</label>
                                    <Select 
                                        value={newRep.role} 
                                        onValueChange={(v) => setNewRep({...newRep, role: v})}
                                    >
                                        <SelectTrigger className="h-10 bg-black border-gray-700">
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
                                    className="w-full h-10 bg-yellow-500 text-black font-bold mt-4"
                                >
                                    Create Member
                                </Button>
                            </div>
                        </DialogContent>
                    </Dialog>
                    </div>
                </div>

                {/* 1. TEAM ROSTER (Priority Display) */}
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-lg font-bold text-white flex items-center gap-2">
                            <Users className="w-5 h-5 text-blue-500" />
                            Active Roster
                        </h2>
                        <span className="text-xs text-gray-500 font-mono">{teamMembers.length} ACTIVE</span>
                    </div>

                    {teamMembers.length === 0 ? (
                        <div className="text-center py-12 border-2 border-dashed border-gray-800 rounded-xl bg-[#0F0F0F]">
                            <Users className="w-12 h-12 text-gray-700 mx-auto mb-3" />
                            <h3 className="text-lg font-bold text-gray-400">No Team Members</h3>
                            <p className="text-gray-600 text-sm mb-4">Add your first rep to get started.</p>
                            <Button 
                                onClick={() => setIsAddRepOpen(true)}
                                className="bg-yellow-500 text-black font-bold"
                            >
                                Add First Rep
                            </Button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                            {teamMembers.map(member => {
                                const memberRoutes = routesByRep[member.id] || [];
                                const memberMetrics = metricsByRep[member.email] || { doorsKnocked: 0, talkedTo: 0, sales: 0 };
                                
                                return (
                                    <TeamMemberCard 
                                        key={member.id}
                                        member={member} 
                                        routes={memberRoutes} 
                                        metrics={memberMetrics}
                                        allRoutes={routesByRep.unassigned}
                                        onAssignRoute={handleAssign}
                                    />
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* 2. UNASSIGNED ROUTES (Secondary Display) */}
                {routesByRep.unassigned.length > 0 && (
                    <div className="space-y-4 pt-6 border-t border-gray-800">
                        <div className="flex items-center justify-between">
                            <h2 className="text-lg font-bold text-white flex items-center gap-2">
                                <AlertCircle className="w-5 h-5 text-red-500" />
                                Unassigned Routes
                            </h2>
                            <span className="text-xs text-red-400 font-mono">{routesByRep.unassigned.length} PENDING</span>
                        </div>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {routesByRep.unassigned.map(route => (
                                <div key={route.id} className="bg-[#111] border border-gray-800 rounded-lg p-4 flex flex-col gap-3 hover:border-gray-700 transition-colors">
                                    <div className="flex justify-between items-start">
                                        <div>
                                            <h4 className="font-bold text-white text-sm">{route.name}</h4>
                                            <div className="flex items-center gap-2 mt-1">
                                                <Badge variant="secondary" className="bg-gray-800 text-gray-400 text-[10px]">
                                                    {route.metrics?.house_count || 0} homes
                                                </Badge>
                                                <Badge variant="secondary" className="bg-gray-800 text-gray-400 text-[10px]">
                                                    {route.metrics?.distance || 0} mi
                                                </Badge>
                                            </div>
                                        </div>
                                        <Badge className="bg-red-900/30 text-red-400 border-red-900/50">OPEN</Badge>
                                    </div>
                                    
                                    <div className="mt-2 pt-3 border-t border-gray-800/50">
                                        <Select onValueChange={(memberId) => handleAssign(route.id, memberId)}>
                                            <SelectTrigger className="w-full h-8 text-xs bg-[#1F1F1F] border-gray-700 focus:ring-offset-0">
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

                {teamMembers.length === 0 && (
                    <div className="text-center py-12 border-2 border-dashed border-gray-800 rounded-xl">
                        <Users className="w-12 h-12 text-gray-700 mx-auto mb-3" />
                        <h3 className="text-lg font-bold text-gray-400">No Team Members</h3>
                        <p className="text-gray-600 text-sm mb-4">Add your first rep to get started.</p>
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