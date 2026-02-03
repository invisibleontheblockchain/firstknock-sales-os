import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNavigate } from 'react-router-dom';
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Users, Plus, UserPlus, Map, CheckCircle2, AlertCircle, X, Key, Sparkles, TrendingUp, DollarSign, Home, Shield, Activity, BarChart3, Lock, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { toast } from "sonner";
import TeamMemberCard from "@/components/team/TeamMemberCard";
import RepPerformanceDetail from "@/components/team/RepPerformanceDetail";
import RouteInsights from "@/components/insights/RouteInsights";
import TeamLeaderboard from "@/components/team/TeamLeaderboard";


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
    const [routeSearch, setRouteSearch] = useState('');
    const [newRep, setNewRep] = useState({ name: '', email: '', phone: '', role: 'rep' });
    const [newCode, setNewCode] = useState({ code: '', role: 'manager', label: '' });
    const [selectedRep, setSelectedRep] = useState(null); 
    const [activeTab, setActiveTab] = useState("overview");

    // --- Queries ---
    const { data: user } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me()
    });

    const { data: teamMembers = [], isLoading: teamLoading } = useQuery({
        queryKey: ['teamMembers', user?.id],
        queryFn: async () => {
            if (!user?.id) return [];
            // Filter by manager_id (current user)
            const res = await base44.entities.TeamMember.filter({ manager_id: user.id }, '-created_date', 100);
            return Array.isArray(res) ? res : (res?.items || []);
        },
        enabled: !!user?.id
    });

    const { data: routes = [], isLoading: routesLoading } = useQuery({
        queryKey: ['allRoutes', user?.id],
        queryFn: async () => {
            if (!user?.id) return [];
            // Filter by manager_id
            const res = await base44.entities.SavedRoute.filter({ manager_id: user.id }, '-created_date', 200);
            return Array.isArray(res) ? res : (res?.items || []);
        },
        enabled: !!user?.id
    });

    const { data: inviteCodes = [] } = useQuery({
        queryKey: ['inviteCodes', user?.id],
        queryFn: async () => {
            if (!user?.id) return [];
            // Only fetch codes linked to this manager
            const res = await base44.entities.InviteCode.filter({ linked_user_id: user.id }, '-created_date', 50);
            return Array.isArray(res) ? res : (res?.items || []);
        },
        enabled: !!user?.id
    });

    const { data: logs = [] } = useQuery({
        queryKey: ['teamLogs'],
        queryFn: async () => {
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
                status: 'ACTIVE' 
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['allRoutes'] });
            toast.success("Route assigned");
        }
    });

    const createCodeMutation = useMutation({
        mutationFn: (data) => base44.entities.InviteCode.create({ ...data, linked_user_id: user.id, max_uses: data.max_uses || 50 }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['inviteCodes'] });
            setNewCode({ code: '', role: 'rep', label: '' });
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

    const metricsByRep = useMemo(() => {
        const metrics = {};
        teamMembers.forEach(m => {
            metrics[m.email] = { doorsKnocked: 0, talkedTo: 0, sales: 0 };
        });
        logs.forEach(log => {
            const email = log.created_by;
            if (!metrics[email]) return;
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

    const teamTotals = useMemo(() => {
        return Object.values(metricsByRep).reduce((acc, curr) => ({
            doorsKnocked: acc.doorsKnocked + curr.doorsKnocked,
            talkedTo: acc.talkedTo + curr.talkedTo,
            sales: acc.sales + curr.sales
        }), { doorsKnocked: 0, talkedTo: 0, sales: 0 });
    }, [metricsByRep]);

    const teamAverage = useMemo(() => {
        const activeReps = Object.keys(metricsByRep).length || 1;
        return {
            knocks: teamTotals.doorsKnocked / activeReps,
            sales: teamTotals.sales / activeReps,
            conversion: teamTotals.doorsKnocked > 0 ? (teamTotals.sales / teamTotals.doorsKnocked * 100) : 0
        };
    }, [teamTotals, metricsByRep]);



    const handleAddRep = () => {
        if (!newRep.name || !newRep.email) {
            toast.error("Name and Email are required");
            return;
        }
        
        // Free Plan Check (If no active subscription, limit to 1 seat - just the manager)
        const isActiveSub = user?.subscription_status === 'active';
        // If paid, use total_seats (defaults to 1 if not set but active? shouldn't happen). If free, max 1.
        const effectiveLimit = isActiveSub ? (user.total_seats || 1) : 1;
        
        if (teamMembers.length >= effectiveLimit) {
             const message = isActiveSub 
                ? `You have reached your seat limit (${effectiveLimit}). Upgrade to add more users.`
                : "Free plan limit reached. Upgrade to add team members.";
                
             toast.error(message);
             
             if(confirm(`${message} Go to Billing?`)) {
                 navigate(createPageUrl('Billing'));
             }
             return;
        }

        createRepMutation.mutate({
            ...newRep,
            email: newRep.email.trim().toLowerCase(),
            manager_id: user.id // Assign to current manager
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
        <div className="h-full overflow-y-auto bg-black text-white p-4 md:p-6 pb-24">
            <div className="max-w-7xl mx-auto space-y-8">
                
                {/* Header Section */}
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div>
                        <h1 className="text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
                            <Shield className="w-8 h-8 text-yellow-500" />
                            Command Center
                        </h1>
                        <p className="text-gray-400 text-sm mt-1">Manage your team, routes, and performance.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button 
                            onClick={() => createCodeMutation.mutate({ code: "0000", max_uses: 5, role: 'rep', label: 'Demo Team' })}
                            className="h-9 bg-gray-800 text-gray-300 font-bold hover:bg-gray-700 hover:text-white border border-gray-700"
                        >
                            <Key className="w-4 h-4 mr-2" /> Create Demo Team
                        </Button>
                        <Dialog open={isAddRepOpen} onOpenChange={setIsAddRepOpen}>
                            <DialogTrigger asChild>
                                <Button className="h-9 bg-yellow-500 text-black font-bold hover:bg-yellow-400">
                                    <UserPlus className="w-4 h-4 mr-2" /> Add Rep
                                </Button>
                            </DialogTrigger>
                            <DialogContent className="bg-[#111] border-gray-800 text-white">
                                <DialogHeader>
                                    <DialogTitle>Add New Team Member</DialogTitle>
                                </DialogHeader>
                                <div className="space-y-4 py-4">
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-gray-500">FULL NAME</label>
                                        <Input 
                                            value={newRep.name}
                                            onChange={(e) => setNewRep({...newRep, name: e.target.value})}
                                            className="bg-black border-gray-700"
                                            placeholder="Ex: John Doe"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-gray-500">EMAIL</label>
                                        <Input 
                                            value={newRep.email}
                                            onChange={(e) => setNewRep({...newRep, email: e.target.value})}
                                            className="bg-black border-gray-700"
                                            placeholder="john@example.com"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-gray-500">ROLE</label>
                                        <Select value={newRep.role} onValueChange={(v) => setNewRep({...newRep, role: v})}>
                                            <SelectTrigger className="bg-black border-gray-700">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent className="bg-[#111] border-gray-800 text-white">
                                                <SelectItem value="rep">Sales Rep</SelectItem>
                                                <SelectItem value="manager">Manager</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <Button onClick={handleAddRep} className="w-full bg-yellow-500 text-black font-bold mt-2">
                                        Create Account
                                    </Button>
                                </div>
                            </DialogContent>
                        </Dialog>
                    </div>
                </div>

                {/* Streamlined Stats Bar */}
                <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-gray-800 bg-[#111] border border-gray-800 rounded-xl overflow-hidden shadow-lg">
                    <div className="p-4 flex flex-col items-center justify-center hover:bg-white/5 transition-colors group">
                        <div className="flex items-center gap-2 mb-1 text-yellow-500 group-hover:scale-110 transition-transform">
                            <TrendingUp size={16} />
                            <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">Knocks</span>
                        </div>
                        <span className="text-2xl font-extrabold text-white tracking-tight">{teamTotals.doorsKnocked.toLocaleString()}</span>
                    </div>

                    <div className="p-4 flex flex-col items-center justify-center hover:bg-white/5 transition-colors group">
                        <div className="flex items-center gap-2 mb-1 text-green-500 group-hover:scale-110 transition-transform">
                            <DollarSign size={16} />
                            <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">Sales</span>
                        </div>
                        <span className="text-2xl font-extrabold text-white tracking-tight">{teamTotals.sales.toLocaleString()}</span>
                    </div>

                    <div className="p-4 flex flex-col items-center justify-center hover:bg-white/5 transition-colors group cursor-pointer" onClick={() => navigate(createPageUrl('Billing'))}>
                        <div className="flex items-center gap-2 mb-1 text-blue-500 group-hover:scale-110 transition-transform">
                            <Users size={16} />
                            <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">Seats Usage</span>
                        </div>
                        <div className="flex items-baseline gap-1">
                            <span className="text-2xl font-extrabold text-white tracking-tight">{teamMembers.length}</span>
                            <span className="text-sm font-bold text-gray-500">/ {user?.total_seats || 1}</span>
                        </div>
                    </div>

                    <div className="p-4 flex flex-col items-center justify-center hover:bg-white/5 transition-colors group">
                        <div className="flex items-center gap-2 mb-1 text-purple-500 group-hover:scale-110 transition-transform">
                            <Map size={16} />
                            <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">Total Routes</span>
                        </div>
                        <span className="text-2xl font-extrabold text-white tracking-tight">{routes.length}</span>
                    </div>
                </div>

                {/* Main Content Tabs */}
                <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
                    <TabsList className="bg-[#111] border border-gray-800 p-1 h-12 w-full md:w-auto">
                        <TabsTrigger value="overview" className="h-full px-6 data-[state=active]:bg-yellow-500 data-[state=active]:text-black font-bold text-xs uppercase tracking-wide">Overview</TabsTrigger>
                        <TabsTrigger value="roster" className="h-full px-6 data-[state=active]:bg-yellow-500 data-[state=active]:text-black font-bold text-xs uppercase tracking-wide">Roster</TabsTrigger>
                        <TabsTrigger value="logistics" className="h-full px-6 data-[state=active]:bg-yellow-500 data-[state=active]:text-black font-bold text-xs uppercase tracking-wide">Routes</TabsTrigger>
                        <TabsTrigger value="access" className="h-full px-6 data-[state=active]:bg-yellow-500 data-[state=active]:text-black font-bold text-xs uppercase tracking-wide">Codes</TabsTrigger>
                    </TabsList>

                    {/* OVERVIEW TAB */}
                    <TabsContent value="overview" className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                            {/* Intelligence Column */}
                            <div className="lg:col-span-2 space-y-6">
                                <Card className="bg-[#111] border-gray-800">
                                    <CardHeader className="pb-3 border-b border-gray-800">
                                        <CardTitle className="text-sm font-bold text-gray-400 uppercase tracking-wide flex items-center gap-2">
                                            <Sparkles className="w-4 h-4 text-yellow-500" />
                                            Territory Insights
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="p-0">
                                        <RouteInsights />
                                    </CardContent>
                                </Card>

                                {routesByRep.unassigned.length > 0 && (
                                    <Card className="bg-[#111] border-red-900/30">
                                        <CardHeader className="pb-3 border-b border-gray-800">
                                            <div className="flex justify-between items-center">
                                                <CardTitle className="text-sm font-bold text-red-400 uppercase tracking-wide flex items-center gap-2">
                                                    <AlertCircle className="w-4 h-4" />
                                                    Unassigned Routes
                                                </CardTitle>
                                                <Button variant="link" onClick={() => setActiveTab('logistics')} className="text-xs text-red-400 p-0 h-auto">
                                                    View All &rarr;
                                                </Button>
                                            </div>
                                        </CardHeader>
                                        <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                                            {routesByRep.unassigned.slice(0, 4).map(route => (
                                                <div key={route.id} className="flex items-center justify-between p-3 bg-black/40 rounded border border-gray-800/50">
                                                    <div>
                                                        <p className="font-bold text-sm text-white">{route.name}</p>
                                                        <p className="text-[10px] text-gray-500">{route.metrics?.house_count || 0} homes</p>
                                                    </div>
                                                    <Button 
                                                        size="sm" 
                                                        variant="ghost"
                                                        onClick={() => setActiveTab('logistics')}
                                                        className="text-yellow-500 text-xs h-7"
                                                    >
                                                        Assign
                                                    </Button>
                                                </div>
                                            ))}
                                        </CardContent>
                                    </Card>
                                )}
                            </div>

                            {/* Leaderboard Column */}
                            <div>
                                <TeamLeaderboard 
                                    members={teamMembers} 
                                    logs={logs} 
                                    routes={Object.values(routesByRep).flat()} 
                                />
                            </div>
                        </div>
                    </TabsContent>

                    {/* ROSTER TAB */}
                    <TabsContent value="roster" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                        {selectedRep ? (
                             <RepPerformanceDetail 
                                member={selectedRep}
                                logs={logs}
                                teamAverage={teamAverage}
                                onClose={() => setSelectedRep(null)}
                            />
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                {teamMembers.map(member => {
                                    const memberRoutes = routesByRep[member.id] || [];
                                    const memberMetrics = metricsByRep[member.email] || { doorsKnocked: 0, talkedTo: 0, sales: 0 };
                                    return (
                                        <div key={member.id} onClick={() => setSelectedRep(member)} className="cursor-pointer hover:scale-[1.02] transition-transform duration-200">
                                            <TeamMemberCard 
                                                member={member} 
                                                routes={memberRoutes} 
                                                metrics={memberMetrics}
                                                allRoutes={routesByRep.unassigned}
                                                onAssignRoute={(rId, mId) => handleAssign(rId, mId)}
                                            />
                                        </div>
                                    );
                                })}
                                {/* Add New Card */}
                                <button 
                                    onClick={() => setIsAddRepOpen(true)}
                                    className="flex flex-col items-center justify-center p-8 bg-[#111] border-2 border-dashed border-gray-800 rounded-xl hover:border-yellow-500/50 hover:bg-yellow-500/5 transition-all group h-full min-h-[200px]"
                                >
                                    <div className="w-12 h-12 bg-gray-800 rounded-full flex items-center justify-center mb-4 group-hover:bg-yellow-500 group-hover:text-black transition-colors">
                                        <Plus className="w-6 h-6" />
                                    </div>
                                    <p className="font-bold text-gray-400 group-hover:text-white">Add Team Member</p>
                                </button>
                            </div>
                        )}
                    </TabsContent>

                    {/* LOGISTICS TAB */}
                    <TabsContent value="logistics" className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <Card className="bg-[#111] border-gray-800">
                            <CardHeader className="border-b border-gray-800 flex flex-row items-center justify-between">
                                <div>
                                    <CardTitle className="text-lg font-bold text-white flex items-center gap-2">
                                        <Map className="w-5 h-5 text-blue-500" />
                                        Route Registry
                                    </CardTitle>
                                    <CardDescription className="text-gray-400">Manage and assign all territory routes.</CardDescription>
                                </div>
                                <div className="relative w-64">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                                    <Input 
                                        placeholder="Search routes..." 
                                        value={routeSearch}
                                        onChange={(e) => setRouteSearch(e.target.value)}
                                        className="bg-black border-gray-700 pl-9"
                                    />
                                </div>
                            </CardHeader>
                            <CardContent className="p-0">
                                <div className="divide-y divide-gray-800 max-h-[600px] overflow-y-auto">
                                    {routes
                                        .filter(r => r.name.toLowerCase().includes(routeSearch.toLowerCase()))
                                        .map(route => (
                                            <div key={route.id} className="p-4 flex items-center justify-between hover:bg-white/5 transition-colors">
                                                <div className="flex items-center gap-4">
                                                    <div className={`w-2 h-12 rounded-full ${route.assigned_to ? 'bg-green-500' : 'bg-red-500'}`} />
                                                    <div>
                                                        <h4 className="font-bold text-white text-base">{route.name}</h4>
                                                        <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                                                            <span className="flex items-center gap-1"><Home className="w-3 h-3" /> {route.metrics?.house_count || 0}</span>
                                                            <span className="flex items-center gap-1"><Map className="w-3 h-3" /> {route.metrics?.distance || 0} mi</span>
                                                            
                                                            {/* Zip Code Display */}
                                                            {route.start_location?.address && (
                                                                <Badge variant="outline" className="border-gray-700 bg-gray-900 text-gray-300 text-[10px] px-2">
                                                                    {route.start_location.address.match(/\b\d{5}\b/)?.[0] || 'Zip N/A'}
                                                                </Badge>
                                                            )}

                                                            <Badge variant="outline" className={`border-0 text-[10px] px-2 ${route.status === 'COMPLETED' ? 'bg-green-900/30 text-green-400' : 'bg-gray-800'}`}>
                                                                {route.status}
                                                            </Badge>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-4">
                                                     {route.assigned_to_name ? (
                                                        <div className="text-right hidden sm:block">
                                                            <p className="text-[10px] text-gray-500 uppercase font-bold">Assigned To</p>
                                                            <p className="text-sm font-bold text-white">{route.assigned_to_name}</p>
                                                        </div>
                                                    ) : (
                                                        <Badge className="bg-red-900/20 text-red-400 hover:bg-red-900/30 border-0">UNASSIGNED</Badge>
                                                    )}
                                                    
                                                    <Select onValueChange={(memberId) => handleAssign(route.id, memberId)}>
                                                        <SelectTrigger className="w-[160px] h-9 text-xs bg-[#000] border-gray-700">
                                                            <SelectValue placeholder="Assign / Reassign" />
                                                        </SelectTrigger>
                                                        <SelectContent className="bg-[#1F1F1F] border-gray-800 text-white">
                                                            {teamMembers.map(m => (
                                                                <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                    </TabsContent>

                    {/* ACCESS TAB */}
                    <TabsContent value="access" className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-2xl mx-auto">
                        <Card className="bg-[#111] border-gray-800">
                            <CardHeader className="border-b border-gray-800 flex flex-row items-center justify-between">
                                <div>
                                    <CardTitle className="text-lg font-bold text-white flex items-center gap-2">
                                        <Key className="w-5 h-5 text-yellow-500" />
                                        Team Access
                                    </CardTitle>
                                    <CardDescription className="text-gray-400">Manage invite codes for your team.</CardDescription>
                                </div>
                                <Button onClick={() => navigate(createPageUrl('Billing'))} variant="outline" size="sm" className="border-yellow-500 text-yellow-500 hover:bg-yellow-500/10">
                                    Manage Seats ({teamMembers.length}/{user?.total_seats || 1})
                                </Button>
                            </CardHeader>
                            <CardContent className="p-6 space-y-8">
                                
                                {/* PRIMARY TEAM CODE */}
                                {inviteCodes.filter(c => c.linked_user_id === user?.id).map(code => (
                                    <div key={code.id} className="bg-gradient-to-r from-yellow-900/20 to-black p-6 rounded-xl border border-yellow-500/30 flex items-center justify-between relative overflow-hidden">
                                        <div className="absolute top-0 right-0 p-2 opacity-10">
                                            <Sparkles className="w-24 h-24 text-yellow-500" />
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2 mb-1">
                                                <Badge className="bg-yellow-500 text-black font-bold hover:bg-yellow-400">PRIMARY TEAM CODE</Badge>
                                                <span className="text-xs text-gray-400">Auto-managed by subscription</span>
                                            </div>
                                            <div className="text-4xl font-mono font-bold text-white tracking-wider my-2">{code.code}</div>
                                            <p className="text-sm text-gray-400">
                                                Used by {teamMembers.length} reps (Max {code.max_uses})
                                            </p>
                                        </div>
                                        <Button 
                                            onClick={() => {
                                                navigator.clipboard.writeText(code.code);
                                                toast.success("Code copied!");
                                            }}
                                            className="bg-yellow-500 text-black font-bold hover:bg-yellow-400 z-10"
                                        >
                                            Copy Code
                                        </Button>
                                    </div>
                                ))}

                                <div className="bg-black/40 p-5 rounded-xl border border-gray-800 space-y-4">
                                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Generate Custom Code</h3>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div className="relative">
                                            <Input 
                                                placeholder="Code (Auto or Custom)" 
                                                value={newCode.code}
                                                onChange={(e) => setNewCode({...newCode, code: e.target.value})}
                                                className="bg-black border-gray-700"
                                            />
                                            <button 
                                                onClick={() => setNewCode({...newCode, code: "0000", max_uses: 5})}
                                                className="absolute right-8 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-white mr-2"
                                            >
                                                Test Code (0000)
                                            </button>
                                            <button 
                                                onClick={() => setNewCode({...newCode, code: Math.floor(1000 + Math.random() * 9000).toString()})}
                                                className="absolute right-3 top-1/2 -translate-y-1/2 text-yellow-500 hover:text-white"
                                            >
                                                <Sparkles className="w-4 h-4" />
                                            </button>
                                        </div>
                                        <Input 
                                            placeholder="Label (e.g. Sales Team)" 
                                            value={newCode.label}
                                            onChange={(e) => setNewCode({...newCode, label: e.target.value})}
                                            className="bg-black border-gray-700"
                                        />
                                    </div>
                                    <div className="flex gap-4">
                                        <Select 
                                            value={newCode.role} 
                                            onValueChange={(v) => {
                                                const randomCode = Math.floor(1000 + Math.random() * 9000).toString();
                                                setNewCode({
                                                    ...newCode, 
                                                    role: v, 
                                                    code: newCode.code || randomCode
                                                });
                                            }}
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
                                            className="bg-green-600 hover:bg-green-700 font-bold px-8"
                                        >
                                            Create Code
                                        </Button>
                                    </div>
                                </div>

                                <div className="space-y-3">
                                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Active Invites</h3>
                                    {inviteCodes.length === 0 ? (
                                        <div className="text-center p-8 bg-black/20 rounded-xl border border-dashed border-gray-800">
                                            <Lock className="w-8 h-8 text-gray-700 mx-auto mb-2" />
                                            <p className="text-sm text-gray-500">No active codes found</p>
                                        </div>
                                    ) : (
                                        <div className="grid gap-2">
                                            {inviteCodes.map(code => (
                                                <div key={code.id} className="flex items-center justify-between p-4 bg-[#0A0A0A] rounded-lg border border-gray-800 hover:border-gray-700 transition-colors">
                                                    <div className="flex items-center gap-4">
                                                        <div className="w-12 h-12 rounded-lg bg-yellow-500/10 flex items-center justify-center border border-yellow-500/20">
                                                            <span className="font-mono font-bold text-yellow-500 text-lg">{code.code}</span>
                                                        </div>
                                                        <div>
                                                            <p className="font-bold text-white text-sm">{code.label || 'Unlabeled Code'}</p>
                                                            <Badge variant="outline" className="text-[10px] border-gray-700 text-gray-400 mt-1">{code.role.toUpperCase()}</Badge>
                                                        </div>
                                                    </div>
                                                    <Button 
                                                        variant="ghost" 
                                                        size="icon"
                                                        onClick={() => deleteCodeMutation.mutate(code.id)}
                                                        className="text-red-500 hover:text-red-400 hover:bg-red-900/20"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}