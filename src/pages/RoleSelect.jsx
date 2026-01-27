import React from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Navigation, Users, Briefcase, ChevronRight, Sparkles, Copy, Check, Rocket } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";

export default function RoleSelect() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [inviteCode, setInviteCode] = React.useState('');
    const [isLoading, setIsLoading] = React.useState(false);
    const [showManagerSetup, setShowManagerSetup] = React.useState(false);
    const [generatedCode, setGeneratedCode] = React.useState('');
    const [codeCopied, setCodeCopied] = React.useState(false);
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    const updateUserMutation = useMutation({
        mutationFn: (data) => base44.auth.updateMe(data),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user'] })
    });

    const selectRole = async (role) => {
        if (role === 'manager') {
            // Show manager setup flow instead of immediate navigation
            setShowManagerSetup(true);
            // Generate a team code automatically
            const newCode = Math.floor(1000 + Math.random() * 9000).toString();
            setGeneratedCode(newCode);
        } else {
            await updateUserMutation.mutateAsync({ app_role: role });
            navigate(createPageUrl('RepHome'));
        }
    };

    const completeManagerSetup = async () => {
        setIsLoading(true);
        try {
            // 1. Update user role to manager
            await updateUserMutation.mutateAsync({ app_role: 'manager' });
            
            // 2. Create the invite code for reps
            await base44.entities.InviteCode.create({
                code: generatedCode,
                role: 'rep',
                label: `Team Code - Created by ${user?.full_name || user?.email}`,
                is_active: true
            });
            
            // 3. Create TeamMember record for manager
            const existingMembers = await base44.entities.TeamMember.filter({ email: user.email }, '-created_date', 1);
            const memberExists = existingMembers?.items?.length > 0 || (Array.isArray(existingMembers) && existingMembers.length > 0);
            
            if (!memberExists) {
                await base44.entities.TeamMember.create({
                    name: user.full_name || user.email.split('@')[0],
                    email: user.email,
                    role: 'manager',
                    status: 'active',
                    color: '#FFD700'
                });
            }
            
            toast.success("Team created! Share your code with reps.");
            navigate(createPageUrl('Home'));
        } catch (e) {
            console.error(e);
            toast.error("Failed to setup team");
        } finally {
            setIsLoading(false);
        }
    };

    const copyCode = () => {
        navigator.clipboard.writeText(generatedCode);
        setCodeCopied(true);
        toast.success("Code copied!");
        setTimeout(() => setCodeCopied(false), 2000);
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
                        color: '#' + Math.floor(Math.random()*16777215).toString(16) // Random color
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
        return <div className="min-h-screen bg-black flex items-center justify-center text-white">Redirecting...</div>;
    }

    // Manager Setup Flow
    if (showManagerSetup) {
        return (
            <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
                <div className="w-16 h-16 bg-yellow-500 rounded-2xl flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                    <Rocket className="w-8 h-8 text-black" />
                </div>
                
                <h1 className="text-2xl font-bold text-white mb-2">Create Your Team</h1>
                <p className="text-gray-400 text-center mb-8 max-w-xs">
                    Share this code with your sales reps so they can join your team
                </p>

                <div className="w-full max-w-sm space-y-6">
                    {/* Generated Code Display */}
                    <Card className="bg-[#1F1F1F] border-yellow-500/50 p-6">
                        <div className="text-center">
                            <p className="text-xs font-bold text-yellow-500 uppercase mb-3">Your Team Code</p>
                            <div className="flex items-center justify-center gap-3 mb-4">
                                <span className="text-5xl font-mono font-bold text-white tracking-widest">
                                    {generatedCode}
                                </span>
                                <Button 
                                    variant="ghost" 
                                    size="icon"
                                    onClick={copyCode}
                                    className="text-yellow-500 hover:bg-yellow-500/20"
                                >
                                    {codeCopied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
                                </Button>
                            </div>
                            <p className="text-xs text-gray-500">
                                Reps enter this code when they sign up to join your team
                            </p>
                        </div>
                    </Card>

                    {/* How it works */}
                    <div className="bg-gray-900/50 rounded-xl p-4 border border-gray-800">
                        <h3 className="font-bold text-sm text-white mb-3">How it works:</h3>
                        <ol className="space-y-2 text-sm text-gray-400">
                            <li className="flex gap-2">
                                <span className="w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-500 flex items-center justify-center text-xs font-bold flex-shrink-0">1</span>
                                <span>Share the code with your reps (text, email, in person)</span>
                            </li>
                            <li className="flex gap-2">
                                <span className="w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-500 flex items-center justify-center text-xs font-bold flex-shrink-0">2</span>
                                <span>Reps download the app and enter the code</span>
                            </li>
                            <li className="flex gap-2">
                                <span className="w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-500 flex items-center justify-center text-xs font-bold flex-shrink-0">3</span>
                                <span>They automatically join your team & see their routes</span>
                            </li>
                        </ol>
                    </div>

                    <Button 
                        onClick={completeManagerSetup}
                        disabled={isLoading}
                        className="w-full h-14 bg-yellow-500 text-black font-bold text-lg hover:bg-yellow-400"
                    >
                        {isLoading ? 'Setting up...' : "Let's Go!"}
                        <ChevronRight className="w-5 h-5 ml-2" />
                    </Button>

                    <button 
                        onClick={() => setShowManagerSetup(false)}
                        className="w-full text-center text-sm text-gray-500 hover:text-gray-400"
                    >
                        ← Go Back
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
            <div className="w-16 h-16 bg-yellow-500 rounded-2xl flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                <Navigation className="w-8 h-8 text-black" />
            </div>
            
            <h1 className="text-2xl font-bold text-white mb-2">Welcome to FirstKnock</h1>
            <p className="text-gray-400 text-center mb-8 max-w-xs">
                The #1 app for door-to-door sales teams
            </p>

            <div className="w-full max-w-sm space-y-4">
                {/* Code Entry Section - For Reps joining a team */}
                <div className="bg-[#1F1F1F] rounded-xl p-4 border border-green-500/30 mb-6">
                    <div className="flex items-center gap-2 mb-3">
                        <Sparkles className="w-4 h-4 text-green-500" />
                        <label className="text-xs font-bold text-green-500 uppercase">Have a Team Code?</label>
                    </div>
                    <p className="text-xs text-gray-500 mb-3">Your manager should have given you a 4-digit code</p>
                    <div className="flex gap-2">
                        <Input
                            value={inviteCode}
                            onChange={(e) => setInviteCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                            placeholder="Enter 4-digit code..."
                            className="bg-black border-gray-700 text-white font-mono text-lg tracking-widest text-center"
                            type="text"
                            maxLength={4}
                        />
                        <Button 
                            onClick={handleCodeSubmit} 
                            disabled={!inviteCode || inviteCode.length < 4 || isLoading}
                            className="bg-green-600 hover:bg-green-700 font-bold px-6"
                        >
                            {isLoading ? '...' : 'JOIN'}
                        </Button>
                    </div>
                </div>

                <div className="relative py-2">
                    <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t border-gray-800" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-black px-2 text-gray-500">Or Start Fresh</span>
                    </div>
                </div>

                <button
                    onClick={() => selectRole('manager')}
                    className="w-full p-5 rounded-xl border-2 border-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/20 transition-all text-left group"
                >
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-yellow-500 rounded-xl flex items-center justify-center">
                            <Users className="w-6 h-6 text-black" />
                        </div>
                        <div className="flex-1">
                            <p className="font-bold text-white text-lg">I'm a Manager</p>
                            <p className="text-sm text-gray-400">Create a new team & invite reps</p>
                        </div>
                        <ChevronRight className="w-5 h-5 text-yellow-500 group-hover:translate-x-1 transition-transform" />
                    </div>
                </button>

                <button
                    onClick={() => selectRole('rep')}
                    className="w-full p-5 rounded-xl border border-gray-700 bg-gray-900 hover:bg-gray-800 transition-all text-left group"
                >
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-gray-700 rounded-xl flex items-center justify-center">
                            <Briefcase className="w-6 h-6 text-white" />
                        </div>
                        <div className="flex-1">
                            <p className="font-bold text-white text-lg">I'm a Solo Rep</p>
                            <p className="text-sm text-gray-400">No team code? Start on your own</p>
                        </div>
                        <ChevronRight className="w-5 h-5 text-gray-500 group-hover:translate-x-1 transition-transform" />
                    </div>
                </button>
            </div>

            <p className="text-xs text-gray-600 mt-8">
                You can change this later in settings
            </p>
        </div>
    );
}