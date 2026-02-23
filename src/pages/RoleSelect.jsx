import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Navigation, ShieldCheck, Map, ArrowRight } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';

export default function RoleSelect() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [inviteCode, setInviteCode] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [referralApplied, setReferralApplied] = useState(false);
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });
    const { accent } = useTheme();
    const accentTxt = contrastText(accent);

    // Auto-apply referral code from URL
    React.useEffect(() => {
        if (!user || referralApplied) return;
        const params = new URLSearchParams(window.location.search);
        const refCode = params.get('ref');
        if (refCode && !user.referred_by_code) {
            base44.functions.invoke('processReferral', { action: 'apply_code', referral_code: refCode })
                .then(res => {
                    if (res.data?.success) {
                        toast.success(`Referred by ${res.data.referrer_name || 'a friend'}!`);
                    }
                })
                .catch(() => {})
                .finally(() => setReferralApplied(true));
        }
    }, [user, referralApplied]);

    // Check if user already has a TeamMember record (already on a team)
    const { data: existingTeamMember } = useQuery({
        queryKey: ['existingTeamMember', user?.email],
        queryFn: async () => {
            if (!user?.email) return null;
            const res = await base44.entities.TeamMember.list('-created_date', 500);
            const members = Array.isArray(res) ? res : (res?.items || []);
            return members.find(m => m.email?.trim().toLowerCase() === user.email.trim().toLowerCase()) || null;
        },
        enabled: !!user?.email
    });

    const updateUserMutation = useMutation({
        mutationFn: (data) => base44.auth.updateMe(data),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user'] })
    });

    const selectRole = async (role) => {
        if (role === 'rep' && existingTeamMember) {
            setIsLoading(true);
            try {
                await updateUserMutation.mutateAsync({ 
                    app_role: 'rep',
                    team_manager_id: existingTeamMember.manager_id || null
                });
                toast.success(`Welcome back! Joining as rep.`);
                navigate(createPageUrl('RepHome'));
            } catch (error) {
                console.error(error);
                toast.error("Failed to set role");
                setIsLoading(false);
            }
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
            const codes = await base44.entities.InviteCode.filter({ code: inviteCode.toUpperCase(), is_active: true }, '-created_date', 1);
            const validCode = codes?.items?.[0] || (Array.isArray(codes) ? codes[0] : null);

            if (validCode) {
                // 1. Update User Role AND store the manager link on the user
                await updateUserMutation.mutateAsync({ 
                    app_role: validCode.role,
                    team_manager_id: validCode.linked_user_id || null,
                    team_invite_code: validCode.code
                });

                // 2. Create Team Member record if not exists
                const allMembers = await base44.entities.TeamMember.list('-created_date', 500);
                const membersList = Array.isArray(allMembers) ? allMembers : (allMembers?.items || []);
                const memberExists = membersList.some(m => 
                    m.email?.trim().toLowerCase() === user.email.trim().toLowerCase()
                );

                if (!memberExists) {
                    await base44.entities.TeamMember.create({
                        name: user.full_name || user.email.split('@')[0],
                        email: user.email.trim().toLowerCase(),
                        role: validCode.role,
                        status: 'active',
                        color: '#' + Math.floor(Math.random()*16777215).toString(16),
                        manager_id: validCode.linked_user_id || null,
                        invite_code: validCode.code
                    });
                } else {
                    const existingMember = membersList.find(m => 
                        m.email?.trim().toLowerCase() === user.email.trim().toLowerCase()
                    );
                    if (existingMember && validCode.linked_user_id && existingMember.manager_id !== validCode.linked_user_id) {
                        await base44.entities.TeamMember.update(existingMember.id, {
                            manager_id: validCode.linked_user_id,
                            invite_code: validCode.code
                        });
                    }
                }

                // 3. Increment usage count
                await base44.entities.InviteCode.update(validCode.id, {
                    used_count: (validCode.used_count || 0) + 1
                });

                toast.success(`Welcome to the team! You are now a ${validCode.role}.`);

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
                <div className="w-12 h-12 border-4 border-t-transparent rounded-full animate-spin" style={{ borderColor: accent, borderTopColor: 'transparent' }} />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#0A0A0A] flex flex-col px-6 relative overflow-hidden">
            {/* Background Gradients */}
            <div className="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-yellow-500/10 to-transparent pointer-events-none" />
            <div className="absolute bottom-0 right-0 w-64 h-64 bg-blue-500/5 blur-3xl rounded-full pointer-events-none" />

            <div className="flex-1 flex flex-col items-center justify-center max-w-md mx-auto w-full z-10 py-8">
                
                {/* Brand Header */}
                <motion.div 
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-center mb-10"
                >
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5 mx-auto rotate-3 hover:rotate-6 transition-transform duration-300" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}CC)`, boxShadow: `0 0 30px ${accent}30` }}>
                        <Navigation className="w-8 h-8" style={{ color: accentTxt }} />
                    </div>
                    <h1 className="text-3xl font-extrabold text-white mb-2 tracking-tight">FirstKnock</h1>
                    <p className="text-gray-400 font-medium">How would you like to use FirstKnock?</p>
                </motion.div>

                {/* Main Options */}
                <div className="w-full space-y-5">
                    
                    {/* Returning Rep Option */}
                    {existingTeamMember && (
                        <motion.button
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            onClick={() => selectRole('rep')}
                            disabled={isLoading}
                            className="w-full relative overflow-hidden group rounded-2xl border border-green-500/30 bg-green-500/10 p-4 transition-all hover:bg-green-500/20 text-left flex items-center gap-4 shadow-[0_0_20px_rgba(34,197,94,0.15)]"
                        >
                            <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 shrink-0">
                                <ArrowRight className="w-5 h-5" />
                            </div>
                            <div>
                                <h3 className="text-lg font-bold text-white mb-0.5">Resume My Route</h3>
                                <p className="text-xs text-gray-300">You're already on a team. Jump right back in.</p>
                            </div>
                        </motion.button>
                    )}

                    {/* Manager Option */}
                    <motion.button
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.1 }}
                        onClick={() => selectRole('manager')}
                        disabled={isLoading}
                        className="w-full relative overflow-hidden group rounded-2xl border border-gray-800 bg-[#151515] p-5 transition-all hover:border-blue-500/50 hover:bg-[#1A1A24] disabled:opacity-50 text-left"
                    >
                        <div className="relative flex items-start gap-4">
                            <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0 mt-1">
                                <ShieldCheck className="w-6 h-6" />
                            </div>
                            <div>
                                <h3 className="text-lg font-bold text-white mb-1">Create a Workspace</h3>
                                <p className="text-sm text-gray-500 leading-relaxed">I am a manager. I want to build territories, generate routes, and invite my team.</p>
                            </div>
                        </div>
                    </motion.button>

                    {/* Divider */}
                    <div className="flex items-center gap-4 py-1">
                        <div className="flex-1 h-px bg-gray-800" />
                        <span className="text-xs font-bold text-gray-600 uppercase tracking-widest">OR</span>
                        <div className="flex-1 h-px bg-gray-800" />
                    </div>

                    {/* Join Team Option */}
                    <motion.div
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.2 }}
                        className="w-full relative overflow-hidden rounded-2xl border border-gray-800 bg-[#151515] p-5 text-left"
                        style={{ boxShadow: inviteCode ? `0 0 30px ${accent}15` : 'none', borderColor: inviteCode ? `${accent}50` : '' }}
                    >
                        <div className="relative flex flex-col gap-4">
                            <div className="flex items-start gap-4">
                                <div className="w-12 h-12 rounded-full flex items-center justify-center transition-colors shrink-0 mt-1" style={{ background: `${accent}15`, color: accent }}>
                                    <Map className="w-6 h-6" />
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-white mb-1">Join a Team</h3>
                                    <p className="text-sm text-gray-500 leading-relaxed">I am a sales rep. I have an invite code from my manager.</p>
                                </div>
                            </div>
                            
                            <div className="mt-1 flex gap-2">
                                <Input
                                    value={inviteCode}
                                    onChange={(e) => setInviteCode(e.target.value)}
                                    placeholder="Invite Code..."
                                    className="bg-black border-gray-800 text-white placeholder:text-gray-600 focus-visible:ring-1 focus-visible:ring-white h-12 text-center text-lg tracking-widest font-mono uppercase"
                                    type="text"
                                    maxLength={8}
                                />
                                <Button 
                                    onClick={handleCodeSubmit}
                                    disabled={!inviteCode || isLoading}
                                    className="h-12 px-6 rounded-xl font-bold transition-all disabled:opacity-50 shadow-lg"
                                    style={{ background: accent, color: accentTxt }}
                                >
                                    {isLoading ? <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" /> : 'Join'}
                                </Button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            </div>
            {/* Footer */}
            <div className="py-6 text-center text-xs text-gray-600">
                <p>Protected by FirstKnock Security</p>
            </div>
        </div>
    );
}