import React from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Navigation, Users, Briefcase, ChevronRight } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export default function RoleSelect() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [inviteCode, setInviteCode] = React.useState('');
    const [isLoading, setIsLoading] = React.useState(false);
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    const updateUserMutation = useMutation({
        mutationFn: (data) => base44.auth.updateMe(data),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user'] })
    });

    const selectRole = async (role) => {
        await updateUserMutation.mutateAsync({ app_role: role });
        if (role === 'manager') {
            navigate(createPageUrl('Home'));
        } else {
            navigate(createPageUrl('RepHome'));
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

    return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
            <div className="w-16 h-16 bg-yellow-500 rounded-2xl flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                <Navigation className="w-8 h-8 text-black" />
            </div>
            
            <h1 className="text-2xl font-bold text-white mb-2">Welcome to FirstKnock</h1>
            <p className="text-gray-400 text-center mb-8 max-w-xs">
                Select your role to get the right experience
            </p>

            <div className="w-full max-w-sm space-y-4">
                {/* Code Entry Section */}
                <div className="bg-[#1F1F1F] rounded-xl p-4 border border-gray-800 mb-6">
                    <label className="text-xs font-bold text-gray-400 mb-2 block uppercase">Have a Team Code?</label>
                    <div className="flex gap-2">
                        <Input
                            value={inviteCode}
                            onChange={(e) => setInviteCode(e.target.value)}
                            placeholder="Enter PIN code..."
                            className="bg-black border-gray-700 text-white"
                            type="text"
                        />
                        <Button 
                            onClick={handleCodeSubmit} 
                            disabled={!inviteCode || isLoading}
                            className="bg-green-600 hover:bg-green-700 font-bold"
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
                        <span className="bg-black px-2 text-gray-500">Or Select Role</span>
                    </div>
                </div>

                <button
                    onClick={() => selectRole('rep')}
                    className="w-full p-5 rounded-xl border-2 border-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/20 transition-all text-left group"
                >
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-yellow-500 rounded-xl flex items-center justify-center">
                            <Briefcase className="w-6 h-6 text-black" />
                        </div>
                        <div className="flex-1">
                            <p className="font-bold text-white text-lg">I'm a Rep</p>
                            <p className="text-sm text-gray-400">Knock doors & log results</p>
                        </div>
                        <ChevronRight className="w-5 h-5 text-yellow-500 group-hover:translate-x-1 transition-transform" />
                    </div>
                </button>

                <button
                    onClick={() => selectRole('manager')}
                    className="w-full p-5 rounded-xl border border-gray-700 bg-gray-900 hover:bg-gray-800 transition-all text-left group"
                >
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-gray-700 rounded-xl flex items-center justify-center">
                            <Users className="w-6 h-6 text-white" />
                        </div>
                        <div className="flex-1">
                            <p className="font-bold text-white text-lg">I'm a Manager</p>
                            <p className="text-sm text-gray-400">Plan routes & manage team</p>
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