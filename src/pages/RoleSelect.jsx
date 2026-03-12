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
                .catch(() => { })
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
                        color: '#' + Math.floor(Math.random() * 16777215).toString(16),
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
            <div className="h-full w-full bg-[#0A0A0A] flex flex-col items-center justify-center text-white space-y-4">
                <div className="w-12 h-12 border-4 border-t-transparent rounded-full animate-spin" style={{ borderColor: accent, borderTopColor: 'transparent' }} />
            </div>
        );
    }

    return (
        <div className="relative flex w-full min-h-[100dvh] h-screen bg-[#0A0A0A] overflow-auto text-white font-sans items-center justify-center">
            {/* Background Image Container */}
            <div className="absolute inset-0 z-0">
                <img
                    src="https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?ixlib=rb-4.0.3&auto=format&fit=crop&w=2075&q=80"
                    alt="Sales Rep knocking on door"
                    className="w-full h-full object-cover"
                />
                {/* Global Dark overlay to ensure text readability */}
                <div className="absolute inset-0 bg-black/40" />
            </div>

            {/* Content Container - No background, just a container for the cards */}
            <div className="relative z-10 w-full max-w-md px-5 flex flex-col justify-center min-h-min my-auto py-8">

                {/* Brand Header */}
                <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: "easeOut" }}
                    className="mb-8 text-center"
                >
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4 mx-auto rotate-3 hover:rotate-6 transition-transform duration-300 shadow-xl" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}CC)`, boxShadow: `0 8px 32px ${accent}40` }}>
                        <Navigation className="w-7 h-7" style={{ color: accentTxt }} />
                    </div>
                    <h1 className="text-4xl font-extrabold text-white mb-2 tracking-tight drop-shadow-md">FirstKnock</h1>
                    <p className="text-gray-200 text-sm font-medium tracking-wide drop-shadow-md">How would you like to use FirstKnock?</p>
                </motion.div>

                {/* Main Options Container - This houses the translucent cards */}
                <div className="w-full space-y-4">

                    {/* Returning Rep Option */}
                    {existingTeamMember && (
                        <motion.button
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1, duration: 0.4 }}
                            onClick={() => selectRole('rep')}
                            disabled={isLoading}
                            className="w-full relative overflow-hidden group rounded-xl border border-white/20 bg-black/30 backdrop-blur-md p-5 transition-all hover:bg-black/50 text-left flex items-center gap-5 shadow-lg"
                        >
                            {/* Inner Green Glow */}
                            <div className="absolute inset-0 bg-gradient-to-r from-green-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

                            <div className="w-10 h-10 rounded-full flex items-center justify-center text-green-400 shrink-0 bg-green-500/10 aspect-square">
                                <ArrowRight className="w-5 h-5" />
                            </div>
                            <div>
                                <h3 className="text-lg font-bold text-white mb-0.5 tracking-tight shadow-black drop-shadow-md">Resume My Route</h3>
                                <p className="text-xs text-gray-300 shadow-black drop-shadow-md">You're already on a team. Jump right back in.</p>
                            </div>
                        </motion.button>
                    )}

                    {/* Manager Option */}
                    <motion.button
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2, duration: 0.4 }}
                        onClick={() => selectRole('manager')}
                        disabled={isLoading}
                        className="w-full relative overflow-hidden group rounded-xl border border-white/20 bg-black/30 backdrop-blur-md p-6 transition-all hover:border-white/30 hover:bg-black/50 disabled:opacity-50 text-left shadow-lg"
                    >
                        <div className="relative flex items-start gap-4">
                            <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-gray-200 shrink-0 group-hover:bg-white/20 group-hover:text-white transition-colors aspect-square">
                                <ShieldCheck className="w-5 h-5" />
                            </div>
                            <div className="flex-1">
                                <h3 className="text-lg font-bold text-white mb-1 tracking-tight drop-shadow-md">Create a Workspace</h3>
                                <p className="text-xs text-gray-300 leading-relaxed drop-shadow-md">I am a manager. I want to build territories, generate routes, and invite my team.</p>
                            </div>
                        </div>
                    </motion.button>

                    {/* Divider */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.3 }}
                        className="flex items-center gap-4 py-1 opacity-70"
                    >
                        <div className="flex-1 h-px bg-white/30" />
                        <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest drop-shadow-md">OR</span>
                        <div className="flex-1 h-px bg-white/30" />
                    </motion.div>

                    {/* Join Team Option */}
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.4, duration: 0.4 }}
                        className="w-full relative overflow-hidden rounded-xl border border-white/20 bg-black/30 backdrop-blur-md p-6 text-left transition-all shadow-lg"
                        style={{ boxShadow: inviteCode ? `0 0 20px ${accent}30` : 'none', borderColor: inviteCode ? `${accent}60` : 'rgba(255,255,255,0.2)' }}
                    >
                        <div className="relative flex flex-col gap-4">
                            <div className="flex items-start gap-4">
                                <div className="w-10 h-10 rounded-full flex items-center justify-center transition-colors shrink-0 aspect-square" style={{ background: `${accent}20`, color: accentTxt }}>
                                    <Map className="w-5 h-5" style={{ color: accent }} />
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-lg font-bold text-white mb-1 tracking-tight drop-shadow-md">Join a Team</h3>
                                    <p className="text-xs text-gray-300 leading-relaxed drop-shadow-md">I am a sales rep. I have an invite code from my manager.</p>
                                </div>
                            </div>

                            <div className="mt-2 flex flex-col sm:flex-row gap-3">
                                <Input
                                    value={inviteCode}
                                    onChange={(e) => setInviteCode(e.target.value)}
                                    placeholder="INVITE CODE..."
                                    className="bg-black/80 border-black/50 text-white placeholder:text-gray-500 focus-visible:ring-1 focus-visible:ring-white h-10 text-center sm:text-left sm:pl-4 text-sm tracking-widest font-mono uppercase rounded-lg flex-1 shadow-inner"
                                    type="text"
                                    maxLength={8}
                                />
                                <Button
                                    onClick={handleCodeSubmit}
                                    disabled={!inviteCode || isLoading}
                                    className="h-10 px-6 rounded-lg font-bold transition-all disabled:opacity-50 shadow-md text-sm sm:w-auto w-full"
                                    style={{ background: inviteCode ? accent : 'rgba(255,255,255,0.15)', color: inviteCode ? accentTxt : 'rgba(255,255,255,0.6)' }}
                                >
                                    {isLoading ? <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> : 'Join'}
                                </Button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            </div>

            {/* Overlay Gradient at the bottom to ensure footer is readable */}
            <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black/80 to-transparent pointer-events-none z-10" />

            {/* Footer */}
            <div className="absolute bottom-6 left-0 right-0 py-2 text-center text-[10px] text-gray-400 font-medium tracking-wide drop-shadow-md z-20">
                <p>Protected by FirstKnock Security</p>
            </div>
        </div>
    );
}