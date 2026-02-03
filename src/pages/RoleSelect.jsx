import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Navigation, Users, Briefcase, ChevronRight, Key, ArrowRight, ShieldCheck, Map } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

export default function RoleSelect() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [inviteCode, setInviteCode] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [showRepCodeDialog, setShowRepCodeDialog] = useState(false);
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    const updateUserMutation = useMutation({
        mutationFn: (data) => base44.auth.updateMe(data),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user'] })
    });

    const selectRole = async (role) => {
        if (role === 'rep') {
            setShowRepCodeDialog(true);
            return;
        }

        // Manager flow
        setIsLoading(true);
        try {
            await updateUserMutation.mutateAsync({ app_role: role });
            navigate(createPageUrl('Home'));
        } catch (error) {
            console.error(error);
            toast.error("Failed to set role");
            setIsLoading(false);
        }
    };

    const handleCodeSubmit = async () => {
        if (!inviteCode) return;
        setIsLoading(true);
        try {
            const codes = await base44.entities.InviteCode.filter({ code: inviteCode, is_active: true }, '-created_date', 1);
            const validCode = codes?.items?.[0] || (Array.isArray(codes) ? codes[0] : null);

            if (validCode) {
                // 1. Update User Role
                await updateUserMutation.mutateAsync({ app_role: validCode.role });

                // 2. Create Team Member record if not exists
                const existingMembers = await base44.entities.TeamMember.filter({ email: user.email }, '-created_date', 1);
                const memberExists = existingMembers?.items?.length > 0 || (Array.isArray(existingMembers) && existingMembers.length > 0);

                if (!memberExists) {
                    await base44.entities.TeamMember.create({
                        name: user.full_name || user.email.split('@')[0],
                        email: user.email,
                        role: validCode.role,
                        status: 'active',
                        color: '#' + Math.floor(Math.random()*16777215).toString(16), // Random color
                        manager_id: validCode.linked_user_id || null // Link to manager
                    });
                }

                toast.success(`Welcome to the team! You are now a ${validCode.role}.`);

                // 3. Navigate
                if (validCode.role === 'manager') {
                    navigate(createPageUrl('Home'));
                } else {
                    navigate(createPageUrl('RepHome'));
                }
            } else {
                toast.error("Invalid or expired code");
            }
        } catch (error) {
            console.error(error);
            toast.error("Failed to verify code");
        } finally {
            setIsLoading(false);
            setShowRepCodeDialog(false);
        }
    };

    // Auto-redirect if user already has a role
    React.useEffect(() => {
        if (user?.app_role) {
            if (user.app_role === 'manager') {
                navigate(createPageUrl('Home'), { replace: true });
            } else {
                navigate(createPageUrl('RepHome'), { replace: true });
            }
        }
    }, [user, navigate]);

    if (user?.app_role) {
        return (
            <div className="min-h-screen bg-[#0A0A0A] flex flex-col items-center justify-center text-white space-y-4">
                <div className="w-12 h-12 border-4 border-yellow-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-gray-400 font-medium">Loading your workspace...</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#0A0A0A] flex flex-col px-6 relative overflow-hidden">
            {/* Background Gradients */}
            <div className="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-yellow-500/10 to-transparent pointer-events-none" />
            <div className="absolute bottom-0 right-0 w-64 h-64 bg-blue-500/5 blur-3xl rounded-full pointer-events-none" />

            <div className="flex-1 flex flex-col items-center justify-center max-w-md mx-auto w-full z-10 py-10">
                
                {/* Brand Header */}
                <motion.div 
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-center mb-10"
                >
                    <div className="w-20 h-20 bg-gradient-to-br from-yellow-400 to-yellow-600 rounded-3xl flex items-center justify-center mb-6 shadow-[0_0_40px_rgba(255,215,0,0.2)] mx-auto rotate-3 hover:rotate-6 transition-transform duration-300">
                        <Navigation className="w-10 h-10 text-black fill-black" />
                    </div>
                    <h1 className="text-3xl font-extrabold text-white mb-2 tracking-tight">FirstKnock</h1>
                    <p className="text-gray-400 font-medium">Select your path to continue</p>
                </motion.div>

                {/* Main Options */}
                <div className="w-full space-y-4">
                    
                    {/* Rep Option */}
                    <motion.button
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.1 }}
                        onClick={() => selectRole('rep')}
                        disabled={isLoading}
                        className="w-full relative overflow-hidden group rounded-2xl border border-yellow-500/30 bg-[#151515] p-1 transition-all hover:border-yellow-500 hover:shadow-[0_0_30px_rgba(255,215,0,0.15)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <div className="absolute inset-0 bg-gradient-to-r from-yellow-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="relative flex items-center p-5 gap-5">
                            <div className="w-14 h-14 rounded-xl bg-yellow-500/10 flex items-center justify-center group-hover:bg-yellow-500 group-hover:text-black transition-colors text-yellow-500">
                                <Map className="w-7 h-7" />
                            </div>
                            <div className="flex-1 text-left">
                                <h3 className="text-lg font-bold text-white group-hover:text-yellow-500 transition-colors">I'm a Sales Rep</h3>
                                <p className="text-sm text-gray-500 group-hover:text-gray-400">Knock doors, track leads, earn commission</p>
                            </div>
                            <ChevronRight className="w-5 h-5 text-gray-600 group-hover:text-yellow-500 group-hover:translate-x-1 transition-all" />
                        </div>
                    </motion.button>

                    {/* Manager Option */}
                    <motion.button
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.2 }}
                        onClick={() => selectRole('manager')}
                        disabled={isLoading}
                        className="w-full relative overflow-hidden group rounded-2xl border border-gray-800 bg-[#151515] p-1 transition-all hover:border-blue-500 hover:shadow-[0_0_30px_rgba(59,130,246,0.15)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="relative flex items-center p-5 gap-5">
                            <div className="w-14 h-14 rounded-xl bg-gray-800 flex items-center justify-center group-hover:bg-blue-500 group-hover:text-white transition-colors text-gray-400">
                                <ShieldCheck className="w-7 h-7" />
                            </div>
                            <div className="flex-1 text-left">
                                <h3 className="text-lg font-bold text-white group-hover:text-blue-400 transition-colors">I'm a Manager</h3>
                                <p className="text-sm text-gray-500 group-hover:text-gray-400">Assign territories, manage team, view analytics</p>
                            </div>
                            <ChevronRight className="w-5 h-5 text-gray-600 group-hover:text-blue-400 group-hover:translate-x-1 transition-all" />
                        </div>
                    </motion.button>

                    {/* Divider */}
                    <div className="relative py-6">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-gray-800"></div>
                        </div>
                        <div className="relative flex justify-center">
                            <span className="px-4 bg-[#0A0A0A] text-xs font-bold text-gray-600 uppercase tracking-widest">
                                Or Join with Code
                            </span>
                        </div>
                    </div>

                    {/* Code Input */}
                    <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.3 }}
                        className="bg-[#151515] p-1 rounded-2xl border border-gray-800 flex items-center"
                    >
                        <div className="pl-4 text-gray-500">
                            <Key className="w-5 h-5" />
                        </div>
                        <Input
                            value={inviteCode}
                            onChange={(e) => setInviteCode(e.target.value)}
                            placeholder="Enter Team PIN..."
                            className="bg-transparent border-0 text-white placeholder:text-gray-600 focus-visible:ring-0 h-14 text-base"
                            type="text"
                        />
                        <Button 
                            onClick={handleCodeSubmit}
                            disabled={!inviteCode || isLoading}
                            className="m-1 h-12 px-6 rounded-xl bg-gray-800 hover:bg-white hover:text-black font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isLoading ? '...' : <ArrowRight className="w-5 h-5" />}
                        </Button>
                    </motion.div>

                </div>
            </div>

            {/* Footer */}
            <div className="py-6 text-center text-xs text-gray-600">
                <p>Protected by FirstKnock Security</p>
            </div>

            <Dialog open={showRepCodeDialog} onOpenChange={setShowRepCodeDialog}>
                <DialogContent className="bg-[#111] border-gray-800 text-white">
                    <DialogHeader>
                        <DialogTitle>Enter Team Code</DialogTitle>
                        <DialogDescription>
                            You must enter a valid team code to join as a sales rep.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-4">
                         <div className="bg-[#151515] p-1 rounded-2xl border border-gray-800 flex items-center">
                            <div className="pl-4 text-gray-500">
                                <Key className="w-5 h-5" />
                            </div>
                            <Input
                                value={inviteCode}
                                onChange={(e) => setInviteCode(e.target.value)}
                                placeholder="Enter Team PIN..."
                                className="bg-transparent border-0 text-white placeholder:text-gray-600 focus-visible:ring-0 h-14 text-base"
                                type="text"
                                autoFocus
                            />
                        </div>
                    </div>
                    <DialogFooter>
                         <Button 
                            onClick={handleCodeSubmit}
                            disabled={!inviteCode || isLoading}
                            className="w-full bg-yellow-500 text-black font-bold hover:bg-yellow-400"
                        >
                            {isLoading ? 'Verifying...' : 'Join Team'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}